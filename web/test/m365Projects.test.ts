// FLOOR360 per-job projects on SharePoint (lib/msgraph/projects.js): job
// folders listed under the project root, new projects refused on a name
// clash or a name SharePoint won't take, ?job= ids validated, and a 403
// (site grant not finished) read as one plain sentence. A job folder opened
// with cloudStore keeps its PDFs in the folder and annotations in
// .opentakeoff/, over the Graph client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { UNASSIGNED_GROUP, checkProjectName, createProject, filterProjectGroups, isSalespersonGroup, jobHref, jobIdFromSearch, listProjectGroups, listProjects, projectErrorMessage } from "../src/lib/msgraph/projects.js";
import { GraphAuthError, createGraphDrive } from "../src/lib/msgraph/graphDrive.js";

const FOLDER = "application/vnd.google-apps.folder";
const ROOT = "01NF4SHUHQPL6SK4HCAZDIH4FBNHIW7NFJ";

function fakeGraph(children: { id: string; name: string; mimeType: string; modifiedTime?: string }[]) {
  const made: string[] = [];
  return {
    made,
    listChildren: async (id: string) => { assert.equal(id, ROOT); return children; },
    findChild: async (_id: string, name: string) => children.find((c) => c.name === name) || null,
    createFolder: async (_id: string, name: string) => { made.push(name); return { id: "01NEWFOLDERIDNEWFOLDERID", name }; },
  };
}

test("lists job folders, newest first, without dot-folders or files", async () => {
  const g = fakeGraph([
    { id: "A", name: "Old job", mimeType: FOLDER, modifiedTime: "2026-01-01T00:00:00Z" },
    { id: "B", name: ".opentakeoff", mimeType: FOLDER },
    { id: "C", name: "readme.pdf", mimeType: "application/pdf" },
    { id: "D", name: "24-118 Hospital", mimeType: FOLDER, modifiedTime: "2026-10-01T00:00:00Z" },
  ]);
  assert.deepEqual((await listProjects(g as never, ROOT)).map((p) => p.name), ["24-118 Hospital", "Old job"]);
});

test("new project: trimmed, refused on a clash or a bad name", async () => {
  const g = fakeGraph([{ id: "A", name: "Existing", mimeType: FOLDER }]);
  assert.deepEqual(await createProject(g as never, ROOT, "  24-200   School "), { id: "01NEWFOLDERIDNEWFOLDERID", name: "24-200 School" });
  await assert.rejects(createProject(g as never, ROOT, "Existing"), /already exists/);
  await assert.rejects(createProject(g as never, ROOT, "a/b"), /can't contain/);
  assert.equal(checkProjectName("").error !== undefined, true);
  assert.equal(checkProjectName("x".repeat(121)).error !== undefined, true);
  assert.equal(checkProjectName("con").error !== undefined, true);
  assert.deepEqual(g.made, ["24-200 School"]);
});

test("?job= takes a driveItem id only", () => {
  assert.equal(jobIdFromSearch("?job=01NF4SHUHQPL6SK4HCAZDIH4FBNHIW7NFJ"), ROOT);
  assert.equal(jobIdFromSearch("?job=../etc"), "");
  assert.equal(jobIdFromSearch("?job=root"), "");
  assert.equal(jobIdFromSearch(""), "");
  assert.equal(jobHref(ROOT), `/?job=${ROOT}`);
});

test("a 403 from SharePoint reads as the site grant, without Graph's JSON", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, headers: { get: () => null }, text: async () => '{"error":{"code":"accessDenied","message":"Access denied"}}', json: async () => ({}) });
  const graph = createGraphDrive({ getToken: async () => "t", driveId: "b!x", fetch: fetchImpl as never, sleep: async () => {} });
  const err = await graph.listChildren(ROOT).catch((e: unknown) => e) as GraphAuthError & { detail?: string };
  assert.ok(err instanceof GraphAuthError);
  assert.equal(err.status, 403);
  assert.doesNotMatch(err.message, /accessDenied/);
  assert.match(err.detail || "", /accessDenied/);
  assert.match(projectErrorMessage(err), /^SharePoint said no \(HTTP 403\).*Sites\.Selected write grant/);
  assert.match(projectErrorMessage({ status: 401 }), /sign-in expired/);
  assert.equal(projectErrorMessage(new Error("boom")), "boom");
});

// Bids layout: OpenTakeoff Projects/<salesperson>/<project> - <bid number>/, next to older top-level jobs.
const PDF = "application/pdf";
type Item = { id: string; name: string; mimeType: string; modifiedTime?: string };

function treeGraph(tree: Record<string, Item[]>) {
  const calls: string[] = [];
  const made: string[] = [];
  return {
    calls,
    made,
    listChildren: async (id: string) => { calls.push(id); return tree[id] || []; },
    findChild: async (id: string, name: string) => (tree[id] || []).find((c) => c.name === name) || null,
    createFolder: async (id: string, name: string) => {
      const folder = { id: `NEW-${name}`, name, mimeType: FOLDER };
      (tree[id] ||= []).push(folder);
      made.push(`${id}/${name}`);
      return { id: folder.id, name };
    },
  };
}

const MIXED = (): Record<string, Item[]> => ({
  [ROOT]: [
    { id: "OLD1", name: "24-118 Hospital", mimeType: FOLDER, modifiedTime: "2026-03-01T00:00:00Z" },
    { id: "OLD2", name: "Perfumania - F360-26-0170", mimeType: FOLDER, modifiedTime: "2026-10-01T00:00:00Z" },
    { id: "ROB", name: "Rob Palermo", mimeType: FOLDER },
    { id: "UN", name: "Unassigned", mimeType: FOLDER },
    { id: "DOT", name: ".opentakeoff", mimeType: FOLDER },
  ],
  OLD1: [{ id: "P1", name: "A101.pdf", mimeType: PDF }, { id: "S1", name: "Specs", mimeType: FOLDER }],
  ROB: [
    { id: "J1", name: "School - F360-26-0180", mimeType: FOLDER, modifiedTime: "2026-10-10T00:00:00Z" },
    { id: "J2", name: "Clinic - F360-26-0181", mimeType: FOLDER, modifiedTime: "2026-10-12T00:00:00Z" },
  ],
  UN: [],
});

test("mixed layout: salesperson groups and old top-level jobs, one children call per folder, cached", async () => {
  const g = treeGraph(MIXED());
  const cache = new Map();
  const listing = await listProjectGroups(g as never, ROOT, cache);
  assert.deepEqual(listing.groups.map((x: { name: string; projects: { name: string }[] }) => [x.name, x.projects.map((p: { name: string }) => p.name)]), [
    ["Rob Palermo", ["Clinic - F360-26-0181", "School - F360-26-0180"]],
    ["Unassigned", []],
  ]);
  assert.deepEqual(listing.projects.map((p) => p.name), ["Perfumania - F360-26-0170", "24-118 Hospital"], "old top-level jobs still show");
  assert.deepEqual([...g.calls].sort(), [ROOT, "OLD1", "ROB", "UN"].sort(), "the root once, then each top-level folder not named like a bid once");
  await listProjectGroups(g as never, ROOT, cache);
  assert.equal(g.calls.length, 4, "a second list with the same cache makes no call");
  assert.equal(listing.groups[0]!.projects[0]!.id, "J2", "a nested job opens by its own folder id");
  assert.equal(listing.groups[1]!.projects.length, 0, "an empty Unassigned folder is still a group");
});

test("a folder with its own .opentakeoff or PDFs is a job, not a group", () => {
  assert.equal(isSalespersonGroup([{ id: "x", name: ".opentakeoff", mimeType: FOLDER }, { id: "y", name: "A - F360-26-0001", mimeType: FOLDER }]), false);
  assert.equal(isSalespersonGroup([{ id: "y", name: "Kitchen", mimeType: FOLDER }]), true, "only folders: a group");
  assert.equal(isSalespersonGroup([{ id: "y", name: "Kitchen", mimeType: FOLDER }, { id: "p", name: "a.pdf", mimeType: PDF }]), false, "PDFs: a job");
  assert.equal(isSalespersonGroup([]), false, "empty: a job");
  assert.equal(isSalespersonGroup([{ id: "y", name: "Kitchen", mimeType: FOLDER }, { id: "p", name: "a.pdf", mimeType: PDF }, { id: "q", name: ".opentakeoff", mimeType: FOLDER }]), false, "PDFs and .opentakeoff: a job");
});

test("search across groups: by project name or by salesperson", async () => {
  const listing = await listProjectGroups(treeGraph(MIXED()) as never, ROOT);
  const byName = filterProjectGroups(listing, "clinic");
  assert.deepEqual(byName.groups.map((x: { name: string; projects: { name: string }[] }) => [x.name, x.projects.map((p: { name: string }) => p.name)]), [["Rob Palermo", ["Clinic - F360-26-0181"]]]);
  assert.deepEqual(byName.projects, [], "groups and old jobs without a match drop out");
  assert.equal(filterProjectGroups(listing, "palermo").groups[0]!.projects.length, 2, "the salesperson name shows all their jobs");
  assert.deepEqual(filterProjectGroups(listing, "hospital").projects.map((p: { name: string }) => p.name), ["24-118 Hospital"]);
  assert.equal(filterProjectGroups(listing, "  "), listing, "a blank search shows everything");
});

test("new project goes in the chosen salesperson folder; Unassigned is made when missing", async () => {
  const g = treeGraph(MIXED());
  assert.deepEqual(await createProject(g as never, ROOT, "Gym - F360-26-0190", "Rob Palermo"), { id: "NEW-Gym - F360-26-0190", name: "Gym - F360-26-0190" });
  assert.deepEqual(g.made, ["ROB/Gym - F360-26-0190"]);
  await assert.rejects(createProject(g as never, ROOT, "School - F360-26-0180", "Rob Palermo"), /already exists/);
  const fresh = treeGraph({ [ROOT]: [] });
  await createProject(fresh as never, ROOT, "Pool", UNASSIGNED_GROUP);
  assert.deepEqual(fresh.made, [`${ROOT}/Unassigned`, "NEW-Unassigned/Pool"]);
  await createProject(fresh as never, ROOT, "Old style");
  assert.equal(fresh.made[2], `${ROOT}/Old style`, "no group: the root, as before");
  await assert.rejects(createProject(fresh as never, ROOT, "Pool 2", "a/b"), /can't contain/);
  await assert.rejects(createProject(fresh as never, ROOT, "Pool 3", "a/b/c"), /can't contain/);
});
