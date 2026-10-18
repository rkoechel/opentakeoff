// The runner's project file opens in the browser unchanged: the real web
// loader (cloudStore) and import path over a job folder laid out as Bids
// saves it. The real-engine variant of this check is in
// engine.integration.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { JobStore } from "../src/jobs.ts";
import { runTakeoff } from "../src/pipeline.ts";
import { DRAFT_MARKER_KEY, markDraft } from "../src/outputs.ts";
import { createCloudStore } from "../../../web/src/lib/cloudStore.js";
import { assertBrowserOpens, jobFolderDrive } from "./browser.ts";
import { createUploaded, fakeEngine, PDF, setManifest, smallSet } from "./fakes.ts";
import { FakeClock, tempDir } from "./helpers.ts";

async function fakeRun() {
  const { dir, cleanup } = await tempDir();
  const store = new JobStore({
    dataDir: dir, clock: new FakeClock(), jobTimeoutMs: 3600_000, retentionMs: 86400_000,
    execute: (ctx) => runTakeoff(ctx, { startEngine: async () => fakeEngine(smallSet()), vision: null, runnerVersion: "t", verdictMinConfidence: 0.9 }),
  });
  await store.init();
  const job = await createUploaded(store, setManifest());
  await store.start(job.id);
  await store.whenIdle();
  assert.equal(store.get(job.id).status, "done");
  return { outputsDir: path.join(dir, "jobs", job.id, "outputs"), cleanup };
}

test("annotations.json + sheets.json open through the web app's own loader and import", async () => {
  const { outputsDir, cleanup } = await fakeRun();
  try {
    const { loaded } = await assertBrowserOpens(outputsDir, { "A-plan.pdf": PDF, "B-schedule.pdf": PDF });
    assert.equal(loaded[DRAFT_MARKER_KEY].bidNumber, "F360-26-0170");
  } finally {
    await cleanup();
  }
});

test("sheets.json ids are Bids' to fill: until then the list shows but the PDFs can't download", async () => {
  const { outputsDir, cleanup } = await fakeRun();
  try {
    const ann = JSON.parse(await readFile(path.join(outputsDir, "annotations.json"), "utf8"));
    const sheets = JSON.parse(await readFile(path.join(outputsDir, "sheets.json"), "utf8"));
    assert.ok(sheets.files.every((f: { id: unknown }) => f.id === null));
    const { drive } = jobFolderDrive({ "A-plan.pdf": PDF }, ann, sheets);
    const store = createCloudStore("JOB", drive as never, { local: new Proxy({}, { get: () => () => Promise.resolve([]) }) as never });
    assert.deepEqual((await store.listSheets()).map((s: { name: string }) => s.name), ["A-plan.pdf", "B-schedule.pdf"]);
    await assert.rejects(store.loadPdfData("A-plan.pdf"));
  } finally {
    await cleanup();
  }
});

test("the draft marker is additive: every engine key and value is kept", () => {
  const engine = { schema: "opentakeoff.takeoff_canvas.v1", project_name: "", sheets: [], conditions: [{ id: "c1" }], shapes: [], markups: [], rfis: [], sheet_group: [], last_group: [], sheet_tabs: [], nts_sheets: ["x.pdf"] };
  const out = markDraft(engine, {
    manifest: setManifest(), jobId: "j", generatedAt: "2026-10-17T00:00:00.000Z", runnerVersion: "v", engineVersion: "e",
    counts: { sheets: 1, rooms: 0, conditions: 1, rfisDrafted: 0 }, findings: [], wallTile: false,
  }, ["y.pdf#2"]);
  for (const [k, v] of Object.entries(engine)) if (k !== "project_name" && k !== "nts_sheets") assert.deepEqual(out[k], v, k);
  assert.deepEqual(out.nts_sheets, ["x.pdf", "y.pdf#2"]);
  assert.equal(out.project_name, "Perfumania Wauwatosa - F360-26-0170");
  assert.deepEqual(Object.keys(out).slice(-1), [DRAFT_MARKER_KEY], "appended last");
  assert.ok(!(out[DRAFT_MARKER_KEY] as { checklistItems: string[] }).checklistItems.includes("wall_tile_elevations"));
});
