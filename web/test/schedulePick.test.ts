import { test } from "node:test";
import assert from "node:assert/strict";
import { rankScheduleCandidates, suggestSchedule } from "../src/lib/schedulePick";

const table = (sheet: string, kind: string, title: string, rows: number) => ({
  kind, sheet, title: title ? { sheet, text: title, bbox: [0, 0, 1, 1] } : null, headers: [],
  rows: Array.from({ length: rows }, () => ({})), region: [10, 20, 300, 400],
}) as any;

test("rank: room finish first, then finish/material; door and device schedules last and never suggested", () => {
  const ranked = rankScheduleCandidates([
    table("A-601", "equipment", "FAN SCHEDULE", 40),
    table("A-602", "finish", "DOOR SCHEDULE", 60),
    table("A-501", "finish", "FINISH LEGEND", 8),
    table("A-500", "room-finish", "ROOM FINISH SCHEDULE", 25),
  ]);
  assert.deepEqual(ranked.map((c) => c.sheet), ["A-500", "A-501", "A-602", "A-601"]);
  assert.equal(ranked[2].demoted, true);
  assert.match(ranked[2].reason, /another schedule/);
  assert.equal(ranked[3].demoted, true);
  assert.match(ranked[3].reason, /Device/);
  assert.equal(suggestSchedule(ranked)?.sheet, "A-500");
  assert.deepEqual(ranked[0].region, [10, 20, 300, 400]);
});

test("suggest: only door/device schedules → no suggestion (the estimator picks or draws the box)", () => {
  const ranked = rankScheduleCandidates([table("A-602", "finish", "DOOR SCHEDULE", 60), table("M-1", "equipment", "FAN SCHEDULE", 5)]);
  assert.equal(suggestSchedule(ranked), null);
  assert.equal(ranked.length, 2);
  assert.equal(suggestSchedule(rankScheduleCandidates([])), null);
});

test("rank: among finish schedules, a FINISH/MATERIAL title and more rows win; untitled is labeled", () => {
  const ranked = rankScheduleCandidates([table("A-2", "finish", "", 30), table("A-1", "finish", "MATERIAL SCHEDULE", 10)]);
  assert.equal(ranked[0].sheet, "A-1"); // 200+40+10 beats 200+30
  assert.equal(ranked[0].title, "MATERIAL SCHEDULE");
  assert.equal(ranked[1].title, "(untitled schedule)");
});
