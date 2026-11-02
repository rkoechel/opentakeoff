// The document watermark is off unless VITE_OT_WATERMARK or OT_WATERMARK is
// exactly "1" or "true". Off leaves the page and the xlsx footer untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import { unzipSync, strFromU8 } from "fflate";
import { OT_NAME, OT_WATERMARK, watermarkEnabled, xlsxWatermarkFooter } from "../src/lib/branding.js";
import { stampWatermark, STAR_OPACITY } from "../src/lib/pdfWatermark.js";
import { buildXlsx } from "../src/lib/xlsx.js";

const KEYS = ["VITE_OT_WATERMARK", "OT_WATERMARK"] as const;

function withFlags(values: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const prev = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) {
    if (values[k] === undefined) delete process.env[k];
    else process.env[k] = values[k];
  }
  const finish = () => {
    for (const k of KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  };
  try {
    const out = fn();
    if (out && typeof (out as Promise<void>).then === "function") return (out as Promise<void>).finally(finish);
    finish();
  } catch (err) {
    finish();
    throw err;
  }
}

test("the web build inlines VITE_OT_WATERMARK and leaves it off when unset", () => {
  const cfg = readFileSync(new URL("../vite.config.js", import.meta.url), "utf8");
  assert.match(cfg, /\["import\.meta\.env\.VITE_OT_WATERMARK"\]/);
  assert.match(cfg, /watermarkFlag === "1" \|\| watermarkFlag === "true"/);
});

async function page() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const pg = doc.addPage([612, 792]);
  const texts: string[] = [];
  const rects: Array<{ opacity?: number } | undefined> = [];
  const drawText = pg.drawText.bind(pg);
  const drawRectangle = pg.drawRectangle.bind(pg);
  pg.drawText = (text: string, opts: Parameters<typeof pg.drawText>[1]) => {
    texts.push(text);
    drawText(text, opts);
  };
  pg.drawRectangle = (opts: Parameters<typeof pg.drawRectangle>[0]) => {
    rects.push(opts);
    drawRectangle(opts);
  };
  return { doc, pg, font, texts, rects };
}

test("flag off leaves the page and the workbook untouched; flag on draws the upstream mark", async () => {
  await withFlags({}, async () => {
    assert.equal(watermarkEnabled(), false);
    assert.deepEqual(xlsxWatermarkFooter(), []);
    for (const key of KEYS) {
      for (const off of ["", "0", "false", "TRUE", "yes", "on"]) {
        process.env[key] = off;
        assert.equal(watermarkEnabled(), false, `${key}=${off}`);
      }
      delete process.env[key];
    }
    process.env.OT_WATERMARK = "1";
    assert.equal(watermarkEnabled(), true);
    delete process.env.OT_WATERMARK;
    process.env.VITE_OT_WATERMARK = "true";
    assert.equal(watermarkEnabled(), true);
    delete process.env.VITE_OT_WATERMARK;
    assert.equal(watermarkEnabled(), false);
    const { doc, pg, font, texts, rects } = await page();
    stampWatermark(pg, { font, rgb, degrees });
    assert.deepEqual(texts, []);
    assert.deepEqual(rects, []);
    const bytes = await doc.save();
    assert.equal(Buffer.from(bytes).includes("Prepared with OpenTakeoff"), false);
    assert.equal(Buffer.from(bytes).includes("OpenTakeoff"), false);

    const foot = xlsxWatermarkFooter();
    assert.deepEqual(foot, []);
    const xlsx = await buildXlsx([{ name: "Estimate", rows: [["Estimate", "Sample"], ...foot] }]);
    const xml = strFromU8(unzipSync(xlsx)["xl/worksheets/sheet1.xml"]);
    assert.equal(xml.includes("Prepared with OpenTakeoff"), false);
    assert.equal(xml.includes(OT_WATERMARK), false);
  });

  await withFlags({ VITE_OT_WATERMARK: "1" }, async () => {
    assert.equal(watermarkEnabled(), true);
    const { doc, pg, font, texts, rects } = await page();
    stampWatermark(pg, { font, rgb, degrees });
    assert.ok(texts.includes(OT_NAME));
    assert.ok(texts.includes(OT_WATERMARK));
    assert.equal(rects.filter((r) => r?.opacity === STAR_OPACITY).length, 23);
    assert.equal(rects.filter((r) => r != null && r.opacity === undefined).length, 7);
    const stamped = Buffer.from(await doc.save());
    const bare = await PDFDocument.create();
    bare.addPage([612, 792]);
    const plain = Buffer.from(await bare.save());
    assert.ok(stamped.length > plain.length, "the stamped page is larger than a blank page");
    assert.equal(texts.includes(OT_WATERMARK), true);

    const rotated = await PDFDocument.create();
    const rfont = await rotated.embedFont(StandardFonts.Helvetica);
    const rpage = rotated.addPage([792, 612]);
    rpage.setRotation(degrees(90));
    const rtexts: string[] = [];
    rpage.drawText = (text: string) => {
      rtexts.push(text);
    };
    stampWatermark(rpage, { font: rfont, rgb, degrees });
    assert.ok(rtexts.includes(OT_WATERMARK));

    const foot = xlsxWatermarkFooter();
    assert.deepEqual(foot, [[], [OT_WATERMARK]]);
    const xlsx = await buildXlsx([{ name: "Estimate", rows: [["Estimate", "Sample"], ...foot] }]);
    const xml = strFromU8(unzipSync(xlsx)["xl/worksheets/sheet1.xml"]);
    assert.equal(xml.includes(OT_WATERMARK), true);
    assert.equal(xml.includes("Prepared with OpenTakeoff"), true);
  });
});
