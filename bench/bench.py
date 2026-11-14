#!/usr/bin/env python3
"""A fixed token benchmark of the plugin: each task run headless (claude -p) on a fresh copy of a
project with an RFT vault, once per plugin folder, and its input tokens, output tokens, cost and
turns reported side by side. The project is copied, never touched.

    python3 bench/bench.py --project ~/my-project-copy --tasks tasks.json \
        --plugin old=/tmp/rft-0.19 --plugin new=~/code/rft-plugin [--runs 2] [--out results.json]

tasks.json is a list of {"name": ..., "prompt": ...}; a prompt can be a slash command
("/rft-next"). Input tokens count every token sent: input + cache creation + cache reads.
"""

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

TOOLS = "mcp__rft__*,Read,Grep,Glob"


def run_once(project: Path, plugin: Path, prompt: str, timeout: int) -> dict:
    with tempfile.TemporaryDirectory(prefix="rft-bench-") as tmp:
        work = Path(tmp) / "project"
        shutil.copytree(project, work, symlinks=True, ignore=shutil.ignore_patterns(".git"))
        cmd = ["claude", "-p", prompt, "--plugin-dir", str(plugin), "--output-format", "json", "--allowedTools", TOOLS]
        out = subprocess.run(cmd, cwd=work, capture_output=True, text=True, timeout=timeout)
        try:
            d = json.loads(out.stdout)
        except json.JSONDecodeError:
            return {"error": (out.stderr or out.stdout)[-300:]}
        u = d.get("usage") or {}
        return {
            "tools": tools_used(work, d.get("session_id", "")),
            "input": u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0) + u.get("cache_read_input_tokens", 0),
            "output": u.get("output_tokens", 0),
            "cost": round(d.get("total_cost_usd") or 0, 4),
            "turns": d.get("num_turns", 0),
            "answer": (d.get("result") or "")[:400],
        }


def tools_used(cwd: Path, session: str) -> list[str]:
    """The tools the session called, in order, from its transcript."""
    folder = Path.home() / ".claude" / "projects" / str(cwd.resolve()).replace("/", "-").replace(".", "-")
    path = folder / f"{session}.jsonl"
    names: list[str] = []
    try:
        for line in path.read_text().splitlines():
            o = json.loads(line)
            if o.get("type") != "assistant":
                continue
            for b in (o.get("message") or {}).get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    names.append(b.get("name", "?").replace("mcp__rft__", ""))
    except (OSError, ValueError):
        pass
    return names


def mean(rows: list[dict], key: str) -> float:
    vals = [r[key] for r in rows if key in r]
    return sum(vals) / len(vals) if vals else float("nan")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--project", required=True, type=Path)
    ap.add_argument("--tasks", required=True, type=Path)
    ap.add_argument("--plugin", action="append", required=True, help="label=folder, once per plugin version")
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--timeout", type=int, default=900)
    ap.add_argument("--out", type=Path)
    a = ap.parse_args(argv)
    tasks = json.loads(a.tasks.read_text())
    plugins = [p.split("=", 1) for p in a.plugin]
    results: dict = {}
    for t in tasks:
        for label, folder in plugins:
            rows = [run_once(a.project.expanduser(), Path(folder).expanduser(), t["prompt"], a.timeout) for _ in range(a.runs)]
            results.setdefault(t["name"], {})[label] = rows
            ok = [r for r in rows if "error" not in r]
            print(f"{t['name']:<14} {label:<6} input {mean(ok, 'input'):>9.0f}  output {mean(ok, 'output'):>6.0f}  "
                  f"cost ${mean(ok, 'cost'):.3f}  turns {mean(ok, 'turns'):.1f}" + (f"  ({len(rows) - len(ok)} failed)" if len(ok) < len(rows) else ""),
                  flush=True)
    if a.out:
        a.out.write_text(json.dumps(results, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
