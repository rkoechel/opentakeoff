import { test } from "node:test";
import assert from "node:assert/strict";
import { canonScale, titleBlockCheck, scaleCrops } from "../src/scalecheck.ts";

test("titleBlockCheck: agrees, differs, absent", () => {
  assert.equal(titleBlockCheck(`1/8" = 1'-0"`, `SCALE: 1/8" = 1'-0" DATE 10/18/26`), "agrees");
  assert.equal(titleBlockCheck(`1/8" = 1'-0"`, `SCALE 1/8"=1'`), "agrees");
  assert.equal(titleBlockCheck(`1/8" = 1'-0"`, `SCALE: 1/4" = 1'-0"`), "differs");
  assert.equal(titleBlockCheck(`1/8" = 1'-0"`, "SCALE 1:96"), "agrees");
  assert.equal(titleBlockCheck(`1/8" = 1'-0"`, "SCALE 1:48"), "differs");
  assert.equal(titleBlockCheck(`1/8" = 1'-0"`, "PLOTTED 10/18/2026 11:30:12 AM"), "absent");
  assert.equal(titleBlockCheck(`1/8" = 1'-0"`, "PROJECT NO 2026-114 SHEET A1.1"), "absent");
  assert.equal(titleBlockCheck(`1/8" = 1'-0"`, ""), "absent");
});

test("scaleCrops: the whole right edge first, then the bottom strip", () => {
  assert.deepEqual(scaleCrops({ width_px: 2000, height_px: 1000 }), [{ x0: 1100, y0: 0, x1: 2000, y1: 1000 }, { x0: 0, y0: 850, x1: 2000, y1: 1000 }]);
});

test("canonScale straightens curly quotes and primes", () => {
  assert.equal(canonScale("1/8\u2033 = 1\u2032-0\u2033"), `1/8"=1'-0"`);
});
