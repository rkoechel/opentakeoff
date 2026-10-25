// Tile and LVT grout lines, in image px, clipped to the room.
// The start point is a grout intersection. Brick, ashlar and running bond
// shift every other row by half a tile. Herringbone turns the tile on
// alternate rows (that row's step is the other side). Anything else is
// stacked. The sheet still prints the pattern name as given.
import type { Pt } from "./geometry.ts";
import { clipSegment } from "./hatch.ts";

export function patternBond(pattern: string): "stacked" | "half" | "herringbone" {
  const s = pattern.trim().toLowerCase();
  if (/herring/.test(s)) return "herringbone";
  if (/brick|ashlar|running|offset|half/.test(s)) return "half";
  return "stacked";
}

interface Row { y: number; h: number; step: number; shift: number }

/** Grout lines. `tileW` and `tileH` are image px. Empty when the tile is not a positive size. */
export function patternLines(poly: Pt[], start: Pt, tileW: number, tileH: number, pattern: string): [Pt, Pt][] {
  if (!(tileW > 0) || !(tileH > 0) || poly.length < 3) return [];
  const bond = patternBond(pattern);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const spec = (i: number): { h: number; step: number; shift: number } => {
    if (bond === "herringbone") {
      const turned = Math.abs(i) % 2 === 1;
      return { h: turned ? tileW : tileH, step: turned ? tileH : tileW, shift: 0 };
    }
    const odd = Math.abs(i) % 2 === 1;
    return { h: tileH, step: tileW, shift: bond === "half" && odd ? tileW / 2 : 0 };
  };

  const rows: Row[] = [];
  let y = start.y;
  for (let i = 0; y < y1 && i < 4000; i++) {
    const s = spec(i);
    rows.push({ y, ...s });
    y += s.h;
  }
  y = start.y;
  for (let i = -1; y > y0 && i > -4000; i--) {
    const s = spec(i);
    y -= s.h;
    rows.push({ y, ...s });
  }

  const out: [Pt, Pt][] = [];
  const push = (a: Pt, b: Pt) => {
    if (out.length > 8000) return;
    out.push(...clipSegment(a, b, poly));
  };
  for (const row of rows) {
    push({ x: x0, y: row.y }, { x: x1, y: row.y });
    push({ x: x0, y: row.y + row.h }, { x: x1, y: row.y + row.h });
    let x = start.x + row.shift;
    while (x > x0) x -= row.step;
    for (let i = 0; x < x1 && i < 4000; i++) {
      push({ x, y: row.y }, { x, y: row.y + row.h });
      x += row.step;
    }
  }
  return out;
}
