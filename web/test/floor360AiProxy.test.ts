// /api/ai (scripts/floor360-ai-proxy.mjs): the takeoff agent's same-origin
// proxy to the DGX. The upstream is a fake. Pinned: the default upstream is
// takeoff-vision.floor360.com; the vLLM key and the Cloudflare Access token
// go upstream as headers and never back to the browser or into a log; the
// model is the site's; at most 2 requests run, the third is 503 "AI busy";
// upstream 429 reads busy and 502/503/52x or no connection reads starting.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticServer } from "../scripts/floor360-static.mjs";
import { AI_PATH, DEFAULT_AI_MODEL, DEFAULT_AI_UPSTREAM_URL, aiProxyConfig, classifyUpstream, createAiProxyHandler, upstreamBody } from "../scripts/floor360-ai-proxy.mjs";

const SECRETS = { AI_API_KEY: "vllm-secret", CF_ACCESS_CLIENT_ID: "cf-id.access", CF_ACCESS_CLIENT_SECRET: "cf-secret" };
const CHAT = { model: "gpt-anything", max_tokens: 99999, stream: true, messages: [{ role: "user", content: "hi" }], tools: [], extra: "dropped" };
const REPLY = { choices: [{ message: { role: "assistant", content: "ok" } }] };

type Seen = { url: string; headers: Record<string, string>; body: Record<string, unknown> | null };

async function withProxy(env: Record<string, string>, upstream: (s: Seen) => Promise<Response>, fn: (base: string, seen: Seen[], logs: string[]) => Promise<void>) {
  const seen: Seen[] = [];
  const logs: string[] = [];
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) } as unknown as Console;
  const fetchImpl = (async (url: string, init: { headers: Record<string, string>; body?: string }) => {
    const s = { url: String(url), headers: init.headers, body: init.body ? JSON.parse(init.body) : null };
    seen.push(s);
    return upstream(s);
  }) as unknown as typeof fetch;
  const dir = mkdtempSync(join(tmpdir(), "ai-proxy-"));
  const server = createStaticServer(dir, { routes: { [AI_PATH]: createAiProxyHandler({ env, fetchImpl, log }) } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  try { await fn(`http://127.0.0.1:${port}`, seen, logs); } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
}

const chat = (base: string, user = "ryan@floor360.com") => fetch(`${base}${AI_PATH}/v1/chat/completions`, {
  method: "POST", body: JSON.stringify(CHAT), headers: { "Content-Type": "application/json", ...(user ? { "X-MS-CLIENT-PRINCIPAL-NAME": user } : {}) },
});

test("defaults: takeoff-vision.floor360.com, Qwen3-VL-8B-Instruct, 2 at once", () => {
  assert.equal(DEFAULT_AI_UPSTREAM_URL, "https://takeoff-vision.floor360.com/v1");
  const c = aiProxyConfig({});
  assert.equal(c.upstream, DEFAULT_AI_UPSTREAM_URL);
  assert.equal(c.model, DEFAULT_AI_MODEL);
  assert.equal(DEFAULT_AI_MODEL, "Qwen3-VL-8B-Instruct");
  assert.equal(c.maxConcurrent, 2);
  assert.equal(aiProxyConfig({ AI_UPSTREAM_URL: "http://example.com/v1" }).upstream, "");
  assert.doesNotMatch(DEFAULT_AI_UPSTREAM_URL, /spark-vision/);
});

test("forwards with the site's credentials and model; nothing secret comes back or is logged", async () => {
  await withProxy(SECRETS, async () => Response.json(REPLY), async (base, seen, logs) => {
    const res = await chat(base);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), REPLY);
    const s = seen[0];
    assert.equal(s.url, "https://takeoff-vision.floor360.com/v1/chat/completions");
    assert.equal(s.headers.Authorization, "Bearer vllm-secret");
    assert.equal(s.headers["CF-Access-Client-Id"], "cf-id.access");
    assert.equal(s.headers["CF-Access-Client-Secret"], "cf-secret");
    assert.equal(s.body!.model, DEFAULT_AI_MODEL);
    assert.equal(s.body!.max_tokens, 4096);
    assert.equal(s.body!.stream, false);
    assert.equal(s.body!.extra, undefined);
    for (const v of Object.values(SECRETS)) {
      assert.equal(text.includes(v), false);
      assert.equal(logs.join("\n").includes(v), false);
      assert.equal([...res.headers.values()].join("\n").includes(v), false);
    }
  });
});

test("Easy Auth user required", async () => {
  await withProxy(SECRETS, async () => Response.json(REPLY), async (base, seen) => {
    assert.equal((await chat(base, "")).status, 401);
    assert.equal(seen.length, 0);
  });
});

test("a third request while two run is 503 AI busy", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await withProxy(SECRETS, async () => { await gate; return Response.json(REPLY); }, async (base, seen) => {
    const a = chat(base), b = chat(base);
    while (seen.length < 2) await new Promise((r) => setTimeout(r, 5));
    const c = await chat(base);
    assert.equal(c.status, 503);
    assert.deepEqual(await c.json(), { error: "AI busy", state: "busy" });
    const status = await (await fetch(`${base}${AI_PATH}/status`)).json();
    assert.equal(status.state, "busy");
    release();
    assert.equal((await a).status, 200);
    assert.equal((await b).status, 200);
    assert.equal((await chat(base)).status, 200);
  });
});

test("upstream 429 is busy; 503 / 524 / no connection is starting; 403 is refused", async () => {
  assert.equal(classifyUpstream(429).kind, "busy");
  assert.equal(classifyUpstream(502).kind, "starting");
  assert.equal(classifyUpstream(524).kind, "starting");
  assert.equal(classifyUpstream(302).kind, "refused");
  assert.equal(classifyUpstream(403).kind, "refused");
  for (const [status, state] of [[429, "busy"], [503, "starting"], [403, "off"]] as const) {
    await withProxy(SECRETS, async () => new Response("<html>", { status }), async (base) => {
      const res = await chat(base);
      assert.equal(res.status, status === 403 ? 502 : 503);
      assert.equal((await res.json()).state, state);
    });
  }
  await withProxy(SECRETS, async () => { throw new TypeError("fetch failed"); }, async (base) => {
    const res = await chat(base);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "AI starting", state: "starting" });
  });
});

test("max_tokens is clamped, not raised", () => {
  const cfg = aiProxyConfig({ AI_MAX_TOKENS: "1000" });
  assert.equal(upstreamBody({ messages: [], max_tokens: 200 }, cfg).max_tokens, 200);
  assert.equal(upstreamBody({ messages: [], max_tokens: 5000 }, cfg).max_tokens, 1000);
});
