// Static host for the FLOOR360 private build.
//
// Azure App Service does not apply web/public/_headers or
// staticwebapp.config.json. `npx serve` does not set this Content-Security-Policy
// and often serves .mjs as application/octet-stream, which makes the browser
// refuse the pdf.js worker and Vite's module chunks. This file is dependency-free
// Node (no Express, no nginx): it sends the same CSP as those two configs and
// serves .mjs as JavaScript. The production build copies it to dist/.
//
//   node floor360-static.mjs
//
// Listens on PORT (App Service sets it) and 0.0.0.0. The site root is the
// directory that contains this file, or FLOOR360_STATIC_ROOT when set.
// Existing files are served as themselves. A directory with index.html serves
// that file. Any other extensionless path falls back to /index.html. A missing
// file with an extension is a 404, so a bad asset is not masked as the app.
//
// Same-origin API routes (createStaticServer's `routes`) answer under /api/;
// any other /api/ path is a 404, never the app. The CSP stays 'self'.
//   POST /api/ocr/read   Azure Document Intelligence Read (floor360-ocr-read.mjs)

import http from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OCR_READ_PATH, createOcrReadHandler } from "./floor360-ocr-read.mjs";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  // Microsoft 365 sync (FLOOR360 tenant only): MSAL's token endpoint, Graph,
  // and FLOOR360's SharePoint host, where Graph's pre-authenticated
  // downloadUrl points. Nothing else leaves the origin.
  "connect-src 'self' blob: data: https://login.microsoftonline.com https://graph.microsoft.com https://floor360com.sharepoint.com",
  "worker-src 'self' blob:",
  // MSAL's silent token renewal runs in a hidden iframe on the login host.
  "frame-src https://login.microsoftonline.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

export const SECURITY_HEADERS = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(self), geolocation=(), interest-cohort=()",
  "Strict-Transport-Security": "max-age=31536000",
};

// The MSAL redirect bridge is loaded inside MSAL's own hidden iframe (silent
// renewal) on this origin, so it alone may be framed by this origin.
export const REDIRECT_BRIDGE_PATH = "/redirect.html";
export const REDIRECT_BRIDGE_HEADERS = {
  ...SECURITY_HEADERS,
  "Content-Security-Policy": CONTENT_SECURITY_POLICY.replace("frame-ancestors 'none'", "frame-ancestors 'self'"),
  "X-Frame-Options": "SAMEORIGIN",
};

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
  ".mp4": "video/mp4",
  ".onnx": "application/octet-stream",
};

// Cache rules. Vite's /assets/* names carry a content hash, so they never
// change: cache for a year. The OCR model files are pinned by sha256 in the
// manifest and the app's own Cache Storage keys them by hash, so a model
// change gets a new MODEL_REV; cache them a year too. Everything else
// (index.html, the manifest, public pages) revalidates on every load so a
// deploy is picked up at once.
export function cacheControlFor(pathname) {
  if (/^\/assets\/[^/]+$/.test(pathname)) return "public, max-age=31536000, immutable";
  if (/^\/models\/ocr\/[^/]+\.(onnx|txt)$/.test(pathname)) return "public, max-age=31536000";
  return "no-cache";
}

export function resolveRequest(root, urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(urlPath, "http://localhost").pathname);
  } catch {
    return { status: 400 };
  }
  const rootAbs = path.resolve(root);
  const rel = pathname.replace(/^[/\\]+/, "");
  const abs = path.resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return { status: 403 };
  if (existsSync(abs)) {
    const st = statSync(abs);
    if (st.isFile()) return { status: 200, file: abs };
    if (st.isDirectory()) {
      const index = path.join(abs, "index.html");
      if (existsSync(index) && statSync(index).isFile()) return { status: 200, file: index };
    }
  }
  const last = pathname.split("/").filter(Boolean).pop() || "";
  if (last.includes(".")) return { status: 404 };
  const spa = path.join(rootAbs, "index.html");
  if (existsSync(spa)) return { status: 200, file: spa };
  return { status: 404 };
}

export function createStaticServer(root, { routes = {} } = {}) {
  return http.createServer((req, res) => {
    let apiPath = "";
    try { apiPath = new URL(req.url || "/", "http://localhost").pathname; } catch { /* resolveRequest answers 400 */ }
    if (apiPath === "/api" || apiPath.startsWith("/api/")) {
      const route = Object.keys(routes).find((p) => apiPath === p || apiPath.startsWith(p + "/"));
      if (!route) {
        res.writeHead(404, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ error: "Not found" }));
        return;
      }
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
      Promise.resolve(routes[route](req, res)).catch(() => {
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Server error" }));
      });
      return;
    }
    const resolved = resolveRequest(root, req.url || "/");
    let bridge = false;
    try { bridge = new URL(req.url || "/", "http://localhost").pathname === REDIRECT_BRIDGE_PATH; } catch { /* 400 below */ }
    const headers = { ...(bridge && resolved.file ? REDIRECT_BRIDGE_HEADERS : SECURITY_HEADERS) };
    if (!resolved.file) {
      const status = resolved.status || 404;
      res.writeHead(status, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
      res.end(status === 403 ? "Forbidden" : status === 400 ? "Bad request" : "Not found");
      return;
    }
    const ext = path.extname(resolved.file).toLowerCase();
    headers["Content-Type"] = MIME[ext] || "application/octet-stream";
    let pathname = "/";
    try { pathname = new URL(req.url || "/", "http://localhost").pathname; } catch { /* resolved above */ }
    headers["Cache-Control"] = cacheControlFor(resolved.file.endsWith("index.html") && !pathname.endsWith(".html") ? "/index.html" : pathname);
    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(resolved.file).on("error", () => {
      if (!res.headersSent) res.writeHead(500, headers);
      res.end();
    }).pipe(res);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = process.env.FLOOR360_STATIC_ROOT
    ? path.resolve(process.env.FLOOR360_STATIC_ROOT)
    : path.dirname(fileURLToPath(import.meta.url));
  const port = Number(process.env.PORT) || 8080;
  const host = "0.0.0.0";
  const routes = { [OCR_READ_PATH]: createOcrReadHandler() };
  createStaticServer(root, { routes }).listen(port, host, () => {
    console.log(`floor360-static serving ${root} on ${host}:${port}`);
  });
}
