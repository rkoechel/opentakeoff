// Hide sheet was retired in favor of the sheet tree's delete (upstream page
// tools). Projects saved before that still carry `hidden_sheets`; they must
// open cleanly, show every sheet, and lose the key on the next save.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TAKEOFF_SCHEMA } from "../src/lib/takeoffConstants.ts";
import { buildTakeoffDocument } from "../src/lib/takeoffDocument.js";
import { parseTakeoffImport, mergeTakeoffImport } from "../src/lib/importTakeoff.js";
import { sanitizeNtsSheets } from "../src/lib/scaleReview.ts";
import { readAutoTakeoff } from "../src/lib/aiDraft.js";
import { sanitizeSheetLevels } from "../src/lib/sheetLevels.js";

const LEGACY = {
  schema: TAKEOFF_SCHEMA,
  project_name: "Saved before Hide sheet was retired",
  sheets: [{ sheet_id: "a.pdf", units_per_px: 0.05 }],
  conditions: [{ id: "c1", finish_tag: "CPT-1" }],
  shapes: [{ id: "s1", sheet_id: "a.pdf", condition_id: "c1", verts_norm: [[0, 0], [1, 0], [1, 1]], computed: { area_sf: 10 } }],
  markups: [], rfis: [],
  sheet_group: ["a.pdf"], last_group: ["a.pdf"], sheet_tabs: ["a.pdf"],
  sheet_levels: { "a.pdf": "L1" },
  nts_sheets: ["a.pdf#2"],
  hidden_sheets: ["a.pdf#3", "b.pdf", 7, null],
  floor360AutoTakeoff: { status: "draft", runId: "r1", findings: [{ kind: "no_scale", sheet: "a.pdf#3", message: "No scale" }] },
};

// what the canvas hydrate reads, then what its next save writes
function loadThenSave(doc: Record<string, unknown>) {
  return buildTakeoffDocument({
    project_name: doc.project_name, sheets: doc.sheets, conditions: doc.conditions, shapes: doc.shapes,
    markups: doc.markups, rfis: doc.rfis, sheet_group: doc.sheet_group, last_group: doc.last_group, sheet_tabs: doc.sheet_tabs,
    sheet_levels: sanitizeSheetLevels(doc.sheet_levels), nts_sheets: sanitizeNtsSheets(doc.nts_sheets),
    floor360AutoTakeoff: readAutoTakeoff(doc),
  });
}

test("a legacy document with hidden_sheets loads and saves without it", () => {
  const doc = parseTakeoffImport(JSON.stringify(LEGACY));
  assert.deepEqual(doc.hidden_sheets, LEGACY.hidden_sheets, "parsing tolerates the key");
  const saved = loadThenSave(doc);
  assert.equal("hidden_sheets" in saved, false);
  assert.deepEqual(saved.nts_sheets, ["a.pdf#2"]);
  assert.deepEqual(saved.sheet_levels, { "a.pdf": "L1" });
  assert.equal(saved.shapes.length, 1);
  assert.equal(saved.floor360AutoTakeoff.findings.length, 1, "a finding on a once-hidden sheet still shows");
  assert.deepEqual(loadThenSave(saved), saved, "the next save is stable");
});

test("importing a legacy document into a project does not carry hidden_sheets", () => {
  const current = buildTakeoffDocument({});
  const { payload } = mergeTakeoffImport(current, parseTakeoffImport(JSON.stringify(LEGACY)));
  assert.equal("hidden_sheets" in buildTakeoffDocument(payload), false);
});

test("the canvas no longer reads or writes hidden_sheets", () => {
  const src = readFileSync(new URL("../src/pages/TakeoffCanvas.jsx", import.meta.url), "utf8");
  assert.equal(/hidden_sheets|hiddenSheets|lib\/hiddenSheets/.test(src), false);
  const nav = readFileSync(new URL("../src/components/PlanNavigator.jsx", import.meta.url), "utf8");
  assert.equal(/hiddenSheets|onToggleHidden|Show hidden/.test(nav), false);
});
