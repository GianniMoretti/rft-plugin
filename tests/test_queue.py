"""Tests of the experiment queue (server/rft_queue.py): jobs started on this machine's GPUs in the
user's order, a GPU in use elsewhere left alone, failures kept with their log, retries, cancels,
the runner that outlives the session, and the tree view's api/queue.

The jobs are real processes (short shell commands that wait for a file the test makes); the GPUs
are a fake probe, so the tests mean the same on a machine with no GPU.

    python3 -m unittest discover -s tests -p "test_*.py"
"""
import http.client
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import rft_queue  # noqa: E402
import rft_server  # noqa: E402

WEB = Path(__file__).resolve().parents[1] / "web"
QUEUE = Path(__file__).resolve().parents[1] / "server" / "rft_queue.py"
KEY = "test-key-123"


def gpu(index, mem=10, procs=()):
    return {"index": index, "uuid": f"GPU-{index}", "name": "RTX 5080", "mem_used": mem, "mem_total": 16303,
            "util": 0, "temp": 30, "procs": [{"pid": p, "mem": 500, "name": "python"} for p in procs]}


class FakeGpus:
    """What nvidia-smi says: `n` idle GPUs; a test can put a process of someone else's on one."""

    def __init__(self, n=2):
        self.gpus = [gpu(i) for i in range(n)]

    def __call__(self):
        return [dict(g) for g in self.gpus]


def wait_until(check, tick=None, timeout=10.0):
    end = time.time() + timeout
    while time.time() < end:
        if tick:
            tick()
        if check():
            return True
        time.sleep(0.05)
    return False


class QueueTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.vault = Path(self.tmp.name) / "vault"
        self.vault.mkdir()
        self.work = Path(self.tmp.name) / "code"
        self.work.mkdir()
        self.probe = FakeGpus(2)
        self.q = rft_queue.Queue(self.vault, probe=self.probe, wake=lambda: None)

    def tearDown(self):
        for j in self.q.read()["jobs"]:
            if j["state"] == "running":
                self.q.cancel(j["id"], "test over")
        self.tmp.cleanup()

    def held(self, name, code=0):
        """A job's command: it runs until the test makes the file `name`, then exits with `code`."""
        go = self.work / name
        return f"echo started {name}; while [ ! -e {go} ]; do sleep 0.05; done; echo bye; exit {code}"

    def release(self, name):
        (self.work / name).touch()

    def job(self, jid):
        return self.q.find(jid)

    def state_of(self, jid):
        return self.job(jid)["state"]

    def ended(self, jid):
        return wait_until(lambda: self.state_of(jid) not in ("pending", "running"), self.q.tick)

    # ------------------------------------------------------------ example 1: the order

    def test_jobs_start_in_order_on_the_free_gpus_and_a_2_gpu_job_waits(self):
        a = self.q.add("E14", self.held("a"), str(self.work), gpus=1)
        b = self.q.add("E15", self.held("b"), str(self.work), gpus=1)
        c = self.q.add("E16", self.held("c"), str(self.work), gpus=2)
        self.assertEqual([a["id"], b["id"], c["id"]], ["q1", "q2", "q3"])
        self.assertEqual(c["place"], 3)
        self.q.tick()
        self.assertEqual((self.state_of("q1"), self.job("q1")["gpu_ids"]), ("running", [0]))
        self.assertEqual((self.state_of("q2"), self.job("q2")["gpu_ids"]), ("running", [1]))
        self.assertEqual(self.state_of("q3"), "pending")
        # the job sees only its own GPUs, numbered as nvidia-smi numbers them
        log = (self.vault / ".queue" / "logs" / "q1.log")
        self.assertTrue(wait_until(lambda: "started a" in log.read_text()))

    def test_a_job_moved_up_starts_first_when_a_gpu_frees(self):
        self.q.add("E14", self.held("a"), str(self.work), gpus=1)
        self.q.add("E15", self.held("b"), str(self.work), gpus=1)
        self.q.add("E16", self.held("c"), str(self.work), gpus=2)
        self.q.tick()
        d = self.q.add("E17", self.held("d"), str(self.work), gpus=1)
        self.q.move(d["id"], before="q3")
        self.assertEqual([j["id"] for j in self.q.read()["jobs"] if j["state"] == "pending"], ["q4", "q3"])
        self.release("a")
        self.assertTrue(self.ended("q1"))
        self.q.tick()
        self.assertEqual((self.state_of("q1"), self.job("q1")["exit"]), ("done", 0))
        self.assertEqual((self.state_of("q4"), self.job("q4")["gpu_ids"]), ("running", [0]))
        self.assertEqual(self.state_of("q3"), "pending")

    def test_strict_order_nothing_jumps_a_job_waiting_for_two_gpus(self):
        self.q.add("E14", self.held("a"), str(self.work), gpus=1)
        self.q.tick()  # q1 on GPU 0, GPU 1 free
        self.q.add("E16", self.held("c"), str(self.work), gpus=2)
        self.q.add("E17", self.held("d"), str(self.work), gpus=1)
        self.q.tick()
        self.assertEqual(self.state_of("q2"), "pending")
        self.assertEqual(self.state_of("q3"), "pending")  # GPU 1 is free, but q2 is first
        self.assertIn("needs 2 GPUs", self.q.outlook(self.job("q2")))
        self.assertIn("after q2", self.q.outlook(self.job("q3")))

    def test_a_gpu_in_use_outside_the_queue_is_left_alone(self):
        self.probe.gpus[0] = gpu(0, mem=6000, procs=[424242])  # someone's notebook
        self.q.add("E14", self.held("a"), str(self.work), gpus=1)
        self.q.add("E15", self.held("b"), str(self.work), gpus=1)
        self.q.tick()
        self.assertEqual((self.state_of("q1"), self.job("q1")["gpu_ids"]), ("running", [1]))
        self.assertEqual(self.state_of("q2"), "pending")
        # memory held without a listed process counts too (another user's container)
        self.probe.gpus[0] = gpu(0, mem=3000)
        self.q.tick()
        self.assertEqual(self.state_of("q2"), "pending")
        self.probe.gpus[0] = gpu(0)
        self.q.tick()
        self.assertEqual((self.state_of("q2"), self.job("q2")["gpu_ids"]), ("running", [0]))

    def test_the_gpus_the_queue_may_use(self):
        self.q.allow([1])
        self.q.add("E14", self.held("a"), str(self.work), gpus=1)
        self.q.add("E15", self.held("b"), str(self.work), gpus=1)
        self.q.tick()
        self.assertEqual(self.job("q1")["gpu_ids"], [1])
        self.assertEqual(self.state_of("q2"), "pending")
        self.assertIn("GPU 0 is kept out of the queue", self.q.outlook(self.job("q2")))
        self.q.allow(None)
        self.q.tick()
        self.assertEqual(self.job("q2")["gpu_ids"], [0])

    def test_a_cpu_job_does_not_wait_for_gpus(self):
        self.q.add("E16", self.held("c"), str(self.work), gpus=2)
        self.probe.gpus = []  # no GPU at all
        self.q.add("E18", "echo cpu-only", str(self.work), gpus=0)
        self.q.tick()
        self.assertEqual(self.state_of("q1"), "pending")
        self.assertTrue(self.ended("q2"))
        self.assertEqual(self.state_of("q2"), "done")

    def test_pause_holds_the_queue(self):
        self.q.pause(True)
        self.q.add("E14", self.held("a"), str(self.work), gpus=1)
        self.q.tick()
        self.assertEqual(self.state_of("q1"), "pending")
        self.assertIn("paused", self.q.outlook(self.job("q1")))
        self.q.pause(False)
        self.q.tick()
        self.assertEqual(self.state_of("q1"), "running")

    def test_a_job_added_at_the_top(self):
        self.q.pause(True)
        self.q.add("E14", "true", str(self.work))
        top = self.q.add("E15", "true", str(self.work), top=True)
        self.assertEqual(top["place"], 1)
        self.assertEqual([j["id"] for j in self.q.read()["jobs"]], ["q2", "q1"])
        self.q.move("q2")  # to the end
        self.assertEqual([j["id"] for j in self.q.read()["jobs"]], ["q1", "q2"])
        self.q.move("q2", before="top")
        self.assertEqual([j["id"] for j in self.q.read()["jobs"]], ["q2", "q1"])

    # ------------------------------------------------------------ example 2: a failure

    def test_a_failed_job_keeps_its_exit_code_and_log_and_can_be_retried(self):
        self.q.add("E15", "echo 'CUDA out of memory'; exit 1", str(self.work), gpus=1, label="bs 512")
        self.q.tick()
        self.assertTrue(self.ended("q1"))
        j = self.job("q1")
        self.assertEqual((j["state"], j["exit"]), ("failed", 1))
        self.assertGreaterEqual(j["ended"], j["started"])
        self.assertIn("CUDA out of memory", self.q.log("q1", 5))
        self.assertEqual([h["id"] for h in self.q.history()], ["q1"])
        self.assertEqual(self.q.read()["jobs"], [])  # finished jobs leave the queue for the history
        self.q.pause(True)
        self.q.add("E20", "true", str(self.work))
        again = self.q.retry("q1")
        self.assertEqual((again["id"], again["retry_of"], again["exp"], again["label"]), ("q3", "q1", "E15", "bs 512"))
        self.assertEqual([j["id"] for j in self.q.read()["jobs"]], ["q3", "q2"])  # a retry goes first

    def test_a_job_killed_by_a_signal_fails(self):
        self.q.add("E15", "kill -9 $$", str(self.work), gpus=0)
        self.q.tick()
        self.assertTrue(self.ended("q1"))
        self.assertEqual(self.state_of("q1"), "failed")
        self.assertEqual(self.job("q1")["exit"], 137)

    def test_cancel_kills_the_job_and_what_it_started(self):
        pidfile = self.work / "child.pid"
        self.q.add("E14", f"sleep 300 & echo $! > {pidfile}; wait", str(self.work), gpus=1)
        self.q.tick()
        self.assertTrue(wait_until(lambda: pidfile.exists() and pidfile.read_text().strip()))
        child = int(pidfile.read_text())
        done = self.q.cancel("q1", "wrong config")
        self.assertEqual((done["state"], done["reason"]), ("cancelled", "wrong config"))
        self.assertTrue(wait_until(lambda: not rft_queue.pid_alive(child)))
        self.assertEqual(self.q.read()["jobs"], [])
        # a pending job is only taken off the queue
        self.q.pause(True)
        self.q.add("E15", "true", str(self.work))
        self.assertEqual(self.q.cancel("q2")["state"], "cancelled")
        self.assertEqual([h["id"] for h in self.q.history()], ["q2", "q1"])

    def test_a_job_that_vanished_without_an_exit_code_is_lost(self):
        self.q.add("E14", self.held("a"), str(self.work), gpus=1)
        self.q.tick()
        real = self.job("q1")["pid"]
        # the machine restarted: the process is gone and wrote no exit code
        with self.q.change() as st:
            st["jobs"][0]["pid"] = 2 ** 22 + 12345
        self.q.tick()
        j = self.job("q1")
        self.assertEqual(j["state"], "failed")
        self.assertIn("lost", j["reason"])
        os.killpg(real, signal.SIGKILL)  # the real process, no longer followed
        self.assertTrue(wait_until(lambda: not rft_queue.pid_alive(real), self.q.tick))

    def test_errors_are_plain(self):
        with self.assertRaisesRegex(rft_queue.QueueError, "no job q9"):
            self.q.cancel("q9")
        with self.assertRaisesRegex(rft_queue.QueueError, "experiment"):
            self.q.add("D04", "true", str(self.work))
        with self.assertRaisesRegex(rft_queue.QueueError, "folder"):
            self.q.add("E14", "true", str(self.work / "missing"))
        with self.assertRaisesRegex(rft_queue.QueueError, "command"):
            self.q.add("E14", "  ", str(self.work))
        self.q.add("E14", "echo x", str(self.work), gpus=0)
        self.q.tick()
        self.assertTrue(self.ended("q1"))
        with self.assertRaisesRegex(rft_queue.QueueError, "q1 has already ended"):
            self.q.move("q1", before="top")

    def test_two_writers_never_lose_a_job(self):
        self.q.pause(True)
        others = [rft_queue.Queue(self.vault, probe=self.probe, wake=lambda: None) for _ in range(4)]
        threads = [threading.Thread(target=lambda o=o: [o.add("E14", "true", str(self.work)) for _ in range(10)]) for o in others]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        ids = [j["id"] for j in self.q.read()["jobs"]]
        self.assertEqual(len(ids), 40)
        self.assertEqual(len(set(ids)), 40)

    def test_snapshot_for_the_view(self):
        self.probe.gpus[1] = gpu(1, mem=6000, procs=[424242])
        self.q.add("E14", self.held("a"), str(self.work), gpus=1)
        self.q.tick()
        s = self.q.snapshot()
        self.assertEqual(s["gpus"][0]["job"], "q1")
        self.assertIsNone(s["gpus"][1]["job"])
        self.assertTrue(s["gpus"][1]["busy"])
        self.assertEqual([j["id"] for j in s["jobs"]], ["q1"])
        self.assertIn("host", s)
        self.assertEqual(s["history"], [])

    def test_no_nvidia_smi_is_said_not_raised(self):
        def broken():
            raise rft_queue.QueueError("nvidia-smi not found")
        q = rft_queue.Queue(self.vault, probe=broken, wake=lambda: None)
        q.add("E14", "true", str(self.work), gpus=1)
        q.tick()
        self.assertEqual(q.find("q1")["state"], "pending")
        self.assertIn("nvidia-smi not found", q.snapshot()["gpu_error"])
        self.assertIn("nvidia-smi not found", q.outlook(q.find("q1")))


class ProbeTest(unittest.TestCase):
    def test_reads_nvidia_smi(self):
        answers = {
            "--query-gpu": "0, GPU-a, NVIDIA GeForce RTX 5080, 37, 16303, 3, 41\n1, GPU-b, NVIDIA GeForce RTX 5080, 9000, 16303, 97, 70\n",
            "--query-compute-apps": "GPU-b, 4242, 8900, python\n",
        }

        def run(argv, **kw):
            key = next(a.split("=")[0] for a in argv if a.startswith("--query"))
            return subprocess.CompletedProcess(argv, 0, answers[key], "")

        gpus = rft_queue.probe_gpus(run)
        self.assertEqual([g["index"] for g in gpus], [0, 1])
        self.assertEqual((gpus[0]["name"], gpus[0]["mem_used"], gpus[0]["procs"]), ("NVIDIA GeForce RTX 5080", 37, []))
        self.assertEqual(gpus[1]["procs"], [{"pid": 4242, "mem": 8900, "name": "python"}])
        self.assertEqual((gpus[1]["util"], gpus[1]["temp"]), (97, 70))


class RunnerTest(unittest.TestCase):
    """The runner is a process of its own, apart from the session: it starts the jobs and stops
    once the queue has been empty a while."""

    def test_the_runner_runs_the_queue_and_stops_when_idle(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            q = rft_queue.Queue(vault, wake=lambda: None)
            q.add("E14", "echo from-the-runner", tmp, gpus=0)
            self.assertFalse(rft_queue.runner_alive(vault))
            self.assertTrue(rft_queue.ensure_runner(vault, idle=1.0, every=0.2))
            self.assertTrue(wait_until(lambda: rft_queue.runner_alive(vault)))
            self.assertFalse(rft_queue.ensure_runner(vault, idle=1.0, every=0.2))  # one runner per vault
            self.assertTrue(wait_until(lambda: q.find("q1")["state"] == "done"))
            self.assertIn("from-the-runner", q.log("q1"))
            self.assertTrue(wait_until(lambda: not rft_queue.runner_alive(vault), timeout=15))

    def test_the_command_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = lambda *a: subprocess.run([sys.executable, str(QUEUE), *a, "--vault", tmp, "--no-runner"],
                                            capture_output=True, text=True, timeout=30)
            out = run("add", "--job", json.dumps({"exp": "E14", "cmd": "true", "cwd": tmp, "gpus": 1, "label": "seed 0"}))
            self.assertEqual(out.returncode, 0, out.stderr)
            added = json.loads(out.stdout)
            self.assertEqual((added["job"]["id"], added["job"]["place"]), ("q1", 1))
            self.assertIn("outlook", added)
            status = json.loads(run("status").stdout)
            self.assertEqual([j["id"] for j in status["jobs"]], ["q1"])
            bad = run("cancel", "--id", "q7")
            self.assertEqual(bad.returncode, 2)
            self.assertIn("no job q7", json.loads(bad.stdout)["error"])
            gone = json.loads(run("cancel", "--id", "q1").stdout)
            self.assertEqual(gone["job"]["state"], "cancelled")


class ServerQueueTest(unittest.TestCase):
    """api/queue: what the monitor shows, and the user's changes to the queue (with the key)."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        vault = Path(cls.tmp.name) / "vault"
        (vault / "experiments").mkdir(parents=True)
        cls.v = rft_server.Vault(vault, "demo")
        handler = rft_server.make_handler(cls.v, WEB, KEY, lambda *a: None)
        cls.server = rft_server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def setUp(self):
        # each test its own queue, behind the same server
        self.qdir = tempfile.TemporaryDirectory()
        self.probe = FakeGpus(2)
        self.q = self.v.queue = rft_queue.Queue(self.qdir.name, probe=self.probe, wake=lambda: None)

    def tearDown(self):
        self.qdir.cleanup()

    def call(self, method, path, body=None, key=KEY):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Host": f"127.0.0.1:{self.port}", "Origin": f"http://127.0.0.1:{self.port}", "Content-Type": "application/json"}
        if key:
            headers["X-RFT-Token"] = key
        data = json.dumps(body).encode() if body is not None else None
        c.request(method, path, body=data, headers=headers)
        r = c.getresponse()
        out = r.read()
        c.close()
        return r.status, json.loads(out) if out[:1] in (b"{", b"[") else out

    def test_get_and_change_the_queue(self):
        self.q.pause(True)
        self.q.add("E14", "true", self.qdir.name)
        self.q.add("E15", "true", self.qdir.name)
        status, s = self.call("GET", "/api/queue")
        self.assertEqual(status, 200)
        self.assertEqual([j["id"] for j in s["jobs"]], ["q1", "q2"])
        self.assertIn("paused", s["jobs"][0]["outlook"])
        self.assertEqual(len(s["gpus"]), 2)
        self.assertTrue(s["paused"])
        # without the key nothing changes
        status, _ = self.call("POST", "/api/queue", {"op": "move", "id": "q2", "before": "top"}, key=None)
        self.assertEqual(status, 403)
        status, r = self.call("POST", "/api/queue", {"op": "move", "id": "q2", "before": "top"})
        self.assertEqual(status, 200, r)
        self.assertEqual([j["id"] for j in self.q.read()["jobs"]], ["q2", "q1"])
        status, r = self.call("POST", "/api/queue", {"op": "cancel", "id": "q1"})
        self.assertEqual((status, r["job"]["state"]), (200, "cancelled"))
        status, r = self.call("POST", "/api/queue", {"op": "retry", "id": "q1"})
        self.assertEqual((status, r["job"]["retry_of"], r["job"]["by"]), (200, "q1", "user"))
        status, r = self.call("POST", "/api/queue", {"op": "gpus", "allowed": [0]})
        self.assertEqual((status, self.q.read()["allowed"]), (200, [0]))
        status, r = self.call("POST", "/api/queue", {"op": "pause", "paused": False})
        self.assertEqual((status, self.q.read()["paused"]), (200, False))
        status, r = self.call("POST", "/api/queue", {"op": "cancel", "id": "q99"})
        self.assertEqual(status, 404)
        status, r = self.call("POST", "/api/queue", {"op": "move", "id": "q1", "before": "top"})
        self.assertEqual(status, 409)  # it ended
        status, r = self.call("POST", "/api/queue", {"op": "explode"})
        self.assertEqual(status, 400)

    def test_a_log_needs_the_key(self):
        jid = self.q.add("E16", "echo some-output", self.qdir.name, gpus=0)["id"]
        self.assertTrue(wait_until(lambda: self.q.find(jid)["state"] == "done", self.q.tick))
        status, _ = self.call("GET", f"/api/queue/log?id={jid}&lines=10", key=None)
        self.assertEqual(status, 403)
        status, r = self.call("GET", f"/api/queue/log?id={jid}&lines=10")
        self.assertEqual(status, 200)
        self.assertIn("some-output", r["text"])
        status, _ = self.call("GET", "/api/queue/log?id=q99&lines=10")
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
