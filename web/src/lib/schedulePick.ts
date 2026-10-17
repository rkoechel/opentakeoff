// Finish-schedule pick (FLOOR360 phase 1): rank the schedule tables the sheet
// graph (buildSheetGraph — the engine behind the MCP's find_schedule) found
// across the set, so the canvas can SUGGEST the finish schedule sheet. The
// estimator confirms before the existing Import from schedule reads it;
// nothing imports on its own. Door / device / other-family schedules are kept
// in the list (the estimator may pick one) but ranked last with a reason.
import { isNonFinishSchedule, type ScheduleTable } from "./sheetgraph.ts";

export interface ScheduleCandidate {
  sheet: string;
  title: string;
  kind: ScheduleTable["kind"];
  rows: number;
  region: [number, number, number, number];
  score: number;
  /** true for door/device/other-family schedules — never auto-suggested */
  demoted: boolean;
  reason: string;
}

const KIND_SCORE: Record<string, number> = { "room-finish": 300, finish: 200, unknown: 50, equipment: 0 };

export function rankScheduleCandidates(tables: readonly ScheduleTable[]): ScheduleCandidate[] {
  const out: ScheduleCandidate[] = [];
  for (const t of tables || []) {
    const title = t.title?.text || "";
    const otherFamily = isNonFinishSchedule(title);
    const demoted = otherFamily || t.kind === "equipment";
    const rows = t.rows?.length || 0;
    const titleBoost = /\bFINISH|MATERIAL/i.test(title) ? 40 : 0;
    const score = demoted ? -100 + Math.min(rows, 50) : (KIND_SCORE[t.kind] ?? 0) + titleBoost + Math.min(rows, 50);
    const reason = otherFamily ? `Titled as another schedule ("${title}") — not a finish schedule`
      : t.kind === "equipment" ? "Device/equipment schedule — not a finish schedule"
      : t.kind === "room-finish" ? `Room finish schedule, ${rows} rows`
      : t.kind === "finish" ? `Finish/material schedule, ${rows} rows`
      : `Schedule, ${rows} rows`;
    out.push({ sheet: t.sheet, title: title || "(untitled schedule)", kind: t.kind, rows, region: t.region, score, demoted, reason });
  }
  // best first; ties: more rows, then sheet key for a stable order
  return out.sort((a, b) => b.score - a.score || b.rows - a.rows || a.sheet.localeCompare(b.sheet));
}

/** The one to suggest: the best non-demoted candidate, or null. */
export function suggestSchedule(c: readonly ScheduleCandidate[]): ScheduleCandidate | null {
  return c.find((x) => !x.demoted) ?? null;
}
