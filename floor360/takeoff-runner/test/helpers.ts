// Shared test plumbing: a temp data dir, a runner HTTP server on an ephemeral
// loopback port, and a fake clock. No test reaches beyond 127.0.0.1.
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { JobStore, type Execute } from "../src/jobs.ts";
import { createRunnerHandler } from "../src/server.ts";
import type { Clock } from "../src/clock.ts";

export const TOKEN = "test-runner-token-0123456789";

export const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

export async function tempDir(prefix = "takeoff-runner-"): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Time that only moves when told to; sleep() advances it at once and records
 *  how long was asked for. */
export class FakeClock implements Clock {
  t = Date.parse("2026-10-17T19:00:00Z");
  sleeps: number[] = [];
  now() { return this.t; }
  async sleep(ms: number, signal?: AbortSignal) {
    if (signal?.aborted) throw signal.reason;
    this.sleeps.push(ms);
    this.t += ms;
    await Promise.resolve();
    if (signal?.aborted) throw signal.reason;
  }
}

export interface Harness {
  url: string;
  store: JobStore;
  server: Server;
  dataDir: string;
  close: () => Promise<void>;
}

export async function startRunner(o: { execute: Execute; enabled?: boolean; token?: string; clock?: Clock; jobTimeoutMs?: number; retentionMs?: number; dataDir?: string }): Promise<Harness> {
  const tmp = o.dataDir ? null : await tempDir();
  const dataDir = o.dataDir ?? tmp!.dir;
  const clock = o.clock ?? { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
  const store = new JobStore({ dataDir, clock, execute: o.execute, jobTimeoutMs: o.jobTimeoutMs ?? 60 * 60_000, retentionMs: o.retentionMs ?? 7 * 24 * 3600_000, watchdogMs: 20 });
  await store.init();
  const server = createServer(createRunnerHandler({ config: { enabled: o.enabled ?? true, token: o.token ?? TOKEN, defaultDpi: 200 }, store }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    server,
    dataDir,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await store.whenIdle();
      await tmp?.cleanup();
    },
  };
}

export const auth = { Authorization: `Bearer ${TOKEN}` };

export function manifestFor(files: { name: string; bytes: Uint8Array; role?: string; fileId?: string }[], extra: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    bidId: "bid-42",
    bidNumber: "F360-26-0170",
    projectName: "Perfumania Wauwatosa",
    files: files.map((f, i) => ({ fileId: f.fileId ?? `f${i + 1}`, name: f.name, size: f.bytes.length, sha256: sha256(f.bytes), role: f.role ?? "plans" })),
    ...extra,
  };
}

export async function api(url: string, method: string, body?: unknown, headers: Record<string, string> = auth): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { method, headers: { ...headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

export async function putChunk(url: string, bytes: Uint8Array, start: number, end: number, total: number): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { method: "PUT", headers: { ...auth, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Type": "application/octet-stream" }, body: bytes.subarray(start, end + 1) });
  return { status: res.status, json: await res.json() };
}

/** Upload a whole file in chunks of `chunk` bytes. Returns the last reply. */
export async function upload(base: string, jobId: string, fileId: string, bytes: Uint8Array, chunk = 64 * 1024): Promise<{ status: number; json: any }> {
  let last = { status: 0, json: null as any };
  for (let s = 0; s < bytes.length; s += chunk) {
    const e = Math.min(bytes.length, s + chunk) - 1;
    last = await putChunk(`${base}/jobs/${jobId}/files/${fileId}`, bytes, s, e, bytes.length);
  }
  return last;
}

export async function waitFor(base: string, jobId: string, done = (j: any) => ["done", "failed", "cancelled"].includes(j.status), timeoutMs = 90_000): Promise<any> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await api(`${base}/jobs/${jobId}`, "GET");
    if (done(r.json)) return r.json;
    if (Date.now() > end) throw new Error(`job ${jobId} stuck at ${JSON.stringify(r.json.status)} (${r.json.progress?.text})`);
    await new Promise((res) => setTimeout(res, 25));
  }
}
