// scripts/stage-door-model.mjs stages the door detector same-origin under
// public/models/door/, verifying every byte, and writes manifest.json last.
// Runs against a temp directory and a fake fetch; the network is never touched.
// The pin itself is locked to doorDetectSettings.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DOOR_MODEL, DOOR_MODEL_URL, stage } from "../scripts/stage-door-model.mjs";
import { stripPrivateHosts } from "../scripts/strip-private-hosts.mjs";
import settings from "../src/lib/doorDetect/doorDetectSettings.json";

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const BODY = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const PIN = {
  ...DOOR_MODEL,
  bytes: BODY.length,
  sha256: sha(BODY),
  served: "/models/door/door-detector-test.onnx",
};
const URL = "https://models.example/door.onnx";

function fakeFetch(body: Uint8Array = BODY) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (url !== URL) return new Response("nope", { status: 404 });
    return new Response(body as unknown as BodyInit, { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const quiet = () => {};
const destOf = () => join(mkdtempSync(join(tmpdir(), "door-stage-")), "door");

test("the pin is revision 1ea0a85, the published size and sha256, and a same-origin path", () => {
  assert.equal(DOOR_MODEL.revision, "1ea0a850a52cfe9ef19931b37fcc2c2a69981465");
  assert.equal(DOOR_MODEL.revision.startsWith("1ea0a85"), true);
  assert.equal(DOOR_MODEL.file, "onnx/door-detector-r4-medium-fp32.onnx");
  assert.equal(DOOR_MODEL.bytes, 122154402);
  assert.equal(DOOR_MODEL.sha256, "7626ef625206c0ef1ee7cd89e4b027599e0cee05d5dc56d4c2f6e58047e7b0a5");
  assert.equal(DOOR_MODEL.sha256.startsWith("7626ef62"), true);
  assert.equal(DOOR_MODEL.served, `/models/door/door-detector-${DOOR_MODEL.revision}.onnx`);
  assert.equal(DOOR_MODEL.served.includes("://"), false);
  assert.equal(DOOR_MODEL_URL, `https://huggingface.co/${DOOR_MODEL.repo}/resolve/${DOOR_MODEL.revision}/${DOOR_MODEL.file}`);
  assert.equal(DOOR_MODEL_URL.includes("/resolve/main/"), false);
  const model = settings.model;
  assert.equal(model.repo, DOOR_MODEL.repo);
  assert.equal(model.revision, DOOR_MODEL.revision);
  assert.equal(model.file, DOOR_MODEL.file);
  assert.equal(model.bytes, DOOR_MODEL.bytes);
  assert.equal(model.sha256, DOOR_MODEL.sha256);
  assert.equal(model.served, DOOR_MODEL.served);
});

test("the host strip keeps the served path and still removes every other huggingface.co path", () => {
  assert.equal(stripPrivateHosts(DOOR_MODEL.served), DOOR_MODEL.served);
  assert.equal(stripPrivateHosts(DOOR_MODEL_URL).includes("huggingface.co"), false);
  assert.equal(stripPrivateHosts("https://huggingface.co/other/repo/resolve/main/model.onnx").includes("huggingface.co"), false);
  assert.equal(stripPrivateHosts("https://cdn.jsdelivr.net/npm/x").includes("cdn.jsdelivr.net"), false);
});

test("stages the model and a manifest whose url is the same-origin path", async () => {
  const dest = destOf();
  const { calls, fetchImpl } = fakeFetch();
  const { manifest } = await stage({ dest, fetchImpl, model: PIN, url: URL, log: quiet });
  assert.deepEqual(calls, [URL]);
  assert.deepEqual(new Uint8Array(readFileSync(join(dest, "door-detector-test.onnx"))), BODY);
  assert.equal(manifest.url, PIN.served);
  assert.equal(manifest.sha256, PIN.sha256);
  assert.equal(manifest.bytes, PIN.bytes);
  const onDisk = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"));
  assert.equal(onDisk.url, PIN.served);
});

test("a sha256 mismatch writes no file and no manifest", async () => {
  const dest = destOf();
  const { fetchImpl } = fakeFetch(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]));
  await assert.rejects(stage({ dest, fetchImpl, model: PIN, url: URL, log: quiet }), /sha256/i);
  assert.equal(existsSync(join(dest, "manifest.json")), false);
  assert.equal(existsSync(join(dest, "door-detector-test.onnx")), false);
});

test("a file longer than the pin is refused before it is kept", async () => {
  const dest = destOf();
  const { fetchImpl } = fakeFetch(new Uint8Array(PIN.bytes + 1));
  await assert.rejects(stage({ dest, fetchImpl, model: PIN, url: URL, log: quiet }), /over its pinned/);
  assert.equal(existsSync(join(dest, "manifest.json")), false);
  assert.equal(existsSync(join(dest, "door-detector-test.onnx")), false);
});

test("a cached file with the right sha256 is not downloaded again", async () => {
  const dest = destOf();
  await stage({ dest, fetchImpl: fakeFetch().fetchImpl, model: PIN, url: URL, log: quiet });
  const again = fakeFetch();
  await stage({ dest, fetchImpl: again.fetchImpl, model: PIN, url: URL, log: quiet });
  assert.deepEqual(again.calls, []);
  assert.ok(existsSync(join(dest, "manifest.json")));
});

test("a cached file with the wrong sha256 is replaced, and a failed rerun leaves no manifest", async () => {
  const dest = destOf();
  await stage({ dest, fetchImpl: fakeFetch().fetchImpl, model: PIN, url: URL, log: quiet });
  const failing = { ...PIN, sha256: "0".repeat(64) };
  await assert.rejects(stage({ dest, fetchImpl: fakeFetch().fetchImpl, model: failing, url: URL, log: quiet }), /sha256/i);
  assert.equal(existsSync(join(dest, "manifest.json")), false);
});
