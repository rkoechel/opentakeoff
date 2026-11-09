// The marked-set cover prints the project name it was given, and "Untitled
// project" only when that name is genuinely absent. The canvas resolves a
// blank report label to the cloud folder name before it calls the builder.
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PDFDocument, PDFName } from "pdf-lib";
import { inflateSync } from "node:zlib";
import { buildMarkedSetPdf, markedSetCoverName } from "../src/lib/markedset.js";
import { createCloudStore } from "../src/lib/cloudStore.js";

test("markedSetCoverName prefers a typed name, then the folder, then nothing", () => {
  assert.equal(markedSetCoverName("  Clinic Remodel  ", "Other"), "Clinic Remodel");
  assert.equal(markedSetCoverName("", "  Acme HQ  "), "Acme HQ");
  assert.equal(markedSetCoverName("   ", "Acme HQ"), "Acme HQ");
  assert.equal(markedSetCoverName(undefined, undefined), "");
  assert.equal(markedSetCoverName("", ""), "");
});

async function coverText(projectName: string) {
  const source = await PDFDocument.create();
  source.addPage([300, 200]);
  const sourceBytes = await source.save();
  const conditions = [{ id: "c", finish_tag: "CPT-1", color: "#2563eb", multiplier: 1 }];
  const shapes = [{ id: "s1", sheet_id: "sample.pdf", condition_id: "c", measure_role: "count", computed: { count: 1 }, verts_norm: [[0.2, 0.3]] }];
  const built = await buildMarkedSetPdf({
    projectName, dark: false, sheets: [{ key: "sample.pdf", file: "sample.pdf", page: 1, label: "A-101" }],
    shapes, markups: [], conditions, company: null, clientInfo: null,
    loadPdfData: async () => sourceBytes,
    getPage: async () => ({ rotate: 0, getViewport: ({ scale }: { scale: number }) => ({ width: 300 * scale, height: 200 * scale, transform: [scale, 0, 0, -scale, 0, 200 * scale] }) }),
  });
  const out = await PDFDocument.load(built.bytes, { updateMetadata: false });
  const page: any = out.getPages()[0];
  let raw = "";
  for (const ref of page.node.Contents().asArray()) {
    const stream: any = out.context.lookup(ref);
    const filter = stream.dict.lookup(PDFName.of("Filter"));
    raw += Buffer.from(String(filter) === "/FlateDecode" ? inflateSync(stream.contents) : stream.contents).toString("latin1");
  }
  const text = (raw.match(/<[0-9A-Fa-f]+>/g) || []).map((h) => Buffer.from(h.slice(1, -1), "hex").toString("latin1")).join("");
  return { text, filename: built.filename, producer: out.getProducer(), creator: out.getCreator() };
}

test("the cover uses the project name when one is set", async () => {
  const cover = await coverText("Clinic Remodel");
  assert.match(cover.text, /Clinic Remodel/);
  assert.equal(cover.text.includes("Untitled project"), false);
  assert.equal(cover.filename, "Clinic Remodel - marked set.pdf");
  assert.equal(cover.producer, "FLOOR360");
  assert.equal(cover.creator, "FLOOR360");
});

test("the cover says Untitled project only when the name is absent", async () => {
  for (const blank of ["", "   "]) {
    const cover = await coverText(blank);
    assert.match(cover.text, /Untitled project/);
    assert.equal(cover.filename, "marked set.pdf");
    assert.equal(cover.producer, "FLOOR360");
    assert.equal(cover.creator, "FLOOR360");
  }
});

test("the canvas passes the folder name into both marked-set builds", () => {
  const src = readFileSync(new URL("../src/pages/TakeoffCanvas.jsx", import.meta.url), "utf8");
  const uses = src.match(/markedSetCoverName\(projectName, cloudFolderName\)/g) || [];
  assert.equal(uses.length, 2);
});

test("a cloud store reads the job folder name and survives a lookup failure", async () => {
  const named = createCloudStore("job-1", { getItem: async (id: string) => ({ id, name: "  Acme HQ  " }) } as any);
  assert.equal(await named.folderName(), "Acme HQ");
  const down = createCloudStore("job-1", { getItem: async () => { throw new Error("offline"); } } as any);
  assert.equal(await down.folderName(), "");
});
