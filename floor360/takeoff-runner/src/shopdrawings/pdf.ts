// ANSI B shop-drawing PDF: title block, DRAFT watermark, cover, finish plans.
// Geometry is already decided by buildShopModel; this file only draws it.
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, degrees, type PDFFont, type PDFPage, type PDFEmbeddedPage, type RGB } from "pdf-lib";
import { readBrandFile } from "./brand.ts";
import { centroid, longestEdgeIndex, shoelace, type Pt } from "./geometry.ts";
import { hatchSegments } from "./hatch.ts";
import type { RoomModel, SheetModel, ShopModel } from "./model.ts";
import { planSheets, type SheetSpec } from "./numbering.ts";
import { drawingFrame, fitSheet, legendFrame, PAGE_H, PAGE_W, planFrame, pxToPdf, type Fit } from "./page.ts";
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
    else if (spec.series === "finish" && spec.sourceSheetId) {
      drawFinish(page, fonts, spec, model, await embedUnderlay(spec.sourceSheetId));
    }
    if (!model.approval) drawWatermark(page, fonts.bold);
    drawStamp(page, fonts, model);
    drawTitleBlock(page, fonts, model, spec, logo);
    page.drawRectangle({ x: 10, y: 10, width: PAGE_W - 20, height: PAGE_H - 20, borderColor: RULE, borderWidth: 0.8 });
  }
  return { pdf: await doc.save(), specs };
}
