// A scripted stand-in for the MCP engine, and fake vision/waker HTTP
// services. Every reply mirrors the real tool's output schema closely enough
// for the pipeline; the real engine is exercised in engine.integration.test.ts.
import { writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import type { Engine } from "../src/engine.ts";
import { EngineToolError } from "../src/engine.ts";
import type { JobStore } from "../src/jobs.ts";
import type { JobManifest } from "../src/types.ts";
import { sha256 } from "./helpers.ts";

// Any fetch that leaves the loopback interface fails the test run.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "127.0.0.1") throw new Error(`test tried to reach ${url.host}`);
  return realFetch(input, init);
}) as typeof fetch;

export const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
export const ENCRYPTED_PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R /Encrypt 5 0 R >>\n%%EOF\n");

type Handler = (args: any) => unknown;

export interface FakeEngine extends Engine {
  calls: { tool: string; args: any }[];
  closed: boolean;
}

/** Plan "A-plan.pdf" (2 sheets: a vector plan with a scale note, a scan with
 *  none) and "B-schedule.pdf" (a room-finish schedule). */
export function smallSet(overrides: Record<string, Handler> = {}): Record<string, Handler> {
  const sheets = [
    { sheet: "A-plan.pdf", page: 1, width_pt: 1224, height_pt: 792, width_px: 2448, height_px: 1584, detected_scale: '1/8" = 1\'-0"' },
    { sheet: "A-plan.pdf#2", page: 2, width_pt: 1224, height_pt: 792, width_px: 2448, height_px: 1584 },
    { sheet: "B-schedule.pdf", page: 1, width_pt: 1224, height_pt: 792, width_px: 2448, height_px: 1584 },
  ];
  const loaded: typeof sheets = [];
  const shapes: any[] = [];
  return {
    load_plan: (a) => {
      const base = String(a.path).split("/").pop()!;
      const known = sheets.filter((s) => s.sheet.split("#")[0] === base);
      loaded.push(...(known.length ? known : [{ sheet: base, page: 1, width_pt: 1224, height_pt: 792, width_px: 2448, height_px: 1584, detected_scale: '1/4" = 1\'-0"' }]));
      return { file: base, files: [], page_count: loaded.length, sheets: [...loaded], note: "" };
    },
    sheet_graph: () => ({ available: true, sheets: [{ sheet: "A-plan.pdf", role: "plan" }, { sheet: "A-plan.pdf#2", role: "plan" }, { sheet: "B-schedule.pdf", role: "schedule" }] }),
    find_schedule: (a) => {
      if (a.kind === "room finish") return { matches: [{ sheet: "B-schedule.pdf", kind: "room finish", title: "ROOM FINISH SCHEDULE", rows: 3, headers: [], region: { x0: 100, y0: 100, x1: 900, y1: 600 } }] };
      throw new EngineToolError("find_schedule", "no finish schedule in the set");
    },
    sheet_info: (a) => {
      const s = loaded.find((x) => x.sheet === a.sheet)!;
      return { ...s, seg_count: s.detected_scale ? 5000 : 0, has_vector_linework: !!s.detected_scale, scale_set: false, shape_count: 0, layers: [] };
    },
    set_scale: (a) => ({ sheet: a.sheet, upp: 0.03, source: "detected", confirmed: false }),
    find_text: (a) => {
      if (a.q === "e") return { sheet: a.sheet, q: "e", count: a.sheet === "A-plan.pdf#2" ? 0 : 10, truncated: false, hits: [] };
      if (a.q === "CPT-1" && a.sheet === "A-plan.pdf") return { sheet: a.sheet, q: a.q, count: 1, truncated: false, hits: [{ str: "CPT-1", bbox: [0, 0, 10, 10], center: [5, 5] }] };
      return { sheet: a.sheet, q: a.q, count: 0, truncated: false, hits: [] };
    },
    view_sheet: () => "iVBORw0KGgo=",
    propose_takeoff: () => ({ proposal_id: "p1" }),
    detect_rooms: (a) => {
      const ring = [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3], [0.1, 0.3]];
      shapes.push(
        { id: "s1", sheet_id: a.sheet, condition_id: "c1", measure_role: "floor_area", verts_norm: ring, label: "101", origin: { actor: "agent", reviewed: false } },
        { id: "s2", sheet_id: a.sheet, condition_id: "c2", measure_role: "floor_area", verts_norm: ring, label: "102", origin: { actor: "agent", reviewed: false } },
      );
      return {
        detected: 2,
        rooms: [
          { label: "101", nverts: 4, shape_id: "s1", condition: "CPT-1", confidence: 0.97, area_sf: 200, perimeter_lf: 60 },
          { label: "102", nverts: 6, shape_id: "s2", condition: "VCT-1", confidence: 0.6, area_sf: 120, perimeter_lf: 44 },
        ],
        withheld: { total: 2, degenerate: 0, duplicate: 0, bubble: 0, unowned: 0, implausible: 0, unresolved: 2 },
        unresolved: [
          { label: "103", reason: "no schedule row for 103 — the plan shows the room but no room-finish table lists it", area_sf: 50, perimeter_lf: 30, seed: [400, 500] },
          { label: "104", reason: "ambiguous: floor cell \"CPT-1/VCT-1\" names more than one finish with no stated split", area_sf: 70, perimeter_lf: 34, seed: [800, 500] },
        ],
        _sheet: a.sheet,
      };
    },
    derive_base: () => ({ committed: 1, rooms: [], total_lf: 60, condition: "RB-1", source_condition: "x", note: "" }),
    derive_transitions: () => ({ condition: "TRANSITION", between: [], committed: 0, total_lf: 0, runs: [], withheld: [{ sheet: "A-plan.pdf", between_shape_ids: ["s1", "s2"], length_lf: 10, gap_in: 6, at: [600, 500], reason: "wall_separated", detail: "" }], withheld_lf: 10, note: "" }),
    mark_verdict: (a) => ({ id: `apr-${a.shape_id}`, actor: "agent", sheet: "A-plan.pdf", ts: "t", note: "" }),
    annotate: (a) => ({ id: `mk-${Math.random().toString(36).slice(2, 8)}`, sheet: a.sheet, type: a.type, text: a.text ?? "", condition: "", condition_id: "", note: "" }),
    create_rfi: (() => {
      let n = 0;
      return (a: any) => ({ id: `rfi-${++n}`, number: `RFI-${String(n).padStart(3, "0")}`, subject: a.title, question: a.question, status: "open", sheet: a.sheet, actor: "agent", pending: true, date: "2026-10-17", response: "", response_date: "", linked_markups: a.markup_ids ?? [], conditions: [], note: "" });
    })(),
    export_takeoff: async (a) => {
      const payload = { schema: "opentakeoff.takeoff_canvas.v1", project_name: "", sheets: [{ sheet_id: "A-plan.pdf", units_per_px: 0.03, scale_source: "detected", scale_confirmed: false }], conditions: [{ id: "c1", finish_tag: "CPT-1" }, { id: "c2", finish_tag: "VCT-1" }], shapes, markups: [], rfis: [], sheet_group: [], last_group: [], sheet_tabs: [] };
      await writeFile(a.path, JSON.stringify(payload));
      return payload;
    },
    export_marked_pdf: async (a) => {
      await writeFile(a.path, "%PDF-1.7 marked");
      return { path: a.path, pages: 2, sheets_marked: 1, shapes_drawn: 2, annotations_drawn: 0, approvals_drawn: 1, rfis_printed: 0, note: "" };
    },
    export_report: async (a) => {
      const doc = { schema: "opentakeoff.report.v1", project_name: a.project_name, conditions: [{ id: "c1", finish_tag: "CPT-1", name: "Carpet", floor_sf: 200 }, { id: "c2", finish_tag: "=VCT-1", name: "VCT, tile", floor_sf: 120 }] };
      await writeFile(a.path, JSON.stringify(doc));
      return doc;
    },
    ...overrides,
  };
}

export function fakeEngine(handlers: Record<string, Handler>, o: { onCall?: (tool: string) => Promise<void> | void } = {}): FakeEngine {
  const e: FakeEngine = {
    calls: [],
    closed: false,
    async call(tool, args = {}) {
      e.calls.push({ tool, args });
      await o.onCall?.(tool);
      const h = handlers[tool];
      if (!h) throw new EngineToolError(tool, `fake engine has no ${tool}`);
      return (await h(args)) as never;
    },
    async image(tool, args) {
      e.calls.push({ tool, args });
      return String(await handlers[tool](args));
    },
    version: () => "0.9.98",
    async close() { e.closed = true; },
  };
  return e;
}

export function setManifest(extra: Partial<JobManifest> = {}, bytes: Uint8Array = PDF): JobManifest {
  return {
    runId: "run-7",
    bidId: "bid-7",
    bidNumber: "F360-26-0170",
    projectName: "Perfumania Wauwatosa",
    files: [
      { fileId: "plan", name: "A-plan.pdf", size: bytes.length, sha256: sha256(bytes), role: "plans" },
      { fileId: "sched", name: "B-schedule.pdf", size: PDF.length, sha256: sha256(PDF), role: "schedule" },
    ],
    scheduleRows: [
      { finishTag: "CPT-1", category: "Carpet tile", product: "Shaw" },
      { finishTag: "VCT-1", category: "VCT", product: "Armstrong" },
      { finishTag: "EP-1", category: "Epoxy", product: "Stonhard" },
      { finishTag: "RB-1", category: "Rubber base", product: "Roppe" },
      { finishTag: "WT-1", category: "Porcelain wall tile", product: "Daltile" },
    ],
    options: { includeElevations: false, dpi: 200 },
    ...extra,
  };
}

/** Create a job and upload its files straight through the store. */
export async function createUploaded(store: JobStore, m: JobManifest, bytesFor: (fileId: string) => Uint8Array = () => PDF) {
  const job = await store.create(m);
  for (const f of m.files) {
    const b = bytesFor(f.fileId);
    await store.putChunk(job.id, f.fileId, `bytes 0-${b.length - 1}/${b.length}`, b.length, Readable.from([Buffer.from(b)]));
  }
  return job;
}

/** A fake waker + vision server as a fetch implementation. */
export function fakeServices(o: {
  waker?: () => { status: number; state: string };
  wake?: () => { status: number; state: string };
  chat?: () => { status: number; content?: string } | "down";
  models?: () => { status: number; id?: string };
} = {}) {
  const calls: { url: string; method: string; auth?: string }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    if (url.endsWith("/_waker/status")) { const r = (o.waker ?? (() => ({ status: 200, state: "running" })))(); return Response.json({ state: r.state }, { status: r.status }); }
    if (url.endsWith("/_waker/wake")) { const r = (o.wake ?? (() => ({ status: 202, state: "starting" })))(); return Response.json({ state: r.state }, { status: r.status }); }
    if (url.endsWith("/models")) { const r = (o.models ?? (() => ({ status: 200, id: "qwen2.5-vl-7b" })))(); return Response.json({ data: r.id ? [{ id: r.id }] : [] }, { status: r.status }); }
    if (url.endsWith("/chat/completions")) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await new Promise((r) => setTimeout(r, 5));
        const r = (o.chat ?? (() => ({ status: 200, content: '{"scale": "1/4\\" = 1\'-0\\""}' })))();
        if (r === "down") throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" });
        return Response.json({ choices: [{ message: { content: r.content ?? "" } }] }, { status: r.status });
      } finally {
        inFlight--;
      }
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls, maxInFlight: () => maxInFlight };
}

export const visionConfig = {
  visionBaseUrl: "http://127.0.0.1:8010/v1",
  visionApiKeyFile: "/run/secrets/vision.key",
  visionModel: "",
  visionTimeoutMs: 5_000,
  wakerUrl: "http://127.0.0.1:8012",
  wakerTokenFile: "/run/secrets/waker.token",
  wakeWaitMs: 180_000,
  wakePollMs: 5_000,
  noMemoryRetryMs: 15 * 60_000,
  noMemoryMaxMs: 4 * 60 * 60_000,
};

export const secrets = (file: string) => (file.endsWith("vision.key") ? "vision-key-secret" : file.endsWith("waker.token") ? "waker-token-secret" : "");
