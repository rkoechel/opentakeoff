// /api/bids/drafts (scripts/floor360-bids-drafts.mjs): the FLOOR360 static
// server's route to Bids' auto-takeoff API. The App Service identity endpoint
// and Bids are fakes; nothing leaves the process. Pinned: off by default (404,
// no call); the Easy Auth user is required; only that user's email is
// forwarded; the managed-identity token is cached until 5 min before expiry;
// Bids 401/403 reads as the Appendix B message; a 409 claim passes through;
// a Bids 5xx logs one warn line with a redacted 200-char body snippet; no
// token or email is ever returned or logged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticServer } from "../scripts/floor360-static.mjs";
import {
  BIDS_DRAFTS_PATH, BIDS_REFUSED_MESSAGE, DEFAULT_BIDS_API_AUDIENCE, USER_EMAIL_HEADER,
  bidsDraftsConfig, createBidsDraftsHandler, createIdentityToken, easyAuthUser, redactUpstreamSnippet, sanitizeDraft,
} from "../scripts/floor360-bids-drafts.mjs";

const BIDS = "https://bids.test";
const ON = { FLOOR360_AI_DRAFTS: "on", BIDS_API_URL: BIDS, IDENTITY_ENDPOINT: "http://identity.local/msi/token", IDENTITY_HEADER: "id-hdr" };
const DRAFT = {
  runId: "run_1", bidId: "bid-9", bidNumber: "F360-26-0170", projectName: "Perfumania Wauwatosa", gc: "Acme GC",
  dueAt: "2026-10-20T22:00:00Z", status: "draft_ready", sharepointFolderId: "01NF4SHUABCDEFGHIJKLMNOPQRSTUVWX",
  sharepointFolderUrl: "https://floor360com.sharepoint.com/sites/Estimating/x", claimedByEmail: "", claimedAt: "",
  counts: { sheets: 12, rooms: 30, conditions: 7, rfisDrafted: 2 }, secretInternal: "drop me",
};

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
type Reply = { status: number; body?: unknown; text?: string } | Error;

function fakes({ bids = [] as Reply[], identity = [] as Reply[], clock = { now: Date.parse("2026-10-17T19:00:00Z") } } = {}) {
  const calls: Call[] = [];
  let tokenN = 0;
  const fetchImpl = async (url: string | URL, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || "GET", headers: init.headers || {}, body: init.body });
    if (u.startsWith("http://identity.local")) {
      const r = identity.length ? identity.shift()! : { status: 200, body: { access_token: `mi-token-${++tokenN}`, expires_on: String(Math.floor(clock.now / 1000) + 3600) } };
      if (r instanceof Error) throw r;
      return Response.json(r.body, { status: r.status });
    }
    const r = bids.length ? bids.shift()! : { status: 200, body: { drafts: [DRAFT] } };
    if (r instanceof Error) throw r;
    if (r.text !== undefined) return new Response(r.text, { status: r.status, headers: { "Content-Type": "text/html" } });
    return r.body === undefined ? new Response("", { status: r.status }) : Response.json(r.body, { status: r.status });
  };
  return { calls, fetchImpl, clock, identityCalls: () => calls.filter((c) => c.url.startsWith("http://identity.local")), bidsCalls: () => calls.filter((c) => c.url.startsWith(BIDS)) };
}

async function withServer(env: Record<string, string>, f: ReturnType<typeof fakes>, fn: (base: string, logs: string[], warns: string[]) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "bids-drafts-"));
  const logs: string[] = [];
  const warns: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => { logs.push(m); warns.push(m); } } as unknown as Console;
  const handler = createBidsDraftsHandler({ env, fetchImpl: f.fetchImpl as unknown as typeof fetch, nowMs: () => f.clock.now, log });
  const server = createStaticServer(dir, { routes: { [BIDS_DRAFTS_PATH]: handler } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  try { await fn(`http://127.0.0.1:${port}`, logs, warns); } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
}

const USER = { "X-MS-CLIENT-PRINCIPAL-NAME": "rpalermo@floor360.com" };
const get = (base: string, headers: Record<string, string> = USER) => fetch(base + BIDS_DRAFTS_PATH, { headers });
const post = (base: string, path: string, headers: Record<string, string> = { ...USER, "Content-Type": "application/json" }) =>
  fetch(base + BIDS_DRAFTS_PATH + path, { method: "POST", headers, body: "{}" });

test("config: off unless FLOOR360_AI_DRAFTS is on; BIDS_API_URL https only; default audience", () => {
  assert.equal(bidsDraftsConfig({}).enabled, false);
  assert.equal(bidsDraftsConfig({ FLOOR360_AI_DRAFTS: "off" }).enabled, false);
  assert.equal(bidsDraftsConfig({ FLOOR360_AI_DRAFTS: "maybe" }).enabled, false);
  for (const v of ["on", "1", "true", "ON"]) assert.equal(bidsDraftsConfig({ FLOOR360_AI_DRAFTS: v }).enabled, true, v);
  assert.equal(bidsDraftsConfig({}).audience, DEFAULT_BIDS_API_AUDIENCE);
  assert.equal(DEFAULT_BIDS_API_AUDIENCE, "api://f2471322-f309-465c-b467-6915a020f5da");
  assert.equal(bidsDraftsConfig({ BIDS_API_URL: "https://bids.floor360.com/" }).bidsUrl, "https://bids.floor360.com");
  assert.equal(bidsDraftsConfig({ BIDS_API_URL: "http://bids.floor360.com" }).bidsUrl, "");
  assert.equal(bidsDraftsConfig({ BIDS_API_URL: "http://localhost:3000" }).bidsUrl, "");
  assert.equal(bidsDraftsConfig({ BIDS_API_URL: "https://u:p@bids.floor360.com" }).bidsUrl, "");
  assert.equal(bidsDraftsConfig({}).timeoutMs, 15000);
});

test("flag off: every path is a 404 like an unknown route, and nothing is called", async () => {
  const f = fakes();
  await withServer({ ...ON, FLOOR360_AI_DRAFTS: "" }, f, async (base) => {
    assert.equal((await get(base)).status, 404);
    assert.equal((await post(base, "/run_1/claim")).status, 404);
    assert.equal((await post(base, "/run_1/approved")).status, 404);
    assert.deepEqual(await (await get(base)).json(), { error: "Not found" });
  });
  assert.equal(f.calls.length, 0);
});

test("no Easy Auth user: 401 and no identity or Bids call", async () => {
  const f = fakes();
  await withServer(ON, f, async (base) => {
    assert.equal((await get(base, {})).status, 401);
    assert.equal((await post(base, "/run_1/claim", { "Content-Type": "application/json" })).status, 401);
    assert.equal((await get(base, { "X-MS-CLIENT-PRINCIPAL-NAME": "not-an-email" })).status, 401);
  });
  assert.equal(f.calls.length, 0);
});

test("lists drafts with the MI token and only the user's email; sanitized; no token leaks", async () => {
  const f = fakes();
  await withServer(ON, f, async (base, logs) => {
    const res = await get(base, { ...USER, Cookie: "AppServiceAuthSession=abc" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.match(res.headers.get("content-security-policy") || "", /default-src 'self'/);
    const text = await res.text();
    assert.doesNotMatch(text, /mi-token|id-hdr|secretInternal/);
    const body = JSON.parse(text);
    assert.equal(body.enabled, true);
    assert.deepEqual(body.user, { email: "rpalermo@floor360.com", name: "rpalermo@floor360.com" });
    assert.equal(body.drafts.length, 1);
    assert.equal(body.drafts[0].bidNumber, "F360-26-0170");
    assert.deepEqual(body.drafts[0].counts, { sheets: 12, rooms: 30, conditions: 7, rfisDrafted: 2 });
    assert.ok(logs.every((l) => !/mi-token|id-hdr/.test(l)), "no token in the log");
  });
  const [id] = f.identityCalls();
  const idUrl = new URL(id.url);
  assert.equal(idUrl.searchParams.get("resource"), DEFAULT_BIDS_API_AUDIENCE);
  assert.equal(idUrl.searchParams.get("api-version"), "2019-08-01");
  assert.equal(id.headers["X-IDENTITY-HEADER"], "id-hdr");
  const [b] = f.bidsCalls();
  assert.equal(b.url, `${BIDS}/api/auto-takeoff/drafts`);
  assert.equal(b.method, "GET");
  assert.equal(b.headers.Authorization, "Bearer mi-token-1");
  assert.equal(b.headers[USER_EMAIL_HEADER], "rpalermo@floor360.com");
  assert.deepEqual(Object.keys(b.headers).sort(), ["Accept", "Authorization", USER_EMAIL_HEADER].sort(), "no cookie or principal forwarded");
});

test("token: cached until 5 min before expiry, then fetched again", async () => {
  const f = fakes();
  await withServer({ ...ON, BIDS_API_AUDIENCE: "api://custom" }, f, async (base) => {
    await get(base);
    f.clock.now += 50 * 60_000;          // 10 min left: still cached
    await get(base);
    assert.equal(f.identityCalls().length, 1);
    f.clock.now += 6 * 60_000;           // 4 min left: refresh
    await get(base);
    assert.equal(f.identityCalls().length, 2);
  });
  assert.equal(new URL(f.identityCalls()[0].url).searchParams.get("resource"), "api://custom");
  assert.deepEqual(f.bidsCalls().map((c) => c.headers.Authorization), ["Bearer mi-token-1", "Bearer mi-token-1", "Bearer mi-token-2"]);
});

test("token source: one fetch for concurrent callers; a failed fetch is null, not cached", async () => {
  const f = fakes({ identity: [{ status: 500, body: {} }] });
  const cfg = { identityEndpoint: "http://identity.local/t", identityHeader: "h", clientId: "uai", audience: "api://x", timeoutMs: 1000 };
  const t = createIdentityToken(cfg, f.fetchImpl as unknown as typeof fetch, () => f.clock.now);
  assert.equal(await t.get(), null);
  const [a, b] = await Promise.all([t.get(), t.get()]);
  assert.equal(a, "mi-token-1");
  assert.equal(b, "mi-token-1");
  assert.equal(f.identityCalls().length, 2);
  assert.equal(new URL(f.identityCalls()[1].url).searchParams.get("client_id"), "uai");
  t.drop();
  assert.equal(await t.get(), "mi-token-2");
});

test("Bids 403 / 401 / login redirect read as the Appendix B message; 401 drops the token", async () => {
  const f = fakes({ bids: [{ status: 403, body: { error: "forbidden" } }, { status: 401 }, { status: 302 }] });
  await withServer(ON, f, async (base) => {
    for (let i = 0; i < 3; i++) {
      const res = await get(base);
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.error, BIDS_REFUSED_MESSAGE);
      assert.equal(body.code, "bids_refused");
      assert.equal(body.enabled, true);
      assert.deepEqual(body.drafts, []);
    }
  });
  assert.match(BIDS_REFUSED_MESSAGE, /Bids hasn't accepted this site's identity yet \(Appendix B\)/);
  assert.equal(f.identityCalls().length, 2, "the 401 forced a fresh token for the next call");
});

test("claim: 200 wins, 409 passes through who claimed it; POST carries only the email", async () => {
  const f = fakes({ bids: [
    { status: 200, body: { claimedByEmail: "RPalermo@floor360.com", claimedAt: "2026-10-18T00:12:00Z" } },
    { status: 409, body: { claimedByEmail: "bwright@floor360.com", claimedAt: "2026-10-18T00:10:00Z", claimedByName: "Brian Wright" } },
  ] });
  await withServer(ON, f, async (base) => {
    const won = await post(base, "/run_1/claim");
    assert.equal(won.status, 200);
    const w = await won.json();
    assert.equal(w.claimedByEmail, "rpalermo@floor360.com");
    assert.equal(w.claimedAt, "2026-10-18T00:12:00Z");
    const lost = await post(base, "/run_1/claim");
    assert.equal(lost.status, 409);
    const l = await lost.json();
    assert.deepEqual([l.claimedByEmail, l.claimedAt, l.claimedByName, l.code], ["bwright@floor360.com", "2026-10-18T00:10:00Z", "Brian Wright", "already_claimed"]);
  });
  const [c] = f.bidsCalls();
  assert.equal(c.url, `${BIDS}/api/auto-takeoff/runs/run_1/claim`);
  assert.equal(c.method, "POST");
  assert.deepEqual(JSON.parse(c.body || ""), { email: "rpalermo@floor360.com" });
  assert.equal(c.headers[USER_EMAIL_HEADER], "rpalermo@floor360.com");
});

test("approved: 200 -> {ok}; Bids failure is readable; bad run id and non-JSON / cross-site posts are refused", async () => {
  const f = fakes({ bids: [{ status: 200, body: {} }, { status: 500 }, { status: 404 }] });
  await withServer(ON, f, async (base) => {
    const ok = await post(base, "/run_1/approved");
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).ok, true);
    const bad = await post(base, "/run_1/approved");
    assert.equal(bad.status, 502);
    assert.match((await bad.json()).error, /HTTP 500/);
    assert.equal((await post(base, "/run_1/approved")).status, 404);
    assert.equal((await post(base, "/bad.id!/claim")).status, 400);
    assert.equal((await post(base, "/run_1/claim", USER)).status, 415);
    assert.equal((await post(base, "/run_1/claim", { ...USER, "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await fetch(base + BIDS_DRAFTS_PATH + "/x", { headers: USER })).status, 404);
    assert.equal((await fetch(base + BIDS_DRAFTS_PATH, { method: "POST", headers: { ...USER, "Content-Type": "application/json" } })).status, 405);
    assert.equal((await fetch(base + BIDS_DRAFTS_PATH + "/run_1/claim", { headers: USER })).status, 405);
    assert.equal((await fetch(base + "/api/bids/other", { headers: USER })).status, 404);
  });
  assert.equal(f.bidsCalls().length, 3);
});

test("timeout and unreachable Bids, missing URL or identity: readable errors, user still returned", async () => {
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const f = fakes({ bids: [timeout, new TypeError("fetch failed")] });
  await withServer(ON, f, async (base) => {
    const t = await get(base);
    assert.equal(t.status, 504);
    assert.match((await t.json()).error, /didn't answer in 15 s/);
    assert.equal((await get(base)).status, 502);
  });
  await withServer({ ...ON, BIDS_API_URL: "http://bids.test" }, fakes(), async (base) => {
    const r = await get(base);
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.equal(body.code, "not_configured");
    assert.equal(body.user.email, "rpalermo@floor360.com");
  });
  await withServer({ FLOOR360_AI_DRAFTS: "on", BIDS_API_URL: BIDS }, fakes(), async (base) => {
    assert.equal((await (await get(base)).json()).code, "no_identity");
  });
  await withServer(ON, fakes({ identity: [{ status: 400, body: { error: "bad resource" } }] }), async (base) => {
    assert.equal((await (await get(base)).json()).code, "no_token");
  });
});

const LIST_FAILED = (status: number) => ({
  enabled: true, user: { email: "rpalermo@floor360.com", name: "rpalermo@floor360.com" }, drafts: [],
  error: `Bids couldn't answer right now (HTTP ${status}).`, code: "bids_failed",
});

test("Bids 500 with an HTML body: one warn line with the status and the first 200 chars; response unchanged", async () => {
  const html = `<!DOCTYPE html>\n<html>\n  <head>\n    <title>500.73 - Internal Server Error</title>\n  </head>\n  <body>\n    <h1>Server Error</h1>\n    <p>The page cannot be displayed because an internal server error has occurred. Most likely causes: the request could not be routed.</p>\n  </body>\n</html>\n`;
  const f = fakes({ bids: [{ status: 500, text: html }] });
  await withServer(ON, f, async (base, logs, warns) => {
    const res = await get(base);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), LIST_FAILED(500));
    assert.equal(warns.length, 1);
    const prefix = "bids-drafts GET /api/auto-takeoff/drafts upstream 500 body: ";
    assert.ok(warns[0].startsWith(prefix), warns[0]);
    const snippet = warns[0].slice(prefix.length);
    assert.equal(snippet, html.replace(/\s+/g, " ").trim().slice(0, 200));
    assert.equal(snippet.length, 200);
    assert.match(snippet, /^<!DOCTYPE html> <html> <head> <title>500\.73 - Internal Server Error<\/title>/);
    assert.ok(logs.includes("bids-drafts GET upstream 500"), "the status line is still there");
  });
});

test("Bids 500 body with a Bearer token, a JWT, an access_token field and emails: none reach the log", async () => {
  const jwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJyb2IiLCJhdWQiOiJhcGk6Ly94In0.c2lnbmF0dXJlLXNlZ21lbnQtaGVyZQ";
  const body = [
    "Easy Auth failed. Authorization: Bearer mi-token-1",
    `x-ms-token-aad-id-token: ${jwt}`,
    `{"access_token":"at-plain-secret-value","refresh_token": "rt-plain-secret","error":"invalid"}`,
    "redirect /callback?code=authcode-plain&state=ok&sig=sasSigPlain&client_secret=cs-plain",
    "password=hunter2-plain user rpalermo@floor360.com cc bwright@floor360.com and rpalermo%40floor360.com",
  ].join("\n");
  const f = fakes({ bids: [{ status: 500, text: body }] });
  await withServer(ON, f, async (base, logs, warns) => {
    const res = await get(base);
    assert.deepEqual(await res.json(), LIST_FAILED(500));
    assert.equal(warns.length, 1);
    const all = logs.join("\n");
    for (const secret of ["mi-token", jwt.slice(0, 20), "eyJ", "at-plain-secret-value", "rt-plain-secret", "authcode-plain", "sasSigPlain", "cs-plain", "hunter2-plain", "rpalermo", "bwright", "floor360.com", "id-hdr"]) {
      assert.ok(!all.includes(secret), `${secret} leaked: ${all}`);
    }
    assert.match(warns[0], /upstream 500 body: Easy Auth failed\. Authorization: Bearer \[redacted\]/);
    assert.match(warns[0], /"access_token":"\[redacted\]"/);
  });
});

test("Bids 503 with an empty body logs (empty)", async () => {
  const f = fakes({ bids: [{ status: 503 }, { status: 504, text: " \n\t " }] });
  await withServer(ON, f, async (base, _logs, warns) => {
    const res = await get(base);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), LIST_FAILED(503));
    await get(base);
    assert.deepEqual(warns, [
      "bids-drafts GET /api/auto-takeoff/drafts upstream 503 body: (empty)",
      "bids-drafts GET /api/auto-takeoff/drafts upstream 504 body: (empty)",
    ]);
  });
});

test("a long Bids 5xx body is cut to 200 chars after redaction, so a cut can't leave part of a secret", async () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnopqrstu";
  const body = "a ".repeat(95) + jwt + " tail ".repeat(100);
  const f = fakes({ bids: [{ status: 500, text: body }] });
  await withServer(ON, f, async (base, _logs, warns) => {
    await get(base);
    const snippet = warns[0].split(" body: ")[1];
    assert.equal(snippet.length, 200);
    assert.ok(snippet.endsWith("a [redacted]"), snippet);
    assert.ok(!snippet.includes("eyJ"));
  });
  assert.equal(redactUpstreamSnippet("password=hunter2 " + "z".repeat(500)), ("password=[redacted] " + "z".repeat(500)).slice(0, 200));
  assert.equal(redactUpstreamSnippet("x".repeat(50), 10), "x".repeat(10));
});

test("Bids 200 and 403 keep their logging: no body line", async () => {
  const f = fakes({ bids: [{ status: 200, body: { drafts: [DRAFT] } }, { status: 403, text: "<html>Forbidden rpalermo@floor360.com</html>" }] });
  await withServer(ON, f, async (base, logs, warns) => {
    assert.equal((await get(base)).status, 200);
    const refused = await get(base);
    assert.equal(refused.status, 502);
    assert.equal((await refused.json()).code, "bids_refused");
    assert.deepEqual(warns, []);
    assert.deepEqual(logs, ["bids-drafts GET upstream 200", "bids-drafts GET upstream 403"]);
  });
});

test("a JSON Bids 500 is still handled: no crash, same failure, redacted JSON in the log", async () => {
  const f = fakes({ bids: [
    { status: 500, body: { drafts: [DRAFT], error: "db down" } },
    { status: 500, body: { error: "boom", claimedByEmail: "bwright@floor360.com", token: "plain-tok" } },
  ] });
  await withServer(ON, f, async (base, _logs, warns) => {
    const list = await get(base);
    assert.equal(list.status, 502);
    assert.deepEqual(await list.json(), LIST_FAILED(500));
    const claim = await post(base, "/run_1/claim");
    assert.equal(claim.status, 502);
    const c = await claim.json();
    assert.deepEqual([c.error, c.code], ["Bids couldn't answer right now (HTTP 500).", "bids_failed"]);
    assert.equal(warns.length, 2);
    assert.match(warns[0], /^bids-drafts GET \/api\/auto-takeoff\/drafts upstream 500 body: \{"drafts":\[\{"runId":"run_1"/);
    assert.equal(warns[1], `bids-drafts POST /api/auto-takeoff/runs/run_1/claim upstream 500 body: {"error":"boom","claimedByEmail":"[redacted]","token":"[redacted]"}`);
  });
});

test("redactUpstreamSnippet: long hex/base64 runs, newlines collapsed (one log line), paths kept", () => {
  assert.equal(redactUpstreamSnippet(""), "(empty)");
  assert.equal(redactUpstreamSnippet(null), "(empty)");
  assert.equal(redactUpstreamSnippet("key 0123456789abcdef0123456789abcdef01234567 end"), "key [redacted] end");
  assert.equal(redactUpstreamSnippet("sas sv=2024&x=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MFhZWkFCQ0RFRkc+/== end"), "sas sv=2024&x=[redacted] end");
  assert.equal(redactUpstreamSnippet("line one\r\n\tFAKE bids-drafts GET upstream 200\u0000x"), "line one FAKE bids-drafts GET upstream 200 x");
  assert.equal(redactUpstreamSnippet("no route /api/auto-takeoff/runs/run_1/approved here"), "no route /api/auto-takeoff/runs/run_1/approved here");
  assert.equal(redactUpstreamSnippet("tok s3cr3t and s3cr3t", 200, ["s3cr3t"]), "tok [redacted] and [redacted]");
  assert.equal(redactUpstreamSnippet("Error 500.73 IIS Microsoft.AspNetCore.Server"), "Error 500.73 IIS Microsoft.AspNetCore.Server");
});

test("easyAuthUser: email and display name from X-MS-CLIENT-PRINCIPAL claims, else the principal name", () => {
  const principal = Buffer.from(JSON.stringify({ claims: [
    { typ: "name", val: "Rob Palermo" }, { typ: "preferred_username", val: "RPalermo@floor360.com" },
  ] })).toString("base64");
  assert.deepEqual(easyAuthUser({ "x-ms-client-principal": principal, "x-ms-client-principal-name": "other@floor360.com" }), { email: "rpalermo@floor360.com", name: "Rob Palermo" });
  assert.deepEqual(easyAuthUser({ "x-ms-client-principal-name": "bwright@floor360.com" }), { email: "bwright@floor360.com", name: "bwright@floor360.com" });
  assert.equal(easyAuthUser({ "x-ms-client-principal": "not base64 json" }), null);
  assert.equal(easyAuthUser({}), null);
});

test("sanitizeDraft: contract fields only; bad run id dropped; non-https folder URL dropped", () => {
  assert.equal(sanitizeDraft({ ...DRAFT, runId: "../x" }), null);
  assert.equal(sanitizeDraft(null), null);
  const d = sanitizeDraft({ ...DRAFT, sharepointFolderUrl: "javascript:alert(1)", counts: { sheets: -1, rooms: "3" } })!;
  assert.equal(d.sharepointFolderUrl, "");
  assert.deepEqual(d.counts, { sheets: null, rooms: null, conditions: null, rfisDrafted: null });
  assert.equal("secretInternal" in d, false);
});
