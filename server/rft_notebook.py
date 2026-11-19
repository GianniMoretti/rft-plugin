"""Experiment notebooks: follows the vault's link (vault/notebooks/E02.py) to the marimo notebook in
its repo, runs it in that repo's uv environment, and serves it in the marimo editor for the tree view.

    python3 rft_notebook.py link <target> <link>         make <link> a symlink to <target>
    python3 rft_notebook.py run <notebook or link> [--timeout S]
    python3 rft_notebook.py apply --vault V --exp E08 [--record] [--runs q1,q2] [--timeout S] [--date D]
        run the experiment's notebook, then take its run to the note and the vault (rft_results.py)
    python3 rft_notebook.py backfill --vault V [--only D04] [--timeout S]
        every notebook of the vault (or of one concept) run again, one after another, in check mode
        (no number written over a Result's): experiments first, then concepts; a bar and a line each
    python3 rft_notebook.py exec <notebook>              (inside the repo's environment: the run itself)

`link` and `run` print one line of JSON, their answer. A run is the notebook as the editor runs
it: the repo's root (the folder of its pyproject.toml) as working folder and the notebook's own
folder first on sys.path; it answers the notebook's RESULTS, the repo's commit, and the end of the
traceback when a cell fails; and FIGURES (each an SVG: a matplotlib figure, or SVG text) and
TABLES (each a DataFrame, a list of rows as dicts, or a dict of columns), as SVG text and as
columns and rows. The editors (`Editors`) are one `marimo edit` per repo, on 127.0.0.1
with a key of their own, started when the tree view first opens a notebook of that repo and
stopped with the server; each serves under notebook/<name>/ and the page reaches it through the
server's own port (rft_server passes those requests on), the only one a browser on another
machine, through an SSH tunnel, may reach. Standard library only: marimo itself runs in the repo's environment
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
EDITOR_PATH = "notebook"  # an editor's addresses on the server: notebook/<its name>/...


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
            said = json.loads(got)
        except ValueError:
            return {**out, "ok": False, "error": "the run's answer was not JSON"}
        out["results"] = said.get("results")
        for k in ("figures", "pdfs", "tables", "notes"):
            if said.get(k):
                out[k] = said[k]
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
    get = defs.get if hasattr(defs, "get") else (lambda _k: None)
    notes: list[str] = []
    figures = {str(k): svg for k, v in (get("FIGURES") or {}).items() if (svg := svg_of(k, v, notes)) is not None} \
        if isinstance(get("FIGURES"), dict) else {}
    tables = {str(k): t for k, v in (get("TABLES") or {}).items() if (t := table_of(k, v, notes)) is not None} \
        if isinstance(get("TABLES"), dict) else {}
    # a matplotlib figure is also kept as PDF, for the manuscript's LaTeX (an SVG given as text has none)
    pdfs = {str(k): pdf for k, v in (get("FIGURES") or {}).items() if str(k) in figures and (pdf := pdf_of(v)) is not None} \
        if isinstance(get("FIGURES"), dict) else {}
    answer = {"results": jsonable(get("RESULTS")), "figures": figures, "pdfs": pdfs, "tables": tables, "notes": notes}
    sys.stdout.flush()
    print("\n" + MARK + json.dumps(answer, allow_nan=False), flush=True)
    return 0


def svg_of(name, v, notes: list[str]) -> str | None:
    """A figure of FIGURES as SVG text: SVG text as it is, a matplotlib figure (or its axes) saved as SVG."""
    if isinstance(v, str):
        return v if "<svg" in v[:2000] else (notes.append(f"figure {name!r}: text that is not an SVG") or None)
    fig = v if callable(getattr(v, "savefig", None)) else getattr(v, "figure", None)
    if fig is not None and callable(getattr(fig, "savefig", None)):
        import io
        buf = io.StringIO()
        try:
            fig.savefig(buf, format="svg", bbox_inches="tight")
        except Exception as e:  # noqa: BLE001 - said, not raised: the numbers still count
            notes.append(f"figure {name!r}: not saved ({type(e).__name__}: {e})")
            return None
        return buf.getvalue()
    notes.append(f"figure {name!r}: a {type(v).__name__}, not a matplotlib figure or SVG text")
    return None


def pdf_of(v) -> str | None:
    """A matplotlib figure (or its axes) saved as PDF, base64; None for anything else, or when it cannot be saved."""
    if isinstance(v, str):
        return None
    fig = v if callable(getattr(v, "savefig", None)) else getattr(v, "figure", None)
    if fig is None or not callable(getattr(fig, "savefig", None)):
        return None
    import base64
    import io
    buf = io.BytesIO()
    try:
        fig.savefig(buf, format="pdf", bbox_inches="tight")
    except Exception:  # noqa: BLE001 - the SVG is the figure; the PDF only follows it
        return None
    return base64.b64encode(buf.getvalue()).decode("ascii")


def table_of(name, v, notes: list[str]) -> dict | None:
    """A table of TABLES as {"columns", "rows"}: a DataFrame (its index too when it is not 0..n-1), a
    list of rows as dicts, a dict of columns, or a list of lists whose first row names the columns."""
    if callable(getattr(v, "to_dict", None)) and hasattr(v, "columns"):
        try:
            d = v.to_dict(orient="split")
        except Exception as e:  # noqa: BLE001
            notes.append(f"table {name!r}: not read ({type(e).__name__}: {e})")
            return None
        cols, rows, index = [str(c) for c in d.get("columns", [])], d.get("data", []), d.get("index", [])
        if list(index) != list(range(len(rows))):
            label = getattr(getattr(v, "index", None), "name", None)
            cols, rows = [str(label or "")] + cols, [[i, *r] for i, r in zip(index, rows)]
        return {"columns": cols, "rows": jsonable(rows)}
    if isinstance(v, list) and v and all(isinstance(r, dict) for r in v):
        cols = list(dict.fromkeys(str(k) for r in v for k in r))
        return {"columns": cols, "rows": jsonable([[r.get(c) for c in cols] for r in v])}
    if isinstance(v, dict) and v and all(isinstance(c, (list, tuple)) for c in v.values()):
        cols = [str(k) for k in v]
        n = max(len(c) for c in v.values())
        return {"columns": cols, "rows": jsonable([[c[i] if i < len(c) else None for c in v.values()] for i in range(n)])}
    if isinstance(v, list) and len(v) > 1 and all(isinstance(r, (list, tuple)) for r in v):
        return {"columns": [str(c) for c in v[0]], "rows": jsonable([list(r) for r in v[1:]])}
    notes.append(f"table {name!r}: a {type(v).__name__}, not a DataFrame, rows as dicts or columns")
    return None


def apply_run(vault: Path, exp: str, timeout: float, record: bool = False, runs: list[str] | None = None,
              date: str | None = None, uv: str = "uv", chain: bool = True) -> dict:
    """Runs an experiment's notebook (the note's `notebook:`, a link in the vault) and takes the run
    to its note and the vault (rft_results.apply): checked, recorded, saved, stamped."""
    import rft_results  # beside this file; not needed by the run itself (exec), so not loaded there
    vault = Path(vault)
    path = rft_results.note_path(vault, exp)
    if path is None:
        return {"ok": False, "state": "failed", "error": f"no note {exp} in the vault"}
    rel = rft_results.field(path.read_text(encoding="utf-8"), "notebook")
    if not rel:
        return {"ok": False, "state": "failed", "error": f"{exp} has no notebook (notebook: in its note)"}
    date = date or time.strftime("%Y-%m-%d")
    if rft_results.field(path.read_text(encoding="utf-8"), "type") != "experiment":
        # a concept's notebook, on the note that starts it: its comparisons, for its artifact
        return rft_results.apply_concept(vault, exp, run(vault / rel, timeout, uv), date)
    got = rft_results.apply(vault, exp, run(vault / rel, timeout, uv), date, record=record, runs=runs)
    if chain and got.get("state") == "ok" and got.get("saved"):
        # the experiment's numbers are new or confirmed: the notebooks of its concepts run again
        got["concepts"] = []
        for cid in rft_results.concept_notebooks(vault, exp):
            crel = rft_results.field(rft_results.note_path(vault, cid).read_text(encoding="utf-8"), "notebook")
            c = rft_results.apply_concept(vault, cid, run(vault / crel, timeout, uv), date)
            got["concepts"].append({k: c[k] for k in ("state", "saved", "error", "seconds") if k in c} | {"id": cid})
    return got


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
    """The marimo editors the tree view frames: one per repo, started on first use, stopped with
    `stop_all`. Each serves under /notebook/<name>/ (a name of its own, new at each start), which
    the server passes on to its port (`port_of`)."""

    def __init__(self, uv: str = "uv", wait: float = 120.0):
        self.uv = uv
        self.wait = wait
        self.lock = threading.Lock()
        self.running: dict[Path, tuple[subprocess.Popen, int, str, str]] = {}  # repo → process, port, key, name

    def open(self, path: Path) -> str:
        """The address of the notebook in its repo's editor, relative to the server's own (the page's),
        the editor started first if need be: a new one, at a new address, when the last one stopped."""
        real, root = resolve(path)
        with self.lock:
            got = self.running.get(root)
            if got and got[0].poll() is not None:
                got = None  # it stopped (idle, or killed): start it again
            if not got:
                got = self._start(root)
                self.running[root] = got
        _, _, token, name = got
        rel = real.relative_to(root).as_posix()
        return f"{EDITOR_PATH}/{name}/?file={quote(rel)}&access_token={quote(token)}"

    def port_of(self, name: str) -> int | None:
        """The port of the running editor called `name`; None when there is none (it stopped)."""
        with self.lock:
            for proc, port, _, n in self.running.values():
                if n == name and proc.poll() is None:
                    return port
        return None

    def _start(self, root: Path) -> tuple[subprocess.Popen, int, str, str]:
        exe = shutil.which(self.uv)
        if not exe:
            raise NotebookError(f"{self.uv} is not on PATH: the notebooks run in their repo's uv environment (https://docs.astral.sh/uv/)")
        port, token, name = free_port(), secrets.token_urlsafe(18), secrets.token_hex(8)
        cmd = [exe, "run", "--project", str(root), "--with", "marimo", "marimo", "edit", str(root), "--headless",
               "--host", "127.0.0.1", "--port", str(port), "--token-password-file", "-", "--skip-update-check",
               "--watch", "--timeout", str(EDITOR_IDLE_MINUTES), "--base-url", f"/{EDITOR_PATH}/{name}"]
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
            return proc, port, token, name
        stop(proc)
        log.seek(0)
        said = tail(log.read().decode("utf-8", "replace"), 8)
        log.close()
        raise NotebookError(f"the marimo editor for {root} did not start" + (f": {said}" if said else f" within {self.wait:g} s"))

    def stop_all(self) -> None:
        with self.lock:
            procs = [p for p, _, _, _ in self.running.values()]
            self.running.clear()
        for p in procs:
            stop(p)


def _clock(s: float) -> str:
    s = int(s)
    return f"{s // 3600}:{s // 60 % 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60:02d}:{s % 60:02d}"


def backfill(vault: Path, timeout: float, only: str | None = None, out=print) -> dict:
    """Every notebook of the vault run again, one after another, in check mode: each experiment's
    (its numbers checked against its Result, never written over them; saved with its figures,
    tables and concepts), then each concept's (its comparisons, its artifact's tables). `only`: a
    concept, its sub-concepts included. A bar as tqdm draws it, for the queue's monitor, and a
    line per notebook; the answer counts them, and names the ones that differ or failed."""
    import rft_results
    vault = Path(vault)
    nodes, concepts = rft_results._concepts(vault)

    def inside(cid: str | None) -> bool:
        seen = set()
        while cid and cid not in seen:
            if cid == only:
                return True
            seen.add(cid)
            cid = (concepts.get(cid) or {}).get("parent")
        return False
    starts = {c.get("root"): c["id"] for c in concepts.values() if c.get("root")}
    exps = sorted((n["id"] for n in nodes.values() if n["type"] == "experiment" and n.get("notebook") and (not only or inside(n.get("concept")))),
                  key=lambda i: int(i[1:]))
    cons = sorted((s for s, cid in starts.items() if (nodes.get(s) or {}).get("notebook") and (not only or inside(cid))),
                  key=lambda i: (-(concepts[starts[i]].get("depth") or 0), i))
    todo = exps + cons
    tally: dict[str, list[str]] = {"ok": [], "recorded": [], "differs": [], "failed": [], "unchecked": []}
    t0 = time.monotonic()
    for i, nid in enumerate(todo):
        done = time.monotonic() - t0
        left = done / i * (len(todo) - i) if i else 0
        pct = int(100 * i / len(todo))
        out(f"notebooks: {pct:3d}%|{'#' * (pct // 10):<10}| {i}/{len(todo)} [{_clock(done)}<{_clock(left) if i else '?'}, {nid}]", flush=True)
        try:
            got = apply_run(vault, nid, timeout, chain=False)
        except Exception as e:  # noqa: BLE001 - one notebook's trouble is its own line, the rest go on
            got = {"state": "failed", "error": f"{type(e).__name__}: {e}"}
        state = "recorded" if got.get("recorded") else got.get("state") or "failed"
        tally.setdefault(state, []).append(nid)
        why = ""
        if state == "differs":
            why = ": " + ", ".join(f"{c['key']} {c['value']}" for c in got.get("checks") or [] if not c.get("found"))[:200]
        elif state == "failed":
            last = str(got.get("error") or "").strip().splitlines()
            why = f": {last[-1][:200]}" if last else ""
        out(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {nid}: {state}{why}", flush=True)
    out(f"notebooks: 100%|##########| {len(todo)}/{len(todo)} [{_clock(time.monotonic() - t0)}<00:00, done]", flush=True)
    parts = [f"{len(tally[k])} {k}" for k in ("ok", "recorded", "differs", "failed", "unchecked") if tally.get(k)]
    named = "; ".join(f"{k}: {', '.join(tally[k])}" for k in ("differs", "failed") if tally.get(k))
    summary = f"rerun of {len(todo)} notebook{'s' if len(todo) != 1 else ''}: {', '.join(parts) or 'none'}" + (f" ({named})" if named else "")
    return {"ok": True, "state": "failed" if tally.get("failed") else "ok", "summary": summary, "tally": tally}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    a_link = sub.add_parser("link")
    a_link.add_argument("target")
    a_link.add_argument("at")
    a_run = sub.add_parser("run")
    a_run.add_argument("path")
    a_run.add_argument("--timeout", type=float, default=540)
    a_apply = sub.add_parser("apply")
    a_apply.add_argument("--vault", required=True)
    a_apply.add_argument("--exp", required=True)
    a_apply.add_argument("--record", action="store_true")
    a_apply.add_argument("--runs", default="")
    a_apply.add_argument("--timeout", type=float, default=540)
    a_apply.add_argument("--date", default=None)
    a_back = sub.add_parser("backfill")
    a_back.add_argument("--vault", required=True)
    a_back.add_argument("--only", default=None)
    a_back.add_argument("--timeout", type=float, default=540)
    a_exec = sub.add_parser("exec")
    a_exec.add_argument("path")
    a = ap.parse_args(argv)
    if a.cmd == "exec":
        return exec_notebook(a.path)
    if a.cmd == "backfill":
        got = backfill(Path(a.vault), max(1.0, a.timeout), a.only or None)
        print(json.dumps(got, allow_nan=False), flush=True)
        return 0
    if a.cmd == "apply":
        try:
            got = apply_run(Path(a.vault), a.exp, max(1.0, a.timeout), a.record, [r for r in a.runs.split(",") if r] or None, a.date)
        except OSError as e:
            got = {"ok": False, "state": "failed", "error": f"{type(e).__name__}: {e}"}
        print(json.dumps(got, allow_nan=False), flush=True)
        return 0
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
