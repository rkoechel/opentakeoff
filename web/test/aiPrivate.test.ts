// The FLOOR360 private build's AI lock (lib/ai.js): with
// __OT_FLOOR360_PRIVATE__ true (as vite.config defines it), the config is
// this origin's /api/ai with no key, whatever localStorage holds, and save
// is a no-op. The proxy's busy / starting replies read as such.
import { test } from "node:test";
import assert from "node:assert/strict";

(globalThis as Record<string, unknown>).__OT_FLOOR360_PRIVATE__ = true;
const store = new Map<string, string>([["opentakeoff_ai_endpoint", "https://api.example.com"], ["opentakeoff_ai_key", "sk-user"], ["opentakeoff_ai_model", "x"]]);
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k),
};
const ai = await import("../src/lib/ai.js");

test("locked to /api/ai with no key; localStorage ignored; save does nothing", () => {
  assert.deepEqual(ai.aiConfig(), { endpoint: "/api/ai", apiKey: "", model: "floor360-takeoff", provider: "openai" });
  assert.equal(ai.isAiConfigured(), true);
  ai.saveAiConfig({ endpoint: "https://evil.example", apiKey: "k", model: "m", provider: "openai" });
  assert.equal(store.get("opentakeoff_ai_endpoint"), "https://api.example.com");
  const req = ai.buildChatRequest(ai.aiConfig(), { system: "s", messages: [], tools: [] });
  assert.equal(req.url, "/api/ai/v1/chat/completions");
  assert.equal(req.headers.Authorization, undefined);
});

test("busy and starting replies read as such", async () => {
  for (const [body, re] of [[{ error: "AI busy", state: "busy" }, /^AI busy/], [{ error: "AI starting", state: "starting" }, /^AI starting/]] as const) {
    const fetchFn = (async () => Response.json(body, { status: 503 })) as unknown as typeof fetch;
    await assert.rejects(ai.chatWithTools({ messages: [], tools: [], fetchFn }), { message: re });
  }
  assert.equal(ai.aiHttpError(500, null), "AI request failed (HTTP 500).");
  assert.equal(ai.aiHttpError(400, { error: { message: "x" } }), "AI request failed (HTTP 400).");
});

test("starting with retryAfter: says so once, waits, retries until the model answers", async () => {
  let n = 0;
  const fetchFn = (async () => (++n < 3 ? Response.json({ error: "Starting the takeoff AI", state: "starting", retryAfter: 10 }, { status: 503 }) : Response.json({ choices: [] }))) as unknown as typeof fetch;
  const waits: number[] = [];
  const told: string[] = [];
  const out = await ai.chatWithTools({ messages: [], tools: [], fetchFn, onWait: (t: string) => told.push(t), sleepFn: async (ms: number) => { waits.push(ms); } });
  assert.deepEqual(out, { choices: [] });
  assert.deepEqual(waits, [10000, 10000]);
  assert.deepEqual(told, ["Starting the takeoff AI… (usually ~1–2 min)"]);
});

test("no_memory and a plain starting without retryAfter are not retried", async () => {
  let n = 0;
  const noMem = (async () => { n++; return Response.json({ error: "x", state: "no_memory" }, { status: 503 }); }) as unknown as typeof fetch;
  await assert.rejects(ai.chatWithTools({ messages: [], tools: [], fetchFn: noMem, sleepFn: async () => {} }), { message: "The AI server is out of memory right now. Ask Ryan to free memory on the DGX." });
  assert.equal(n, 1);
  n = 0;
  const plain = (async () => { n++; return Response.json({ error: "AI starting", state: "starting" }, { status: 503 }); }) as unknown as typeof fetch;
  await assert.rejects(ai.chatWithTools({ messages: [], tools: [], fetchFn: plain, sleepFn: async () => {} }), { message: /^AI starting/ });
  assert.equal(n, 1);
});

test("the start wait gives up after startWaitMs", async () => {
  let n = 0;
  const fetchFn = (async () => { n++; return Response.json({ state: "starting", retryAfter: 10 }, { status: 503 }); }) as unknown as typeof fetch;
  let now = 0;
  await assert.rejects(ai.chatWithTools({ messages: [], tools: [], fetchFn, sleepFn: async (ms: number) => { now += ms; }, nowFn: () => now, startWaitMs: 25_000 }), { message: /^AI starting/ });
  assert.equal(n, 3);
});
