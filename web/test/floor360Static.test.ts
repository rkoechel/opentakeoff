import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTENT_SECURITY_POLICY, REDIRECT_BRIDGE_HEADERS, cacheControlFor, createStaticServer, resolveRequest } from "../scripts/floor360-static.mjs";
import { ALLOWED_MICROSOFT_HOSTS, STRIPPED_HOSTS, stripPrivateHosts } from "../scripts/strip-private-hosts.mjs";

test("private host strip removes dependency URLs and leaves the source link", () => {
  const sample = [
    "https://cdn.jsdelivr.net/npm/onnxruntime-web@1/dist/",
    "https://huggingface.co/org/model",
    "https://hf.co/org/model",
    "https://www.googleapis.com/drive/v3/files",
    "https://accounts.google.com/gsi/client",
    "https://opentakeoff.kentucky-ai.com/",
    "https://github.com/rkoechel/opentakeoff/commit/abc",
  ].join("\n");
  const out = stripPrivateHosts(sample);
  for (const host of ["cdn.jsdelivr.net", "huggingface.co", "hf.co", "googleapis.com", "accounts.google.com", "opentakeoff.kentucky-ai.com"]) {
    assert.equal(out.includes(host), false, host);
  }
  assert.match(out, /github\.com\/rkoechel\/opentakeoff\/commit\/abc/);
});

test("Microsoft 365 sync hosts are kept in the artifact and are the only hosts the CSP allows", () => {
  assert.equal(stripPrivateHosts("https://graph.microsoft.com/v1.0"), "https://graph.microsoft.com/v1.0");
  for (const host of ALLOWED_MICROSOFT_HOSTS) assert.equal(STRIPPED_HOSTS.includes(host), false, host);
  const connect = /connect-src ([^;]+)/.exec(CONTENT_SECURITY_POLICY)![1].trim().split(/\s+/);
  assert.deepEqual(connect, ["'self'", "blob:", "data:", ...ALLOWED_MICROSOFT_HOSTS.map((h) => `https://${h}`)]);
  assert.match(CONTENT_SECURITY_POLICY, /frame-src https:\/\/login\.microsoftonline\.com;/);
  assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /\*\.sharepoint\.com|\*\.microsoft|\*\.1drv/);
  assert.match(REDIRECT_BRIDGE_HEADERS["Content-Security-Policy"], /frame-ancestors 'self'/);
  assert.equal(REDIRECT_BRIDGE_HEADERS["X-Frame-Options"], "SAMEORIGIN");
});

test("CSP matches _headers and staticwebapp.config.json", () => {
  const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  const line = headers.split("\n").find((l) => l.includes("Content-Security-Policy:"));
  assert.ok(line, "missing CSP in _headers");
  assert.equal(line!.slice(line!.indexOf(":") + 1).trim(), CONTENT_SECURITY_POLICY);
  const swa = JSON.parse(readFileSync(new URL("../public/staticwebapp.config.json", import.meta.url), "utf8"));
  assert.equal(swa.globalHeaders["Content-Security-Policy"], CONTENT_SECURITY_POLICY);
  assert.equal(swa.mimeTypes[".mjs"], "text/javascript");
  assert.match(CONTENT_SECURITY_POLICY, /connect-src 'self' blob: data:/);
  assert.equal(headers.includes("frame-src 'none'"), false);
  assert.match(CONTENT_SECURITY_POLICY, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(CONTENT_SECURITY_POLICY, /worker-src 'self' blob:/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /cloudflare|googleapis|gstatic|accounts\.google/);
});

test("static server sends the CSP and serves .mjs as JavaScript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ot-static-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>ok</title>");
  writeFileSync(join(dir, "worker.mjs"), "export const x = 1;\n");
  writeFileSync(join(dir, "redirect.html"), "<!doctype html><title>bridge</title>");
  const server = createStaticServer(dir);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const mod = await fetch(`http://127.0.0.1:${port}/worker.mjs`);
    assert.equal(mod.status, 200);
    assert.match(mod.headers.get("content-type") || "", /^text\/javascript/);
    assert.equal(mod.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
    assert.equal(mod.headers.get("x-content-type-options"), "nosniff");
    assert.equal(mod.headers.get("x-frame-options"), "DENY");
    const bridge = await fetch(`http://127.0.0.1:${port}/redirect.html`);
    assert.equal(bridge.status, 200);
    assert.equal(bridge.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.match(bridge.headers.get("content-security-policy") || "", /frame-ancestors 'self'/);
    const spa = await fetch(`http://127.0.0.1:${port}/projects/abc`);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /ok/);
    const missing = await fetch(`http://127.0.0.1:${port}/missing.js`);
    assert.equal(missing.status, 404);
    const escaped = resolveRequest(dir, "/%2e%2e/%2e%2e/etc/passwd");
    if (escaped.file) assert.ok(escaped.file.startsWith(dir), escaped.file);
    const dotted = resolveRequest(dir, "/%2e%2e/package.json");
    assert.equal(dotted.file, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cache headers: hashed assets and OCR models for a year, everything else revalidates", async () => {
  assert.equal(cacheControlFor("/assets/index-abc123.js"), "public, max-age=31536000, immutable");
  assert.equal(cacheControlFor("/assets/ort-wasm-simd-threaded.asyncify-DMmc6YqF.wasm"), "public, max-age=31536000, immutable");
  assert.equal(cacheControlFor("/models/ocr/det.onnx"), "public, max-age=31536000");
  assert.equal(cacheControlFor("/models/ocr/dict.txt"), "public, max-age=31536000");
  assert.equal(cacheControlFor("/models/ocr/manifest.json"), "no-cache");
  assert.equal(cacheControlFor("/index.html"), "no-cache");
  assert.equal(cacheControlFor("/"), "no-cache");
  const dir = mkdtempSync(join(tmpdir(), "ot-cache-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>ok</title>");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "models", "ocr"), { recursive: true });
  writeFileSync(join(dir, "models", "ocr", "det.onnx"), "x");
  const server = createStaticServer(dir);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const model = await fetch(`http://127.0.0.1:${port}/models/ocr/det.onnx`);
    assert.equal(model.headers.get("cache-control"), "public, max-age=31536000");
    assert.equal(model.headers.get("content-type"), "application/octet-stream");
    const spa = await fetch(`http://127.0.0.1:${port}/projects/abc`);
    assert.equal(spa.headers.get("cache-control"), "no-cache");
    assert.equal(spa.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
