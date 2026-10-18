// FLOOR360 auto-takeoff review: the draft / approve gate (lib/aiDraft.js), the
// floor360AutoTakeoff key through the one document writer, and the browser
// client of /api/bids/drafts (lib/bidsDrafts.js). Pinned: every check records
// who and when; un-checking re-locks Approve; wall tile adds an item when a
// wall-tile condition exists or the runner's checklistItems lists it (the
// runner's real marker is read here); unknown keys survive a save; a project without
// the key writes byte-identical documents; the route's 404 reads as off.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_TAKEOFF_KEY, CHECKLIST_ITEMS, WALL_TILE_ITEM, approveAutoTakeoff, canApprove, checkOf, checklistItems,
  isWallTileCondition, markBidsNotified, missingChecks, needsBidsNotice, readAutoTakeoff, setCheck,
} from "../src/lib/aiDraft.js";
import { claimDraft, claimText, formatCt, loadAiDrafts, notifyApproved } from "../src/lib/bidsDrafts.js";
import { buildTakeoffDocument, TAKEOFF_DOCUMENT_KEYS } from "../src/lib/takeoffDocument.js";
import { isJobFolderId } from "../src/lib/msgraph/projects.js";
import { CHECKLIST_ITEMS as RUNNER_ITEMS, DRAFT_MARKER_KEY as RUNNER_MARKER_KEY, markDraft } from "../../floor360/takeoff-runner/src/outputs.ts";

const T0 = "2026-10-18T00:12:00.000Z";   // 7:12 PM CT, Oct 17
const ME = "rpalermo@floor360.com";
const draft = (extra: Record<string, unknown> = {}) => ({
  status: "draft", runId: "run_1", bidId: "bid-9", bidNumber: "F360-26-0170", generatedAt: "2026-10-17T23:00:00Z", runnerVersion: "0.1.0", checklist: {}, ...extra,
});
const CARPET = [{ id: "c1", finish_tag: "CPT-1" }];
type AT = ReturnType<typeof draft>;
const checkAll = (at: AT, conditions: unknown[]) => checklistItems(conditions).reduce((a: AT, it) => setCheck(a, it.id, true, ME, T0), at);

test("checklist: the eight items in order; wall tile only with a wall-tile condition", () => {
  assert.deepEqual(CHECKLIST_ITEMS.map((i) => i.label), ["Scales", "Schedule mapping", "Areas and rooms", "Seams and transitions", "Waste and quantities", "Shop drawings", "Submittal docs", "RFIs"]);
  assert.equal(checklistItems(CARPET).length, 8);
  assert.equal(checklistItems([]).length, 8);
  assert.equal(checklistItems(undefined as never).length, 8);
  for (const c of [{ finish_tag: "WT-1" }, { finish_tag: "PT-2", name: "Porcelain wall tile" }, { finish_tag: "T-1", spec: { description: "Ceramic Wall-Tile 3x6" } }]) {
    assert.equal(isWallTileCondition(c), true, JSON.stringify(c));
    assert.deepEqual(checklistItems([...CARPET, c]).at(-1), WALL_TILE_ITEM);
  }
  for (const c of [{ finish_tag: "WTR-1" }, { finish_tag: "PT-1", name: "Porcelain floor tile" }, null]) assert.equal(isWallTileCondition(c), false, JSON.stringify(c));
  assert.equal(WALL_TILE_ITEM.label, "Wall tile from elevations");
});

test("a check records who and when; un-checking removes it and re-locks Approve", () => {
  let at = draft();
  assert.equal(canApprove(at, CARPET), false);
  at = setCheck(at, "scales", true, ME, T0);
  assert.deepEqual(checkOf(at, "scales"), { by: ME, at: T0 });
  at = checkAll(at, CARPET);
  assert.equal(missingChecks(at, CARPET).length, 0);
  assert.equal(canApprove(at, CARPET), true);
  const relocked = setCheck(at, "rfis", false, ME, T0);
  assert.equal(checkOf(relocked, "rfis"), null);
  assert.equal(canApprove(relocked, CARPET), false);
  assert.deepEqual(missingChecks(relocked, CARPET).map((m) => m.id), ["rfis"]);
  assert.equal(checkOf(at, "rfis")?.by, ME, "setCheck doesn't mutate its input");
});

test("no name, no check; a malformed record isn't a check; only a draft changes", () => {
  const at = draft({ checklist: { scales: { by: "", at: T0 }, rfis: "yes" } });
  assert.equal(setCheck(at, "scales", true, "  ", T0), at);
  assert.equal(checkOf(at, "scales"), null);
  assert.equal(checkOf(at, "rfis"), null);
  const approved = { ...draft(), status: "approved" };
  assert.equal(setCheck(approved, "scales", true, ME, T0), approved);
});

test("Approve: locked until every item (incl. wall tile) is checked; sets status, approvedBy/At", () => {
  const wall = [...CARPET, { id: "w", finish_tag: "WT-1" }];
  const eight = CHECKLIST_ITEMS.reduce((a: AT, it) => setCheck(a, it.id, true, ME, T0), draft());
  assert.equal(canApprove(eight, CARPET), true);
  assert.equal(canApprove(eight, wall), false, "wall tile adds a ninth item");
  assert.equal(approveAutoTakeoff(eight, wall, ME, T0), null);
  const nine = setCheck(eight, WALL_TILE_ITEM.id, true, ME, T0);
  const approved = approveAutoTakeoff(nine, wall, ME, T0)!;
  assert.equal(approved.status, "approved");
  assert.equal(approved.approvedBy, ME);
  assert.equal(approved.approvedAt, T0);
  assert.equal(approved.runId, "run_1");
  assert.equal(approveAutoTakeoff(nine, wall, "", T0), null, "no signed-in name, no approval");
  assert.equal(approveAutoTakeoff(approved, wall, ME, T0), null, "approve once");
});

test("the runner's own marker: same key and item ids; its wall-tile item gates Approve without a wall-tile condition", () => {
  const info = (wallTile: boolean) => ({
    manifest: { runId: "run_1", bidId: "bid-9", bidNumber: "F360-26-0170", projectName: "Perfumania Wauwatosa", files: [], scheduleRows: [], options: { includeElevations: true, dpi: 144 } },
    jobId: "job_1", generatedAt: T0, runnerVersion: "0.1.0", engineVersion: "0.9.98",
    counts: { sheets: 1, rooms: 2, conditions: 1, rfisDrafted: 1 },
    findings: [{ kind: "wall_tile_no_elevation" as const, message: "Wall tile WT-1: not measured.", tag: "WT-1", rfi: "RFI-001" }],
    wallTile,
  });
  assert.equal(RUNNER_MARKER_KEY, AUTO_TAKEOFF_KEY);
  assert.deepEqual([...RUNNER_ITEMS], CHECKLIST_ITEMS.map((i) => i.id));
  const payload = JSON.parse(JSON.stringify(markDraft({ schema: "opentakeoff.takeoff_canvas.v1", shapes: [] }, info(true), [])));
  const at = readAutoTakeoff(payload)!;
  assert.equal(at.status, "draft");
  assert.deepEqual(at.checklistItems, [...RUNNER_ITEMS, WALL_TILE_ITEM.id]);
  assert.deepEqual(checklistItems(CARPET, at).map((i) => i.id), at.checklistItems, "the runner's list, in order");
  const eight = CHECKLIST_ITEMS.reduce((a: typeof at, it) => setCheck(a, it.id, true, ME, T0), at);
  assert.equal(canApprove(eight, CARPET), false, "wall tile from the schedule locks Approve with only floor conditions");
  assert.deepEqual(missingChecks(eight, CARPET).map((m) => m.id), [WALL_TILE_ITEM.id]);
  const approved = approveAutoTakeoff(setCheck(eight, WALL_TILE_ITEM.id, true, ME, T0), CARPET, ME, T0)!;
  assert.equal(approved.status, "approved");
  const out = JSON.parse(JSON.stringify(buildTakeoffDocument({ conditions: CARPET, floor360AutoTakeoff: approved })))[AUTO_TAKEOFF_KEY];
  assert.deepEqual(out.counts, { sheets: 1, rooms: 2, conditions: 1, rfisDrafted: 1 });
  assert.deepEqual(out.findings, [{ kind: "wall_tile_no_elevation", message: "Wall tile WT-1: not measured.", tag: "WT-1", rfi: "RFI-001" }]);
  assert.equal(out.checklist.wall_tile_elevations.by, ME);

  const plain = readAutoTakeoff(JSON.parse(JSON.stringify(markDraft({ shapes: [] }, info(false), []))))!;
  assert.equal(checklistItems(CARPET, plain).length, 8);
  assert.equal(checklistItems([{ finish_tag: "WT-1" }], plain).at(-1), WALL_TILE_ITEM, "a wall-tile condition still adds it");
  assert.equal(checklistItems(CARPET, { ...plain, checklistItems: ["scales", "future_item"] }).length, 8, "the eight always show; unknown ids are ignored");
});

test("Bids notice: pending after approve, cleared by markBidsNotified; never on a draft or without runId", () => {
  const approved = approveAutoTakeoff(checkAll(draft(), CARPET), CARPET, ME, T0)!;
  assert.equal(needsBidsNotice(approved), true);
  const told = markBidsNotified(approved, T0);
  assert.equal(needsBidsNotice(told), false);
  assert.equal(told.status, "approved");
  assert.equal(needsBidsNotice(draft()), false);
  assert.equal(needsBidsNotice({ ...approved, runId: "" }), false);
});

test("payload round trip: the key rides through the writer with unknown fields intact", () => {
  const at = { ...draft({ checklist: { scales: { by: ME, at: T0, note: "kept" } } }), futureField: { nested: [1, 2] } };
  const payload = { schema: "x", shapes: [], [AUTO_TAKEOFF_KEY]: at };
  const loaded = readAutoTakeoff(JSON.parse(JSON.stringify(payload)))!;
  const doc = buildTakeoffDocument({ conditions: CARPET, floor360AutoTakeoff: setCheck(loaded, "rfis", true, ME, T0) });
  const out = JSON.parse(JSON.stringify(doc))[AUTO_TAKEOFF_KEY];
  assert.deepEqual(out.futureField, { nested: [1, 2] });
  assert.equal(out.checklist.scales.note, "kept");
  assert.deepEqual(out.checklist.rfis, { by: ME, at: T0 });
  assert.equal(out.bidNumber, "F360-26-0170");
  assert.equal(Object.keys(doc).at(-1), AUTO_TAKEOFF_KEY);
  assert.equal(TAKEOFF_DOCUMENT_KEYS.at(-1), AUTO_TAKEOFF_KEY);
});

test("projects without the key: nothing read, nothing written, documents byte-identical", () => {
  const fields = { project_name: "Job", conditions: CARPET, shapes: [{ id: "s1" }], sheet_tabs: ["a.pdf"] };
  const before = JSON.stringify(buildTakeoffDocument(fields));
  for (const v of [undefined, null, {}, [], "draft", { status: 1 }]) {
    assert.equal(JSON.stringify(buildTakeoffDocument({ ...fields, floor360AutoTakeoff: v })), before, JSON.stringify(v));
  }
  assert.equal(readAutoTakeoff({ shapes: [] }), null);
  assert.equal(readAutoTakeoff(null), null);
  assert.equal(readAutoTakeoff({ [AUTO_TAKEOFF_KEY]: [] }), null);
});

test("formatCt and claimText: Central time with CT; today is time only", () => {
  const now = new Date("2026-10-18T01:00:00Z");   // 8:00 PM CT Oct 17
  assert.equal(formatCt(T0, now), "7:12 PM CT");
  assert.equal(formatCt("2026-10-16T15:05:00Z", now), "Oct 16, 10:05 AM CT");
  assert.equal(formatCt("2025-12-31T18:00:00Z", now), "Dec 31, 2025, 12:00 PM CT");
  assert.equal(formatCt("nope", now), "");
  assert.equal(claimText({ claimedByEmail: "rpalermo@floor360.com", claimedByName: "Rob Palermo", claimedAt: T0 }, "bwright@floor360.com", now), "Rob claimed this at 7:12 PM CT");
  assert.equal(claimText({ claimedByEmail: "bwright@floor360.com", claimedAt: T0 }, "rpalermo@floor360.com", now), "bwright@floor360.com claimed this at 7:12 PM CT");
  assert.equal(claimText({ claimedByEmail: "RPalermo@floor360.com", claimedAt: T0 }, ME, now), "You claimed this at 7:12 PM CT");
  assert.equal(claimText({ claimedByEmail: "", claimedAt: "" }, ME, now), "");
});

type FakeReply = { status: number; body?: unknown; html?: boolean } | Error;
function fakeFetch(replies: FakeReply[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = replies.shift()!;
    if (r instanceof Error) throw r;
    if (r.html) return new Response("<!doctype html>", { status: r.status, headers: { "Content-Type": "text/html" } });
    return Response.json(r.body ?? {}, { status: r.status });
  };
  return { calls, fn: fn as unknown as typeof fetch };
}

test("loadAiDrafts: 404, an HTML fallback or no connection is off; otherwise drafts, user and any error", async () => {
  for (const r of [{ status: 404, body: { error: "Not found" } }, { status: 200, html: true }, new TypeError("offline")]) {
    assert.deepEqual(await loadAiDrafts(fakeFetch([r]).fn), { enabled: false });
  }
  const user = { email: ME, name: "Rob Palermo" };
  const ok = await loadAiDrafts(fakeFetch([{ status: 200, body: { enabled: true, user, drafts: [{ runId: "r" }] } }]).fn);
  assert.deepEqual(ok, { enabled: true, user, drafts: [{ runId: "r" }], error: "" });
  const refused = await loadAiDrafts(fakeFetch([{ status: 502, body: { enabled: true, user, drafts: [], error: "Bids hasn't accepted this site's identity yet (Appendix B)." } }]).fn);
  assert.equal(refused.enabled, true);
  assert.match(refused.error || "", /Appendix B/);
  assert.equal((await loadAiDrafts(fakeFetch([{ status: 401, body: { error: "Sign in" } }]).fn)).enabled, false);
});

test("claimDraft / notifyApproved: JSON POSTs; 409 is taken, not an error; failures are readable", async () => {
  const f = fakeFetch([
    { status: 200, body: { claimedByEmail: ME, claimedAt: T0 } },
    { status: 409, body: { claimedByEmail: "bwright@floor360.com", claimedAt: T0 } },
    { status: 502, body: { error: "Bids hasn't accepted this site's identity yet (Appendix B)." } },
    { status: 200, body: { ok: true } },
    { status: 504, body: { error: "Bids didn't answer in 15 s. Try again." } },
    new TypeError("offline"),
  ]);
  assert.deepEqual(await claimDraft("run_1", f.fn), { ok: true, claimedByEmail: ME, claimedAt: T0 });
  assert.deepEqual(await claimDraft("run_1", f.fn), { taken: true, claimedByEmail: "bwright@floor360.com", claimedAt: T0 });
  assert.match((await claimDraft("run_1", f.fn)).error || "", /Appendix B/);
  assert.deepEqual(await notifyApproved("run_1", f.fn), { ok: true });
  assert.match((await notifyApproved("run_1", f.fn)).error || "", /15 s/);
  assert.match((await notifyApproved("run_1", f.fn)).error || "", /connection/);
  assert.equal(f.calls[0].url, "/api/bids/drafts/run_1/claim");
  assert.equal(f.calls[3].url, "/api/bids/drafts/run_1/approved");
  assert.equal(f.calls[0].init.method, "POST");
  assert.equal((f.calls[0].init.headers as Record<string, string>)["Content-Type"], "application/json");
});

test("Open uses the job folder id only when ?job= would accept it", () => {
  assert.equal(isJobFolderId("01NF4SHUABCDEFGHIJKLMNOPQRSTUVWX"), true);
  assert.equal(isJobFolderId("../../etc"), false);
  assert.equal(isJobFolderId(""), false);
  assert.equal(isJobFolderId(undefined), false);
});
