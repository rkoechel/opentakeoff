// Open a run's outputs the way the browser does: the web app's real
// cloudStore over a fake drive laid out as Bids saves the job folder
// (PDFs in the folder, annotations.json + sheets.json in .opentakeoff/), then
// the app's own import parser and merge.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createCloudStore } from "../../../web/src/lib/cloudStore.js";
import { mergeTakeoffImport, parseTakeoffImport } from "../../../web/src/lib/importTakeoff.js";
import { emptyAnnotations } from "../../../web/src/lib/store.js";

const FOLDER = "application/vnd.google-apps.folder";

/** The Graph/Drive client surface cloudStore reads through, over a Map. */
export function jobFolderDrive(pdfs: Record<string, Uint8Array>, annotations: unknown, sheets: unknown) {
  const items = new Map<string, { id: string; name: string; parent: string; mimeType: string; bytes?: Uint8Array; json?: unknown }>();
  items.set("SIDE", { id: "SIDE", name: ".opentakeoff", parent: "JOB", mimeType: FOLDER });
  let n = 0;
  const ids: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(pdfs)) {
    const id = `PDF${++n}`;
    ids[name] = id;
    items.set(id, { id, name, parent: "JOB", mimeType: "application/pdf", bytes });
  }
  items.set("ANN", { id: "ANN", name: "annotations.json", parent: "SIDE", mimeType: "application/json", json: annotations });
  items.set("SHEETS", { id: "SHEETS", name: "sheets.json", parent: "SIDE", mimeType: "application/json", json: typeof sheets === "function" ? sheets(ids) : sheets });
  const drive = {
    async findChild(parent: string, name: string) {
      for (const it of items.values()) if (it.parent === parent && it.name === name) return { id: it.id, name: it.name, mimeType: it.mimeType, modifiedTime: "2026-10-17T19:30:00Z" };
      return null;
    },
    async listChildren(parent: string) {
      return [...items.values()].filter((it) => it.parent === parent).map((it) => ({ id: it.id, name: it.name, mimeType: it.mimeType, modifiedTime: "t" }));
    },
    async getJson(id: string) {
      const it = items.get(id);
      if (!it) throw new Error("HTTP 404");
      return JSON.parse(JSON.stringify(it.json));
    },
    async getFileBytes(id: string) {
      const it = items.get(id);
      if (!it?.bytes) throw new Error(`HTTP 400: no item ${String(id)}`);
      return new Uint8Array(it.bytes);
    },
    async createFolder() { throw new Error("read-only test drive"); },
    async putJson() { throw new Error("read-only test drive"); },
  };
  return { drive, ids };
}

const noLocal = new Proxy({}, { get: () => () => Promise.resolve([]) });

/** Assert the browser opens the outputs: annotations load, the sheet list is
 *  the PDFs, every shape's sheet is one of them, the app's import accepts the
 *  file and merges it into an empty project losslessly. */
export async function assertBrowserOpens(outputsDir: string, pdfs: Record<string, Uint8Array>) {
  const ann = JSON.parse(await readFile(path.join(outputsDir, "annotations.json"), "utf8"));
  const sheetsOut = JSON.parse(await readFile(path.join(outputsDir, "sheets.json"), "utf8"));
  // what Bids does on save (CONTRACT.md): each id becomes the uploaded driveItem id
  const { drive } = jobFolderDrive(pdfs, ann, (ids: Record<string, string>) => ({ files: sheetsOut.files.map((f: { name: string }) => ({ ...f, id: ids[f.name] })) }));
  const store = createCloudStore("JOB", drive as never, { local: noLocal as never });
  const loaded = await store.loadAnnotations();
  assert.equal(loaded.schema, "opentakeoff.takeoff_canvas.v1");
  assert.equal(loaded.floor360AutoTakeoff?.status, "draft", "the draft marker rides through the loader");
  const names = (await store.listSheets()).map((s: { name: string }) => s.name);
  assert.deepEqual(names.sort(), Object.keys(pdfs).sort());
  for (const name of names) assert.deepEqual(await store.loadPdfData(name), pdfs[name], `${name} downloads by its id`);
  for (const s of loaded.shapes) assert.ok(names.includes(String(s.sheet_id).split("#")[0]), `shape ${s.id} sits on a sheet in the set`);
  const doc = parseTakeoffImport(JSON.stringify(loaded));
  const { payload, note } = mergeTakeoffImport(emptyAnnotations(), doc, names);
  assert.equal(note.replaced, true);
  assert.deepEqual(note.unknown_files, []);
  assert.equal(payload.shapes.length, loaded.shapes.length);
  assert.equal(payload.conditions.length, loaded.conditions.length);
  return { loaded, sheetsOut };
}
