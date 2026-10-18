// The job model and the manifest Bids posts (POST /jobs). Validation is strict
// and every refusal is one plain sentence Bids can show on the bid.
import { LIMITS } from "./config.ts";

export type JobStatus = "queued" | "starting" | "running" | "no_memory" | "done" | "failed" | "cancelled";
export const FINISHED: ReadonlySet<JobStatus> = new Set(["done", "failed", "cancelled"]);
export type FileRole = "plans" | "schedule" | "elevations" | "addendum";
const ROLES: readonly FileRole[] = ["plans", "schedule", "elevations", "addendum"];

export interface ManifestFile {
  fileId: string;
  name: string;
  size: number;
  sha256: string;
  role: FileRole;
}

/** One proposed/accepted finish-schedule row from Bids (#118). Only finishTag
 *  is required; rooms, when Bids knows them, map room labels to this tag. */
export interface ScheduleRow {
  finishTag: string;
  category?: string;
  product?: string;
  manufacturer?: string;
  color?: string;
  status?: string;
  rooms?: string[];
}

export interface JobManifest {
  runId: string;
  bidId: string;
  bidNumber: string;
  projectName: string;
  files: ManifestFile[];
  scheduleRows: ScheduleRow[];
  options: { includeElevations: boolean; dpi: number };
}

export interface FileState extends ManifestFile {
  /** Byte ranges received so far, merged, [start, endExclusive). */
  ranges: [number, number][];
  complete: boolean;
}

export type FindingKind =
  | "no_scale"
  | "nts_sheet"
  | "multiple_scales"
  | "scale_mismatch"
  | "schedule_row_not_drawn"
  | "room_no_schedule_row"
  | "no_room_finish_match"
  | "room_no_floor_finish"
  | "conflicting_finishes"
  | "unreadable_schedule"
  | "wall_tile_no_elevation"
  | "no_room_finish_schedule"
  | "tag_not_measured"
  | "base_gross_perimeter"
  | "base_multiple_types"
  | "transitions_withheld"
  | "low_confidence_rooms"
  | "scales_unconfirmed"
  | "run_summary"
  | "vision_unavailable"
  | "step_failed";

export type Point = [number, number];

export interface Finding {
  kind: FindingKind;
  message: string;
  sheet?: string;
  tag?: string;
  /** Where to look, image px (the engine's coordinate space). */
  at?: Point;
  /** A box worth clouding, image px. */
  rect?: [Point, Point];
  /** What the documents say, quoted into the RFI question (PR F). */
  detail?: string;
  /** The RFI drafted for this finding, when one was (PR F). */
  rfi?: string;
}

export interface Counts {
  sheets: number;
  rooms: number;
  conditions: number;
  rfisDrafted: number;
}

export interface OutputEntry {
  name: string;
  size: number;
  sha256: string;
  contentType: string;
}

export interface Progress {
  step: string;
  page: number;
  pages: number;
}

export interface Job {
  id: string;
  manifest: JobManifest;
  files: FileState[];
  status: JobStatus;
  reason?: string;
  progress: Progress;
  findings: Finding[];
  counts: Counts;
  outputs: OutputEntry[];
  createdAt: string;
  startRequestedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Milliseconds spent starting/running (no_memory waits excluded). */
  activeMs: number;
}

export class ManifestError extends Error {}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA = /^[0-9a-f]{64}$/;
// SharePoint refuses these in a name (web/src/lib/msgraph/projects.js) and a
// path separator would escape the job folder.
const BAD_NAME = /["*:<>?/\\|#%\u0000-\u001f\u007f]/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function str(v: unknown, field: string, max: number, { required = true } = {}): string {
  if (v == null || v === "") {
    if (required) throw new ManifestError(`${field} is required.`);
    return "";
  }
  if (typeof v !== "string") throw new ManifestError(`${field} must be a string.`);
  const s = v.replace(/\s+/g, " ").trim();
  if (required && !s) throw new ManifestError(`${field} is required.`);
  if (s.length > max) throw new ManifestError(`${field} is longer than ${max} characters.`);
  if (CONTROL.test(s)) throw new ManifestError(`${field} contains control characters.`);
  return s;
}

/** A plan file name the job folder, the engine's sheet keys and SharePoint
 *  all accept unchanged: the name IS the sheet key ("plan.pdf", "plan.pdf#2"),
 *  so it must reach SharePoint exactly as uploaded here. */
export function checkFileName(raw: unknown): string {
  if (typeof raw !== "string") throw new ManifestError("Each file needs a name.");
  const name = raw.trim();
  if (name !== raw || !name) throw new ManifestError(`File name ${JSON.stringify(raw)} has leading or trailing spaces.`);
  if (name.length > 200) throw new ManifestError(`File name "${name.slice(0, 40)}…" is longer than 200 characters.`);
  if (BAD_NAME.test(name)) throw new ManifestError(`File name "${name}" contains a character SharePoint won't take (" * : < > ? / \\ | # %).`);
  if (name.startsWith(".") || name.startsWith("~")) throw new ManifestError(`File name "${name}" can't start with "." or "~".`);
  if (!/\.pdf$/i.test(name)) throw new ManifestError(`"${name}" is not a PDF (the name must end in .pdf).`);
  return name;
}

function parseRow(v: unknown, i: number): ScheduleRow {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ManifestError(`scheduleRows[${i}] must be an object.`);
  const r = v as Record<string, unknown>;
  const row: ScheduleRow = { finishTag: str(r.finishTag, `scheduleRows[${i}].finishTag`, 40) };
  for (const k of ["category", "product", "manufacturer", "color", "status"] as const) {
    const s = str(r[k], `scheduleRows[${i}].${k}`, 200, { required: false });
    if (s) row[k] = s;
  }
  if (r.rooms != null) {
    if (!Array.isArray(r.rooms) || r.rooms.length > 500) throw new ManifestError(`scheduleRows[${i}].rooms must be a list of at most 500 room labels.`);
    const rooms = r.rooms.map((x, j) => str(x, `scheduleRows[${i}].rooms[${j}]`, 40));
    if (rooms.length) row.rooms = [...new Set(rooms)];
  }
  return row;
}

/** Validate POST /jobs. Throws ManifestError with a plain sentence. Size
 *  limits are NOT refused here: an over-limit job is created already failed,
 *  so Bids shows the reason the same way as every other failure. */
export function parseManifest(body: unknown, defaultDpi: number): JobManifest {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ManifestError("Send a JSON job manifest.");
  const b = body as Record<string, unknown>;
  const runId = str(b.runId, "runId", 100);
  const bidId = str(b.bidId, "bidId", 100);
  if (!ID.test(runId)) throw new ManifestError("runId may use letters, digits, '.', '_', ':' and '-' only.");
  if (!ID.test(bidId)) throw new ManifestError("bidId may use letters, digits, '.', '_', ':' and '-' only.");
  const bidNumber = str(b.bidNumber, "bidNumber", 40);
  const projectName = str(b.projectName, "projectName", 200);
  if (!Array.isArray(b.files) || b.files.length === 0) throw new ManifestError("files must list at least one PDF.");
  if (b.files.length > LIMITS.maxFiles) throw new ManifestError(`At most ${LIMITS.maxFiles} files per job.`);
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const files: ManifestFile[] = b.files.map((f: unknown, i: number) => {
    if (!f || typeof f !== "object" || Array.isArray(f)) throw new ManifestError(`files[${i}] must be an object.`);
    const o = f as Record<string, unknown>;
    if (typeof o.fileId !== "string" || !FILE_ID.test(o.fileId)) throw new ManifestError(`files[${i}].fileId may use letters, digits, '.', '_' and '-' only.`);
    const name = checkFileName(o.name);
    if (!Number.isSafeInteger(o.size) || (o.size as number) < 1) throw new ManifestError(`"${name}" needs its size in bytes.`);
    const sha256 = typeof o.sha256 === "string" ? o.sha256.toLowerCase() : "";
    if (!SHA.test(sha256)) throw new ManifestError(`"${name}" needs its sha256 (64 hex characters).`);
    if (!ROLES.includes(o.role as FileRole)) throw new ManifestError(`"${name}" role must be one of ${ROLES.join(", ")}.`);
    if (seenIds.has(o.fileId)) throw new ManifestError(`fileId "${o.fileId}" appears twice.`);
    if (seenNames.has(name.toLowerCase())) throw new ManifestError(`"${name}" appears twice.`);
    seenIds.add(o.fileId);
    seenNames.add(name.toLowerCase());
    return { fileId: o.fileId, name, size: o.size as number, sha256, role: o.role as FileRole };
  });
  const rowsIn = b.scheduleRows ?? [];
  if (!Array.isArray(rowsIn) || rowsIn.length > 500) throw new ManifestError("scheduleRows must be a list of at most 500 rows.");
  const scheduleRows = rowsIn.map(parseRow);
  const o = (b.options && typeof b.options === "object" && !Array.isArray(b.options) ? b.options : {}) as Record<string, unknown>;
  if (o.includeElevations != null && typeof o.includeElevations !== "boolean") throw new ManifestError("options.includeElevations must be true or false.");
  let dpi = defaultDpi;
  if (o.dpi != null) {
    if (!Number.isInteger(o.dpi) || (o.dpi as number) < 72 || (o.dpi as number) > 300) throw new ManifestError("options.dpi must be a whole number from 72 to 300.");
    dpi = o.dpi as number;
  }
  return { runId, bidId, bidNumber, projectName, files, scheduleRows, options: { includeElevations: o.includeElevations === true, dpi } };
}

const mb = (n: number) => `${Math.ceil(n / (1024 * 1024))} MB`;

/** The plain reason an over-limit manifest fails with, or null. */
export function manifestLimitReason(m: JobManifest): string | null {
  const big = m.files.find((f) => f.size > LIMITS.maxFileBytes);
  if (big) return `"${big.name}" is ${mb(big.size)}; files over 250 MB can't be auto-taken off. Run this takeoff by hand.`;
  const total = m.files.reduce((n, f) => n + f.size, 0);
  if (total > LIMITS.maxJobBytes) return `Too large for auto-takeoff (${mb(total)} of documents, limit 600 MB). Run it by hand.`;
  return null;
}

/** "<project name> - <bid number>" with the characters SharePoint rejects
 *  removed; the project name is trimmed to keep the whole name ≤ 120
 *  characters, the bid number never is (Phase 2 §5). */
export function setName(projectName: string, bidNumber: string): string {
  const clean = (s: string) => s.replace(/["*:<>?/\\|#%\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  const bid = clean(bidNumber).replace(/^[.\s]+|[.\s]+$/g, "");
  const room = Math.max(1, 120 - bid.length - 3);
  const project = clean(projectName).slice(0, room).replace(/^[.\s]+|[.\s]+$/g, "");
  return [project, bid].filter(Boolean).join(" - ") || "takeoff";
}
