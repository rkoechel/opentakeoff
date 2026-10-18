// The vision model (takeoff-vision on the Spark, Qwen2.5-VL behind vLLM) and
// its waker. The runner never runs docker and never starts or stops a
// container: when the model is down it asks the existing waker
// (infra/takeoff-vision-waker), whose memory gate refuses with no_memory while
// Orduh Up needs the room. On no_memory the job pauses and retries every 15
// minutes for up to 4 hours, then fails with the honest message. There is no
// other model to fall back to, paid or otherwise.
//
// What vision is used for here is deliberately narrow: reading the printed
// scale note off a SCANNED sheet (no text layer) as a suggestion for the
// estimator. The suggestion is reported, never applied — scale is a gate.
import { readFileSync } from "node:fs";
import type { Clock } from "./clock.ts";
import type { RunnerConfig } from "./config.ts";

export const NO_MEMORY_MESSAGE = "The AI server is out of memory right now. Ask Ryan to free memory on the DGX.";

/** The job must fail with this reason (the 4-hour no_memory ceiling). */
export class JobFailure extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "JobFailure";
  }
}

/** Vision can't be reached or refused us: the step is skipped, the job goes on. */
export class VisionUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisionUnavailable";
  }
}

export type VisionState = "starting" | "running" | "no_memory";

export interface VisionCallContext {
  signal: AbortSignal;
  onState: (s: VisionState) => void;
}

export interface Vision {
  /** The scale note as printed ("1/8\" = 1'-0\"", "NTS"), or null when none is legible. */
  readScaleNote(pngBase64: string, ctx: VisionCallContext): Promise<string | null>;
}

type Fetch = typeof globalThis.fetch;

export interface VisionDeps {
  config: Pick<RunnerConfig, "visionBaseUrl" | "visionApiKeyFile" | "visionModel" | "visionTimeoutMs" | "wakerUrl" | "wakerTokenFile" | "wakeWaitMs" | "wakePollMs" | "noMemoryRetryMs" | "noMemoryMaxMs">;
  fetchImpl?: Fetch;
  clock: Clock;
  log?: (msg: string) => void;
  /** Read a secret file; "" when unset or unreadable. Values are never logged. */
  readSecret?: (file: string) => string;
}

export function readSecretFile(file: string): string {
  if (!file) return "";
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

const SCALE_PROMPT = "This is a crop of a construction drawing sheet (title block area). Find the drawing SCALE note, for example 1/8\" = 1'-0\" or 1:100 or NOT TO SCALE. Answer with JSON only: {\"scale\": \"<the note exactly as printed>\"}, {\"scale\": \"NTS\"} for not to scale, or {\"scale\": null} if there is no legible scale note. Do not guess.";

/** The model's answer reduced to a short, printable scale note, or null. */
export function parseScaleAnswer(content: unknown): string | null {
  if (typeof content !== "string") return null;
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let v: unknown;
  try { v = JSON.parse(m[0])?.scale; } catch { return null; }
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  if (/^(N\.?T\.?S\.?|NOT TO SCALE)$/i.test(s)) return "NTS";
  if (!s || s.length > 40 || !/^[0-9A-Za-z/'"=\-.:, ]+$/.test(s) || !/\d/.test(s)) return null;
  return s;
}

const isDown = (status: number) => status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530);

export function createVision(d: VisionDeps): Vision | null {
  const cfg = d.config;
  if (!cfg.visionBaseUrl) return null;
  const fetchImpl = d.fetchImpl ?? globalThis.fetch;
  const readSecret = d.readSecret ?? readSecretFile;
  const log = d.log ?? (() => {});
  let model = cfg.visionModel;
  let chain: Promise<unknown> = Promise.resolve();

  const visionHeaders = (): Record<string, string> => {
    const h: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
    const key = readSecret(cfg.visionApiKeyFile);
    if (key) h.Authorization = `Bearer ${key}`;
    return h;
  };
  const wakerToken = () => readSecret(cfg.wakerTokenFile);

  async function waker(path: "/_waker/status" | "/_waker/wake", method: "GET" | "POST", signal: AbortSignal): Promise<{ status: number; state: string }> {
    const token = wakerToken();
    const res = await fetchImpl(`${cfg.wakerUrl}${path}`, {
      method,
      headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    let body: { state?: unknown } | null = null;
    try { body = await res.json() as { state?: unknown }; } catch { /* not JSON */ }
    return { status: res.status, state: typeof body?.state === "string" ? body.state : "" };
  }

  /** Model id: VISION_MODEL, else the first id /v1/models lists. Throws
   *  VisionUnavailable when the server isn't answering. */
  async function resolveModel(signal: AbortSignal): Promise<string> {
    if (model) return model;
    let res: Response;
    try {
      res = await fetchImpl(`${cfg.visionBaseUrl}/models`, { headers: visionHeaders(), redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
    } catch (e) {
      if (signal.aborted) throw signal.reason;
      throw new VisionUnavailable(`the vision model is not answering (${(e as Error).name})`);
    }
    if (!res.ok) throw new VisionUnavailable(`the vision model answered HTTP ${res.status} on /models`);
    const body = await res.json().catch(() => null) as { data?: { id?: unknown }[] } | null;
    const id = Array.isArray(body?.data) && typeof body.data[0]?.id === "string" ? body.data[0].id : "";
    if (!id) throw new VisionUnavailable("the vision model lists no model yet");
    model = id;
    return id;
  }

  /** Make sure the model is up, through the waker's memory gate. Returns when
   *  it is running; throws JobFailure after 4 hours of no_memory, or
   *  VisionUnavailable when the waker can't be reached or the start stalls. */
  async function ensureReady(ctx: VisionCallContext): Promise<void> {
    if (!cfg.wakerUrl || !wakerToken()) return;   // no waker set up: try the model as it is
    let noMemSince: number | null = null;
    const noMemory = async () => {
      const now = d.clock.now();
      noMemSince ??= now;
      ctx.onState("no_memory");
      const left = cfg.noMemoryMaxMs - (now - noMemSince);
      if (left <= 0) throw new JobFailure(NO_MEMORY_MESSAGE);
      log(`vision: waker reports no_memory; retrying in ${Math.round(Math.min(cfg.noMemoryRetryMs, left) / 60_000)} min`);
      await d.clock.sleep(Math.min(cfg.noMemoryRetryMs, left), ctx.signal);
      if (d.clock.now() - noMemSince >= cfg.noMemoryMaxMs) throw new JobFailure(NO_MEMORY_MESSAGE);
    };
    for (;;) {
      let st: { status: number; state: string };
      try {
        st = await waker("/_waker/status", "GET", ctx.signal);
      } catch (e) {
        if (ctx.signal.aborted) throw ctx.signal.reason;
        throw new VisionUnavailable(`the waker is not reachable (${(e as Error).name})`);
      }
      if (st.status === 401 || st.status === 403) throw new VisionUnavailable("the waker refused the runner's token");
      if (st.state === "running") { ctx.onState("running"); return; }
      if (st.state === "no_memory") { await noMemory(); continue; }
      if (st.state === "stopped") {
        // one wake per attempt; the waker itself refuses a start without memory
        const w = await waker("/_waker/wake", "POST", ctx.signal).catch((e) => {
          if (ctx.signal.aborted) throw ctx.signal.reason;
          throw new VisionUnavailable(`the waker is not reachable (${(e as Error).name})`);
        });
        log(`vision: waker /wake ${w.status}`);
        if (w.state === "no_memory") { await noMemory(); continue; }
        if (w.state === "running") { ctx.onState("running"); return; }
        if (w.status !== 200 && w.status !== 202 && w.status !== 429) throw new VisionUnavailable(`the waker could not start the model (HTTP ${w.status})`);
      } else if (st.state !== "starting") {
        throw new VisionUnavailable(`the waker answered an unknown state (HTTP ${st.status})`);
      }
      ctx.onState("starting");
      const deadline = d.clock.now() + cfg.wakeWaitMs;
      let next: string = "starting";
      while (d.clock.now() < deadline) {
        await d.clock.sleep(cfg.wakePollMs, ctx.signal);
        try {
          next = (await waker("/_waker/status", "GET", ctx.signal)).state;
        } catch (e) {
          if (ctx.signal.aborted) throw ctx.signal.reason;
          continue;
        }
        if (next === "running" || next === "no_memory") break;
      }
      if (next === "running") { ctx.onState("running"); return; }
      if (next === "no_memory") { await noMemory(); continue; }
      throw new VisionUnavailable(`the vision model did not start within ${Math.round(cfg.wakeWaitMs / 1000)} s`);
    }
  }

  async function chat(body: Record<string, unknown>, ctx: VisionCallContext): Promise<{ status: number; content?: unknown; down: boolean }> {
    const m = await resolveModel(ctx.signal);
    let res: Response;
    try {
      res = await fetchImpl(`${cfg.visionBaseUrl}/chat/completions`, {
        method: "POST",
        headers: visionHeaders(),
        body: JSON.stringify({ ...body, model: m, stream: false }),
        redirect: "manual",
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(cfg.visionTimeoutMs)]),
      });
    } catch (e) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      return { status: 0, down: (e as Error).name !== "TimeoutError" };
    }
    if (!res.ok) return { status: res.status, down: isDown(res.status) };
    const j = await res.json().catch(() => null) as { choices?: { message?: { content?: unknown } }[] } | null;
    return { status: 200, content: j?.choices?.[0]?.message?.content, down: false };
  }

  async function ask(body: Record<string, unknown>, ctx: VisionCallContext): Promise<unknown> {
    await ensureReady(ctx);
    let r: Awaited<ReturnType<typeof chat>>;
    try {
      r = await chat(body, ctx);
    } catch (e) {
      if (!(e instanceof VisionUnavailable)) throw e;
      r = { status: 0, down: true };
    }
    if (r.down) {
      // down mid-job (stopped idle, restarting): wake once through the gate, retry once
      model = cfg.visionModel;
      await ensureReady(ctx);
      r = await chat(body, ctx);
    }
    if (r.status === 200) return r.content;
    if (r.status === 401 || r.status === 403) throw new VisionUnavailable("the vision model refused the runner's key");
    throw new VisionUnavailable(r.status ? `the vision model answered HTTP ${r.status}` : "the vision model is not answering");
  }

  return {
    readScaleNote(pngBase64, ctx) {
      // at most one vision request in flight, so one of takeoff-vision's two
      // seats always stays free for estimators
      const run = chain.then(async () => parseScaleAnswer(await ask({
        messages: [{ role: "user", content: [
          { type: "text", text: SCALE_PROMPT },
          { type: "image_url", image_url: { url: `data:image/png;base64,${pngBase64}` } },
        ] }],
        max_tokens: 64,
        temperature: 0,
      }, ctx)));
      chain = run.catch(() => {});
      return run;
    },
  };
}
