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
 *  silently opening someone else's job. */
export async function createProject(graph, rootId, raw) {
  const checked = checkProjectName(raw);
  if (checked.error) throw new Error(checked.error);
  const existing = await graph.findChild(rootId, checked.name);
  if (existing) throw new Error(`A project named "${checked.name}" already exists. Open it from the list.`);
  return graph.createFolder(rootId, checked.name);
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
