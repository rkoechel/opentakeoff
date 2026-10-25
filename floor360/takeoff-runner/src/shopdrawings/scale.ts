// A wrong scale makes every length on the sheet wrong. Shop drawings refuse
// the whole set when any room-bearing sheet is NTS, explicitly unconfirmed,
// or has no units-per-pixel. An absent scale_confirmed is the pre-flag
// reading (confirmed). The source string is still printed on the sheet.
import { RENDER_SCALE } from "../../../../web/src/lib/takeoffConstants.ts";

const NTS = /(^|[^A-Z])(N\.?\s?T\.?\s?S\.?|NOT\s+TO\s+SCALE)($|[^A-Z])/i;

export interface ScaleSheet {
  sheetId: string;
  upp: number;
  scaleSource: string;
  /** null = the key was absent. */
  scaleConfirmed: boolean | null;
  nts: boolean;
}

export function scaleRefusal(sheets: ScaleSheet[]): string | null {
  const problems: string[] = [];
  for (const s of sheets) {
    if (s.nts || NTS.test(s.scaleSource) || /unconfirmed/i.test(s.scaleSource)) {
      problems.push(`"${s.sheetId}" is NTS or unconfirmed`);
    } else if (s.scaleConfirmed === false) {
      problems.push(`"${s.sheetId}" has an unconfirmed scale`);
    } else if (!(s.upp > 0)) {
      problems.push(`"${s.sheetId}" has no scale`);
    }
  }
  if (!problems.length) return null;
  return `Refusing shop drawings: ${problems.join("; ")}. Confirm a scale on every sheet before generating.`;
}

/** Architectural label of the SOURCE sheet, from feet per image px. */
export function sourceScaleLabel(upp: number): string {
  if (!(upp > 0)) return "no scale";
  const ftPerIn = upp * RENDER_SCALE * 72;
  const arch: [number, string][] = [
    [1 / 32, '1/32" = 1\'-0"'],
    [1 / 16, '1/16" = 1\'-0"'],
    [3 / 32, '3/32" = 1\'-0"'],
    [1 / 8, '1/8" = 1\'-0"'],
    [3 / 16, '3/16" = 1\'-0"'],
    [1 / 4, '1/4" = 1\'-0"'],
    [3 / 8, '3/8" = 1\'-0"'],
    [1 / 2, '1/2" = 1\'-0"'],
    [3 / 4, '3/4" = 1\'-0"'],
    [1, '1" = 1\'-0"'],
    [1.5, '1-1/2" = 1\'-0"'],
    [3, '3" = 1\'-0"'],
    [6, '6" = 1\'-0"'],
  ];
  for (const [paperInPerFt, label] of arch) {
    const expected = 1 / paperInPerFt;
    if (Math.abs(ftPerIn - expected) / expected < 0.02) return label;
  }
  for (const n of [10, 20, 30, 40, 50, 60, 100]) {
    if (Math.abs(ftPerIn - n) / n < 0.02) return `1" = ${n}'`;
  }
  return `${(Math.round(ftPerIn * 100) / 100).toLocaleString("en-US")} ft per inch`;
}

export function scaleNote(source: string, upp: number): string {
  const src = source.trim() || "not recorded";
  return `Scale source: ${src} · ${sourceScaleLabel(upp)} · plotted to fit`;
}
