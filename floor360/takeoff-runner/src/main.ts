// Entry point: node dist/main.js (the image) or npm run dev (a checkout).
import { createServer } from "node:http";
import { systemClock } from "./clock.ts";
import { loadConfig } from "./config.ts";
import { startMcpEngine } from "./engine.ts";
import { JobStore } from "./jobs.ts";
import { runTakeoff } from "./pipeline.ts";
import { createRunnerHandler } from "./server.ts";
import { createVision } from "./vision.ts";
import pkg from "../package.json" with { type: "json" };

const config = loadConfig();
const log = (msg: string) => console.log(`${new Date().toISOString()} takeoff-runner ${msg}`);
const runnerVersion = config.buildSha ? `${pkg.version}+${config.buildSha.slice(0, 12)}` : pkg.version;
const vision = createVision({ config, clock: systemClock, log });

const store = new JobStore({
  dataDir: config.dataDir,
  clock: systemClock,
  jobTimeoutMs: config.jobTimeoutMs,
  retentionMs: config.retentionMs,
  log,
  execute: (ctx) => runTakeoff(ctx, {
    startEngine: (signal) => startMcpEngine({ command: config.mcpCommand, args: config.mcpArgs, signal, log }),
    vision,
    runnerVersion,
    verdictMinConfidence: config.verdictMinConfidence,
  }),
});

if (config.concurrencyIgnored) log("RUNNER_CONCURRENCY is fixed at 1 (one job at a time); the setting was ignored");
await store.init();
const sweep = setInterval(() => { store.sweep().catch((e) => log(`sweep failed: ${(e as Error).message}`)); }, 60 * 60_000);
sweep.unref();

const server = createServer(createRunnerHandler({ config, store, log }));
server.requestTimeout = 15 * 60_000;   // a 64 MB chunk over a slow tunnel
server.listen(config.port, config.host, () => {
  log(`listening on ${config.host}:${config.port} (${config.enabled ? "enabled" : "disabled: RUNNER_ENABLED is not 1"}${config.enabled && !config.token ? ", no RUNNER_TOKEN set" : ""}); version ${runnerVersion}`);
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    log(`${sig}: shutting down`);
    server.close();
    process.exit(0);
  });
}
