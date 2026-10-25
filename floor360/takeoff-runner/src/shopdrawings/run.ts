// One shop-drawings run on the shared job queue. Writes the PDF and a status
// file. It does not send the PDF anywhere.
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import type { RunContext, RunResult } from "../pipeline.ts";
import { setName, type Finding } from "../types.ts";
import { JobFailure } from "../vision.ts";
import { parseSheetKey } from "../../../../web/src/lib/sheetKey.ts";
import { buildShopModel, ShopDrawingsRefusal, type Frame } from "./model.ts";
import { pageSizeToPx } from "./page.ts";
import { renderShopDrawings, type Underlay } from "./pdf.ts";
import { parseShopDrawingsRequest, ShopDrawingsError } from "./request.ts";

export function shopDrawingsPdfName(projectName: string, bidNumber: string, approved: boolean): string {
  const set = setName(projectName, bidNumber);
  return approved ? `${set} - shop drawings.pdf` : `${set} - shop drawings DRAFT.pdf`;
}

export function shopDrawingsStatusName(projectName: string, bidNumber: string): string {
  return `${setName(projectName, bidNumber)} - shop drawings.json`;
}

async function framesFromFiles(filesDir: string, annotations: Record<string, unknown>): Promise<{ frames: Record<string, Frame>; underlays: Record<string, Underlay> }> {
  const frames: Record<string, Frame> = {};
  const underlays: Record<string, Underlay> = {};
  const sheets = Array.isArray(annotations.sheets) ? annotations.sheets : [];
  const wanted = new Map<string, { sheetId: string; pageIndex: number }[]>();
  for (const row of sheets) {
    if (!row || typeof row !== "object") continue;
    const id = (row as { sheet_id?: unknown }).sheet_id;
    if (typeof id !== "string") continue;
    const parsed = parseSheetKey(id);
    const list = wanted.get(parsed.file) ?? [];
    list.push({ sheetId: id, pageIndex: Math.max(0, parsed.page - 1) });
    wanted.set(parsed.file, list);
  }
  for (const [file, pages] of wanted) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(path.join(filesDir, file)));
    } catch {
      continue;
    }
    let doc: PDFDocument;
    try {
      doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    } catch {
      throw new JobFailure(`"${file}" could not be read as a PDF, so shop drawings have no page size.`);
    }
    for (const page of pages) {
      if (page.pageIndex >= doc.getPageCount()) {
        throw new JobFailure(`"${page.sheetId}" asks for a page that is not in "${file}".`);
      }
      const size = doc.getPage(page.pageIndex).getSize();
      const px = pageSizeToPx(size.width, size.height);
      frames[page.sheetId] = px;
      frames[file] = px;
      underlays[page.sheetId] = { pdf: bytes, pageIndex: page.pageIndex };
    }
  }
  return { frames, underlays };
}

/** Run a queued shop-drawings job. Refusals become a failed job with one sentence. */
export async function runShopDrawings(ctx: RunContext): Promise<RunResult> {
  let request;
  try {
    request = parseShopDrawingsRequest(ctx.shopDrawings);
  } catch (e) {
    if (e instanceof ShopDrawingsError) throw new JobFailure(e.message);
    throw e;
  }
  const bid = {
    ...request.bid,
    projectName: request.bid.projectName || ctx.manifest.projectName,
    bidNumber: request.bid.bidNumber || ctx.manifest.bidNumber,
  };
  const filled = { ...request, bid };
  ctx.progress("Reading sheets");
  const loaded = await framesFromFiles(ctx.filesDir, filled.annotations);
  const frames = { ...loaded.frames, ...filled.sheetFrames };
  let model;
  try {
    model = buildShopModel(filled, frames, new Date());
  } catch (e) {
    if (e instanceof ShopDrawingsRefusal) throw new JobFailure(e.message);
    throw e;
  }
  ctx.progress("Drawing shop sheets", 0, model.sheets.length + 1);
  ctx.setStatus("running");
  const { pdf, specs } = await renderShopDrawings(model, { underlays: loaded.underlays });
  await mkdir(ctx.outputsDir, { recursive: true });
  const pdfName = shopDrawingsPdfName(model.projectName, model.bidNumber, !!model.approval);
  const statusName = shopDrawingsStatusName(model.projectName, model.bidNumber);
  await writeFile(path.join(ctx.outputsDir, pdfName), pdf);
  const status = {
    schema: "floor360.shop_drawings.v1",
    status: model.approval ? "approved" : "draft",
    approval: model.approval,
    pdf: pdfName,
    sheets: specs.map((s) => ({ number: s.number, title: s.title, series: s.series, ...(s.sourceSheetId ? { sheet: s.sourceSheetId } : {}) })),
    warnings: model.warnings,
    errors: [] as string[],
    scales: model.sheets.map((s) => ({ sheet: s.id, source: s.scaleSource, note: s.scaleNote })),
    lowConfidenceRooms: model.sheets.flatMap((s) => s.rooms.filter((r) => r.lowConfidence).map((r) => ({ sheet: s.id, room: r.label, tag: r.finishTag }))),
  };
  await writeFile(path.join(ctx.outputsDir, statusName), JSON.stringify(status, null, 2));
  const findings: Finding[] = [];
  for (const sheet of model.sheets) {
    const lows = sheet.rooms.filter((r) => r.lowConfidence);
    if (lows.length) {
      findings.push({
        kind: "low_confidence_rooms",
        sheet: sheet.id,
        message: `${lows.length} low-confidence room${lows.length === 1 ? "" : "s"} on ${sheet.id}: ${lows.map((r) => r.label).join(", ")}.`,
      });
    }
  }
  for (const warning of model.warnings) {
    if (/^No nap was given/.test(warning) || /rollWidthFt/.test(warning) || /tile size/.test(warning) || /no pattern/.test(warning) || /base type/.test(warning)) {
      findings.push({ kind: "shop_drawing_note", message: warning });
    }
  }
  const rooms = model.sheets.reduce((n, s) => n + s.rooms.length, 0);
  return {
    counts: { sheets: specs.length, rooms, conditions: model.finishes.length, rfisDrafted: 0 },
    findings,
    outputs: [pdfName, statusName],
  };
}
