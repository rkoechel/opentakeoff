import { test } from "node:test";
import assert from "node:assert/strict";
import { conditionTotals, grandTotals, isFinishTbd } from "../src/lib/totals.js";

const area = (id: string, sf: number) => ({ condition_id: id, measure_role: "floor_area", computed: { area_sf: sf } });

test("isFinishTbd: the runner flag or the FINISH-TBD tag", () => {
  assert.equal(isFinishTbd({ finish_tag: "X", finishStatus: "tbd" }), true);
  assert.equal(isFinishTbd({ finish_tag: "finish-tbd" }), true);
  assert.equal(isFinishTbd({ finish_tag: "CPT-1" }), false);
  assert.equal(isFinishTbd(undefined), false);
});

test("Finish TBD rooms show as their own row but stay out of the grand total", () => {
  const conds = [{ id: "c1", finish_tag: "CPT-1" }, { id: "c9", finish_tag: "FINISH-TBD", finishStatus: "tbd" }];
  const rows = conditionTotals(conds as any, [area("c1", 200), area("c9", 150)] as any);
  const tbd = rows.find((r: any) => r.finish_tag === "FINISH-TBD") as any;
  assert.equal(tbd.finish_tbd, true);
  assert.equal(tbd.floor_sf, 150);
  assert.equal((rows.find((r: any) => r.finish_tag === "CPT-1") as any).finish_tbd, undefined, "matched rows are unchanged");
  const g = grandTotals(rows as any);
  const only = grandTotals(conditionTotals([conds[0]] as any, [area("c1", 200)] as any) as any);
  assert.deepEqual(g, only);
});

test("AI draft panel names the Finish TBD rooms so the estimator assigns them before accepting", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { default: AiDraftPanel } = await import("../src/components/AiDraftPanel.jsx");
  const props = { autoTakeoff: { status: "draft", checklist: {} }, conditions: [], user: { email: "e@x.com" }, nowIso: () => "2026-10-18T00:00:00Z", onChange: () => {}, onApprove: () => {} };
  const html = renderToStaticMarkup(createElement(AiDraftPanel as any, { ...props, tbdRooms: 12 }));
  assert.match(html, /data-testid="ai-draft-finish-tbd"/);
  assert.match(html, /12 rooms drawn as Finish TBD/);
  assert.match(html, /change its condition to the right finish, then accept it/);
  assert.doesNotMatch(renderToStaticMarkup(createElement(AiDraftPanel as any, props)), /ai-draft-finish-tbd/, "no notice when every room has a finish");

  assert.match(html, /2 rooms drawn as Finish TBD/);
});
