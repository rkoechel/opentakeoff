"""Unit tests for waker.py (python3 -m unittest, from this directory)."""
import threading
import unittest

import waker as w

MEM = lambda gb: (lambda: f"MemTotal: 128000000 kB\nMemAvailable: {int(gb * 1024 * 1024)} kB\n")
TOKEN = "t0ken-for-tests"
AUTH = f"Bearer {TOKEN}"


class FakeDocker:
    def __init__(self, status="exited", start_code=0, gate=None):
        self.status = status
        self.start_code = start_code
        self.calls = []
        self.gate = gate

    def __call__(self, argv):
        self.calls.append(list(argv))
        if "inspect" in argv:
            return (0, self.status + "\n") if self.status != "missing" else (1, "")
        if "start" in argv:
            if self.gate:
                self.gate.wait(2)
            if self.start_code == 0:
                self.status = "running"
            return self.start_code, ""
        return 1, ""


def make(docker, gb=40, env=None, healthy=False, clock=None, logs=None):
    e = {"WAKER_TOKEN": TOKEN, **(env or {})}
    return w.Waker(env=e, run=docker, read_meminfo=MEM(gb), health=lambda _u: healthy,
                   now=clock or (lambda: 1000.0), log=(logs.append if logs is not None else (lambda _m: None)))


class WakerTest(unittest.TestCase):
    def test_auth_required_and_token_never_logged(self):
        logs = []
        k = make(FakeDocker(), logs=logs)
        self.assertEqual(k.handle("GET", "/_waker/status", None)[0], 401)
        self.assertEqual(k.handle("GET", "/_waker/status", "Bearer wrong")[0], 401)
        self.assertEqual(k.handle("GET", "/_waker/status", TOKEN)[0], 401)
        self.assertEqual(k.handle("GET", "/_waker/status", AUTH)[0], 200)
        k.handle("POST", "/_waker/wake", AUTH)
        self.assertFalse(any(TOKEN in m for m in logs))
        unset = w.Waker(env={}, run=FakeDocker(), read_meminfo=MEM(40), health=lambda _u: False)
        self.assertEqual(unset.handle("GET", "/status", AUTH)[0], 503)

    def test_status_states(self):
        self.assertEqual(make(FakeDocker("running"), healthy=True).status()["state"], "running")
        self.assertEqual(make(FakeDocker("running"), healthy=False).status()["state"], "starting")
        self.assertEqual(make(FakeDocker("exited"), gb=40).status(), {"state": "stopped", "freeGB": 40.0})
        self.assertEqual(make(FakeDocker("exited"), gb=10).status()["state"], "no_memory")

    def test_memory_gate_refuses_without_starting(self):
        d = FakeDocker("exited")
        code, body = make(d, gb=12).handle("POST", "/_waker/wake", AUTH)
        self.assertEqual(code, 503)
        self.assertEqual(body["state"], "no_memory")
        self.assertFalse(any("start" in c for c in d.calls))
        code, _ = make(FakeDocker("exited"), gb=12, env={"MEM_THRESHOLD_GB": "8"}).handle("POST", "/wake", AUTH)
        self.assertEqual(code, 202)

    def test_starts_only_the_fixed_container_without_a_shell(self):
        d = FakeDocker("exited")
        code, body = make(d).handle("POST", "/_waker/wake?name=evil;rm", AUTH)
        self.assertEqual((code, body["state"]), (202, "starting"))
        self.assertIn(["docker", "start", "takeoff-vision"], d.calls)
        for c in d.calls:
            self.assertEqual(c[-1], "takeoff-vision")
        s = FakeDocker("exited")
        make(s, env={"WAKER_USE_SUDO": "1"}).wake()
        self.assertIn(["sudo", "-n", "/usr/bin/docker", "start", "takeoff-vision"], s.calls)

    def test_idempotent_running_and_starting(self):
        d = FakeDocker("running")
        self.assertEqual(make(d, healthy=True).wake()[0], 200)
        self.assertEqual(make(d, healthy=False).wake(), (202, {"state": "starting", "freeGB": 40.0}))
        self.assertFalse(any("start" in c for c in d.calls))

    def test_one_start_in_flight_and_cooldown(self):
        gate = threading.Event()
        d = FakeDocker("exited", gate=gate)
        k = make(d)
        out = []
        t = threading.Thread(target=lambda: out.append(k.wake()))
        t.start()
        while not k._starting:
            pass
        self.assertEqual(k.wake()[1]["state"], "starting")   # second caller while the first runs
        gate.set()
        t.join()
        self.assertEqual(out[0][0], 202)
        self.assertEqual(sum(1 for c in d.calls if "start" in c), 1)
        failing = FakeDocker("exited", start_code=1)
        clock = [1000.0]
        k2 = make(failing, clock=lambda: clock[0])
        self.assertEqual(k2.wake()[0], 500)
        code, body = k2.wake()
        self.assertEqual(code, 429)
        self.assertGreater(body["retryAfter"], 0)
        clock[0] += 31
        self.assertEqual(k2.wake()[0], 500)
        self.assertEqual(sum(1 for c in failing.calls if "start" in c), 2)

    def test_methods_and_paths(self):
        k = make(FakeDocker())
        self.assertEqual(k.handle("POST", "/_waker/status", AUTH)[0], 405)
        self.assertEqual(k.handle("GET", "/_waker/wake", AUTH)[0], 405)
        self.assertEqual(k.handle("GET", "/_waker/other", AUTH)[0], 404)


if __name__ == "__main__":
    unittest.main()
