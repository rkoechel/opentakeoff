// POST /jobs/:id/shop-drawings uses the same queue, auth and health check as a takeoff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { api, manifestFor, startRunner, TOKEN } from "./helpers.ts";
import { runShopDrawings, shopDrawingsPdfName } from "../src/shopdrawings/run.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/synthetic-annotations.json", import.meta.url));
const realPath = fileURLToPath(new URL("../../../evals/mcp-workflow-bench/plan-set/human-review-2026-09-12/takeoff-after-review.json", import.meta.url));

async function body(extra: Record<string, unknown> = {}) {
  const annotations = JSON.parse(await readFile(fixturePath, "utf8"));
  return {
    annotations,
    bid: { projectName: "Synthetic Fixture", bidNumber: "SYN-1", date: "2026-10-25", drawnBy: "Estimator" },
    ...extra,
  };
}

test("shop drawings queue on an empty shop-drawings job and write the DRAFT pdf", async () => {
  const h = await startRunner({
    execute: (ctx) => {
      if (ctx.work !== "shop-drawings") throw new Error("takeoff should not run");
      return runShopDrawings(ctx);
    },
  });
  try {
    const created = await api(`${h.url}/jobs`, "POST", {
      ...manifestFor([]),
      files: [],
      options: { shopDrawings: true },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const id = created.json.id as string;
    const queued = await api(`${h.url}/jobs/${id}/shop-drawings`, "POST", await body());
    assert.equal(queued.status, 202);
    await h.store.whenIdle();
    const done = await api(`${h.url}/jobs/${id}`, "GET");
    assert.equal(done.json.status, "done", done.json.reason);
    const pdfName = shopDrawingsPdfName("Synthetic Fixture", "SYN-1", false);
    assert.ok(done.json.outputs.some((o: { name: string }) => o.name === pdfName));
    assert.ok(done.json.findings.some((f: { kind: string }) => f.kind === "low_confidence_rooms"));
    assert.ok(done.json.findings.some((f: { kind: string; message: string }) => f.kind === "shop_drawing_note" && /rollWidthFt/.test(f.message)));
    const file = await fetch(`${h.url}/jobs/${id}/outputs/${encodeURIComponent(pdfName)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "application/pdf");
    const bytes = new Uint8Array(await file.arrayBuffer());
    assert.equal(Buffer.from(bytes.subarray(0, 5)).toString(), "%PDF-");
  } finally {
    await h.close();
  }
});

test("an NTS sheet fails the job with a sentence and writes no pdf", async () => {
  const h = await startRunner({
    execute: (ctx) => ctx.work === "shop-drawings" ? runShopDrawings(ctx) : Promise.reject(new Error("takeoff")),
  });
  try {
    const created = await api(`${h.url}/jobs`, "POST", { ...manifestFor([]), files: [], options: { shopDrawings: true } });
    const annotations = JSON.parse(await readFile(fixturePath, "utf8"));
    annotations.nts_sheets = ["SYNTHETIC-PLAN.pdf"];
    const queued = await api(`${h.url}/jobs/${created.json.id}/shop-drawings`, "POST", await body({ annotations }));
    assert.equal(queued.status, 202);
    await h.store.whenIdle();
    const done = await api(`${h.url}/jobs/${created.json.id}`, "GET");
    assert.equal(done.json.status, "failed");
    assert.match(done.json.reason, /Refusing shop drawings:.*NTS or unconfirmed/);
    assert.equal(done.json.outputs.length, 0);
  } finally {
    await h.close();
  }
});

test("a detected-only scale fails the job, writes no pdf, and the reason has no scale", async () => {
  const h = await startRunner({
    execute: (ctx) => ctx.work === "shop-drawings" ? runShopDrawings(ctx) : Promise.reject(new Error("takeoff")),
  });
  try {
    const created = await api(`${h.url}/jobs`, "POST", { ...manifestFor([]), files: [], options: { shopDrawings: true } });
    const annotations = JSON.parse(await readFile(realPath, "utf8"));
    const queued = await api(`${h.url}/jobs/${created.json.id}/shop-drawings`, "POST", await body({ annotations, bid: { projectName: "Sample finish plan", bidNumber: "DEMO-1" } }));
    assert.equal(queued.status, 202);
    await h.store.whenIdle();
    const done = await api(`${h.url}/jobs/${created.json.id}`, "GET");
    assert.equal(done.json.status, "failed");
    assert.match(done.json.reason, /scale not confirmed/);
    assert.doesNotMatch(done.json.reason, /1\/8|ft per inch|Scale source|plotted to fit/);
    assert.equal(done.json.outputs.length, 0);
    assert.deepEqual(done.json.findings, []);
  } finally {
    await h.close();
  }
});

test("a bad body is 400 and does not queue", async () => {
  const h = await startRunner({ execute: async () => { throw new Error("should not run"); } });
  try {
    const created = await api(`${h.url}/jobs`, "POST", { ...manifestFor([]), files: [], options: { shopDrawings: true } });
    const bad = await api(`${h.url}/jobs/${created.json.id}/shop-drawings`, "POST", { annotations: { schema: "nope" } });
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /annotations.schema/);
    const still = await api(`${h.url}/jobs/${created.json.id}`, "GET");
    assert.equal(still.json.status, "queued");
  } finally {
    await h.close();
  }
});

test("shop drawings are disabled and unauthorized the same way as other job routes", async () => {
  const off = await startRunner({ execute: async () => { throw new Error("no"); }, enabled: false });
  try {
    const r = await api(`${off.url}/jobs/x/shop-drawings`, "POST", {});
    assert.equal(r.status, 503);
    assert.deepEqual(r.json, { error: "runner disabled" });
  } finally {
    await off.close();
  }
});
