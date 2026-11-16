// Stage the door-detector model for the FLOOR360 build.
//
// Downloads one pinned ONNX file into web/public/models/door/ so the app
// serves it from its own origin. The running app never talks to a model
// host. This script is the only place that network is involved, and it runs
// at build time.
//
//   node scripts/stage-door-model.mjs
//
// The file is Kentucky-ai/opentakeoff-door-detector at revision 1ea0a85
// (full commit below), onnx/door-detector-r4-medium-fp32.onnx. A file already
// on disk is hashed again; a mismatch is downloaded again. A download gives
// up after FETCH_TIMEOUT_MS, or as soon as it runs past the pinned size.
// The bytes and sha256 are checked before the file is kept, and manifest.json
// is written last, so a failed run leaves nothing the build would treat as
// installed. The directory is gitignored (under public/models/).
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");

// Pinned to an immutable commit, not the repo's default branch. The size and
// sha256 were read from that revision (x-linked-size / x-linked-etag) and
// match doorDetectSettings.json. The served path carries the revision, so a
// new pin is a new URL.
export const DOOR_MODEL = {
  repo: "Kentucky-ai/opentakeoff-door-detector",
  revision: "1ea0a850a52cfe9ef19931b37fcc2c2a69981465",
  file: "onnx/door-detector-r4-medium-fp32.onnx",
  bytes: 122154402,
  sha256: "7626ef625206c0ef1ee7cd89e4b027599e0cee05d5dc56d4c2f6e58047e7b0a5",
  served: "/models/door/door-detector-1ea0a850a52cfe9ef19931b37fcc2c2a69981465.onnx",
};

export const DOOR_MODEL_URL = `https://huggingface.co/${DOOR_MODEL.repo}/resolve/${DOOR_MODEL.revision}/${DOOR_MODEL.file}`;

// A 122 MB file. A hung download fails the build rather than shipping a
// partial model. Ten minutes is enough for the pinned size on a slow link.
export const FETCH_TIMEOUT_MS = 600_000;

const sha256File = (path) => new Promise((resolve, reject) => {
  const hash = createHash("sha256");
  createReadStream(path).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
});

const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;

/** Download one pinned file, stopping as soon as it runs past its size. */
async function download(url, bytes, fetchImpl, timeoutMs) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > bytes) throw new Error(`door model from ${url} is over its pinned ${bytes} bytes; stopped at ${buf.length}`);
    return buf;
  }
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > bytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`door model from ${url} is over its pinned ${bytes} bytes; stopped at ${n}`);
    }
    parts.push(value);
  }
  return Buffer.concat(parts, n);
}

/** Stage into `dest`. Throws on any failure; the caller decides the exit. */
export async function stage({
  dest = join(web, "public", "models", "door"),
  fetchImpl = globalThis.fetch,
  model = DOOR_MODEL,
  url = DOOR_MODEL_URL,
  log = console.log,
  timeoutMs = FETCH_TIMEOUT_MS,
} = {}) {
  mkdirSync(dest, { recursive: true });
  const manifestPath = join(dest, "manifest.json");
  const tmpManifest = `${manifestPath}.tmp`;
  rmSync(manifestPath, { force: true });
  rmSync(tmpManifest, { force: true });

  const filename = model.served.split("/").pop();
  const path = join(dest, filename);
  rmSync(`${path}.partial`, { force: true });
  let verified = false;
  if (existsSync(path)) {
    const size = statSync(path).size;
    const got = size === model.bytes ? await sha256File(path) : "";
    if (size === model.bytes && got === model.sha256) {
      log(`  = ${filename}  ${mb(size)}  sha256 ${got.slice(0, 12)}… (cached, verified)`);
      verified = true;
    } else {
      log(`  ! ${filename} on disk fails its size or sha256; downloading again`);
      rmSync(path);
    }
  }
  if (!verified) {
    const buf = await download(url, model.bytes, fetchImpl, timeoutMs);
    if (buf.length !== model.bytes) {
      throw new Error(`door model from ${url} is ${buf.length} bytes, pinned ${model.bytes}`);
    }
    const got = createHash("sha256").update(buf).digest("hex");
    if (got !== model.sha256) throw new Error(`sha256 mismatch for the door model from ${url}\n  want ${model.sha256}\n  got  ${got}`);
    const partial = `${path}.partial`;
    writeFileSync(partial, buf);
    renameSync(partial, path);
    log(`  ↓ ${filename}  ${mb(buf.length)}  sha256 ${got.slice(0, 12)}… (verified)`);
  }

  const manifest = {
    revision: model.revision,
    file: model.file,
    url: model.served,
    bytes: model.bytes,
    sha256: model.sha256,
  };
  writeFileSync(tmpManifest, JSON.stringify(manifest, null, 2) + "\n");
  renameSync(tmpManifest, manifestPath);
  log(`Door detector staged: ${model.revision.slice(0, 7)} ${mb(model.bytes)} → ${dest}`);
  return { manifest };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  stage().catch((err) => {
    console.error(`stage-door-model: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
