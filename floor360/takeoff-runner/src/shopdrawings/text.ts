// Strings that land in a PDF. Brandon Text covers Latin-1; everything drawn
// is kept to that range so a room name cannot abort the set.

const ELLIPSIS = "...";

/** One line, control characters removed, capped. */
export function pdfText(value: unknown, max = 80): string {
  const raw = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (raw.length <= max) return raw;
  return raw.slice(0, Math.max(0, max - ELLIPSIS.length)) + ELLIPSIS;
}

/** 24.5 ft → 24'-6". */
export function feetInches(ft: number): string {
  if (!Number.isFinite(ft)) return "—";
  const sign = ft < 0 ? "-" : "";
  const abs = Math.abs(ft);
  let feet = Math.floor(abs + 1e-9);
  let inches = Math.round((abs - feet) * 12);
  if (inches === 12) { feet += 1; inches = 0; }
  return `${sign}${feet}'-${inches}"`;
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
