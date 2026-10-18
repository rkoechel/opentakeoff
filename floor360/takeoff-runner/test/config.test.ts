// Settings: unset means off and loopback; service URLs stay on the Spark's own
// network; names and CSV cells are safe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, serviceUrl } from "../src/config.ts";
import { reportCsv } from "../src/outputs.ts";
import { classifyRow, loadOrder } from "../src/pipeline.ts";
import { setName } from "../src/types.ts";
import { setManifest } from "./fakes.ts";

test("with nothing set: disabled, no token, 127.0.0.1:8014, the Spark's vision and waker, 60 min, 7 days, one job", () => {
  const c = loadConfig({});
  assert.equal(c.enabled, false);
  assert.equal(c.token, "");
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.port, 8014);
  assert.equal(c.dataDir, "/var/lib/takeoff-runner");
  assert.equal(c.visionBaseUrl, "http://127.0.0.1:8010/v1");
  assert.equal(c.wakerUrl, "http://127.0.0.1:8012");
  assert.equal(c.jobTimeoutMs, 60 * 60_000);
  assert.equal(c.retentionMs, 7 * 24 * 3600_000);
  assert.equal(c.noMemoryRetryMs, 15 * 60_000);
  assert.equal(c.noMemoryMaxMs, 4 * 3600_000);
  assert.equal(c.concurrency, 1);
  assert.equal(c.concurrencyIgnored, false);
  assert.equal(loadConfig({ RUNNER_ENABLED: "true" }).enabled, false, "only the literal 1 turns it on");
  assert.equal(loadConfig({ RUNNER_ENABLED: "1" }).enabled, true);
  assert.equal(loadConfig({ RUNNER_CONCURRENCY: "4" }).concurrency, 1);
  assert.equal(loadConfig({ RUNNER_CONCURRENCY: "4" }).concurrencyIgnored, true);
  assert.equal(loadConfig({ RUNNER_PORT: "8016" }).port, 8016);
  assert.equal(loadConfig({ RUNNER_PORT: "nope" }).port, 8014);
});

test("service URLs: https anywhere, plain http only on loopback, private or tailnet addresses, never credentials in the URL", () => {
  assert.equal(serviceUrl("http://100.72.198.58:8010/v1/", ""), "http://100.72.198.58:8010/v1");
  assert.equal(serviceUrl("http://host.docker.internal:8012", ""), "http://host.docker.internal:8012");
  assert.equal(serviceUrl("https://takeoff-vision.floor360.com/v1", ""), "https://takeoff-vision.floor360.com/v1");
  assert.equal(serviceUrl("http://example.com/v1", ""), "", "plain http to the internet is refused");
  assert.equal(serviceUrl("http://user:pw@127.0.0.1:8010", ""), "");
  assert.equal(serviceUrl("file:///etc/passwd", ""), "");
});

test("set name: SharePoint-safe, 120 characters at most, the bid number never trimmed", () => {
  assert.equal(setName("Perfumania Wauwatosa", "F360-26-0170"), "Perfumania Wauwatosa - F360-26-0170");
  assert.equal(setName('Bad: "name" / with * chars?', "F360-26-0001"), "Bad name with chars - F360-26-0001");
  const long = setName("X".repeat(300), "F360-26-0170");
  assert.ok(long.length <= 120);
  assert.ok(long.endsWith(" - F360-26-0170"));
});

test("CSV: formula-looking cells are inert, quotes and commas escaped", () => {
  const csv = reportCsv({ conditions: [{ id: "c1", finish_tag: "+CPT", name: 'Say "hi", ok', floor_sf: 1.5, nested: { a: 1 } }] });
  assert.equal(csv, 'finish_tag,name,floor_sf\r\n\'+CPT,"Say ""hi"", ok",1.5\r\n');
});

test("row classes and load order", () => {
  assert.equal(classifyRow({ finishTag: "WT-1" }), "wall_tile");
  assert.equal(classifyRow({ finishTag: "PT-3", category: "Porcelain wall tile" }), "wall_tile");
  assert.equal(classifyRow({ finishTag: "RB-1" }), "base");
  assert.equal(classifyRow({ finishTag: "B-2", category: "Vinyl cove base" }), "base");
  assert.equal(classifyRow({ finishTag: "TR-1" }), "transition");
  assert.equal(classifyRow({ finishTag: "CPT-1", category: "Carpet tile" }), "floor");
  assert.equal(classifyRow({ finishTag: "PT-1", category: "Porcelain floor tile" }), "floor");
  const m = setManifest();
  m.files.push({ fileId: "elev", name: "C-elev.pdf", size: 1, sha256: "0".repeat(64), role: "elevations" }, { fileId: "add", name: "D-add.pdf", size: 1, sha256: "0".repeat(64), role: "addendum" });
  assert.deepEqual(loadOrder(m).map((f) => f.name), ["A-plan.pdf", "D-add.pdf", "B-schedule.pdf"], "elevations only when asked for");
  m.options.includeElevations = true;
  assert.deepEqual(loadOrder(m).map((f) => f.name), ["A-plan.pdf", "D-add.pdf", "B-schedule.pdf", "C-elev.pdf"]);
});
