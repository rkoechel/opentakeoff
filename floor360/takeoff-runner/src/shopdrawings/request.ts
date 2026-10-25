// POST /jobs/:id/shop-drawings body. A bad body is a 400 with one sentence.
// Scale refusals are not 400s: the body is valid, and the job fails when it runs.
import { TAKEOFF_SCHEMA } from "../../../../web/src/lib/takeoffConstants.ts";

export class ShopDrawingsError extends Error {}

const CONTROL = /[\u0000-\u001f\u007f]/;

function str(v: unknown, field: string, max: number, required: boolean): string {
  if (v == null || v === "") {
    if (required) throw new ShopDrawingsError(`${field} is required.`);
    return "";
  }
  if (typeof v !== "string") throw new ShopDrawingsError(`${field} must be a string.`);
  const s = v.replace(/\s+/g, " ").trim();
  if (required && !s) throw new ShopDrawingsError(`${field} is required.`);
  if (s.length > max) throw new ShopDrawingsError(`${field} is longer than ${max} characters.`);
  if (CONTROL.test(s)) throw new ShopDrawingsError(`${field} contains control characters.`);
  return s;
}

function num(v: unknown, field: string, { min = 0, max = 1e6 } = {}): number | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw new ShopDrawingsError(`${field} must be a number from ${min} to ${max}.`);
  }
  return v;
}

function obj(v: unknown, field: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ShopDrawingsError(`${field} must be an object.`);
  return v as Record<string, unknown>;
}

export interface ProductInput {
  finishTag: string;
  rollWidthFt?: number;
  rollLengthFt?: number;
  tileWidthIn?: number;
  tileHeightIn?: number;
  pattern?: string;
  nap?: string;
  material?: string;
  category?: string;
  product?: string;
  seamAllowanceIn?: number;
  wallOverageIn?: number;
  doorwayOverageIn?: number;
}

export interface RoomOverride {
  nap?: string;
  /** Edge index on the room ring. */
  startEdge?: number;
  /** Normalized sheet point, used instead of an edge. */
  startNorm?: [number, number];
  base?: string;
}

export interface BidMeta {
  projectName: string;
  bidNumber: string;
  address: string;
  date: string;
  drawnBy: string;
  checkedBy: string;
  rev: string;
}

export interface ApprovalStamp {
  name: string;
  at: string;
}

export interface TransitionType {
  between: [string, string];
  type: string;
}

export interface BaseSpec {
  tag: string;
  description: string;
}

export interface SheetFrameInput {
  widthPx: number;
  heightPx: number;
}

export interface ShopDrawingsRequest {
  annotations: Record<string, unknown>;
  products: ProductInput[];
  overrides: Record<string, RoomOverride>;
  bid: BidMeta;
  approval: ApprovalStamp | null;
  sheetFrames: Record<string, SheetFrameInput>;
  base: BaseSpec | null;
  transitions: TransitionType[];
}

function parseProduct(v: unknown, i: number): ProductInput {
  const r = obj(v, `products[${i}]`);
  const row: ProductInput = { finishTag: str(r.finishTag, `products[${i}].finishTag`, 40, true) };
  const rollWidthFt = num(r.rollWidthFt, `products[${i}].rollWidthFt`, { min: 0.5, max: 50 });
  const rollLengthFt = num(r.rollLengthFt, `products[${i}].rollLengthFt`, { min: 0, max: 1000 });
  const tileWidthIn = num(r.tileWidthIn, `products[${i}].tileWidthIn`, { min: 0.5, max: 96 });
  const tileHeightIn = num(r.tileHeightIn, `products[${i}].tileHeightIn`, { min: 0.5, max: 96 });
  if (rollWidthFt !== undefined) row.rollWidthFt = rollWidthFt;
  if (rollLengthFt !== undefined) row.rollLengthFt = rollLengthFt;
  if (tileWidthIn !== undefined) row.tileWidthIn = tileWidthIn;
  if (tileHeightIn !== undefined) row.tileHeightIn = tileHeightIn;
  for (const k of ["pattern", "nap", "material", "category", "product"] as const) {
    const s = str(r[k], `products[${i}].${k}`, 80, false);
    if (s) row[k] = s;
  }
  for (const k of ["seamAllowanceIn", "wallOverageIn", "doorwayOverageIn"] as const) {
    const n = num(r[k], `products[${i}].${k}`, { min: 0, max: 24 });
    if (n !== undefined) row[k] = n;
  }
  return row;
}

function parseOverride(v: unknown, key: string): RoomOverride {
  const r = obj(v, `overrides.rooms.${key}`);
  const out: RoomOverride = {};
  const nap = str(r.nap, `overrides.rooms.${key}.nap`, 40, false);
  if (nap) out.nap = nap;
  const base = str(r.base, `overrides.rooms.${key}.base`, 80, false);
  if (base) out.base = base;
  if (r.startEdge != null) {
    if (!Number.isInteger(r.startEdge) || (r.startEdge as number) < 0 || (r.startEdge as number) > 500) {
      throw new ShopDrawingsError(`overrides.rooms.${key}.startEdge must be a whole number.`);
    }
    out.startEdge = r.startEdge as number;
  }
  if (r.startNorm != null) {
    if (!Array.isArray(r.startNorm) || r.startNorm.length !== 2 || r.startNorm.some((n) => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1)) {
      throw new ShopDrawingsError(`overrides.rooms.${key}.startNorm must be two numbers from 0 to 1.`);
    }
    out.startNorm = [r.startNorm[0] as number, r.startNorm[1] as number];
  }
  return out;
}

/** Validate the shop-drawings body. Throws ShopDrawingsError. */
export function parseShopDrawingsRequest(body: unknown): ShopDrawingsRequest {
  const b = obj(body, "body");
  const annotations = obj(b.annotations, "annotations");
  if (annotations.schema !== TAKEOFF_SCHEMA) {
    throw new ShopDrawingsError(`annotations.schema must be ${TAKEOFF_SCHEMA}.`);
  }
  if (!Array.isArray(annotations.sheets) || !Array.isArray(annotations.shapes) || !Array.isArray(annotations.conditions)) {
    throw new ShopDrawingsError("annotations needs sheets, shapes and conditions arrays.");
  }
  if (annotations.shapes.length > 5000) throw new ShopDrawingsError("annotations has more than 5000 shapes.");
  const productsIn = b.products ?? [];
  if (!Array.isArray(productsIn) || productsIn.length > 500) throw new ShopDrawingsError("products must be a list of at most 500 finishes.");
  const products = productsIn.map(parseProduct);
  const overrides: Record<string, RoomOverride> = {};
  if (b.overrides != null) {
    const o = obj(b.overrides, "overrides");
    const rooms = o.rooms ?? {};
    const roomObj = obj(rooms, "overrides.rooms");
    const keys = Object.keys(roomObj);
    if (keys.length > 2000) throw new ShopDrawingsError("overrides.rooms has more than 2000 entries.");
    for (const key of keys) {
      if (key.length > 200) throw new ShopDrawingsError("An overrides.rooms key is longer than 200 characters.");
      overrides[key] = parseOverride(roomObj[key], key);
    }
  }
  const bidIn = b.bid == null ? {} : obj(b.bid, "bid");
  const bid: BidMeta = {
    projectName: str(bidIn.projectName, "bid.projectName", 200, false),
    bidNumber: str(bidIn.bidNumber, "bid.bidNumber", 40, false),
    address: str(bidIn.address, "bid.address", 200, false),
    date: str(bidIn.date, "bid.date", 40, false),
    drawnBy: str(bidIn.drawnBy, "bid.drawnBy", 80, false),
    checkedBy: str(bidIn.checkedBy, "bid.checkedBy", 80, false),
    rev: str(bidIn.rev, "bid.rev", 20, false),
  };
  let approval: ApprovalStamp | null = null;
  if (b.approval != null) {
    const a = obj(b.approval, "approval");
    const name = str(a.name, "approval.name", 80, true);
    approval = { name, at: str(a.at, "approval.at", 40, false) };
  }
  const sheetFrames: Record<string, SheetFrameInput> = {};
  if (b.sheetFrames != null) {
    const frames = obj(b.sheetFrames, "sheetFrames");
    for (const [key, value] of Object.entries(frames)) {
      const f = obj(value, `sheetFrames.${key}`);
      const widthPx = num(f.widthPx, `sheetFrames.${key}.widthPx`, { min: 1, max: 100000 });
      const heightPx = num(f.heightPx, `sheetFrames.${key}.heightPx`, { min: 1, max: 100000 });
      if (widthPx === undefined || heightPx === undefined) throw new ShopDrawingsError(`sheetFrames.${key} needs widthPx and heightPx.`);
      sheetFrames[key] = { widthPx, heightPx };
    }
  }
  let base: BaseSpec | null = null;
  if (b.base != null) {
    const baseIn = obj(b.base, "base");
    const description = str(baseIn.description, "base.description", 80, true);
    base = { tag: str(baseIn.tag, "base.tag", 20, false), description };
  }
  const transitionsIn = b.transitions ?? [];
  if (!Array.isArray(transitionsIn) || transitionsIn.length > 500) throw new ShopDrawingsError("transitions must be a list of at most 500 types.");
  const transitions = transitionsIn.map((v, i) => {
    const r = obj(v, `transitions[${i}]`);
    if (!Array.isArray(r.between) || r.between.length !== 2) throw new ShopDrawingsError(`transitions[${i}].between must name two finish tags.`);
    return {
      between: [str(r.between[0], `transitions[${i}].between[0]`, 40, true), str(r.between[1], `transitions[${i}].between[1]`, 40, true)] as [string, string],
      type: str(r.type, `transitions[${i}].type`, 40, true),
    };
  });
  return { annotations, products, overrides, bid, approval, sheetFrames, base, transitions };
}
