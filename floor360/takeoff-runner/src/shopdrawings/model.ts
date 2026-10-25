// Reviewed annotations + product data → the rooms each sheet draws.
// Pure: no PDF, no disk. A refusal is one sentence and no partial set.
import { parseSheetKey } from "../../../../web/src/lib/sheetKey.ts";
import { isLowConfidence, tileStart, type Pt, type StartPoint } from "./geometry.ts";
import type { RoomOverride, ShopDrawingsRequest } from "./request.ts";
import { scaleNote, scaleRefusal, type ScaleSheet } from "./scale.ts";
import { pdfText } from "./text.ts";

export class ShopDrawingsRefusal extends Error {}

export type FinishKind = "roll" | "tile" | "base" | "transition" | "floor";
export type Nap = "ew" | "ns";

export interface RoomModel {
  id: string;
  sheetId: string;
  label: string;
  finishTag: string;
  color: string;
  hatch: string;
  productName: string;
  ringPx: Pt[];
  ringFt: Pt[];
  lowConfidence: boolean;
  confidence?: number;
  openings: number[];
  nap: Nap;
  napExplicit: boolean;
  start: StartPoint;
  kind: FinishKind;
  rollWidthFt?: number;
  rollLengthFt?: number;
  seamAllowanceIn?: number;
  wallOverageIn?: number;
  doorwayOverageIn?: number;
  tileWidthIn?: number;
  tileHeightIn?: number;
  pattern?: string;
  baseLabel?: string;
}

export interface SheetModel {
  id: string;
  widthPx: number;
  heightPx: number;
  upp: number;
  scaleSource: string;
  scaleNote: string;
  rooms: RoomModel[];
}

export interface FinishLegend {
  tag: string;
  color: string;
  hatch: string;
  product: string;
}

export interface ShopModel {
  projectName: string;
  bidNumber: string;
  address: string;
  date: string;
  drawnBy: string;
  checkedBy: string;
  rev: string;
  approval: { name: string; at: string } | null;
  sheets: SheetModel[];
  finishes: FinishLegend[];
  base: { tag: string; description: string } | null;
  transitions: { between: [string, string]; type: string }[];
  warnings: string[];
}

export interface Frame {
  widthPx: number;
  heightPx: number;
}

const normTag = (t: string) => t.trim().toUpperCase();

export function parseNap(raw: string | undefined, fallback: Nap): Nap {
  const s = (raw ?? "").trim().toLowerCase().replace(/[\s_]/g, "-");
  if (s === "ns" || s === "n-s" || s === "north-south" || s === "northsouth") return "ns";
  if (s === "ew" || s === "e-w" || s === "east-west" || s === "eastwest") return "ew";
  return fallback;
}

export function finishKind(tag: string, product?: { material?: string; category?: string; rollWidthFt?: number; tileWidthIn?: number; tileHeightIn?: number }): FinishKind {
  const t = normTag(tag);
  const mat = (product?.material ?? "").toLowerCase();
  const cat = (product?.category ?? "").toLowerCase();
  if (mat === "base" || /\bbase\b/.test(cat) || /^(RB|VB|WB|CB)-?\d/.test(t)) return "base";
  if (mat === "transition" || /transition|reducer|threshold/.test(cat) || /^(TR|TS|TH)-?\d/.test(t)) return "transition";
  if ((product?.tileWidthIn ?? 0) > 0 && (product?.tileHeightIn ?? 0) > 0) return "tile";
  if ((product?.rollWidthFt ?? 0) > 0) return "roll";
  if (/^(LVT|VCT|CT|QT|TILE|POR)-?\d/.test(t) || /tile|lvt|vct/.test(mat) || /tile|lvt|vct/.test(cat)) return "tile";
  if (/^(CPT|CP|SV|RS)-?\d/.test(t) || /carpet|sheet/.test(mat) || /carpet|sheet/.test(cat)) return "roll";
  return "floor";
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function ringOf(verts: unknown, widthPx: number, heightPx: number, upp: number): { px: Pt[]; ft: Pt[] } | null {
  if (!Array.isArray(verts) || verts.length < 3) return null;
  const px: Pt[] = [];
  for (const v of verts) {
    if (!Array.isArray(v) || v.length < 2 || typeof v[0] !== "number" || typeof v[1] !== "number") return null;
    if (!Number.isFinite(v[0]) || !Number.isFinite(v[1])) return null;
    px.push({ x: v[0] * widthPx, y: v[1] * heightPx });
  }
  return { px, ft: px.map((p) => ({ x: p.x * upp, y: p.y * upp })) };
}

function overrideFor(map: Record<string, RoomOverride>, id: string, label: string): RoomOverride | undefined {
  return map[id] ?? (label ? map[label] : undefined);
}

function openingsOf(shape: Record<string, unknown>): number[] {
  const raw = shape.openings;
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is number => Number.isInteger(n) && (n as number) >= 0);
}

/**
 * Build the drawing model. `frames` supplies page size in image px when the
 * annotations (or an uploaded PDF) know it. Missing size, NTS, or an
 * unconfirmed scale refuses the set.
 */
export function buildShopModel(req: ShopDrawingsRequest, frames: Record<string, Frame>, now = new Date()): ShopModel {
  const ann = req.annotations;
  const nts = new Set(Array.isArray(ann.nts_sheets) ? (ann.nts_sheets as unknown[]).filter((s): s is string => typeof s === "string") : []);
  const hidden = new Set(Array.isArray(ann.hidden_sheets) ? (ann.hidden_sheets as unknown[]).filter((s): s is string => typeof s === "string") : []);
  const conditions = new Map<string, Record<string, unknown>>();
  for (const c of ann.conditions as unknown[]) {
    const row = asRecord(c);
    if (row && typeof row.id === "string") conditions.set(row.id, row);
  }
  const products = new Map(req.products.map((p) => [normTag(p.finishTag), p]));
  const sheetRows = (ann.sheets as unknown[]).map(asRecord).filter((s): s is Record<string, unknown> => !!s && typeof s.sheet_id === "string");
  const shapes = (ann.shapes as unknown[]).map(asRecord).filter((s): s is Record<string, unknown> => !!s);

  const scaleInputs: ScaleSheet[] = [];
  const pending: { sheet: Record<string, unknown>; rooms: Record<string, unknown>[] }[] = [];
  for (const sheet of sheetRows) {
    const id = sheet.sheet_id as string;
    if (hidden.has(id)) continue;
    const rooms = shapes.filter((s) => s.sheet_id === id && s.measure_role === "floor_area" && Array.isArray(s.verts_norm) && s.verts_norm.length >= 3);
    if (!rooms.length) continue;
    const upp = typeof sheet.units_per_px === "number" ? sheet.units_per_px : 0;
    const scaleSource = typeof sheet.scale_source === "string" ? sheet.scale_source : "";
    const scaleConfirmed = sheet.scale_confirmed === true ? true : sheet.scale_confirmed === false ? false : null;
    scaleInputs.push({ sheetId: id, upp, scaleSource, scaleConfirmed, nts: nts.has(id) || nts.has(parseSheetKey(id).file) });
    pending.push({ sheet, rooms });
  }
  if (!pending.length) throw new ShopDrawingsRefusal("Refusing shop drawings: no reviewed floor rooms to draw.");
  const refused = scaleRefusal(scaleInputs);
  if (refused) throw new ShopDrawingsRefusal(refused);

  const missingSize: string[] = [];
  const sheets: SheetModel[] = [];
  const warnings: string[] = [];
  const warned = new Set<string>();
  const finishByTag = new Map<string, FinishLegend>();

  for (const { sheet, rooms: roomShapes } of pending) {
    const id = sheet.sheet_id as string;
    const parsed = parseSheetKey(id);
    const frame = frames[id] ?? frames[parsed.file] ?? req.sheetFrames[id] ?? req.sheetFrames[parsed.file] ?? frameFromSheet(sheet);
    if (!frame) { missingSize.push(id); continue; }
    const upp = sheet.units_per_px as number;
    const scaleSource = typeof sheet.scale_source === "string" && sheet.scale_source.trim() ? sheet.scale_source : "not recorded";
    const drawn: RoomModel[] = [];
    for (const shape of roomShapes) {
      const ring = ringOf(shape.verts_norm, frame.widthPx, frame.heightPx, upp);
      if (!ring) continue;
      const cond = conditions.get(String(shape.condition_id ?? ""));
      const tag = pdfText(cond?.finish_tag ?? "FINISH", 40) || "FINISH";
      const key = normTag(tag);
      const product = products.get(key);
      const label = pdfText(shape.label ?? "", 60);
      const over = overrideFor(req.overrides, String(shape.id ?? ""), label);
      const kind = finishKind(tag, product);
      const napExplicit = Boolean(over?.nap || product?.nap);
      const nap = parseNap(over?.nap, parseNap(product?.nap, "ew"));
      const low = isLowConfidence(shape.origin);
      const color = typeof cond?.color === "string" && /^#[0-9a-fA-F]{6}$/.test(cond.color) ? cond.color : "#8a8f98";
      const hatch = typeof cond?.hatch === "string" && cond.hatch.trim() ? cond.hatch.trim() : "diag";
      const productName = pdfText(product?.product ?? tag, 60);
      const start = tileStart(ring.px, {
        ...(over?.startEdge !== undefined ? { edge: over.startEdge } : {}),
        ...(over?.startNorm ? { norm: over.startNorm, widthPx: frame.widthPx, heightPx: frame.heightPx } : {}),
      });
      const room: RoomModel = {
        id: String(shape.id ?? `${id}:${drawn.length}`),
        sheetId: id,
        label: label || tag,
        finishTag: tag,
        color, hatch, productName,
        ringPx: ring.px,
        ringFt: ring.ft,
        lowConfidence: low.low,
        ...(low.confidence !== undefined ? { confidence: low.confidence } : {}),
        openings: openingsOf(shape),
        nap, napExplicit, start, kind,
      };
      if (product?.rollWidthFt) room.rollWidthFt = product.rollWidthFt;
      if (product?.rollLengthFt) room.rollLengthFt = product.rollLengthFt;
      if (product?.seamAllowanceIn !== undefined) room.seamAllowanceIn = product.seamAllowanceIn;
      if (product?.wallOverageIn !== undefined) room.wallOverageIn = product.wallOverageIn;
      if (product?.doorwayOverageIn !== undefined) room.doorwayOverageIn = product.doorwayOverageIn;
      if (product?.tileWidthIn) room.tileWidthIn = product.tileWidthIn;
      if (product?.tileHeightIn) room.tileHeightIn = product.tileHeightIn;
      if (product?.pattern) room.pattern = product.pattern;
      if (over?.base) room.baseLabel = over.base;
      drawn.push(room);
      if (!finishByTag.has(key)) finishByTag.set(key, { tag, color, hatch, product: productName });
      if (low.low && !warned.has(`low:${room.id}`)) {
        warned.add(`low:${room.id}`);
        const conf = low.confidence !== undefined ? ` (${low.confidence.toFixed(2)})` : "";
        warnings.push(`${room.label} (${tag}) is low confidence${conf} on ${id}. Verify the outline.`);
      }
      if (kind === "roll" && !room.rollWidthFt && !warned.has(`roll:${key}`)) {
        warned.add(`roll:${key}`);
        warnings.push(`${tag} is roll goods and has no rollWidthFt, so no seam plan is drawn for it.`);
      }
      if (kind === "tile" && (!room.tileWidthIn || !room.tileHeightIn) && !warned.has(`tile:${key}`)) {
        warned.add(`tile:${key}`);
        warnings.push(`${tag} has no tile size, so the pattern plan has no grid.`);
      }
      if (kind === "tile" && !room.pattern && !warned.has(`pat:${key}`)) {
        warned.add(`pat:${key}`);
        warnings.push(`${tag} has no pattern named.`);
      }
      if (kind === "roll" && !napExplicit && !warned.has(`nap:${key}`)) {
        warned.add(`nap:${key}`);
        warnings.push(`No nap was given for ${tag}; seam plans use east-west.`);
      }
    }
    if (drawn.length) {
      sheets.push({
        id, widthPx: frame.widthPx, heightPx: frame.heightPx, upp,
        scaleSource, scaleNote: scaleNote(scaleSource, upp), rooms: drawn,
      });
    }
  }
  if (missingSize.length) {
    throw new ShopDrawingsRefusal(`Refusing shop drawings: ${missingSize.map((s) => `"${s}"`).join(", ")} ${missingSize.length === 1 ? "has" : "have"} no page size, so a check dimension can't be printed. Attach the plan PDF or sheetFrames.`);
  }
  if (!sheets.length) throw new ShopDrawingsRefusal("Refusing shop drawings: no reviewed floor rooms to draw.");
  if (!req.base && !warned.has("base")) warnings.push("No base type was given. Base lines read \"Base: type not specified\".");

  const date = req.bid.date || now.toISOString().slice(0, 10);
  const projectName = req.bid.projectName || pdfText(ann.project_name, 200) || "Project";
  const bidNumber = req.bid.bidNumber || "—";
  return {
    projectName, bidNumber,
    address: req.bid.address,
    date,
    drawnBy: req.bid.drawnBy || "—",
    checkedBy: req.bid.checkedBy || "—",
    rev: req.bid.rev || "0",
    approval: req.approval,
    sheets,
    finishes: [...finishByTag.values()],
    base: req.base,
    transitions: req.transitions,
    warnings,
  };
}

function frameFromSheet(sheet: Record<string, unknown>): Frame | null {
  const widthPx = sheet.width_px;
  const heightPx = sheet.height_px;
  if (typeof widthPx === "number" && typeof heightPx === "number" && widthPx > 0 && heightPx > 0) return { widthPx, heightPx };
  return null;
}
