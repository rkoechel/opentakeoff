// POST /api/ocr/read (scripts/floor360-ocr-read.mjs): Azure Document
// Intelligence Read behind the FLOOR360 static server. Azure and the App
// Service identity endpoint are fakes. Pinned: the Easy Auth user is
// required; the managed identity is used before the key; the monthly and
// per-user caps are enforced and persisted; a refused submit is not counted;
// HTTP 429 is retried; lines come back with polygons; nothing secret leaks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticServer } from "../scripts/floor360-static.mjs";
import { OCR_READ_PATH, createOcrReadHandler, ocrReadConfig, readLines } from "../scripts/floor360-ocr-read.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const ENDPOINT = "https://di-test.cognitiveservices.azure.com";
const RESULT = {
  status: "succeeded",
  analyzeResult: { pages: [{ width: 400, height: 100, unit: "pixel",
    lines: [{ content: "D1 DOOR", polygon: [10, 10, 90, 10, 90, 30, 10, 30], spans: [{ offset: 0, length: 7 }] }],
    words: [{ content: "D1", confidence: 0.99, span: { offset: 0, length: 2 } }, { content: "DOOR", confidence: 0.8, span: { offset: 3, length: 4 } }] }] },
};

type Call = { url: string; headers: Record<string, string> };
function fakeAzure({ submit = [202], identity = true } = {}) {
  const calls: Call[] = [];
  const submits = [...submit];
  const fetchImpl = async (url: string | URL, init: { headers?: Record<string, string>; method?: string } = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: init.headers || {} });
    if (u.startsWith("http://identity.local")) {
      return identity ? Response.json({ access_token: "mi-token", expires_on: String(Math.floor(Date.now() / 1000) + 3600) }) : new Response("", { status: 500 });
    }
    if (init.method === "POST") {
      const status = submits.length > 1 ? submits.shift()! : submits[0];
      return new Response("", { status, headers: status === 202 ? { "operation-location": `${ENDPOINT}/documentintelligence/documentModels/prebuilt-read/analyzeResults/1` } : { "retry-after": "0" } });
    }
    return Response.json(RESULT);
  };
  return { calls, fetchImpl };
}

async function withServer(env: Record<string, string>, fetchImpl: unknown, fn: (base: string, usageFile: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "ocr-read-"));
  const usageFile = join(dir, "data", "ocr-usage.json");
  const handler = createOcrReadHandler({ env: { OCR_USAGE_FILE: usageFile, ...env }, fetchImpl: fetchImpl as typeof fetch, pollMs: 1, retryDelays: [1, 1], log: {} as Console });
  const server = createStaticServer(dir, { routes: { [OCR_READ_PATH]: handler } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  try { await fn(`http://127.0.0.1:${port}`, usageFile); } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
}

const post = (base: string, user = "ryan@floor360.com", body: Buffer = PNG) =>
  fetch(base + OCR_READ_PATH, { method: "POST", body, headers: user ? { "X-MS-CLIENT-PRINCIPAL-NAME": user } : {} });

const MI_ENV = { DI_ENDPOINT: ENDPOINT + "/", IDENTITY_ENDPOINT: "http://identity.local/msi/token", IDENTITY_HEADER: "hdr", DI_KEY: "secret-key" };

test("config: DI_ENDPOINT first, the Build portal names as fallbacks, caps default 300 / 100", () => {
  const c = ocrReadConfig({ DOCUMENT_INTELLIGENCE_ENDPOINT: ENDPOINT, DOCUMENT_INTELLIGENCE_KEY: "k" });
  assert.equal(c.endpoint, ENDPOINT);
  assert.equal(c.key, "k");
  assert.equal(c.monthlyCap, 300);
  assert.equal(c.userDailyCap, 100);
  assert.equal(ocrReadConfig({ DI_ENDPOINT: "https://a.cognitiveservices.azure.com", DOCUMENT_INTELLIGENCE_ENDPOINT: ENDPOINT }).endpoint, "https://a.cognitiveservices.azure.com");
  assert.equal(ocrReadConfig({ DI_ENDPOINT: "http://insecure" }).endpoint, "");
  assert.equal(ocrReadConfig({ OCR_MONTHLY_PAGE_CAP: "2000", OCR_USER_DAILY_CAP: "x" }).monthlyCap, 2000);
  assert.equal(ocrReadConfig({ OCR_USER_DAILY_CAP: "x" }).userDailyCap, 100);
});

test("reads with the managed identity, returns lines, counts the page, leaks no secret", async () => {
  const az = fakeAzure();
  await withServer(MI_ENV, az.fetchImpl, async (base, usageFile) => {
    const status = await (await fetch(base + OCR_READ_PATH)).json();
    assert.deepEqual(status, { enabled: true, monthlyCap: 300, userDailyCap: 100 });
    const res = await post(base);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.match(res.headers.get("content-security-policy") || "", /default-src 'self'/);
    const text = await res.text();
    assert.doesNotMatch(text, /mi-token|secret-key|hdr/);
    const body = JSON.parse(text);
    assert.deepEqual(body.lines, [{ content: "D1 DOOR", polygon: [10, 10, 90, 10, 90, 30, 10, 30], confidence: 0.8 }]);
    assert.equal(body.usage.monthPages, 1);
    const submit = az.calls.find((c) => c.url.includes(":analyze"))!;
    assert.equal(submit.url, `${ENDPOINT}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-11-30`);
    assert.equal(submit.headers.Authorization, "Bearer mi-token");
    assert.equal(submit.headers["Ocp-Apim-Subscription-Key"], undefined);
    const mi = az.calls.find((c) => c.url.startsWith("http://identity.local"))!;
    assert.match(mi.url, /resource=https%3A%2F%2Fcognitiveservices\.azure\.com/);
    assert.equal(mi.headers["X-IDENTITY-HEADER"], "hdr");
    const saved = JSON.parse(readFileSync(usageFile, "utf8"));
    assert.equal(saved.monthPages, 1);
    assert.equal(saved.users["ryan@floor360.com"], 1);
  });
});

test("falls back to the key when the identity gives no token", async () => {
  const az = fakeAzure({ identity: false });
  await withServer(MI_ENV, az.fetchImpl, async (base) => {
    assert.equal((await post(base)).status, 200);
    const submit = az.calls.find((c) => c.url.includes(":analyze"))!;
    assert.equal(submit.headers["Ocp-Apim-Subscription-Key"], "secret-key");
    assert.equal(submit.headers.Authorization, undefined);
  });
});

test("no Easy Auth user is 401; no endpoint is 503; not an image is 415", async () => {
  const az = fakeAzure();
  await withServer(MI_ENV, az.fetchImpl, async (base) => {
    assert.equal((await post(base, "")).status, 401);
    assert.equal((await post(base, "ryan@floor360.com", Buffer.from("hello"))).status, 415);
    assert.equal((await fetch(base + "/api/nope")).status, 404);
  });
  await withServer({ DI_KEY: "k" }, az.fetchImpl, async (base) => {
    assert.equal((await post(base)).status, 503);
    assert.equal((await (await fetch(base + OCR_READ_PATH)).json()).enabled, false);
  });
  assert.equal(az.calls.filter((c) => c.url.includes(":analyze")).length, 0);
});

test("monthly and per-user daily caps answer 429 before Azure is called", async () => {
  const az = fakeAzure();
  await withServer({ ...MI_ENV, OCR_MONTHLY_PAGE_CAP: "3", OCR_USER_DAILY_CAP: "2" }, az.fetchImpl, async (base) => {
    assert.equal((await post(base, "a@x")).status, 200);
    assert.equal((await post(base, "a@x")).status, 200);
    const daily = await post(base, "a@x");
    assert.equal(daily.status, 429);
    assert.equal((await daily.json()).reason, "daily-cap");
    assert.equal((await post(base, "b@x")).status, 200);
    const monthly = await post(base, "c@x");
    assert.equal(monthly.status, 429);
    assert.equal((await monthly.json()).reason, "monthly-cap");
  });
  assert.equal(az.calls.filter((c) => c.url.includes(":analyze")).length, 3);
});

test("HTTP 429 is retried; a submit Azure refuses is not counted", async () => {
  const ok = fakeAzure({ submit: [429, 202] });
  await withServer(MI_ENV, ok.fetchImpl, async (base) => {
    assert.equal((await post(base)).status, 200);
  });
  assert.equal(ok.calls.filter((c) => c.url.includes(":analyze")).length, 2);
  const limited = fakeAzure({ submit: [429] });
  await withServer(MI_ENV, limited.fetchImpl, async (base, usageFile) => {
    const res = await post(base);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /rate limit/);
    assert.equal(JSON.parse(readFileSync(usageFile, "utf8")).monthPages, 0);
  });
  assert.equal(limited.calls.filter((c) => c.url.includes(":analyze")).length, 3);
});

test("readLines skips lines without a polygon", () => {
  assert.deepEqual(readLines({ lines: [{ content: "x", polygon: [1, 2] }, { content: "y", polygon: [0, 0, 1, 0, 1, 1, 0, 1] }] }), [{ content: "y", polygon: [0, 0, 1, 0, 1, 1, 0, 1] }]);
});
