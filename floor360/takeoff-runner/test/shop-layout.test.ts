// Seam, pattern, base and transitions against the synthetic fixture.
// Roll lengths come from rollgoods.js; this file checks the sheet uses that
// answer, and that a 0.5 ft gap is a doorway while a shared edge is a butt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { computeRollLayout, seamLfBySrc } from "../../../web/src/lib/rollgoods.js";
import { tileStart } from "../src/shopdrawings/geometry.ts";
import { pointInPoly } from "../src/shopdrawings/hatch.ts";
import { baseRuns, ROLL_DEFAULTS, sheetRolls, sheetTransitions } from "../src/shopdrawings/layout.ts";
import { buildShopModel } from "../src/shopdrawings/model.ts";
import { patternBond, patternLines } from "../src/shopdrawings/pattern.ts";
import { parseShopDrawingsRequest } from "../src/shopdrawings/request.ts";
import { sheetGroups } from "../src/shopdrawings/series.ts";
import { round2 } from "../src/shopdrawings/text.ts";

const fixturePath = fileURLToPath(new URL("./fixtures/synthetic-annotations.json", import.meta.url));

const products = [
  { finishTag: "CPT-1", rollWidthFt: 12, nap: "ew", material: "carpet", product: "Broadloom" },
  { finishTag: "LVT-1", tileWidthIn: 7, tileHeightIn: 48, pattern: "ashlar", product: "LVT plank" },
  { finishTag: "VCT-1", tileWidthIn: 12, tileHeightIn: 12, pattern: "stacked", product: "VCT" },
];

async function model(extra: Record<string, unknown> = {}) {
  const annotations = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
  const req = parseShopDrawingsRequest({
    annotations,
    bid: { projectName: "Synthetic Fixture", bidNumber: "SYN-1" },
    products,
    transitions: [{ between: ["CPT-1", "LVT-1"], type: "reducer" }],
    base: { tag: "RB-1", description: "rubber 4\"" },
    ...extra,
  });
  return buildShopModel(req, {}, new Date("2026-10-25T00:00:00Z"));
}

test("without a roll width or a tile size those sheets are omitted", async () => {
  const annotations = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, unknown>;
  const req = parseShopDrawingsRequest({
    annotations,
    bid: { projectName: "Synthetic Fixture", bidNumber: "SYN-1" },
  });
  const groups = sheetGroups(buildShopModel(req, {}));
  assert.deepEqual(groups.roll, []);
  assert.deepEqual(groups.pattern, []);
  assert.deepEqual(groups.transitions, ["SYNTHETIC-PLAN.pdf"]);
  assert.match(buildShopModel(req, {}).warnings.join("\n"), /no rollWidthFt/);
  assert.match(buildShopModel(req, {}).warnings.join("\n"), /no tile size/);
});

test("east-west 12 ft roll of the 24 by 10 lobby is one cut and no seam", async () => {
  const built = await model();
  const sheet = built.sheets[0]!;
  const lobby = sheet.rooms.find((r) => r.id === "room-lobby")!;
  const roll = sheetRolls(sheet).find((r) => r.roomId === "room-lobby")!;
  assert.equal(roll.nap, "ew");
  assert.equal(roll.cuts.length, 1);
  assert.equal(roll.seamLf, 0);
  assert.equal(roll.seams.length, 0);
  const direct = computeRollLayout([{ id: lobby.id, name: lobby.label, ring: lobby.ringFt }], {
    rollWidthFt: 12,
    rollLengthFt: 0,
    seamAllowanceIn: ROLL_DEFAULTS.seamAllowanceIn,
    wallOverageIn: ROLL_DEFAULTS.wallOverageIn,
    doorwayOverageIn: ROLL_DEFAULTS.doorwayOverageIn,
    direction: "ew",
  });
  assert.equal(direct.strips.length, 1);
  assert.equal(seamLfBySrc(direct.strips).get(lobby.id) ?? 0, 0);
});

test("a north-south override seams, and the length matches rollgoods", async () => {
  const built = await model({ overrides: { rooms: { "room-lobby": { nap: "ns" } } } });
  const sheet = built.sheets[0]!;
  const lobby = sheet.rooms.find((r) => r.id === "room-lobby")!;
  const roll = sheetRolls(sheet).find((r) => r.roomId === "room-lobby")!;
  assert.equal(roll.nap, "ns");
  assert.ok(roll.cuts.length > 1, "a 24 ft room on a 12 ft roll needs more than one lane");
  assert.ok(roll.seamLf > 0);
  assert.equal(roll.seams.length, roll.cuts.length - 1);
  const direct = computeRollLayout([{ id: lobby.id, name: lobby.label, ring: lobby.ringFt }], {
    rollWidthFt: 12,
    rollLengthFt: 0,
    seamAllowanceIn: ROLL_DEFAULTS.seamAllowanceIn,
    wallOverageIn: ROLL_DEFAULTS.wallOverageIn,
    doorwayOverageIn: ROLL_DEFAULTS.doorwayOverageIn,
    direction: "ns",
  });
  const seam = round2(seamLfBySrc(direct.strips).get(lobby.id) ?? 0);
  assert.equal(roll.seamLf, seam);
  assert.equal(roll.cuts.length, direct.strips.length);
});

test("a shared edge is a numbered butt; the 0.5 ft gap is TBD", async () => {
  const built = await model();
  const marks = sheetTransitions(built, built.sheets[0]!);
  const butt = marks.find((m) => m.kind === "butt" && m.between.includes("CPT-1") && m.between.includes("LVT-1"));
  assert.ok(butt, "lobby and the adjacent LVT share an edge");
  assert.equal(butt.id, "T-1");
  assert.equal(butt.type, "reducer");
  assert.ok(butt.lengthLf > 9, "the shared edge is 10 ft");
  const doorway = marks.find((m) => m.kind === "doorway" && m.between.includes("CPT-1") && m.between.includes("VCT-1"));
  assert.ok(doorway, "the office sits 0.5 ft off the lobby");
  assert.equal(doorway.id, "");
  assert.match(doorway.type, /TBD \u2013 verify/);
  assert.ok(marks.filter((m) => m.kind === "butt").every((m) => /^T-\d+$/.test(m.id)));
  assert.ok(marks.filter((m) => m.kind === "doorway").every((m) => m.id === ""));
});

test("base follows the perimeter and skips a stated opening", async () => {
  const built = await model();
  const sheet = built.sheets[0]!;
  const { runs, openingsStated } = baseRuns(built, sheet);
  assert.equal(openingsStated, true);
  assert.equal(runs.filter((r) => r.roomId === "room-office").length, 3);
  assert.equal(runs.filter((r) => r.roomId === "room-lobby").length, 4);
  assert.ok(runs.every((r) => r.label.includes("rubber")));
});

test("ashlar grout stays inside the room and crosses the start", async () => {
  assert.equal(patternBond("ashlar"), "half");
  assert.equal(patternBond("herringbone"), "herringbone");
  assert.equal(patternBond(""), "stacked");
  const built = await model();
  const sheet = built.sheets[0]!;
  const room = sheet.rooms.find((r) => r.id === "room-lvt")!;
  const tileW = (room.tileWidthIn! / 12) / sheet.upp;
  const tileH = (room.tileHeightIn! / 12) / sheet.upp;
  const lines = patternLines(room.ringPx, room.start.at, tileW, tileH, "ashlar");
  assert.ok(lines.length > 4);
  for (const [a, b] of lines) {
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    assert.equal(pointInPoly(mid.x, mid.y, room.ringPx), true);
  }
  const start = room.start.at;
  const through = lines.some(([a, b]) => {
    const horizontal = Math.abs(a.y - b.y) < 0.01 && Math.abs(a.y - start.y) < 0.01;
    const vertical = Math.abs(a.x - b.x) < 0.01 && Math.abs(a.x - start.x) < 0.01;
    return horizontal || vertical;
  });
  assert.equal(through, true);
  const half = lines.some(([a, b]) => {
    if (Math.abs(a.x - b.x) > 0.01) return false;
    return Math.abs(a.x - (start.x + tileW / 2)) < 0.05 || Math.abs(a.x - (start.x - tileW / 2)) < 0.05;
  });
  assert.equal(half, true, "ashlar shifts every other row by half a tile");
  const expected = tileStart(room.ringPx);
  assert.equal(room.start.at.x, expected.at.x);
  assert.equal(room.start.at.y, expected.at.y);
});
