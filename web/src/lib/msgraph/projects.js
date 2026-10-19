// FLOOR360 per-job projects on SharePoint (Microsoft 365 builds).
//
// Each job is its own folder under the build's project root
// (VITE_GRAPH_FOLDER_ID, "OpenTakeoff Projects" on the Estimating site).
// Opening a job installs cloudStore on that folder with the Graph client,
// so the job's plan PDFs sit in the folder and its annotations in
// <job>/.opentakeoff/ (annotations.json, sheets.json), the same layout a
// Google Drive project uses. Only the one Sites.Selected scope is used.
//
// Pure helpers over the injected Graph client (graphDrive.js), unit-tested.

const FOLDER_MIME = "application/vnd.google-apps.folder";   // graphDrive maps folders onto it
const ITEM_ID = /^[A-Z0-9]{20,64}$/;
// SharePoint / OneDrive refuse these in a name
const BAD_CHARS = /["*:<>?/\\|#%]/;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d|_vti_|desktop\.ini)$/i;
export const PROJECT_NAME_MAX = 120;

/** The job folder id in the URL (`?job=`), or "". */
export function jobIdFromSearch(search) {
  try {
    const id = new URLSearchParams(search || "").get("job") || "";
    return ITEM_ID.test(id) ? id : "";
  } catch {
    return "";
  }
}

export const jobHref = (id) => `/?job=${encodeURIComponent(id)}`;

/** A SharePoint folder id `?job=` will open. */
export const isJobFolderId = (id) => ITEM_ID.test(String(id ?? ""));

/** The root's job folders, newest change first. Dot-folders are ours
 *  (.opentakeoff), not jobs. */
export async function listProjects(graph, rootId) {
  const children = await graph.listChildren(rootId);
  return children
    .filter((c) => c.mimeType === FOLDER_MIME && !c.name.startsWith("."))
    .map((c) => ({ id: c.id, name: c.name, modifiedTime: c.modifiedTime || "" }))
    .sort((a, b) => String(b.modifiedTime).localeCompare(String(a.modifiedTime)) || a.name.localeCompare(b.name));
}

const jobFolders = (children) => children.filter((c) => c.mimeType === FOLDER_MIME && !c.name.startsWith("."));
const asProject = (c) => ({ id: c.id, name: c.name, modifiedTime: c.modifiedTime || "" });
const byNewest = (a, b) => String(b.modifiedTime).localeCompare(String(a.modifiedTime)) || a.name.localeCompare(b.name);

/** A top-level folder is a salesperson group when it has no .opentakeoff of its own and holds a
 *  bid project folder ("<x> - F360-…"), or only folders (no PDFs). Otherwise it is an old job. */
export function isSalespersonGroup(children) {
  if (children.some((c) => c.name === ".opentakeoff")) return false;
  const folders = jobFolders(children);
  if (folders.some((c) => BID_PROJECT.test(c.name))) return true;
  return folders.length > 0 && !children.some((c) => c.mimeType === PDF_MIME);
}

// Bids saves AI takeoffs as OpenTakeoff Projects/<salesperson>/<project> - <bid number>/ (Ryan, 2026-10-18).
// Older jobs sit directly under the root, so the list reads both layouts.
const BID_PROJECT = / - F360-\d{2}-\d+( \(\d+\))?$/i;
const PDF_MIME = "application/pdf";
/** The salesperson folder Bids uses when a bid has no salesperson. */
export const UNASSIGNED_GROUP = "Unassigned";

/** A folder's children, read once per cache (Refresh starts a new Map). */
function childrenOf(graph, folderId, cache) {
  if (!cache.has(folderId)) cache.set(folderId, graph.listChildren(folderId));
  return cache.get(folderId);
}

/** Both layouts: { groups: [{ id, name, projects }], projects } where projects are old top-level jobs.
 *  One children call for the root, then one per top-level folder not named like a bid project, cached. */
export async function listProjectGroups(graph, rootId, cache = new Map()) {
  const top = jobFolders(await childrenOf(graph, rootId, cache));
  const groups = [];
  const projects = [];
  await Promise.all(top.map(async (folder) => {
    if (BID_PROJECT.test(folder.name)) {
      projects.push(asProject(folder));
      return;
    }
    const children = await childrenOf(graph, folder.id, cache);
    if (folder.name === UNASSIGNED_GROUP || isSalespersonGroup(children)) {
      groups.push({ id: folder.id, name: folder.name, projects: jobFolders(children).map(asProject).sort(byNewest) });
    } else {
      projects.push(asProject(folder));
    }
  }));
  groups.sort((a, b) => a.name.localeCompare(b.name));
  return { groups, projects: projects.sort(byNewest) };
}

/** Search across groups: a project matches by its own name or its salesperson's; empty groups drop out. */
export function filterProjectGroups(listing, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return listing;
  const hit = (name) => name.toLowerCase().includes(q);
  return {
    groups: listing.groups
      .map((g) => ({ ...g, projects: hit(g.name) ? g.projects : g.projects.filter((p) => hit(p.name)) }))
      .filter((g) => g.projects.length > 0),
    projects: listing.projects.filter((p) => hit(p.name)),
  };
}

/** A job name SharePoint will take, or an error to show. */
export function checkProjectName(raw) {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!name) return { error: "Name the project (the job name or number)." };
  if (name.length > PROJECT_NAME_MAX) return { error: `Keep the name under ${PROJECT_NAME_MAX} characters.` };
  if (BAD_CHARS.test(name)) return { error: "SharePoint names can't contain \" * : < > ? / \\ | # %." };
  if (name.startsWith(".") || name.endsWith(".") || RESERVED.test(name)) return { error: "SharePoint won't take that name. Try another." };
  return { name };
}

/** Create the job folder; refuses a name that already exists, rather than
 *  silently opening someone else's job. With a salesperson group the job goes in
 *  <root>/<group>/, and the group folder is made first if it is missing (e.g. Unassigned). */
export async function createProject(graph, rootId, raw, group = "") {
  const checked = checkProjectName(raw);
  if (checked.error) throw new Error(checked.error);
  let parentId = rootId;
  if (group) {
    const groupName = checkProjectName(group);
    if (groupName.error) throw new Error(groupName.error);
    const found = await graph.findChild(rootId, groupName.name);
    parentId = (found || (await graph.createFolder(rootId, groupName.name))).id;
  }
  const existing = await graph.findChild(parentId, checked.name);
  if (existing) throw new Error(`A project named "${checked.name}" already exists. Open it from the list.`);
  return graph.createFolder(parentId, checked.name);
}

/** A Graph failure as one plain sentence for the project screens. A 403 is
 *  the Estimating site not yet granted to this app (Sites.Selected write),
 *  or an account without access. */
export function projectErrorMessage(e) {
  const status = e?.status;
  if (status === 403) {
    return "SharePoint said no (HTTP 403): OpenTakeoff doesn't have write access to the Estimating site yet. "
      + "An admin has to finish the Sites.Selected write grant for this app, or your account can't open that library. Nothing was changed.";
  }
  if (status === 401) return "Your Microsoft 365 sign-in expired. Sign in again.";
  if (/HTTP 404/.test(String(e?.message))) return "That project folder isn't there any more. It may have been moved or deleted in SharePoint.";
  return String(e?.message || e);
}
