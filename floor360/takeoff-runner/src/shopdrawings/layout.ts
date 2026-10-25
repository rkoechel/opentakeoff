// Seam strips, base edges and transitions for one sheet.
// Roll math is rollgoods.js (the same layout the takeoff uses). A room's nap
// is passed as that room's direction, so one override does not flip the
// others. Transitions are deriveTransitionRuns: a gap of an inch or less is
// a committed butt; anything wider that is still adjacent is a doorway to verify.
// The first version draws that whole adjacent run. It does not locate the
// opening along the run.
import { clipRingToLaneSlab, computeRollLayout, rollCutNumbers, seamLfBySrc } from "../../../../web/src/lib/rollgoods.js";
import { stripLenFt, stripWidthFt } from "../../../../web/src/lib/rollTakeoff.js";
import { deriveTransitionRuns, type SheetFrame, type TransitionSourceShape } from "../../../../web/src/lib/transitions.ts";
import { perimeterFt, type Pt } from "./geometry.ts";
import type { RoomModel, SheetModel, ShopModel } from "./model.ts";
import type { TransitionType } from "./request.ts";
import { round2 } from "./text.ts";

/** Same allowances as defaultRollSetup in rollgoods.js when the request omits them. */
export const ROLL_DEFAULTS = { seamAllowanceIn: 2, wallOverageIn: 3, doorwayOverageIn: 1 };

interface Strip {
  id: string;
  srcId: string;
  laneIndex: number;
  laneCount: number;
  laneAxis: "x" | "y";
  coverMin: number;
  coverMax: number;
  runMin: number;
  runMax: number;
  minOverageFt: number;
  maxOverageFt: number;
}

export interface RollCut {
  num: number;
  lenFt: number;
  widthFt: number;
  /** In-room coverage, image px. */
  ringPx: Pt[];
}

export interface RoomRoll {
  roomId: string;
  label: string;
  tag: string;
  nap: "ew" | "ns";
  seamLf: number;
  cuts: RollCut[];
  /** Seam between two lanes, image px. */
  seams: [Pt, Pt][];
  /** Nap arrow, image px, tip toward the named direction. */
  arrow: [Pt, Pt];
}

export interface BaseRun {
  roomId: string;
  label: string;
  a: Pt;
  b: Pt;
}

export interface TransitionMark {
  /** T-1… for a committed butt. Empty for a doorway question. */
  id: string;
  kind: "butt" | "doorway";
  between: [string, string];
  /** Requested type, or "butt — type not specified", or "TBD – verify". */
  type: string;
  lengthLf: number;
  pathPx: Pt[];
}

function ftToPx(p: { x: number; y: number }, upp: number): Pt {
  return { x: p.x / upp, y: p.y / upp };
}

function rollOf(room: RoomModel, upp: number): RoomRoll | null {
  if (room.kind !== "roll" || !(room.rollWidthFt && room.rollWidthFt > 0) || !(upp > 0)) return null;
  const layout = computeRollLayout(
    [{
      id: room.id,
      name: room.label,
      ring: room.ringFt,
      hasDoorAtEdge: (edge: number) => room.openings.includes(edge),
    }],
    {
      rollWidthFt: room.rollWidthFt,
      rollLengthFt: room.rollLengthFt ?? 0,
      seamAllowanceIn: room.seamAllowanceIn ?? ROLL_DEFAULTS.seamAllowanceIn,
      wallOverageIn: room.wallOverageIn ?? ROLL_DEFAULTS.wallOverageIn,
      doorwayOverageIn: room.doorwayOverageIn ?? ROLL_DEFAULTS.doorwayOverageIn,
      direction: room.nap,
    },
  ) as { strips: Strip[] };
  const strips = layout.strips ?? [];
  const nums = rollCutNumbers(strips) as Map<string, number>;
  const seamByRoom = seamLfBySrc(strips) as Map<string, number>;
  const cuts: RollCut[] = strips.map((strip) => {
    const slab = clipRingToLaneSlab(room.ringFt, strip.laneAxis, strip.coverMin, strip.coverMax) as { x: number; y: number }[];
    const ringPx = (slab.length >= 3 ? slab : []).map((p) => ftToPx(p, upp));
    return {
      num: nums.get(strip.id) ?? strip.laneIndex + 1,
      lenFt: stripLenFt(strip) as number,
      widthFt: stripWidthFt(strip) as number,
      ringPx,
    };
  });
  const seams: [Pt, Pt][] = [];
  const ordered = [...strips].sort((a, b) => a.laneIndex - b.laneIndex);
  for (let i = 0; i + 1 < ordered.length; i++) {
    const a = ordered[i]!;
    const b = ordered[i + 1]!;
    if (b.laneIndex !== a.laneIndex + 1) continue;
    const aLo = a.runMin + (a.minOverageFt || 0);
    const aHi = a.runMax - (a.maxOverageFt || 0);
    const bLo = b.runMin + (b.minOverageFt || 0);
    const bHi = b.runMax - (b.maxOverageFt || 0);
    const lo = Math.max(aLo, bLo);
    const hi = Math.min(aHi, bHi);
    if (!(hi - lo > 0)) continue;
    const at = a.coverMax;
    const seg = a.laneAxis === "y"
      ? [ftToPx({ x: lo, y: at }, upp), ftToPx({ x: hi, y: at }, upp)]
      : [ftToPx({ x: at, y: lo }, upp), ftToPx({ x: at, y: hi }, upp)];
    seams.push([seg[0]!, seg[1]!]);
  }
  const c = room.ringPx.reduce((s, p) => ({ x: s.x + p.x, y: s.y + p.y }), { x: 0, y: 0 });
  const mid = { x: c.x / room.ringPx.length, y: c.y / room.ringPx.length };
  const span = Math.max(...room.ringPx.map((p) => Math.hypot(p.x - mid.x, p.y - mid.y)), 1) * 0.35;
  const arrow: [Pt, Pt] = room.nap === "ns"
    ? [{ x: mid.x, y: mid.y + span / 2 }, { x: mid.x, y: mid.y - span / 2 }]
    : [{ x: mid.x - span / 2, y: mid.y }, { x: mid.x + span / 2, y: mid.y }];
  return {
    roomId: room.id,
    label: room.label,
    tag: room.finishTag,
    nap: room.nap,
    seamLf: round2(seamByRoom.get(room.id) ?? 0),
    cuts: cuts.sort((a, b) => a.num - b.num),
    seams,
    arrow,
  };
}

export function sheetRolls(sheet: SheetModel): RoomRoll[] {
  return sheet.rooms.map((room) => rollOf(room, sheet.upp)).filter((r): r is RoomRoll => !!r);
}

export function baseLabel(model: ShopModel, room: RoomModel): string {
  if (room.baseLabel) return room.baseLabel;
  if (model.base) return [model.base.tag, model.base.description].filter(Boolean).join(" ");
  return "Base: type not specified";
}

export function baseRuns(model: ShopModel, sheet: SheetModel): { runs: BaseRun[]; openingsStated: boolean } {
  const runs: BaseRun[] = [];
  let openingsStated = false;
  for (const room of sheet.rooms) {
    if (room.openings.length) openingsStated = true;
    const skip = new Set(room.openings);
    const label = baseLabel(model, room);
    for (let i = 0; i < room.ringPx.length; i++) {
      if (skip.has(i)) continue;
      runs.push({
        roomId: room.id,
        label,
        a: room.ringPx[i]!,
        b: room.ringPx[(i + 1) % room.ringPx.length]!,
      });
    }
  }
  return { runs, openingsStated };
}

export function basePerimeterFt(sheet: SheetModel): number {
  return round2(sheet.rooms.reduce((n, room) => n + perimeterFt(room.ringFt, room.openings), 0));
}

function typeFor(between: [string, string], specs: TransitionType[]): string | undefined {
  const a = between[0].toUpperCase();
  const b = between[1].toUpperCase();
  return specs.find((t) => {
    const x = t.between[0].toUpperCase();
    const y = t.between[1].toUpperCase();
    return (x === a && y === b) || (x === b && y === a);
  })?.type;
}

export function sheetTransitions(model: ShopModel, sheet: SheetModel): TransitionMark[] {
  const tags = [...new Set(sheet.rooms.map((r) => r.finishTag))];
  const shapesOf = (tag: string): TransitionSourceShape[] => sheet.rooms.filter((r) => r.finishTag === tag).map((r) => ({
    id: r.id,
    sheet_id: sheet.id,
    verts_norm: r.ringPx.map((p) => [p.x / sheet.widthPx, p.y / sheet.heightPx] as [number, number]),
  }));
  const frames = new Map<string, SheetFrame>([[sheet.id, { widthPx: sheet.widthPx, heightPx: sheet.heightPx, upp: sheet.upp }]]);
  const marks: TransitionMark[] = [];
  let n = 0;
  for (let i = 0; i < tags.length; i++) {
    for (let j = i + 1; j < tags.length; j++) {
      const a = tags[i]!;
      const b = tags[j]!;
      const derived = deriveTransitionRuns(
        { tag: a, shapes: shapesOf(a) },
        { tag: b, shapes: shapesOf(b) },
        frames,
      );
      for (const run of derived.runs) {
        n += 1;
        const requested = typeFor(run.between, model.transitions);
        marks.push({
          id: `T-${n}`,
          kind: "butt",
          between: run.between,
          type: requested || "butt — type not specified",
          lengthLf: run.length_lf,
          pathPx: run.verts_norm.map(([x, y]) => ({ x: x * sheet.widthPx, y: y * sheet.heightPx })),
        });
      }
      for (const run of derived.withheld) {
        const requested = typeFor(run.between, model.transitions);
        marks.push({
          id: "",
          kind: "doorway",
          between: run.between,
          type: requested ? `TBD \u2013 verify — ${requested}` : "TBD \u2013 verify",
          lengthLf: run.length_lf,
          pathPx: run.verts_norm.map(([x, y]) => ({ x: x * sheet.widthPx, y: y * sheet.heightPx })),
        });
      }
    }
  }
  return marks;
}
