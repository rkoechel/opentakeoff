// The scan star geometry behind the exported PDF watermark (lib/pdfWatermark.js). The stamp
// draws nothing unless OT_WATERMARK (or VITE_OT_WATERMARK) is 1 or true.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import { scanStarRows } from "../src/lib/scanStar.js";
import { stampWatermark, STAR_OPACITY } from "../src/lib/pdfWatermark.js";

test("scanStarRows: the centre row runs tip to tip, rows mirror about it and narrow toward the points", () => {
  for (const [n, reach] of [[7, 1], [11, 1.6], [23, 2.4]]) {
    const rows = scanStarRows(n, reach);
    const mid = (n - 1) / 2;
    assert.equal(rows.length, n);
    assert.equal(rows[mid].w, 2 * reach);
    for (let i = 0; i < mid; i++) {
      assert.ok(Math.abs(rows[i].w - rows[n - 1 - i].w) < 1e-9, "mirrored");
      assert.ok(rows[i].w <= rows[i + 1].w, "narrows toward the top point");
      assert.ok(rows[i].x >= -reach && rows[i].y >= -1 && rows[i].y + rows[i].h <= 1, "inside its box");
    }
  }
});

async function withWatermarkFlag(value: string | undefined, fn: () => Promise<void>) {
  const prev = process.env.OT_WATERMARK, prevVite = process.env.VITE_OT_WATERMARK;
  delete process.env.VITE_OT_WATERMARK;
  if (value === undefined) delete process.env.OT_WATERMARK;
  else process.env.OT_WATERMARK = value;
  try { await fn(); } finally {
    if (prev === undefined) delete process.env.OT_WATERMARK;
    else process.env.OT_WATERMARK = prev;
    if (prevVite === undefined) delete process.env.VITE_OT_WATERMARK;
    else process.env.VITE_OT_WATERMARK = prevVite;
  }
}

test("watermark default: with the flag unset the stamp draws nothing", () => withWatermarkFlag(undefined, async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);
  let drawn = 0;
  page.drawRectangle = () => { drawn++; };
  page.drawText = () => { drawn++; };
  stampWatermark(page, { font, rgb, degrees });
  assert.equal(drawn, 0);
}));

test("watermark (flag on): every page gets the centre star and the footer star, on a rotated sheet too", () => withWatermarkFlag("1", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const [size, rot] of [[[612, 792], 0], [[792, 612], 90]] as const) {
    const page = doc.addPage([...size]); page.setRotation(degrees(rot));
    const rects: any[] = [];
    const real = page.drawRectangle.bind(page);
    page.drawRectangle = (o: any) => { rects.push(o); real(o); };
    stampWatermark(page, { font, rgb, degrees });
    assert.equal(rects.filter((r) => r.opacity === STAR_OPACITY).length, 23, "centre star: 23 faint rows");
    assert.equal(rects.filter((r) => r.opacity === undefined).length, 7, "footer star: 7 solid rows");
    assert.ok(rects.every((r) => r.rotate.angle === rot), "rows follow the page's /Rotate");
  }
}));
