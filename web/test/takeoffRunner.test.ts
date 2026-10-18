// floor360/takeoff-runner: its own suite runs in its package (npm test there,
// and the takeoff-runner CI job). These checks run inside the web suite so the
// deploy artifacts keep their promises with no extra install: no GPU, no
// docker calls, host network bound to loopback port 8014, off by default, no
// secrets in the examples, cloudflared left alone (dashboard-managed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../../floor360/takeoff-runner/", import.meta.url));
const read = (p: string) => readFileSync(dir + p, "utf8");

test("the runner image and run lines ask for no GPU, use the host network and bind 127.0.0.1 only", () => {
  const docker = read("Dockerfile");
  const readme = read("README.md");
  const compose = read("compose.example.yml");
  const envExample = read("takeoff-runner.env.example");
  for (const [name, text] of [["Dockerfile", docker], ["README.md", readme], ["compose.example.yml", compose]]) {
    assert.doesNotMatch(text, /--gpus\s|\bgpus:|nvidia|runtime:\s*nvidia|capabilities:\s*\[\s*gpu/i, `${name} must not request a GPU`);
  }
  for (const [name, text] of [["Dockerfile", docker], ["compose.example.yml", compose], ["takeoff-runner.env.example", envExample]]) {
    assert.doesNotMatch(text, /RUNNER_HOST[=:]\s*"?0\.0\.0\.0/, `${name} must not bind every interface`);
  }
  const run = readme.slice(readme.indexOf("docker run -d --name takeoff-runner"));
  const line = run.slice(0, run.indexOf("```"));
  assert.match(line, /--network host/);
  assert.match(line, /-e RUNNER_HOST=127\.0\.0\.1/);
  assert.doesNotMatch(line, /(^|\s)(-p|--publish)\s/, "host network: nothing is published");
  assert.doesNotMatch(line, /--add-host|host-gateway/);
  assert.match(line, /--cpus 6 --memory 12g/);
  assert.match(line, /--restart unless-stopped/);
  assert.match(line, /--cap-drop ALL/);
  assert.match(compose, /^\s+network_mode: host$/m);
  assert.match(compose, /^\s+RUNNER_HOST: 127\.0\.0\.1$/m);
  assert.doesNotMatch(compose, /^\s+(ports|extra_hosts):/m);
  assert.match(docker, /ENV RUNNER_HOST=127\.0\.0\.1 /);
  assert.match(docker, /^FROM node:22-bookworm-slim AS runtime$/m);
});

test("cloudflared is remotely managed: the install adds a dashboard hostname and never edits or restarts cloudflared", () => {
  for (const f of ["README.md", "CONTRACT.md", "Dockerfile", "compose.example.yml", "takeoff-runner.env.example"]) {
    const text = read(f);
    assert.doesNotMatch(text, /restart(ing)?\s+(the\s+)?cloudflared|systemctl\s+\S+\s+cloudflared/i, `${f} must not restart cloudflared`);
    assert.doesNotMatch(text, /ingress rule|- hostname:/i, `${f} must not edit a local cloudflared config`);
  }
  const readme = read("README.md");
  assert.match(readme, /Public Hostname `takeoff-runner\.floor360\.com` with service `http:\/\/127\.0\.0\.1:8014`/);
  assert.match(readme, /\*\*No local cloudflared config edit and NO cloudflared restart/);
  assert.match(readme, /CF-Access-Client-Id: \$ID/);
});

test("the runner never shells out or runs docker; the engine is the only child", () => {
  for (const f of readdirSync(dir + "src")) {
    const src = read(`src/${f}`);
    assert.doesNotMatch(src, /node:child_process|from "child_process"|execSync|spawnSync/, `${f} must not spawn processes itself`);
    assert.doesNotMatch(src, /["'`]docker["'`]|docker (start|stop|run|rm|kill)/, `${f} must not run docker`);
  }
  assert.match(read("src/engine.ts"), /OPENTAKEOFF_ONE_CLICK: "1"/);
});

test("off by default, loopback by default, and no secret values in the examples", () => {
  const cfg = read("src/config.ts");
  assert.match(cfg, /enabled: env\.RUNNER_ENABLED === "1"/);
  assert.match(cfg, /env\.RUNNER_HOST \|\| "127\.0\.0\.1"/);
  assert.match(cfg, /intSetting\(env\.RUNNER_PORT, 8014\)/);
  const env = read("takeoff-runner.env.example").split("\n").filter((l) => l && !l.startsWith("#"));
  assert.ok(env.includes("RUNNER_ENABLED=0"));
  assert.ok(env.includes("RUNNER_TOKEN="));
  assert.ok(env.includes("RUNNER_HOST=127.0.0.1"));
  assert.ok(env.includes("RUNNER_PORT=8014"));
  assert.ok(env.includes("VISION_BASE_URL=http://100.72.198.58:8010/v1"), "takeoff-vision on the tailnet, with the /v1 the client appends to");
  assert.ok(env.includes("WAKER_URL=http://127.0.0.1:8012"));
  for (const l of env) {
    const [k, v = ""] = l.split("=");
    if (/TOKEN|KEY|SECRET|PASSWORD/.test(k) && !k.endsWith("_FILE")) assert.equal(v, "", `${k} must be empty in the example`);
  }
  assert.doesNotMatch(read("takeoff-runner.env.example"), /:(800[0-3])\b/, "no existing service port is reused");
});
