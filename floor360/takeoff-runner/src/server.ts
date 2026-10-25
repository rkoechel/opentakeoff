// The job API (Phase 2 §4). Dependency-free node:http, like the FLOOR360
// proxies in web/scripts. Off unless RUNNER_ENABLED=1; every route but
// /health needs Authorization: Bearer <RUNNER_TOKEN>, compared in constant
// time. Logs carry the method, route and status only — never a header.
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LIMITS, type RunnerConfig } from "./config.ts";
import { HttpError, jobView, type JobStore } from "./jobs.ts";
import { parseShopDrawingsRequest, ShopDrawingsError } from "./shopdrawings/request.ts";
import { ManifestError, parseManifest } from "./types.ts";

export interface HandlerDeps {
  config: Pick<RunnerConfig, "enabled" | "token" | "defaultDpi">;
  store: JobStore;
  log?: (msg: string) => void;
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
};

export function tokenMatches(header: string | undefined, token: string): boolean {
  if (!token || !header || !header.startsWith("Bearer ")) return false;
  const a = createHash("sha256").update(header.slice(7).trim()).digest();
  const b = createHash("sha256").update(token).digest();
  return timingSafeEqual(a, b);
}

function readJson(req: IncomingMessage, limit: number, tooLarge = "The manifest is too large.", badJson = "Send a JSON job manifest."): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, tooLarge)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, badJson));
      }
    });
    req.on("error", reject);
  });
}

const SEG = "([^/]+)";
const ROUTES: { method: string; re: RegExp; name: string }[] = [
  { method: "POST", re: /^\/jobs$/, name: "create" },
  { method: "PUT", re: new RegExp(`^/jobs/${SEG}/files/${SEG}$`), name: "upload" },
  { method: "POST", re: new RegExp(`^/jobs/${SEG}/start$`), name: "start" },
  { method: "POST", re: new RegExp(`^/jobs/${SEG}/shop-drawings$`), name: "shop-drawings" },
  { method: "GET", re: new RegExp(`^/jobs/${SEG}$`), name: "get" },
  { method: "GET", re: new RegExp(`^/jobs/${SEG}/outputs/${SEG}$`), name: "output" },
  { method: "POST", re: new RegExp(`^/jobs/${SEG}/cancel$`), name: "cancel" },
];

export function createRunnerHandler(d: HandlerDeps) {
  const log = d.log ?? (() => {});
  return async function handle(req: IncomingMessage, res: ServerResponse) {
    let pathname: string;
    try {
      pathname = new URL(req.url || "/", "http://localhost").pathname;
    } catch {
      json(res, 400, { error: "bad request" });
      return;
    }
    const done = (status: number, route: string) => log(`${req.method} ${route} ${status}`);
    if (pathname === "/health") {
      json(res, req.method === "GET" || req.method === "HEAD" ? 200 : 405, req.method === "GET" || req.method === "HEAD" ? { ok: true } : { error: "use GET" });
      return;
    }
    if (pathname !== "/jobs" && !pathname.startsWith("/jobs/")) { json(res, 404, { error: "not found" }); return; }
    if (!d.config.enabled) { json(res, 503, { error: "runner disabled" }); done(503, "/jobs"); return; }
    if (!d.config.token) { json(res, 503, { error: "runner not configured" }); done(503, "/jobs"); return; }
    if (!tokenMatches(req.headers.authorization, d.config.token)) {
      json(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      done(401, "/jobs");
      return;
    }
    const hit = ROUTES.map((r) => ({ r, m: r.re.exec(pathname) })).find((x) => x.m);
    if (!hit) { json(res, 404, { error: "not found" }); return; }
    if (hit.r.method !== req.method) { json(res, 405, { error: `use ${hit.r.method}` }); return; }
    const [a, b] = (hit.m as RegExpExecArray).slice(1).map((s) => { try { return decodeURIComponent(s); } catch { return ""; } });
    const route = `/jobs${hit.r.name === "create" ? "" : `/:id`}${hit.r.name === "upload" ? "/files/:fileId" : hit.r.name === "output" ? "/outputs/:name" : hit.r.name === "start" || hit.r.name === "cancel" || hit.r.name === "shop-drawings" ? `/${hit.r.name}` : ""}`;
    try {
      switch (hit.r.name) {
        case "create": {
          const manifest = parseManifest(await readJson(req, LIMITS.maxManifestBytes), d.config.defaultDpi);
          const job = await d.store.create(manifest);
          json(res, 201, jobView(job));
          done(201, route);
          return;
        }
        case "upload": {
          const len = req.headers["content-length"] !== undefined ? Number(req.headers["content-length"]) : undefined;
          const r = await d.store.putChunk(a, b, req.headers["content-range"] as string | undefined, Number.isFinite(len) ? len : undefined, req);
          json(res, r.status, r.body);
          done(r.status, route);
          return;
        }
        case "start": {
          const job = await d.store.start(a);
          json(res, 202, jobView(job));
          done(202, route);
          return;
        }
        case "shop-drawings": {
          const body = await readJson(req, LIMITS.maxShopDrawingsBytes, "The shop drawings request is too large.", "Send a JSON shop drawings request.");
          const request = parseShopDrawingsRequest(body);
          const job = await d.store.startShopDrawings(a, request);
          json(res, 202, jobView(job));
          done(202, route);
          return;
        }
        case "get":
          json(res, 200, jobView(d.store.get(a)));
          return;
        case "output": {
          const { path: p, entry } = d.store.outputPath(a, b);
          res.writeHead(200, {
            "Content-Type": entry.contentType,
            "Content-Length": String(entry.size),
            "Cache-Control": "no-store",
            "X-Content-Sha256": entry.sha256,
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
          });
          createReadStream(p).on("error", () => res.destroy()).pipe(res);
          done(200, route);
          return;
        }
        case "cancel": {
          const job = await d.store.cancel(a);
          json(res, 202, jobView(job));
          done(202, route);
          return;
        }
      }
    } catch (e) {
      if (e instanceof ManifestError || e instanceof ShopDrawingsError) { json(res, 400, { error: e.message }); done(400, route); return; }
      if (e instanceof HttpError) {
        // drain an upload body we refused, so the client sees the answer
        if (!req.readableEnded) req.resume();
        json(res, e.status, { error: e.message, ...e.extra });
        done(e.status, route);
        return;
      }
      log(`${req.method} ${route} 500 (${(e as Error).name})`);
      if (!res.headersSent) json(res, 500, { error: "runner error" });
      else res.destroy();
    }
  };
}
