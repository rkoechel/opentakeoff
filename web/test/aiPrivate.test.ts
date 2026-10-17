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
