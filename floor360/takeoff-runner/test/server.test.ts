// The job API: the off switch, bearer auth, manifest validation, the size
// limits, and chunked upload with the sha256 check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDF } from "./fakes.ts";
import { api, auth, manifestFor, putChunk, sha256, startRunner, TOKEN, upload } from "./helpers.ts";
import { tokenMatches } from "../src/server.ts";
import { parseContentRange, addRange } from "../src/jobs.ts";

const neverRuns = async () => { throw new Error("execute should not run"); };

test("GET /health needs no token and says nothing else, even when disabled", async () => {
  const h = await startRunner({ execute: neverRuns, enabled: false });
  try {
    const r = await api(`${h.url}/health`, "GET", undefined, {});
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true });
  } finally {
    await h.close();
  }
});

test("RUNNER_ENABLED unset: every job route answers 503 runner disabled, token or not", async () => {
  const h = await startRunner({ execute: neverRuns, enabled: false });
  try {
    for (const [method, p] of [["POST", "/jobs"], ["GET", "/jobs/x"], ["PUT", "/jobs/x/files/y"], ["POST", "/jobs/x/start"], ["GET", "/jobs/x/outputs/a.json"], ["POST", "/jobs/x/cancel"]]) {
      const r = await api(`${h.url}${p}`, method, method === "POST" ? {} : undefined);
      assert.equal(r.status, 503, `${method} ${p}`);
      assert.deepEqual(r.json, { error: "runner disabled" });
    }
  } finally {
    await h.close();
  }
});

test("enabled without RUNNER_TOKEN refuses rather than running open", async () => {
  const h = await startRunner({ execute: neverRuns, token: "" });
  try {
    const r = await api(`${h.url}/jobs`, "POST", {}, {});
    assert.equal(r.status, 503);
    assert.deepEqual(r.json, { error: "runner not configured" });
  } finally {
    await h.close();
  }
});

test("missing, malformed and wrong tokens get 401; the right one gets through", async () => {
  const h = await startRunner({ execute: neverRuns });
  try {
    for (const headers of [{}, { Authorization: TOKEN }, { Authorization: "Bearer nope" }, { Authorization: `Basic ${TOKEN}` }, { Authorization: `Bearer ${TOKEN}x` }]) {
      const r = await api(`${h.url}/jobs/00000000-0000-0000-0000-000000000000`, "GET", undefined, headers as Record<string, string>);
      assert.equal(r.status, 401, JSON.stringify(headers));
      assert.deepEqual(r.json, { error: "unauthorized" });
    }
    const ok = await api(`${h.url}/jobs/00000000-0000-0000-0000-000000000000`, "GET");
    assert.equal(ok.status, 404, "authorized: the job just doesn't exist");
  } finally {
    await h.close();
  }
  assert.equal(tokenMatches(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(tokenMatches(`Bearer ${TOKEN}`, ""), false, "an empty configured token never matches");
});

test("manifest validation: plain sentences for what's wrong", async () => {
  const h = await startRunner({ execute: neverRuns });
  const good = manifestFor([{ name: "A101 Floor Plan.pdf", bytes: PDF }]);
  const cases: [unknown, RegExp][] = [
    [{ ...good, runId: "" }, /runId is required/],
    [{ ...good, bidId: "bid 42/../x" }, /bidId may use/],
    [{ ...good, files: [] }, /at least one PDF/],
    [{ ...good, files: [{ ...good.files[0], name: "../etc/passwd.pdf" }] }, /character SharePoint won't take/],
    [{ ...good, files: [{ ...good.files[0], name: "plans.docx" }] }, /not a PDF/],
    [{ ...good, files: [{ ...good.files[0], name: ".hidden.pdf" }] }, /can't start with/],
    [{ ...good, files: [{ ...good.files[0], sha256: "abc" }] }, /sha256/],
    [{ ...good, files: [{ ...good.files[0], role: "specs" }] }, /role must be one of/],
    [{ ...good, files: [good.files[0], { ...good.files[0], fileId: "f2" }] }, /appears twice/],
    [{ ...good, options: { dpi: 600 } }, /dpi must be/],
    [{ ...good, scheduleRows: [{ category: "Carpet" }] }, /finishTag is required/],
  ];
  try {
    for (const [body, re] of cases) {
      const r = await api(`${h.url}/jobs`, "POST", body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
      assert.match(r.json.error, re);
    }
    const bad = await fetch(`${h.url}/jobs`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: "{not json" });
    assert.equal(bad.status, 400);
    const ok = await api(`${h.url}/jobs`, "POST", good);
    assert.equal(ok.status, 201);
    assert.equal(ok.json.status, "queued");
    assert.equal(ok.json.files[0].name, "A101 Floor Plan.pdf", "the name is kept verbatim: it is the sheet key");
  } finally {
    await h.close();
  }
});

test("limits: a file over 250 MB or a set over 600 MB is created failed, naming the file", async () => {
  const h = await startRunner({ execute: neverRuns });
  try {
    const big = manifestFor([{ name: "Scans.pdf", bytes: PDF }]);
    big.files[0].size = 251 * 1024 * 1024;
    const r1 = await api(`${h.url}/jobs`, "POST", big);
    assert.equal(r1.status, 201);
    assert.equal(r1.json.status, "failed");
    assert.match(r1.json.reason, /"Scans\.pdf" is 251 MB; files over 250 MB/);
    const start = await api(`${h.url}/jobs/${r1.json.id}/start`, "POST");
    assert.equal(start.status, 409);
    assert.match(start.json.error, /Scans\.pdf/);

    const many = manifestFor([1, 2, 3].map((i) => ({ name: `P${i}.pdf`, bytes: PDF })));
    for (const f of many.files) f.size = 210 * 1024 * 1024;
    const r2 = await api(`${h.url}/jobs`, "POST", many);
    assert.equal(r2.json.status, "failed");
    assert.match(r2.json.reason, /Too large for auto-takeoff \(630 MB of documents, limit 600 MB\)/);
  } finally {
    await h.close();
  }
});

test("chunked upload: out-of-order chunks assemble, sha256 verified at the end, start waits for every file", async () => {
  const h = await startRunner({ execute: async () => ({ counts: { sheets: 0, rooms: 0, conditions: 0, rfisDrafted: 0 }, findings: [], outputs: [] }) });
  try {
    const a = new Uint8Array(1000).map((_, i) => (i * 7) % 251);
    a.set(PDF.subarray(0, 5));
    const b = new Uint8Array(PDF);
    const created = await api(`${h.url}/jobs`, "POST", manifestFor([{ name: "a.pdf", bytes: a }, { name: "b.pdf", bytes: b }]));
    const id = created.json.id;
    const url = `${h.url}/jobs/${id}/files/f1`;
    const early = await api(`${h.url}/jobs/${id}/start`, "POST");
    assert.equal(early.status, 409);
    assert.deepEqual(early.json.missing, ["a.pdf", "b.pdf"]);

    assert.deepEqual((await putChunk(url, a, 600, 999, 1000)).json, { fileId: "f1", name: "a.pdf", complete: false, received: 400, size: 1000 });
    assert.equal((await putChunk(url, a, 600, 999, 1000)).json.received, 400, "a repeated chunk is idempotent");
    const mid = await putChunk(url, a, 0, 299, 1000);
    assert.equal(mid.status, 202);
    assert.equal(mid.json.received, 700);
    const last = await putChunk(url, a, 300, 599, 1000);
    assert.equal(last.status, 200);
    assert.equal(last.json.complete, true);
    const redo = await putChunk(url, a, 0, 9, 1000);
    assert.equal(redo.status, 200);
    assert.equal(redo.json.complete, true, "a finished file just says complete");
    assert.deepEqual(new Uint8Array(await readFile(path.join(h.dataDir, "jobs", id, "files", "a.pdf"))), a, "bytes on disk are the file");

    // a small file may come in one PUT without Content-Range
    const whole = await fetch(`${h.url}/jobs/${id}/files/f2`, { method: "PUT", headers: auth, body: b });
    assert.equal(whole.status, 200);
    const started = await api(`${h.url}/jobs/${id}/start`, "POST");
    assert.equal(started.status, 202);
    const afterStart = await putChunk(url, a, 0, 9, 1000);
    assert.equal(afterStart.status, 409, "files can't change once the job has started");
  } finally {
    await h.close();
  }
});

test("sha256 mismatch: 422 naming the file, bytes dropped, the file can be sent again", async () => {
  const h = await startRunner({ execute: neverRuns });
  try {
    const right = new Uint8Array(PDF);
    const created = await api(`${h.url}/jobs`, "POST", manifestFor([{ name: "plan.pdf", bytes: right }]));
    const id = created.json.id;
    const wrong = new Uint8Array(right);
    wrong[wrong.length - 2] ^= 0xff;
    const r = await upload(h.url, id, "f1", wrong, 16);
    assert.equal(r.status, 422);
    assert.match(r.json.error, /sha256 mismatch for "plan\.pdf"/);
    const view = await api(`${h.url}/jobs/${id}`, "GET");
    assert.equal(view.json.files[0].received, 0);
    assert.equal(view.json.files[0].complete, false);
    const ok = await upload(h.url, id, "f1", right, 16);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.complete, true);
  } finally {
    await h.close();
  }
});

test("upload refusals: bad range, wrong total, chunk over 64 MB, body shorter than its range", async () => {
  const h = await startRunner({ execute: neverRuns });
  try {
    const m = manifestFor([{ name: "plan.pdf", bytes: PDF }, { name: "huge.pdf", bytes: PDF }]);
    m.files[1].size = 200 * 1024 * 1024;
    const id = (await api(`${h.url}/jobs`, "POST", m)).json.id;
    const url = `${h.url}/jobs/${id}/files/f1`;
    const put = (range: string | null, body: Uint8Array, u = url) => fetch(u, { method: "PUT", headers: { ...auth, ...(range ? { "Content-Range": range } : {}) }, body });
    assert.equal((await put("bytes 5-2/" + PDF.length, PDF.subarray(0, 4))).status, 400);
    assert.equal((await put(`bytes 0-3/${PDF.length + 1}`, PDF.subarray(0, 4))).status, 400);
    assert.equal((await put(`bytes 0-9/${PDF.length}`, PDF.subarray(0, 4))).status, 400, "Content-Length disagrees with the range");
    const over = await put(`bytes 0-${64 * 1024 * 1024}/${200 * 1024 * 1024}`, PDF, `${h.url}/jobs/${id}/files/f2`);
    assert.equal(over.status, 413);
    assert.match(((await over.json()) as { error: string }).error, /64 MB/);
    assert.equal((await put(null, PDF, `${h.url}/jobs/${id}/files/f2`)).status, 400, "a big file needs Content-Range");
    assert.equal((await put(`bytes 0-3/${PDF.length}`, PDF.subarray(0, 4), `${h.url}/jobs/${id}/files/nope`)).status, 404);
  } finally {
    await h.close();
  }
});

test("Content-Range parsing and range merging", () => {
  assert.deepEqual(parseContentRange("bytes 0-99/1000"), { start: 0, end: 99, total: 1000 });
  assert.equal(parseContentRange("bytes 100-99/1000"), null);
  assert.equal(parseContentRange("bytes 0-1000/1000"), null);
  assert.equal(parseContentRange("bytes */1000"), null);
  assert.deepEqual(addRange([[0, 10], [20, 30]], 10, 20), [[0, 30]]);
  assert.deepEqual(addRange([[50, 60]], 0, 5), [[0, 5], [50, 60]]);
  assert.equal(sha256("").length, 64);
});
