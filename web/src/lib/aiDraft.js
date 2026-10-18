// FLOOR360 auto-takeoff: the draft / approve gate on a project the AI
// takeoff runner made. The runner writes an additive `floor360AutoTakeoff`
// key into annotations.json:
//
//   {"status": "draft" | "approved", "runId", "bidId", "bidNumber",
//    "generatedAt", "runnerVersion",
//    "checklist": {<item id>: {"by", "at"}}, "approvedBy", "approvedAt"}
//
// An estimator checks every item (each records the Easy Auth name and time);
// un-checking an item re-locks Approve. Approve is a human act: it never
// touches shapes' review state or the APPROVED seals.
//
// Pure functions over that object. Unknown keys always ride through, so a
// newer runner's fields survive a save from this build.

export const AUTO_TAKEOFF_KEY = "floor360AutoTakeoff";

export const CHECKLIST_ITEMS = Object.freeze([
  { id: "scales", label: "Scales" },
  { id: "schedule_mapping", label: "Schedule mapping" },
  { id: "areas_rooms", label: "Areas and rooms" },
  { id: "seams_transitions", label: "Seams and transitions" },
  { id: "waste_quantities", label: "Waste and quantities" },
  { id: "shop_drawings", label: "Shop drawings" },
  { id: "submittal_docs", label: "Submittal docs" },
  { id: "rfis", label: "RFIs" },
]);
export const WALL_TILE_ITEM = Object.freeze({ id: "wall_tile_elevations", label: "Wall tile from elevations" });

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const WALL_TILE_TEXT = /\bwall[\s-]*tile\b/i;
const WALL_TILE_TAG = /^WT[-\s]?\d/i;

/** True when a condition is wall tile: a `WT-` style tag, or "wall tile" in
 *  its tag, name, label, category or imported spec. */
export function isWallTileCondition(c) {
  if (!isObj(c)) return false;
  if (typeof c.finish_tag === "string" && WALL_TILE_TAG.test(c.finish_tag.trim())) return true;
  const spec = isObj(c.spec) ? c.spec : {};
  return [c.finish_tag, c.name, c.label, c.category, spec.description, spec.style]
    .some((v) => typeof v === "string" && WALL_TILE_TEXT.test(v));
}

/** The checklist for this project: the eight items, plus wall tile when any
 *  condition is wall tile. */
export function checklistItems(conditions) {
  const wall = Array.isArray(conditions) && conditions.some(isWallTileCondition);
  return wall ? [...CHECKLIST_ITEMS, WALL_TILE_ITEM] : [...CHECKLIST_ITEMS];
}

/** The loaded key, or null when the project has none (or it is unusable).
 *  Returned as-is (no copy, no dropped keys) so a save writes it back intact. */
export function readAutoTakeoff(payload) {
  const v = isObj(payload) ? payload[AUTO_TAKEOFF_KEY] : null;
  return isObj(v) && typeof v.status === "string" ? v : null;
}

export const isAiDraft = (at) => isObj(at) && at.status === "draft";
export const isAiApproved = (at) => isObj(at) && at.status === "approved";

const checklistOf = (at) => (isObj(at) && isObj(at.checklist) ? at.checklist : {});

/** A recorded check {by, at}, or null when the item isn't checked. */
export function checkOf(at, id) {
  const e = checklistOf(at)[id];
  return isObj(e) && typeof e.by === "string" && e.by.trim() && typeof e.at === "string" && e.at.trim() ? e : null;
}

/** Check (records who and when) or un-check an item. Only a draft changes;
 *  anything else is returned unchanged. */
export function setCheck(at, id, checked, by, nowIso) {
  if (!isAiDraft(at)) return at;
  const checklist = { ...checklistOf(at) };
  if (checked) {
    const who = String(by || "").trim();
    if (!who) return at;
    checklist[id] = { by: who, at: nowIso };
  } else {
    delete checklist[id];
  }
  return { ...at, checklist };
}

/** The items still unchecked, in checklist order. */
export function missingChecks(at, conditions) {
  return checklistItems(conditions).filter((it) => !checkOf(at, it.id));
}

/** Approve unlocks only on a draft with every item checked. */
export function canApprove(at, conditions) {
  return isAiDraft(at) && missingChecks(at, conditions).length === 0;
}

/** The approved key, or null while Approve is locked. */
export function approveAutoTakeoff(at, conditions, by, nowIso) {
  const who = String(by || "").trim();
  if (!who || !canApprove(at, conditions)) return null;
  return { ...at, status: "approved", approvedBy: who, approvedAt: nowIso };
}

/** Approved here but Bids hasn't been told yet (the Retry state). */
export const needsBidsNotice = (at) => isAiApproved(at) && typeof at.runId === "string" && !!at.runId && !at.bidsNotifiedAt;

/** Bids took the approval: stamp it so a reload doesn't offer Retry again. */
export function markBidsNotified(at, nowIso) {
  return isAiApproved(at) ? { ...at, bidsNotifiedAt: nowIso } : at;
}
