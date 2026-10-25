// Jobs on disk and the one-at-a-time queue. Layout under RUNNER_DATA_DIR:
//   jobs/<id>/job.json        the job record (written atomically)
//   jobs/<id>/upload/<fileId>  a file while its chunks arrive
//   jobs/<id>/files/<name>    a verified file, under its own name (= sheet key)
//   jobs/<id>/work/           engine scratch
//   jobs/<id>/outputs/        what GET /jobs/:id/outputs/:name serves
// A job and its files are deleted RUNNER_RETENTION_DAYS (7) after it finishes.
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { Clock } from "./clock.ts";
import { LIMITS } from "./config.ts";
import { contentTypeFor } from "./outputs.ts";
import { sha256File } from "./pdfcheck.ts";
import type { RunContext, RunResult } from "./pipeline.ts";
import { FINISHED, manifestLimitReason, type FileState, type Finding, type Job, type JobManifest, type JobStatus, type OutputEntry } from "./types.ts";
import { JobFailure } from "./vision.ts";

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export type Execute = (ctx: RunContext) => Promise<RunResult>;

export interface JobStoreDeps {
  dataDir: string;
  clock: Clock;
  execute: Execute;
  jobTimeoutMs: number;
  retentionMs: number;
  log?: (msg: string) => void;
  /** How often the running job's budget is checked (ms). */
  watchdogMs?: number;
}

const JOB_ID = /^[0-9a-f-]{36}$/;
const TIMEOUT_REASON = (min: number) => `The AI takeoff ran past ${min} minutes and was stopped. Retry it, or run it by hand.`;

class Cancelled extends Error {}
class TimedOut extends Error {}

/** Merge [start, end) into a sorted, non-overlapping range list. */
export function addRange(ranges: [number, number][], start: number, end: number): [number, number][] {
  const all = [...ranges, [start, end] as [number, number]].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of all) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

const receivedBytes = (ranges: [number, number][]) => ranges.reduce((n, r) => n + (r[1] - r[0]), 0);

/** "bytes start-end/total" (end inclusive), or null. */
export function parseContentRange(h: string | undefined): { start: number; end: number; total: number } | null {
  const m = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15})$/.exec(String(h ?? "").trim());
  if (!m) return null;
  const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (start > end || end >= total) return null;
  return { start, end, total };
}

export class JobStore {
  private jobs = new Map<string, Job>();
  private queue: string[] = [];
  private running: { id: string; abort: AbortController; activeSince: number | null } | null = null;
  private locks = new Map<string, Promise<unknown>>();
  private saving = new Map<string, Promise<void>>();
  private verifying = new Set<string>();
  private idle: Promise<void> = Promise.resolve();
  private log: (msg: string) => void;

  constructor(private d: JobStoreDeps) {
    this.log = d.log ?? (() => {});
  }

  private dir(id: string, ...rest: string[]) {
    return path.join(this.d.dataDir, "jobs", id, ...rest);
  }

  private iso() {
    return new Date(this.d.clock.now()).toISOString();
  }

  /** Serialize state changes per job. */
  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(id, run.catch(() => {}));
    return run;
  }

  /** Writes of one job's record land in call order: the snapshot is taken now,
   *  so a late progress write can never overwrite the final status. */
  private save(job: Job): Promise<void> {
    const data = JSON.stringify(job);
    const file = this.dir(job.id, "job.json");
    const tmp = `${file}.${process.pid}.tmp`;
    const next = (this.saving.get(job.id) ?? Promise.resolve()).then(async () => {
      await writeFile(tmp, data);
      await rename(tmp, file);
    });
    this.saving.set(job.id, next.catch(() => {}));
    return next;
  }

  /** Load jobs from disk. A run the process died in the middle of is failed;
   *  started-but-waiting jobs go back on the queue in their order. */
  async init() {
    const root = path.join(this.d.dataDir, "jobs");
    await mkdir(root, { recursive: true });
    const waiting: Job[] = [];
    for (const id of await readdir(root)) {
      if (!JOB_ID.test(id)) continue;
      let job: Job;
      try {
        job = JSON.parse(await readFile(this.dir(id, "job.json"), "utf8")) as Job;
      } catch {
        continue;
      }
      if (job.status === "starting" || job.status === "running" || job.status === "no_memory") {
        job.status = "failed";
        job.reason = "The takeoff runner restarted during this run. Retry it.";
        job.finishedAt = this.iso();
        await this.save(job);
      }
      this.jobs.set(id, job);
      if (job.status === "queued" && job.startRequestedAt) waiting.push(job);
    }
    waiting.sort((a, b) => String(a.startRequestedAt).localeCompare(String(b.startRequestedAt)));
    this.queue.push(...waiting.map((j) => j.id));
    await this.sweep();
    this.pump();
  }

  get(id: string): Job {
    const job = JOB_ID.test(id) ? this.jobs.get(id) : undefined;
    if (!job) throw new HttpError(404, "No such job.");
    return job;
  }

  async create(manifest: JobManifest): Promise<Job> {
    const id = randomUUID();
    const reason = manifestLimitReason(manifest);
    const now = this.iso();
    const job: Job = {
      id,
      manifest,
      files: manifest.files.map((f) => ({ ...f, ranges: [], complete: false })),
      status: reason ? "failed" : "queued",
      ...(reason ? { reason, finishedAt: now } : {}),
      progress: { step: reason ? "Refused" : "Waiting for files", page: 0, pages: 0 },
      findings: [],
      counts: { sheets: 0, rooms: 0, conditions: 0, rfisDrafted: 0 },
      outputs: [],
      createdAt: now,
      activeMs: 0,
    };
    await mkdir(this.dir(id, "upload"), { recursive: true });
    await mkdir(this.dir(id, "files"), { recursive: true });
    await this.save(job);
    this.jobs.set(id, job);
    this.log(`job ${id} created (${manifest.files.length} files)${reason ? ": refused" : ""}`);
    return job;
  }

  /** One chunk of a file: bytes [start, end] of total, streamed to disk at its
   *  offset. When the file is whole its sha256 is checked; a mismatch drops
   *  the bytes so the file can be sent again. */
  async putChunk(id: string, fileId: string, contentRange: string | undefined, contentLength: number | undefined, body: Readable): Promise<{ status: number; body: Record<string, unknown> }> {
    const job = this.get(id);
    const f = job.files.find((x) => x.fileId === fileId);
    if (!f) throw new HttpError(404, "No such file in this job.");
    if (job.status !== "queued" || job.startRequestedAt) throw new HttpError(409, job.status === "queued" ? "This job has started; files can't change now." : `This job is ${job.status}.`);
    if (f.complete) return { status: 200, body: { fileId, name: f.name, complete: true, received: f.size, size: f.size } };
    let range = parseContentRange(contentRange);
    if (!contentRange && f.size <= LIMITS.maxChunkBytes) range = { start: 0, end: f.size - 1, total: f.size };
    if (!range) throw new HttpError(400, "Send Content-Range: bytes <start>-<end>/<total>.");
    if (range.total !== f.size) throw new HttpError(400, `Content-Range total ${range.total} doesn't match "${f.name}" (${f.size} bytes).`);
    const len = range.end - range.start + 1;
    if (len > LIMITS.maxChunkBytes) throw new HttpError(413, "Chunks are limited to 64 MB.");
    if (contentLength !== undefined && contentLength !== len) throw new HttpError(400, `Content-Length ${contentLength} doesn't match the range (${len} bytes).`);

    const part = this.dir(id, "upload", fileId);
    const fh = await open(part, "a");   // create if missing, never truncate
    await fh.close();
    let seen = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        seen += chunk.length;
        if (seen > len) { cb(new HttpError(400, `More bytes than the range (${len}) were sent.`)); return; }
        cb(null, chunk);
      },
    });
    await streamPipeline(body, counter, createWriteStream(part, { flags: "r+", start: range.start }));
    if (seen !== len) throw new HttpError(400, `Got ${seen} bytes for a ${len}-byte range; send that chunk again.`);

    return this.withLock(id, async () => {
      const cur = this.get(id).files.find((x) => x.fileId === fileId) as FileState;
      if (cur.complete) return { status: 200, body: { fileId, name: cur.name, complete: true, received: cur.size, size: cur.size } };
      cur.ranges = addRange(cur.ranges, range.start, range.end + 1);
      const got = receivedBytes(cur.ranges);
      if (got < cur.size || this.verifying.has(`${id}/${fileId}`)) {
        await this.save(job);
        return { status: 202, body: { fileId, name: cur.name, complete: false, received: got, size: cur.size } };
      }
      this.verifying.add(`${id}/${fileId}`);
      try {
        const sum = await sha256File(part);
        if (sum !== cur.sha256) {
          cur.ranges = [];
          await rm(part, { force: true });
          await this.save(job);
          throw new HttpError(422, `sha256 mismatch for "${cur.name}": the bytes received don't match the manifest. Upload the file again.`, { fileId });
        }
        await rename(part, this.dir(id, "files", cur.name));
        cur.complete = true;
        await this.save(job);
        this.log(`job ${id} file ${fileId} verified`);
        return { status: 200, body: { fileId, name: cur.name, complete: true, received: cur.size, size: cur.size } };
      } finally {
        this.verifying.delete(`${id}/${fileId}`);
      }
    });
  }

  async start(id: string): Promise<Job> {
    return this.withLock(id, async () => {
      const job = this.get(id);
      if (job.status === "failed" && !job.startedAt) throw new HttpError(409, job.reason ?? "This job was refused.");
      if (job.startRequestedAt || job.status !== "queued") return job;   // idempotent
      const missing = job.files.filter((f) => !f.complete).map((f) => f.name);
      if (missing.length) throw new HttpError(409, `Upload every file before starting. Missing: ${missing.join(", ")}.`, { missing });
      job.startRequestedAt = this.iso();
      job.progress = { step: "Waiting for its turn", page: 0, pages: 0 };
      await this.save(job);
      this.queue.push(id);
      this.pump();
      return job;
    });
  }

  /** Queue shop drawings on this job. Same one-at-a-time queue as a takeoff.
   *  A job already queued for shop drawings is returned as-is. A finished job
   *  runs again and replaces the shop-drawings outputs. */
  async startShopDrawings(id: string, request: unknown): Promise<Job> {
    return this.withLock(id, async () => {
      const job = this.get(id);
      if (this.running?.id === id || job.status === "starting" || job.status === "running" || job.status === "no_memory") {
        throw new HttpError(409, "This job is already running.");
      }
      if (job.status === "cancelled") throw new HttpError(409, "This job is cancelled.");
      if (job.status === "failed" && !job.startedAt) throw new HttpError(409, job.reason ?? "This job was refused.");
      if (job.status === "queued" && job.startRequestedAt && job.work === "shop-drawings") return job;
      if (job.status === "queued" && job.startRequestedAt) throw new HttpError(409, "This job is already queued for a takeoff.");
      const missing = job.files.filter((f) => !f.complete).map((f) => f.name);
      if (missing.length) throw new HttpError(409, `Upload every file before shop drawings. Missing: ${missing.join(", ")}.`, { missing });
      job.work = "shop-drawings";
      job.shopDrawings = request;
      job.status = "queued";
      delete job.reason;
      delete job.finishedAt;
      job.startRequestedAt = this.iso();
      job.progress = { step: "Waiting for its turn", page: 0, pages: 0 };
      await this.save(job);
      if (!this.queue.includes(id)) this.queue.push(id);
      this.pump();
      return job;
    });
  }

  async cancel(id: string): Promise<Job> {
    return this.withLock(id, async () => {
      const job = this.get(id);
      if (FINISHED.has(job.status)) throw new HttpError(409, `This job is already ${job.status}.`);
      if (this.running?.id === id) {
        this.running.abort.abort(new Cancelled("cancelled"));
        return job;
      }
      this.queue = this.queue.filter((q) => q !== id);
      job.status = "cancelled";
      job.reason = "Cancelled before it ran.";
      job.finishedAt = this.iso();
      await this.save(job);
      return job;
    });
  }

  outputPath(id: string, name: string): { path: string; entry: OutputEntry } {
    const job = this.get(id);
    const entry = job.outputs.find((o) => o.name === name);
    if (!entry) throw new HttpError(404, "No such output.");
    return { path: this.dir(id, "outputs", entry.name), entry };
  }

  /** Resolves when the queue has drained and every record is written. */
  async whenIdle(): Promise<void> {
    while (this.running || this.queue.length) await this.idle;
    await Promise.all(this.saving.values());
  }

  private pump() {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    const run = this.runJob(next).catch((e) => this.log(`job ${next} crashed: ${(e as Error).message}`)).finally(() => {
      this.running = null;
      this.pump();
    });
    this.idle = this.idle.then(() => run);
  }

  private setStatus(job: Job, status: JobStatus) {
    const r = this.running;
    if (r && r.id === job.id) {
      const now = this.d.clock.now();
      if (status === "no_memory" && r.activeSince !== null) { job.activeMs += now - r.activeSince; r.activeSince = null; }
      if (status !== "no_memory" && r.activeSince === null) r.activeSince = now;
    }
    if (job.status !== status) {
      job.status = status;
      this.save(job).catch(() => {});
    }
  }

  private activeMs(job: Job) {
    const r = this.running;
    return job.activeMs + (r && r.id === job.id && r.activeSince !== null ? this.d.clock.now() - r.activeSince : 0);
  }

  private checkBudget(job: Job) {
    const r = this.running;
    if (r && r.id === job.id && !r.abort.signal.aborted && this.activeMs(job) > this.d.jobTimeoutMs) {
      r.abort.abort(new TimedOut("timeout"));
    }
  }

  private async runJob(id: string) {
    const job = this.jobs.get(id);
    if (!job || job.status !== "queued") return;
    const abort = new AbortController();
    this.running = { id, abort, activeSince: this.d.clock.now() };
    job.status = "starting";
    job.startedAt = this.iso();
    job.progress = { step: "Starting", page: 0, pages: 0 };
    await this.save(job);
    this.log(`job ${id} starting`);
    const watchdog = setInterval(() => this.checkBudget(job), this.d.watchdogMs ?? 5_000);
    watchdog.unref();
    const ctx: RunContext = {
      jobId: id,
      manifest: job.manifest,
      filesDir: this.dir(id, "files"),
      outputsDir: this.dir(id, "outputs"),
      workDir: this.dir(id, "work"),
      signal: abort.signal,
      work: job.work ?? "takeoff",
      shopDrawings: job.shopDrawings,
      setStatus: (s) => this.setStatus(job, s),
      progress: (step, page = 0, pages = 0) => {
        job.progress = { step, page, pages };
        this.checkBudget(job);
        if (abort.signal.aborted) throw abort.signal.reason;
        this.save(job).catch(() => {});
      },
    };
    let result: RunResult | null = null;
    let reason = "";
    let final: JobStatus = "done";
    try {
      result = await this.d.execute(ctx);
      if (abort.signal.aborted) throw abort.signal.reason;
    } catch (e) {
      const why = abort.signal.aborted ? abort.signal.reason : e;
      if (why instanceof Cancelled) { final = "cancelled"; reason = "Cancelled while it ran."; }
      else if (why instanceof TimedOut) { final = "failed"; reason = TIMEOUT_REASON(Math.round(this.d.jobTimeoutMs / 60_000)); }
      else if (why instanceof JobFailure) { final = "failed"; reason = why.reason; }
      else {
        final = "failed";
        const lead = job.work === "shop-drawings" ? "Shop drawings stopped" : "The takeoff engine stopped";
        reason = `${lead}: ${(why as Error)?.message ?? String(why)}`;
      }
    } finally {
      clearInterval(watchdog);
    }
    await this.withLock(id, async () => {
      // the uploaded bytes and scratch are not needed after the run
      await rm(this.dir(id, "work"), { recursive: true, force: true });
      await rm(this.dir(id, "upload"), { recursive: true, force: true });
      const outputs = result ? await this.describeOutputs(id, result.outputs) : [];
      // everything a poller reads changes in one synchronous step, status last
      job.activeMs = this.activeMs(job);
      if (reason) job.reason = reason;
      if (result) {
        job.counts = result.counts;
        job.findings = result.findings as Finding[];
        if (job.work === "shop-drawings") {
          const names = new Set(outputs.map((o) => o.name));
          job.outputs = [...job.outputs.filter((o) => !names.has(o.name)), ...outputs];
        } else {
          job.outputs = outputs;
        }
        job.progress = { step: "Done", page: job.progress.pages, pages: job.progress.pages };
      }
      job.finishedAt = this.iso();
      job.status = final;
      await this.save(job);
    });
    this.log(`job ${id} ${final}${reason ? `: ${reason}` : ""}`);
  }

  private async describeOutputs(id: string, names: string[]): Promise<OutputEntry[]> {
    const out: OutputEntry[] = [];
    for (const name of names) {
      const p = this.dir(id, "outputs", name);
      try {
        const st = await stat(p);
        out.push({ name, size: st.size, sha256: await sha256File(p), contentType: contentTypeFor(name) });
      } catch { /* not written */ }
    }
    return out;
  }

  /** Delete jobs (and every file of theirs) RUNNER_RETENTION_DAYS after they
   *  finished, or after they were created when they never ran. */
  async sweep(): Promise<number> {
    const now = this.d.clock.now();
    let n = 0;
    for (const [id, job] of this.jobs) {
      if (this.running?.id === id || this.queue.includes(id)) continue;
      const since = Date.parse(job.finishedAt ?? job.createdAt);
      if (Number.isFinite(since) && now - since >= this.d.retentionMs) {
        await this.saving.get(id);
        await rm(this.dir(id), { recursive: true, force: true });
        this.jobs.delete(id);
        this.saving.delete(id);
        this.locks.delete(id);
        n++;
      }
    }
    if (n) this.log(`swept ${n} job${n === 1 ? "" : "s"} past retention`);
    return n;
  }
}

/** The JSON Bids reads from GET /jobs/:id. */
export function jobView(job: Job): Record<string, unknown> {
  const m = job.manifest;
  return {
    id: job.id,
    runId: m.runId,
    bidId: m.bidId,
    bidNumber: m.bidNumber,
    projectName: m.projectName,
    status: job.status,
    ...(job.reason ? { reason: job.reason } : {}),
    ...(job.status === "no_memory" ? { message: "Waiting for memory on the AI server; retrying every 15 minutes." } : {}),
    progress: { ...job.progress, text: job.progress.pages ? `${job.progress.step}: page ${job.progress.page} of ${job.progress.pages}` : job.progress.step },
    files: job.files.map((f) => ({ fileId: f.fileId, name: f.name, role: f.role, size: f.size, received: receivedBytes(f.ranges), complete: f.complete })),
    findings: job.findings,
    counts: job.counts,
    outputs: job.outputs,
    createdAt: job.createdAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
  };
}
