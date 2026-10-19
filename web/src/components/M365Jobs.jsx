// FLOOR360 per-job projects on SharePoint (Microsoft 365 builds): the
// project list at /projects and the job canvas at /?job=<folderId>.
//
//   M365ProjectsGate  sign in with Microsoft, list the job folders under the
//                     build's project root ("OpenTakeoff Projects"), grouped by
//                     salesperson folder (older jobs at the top level too), open
//                     one, or create a new one in a salesperson folder.
//   M365JobGate       sign in, install cloudStore on the job folder with the
//                     Graph client (PDFs in the folder, annotations in
//                     .opentakeoff/), then mount the canvas.
//
// MSAL and the Graph client load only here (dynamic imports). The one
// delegated scope is the build's (Sites.Selected on FLOOR360); the token stays
// in this browser. Every failure is a readable state (projectErrorMessage),
// including the 403 a library returns before its site grant is finished.
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import TakeoffCanvas from "../pages/TakeoffCanvas.jsx";
import { setActiveStore } from "../lib/store.js";
import { LOW_MEMORY_DEVICE } from "../lib/deviceClass";
import { byteBudget } from "../lib/pdfBytes";
import { UNASSIGNED_GROUP, createProject, filterProjectGroups, jobHref, listProjectGroups, projectErrorMessage } from "../lib/msgraph/projects.js";
import { floor360PrivateBuild } from "../lib/privateBuild.js";
import AiDraftsSection from "./AiDraftsSection.jsx";

const centered = {
  minHeight: "100vh", display: "flex", flexDirection: "column",
  alignItems: "center", justifyContent: "center", gap: 14, padding: 24,
  textAlign: "center", background: "var(--paper-bright)", color: "var(--ink)",
};
const brand = (
  <strong style={{ fontFamily: "var(--f-display)", fontSize: 20, letterSpacing: "-0.02em" }}>
    open<span style={{ fontStyle: "italic", color: "var(--cobalt)" }}>takeoff</span>
  </strong>
);
const primaryBtn = {
  padding: "9px 16px", border: "1px solid var(--ink)", background: "var(--ink)",
  color: "var(--paper-bright)", cursor: "pointer", fontWeight: 600, fontSize: 13.5,
};
const linkBtn = { border: "none", background: "transparent", color: "var(--ink-muted)", fontSize: 12.5, cursor: "pointer", textDecoration: "underline" };
const errStyle = { fontSize: 12.5, color: "var(--c-danger)", maxWidth: 520 };
const LOCAL_HREF = "/?local=1";

/** MSAL + Graph for `cfg`, loaded once: {status, graph, signIn, err}.
 *  status: checking | signin | ready | dead */
function useM365(cfg) {
  const [status, setStatus] = useState("checking");
  const [err, setErr] = useState("");
  const mods = useRef(null);
  const [graph, setGraph] = useState(null);

  async function load() {
    if (mods.current) return mods.current;
    const [{ createMsalAuth }, { createGraphDrive }] = await Promise.all([
      import("../lib/msgraph/auth.js"),
      import("../lib/msgraph/graphDrive.js"),
    ]);
    const auth = createMsalAuth(cfg);
    mods.current = { auth, graph: createGraphDrive({ getToken: auth.getToken, driveId: cfg.driveId }) };
    return mods.current;
  }
  useEffect(() => {
    let live = true;
    load().then(async (m) => {
      const acc = await m.auth.currentAccount();
      if (!live) return;
      if (acc) { setGraph(m.graph); setStatus("ready"); } else setStatus("signin");
    }).catch((e) => { if (live) { setErr(String(e?.message || e)); setStatus("dead"); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const signIn = async () => {
    setErr("");
    try {
      const m = await load();
      await m.auth.signIn();
      setGraph(m.graph);
      setStatus("ready");
    } catch (e) {
      setErr(`Sign-in failed: ${String(e?.message || e)}`);
    }
  };
  return { status, graph, signIn, err };
}

function SignIn({ title, body, signIn, err }) {
  return (
    <div style={centered}>
      {brand}
      <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 13, color: "var(--ink-muted)", maxWidth: 460 }}>{body}</div>
      <button type="button" onClick={signIn} style={primaryBtn}>Sign in with Microsoft</button>
      {err ? <div style={errStyle}>{err}</div> : null}
      <a href={LOCAL_HREF} style={linkBtn}>work locally in this browser</a>
    </div>
  );
}

function Dead({ err }) {
  return (
    <div style={centered}>
      {brand}
      <div style={{ fontSize: 15, fontWeight: 600 }}>SharePoint projects can't load</div>
      <div style={errStyle}>{err || "The Microsoft sign-in layer failed to load."}</div>
      <a href={LOCAL_HREF} style={linkBtn}>work locally in this browser</a>
    </div>
  );
}

const fmtDate = (iso) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
};

/** Job rows; each opens /?job=<folder id>, so a job opens the same at the top level or in a salesperson folder. */
function ProjectList({ projects }) {
  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, borderTop: projects.length ? "1px solid var(--ink-faint)" : "none" }}>
      {projects.map((p) => (
        <li key={p.id} style={{ borderBottom: "1px solid var(--ink-faint)" }}>
          <Link to={jobHref(p.id)} style={{ display: "flex", gap: 12, padding: "10px 4px", color: "inherit", textDecoration: "none" }}>
            <span style={{ fontWeight: 600 }}>{p.name}</span>
            <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--ink-muted)" }}>{fmtDate(p.modifiedTime)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function M365ProjectsGate({ cfg }) {
  const { status, graph, signIn, err } = useM365(cfg);
  const navigate = useNavigate();
  const [listing, setListing] = useState(null);   // { groups: [{ id, name, projects }], projects } (old top-level jobs)
  const cache = useRef(new Map());                 // folder id -> children; Refresh starts over
  const [group, setGroup] = useState(UNASSIGNED_GROUP);
  const [listErr, setListErr] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [createErr, setCreateErr] = useState("");
  const [filter, setFilter] = useState("");

  const refresh = () => {
    if (!graph) return;
    setListErr("");
    cache.current = new Map();
    listProjectGroups(graph, cfg.folderId, cache.current)
      .then(setListing)
      .catch((e) => { setListing({ groups: [], projects: [] }); setListErr(projectErrorMessage(e)); });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(refresh, [graph]);

  if (status === "checking") return null;
  if (status === "dead") return <Dead err={err} />;
  if (status === "signin") {
    return <SignIn signIn={signIn} err={err} title="Your projects live in SharePoint"
      body="Sign in with your FLOOR360 Microsoft account to open a job or start a new one. Each job is its own folder in OpenTakeoff Projects, with its plans and takeoff." />;
  }

  const create = async (e) => {
    e.preventDefault();
    setCreateErr("");
    setBusy(true);
    try {
      const made = await createProject(graph, cfg.folderId, name, group);
      navigate(jobHref(made.id));
    } catch (e2) {
      setCreateErr(projectErrorMessage(e2));
    } finally {
      setBusy(false);
    }
  };
  const shown = filterProjectGroups(listing || { groups: [], projects: [] }, filter);
  const total = listing ? listing.projects.length + listing.groups.reduce((n, g) => n + g.projects.length, 0) : 0;
  const shownCount = shown.projects.length + shown.groups.reduce((n, g) => n + g.projects.length, 0);
  // New project: any salesperson folder in the list, plus Unassigned.
  const groupNames = [...new Set([UNASSIGNED_GROUP, ...(listing?.groups || []).map((g) => g.name)])];

  return (
    <div style={{ minHeight: "100vh", background: "var(--paper-bright)", color: "var(--ink)", padding: "32px 24px" }} data-m365-projects="">
      <div style={{ maxWidth: 720, margin: "0 auto", display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          {brand}
          <span style={{ fontSize: 15, fontWeight: 600 }}>Projects</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 14 }}>
            <button type="button" onClick={refresh} style={linkBtn}>refresh</button>
            <a href={LOCAL_HREF} style={linkBtn}>work locally</a>
          </span>
        </div>
        <form onSubmit={create} style={{ display: "flex", gap: 8 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project: job name or number"
            className="field-input" aria-label="New project name" style={{ flex: 1 }} disabled={busy} />
          <select value={group} onChange={(e) => setGroup(e.target.value)} className="field-input" aria-label="Salesperson folder" disabled={busy}
            title="The salesperson folder the new project goes in">
            {groupNames.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
          <button type="submit" style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }} disabled={busy}>New project</button>
        </form>
        {createErr ? <div style={errStyle} role="alert">{createErr}</div> : null}
        {floor360PrivateBuild() ? <AiDraftsSection /> : null}
        {listErr ? <div style={errStyle} role="alert">{listErr}</div> : null}
        {total > 8 ? (
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter projects or salespeople" className="field-input" aria-label="Filter projects" />
        ) : null}
        {listing === null ? <div style={{ fontSize: 13, color: "var(--ink-muted)" }}>Loading projects…</div> : null}
        {listing && !total && !listErr ? (
          <div style={{ fontSize: 13, color: "var(--ink-muted)" }}>No projects yet. Name one above to start.</div>
        ) : null}
        {listing && total > 0 && !shownCount ? <div style={{ fontSize: 13, color: "var(--ink-muted)" }}>No project matches.</div> : null}
        {shown.groups.map((g) => (
          <section key={g.id} data-salesperson-group={g.name}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-muted)", margin: "4px 0" }}>{g.name}</div>
            <ProjectList projects={g.projects} />
          </section>
        ))}
        {shown.projects.length ? (
          <section data-salesperson-group="">
            {shown.groups.length ? <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink-muted)", margin: "4px 0" }}>Other projects</div> : null}
            <ProjectList projects={shown.projects} />
          </section>
        ) : null}
      </div>
    </div>
  );
}

export function M365JobGate({ cfg, jobId }) {
  const { status, graph, signIn, err } = useM365(cfg);
  const [ready, setReady] = useState(false);
  const [openErr, setOpenErr] = useState("");

  useEffect(() => {
    if (!graph) return;
    let live = true;
    setReady(false);
    setOpenErr("");
    (async () => {
      try {
        const { createCloudStore } = await import("../lib/cloudStore.js");
        if (!live) return;
        const store = createCloudStore(jobId, graph, { maxPdfBytes: byteBudget(LOW_MEMORY_DEVICE) });
        await store.listSheets();   // reach the folder once: a 403 / 404 is a readable screen, not a blank canvas
        if (!live) return;
        setActiveStore(store);
        setReady(true);
      } catch (e) {
        if (live) setOpenErr(projectErrorMessage(e));
      }
    })();
    return () => { live = false; };
  }, [graph, jobId]);
  // leaving the job restores the local store
  useEffect(() => () => { setActiveStore(); }, []);

  if (status === "checking") return null;
  if (status === "dead") return <Dead err={err} />;
  if (status === "signin") {
    return <SignIn signIn={signIn} err={err} title="This project is stored in SharePoint"
      body="Sign in with your FLOOR360 Microsoft account to open it." />;
  }
  if (openErr) {
    return (
      <div style={centered}>
        {brand}
        <div style={{ fontSize: 15, fontWeight: 600 }}>Couldn't open this project</div>
        <div style={errStyle} role="alert">{openErr}</div>
        <Link to="/projects" style={linkBtn}>back to projects</Link>
      </div>
    );
  }
  if (!ready) return <div style={centered}>{brand}<div style={{ fontSize: 15, fontWeight: 600 }}>Opening project…</div></div>;
  return <TakeoffCanvas key={`job:${jobId}`} />;
}
