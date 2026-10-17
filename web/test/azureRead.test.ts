// "Hard scan? Read with Azure" in the browser (lib/ocr/azureRead.ts): the box
// is one PNG to this origin's /api/ocr/read, never an Azure host; Azure's
// pixel polygons map to OcrWords in image px as on-device crop boxes do; the
// DPI drops until the PNG fits; route errors read as the route wrote them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AZURE_READ_PATH, azureLinesToWords, azureOcrOffered, azureReadBox, readBoxWithAzure } from "../src/lib/ocr/azureRead.ts";
import type { RegionRaster } from "../src/lib/ocr/rasterize.ts";

const page = { getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }) } as never;
const g = { rect: { x0: 100, y0: 200, x1: 300, y1: 300 }, zoom: 2 };

test("polygons map through the raster geometry into image px", () => {
  const words = azureLinesToWords([{ content: " D1 ", polygon: [10, 20, 50, 20, 50, 40, 10, 40], confidence: 0.9 }, { content: "", polygon: [0, 0, 1, 0, 1, 1, 0, 1] }], g);
  assert.deepEqual(words, [{ str: "D1", x: 105, y: 220, w: 20, h: 10, confidence: 0.9 }]);
});

test("off unless the private build defines VITE_OCR_AZURE", () => {
  assert.equal(azureOcrOffered({}), false);
  assert.equal(azureOcrOffered({ VITE_OCR_AZURE: "1" }), true);
});

test("one same-origin POST, DPI dropped until the PNG fits", async () => {
  const dpis: number[] = [];
  const rasterize = async (_p: unknown, _rs: number, _r: unknown, o: { dpi?: number }) => {
    dpis.push(o.dpi!);
    const size = o.dpi! > 150 ? 64 : 8;
    return { width: 1, height: 1, rgba: new Uint8ClampedArray(4), geometry: g, png: Buffer.alloc(size).toString("base64") } as RegionRaster;
  };
  const urls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    urls.push(url);
    assert.equal(init.method, "POST");
    assert.equal(init.credentials, "same-origin");
    return Response.json({ lines: [{ content: "DOOR", polygon: [0, 0, 20, 0, 20, 10, 0, 10] }] });
  }) as unknown as typeof fetch;
  const words = await azureReadBox(page, 1.5, { x0: 0, y0: 0, x1: 10, y1: 10 }, undefined, { rasterize, fetchImpl, maxBytes: 32 });
  assert.deepEqual(dpis, [216, 150]);
  assert.deepEqual(urls, [AZURE_READ_PATH]);
  assert.deepEqual(words.map((w) => w.str), ["DOOR"]);
});

test("a route error becomes the box's message; an abort is cancelled", async () => {
  const fail = await readBoxWithAzure({ readWords: async () => { throw new Error("You've used today's 100 Azure OCR pages"); }, read: () => ({ rows: [] }) as never, isCurrent: () => true, signal: new AbortController().signal });
  assert.deepEqual(fail, { kind: "message", text: "Couldn't read that box with Azure (You've used today's 100 Azure OCR pages)." });
  const ac = new AbortController(); ac.abort();
  const gone = await readBoxWithAzure({ readWords: async () => [], read: () => ({ rows: [] }) as never, isCurrent: () => true, signal: ac.signal });
  assert.deepEqual(gone, { kind: "cancelled" });
});
