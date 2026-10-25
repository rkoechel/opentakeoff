// Print hatches. Line families match markedset.js HATCH_FAMILIES (the canvas
// pattern's geometric read, pitched for paper). Solid is a fill only.
// Decorative tiles that markedset draws from segments fall back to diag so a
// finish still reads as hatched; the legend names the stored hatch id.
import type { Pt } from "./geometry.ts";

const FAMILIES: Record<string, [number, number][]> = {
  diag: [[45, 14]], diag2: [[135, 14]], cross: [[45, 14], [135, 14]],
  diagdense: [[45, 7]], horiz: [[0, 10]], vert: [[90, 10]],
  grid: [[0, 10], [90, 10]], brick: [[0, 10]], plank: [[0, 10]],
  herring: [[45, 14], [135, 14]], basket: [[0, 10], [90, 10]],
  checker: [[45, 7]], wave: [[0, 10]], dots: [[45, 20]], speckle: [[45, 20]],
};

export function pointInPoly(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!, pj = poly[j]!;
    if ((pi.y > y) !== (pj.y > y) && x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x) inside = !inside;
  }
  return inside;
}

function clipSeg(ax: number, ay: number, bx: number, by: number, poly: Pt[]): [Pt, Pt][] {
  const ts = [0, 1];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const p = poly[j]!, q = poly[i]!;
    const rx = bx - ax, ry = by - ay, sx = q.x - p.x, sy = q.y - p.y;
    const den = rx * sy - ry * sx;
    if (!den) continue;
    const t = ((p.x - ax) * sy - (p.y - ay) * sx) / den;
    const u = ((p.x - ax) * ry - (p.y - ay) * rx) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
  }
  ts.sort((a, b) => a - b);
  const out: [Pt, Pt][] = [];
  for (let k = 0; k + 1 < ts.length; k++) {
    const t0 = ts[k]!, t1 = ts[k + 1]!;
    if (t1 - t0 < 1e-6) continue;
    const mx = ax + ((t0 + t1) / 2) * (bx - ax);
    const my = ay + ((t0 + t1) / 2) * (by - ay);
    if (pointInPoly(mx, my, poly)) {
      out.push([
        { x: ax + t0 * (bx - ax), y: ay + t0 * (by - ay) },
        { x: ax + t1 * (bx - ax), y: ay + t1 * (by - ay) },
      ]);
    }
  }
  return out;
}

/** Hatch segments in the same space as `poly` (image px or PDF pt). */
export function hatchSegments(poly: Pt[], style: string): [Pt, Pt][] {
  if (!poly.length || style === "solid") return [];
  const fams = FAMILIES[style] ?? FAMILIES.diag!;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const corners = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const out: [Pt, Pt][] = [];
  for (const [deg, pitch] of fams) {
    const th = (deg * Math.PI) / 180;
    const ux = Math.cos(th), uy = Math.sin(th), nx = -uy, ny = ux;
    let d0 = Infinity, d1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    for (const c of corners) {
      const d = c.x * nx + c.y * ny, t = c.x * ux + c.y * uy;
      d0 = Math.min(d0, d); d1 = Math.max(d1, d);
      t0 = Math.min(t0, t); t1 = Math.max(t1, t);
    }
    for (let d = d0 + pitch / 2; d < d1; d += pitch) {
      out.push(...clipSeg(nx * d + ux * t0, ny * d + uy * t0, nx * d + ux * t1, ny * d + uy * t1, poly));
    }
  }
  return out;
}
