// The plan-set home line keeps the AGPL-3.0 label and the source link.
// It does not name Kentucky AI or link opentakeoff.kentucky-ai.com.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the plan-set home line keeps the AGPL source link and does not name Kentucky AI", () => {
  const src = readFileSync(new URL("../src/components/PlanNavigator.jsx", import.meta.url), "utf8");
  const at = src.indexOf("AGPL-3.0 ·");
  assert.ok(at > 0, "home line should contain the AGPL-3.0 label");
  const line = src.slice(at, at + 700);
  assert.equal(line.includes("sourceHref()"), true);
  assert.equal(line.includes("sourceLabel()"), true);
  assert.equal(line.includes("AGPL-3.0"), true);
  assert.equal(line.includes("Kentucky AI"), false);
  assert.equal(line.includes("kentucky-ai.com"), false);
  assert.equal(line.includes("OpenTakeoff"), false);
});
