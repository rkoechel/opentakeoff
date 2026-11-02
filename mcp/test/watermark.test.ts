// OT_WATERMARK defaults off. Only the exact strings "1" and "true" enable it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { watermarkEnabled } from "../src/watermark.ts";

test("OT_WATERMARK is off unless it is exactly 1 or true", () => {
  const prev = process.env.OT_WATERMARK;
  try {
    delete process.env.OT_WATERMARK;
    assert.equal(watermarkEnabled(), false);
    for (const off of ["", "0", "false", "TRUE", "yes", "on"]) {
      process.env.OT_WATERMARK = off;
      assert.equal(watermarkEnabled(), false, off);
    }
    process.env.OT_WATERMARK = "1";
    assert.equal(watermarkEnabled(), true);
    process.env.OT_WATERMARK = "true";
    assert.equal(watermarkEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.OT_WATERMARK;
    else process.env.OT_WATERMARK = prev;
  }
});
