import { test } from "node:test";
import assert from "node:assert/strict";
import { sheetSeries, isNonPlanSheet, duplicatePages } from "../src/sheetfilter.ts";

test("sheetSeries reads the discipline and series", () => {
  assert.deepEqual(sheetSeries("A5.1"), { discipline: "A", series: 5 });
  assert.deepEqual(sheetSeries("a-101"), { discipline: "A", series: 1 });
  assert.deepEqual(sheetSeries("FP001"), { discipline: "FP", series: 0 });
  assert.equal(sheetSeries(undefined), null);
  assert.equal(sheetSeries("101"), null);
});

test("isNonPlanSheet: cover, spec, elevation, section, detail and schedule sheets, never a titled plan", () => {
  for (const n of ["A0.0", "A5.1", "A5.2", "M3.0", "E4.0", "A3.2", "A6.1", "G-001"])
    assert.equal(isNonPlanSheet("unknown", n), true, n);
  for (const n of ["A1.1", "A-101", "A4.1", "I4.0", "M1.1", "E2.0x"])
    assert.equal(isNonPlanSheet("unknown", n), n === "E2.0x", n);
  assert.equal(isNonPlanSheet("plan", "A-601"), false);
  assert.equal(isNonPlanSheet("schedule", undefined), true);
  assert.equal(isNonPlanSheet("detail", "A1.1"), true);
  assert.equal(isNonPlanSheet("legend", undefined), true);
  assert.equal(isNonPlanSheet(undefined, undefined), false);
});

test("duplicatePages maps each repeat to the first copy and ignores unhashed sheets", () => {
  const hashes = new Map([["a.pdf", "h1"], ["a.pdf#2", "h2"], ["b.pdf", "h1"], ["b.pdf#2", "h2"], ["c.pdf", "h1"]]);
  assert.deepEqual([...duplicatePages(["a.pdf", "a.pdf#2", "b.pdf", "b.pdf#2", "c.pdf", "x.pdf"], hashes)], [["b.pdf", "a.pdf"], ["b.pdf#2", "a.pdf#2"], ["c.pdf", "a.pdf"]]);
  assert.equal(duplicatePages([], hashes).size, 0);
});
