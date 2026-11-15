"""Experiment notebooks: follows the vault's link (vault/notebooks/E02.py) to the marimo notebook in
its repo, runs it in that repo's uv environment, and serves it in the marimo editor for the tree view.

    python3 rft_notebook.py link <target> <link>         make <link> a symlink to <target>
    python3 rft_notebook.py run <notebook or link> [--timeout S]
    python3 rft_notebook.py exec <notebook>              (inside the repo's environment: the run itself)

`link` and `run` print one line of JSON, their answer. A run is the notebook as the editor runs
it: the repo's root (the folder of its pyproject.toml) as working folder and the notebook's own
folder first on sys.path; it answers the notebook's RESULTS, the repo's commit, and the end of the
traceback when a cell fails. The editors (`Editors`) are one `marimo edit` per repo, on 127.0.0.1
with a key of their own, started when the tree view first opens a notebook of that repo and
stopped with the server. Standard library only: marimo itself runs in the repo's environment
(`uv run --with marimo`), so the repos need not list it.
"""
import argparse
import importlib.util
import json
import math
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path
from urllib.parse import quote

MARK = "RFT_NOTEBOOK "
TAIL = 15  # lines of a traceback kept
EDITOR_IDLE_MINUTES = 240  # an editor nobody has been connected to for this long stops itself


class NotebookError(Exception):
    pass


def project_root(path: Path) -> Path | None:
    """The nearest folder above `path` that holds a pyproject.toml: the uv project it runs in."""
    for d in [path.parent, *path.parent.parents]:
        if (d / "pyproject.toml").is_file():
            return d
    return None


def resolve(path: Path) -> tuple[Path, Path]:
    """The notebook a path (or the vault's link) leads to, and its uv project's root."""
    real = Path(os.path.realpath(path))
    if real.suffix != ".py":
        raise NotebookError(f"{real} is not a marimo notebook (.py)")
    if not real.is_file():
        raise NotebookError(f"no notebook at {real}" + (f" (the link {path} leads nowhere)" if Path(path).is_symlink() else ""))
    root = project_root(real)
    if root is None:
        raise NotebookError(f"no pyproject.toml above {real}: the notebook's repo is not a uv project")
    return real, root


def link(target: str, at: Path) -> None:
    """Makes `at` a symbolic link to `target`, replacing a link there but never a file."""
    at = Path(at)
    if at.exists() and not at.is_symlink():
        raise NotebookError(f"{at} is a file, not a link: move it away first")
    at.parent.mkdir(parents=True, exist_ok=True)
    tmp = at.with_name(f".{at.name}.{secrets.token_hex(4)}")
    os.symlink(target, tmp)
    os.replace(tmp, at)


def jsonable(x):
    """RESULTS as JSON can hold them: numpy scalars as numbers, tuples as lists, NaN and infinities as text."""
    if isinstance(x, bool) or x is None or isinstance(x, (int, str)):
        return x
    if isinstance(x, float):
        return x if math.isfinite(x) else str(x)
    if isinstance(x, dict):
        return {str(k): jsonable(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [jsonable(v) for v in x]
    item = getattr(x, "item", None)
    if callable(item):
        try:
            return jsonable(item())
        except Exception:
            pass
    tolist = getattr(x, "tolist", None)
    if callable(tolist):
        try:
            return jsonable(tolist())
        except Exception:
            pass
    return str(x)


def tail(text: str, lines: int = TAIL) -> str:
    return "\n".join(text.rstrip().splitlines()[-lines:])


def git_state(root: Path) -> tuple[str | None, bool | None]:
    """The repo's commit (short) and whether it has uncommitted changes; (None, None) outside git."""
    try:
        head = subprocess.run(["git", "-C", str(root), "rev-parse", "--short=10", "HEAD"], capture_output=True, text=True, timeout=10)
        if head.returncode != 0:
            return None, None
        dirty = subprocess.run(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=no"], capture_output=True, text=True, timeout=10)
        return head.stdout.strip() or None, bool(dirty.stdout.strip()) if dirty.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None, None


def stop(proc: subprocess.Popen, grace: float = 3.0) -> None:
    """Ends a process started in a group of its own, and its children."""
    for sig, wait in ((signal.SIGTERM, grace), (signal.SIGKILL, grace)):
        if proc.poll() is not None:
            return
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            return
        try:
            proc.wait(wait)
        except subprocess.TimeoutExpired:
            pass


def run(path: Path, timeout: float, uv: str = "uv") -> dict:
    """Runs the notebook in its repo's uv environment: whether it ran, its RESULTS, the commit, the error's end."""
    try:
        real, root = resolve(path)
    except NotebookError as e:
        return {"ok": False, "error": str(e)}
    out: dict = {"file": str(real)}
    out["commit"], out["dirty"] = git_state(root)
    exe = shutil.which(uv)
    if not exe:
        return {**out, "ok": False, "error": f"{uv} is not on PATH: the notebooks run in their repo's uv environment (https://docs.astral.sh/uv/)"}
    cmd = [exe, "run", "--project", str(root), "--with", "marimo", "python", str(Path(__file__).resolve()), "exec", str(real)]
    t = time.monotonic()
    with tempfile.TemporaryFile() as so, tempfile.TemporaryFile() as se:
        proc = subprocess.Popen(cmd, cwd=root, stdin=subprocess.DEVNULL, stdout=so, stderr=se, start_new_session=True)
        try:
            proc.wait(timeout)
        except subprocess.TimeoutExpired:
            stop(proc)
            return {**out, "ok": False, "seconds": round(time.monotonic() - t, 2), "error": f"timed out after {timeout:g} s: stopped"}
        out["seconds"] = round(time.monotonic() - t, 2)
        so.seek(0)
        se.seek(0)
        stdout = so.read().decode("utf-8", "replace")
        stderr = se.read().decode("utf-8", "replace")
    got = next((line[len(MARK):] for line in reversed(stdout.splitlines()) if line.startswith(MARK)), None)
    if proc.returncode == 0 and got is not None:
        try:
            out["results"] = json.loads(got).get("results")
        except ValueError:
            return {**out, "ok": False, "error": "the run's answer was not JSON"}
        return {**out, "ok": True}
    return {**out, "ok": False, "error": tail(stderr or stdout) or f"the run exited with {proc.returncode}"}


def exec_notebook(path: str) -> int:
    """The run itself, inside the repo's environment: the notebook's app run as a script, its RESULTS printed."""
    file = Path(path).resolve()
    here = str(Path(__file__).resolve().parent)
    sys.path[:] = [p for p in sys.path if p and Path(p).resolve() != Path(here)]
    sys.path.insert(0, str(file.parent))  # as the editor's kernel has it
    try:
        spec = importlib.util.spec_from_file_location("rft_notebook_under_test", file)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        app = getattr(module, "app", None)
        if app is None or not callable(getattr(app, "run", None)):
            print(f"{file} is not a marimo notebook: it defines no app", file=sys.stderr)
            return 2
        _, defs = app.run()
    except BaseException:  # noqa: BLE001 — a cell's error, whatever it is, is the answer
        traceback.print_exc()
        return 1
    results = defs.get("RESULTS") if hasattr(defs, "get") else None
    sys.stdout.flush()
    print("\n" + MARK + json.dumps({"results": jsonable(results)}, allow_nan=False), flush=True)
    return 0


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def listening(port: int) -> bool:
    try:
        socket.create_connection(("127.0.0.1", port), timeout=0.5).close()
        return True
    except OSError:
        return False


class Editors:
    """The marimo editors the tree view frames: one per repo, started on first use, stopped with `stop_all`."""

    def __init__(self, uv: str = "uv", wait: float = 120.0):
        self.uv = uv
        self.wait = wait
        self.lock = threading.Lock()
        self.running: dict[Path, tuple[subprocess.Popen, int, str]] = {}

    def open(self, path: Path) -> str:
        """The address of the notebook in its repo's editor, the editor started first if need be."""
        real, root = resolve(path)
        with self.lock:
            got = self.running.get(root)
            if got and got[0].poll() is not None:
                got = None  # it stopped (idle, or killed): start it again
            if not got:
                got = self._start(root)
                self.running[root] = got
        _, port, token = got
        rel = real.relative_to(root).as_posix()
        return f"http://127.0.0.1:{port}/?file={quote(rel)}&access_token={quote(token)}"

    def _start(self, root: Path) -> tuple[subprocess.Popen, int, str]:
        exe = shutil.which(self.uv)
        if not exe:
            raise NotebookError(f"{self.uv} is not on PATH: the notebooks run in their repo's uv environment (https://docs.astral.sh/uv/)")
        port, token = free_port(), secrets.token_urlsafe(18)
        cmd = [exe, "run", "--project", str(root), "--with", "marimo", "marimo", "edit", str(root), "--headless",
               "--host", "127.0.0.1", "--port", str(port), "--token-password-file", "-", "--skip-update-check",
               "--watch", "--timeout", str(EDITOR_IDLE_MINUTES)]
        log = tempfile.TemporaryFile()
        proc = subprocess.Popen(cmd, cwd=root, stdin=subprocess.PIPE, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            proc.stdin.write(token.encode())  # the key on stdin, not in the process list
            proc.stdin.close()
        except OSError:
            pass
        end = time.monotonic() + self.wait
        while time.monotonic() < end and proc.poll() is None and not listening(port):
            time.sleep(0.2)
        if proc.poll() is None and listening(port):
            log.close()
            return proc, port, token
        stop(proc)
        log.seek(0)
        said = tail(log.read().decode("utf-8", "replace"), 8)
        log.close()
        raise NotebookError(f"the marimo editor for {root} did not start" + (f": {said}" if said else f" within {self.wait:g} s"))

    def stop_all(self) -> None:
        with self.lock:
            procs = [p for p, _, _ in self.running.values()]
            self.running.clear()
        for p in procs:
            stop(p)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    a_link = sub.add_parser("link")
    a_link.add_argument("target")
    a_link.add_argument("at")
    a_run = sub.add_parser("run")
    a_run.add_argument("path")
    a_run.add_argument("--timeout", type=float, default=540)
    a_exec = sub.add_parser("exec")
    a_exec.add_argument("path")
    a = ap.parse_args(argv)
    if a.cmd == "exec":
        return exec_notebook(a.path)
    if a.cmd == "link":
        try:
            link(a.target, Path(a.at))
            got = {"ok": True}
        except (NotebookError, OSError) as e:
            got = {"ok": False, "error": str(e)}
    else:
        got = run(Path(a.path), max(1.0, a.timeout))
    print(json.dumps(got, allow_nan=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
