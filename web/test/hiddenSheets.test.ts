import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeHiddenSheets, isHidden, toggleHidden, visibleKeys, hiddenCount, canHide } from "../src/lib/hiddenSheets.js";

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
