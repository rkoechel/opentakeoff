// RFI drafts from findings (PR F): one pending agent RFI per open question,
// on its sheet, clouded where the finding knows the spot, deduplicated by
// (kind, sheet, tag), counted, and listed back on the findings. Nothing sends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EngineToolError } from "../src/engine.ts";
import { JobStore } from "../src/jobs.ts";
import { runTakeoff, type RunState } from "../src/pipeline.ts";
import { draftRfis, rfiKey, RFI_FINDING_KINDS } from "../src/rfis.ts";
import type { Finding } from "../src/types.ts";
import { createUploaded, fakeEngine, setManifest, smallSet } from "./fakes.ts";
import { FakeClock, tempDir } from "./helpers.ts";

function state(findings: Finding[]): RunState {
  const s: RunState = {
    manifest: setManifest(),
    sheets: [
      { sheet: "A-plan.pdf", page: 1, width_px: 2448, height_px: 1584 },
      { sheet: "A-plan.pdf#2", page: 2, width_px: 2448, height_px: 1584 },
      { sheet: "B-schedule.pdf", page: 1, width_px: 2448, height_px: 1584 },
    ],
    fileOfSheet: new Map(),
    roles: new Map(),
    scaled: new Set(),
    nts: new Set(),
    rooms: [],
    findings,
    scheduleSheet: "B-schedule.pdf",
    rfisDrafted: 0,
    visionOff: false,
    addFinding(f) { s.findings.push(f); },
  };
  return s;
}

const SIX: Finding[] = [
  { kind: "no_scale", sheet: "A-plan.pdf#2", message: "no scale" },
  { kind: "schedule_row_not_drawn", sheet: "B-schedule.pdf", tag: "EP-1", detail: "(Epoxy)", rect: [[100, 100], [900, 600]], message: "never drawn" },
  { kind: "room_no_schedule_row", sheet: "A-plan.pdf", tag: "103", at: [400, 500], message: "no row" },
  { kind: "conflicting_finishes", sheet: "A-plan.pdf", tag: "104", at: [800, 500], detail: "For room 104 the room finish schedule reads: ambiguous: floor cell \"CPT-1/VCT-1\".", message: "two finishes" },
  { kind: "unreadable_schedule", sheet: "B-schedule.pdf", message: "scan" },
  { kind: "wall_tile_no_elevation", sheet: "B-schedule.pdf", tag: "WT-1", message: "wall tile" },
];

test("each of the six questions drafts one pending agent RFI on its sheet; clouds where the finding has a spot", async () => {
  const e = fakeEngine(smallSet());
  const s = state([...SIX.map((f) => ({ ...f })), { kind: "low_confidence_rooms", message: "not an RFI" }, { kind: "base_gross_perimeter", tag: "RB-1", message: "not an RFI" }]);
  await draftRfis(e, s);
  const rfis = e.calls.filter((c) => c.tool === "create_rfi").map((c) => c.args);
  assert.equal(rfis.length, 6);
  assert.equal(s.rfisDrafted, 6);
  assert.deepEqual(rfis.map((r) => [r.sheet, r.title]), [
    ["A-plan.pdf#2", "Scale needed: A-plan.pdf#2"],
    ["B-schedule.pdf", "Finish EP-1 not shown on plans"],
    ["A-plan.pdf", "Room 103: finish not scheduled"],
    ["A-plan.pdf", "Conflicting finish: 104"],
    ["B-schedule.pdf", "Readable finish schedule needed"],
    ["B-schedule.pdf", "Wall tile WT-1: heights and extents"],
  ]);
  assert.match(rfis[1].question, /lists EP-1 \(Epoxy\), but no plan shows where it goes/);
  assert.match(rfis[3].question, /CPT-1\/VCT-1.*Please confirm which finish applies/);
  const clouds = e.calls.filter((c) => c.tool === "annotate").map((c) => c.args);
  assert.deepEqual(clouds.map((c) => [c.sheet, c.type, c.rect]), [
    ["B-schedule.pdf", "cloud", [[100, 100], [900, 600]]],
    ["A-plan.pdf", "cloud", [[310, 410], [490, 590]]],
    ["A-plan.pdf", "cloud", [[710, 410], [890, 590]]],
  ], "clouds only where the finding knows the spot");
  assert.ok(rfis[1].markup_ids?.length === 1 && rfis[2].markup_ids?.length === 1 && rfis[3].markup_ids?.length === 1, "each cloud is linked to its RFI");
  assert.equal(rfis[0].markup_ids, undefined);
  assert.deepEqual(s.findings.slice(0, 6).map((f) => f.rfi), ["RFI-001", "RFI-002", "RFI-003", "RFI-004", "RFI-005", "RFI-006"]);
  assert.ok(s.findings.slice(6).every((f) => f.rfi === undefined), "other findings stay findings");
  assert.ok(!e.calls.some((c) => /send|email|export/.test(c.tool)), "nothing is sent or exported from here");
  assert.deepEqual([...RFI_FINDING_KINDS].sort(), ["conflicting_finishes", "no_scale", "nts_sheet", "room_no_schedule_row", "schedule_row_not_drawn", "unreadable_schedule", "wall_tile_no_elevation"]);
});

test("NTS drafts the scale question too", async () => {
  const e = fakeEngine(smallSet());
  const s = state([{ kind: "nts_sheet", sheet: "A-plan.pdf", at: [100, 100], message: "nts" }]);
  await draftRfis(e, s);
  const r = e.calls.find((c) => c.tool === "create_rfi")!.args;
  assert.equal(r.title, "Scaled sheet needed: A-plan.pdf");
  assert.match(r.question, /NOT TO SCALE/);
});

test("dedupe per (kind, sheet, tag): repeats share one RFI; NTS and no-scale on one sheet are one question; the same tag on another sheet is its own", async () => {
  const e = fakeEngine(smallSet());
  const s = state([
    { kind: "room_no_schedule_row", sheet: "A-plan.pdf", tag: "103", message: "a" },
    { kind: "room_no_schedule_row", sheet: "A-plan.pdf", tag: " 103 ", message: "b" },
    { kind: "room_no_schedule_row", sheet: "A-plan.pdf#2", tag: "103", message: "c" },
    { kind: "no_scale", sheet: "A-plan.pdf#2", message: "d" },
    { kind: "nts_sheet", sheet: "A-plan.pdf#2", message: "e" },
    { kind: "wall_tile_no_elevation", sheet: "B-schedule.pdf", tag: "wt-1", message: "f" },
    { kind: "wall_tile_no_elevation", sheet: "B-schedule.pdf", tag: "WT-1", message: "g" },
  ]);
  await draftRfis(e, s);
  assert.equal(e.calls.filter((c) => c.tool === "create_rfi").length, 4);
  assert.equal(s.rfisDrafted, 4);
  assert.deepEqual(s.findings.map((f) => f.rfi), ["RFI-001", "RFI-001", "RFI-002", "RFI-003", "RFI-003", "RFI-004", "RFI-004"]);
  assert.equal(rfiKey({ kind: "no_scale", sheet: "x", message: "" }), rfiKey({ kind: "nts_sheet", sheet: "x", message: "" }));
  assert.equal(rfiKey({ kind: "transitions_withheld", message: "" }), null);
});

test("a finding with no sheet, or one the set doesn't have, goes on the schedule sheet with no cloud", async () => {
  const e = fakeEngine(smallSet());
  const s = state([
    { kind: "conflicting_finishes", tag: "CPT-1", detail: "The finish schedule describes it as Shaw and as Mohawk.", message: "x" },
    { kind: "room_no_schedule_row", sheet: "Z-gone.pdf", tag: "9", at: [1, 1], message: "y" },
  ]);
  await draftRfis(e, s);
  const rfis = e.calls.filter((c) => c.tool === "create_rfi").map((c) => c.args);
  assert.deepEqual(rfis.map((r) => r.sheet), ["B-schedule.pdf", "B-schedule.pdf"]);
  assert.ok(!e.calls.some((c) => c.tool === "annotate"), "a spot on another sheet is never clouded here");
  assert.match(rfis[0].question, /describes it as Shaw and as Mohawk/);
});

test("an engine refusal on one RFI is a finding; the rest are still drafted", async () => {
  let n = 0;
  const base = smallSet();
  const e = fakeEngine({ ...base, create_rfi: (a) => { if (++n === 1) throw new EngineToolError("create_rfi", "No annotation \"mk-x\""); return (base.create_rfi as (x: unknown) => unknown)(a); } });
  const s = state(SIX.map((f) => ({ ...f })));
  await draftRfis(e, s);
  assert.equal(s.rfisDrafted, 5);
  const fail = s.findings.find((f) => f.kind === "step_failed")!;
  assert.match(fail.message, /The RFI draft "Scale needed: A-plan\.pdf#2" could not be written/);
  assert.equal(s.findings[0].rfi, undefined);
});

test("in a full run: RFIs are drafted before the exports, counted in counts.rfisDrafted, listed on the findings and the draft marker", async () => {
  const { dir, cleanup } = await tempDir();
  try {
    let engine: ReturnType<typeof fakeEngine> | null = null;
    const store = new JobStore({
      dataDir: dir, clock: new FakeClock(), jobTimeoutMs: 3600_000, retentionMs: 86400_000,
      execute: (ctx) => runTakeoff(ctx, { startEngine: async () => (engine = fakeEngine(smallSet())), vision: null, runnerVersion: "t", verdictMinConfidence: 0.9 }),
    });
    await store.init();
    const job = await createUploaded(store, setManifest());
    await store.start(job.id);
    await store.whenIdle();
    const done = store.get(job.id);
    assert.equal(done.status, "done", done.reason);
    assert.equal(done.counts.rfisDrafted, 5);
    const drafted = done.findings.filter((f) => f.rfi);
    assert.deepEqual(drafted.map((f) => f.kind).sort(), ["conflicting_finishes", "no_scale", "room_no_schedule_row", "schedule_row_not_drawn", "wall_tile_no_elevation"]);
    const tools = engine!.calls.map((c) => c.tool);
    assert.ok(tools.lastIndexOf("create_rfi") < tools.indexOf("export_takeoff"), "the register is filled before anything is exported");
    const { readFile } = await import("node:fs/promises");
    const ann = JSON.parse(await readFile(`${dir}/jobs/${job.id}/outputs/annotations.json`, "utf8"));
    assert.equal(ann.floor360AutoTakeoff.counts.rfisDrafted, 5);
    assert.equal(ann.floor360AutoTakeoff.findings.filter((f: { rfi?: string }) => f.rfi).length, 5);
  } finally {
    await cleanup();
  }
});
