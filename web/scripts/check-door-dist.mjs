// Check a built dist/ for the self-hosted door-detector model.
//
//   npm run build && node scripts/check-door-dist.mjs
//
// It fails unless:
//   • dist has the pinned ONNX at the served path, at the pinned byte length
//     and sha256;
//   • models/door/manifest.json names that same same-origin path (no host);
//   • the door-detector worker chunk fetches that path and no chunk names
//     huggingface.co (the build's host strip is the other half of this).
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DOOR_MODEL } from "./stage-door-model.mjs";

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out;
}

const sha256File = (path) => new Promise((resolve, reject) => {
  const hash = createHash("sha256");
  createReadStream(path).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
});

/** True when a model URL is a path on this origin and nothing else. */
export function sameOriginModelPath(url) {
  return typeof url === "string" && url.startsWith("/models/door/") && !url.includes("://") && !url.includes("huggingface");
}

/** Pure over a directory, apart from hashing the model file. */
export async function checkDoorDist(distDir, pin = DOOR_MODEL) {
  const errors = [];
  if (!existsSync(distDir)) {
    return { ok: false, errors: ["no dist/"] };
  }
  const files = listFiles(distDir).map((p) => relative(distDir, p).split("\\").join("/"));
  const rel = pin.served.replace(/^\//, "");
  if (!sameOriginModelPath(pin.served)) errors.push(`served path ${JSON.stringify(pin.served)} is not a /models/door/ path on this site`);
  if (!files.includes(rel)) errors.push(`${rel} is missing from dist`);
  else {
    const abs = join(distDir, rel);
    const size = statSync(abs).size;
    if (size !== pin.bytes) errors.push(`${rel} is ${size} bytes in dist, pinned ${pin.bytes}`);
    else {
      const got = await sha256File(abs);
      if (got !== pin.sha256) errors.push(`${rel} sha256 ${got} does not match the pin ${pin.sha256}`);
    }
  }
  if (!files.includes("models/door/manifest.json")) errors.push("models/door/manifest.json is missing from dist");
  else {
    const manifest = JSON.parse(readFileSync(join(distDir, "models/door/manifest.json"), "utf8"));
    if (!sameOriginModelPath(manifest.url)) errors.push(`manifest url ${JSON.stringify(manifest.url)} is not a same-origin /models/door/ path`);
    else if (manifest.url !== pin.served) errors.push(`manifest url ${manifest.url} is not the pinned path ${pin.served}`);
    if (manifest.bytes !== pin.bytes || manifest.sha256 !== pin.sha256) errors.push("manifest bytes or sha256 do not match the pin");
    if (manifest.revision !== pin.revision) errors.push(`manifest revision ${manifest.revision} is not the pin ${pin.revision}`);
  }
  const workers = files.filter((f) => /^assets\/doorDetect\.worker-[^/]*\.js$/.test(f));
  if (workers.length !== 1) errors.push(`expected 1 doorDetect.worker chunk, found ${workers.length}: ${workers.join(", ") || "none"}`);
  for (const w of workers) {
    const text = readFileSync(join(distDir, w), "latin1");
    if (!text.includes(pin.served)) errors.push(`${w} does not fetch ${pin.served}`);
    if (text.includes("huggingface.co") || text.includes("hf.co")) errors.push(`${w} names a model host`);
  }
  return { ok: errors.length === 0, errors };
}

async function main() {
  const web = join(dirname(fileURLToPath(import.meta.url)), "..");
  const distDir = join(web, "dist");
  const r = await checkDoorDist(distDir);
  if (!r.ok) {
    for (const e of r.errors) console.error(`check-door-dist: ${e}`);
    process.exit(1);
  }
  console.log(`check-door-dist: ${DOOR_MODEL.served} matches the pin (${DOOR_MODEL.bytes} bytes, sha256 ${DOOR_MODEL.sha256.slice(0, 12)}…).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
