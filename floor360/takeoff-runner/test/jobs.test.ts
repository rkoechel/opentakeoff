// The job state machine with a fake engine and fake vision/waker: a full run,
// a cold start, no_memory backoff on a fake clock, the limits, cancel, the
// 60-minute budget, one job at a time, restart recovery and the 7-day sweep.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { JobStore, jobView } from "../src/jobs.ts";
import { runTakeoff, type PipelineDeps } from "../src/pipeline.ts";
import { createVision, NO_MEMORY_MESSAGE } from "../src/vision.ts";
import { DRAFT_MARKER_KEY } from "../src/outputs.ts";
import type { JobStatus } from "../src/types.ts";
import { createUploaded, ENCRYPTED_PDF, PDF, fakeEngine, fakeServices, secrets, setManifest, smallSet, visionConfig, type FakeEngine } from "./fakes.ts";
import { FakeClock, tempDir } from "./helpers.ts";

interface Rig {
  store: JobStore;
  clock: FakeClock;
  engines: FakeEngine[];
  statuses: JobStatus[];
  services: ReturnType<typeof fakeServices>;
  dataDir: string;
  cleanup: () => Promise<void>;
}

async function rig(o: { handlers?: () => Record<string, (a: any) => unknown>; services?: Parameters<typeof fakeServices>[0]; onCall?: (tool: string, clock: FakeClock) => Promise<void> | void; jobTimeoutMs?: number; deps?: Partial<PipelineDeps> } = {}): Promise<Rig> {
  const { dir, cleanup } = await tempDir();
  const clock = new FakeClock();
  const engines: FakeEngine[] = [];
  const statuses: JobStatus[] = [];
  const services = fakeServices(o.services);
  const vision = createVision({ config: visionConfig, fetchImpl: services.fetchImpl, clock, readSecret: secrets });
  const store: JobStore = new JobStore({
    dataDir: dir,
    clock,
    jobTimeoutMs: o.jobTimeoutMs ?? 60 * 60_000,
    retentionMs: 7 * 24 * 3600_000,
    watchdogMs: 5,
    execute: (ctx) => runTakeoff({ ...ctx, setStatus: (s) => { if (statuses[statuses.length - 1] !== s) statuses.push(s); ctx.setStatus(s); } }, {
      startEngine: async () => {
        const e = fakeEngine((o.handlers ?? smallSet)(), { onCall: (t) => o.onCall?.(t, clock) });
        engines.push(e);
        return e;
      },
      vision,
      runnerVersion: "0.1.0-test",
      verdictMinConfidence: 0.9,
      now: () => new Date(clock.now()),
      ...o.deps,
    }),
  });
  await store.init();
  return { store, clock, engines, statuses, services, dataDir: dir, cleanup };
}

async function runOne(r: Rig, m = setManifest(), bytesFor?: (id: string) => Uint8Array) {
  const job = await createUploaded(r.store, m, bytesFor);
  await r.store.start(job.id);
  await r.store.whenIdle();
  return r.store.get(job.id);
}

test("a full run: done, counts, findings with sheet refs, verdicts on confident rooms only, draft-marked outputs", async () => {
  const r = await rig();
  try {
    const job = await runOne(r);
    assert.equal(job.status, "done", job.reason);
    assert.deepEqual(job.counts, { sheets: 3, rooms: 2, conditions: 2, rfisDrafted: 5 });
    assert.deepEqual(r.statuses, ["running"]);
    const e = r.engines[0];
    assert.equal(e.closed, true, "the engine process is closed after the run");
    const tools = e.calls.map((c) => c.tool);
    assert.deepEqual(e.calls.filter((c) => c.tool === "load_plan").map((c) => [path.basename(c.args.path), c.args.merge]), [["A-plan.pdf", false], ["B-schedule.pdf", true]]);
    assert.deepEqual(e.calls.filter((c) => c.tool === "set_scale").map((c) => c.args), [{ sheet: "A-plan.pdf", use_detected: true }]);
    assert.deepEqual(e.calls.filter((c) => c.tool === "detect_rooms").map((c) => c.args), [{ sheet: "A-plan.pdf", assign_from_schedule: true }], "rooms only on the scaled plan sheet");
    assert.deepEqual(e.calls.filter((c) => c.tool === "mark_verdict").map((c) => c.args.shape_id), ["s1"], "0.97 gets the AGENT mark, 0.6 does not");
    assert.ok(tools.indexOf("export_takeoff") > tools.lastIndexOf("mark_verdict"), "exports come last");
    assert.deepEqual(e.calls.filter((c) => c.tool === "derive_base").map((c) => c.args), [{ source_condition: "CPT-1", condition: "RB-1" }, { source_condition: "VCT-1", condition: "RB-1" }]);

    const byKind = (k: string) => job.findings.filter((f) => f.kind === k);
    assert.deepEqual(byKind("room_no_schedule_row").map((f) => [f.sheet, f.tag, f.at]), [["A-plan.pdf", "103", [400, 500]]]);
    assert.deepEqual(byKind("conflicting_finishes").map((f) => [f.sheet, f.tag]), [["A-plan.pdf", "104"]]);
    assert.deepEqual(byKind("schedule_row_not_drawn").map((f) => [f.tag, f.sheet]), [["EP-1", "B-schedule.pdf"]]);
    assert.deepEqual(byKind("wall_tile_no_elevation").map((f) => f.tag), ["WT-1"]);
    assert.match(byKind("wall_tile_no_elevation")[0].message, /no elevation sheets were included/);
    assert.equal(byKind("base_gross_perimeter").length, 1);
    assert.match(byKind("base_gross_perimeter")[0].message, /NOT deducted/);
    assert.equal(byKind("transitions_withheld").length, 1);
    assert.equal(byKind("low_confidence_rooms").length, 1);
    const noScale = byKind("no_scale");
    assert.deepEqual(noScale.map((f) => f.sheet), ["A-plan.pdf#2"]);
    assert.match(noScale[0].message, /the AI read the note as "1\/4" = 1'-0"" \(not applied\)/, "vision suggests, never applies");
    assert.ok(!e.calls.some((c) => c.tool === "set_scale" && c.args.sheet === "A-plan.pdf#2"));

    const outDir = path.join(r.dataDir, "jobs", job.id, "outputs");
    const ann = JSON.parse(await readFile(path.join(outDir, "annotations.json"), "utf8"));
    assert.equal(ann.schema, "opentakeoff.takeoff_canvas.v1");
    const mark = ann[DRAFT_MARKER_KEY];
    assert.equal(mark.status, "draft");
    assert.deepEqual([mark.runId, mark.bidId, mark.bidNumber, mark.runnerVersion], ["run-7", "bid-7", "F360-26-0170", "0.1.0-test"]);
    assert.deepEqual(mark.checklist, {}, "nothing is checked by the machine");
    assert.ok(mark.checklistItems.includes("wall_tile_elevations"), "wall tile joins the checklist when the schedule has it");
    assert.equal(mark.generatedAt, new Date(r.clock.now()).toISOString());
    assert.equal(ann.project_name, "Perfumania Wauwatosa - F360-26-0170");
    const sheets = JSON.parse(await readFile(path.join(outDir, "sheets.json"), "utf8"));
    assert.deepEqual(sheets.files.map((f: any) => [f.id, f.name]), [[null, "A-plan.pdf"], [null, "B-schedule.pdf"]]);
    const run = JSON.parse(await readFile(path.join(outDir, "floor360-run.json"), "utf8"));
    assert.equal(run.status, "draft");
    assert.match(run.inputsHash, /^[0-9a-f]{64}$/);
    const csv = await readFile(path.join(outDir, "Perfumania Wauwatosa - F360-26-0170 - takeoff report.csv"), "utf8");
    assert.match(csv, /^finish_tag,name,floor_sf\r\n/);
    assert.match(csv, /'=VCT-1,"VCT, tile",120/, "formula-looking cells are inert, commas quoted");

    const view = jobView(job);
    assert.deepEqual((view.outputs as any[]).map((o) => o.name), ["annotations.json", "sheets.json", "floor360-run.json", "findings.json",
      "Perfumania Wauwatosa - F360-26-0170 - marked set.pdf", "Perfumania Wauwatosa - F360-26-0170 - takeoff report.json", "Perfumania Wauwatosa - F360-26-0170 - takeoff report.csv"]);
    assert.ok((view.outputs as any[]).every((o) => /^[0-9a-f]{64}$/.test(o.sha256) && o.size > 0));
    assert.deepEqual(await readdir(path.join(r.dataDir, "jobs", job.id)).then((d) => d.sort()), ["files", "job.json", "outputs"], "scratch and upload dirs removed");
  } finally {
    await r.cleanup();
  }
});

test("no room-finish schedule in the PDF: Bids rows that name rooms assign them; others are reported, dismissed rows ignored", async () => {
  const tri = [[200, 200], [300, 200], [300, 300], [200, 300]];   // clear of the CPT-1 text the fake plan prints at (5, 5)
  const r = await rig({
    handlers: () => smallSet({
      find_schedule: () => { throw new EngineToolError("find_schedule", "no schedule"); },
      detect_rooms: () => ({ detected: 3, rooms: [{ label: "101", nverts: 4, verts: tri, confidence: 0.95 }, { label: "105", nverts: 4, verts: tri, confidence: 0.95 }, { label: "106", nverts: 4, verts: tri, confidence: 0.95 }], withheld: { total: 0, degenerate: 0, duplicate: 0, bubble: 0, unowned: 0, implausible: 0, unresolved: 0 } }),
      measure_polygon: (a) => ({ area_sf: 100, perimeter_lf: 40, nverts: 4, shape_id: `m-${a.condition}` }),
      edit_shape: (a) => ({ shape_id: a.shape_id }),
    }),
  });
  try {
    const m = setManifest({
      scheduleRows: [
        { finishTag: "CPT-1", category: "Carpet tile", rooms: ["101", "106"] },
        { finishTag: "VCT-1", category: "VCT", rooms: ["106"] },
        { finishTag: "EP-1", category: "Epoxy", status: "dismissed" },
      ],
    });
    const job = await runOne(r, m);
    assert.equal(job.status, "done", job.reason);
    const e = r.engines[0];
    assert.deepEqual(e.calls.filter((c) => c.tool === "detect_rooms").map((c) => c.args), [{ sheet: "A-plan.pdf", return_verts: true }], "preview only: nothing commits under one guessed tag");
    assert.deepEqual(e.calls.filter((c) => c.tool === "measure_polygon").map((c) => [c.args.sheet, c.args.condition]), [["A-plan.pdf", "CPT-1"]]);
    assert.deepEqual(e.calls.filter((c) => c.tool === "edit_shape").map((c) => c.args), [{ shape_id: "m-CPT-1", label: "101" }]);
    assert.deepEqual(job.findings.filter((f) => f.kind === "room_no_schedule_row").map((f) => f.tag), ["105"]);
    assert.deepEqual(job.findings.filter((f) => f.kind === "conflicting_finishes").map((f) => f.tag), ["106"]);
    assert.ok(!job.findings.some((f) => f.tag === "EP-1"), "a dismissed row never counts");
    assert.ok(e.calls.some((c) => c.tool === "propose_takeoff" && /Bids/.test(c.args.rationale)));
  } finally {
    await r.cleanup();
  }
});

test("finish tags printed inside rooms assign them; a room with two tags is a finding, not a guess", async () => {
  const sq = (x: number, y: number) => [[x, y], [x + 100, y], [x + 100, y + 100], [x, y + 100]];
  const r = await rig({
    handlers: () => smallSet({
      find_schedule: () => { throw new EngineToolError("find_schedule", "no schedule"); },
      find_text: (a) => {
        if (a.q === "e") return { sheet: a.sheet, q: "e", count: 10, truncated: false, hits: [] };
        if (a.q === "LVT-2") return { sheet: a.sheet, q: a.q, count: 2, truncated: false, hits: [{ str: "LVT-2", center: [250, 50] }, { str: "LVT-2", center: [60, 60] }] };
        if (a.q === "CPT-1") return { sheet: a.sheet, q: a.q, count: 1, truncated: false, hits: [{ str: "CPT-1", center: [50, 50] }] };
        return { sheet: a.sheet, q: a.q, count: 0, truncated: false, hits: [] };
      },
      detect_rooms: () => ({ detected: 3, rooms: [{ label: "101", nverts: 4, verts: sq(0, 0) }, { label: "102", nverts: 4, verts: sq(200, 0) }, { label: "103", nverts: 4, verts: sq(500, 500) }] }),
      measure_polygon: (a) => ({ area_sf: 100, perimeter_lf: 40, nverts: 4, shape_id: `m-${a.condition}` }),
      edit_shape: (a) => ({ shape_id: a.shape_id }),
    }),
  });
  try {
    const m = setManifest({ scheduleRows: [{ finishTag: "CPT-1", category: "Carpet tile" }, { finishTag: "LVT-2", category: "LVT" }] });
    const job = await runOne(r, m);
    assert.equal(job.status, "done", job.reason);
    const e = r.engines[0];
    assert.deepEqual(e.calls.filter((c) => c.tool === "measure_polygon").map((c) => [c.args.sheet, c.args.condition]), [["A-plan.pdf", "LVT-2"]]);
    assert.deepEqual(e.calls.filter((c) => c.tool === "edit_shape").map((c) => c.args), [{ shape_id: "m-LVT-2", label: "102" }]);
    assert.deepEqual(job.findings.filter((f) => f.kind === "conflicting_finishes").map((f) => f.tag), ["101"]);
    assert.deepEqual(job.findings.filter((f) => f.kind === "room_no_schedule_row").map((f) => f.tag), ["103"]);
    assert.ok(!job.findings.some((f) => f.kind === "no_room_finish_match" || f.kind === "no_room_finish_schedule"));
  } finally {
    await r.cleanup();
  }
});

test("no room matches any finish: one consolidated question, not one RFI per room", async () => {
  const sq = (x: number, y: number) => [[x, y], [x + 100, y], [x + 100, y + 100], [x, y + 100]];
  const r = await rig({
    handlers: () => smallSet({
      find_schedule: () => { throw new EngineToolError("find_schedule", "no schedule"); },
      detect_rooms: () => ({ detected: 3, rooms: [{ label: "101", nverts: 4, verts: sq(200, 200) }, { label: "102", nverts: 4, verts: sq(400, 200) }, { label: "103", nverts: 4, verts: sq(600, 200) }] }),
    }),
  });
  try {
    const m = setManifest({ scheduleRows: [{ finishTag: "LVT-9", category: "LVT" }] });
    const job = await runOne(r, m);
    assert.equal(job.status, "done", job.reason);
    const e = r.engines[0];
    assert.ok(!e.calls.some((c) => c.tool === "measure_polygon"), "nothing drawn under a guess");
    assert.equal(job.findings.filter((f) => f.kind === "room_no_schedule_row").length, 0, "no per-room questions");
    const q = job.findings.filter((f) => f.kind === "no_room_finish_match");
    assert.equal(q.length, 1);
    assert.match(q[0].message, /3 of 3 rooms/);
    assert.match(q[0].detail ?? "", /no finish tag printed inside a room/);
  } finally {
    await r.cleanup();
  }
});

test("elevations included: loaded last, scale applied quietly, wall tile still left for the estimator", async () => {
  const r = await rig();
  try {
    const m = setManifest({ options: { includeElevations: true, dpi: 200 } });
    m.files.push({ ...m.files[1], fileId: "elev", name: "C-elevations.pdf", role: "elevations" });
    const job = await runOne(r, m);
    assert.equal(job.status, "done", job.reason);
    assert.deepEqual(r.engines[0].calls.filter((c) => c.tool === "load_plan").map((c) => path.basename(c.args.path)), ["A-plan.pdf", "B-schedule.pdf", "C-elevations.pdf"]);
    const wt = job.findings.find((f) => f.kind === "wall_tile_no_elevation")!;
    assert.match(wt.message, /no usable elevation measurement/);
  } finally {
    await r.cleanup();
  }
});

test("cold model: status goes starting while the waker starts it, then running, then done", async () => {
  const seq = ["stopped", "starting", "running"];
  const r = await rig({ services: { waker: () => ({ status: 200, state: seq.shift() ?? "running" }) } });
  try {
    const job = await runOne(r);
    assert.equal(job.status, "done", job.reason);
    assert.deepEqual(r.statuses, ["running", "starting", "running"]);
    assert.equal(r.services.calls.filter((c) => c.url.endsWith("/_waker/wake")).length, 1);
  } finally {
    await r.cleanup();
  }
});

test("no_memory for 4 hours: status no_memory, 15-minute retries, then failed with the honest message (not the 60-minute timeout)", async () => {
  const r = await rig({ services: { waker: () => ({ status: 200, state: "no_memory" }) } });
  try {
    const t0 = r.clock.now();
    const job = await runOne(r);
    assert.equal(job.status, "failed");
    assert.equal(job.reason, NO_MEMORY_MESSAGE);
    assert.deepEqual(r.statuses, ["running", "no_memory"]);
    assert.equal(r.clock.sleeps.filter((ms) => ms === 15 * 60_000).length, 16);
    assert.equal(r.clock.now() - t0, 4 * 3600_000);
    assert.ok(job.activeMs < 60 * 60_000, "time waiting for memory doesn't count against the run budget");
    assert.ok(!r.engines[0].calls.some((c) => c.tool === "export_takeoff"), "no draft written for a failed run");
  } finally {
    await r.cleanup();
  }
});

test("no_memory, then memory frees after 30 minutes: the run resumes and finishes", async () => {
  const seq = ["no_memory", "no_memory", "running"];
  const r = await rig({ services: { waker: () => ({ status: 200, state: seq.shift() ?? "running" }) } });
  try {
    const job = await runOne(r);
    assert.equal(job.status, "done", job.reason);
    assert.deepEqual(r.statuses, ["running", "no_memory", "running"]);
    assert.deepEqual(r.clock.sleeps, [15 * 60_000, 15 * 60_000]);
  } finally {
    await r.cleanup();
  }
});

test("vision down: the run finishes, the scan's scale is left for the estimator with a finding", async () => {
  const r = await rig({ services: { chat: () => ({ status: 502 }) } });
  try {
    const job = await runOne(r);
    assert.equal(job.status, "done");
    assert.ok(job.findings.some((f) => f.kind === "vision_unavailable"));
    assert.match(job.findings.find((f) => f.kind === "no_scale")!.message, /no scale note the engine could read/);
  } finally {
    await r.cleanup();
  }
});

test("over 80 sheets: failed with the plain reason", async () => {
  const r = await rig({ handlers: () => smallSet({ load_plan: () => ({ page_count: 81, sheets: [], files: [], file: "", note: "" }) }) });
  try {
    const job = await runOne(r);
    assert.equal(job.status, "failed");
    assert.match(job.reason!, /Too large for auto-takeoff \(81\+ sheets, limit 80\)/);
  } finally {
    await r.cleanup();
  }
});

test("an encrypted PDF fails before the engine starts, naming the file", async () => {
  const r = await rig();
  try {
    const m = setManifest({}, ENCRYPTED_PDF);
    const job = await runOne(r, m, (id) => (id === "plan" ? ENCRYPTED_PDF : PDF));
    assert.equal(job.status, "failed");
    assert.match(job.reason!, /"A-plan\.pdf" is encrypted/);
    assert.equal(r.engines.length, 0);
  } finally {
    await r.cleanup();
  }
});

test("a file that isn't a PDF fails naming it", async () => {
  const r = await rig();
  try {
    const junk = new TextEncoder().encode("PK\u0003\u0004 not a pdf");
    const job = await runOne(r, setManifest({}, junk), (id) => (id === "plan" ? junk : PDF));
    assert.equal(job.status, "failed");
    assert.match(job.reason!, /"A-plan\.pdf" is not a PDF/);
  } finally {
    await r.cleanup();
  }
});

test("cancel while running: the engine is stopped and the job ends cancelled", async () => {
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  let reached!: () => void;
  const atRooms = new Promise<void>((res) => { reached = res; });
  const r = await rig({ onCall: async (t) => { if (t === "detect_rooms") { reached(); await gate; } } });
  try {
    const job = await createUploaded(r.store, setManifest());
    await r.store.start(job.id);
    await atRooms;
    assert.equal(r.store.get(job.id).status, "running");
    await r.store.cancel(job.id);
    release();
    await r.store.whenIdle();
    const after = r.store.get(job.id);
    assert.equal(after.status, "cancelled");
    assert.equal(r.engines[0].closed, true);
    await assert.rejects(r.store.cancel(job.id), /already cancelled/);
  } finally {
    await r.cleanup();
  }
});

test("cancel before it runs: removed from the queue", async () => {
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const r = await rig({ onCall: async (t) => { if (t === "load_plan") await gate; } });
  try {
    const first = await createUploaded(r.store, setManifest());
    const second = await createUploaded(r.store, setManifest({ runId: "run-8" }));
    await r.store.start(first.id);
    await r.store.start(second.id);
    assert.equal(r.store.get(second.id).status, "queued");
    await r.store.cancel(second.id);
    assert.equal(r.store.get(second.id).status, "cancelled");
    release();
    await r.store.whenIdle();
    assert.equal(r.store.get(first.id).status, "done");
    assert.equal(r.engines.length, 1, "the cancelled job never ran");
  } finally {
    await r.cleanup();
  }
});

test("one job at a time, first come first served", async () => {
  let active = 0;
  let max = 0;
  const order: string[] = [];
  const r = await rig({ onCall: async (t) => { if (t === "sheet_graph") { active++; max = Math.max(max, active); await new Promise((res) => setTimeout(res, 5)); } if (t === "export_report") active--; } });
  try {
    const ids: string[] = [];
    for (const run of ["a", "b", "c"]) {
      const j = await createUploaded(r.store, setManifest({ runId: `run-${run}` }));
      ids.push(j.id);
    }
    for (const id of ids) await r.store.start(id);
    await r.store.whenIdle();
    for (const id of ids) order.push(r.store.get(id).startedAt!);
    assert.equal(max, 1);
    assert.deepEqual([...order].sort(), order, "started in the order they were queued");
    assert.deepEqual(ids.map((id) => r.store.get(id).status), ["done", "done", "done"], ids.map((id) => r.store.get(id).reason).join(" | "));
  } finally {
    await r.cleanup();
  }
});

test("the 60-minute budget: a run that goes long is stopped and failed", async () => {
  const r = await rig({ onCall: (t, clock) => { if (t === "detect_rooms") clock.t += 61 * 60_000; } });
  try {
    const job = await runOne(r);
    assert.equal(job.status, "failed");
    assert.match(job.reason!, /ran past 60 minutes/);
  } finally {
    await r.cleanup();
  }
});

test("an engine crash fails the job with the reason; a tool refusal is a finding, not a failure", async () => {
  const crash = await rig({ handlers: () => smallSet({ sheet_graph: () => { throw new Error("engine exited (code 137)"); } }) });
  try {
    const job = await runOne(crash);
    assert.equal(job.status, "failed");
    assert.match(job.reason!, /The takeoff engine stopped: engine exited \(code 137\)/);
  } finally {
    await crash.cleanup();
  }
  const refusal = await rig({ handlers: () => smallSet({ derive_transitions: () => { throw new (require_EngineToolError())("derive_transitions", "no scale on A-plan.pdf"); } }) });
  try {
    const job = await runOne(refusal);
    assert.equal(job.status, "done");
    assert.ok(job.findings.some((f) => f.kind === "step_failed" && /derive_transitions did not finish: no scale/.test(f.message)));
  } finally {
    await refusal.cleanup();
  }
});

import { EngineToolError } from "../src/engine.ts";
function require_EngineToolError() { return EngineToolError; }

test("restart: a run cut off mid-way is failed, a started job still waiting runs, old jobs are swept after 7 days", async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const clock = new FakeClock();
    const mk = async (id: string, job: Record<string, unknown>) => {
      await mkdir(path.join(dir, "jobs", id, "files"), { recursive: true });
      await writeFile(path.join(dir, "jobs", id, "job.json"), JSON.stringify({ id, manifest: setManifest(), files: [], findings: [], counts: {}, outputs: [], progress: { step: "", page: 0, pages: 0 }, activeMs: 0, ...job }));
    };
    const iso = (msAgo: number) => new Date(clock.now() - msAgo).toISOString();
    await mk("11111111-1111-4111-8111-111111111111", { status: "running", createdAt: iso(1000), startedAt: iso(500) });
    await mk("22222222-2222-4222-8222-222222222222", { status: "queued", createdAt: iso(1000), startRequestedAt: iso(900) });
    await mk("33333333-3333-4333-8333-333333333333", { status: "done", createdAt: iso(9 * 86400_000), finishedAt: iso(8 * 86400_000) });
    await mk("44444444-4444-4444-8444-444444444444", { status: "done", createdAt: iso(2 * 86400_000), finishedAt: iso(86400_000) });
    const ran: string[] = [];
    const store = new JobStore({ dataDir: dir, clock, jobTimeoutMs: 3600_000, retentionMs: 7 * 86400_000, execute: async (ctx) => { ran.push(ctx.jobId); return { counts: { sheets: 0, rooms: 0, conditions: 0, rfisDrafted: 0 }, findings: [], outputs: [] }; } });
    await store.init();
    await store.whenIdle();
    const cut = store.get("11111111-1111-4111-8111-111111111111");
    assert.equal(cut.status, "failed");
    assert.match(cut.reason!, /restarted during this run/);
    assert.deepEqual(ran, ["22222222-2222-4222-8222-222222222222"]);
    assert.throws(() => store.get("33333333-3333-4333-8333-333333333333"), /No such job/);
    assert.deepEqual((await readdir(path.join(dir, "jobs"))).sort(), ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "44444444-4444-4444-8444-444444444444"], "the 8-day-old job's folder is gone");
    clock.t += 7 * 86400_000 + 1;
    assert.equal(await store.sweep(), 3, "everything else ages out on schedule");
  } finally {
    await cleanup();
  }
});

test("duplicate input pages are skipped: no scale finding, no rooms, hidden at import", async () => {
  const r = await rig({ handlers: () => smallSet({ view_sheet: (a: any) => (a.region ? "iVBORw0KGgo=" : a.sheet === "B-schedule.pdf" ? "schedule-page" : "same-page") }) });
  try {
    const job = await runOne(r);
    assert.equal(job.status, "done", job.reason);
    const ann = JSON.parse(await readFile(path.join(r.dataDir, "jobs", job.id, "outputs", "annotations.json"), "utf8"));
    assert.ok(!job.findings.some((f) => f.sheet === "A-plan.pdf#2"), "a duplicate page gets no findings");
    assert.ok(!r.engines[0].calls.some((c) => c.tool === "sheet_info" && c.args.sheet === "A-plan.pdf#2"), "no scale pass on the duplicate");
    assert.deepEqual(ann.hidden_sheets, ["A-plan.pdf#2"]);
  } finally {
    await r.cleanup();
  }
});

test("non-plan sheets (detail-only) get no scale RFI and are hidden at import", async () => {
  const r = await rig({ handlers: () => smallSet({ sheet_graph: () => ({ available: true, sheets: [{ sheet: "A-plan.pdf", role: "plan" }, { sheet: "A-plan.pdf#2", role: "detail" }, { sheet: "B-schedule.pdf", role: "schedule" }] }) }) });
  try {
    const job = await runOne(r);
    assert.equal(job.status, "done", job.reason);
    const ann = JSON.parse(await readFile(path.join(r.dataDir, "jobs", job.id, "outputs", "annotations.json"), "utf8"));
    assert.ok(!job.findings.some((f) => f.kind === "no_scale"), "no scale RFI on a detail sheet");
    assert.ok(!r.engines[0].calls.some((c) => c.tool === "view_sheet" && c.args.region), "no vision call for a non-plan sheet");
    assert.deepEqual(ann.hidden_sheets, ["A-plan.pdf#2"]);
  } finally {
    await r.cleanup();
  }
});

test("a sheet guessed non-plan from its number (A2.1, engine role unknown) gets no scale RFI but still gets room detection", async () => {
  const withA21 = (h: Record<string, (a: any) => unknown>) => ({ ...h, load_plan: (a: any) => { const out: any = h.load_plan(a); return { ...out, sheets: out.sheets.map((s: any) => (s.sheet === "A-plan.pdf" ? { ...s, sheet_number: "A2.1" } : s)) }; } });
  const r = await rig({ handlers: () => withA21(smallSet({ sheet_graph: () => ({ available: true, sheets: [{ sheet: "A-plan.pdf", role: "unknown" }, { sheet: "A-plan.pdf#2", role: "plan" }, { sheet: "B-schedule.pdf", role: "schedule" }] }) })) });
  try {
    const job = await runOne(r);
    assert.equal(job.status, "done", job.reason);
    const ann = JSON.parse(await readFile(path.join(r.dataDir, "jobs", job.id, "outputs", "annotations.json"), "utf8"));
    assert.ok(r.engines[0].calls.some(c => c.tool === "detect_rooms" && c.args.sheet === "A-plan.pdf"), "a guessed non-plan sheet still gets room detection");
    assert.ok(!(ann.hidden_sheets ?? []).includes("A-plan.pdf"), "a sheet with drawn rooms is not auto-hidden");
  } finally {
    await r.cleanup();
  }
});

test("vision fallback reads a vector plan sheet whose scale note has no text layer", async () => {
  const r = await rig({ handlers: () => smallSet({ sheet_info: (a: any) => ({ sheet: a.sheet, page: 1, width_pt: 1224, height_pt: 792, width_px: 2448, height_px: 1584, detected_scale: a.sheet === "A-plan.pdf" ? "1/8\" = 1'-0\"" : undefined, seg_count: 5000, has_vector_linework: true, scale_set: false, shape_count: 0, layers: [] }) }) });
  try {
    const job = await runOne(r);
    assert.equal(job.status, "done", job.reason);
    const ann = JSON.parse(await readFile(path.join(r.dataDir, "jobs", job.id, "outputs", "annotations.json"), "utf8"));
    const noScale = job.findings.filter((f) => f.kind === "no_scale");
    assert.deepEqual(noScale.map((f) => f.sheet), ["A-plan.pdf#2"]);
    assert.match(noScale[0].message, /has no scale text the engine could read; the AI read the note as/);
    assert.ok(r.engines[0].calls.some((c) => c.tool === "view_sheet" && c.args.sheet === "A-plan.pdf#2" && c.args.region), "vision was asked even though the sheet has linework");
    assert.equal(ann.hidden_sheets, undefined);
  } finally {
    await r.cleanup();
  }
});

test("a main plan with several scale notes gets the title-block scale and a multiple_scales finding", async () => {
  const r = await rig({ handlers: () => smallSet({ sheet_info: (a: any) => ({ sheet: a.sheet, page: 1, width_pt: 1224, height_pt: 792, width_px: 2448, height_px: 1584, detected_scale: "1/8\" = 1'-0\"", multiple_scales: a.sheet === "A-plan.pdf" ? true : undefined, seg_count: 5000, has_vector_linework: true, scale_set: false, shape_count: 0, layers: [] }) }) });
  try {
    const job = await runOne(r);
    assert.equal(job.status, "done", job.reason);
    const multi = job.findings.filter((f) => f.kind === "multiple_scales");
    assert.deepEqual(multi.map((f) => f.sheet), ["A-plan.pdf"]);
    assert.match(multi[0].message, /title-block scale .* was applied to the main plan/);
    assert.ok(r.engines[0].calls.some((c) => c.tool === "set_scale" && c.args.sheet === "A-plan.pdf" && c.args.use_detected === true), "the title-block scale is applied");
    assert.ok(!job.findings.some((f) => f.kind === "no_scale" && f.sheet === "A-plan.pdf"));
  } finally {
    await r.cleanup();
  }
});
