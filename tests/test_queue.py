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
import shlex
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


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args],
                          check=True, capture_output=True, text=True).stdout.strip()


class RunRecordTest(unittest.TestCase):
    """A job is the record of its run: the code it ran (commit, branch, uncommitted changes as a
    patch), its output folder ($RFT_OUT), and how it ended (the end of a traceback), kept in the
    history and as rft-run.json beside its outputs."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name).resolve()
        self.vault = base / "vault"
        self.vault.mkdir()
        self.repo = base / "code"
        (self.repo / "src").mkdir(parents=True)
        (self.repo / "train.py").write_text("print('v1')\n")
        git(self.repo, "init", "-q", "-b", "main")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-q", "-m", "one")
        self.q = rft_queue.Queue(self.vault, probe=FakeGpus(1), wake=lambda: None)

    def tearDown(self):
        for j in self.q.read()["jobs"]:
            if j["state"] == "running":
                self.q.cancel(j["id"], "test over")

    def ended(self, jid):
        return wait_until(lambda: self.q.find(jid)["state"] not in ("pending", "running"), self.q.tick)

    def test_a_run_records_the_code_it_ran_and_its_output_folder(self):
        (self.repo / "train.py").write_text("print('v2')\n")  # an uncommitted change
        (self.repo / "notes.txt").write_text("untracked\n")
        j = self.q.add("E14", 'echo "$RFT_OUT" > "$RFT_OUT/seen"; python3 ../train.py', str(self.repo / "src"), gpus=0, label="seed 0")
        out = self.repo / "runs" / "E14" / "q1"
        self.assertEqual(j["out"], str(out))  # known when queued, made when it starts
        self.assertTrue(self.ended("q1"))
        r = self.q.find("q1")
        self.assertEqual(r["state"], "done")
        self.assertEqual((out / "seen").read_text().strip(), str(out))
        self.assertEqual((r["repo"], r["commit"], r["branch"]), (str(self.repo), git(self.repo, "rev-parse", "--short=10", "HEAD"), "main"))
        self.assertTrue(r["dirty"])
        self.assertEqual(r["untracked"], 1)
        self.assertIn("+print('v2')", Path(r["patch"]).read_text())
        self.assertEqual(Path(r["patch"]).parent, out)
        self.assertNotIn("changed", r)
        # the outputs say what made them; the root the runner made keeps them out of git
        rec = json.loads((out / "rft-run.json").read_text())
        self.assertEqual((rec["id"], rec["state"], rec["commit"], rec["label"]), ("q1", "done", r["commit"], "seed 0"))
        self.assertNotIn("pid", rec)
        self.assertEqual((self.repo / "runs" / ".gitignore").read_text(), "*\n")
        self.assertNotIn("runs", git(self.repo, "status", "--porcelain"))
        # the patch applies on the commit: the run can be made again exactly
        clone = Path(self.tmp.name) / "clone"
        subprocess.run(["git", "clone", "-q", str(self.repo), str(clone)], check=True)
        git(clone, "checkout", "-q", r["commit"])
        git(clone, "apply", r["patch"])
        self.assertEqual((clone / "train.py").read_text(), "print('v2')\n")

    def test_a_clean_repo_has_no_patch_and_a_folder_outside_git_no_code(self):
        self.q.add("E14", "true", str(self.repo), gpus=0)
        plain = Path(self.tmp.name) / "plain"
        plain.mkdir()
        self.q.add("E15", "true", str(plain), gpus=0)
        self.assertTrue(self.ended("q1") and self.ended("q2"))
        a, b = self.q.find("q1"), self.q.find("q2")
        self.assertEqual((a["dirty"], "patch" in a), (False, False))
        self.assertEqual(b["out"], str(plain / "runs" / "E15" / "q2"))
        self.assertFalse(any(k in b for k in ("repo", "commit", "patch")))
        self.assertFalse((plain / "runs" / ".gitignore").exists())

    def test_a_given_outputs_root_keeps_them_by_repo_and_a_retry_keeps_it(self):
        root = Path(self.tmp.name) / "data" / "rft-runs"
        j = self.q.add("E14", "exit 1", str(self.repo / "src"), gpus=0, runs=str(root))
        self.assertEqual(j["out"], str(root / "code" / "E14" / "q1"))  # the repo's folder name, from a folder inside it too
        self.assertTrue(self.ended("q1"))
        self.assertTrue((root / "code" / "E14" / "q1").is_dir())
        self.assertFalse((root / ".gitignore").exists())  # outside the repo: nothing to keep out of git
        again = self.q.retry("q1")
        self.assertEqual(again["out"], str(root / "code" / "E14" / "q2"))
        plain = Path(self.tmp.name) / "scratch"
        plain.mkdir()
        self.assertEqual(self.q.add("E15", "true", str(plain), runs=str(root))["out"], str(root / "scratch" / "E15" / "q3"))
        with self.assertRaises(rft_queue.QueueError):
            self.q.add("E14", "true", str(self.repo), runs="relative/runs")

    def test_a_failed_run_keeps_the_end_of_its_traceback(self):
        self.q.add("E14", "python3 -c 'import sys; print(\"loading\"); raise ValueError(\"bad shape (3, 4)\")'", str(self.repo), gpus=0)
        self.q.add("E15", "echo 'warming up'; echo 'CUDA out of memory' >&2; exit 3", str(self.repo), gpus=0)
        self.assertTrue(self.ended("q1") and self.ended("q2"))
        e1, e2 = self.q.find("q1")["error"], self.q.find("q2")["error"]
        self.assertTrue(e1.startswith("Traceback (most recent call last)"))
        self.assertTrue(e1.endswith("ValueError: bad shape (3, 4)"))
        self.assertNotIn("loading", e1)
        self.assertEqual(e2.splitlines()[-1], "CUDA out of memory")
        self.assertNotIn("# rft job", e2)
        rec = json.loads((self.repo / "runs" / "E14" / "q1" / "rft-run.json").read_text())
        self.assertEqual(rec["error"], e1)

    def test_a_long_traceback_keeps_its_first_line_and_its_end(self):
        rows = ["# rft job q1 (E1) on no GPU", "noise", "Traceback (most recent call last):", *[f'  File "f{i}.py", line {i}' for i in range(40)], "KeyError: 'lr'"]
        err = rft_queue.error_of(rows).splitlines()
        self.assertEqual(len(err), rft_queue.ERROR_LINES)
        self.assertEqual((err[0], err[1], err[-1]), ("Traceback (most recent call last):", "  …", "KeyError: 'lr'"))

    def test_a_run_whose_code_moved_while_it_ran_says_so(self):
        go = Path(self.tmp.name) / "go"
        self.q.add("E14", f"while [ ! -e {go} ]; do sleep 0.05; done", str(self.repo), gpus=0)
        self.q.tick()
        self.assertTrue(wait_until(lambda: self.q.find("q1")["state"] == "running"))
        (self.repo / "train.py").write_text("print('v3')\n")
        git(self.repo, "commit", "-q", "-am", "two")
        go.touch()
        self.assertTrue(self.ended("q1"))
        self.assertTrue(self.q.find("q1")["changed"])


class NotebookAfterRunsTest(unittest.TestCase):
    """When an experiment's last run ends well and it has a notebook, the runner queues the
    notebook's run (no GPU), which records the result: no session, no model turn."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name).resolve()
        self.vault = base / "vault"
        (self.vault / "notebooks").mkdir(parents=True)
        self.work = base / "code"
        self.work.mkdir()
        self.q = rft_queue.Queue(self.vault, probe=FakeGpus(2), wake=lambda: None)
        said = json.dumps({"ok": True, "state": "ok", "recorded": True, "reproduced": "2026-11-16 ok @a1b2c3d4e5 in 1 s", "checks": []})
        self.q.notebook_cmd = lambda exp: f"echo 'marimo noise'; echo '{said}'"

    def tearDown(self):
        for j in self.q.read()["jobs"]:
            if j["state"] == "running":
                self.q.cancel(j["id"], "test over")

    def settle(self):
        return wait_until(lambda: not self.q.read()["jobs"], self.q.tick)

    def test_the_notebook_runs_once_after_the_last_run_and_keeps_how_it_went(self):
        (self.vault / "notebooks" / "E14.py").write_text("# the link")
        go = self.work / "go"
        self.q.add("E14", "true", str(self.work), gpus=1, label="seed 0")
        self.q.add("E14", f"while [ ! -e {go} ]; do sleep 0.05; done", str(self.work), gpus=1, label="seed 1")
        self.q.tick()
        self.assertTrue(wait_until(lambda: self.q.find("q1")["state"] == "done", self.q.tick))
        self.assertFalse(any(j.get("kind") == "notebook" for j in self.q.read()["jobs"]))  # seed 1 still runs
        go.touch()
        self.assertTrue(self.settle())
        nb = self.q.find("q3")
        self.assertEqual((nb["kind"], nb["exp"], nb["gpus"], nb["by"], nb["after"], nb["state"]), ("notebook", "E14", 0, "runner", "q2", "done"))
        self.assertEqual(nb["outcome"], {"state": "ok", "recorded": True, "reproduced": "2026-11-16 ok @a1b2c3d4e5 in 1 s"})
        self.assertNotIn("out", nb)
        self.assertEqual(len([j for j in self.q.history() if j.get("kind") == "notebook"]), 1)

    def test_no_notebook_after_a_failed_run_or_for_an_experiment_with_none(self):
        (self.vault / "notebooks" / "E14.py").write_text("# the link")
        self.q.add("E14", "exit 1", str(self.work), gpus=0)
        self.q.add("E15", "true", str(self.work), gpus=0)
        self.assertTrue(self.settle())
        self.assertEqual([j["id"] for j in self.q.history()], ["q2", "q1"])

    def test_a_notebook_that_failed_keeps_its_error(self):
        (self.vault / "notebooks" / "E14.py").write_text("# the link")
        said = json.dumps({"ok": False, "state": "failed", "error": "Traceback (most recent call last):\nKeyError: 'acc'"})
        self.q.notebook_cmd = lambda exp: f"printf '%s\\n' {shlex.quote(said)}"
        self.q.add("E14", "true", str(self.work), gpus=0)
        self.assertTrue(self.settle())
        nb = self.q.find("q2")
        self.assertEqual((nb["state"], nb["outcome"]["state"], nb["error"].splitlines()[-1]), ("done", "failed", "KeyError: 'acc'"))

    def test_the_command_runs_the_notebook_helper_on_the_vault(self):
        q = rft_queue.Queue(self.vault, probe=FakeGpus(1), wake=lambda: None)
        cmd = q.notebook_cmd("E14")
        self.assertIn("rft_notebook.py apply --vault", cmd)
        self.assertTrue(cmd.endswith("--exp E14 --record"))


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

    def test_the_command_line_moves_one_job_and_answers_the_new_order(self):
        """rft_move_job: example 1 (E17 before E16), to the top, to the end; the order comes back."""
        with tempfile.TemporaryDirectory() as tmp:
            run = lambda *a: subprocess.run([sys.executable, str(QUEUE), *a, "--vault", tmp, "--no-runner"],
                                            capture_output=True, text=True, timeout=30)
            self.assertEqual(run("pause").returncode, 0)
            for exp, gpus in (("E16", 2), ("E04", 1), ("E17", 1)):
                run("add", "--job", json.dumps({"exp": exp, "cmd": "true", "cwd": tmp, "gpus": gpus}))
            order = lambda out: [(w["id"], w["exp"]) for w in json.loads(out.stdout)["waiting"]]
            moved = run("move", "--id", "q3", "--before", "q1")
            self.assertEqual(moved.returncode, 0, moved.stdout + moved.stderr)
            self.assertEqual(json.loads(moved.stdout)["job"]["id"], "q3")
            self.assertEqual(order(moved), [("q3", "E17"), ("q1", "E16"), ("q2", "E04")])
            self.assertEqual(json.loads(moved.stdout)["waiting"][1]["gpus"], 2)
            self.assertEqual(order(run("move", "--id", "q2", "--before", "top")), [("q2", "E04"), ("q3", "E17"), ("q1", "E16")])
            self.assertEqual(order(run("move", "--id", "q2", "--before", "end")), [("q3", "E17"), ("q1", "E16"), ("q2", "E04")])
            self.assertEqual(order(run("move", "--id", "q1")), [("q3", "E17"), ("q2", "E04"), ("q1", "E16")])
            bad = run("move", "--id", "q3", "--before", "q9")
            self.assertEqual(bad.returncode, 2)
            self.assertIn("q9 is not a waiting job", json.loads(bad.stdout)["error"])


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
        # the address the page reads it at now (blockers refuse ones like api/queue/log); the old one stays for older pages
        self.assertEqual(self.call("GET", f"/api/queue/output?id={jid}", key=None)[0], 403)
        status, r = self.call("GET", f"/api/queue/output?id={jid}")
        self.assertEqual(status, 200)
        self.assertIn("some-output", r["text"])

    def test_the_monitor_follows_a_log_by_byte_in_bounded_pieces(self):
        go = Path(self.qdir.name) / "go"
        # a progress bar redrawn without newlines for a while: one line of more than a megabyte
        (Path(self.qdir.name) / "bar.py").write_text('import sys\nfor i in range(40000):\n    sys.stdout.write("\\rstep %6d |" % i + "#" * 20)\nprint()\n')
        cmd = f"python3 bar.py; echo after; while [ ! -e {go} ]; do sleep 0.05; done; echo last-words"
        jid = self.q.add("E16", cmd, self.qdir.name, gpus=0)["id"]
        self.q.tick()
        self.assertTrue(wait_until(lambda: "after" in self.q.log(jid, 5).splitlines(), self.q.tick))
        status, first = self.call("GET", f"/api/queue/output?id={jid}")
        self.assertEqual(status, 200)
        self.assertGreater(first["size"], 1_000_000)
        self.assertTrue(first["reset"])
        self.assertLessEqual(len(first["text"].encode()), rft_queue.TAIL_BYTES)  # the end, not the whole file
        self.assertTrue(first["text"].rstrip().endswith("after"))
        self.assertEqual((first["end"], first["state"]), (first["size"], "running"))
        # then only what came since
        go.touch()
        self.assertTrue(wait_until(lambda: self.q.find(jid)["state"] == "done", self.q.tick))
        status, more = self.call("GET", f"/api/queue/output?id={jid}&from={first['end']}")
        self.assertEqual((status, more["reset"], more["text"], more["state"]), (200, False, "last-words\n", "done"))
        status, same = self.call("GET", f"/api/queue/output?id={jid}&from={more['end']}")
        self.assertEqual((same["text"], same["end"]), ("", more["end"]))
        # what Claude reads: the bar's last state, cut short, not a megabyte
        tail = self.q.log(jid, 5)
        self.assertLess(len(tail), 2 * rft_queue.MAX_ROW)
        self.assertIn("step  39999", tail)
        # the whole log, as a file to save, with the key only
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", f"/api/queue/output?id={jid}&raw=1", headers={"Host": f"127.0.0.1:{self.port}", "X-RFT-Token": KEY})
        r = c.getresponse()
        body = r.read()
        c.close()
        self.assertEqual((r.status, r.getheader("Content-Disposition")), (200, f'attachment; filename="{jid}.log"'))
        self.assertEqual(len(body), more["size"])
        self.assertEqual(self.call("GET", f"/api/queue/output?id={jid}&raw=1", key=None)[0], 403)

    def test_a_log_that_cannot_be_read_says_why_instead_of_dropping_the_connection(self):
        jid = self.q.add("E16", "true", self.qdir.name, gpus=0)["id"]
        self.assertTrue(wait_until(lambda: self.q.find(jid)["state"] == "done", self.q.tick))
        broken = lambda *a, **k: (_ for _ in ()).throw(ValueError("odd bytes"))  # noqa: E731
        self.q.read_log = broken
        status, r = self.call("GET", f"/api/queue/output?id={jid}")
        self.assertEqual(status, 500)
        self.assertIn("ValueError: odd bytes", r["error"])


class ProgressTest(unittest.TestCase):
    """How far a running job is, from what it writes anyway: tqdm's bars, its last line, its stages."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.log = Path(self.tmp.name) / "q1.log"
        self.stages = Path(self.tmp.name) / "progress.jsonl"

    def test_one_bar_the_last_drawn_with_a_total_a_finished_one_left_out(self):
        self.log.write_text(
            "# rft job q1 (E24) on GPU 1, 2026-11-16T12:00:00+01:00, in /code\n# $ scripts/local/pose_probes_job.sh mae base\n"
            "2026-11-16 12:00:01 cache whole: output/pose_cache/x\n"
            "mlp:   2%|▏         | 1/50 [00:10<08:10, 10.0s/it]\rmlp:   4%|▍         | 2/50 [00:20<08:00, 10.0s/it]\n"
            "\x1b[A\rtrain shard 3/12:  44%|████▍     | 440/1000 [01:22<01:45, 5.33it/s]"
            "\rtrain shard 3/12:  45%|████▌     | 450/1000 [01:23<01:40, 5.40it/s, loss=0.31]"
            "\rtest shard 1/4: 100%|██████████| 10/10 [00:01<00:00, 9.9it/s]\nrows: 1200it [00:30, 40.0it/s]")
        got = rft_queue.progress_of(self.log)
        # the count bar "rows" was drawn last, but has no total: the shard bar says more
        self.assertEqual([(b["desc"], b.get("pct"), b["n"], b.get("total"), b.get("left")) for b in got["bars"]],
                         [("train shard 3/12", 45, "450", "1000", "01:40")])
        self.assertEqual(got["line"], "2026-11-16 12:00:01 cache whole: output/pose_cache/x")
        self.assertNotIn("stage", got)
        self.log.write_text("rows: 1200it [00:30, 40.0it/s]")
        self.assertEqual(rft_queue.progress_of(self.log)["bars"][0]["rate"], "40.0it/s")

    def test_a_bar_whose_label_carries_a_changing_metric_is_one_bar_and_ends_when_it_ends(self):
        draws = [f"mlp train mse {0.034 - k * 1e-4:.5f} val mse {0.035 - k * 1e-4:.5f}: {k}%|#   | {k}/100 [00:{k:02d}<00:10, 1.0it/s]" for k in (96, 97, 98)]
        self.log.write_text("\r".join(draws))
        got = rft_queue.progress_of(self.log)
        self.assertEqual([(b["desc"], b["n"]) for b in got["bars"]], [("mlp train mse 0.02420 val mse 0.02520", "98")])
        self.log.write_text("\r".join(draws + ["mlp train mse 0.03299 val mse 0.03399: 100%|####| 100/100 [01:40<00:00, 1.0it/s]", "\nloaded probe: output/probes/x"]))
        got = rft_queue.progress_of(self.log)
        self.assertNotIn("bars", got)
        self.assertEqual(got["line"], "loaded probe: output/probes/x")

    def test_no_bar_its_last_line_and_its_stage_as_json_or_text(self):
        self.log.write_text("# rft job q1 (E24)\n2026-11-16 12:00:01 waiting for GPU 1: 2048 MiB free, need 14336\n")
        self.stages.write_text('{"stage": "cache", "i": 1, "n": 5}\n{"stage": "probe patchpos", "i": 2, "n": 5, "extra": [1]}\n')
        got = rft_queue.progress_of(self.log, self.stages)
        self.assertEqual(got, {"line": "2026-11-16 12:00:01 waiting for GPU 1: 2048 MiB free, need 14336",
                               "stage": {"stage": "probe patchpos", "i": 2, "n": 5}})
        self.stages.write_text("probe 3/5: mlp\n\n")
        self.assertEqual(rft_queue.progress_of(self.log, self.stages)["stage"], {"stage": "probe 3/5: mlp"})
        self.assertEqual(rft_queue.progress_of(Path(self.tmp.name) / "none.log"), {})

    def test_a_job_gets_its_stages_file_and_slower_bars_and_its_row_says_how_far_it_is(self):
        vault, work = Path(self.tmp.name) / "vault", Path(self.tmp.name) / "work"
        vault.mkdir()
        work.mkdir()
        q = rft_queue.Queue(vault, probe=FakeGpus(1), wake=lambda: None)
        go = work / "go"
        j = q.add("E24", f'echo "$TQDM_MININTERVAL" > seen; echo \'{{"stage": "probe", "i": 2, "n": 5}}\' >> "$RFT_PROGRESS"; '
                         f'printf "mlp:  40%%|####      | 20/50 [00:10<00:15, 2.00it/s]"; while [ ! -e {go} ]; do sleep 0.05; done', str(work), gpus=0)
        q.tick()
        try:
            self.assertTrue(wait_until(lambda: (q.snapshot()["jobs"] or [{}])[0].get("progress", {}).get("bars"), q.tick))
            row = q.snapshot()["jobs"][0]
            self.assertEqual(row["progress"]["stage"], {"stage": "probe", "i": 2, "n": 5})
            self.assertEqual(row["progress"]["bars"][0]["pct"], 40)
            self.assertEqual((work / "seen").read_text().strip(), rft_queue.TQDM_MININTERVAL)
            self.assertTrue((Path(j["out"]) / rft_queue.PROGRESS).is_file())
        finally:
            go.touch()
            wait_until(lambda: q.find(j["id"])["state"] != "running", q.tick)


class ReadLogTest(unittest.TestCase):
    """rft_queue.read_log: a log in bounded pieces, by byte."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "q1.log"

    def test_a_piece_never_cuts_a_character_and_a_log_that_started_anew_is_read_from_its_end(self):
        self.path.write_bytes("loss 0.5 → 0.4\n".encode())
        whole = rft_queue.read_log(self.path, 0)
        cut = len("loss 0.5 ".encode()) + 1  # in the middle of →
        with open(self.path, "wb") as f:
            f.write("loss 0.5 → 0.4\n".encode()[:cut])
        got = rft_queue.read_log(self.path, 0)
        self.assertEqual((got["text"], got["end"]), ("loss 0.5 ", len("loss 0.5 ".encode())))
        self.path.write_bytes("loss 0.5 → 0.4\n".encode())
        rest = rft_queue.read_log(self.path, got["end"])
        self.assertEqual(rest["text"], "→ 0.4\n")
        self.assertEqual(rest["end"], whole["end"])
        self.path.write_bytes(b"new\n")  # truncated: started anew
        self.assertEqual((rft_queue.read_log(self.path, whole["end"])["text"], rft_queue.read_log(self.path, whole["end"])["reset"]), ("new\n", True))
        self.assertEqual(rft_queue.read_log(Path(self.tmp.name) / "none.log", None)["text"], "")

    def test_far_behind_it_starts_again_from_the_end(self):
        self.path.write_bytes(b"x" * 10 + b"\n" + b"line\n" * 100_000)
        got = rft_queue.read_log(self.path, 5)
        self.assertTrue(got["reset"])
        self.assertTrue(got["text"].startswith("line\n"))  # from a line's start
        self.assertLessEqual(len(got["text"]), rft_queue.TAIL_BYTES)


if __name__ == "__main__":
    unittest.main()
