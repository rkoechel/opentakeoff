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
//   AI_WAKER_URL             the DGX waker (infra/takeoff-vision-waker), e.g.
//                            https://takeoff-vision.floor360.com/_waker. Unset:
//                            no on-demand start.
//   WAKER_TOKEN              the waker's bearer token (with the same CF Access
//                            headers as the model)
//
// Upstream 429 reads as busy; 502/503/504, Cloudflare's 52x, a timeout, or no
// connection read as starting (the DGX model loading, or the box asleep).
//
// On-demand start: when the model is down (no connection, or 502/503/504/52x
// on /models or a chat request) and AI_WAKER_URL is set, the proxy POSTs the
// waker's /wake once, then polls its /status (every AI_WAKE_POLL_MS, default
// 5 s) for up to AI_WAKE_TIMEOUT_MS (default 180 s). Until the model answers,
// every AI request gets 503 {state: "starting", retryAfter} at once, without
// another wake or an upstream call, so browsers retrying can't pile up starts.
// A waker 503 {state: "no_memory"} is passed on as no_memory (held 60 s).

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
    wakerUrl: env.AI_WAKER_URL ? upstreamUrl(env.AI_WAKER_URL) : "",
    wakerToken: String(env.WAKER_TOKEN || "").trim(),
    wakeTimeoutMs: intSetting(env.AI_WAKE_TIMEOUT_MS, 180000),
    wakePollMs: intSetting(env.AI_WAKE_POLL_MS, 5000),
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
export const RETRY_AFTER_S = 10;
export const NO_MEMORY_MESSAGE = "The AI server is out of memory right now. Ask Ryan to free memory on the DGX.";
const STARTING_WAKE = { error: "Starting the takeoff AI", state: "starting", retryAfter: RETRY_AFTER_S };
const NO_MEMORY = { error: NO_MEMORY_MESSAGE, state: "no_memory" };

/** Headers for the waker: the CF Access token and WAKER_TOKEN, never the
 *  vLLM key. */
export function wakerHeaders(cfg) {
  const h = { Accept: "application/json" };
  if (cfg.wakerToken) h.Authorization = `Bearer ${cfg.wakerToken}`;
  if (cfg.cfId && cfg.cfSecret) {
    h["CF-Access-Client-Id"] = cfg.cfId;
    h["CF-Access-Client-Secret"] = cfg.cfSecret;
  }
  return h;
}

/** One wake at a time for the whole site: wake() POSTs /wake unless a wake
 *  is already under way (or no_memory was just reported), then polls /status
 *  in the background until running or the timeout. state() is "idle",
 *  "starting" or "no_memory". onReady runs when the model is up. */
export function createWakeManager(cfg, { fetchImpl, nowMs = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console, onReady = () => {} } = {}) {
  let cur = { state: "idle", until: 0 };
  const state = () => (cur.state !== "idle" && cur.until > nowMs() ? cur.state : "idle");
  const call = async (path, method) => {
    const res = await fetchImpl(`${cfg.wakerUrl}${path}`, { method, headers: wakerHeaders(cfg), redirect: "manual", signal: AbortSignal.timeout(10000) });
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body };
  };
  async function poll(deadline) {
    while (nowMs() < deadline) {
      await sleep(cfg.wakePollMs);
      try {
        const { status, body } = await call("/status", "GET");
        if (status === 200 && body?.state === "running") { cur = { state: "idle", until: 0 }; onReady(); log.info?.("ai-proxy waker: model running"); return; }
        if (status === 200 && body?.state === "no_memory") { cur = { state: "no_memory", until: nowMs() + 60_000 }; return; }
      } catch { /* keep polling */ }
    }
    log.warn?.("ai-proxy waker: model did not come up in time");
    cur = { state: "idle", until: 0 };
  }
  return {
    enabled: () => Boolean(cfg.wakerUrl),
    state,
    /** "starting" | "no_memory" | null (no waker, or it failed) */
    async wake() {
      if (!cfg.wakerUrl) return null;
      const s = state();
      if (s !== "idle") return s;
      const deadline = nowMs() + cfg.wakeTimeoutMs;
      cur = { state: "starting", until: deadline };
      try {
        const { status, body } = await call("/wake", "POST");
        log.info?.(`ai-proxy waker /wake ${status}`);
        if (body?.state === "no_memory") { cur = { state: "no_memory", until: nowMs() + 60_000 }; return "no_memory"; }
        if (body?.state === "running") { cur = { state: "idle", until: 0 }; onReady(); return "starting"; }
        if (status !== 200 && status !== 202 && status !== 429) { cur = { state: "idle", until: 0 }; return null; }
      } catch (e) {
        log.warn?.(`ai-proxy waker unreachable (${e?.name || "error"})`);
        cur = { state: "idle", until: 0 };
        return null;
      }
      poll(deadline);
      return "starting";
    },
  };
}

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

export function createAiProxyHandler({ env = process.env, fetchImpl = globalThis.fetch, log = console, nowMs = () => Date.now(), sleep } = {}) {
  const cfg = aiProxyConfig(env);
  let inFlight = 0;
  let statusCache = null;
  let modelCache = null;
  const waker = createWakeManager(cfg, { fetchImpl, nowMs, sleep, log, onReady: () => { statusCache = null; } });

  /** The browser's answer while the model is down: wake it (once) when a
   *  waker is set up, else today's plain "AI starting". */
  async function down(res) {
    const s = await waker.wake();
    if (s === "no_memory") json(res, 503, NO_MEMORY);
    else if (s === "starting") json(res, 503, STARTING_WAKE);
    else json(res, 503, STARTING);
  }

  /** AI_MODEL, or the first id the upstream's /models lists. {id, down}:
   *  down = the model server isn't answering (worth a wake). */
  async function resolveModel() {
    if (cfg.model) return { id: cfg.model, down: false };
    if (modelCache && modelCache.until > nowMs()) return { id: modelCache.id, down: false };
    try {
      const res = await fetchImpl(`${cfg.upstream}/models`, { headers: upstreamHeaders(cfg), redirect: "manual", signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { id: "", down: classifyUpstream(res.status).kind === "starting" };
      const body = await res.json();
      const id = Array.isArray(body?.data) && typeof body.data[0]?.id === "string" ? body.data[0].id : "";
      if (id) modelCache = { id, until: nowMs() + 5 * 60_000 };
      return { id, down: false };
    } catch {
      return { id: "", down: true };
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
      const waking = waker.state();
      if (waking !== "idle") {
        json(res, 200, { state: waking, model: cfg.model, maxConcurrent: cfg.maxConcurrent, ...(waking === "starting" ? { retryAfter: RETRY_AFTER_S } : { error: NO_MEMORY_MESSAGE }) });
        return;
      }
      let state = inFlight >= cfg.maxConcurrent ? "busy" : await probe();
      const m = state === "ready" ? await resolveModel() : { id: cfg.model, down: false };
      if (state === "ready" && !m.id) state = "starting";
      if (state === "starting" && waker.enabled()) {
        const s = await waker.wake();
        if (s === "no_memory") { json(res, 200, { state: "no_memory", model: cfg.model, error: NO_MEMORY_MESSAGE, maxConcurrent: cfg.maxConcurrent }); return; }
        if (s === "starting") { json(res, 200, { state: "starting", model: cfg.model, retryAfter: RETRY_AFTER_S, maxConcurrent: cfg.maxConcurrent }); return; }
      }
      json(res, 200, { state, model: m.id, maxConcurrent: cfg.maxConcurrent });
      return;
    }
    if (pathname !== `${AI_PATH}/v1/chat/completions`) { json(res, 404, { error: "Not found" }); return; }
    if (req.method !== "POST") { json(res, 405, { error: "Use POST" }); return; }
    const user = String(req.headers["x-ms-client-principal-name"] || "").trim();
    if (!user) { json(res, 401, { error: "Sign in to use the takeoff AI" }); return; }
    if (!cfg.upstream) { json(res, 503, { error: "The takeoff AI is not set up on this site", state: "off" }); return; }
    // a wake under way: answer at once, no upstream call and no second wake
    const waking = waker.state();
    if (waking === "starting") { json(res, 503, STARTING_WAKE); return; }
    if (waking === "no_memory") { json(res, 503, NO_MEMORY); return; }
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
      const m = await resolveModel();
      if (!m.id) { if (m.down) await down(res); else json(res, 503, STARTING); return; }
      const model = m.id;
      let upstream;
      try {
        upstream = await fetchImpl(`${cfg.upstream}/chat/completions`, {
          method: "POST", headers: upstreamHeaders(cfg), body: JSON.stringify(upstreamBody(body, cfg, model)),
          redirect: "manual", signal: AbortSignal.timeout(cfg.timeoutMs),
        });
      } catch (e) {
        log.warn?.(`ai-proxy upstream unreachable (${e?.name || "error"})`);
        if (e?.name === "TimeoutError") json(res, 503, STARTING);   // slow, not down: no wake
        else { modelCache = null; await down(res); }
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
      if (c.kind === "starting") { statusCache = null; modelCache = null; await down(res); return; }
      if (c.kind === "refused") { json(res, 502, { error: "The takeoff AI refused this site's credentials", state: "off" }); return; }
      json(res, 502, { error: `The takeoff AI failed (HTTP ${upstream.status})` });
    } finally {
      inFlight -= 1;
    }
  };
}
