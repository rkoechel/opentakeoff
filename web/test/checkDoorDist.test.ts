// scripts/check-door-dist.mjs: the built model is the pinned file, at a
// same-origin path, and the worker chunk fetches that path.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDoorDist, sameOriginModelPath } from "../scripts/check-door-dist.mjs";
import { DOOR_MODEL } from "../scripts/stage-door-model.mjs";

const BODY = new TextEncoder().encode("pinned-door-model");
const PIN = {
  ...DOOR_MODEL,
  bytes: BODY.length,
  sha256: createHash("sha256").update(BODY).digest("hex"),
  served: "/models/door/door-detector-test.onnx",
};

function distWith(opts: { onnx?: Uint8Array; manifest?: unknown; worker?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "door-dist-"));
  mkdirSync(join(root, "models", "door"), { recursive: true });
  mkdirSync(join(root, "assets"), { recursive: true });
  const onnx = opts.onnx === undefined ? BODY : opts.onnx;
  if (onnx) writeFileSync(join(root, "models", "door", "door-detector-test.onnx"), onnx);
  const manifest = opts.manifest === undefined
    ? { revision: PIN.revision, file: PIN.file, url: PIN.served, bytes: PIN.bytes, sha256: PIN.sha256 }
    : opts.manifest;
  if (manifest) writeFileSync(join(root, "models", "door", "manifest.json"), JSON.stringify(manifest));
  const worker = opts.worker === undefined ? `fetch(${JSON.stringify(PIN.served)})` : opts.worker;
  if (worker !== null) writeFileSync(join(root, "assets", "doorDetect.worker-AbCd.js"), worker);
  return root;
}

test("a same-origin door path is a /models/door/ path with no host", () => {
  assert.equal(sameOriginModelPath(DOOR_MODEL.served), true);
  assert.equal(sameOriginModelPath("https://huggingface.co/Kentucky-ai/opentakeoff-door-detector/resolve/main/onnx/door-detector-r4-medium-fp32.onnx"), false);
  assert.equal(sameOriginModelPath("/models/ocr/det.onnx"), false);
  assert.equal(sameOriginModelPath("models/door/door-detector.onnx"), false);
});

test("a dist that carries the pinned file passes", async () => {
  const r = await checkDoorDist(distWith(), PIN);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test("a wrong sha256 fails", async () => {
  const bad = new Uint8Array(BODY);
  bad[0] ^= 0xff;
  const r = await checkDoorDist(distWith({ onnx: bad }), PIN);
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /sha256/);
});

test("a manifest that points at another host fails", async () => {
  const r = await checkDoorDist(distWith({
    manifest: { revision: PIN.revision, file: PIN.file, url: "https://huggingface.co/other/model.onnx", bytes: PIN.bytes, sha256: PIN.sha256 },
  }), PIN);
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /same-origin/);
});

test("a worker chunk that names a model host fails", async () => {
  const r = await checkDoorDist(distWith({ worker: `fetch(${JSON.stringify(PIN.served)}); huggingface.co` }), PIN);
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /model host/);
});
