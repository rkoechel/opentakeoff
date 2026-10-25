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

async function request(extra: Record<string, unknown> = {}) {
  const annotations = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
  return parseShopDrawingsRequest({
    annotations,
    bid: { projectName: "Synthetic Fixture", bidNumber: "SYN-1", drawnBy: "Estimator", checkedBy: "Reviewer", rev: "0", date: "2026-10-25" },
    ...extra,
  });
}

test("a draft set is ANSI B, numbered SD-000 and SD-101, and marked DRAFT", async () => {
  const model = buildShopModel(await request(), {}, new Date("2026-10-25T00:00:00Z"));
  assert.match(coverNotes(model).join("\n"), /DRAFT until a named FLOOR360 estimator/);
  assert.match(coverNotes(model).join("\n"), /does not send drawings/);
  assert.match(coverNotes(model).join("\n"), /TBD \u2013 verify/);
  const { pdf, specs } = await renderShopDrawings(model);
  assert.deepEqual(specs.map((s) => s.number), ["SD-000", "SD-101"]);
  const doc = await PDFDocument.load(pdf);
  assert.equal(doc.getPageCount(), 2);
  assert.equal(doc.getPage(0).getWidth(), PAGE_W);
  assert.equal(doc.getPage(0).getHeight(), PAGE_H);
  assert.equal(doc.getPage(1).getWidth(), PAGE_W);
  assert.match(doc.getSubject() ?? "", /SD-000 SD-101/);
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

test("a confirmed scale is printed; a detected-only scale never becomes a PDF", async () => {
  const confirmed = buildShopModel(await request(), {}, new Date("2026-10-25T00:00:00Z"));
  assert.match(confirmed.sheets[0]!.scaleNote, /Scale source: confirmed/);
  assert.match(confirmed.sheets[0]!.scaleNote, /ft per inch/);
  const { pdf } = await renderShopDrawings(confirmed);
  assert.ok(pdf.byteLength > 1000);

  const annotations = JSON.parse(await readFile(realPath, "utf8")) as Record<string, unknown>;
  const req = parseShopDrawingsRequest({
    annotations,
    bid: { projectName: "Sample finish plan", bidNumber: "DEMO-1", date: "2026-10-25" },
    sheetFrames: { "sample-finish-plan.pdf": { widthPx: 6048, heightPx: 4320 } },
  });
  let refused = "";
  try {
    const model = buildShopModel(req, {});
    await renderShopDrawings(model);
  } catch (e) {
    refused = e instanceof Error ? e.message : String(e);
  }
  assert.match(refused, /scale not confirmed/);
  assert.doesNotMatch(refused, /1\/8|ft per inch|Scale source|plotted to fit/);
});
