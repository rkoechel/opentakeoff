// Marked Set legend: Finish TBD rooms (AI-drawn, no finish yet, Ryan 2026-10-18) print "Finish TBD (not priced)", never their square footage or a waste allowance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, PDFName } from "pdf-lib";
import { inflateSync } from "node:zlib";
import { buildMarkedSetPdf } from "../src/lib/markedset.js";

const hex = (s: string) => Buffer.from(s).toString("hex").toUpperCase();

test("marked set legend: Finish TBD prints (not priced), no square footage; priced finishes unchanged", async () => {
  const source = await PDFDocument.create(); source.addPage([300, 200]);
  const sourceBytes = await source.save();
  const conditions = [{ id: "c1", finish_tag: "CPT-1", color: "#2563eb", multiplier: 1, waste_pct: 10 }, { id: "c9", finish_tag: "FINISH-TBD", color: "#8a8f98", multiplier: 1, waste_pct: 10, finishStatus: "tbd" }];
  const shapes = [
    { id: "s1", sheet_id: "sample.pdf", condition_id: "c1", measure_role: "floor_area", computed: { area_sf: 200 }, verts_norm: [[0.1, 0.1], [0.4, 0.1], [0.4, 0.4], [0.1, 0.4]] },
    { id: "s2", sheet_id: "sample.pdf", condition_id: "c9", measure_role: "floor_area", finishStatus: "tbd", computed: { area_sf: 777 }, verts_norm: [[0.5, 0.5], [0.8, 0.5], [0.8, 0.8], [0.5, 0.8]] },
  ];
  const { bytes } = await buildMarkedSetPdf({ projectName: "TBD test", dark: false, sheets: [{ key: "sample.pdf", file: "sample.pdf", page: 1, label: "A-101" }], shapes, markups: [], conditions, company: null, clientInfo: null,
    loadPdfData: async () => sourceBytes, getPage: async () => ({ rotate: 0, getViewport: ({ scale }: { scale: number }) => ({ width: 300 * scale, height: 200 * scale, transform: [scale, 0, 0, -scale, 0, 200 * scale] }) }) });
  const out = await PDFDocument.load(bytes);
  let contents = "";
  for (const page of out.getPages() as any[]) {
    for (const ref of page.node.Contents().asArray()) {
      const stream: any = out.context.lookup(ref), filter = stream.dict.lookup(PDFName.of("Filter"));
      contents += Buffer.from(String(filter) === "/FlateDecode" ? inflateSync(stream.contents) : stream.contents).toString("latin1");
    }
  }
  assert.ok(contents.includes(hex("Finish TBD (not priced)")), "the TBD row says it is not priced");
  // legend rows are their own text runs; the plan sheet still labels the TBD outline with its measured size ("FINISH-TBD · 777 SF"), which is geometry, not price
  const runs = [...contents.matchAll(/<([0-9A-F]+)> Tj/g)].map((x) => Buffer.from(x[1], "hex").toString("latin1"));
  assert.deepEqual(runs.filter((t) => /777/.test(t) && !t.startsWith("FINISH-TBD · ")), [], "no TBD square footage or waste allowance in the legend");
  assert.ok(contents.includes(hex("200 SF")), "the priced finish still prints its quantity");
});
