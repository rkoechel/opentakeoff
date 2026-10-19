// FLOOR360 auto-takeoff: the "AI draft, not verified" banner and the
// estimator's verification checklist (lib/aiDraft.js). Shown only on a project
// whose annotations carry floor360AutoTakeoff, and only when this site's
// /api/bids/drafts route says AI drafts are on. Each check records the Easy
// Auth user and time; Approve stays locked until every item is checked.
// Approving doesn't accept machine shapes or place APPROVED seals.
import { useState } from "react";
import { Z } from "../lib/ui.js";
import { canApprove, checkOf, checklistItems, isAiApproved, isAiDraft, missingChecks, needsBidsNotice, setCheck } from "../lib/aiDraft.js";
import { formatCt } from "../lib/bidsDrafts.js";

const box = {
  position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: Z.drawer,
  width: "min(560px, calc(100% - 24px))", background: "var(--paper-bright)", boxShadow: "var(--shadow-2)",
  fontSize: 12.5, color: "var(--ink)",
};
const btn = { padding: "5px 12px", border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap" };
const muted = { color: "var(--ink-muted)", fontSize: 11.5 };

/** notice: {state: "idle" | "saving" | "sending" | "error" | "done", error} */
export default function AiDraftPanel({ autoTakeoff, conditions, user, nowIso, onChange, onApprove, notice, onRetry, findings = [], hiddenFindings = 0, labelOf, tbdRooms = 0 }) {
  const [open, setOpen] = useState(true);
  const who = user?.email || "";

  if (isAiApproved(autoTakeoff)) {
    const pending = needsBidsNotice(autoTakeoff);
    if (!pending && notice?.state !== "done") return null;
    return (
      <div style={{ ...box, border: `1px solid ${notice?.state === "error" ? "var(--c-danger)" : "var(--c-positive)"}`, padding: "8px 12px", display: "flex", alignItems: "center", gap: 10 }}
        data-testid="ai-draft-approved" role="status">
        <span style={{ flex: 1 }}>
          <strong style={{ color: "var(--c-positive)" }}>AI takeoff approved</strong>
          {autoTakeoff.approvedBy ? ` by ${autoTakeoff.approvedBy}` : ""}
          {autoTakeoff.approvedAt ? ` · ${formatCt(autoTakeoff.approvedAt)}` : ""}
          {notice?.state === "saving" ? " · saving…" : ""}
          {notice?.state === "sending" ? " · telling Bids…" : ""}
          {notice?.state === "done" ? " · Bids notified" : ""}
          {notice?.state === "error" ? <span style={{ color: "var(--c-danger)" }}>{` · Bids wasn't told: ${notice.error} The approval is saved.`}</span> : null}
          {pending && (!notice || notice.state === "idle") ? " · Bids hasn't been told yet." : ""}
        </span>
        {pending && (notice?.state === "error" || !notice || notice.state === "idle")
          ? <button type="button" style={btn} onClick={onRetry}>Retry</button> : null}
      </div>
    );
  }
  if (!isAiDraft(autoTakeoff)) return null;

  const items = checklistItems(conditions, autoTakeoff);
  const missing = missingChecks(autoTakeoff, conditions);
  const ready = canApprove(autoTakeoff, conditions) && !!who;
  const done = items.length - missing.length;
  const bid = autoTakeoff.bidNumber ? `Bid ${autoTakeoff.bidNumber}` : "";

  return (
    <div style={{ ...box, border: "1px solid var(--c-warning)" }} data-testid="ai-draft-banner">
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px" }}>
        <span style={{ flex: 1 }}>
          <strong style={{ color: "var(--c-warning)" }}>AI draft, not verified</strong>
          {bid ? ` · ${bid}` : ""} · {done} of {items.length} checked
        </span>
        <button type="button" style={btn} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {open ? "Hide checklist" : "Checklist"}
        </button>
      </div>
      {open ? (
        <div style={{ borderTop: "1px solid var(--ink-faint)", padding: "8px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
          {!who ? <div style={{ ...muted, color: "var(--c-danger)" }}>Your sign-in name isn't available, so checks can't be recorded. Reload the page.</div> : null}
          {tbdRooms > 0 ? <div data-testid="ai-draft-finish-tbd" style={{ border: "1px dashed #8a8f98", background: "rgba(138, 143, 152, 0.12)", padding: "5px 8px" }}><strong>{`${tbdRooms} room${tbdRooms === 1 ? "" : "s"} drawn as Finish TBD`}</strong>{" (grey). They aren't priced. Select each one, change its condition to the right finish, then accept it."}</div> : null}
          {items.map((it) => {
            const c = checkOf(autoTakeoff, it.id);
            return (
              <label key={it.id} style={{ display: "flex", alignItems: "baseline", gap: 8, cursor: who ? "pointer" : "default" }}>
                <input type="checkbox" checked={!!c} disabled={!who} data-check={it.id}
                  onChange={(e) => onChange(setCheck(autoTakeoff, it.id, e.target.checked, who, nowIso()))} />
                <span style={{ fontWeight: 600 }}>{it.label}</span>
                {c ? <span style={muted}>{`${c.by} · ${formatCt(c.at)}`}</span> : null}
              </label>
            );
          })}
          {(findings.length > 0 || hiddenFindings > 0) ? (
            <div data-testid="ai-draft-findings" style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 4 }}>
              <span style={{ fontWeight: 600 }}>To verify on the drawings</span>
              {findings.map((f, i) => <div key={`${f.kind}-${f.sheet || ""}-${f.tag || ""}-${i}`} style={{ display: "flex", gap: 6 }}>{f.sheet ? <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{labelOf ? labelOf(f.sheet) : f.sheet}</span> : null}<span>{f.message}</span></div>)}
              {hiddenFindings > 0 ? <span style={muted}>{`${hiddenFindings} more on hidden sheets. Use Show hidden or Unhide to see them.`}</span> : null}
            </div>
          ) : null}
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
            <button type="button" disabled={!ready} onClick={onApprove} data-testid="ai-draft-approve"
              title={ready ? "Mark this AI takeoff verified and tell Bids" : `Check every item first: ${missing.map((m) => m.label).join(", ") || "sign in"}`}
              style={{ ...btn, fontWeight: 600, border: "1px solid var(--ink)", background: ready ? "var(--ink)" : "var(--paper-bright)", color: ready ? "var(--paper-bright)" : "var(--ink-muted)", cursor: ready ? "pointer" : "not-allowed" }}>
              Approve AI takeoff
            </button>
            <span style={muted}>Approving doesn't accept machine shapes or add APPROVED seals.</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
