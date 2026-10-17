// infra/takeoff-vision-waker (Python stdlib): its unittests run here so the
// web suite covers the waker's memory gate, auth, idempotency and fixed
// container name. Skipped where python3 is missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../../infra/takeoff-vision-waker/", import.meta.url));
const py = spawnSync("python3", ["--version"]);

test("waker unittests pass", { skip: py.status !== 0 && "python3 not installed" }, () => {
  const r = spawnSync("python3", ["-m", "unittest", "-q", "test_waker"], { cwd: dir, encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.equal(r.status, 0, r.stderr);
});

test("the waker can only start takeoff-vision, never through a shell", () => {
  const src = readFileSync(dir + "waker.py", "utf8");
  assert.match(src, /^CONTAINER = "takeoff-vision"/m);
  assert.doesNotMatch(src, /shell=True|os\.system|os\.popen/);
  const sudoers = readFileSync(dir + "takeoff-vision-waker.sudoers", "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
  assert.deepEqual(sudoers, [
    "takeoff-waker ALL=(root) NOPASSWD: /usr/bin/docker start takeoff-vision",
    "takeoff-waker ALL=(root) NOPASSWD: /usr/bin/docker inspect --format {{.State.Status}} takeoff-vision",
  ]);
  const unit = readFileSync(dir + "takeoff-vision-waker.service", "utf8");
  assert.match(unit, /EnvironmentFile=\/etc\/takeoff-vision-waker\.env/);
  assert.doesNotMatch(unit, /WAKER_TOKEN=/);
});
