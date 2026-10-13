import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTENT_SECURITY_POLICY, createStaticServer, resolveRequest } from "../scripts/floor360-static.mjs";
import { stripPrivateHosts } from "../scripts/strip-private-hosts.mjs";

test("private host strip removes dependency URLs and leaves the source link", () => {
  const sample = [
    "https://cdn.jsdelivr.net/npm/onnxruntime-web@1/dist/",
    "https://huggingface.co/org/model",
    "https://hf.co/org/model",
    "https://www.googleapis.com/drive/v3/files",
    "https://graph.microsoft.com/v1.0",
    "https://accounts.google.com/gsi/client",
    "https://opentakeoff.kentucky-ai.com/",
    "https://github.com/rkoechel/opentakeoff/commit/abc",
  ].join("\n");
  const out = stripPrivateHosts(sample);
  for (const host of ["cdn.jsdelivr.net", "huggingface.co", "hf.co", "googleapis.com", "graph.microsoft.com", "accounts.google.com", "opentakeoff.kentucky-ai.com"]) {
    assert.equal(out.includes(host), false, host);
  }
  assert.match(out, /github\.com\/rkoechel\/opentakeoff\/commit\/abc/);
});

test("CSP matches _headers and staticwebapp.config.json", () => {
  const headers = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  const line = headers.split("\n").find((l) => l.includes("Content-Security-Policy:"));
  assert.ok(line, "missing CSP in _headers");
  assert.equal(line!.slice(line!.indexOf(":") + 1).trim(), CONTENT_SECURITY_POLICY);
  const swa = JSON.parse(readFileSync(new URL("../public/staticwebapp.config.json", import.meta.url), "utf8"));
  assert.equal(swa.globalHeaders["Content-Security-Policy"], CONTENT_SECURITY_POLICY);
  assert.equal(swa.mimeTypes[".mjs"], "text/javascript");
  assert.match(CONTENT_SECURITY_POLICY, /connect-src 'self' blob: data:/);
  assert.match(CONTENT_SECURITY_POLICY, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(CONTENT_SECURITY_POLICY, /worker-src 'self' blob:/);
  assert.doesNotMatch(CONTENT_SECURITY_POLICY, /cloudflare|googleapis|gstatic|accounts\.google/);
});

test("static server sends the CSP and serves .mjs as JavaScript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ot-static-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>ok</title>");
  writeFileSync(join(dir, "worker.mjs"), "export const x = 1;\n");
  const server = createStaticServer(dir);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    const mod = await fetch(`http://127.0.0.1:${port}/worker.mjs`);
    assert.equal(mod.status, 200);
    assert.match(mod.headers.get("content-type") || "", /^text\/javascript/);
    assert.equal(mod.headers.get("content-security-policy"), CONTENT_SECURITY_POLICY);
    assert.equal(mod.headers.get("x-content-type-options"), "nosniff");
    const spa = await fetch(`http://127.0.0.1:${port}/projects/abc`);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /ok/);
    const missing = await fetch(`http://127.0.0.1:${port}/missing.js`);
    assert.equal(missing.status, 404);
    const escaped = resolveRequest(dir, "/%2e%2e/%2e%2e/etc/passwd");
    if (escaped.file) assert.ok(escaped.file.startsWith(dir), escaped.file);
    const dotted = resolveRequest(dir, "/%2e%2e/package.json");
    assert.equal(dotted.file, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
