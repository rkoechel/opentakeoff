// Scale review (FLOOR360 phase 1): the per-sheet scale state an estimator
// confirms after a plan set is imported. PURE and pdfjs-free so the canvas
// and the tests share one set of rules.
//
// It builds on what the canvas already has, not beside it:
//   - `scales[key]` (units per px) and `scaleUnconfirmed[key] === false`
//     (the existing scale gate: set, but no person has confirmed it), both
//     already persisted in `sheets[]` as units_per_px / scale_confirmed;
//   - `detectedScales[key]`, the plan-noted scale read off the page text.
// The one new persisted fact is "this sheet is not to scale" (NTS), kept in
// the additive `nts_sheets` key of the takeoff document (sanitizeNtsSheets).

export type DetectSource = "title-block" | "page-text";
export interface Detected { upp: number; label: string; multi: boolean; source?: DetectSource }

/** confirmed: a person set or confirmed the scale. needs-confirm: a scale is
 *  set (auto-applied from the plan note) but nobody has confirmed it.
 *  detected: the plan notes a scale that was NOT applied (ambiguous).
 *  needs-scale: nothing found. nts: a person marked the sheet not to scale. */
export type ScaleState = "confirmed" | "needs-confirm" | "detected" | "needs-scale" | "nts";

export interface ScaleInputs {
  scales: Record<string, number | undefined>;
  scaleUnconfirmed: Record<string, boolean | undefined>;
  detected: Record<string, Detected | undefined>;
  nts: ReadonlySet<string> | readonly string[];
}

const hasNts = (nts: ScaleInputs["nts"], key: string): boolean =>
  Array.isArray(nts) ? nts.includes(key) : (nts as ReadonlySet<string>).has(key);

export function sheetScaleState(key: string, s: ScaleInputs): ScaleState {
  if (hasNts(s.nts, key)) return "nts";
  if (s.scales[key]) return s.scaleUnconfirmed[key] === false ? "needs-confirm" : "confirmed";
  if (s.detected[key]) return "detected";
  return "needs-scale";
}

/** 0–1 confidence in a detected scale, with the reason shown beside it.
 *  A title-block note is the plan's own statement; a lone page note is likely
 *  but could be a detail's; several different notes is ambiguous. */
export function scaleConfidence(d: Detected | null | undefined): { value: number; label: string } {
  if (!d) return { value: 0, label: "No scale note found" };
  if (d.source === "title-block") return d.multi
    ? { value: 0.7, label: "Title block (other scales on sheet)" }
    : { value: 0.9, label: "Title block" };
  return { value: 0.6, label: "Only scale note on the page" };
}

/** Auto-apply a detected scale (as UNCONFIRMED) only when it is unambiguous
 *  and the sheet has no scale yet: a title-block note with no competing
 *  notes, or the page's only note. Never overwrites a person's scale. */
export function shouldAutoApply(key: string, d: Detected | null | undefined, s: Pick<ScaleInputs, "scales" | "nts">): boolean {
  if (!d || !(d.upp > 0)) return false;
  if (s.scales[key] || hasNts(s.nts, key)) return false;
  return !d.multi;
}

export interface ScaleSummary { total: number; confirmed: number; review: number; needsScale: number; nts: number; text: string }

/** "Scales: 12 confirmed / 3 need review". NTS counts as settled (a person
 *  decided); needs-confirm, detected and needs-scale all need review. */
export function scaleSummary(keys: readonly string[], s: ScaleInputs): ScaleSummary {
  let confirmed = 0, review = 0, needsScale = 0, nts = 0;
  for (const k of keys) {
    const st = sheetScaleState(k, s);
    if (st === "confirmed") confirmed++;
    else if (st === "nts") nts++;
    else { review++; if (st === "needs-scale") needsScale++; }
  }
  const text = `Scales: ${confirmed} confirmed / ${review} need review${nts ? ` / ${nts} NTS` : ""}`;
  return { total: keys.length, confirmed, review, needsScale, nts, text };
}

/** The footer warning after a measurement lands on an unconfirmed sheet —
 *  a warning, never a block. null when there is nothing to say. */
export function measureScaleWarning(state: ScaleState, sheetLabel: string): string | null {
  if (state === "needs-confirm") return `Measured on ${sheetLabel} with an UNCONFIRMED scale (read from the plan note). Confirm it in Scale review or the scale menu — every quantity on the sheet stands on it.`;
  if (state === "nts") return `${sheetLabel} is marked NTS (not to scale) — quantities measured here are not reliable.`;
  return null;
}

/** Additive `nts_sheets` payload key: a list of sheet keys; anything else
 *  (old payloads, garbage) reads as none. */
export function sanitizeNtsSheets(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((k): k is string => typeof k === "string" && k.length > 0))];
}

/** Every page key of a set of files, in the canvas's key form
 *  (`file` for page 1, `file#n` after). */
export function pageKeys(file: string, numPages: number): string[] {
  const out: string[] = [];
  for (let n = 1; n <= Math.max(1, numPages | 0); n++) out.push(n > 1 ? `${file}#${n}` : file);
  return out;
}

export interface BatchPage<T> { key: string; text: T }
export interface BatchOpts<T> {
  /** the files to scan and how to read them */
  files: readonly string[];
  numPages: (file: string) => Promise<number>;
  readPage: (file: string, page: number) => Promise<T>;
  detect: (text: T) => Detected | null;
  /** keys already scanned this session — skipped */
  done?: ReadonlySet<string>;
  /** stop early (a newer pass started, the canvas unmounted) */
  isStale?: () => boolean;
  onResult?: (key: string, det: Detected | null, text: T) => void;
  /** hold a file open for the whole scan of its pages (the canvas's
   *  docCache.withDoc lease); default runs the scan directly */
  withFile?: (file: string, scan: () => Promise<void>) => Promise<unknown>;
}

/** Run detection over every page of every file, one page at a time (the
 *  canvas hands pages to pdf.js serially; nothing renders). A page that
 *  fails to read is reported as null and the pass goes on. Returns the
 *  detections by key, including nulls for pages with no note. */
export async function batchDetectScales<T>(o: BatchOpts<T>): Promise<Record<string, Detected | null>> {
  const out: Record<string, Detected | null> = {};
  const hold = o.withFile ?? ((_f: string, scan: () => Promise<void>) => scan());
  for (const file of o.files) {
    if (o.isStale?.()) break;
    try {
      await hold(file, async () => {
        const n = await o.numPages(file);
        for (let p = 1; p <= Math.max(1, n); p++) {
          if (o.isStale?.()) return;
          const key = p > 1 ? `${file}#${p}` : file;
          if (o.done?.has(key)) continue;
          let det: Detected | null = null;
          let text: T | undefined;
          try { text = await o.readPage(file, p); det = o.detect(text); } catch { det = null; }
          out[key] = det;
          o.onResult?.(key, det, text as T);
        }
      });
    } catch { /* a file that won't open is skipped; the rest still scan */ }
  }
  return out;
}
