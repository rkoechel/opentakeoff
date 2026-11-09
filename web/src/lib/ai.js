// Bring-your-own-AI — strictly opt-in, dormant until configured.
//
// The in-canvas takeoff agent (agentLoop.js) runs on a vision model YOU
// provide. You point it at an endpoint you control: a hosted API or a local
// runtime on your own machine (most local runtimes speak the OpenAI-style
// protocol). Nothing is ever sent anywhere except the agent's requests to YOUR
// endpoint, while a run you started is going; unconfigured builds make zero AI
// network calls. No telemetry.
// The code is open so anyone can audit exactly this.
//
// Config lives per-browser (localStorage) with build-time VITE_* fallbacks for
// self-hosted team deploys. WARNING for deployers: Vite inlines VITE_AI_KEY
// into the shipped JS bundle — anyone who can load the page can read it.
// Never set it on a public deploy; it exists for private/team builds only.
// The FLOOR360 private build ignores these VITE_AI_* fallbacks entirely.
//
// FLOOR360 private build: the agent is locked to this site's own /api/ai
// proxy (scripts/floor360-ai-proxy.mjs), which adds the DGX's credentials
// server-side and picks the model. localStorage and VITE_AI_* are ignored, no
// key is ever held in the browser, and the settings can't be changed.

import { floor360PrivateBuild } from "./privateBuild.js";

import { clampHistoryTurns } from "./agentChat.js";
import { looksLikeSse, parseChatStreamText, readChatStream } from "./chatStream.js";

const KEYS = {
  endpoint: "opentakeoff_ai_endpoint",
  apiKey: "opentakeoff_ai_key",
  model: "opentakeoff_ai_model",
  provider: "opentakeoff_ai_provider",
  historyTurns: "opentakeoff_ai_history_turns",
};

// Build-time VITE_AI_* values are ignored on the private build so a key in
// the deploy environment is never read (aiConfig returns PRIVATE_AI_CONFIG
// there before it reads anything).
const env = (name) => {
  if (floor360PrivateBuild()) return "";
  return (import.meta.env && import.meta.env[name]) || "";
};

function readKey(k, envName) {
  try {
    const v = localStorage.getItem(KEYS[k]);
    if (v) return v;
  } catch { /* private mode */ }
  return env(envName);
}

/** The private build's only AI config: this origin's proxy. The model
 *  name is a label; the proxy sends its own AI_MODEL. */
export const PRIVATE_AI_CONFIG = Object.freeze({ endpoint: "/api/ai", apiKey: "", model: "floor360-takeoff", provider: "openai" });
export const PRIVATE_AI_STATUS_URL = "/api/ai/status";

/** Current config. provider: "openai" (OpenAI-style — the default; local
 *  runtimes speak it) | "anthropic" (Anthropic-style). historyTurns: how many
 *  earlier chat turns ride along with each new message (0–20, default 8 —
 *  "Conversation memory" in AI settings). */
export function aiConfig() {
  if (floor360PrivateBuild()) return { ...PRIVATE_AI_CONFIG };
  return {
    endpoint: readKey("endpoint", "VITE_AI_ENDPOINT"),
    apiKey: readKey("apiKey", "VITE_AI_KEY"),
    model: readKey("model", "VITE_AI_MODEL"),
    provider: readKey("provider", "VITE_AI_PROVIDER") || "openai",
    historyTurns: clampHistoryTurns(readKey("historyTurns", "VITE_AI_HISTORY_TURNS")),
  };
}

/** Configured = endpoint + model. A key is optional — local runtimes need none. */
export function isAiConfigured() {
  const c = aiConfig();
  return !!(c.endpoint && c.model);
}

/** @param {{ endpoint?: string, apiKey?: string, model?: string, provider?: string, historyTurns?: number | string | null }} cfg */
export function saveAiConfig({ endpoint, apiKey, model, provider, historyTurns }) {
  if (floor360PrivateBuild()) return;   // locked to /api/ai
  try {
    for (const [k, v] of [["endpoint", endpoint], ["apiKey", apiKey], ["model", model], ["provider", provider]]) {
      if (v) localStorage.setItem(KEYS[k], v);
      else localStorage.removeItem(KEYS[k]);
    }
    // 0 is a real choice (no memory), so this one is stored whenever it's set;
    // blank / missing goes back to the default
    if (historyTurns === "" || historyTurns == null) localStorage.removeItem(KEYS.historyTurns);
    else localStorage.setItem(KEYS.historyTurns, String(clampHistoryTurns(historyTurns)));
  } catch { /* private mode */ }
}

// ── pure request plumbing (unit-tested; no fetch, no DOM) ───────────────────

/** Base URL → full request URL. A path that already ends in the protocol's
 *  completion route is used as-is; otherwise the standard route is appended. */
export function aiRequestUrl(endpoint, provider) {
  const base = (endpoint || "").replace(/\/+$/, "");
  if (provider === "anthropic") {
    return /\/messages$/.test(base) ? base : `${base}/v1/messages`;
  }
  return /\/chat\/completions$/.test(base) ? base : `${base}/v1/chat/completions`;
}

/** One vision request: an image + a question. Returns {url, headers, body}
 *  (body as an object — the caller JSON.stringifies). */
export function buildVisionRequest(cfg, { imageDataUrl, prompt, maxTokens = 100 }) {
  const url = aiRequestUrl(cfg.endpoint, cfg.provider);
  if (cfg.provider === "anthropic") {
    const m = /^data:(image\/\w+);base64,(.*)$/s.exec(imageDataUrl) || [];
    const headers = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      // the protocol's explicit acknowledgment that the key lives client-side —
      // which is exactly the bring-your-own-key model here
      "anthropic-dangerous-direct-browser-access": "true",
    };
    if (cfg.apiKey) headers["x-api-key"] = cfg.apiKey;
    return {
      url, headers,
      body: {
        model: cfg.model, max_tokens: maxTokens,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: m[1] || "image/jpeg", data: m[2] || "" } },
          { type: "text", text: prompt },
        ] }],
      },
    };
  }
  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  return {
    url, headers,
    body: {
      model: cfg.model, max_tokens: maxTokens,
      messages: [{ role: "user", content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: imageDataUrl } },
      ] }],
    },
  };
}

/** Model reply JSON → trimmed text, or null when there's none to be had. */
export function parseVisionResponse(provider, json) {
  if (!json || typeof json !== "object") return null;
  if (provider === "anthropic") {
    if (json.stop_reason === "refusal") return null;
    const block = Array.isArray(json.content) ? json.content.find((b) => b && b.type === "text") : null;
    return block && typeof block.text === "string" ? block.text.trim() : null;
  }
  const content = json.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const text = content.filter((p) => p && typeof p.text === "string").map((p) => p.text).join(" ").trim();
    return text || null;
  }
  return null;
}

/** Constrained scale-reading prompt: exactly one known label, or UNKNOWN. */
export function scaleReadPrompt(labels) {
  return `This image is the title block region of a construction drawing. Find the stated drawing scale (usually after the word SCALE). Reply with exactly one of the following labels, character for character, or the single word UNKNOWN if no scale is stated. Labels: ${labels.join(" | ")}. Reply with the label only — no other words.`;
}

/** One chat-with-tools turn: system + running messages + tool declarations.
 *  Returns {url, headers, body} (body as an object — the caller stringifies).
 *  Same key/endpoint handling as buildVisionRequest; `messages` and `tools`
 *  are already in the PROVIDER's own shape (agentLoop owns that translation —
 *  Anthropic-style tools/tool_use/tool_result vs OpenAI-style function
 *  calling), so this stays pure request plumbing. */
export function buildChatRequest(cfg, { system, messages, tools, maxTokens = 4096, stream = false }) {
  const streamFlag = stream ? { stream: true } : {};
  const url = aiRequestUrl(cfg.endpoint, cfg.provider);
  if (cfg.provider === "anthropic") {
    const headers = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
    if (cfg.apiKey) headers["x-api-key"] = cfg.apiKey;
    return { url, headers, body: { model: cfg.model, max_tokens: maxTokens, ...(system ? { system } : {}), messages, ...(tools?.length ? { tools } : {}), ...streamFlag } };
  }
  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  return {
    url, headers,
    body: {
      model: cfg.model, max_tokens: maxTokens,
      messages: [...(system ? [{ role: "system", content: system }] : []), ...messages],
      ...(tools?.length ? { tools } : {}),
      ...streamFlag,
    },
  };
}

export const AI_STARTING_MESSAGE = "Starting the takeoff AI… (usually ~1–2 min)";
export const AI_NO_MEMORY_MESSAGE = "The AI server is out of memory right now. Ask Ryan to free memory on the DGX.";
/** How long chatWithTools keeps retrying while the FLOOR360 proxy reports
 *  the model starting (it starts the DGX container on demand). */
export const AI_START_WAIT_MS = 4 * 60_000;

/** The proxy's 503 while it starts the model: {state: "starting",
 *  retryAfter}. Only the FLOOR360 proxy sends retryAfter, so a BYO endpoint
 *  never triggers the wait. Returns seconds to wait, or 0. */
export function startingRetryAfter(status, body) {
  if (status !== 503 || !body || body.state !== "starting") return 0;
  const s = Number(body.retryAfter);
  return Number.isFinite(s) && s > 0 ? Math.min(15, Math.max(3, s)) : 0;
}

const waitFor = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(Object.assign(new Error("aborted"), { name: "AbortError" })); return; }
  const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); };
  signal?.addEventListener("abort", onAbort, { once: true });
});

/** A failed reply as a plain-language message. The FLOOR360 proxy answers
 *  {error, state}: "busy" (its two slots are taken, or the model is) and
 *  "starting" (the model is loading or the DGX is waking) get their own
 *  wording; another proxy error string is shown as written. Any other
 *  endpoint keeps the generic HTTP message. */
export function aiHttpError(status, body) {
  const state = body && typeof body === "object" ? body.state : undefined;
  if (state === "busy") return "AI busy — the takeoff AI is already working on two requests. Try again in a minute.";
  if (state === "starting") return "AI starting — the takeoff AI is warming up. Try again in a minute.";
  if (state === "no_memory") return AI_NO_MEMORY_MESSAGE;
  if (body && typeof body.error === "string" && body.error) return `${body.error} (HTTP ${status}).`;
  return `AI request failed (HTTP ${status}).`;
}

// ── the seam every AI consumer goes through ─────────────────────────────────

/** Send one vision query to the user's configured endpoint. Throws with a
 *  plain-language message on any failure. */
export async function visionQuery({ imageDataUrl, prompt, maxTokens = 100 }) {
  const cfg = aiConfig();
  if (!isAiConfigured()) throw new Error("AI isn't configured — open AI settings first.");
  const { url, headers, body } = buildVisionRequest(cfg, { imageDataUrl, prompt, maxTokens });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctl.signal });
  } catch (e) {
    throw new Error(e?.name === "AbortError"
      ? "The endpoint took more than 30 seconds — check the model is loaded."
      : "Couldn't reach the endpoint — check the URL, and that it allows browser requests (CORS).");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(aiHttpError(res.status, await res.json().catch(() => null)));
  const text = parseVisionResponse(cfg.provider, await res.json().catch(() => null));
  if (text == null) throw new Error("The endpoint replied, but not with text.");
  return text;
}

// Endpoints seen NOT to stream this session (they refused `stream`, or
// answered it with plain JSON), keyed by request URL + model: later turns ask
// them for plain JSON straight away instead of paying a refused request each
// time. Memory only — a reload tries streaming again.
const noStream = new Set();
/** Forget which endpoints refused to stream (tests; a settings change). */
export function forgetStreamSupport() { noStream.clear(); }

// A runtime that doesn't understand `stream: true` typically rejects the body
// (400 / 422) or the mode (415 / 501). Those get ONE plain retry; any other
// status (401, 429, 5xx…) is the endpoint's real answer and is reported.
const STREAM_REFUSED = new Set([400, 415, 422, 501]);
const TURN_IDLE_MS = 120000;

/** Send one chat-with-tools request (the agent loop's transport). Same
 *  config/endpoint machinery as visionQuery — the user's own key, their own
 *  endpoint, nothing else; no telemetry.
 *
 *  stream: true asks the endpoint to stream (Anthropic Messages SSE /
 *  OpenAI-style `stream: true`); every piece of answer text then goes to
 *  onTextDelta as it arrives, tool calls assemble in full, and the resolved
 *  value is the SAME assistant JSON a non-streaming reply would have been.
 *  An endpoint that refuses `stream` (400/415/422/501) is retried once
 *  without it; one that answers plain JSON is simply read as JSON. Either way
 *  it's remembered for the session (forgetStreamSupport).
 *
 *  Throws with a plain-language message on any transport failure; an
 *  AbortError from the caller's signal (Stop) is re-thrown as an AbortError so
 *  the loop can tell "stopped" from "broken", mid-stream included. The 2-minute
 *  timeout is an IDLE timeout: it re-arms on every streamed chunk, so a long
 *  answer that keeps arriving is never cut off.
 *
 *  While the FLOOR360 proxy starts the model on demand it answers 503 {state:
 *  "starting", retryAfter}: onWait hears AI_STARTING_MESSAGE once, and the
 *  request is retried for up to startWaitMs. The proxy holds the one wake;
 *  retries never add another. Any other failure is worded by aiHttpError.
 *  `cfg`/`fetchFn`/`sleepFn`/`nowFn` are injectable for tests (default: live
 *  config + fetch + real time).
 * @param {{
 *   cfg?: { endpoint: string, apiKey?: string, model: string, provider?: string },
 *   system?: string, messages: any[], tools?: any[], maxTokens?: number,
 *   signal?: AbortSignal, fetchFn?: typeof fetch,
 *   stream?: boolean, onTextDelta?: (text: string) => void,
 *   onWait?: (text: string) => void, sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   startWaitMs?: number, nowFn?: () => number,
 * }} opts */
export async function chatWithTools({ cfg, system, messages, tools, maxTokens = 4096, signal, fetchFn, stream = false, onTextDelta, onWait, sleepFn = waitFor, startWaitMs = AI_START_WAIT_MS, nowFn = Date.now }) {
  const c = cfg || aiConfig();
  if (!(c.endpoint && c.model)) throw new Error("AI isn't configured — open AI settings first.");
  const provider = c.provider === "anthropic" ? "anthropic" : "openai";
  const memo = `${aiRequestUrl(c.endpoint, c.provider)}\n${c.model}`;
  let wantStream = !!stream && !noStream.has(memo);

  // one controller per call: the caller's Stop, or the idle timer, aborts it
  const ctl = new AbortController();
  let timedOut = false;
  let timer = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; ctl.abort(); }, TURN_IDLE_MS);
  };
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const stopped = () => !!signal?.aborted;
  const abortError = () => { const e = new Error("The operation was aborted."); e.name = "AbortError"; return e; };
  const idle = () => new Error("The endpoint went quiet for more than 2 minutes — check the model is loaded.");

  const send = async (asStream) => {
    const { url, headers, body } = buildChatRequest(c, { system, messages, tools, maxTokens, stream: asStream });
    arm();
    try {
      return await (fetchFn || fetch)(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      if (stopped()) throw abortError();
      if (timedOut || e?.name === "TimeoutError") throw idle();
      if (e?.name === "AbortError") throw e;
      throw new Error("Couldn't reach the endpoint — check the URL, and that it allows browser requests (CORS).");
    }
  };

  try {
    const waitUntil = nowFn() + startWaitMs;
    let told = false;
    let res;
    for (;;) {
      res = await send(wantStream);
      if (wantStream && !res.ok && STREAM_REFUSED.has(res.status)) {
        // the runtime may not know `stream` — ask again, plainly, once
        noStream.add(memo);
        wantStream = false;
        try { await res.body?.cancel?.(); } catch { /* nothing to drain */ }
        res = await send(false);
      }
      if (res.ok) break;
      const errBody = await res.json().catch(() => null);
      const wait = startingRetryAfter(res.status, errBody);
      if (!wait || nowFn() + wait * 1000 > waitUntil) throw new Error(aiHttpError(res.status, errBody));
      if (!told) { told = true; try { onWait?.(AI_STARTING_MESSAGE); } catch { /* a listener must not break the call */ } }
      // the idle timer must not fire while we sleep between start retries
      if (timer) { clearTimeout(timer); timer = null; }
      await sleepFn(wait * 1000, signal);
    }

    const type = typeof res.headers?.get === "function" ? String(res.headers.get("content-type") || "") : "";
    if (wantStream && /text\/event-stream/i.test(type) && res.body && typeof res.body.getReader === "function") {
      try {
        return await readChatStream({ provider, body: res.body, signal: ctl.signal, onTextDelta, onActivity: arm });
      } catch (e) {
        if (stopped()) throw abortError();
        if (timedOut) throw idle();
        throw e;
      }
    }

    // not an event stream (or streaming wasn't asked for): read the body as
    // text when the response can, so a stream sent with the wrong content
    // type is still understood; minimal fetch stubs with only json() work too
    let json = null;
    try {
      if (typeof res.text === "function") {
        const raw = await res.text();
        if (wantStream && looksLikeSse(raw)) return parseChatStreamText(provider, raw, { onTextDelta });
        try { json = JSON.parse(raw); } catch { json = null; }
      } else {
        json = await res.json().catch(() => null);
      }
    } catch (e) {
      if (stopped()) throw abortError();
      if (timedOut) throw idle();
      throw e;
    }
    if (wantStream) noStream.add(memo);   // it answered `stream: true` with plain JSON
    if (!json || typeof json !== "object") throw new Error("The endpoint replied, but not with JSON.");
    return json;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}
