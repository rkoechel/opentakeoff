import { test } from "node:test";
import assert from "node:assert/strict";
import { applyShapeCommand } from "../src/lib/shapeCommands.js";

test("reassigning a Finish TBD room to a real finish clears its tbd flag; undo puts it back", () => {
  const shapes = [{ id: "s1", condition_id: "c9", measure_role: "floor_area", finishStatus: "tbd", origin: { actor: "agent", reviewed: false } }, { id: "s2", condition_id: "c9", measure_role: "floor_area", finishStatus: "tbd" }];
  const { shapes: next, inverse } = applyShapeCommand(shapes as any, { type: "reassign", ids: ["s1"], condition_id: "c1" } as any) as any;
  assert.equal(next[0].condition_id, "c1");
  assert.equal("finishStatus" in next[0], false, "flag cleared on the reassigned room");
  assert.equal(next[1].finishStatus, "tbd", "other TBD rooms keep the flag");
  const { shapes: back } = applyShapeCommand(next, inverse) as any;
  assert.equal(back[0].condition_id, "c9");
  assert.equal(back[0].finishStatus, "tbd", "undo restores the flag");
  assert.equal(back[1].finishStatus, "tbd", "undo restores the flag on other rooms");
});
