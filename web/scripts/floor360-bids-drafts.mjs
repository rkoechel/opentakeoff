// /api/bids/drafts for the FLOOR360 private build: the reviewer side of
// auto-takeoff. The browser lists the AI takeoff drafts Bids made, claims one
// for review, and reports an approval. It never calls Bids itself: this route
// calls Bids server to server with the App Service managed identity and passes
// only the signed-in Easy Auth user's email.
//
// Dependency-free Node, like floor360-static.mjs, and copied into dist/.
//
//   GET  /api/bids/drafts                 {enabled, user, drafts[]}
//   POST /api/bids/drafts/:runId/claim    200 or 409 {claimedByEmail, claimedAt}
//   POST /api/bids/drafts/:runId/approved 200 {ok}
//
// Bids side (Bids PR E, MI-only):
//   GET  <BIDS_API_URL>/api/auto-takeoff/drafts
//   POST <BIDS_API_URL>/api/auto-takeoff/runs/:runId/claim
//   POST <BIDS_API_URL>/api/auto-takeoff/runs/:runId/approved
// with Authorization: Bearer <managed identity token for BIDS_API_AUDIENCE>
// and X-Auto-Takeoff-User-Email: <the Easy Auth user's email>.
//
// App settings (values are never logged or returned):
//   FLOOR360_AI_DRAFTS   on | 1 | true turns the route on. Unset or anything
//                        else: every path here is a 404, like an unknown route.
//   BIDS_API_URL         https://bids.floor360.com (https only)
//   BIDS_API_AUDIENCE    default api://f2471322-f309-465c-b467-6915a020f5da
//   BIDS_API_TIMEOUT_MS  default 15000, for the token and every Bids call
//   AZURE_CLIENT_ID      only for a user-assigned identity
//
// The token comes from IDENTITY_ENDPOINT / IDENTITY_HEADER (set by App Service
// when its identity is on) and is cached until 5 minutes before it expires.
// The signed-in user comes from Easy Auth's X-MS-CLIENT-PRINCIPAL(-NAME),
// which App Service sets and strips from client requests. No user, no call.

export const BIDS_DRAFTS_PATH = "/api/bids/drafts";
export const DEFAULT_BIDS_API_AUDIENCE = "api://f2471322-f309-465c-b467-6915a020f5da";
export const DEFAULT_BIDS_TIMEOUT_MS = 15000;
export const USER_EMAIL_HEADER = "X-Auto-Takeoff-User-Email";
export const BIDS_REFUSED_MESSAGE = "Bids hasn't accepted this site's identity yet (Appendix B). Ask Ryan to finish the Bids Easy Auth change.";
const TOKEN_MARGIN_MS = 5 * 60_000;
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const EMAIL_CLAIMS = [
  "preferred_username", "email", "upn",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
];
const NAME_CLAIMS = ["name", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"];

function intSetting(value, fallback) {
  if (value == null || String(value).trim() === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function httpsBase(value) {
  const v = String(value || "").trim().replace(/\/+$/, "");
  try {
    const u = new URL(v);
    if (u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash) return v;
  } catch { /* below */ }
  return "";
}

export function flagOn(value) {
  return /^(1|on|true|yes)$/i.test(String(value ?? "").trim());
}

export function bidsDraftsConfig(env = process.env) {
  return {
    enabled: flagOn(env.FLOOR360_AI_DRAFTS),
    bidsUrl: httpsBase(env.BIDS_API_URL),
    audience: String(env.BIDS_API_AUDIENCE || "").trim() || DEFAULT_BIDS_API_AUDIENCE,
    identityEndpoint: String(env.IDENTITY_ENDPOINT || "").trim(),
    identityHeader: String(env.IDENTITY_HEADER || "").trim(),
    clientId: String(env.AZURE_CLIENT_ID || "").trim(),
    timeoutMs: intSetting(env.BIDS_API_TIMEOUT_MS, DEFAULT_BIDS_TIMEOUT_MS),
  };
}

// ── the Easy Auth user ──────────────────────────────────────────────────────

function principalClaims(raw) {
  if (!raw) return [];
  try {
    const p = JSON.parse(Buffer.from(String(raw), "base64").toString("utf8"));
    return Array.isArray(p?.claims) ? p.claims.filter((c) => c && typeof c.typ === "string" && typeof c.val === "string") : [];
  } catch {
    return [];
  }
}

/** {email, name} of the signed-in Easy Auth user, or null. The email is the
 *  principal's email/UPN claim, else X-MS-CLIENT-PRINCIPAL-NAME. */
export function easyAuthUser(headers = {}) {
  const claims = principalClaims(headers["x-ms-client-principal"]);
  const claim = (types) => {
    for (const t of types) {
      const c = claims.find((x) => x.typ.toLowerCase() === t.toLowerCase() && x.val.trim());
      if (c) return c.val.trim();
    }
    return "";
  };
  const principalName = String(headers["x-ms-client-principal-name"] || "").trim();
  const email = [claim(EMAIL_CLAIMS), principalName].find((v) => EMAIL.test(v)) || "";
  if (!email) return null;
  const name = claim(NAME_CLAIMS).slice(0, 120) || email;
  return { email: email.toLowerCase(), name };
}

// ── managed identity token ──────────────────────────────────────────────────

/** A token for cfg.audience from the App Service identity endpoint, cached
 *  until 5 minutes before it expires; one fetch at a time. get() -> token or
 *  null; drop() forgets it (after Bids answers 401). */
export function createIdentityToken(cfg, fetchImpl, nowMs = () => Date.now()) {
  let cached = null;
  let pending = null;
  async function fetchToken() {
    const url = new URL(cfg.identityEndpoint);
    url.searchParams.set("resource", cfg.audience);
    url.searchParams.set("api-version", "2019-08-01");
    if (cfg.clientId) url.searchParams.set("client_id", cfg.clientId);
    try {
      const res = await fetchImpl(url, { headers: { "X-IDENTITY-HEADER": cfg.identityHeader }, signal: AbortSignal.timeout(cfg.timeoutMs) });
      if (!res.ok) return null;
      const body = await res.json();
      if (typeof body?.access_token !== "string" || !body.access_token) return null;
      const on = Number(body.expires_on);
      const inSec = Number(body.expires_in);
      const expiresMs = Number.isFinite(on) && on > 0 ? on * 1000 : Number.isFinite(inSec) && inSec > 0 ? nowMs() + inSec * 1000 : nowMs() + 30 * 60_000;
      cached = { token: body.access_token, expiresMs };
      return cached.token;
    } catch {
      return null;
    }
  }
  return {
    configured: () => Boolean(cfg.identityEndpoint && cfg.identityHeader),
    async get() {
      if (!cfg.identityEndpoint || !cfg.identityHeader) return null;
      if (cached && cached.expiresMs - TOKEN_MARGIN_MS > nowMs()) return cached.token;
      if (!pending) pending = fetchToken().finally(() => { pending = null; });
      return pending;
    },
    drop() { cached = null; },
  };
}

// ── Bids answers ────────────────────────────────────────────────────────────

const str = (v, max = 300) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : "");
const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const httpsUrl = (v) => {
  const s = str(v, 2000);
  try { return s && new URL(s).protocol === "https:" ? s : ""; } catch { return ""; }
};

/** One draft as the browser gets it: the contract's fields only. */
export function sanitizeDraft(d) {
  if (!d || typeof d !== "object") return null;
  const runId = str(d.runId, 64);
  if (!RUN_ID.test(runId)) return null;
  const c = d.counts && typeof d.counts === "object" ? d.counts : {};
  const out = {
    runId,
    bidId: str(d.bidId, 64),
    bidNumber: str(d.bidNumber, 64),
    projectName: str(d.projectName),
    gc: str(d.gc),
    dueAt: str(d.dueAt, 40),
    status: str(d.status, 40),
    sharepointFolderId: str(d.sharepointFolderId, 64),
    sharepointFolderUrl: httpsUrl(d.sharepointFolderUrl),
    claimedByEmail: str(d.claimedByEmail, 200).toLowerCase(),
    claimedAt: str(d.claimedAt, 40),
    counts: { sheets: count(c.sheets), rooms: count(c.rooms), conditions: count(c.conditions), rfisDrafted: count(c.rfisDrafted) },
  };
  const claimedByName = str(d.claimedByName, 120);
  if (claimedByName) out.claimedByName = claimedByName;
  return out;
}

export function sanitizeClaim(b) {
  const out = { claimedByEmail: str(b?.claimedByEmail, 200).toLowerCase(), claimedAt: str(b?.claimedAt, 40) };
  const claimedByName = str(b?.claimedByName, 120);
  if (claimedByName) out.claimedByName = claimedByName;
  return out;
}

/** A Bids status the browser can't use, as {status, error}. A redirect (to
 *  the Easy Auth login), 401 or 403 is Bids not accepting this identity. */
export function bidsFailure(status) {
  if (status === 401 || status === 403 || (status >= 300 && status < 400)) return { status: 502, error: BIDS_REFUSED_MESSAGE, code: "bids_refused" };
  if (status === 404) return { status: 404, error: "Bids doesn't have that AI takeoff run.", code: "not_found" };
  return { status: 502, error: `Bids couldn't answer right now (HTTP ${status}).`, code: "bids_failed" };
}

// ── HTTP handler ────────────────────────────────────────────────────────────

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

export function createBidsDraftsHandler({ env = process.env, fetchImpl = globalThis.fetch, nowMs = () => Date.now(), log = console } = {}) {
  const cfg = bidsDraftsConfig(env);
  const token = createIdentityToken(cfg, fetchImpl, nowMs);

  /** {status, body} from Bids, or {fail: {status, error, code}}. */
  async function callBids(path, method, user) {
    if (!cfg.bidsUrl) return { fail: { status: 503, error: "Bids isn't set up on this site (BIDS_API_URL).", code: "not_configured" } };
    if (!token.configured()) return { fail: { status: 503, error: "This site has no managed identity turned on, so it can't call Bids.", code: "no_identity" } };
    const bearer = await token.get();
    if (!bearer) return { fail: { status: 503, error: "This site couldn't get its managed-identity token for Bids (BIDS_API_AUDIENCE).", code: "no_token" } };
    const headers = { Accept: "application/json", Authorization: `Bearer ${bearer}`, [USER_EMAIL_HEADER]: user.email };
    const init = { method, headers, redirect: "manual", signal: AbortSignal.timeout(cfg.timeoutMs) };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify({ email: user.email });
    }
    let res;
    try {
      res = await fetchImpl(`${cfg.bidsUrl}${path}`, init);
    } catch (e) {
      const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
      log.warn?.(`bids-drafts ${method} ${timeout ? "timeout" : "unreachable"}`);
      return { fail: timeout
        ? { status: 504, error: `Bids didn't answer in ${Math.round(cfg.timeoutMs / 1000)} s. Try again.`, code: "timeout" }
        : { status: 502, error: "Couldn't reach Bids from this site.", code: "unreachable" } };
    }
    log.info?.(`bids-drafts ${method} upstream ${res.status}`);
    if (res.status === 401) token.drop();
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body };
  }

  return async function handleBidsDrafts(req, res) {
    if (!cfg.enabled) { json(res, 404, { error: "Not found" }); return; }
    const pathname = new URL(req.url || "/", "http://localhost").pathname.replace(/\/+$/, "");
    const rest = pathname.slice(BIDS_DRAFTS_PATH.length);
    const action = rest === "" ? { kind: "list" } : (() => {
      const m = /^\/([^/]+)\/(claim|approved)$/.exec(rest);
      return m ? { kind: m[2], runId: m[1] } : null;
    })();
    if (!action) { json(res, 404, { error: "Not found" }); return; }
    const wantMethod = action.kind === "list" ? "GET" : "POST";
    if (req.method !== wantMethod) { json(res, 405, { error: `Use ${wantMethod}` }); return; }
    const user = easyAuthUser(req.headers);
    if (!user) { json(res, 401, { error: "Sign in to see AI takeoff drafts" }); return; }
    const base = { enabled: true, user };

    if (action.kind === "list") {
      const r = await callBids("/api/auto-takeoff/drafts", "GET", user);
      if (r.fail) { json(res, r.fail.status, { ...base, drafts: [], error: r.fail.error, code: r.fail.code }); return; }
      if (r.status !== 200) { const f = bidsFailure(r.status); json(res, f.status, { ...base, drafts: [], error: f.error, code: f.code }); return; }
      const drafts = (Array.isArray(r.body?.drafts) ? r.body.drafts : []).map(sanitizeDraft).filter(Boolean);
      json(res, 200, { ...base, drafts });
      return;
    }

    // a POST changes state in Bids: same-site JSON only, so a cross-site form can't send one
    if (String(req.headers["sec-fetch-site"] || "") === "cross-site") { json(res, 403, { error: "Cross-site request refused" }); return; }
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) { json(res, 415, { error: "Send JSON" }); return; }
    if (!RUN_ID.test(action.runId)) { json(res, 400, { ...base, error: "That isn't an AI takeoff run id." }); return; }
    const r = await callBids(`/api/auto-takeoff/runs/${encodeURIComponent(action.runId)}/${action.kind}`, "POST", user);
    if (r.fail) { json(res, r.fail.status, { ...base, error: r.fail.error, code: r.fail.code }); return; }
    if (action.kind === "claim" && (r.status === 200 || r.status === 409)) {
      json(res, r.status, { ...base, ...sanitizeClaim(r.body), ...(r.status === 409 ? { code: "already_claimed" } : {}) });
      return;
    }
    if (action.kind === "approved" && r.status >= 200 && r.status < 300) { json(res, 200, { ...base, ok: true }); return; }
    const f = bidsFailure(r.status);
    json(res, f.status, { ...base, error: f.error, code: f.code });
  };
}
