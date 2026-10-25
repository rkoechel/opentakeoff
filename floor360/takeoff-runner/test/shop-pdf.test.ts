// The PDF itself: page size, sheet numbers, DRAFT vs an approval stamp, Brandon Text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { buildShopModel } from "../src/shopdrawings/model.ts";
import { PAGE_H, PAGE_W } from "../src/shopdrawings/page.ts";
import { coverNotes, renderShopDrawings } from "../src/shopdrawings/pdf.ts";
import { parseShopDrawingsRequest } from "../src/shopdrawings/request.ts";

/** Subset fonts hide the family name inside a compressed stream. The font dictionary does not. */
function embeddedFontNames(doc: PDFDocument): string[] {
  const names: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const base = obj.lookupMaybe(PDFName.of("BaseFont"), PDFName);
    if (base) names.push(base.decodeText());
  }
  return names;
}

const fixturePath = fileURLToPath(new URL("./fixtures/synthetic-annotations.json", import.meta.url));
const realPath = fileURLToPath(new URL("../../../evals/mcp-workflow-bench/plan-set/human-review-2026-09-12/takeoff-after-review.json", import.meta.url));
const samplePdf = fileURLToPath(new URL("../../../demo/sample-finish-plan.pdf", import.meta.url));

async function request(extra: Record<string, unknown> = {}) {
  const annotations = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
  return parseShopDrawingsRequest({
    annotations,
    bid: { projectName: "Synthetic Fixture", bidNumber: "SYN-1", drawnBy: "Estimator", checkedBy: "Reviewer", rev: "0", date: "2026-10-25" },
    ...extra,
  });
}

test("a draft set is ANSI B, numbered SD-000, SD-101 and SD-401, and marked DRAFT", async () => {
  const model = buildShopModel(await request(), {}, new Date("2026-10-25T00:00:00Z"));
  assert.match(coverNotes(model).join("\n"), /DRAFT until a named FLOOR360 estimator/);
  assert.match(coverNotes(model).join("\n"), /does not send drawings/);
  assert.match(coverNotes(model).join("\n"), /TBD \u2013 verify/);
  const { pdf, specs } = await renderShopDrawings(model);
  assert.deepEqual(specs.map((s) => s.number), ["SD-000", "SD-101", "SD-401"]);
  const doc = await PDFDocument.load(pdf);
  assert.equal(doc.getPageCount(), 3);
  assert.equal(doc.getPage(0).getWidth(), PAGE_W);
  assert.equal(doc.getPage(0).getHeight(), PAGE_H);
  assert.equal(doc.getPage(1).getWidth(), PAGE_W);
  assert.match(doc.getSubject() ?? "", /SD-000 SD-101 SD-401/);
  assert.match((doc.getKeywords() ?? "").toUpperCase(), /DRAFT/);
  assert.match(embeddedFontNames(doc).join(" "), /BrandonText/);
  assert.equal(doc.getAuthor(), "FLOOR360");
});

test("an approval stamp removes the DRAFT keyword and names the approver", async () => {
  const model = buildShopModel(await request({ approval: { name: "Casey Estimator", at: "2026-10-25" } }), {});
  assert.match(coverNotes(model).join("\n"), /APPROVED FOR INSTALL by Casey Estimator/);
  const { pdf } = await renderShopDrawings(model);
  const doc = await PDFDocument.load(pdf);
  const keys = doc.getKeywords() ?? "";
  assert.match(keys, /Casey Estimator/);
  assert.match(keys, /APPROVED/);
  assert.doesNotMatch(keys, /DRAFT/);
});

const fixtureProducts = {
  products: [
    { finishTag: "CPT-1", rollWidthFt: 12, nap: "ew", material: "carpet", product: "Broadloom" },
    { finishTag: "LVT-1", tileWidthIn: 7, tileHeightIn: 48, pattern: "ashlar", product: "LVT plank" },
    { finishTag: "VCT-1", tileWidthIn: 12, tileHeightIn: 12, pattern: "stacked", product: "VCT" },
  ],
  base: { tag: "RB-1", description: "rubber 4\"" },
  transitions: [{ between: ["CPT-1", "LVT-1"], type: "reducer" }],
};

test("product data adds the seam and pattern sheets", async () => {
  const model = buildShopModel(await request(fixtureProducts), {}, new Date("2026-10-25T00:00:00Z"));
  const { pdf, specs } = await renderShopDrawings(model);
  assert.deepEqual(specs.map((s) => s.number), ["SD-000", "SD-101", "SD-201", "SD-301", "SD-401"]);
  const doc = await PDFDocument.load(pdf);
  assert.equal(doc.getPageCount(), 5);
  assert.match(doc.getSubject() ?? "", /SD-201 SD-301 SD-401/);
  assert.match((doc.getKeywords() ?? "").toUpperCase(), /DRAFT/);
  if (process.env.SHOP_DRAWINGS_ARTIFACT) {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(process.env.SHOP_DRAWINGS_ARTIFACT, { recursive: true });
    await writeFile(`${process.env.SHOP_DRAWINGS_ARTIFACT}/shop-drawings-synthetic.pdf`, pdf);
  }
});

test("the reviewed sample plan renders a cover, a finish plan and transitions", async () => {
  const annotations = JSON.parse(await readFile(realPath, "utf8")) as Record<string, unknown>;
  const bytes = new Uint8Array(await readFile(samplePdf));
  const src = await PDFDocument.load(bytes);
  const size = src.getPage(0).getSize();
  const req = parseShopDrawingsRequest({
    annotations,
    bid: { projectName: "Sample finish plan", bidNumber: "DEMO-1", date: "2026-10-25", drawnBy: "Estimator" },
    sheetFrames: { "sample-finish-plan.pdf": { widthPx: size.width * 2, heightPx: size.height * 2 } },
  });
  const model = buildShopModel(req, {}, new Date("2026-10-25T00:00:00Z"));
  const { pdf, specs } = await renderShopDrawings(model, {
    underlays: { "sample-finish-plan.pdf": { pdf: bytes, pageIndex: 0 } },
  });
  assert.deepEqual(specs.map((s) => `${s.number} ${s.series}`), ["SD-000 cover", "SD-101 finish", "SD-401 transitions"]);
  const doc = await PDFDocument.load(pdf);
  assert.equal(doc.getPageCount(), 3);
  assert.ok(pdf.byteLength > 50_000, "the source plan is embedded, so the file is larger than a blank sheet");
  if (process.env.SHOP_DRAWINGS_ARTIFACT) {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(process.env.SHOP_DRAWINGS_ARTIFACT, { recursive: true });
    await writeFile(`${process.env.SHOP_DRAWINGS_ARTIFACT}/shop-drawings-finish.pdf`, pdf);
  }
});
