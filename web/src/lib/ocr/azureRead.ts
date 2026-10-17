// "Hard scan? Read with Azure" (FLOOR360 private build): Import from
// schedule's box read by Azure AI Document Intelligence through the site's
// own POST /api/ocr/read (scripts/floor360-ocr-read.mjs), for a scan the
// on-device reader couldn't make a table of. The browser never holds an
// Azure key or calls an Azure host: it sends one PNG of the box to its own
// origin, and the server applies the monthly and per-user page caps.
//
// The box is rendered once (not tiled: one image is one billed page) at
// OCR's DPI, dropping the DPI until the PNG fits the route's size limit. The
// lines that come back carry pixel polygons on that raster; each becomes an
// OcrWord through cropBoxToWord, as an on-device crop box does (Azure's
// polygons have no padding to take off), then boxWords cleans them.
import { boxWords } from "./boxRead";
import { cropBoxToWord, type RenderGeometry } from "./raster";
import { OCR_TARGET_DPI, rasterizeRegion, type RegionRaster } from "./rasterize";
import type { PageLike } from "./regionRead";
import type { Rect } from "./seams";
import { wordsToSpans, type OcrWord } from "./types";
import { routeOcrRead, type ImportRoute } from "../scheduleRoute";
import type { GraphSpan } from "../sheetgraph";
import type { ScheduleRead } from "../scheduleRead";

export const AZURE_READ_PATH = "/api/ocr/read";
/** the route's default OCR_MAX_IMAGE_BYTES */
export const AZURE_MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const DPI_STEPS = [OCR_TARGET_DPI, 150, 110];

export const AZURE_READING_MESSAGE = "Reading the box with Azure…";
export const AZURE_RETRY_LABEL = "Hard scan? Read with Azure";

export interface AzureLine { content: string; polygon: number[]; confidence?: number }

/** The private build offers the Azure read (vite.config defines it there). */
export function azureOcrOffered(env: Record<string, unknown> = (import.meta as unknown as { env?: Record<string, unknown> }).env ?? {}): boolean {
  return env.VITE_OCR_AZURE === "1";
}

let statusPromise: Promise<boolean> | null = null;
/** Whether this site's route is set up (GET /api/ocr/read), asked once. */
export function azureOcrReady(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  statusPromise ??= fetchImpl(AZURE_READ_PATH, { credentials: "same-origin" })
    .then(async (r) => r.ok && (await r.json())?.enabled === true)
    .catch(() => false)
    .then((ok) => { if (!ok) statusPromise = null; return ok; });
  return statusPromise;
}

/** Azure's lines (pixel polygons on the raster) as OcrWords in image px. */
export function azureLinesToWords(lines: readonly AzureLine[], g: RenderGeometry): OcrWord[] {
  const out: OcrWord[] = [];
  for (const l of lines) {
    const str = typeof l.content === "string" ? l.content.trim() : "";
    const p = l.polygon;
    if (!str || !Array.isArray(p) || p.length < 8) continue;
    const xs = [p[0], p[2], p[4], p[6]], ys = [p[1], p[3], p[5], p[7]];
    const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    if (!(box.x1 > box.x0 && box.y1 > box.y0)) continue;
    const conf = Number.isFinite(l.confidence) ? l.confidence : undefined;
    out.push(cropBoxToWord(str, box, g, conf));
  }
  return out;
}

function pngBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface AzureReadDeps {
  rasterize?: (page: PageLike, rs: number, rect: Rect, o: { dpi?: number; png?: boolean; signal?: AbortSignal }) => Promise<RegionRaster>;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
}

/** Read `rect` (image px at rs) of `page` with Azure; resolves the box's
 * words or rejects with an Error whose message is the route's own. */
export async function azureReadBox(page: PageLike, rs: number, rect: Rect, signal: AbortSignal | undefined, deps: AzureReadDeps = {}): Promise<OcrWord[]> {
  const rasterize = deps.rasterize ?? (rasterizeRegion as unknown as NonNullable<AzureReadDeps["rasterize"]>);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const maxBytes = deps.maxBytes ?? AZURE_MAX_IMAGE_BYTES;
  let raster: RegionRaster | null = null;
  let bytes: Uint8Array | null = null;
  for (const dpi of DPI_STEPS) {
    raster = await rasterize(page, rs, rect, { dpi, png: true, signal });
    bytes = pngBytes(raster.png || "");
    if (bytes.length <= maxBytes) break;
    bytes = null;
  }
  if (!raster || !bytes) throw new Error("That box is too large for Azure OCR — draw a smaller box");
  const res = await fetchImpl(AZURE_READ_PATH, { method: "POST", headers: { "Content-Type": "image/png" }, body: bytes as BodyInit, credentials: "same-origin", signal });
  let body: { error?: string; lines?: AzureLine[] } = {};
  try { body = await res.json(); } catch { /* the message below */ }
  if (!res.ok) throw new Error(body.error || `Azure OCR failed (HTTP ${res.status})`);
  const words = azureLinesToWords(body.lines || [], raster.geometry);
  return boxWords(words);
}

export type AzureReadResult = Exclude<ImportRoute, { kind: "ocr" }> | { kind: "cancelled" };

/** The box read with Azure, then the same finish reader as on-device. */
export async function readBoxWithAzure(steps: {
  readWords: (signal: AbortSignal) => Promise<OcrWord[]>;
  read: (spans: GraphSpan[]) => ScheduleRead;
  isCurrent: () => boolean;
  signal: AbortSignal;
}): Promise<AzureReadResult> {
  const { readWords, read, isCurrent, signal } = steps;
  try {
    const words = await readWords(signal);
    if (signal.aborted || !isCurrent()) return { kind: "cancelled" };
    const spans = wordsToSpans(words);
    return routeOcrRead(read(spans), spans);
  } catch (e) {
    if (signal.aborted || !isCurrent() || (e as { name?: string })?.name === "AbortError") return { kind: "cancelled" };
    return { kind: "message", text: `Couldn't read that box with Azure (${e instanceof Error ? e.message : String(e)}).` };
  }
}
