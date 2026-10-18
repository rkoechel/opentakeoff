// One AI takeoff run over the engine (Phase 2 §4): load_plan (merge), the
// sheet graph and find_schedule, a batch scale pass, detect_rooms from the
// schedule, derive_base, derive_transitions, mark_verdict on confident rooms,
// then export_takeoff / export_marked_pdf / export_report. Everything the run
// could not answer becomes a finding with the sheet to look at — never a guess.
import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Engine } from "./engine.ts";
import { EngineToolError } from "./engine.ts";
import { hasPdfHeader, isEncryptedPdf } from "./pdfcheck.ts";
import { JobFailure, VisionUnavailable, type Vision } from "./vision.ts";
import { markDraft, reportCsv, runRecord, sheetsManifest, type DraftInfo } from "./outputs.ts";
import { draftRfis } from "./rfis.ts";
import { LIMITS } from "./config.ts";
import { setName, type Counts, type Finding, type JobManifest, type ManifestFile, type Point, type ScheduleRow } from "./types.ts";
import { duplicatePages, isNonPlanSheet } from "./sheetfilter.ts";

export interface RunContext {
  jobId: string;
  manifest: JobManifest;
  filesDir: string;
  outputsDir: string;
  workDir: string;
  signal: AbortSignal;
  setStatus(s: "starting" | "running" | "no_memory"): void;
  progress(step: string, page?: number, pages?: number): void;
}

export interface RunResult {
  counts: Counts;
  findings: Finding[];
  outputs: string[];
}

export interface PipelineDeps {
  startEngine(signal: AbortSignal): Promise<Engine>;
  vision: Vision | null;
  runnerVersion: string;
  verdictMinConfidence: number;
  now?: () => Date;
  /** Runs after the takeoff and before the exports, so anything it adds to the
   *  session lands in every output. Default: draftRfis (rfis.ts). */
  beforeExport?: (engine: Engine, state: RunState) => Promise<void>;
}

interface SheetSummary { sheet: string; page: number; width_px: number; height_px: number; sheet_number?: string; detected_scale?: string }

export interface CommittedRoom {
  shapeId: string;
  sheet: string;
  label: string;
  condition: string;
  confidence?: number;
  raster?: boolean;
  fromSchedule: boolean;
}

export interface RunState {
  manifest: JobManifest;
  sheets: SheetSummary[];
  fileOfSheet: Map<string, ManifestFile>;
  roles: Map<string, string>;
  scaled: Set<string>;
  nts: Set<string>;
  rooms: CommittedRoom[];
  findings: Finding[];
  scheduleSheet?: string;
  scheduleRegion?: [Point, Point];
  rfisDrafted: number;
  /** Vision failed once this run: scanned sheets after it skip the call. */
  visionOff: boolean;
  addFinding(f: Finding): void;
}

const WALL_TILE = /wall\s*tile|wall\s*(porcelain|ceramic)|(porcelain|ceramic)\s+wall/i;
const BASE = /\bbase\b|cove\s*base/i;
const TRANSITION = /transition|threshold|reducer|edge\s*strip/i;
const rowText = (r: ScheduleRow) => `${r.category ?? ""} ${r.product ?? ""}`;
const normTag = (t: string) => t.trim().toUpperCase();

export function classifyRow(r: ScheduleRow): "wall_tile" | "base" | "transition" | "floor" {
  const tag = normTag(r.finishTag);
  if (WALL_TILE.test(rowText(r)) || /^WT-?\d/.test(tag)) return "wall_tile";
  if (BASE.test(r.category ?? "") || /^(RB|VB|WB|CB)-?\d/.test(tag)) return "base";
  if (TRANSITION.test(rowText(r)) || /^(TR|TS|TH)-?\d/.test(tag)) return "transition";
  return "floor";
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const tagRe = (tag: string) => new RegExp(`(^|[^A-Z0-9])${escapeRe(normTag(tag))}($|[^A-Z0-9])`, "i");
const NTS_RE = /(^|[^A-Z])(N\.?\s?T\.?\s?S\.?|NOT\s+TO\s+SCALE)($|[^A-Z])/i;

function boxAround(at: Point, half = 90): [Point, Point] {
  return [[at[0] - half, at[1] - half], [at[0] + half, at[1] + half]];
}

/** Order the engine loads files in: plans, addenda, schedule, then elevations
 *  (only when asked for). The first file replaces the session, the rest merge. */
export function loadOrder(m: JobManifest): ManifestFile[] {
  const rank: Record<string, number> = { plans: 0, addendum: 1, schedule: 2, elevations: 3 };
  return m.files
    .filter((f) => f.role !== "elevations" || m.options.includeElevations)
    .slice()
    .sort((a, b) => rank[a.role] - rank[b.role]);
}

export async function runTakeoff(ctx: RunContext, deps: PipelineDeps): Promise<RunResult> {
  const m = ctx.manifest;
  const files = loadOrder(m);
  if (!files.length) throw new JobFailure("No plan or schedule PDFs to take off (elevations only).");

  // ── preflight: every file a PDF, none encrypted ──────────────────────────
  ctx.progress("Checking files");
  for (const f of files) {
    const p = path.join(ctx.filesDir, f.name);
    if (!(await hasPdfHeader(p))) throw new JobFailure(`"${f.name}" is not a PDF. Upload the PDF itself, or run this takeoff by hand.`);
    if (await isEncryptedPdf(p)) throw new JobFailure(`"${f.name}" is encrypted (password-protected). Save an unlocked copy and Retry, or run this takeoff by hand.`);
  }

  ctx.progress("Starting the takeoff engine");
  const engine = await deps.startEngine(ctx.signal);
  try {
    return await runWithEngine(ctx, deps, engine, files);
  } finally {
    await engine.close();
  }
}

async function runWithEngine(ctx: RunContext, deps: PipelineDeps, engine: Engine, files: ManifestFile[]): Promise<RunResult> {
  const m = ctx.manifest;
  const seen = new Set<string>();
  const state: RunState = {
    manifest: m,
    sheets: [],
    fileOfSheet: new Map(),
    roles: new Map(),
    scaled: new Set(),
    nts: new Set(),
    rooms: [],
    findings: [],
    rfisDrafted: 0,
    visionOff: false,
    addFinding(f) {
      const key = `${f.kind}|${f.sheet ?? ""}|${normTag(f.tag ?? "")}`;
      if (seen.has(key)) return;
      seen.add(key);
      state.findings.push(f);
    },
  };
  const tryStep = async <T>(step: string, fn: () => Promise<T>, sheet?: string): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      if (ctx.signal.aborted || e instanceof JobFailure) throw e;
      if (!(e instanceof EngineToolError)) throw e;
      state.addFinding({ kind: "step_failed", sheet, tag: step, message: `${step}${sheet ? ` on ${sheet}` : ""} did not finish: ${e.message}` });
      return null;
    }
  };
  ctx.setStatus("running");

  // ── load the set ─────────────────────────────────────────────────────────
  for (const [i, f] of files.entries()) {
    ctx.progress("Loading documents", i + 1, files.length);
    const r = await engine.call<{ page_count: number; sheets: SheetSummary[] }>("load_plan", { path: path.join(ctx.filesDir, f.name), merge: i > 0 });
    if (r.page_count > LIMITS.maxSheets) throw new JobFailure(`Too large for auto-takeoff (${r.page_count}+ sheets, limit ${LIMITS.maxSheets}). Run it by hand.`);
    state.sheets = r.sheets;
  }
  const byFile = new Map(files.map((f) => [f.name, f]));
  for (const s of state.sheets) {
    const f = byFile.get(s.sheet.split("#")[0]);
    if (f) state.fileOfSheet.set(s.sheet, f);
  }
  // ── duplicate input pages (Ryan 2026-10-18): a page sent twice is read once ──
  // Same rendered page = same sheet. Duplicates get no scale pass, no rooms and no findings, and are hidden at import.
  const pageHash = new Map<string, string>();
  for (const [i, s] of state.sheets.entries()) {
    ctx.progress("Checking for duplicate pages", i + 1, state.sheets.length);
    try {
      const png = await engine.image("view_sheet", { sheet: s.sheet, px: 200 });
      pageHash.set(s.sheet, createHash("sha256").update(`${s.width_px}x${s.height_px}|${png}`).digest("hex"));
    } catch (e) {
      if (ctx.signal.aborted || !(e instanceof EngineToolError)) throw e;
    }
  }
  const dupOf = duplicatePages(state.sheets.map((s) => s.sheet), pageHash);

  // ── index: sheet roles and schedules ─────────────────────────────────────
  ctx.progress("Indexing the set");
  const graph = await tryStep("sheet_graph", () => engine.call<{ available: boolean; sheets: { sheet: string; role: string }[] }>("sheet_graph"));
  for (const s of graph?.sheets ?? []) state.roles.set(s.sheet, s.role);
  const nonPlan = new Set(state.sheets.filter((s) => !dupOf.has(s.sheet) && isNonPlanSheet(state.roles.get(s.sheet), s.sheet_number)).map((s) => s.sheet));   // cover, spec, schedule, detail-only: no scale RFIs, hidden at import
  let roomFinish = false;
  try {
    const rf = await engine.call<{ matches: { sheet: string; region: { x0: number; y0: number; x1: number; y1: number } }[] }>("find_schedule", { kind: "room finish" });
    if (rf.matches.length) {
      roomFinish = true;
      state.scheduleSheet = rf.matches[0].sheet;
      const g = rf.matches[0].region;
      state.scheduleRegion = [[g.x0, g.y0], [g.x1, g.y1]];
    }
  } catch (e) {
    if (!(e instanceof EngineToolError)) throw e;
  }
  let materialSchedule = false;
  try {
    const mf = await engine.call<{ matches: { sheet: string; region: { x0: number; y0: number; x1: number; y1: number } }[] }>("find_schedule", { kind: "finish" });
    if (mf.matches.length) {
      materialSchedule = true;
      if (!state.scheduleSheet) {
        state.scheduleSheet = mf.matches[0].sheet;
        const g = mf.matches[0].region;
        state.scheduleRegion = [[g.x0, g.y0], [g.x1, g.y1]];
      }
    }
  } catch (e) {
    if (!(e instanceof EngineToolError)) throw e;
  }

  const sheetsOf = (role: ManifestFile["role"]) => state.sheets.filter((s) => state.fileOfSheet.get(s.sheet)?.role === role);
  const hasText = async (sheet: string) => {
    // every text layer on a drawing carries an "e" somewhere; a scan carries none
    const r = await tryStep("find_text", () => engine.call<{ count: number }>("find_text", { sheet, q: "e", limit: 1 }), sheet);
    return (r?.count ?? 0) > 0;
  };

  // a schedule file the engine can't read (a scan): Bids' rows may stand in
  const scheduleSheets = sheetsOf("schedule");
  if (scheduleSheets.length && !roomFinish && !materialSchedule) {
    let anyText = false;
    for (const s of scheduleSheets) if (await hasText(s.sheet)) { anyText = true; break; }
    if (!anyText) {
      state.addFinding({
        kind: "unreadable_schedule",
        sheet: scheduleSheets[0].sheet,
        message: m.scheduleRows.length
          ? `The finish schedule on ${scheduleSheets[0].sheet} is a scan the engine can't read; the run used the ${m.scheduleRows.length} rows Bids read from it. Check them against the drawing.`
          : `The finish schedule on ${scheduleSheets[0].sheet} is a scan the engine can't read, and Bids sent no rows. Rooms were not assigned finishes.`,
      });
      state.scheduleSheet ??= scheduleSheets[0].sheet;
    }
  }

  // ── batch scale pass ─────────────────────────────────────────────────────
  const measurable = state.sheets.filter((s) => {
    const role = state.fileOfSheet.get(s.sheet)?.role;
    const g = state.roles.get(s.sheet);
    return role !== "schedule" && g !== "schedule" && g !== "legend" && !dupOf.has(s.sheet);
  });
  const isElevation = (s: SheetSummary) => state.fileOfSheet.get(s.sheet)?.role === "elevations" || state.roles.get(s.sheet) === "elevation";
  for (const [i, s] of measurable.entries()) {
    ctx.progress("Reading scales", i + 1, measurable.length);
    const info = await tryStep("sheet_info", () => engine.call<{ detected_scale?: string; multiple_scales?: true; has_vector_linework: boolean; width_px: number; height_px: number }>("sheet_info", { sheet: s.sheet }), s.sheet);
    if (!info) continue;
    const quiet = isElevation(s);   // elevations: scale applied when noted, never an RFI
    if (info.detected_scale) {
      const set = await tryStep("set_scale", () => engine.call("set_scale", { sheet: s.sheet, use_detected: true }), s.sheet);
      if (set) state.scaled.add(s.sheet);
      if (set && info.multiple_scales && !quiet && !nonPlan.has(s.sheet)) state.addFinding({ kind: "multiple_scales", sheet: s.sheet, message: `${s.sheet} has more than one scale note. The title-block scale ${info.detected_scale} was applied to the main plan; check rooms inside enlarged plans or details drawn at another scale.` });
      continue;
    }
    if (quiet) continue;
    if (nonPlan.has(s.sheet)) continue;   // cover, spec, schedule and detail sheets: a scale applies when noted, never an RFI
    const nts = await findNts(engine, s.sheet);
    if (nts) {
      state.nts.add(s.sheet);
      state.addFinding({ kind: "nts_sheet", sheet: s.sheet, at: nts, rect: boxAround(nts), message: `${s.sheet} is marked NOT TO SCALE. Nothing was measured on it; ask for a scaled sheet or a key dimension.` });
      continue;
    }
    let suggestion: string | null = null;
    // vision fallback (Ryan 2026-10-18): any plan sheet with no scale text, scans and vector sheets alike (F360-26-0173 drew its scale notes as linework)
    if (deps.vision && !state.visionOff) {
      suggestion = await readScaleWithVision(engine, deps.vision, ctx, state, s.sheet, info);
    }
    if (suggestion === "NTS") {
      state.nts.add(s.sheet);
      state.addFinding({ kind: "nts_sheet", sheet: s.sheet, message: `${s.sheet} has no scale text and the AI read it as NOT TO SCALE. Nothing was measured on it; confirm on the drawing.` });
      continue;
    }
    state.addFinding({
      kind: "no_scale",
      sheet: s.sheet,
      message: suggestion
        ? `${s.sheet} has no scale text the engine could read; the AI read the note as "${suggestion}" (not applied). Confirm it in Scale review before measuring.`
        : `${s.sheet} has no scale note the engine could read. Left unscaled; set the scale by hand or ask for a scaled sheet.`
    });
  }

  // ── rooms from the schedule ──────────────────────────────────────────────
  // dismissed rows never count (Phase 2 answer 2), even if Bids sends them
  const rows = m.scheduleRows.filter((r) => (r.status ?? "").toLowerCase() !== "dismissed");
  const roomToTag = new Map<string, string>();
  for (const r of rows) {
    if (classifyRow(r) !== "floor") continue;
    for (const room of r.rooms ?? []) {
      const k = normTag(room);
      const prev = roomToTag.get(k);
      if (prev && normTag(prev) !== normTag(r.finishTag)) {
        state.addFinding({ kind: "conflicting_finishes", tag: room, sheet: state.scheduleSheet, detail: `Bids lists room ${room} under both ${prev} and ${r.finishTag}.`, message: `Room ${room} is listed under two floor finishes (${prev} and ${r.finishTag}). It was not assigned; ask which finish applies.` });
        roomToTag.set(k, "");
      } else if (prev === undefined) {
        roomToTag.set(k, r.finishTag);
      }
    }
  }
  const roomSheets = measurable.filter((s) => state.scaled.has(s.sheet) && !isElevation(s) && !nonPlan.has(s.sheet) && (state.roles.size === 0 || ["plan", "unknown"].includes(state.roles.get(s.sheet) ?? "unknown")));
  if (roomSheets.length && (roomFinish || roomToTag.size)) {
    await tryStep("propose_takeoff", () => engine.call("propose_takeoff", {
      label: `AI auto-takeoff draft · ${m.bidNumber}`,
      rationale: roomFinish
        ? `Rooms detected on the plans and assigned from the room-finish schedule on ${state.scheduleSheet}. Pending estimator review.`
        : "Rooms detected on the plans and assigned from the finish-schedule rows in Bids. Pending estimator review.",
    }));
  }
  if (roomSheets.length && !roomFinish && !roomToTag.size) {
    state.addFinding({ kind: "no_room_finish_schedule", sheet: state.scheduleSheet, message: "The set has no room-finish schedule the engine could read, and the Bids rows don't name rooms, so no rooms were assigned finishes. Assign them in the canvas." });
  }
  for (const [i, s] of roomSheets.entries()) {
    ctx.progress("Finding rooms", i + 1, roomSheets.length);
    if (roomFinish) {
      const r = await tryStep("detect_rooms", () => engine.call<{ rooms: { label: string; shape_id?: string; condition?: string; confidence?: number; raster_traced?: true }[]; unresolved?: { label: string; reason: string; seed: Point }[] }>("detect_rooms", { sheet: s.sheet, assign_from_schedule: true }), s.sheet);
      if (!r) continue;
      for (const room of r.rooms) {
        if (room.shape_id && room.condition) state.rooms.push({ shapeId: room.shape_id, sheet: s.sheet, label: room.label, condition: room.condition, confidence: room.confidence, raster: room.raster_traced === true, fromSchedule: true });
      }
      for (const u of r.unresolved ?? []) {
        if (/ambiguous/i.test(u.reason)) {
          state.addFinding({ kind: "conflicting_finishes", sheet: s.sheet, tag: u.label, at: u.seed, rect: boxAround(u.seed), detail: `For room ${u.label} the room finish schedule reads: ${u.reason}.`, message: `Room ${u.label} on ${s.sheet}: the schedule gives more than one floor finish (${u.reason}). Not measured under a guess; ask which applies.` });
        } else if (/no\s+(schedule\s+)?row|not\s+in\s+the\s+schedule|no room-finish row/i.test(u.reason)) {
          state.addFinding({ kind: "room_no_schedule_row", sheet: s.sheet, tag: u.label, at: u.seed, rect: boxAround(u.seed), message: `Room ${u.label} on ${s.sheet} has no row in the room-finish schedule. Not measured under a guess; ask for its finish.` });
        } else {
          state.addFinding({ kind: "room_no_floor_finish", sheet: s.sheet, tag: u.label, at: u.seed, rect: boxAround(u.seed), message: `Room ${u.label} on ${s.sheet}: ${u.reason}. Left for the estimator.` });
        }
      }
    } else {
      const r = await tryStep("detect_rooms", () => engine.call<{ rooms: { label: string; verts?: Point[]; confidence?: number; raster_traced?: true }[] }>("detect_rooms", { sheet: s.sheet, return_verts: true }), s.sheet);
      if (!r) continue;
      for (const room of r.rooms) {
        const tag = roomToTag.get(normTag(room.label));
        if (tag === "") continue;   // conflicting rows, already reported
        if (!tag) {
          const c = room.verts?.length ? centroid(room.verts) : undefined;
          state.addFinding({ kind: "room_no_schedule_row", sheet: s.sheet, tag: room.label, ...(c ? { at: c, rect: boxAround(c) } : {}), message: `Room ${room.label} on ${s.sheet} is not on any finish-schedule row in Bids. Not measured under a guess; ask for its finish.` });
          continue;
        }
        if (!room.verts || room.verts.length < 3) continue;
        const shot = await tryStep("measure_polygon", () => engine.call<{ shape_id?: string }>("measure_polygon", { sheet: s.sheet, verts: room.verts, condition: tag }), s.sheet);
        if (!shot?.shape_id) continue;
        await tryStep("edit_shape", () => engine.call("edit_shape", { shape_id: shot.shape_id, label: room.label }), s.sheet);
        state.rooms.push({ shapeId: shot.shape_id, sheet: s.sheet, label: room.label, condition: tag, confidence: room.confidence, raster: room.raster_traced === true, fromSchedule: true });
      }
    }
  }

  // ── what the schedule rows say vs what was drawn ─────────────────────────
  ctx.progress("Checking the schedule");
  const committedTags = new Set(state.rooms.map((r) => normTag(r.condition)));
  const byTag = new Map<string, ScheduleRow[]>();
  for (const r of rows) byTag.set(normTag(r.finishTag), [...(byTag.get(normTag(r.finishTag)) ?? []), r]);
  for (const list of byTag.values()) {
    const variants = new Set(list.map((r) => `${(r.category ?? "").toLowerCase()}|${(r.product ?? "").toLowerCase()}`));
    if (variants.size > 1) {
      state.addFinding({ kind: "conflicting_finishes", tag: list[0].finishTag, sheet: state.scheduleSheet, detail: `The finish schedule describes it as ${list.map((r) => r.product || r.category || "unnamed").join(" and as ")}.`, message: `${list[0].finishTag} is called out two ways in the finish schedule (${list.map((r) => r.product || r.category || "unnamed").join(" / ")}). Ask which is current.` });
    }
  }
  const planSheets = measurable.filter((s) => !isElevation(s));
  for (const [tag, list] of byTag) {
    if (classifyRow(list[0]) !== "floor" || committedTags.has(tag)) continue;
    let hit: { sheet: string; at: Point } | null = null;
    for (const s of planSheets) {
      const r = await tryStep("find_text", () => engine.call<{ hits: { str: string; center: Point }[] }>("find_text", { sheet: s.sheet, q: tag, limit: 50 }), s.sheet);
      const h = r?.hits.find((x) => tagRe(tag).test(x.str));
      if (h) { hit = { sheet: s.sheet, at: h.center }; break; }
    }
    if (!hit) {
      state.addFinding({ kind: "schedule_row_not_drawn", tag: list[0].finishTag, sheet: state.scheduleSheet, ...(state.scheduleRegion ? { rect: state.scheduleRegion } : {}), detail: `(${list[0].product || list[0].category || "finish"})`, message: `${list[0].finishTag} (${list[0].product || list[0].category || "finish"}) is on the finish schedule but never drawn on the plans. Ask where it goes, or whether it's deleted.` });
    } else {
      state.addFinding({ kind: "tag_not_measured", tag: list[0].finishTag, sheet: hit.sheet, at: hit.at, message: `${list[0].finishTag} is tagged on ${hit.sheet} but no room was measured under it. Measure it in the canvas.` });
    }
  }

  // ── wall tile: elevations are never measured by guess ────────────────────
  const wallTileRows = rows.filter((r) => classifyRow(r) === "wall_tile");
  const elevationSheets = state.sheets.filter(isElevation);
  for (const r of wallTileRows) {
    state.addFinding({
      kind: "wall_tile_no_elevation",
      tag: r.finishTag,
      sheet: elevationSheets[0]?.sheet ?? state.scheduleSheet,
      message: m.options.includeElevations && elevationSheets.length
        ? `Wall tile ${r.finishTag}: the elevations are in the set, but there is no usable elevation measurement for it. Left for the estimator (heights and extents), not guessed.`
        : `Wall tile ${r.finishTag}: no elevation sheets were included, so it was not measured. Ask for the elevations or the tile heights.`,
    });
  }

  // ── derive base and transitions from the committed rooms ─────────────────
  const floorConds = [...new Set(state.rooms.map((r) => r.condition))];
  const baseTags = [...new Set(rows.filter((r) => classifyRow(r) === "base").map((r) => r.finishTag))];
  if (floorConds.length && baseTags.length === 1) {
    ctx.progress("Deriving base");
    let rooms = 0;
    for (const c of floorConds) {
      if (normTag(c) === normTag(baseTags[0])) continue;
      const r = await tryStep("derive_base", () => engine.call<{ committed: number }>("derive_base", { source_condition: c, condition: baseTags[0] }));
      rooms += r?.committed ?? 0;
    }
    if (rooms) state.addFinding({ kind: "base_gross_perimeter", tag: baseTags[0], message: `Base ${baseTags[0]} was derived as the full perimeter of ${rooms} room${rooms === 1 ? "" : "s"}; door openings were NOT deducted. Deduct them before pricing.` });
  } else if (floorConds.length && baseTags.length > 1) {
    state.addFinding({ kind: "base_multiple_types", message: `The schedule has ${baseTags.length} base types (${baseTags.join(", ")}); base was left for the estimator to assign per room.` });
  }
  if (floorConds.length >= 2) {
    ctx.progress("Deriving transitions");
    const transitionTags = [...new Set(rows.filter((r) => classifyRow(r) === "transition").map((r) => r.finishTag))];
    const tTag = transitionTags.length === 1 ? transitionTags[0] : "TRANSITION";
    const conds = floorConds.filter((c) => normTag(c) !== normTag(tTag)).slice(0, 12);
    let withheld = 0;
    let first: { sheet: string; at: Point } | null = null;
    for (let a = 0; a < conds.length; a++) {
      for (let b = a + 1; b < conds.length; b++) {
        const r = await tryStep("derive_transitions", () => engine.call<{ withheld: { sheet: string; at: number[] }[] }>("derive_transitions", { condition_a: conds[a], condition_b: conds[b], condition: tTag }));
        for (const w of r?.withheld ?? []) {
          withheld++;
          first ??= { sheet: w.sheet, at: [w.at[0], w.at[1]] };
        }
      }
    }
    if (withheld && first) state.addFinding({ kind: "transitions_withheld", sheet: first.sheet, at: first.at, message: `${withheld} finish change${withheld === 1 ? "" : "s"} across a wall need a threshold at the doorway; the engine can't locate doorways, so they were left for the estimator.` });
  }

  // ── the agent's verdict, on confident rooms only ─────────────────────────
  ctx.progress("Marking confident rooms");
  let low = 0;
  for (const r of state.rooms) {
    const ok = r.fromSchedule && !r.raster && typeof r.confidence === "number" && r.confidence >= deps.verdictMinConfidence;
    if (!ok) { low++; continue; }
    await tryStep("mark_verdict", () => engine.call("mark_verdict", { shape_id: r.shapeId, text: `AI draft: clean trace (${r.confidence!.toFixed(2)}), finish from schedule` }), r.sheet);
  }
  if (low) state.addFinding({ kind: "low_confidence_rooms", message: `${low} of ${state.rooms.length} measured room${state.rooms.length === 1 ? "" : "s"} did not trace cleanly enough for the AI's check mark. Review those first.` });

  // RFI drafts (PR F) go in before the exports, so the register, the marked
  // set's RFI schedule and the counts all carry them
  await (deps.beforeExport ?? draftRfis)(engine, state);

  // ── exports ──────────────────────────────────────────────────────────────
  ctx.progress("Writing the project file");
  await mkdir(ctx.outputsDir, { recursive: true });
  await mkdir(ctx.workDir, { recursive: true });
  const set = setName(m.projectName, m.bidNumber);
  const enginePayload = path.join(ctx.workDir, "annotations.engine.json");
  await engine.call("export_takeoff", { path: enginePayload, overwrite: true });
  const payload = JSON.parse(await readFile(enginePayload, "utf8")) as Record<string, unknown>;
  const outputs: string[] = [];
  const markedName = `${set} - marked set.pdf`;
  const marked = await tryStep("export_marked_pdf", () => engine.call("export_marked_pdf", { path: path.join(ctx.outputsDir, markedName), project_name: set, overwrite: true }));
  if (marked) outputs.push(markedName);
  const reportName = `${set} - takeoff report.json`;
  const report = await tryStep("export_report", () => engine.call<{ conditions?: Record<string, unknown>[] }>("export_report", { path: path.join(ctx.outputsDir, reportName), project_name: set, overwrite: true }));
  if (report) {
    outputs.push(reportName);
    const csvName = `${set} - takeoff report.csv`;
    await writeFile(path.join(ctx.outputsDir, csvName), reportCsv(report));
    outputs.push(csvName);
  }

  const shapes = Array.isArray(payload.shapes) ? payload.shapes as { measure_role?: string }[] : [];
  const counts: Counts = {
    sheets: state.sheets.length,
    rooms: shapes.filter((s) => s.measure_role === "floor_area").length,
    conditions: Array.isArray(payload.conditions) ? payload.conditions.length : 0,
    rfisDrafted: state.rfisDrafted,
  };
  const info: DraftInfo = {
    manifest: m,
    jobId: ctx.jobId,
    generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
    runnerVersion: deps.runnerVersion,
    engineVersion: engine.version(),
    counts,
    findings: state.findings,
    wallTile: wallTileRows.length > 0,
  };
  const loaded = [...new Set(state.sheets.map((s) => s.sheet.split("#")[0]))];
  const inputsHash = createHash("sha256").update(m.files.map((f) => f.sha256).sort().join("\n")).digest("hex");
  // auto-hide at import (Ryan 2026-10-18): non-plan sheets and duplicate pages go in hidden_sheets, restorable with Show hidden.
  // A sheet that carries a finding stays visible so its checklist item is never hidden.
  const findingSheets = new Set(state.findings.map((f) => f.sheet).filter((k): k is string => !!k));
  const autoHidden = [...nonPlan, ...dupOf.keys()].filter((k) => !findingSheets.has(k));
  await writeFile(path.join(ctx.outputsDir, "annotations.json"), JSON.stringify(markDraft(payload, info, [...state.nts], autoHidden)));
  await writeFile(path.join(ctx.outputsDir, "sheets.json"), JSON.stringify(sheetsManifest(m, loaded)));
  await writeFile(path.join(ctx.outputsDir, "floor360-run.json"), JSON.stringify(runRecord(info, inputsHash), null, 2));
  await writeFile(path.join(ctx.outputsDir, "findings.json"), JSON.stringify({ findings: state.findings }, null, 2));
  outputs.unshift("annotations.json", "sheets.json", "floor360-run.json", "findings.json");
  return { counts, findings: state.findings, outputs };
}

function centroid(verts: Point[]): Point {
  const n = verts.length;
  return [verts.reduce((a, v) => a + v[0], 0) / n, verts.reduce((a, v) => a + v[1], 0) / n];
}

async function findNts(engine: Engine, sheet: string): Promise<Point | null> {
  for (const q of ["NOT TO SCALE", "NTS", "N.T.S"]) {
    try {
      const r = await engine.call<{ hits: { str: string; center: Point }[] }>("find_text", { sheet, q, limit: 20 });
      const h = r.hits.find((x) => NTS_RE.test(x.str));
      if (h) return h.center;
    } catch (e) {
      if (!(e instanceof EngineToolError)) throw e;
    }
  }
  return null;
}

/** Crop the title-block corner of a scanned sheet and ask the vision model to
 *  read its scale note. A suggestion only; null when vision is unavailable. */
async function readScaleWithVision(engine: Engine, vision: Vision, ctx: RunContext, state: RunState, sheet: string, info: { width_px: number; height_px: number }): Promise<string | null> {
  const region = { x0: Math.round(info.width_px * 0.55), y0: Math.round(info.height_px * 0.6), x1: info.width_px, y1: info.height_px };
  // px budget from the requested DPI: image px are PDF pt × 2 (144 DPI)
  const px = Math.max(200, Math.min(2000, Math.round(((region.x1 - region.x0) / 2) * (ctx.manifest.options.dpi / 72))));
  let png: string;
  try {
    png = await engine.image("view_sheet", { sheet, region, px });
  } catch (e) {
    if (!(e instanceof EngineToolError)) throw e;
    state.visionOff = true;
    state.addFinding({ kind: "vision_unavailable", tag: "view_sheet", message: `Scanned sheets could not be rendered for the AI (${e.message}); their scales are left for the estimator.` });
    return null;
  }
  try {
    const answer = await vision.readScaleNote(png, {
      signal: ctx.signal,
      onState: (s) => ctx.setStatus(s === "no_memory" ? "no_memory" : s === "starting" ? "starting" : "running"),
    });
    ctx.setStatus("running");
    return answer;
  } catch (e) {
    if (e instanceof VisionUnavailable) {
      ctx.setStatus("running");
      state.visionOff = true;
      state.addFinding({ kind: "vision_unavailable", tag: "vision", message: `The AI vision model was not available (${e.message}); scales on scanned sheets are left for the estimator.` });
      return null;
    }
    throw e;
  }
}
