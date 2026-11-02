// NOTICE section 7(b): the plan-set home screen keeps the attribution phrase,
// the opentakeoff.kentucky-ai.com link, the AGPL-3.0 label, and the source link.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("the plan-set home line names OpenTakeoff, links Kentucky AI's project, and keeps AGPL and source", () => {
  const src = readFileSync(new URL("../src/components/PlanNavigator.jsx", import.meta.url), "utf8");
  const at = src.indexOf("AGPL-3.0 ·");
  assert.ok(at > 0, "home line should contain the AGPL-3.0 label");
  const line = src.slice(at, at + 700);
  assert.equal(line.includes("OpenTakeoff, an open project by Kentucky AI"), true);
  assert.equal(line.includes("https://opentakeoff.kentucky-ai.com"), true);
  assert.equal(line.includes("sourceHref()"), true);
  assert.equal(line.includes("sourceLabel()"), true);
  assert.equal(line.includes("AGPL-3.0"), true);
});
