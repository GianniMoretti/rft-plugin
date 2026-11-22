#!/usr/bin/env python3
"""A fixed token benchmark of the plugin: each task run headless (claude -p) on a fresh copy of a
project with an RFT vault, once per plugin folder, and its requests, input tokens, output tokens
and cost reported side by side. The project is copied, never touched.

    python3 bench/bench.py --project ~/my-project-copy --tasks tasks.json \
        --plugin old=/tmp/rft-0.19 --plugin new=~/code/rft-plugin [--runs 5] [--model claude-opus-5-5]
        [--out results.json]

tasks.json is a list of {"name": ..., "prompt": ..., "setup"?: [argv]}; a prompt can be a slash
command ("/rft-next"). A setup runs in the fresh copy before the prompt, once per run, with {work}
(the copy), {plugin} (the plugin folder of the run) and {bench} (this folder) filled in: it brings
the project to the stage the task starts from (lifecycle.py and lifecycle.json: one experiment
from planned to recorded). Input tokens count every token sent: input + cache creation + cache reads.
Requests are the API requests of the session, one per message id of its transcript: tool calls that
share an id went out together and cost one round trip, so calls are not counted. `first` is what the
first request sent: the system prompt, the tool schemas and the plugin's rules, before any work.
"""

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

TOOLS = "mcp__rft__*,Read,Grep,Glob"


def sent(usage: dict) -> int:
    return usage.get("input_tokens", 0) + usage.get("cache_creation_input_tokens", 0) + usage.get("cache_read_input_tokens", 0)


def run_once(project: Path, plugin: Path, prompt: str, timeout: int, setup: list[str] | None = None, model: str | None = None) -> dict:
    with tempfile.TemporaryDirectory(prefix="rft-bench-") as tmp:
        work = Path(tmp) / "project"
        shutil.copytree(project, work, symlinks=True, ignore=shutil.ignore_patterns(".git"))
        if setup:
            argv = [a.format(work=work, plugin=plugin, bench=Path(__file__).resolve().parent) for a in setup]
            s = subprocess.run(argv, cwd=work, capture_output=True, text=True, timeout=timeout)
            if s.returncode != 0:
                return {"error": f"setup failed: {(s.stderr or s.stdout)[-300:]}"}
        cmd = ["claude", "-p", prompt, "--plugin-dir", str(plugin), "--output-format", "json", "--allowedTools", TOOLS]
        if model:
            cmd += ["--model", model]
        out = subprocess.run(cmd, cwd=work, capture_output=True, text=True, timeout=timeout)
        try:
            d = json.loads(out.stdout)
        except json.JSONDecodeError:
            return {"error": (out.stderr or out.stdout)[-300:]}
        u = d.get("usage") or {}
        return {
            **transcript(work, d.get("session_id", "")),
            "input": sent(u),
            "output": u.get("output_tokens", 0),
            "cost": round(d.get("total_cost_usd") or 0, 4),
            "turns": d.get("num_turns", 0),
            "answer": (d.get("result") or "")[:400],
        }


def transcript(cwd: Path, session: str) -> dict:
    """What the session's transcript says: the tools it called, in order; its API requests, one per
    message id; the tokens its first request sent; the models that answered."""
    folder = Path.home() / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(cwd.resolve()))
    path = folder / f"{session}.jsonl"
    names: list[str] = []
    ids: list[str] = []
    models: list[str] = []
    first = 0
    try:
        for line in path.read_text().splitlines():
            o = json.loads(line)
            if o.get("type") != "assistant":
                continue
            m = o.get("message") or {}
            if m.get("model") == "<synthetic>":
                continue
            if m.get("id") and m["id"] not in ids:
                if not ids:
                    first = sent(m.get("usage") or {})
                ids.append(m["id"])
                if m.get("model") and m["model"] not in models:
                    models.append(m["model"])
            for b in m.get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    names.append(b.get("name", "?").replace("mcp__rft__", ""))
    except (OSError, ValueError):
        pass
    return {"tools": names, "requests": len(ids), "first": first, "models": models}


def mean(rows: list[dict], key: str) -> float:
    vals = [r[key] for r in rows if key in r]
    return sum(vals) / len(vals) if vals else float("nan")


def spread(rows: list[dict], key: str) -> str:
    vals = [r[key] for r in rows if key in r]
    return f"{min(vals)}-{max(vals)}" if vals else "-"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--project", required=True, type=Path)
    ap.add_argument("--tasks", required=True, type=Path)
    ap.add_argument("--plugin", action="append", required=True, help="label=folder, once per plugin version")
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--model", help="the model of every run (claude -p --model), e.g. claude-opus-5-5; absent, the default one")
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--out", type=Path)
    a = ap.parse_args(argv)
    tasks = json.loads(a.tasks.read_text())
    plugins = [p.split("=", 1) for p in a.plugin]
    results: dict = {}
    for t in tasks:
        for label, folder in plugins:
            rows = [run_once(a.project.expanduser(), Path(folder).expanduser().resolve(), t["prompt"], a.timeout, t.get("setup"), a.model) for _ in range(a.runs)]
            results.setdefault(t["name"], {})[label] = rows
            ok = [r for r in rows if "error" not in r]
            models = sorted({m for r in ok for m in r["models"]})
            print(f"{t['name']:<14} {label:<6} requests {mean(ok, 'requests'):>4.1f} ({spread(ok, 'requests')})  first {mean(ok, 'first'):>6.0f}  "
                  f"input {mean(ok, 'input'):>9.0f}  output {mean(ok, 'output'):>6.0f}  cost ${mean(ok, 'cost'):.3f}  {', '.join(models)}"
                  + (f"  ({len(rows) - len(ok)} failed)" if len(ok) < len(rows) else ""),
                  flush=True)
    if a.out:
        a.out.write_text(json.dumps(results, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
