#!/usr/bin/env python3
"""takeoff-vision waker: start the DGX's takeoff-vision container on demand.

OpenTakeoff's /api/ai proxy calls this when the vision model is down (the
container stops itself after 15 minutes idle). Python 3.8+ standard library
only. It runs as a systemd service on the Spark, listens on a local port
(default 127.0.0.1:8012), and sits behind cloudflared at
https://takeoff-vision.floor360.com/_waker/* with the same Cloudflare Access
service token as the model.

  GET  /_waker/status  {"state": running|starting|stopped|no_memory, "freeGB": n}
  POST /_waker/wake    start the container if it is stopped and memory allows

Both require "Authorization: Bearer <WAKER_TOKEN>". The prefix /_waker is
optional, so /status and /wake work on the local port too.

The only command it can run is `docker start takeoff-vision` (plus
`docker inspect` of that same container to read its state). The container
name is a constant; nothing from a request reaches a command line, and no
shell is used. One start runs at a time, and a start is not retried within
WAKE_COOLDOWN_S.

Environment (EnvironmentFile=/etc/takeoff-vision-waker.env):
  WAKER_TOKEN        required; the shared bearer token (never logged)
  MEM_THRESHOLD_GB   free memory needed before a start, default 17
  WAKER_HOST         default 127.0.0.1
  WAKER_PORT         default 8012
  HEALTH_URL         the model's health check, default http://127.0.0.1:8010/health
  WAKE_COOLDOWN_S    minimum seconds between start attempts, default 30
  WAKER_USE_SUDO     "1": run docker as `sudo -n /usr/bin/docker ...` (the
                     narrow sudoers rule in README.md); else plain `docker`
                     (the service user is in the docker group)
"""

import hashlib
import hmac
import json
import os
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONTAINER = "takeoff-vision"   # fixed; never taken from a request
PREFIX = "/_waker"


class Waker:
    def __init__(self, env=None, run=None, read_meminfo=None, health=None, now=None, log=None):
        env = os.environ if env is None else env
        self.token = (env.get("WAKER_TOKEN") or "").strip()
        self.threshold_gb = _float(env.get("MEM_THRESHOLD_GB"), 17.0)
        self.health_url = env.get("HEALTH_URL") or "http://127.0.0.1:8010/health"
        self.cooldown_s = _float(env.get("WAKE_COOLDOWN_S"), 30.0)
        self.use_sudo = env.get("WAKER_USE_SUDO") == "1"
        self._run = run or _run
        self._read_meminfo = read_meminfo or _read_meminfo
        self._health = health or _health
        self._now = now or time.monotonic
        self._log = log or (lambda msg: print(msg, flush=True))
        self._lock = threading.Lock()
        self._starting = False
        self._last_start = None

    # ── commands (fixed argv, no shell) ────────────────────────────────────
    def _docker(self, *args):
        base = ["sudo", "-n", "/usr/bin/docker"] if self.use_sudo else ["docker"]
        return self._run(base + list(args))

    def container_status(self):
        code, out = self._docker("inspect", "--format", "{{.State.Status}}", CONTAINER)
        return out.strip() if code == 0 and out.strip() else "missing"

    def free_gb(self):
        """MemAvailable in GiB (DGX Spark memory is unified CPU/GPU)."""
        for line in self._read_meminfo().splitlines():
            if line.startswith("MemAvailable:"):
                return round(int(line.split()[1]) / (1024 * 1024), 1)
        return 0.0

    # ── state ──────────────────────────────────────────────────────────────
    def status(self):
        free = self.free_gb()
        c = self.container_status()
        if c == "running":
            state = "running" if self._health(self.health_url) else "starting"
        elif c in ("restarting",) or self._starting:
            state = "starting"
        elif free < self.threshold_gb:
            state = "no_memory"
        else:
            state = "stopped"
        return {"state": state, "freeGB": free}

    def wake(self):
        """(http status, body). Idempotent: a running or starting container
        is left alone; one start at a time; no retry inside the cooldown."""
        with self._lock:
            if self._starting:
                return 202, {"state": "starting", "freeGB": self.free_gb()}
            cur = self.status()
            if cur["state"] in ("running", "starting"):
                return (200 if cur["state"] == "running" else 202), cur
            if self._last_start is not None and self._now() - self._last_start < self.cooldown_s:
                wait = int(self.cooldown_s - (self._now() - self._last_start)) + 1
                return 429, {**cur, "error": "a start was just tried", "retryAfter": wait}
            if cur["freeGB"] < self.threshold_gb:
                self._log(f"wake refused: {cur['freeGB']} GB free, need {self.threshold_gb}")
                return 503, {"state": "no_memory", "freeGB": cur["freeGB"], "needGB": self.threshold_gb}
            self._starting = True
            self._last_start = self._now()
        try:
            code, _ = self._docker("start", CONTAINER)
        finally:
            with self._lock:
                self._starting = False
        if code != 0:
            self._log(f"docker start {CONTAINER} failed (exit {code})")
            return 500, {"state": "stopped", "freeGB": self.free_gb(), "error": "docker start failed"}
        self._log(f"started {CONTAINER}")
        return 202, {"state": "starting", "freeGB": self.free_gb()}

    def authorized(self, header):
        if not self.token:
            return False
        given = (header or "")
        if not given.startswith("Bearer "):
            return False
        a = hashlib.sha256(given[7:].strip().encode()).digest()
        b = hashlib.sha256(self.token.encode()).digest()
        return hmac.compare_digest(a, b)

    def handle(self, method, path, auth_header):
        """(http status, body) for one request."""
        if path.startswith(PREFIX + "/"):
            path = path[len(PREFIX):]
        path = path.split("?", 1)[0]
        if path not in ("/status", "/wake"):
            return 404, {"error": "not found"}
        if not self.token:
            return 503, {"error": "waker not configured"}
        if not self.authorized(auth_header):
            return 401, {"error": "unauthorized"}
        if path == "/status":
            if method != "GET":
                return 405, {"error": "use GET"}
            return 200, self.status()
        if method != "POST":
            return 405, {"error": "use POST"}
        return self.wake()


def _float(value, default):
    try:
        v = float(value)
        return v if v >= 0 else default
    except (TypeError, ValueError):
        return default


def _run(argv):
    try:
        p = subprocess.run(argv, shell=False, capture_output=True, text=True, timeout=60, check=False)
        return p.returncode, p.stdout
    except (OSError, subprocess.SubprocessError):
        return 127, ""


def _read_meminfo():
    with open("/proc/meminfo", encoding="ascii") as f:
        return f.read()


def _health(url):
    try:
        with urllib.request.urlopen(url, timeout=2) as r:
            return 200 <= r.status < 300
    except Exception:  # noqa: BLE001 - any failure is "not up yet"
        return False


def make_handler(waker):
    class Handler(BaseHTTPRequestHandler):
        server_version = "takeoff-vision-waker"
        sys_version = ""

        def _send(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _do(self, method):
            status, body = waker.handle(method, self.path, self.headers.get("Authorization"))
            self._send(status, body)

        def do_GET(self):
            self._do("GET")

        def do_POST(self):
            # a body is never read or used
            self._do("POST")

        def log_message(self, fmt, *args):
            # method, path and status only: no headers, so no token
            waker._log(f"{self.command} {self.path.split('?', 1)[0]} {args[1] if len(args) > 1 else ''}")

    return Handler


def main():
    waker = Waker()
    if not waker.token:
        raise SystemExit("WAKER_TOKEN is not set")
    host = os.environ.get("WAKER_HOST") or "127.0.0.1"
    port = int(os.environ.get("WAKER_PORT") or "8012")
    httpd = ThreadingHTTPServer((host, port), make_handler(waker))
    waker._log(f"takeoff-vision-waker on {host}:{port}, threshold {waker.threshold_gb} GB")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
