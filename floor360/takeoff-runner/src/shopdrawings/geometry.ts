// Ring helpers shared by the finish, seam, pattern and base sheets.
// Coordinates are image px (y down) unless a function says feet.

export interface Pt { x: number; y: number }

export const LOW_CONFIDENCE = 0.75;

/** Rooms below this trace confidence, or flagged by the estimator, are marked on the sheet. */
export function isLowConfidence(origin: unknown): { low: boolean; confidence?: number } {
  if (!origin || typeof origin !== "object") return { low: false };
  const o = origin as Record<string, unknown>;
  if (o.low_confidence === true) return { low: true, confidence: typeof o.confidence === "number" ? o.confidence : undefined };
  if (typeof o.confidence === "number" && Number.isFinite(o.confidence) && o.confidence < LOW_CONFIDENCE) {
    return { low: true, confidence: o.confidence };
  }
  return { low: false, confidence: typeof o.confidence === "number" ? o.confidence : undefined };
}

export function ringLength(ring: Pt[]): number {
  let n = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    n += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return n;
}

export function longestEdgeIndex(ring: Pt[]): number {
  let best = 0;
  let len = -1;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L > len) { len = L; best = i; }
  }
  return best;
}

export function edgeMidpoint(ring: Pt[], index: number): Pt {
  const a = ring[index]!;
  const b = ring[(index + 1) % ring.length]!;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export interface StartPoint {
  /** Image px. */
  at: Pt;
  edgeIndex: number | null;
  /** True when the request named the edge or the point. */
  fromOverride: boolean;
}

/**
 * Tile/LVT start until a doorway can be located: the center of the longest
 * wall, or the edge/point the estimator named. The sheet always labels it
 * "Start: verify at doorway center".
 */
export function tileStart(ring: Pt[], override?: { edge?: number; norm?: [number, number]; widthPx?: number; heightPx?: number }): StartPoint {
  if (override?.norm && override.widthPx && override.heightPx) {
    return {
      at: { x: override.norm[0] * override.widthPx, y: override.norm[1] * override.heightPx },
      edgeIndex: null,
      fromOverride: true,
    };
  }
  const edge = override?.edge;
  const index = Number.isInteger(edge) && (edge as number) >= 0 && (edge as number) < ring.length
    ? (edge as number)
    : longestEdgeIndex(ring);
  return { at: edgeMidpoint(ring, index), edgeIndex: index, fromOverride: Number.isInteger(edge) };
}

export function centroid(ring: Pt[]): Pt {
  let x = 0, y = 0;
  for (const p of ring) { x += p.x; y += p.y; }
  return { x: x / ring.length, y: y / ring.length };
}

export function shoelace(ring: Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!, q = ring[(i + 1) % ring.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

export interface CheckEdge {
  a: Pt;
  b: Pt;
  lengthFt: number;
  roomLabel: string;
}

/** Longest edge of the largest room, in feet, for the on-sheet check dimension. */
export function checkEdge(rooms: { label: string; ringFt: Pt[] }[]): CheckEdge | null {
  let best: { label: string; ring: Pt[]; area: number } | null = null;
  for (const room of rooms) {
    if (room.ringFt.length < 2) continue;
    const area = shoelace(room.ringFt);
    if (!best || area > best.area) best = { label: room.label, ring: room.ringFt, area };
  }
  if (!best) return null;
  const i = longestEdgeIndex(best.ring);
  const a = best.ring[i]!;
  const b = best.ring[(i + 1) % best.ring.length]!;
  return { a, b, lengthFt: Math.hypot(b.x - a.x, b.y - a.y), roomLabel: best.label };
}

/** Perimeter in feet, skipping edge indexes listed as openings. */
export function perimeterFt(ring: Pt[], openings: readonly number[] = []): number {
  const skip = new Set(openings);
  let n = 0;
  for (let i = 0; i < ring.length; i++) {
    if (skip.has(i)) continue;
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    n += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return n;
}
