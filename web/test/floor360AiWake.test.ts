// On-demand start of the DGX model (scripts/floor360-ai-proxy.mjs with
// AI_WAKER_URL). The upstream and the waker are fakes. Pinned: a down model
// (no connection, 502/503/530) triggers ONE /wake with the CF Access headers
// and WAKER_TOKEN (never the vLLM key); while it starts every request gets
// 503 {state: starting, retryAfter} with no upstream call and no second
// wake; /status is polled until running, and then requests go through; a
// waker no_memory is passed on with its message; unset AI_WAKER_URL keeps
// the old plain "AI starting".
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticServer } from "../scripts/floor360-static.mjs";
import { AI_PATH, NO_MEMORY_MESSAGE, createAiProxyHandler, createWakeManager, aiProxyConfig } from "../scripts/floor360-ai-proxy.mjs";

const ENV = {
  AI_MODEL: "m", AI_API_KEY: "vllm-secret", CF_ACCESS_CLIENT_ID: "cf-id", CF_ACCESS_CLIENT_SECRET: "cf-secret",
  AI_WAKER_URL: "https://takeoff-vision.floor360.com/_waker", WAKER_TOKEN: "waker-secret", AI_WAKE_POLL_MS: "1",
};
const REPLY = { choices: [{ message: { role: "assistant", content: "ok" } }] };
type Call = { url: string; method: string; headers: Record<string, string> };

function world({ upstreamDown = true, wake = { status: 202, body: { state: "starting" } as Record<string, unknown> }, runningAfter = 2, upErr = "refused" as "refused" | 502 | 503 | 530 } = {}) {
  const calls: Call[] = [];
  let down = upstreamDown;
  let polls = 0;
  const fetchImpl = (async (url: string | URL, init: { method?: string; headers?: Record<string, string> } = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || "GET", headers: init.headers || {} });
    if (u.endsWith("/_waker/wake")) return Response.json(wake.body, { status: wake.status });
    if (u.endsWith("/_waker/status")) {
      polls += 1;
      if (polls >= runningAfter) { down = false; return Response.json({ state: "running", freeGB: 40 }); }
      return Response.json({ state: "starting", freeGB: 40 });
    }
    if (down) {
      if (upErr === "refused") throw new TypeError("fetch failed");
      return new Response("", { status: upErr });
    }
    if (u.endsWith("/models")) return Response.json({ data: [{ id: "m" }] });
    return Response.json(REPLY);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, wakes: () => calls.filter((c) => c.url.endsWith("/wake")).length, upstreamChats: () => calls.filter((c) => c.url.endsWith("/chat/completions")).length };
}

async function withProxy(env: Record<string, string>, fetchImpl: typeof fetch, fn: (base: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "ai-wake-"));
  const handler = createAiProxyHandler({ env, fetchImpl, log: {} as Console, sleep: () => new Promise((r) => setTimeout(r, 2)) });
  const server = createStaticServer(dir, { routes: { [AI_PATH]: handler } });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  try { await fn(`http://127.0.0.1:${port}`); } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
}
const chat = (base: string) => fetch(`${base}${AI_PATH}/v1/chat/completions`, {
  method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  headers: { "Content-Type": "application/json", "X-MS-CLIENT-PRINCIPAL-NAME": "ryan@floor360.com" },
});
const until = async (cond: () => boolean) => { for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 2)); assert.ok(cond()); };

for (const upErr of ["refused", 502, 503, 530] as const) {
  test(`down model (${upErr}) wakes once, answers starting, then goes through once running`, async () => {
    const w = world({ upErr, runningAfter: 3 });
    await withProxy(ENV, w.fetchImpl, async (base) => {
      const first = await chat(base);
      assert.equal(first.status, 503);
      const body = await first.json();
      assert.equal(body.state, "starting");
      assert.equal(body.retryAfter, 10);
      const chatsAfterFirst = w.upstreamChats();
      // more requests while starting: no new wake, no upstream call
      for (let i = 0; i < 3; i++) {
        const again = await chat(base);
        if (again.status === 200) break;
        assert.equal((await again.json()).state, "starting");
      }
      assert.equal(w.wakes(), 1);
      await until(() => w.calls.some((c) => c.url.endsWith("/_waker/status")) && w.calls.filter((c) => c.url.endsWith("/_waker/status")).length >= 3);
      await new Promise((r) => setTimeout(r, 10));
      const ok = await chat(base);
      assert.equal(ok.status, 200);
      assert.ok(w.upstreamChats() >= chatsAfterFirst + 1);
      assert.equal(w.wakes(), 1);
      const wakeCall = w.calls.find((c) => c.url.endsWith("/wake"))!;
      assert.equal(wakeCall.method, "POST");
      assert.equal(wakeCall.headers.Authorization, "Bearer waker-secret");
      assert.equal(wakeCall.headers["CF-Access-Client-Id"], "cf-id");
      assert.equal(wakeCall.headers["CF-Access-Client-Secret"], "cf-secret");
      assert.equal(JSON.stringify(wakeCall.headers).includes("vllm-secret"), false);
    });
  });
}

test("no_memory from the waker reaches the browser with the message, and holds", async () => {
  const w = world({ wake: { status: 503, body: { state: "no_memory", freeGB: 9 } } });  // no poll: no_memory ends the wake
  await withProxy(ENV, w.fetchImpl, async (base) => {
    const res = await chat(base);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: NO_MEMORY_MESSAGE, state: "no_memory" });
    assert.equal(NO_MEMORY_MESSAGE, "The AI server is out of memory right now. Ask Ryan to free memory on the DGX.");
    const again = await chat(base);
    assert.equal((await again.json()).state, "no_memory");
    const status = await (await fetch(`${base}${AI_PATH}/status`)).json();
    assert.equal(status.state, "no_memory");
    assert.equal(w.wakes(), 1);
  });
});

test("/api/ai/status wakes a down model too, once", async () => {
  const w = world({ runningAfter: 1000 });
  await withProxy({ ...ENV, AI_MODEL: "", AI_WAKE_TIMEOUT_MS: "300" }, w.fetchImpl, async (base) => {
    const s1 = await (await fetch(`${base}${AI_PATH}/status`)).json();
    assert.equal(s1.state, "starting");
    assert.equal(s1.retryAfter, 10);
    const s2 = await (await fetch(`${base}${AI_PATH}/status`)).json();
    assert.equal(s2.state, "starting");
    assert.equal(w.wakes(), 1);
  });
});

test("without AI_WAKER_URL a down model is the old plain starting, no wake", async () => {
  const w = world();
  const { AI_WAKER_URL: _drop, ...noWaker } = ENV;
  await withProxy(noWaker, w.fetchImpl, async (base) => {
    const res = await chat(base);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "AI starting", state: "starting" });
    assert.equal(w.wakes(), 0);
  });
  assert.equal(aiProxyConfig({ AI_WAKER_URL: "http://evil.example/_waker" }).wakerUrl, "");
});

test("the wake manager gives up after the timeout and can wake again", async () => {
  let now = 0;
  const w = world({ runningAfter: 1e9 });
  const cfg = aiProxyConfig({ ...ENV, AI_WAKE_TIMEOUT_MS: "100" });
  const m = createWakeManager(cfg, { fetchImpl: w.fetchImpl, nowMs: () => now, sleep: async () => { now += 30; }, log: {} as Console });
  assert.equal(await m.wake(), "starting");
  assert.equal(await m.wake(), "starting");
  assert.equal(w.wakes(), 1);
  await until(() => m.state() === "idle");
  assert.equal(await m.wake(), "starting");
  assert.equal(w.wakes(), 2);
});
