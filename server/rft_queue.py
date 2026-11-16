#!/usr/bin/env python3
"""The experiment queue: jobs that run an experiment of the tree, started on this machine's GPUs
in the user's order, and the history of the ones that ended. Standard library only.

A job is a shell command, the folder it runs in and how many GPUs it takes, for one experiment
(E..). Claude queues it (rft_queue, through this file's command line); the user reorders, pauses,
cancels and retries in the tree view (api/queue, through rft_server.py). Neither runs it: a
**runner**, a process of its own apart from any session, starts each job once its GPUs are free
and records how it ended, so a run outlives the session that queued it. It stops once the queue
has been empty a while; queueing a job, opening the tree view or a new session starts it again.

- **Order**: strict. The first waiting job that needs GPUs takes them as soon as enough are free;
  nothing behind it starts first (a job that needs no GPU never waits). The user moves a job up
  to run it sooner.
- **A free GPU**: one the queue may use (all, unless the user keeps some out), no job of the queue
  on it, no compute process of anyone else's on it, and less than FREE_MIB of memory taken.
- **A job runs** as `bash -c <cmd>` in its folder, in a session of its own, with
  CUDA_VISIBLE_DEVICES set to its GPUs (numbered as nvidia-smi numbers them: CUDA_DEVICE_ORDER is
  PCI_BUS_ID), RFT_JOB, RFT_EXPERIMENT and RFT_OUT; its output goes to .queue/logs/<id>.log. A
  wrapper writes its exit code to .queue/run/<id>.exit, so how it ended is known even if the
  runner was not there to see it. A job gone with no exit code (killed, or the machine restarted)
  is lost.
- **The run record**: a job is the record of its run. When it starts, the runner adds the code it
  runs (its git repo, commit and branch; uncommitted changes to tracked files saved whole as
  code.patch in its output folder) and its output folder (RFT_OUT: <runs>/<exp>/<id>, <runs> the
  folder the job names, else `runs/` at the top of its repo, else of its folder). When it ends:
  the end of the traceback of a failed one (`error`), and `changed` when its repo's code moved
  while it ran. Each output folder holds a copy of its record (rft-run.json), so the outputs say
  what made them; history.jsonl keeps them all.
- **Files**, in the vault's .queue/ (a dot folder Obsidian leaves alone): queue.json, the jobs
  waiting and running in their order (rewritten whole, under `lock`); history.jsonl, one line per
  job that ended (appended); logs/ and run/, which its .gitignore keeps out of git.

    python3 rft_queue.py add --vault V --job '{"exp": "E14", "cmd": "...", "cwd": "/abs", "gpus": 1}' [--top]
    python3 rft_queue.py status|ensure --vault V
    python3 rft_queue.py cancel|retry --vault V --id q7
    python3 rft_queue.py move --vault V --id q7 [--before top|end|q3]   (no --before: to the end;
        answers the job and the waiting order it leaves)
    python3 rft_queue.py pause|resume --vault V
    python3 rft_queue.py log --vault V --id q7 [--lines 40]

Each prints one JSON object; an error is {"error": "..."} with exit code 2. `--no-runner` leaves
the runner as it is (tests).
"""
from __future__ import annotations

import argparse
import contextlib
import datetime
import fcntl
import hashlib
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

QUEUE_DIR = ".queue"
STATE = "queue.json"
HISTORY = "history.jsonl"
LOCK = "lock"
RUNNER_LOCK = "runner.lock"
RUNNER_LOG = "runner.log"
LOGS = "logs"
RUN = "run"
GITIGNORE = "logs/\nrun/\nlock\nrunner.lock\nrunner.log\n*.tmp\n"
FREE_MIB = 1000  # a GPU holding this much memory, with no job of the queue on it, is in use elsewhere
EVERY_S = 3.0  # how often the runner looks
IDLE_S = 60.0  # how long the queue stays empty before the runner stops
KILL_WAIT_S = 5.0  # how long a cancelled job has to stop before it is killed
EXP_RE = re.compile(r"^E\d+$")
WAITING, RUNNING = "pending", "running"
FINISHED = ("done", "failed", "cancelled")
MAX_CMD = 10_000
MAX_LABEL = 120
MAX_GPUS = 64
MAX_LOG_LINES = 500
RUNS = "runs"  # the output folders' root when a job names none, at the top of its repo (or folder)
RUN_RECORD = "rft-run.json"  # each output folder's copy of its job's record
PATCH = "code.patch"
ERROR_LINES = 14  # a failed job's error: the traceback's first line and its end
# the job's command in a shell of its own; its exit code (128 + n when a signal n ended it) lands
# in a file, written whole
WRAP = 'bash -c "$1"; c=$?; printf "%s\\n" "$c" > "$2.tmp" && mv -f "$2.tmp" "$2"'
PROC = Path("/proc/self/stat").exists()


class QueueError(Exception):
    """A request the queue refuses, said plainly."""


class NotFound(QueueError):
    """No such job."""


# ---------------------------------------------------------------- processes and GPUs

def _stat(pid: int) -> list[str] | None:
    try:
        text = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return None
    return text[text.rindex(")") + 2:].split()


def start_ticks(pid: int) -> int | None:
    """When the process started (clock ticks since boot), to tell it from a later one with its pid."""
    fields = _stat(pid) if PROC else None
    return int(fields[19]) if fields and len(fields) > 19 else None


def pid_alive(pid: int | None, ticks: int | None = None) -> bool:
    """Whether the process runs (a zombie does not), and is the one that started at `ticks`."""
    if not pid:
        return False
    if PROC:
        fields = _stat(pid)
        if not fields or fields[0] in ("Z", "X"):
            return False
        return ticks is None or len(fields) <= 19 or int(fields[19]) == ticks
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _num(v: str) -> int | None:
    try:
        return int(float(v))
    except ValueError:
        return None


def probe_gpus(run=subprocess.run) -> list[dict]:
    """This machine's NVIDIA GPUs as nvidia-smi sees them: index, name, memory (MiB), use (%),
    temperature, and the compute processes on each."""
    def ask(query: str) -> str:
        try:
            r = run(["nvidia-smi", query, "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10)
        except FileNotFoundError:
            raise QueueError("nvidia-smi not found: no NVIDIA GPU here, or its driver is not installed") from None
        except subprocess.TimeoutExpired:
            raise QueueError("nvidia-smi did not answer within 10 s") from None
        if r.returncode != 0:
            last = (r.stderr or r.stdout or "").strip().splitlines()
            raise QueueError(f"nvidia-smi failed: {last[-1] if last else f'exit {r.returncode}'}")
        return r.stdout

    gpus, by_uuid = [], {}
    for line in ask("--query-gpu=index,uuid,name,memory.used,memory.total,utilization.gpu,temperature.gpu").splitlines():
        f = [x.strip() for x in line.split(",")]
        if len(f) < 7:
            continue
        name = ", ".join(f[2:len(f) - 4])  # a name with a comma in it
        g = {"index": _num(f[0]), "uuid": f[1], "name": name, "mem_used": _num(f[-4]) or 0, "mem_total": _num(f[-3]) or 0,
             "util": _num(f[-2]), "temp": _num(f[-1]), "procs": []}
        if g["index"] is None:
            continue
        gpus.append(g)
        by_uuid[g["uuid"]] = g
    try:
        apps = ask("--query-compute-apps=gpu_uuid,pid,used_memory,process_name")
    except QueueError:
        apps = ""
    for line in apps.splitlines():
        f = [x.strip() for x in line.split(",", 3)]
        if len(f) >= 3 and f[0] in by_uuid and _num(f[1]):
            by_uuid[f[0]]["procs"].append({"pid": _num(f[1]), "mem": _num(f[2]) or 0, "name": f[3] if len(f) > 3 else ""})
    return gpus


def in_use_elsewhere(g: dict, free_mib: int = FREE_MIB) -> bool:
    return bool(g.get("procs")) or (g.get("mem_used") or 0) >= free_mib


def free_gpus(gpus: list[dict], jobs: list[dict], allowed: list[int] | None, free_mib: int = FREE_MIB) -> list[int]:
    """The GPUs a waiting job may take now, lowest first."""
    ours = {i for j in jobs if j["state"] == RUNNING for i in j.get("gpu_ids") or []}
    return sorted(g["index"] for g in gpus
                  if g["index"] not in ours and (allowed is None or g["index"] in allowed) and not in_use_elsewhere(g, free_mib))


def plan(jobs: list[dict], free: list[int]) -> list[tuple[dict, list[int]]]:
    """The waiting jobs to start now and their GPUs, in strict order: the first job that needs more
    GPUs than are free holds back every GPU job behind it. A job that needs none starts at once."""
    free, out, held = list(free), [], False
    for j in jobs:
        if j["state"] != WAITING:
            continue
        n = j["gpus"]
        if n == 0:
            out.append((j, []))
        elif not held and n <= len(free):
            out.append((j, free[:n]))
            free = free[n:]
        else:
            held = True
    return out


def _ordinal(n: int) -> str:
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def _gpu_list(ids: list[int]) -> str:
    return f"GPU{'s' if len(ids) != 1 else ''} {', '.join(map(str, ids))}"


# ---------------------------------------------------------------- the code a job runs

def _git(cwd, *args: str, binary: bool = False):
    """git's output in `cwd` (bytes when `binary`), or None when it fails or is not there."""
    try:
        r = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if r.returncode != 0:
        return None
    return r.stdout if binary else r.stdout.decode("utf-8", "replace").strip()


def repo_of(cwd) -> str | None:
    """The top of the git repo `cwd` is in, or None."""
    return _git(cwd, "rev-parse", "--show-toplevel") or None


def code_state(cwd) -> dict:
    """The code a job in `cwd` runs: its repo, commit (short, as the notebooks' stamps have it) and
    branch, and `diff`, its uncommitted changes to tracked files (binary ones too); untracked files
    are counted, not kept. {} outside git."""
    top = repo_of(cwd)
    if not top:
        return {}
    commit = _git(top, "rev-parse", "--short=10", "HEAD")
    if not commit:
        return {"repo": top}
    branch = _git(top, "rev-parse", "--abbrev-ref", "HEAD")
    diff = _git(top, "diff", "--binary", "HEAD", binary=True) or b""
    untracked = _git(top, "ls-files", "--others", "--exclude-standard") or ""
    return {"repo": top, "commit": commit, "branch": branch if branch and branch != "HEAD" else None,
            "dirty": bool(diff), "untracked": len(untracked.splitlines()), "diff": diff}


def code_sig(state: dict) -> str | None:
    """What the code was, in a few characters: changes when a commit or an uncommitted change does."""
    if not state.get("commit"):
        return None
    return hashlib.sha1(state["commit"].encode() + b"\0" + state.get("diff", b"")).hexdigest()[:12]


def _tail_lines(path: Path, lines: int) -> list[str]:
    """The last `lines` lines of a file; a progress bar's redraws (\\r) count as its last state."""
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            take = min(size, 4096)
            while True:
                f.seek(size - take)
                data = f.read(take)
                if take >= size or data.count(b"\n") > lines:
                    break
                take = min(size, take * 4)
    except FileNotFoundError:
        return []
    rows = [r.split("\r")[-1] for r in data.decode("utf-8", "replace").rstrip("\n").split("\n")]
    return rows[-lines:]


def error_of(rows: list[str]) -> str:
    """A failed job's error from the end of its output: the last Python traceback (its first line
    and its end), else its last lines that say something; the runner's own header lines left out."""
    rows = [r for r in rows if not r.startswith(("# rft job ", "# $ "))]
    at = max((i for i, r in enumerate(rows) if r.startswith("Traceback (most recent call last)")), default=None)
    if at is not None:
        # to its exception, the first line after it not indented as its frames are (a buffered
        # print can land after it)
        end = next((i for i in range(at + 1, len(rows)) if rows[i].strip() and not rows[i][:1].isspace()), len(rows) - 1)
        tb = rows[at:end + 1]
        if len(tb) > ERROR_LINES:
            tb = [tb[0], "  …", *tb[-(ERROR_LINES - 2):]]
    else:
        tb = [r for r in rows if r.strip()][-6:]
    return "\n".join(tb)[-2000:]


# ---------------------------------------------------------------- the queue

class Queue:
    """The queue of one vault. `probe`: the GPUs now (probe_gpus); `wake`: makes sure a runner
    runs (ensure_runner), called after a change that may start a job."""

    def __init__(self, vault, probe=probe_gpus, wake=None, clock=time.time):
        self.root = Path(vault)
        self.dir = self.root / QUEUE_DIR
        self.probe = probe
        self.wake = wake if wake is not None else (lambda: ensure_runner(self.root))
        self.clock = clock
        self.children: dict[str, subprocess.Popen] = {}  # the jobs this process started, reaped as they end
        self._ending: list[subprocess.Popen] = []  # ended jobs' shells still exiting, reaped at a later tick

    # ------------------------------------------------------------ files

    def _ensure_dir(self):
        (self.dir / LOGS).mkdir(parents=True, exist_ok=True)
        (self.dir / RUN).mkdir(exist_ok=True)
        ignore = self.dir / ".gitignore"
        if not ignore.exists():
            ignore.write_text(GITIGNORE)

    def read(self) -> dict:
        """The queue as it is on disk (written whole, so never half): the jobs waiting and running."""
        try:
            data = json.loads((self.dir / STATE).read_text(encoding="utf-8"))
        except FileNotFoundError:
            data = {}
        except ValueError as err:
            raise QueueError(f"{QUEUE_DIR}/{STATE} is not valid JSON ({err})") from None
        allowed = data.get("allowed")
        return {
            "version": 1,
            "seq": int(data.get("seq") or 0),
            "paused": data.get("paused") is True,
            "allowed": sorted({int(i) for i in allowed}) if isinstance(allowed, list) else None,
            "free_mib": int(data.get("free_mib") or FREE_MIB),
            "jobs": [j for j in data.get("jobs") or [] if isinstance(j, dict) and j.get("id")],
        }

    @contextlib.contextmanager
    def change(self):
        """The queue to change, under the lock; written back if it changed, the jobs that ended
        moved to the history."""
        self._ensure_dir()
        with open(self.dir / LOCK, "a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            st = self.read()
            before = json.dumps(st, sort_keys=True)
            yield st
            if json.dumps(st, sort_keys=True) != before:
                self._write(st)

    def _write(self, st: dict):
        ended = [j for j in st["jobs"] if j["state"] in FINISHED]
        if ended:
            with open(self.dir / HISTORY, "a", encoding="utf-8") as h:
                for j in ended:
                    h.write(json.dumps(j, ensure_ascii=False) + "\n")
            st["jobs"] = [j for j in st["jobs"] if j["state"] not in FINISHED]
        tmp = self.dir / f"{STATE}.{os.getpid()}.tmp"
        tmp.write_text(json.dumps(st, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        os.replace(tmp, self.dir / STATE)

    def history(self, limit: int | None = None) -> list[dict]:
        """The jobs that ended, newest first (a job written twice counts once, as last written)."""
        try:
            lines = (self.dir / HISTORY).read_text(encoding="utf-8").splitlines()
        except FileNotFoundError:
            return []
        seen, out = set(), []
        for line in reversed(lines):
            try:
                j = json.loads(line)
            except ValueError:
                continue
            if not isinstance(j, dict) or j.get("id") in seen:
                continue
            seen.add(j.get("id"))
            out.append(j)
            if limit is not None and len(out) >= limit:
                break
        return out

    def find(self, jid: str) -> dict | None:
        for j in self.read()["jobs"]:
            if j["id"] == jid:
                return j
        return next((j for j in self.history() if j["id"] == jid), None)

    # ------------------------------------------------------------ what Claude and the user change

    def add(self, exp, cmd, cwd, gpus=1, label="", by="claude", top=False, retry_of=None, runs=None, kind="run") -> dict:
        """Queues a job for experiment `exp`, last (or first, `top`); the job, with its place in line.
        `runs`: the root of its output folder (absolute), else `runs/` at the top of its repo or
        folder. `kind`: "run", or "notebook" for the run of an experiment's notebook (no output
        folder of its own)."""
        exp, cmd, label = str(exp or "").strip(), str(cmd or ""), str(label or "").strip()
        if not EXP_RE.match(exp):
            raise QueueError(f'a job runs an experiment: "{exp}" is not an experiment id like E14')
        if not cmd.strip():
            raise QueueError("the command is empty")
        if len(cmd) > MAX_CMD:
            raise QueueError(f"the command is longer than {MAX_CMD} characters: put it in a script")
        cwd = str(cwd or "")
        if not os.path.isabs(cwd) or not os.path.isdir(cwd):
            raise QueueError(f'the folder "{cwd}" to run it in does not exist (give an absolute path)')
        try:
            gpus = int(gpus)
        except (TypeError, ValueError):
            raise QueueError("gpus is a whole number") from None
        if not 0 <= gpus <= MAX_GPUS:
            raise QueueError(f"gpus is between 0 and {MAX_GPUS}")
        runs = str(runs or "")
        if runs and not os.path.isabs(runs):
            raise QueueError(f'the folder "{runs}" for its outputs is not an absolute path')
        if kind not in ("run", "notebook"):
            raise QueueError(f'a job is a run or a notebook, not "{kind}"')
        root = Path(runs) if runs else Path(repo_of(cwd) or cwd) / RUNS
        with self.change() as st:
            st["seq"] += 1
            j = {"id": f"q{st['seq']}", "exp": exp, "label": label[:MAX_LABEL], "cmd": cmd, "cwd": cwd, "gpus": gpus,
                 "by": by if by in ("claude", "user", "runner") else "claude", "state": WAITING, "added": self.clock()}
            if kind == "notebook":
                j["kind"] = "notebook"
            else:
                j["out"] = str(root / exp / j["id"])
            if retry_of:
                j["retry_of"] = retry_of
            at = next((i for i, x in enumerate(st["jobs"]) if x["state"] == WAITING), len(st["jobs"])) if top else len(st["jobs"])
            st["jobs"].insert(at, j)
            place = [x["id"] for x in st["jobs"] if x["state"] == WAITING].index(j["id"]) + 1
        self.wake()
        return {**j, "place": place}

    def move(self, jid: str, before: str | None = None) -> dict:
        """Moves a waiting job before another (`before`: its id, or "top"), or to the end (None)."""
        with self.change() as st:
            j = self._active(st, jid)
            if j["state"] != WAITING:
                raise QueueError(f"{jid} is not waiting: it is {j['state']}")
            st["jobs"].remove(j)
            waiting = [x for x in st["jobs"] if x["state"] == WAITING]
            if before in (None, "", "end"):
                st["jobs"].append(j)
            elif before == "top":
                st["jobs"].insert(st["jobs"].index(waiting[0]) if waiting else len(st["jobs"]), j)
            else:
                ref = next((x for x in waiting if x["id"] == before), None)
                if ref is None:
                    raise QueueError(f"{before} is not a waiting job")
                st["jobs"].insert(st["jobs"].index(ref), j)
        self.wake()
        return j

    def cancel(self, jid: str, why: str = "") -> dict:
        """Takes a waiting job off the queue, or stops a running one (its whole process group)."""
        with self.change() as st:
            j = self._active(st, jid)
            was = j["state"]
            j.update(state="cancelled", ended=self.clock(), reason=(why or "cancelled").strip()[:MAX_LABEL])
            ended = dict(j)
        if was == RUNNING:
            self._stop(ended)
            self._write_record(ended)
        return ended

    def retry(self, jid: str, by: str = "claude") -> dict:
        """Queues an ended job again, first in line."""
        j = next((x for x in self.history() if x["id"] == jid), None)
        if j is None:
            if any(x["id"] == jid for x in self.read()["jobs"]):
                raise QueueError(f"{jid} has not ended: only an ended job is retried")
            raise NotFound(f"no job {jid}")
        if not os.path.isdir(j["cwd"]):
            raise QueueError(f'the folder "{j["cwd"]}" it ran in is gone')
        runs = str(Path(j["out"]).parent.parent) if j.get("out") else None
        return self.add(j["exp"], j["cmd"], j["cwd"], j["gpus"], j.get("label", ""), by, top=True, retry_of=jid,
                        runs=runs, kind=j.get("kind", "run"))

    def pause(self, paused: bool) -> dict:
        with self.change() as st:
            st["paused"] = bool(paused)
        if not paused:
            self.wake()
        return {"paused": bool(paused)}

    def allow(self, indices) -> dict:
        """The GPUs the queue may use (None: all of them)."""
        if indices is not None and (not isinstance(indices, list) or not all(isinstance(i, int) and 0 <= i < 1024 for i in indices)):
            raise QueueError("allowed is a list of GPU indices, or null for all")
        with self.change() as st:
            st["allowed"] = sorted(set(indices)) if indices is not None else None
        self.wake()
        return {"allowed": st["allowed"]}

    def _active(self, st: dict, jid: str) -> dict:
        j = next((x for x in st["jobs"] if x["id"] == jid), None)
        if j is None:
            done = next((x for x in self.history() if x["id"] == jid), None)
            if done:
                raise QueueError(f"{jid} has already ended ({done['state']})")
            raise NotFound(f"no job {jid}")
        return j

    def _alive(self, j: dict) -> bool:
        """Whether anything of the job runs: its process group (a child of ours reaped first)."""
        p = self.children.get(j["id"])
        if p is not None:
            p.poll()
        pid = j.get("pid")
        if not pid:
            return False
        if pid_alive(pid, j.get("ticks")):
            return True
        try:
            os.killpg(pid, 0)  # what the job started may outlive its shell
        except (ProcessLookupError, PermissionError):
            return False
        return True

    def _stop(self, j: dict):
        """Stops a job's whole process group: SIGTERM, then SIGKILL for what is left."""
        for sig, wait in ((signal.SIGTERM, KILL_WAIT_S), (signal.SIGKILL, 2.0)):
            if not self._alive(j):
                break
            try:
                os.killpg(j["pid"], sig)
            except (ProcessLookupError, PermissionError):
                break
            end = time.time() + wait
            while time.time() < end and self._alive(j):
                time.sleep(0.05)
        self._release(j["id"])

    def _release(self, jid: str):
        """Lets go of a job that ended: its shell is reaped now, or at a later tick if still exiting."""
        p = self.children.pop(jid, None)
        if p is not None and p.poll() is None:
            self._ending.append(p)

    # ------------------------------------------------------------ the runner's work

    def gpus(self) -> tuple[list[dict], str | None]:
        """The GPUs now, and why they could not be read (never raises)."""
        try:
            return self.probe(), None
        except (QueueError, OSError, subprocess.SubprocessError) as err:
            return [], str(err)

    def tick(self) -> list[dict]:
        """Records the running jobs that ended, then starts the waiting ones that fit. The events:
        {"event": "ended" | "started", "job": {...}}."""
        events = []
        self._ending = [p for p in self._ending if p.poll() is None]
        st0 = self.read()
        needs_gpus = not st0["paused"] and any(j["state"] == WAITING and j["gpus"] for j in st0["jobs"])
        gpus, _ = self.gpus() if needs_gpus else ([], None)
        with self.change() as st:
            now = self.clock()
            for j in st["jobs"]:
                if j["state"] != RUNNING:
                    continue
                code = self._exit_code(j)
                if code is None:
                    p = self.children.get(j["id"])
                    if p is not None:
                        p.poll()  # a child of ours that ended is reaped, so it no longer counts as running
                    if pid_alive(j.get("pid"), j.get("ticks")):
                        continue
                    code = self._exit_code(j)
                if code is None:
                    j.update(state="failed", ended=now, exit=None,
                             reason="lost: the process ended without an exit code (killed, or the machine restarted)")
                else:
                    j.update(state="done" if code == 0 else "failed", exit=code, ended=self._ended_at(j, now))
                self._release(j["id"])
                self._finish(j)
                events.append({"event": "ended", "job": dict(j)})
            if not st["paused"]:
                for j, ids in plan(st["jobs"], free_gpus(gpus, st["jobs"], st["allowed"], st["free_mib"])):
                    self._launch(j, ids, now)
                    events.append({"event": "started" if j["state"] == RUNNING else "ended", "job": dict(j)})
        return events

    def _exit_path(self, j: dict) -> Path:
        return self.dir / RUN / f"{j['id']}.exit"

    def _exit_code(self, j: dict) -> int | None:
        try:
            return int(self._exit_path(j).read_text().strip())
        except (OSError, ValueError):
            return None

    def _ended_at(self, j: dict, now: float) -> float:
        # file times come from a coarser clock: a job that ends at once may seem to end before it began
        try:
            return max(self._exit_path(j).stat().st_mtime, j.get("started") or 0)
        except OSError:
            return now

    def _launch(self, j: dict, ids: list[int], now: float):
        log = self.dir / LOGS / f"{j['id']}.log"
        exit_file = self._exit_path(j)
        exit_file.unlink(missing_ok=True)
        env = dict(os.environ, CUDA_DEVICE_ORDER="PCI_BUS_ID", CUDA_VISIBLE_DEVICES=",".join(map(str, ids)),
                   RFT_JOB=j["id"], RFT_EXPERIMENT=j["exp"])
        when = datetime.datetime.fromtimestamp(now).astimezone().isoformat(timespec="seconds")
        if j.get("out"):
            try:
                self._prepare_run(j)
            except OSError as err:
                j.update(state="failed", started=now, ended=now, exit=None, gpu_ids=ids,
                         reason=f"could not start: its output folder {j['out']}: {err.strerror or err}")
                return
            env["RFT_OUT"] = j["out"]
        try:
            with open(log, "ab") as out:
                out.write(f"# rft job {j['id']} ({j['exp']}) on {_gpu_list(ids) if ids else 'no GPU'}, {when}, in {j['cwd']}\n"
                          f"# $ {j['cmd']}\n".encode())
                out.flush()
                p = subprocess.Popen(["bash", "-c", WRAP, "rft-job", j["cmd"], str(exit_file)], cwd=j["cwd"], env=env,
                                     stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT, start_new_session=True)
        except OSError as err:
            j.update(state="failed", started=now, ended=now, exit=None, gpu_ids=ids, reason=f"could not start: {err}",
                     log=f"{LOGS}/{log.name}")
            return
        self.children[j["id"]] = p
        j.update(state=RUNNING, started=now, gpu_ids=ids, pid=p.pid, ticks=start_ticks(p.pid), host=socket.gethostname(),
                 log=f"{LOGS}/{log.name}")
        self._write_record(j)

    def _prepare_run(self, j: dict):
        """A run's output folder, made, and the code it runs, recorded on the job: repo, commit,
        branch, and its uncommitted changes saved whole in the folder (code.patch). A root the
        runner makes inside a repo gets a .gitignore, so the outputs stay out of git."""
        out = Path(j["out"])
        root = out.parent.parent
        made = not root.exists()
        out.mkdir(parents=True, exist_ok=True)
        code = code_state(j["cwd"])
        if made and code.get("repo") and str(root.resolve()).startswith(str(Path(code["repo"]).resolve()) + os.sep):
            (root / ".gitignore").write_text("*\n")
        for k in ("repo", "commit", "branch", "dirty", "untracked"):
            if code.get(k) is not None:
                j[k] = code[k]
        if code.get("diff"):
            (out / PATCH).write_bytes(code["diff"])
            j["patch"] = str(out / PATCH)
        sig = code_sig(code)
        if sig:
            j["code_sig"] = sig

    def _finish(self, j: dict):
        """A run that ended: the end of its traceback when it failed, whether its repo's code moved
        while it ran, and its record written in its output folder."""
        if j["state"] == "failed" and j.get("log"):
            err = error_of(_tail_lines(self.dir / j["log"], 200))
            if err:
                j["error"] = err
        if j.get("code_sig") and j.get("started"):
            now = code_sig(code_state(j["cwd"]))
            if now and now != j["code_sig"]:
                j["changed"] = True
        self._write_record(j)

    def _write_record(self, j: dict):
        """The job's record, in its output folder (rft-run.json), so the outputs say what made them."""
        if not j.get("out") or not os.path.isdir(j["out"]):
            return
        rec = {k: v for k, v in j.items() if k not in ("pid", "ticks", "code_sig", "outlook")}
        tmp = Path(j["out"]) / f".{RUN_RECORD}.{os.getpid()}.tmp"
        with contextlib.suppress(OSError):
            tmp.write_text(json.dumps(rec, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
            os.replace(tmp, Path(j["out"]) / RUN_RECORD)

    # ------------------------------------------------------------ what the view and Claude read

    def outlook(self, j: dict, st: dict | None = None, gpus: list[dict] | None = None, err: str | None = None) -> str:
        """Why a waiting job waits, or that it starts now; in a few words."""
        if j["state"] != WAITING:
            return ""
        st = st or self.read()
        if gpus is None and err is None:
            gpus, err = self.gpus()
        waiting = [x for x in st["jobs"] if x["state"] == WAITING]
        place = next((i for i, x in enumerate(waiting) if x["id"] == j["id"]), 0) + 1
        if st["paused"]:
            return f"{_ordinal(place)} in line; the queue is paused"
        if not j["gpus"]:
            return "starts in a few seconds (no GPU)"
        if err:
            return f"{_ordinal(place)} in line; the GPUs cannot be read: {err}"
        free = free_gpus(gpus, st["jobs"], st["allowed"], st["free_mib"])
        ahead = None
        for x, ids in plan(st["jobs"], free):
            if x["id"] == j["id"]:
                return f"starts in a few seconds on {_gpu_list(ids)}"
        for x in waiting[:place - 1]:
            if x["gpus"]:
                ahead = x
        if ahead is not None:
            return f"{_ordinal(place)} in line, after {ahead['id']}"
        why = [f"needs {j['gpus']} GPU{'s' if j['gpus'] != 1 else ''}, {len(free)} free"]
        held = sorted({i for x in st["jobs"] if x["state"] == RUNNING for i in x.get("gpu_ids") or []})
        if held:
            why.append(f"{_gpu_list(held)} taken by the queue")
        kept = [g["index"] for g in gpus if st["allowed"] is not None and g["index"] not in st["allowed"]]
        if kept:
            why.append(f"{_gpu_list(kept)} {'is' if len(kept) == 1 else 'are'} kept out of the queue")
        elsewhere = [g["index"] for g in gpus if g["index"] not in held and g["index"] not in kept and in_use_elsewhere(g, st["free_mib"])]
        if elsewhere:
            why.append(f"{_gpu_list(elsewhere)} in use outside the queue")
        if not gpus:
            why.append("no GPU found")
        return f"{_ordinal(place)} in line: {'; '.join(why)}"

    def snapshot(self, history: int = 50) -> dict:
        """The queue as the tree view and rft_jobs show it: the GPUs, the jobs, the last ones that ended."""
        st = self.read()
        gpus, err = self.gpus()
        held = {i: j["id"] for j in st["jobs"] if j["state"] == RUNNING for i in j.get("gpu_ids") or []}
        for g in gpus:
            g["job"] = held.get(g["index"])
            g["busy"] = g["job"] is None and in_use_elsewhere(g, st["free_mib"])
            g["allowed"] = st["allowed"] is None or g["index"] in st["allowed"]
        jobs = [{**j, "outlook": self.outlook(j, st, gpus, err)} if j["state"] == WAITING else j for j in st["jobs"]]
        return {"host": socket.gethostname(), "paused": st["paused"], "allowed": st["allowed"], "free_mib": st["free_mib"],
                "gpus": gpus, "gpu_error": err, "jobs": jobs, "history": self.history(history),
                "runner": runner_alive(self.root), "now": self.clock()}

    def log(self, jid: str, lines: int = 40) -> str:
        """The last `lines` lines of a job's output; a progress bar's redraws (\\r) count as its last state."""
        j = self.find(jid)
        if j is None:
            raise NotFound(f"no job {jid}")
        if not j.get("log"):
            return ""
        return "\n".join(_tail_lines(self.dir / j["log"], max(1, min(int(lines), MAX_LOG_LINES))))


# ---------------------------------------------------------------- the runner

def runner_alive(vault) -> bool:
    """Whether a runner holds this vault's queue."""
    path = Path(vault) / QUEUE_DIR / RUNNER_LOCK
    try:
        f = open(path, "r")
    except OSError:
        return False
    with f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(f, fcntl.LOCK_UN)
        return False


def ensure_runner(vault, idle: float = IDLE_S, every: float = EVERY_S) -> bool:
    """Starts a runner for the vault's queue unless one runs; whether it started one. The runner
    detaches from whoever asked (a session of its own, its parent gone), so it outlives them."""
    if runner_alive(vault):
        return False
    argv = [sys.executable, str(Path(__file__).resolve()), "runner", "--vault", str(Path(vault).resolve()),
            "--idle", str(idle), "--every", str(every)]
    p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True, cwd="/")
    p.wait(timeout=30)  # it forks and returns at once; the fork runs on
    return True


def run_runner(vault, idle: float = IDLE_S, every: float = EVERY_S):
    """The runner's loop: a tick every `every` seconds until nothing has waited or run for `idle`."""
    q = Queue(vault, wake=lambda: None)
    q._ensure_dir()
    lock = open(q.dir / RUNNER_LOCK, "a+")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return  # another runner has it
    lock.seek(0)
    lock.truncate()
    lock.write(f"{os.getpid()}\n")
    lock.flush()
    quiet_since = None
    while True:
        try:
            q.tick()
            st = q.read()
            busy = any(j["state"] == RUNNING or (j["state"] == WAITING and not st["paused"]) for j in st["jobs"])
        except Exception as err:  # noqa: BLE001 - the runner keeps going; the error is kept for the user
            busy = True
            with contextlib.suppress(OSError):
                with open(q.dir / RUNNER_LOG, "a", encoding="utf-8") as f:
                    f.write(f"{datetime.datetime.now().isoformat(timespec='seconds')} {type(err).__name__}: {err}\n")
        now = time.time()
        if busy:
            quiet_since = None
        elif quiet_since is None:
            quiet_since = now
        elif now - quiet_since >= idle:
            return
        time.sleep(every)


def _detach_and_run(vault, idle, every):
    """Forks: the parent returns (ensure_runner waits for it), the child runs the queue on its own."""
    if os.fork() > 0:
        os._exit(0)
    with contextlib.suppress(OSError):
        os.setsid()
    run_runner(vault, idle, every)
    os._exit(0)


# ---------------------------------------------------------------- command line

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--vault", required=True)
    common.add_argument("--no-runner", action="store_true", help="never start a runner")
    p = sub.add_parser("add", parents=[common])
    p.add_argument("--job", required=True, help='{"exp", "cmd", "cwd", "gpus"?, "label"?, "by"?, "runs"?}')
    p.add_argument("--top", action="store_true")
    p = sub.add_parser("status", parents=[common])
    p.add_argument("--history", type=int, default=20)
    for name in ("cancel", "retry"):
        p = sub.add_parser(name, parents=[common])
        p.add_argument("--id", required=True)
        p.add_argument("--why", default="")
    p = sub.add_parser("move", parents=[common])
    p.add_argument("--id", required=True)
    p.add_argument("--before", default=None)
    sub.add_parser("pause", parents=[common])
    sub.add_parser("resume", parents=[common])
    sub.add_parser("ensure", parents=[common])
    p = sub.add_parser("log", parents=[common])
    p.add_argument("--id", required=True)
    p.add_argument("--lines", type=int, default=40)
    p = sub.add_parser("runner", parents=[common])
    p.add_argument("--idle", type=float, default=IDLE_S)
    p.add_argument("--every", type=float, default=EVERY_S)
    a = ap.parse_args(argv)

    if a.cmd == "runner":
        _detach_and_run(a.vault, a.idle, a.every)
        return 0
    q = Queue(a.vault, wake=(lambda: None) if a.no_runner else None)
    try:
        if a.cmd == "add":
            try:
                spec = json.loads(a.job)
            except ValueError:
                raise QueueError("--job is not JSON") from None
            if not isinstance(spec, dict):
                raise QueueError("--job is a JSON object")
            j = q.add(spec.get("exp"), spec.get("cmd"), spec.get("cwd"), spec.get("gpus", 1), spec.get("label", ""),
                      spec.get("by", "claude"), top=a.top or spec.get("top") is True, runs=spec.get("runs"))
            out = {"job": j, "outlook": q.outlook(q.find(j["id"]) or j)}
        elif a.cmd == "status":
            out = q.snapshot(a.history)
        elif a.cmd == "cancel":
            out = {"job": q.cancel(a.id, a.why)}
        elif a.cmd == "retry":
            j = q.retry(a.id)
            out = {"job": j, "outlook": q.outlook(q.find(j["id"]) or j)}
        elif a.cmd == "move":
            # the job, and the waiting order it leaves, so one call says all (rft_move_job)
            out = {"job": q.move(a.id, a.before),
                   "waiting": [{"id": j["id"], "exp": j["exp"], "gpus": j["gpus"]} for j in q.read()["jobs"] if j["state"] == WAITING]}
        elif a.cmd in ("pause", "resume"):
            out = q.pause(a.cmd == "pause")
        elif a.cmd == "ensure":
            st = q.read()
            busy = any(j["state"] == RUNNING or (j["state"] == WAITING and not st["paused"]) for j in st["jobs"])
            out = {"started": bool(busy and not a.no_runner and ensure_runner(a.vault)), "runner": runner_alive(a.vault)}
        else:  # log
            out = {"id": a.id, "text": q.log(a.id, a.lines)}
    except QueueError as err:
        print(json.dumps({"error": str(err)}, ensure_ascii=False))
        return 2
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
