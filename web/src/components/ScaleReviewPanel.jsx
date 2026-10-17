// Scale review (FLOOR360 phase 1): after a plan set is imported, every sheet's
// detected scale in one list — Confirm, Change (a standard scale, or the
// existing two-point Calibrate on the sheet), or mark NTS — plus the
// suggested finish schedule, which the estimator confirms before the existing
// Import from schedule reads it. Presentation only: every action is a canvas
// callback, and the state rules live in lib/scaleReview.ts / schedulePick.ts.
import { useEffect } from "react";
import { scaleConfidence } from "../lib/scaleReview";

const STATE_FACE = {
  confirmed: { text: "Confirmed", color: "var(--c-positive)" },
  "needs-confirm": { text: "Detected — confirm", color: "var(--c-warning)" },
  detected: { text: "Ambiguous — review", color: "var(--c-warning)" },
  "needs-scale": { text: "Needs scale", color: "var(--c-danger)" },
  nts: { text: "NTS", color: "var(--ink-faint)" },
};
const SOURCE_TEXT = { calibrated: "calibrated", standard: "picked", detected: "plan note" };
const btn = { padding: "3px 8px", fontSize: 11.5, border: "1px solid var(--ink-faint)", background: "var(--paper-bright)", cursor: "pointer", whiteSpace: "nowrap" };

export default function ScaleReviewPanel({
  rows, summary, scanning, standardScales,
  onConfirm, onChange, onCalibrate, onToggleNts, onOpen,
  schedules, scheduleChoice, onChooseSchedule, onConfirmSchedule, scheduleNote,
  onClose,
}) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  const chosen = schedules.find((c) => c.id === scheduleChoice) || null;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.32)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 40 }} onClick={onClose}>
      <div role="dialog" aria-labelledby="scale-review-title" onClick={(e) => e.stopPropagation()}
        style={{ width: "min(860px, 94vw)", maxHeight: "86vh", overflow: "auto", background: "var(--paper-bright)", border: "1px solid var(--ink-faint)", boxShadow: "var(--shadow-2)", padding: 16, fontSize: 12.5, color: "var(--ink)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <h2 id="scale-review-title" style={{ margin: 0, fontSize: 15 }}>Scale review</h2>
          <strong data-testid="scale-summary">{summary.text}</strong>
          {scanning && <span style={{ color: "var(--ink-faint)" }}>reading sheets…</span>}
          <span style={{ flex: 1 }} />
          <button style={btn} onClick={onClose}>Close</button>
        </div>
        <p style={{ margin: "6px 0 10px", color: "var(--ink-faint)" }}>
          Scales read from each sheet's scale note. A detected scale is applied but stays <em>unconfirmed</em> (measuring there shows a warning) until you confirm it. Check one printed dimension (K) before you confirm.
        </p>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ textAlign: "left", borderBottom: "1px solid var(--ink-faint)" }}>
            <th>Sheet</th><th>Status</th><th>Scale</th><th>Source · confidence</th><th style={{ textAlign: "right" }}>Actions</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => {
              const face = STATE_FACE[r.state];
              const conf = scaleConfidence(r.detected);
              return (
                <tr key={r.key} data-sheet={r.key} style={{ borderBottom: "1px solid var(--paper)" }}>
                  <td><button style={{ ...btn, border: "none", background: "none", textDecoration: "underline" }} onClick={() => onOpen(r.key)}>{r.label}</button></td>
                  <td style={{ color: face.color, fontWeight: 600 }}>{face.text}</td>
                  <td>{r.scaleLabel || (r.detected ? `plan: ${r.detected.label}` : "—")}</td>
                  <td>{r.state === "confirmed" && r.source !== "detected" ? (SOURCE_TEXT[r.source] || "set") : r.detected ? `${conf.label} · ${Math.round(conf.value * 100)}%` : "No scale note found"}</td>
                  <td style={{ textAlign: "right" }}>
                    <span style={{ display: "inline-flex", gap: 4 }}>
                      {(r.state === "needs-confirm" || (r.state === "detected" && r.detected)) && <button style={btn} onClick={() => onConfirm(r.key)}>Confirm</button>}
                      <select aria-label={`Change scale for ${r.label}`} style={{ fontSize: 11.5 }} value="" onChange={(e) => { const v = e.target.value; if (v === "__cal") onCalibrate(r.key); else if (v) onChange(r.key, v); }}>
                        <option value="">Change…</option>
                        {standardScales.map((s) => <option key={s.label} value={s.label}>{s.label}</option>)}
                        <option value="__cal">Calibrate from a known dimension…</option>
                      </select>
                      <button style={btn} onClick={() => onToggleNts(r.key)}>{r.state === "nts" ? "Undo NTS" : "NTS"}</button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <h3 style={{ fontSize: 13.5, margin: "16px 0 4px" }}>Finish schedule</h3>
        {schedules.length === 0 ? (
          <p style={{ margin: 0, color: "var(--ink-faint)" }}>{scheduleNote || (scanning ? "Looking for schedules…" : "No schedule table found in the sheet text. Draw a box around it with Import from schedule.")}</p>
        ) : (
          <>
            <p style={{ margin: "0 0 6px", color: "var(--ink-faint)" }}>Suggested from the plan text. Door and device schedules are listed last. Nothing imports until you confirm.</p>
            {schedules.map((c) => (
              <label key={c.id} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "2px 0", opacity: c.demoted ? 0.7 : 1 }}>
                <input type="radio" name="sched" checked={scheduleChoice === c.id} onChange={() => onChooseSchedule(c.id)} />
                <span><strong>{c.title}</strong> — {c.sheetLabel} · {c.reason}{c.suggested ? " · suggested" : ""}</span>
              </label>
            ))}
            <div style={{ marginTop: 8 }}>
              <button style={{ ...btn, fontWeight: 600 }} disabled={!chosen} onClick={() => chosen && onConfirmSchedule(chosen)}>
                Confirm and read this schedule
              </button>
              {chosen?.demoted && <span style={{ marginLeft: 8, color: "var(--c-warning)" }}>This isn't a finish schedule — the reader may refuse it.</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
