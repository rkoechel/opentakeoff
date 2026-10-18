// FLOOR360 auto-takeoff: the "AI drafts" section on /projects. It renders
// nothing unless this site's /api/bids/drafts route says AI drafts are on.
// Claim review is first-wins in Bids; a lost race shows who took it. Open goes
// to the job folder through the same ?job= path an existing project uses.
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { claimDraft, claimText, formatCt, loadAiDrafts } from "../lib/bidsDrafts.js";
import { isJobFolderId, jobHref } from "../lib/msgraph/projects.js";

const btn = { padding: "5px 12px", border: "1px solid var(--ink)", background: "var(--paper-bright)", color: "var(--ink)", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap", textDecoration: "none" };
const muted = { fontSize: 12, color: "var(--ink-muted)" };
const errStyle = { fontSize: 12.5, color: "var(--c-danger)" };

function countsLine(c) {
  if (!c) return "";
  const part = (n, one, many) => (Number.isInteger(n) ? `${n} ${n === 1 ? one : many}` : "");
  return [part(c.sheets, "sheet", "sheets"), part(c.rooms, "room", "rooms"), part(c.conditions, "condition", "conditions"), part(c.rfisDrafted, "RFI drafted", "RFIs drafted")]
    .filter(Boolean).join(" · ");
}

export default function AiDraftsSection() {
  const [state, setState] = useState(null);   // null while asking; {enabled, user, drafts, error}
  const [busy, setBusy] = useState("");       // runId being claimed
  const [rowErr, setRowErr] = useState({});   // runId -> message

  const refresh = () => { loadAiDrafts().then(setState); };
  useEffect(refresh, []);
  if (!state?.enabled) return null;

  const me = state.user?.email || "";
  const claim = async (runId) => {
    setBusy(runId);
    setRowErr((m) => ({ ...m, [runId]: "" }));
    const r = await claimDraft(runId);
    setBusy("");
    if (r.error) { setRowErr((m) => ({ ...m, [runId]: r.error })); return; }
    const { claimedByEmail, claimedAt, claimedByName } = r;
    setState((s) => s && ({ ...s, drafts: s.drafts.map((d) => (d.runId === runId ? { ...d, claimedByEmail, claimedAt, ...(claimedByName ? { claimedByName } : {}) } : d)) }));
  };

  return (
    <section data-ai-drafts="" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>AI drafts</span>
        <span style={muted}>Draft only. Verify before pricing.</span>
        <button type="button" onClick={refresh} style={{ marginLeft: "auto", border: "none", background: "transparent", color: "var(--ink-muted)", fontSize: 12.5, cursor: "pointer", textDecoration: "underline" }}>refresh</button>
      </div>
      {state.error ? <div style={errStyle} role="alert">{state.error}</div> : null}
      {!state.error && !state.drafts.length ? <div style={muted}>No AI drafts waiting for review.</div> : null}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, borderTop: state.drafts.length ? "1px solid var(--ink-faint)" : "none" }}>
        {state.drafts.map((d) => {
          const title = [d.projectName, d.bidNumber].filter(Boolean).join(" - ") || d.runId;
          const claimed = claimText(d, me);
          const due = formatCt(d.dueAt);
          return (
            <li key={d.runId} data-run={d.runId} style={{ borderBottom: "1px solid var(--ink-faint)", padding: "10px 4px", display: "flex", gap: 12, alignItems: "center" }}>
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={{ fontWeight: 600 }}>{title}</span>
                <span style={muted}>{[d.gc, due ? `due ${due}` : "", countsLine(d.counts)].filter(Boolean).join(" · ")}</span>
                {claimed ? <span style={muted}>{claimed}</span> : null}
                {rowErr[d.runId] ? <span style={errStyle} role="alert">{rowErr[d.runId]}</span> : null}
              </div>
              {!d.claimedByEmail ? (
                <button type="button" style={{ ...btn, opacity: busy === d.runId ? 0.6 : 1 }} disabled={!!busy} onClick={() => claim(d.runId)}>
                  Claim review
                </button>
              ) : null}
              {isJobFolderId(d.sharepointFolderId)
                ? <Link to={jobHref(d.sharepointFolderId)} style={btn}>Open</Link>
                : d.sharepointFolderUrl ? <a href={d.sharepointFolderUrl} target="_blank" rel="noreferrer" style={btn}>Open in SharePoint</a> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
