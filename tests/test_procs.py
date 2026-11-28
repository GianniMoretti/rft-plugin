"""What a test starts is not left behind (tests/procs.py), however the run ends.

Each case is a run of its own, a small program that starts a process which starts another, makes a
folder, and then: is killed outright (SIGKILL, as by a timeout), is asked to stop (SIGTERM), or ends
without cleaning up. In every case both processes are gone and the folder removed soon after. `stop`
reaches what the process started and kills one that ignores being asked. The last case is the one this
was written for: a run of the page tests' own server and headless Chromium, killed half way.

    python3 -m unittest tests.test_procs -v
"""
import json
import os
import signal
import subprocess
import sys
import time
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import procs  # noqa: E402
import test_phone  # noqa: E402

# a process that starts another and waits; DEAF also ignores being asked to stop
CHILD = "import subprocess, sys, time; p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)']); print(p.pid, flush=True); time.sleep(600)"
DEAF = "import signal; signal.signal(signal.SIGTERM, signal.SIG_IGN); " + CHILD

RUN = """
import json, subprocess, sys, time
sys.path.insert(0, %(here)r)
import procs
tmp = procs.folder("rft-procs-")
(tmp / "file").write_text("x")
child = procs.start([sys.executable, "-c", %(child)r], stdout=subprocess.PIPE, text=True)
grandchild = int(child.stdout.readline())
other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
procs.watch(other)
print(json.dumps({"tmp": str(tmp), "pids": [child.pid, grandchild, other.pid]}), flush=True)
%(then)s
"""

PAGES = """
import json, re, subprocess, sys, time
sys.path.insert(0, %(here)r)
import procs, test_phone
tmp = procs.folder("rft-procs-pages-")
test_phone.demo_vault(tmp / "vault")
server = procs.start([sys.executable, str(test_phone.ROOT / "server" / "rft_server.py"), "--vault", str(tmp / "vault"),
                      "--web", str(test_phone.ROOT / "web"), "--port", "0", "--project", "demo", "--no-watch"],
                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
url = re.search(r"RFT_SERVER_URL (\\S+)", server.stdout.readline()).group(1)
(tmp / "profile").mkdir()
b = test_phone.Browser(tmp / "profile")
b.open(url)
print(json.dumps({"tmp": str(tmp), "pids": [server.pid, b.proc.pid]}), flush=True)
time.sleep(600)
"""


def mentioning(text) -> list:
    """The processes whose command line has `text` in it: [(pid, command)]."""
    found = []
    for cmd in Path("/proc").glob("[0-9]*/cmdline"):
        try:
            line = cmd.read_bytes().replace(b"\0", b" ").decode(errors="replace")
        except OSError:
            continue
        if text in line and procs.alive(int(cmd.parent.name)):
            found.append((int(cmd.parent.name), line[:120]))
    return found


class Leftovers(unittest.TestCase):
    def run_of(self, program, **words):
        run = subprocess.Popen([sys.executable, "-c", program % {"here": str(HERE), **words}], stdout=subprocess.PIPE, text=True)
        self.addCleanup(lambda: (run.poll() is None and run.kill(), run.wait(), run.stdout.close()))
        said = json.loads(run.stdout.readline())
        for pid in said["pids"]:  # whatever this test finds, it leaves nothing itself
            self.addCleanup(lambda pid=pid: procs.alive(pid) and os.kill(pid, signal.SIGKILL))
        self.assertTrue(all(procs.alive(pid) for pid in said["pids"]), "the run did not start its processes")
        self.assertTrue(Path(said["tmp"]).is_dir())
        return run, said

    def gone(self, said, within):
        end = time.time() + within
        while time.time() < end and (any(procs.alive(pid) for pid in said["pids"]) or Path(said["tmp"]).exists()):
            time.sleep(0.1)
        self.assertEqual([pid for pid in said["pids"] if procs.alive(pid)], [], "still running")
        self.assertFalse(Path(said["tmp"]).exists(), "the folder is still there")

    def test_a_run_killed_outright_leaves_nothing(self):
        run, said = self.run_of(RUN, child=CHILD, then="time.sleep(600)")
        run.send_signal(signal.SIGKILL)
        self.gone(said, 10)

    def test_a_run_asked_to_stop_leaves_nothing(self):
        run, said = self.run_of(RUN, child=CHILD, then="time.sleep(600)")
        run.send_signal(signal.SIGTERM)
        self.gone(said, 10)

    def test_a_run_that_ends_without_cleaning_up_leaves_nothing(self):
        run, said = self.run_of(RUN, child=CHILD, then="")
        run.wait(procs.GRACE + 25)
        self.gone(said, 1)

    def test_a_process_deaf_to_being_asked_is_killed(self):
        run, said = self.run_of(RUN, child=DEAF, then="time.sleep(600)")
        run.send_signal(signal.SIGKILL)
        self.gone(said, procs.GRACE + 10)

    def test_stop_reaches_what_the_process_started_and_kills_the_deaf(self):
        child = procs.start([sys.executable, "-c", DEAF], stdout=subprocess.PIPE, text=True)
        self.addCleanup(child.stdout.close)
        grandchild = int(child.stdout.readline())
        self.addCleanup(lambda: procs.alive(grandchild) and os.kill(grandchild, signal.SIGKILL))
        began = time.time()
        procs.stop(child, wait=1)
        self.assertIsNotNone(child.poll())
        end = time.time() + 5
        while time.time() < end and procs.alive(grandchild):
            time.sleep(0.05)
        self.assertFalse(procs.alive(grandchild), "what it started is still running")
        self.assertLess(time.time() - began, 8)

    def test_another_process_given_the_same_number_is_left_alone(self):
        # the watcher is told of a process by its number and when it started: this one's number, a wrong start
        mine = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])
        self.addCleanup(lambda: (mine.kill(), mine.wait()))
        if not procs.born(mine.pid):
            self.skipTest("no /proc to tell two processes of one number apart")
        watcher = subprocess.Popen([sys.executable, str(HERE / "procs.py")], stdin=subprocess.PIPE, text=True)
        watcher.stdin.write(f"pid\t{mine.pid}\t1\ngroup\t{mine.pid}\t1\n")
        watcher.stdin.close()
        watcher.wait(procs.GRACE + 15)
        self.assertIsNone(mine.poll(), "the watcher stopped a process that was not the one it was told of")

    @unittest.skipUnless(test_phone.CHROME and test_phone.websocket, "needs Chromium (Playwright's, or RFT_CHROME) and websocket-client")
    def test_the_page_tests_server_and_browser_go_with_a_killed_run(self):
        run, said = self.run_of(PAGES)
        self.assertGreaterEqual(len(mentioning(said["tmp"])), 2)
        run.send_signal(signal.SIGKILL)
        self.gone(said, procs.GRACE + 10)
        # Chromium's own processes (renderers, the zygote) carry the profile's folder in their command line
        self.assertEqual(mentioning(said["tmp"]), [])


if __name__ == "__main__":
    unittest.main()
