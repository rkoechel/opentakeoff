// What a finished run hands to Bids, in the layout the browser's Microsoft 365
// sync already opens (web/src/lib/cloudStore.js): annotations.json and
// sheets.json go into <job folder>/.opentakeoff/, the PDFs and the marked set
// sit in the job folder. CONTRACT.md is the field contract for Bids and for
// the Draft banner / Approve gate.
import type { Counts, Finding, JobManifest } from "./types.ts";

/** The additive top-level key that marks a project file as an AI draft. */
export const DRAFT_MARKER_KEY = "floor360AutoTakeoff";

/** Checklist items the estimator signs off (Phase 1 §8); wall tile only when
 *  the schedule carries a wall-tile row. The runner writes them unchecked. */
export const CHECKLIST_ITEMS = Object.freeze([
  "scales", "schedule_mapping", "areas_rooms", "seams_transitions",
  "waste_quantities", "shop_drawings", "submittal_docs", "rfis",
]);

export interface DraftInfo {
  manifest: JobManifest;
  jobId: string;
  generatedAt: string;
  runnerVersion: string;
  engineVersion: string;
  counts: Counts;
  findings: Finding[];
  wallTile: boolean;
}

export function draftMarker(info: DraftInfo): Record<string, unknown> {
  const m = info.manifest;
  return {
    status: "draft",
    runId: m.runId,
    bidId: m.bidId,
    bidNumber: m.bidNumber,
    projectName: m.projectName,
    jobId: info.jobId,
    generatedAt: info.generatedAt,
    runnerVersion: info.runnerVersion,
    engine: { name: "opentakeoff-mcp", version: info.engineVersion },
    checklistItems: info.wallTile ? [...CHECKLIST_ITEMS, "wall_tile_elevations"] : [...CHECKLIST_ITEMS],
    checklist: {},
    counts: info.counts,
    findings: info.findings.map((f) => ({ kind: f.kind, message: f.message, ...(f.sheet ? { sheet: f.sheet } : {}), ...(f.tag ? { tag: f.tag } : {}), ...(f.rfi ? { rfi: f.rfi } : {}) })),
  };
}

/** The engine's export_takeoff payload, marked as a draft. Additive only: the
 *  engine's own keys are untouched except project_name (empty from a headless
 *  session) and nts_sheets (the browser's Scale review list). */
export function markDraft(payload: Record<string, unknown>, info: DraftInfo, ntsSheets: string[], hiddenSheets: readonly string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  if (!out.project_name) out.project_name = `${info.manifest.projectName} - ${info.manifest.bidNumber}`;
  const nts = new Set([...(Array.isArray(out.nts_sheets) ? out.nts_sheets as string[] : []), ...ntsSheets]);
  if (nts.size) out.nts_sheets = [...nts];
  const hidden = new Set([...(Array.isArray(out.hidden_sheets) ? out.hidden_sheets as string[] : []), ...hiddenSheets]);
  if (hidden.size) out.hidden_sheets = [...hidden];
  out[DRAFT_MARKER_KEY] = draftMarker(info);
  return out;
}

/** sheets.json as the browser reads it ({files: [{id, name}]}). The ids are the
 *  SharePoint driveItem ids, which exist only after Bids uploads the PDFs:
 *  the runner writes null and Bids fills each one in before saving. */
export function sheetsManifest(m: JobManifest, loadedNames: string[]): { files: { id: null; name: string; role: string; sha256: string }[] } {
  const byName = new Map(m.files.map((f) => [f.name, f]));
  return { files: loadedNames.map((name) => ({ id: null, name, role: byName.get(name)?.role ?? "plans", sha256: byName.get(name)?.sha256 ?? "" })) };
}

/** Run record for <job folder>/.opentakeoff/floor360-run.json. Bids adds its
 *  docSetHash and folder ids; inputsHash is the runner's own view of the set. */
export function runRecord(info: DraftInfo, inputsHash: string): Record<string, unknown> {
  const m = info.manifest;
  return {
    schema: "floor360.auto_takeoff_run.v1",
    runId: m.runId,
    bidId: m.bidId,
    bidNumber: m.bidNumber,
    projectName: m.projectName,
    jobId: info.jobId,
    status: "draft",
    generatedAt: info.generatedAt,
    runnerVersion: info.runnerVersion,
    engineVersion: info.engineVersion,
    inputsHash,
    files: m.files.map((f) => ({ name: f.name, role: f.role, size: f.size, sha256: f.sha256 })),
    counts: info.counts,
  };
}

const csvCell = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  // a cell starting with = + - @ would run as a formula in Excel: quote it inert
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The report's per-condition rows as CSV: every scalar column the rows carry,
 *  in first-seen order, finish_tag first. */
export function reportCsv(report: { conditions?: Record<string, unknown>[] }): string {
  const rows = Array.isArray(report.conditions) ? report.conditions : [];
  const cols: string[] = [];
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (cols.includes(k)) continue;
      if (v === null || ["string", "number", "boolean"].includes(typeof v)) cols.push(k);
    }
  }
  const order = ["finish_tag", ...cols.filter((c) => c !== "finish_tag" && c !== "id")];
  const head = order.filter((c) => c === "finish_tag" || cols.includes(c));
  return [head.map(csvCell).join(","), ...rows.map((r) => head.map((c) => csvCell(r[c])).join(","))].join("\r\n") + "\r\n";
}

export function contentTypeFor(name: string): string {
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".csv")) return "text/csv; charset=utf-8";
  return "application/json; charset=utf-8";
}

/**
 * Condition tag for rooms the AI found but could not match to a floor finish (Ryan 2026-10-18): drawn as un-accepted drafts, never in finish totals.
 */
export const FINISH_TBD_TAG = "FINISH-TBD";

/**
 * The end-of-run summary line for the AI draft checklist: what was read, scaled, hidden, drawn and asked.
 */
export function runSummary(c: { sheets: number; scaled: number; unscaled: number; hidden: number; rooms: number; tbd: number; toReview: number; rfis: number; unmatched: number }): string {
  const noOutline = c.unmatched ? `${c.unmatched} found with no outline (not drawn), ` : "";
  return `AI run summary: ${c.sheets} sheets read, ${c.scaled} scaled by the AI (unconfirmed), ${c.unscaled} left unscaled, ${c.hidden} hidden as non-plan or duplicate, ${c.rooms} drawn with finish, ${c.tbd} drawn as Finish TBD (${c.toReview} to review first), ${noOutline}${c.rfis} RFIs drafted.`
}

/**
 * Finish TBD styling (Ryan 2026-10-18): a grey that no finish palette uses, so the estimator sees the room is not priced.
 */
export const FINISH_TBD_COLOR = "#8a8f98";

/**
 * Marks the FINISH-TBD condition and its shapes with finishStatus "tbd" and the TBD color, in place. Returns the shape count.
 */
export function markFinishTbd(payload: Record<string, unknown>): number {
  const conds = Array.isArray(payload.conditions) ? payload.conditions as Record<string, unknown>[] : [];
  const ids = new Set<unknown>();
  for (const c of conds) {
    if (String(c.finish_tag ?? "").toUpperCase() === FINISH_TBD_TAG) {
      c.finishStatus = "tbd";
      c.color = FINISH_TBD_COLOR;
      c.name = "Finish TBD";
      ids.add(c.id);
    }
  }
  const shapes = Array.isArray(payload.shapes) ? payload.shapes as Record<string, unknown>[] : [];
  let n = 0;
  for (const s of shapes) {
    if (ids.has(s.condition_id)) {
      s.finishStatus = "tbd";
      n++;
    }
  }
  return n;
}

/**
 * Takes Finish TBD rows out of the report: they move to finish_tbd and their quantities leave totals, so no TBD square footage is priced.
 */
export function excludeFinishTbd(report: Record<string, unknown>): Record<string, unknown> {
  const rows = Array.isArray(report.conditions) ? report.conditions as Record<string, unknown>[] : [];
  const tbd = rows.filter((r) => String(r.finish_tag ?? "").toUpperCase() === FINISH_TBD_TAG);
  if (!tbd.length) return report;
  const out: Record<string, unknown> = { ...report, conditions: rows.filter((r) => !tbd.includes(r)), finish_tbd: tbd };
  const t = report.totals;
  if (t && typeof t === "object") {
    const totals = { ...(t as Record<string, unknown>) };
    for (const k of ["total_sf", "total_sf_net", "lf", "lf_net", "ea", "sy_net"]) {
      if (typeof totals[k] !== "number") continue;
      let v = totals[k] as number;
      for (const r of tbd) if (typeof r[k] === "number") v -= r[k] as number;
      totals[k] = Math.max(0, Math.round(v * 100) / 100);
    }
    out.totals = totals;
  }
  return out;
}
