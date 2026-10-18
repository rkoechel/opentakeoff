// End to end against the REAL engine: the OpenTakeoff MCP server as a child
// over stdio, on the repo's own sample finish plan (plan + room-finish
// schedule), driven through the HTTP job API. No vision (the sheets are
// vector), no network beyond the loopback test server. Skipped when the MCP
// package's dependencies aren't installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { startMcpEngine } from "../src/engine.ts";
import { defaultMcpLaunch } from "../src/config.ts";
import { runTakeoff } from "../src/pipeline.ts";
import { DRAFT_MARKER_KEY } from "../src/outputs.ts";
import path from "node:path";
import { api, manifestFor, startRunner, upload, waitFor } from "./helpers.ts";
import { assertBrowserOpens } from "./browser.ts";
import "./fakes.ts";

const SAMPLE = fileURLToPath(new URL("../../../demo/sample-finish-plan.pdf", import.meta.url));
const mcpReady = existsSync(fileURLToPath(new URL("../../../mcp/node_modules/@modelcontextprotocol/sdk/package.json", import.meta.url)))
  && existsSync(fileURLToPath(new URL("../../../web/node_modules/pdfjs-dist/package.json", import.meta.url)));

test("a real run: rooms from the schedule, verdicts, draft-marked project file, marked set and report", { skip: !mcpReady && "mcp/web dependencies not installed" }, async () => {
  const launch = defaultMcpLaunch({});
  const h = await startRunner({
    execute: (ctx) => runTakeoff(ctx, {
      startEngine: (signal) => startMcpEngine({ ...launch, signal }),
      vision: null,
      runnerVersion: "0.1.0-test",
      verdictMinConfidence: 0.5,
      now: () => new Date("2026-10-17T19:30:00Z"),
    }),
  });
  try {
    const bytes = new Uint8Array(await readFile(SAMPLE));
    const created = await api(`${h.url}/jobs`, "POST", manifestFor([{ name: "sample-finish-plan.pdf", bytes }], {
      scheduleRows: [
        { finishTag: "CPT-1", category: "Carpet tile", product: "Shaw Tile" },
        { finishTag: "ZZZ-9", category: "Epoxy", product: "Never drawn" },
        { finishTag: "WT-1", category: "Porcelain wall tile", product: "Daltile" },
      ],
    }));
    assert.equal(created.status, 201);
    const id = created.json.id;
    const up = await upload(h.url, id, "f1", bytes, Math.ceil(bytes.length / 3));
    assert.equal(up.status, 200);
    assert.equal(up.json.complete, true);
    assert.equal((await api(`${h.url}/jobs/${id}/start`, "POST")).status, 202);
    const job = await waitFor(h.url, id);
    assert.equal(job.status, "done", job.reason);
    assert.equal(job.counts.sheets, 2);
    assert.ok(job.counts.rooms >= 1, "rooms committed from the schedule");
    assert.ok(job.counts.conditions >= 1);
    const names = job.outputs.map((o: any) => o.name);
    for (const n of ["annotations.json", "sheets.json", "floor360-run.json", "findings.json",
      "Perfumania Wauwatosa - F360-26-0170 - marked set.pdf",
      "Perfumania Wauwatosa - F360-26-0170 - takeoff report.json",
      "Perfumania Wauwatosa - F360-26-0170 - takeoff report.csv"]) assert.ok(names.includes(n), `output ${n}`);

    const ann: any = await (await fetch(`${h.url}/jobs/${id}/outputs/annotations.json`, { headers: { Authorization: "Bearer test-runner-token-0123456789" } })).json();
    assert.equal(ann.schema, "opentakeoff.takeoff_canvas.v1");
    assert.equal(ann[DRAFT_MARKER_KEY].status, "draft");
    assert.equal(ann[DRAFT_MARKER_KEY].bidNumber, "F360-26-0170");
    assert.equal(ann.project_name, "Perfumania Wauwatosa - F360-26-0170");
    assert.ok(ann.shapes.length >= 1);
    assert.ok(ann.shapes.every((s: any) => s.origin?.actor === "agent" && s.origin?.reviewed === false), "machine shapes stay pencil");
    assert.ok(ann.sheets.every((s: any) => s.scale_confirmed === false), "agent-set scales await a human");
    assert.ok(!(ann.approvals ?? []).some((a: any) => a.actor === "estimator"), "no human seal minted");

    const pdf = await fetch(`${h.url}/jobs/${id}/outputs/${encodeURIComponent("Perfumania Wauwatosa - F360-26-0170 - marked set.pdf")}`, { headers: { Authorization: "Bearer test-runner-token-0123456789" } });
    assert.equal(pdf.status, 200);
    assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), "%PDF-");

    await assertBrowserOpens(path.join(h.dataDir, "jobs", id, "outputs"), { "sample-finish-plan.pdf": bytes });

    // RFI drafts (PR F): in the register, pending, agent-raised, one per finding that carries a number
    assert.ok(job.counts.rfisDrafted >= 3, `rfisDrafted ${job.counts.rfisDrafted}`);
    assert.equal(ann.rfis.length, job.counts.rfisDrafted);
    assert.ok(ann.rfis.every((r: any) => r.origin?.actor === "agent" && r.origin?.reviewed === false && r.status === "open"), "every draft is pending agent pencil");
    const numbered = new Set(job.findings.filter((f: any) => f.rfi).map((f: any) => f.rfi));
    assert.equal(numbered.size, job.counts.rfisDrafted);
    assert.deepEqual([...numbered].sort(), ann.rfis.map((r: any) => r.number).sort());
    const clouded = ann.markups.filter((m: any) => m.type === "cloud" && m.rfi_id);
    assert.ok(clouded.length >= 1, "rooms with a seed get a cloud linked to their RFI");
    assert.ok(ann.rfis.some((r: any) => /Finish ZZZ-9 not shown on plans/.test(r.subject)));
    assert.ok(ann.rfis.some((r: any) => /Wall tile WT-1/.test(r.subject)));

    const kinds = new Set(job.findings.map((f: any) => f.kind));
    assert.ok(kinds.has("schedule_row_not_drawn"), "ZZZ-9 is never drawn");
    assert.ok(kinds.has("wall_tile_no_elevation"), "wall tile left for the estimator");
    assert.ok(kinds.has("room_no_schedule_row") || kinds.has("room_no_floor_finish"), "unresolved rooms reported");
  } finally {
    await h.close();
  }
});
