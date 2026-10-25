// ANSI B shop-drawing PDF: title block, DRAFT watermark, cover, finish plans.
// Geometry is already decided by buildShopModel; this file only draws it.
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, degrees, type PDFFont, type PDFPage, type PDFEmbeddedPage, type RGB } from "pdf-lib";
import { readBrandFile } from "./brand.ts";
import { centroid, longestEdgeIndex, shoelace, type Pt } from "./geometry.ts";
import { hatchSegments } from "./hatch.ts";
import { basePerimeterFt, baseRuns, sheetRolls, sheetTransitions, type TransitionMark } from "./layout.ts";
import type { RoomModel, SheetModel, ShopModel } from "./model.ts";
import { patternLines } from "./pattern.ts";
import { planSheets, type SheetSpec } from "./numbering.ts";
import { drawingFrame, fitSheet, legendFrame, PAGE_H, PAGE_W, planFrame, pxToPdf, type Fit, type Xy } from "./page.ts";
import { sheetGroups } from "./series.ts";
import { feetInches, pdfText } from "./text.ts";

const INK = rgb(0.12, 0.13, 0.15);
const MUTED = rgb(0.38, 0.4, 0.43);
const RULE = rgb(0.62, 0.64, 0.67);
const COBALT = rgb(0.122, 0.247, 0.78);
const PAPER = rgb(1, 1, 1);
const DRAFT_INK = rgb(0.45, 0.47, 0.5);
const LOW = rgb(0.62, 0.18, 0.14);

export interface Underlay {
  pdf: Uint8Array;
  /** 0-based page index. */
  pageIndex: number;
}

export interface RenderOptions {
  underlays?: Record<string, Underlay>;
}

export function coverNotes(model: ShopModel): string[] {
  return [
    "FIELD VERIFY ALL DIMENSIONS.",
    model.approval
      ? `Stamped APPROVED FOR INSTALL by ${model.approval.name}.`
      : "These drawings are DRAFT until a named FLOOR360 estimator stamps them.",
    "The runner does not send drawings to anyone.",
    "Nap direction is east-west unless a finish or a room says otherwise.",
    "Tile and LVT start points read \"Start: verify at doorway center\" until a doorway is located.",
    "Doorway transitions read \"TBD \u2013 verify\". Only committed butt joints are drawn as transitions.",
  ];
}

interface Fonts { regular: PDFFont; bold: PDFFont; light: PDFFont }

function hexRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  return rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
}

function lighten(hex: string, t = 0.78): RGB {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return rgb(ch[0]! + (1 - ch[0]!) * t, ch[1]! + (1 - ch[1]!) * t, ch[2]! + (1 - ch[2]!) * t);
}

function pathOf(pts: Pt[]): string {
  const n = (v: number) => (Math.round(v * 100) / 100).toFixed(2);
  return pts.map((p, i) => `${i ? "L" : "M"} ${n(p.x)} ${n(p.y)}`).join(" ") + " Z";
}

function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && font.widthOfTextAtSize(next, size) > width) { lines.push(cur); cur = w; }
    else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

function drawTitleBlock(page: PDFPage, fonts: Fonts, model: ShopModel, spec: SheetSpec, logo: PDFEmbeddedPage | null) {
  const x = 16, y = 16, w = PAGE_W - 32, h = 108;
  page.drawRectangle({ x, y, width: w, height: h, borderColor: RULE, borderWidth: 0.8, color: PAPER });
  page.drawLine({ start: { x, y: y + 36 }, end: { x: x + w, y: y + 36 }, thickness: 0.6, color: RULE });
  for (const vx of [130, 300, 860]) {
    page.drawLine({ start: { x: vx, y: y + 36 }, end: { x: vx, y: y + h }, thickness: 0.6, color: RULE });
  }
  if (logo) {
    const lh = 28;
    const lw = lh * (logo.width / logo.height);
    page.drawPage(logo, { x: x + 10, y: y + 52, width: lw, height: lh });
  }
  page.drawText("FLOOR360", { x: 142, y: y + 86, size: 13, font: fonts.bold, color: INK });
  page.drawText("Shop drawings", { x: 142, y: y + 70, size: 8, font: fonts.light, color: MUTED });
  page.drawText(pdfText(model.projectName, 48), { x: 312, y: y + 88, size: 10, font: fonts.bold, color: INK });
  page.drawText(`Bid ${pdfText(model.bidNumber, 32)}`, { x: 312, y: y + 72, size: 8, font: fonts.regular, color: INK });
  if (model.address) page.drawText(pdfText(model.address, 56), { x: 312, y: y + 56, size: 7, font: fonts.light, color: MUTED });
  page.drawText(spec.number, { x: 876, y: y + 82, size: 16, font: fonts.bold, color: INK });
  page.drawText(`Sheet ${spec.page} of ${spec.pages}`, { x: 876, y: y + 66, size: 8, font: fonts.regular, color: INK });
  page.drawText(pdfText(spec.title, 28), { x: 876, y: y + 50, size: 8, font: fonts.light, color: MUTED });

  const cells: [string, string][] = [
    ["Drawn", model.drawnBy],
    ["Checked", model.checkedBy],
    ["Approved", model.approval ? model.approval.name : "DRAFT"],
    ["Rev", model.rev],
    ["Date", model.date],
  ];
  const cw = w / cells.length;
  cells.forEach(([label, value], i) => {
    const cx = x + i * cw + 8;
    page.drawText(label, { x: cx, y: y + 22, size: 6, font: fonts.light, color: MUTED });
    page.drawText(pdfText(value, 22), { x: cx, y: y + 8, size: 8, font: fonts.regular, color: model.approval || label !== "Approved" ? INK : LOW });
  });
}

function drawWatermark(page: PDFPage, font: PDFFont) {
  const size = 92;
  const width = font.widthOfTextAtSize("DRAFT", size);
  page.drawText("DRAFT", {
    x: PAGE_W / 2 - width / 2,
    y: PAGE_H / 2 - 20,
    size,
    font,
    color: DRAFT_INK,
    opacity: 0.28,
    rotate: degrees(28),
  });
}

function drawStamp(page: PDFPage, fonts: Fonts, model: ShopModel) {
  if (!model.approval) return;
  const w = 168, h = 48;
  const x = PAGE_W - 16 - w - 8, y = 16 + 108 + 10;
  page.drawRectangle({ x, y, width: w, height: h, borderColor: rgb(0.12, 0.4, 0.24), borderWidth: 1.4, color: PAPER, opacity: 0.92 });
  page.drawText("APPROVED FOR INSTALL", { x: x + 8, y: y + 30, size: 8, font: fonts.bold, color: rgb(0.12, 0.4, 0.24) });
  page.drawText(pdfText(model.approval.name, 26), { x: x + 8, y: y + 16, size: 8, font: fonts.regular, color: INK });
  page.drawText(pdfText(model.approval.at || model.date, 26), { x: x + 8, y: y + 5, size: 7, font: fonts.light, color: MUTED });
}

function drawCover(page: PDFPage, fonts: Fonts, model: ShopModel, specs: SheetSpec[]) {
  const frame = drawingFrame();
  let y = frame.y + frame.h - 16;
  page.drawText(pdfText(model.projectName, 60), { x: frame.x, y, size: 16, font: fonts.bold, color: INK });
  y -= 16;
  page.drawText(`Bid ${pdfText(model.bidNumber, 40)}`, { x: frame.x, y, size: 10, font: fonts.regular, color: MUTED });
  y -= 22;
  page.drawText("General notes", { x: frame.x, y, size: 9, font: fonts.bold, color: INK });
  y -= 14;
  for (const note of coverNotes(model)) {
    for (const line of wrap(fonts.regular, note, 8, 520)) {
      page.drawText(line, { x: frame.x, y, size: 8, font: fonts.regular, color: INK });
      y -= 11;
    }
    y -= 2;
  }
  if (model.warnings.length) {
    y -= 6;
    page.drawText("Flags", { x: frame.x, y, size: 9, font: fonts.bold, color: LOW });
    y -= 13;
    for (const warning of model.warnings.slice(0, 12)) {
      for (const line of wrap(fonts.regular, warning, 7.5, 520)) {
        if (y < frame.y + 8) break;
        page.drawText(line, { x: frame.x, y, size: 7.5, font: fonts.regular, color: LOW });
        y -= 10;
      }
    }
  }
  let iy = frame.y + frame.h - 16;
  const ix = frame.x + 560;
  page.drawText("Sheet index", { x: ix, y: iy, size: 9, font: fonts.bold, color: INK });
  iy -= 16;
  for (const spec of specs) {
    const label = spec.sourceSheetId ? `${spec.number}  ${spec.title}` : `${spec.number}  ${spec.title}`;
    page.drawText(pdfText(label, 42), { x: ix, y: iy, size: 8, font: fonts.regular, color: INK });
    iy -= 12;
    if (spec.sourceSheetId) {
      page.drawText(pdfText(spec.sourceSheetId, 46), { x: ix + 8, y: iy, size: 7, font: fonts.light, color: MUTED });
      iy -= 12;
    }
  }
  iy -= 8;
  page.drawText("Finish legend", { x: ix, y: iy, size: 9, font: fonts.bold, color: INK });
  iy -= 16;
  for (const fin of model.finishes) {
    if (iy < frame.y + 8) break;
    page.drawRectangle({ x: ix, y: iy - 2, width: 10, height: 10, color: hexRgb(fin.color) });
    page.drawText(pdfText(`${fin.tag}  ${fin.product}  ${fin.hatch}`, 40), { x: ix + 16, y: iy, size: 8, font: fonts.regular, color: INK });
    iy -= 14;
  }
}

function roomCheck(sheet: SheetModel): { a: Pt; b: Pt; lengthFt: number; label: string } | null {
  let best: RoomModel | null = null;
  let area = -1;
  for (const room of sheet.rooms) {
    const a = shoelace(room.ringFt);
    if (a > area) { area = a; best = room; }
  }
  if (!best || best.ringPx.length < 2) return null;
  const i = longestEdgeIndex(best.ringFt);
  const j = (i + 1) % best.ringPx.length;
  const lengthFt = Math.hypot(best.ringFt[j]!.x - best.ringFt[i]!.x, best.ringFt[j]!.y - best.ringFt[i]!.y);
  return { a: best.ringPx[i]!, b: best.ringPx[j]!, lengthFt, label: best.label };
}

function drawFinish(page: PDFPage, fonts: Fonts, spec: SheetSpec, model: ShopModel, underlay: PDFEmbeddedPage | null) {
  const sheet = model.sheets.find((s) => s.id === spec.sourceSheetId);
  if (!sheet) return;
  const frame = planFrame();
  const fit = fitSheet(frame, sheet.widthPx, sheet.heightPx);
  page.drawRectangle({ x: frame.x, y: frame.y, width: frame.w, height: frame.h, borderColor: RULE, borderWidth: 0.4 });
  if (underlay) page.drawPage(underlay, { x: fit.x, y: fit.y, width: fit.w, height: fit.h, opacity: 0.32 });
  for (const room of sheet.rooms) drawRoom(page, fonts, sheet, room, fit);
  drawCheck(page, fonts, sheet, fit);
  drawLegend(page, fonts, sheet);
  const noteY = frame.y + frame.h - 14;
  page.drawRectangle({ x: frame.x + 4, y: noteY - 16, width: Math.min(frame.w - 8, 460), height: 26, color: PAPER, opacity: 0.88 });
  page.drawText(pdfText(sheet.scaleNote, 78), { x: frame.x + 8, y: noteY, size: 7, font: fonts.regular, color: INK });
  const check = roomCheck(sheet);
  if (check) {
    page.drawText(pdfText(`Check: ${check.label} ${feetInches(check.lengthFt)}`, 72), { x: frame.x + 8, y: noteY - 11, size: 7, font: fonts.bold, color: COBALT });
  }
}

function drawRoom(page: PDFPage, fonts: Fonts, sheet: SheetModel, room: RoomModel, fit: Fit) {
  const pts = room.ringPx.map((p) => pxToPdf(fit, p.x, p.y, sheet.heightPx));
  page.drawSvgPath(pathOf(pts), { color: lighten(room.color), borderColor: hexRgb(room.color), borderWidth: room.lowConfidence ? 1.4 : 0.7, opacity: 0.9 });
  const poly = room.ringPx;
  for (const [a, b] of hatchSegments(poly, room.hatch)) {
    const A = pxToPdf(fit, a.x, a.y, sheet.heightPx);
    const B = pxToPdf(fit, b.x, b.y, sheet.heightPx);
    page.drawLine({ start: A, end: B, thickness: 0.35, color: hexRgb(room.color), opacity: 0.8 });
  }
  const c = centroid(poly);
  const at = pxToPdf(fit, c.x, c.y, sheet.heightPx);
  const label = pdfText(`${room.finishTag}  ${room.label}`, 36);
  const size = 7;
  const width = fonts.bold.widthOfTextAtSize(label, size);
  page.drawRectangle({ x: at.x - width / 2 - 2, y: at.y - 2, width: width + 4, height: room.lowConfidence ? 20 : 11, color: PAPER, opacity: 0.88 });
  page.drawText(label, { x: at.x - width / 2, y: at.y, size, font: fonts.bold, color: INK });
  if (room.lowConfidence) {
    const flag = "LOW CONFIDENCE";
    const fw = fonts.bold.widthOfTextAtSize(flag, 6);
    page.drawText(flag, { x: at.x - fw / 2, y: at.y - 9, size: 6, font: fonts.bold, color: LOW });
  }
}

function drawCheck(page: PDFPage, fonts: Fonts, sheet: SheetModel, fit: Fit) {
  const check = roomCheck(sheet);
  if (!check || !(check.lengthFt > 0)) return;
  const A = pxToPdf(fit, check.a.x, check.a.y, sheet.heightPx);
  const B = pxToPdf(fit, check.b.x, check.b.y, sheet.heightPx);
  page.drawLine({ start: A, end: B, thickness: 1, color: COBALT });
  const label = `CHK ${feetInches(check.lengthFt)}`;
  const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
  const width = fonts.bold.widthOfTextAtSize(label, 7);
  page.drawRectangle({ x: mx - width / 2 - 2, y: my + 3, width: width + 4, height: 11, color: PAPER, opacity: 0.9 });
  page.drawText(label, { x: mx - width / 2, y: my + 5, size: 7, font: fonts.bold, color: COBALT });
}

function drawLegend(page: PDFPage, fonts: Fonts, sheet: SheetModel) {
  const box = legendFrame();
  page.drawRectangle({ x: box.x, y: box.y, width: box.w, height: box.h, borderColor: RULE, borderWidth: 0.4, color: PAPER });
  let y = box.y + box.h - 16;
  page.drawText("Legend", { x: box.x + 8, y, size: 8, font: fonts.bold, color: INK });
  y -= 16;
  const seen = new Set<string>();
  for (const room of sheet.rooms) {
    if (seen.has(room.finishTag)) continue;
    seen.add(room.finishTag);
    page.drawRectangle({ x: box.x + 8, y: y - 1, width: 9, height: 9, color: hexRgb(room.color) });
    page.drawText(pdfText(room.finishTag, 16), { x: box.x + 22, y, size: 8, font: fonts.bold, color: INK });
    y -= 11;
    page.drawText(pdfText(`${room.productName} · ${room.hatch}`, 26), { x: box.x + 22, y, size: 6.5, font: fonts.light, color: MUTED });
    y -= 14;
  }
  y -= 4;
  page.drawText(pdfText(sheet.scaleNote, 32), { x: box.x + 8, y, size: 6, font: fonts.regular, color: INK });
}

function openPlan(page: PDFPage, spec: SheetSpec, model: ShopModel, underlay: PDFEmbeddedPage | null): { sheet: SheetModel; fit: Fit } | null {
  const sheet = model.sheets.find((s) => s.id === spec.sourceSheetId);
  if (!sheet) return null;
  const frame = planFrame();
  const fit = fitSheet(frame, sheet.widthPx, sheet.heightPx);
  page.drawRectangle({ x: frame.x, y: frame.y, width: frame.w, height: frame.h, borderColor: RULE, borderWidth: 0.4 });
  if (underlay) page.drawPage(underlay, { x: fit.x, y: fit.y, width: fit.w, height: fit.h, opacity: 0.32 });
  return { sheet, fit };
}

function stampNote(page: PDFPage, fonts: Fonts, sheet: SheetModel) {
  const frame = planFrame();
  const noteY = frame.y + frame.h - 14;
  page.drawRectangle({ x: frame.x + 4, y: noteY - 16, width: Math.min(frame.w - 8, 460), height: 26, color: PAPER, opacity: 0.88 });
  page.drawText(pdfText(sheet.scaleNote, 78), { x: frame.x + 8, y: noteY, size: 7, font: fonts.regular, color: INK });
  const check = roomCheck(sheet);
  if (check) page.drawText(pdfText(`Check: ${check.label} ${feetInches(check.lengthFt)}`, 72), { x: frame.x + 8, y: noteY - 11, size: 7, font: fonts.bold, color: COBALT });
}

function drawArrow(page: PDFPage, from: Xy, to: Xy, color: RGB) {
  page.drawLine({ start: from, end: to, thickness: 1.1, color });
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  const len = 7;
  page.drawLine({ start: to, end: { x: to.x - len * Math.cos(ang - 0.45), y: to.y - len * Math.sin(ang - 0.45) }, thickness: 1.1, color });
  page.drawLine({ start: to, end: { x: to.x - len * Math.cos(ang + 0.45), y: to.y - len * Math.sin(ang + 0.45) }, thickness: 1.1, color });
}

function drawDashed(page: PDFPage, a: Xy, b: Xy, color: RGB) {
  const parts = 8;
  for (let i = 0; i < parts; i += 2) {
    const t0 = i / parts, t1 = (i + 1) / parts;
    page.drawLine({
      start: { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 },
      end: { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 },
      thickness: 1.2,
      color,
    });
  }
}

function listLines(page: PDFPage, fonts: Fonts, lines: string[], color: RGB = INK) {
  const box = legendFrame();
  page.drawRectangle({ x: box.x, y: box.y, width: box.w, height: box.h, borderColor: RULE, borderWidth: 0.4, color: PAPER });
  let y = box.y + box.h - 16;
  for (const line of lines) {
    if (y < box.y + 8) break;
    const size = line.endsWith(":") || line === lines[0] ? 8 : 6.5;
    const font = size === 8 ? fonts.bold : fonts.regular;
    page.drawText(pdfText(line, 32), { x: box.x + 8, y, size, font, color: size === 8 ? INK : color });
    y -= size === 8 ? 12 : 9;
  }
}

function drawRoll(page: PDFPage, fonts: Fonts, spec: SheetSpec, model: ShopModel, underlay: PDFEmbeddedPage | null) {
  const opened = openPlan(page, spec, model, underlay);
  if (!opened) return;
  const { sheet, fit } = opened;
  const rolls = sheetRolls(sheet);
  for (const roll of rolls) {
    for (const cut of roll.cuts) {
      if (cut.ringPx.length < 3) continue;
      const pts = cut.ringPx.map((p) => pxToPdf(fit, p.x, p.y, sheet.heightPx));
      page.drawSvgPath(pathOf(pts), { borderColor: INK, borderWidth: 0.6, color: rgb(0.85, 0.78, 0.62), opacity: 0.35 });
      const c = centroid(cut.ringPx);
      const at = pxToPdf(fit, c.x, c.y, sheet.heightPx);
      page.drawText(String(cut.num), { x: at.x - 3, y: at.y, size: 8, font: fonts.bold, color: INK });
    }
    for (const [a, b] of roll.seams) {
      const A = pxToPdf(fit, a.x, a.y, sheet.heightPx);
      const B = pxToPdf(fit, b.x, b.y, sheet.heightPx);
      page.drawLine({ start: A, end: B, thickness: 1.4, color: LOW });
    }
    const [from, to] = roll.arrow;
    drawArrow(page, pxToPdf(fit, from.x, from.y, sheet.heightPx), pxToPdf(fit, to.x, to.y, sheet.heightPx), COBALT);
  }
  drawCheck(page, fonts, sheet, fit);
  stampNote(page, fonts, sheet);
  const lines = ["Cut list"];
  let seam = 0;
  for (const roll of rolls) {
    seam += roll.seamLf;
    lines.push(`${roll.tag} ${roll.nap === "ns" ? "N-S" : "E-W"}`);
    for (const cut of roll.cuts) lines.push(`${cut.num}  ${feetInches(cut.lenFt)} x ${feetInches(cut.widthFt)}`);
  }
  lines.push(`Seam ${feetInches(seam)}`);
  listLines(page, fonts, lines);
}

function drawPattern(page: PDFPage, fonts: Fonts, spec: SheetSpec, model: ShopModel, underlay: PDFEmbeddedPage | null) {
  const opened = openPlan(page, spec, model, underlay);
  if (!opened) return;
  const { sheet, fit } = opened;
  const lines = ["Pattern"];
  for (const room of sheet.rooms) {
    if (room.kind !== "tile" || !(room.tileWidthIn && room.tileHeightIn)) continue;
    const tileW = (room.tileWidthIn / 12) / sheet.upp;
    const tileH = (room.tileHeightIn / 12) / sheet.upp;
    const pts = room.ringPx.map((p) => pxToPdf(fit, p.x, p.y, sheet.heightPx));
    page.drawSvgPath(pathOf(pts), { color: lighten(room.color, 0.88), borderColor: hexRgb(room.color), borderWidth: 0.6 });
    for (const [a, b] of patternLines(room.ringPx, room.start.at, tileW, tileH, room.pattern ?? "")) {
      const A = pxToPdf(fit, a.x, a.y, sheet.heightPx);
      const B = pxToPdf(fit, b.x, b.y, sheet.heightPx);
      page.drawLine({ start: A, end: B, thickness: 0.3, color: hexRgb(room.color), opacity: 0.85 });
    }
    const at = pxToPdf(fit, room.start.at.x, room.start.at.y, sheet.heightPx);
    page.drawCircle({ x: at.x, y: at.y, size: 3.5, color: COBALT });
    page.drawText("Start: verify at doorway center", { x: at.x + 6, y: at.y + 2, size: 6, font: fonts.bold, color: COBALT });
    lines.push(`${room.finishTag} ${room.tileWidthIn}"x${room.tileHeightIn}"`);
    lines.push(room.pattern || "pattern not named");
  }
  drawCheck(page, fonts, sheet, fit);
  stampNote(page, fonts, sheet);
  listLines(page, fonts, lines);
}

function drawTransitions(page: PDFPage, fonts: Fonts, spec: SheetSpec, model: ShopModel, underlay: PDFEmbeddedPage | null) {
  const opened = openPlan(page, spec, model, underlay);
  if (!opened) return;
  const { sheet, fit } = opened;
  for (const room of sheet.rooms) {
    const pts = room.ringPx.map((p) => pxToPdf(fit, p.x, p.y, sheet.heightPx));
    page.drawSvgPath(pathOf(pts), { color: lighten(room.color, 0.9), borderColor: RULE, borderWidth: 0.3 });
  }
  const base = baseRuns(model, sheet);
  const seen = new Set<string>();
  for (const run of base.runs) {
    const A = pxToPdf(fit, run.a.x, run.a.y, sheet.heightPx);
    const B = pxToPdf(fit, run.b.x, run.b.y, sheet.heightPx);
    page.drawLine({ start: A, end: B, thickness: 1.6, color: rgb(0.35, 0.22, 0.12) });
    if (!seen.has(run.label)) {
      seen.add(run.label);
      page.drawText(pdfText(run.label, 28), { x: (A.x + B.x) / 2 + 2, y: (A.y + B.y) / 2 + 2, size: 6, font: fonts.regular, color: INK });
    }
  }
  const marks = sheetTransitions(model, sheet);
  for (const mark of marks) drawMark(page, fonts, sheet, fit, mark);
  drawCheck(page, fonts, sheet, fit);
  stampNote(page, fonts, sheet);
  const lines = ["Transitions", `Base ${feetInches(basePerimeterFt(sheet))}`];
  lines.push(base.openingsStated ? "Stated openings omitted" : "Openings not stated");
  for (const mark of marks) {
    const name = mark.kind === "butt" ? mark.id : "Door";
    lines.push(`${name} ${mark.between.join("/")} ${feetInches(mark.lengthLf)}`);
    lines.push(mark.type);
  }
  if (!marks.length) lines.push("No adjacent finishes");
  listLines(page, fonts, lines);
}

function drawMark(page: PDFPage, fonts: Fonts, sheet: SheetModel, fit: Fit, mark: TransitionMark) {
  const pts = mark.pathPx.map((p) => pxToPdf(fit, p.x, p.y, sheet.heightPx));
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    if (mark.kind === "doorway") drawDashed(page, a, b, LOW);
    else page.drawLine({ start: a, end: b, thickness: 1.6, color: INK });
  }
  const mid = pts[Math.floor(pts.length / 2)] ?? pts[0];
  if (!mid) return;
  const label = mark.kind === "butt" ? mark.id : "TBD";
  page.drawText(label, { x: mid.x + 3, y: mid.y + 3, size: 7, font: fonts.bold, color: mark.kind === "butt" ? INK : LOW });
}

export async function renderShopDrawings(model: ShopModel, opts: RenderOptions = {}): Promise<{ pdf: Uint8Array; specs: SheetSpec[] }> {
  const specs = planSheets(sheetGroups(model));
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fonts: Fonts = {
    regular: await doc.embedFont(await readBrandFile("BrandonText-Regular.ttf"), { subset: true }),
    bold: await doc.embedFont(await readBrandFile("BrandonText-Bold.ttf"), { subset: true }),
    light: await doc.embedFont(await readBrandFile("BrandonText-Light.ttf"), { subset: true }),
  };
  let logo: PDFEmbeddedPage | null = null;
  try {
    const [embedded] = await doc.embedPdf(await readBrandFile("floor360-logo.pdf"));
    logo = embedded ?? null;
  } catch {
    logo = null;
  }
  doc.setTitle(`${model.projectName} shop drawings`);
  doc.setAuthor("FLOOR360");
  doc.setCreator("FLOOR360 shop drawings");
  doc.setProducer("FLOOR360 takeoff-runner");
  doc.setSubject(specs.map((s) => s.number).join(" "));
  doc.setKeywords(model.approval ? [`APPROVED`, model.approval.name] : ["DRAFT"]);

  const underlayCache = new Map<string, PDFEmbeddedPage | null>();
  const embedUnderlay = async (sheetId: string): Promise<PDFEmbeddedPage | null> => {
    if (underlayCache.has(sheetId)) return underlayCache.get(sheetId) ?? null;
    const src = opts.underlays?.[sheetId];
    if (!src) { underlayCache.set(sheetId, null); return null; }
    const [embedded] = await doc.embedPdf(src.pdf, [src.pageIndex]);
    underlayCache.set(sheetId, embedded ?? null);
    return embedded ?? null;
  };

  for (const spec of specs) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: PAPER });
    if (spec.series === "cover") drawCover(page, fonts, model, specs);
    else if (spec.sourceSheetId) {
      const underlay = await embedUnderlay(spec.sourceSheetId);
      if (spec.series === "finish") drawFinish(page, fonts, spec, model, underlay);
      else if (spec.series === "roll") drawRoll(page, fonts, spec, model, underlay);
      else if (spec.series === "pattern") drawPattern(page, fonts, spec, model, underlay);
      else if (spec.series === "transitions") drawTransitions(page, fonts, spec, model, underlay);
    }
    if (!model.approval) drawWatermark(page, fonts.bold);
    drawStamp(page, fonts, model);
    drawTitleBlock(page, fonts, model, spec, logo);
    page.drawRectangle({ x: 10, y: 10, width: PAGE_W - 20, height: PAGE_H - 20, borderColor: RULE, borderWidth: 0.8 });
  }
  return { pdf: await doc.save(), specs };
}
