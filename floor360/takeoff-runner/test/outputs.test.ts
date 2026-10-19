import { test } from "node:test";
import assert from "node:assert/strict";
import { FINISH_TBD_TAG, excludeFinishTbd, markFinishTbd, runSummary } from "../src/outputs.ts";

test("markFinishTbd flags the FINISH-TBD condition and only its shapes, grey, named Finish TBD", () => {
  const payload: any = {
    conditions: [
      { id: "c1", finish_tag: "CPT-1", color: "#ff0000" },
      { id: "c9", finish_tag: FINISH_TBD_TAG },
    ],
    shapes: [
      { id: "s1", condition_id: "c1" },
      { id: "s2", condition_id: "c9" },
      { id: "s3", condition_id: "c9" },
    ],
  };
  const n = markFinishTbd(payload);
  assert.equal(n, 2);
  assert.equal(payload.conditions[1].finishStatus, "tbd");
  assert.equal(payload.conditions[1].name, "Finish TBD");
  assert.equal(payload.conditions[1].color, "#8a8f98");
  assert.equal(payload.conditions[0].finishStatus, undefined);
  assert.equal(payload.conditions[0].color, "#ff0000");
  assert.deepEqual(
    payload.shapes.map((s: any) => s.finishStatus ?? null),
    [null, "tbd", "tbd"]
  );
});

test("excludeFinishTbd keeps TBD square footage out of the totals", () => {
  const report = {
    conditions: [
      { finish_tag: "CPT-1", total_sf: 200, total_sf_net: 200, lf: 60 },
      {
        finish_tag: FINISH_TBD_TAG,
        total_sf: 150.5,
        total_sf_net: 150.5,
        lf: 50,
      },
    ],
    totals: {
      total_sf: 350.5,
      total_sf_net: 350.5,
      lf: 110,
      lf_net: 0,
      ea: 0,
      sy_net: 38.94,
    },
  };
  const out: any = excludeFinishTbd(report);
  assert.deepEqual(out.conditions.map((r: any) => r.finish_tag), ["CPT-1"]);
  assert.deepEqual(out.finish_tbd.map((r: any) => r.finish_tag), [
    FINISH_TBD_TAG,
  ]);
  assert.equal(out.totals.total_sf, 200);
  assert.equal(out.totals.total_sf_net, 200);
  assert.equal(out.totals.lf, 60);
  assert.equal(out.totals.sy_net, 38.94);
  assert.equal(report.totals.total_sf, 350.5, "input untouched");
});

test("excludeFinishTbd returns the same object when there is nothing TBD (matched runs unchanged)", () => {
  const report = {
    conditions: [{ finish_tag: "CPT-1", total_sf: 200 }],
    totals: { total_sf: 200 },
  };
  assert.equal(excludeFinishTbd(report), report);
});

test("run summary: drawn with finish and drawn as Finish TBD", () => {
  assert.equal(
    runSummary({
      sheets: 50,
      scaled: 3,
      unscaled: 10,
      hidden: 34,
      rooms: 0,
      tbd: 12,
      toReview: 0,
      rfis: 12,
      unmatched: 0,
    }),
    "AI run summary: 50 sheets read, 3 scaled by the AI (unconfirmed), 10 left unscaled, 34 hidden as non-plan or duplicate, 0 drawn with finish, 12 drawn as Finish TBD (0 to review first), 12 RFIs drafted."
  );
  assert.match(
    runSummary({
      sheets: 1,
      scaled: 1,
      unscaled: 0,
      hidden: 0,
      rooms: 2,
      tbd: 1,
      toReview: 1,
      rfis: 1,
      unmatched: 2,
    }),
    /2 drawn with finish, 1 drawn as Finish TBD \(1 to review first\), 2 found with no outline \(not drawn\), 1 RFIs drafted\.$/
  );
});
