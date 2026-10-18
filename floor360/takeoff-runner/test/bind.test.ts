// The listen surface: one HTTP server on RUNNER_HOST (loopback under the host
// network), the engine over stdio only, and deploy defaults that keep it so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";

const dir = fileURLToPath(new URL("../", import.meta.url));
const read = (p: string) => readFileSync(dir + p, "utf8");

function envExample(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const l of read("takeoff-runner.env.example").split("\n")) {
    if (!l || l.startsWith("#")) continue;
    const i = l.indexOf("=");
    env[l.slice(0, i)] = l.slice(i + 1);
  }
  return env;
}

test("the only listener is main's HTTP server on config.host; the engine talks stdio", () => {
  const listens: string[] = [];
  for (const f of readdirSync(dir + "src")) {
    const src = read(`src/${f}`);
    for (const m of src.matchAll(/\.listen\(([^,()]*),\s*([^,()]*)/g)) listens.push(`${f}: ${m[1]}, ${m[2]}`);
    assert.doesNotMatch(src, /node:net"|node:dgram"|node:https"|createSecureServer|WebSocketServer|SSEServerTransport|StreamableHTTP/, `${f} opens no other server`);
  }
  assert.deepEqual(listens, ["main.ts: config.port, config.host"]);
  assert.equal(read("src/main.ts").match(/createServer\(/g)?.length, 1);
  const engine = read("src/engine.ts");
  assert.match(engine, /new StdioClientTransport\(/);
  assert.doesNotMatch(engine, /SSEClientTransport|StreamableHTTPClientTransport/);
});

test("the env example loads as loopback 8014, off, with the tailnet vision URL (with /v1) and the loopback waker", () => {
  const c = loadConfig(envExample());
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.port, 8014);
  assert.equal(c.enabled, false);
  assert.equal(c.token, "");
  assert.equal(c.visionBaseUrl, "http://100.72.198.58:8010/v1");
  assert.equal(c.wakerUrl, "http://127.0.0.1:8012");
});

test("image, compose and env example all default the bind to 127.0.0.1 on the host network", () => {
  assert.match(read("Dockerfile"), /ENV RUNNER_HOST=127\.0\.0\.1 /);
  assert.doesNotMatch(read("Dockerfile"), /0\.0\.0\.0/);
  const compose = read("compose.example.yml");
  assert.match(compose, /^\s+network_mode: host$/m);
  assert.match(compose, /^\s+RUNNER_HOST: 127\.0\.0\.1$/m);
  assert.doesNotMatch(compose, /^\s+(ports|extra_hosts):/m);
  assert.equal(envExample().RUNNER_HOST, "127.0.0.1");
});
