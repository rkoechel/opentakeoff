// Geometry of the synthetic fixture: scale gate, sheet numbers, start point,
// check dimension. The fixture is labeled synthetic and is not a real bid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { checkEdge, longestEdgeIndex, perimeterFt, tileStart } from "../src/shopdrawings/geometry.ts";
import { buildShopModel, ShopDrawingsRefusal } from "../src/shopdrawings/model.ts";
import { planSheets, sheetNumber } from "../src/shopdrawings/numbering.ts";
import { hatchSegments, pointInPoly } from "../src/shopdrawings/hatch.ts";
import { fitSheet, PAGE_H, PAGE_W, planFrame } from "../src/shopdrawings/page.ts";
import { parseShopDrawingsRequest } from "../src/shopdrawings/request.ts";
import { scaleRefusal, sourceScaleLabel } from "../src/shopdrawings/scale.ts";
import { feetInches } from "../src/shopdrawings/text.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/synthetic-annotations.json", import.meta.url));
const realPath = fileURLToPath(new URL("../../../evals/mcp-workflow-bench/plan-set/human-review-2026-09-12/takeoff-after-review.json", import.meta.url));

async function synthetic(extra: Record<string, unknown> = {}) {
  const annotations = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
  return parseShopDrawingsRequest({
    annotations,
    bid: { projectName: "Synthetic Fixture", bidNumber: "SYN-1", rev: "0", date: "2026-10-25" },
    ...extra,
  });
}

test("ANSI B is 17 by 11 inches, and a sheet fits uniformly", () => {
  assert.equal(PAGE_W, 17 * 72);
  assert.equal(PAGE_H, 11 * 72);
  const fit = fitSheet(planFrame(), 2000, 1000);
  assert.ok(Math.abs(fit.w / fit.h - 2) < 1e-9, "aspect preserved");
  assert.ok(fit.w <= planFrame().w + 1e-6 && fit.h <= planFrame().h + 1e-6);
});

test("sheet numbers are SD-000, SD-101, SD-201, SD-301, SD-401", () => {
  assert.equal(sheetNumber("cover", 0), "SD-000");
  assert.equal(sheetNumber("finish", 1), "SD-101");
  assert.equal(sheetNumber("finish", 2), "SD-102");
  assert.equal(sheetNumber("roll", 1), "SD-201");
  assert.equal(sheetNumber("pattern", 1), "SD-301");
  assert.equal(sheetNumber("transitions", 1), "SD-401");
  const specs = planSheets({
    finish: ["b.pdf", "a.pdf"],
    roll: ["b.pdf"],
    pattern: ["a.pdf"],
    transitions: ["a.pdf", "b.pdf"],
  });
  assert.deepEqual(specs.map((s) => s.number), ["SD-000", "SD-101", "SD-102", "SD-201", "SD-301", "SD-401", "SD-402"]);
  assert.equal(specs[0]!.pages, 7);
  assert.equal(specs.at(-1)!.page, 7);
  assert.equal(specs[1]!.sourceSheetId, "a.pdf", "finish sheets follow sheet-key order");
  assert.throws(() => sheetNumber("finish", 100), /no number/);
});

test("scale gate refuses NTS and unconfirmed scales, and names the source scale", () => {
  assert.equal(scaleRefusal([{ sheetId: "A.pdf", upp: 0.02, scaleSource: "confirmed", scaleConfirmed: true, nts: false }]), null);
  assert.match(scaleRefusal([{ sheetId: "A.pdf", upp: 0.02, scaleSource: "confirmed", scaleConfirmed: true, nts: true }]) ?? "", /NTS or unconfirmed/);
  assert.match(scaleRefusal([{ sheetId: "A.pdf", upp: 0.02, scaleSource: "1/8\" = 1'-0\"", scaleConfirmed: false, nts: false }]) ?? "", /unconfirmed scale/);
  assert.match(scaleRefusal([{ sheetId: "A.pdf", upp: 0, scaleSource: "detected", scaleConfirmed: null, nts: false }]) ?? "", /no scale/);
  assert.equal(sourceScaleLabel(0.05555555555555555), '1/8" = 1\'-0"');
  assert.equal(sourceScaleLabel(0.02), "2.88 ft per inch");
  assert.equal(feetInches(24), "24'-0\"");
  assert.equal(feetInches(10.5), "10'-6\"");
});

test("synthetic lobby: check dimension 24 ft, start on the longest wall, override moves it", async () => {
  const req = await synthetic();
  const model = buildShopModel(req, {}, new Date("2026-10-25T12:00:00Z"));
  const sheet = model.sheets[0]!;
  assert.equal(sheet.rooms.length, 4);
  const lobby = sheet.rooms.find((r) => r.id === "room-lobby")!;
  assert.equal(lobby.nap, "ew");
  assert.equal(lobby.kind, "roll");
  assert.equal(longestEdgeIndex(lobby.ringFt), 0);
  const edge = checkEdge(sheet.rooms.map((r) => ({ label: r.label, ringFt: r.ringFt })));
  assert.equal(edge!.roomLabel, "SYNTHETIC LOBBY");
  assert.ok(Math.abs(edge!.lengthFt - 24) < 1e-9);
  assert.deepEqual(lobby.start.at, { x: 800, y: 200 });
  assert.equal(lobby.start.fromOverride, false);
  const closet = sheet.rooms.find((r) => r.id === "room-closet")!;
  assert.equal(closet.lowConfidence, true);
  assert.equal(sheet.rooms.find((r) => r.id === "room-lvt")!.lowConfidence, false);
  const office = sheet.rooms.find((r) => r.id === "room-office")!;
  assert.deepEqual(office.openings, [1]);
  const full = perimeterFt(office.ringFt);
  const net = perimeterFt(office.ringFt, office.openings);
  assert.ok(net < full);
  assert.match(model.warnings.join("\n"), /CPT-1 is roll goods and has no rollWidthFt/);
  assert.match(model.warnings.join("\n"), /VCT-1 has no tile size/);
  assert.match(model.warnings.join("\n"), /No nap was given for CPT-1/);
  assert.match(model.warnings.join("\n"), /No base type was given/);
  assert.equal(model.date, "2026-10-25");
  assert.equal(model.approval, null);

  const moved = buildShopModel(await synthetic({
    overrides: { rooms: { "room-lobby": { startEdge: 1, nap: "north-south" } } },
    products: [{ finishTag: "CPT-1", rollWidthFt: 12, nap: "ew", material: "carpet", product: "carpet" }],
  }), {});
  const lobby2 = moved.sheets[0]!.rooms.find((r) => r.id === "room-lobby")!;
  assert.equal(lobby2.nap, "ns");
  assert.equal(lobby2.rollWidthFt, 12);
  assert.deepEqual(lobby2.start.at, tileStart(lobby2.ringPx, { edge: 1 }).at);
  assert.deepEqual(lobby2.start.at, { x: 1400, y: 450 });
  assert.equal(lobby2.start.fromOverride, true);
  assert.doesNotMatch(moved.warnings.join("\n"), /CPT-1 is roll goods/);
});

test("hatch segments stay inside the polygon", () => {
  const poly = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 40 }, { x: 0, y: 40 }];
  const segs = hatchSegments(poly, "diag");
  assert.ok(segs.length > 0);
  for (const [a, b] of segs) {
    assert.equal(pointInPoly((a.x + b.x) / 2, (a.y + b.y) / 2, poly), true);
  }
  assert.deepEqual(hatchSegments(poly, "solid"), []);
});

test("NTS and unconfirmed sheets refuse the whole set; a missing page size refuses too", async () => {
  const nts = await synthetic();
  nts.annotations.nts_sheets = ["SYNTHETIC-PLAN.pdf"];
  assert.throws(() => buildShopModel(nts, {}), (e: unknown) => e instanceof ShopDrawingsRefusal && /NTS or unconfirmed/.test(e.message));

  const open = await synthetic();
  (open.annotations.sheets as { scale_confirmed?: boolean }[])[0]!.scale_confirmed = false;
  assert.throws(() => buildShopModel(open, {}), (e: unknown) => e instanceof ShopDrawingsRefusal && /unconfirmed scale/.test(e.message));

  const bare = await synthetic();
  delete (bare.annotations.sheets as Record<string, unknown>[])[0]!.width_px;
  delete (bare.annotations.sheets as Record<string, unknown>[])[0]!.height_px;
  assert.throws(() => buildShopModel(bare, {}), (e: unknown) => e instanceof ShopDrawingsRefusal && /no page size/.test(e.message));
});

test("the reviewed sample takeoff is accepted: scale_confirmed is absent, source is printed", async () => {
  const annotations = JSON.parse(await readFile(realPath, "utf8")) as Record<string, unknown>;
  const req = parseShopDrawingsRequest({
    annotations,
    bid: { projectName: "Sample finish plan", bidNumber: "DEMO-1", date: "2026-10-25" },
    sheetFrames: { "sample-finish-plan.pdf": { widthPx: 6048, heightPx: 4320 } },
  });
  const model = buildShopModel(req, {}, new Date("2026-10-25T00:00:00Z"));
  assert.equal(model.sheets.length, 1);
  assert.match(model.sheets[0]!.scaleNote, /detected/);
  assert.match(model.sheets[0]!.scaleNote, /1\/8" = 1'-0"/);
  assert.ok(model.sheets[0]!.rooms.some((r) => r.label === "OFFICE 136"));
  assert.equal(model.sheets[0]!.rooms.some((r) => r.lowConfidence), false);
  assert.match(model.warnings.join("\n"), /CPT-1 is roll goods and has no rollWidthFt/);
  assert.match(model.warnings.join("\n"), /VCT-1 has no tile size/);
  assert.match(model.warnings.join("\n"), /VCT-1 has no pattern named/);
});
