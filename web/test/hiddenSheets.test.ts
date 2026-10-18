import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeHiddenSheets, isHidden, toggleHidden, visibleKeys, hiddenCount, canHide, isFinding, visibleFindings, hiddenFindingCount } from "../src/lib/hiddenSheets.js";

test("sanitizeHiddenSheets", () => {
  assert.deepEqual(sanitizeHiddenSheets(undefined), []);
  assert.deepEqual(sanitizeHiddenSheets(null), []);
  assert.deepEqual(sanitizeHiddenSheets('a.pdf'), []);
  assert.deepEqual(sanitizeHiddenSheets({a:1}), []);
  assert.deepEqual(sanitizeHiddenSheets(['a.pdf', '', '  ', 3, null, 'a.pdf', 'b.pdf#2']), ['a.pdf', 'b.pdf#2']);
});

test("toggleHidden", () => {
  assert.deepEqual(toggleHidden([], 'a.pdf#2'), ['a.pdf#2']);
  assert.deepEqual(toggleHidden(['a.pdf#2'], 'a.pdf#2'), []);
  assert.deepEqual(toggleHidden(undefined, 'x.pdf'), ['x.pdf']);
});

test("visibleKeys", () => {
  const keys = ['a.pdf', 'a.pdf#2', 'a.pdf#3'];
  assert.deepEqual(visibleKeys(keys, ['a.pdf#2'], false), ['a.pdf', 'a.pdf#3']);
  assert.deepEqual(visibleKeys(keys, ['a.pdf#2'], true), keys);
  assert.equal(hiddenCount(keys, ['a.pdf#2', 'gone.pdf']), 1);
  assert.equal(isHidden(undefined, 'a.pdf'), false);
});

test("canHide", () => {
  assert.equal(canHide(0), true);
  assert.equal(canHide(undefined), true);
  assert.equal(canHide(2), false);
});

const fixture = [
  { kind: "no_scale", sheet: "a.pdf#2", message: "No scale" },
  { kind: "missing_finish", sheet: "a.pdf#3", message: "Room 101" },
  { kind: "general", message: "No sheet" },
  null,
  [],
  { kind: "", message: "x" },
  { kind: "k" }
];

test("isFinding", () => {
  assert.equal(isFinding(fixture[0]), true);
  assert.equal(isFinding(fixture[2]), true);
  assert.equal(isFinding(null), false);
  assert.equal(isFinding([]), false);
  assert.equal(isFinding(fixture[5]), false);
  assert.equal(isFinding(fixture[6]), false);
  assert.equal(isFinding("x"), false);
});

test("visibleFindings hides findings on hidden sheets; showHidden restores them", () => {
  assert.deepEqual(visibleFindings(fixture, ["a.pdf#2"], false).map((f) => f.message), ["Room 101", "No sheet"]);
  assert.deepEqual(visibleFindings(fixture, ["a.pdf#2"], true).map((f) => f.message), ["No scale", "Room 101", "No sheet"]);
  assert.deepEqual(visibleFindings(undefined, [], false), []);
  assert.equal(visibleFindings(fixture, undefined, false).length, 3);
});

test("hiddenFindingCount", () => {
  assert.equal(hiddenFindingCount(fixture, ["a.pdf#2"]), 1);
  assert.equal(hiddenFindingCount(fixture, ["a.pdf#2", "a.pdf#3"]), 2);
  assert.equal(hiddenFindingCount(fixture, []), 0);
  assert.equal(hiddenFindingCount(null, ["a.pdf#2"]), 0);
});
