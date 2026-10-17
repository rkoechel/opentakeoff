// /api/ai for the FLOOR360 private build: the takeoff agent's same-origin
// proxy to the vision model on the FLOOR360 DGX (vLLM, OpenAI-compatible,
// tool calling) behind Cloudflare Access. The browser never holds a key and
// never calls the DGX: it posts to this origin, and this route adds the
// credentials server-side.
//
// Dependency-free Node, like floor360-static.mjs, and copied into dist/.
//
//   POST /api/ai/v1/chat/completions   the agent's turn (ai.js chatWithTools,
//                                      visionQuery)
//   GET  /api/ai/status                {state: ready|busy|starting|off, model}
//
// App settings (values are never logged or returned):
//   AI_UPSTREAM_URL          default https://takeoff-vision.floor360.com/v1
//   AI_MODEL                 the exact id from <AI_UPSTREAM_URL>/models; every
//                            request is sent with it, whatever the browser
//                            says. Unset: the first id /models lists (asked
//                            per request until one answers, then cached 5
//                            min); no model up reads as "AI starting".
//   AI_API_KEY               the vLLM --api-key, sent as Authorization: Bearer
//   CF_ACCESS_CLIENT_ID      Cloudflare Access service token, sent as
//   CF_ACCESS_CLIENT_SECRET  CF-Access-Client-Id / CF-Access-Client-Secret
//   AI_MAX_CONCURRENT        default 2; past it the route answers 503 "AI busy"
//   AI_MAX_TOKENS            default 4096; a request's max_tokens is clamped
//   AI_MAX_BODY_BYTES        default 20 MB (the agent sends PNG crops)
//   AI_TIMEOUT_MS            default 120000, the agent's own turn timeout
//
// Upstream 429 reads as busy; 502/503/504, Cloudflare's 52x, a timeout, or no
// connection read as starting (the DGX model loading, or the box asleep).

export const AI_PATH = "/api/ai";
export const DEFAULT_AI_UPSTREAM_URL = "https://takeoff-vision.floor360.com/v1";

const FORWARDED_FIELDS = ["messages", "tools", "tool_choice", "max_tokens", "temperature", "top_p", "stop", "response_format", "seed"];

function intSetting(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function upstreamUrl(value) {
  const v = String(value || DEFAULT_AI_UPSTREAM_URL).trim().replace(/\/+$/, "");
  try {
    const u = new URL(v);
    const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (u.protocol === "https:" || (u.protocol === "http:" && local)) return v;
  } catch { /* below */ }
  return "";
}

export function aiProxyConfig(env = process.env) {
  return {
    upstream: upstreamUrl(env.AI_UPSTREAM_URL),
    model: String(env.AI_MODEL || "").trim(),
    apiKey: String(env.AI_API_KEY || "").trim(),
    cfId: String(env.CF_ACCESS_CLIENT_ID || "").trim(),
    cfSecret: String(env.CF_ACCESS_CLIENT_SECRET || "").trim(),
    maxConcurrent: intSetting(env.AI_MAX_CONCURRENT, 2),
    maxTokens: intSetting(env.AI_MAX_TOKENS, 4096),
    maxBodyBytes: intSetting(env.AI_MAX_BODY_BYTES, 20 * 1024 * 1024),
    timeoutMs: intSetting(env.AI_TIMEOUT_MS, 120000),
  };
}

export function upstreamHeaders(cfg) {
  const h = { "Content-Type": "application/json", Accept: "application/json" };
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
  if (cfg.cfId && cfg.cfSecret) {
    h["CF-Access-Client-Id"] = cfg.cfId;
    h["CF-Access-Client-Secret"] = cfg.cfSecret;
  }
  return h;
}

/** The browser's body, reduced to the chat fields, with this site's model and
 *  a clamped max_tokens. Streaming is off: the agent reads one JSON reply. */
export function upstreamBody(body, cfg, model = cfg.model) {
  const out = {};
  for (const k of FORWARDED_FIELDS) if (body[k] !== undefined) out[k] = body[k];
  out.model = model;
  const asked = Number(out.max_tokens);
  out.max_tokens = Number.isInteger(asked) && asked > 0 ? Math.min(asked, cfg.maxTokens) : cfg.maxTokens;
  out.stream = false;
  return out;
}

/** An upstream status as what the browser is told. */
export function classifyUpstream(status) {
  if (status >= 200 && status < 300) return { kind: "ok" };
  if (status === 429) return { kind: "busy" };
  if (status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530)) return { kind: "starting" };
  if (status === 401 || status === 403 || (status >= 300 && status < 400)) return { kind: "refused" };
  return { kind: "failed" };
}

const BUSY = { error: "AI busy", state: "busy" };
const STARTING = { error: "AI starting", state: "starting" };

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createAiProxyHandler({ env = process.env, fetchImpl = globalThis.fetch, log = console, nowMs = () => Date.now() } = {}) {
  const cfg = aiProxyConfig(env);
  let inFlight = 0;
  let statusCache = null;
  let modelCache = null;

  /** AI_MODEL, or the first id the upstream's /models lists ("" if none). */
  async function resolveModel() {
    if (cfg.model) return cfg.model;
    if (modelCache && modelCache.until > nowMs()) return modelCache.id;
    try {
      const res = await fetchImpl(`${cfg.upstream}/models`, { headers: upstreamHeaders(cfg), redirect: "manual", signal: AbortSignal.timeout(5000) });
      if (!res.ok) return "";
      const body = await res.json();
      const id = Array.isArray(body?.data) && typeof body.data[0]?.id === "string" ? body.data[0].id : "";
      if (id) modelCache = { id, until: nowMs() + 5 * 60_000 };
      return id;
    } catch {
      return "";
    }
  }

  async function probe() {
    if (!cfg.upstream) return "off";
    if (statusCache && statusCache.until > nowMs()) return statusCache.state;
    let state = "starting";
    try {
      const res = await fetchImpl(`${cfg.upstream}/models`, { headers: upstreamHeaders(cfg), redirect: "manual", signal: AbortSignal.timeout(5000) });
      const c = classifyUpstream(res.status);
      state = c.kind === "ok" ? "ready" : c.kind === "busy" ? "busy" : c.kind === "refused" ? "off" : "starting";
    } catch { /* starting */ }
    statusCache = { state, until: nowMs() + 15000 };
    return state;
  }

  return async function handleAi(req, res) {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (pathname === `${AI_PATH}/status` && req.method === "GET") {
      const state = inFlight >= cfg.maxConcurrent ? "busy" : await probe();
      const model = state === "ready" ? await resolveModel() : cfg.model;
      json(res, 200, { state: state === "ready" && !model ? "starting" : state, model, maxConcurrent: cfg.maxConcurrent });
      return;
    }
    if (pathname !== `${AI_PATH}/v1/chat/completions`) { json(res, 404, { error: "Not found" }); return; }
    if (req.method !== "POST") { json(res, 405, { error: "Use POST" }); return; }
    const user = String(req.headers["x-ms-client-principal-name"] || "").trim();
    if (!user) { json(res, 401, { error: "Sign in to use the takeoff AI" }); return; }
    if (!cfg.upstream) { json(res, 503, { error: "The takeoff AI is not set up on this site", state: "off" }); return; }
    if (inFlight >= cfg.maxConcurrent) { json(res, 503, BUSY); return; }
    inFlight += 1;
    try {
      let body;
      try {
        body = JSON.parse((await readBody(req, cfg.maxBodyBytes)).toString("utf8"));
        if (!body || typeof body !== "object" || !Array.isArray(body.messages)) throw new Error("no messages");
      } catch (e) {
        json(res, e.status === 413 ? 413 : 400, { error: e.status === 413 ? "That request is too large for the takeoff AI" : "Send an OpenAI-style chat request" });
        return;
      }
      const model = await resolveModel();
      if (!model) { json(res, 503, STARTING); return; }
      let upstream;
      try {
        upstream = await fetchImpl(`${cfg.upstream}/chat/completions`, {
          method: "POST", headers: upstreamHeaders(cfg), body: JSON.stringify(upstreamBody(body, cfg, model)),
          redirect: "manual", signal: AbortSignal.timeout(cfg.timeoutMs),
        });
      } catch (e) {
        log.warn?.(`ai-proxy upstream unreachable (${e?.name || "error"})`);
        json(res, 503, STARTING);
        return;
      }
      const c = classifyUpstream(upstream.status);
      log.info?.(`ai-proxy upstream ${upstream.status}`);
      if (c.kind === "ok") {
        const text = await upstream.text();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(text);
        return;
      }
      if (c.kind === "busy") { json(res, 503, BUSY); return; }
      if (c.kind === "starting") { statusCache = null; json(res, 503, STARTING); return; }
      if (c.kind === "refused") { json(res, 502, { error: "The takeoff AI refused this site's credentials", state: "off" }); return; }
      json(res, 502, { error: `The takeoff AI failed (HTTP ${upstream.status})` });
    } finally {
      inFlight -= 1;
    }
  };
}
