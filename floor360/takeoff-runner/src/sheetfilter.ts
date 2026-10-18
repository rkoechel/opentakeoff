/**
 * Which sheets the auto-takeoff skips: duplicate input pages (same rendered page) and non-plan sheets (cover, spec, schedule, detail-only). Both are hidden at import (hidden_sheets) and get no scale RFIs; the engine still reads every page, so finish schedules stay readable.
 */
/**
 * Returns the discipline and series of a sheet number, or null if the sheet number is invalid.
 * @param sheetNumber The sheet number to parse, or undefined or null.
 * @returns The discipline and series of the sheet number, or null if invalid.
 */
export function sheetSeries(sheetNumber: string | undefined | null): { discipline: string; series: number } | null {
  const m = sheetNumber?.toUpperCase().trim().match(/^([A-Z]{1,3})[-. ]?(\d)/);
  return m ? { discipline: m[1], series: Number(m[2]) } : null;
}

/**
 * Returns true if the sheet is a non-plan sheet, false otherwise.
 * @param role The role of the sheet, or undefined.
 * @param sheetNumber The sheet number, or undefined or null.
 * @returns True if the sheet is a non-plan sheet, false otherwise.
 */
export function isNonPlanSheet(role: string | undefined, sheetNumber: string | undefined | null): boolean {
  const NON_PLAN_ROLES = new Set(["schedule", "legend", "detail"]);
  if (role !== undefined && NON_PLAN_ROLES.has(role)) return true;
  if (role === "plan") return false;
  const s = sheetSeries(sheetNumber);
  if (!s) return false;
  if ([0, 2, 3, 5, 6, 9].includes(s.series)) return true;
  if (s.series === 4 && !["A", "I", "ID"].includes(s.discipline)) return true;
  return false;
}

/**
 * Returns a map of duplicate sheet numbers to their first occurrence.
 * @param sheets The sheets to check for duplicates.
 * @param hashOf A map of sheet numbers to their hashes.
 * @returns A map of duplicate sheet numbers to their first occurrence.
 */
export function duplicatePages(sheets: readonly string[], hashOf: ReadonlyMap<string, string>): Map<string, string> {
  const firstByHash = new Map<string, string>();
  const out = new Map<string, string>();
  for (const sheet of sheets) {
    const h = hashOf.get(sheet);
    if (h === undefined) continue;
    if (firstByHash.has(h)) {
      out.set(sheet, firstByHash.get(h)!);
    } else {
      firstByHash.set(h, sheet);
    }
  }
  return out;
}
