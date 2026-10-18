// Settings for the takeoff runner, read once from the environment. Unset means
// off: with RUNNER_ENABLED unset every job route answers 503 and nothing runs.
// Secret values (RUNNER_TOKEN, and the vision key / waker token, which are read
// from files) are never logged or returned.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MB = 1024 * 1024;
export const MINUTE = 60_000;

/** The fixed job limits from the plan (Phase 2 §3, §4). */
export const LIMITS = Object.freeze({
  maxSheets: 80,
  maxJobBytes: 600 * MB,
  maxFileBytes: 250 * MB,
  maxChunkBytes: 64 * MB,
  maxFiles: 60,
  maxManifestBytes: 2 * MB,
});

export interface RunnerConfig {
  enabled: boolean;
  token: string;
  host: string;
  port: number;
  dataDir: string;
  concurrency: 1;
  concurrencyIgnored: boolean;
  jobTimeoutMs: number;
  retentionMs: number;
  visionBaseUrl: string;
  visionApiKeyFile: string;
  visionModel: string;
  visionTimeoutMs: number;
  wakerUrl: string;
  wakerTokenFile: string;
  wakeWaitMs: number;
  wakePollMs: number;
  noMemoryRetryMs: number;
  noMemoryMaxMs: number;
  verdictMinConfidence: number;
  defaultDpi: number;
  mcpCommand: string;
  mcpArgs: string[];
  buildSha: string;
}

function intSetting(value: string | undefined, fallback: number, min = 1): number {
  if (value == null || String(value).trim() === "") return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= min ? n : fallback;
}

function numSetting(value: string | undefined, fallback: number): number {
  if (value == null || String(value).trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** http(s) URL with no trailing slash; plain http only to loopback or a
 *  private/tailnet address (the Spark's own network), otherwise "". */
export function serviceUrl(value: string | undefined, fallback: string): string {
  const v = String(value || fallback).trim().replace(/\/+$/, "");
  try {
    const u = new URL(v);
    if (u.username || u.password) return "";
    if (u.protocol === "https:") return v;
    if (u.protocol !== "http:") return "";
    const h = u.hostname;
    const loopback = h === "127.0.0.1" || h === "localhost" || h === "[::1]";
    const privateNet = /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) || h === "host.docker.internal";
    return loopback || privateNet ? v : "";
  } catch {
    return "";
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** How to start the MCP engine as a child over stdio: RUNNER_MCP_ENTRY (the
 *  built mcp/dist/server.js in the image), else the repo checkout's built
 *  server, else the TypeScript source through tsx (development and tests). */
export function defaultMcpLaunch(env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const entry = String(env.RUNNER_MCP_ENTRY || "").trim();
  if (entry) return { command: process.execPath, args: [entry] };
  const repoMcp = path.resolve(here, "../../../mcp");
  const built = path.join(repoMcp, "dist/server.js");
  if (existsSync(built)) return { command: process.execPath, args: [built] };
  return { command: process.execPath, args: ["--import", "tsx", path.join(repoMcp, "server.ts")] };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const launch = defaultMcpLaunch(env);
  return {
    enabled: env.RUNNER_ENABLED === "1",
    token: String(env.RUNNER_TOKEN || "").trim(),
    host: String(env.RUNNER_HOST || "127.0.0.1").trim(),
    port: intSetting(env.RUNNER_PORT, 8014),
    dataDir: path.resolve(String(env.RUNNER_DATA_DIR || "/var/lib/takeoff-runner")),
    // One job at a time is a rule, not a knob: RUNNER_CONCURRENCY other than 1
    // is ignored (main logs it).
    concurrency: 1,
    concurrencyIgnored: env.RUNNER_CONCURRENCY != null && env.RUNNER_CONCURRENCY.trim() !== "" && env.RUNNER_CONCURRENCY.trim() !== "1",
    jobTimeoutMs: intSetting(env.RUNNER_JOB_TIMEOUT_MIN, 60) * MINUTE,
    retentionMs: intSetting(env.RUNNER_RETENTION_DAYS, 7) * 24 * 60 * MINUTE,
    visionBaseUrl: serviceUrl(env.VISION_BASE_URL, "http://127.0.0.1:8010/v1"),
    visionApiKeyFile: String(env.VISION_API_KEY_FILE || "").trim(),
    visionModel: String(env.VISION_MODEL || "").trim(),
    visionTimeoutMs: intSetting(env.VISION_TIMEOUT_MS, 120_000),
    wakerUrl: serviceUrl(env.WAKER_URL, "http://127.0.0.1:8012"),
    wakerTokenFile: String(env.WAKER_TOKEN_FILE || "").trim(),
    wakeWaitMs: intSetting(env.WAKE_WAIT_MS, 180_000),
    wakePollMs: intSetting(env.WAKE_POLL_MS, 5_000),
    noMemoryRetryMs: intSetting(env.NO_MEMORY_RETRY_MIN, 15) * MINUTE,
    noMemoryMaxMs: intSetting(env.NO_MEMORY_MAX_MIN, 240) * MINUTE,
    verdictMinConfidence: Math.min(1, Math.max(0, numSetting(env.RUNNER_VERDICT_MIN_CONFIDENCE, 0.9))),
    defaultDpi: intSetting(env.RUNNER_DPI, 200, 72),
    mcpCommand: launch.command,
    mcpArgs: launch.args,
    buildSha: /^[0-9a-f]{7,40}$/.test(String(env.RUNNER_BUILD_SHA || "")) ? String(env.RUNNER_BUILD_SHA) : "",
  };
}
