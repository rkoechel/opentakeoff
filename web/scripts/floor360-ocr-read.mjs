// POST /api/ocr/read for the FLOOR360 private build: "Hard scan? Read with
// Azure". The browser sends one PNG or JPEG of the box it drew; this route
// sends it to Azure AI Document Intelligence (prebuilt-read) and returns the
// text lines with their pixel polygons. The browser maps them into OCR words the
// same way the on-device reader's are (lib/ocr/azureRead.ts).
//
// Dependency-free Node, like floor360-static.mjs (dist is deployed without
// npm install), so it is copied into dist/ next to it.
//
// The resource is DI_ENDPOINT (https://<name>.cognitiveservices.azure.com;
// DOCUMENT_INTELLIGENCE_ENDPOINT, the Build portal's name, also works).
// The free F0 tier takes 2 pages and 4 MB a request and only a few requests a
// second: this route sends 1 page, at most 4 MB (OCR_MAX_IMAGE_BYTES), runs
// one Azure read at a time, and backs off and retries on HTTP 429.
//
// Auth to Azure, in order:
//   1. The App Service managed identity (IDENTITY_ENDPOINT + IDENTITY_HEADER,
//      which App Service sets when an identity is on; AZURE_CLIENT_ID picks a
//      user-assigned one). This is the managed-identity leg of
//      DefaultAzureCredential, done with fetch. The identity needs the
//      "Cognitive Services User" role on the resource.
//   2. DI_KEY (or DOCUMENT_INTELLIGENCE_KEY / _API_KEY), only
//      when no identity token can be had.
// Neither the key nor a token is ever logged or sent to the browser.
//
// Cost caps, checked and counted here before Azure is called:
//   OCR_MONTHLY_PAGE_CAP  pages a calendar month (UTC) for the site, default 300
//   OCR_USER_DAILY_CAP    pages a UTC day for one signed-in user, default 100
// One request is one image, which Azure bills as one page. The counter lives
// in OCR_USAGE_FILE (default /home/data/opentakeoff/ocr-usage.json; /home is
// the App Service share that survives restarts and deploys) and is written
// atomically. A request Azure refuses at submit is not counted.
//
// The signed-in user comes from Easy Auth's X-MS-CLIENT-PRINCIPAL-NAME,
// which App Service sets and strips from client requests. No user, no read.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const OCR_READ_PATH = "/api/ocr/read";
export const DEFAULT_MONTHLY_PAGE_CAP = 300;
export const DEFAULT_USER_DAILY_CAP = 100;
export const DEFAULT_USAGE_FILE = "/home/data/opentakeoff/ocr-usage.json";
export const DEFAULT_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const COGNITIVE_RESOURCE = "https://cognitiveservices.azure.com";
const DI_PATH = "/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-11-30";
const FR_PATH = "/formrecognizer/documentModels/prebuilt-read:analyze?api-version=2023-07-31";

function intSetting(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function ocrReadConfig(env = process.env) {
  const endpoint = String(env.DI_ENDPOINT || env.DOCUMENT_INTELLIGENCE_ENDPOINT || "").trim().replace(/\/+$/, "");
  return {
    endpoint: /^https:\/\/[^/]+$/.test(endpoint) ? endpoint : "",
    key: String(env.DI_KEY || env.DOCUMENT_INTELLIGENCE_KEY || env.DOCUMENT_INTELLIGENCE_API_KEY || "").trim(),
    identityEndpoint: String(env.IDENTITY_ENDPOINT || "").trim(),
    identityHeader: String(env.IDENTITY_HEADER || "").trim(),
    clientId: String(env.AZURE_CLIENT_ID || "").trim(),
    monthlyCap: intSetting(env.OCR_MONTHLY_PAGE_CAP, DEFAULT_MONTHLY_PAGE_CAP),
    userDailyCap: intSetting(env.OCR_USER_DAILY_CAP, DEFAULT_USER_DAILY_CAP),
    usageFile: String(env.OCR_USAGE_FILE || DEFAULT_USAGE_FILE),
    maxImageBytes: intSetting(env.OCR_MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGE_BYTES) || DEFAULT_MAX_IMAGE_BYTES,
    timeoutMs: intSetting(env.OCR_TIMEOUT_MS, 60000) || 60000,
  };
}

// ── usage counter ───────────────────────────────────────────────────────────

export function createUsageStore(file) {
  let chain = Promise.resolve();
  const load = () => {
    try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; }
  };
  const save = (data) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
  };
  /** Run fn(data) -> result with the file loaded, saving data after; calls
   *  are serialized so two reads can't both take the last page. */
  const update = (fn) => {
    const run = chain.then(() => {
      const data = load();
      const out = fn(data);
      save(data);
      return out;
    });
    chain = run.catch(() => {});
    return run;
  };
  return { update, load };
}

const monthKey = (d) => d.toISOString().slice(0, 7);
const dayKey = (d) => d.toISOString().slice(0, 10);

function roll(data, now) {
  if (data.month !== monthKey(now)) { data.month = monthKey(now); data.monthPages = 0; }
  if (data.day !== dayKey(now)) { data.day = dayKey(now); data.users = {}; }
  data.monthPages = Number(data.monthPages) || 0;
  data.users = data.users && typeof data.users === "object" ? data.users : {};
}

/** Take one page for `user`, or say which cap stops it. */
export function reservePage(data, user, cfg, now) {
  roll(data, now);
  const userPages = Number(data.users[user]) || 0;
  const usage = { monthPages: data.monthPages, monthlyCap: cfg.monthlyCap, userPages, userDailyCap: cfg.userDailyCap };
  if (data.monthPages >= cfg.monthlyCap) return { ok: false, reason: "monthly-cap", usage };
  if (userPages >= cfg.userDailyCap) return { ok: false, reason: "daily-cap", usage };
  data.monthPages += 1;
  data.users[user] = userPages + 1;
  return { ok: true, usage: { ...usage, monthPages: data.monthPages, userPages: userPages + 1 } };
}

export function refundPage(data, user, now) {
  roll(data, now);
  data.monthPages = Math.max(0, data.monthPages - 1);
  data.users[user] = Math.max(0, (Number(data.users[user]) || 0) - 1);
}

// ── Azure credential ────────────────────────────────────────────────────────

export function createCredential(cfg, fetchImpl, nowMs = () => Date.now()) {
  let cached = null;
  async function identityToken() {
    if (!cfg.identityEndpoint || !cfg.identityHeader) return null;
    if (cached && cached.expiresMs - 5 * 60_000 > nowMs()) return cached.token;
    const url = new URL(cfg.identityEndpoint);
    url.searchParams.set("resource", COGNITIVE_RESOURCE);
    url.searchParams.set("api-version", "2019-08-01");
    if (cfg.clientId) url.searchParams.set("client_id", cfg.clientId);
    try {
      const res = await fetchImpl(url, { headers: { "X-IDENTITY-HEADER": cfg.identityHeader } });
      if (!res.ok) return null;
      const body = await res.json();
      if (!body?.access_token) return null;
      const expiresSec = Number(body.expires_on);
      cached = { token: body.access_token, expiresMs: Number.isFinite(expiresSec) ? expiresSec * 1000 : nowMs() + 30 * 60_000 };
      return cached.token;
    } catch {
      return null;
    }
  }
  return {
    async headers() {
      const token = await identityToken();
      if (token) return { Authorization: `Bearer ${token}` };
      if (cfg.key) return { "Ocp-Apim-Subscription-Key": cfg.key };
      return null;
    },
    configured: () => Boolean(cfg.endpoint && ((cfg.identityEndpoint && cfg.identityHeader) || cfg.key)),
  };
}

// ── Document Intelligence Read ──────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class SubmitError extends Error {}

export const RETRY_DELAYS_MS = [1000, 2000, 4000];

/** fetch, retried on 429 after Retry-After (capped at 5 s) or the next
 *  RETRY_DELAYS_MS step. */
async function fetch429(fetchImpl, url, init, delays) {
  for (let i = 0; ; i++) {
    const res = await fetchImpl(url, init);
    if (res.status !== 429 || i >= delays.length) return res;
    const after = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 5000) : delays[i]);
  }
}

const quad = (p) => Array.isArray(p) && p.length >= 8 && p.slice(0, 8).every((v) => Number.isFinite(Number(v)));

/** The page's lines, each with its polygon and the lowest confidence of the
 *  words inside its text span (lines carry no confidence of their own). */
export function readLines(page) {
  const words = (page.words || []).filter((w) => w?.span && Number.isFinite(Number(w.confidence)));
  return (page.lines || [])
    .filter((l) => typeof l?.content === "string" && quad(l.polygon))
    .map((l) => {
      const spans = Array.isArray(l.spans) ? l.spans : [];
      const inside = words.filter((w) => spans.some((s) => w.span.offset >= s.offset && w.span.offset < s.offset + s.length));
      const line = { content: l.content, polygon: l.polygon.slice(0, 8).map(Number) };
      if (inside.length) line.confidence = Math.min(...inside.map((w) => Number(w.confidence)));
      return line;
    });
}

export async function analyzeRead(bytes, contentType, cfg, credential, fetchImpl, { pollMs = 1000, retryDelays = RETRY_DELAYS_MS } = {}) {
  const auth = await credential.headers();
  if (!auth) throw new SubmitError("no Azure credential");
  let res = null;
  for (const p of [DI_PATH, FR_PATH]) {
    res = await fetch429(fetchImpl, cfg.endpoint + p, { method: "POST", headers: { ...auth, "Content-Type": contentType }, body: bytes }, retryDelays);
    if (res.status !== 404) break;
  }
  if (res.status === 429) throw new SubmitError("Azure OCR is busy (rate limit) — try again in a minute");
  if (res.status !== 202) throw new SubmitError(`Azure refused the read (HTTP ${res.status})`);
  const op = res.headers.get("operation-location");
  if (!op || !op.startsWith(cfg.endpoint + "/")) throw new Error("Azure gave no operation to poll");
  const deadline = Date.now() + cfg.timeoutMs;
  while (Date.now() < deadline) {
    const after = Number(res.headers.get("retry-after"));
    await sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, 2000) : pollMs);
    res = await fetch429(fetchImpl, op, { headers: auth }, retryDelays);
    if (!res.ok) throw new Error(`Azure read poll failed (HTTP ${res.status})`);
    const body = await res.json();
    if (body.status === "succeeded") {
      const page = body.analyzeResult?.pages?.[0] || {};
      return { width: Number(page.width) || 0, height: Number(page.height) || 0, unit: page.unit || "pixel", lines: readLines(page) };
    }
    if (body.status === "failed") throw new Error("Azure could not read the image");
  }
  throw new Error("Azure read timed out");
}

// ── HTTP handler ────────────────────────────────────────────────────────────

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

function imageType(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  return "";
}

export function createOcrReadHandler({ env = process.env, fetchImpl = globalThis.fetch, now = () => new Date(), store, pollMs, retryDelays, log = console } = {}) {
  const cfg = ocrReadConfig(env);
  // one Azure read at a time (F0's low request rate)
  let azureChain = Promise.resolve();
  const oneAtATime = (fn) => { const run = azureChain.then(fn); azureChain = run.catch(() => {}); return run; };
  const usage = store || createUsageStore(cfg.usageFile);
  const credential = createCredential(cfg, fetchImpl);
  return async function handleOcrRead(req, res) {
    if (req.method === "GET") {
      json(res, 200, { enabled: credential.configured(), monthlyCap: cfg.monthlyCap, userDailyCap: cfg.userDailyCap });
      return;
    }
    if (req.method !== "POST") { json(res, 405, { error: "Use POST" }); return; }
    const user = String(req.headers["x-ms-client-principal-name"] || "").trim().toLowerCase();
    if (!user) { json(res, 401, { error: "Sign in to use Azure OCR" }); return; }
    if (!credential.configured()) { json(res, 503, { error: "Azure OCR is not set up on this site" }); return; }
    let bytes;
    try {
      bytes = await readBody(req, cfg.maxImageBytes);
    } catch (e) {
      json(res, e.status || 400, { error: e.status === 413 ? "That box is too large for Azure OCR" : "Couldn't read the upload" });
      return;
    }
    const type = imageType(bytes);
    if (!type) { json(res, 415, { error: "Send a PNG or JPEG" }); return; }
    const reserved = await usage.update((data) => reservePage(data, user, cfg, now()));
    if (!reserved.ok) {
      const error = reserved.reason === "monthly-cap"
        ? `Azure OCR has used this month's ${cfg.monthlyCap} pages`
        : `You've used today's ${cfg.userDailyCap} Azure OCR pages`;
      json(res, 429, { error, reason: reserved.reason, usage: reserved.usage });
      return;
    }
    try {
      const opts = {};
      if (pollMs != null) opts.pollMs = pollMs;
      if (retryDelays) opts.retryDelays = retryDelays;
      const result = await oneAtATime(() => analyzeRead(bytes, type, cfg, credential, fetchImpl, opts));
      log.info?.(`ocr-read ok lines=${result.lines.length} month=${reserved.usage.monthPages}/${cfg.monthlyCap}`);
      json(res, 200, { ...result, usage: reserved.usage });
    } catch (e) {
      if (e instanceof SubmitError) await usage.update((data) => refundPage(data, user, now())).catch(() => {});
      log.warn?.(`ocr-read failed: ${e instanceof SubmitError ? "submit" : "read"}`);
      const error = e instanceof SubmitError ? (/rate limit/.test(e.message) ? e.message : "Azure OCR is unavailable right now") : "Azure couldn't read that box";
      json(res, 502, { error });
    }
  };
}
