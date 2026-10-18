// RFI drafts from a run's findings (Phase 2 §7, PR F): the questions the
// drawings left open, raised through the engine's create_rfi so they land in
// the project's RFI register as PENDING agent records (origin.actor "agent",
// reviewed false), on the sheet they concern, with a cloud at the spot when
// the finding knows where it is. Nothing is sent: an estimator accepts each
// one in the register before it is exported or emailed by a person.
import type { Engine } from "./engine.ts";
import { EngineToolError } from "./engine.ts";
import type { RunState } from "./pipeline.ts";
import type { Finding, FindingKind, Point } from "./types.ts";

interface Draft { title: string; question: string }

/** The finding kinds that become RFIs, keyed to the question they ask. NTS and
 *  no scale are one question (the sheet's scale), so they share a key. */
const RFI_KIND: Partial<Record<FindingKind, string>> = {
  no_scale: "scale",
  nts_sheet: "scale",
  schedule_row_not_drawn: "schedule_row_not_drawn",
  room_no_schedule_row: "room_no_schedule_row",
  conflicting_finishes: "conflicting_finishes",
  unreadable_schedule: "unreadable_schedule",
  wall_tile_no_elevation: "wall_tile_no_elevation",
};

export const RFI_FINDING_KINDS: readonly FindingKind[] = Object.freeze(Object.keys(RFI_KIND) as FindingKind[]);

const normTag = (t: string | undefined) => String(t ?? "").trim().toUpperCase();

/** The dedupe key: one RFI per (question kind, sheet, tag). */
export function rfiKey(f: Finding): string | null {
  const kind = RFI_KIND[f.kind];
  return kind ? `${kind}|${f.sheet ?? ""}|${normTag(f.tag)}` : null;
}

export function draftFor(f: Finding, sheet: string): Draft | null {
  const tag = f.tag ?? "";
  const detail = f.detail ? ` ${f.detail}` : "";
  switch (f.kind) {
    case "no_scale":
      return { title: `Scale needed: ${sheet}`, question: `Sheet ${sheet} has no readable drawing scale. Please confirm the scale, or issue a scaled sheet, so the flooring on it can be taken off.` };
    case "nts_sheet":
      return { title: `Scaled sheet needed: ${sheet}`, question: `Sheet ${sheet} is marked NOT TO SCALE. Please issue a scaled sheet, or give a key dimension, for the flooring areas it shows.` };
    case "schedule_row_not_drawn":
      return { title: `Finish ${tag} not shown on plans`, question: `The finish schedule lists ${tag}${detail}, but no plan shows where it goes. Please confirm its locations, or confirm it is deleted.` };
    case "room_no_schedule_row":
      return { title: `Room ${tag}: finish not scheduled`, question: `Room ${tag} on ${sheet} has no row in the room finish schedule. Please confirm its floor and base finishes.` };
    case "conflicting_finishes":
      return { title: `Conflicting finish: ${tag}`, question: `The documents give more than one finish for ${tag}.${detail} Please confirm which finish applies.` };
    case "unreadable_schedule":
      return { title: "Readable finish schedule needed", question: `The finish schedule on ${sheet} is a scanned image that can't be read reliably. Please issue it as a searchable PDF or as a table.` };
    case "wall_tile_no_elevation":
      return { title: `Wall tile ${tag}: heights and extents`, question: `Please confirm the heights and extents of wall tile ${tag} (elevations or a tile layout) so the wall area can be taken off.` };
    default:
      return null;
  }
}

function cloudRect(f: Finding): [Point, Point] | null {
  if (f.rect) return f.rect;
  if (f.at) return [[f.at[0] - 90, f.at[1] - 90], [f.at[0] + 90, f.at[1] + 90]];
  return null;
}

/** Draft one pending RFI per open question in the findings, deduplicated by
 *  (kind, sheet, tag). Each drafted finding gets its RFI number in `rfi`;
 *  state.rfisDrafted counts them. A refusal from the engine becomes a
 *  step_failed finding and the run goes on. */
export async function draftRfis(engine: Engine, state: RunState): Promise<void> {
  const fallbackSheet = state.scheduleSheet ?? state.sheets[0]?.sheet;
  const loaded = new Set(state.sheets.map((s) => s.sheet));
  const done = new Map<string, string>();
  const failures: Finding[] = [];
  for (const f of [...state.findings]) {
    const key = rfiKey(f);
    if (!key) continue;
    const prior = done.get(key);
    if (prior !== undefined) {
      if (prior) f.rfi = prior;
      continue;
    }
    done.set(key, "");
    const sheet = f.sheet && loaded.has(f.sheet) ? f.sheet : fallbackSheet;
    if (!sheet) continue;
    const draft = draftFor(f, sheet);
    if (!draft) continue;
    try {
      const markupIds: string[] = [];
      const rect = sheet === f.sheet ? cloudRect(f) : null;
      if (rect) {
        const cloud = await engine.call<{ id: string }>("annotate", { sheet, type: "cloud", rect, text: draft.title });
        markupIds.push(cloud.id);
      }
      const rfi = await engine.call<{ number: string; pending: boolean; actor: string }>("create_rfi", { title: draft.title, question: draft.question, sheet, ...(markupIds.length ? { markup_ids: markupIds } : {}) });
      f.rfi = rfi.number;
      done.set(key, rfi.number);
      state.rfisDrafted++;
    } catch (e) {
      if (!(e instanceof EngineToolError)) throw e;
      failures.push({ kind: "step_failed", sheet, tag: "create_rfi", message: `The RFI draft "${draft.title}" could not be written: ${e.message}` });
    }
  }
  for (const f of failures) state.addFinding(f);
}
