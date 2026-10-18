// The vision client and the waker's memory gate, against fake services and a
// fake clock: running, a cold start, no_memory backoff (15 minutes, 4 hours),
// a model that drops mid-job, and one request in flight.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVision, JobFailure, NO_MEMORY_MESSAGE, parseScaleAnswer, VisionUnavailable, type VisionState } from "../src/vision.ts";
import { fakeServices, secrets, visionConfig } from "./fakes.ts";
import { FakeClock } from "./helpers.ts";

const ctx = (states: VisionState[] = []) => ({ signal: new AbortController().signal, onState: (s: VisionState) => states.push(s) });

test("parseScaleAnswer keeps a short printed note, reads NTS, refuses junk", () => {
  assert.equal(parseScaleAnswer('{"scale": "1/8\\" = 1\'-0\\""}'), '1/8" = 1\'-0"');
  assert.equal(parseScaleAnswer('Sure! {"scale": "N.T.S."}'), "NTS");
  assert.equal(parseScaleAnswer('{"scale": "NOT TO SCALE"}'), "NTS");
  assert.equal(parseScaleAnswer('{"scale": null}'), null);
  assert.equal(parseScaleAnswer('{"scale": "probably quarter inch"}'), null);
  assert.equal(parseScaleAnswer('{"scale": "<script>1</script>"}'), null);
  assert.equal(parseScaleAnswer("no json"), null);
  assert.equal(parseScaleAnswer(42), null);
});

test("running model: one status check, the model id from /models, the key sent only to vision", async () => {
  const s = fakeServices();
  const v = createVision({ config: visionConfig, fetchImpl: s.fetchImpl, clock: new FakeClock(), readSecret: secrets })!;
  assert.equal(await v.readScaleNote("png", ctx()), '1/4" = 1\'-0"');
  const urls = s.calls.map((c) => c.url.replace("http://127.0.0.1", ""));
  assert.deepEqual(urls, [":8012/_waker/status", ":8010/v1/models", ":8010/v1/chat/completions"]);
  assert.equal(s.calls[0].auth, "Bearer waker-token-secret");
  assert.equal(s.calls[2].auth, "Bearer vision-key-secret");
  assert.ok(!s.calls.some((c) => c.url.includes("_waker") && c.auth?.includes("vision-key")), "the vision key never goes to the waker");
});

test("cold start: wake once, wait while starting, then read", async () => {
  const clock = new FakeClock();
  const seq = ["stopped", "starting", "starting", "running"];
  const s = fakeServices({ waker: () => ({ status: 200, state: seq.shift() ?? "running" }) });
  const states: VisionState[] = [];
  const v = createVision({ config: visionConfig, fetchImpl: s.fetchImpl, clock, readSecret: secrets })!;
  assert.equal(await v.readScaleNote("png", ctx(states)), '1/4" = 1\'-0"');
  assert.equal(s.calls.filter((c) => c.url.endsWith("/_waker/wake")).length, 1, "POST /wake exactly once");
  assert.deepEqual(states, ["starting", "running"]);
  assert.deepEqual(clock.sleeps, [5000, 5000, 5000], "polled every 5 s until running");
});

test("a start that never comes up gives up after 180 s (vision unavailable, not a job failure)", async () => {
  const clock = new FakeClock();
  const s = fakeServices({ waker: () => ({ status: 200, state: "starting" }) });
  const v = createVision({ config: visionConfig, fetchImpl: s.fetchImpl, clock, readSecret: secrets })!;
  await assert.rejects(v.readScaleNote("png", ctx()), (e: unknown) => e instanceof VisionUnavailable && /within 180 s/.test((e as Error).message));
  assert.equal(clock.sleeps.reduce((a, b) => a + b, 0), 180_000);
});

test("no_memory: retry every 15 minutes, fail after 4 hours with the honest message", async () => {
  const clock = new FakeClock();
  const t0 = clock.now();
  const s = fakeServices({ waker: () => ({ status: 200, state: "no_memory" }) });
  const states: VisionState[] = [];
  const v = createVision({ config: visionConfig, fetchImpl: s.fetchImpl, clock, readSecret: secrets })!;
  await assert.rejects(v.readScaleNote("png", ctx(states)), (e: unknown) => e instanceof JobFailure && (e as JobFailure).reason === NO_MEMORY_MESSAGE);
  assert.equal(clock.sleeps.length, 16);
  assert.ok(clock.sleeps.every((ms) => ms === 15 * 60_000), "every wait is 15 minutes");
  assert.equal(clock.now() - t0, 4 * 60 * 60_000, "gave up at 4 hours, not before");
  assert.ok(states.every((x) => x === "no_memory"));
  assert.equal(s.calls.filter((c) => c.url.endsWith("/_waker/wake")).length, 0, "the gate refused: no wake asked");
  assert.equal(s.calls.filter((c) => c.url.includes(":8010")).length, 0, "the model was never called");
});

test("no_memory on /wake, then memory frees: the job resumes", async () => {
  const clock = new FakeClock();
  const status = ["stopped", "no_memory", "stopped", "running"];
  const wake = [{ status: 503, state: "no_memory" }, { status: 202, state: "starting" }];
  const s = fakeServices({ waker: () => ({ status: 200, state: status.shift() ?? "running" }), wake: () => wake.shift()! });
  const states: VisionState[] = [];
  const v = createVision({ config: visionConfig, fetchImpl: s.fetchImpl, clock, readSecret: secrets })!;
  assert.equal(await v.readScaleNote("png", ctx(states)), '1/4" = 1\'-0"');
  assert.deepEqual(clock.sleeps, [15 * 60_000, 15 * 60_000, 5000]);
  assert.deepEqual(states, ["no_memory", "no_memory", "starting", "running"]);
});

test("the model drops mid-job (connection refused): wake through the gate once, retry once", async () => {
  const clock = new FakeClock();
  let chats = 0;
  const status = ["running", "stopped", "running"];
  const s = fakeServices({ waker: () => ({ status: 200, state: status.shift() ?? "running" }), chat: () => (++chats === 1 ? "down" : { status: 200, content: '{"scale":"1:100"}' }) });
  const v = createVision({ config: visionConfig, fetchImpl: s.fetchImpl, clock, readSecret: secrets })!;
  assert.equal(await v.readScaleNote("png", ctx()), "1:100");
  assert.equal(chats, 2);
  assert.equal(s.calls.filter((c) => c.url.endsWith("/_waker/wake")).length, 1);
});

test("502 twice: vision unavailable, never a third try, never another model", async () => {
  const s = fakeServices({ chat: () => ({ status: 502 }) });
  const v = createVision({ config: visionConfig, fetchImpl: s.fetchImpl, clock: new FakeClock(), readSecret: secrets })!;
  await assert.rejects(v.readScaleNote("png", ctx()), VisionUnavailable);
  assert.equal(s.calls.filter((c) => c.url.endsWith("/chat/completions")).length, 2);
  assert.ok(s.calls.every((c) => c.url.startsWith("http://127.0.0.1:801")), "only the Spark's own services");
});

test("at most one vision request in flight", async () => {
  const s = fakeServices();
  const v = createVision({ config: visionConfig, fetchImpl: s.fetchImpl, clock: new FakeClock(), readSecret: secrets })!;
  await Promise.all([1, 2, 3, 4].map(() => v.readScaleNote("png", ctx())));
  assert.equal(s.maxInFlight(), 1);
});

test("waker unreachable or refusing: vision unavailable; no waker configured: the model is tried as it is", async () => {
  const down = (async () => { throw Object.assign(new Error("ECONNREFUSED"), { name: "TypeError" }); }) as unknown as typeof fetch;
  const v1 = createVision({ config: visionConfig, fetchImpl: down, clock: new FakeClock(), readSecret: secrets })!;
  await assert.rejects(v1.readScaleNote("png", ctx()), /waker is not reachable/);
  const s401 = fakeServices({ waker: () => ({ status: 401, state: "" }) });
  const v2 = createVision({ config: visionConfig, fetchImpl: s401.fetchImpl, clock: new FakeClock(), readSecret: secrets })!;
  await assert.rejects(v2.readScaleNote("png", ctx()), /refused the runner's token/);
  const s = fakeServices();
  const v3 = createVision({ config: { ...visionConfig, wakerTokenFile: "" }, fetchImpl: s.fetchImpl, clock: new FakeClock(), readSecret: secrets })!;
  assert.equal(await v3.readScaleNote("png", ctx()), '1/4" = 1\'-0"');
  assert.ok(!s.calls.some((c) => c.url.includes("_waker")));
  assert.equal(createVision({ config: { ...visionConfig, visionBaseUrl: "" }, clock: new FakeClock() }), null);
});
