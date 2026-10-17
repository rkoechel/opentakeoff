// FLOOR360 per-job projects on SharePoint (lib/msgraph/projects.js): job
// folders listed under the project root, new projects refused on a name
// clash or a name SharePoint won't take, ?job= ids validated, and a 403
// (site grant not finished) read as one plain sentence. A job folder opened
// with cloudStore keeps its PDFs in the folder and annotations in
// .opentakeoff/, over the Graph client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkProjectName, createProject, jobHref, jobIdFromSearch, listProjects, projectErrorMessage } from "../src/lib/msgraph/projects.js";
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
