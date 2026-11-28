"""What a test starts and must not leave behind: its processes (a server, a headless Chromium) and its
temporary folders.

A test's own cleanup runs only when the run ends in the ordinary way. A run that is killed (a timeout, a
closed session) left its server and its browser running for days, the browser filling /dev/shm. So each
is also given to a watcher: a small process of its own that waits for this one to go, however it goes,
then stops what is still running and removes the folders.

    proc = procs.start([...])       # subprocess.Popen, in a process group of its own, watched
    procs.stop(proc)                # the whole group: asked to stop, killed if it does not
    tmp = procs.folder("rft-x-")    # tempfile.mkdtemp, watched
    procs.watch(proc)               # a process started some other way: itself only, not what it started

Start every process of a test with `start` (or `watch` it), and make every folder with `folder`.
"""
import atexit
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

GRACE = 5  # seconds the watcher leaves a process to stop when asked, before it kills it

_watcher = None
_lock = threading.Lock()


def born(pid) -> str:
    """When the process started, as the kernel counts it: with its number, what tells it from a later
    process given the same number. "" where that cannot be read (no /proc, or no such process)."""
    try:
        return Path(f"/proc/{pid}/stat").read_bytes().rsplit(b")", 1)[1].split()[19].decode()
    except (OSError, IndexError):
        return ""


def alive(pid) -> bool:
    """Whether the process is still running (one that has ended and waits to be collected is not)."""
    try:
        return Path(f"/proc/{pid}/stat").read_bytes().rsplit(b")", 1)[1].split()[0] != b"Z"
    except (OSError, IndexError):
        pass
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def group_alive(pgid) -> bool:
    """Whether any process of the group is still running."""
    if Path("/proc/self/stat").exists():
        for stat in Path("/proc").glob("[0-9]*/stat"):
            try:
                state, _, pgrp = stat.read_bytes().rsplit(b")", 1)[1].split()[:3]
            except (OSError, ValueError):
                continue
            if int(pgrp) == pgid and state != b"Z":
                return True
        return False
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _tell(*words):
    global _watcher
    with _lock:
        if _watcher is None:
            # a session of its own: what kills this process's group or closes its terminal leaves it
            _watcher = subprocess.Popen([sys.executable, str(Path(__file__).resolve())], stdin=subprocess.PIPE, text=True,
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            atexit.register(_end)
        _watcher.stdin.write("\t".join(str(w) for w in words) + "\n")
        _watcher.stdin.flush()


def _end():
    """At the ordinary end of the run: the watcher does its work now, and is waited for."""
    try:
        _watcher.stdin.close()
        _watcher.wait(GRACE + 20)
    except (OSError, subprocess.TimeoutExpired):
        pass


def start(argv, **kw) -> subprocess.Popen:
    """subprocess.Popen, the process in a group of its own (so `stop` reaches what it starts too) and watched."""
    proc = subprocess.Popen(argv, start_new_session=True, **kw)
    _tell("group", proc.pid, born(proc.pid))
    return proc


def watch(proc) -> None:
    """A process started some other way is stopped too when the run goes: itself, not what it started."""
    _tell("pid", proc.pid, born(proc.pid))


def folder(prefix) -> Path:
    """A new temporary folder, removed when the run goes, whatever the test's own cleanup did."""
    path = Path(tempfile.mkdtemp(prefix=prefix))
    _tell("folder", path)
    return path


def _signal(proc, sig):
    try:
        os.killpg(proc.pid, sig)
    except ProcessLookupError:  # no such group: ended already, or not started by `start`
        if proc.poll() is None:
            proc.send_signal(sig)


def stop(proc, wait=10) -> None:
    """Stops a process and all it started: asked first, killed when it has not gone within `wait` seconds.
    Whatever it started that is still there once it has gone is killed."""
    if proc.poll() is None:
        _signal(proc, signal.SIGTERM)
        try:
            proc.wait(wait)
        except subprocess.TimeoutExpired:
            pass
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    if proc.poll() is None:
        proc.kill()
    proc.wait(10)


def _watch():
    """The watcher: reads what it is told until the tests' process is gone (its end of the pipe closes,
    however it went), then stops the processes still running and removes the folders."""
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, signal.SIG_IGN)
    told = [line.rstrip("\n").split("\t", 2) for line in sys.stdin]
    running = [(kind, int(pid), was) for kind, pid, was in (t for t in told if t[0] in ("group", "pid") and len(t) == 3)]
    folders = [t[1] for t in told if t[0] == "folder" and len(t) > 1]

    def send(kind, pid, was, sig) -> bool:
        """Signals it; False when it is not there any more."""
        now = born(pid)
        if was and now and now != was:
            return False  # the number is another process's now
        if kind == "pid" and was and not now:
            return False
        if not (group_alive(pid) if kind == "group" else alive(pid)):
            return False
        # a group whose first process has gone: its number is not given out again while the group lasts
        try:
            (os.killpg if kind == "group" else os.kill)(pid, sig)
            return True
        except (ProcessLookupError, PermissionError):
            return False

    running = [r for r in running if send(*r, signal.SIGTERM)]
    end = time.time() + GRACE
    while running and time.time() < end:
        time.sleep(0.1)
        running = [r for r in running if send(*r, 0)]
    for r in running:
        send(*r, signal.SIGKILL)
    end = time.time() + 5
    while running and time.time() < end:
        time.sleep(0.1)
        running = [r for r in running if send(*r, 0)]
    for path in folders:
        shutil.rmtree(path, ignore_errors=True)


if __name__ == "__main__":
    _watch()
