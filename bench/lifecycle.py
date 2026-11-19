#!/usr/bin/env python3
"""The experiment lifecycle for the token benchmark: the demo project (examples/demo) with a toy
code repo, at two stages of one experiment, so `bench.py` measures what Claude spends on each.

    python3 bench/lifecycle.py base --out DIR
        the demo copied to DIR, the toy repo in DIR/code/toy, linked from the concept
        "Mix-based augmentation" (D04); its git history is made by `launch`, since bench.py
        copies a project without its .git folders
    python3 bench/lifecycle.py launch --project DIR
        the toy repo under git and this machine paired with the vault's queue: the stage where an
        experiment is planned and queued
    python3 bench/lifecycle.py record --project DIR --plugin PLUGIN
        E08 (three seeds of the toy run under D05) queued and run to its end by PLUGIN's own queue
        runner, and the concept's artifact written before it: the stage where its result is
        recorded. With a plugin whose runner runs an experiment's notebook when its jobs end, the
        notebook is there from the start (it is written when the experiment is planned), as the
        plugin's rules have it; with an older one, it is left to Claude after the result.

    python3 bench/lifecycle.py artifact --project DIR --plugin PLUGIN
        the record stage, then E08 interpreted and done: what is left is the artifact of its
        concept, written before E08 (so "E08 new"). With a plugin that has concept notebooks, the
        concept's notebook and a page placing its figure and table are there from before, as
        they would be after the artifact's first writing; with an older one, the page's table is
        typed by hand.

Each task of `lifecycle.json` names its stage as a setup, which bench.py runs in the copy.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEMO = HERE.parent / "examples" / "demo"
TOY = "code/toy"
D04 = "directions/D04 Mixup as an alternative.md"
D05 = "directions/D05 A schedule that needs no stopping.md"
E08_NAME = "E08 Toy schedule-free run, seeds 0 to 2"
E08 = f"experiments/{E08_NAME}.md"
CMD = "python3 train.py --seed {s} --out runs/E08/seed{s}"

E08_NOTE = f"""---
id: E08
type: experiment
status: running
date: 2026-11-16
parent: "[[D05 A schedule that needs no stopping]]"
children: []
up: "[[D05 A schedule that needs no stopping]]"
down: []
tags: [small-data-regularisation, experiment, schedule, toy, running]
summary: "Training with no stopping rule on a toy logistic model, three seeds"
---

# E08 · Toy schedule-free run, seeds 0 to 2

**Parent:** [[D05 A schedule that needs no stopping]]
**Status:** running · **Date:** 2026-11-16

## What
`{CMD.format(s='S')}` in the toy repo ({TOY}), seeds 0, 1 and 2; no GPU.

## Why
Checks that training with no stopping rule settles on the toy problem before the CIFAR runs of E06.

## Result

## Directions found

## Children in the tree
- none yet
"""

ARTIFACT_PAGE = """<h1>Mix-based augmentation</h1>
<p>Where the line stands: mixing images at 1k examples.</p>
<h2>Results</h2>
<table>
<caption>Gap to the 10k baseline at 1k images</caption>
<thead><tr><th>Experiment</th><th>Method</th><th>Gap (points)</th></tr></thead>
<tbody><tr><td><a href="#E05">E05</a></td><td>CutMix</td><td>0.3 ± 0.5</td></tr></tbody>
</table>
<p>Mixup does not close the gap (<a href="#E05">E05</a>). Next: a schedule that needs no stopping (D05).</p>
"""


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def base(out: Path) -> None:
    if out.exists():
        raise SystemExit(f"{out} exists")
    out.mkdir(parents=True)
    shutil.copytree(DEMO / ".rft", out / ".rft")
    shutil.copytree(DEMO / "vault", out / "vault")
    toy = out / TOY
    toy.mkdir(parents=True)
    shutil.copy(HERE / "toy" / "train.py", toy / "train.py")
    (toy / "pyproject.toml").write_text('[project]\nname = "toy"\nversion = "0.1.0"\nrequires-python = ">=3.10"\ndependencies = []\n')
    (toy / ".gitignore").write_text("runs/\n.venv/\n__pycache__/\n")
    d04 = out / "vault" / D04
    text = d04.read_text()
    d04.write_text(re.sub(r"^(concept_summary: .*)$", rf'\1\nconcept_repos: ["{TOY}"]', text, count=1, flags=re.M))


def pair(vault: Path) -> None:
    """The vault's queue on: this machine paired with it, as /rft-machine add leaves it (the runs in their repo's runs/)."""
    (vault / ".queue").mkdir(exist_ok=True)
    (vault / ".queue" / "machine.json").write_text(json.dumps({"version": 1, "host": socket.gethostname()}))


def launch(project: Path) -> None:
    pair(project / "vault")
    toy = project / TOY
    if (toy / ".git").exists():
        return
    git(toy, "init", "-q", "-b", "main")
    git(toy, "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "add", "-A")
    git(toy, "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "commit", "-q", "-m", "Toy training run")


def experiment_key(server: Path, vault: Path, nid: str) -> str:
    """E05's key as the plugin's own server computes it, so the artifact starts up to date."""
    sys.path.insert(0, str(server))
    import rft_server  # noqa: E402
    nodes = {n["id"]: n for n in rft_server.Vault(vault, "bench").tree()["nodes"]}
    path = next((vault / "experiments").glob(f"{nid} *.md"))
    return rft_server.experiment_key(nodes[nid], path.read_text())


CONCEPT_PAGE = """<h1>Mix-based augmentation</h1>
<p>Where the line stands: mixing images at 1k examples. CutMix closes the gap (<a href="#E05">E05</a>); Mixup does not.</p>
<h2>Results</h2>
<rft-table src="D04_results_by_experiment"></rft-table>
<img src="../figures/D04_accuracy_by_experiment.svg" alt="Accuracy by experiment">
<p>Next: a schedule that needs no stopping (D05).</p>
"""


def has_concept_notebooks(plugin: Path) -> bool:
    return "EXPERIMENTS" in (plugin / "server" / "rft_results.py").read_text() if (plugin / "server" / "rft_results.py").exists() else False


def record(project: Path, plugin: Path, timeout: float = 600, concept_notebook: bool = False) -> None:
    launch(project)
    vault = project / "vault"
    toy = project / TOY
    (vault / E08).write_text(E08_NOTE)
    d05 = vault / D05
    text = d05.read_text().replace('"[[E06 CutMix with cosine schedule on three datasets]]"]',
                                   f'"[[E06 CutMix with cosine schedule on three datasets]]", "[[{E08_NAME}]]"]')
    d05.write_text(text.rstrip("\n") + f"\n- [[{E08_NAME}]]\n")
    cfg = project / ".rft" / "config.json"
    c = json.loads(cfg.read_text())
    c["lastId"]["E"] = 8
    cfg.write_text(json.dumps(c, indent=2) + "\n")
    # the artifact of E08's concept, up to date before E08's result
    head = {"concept": "D04", "name": "Mix-based augmentation", "updated": "2026-11-15",
            "basis": {"E05": experiment_key(plugin / "server", vault, "E05")}}
    (vault / "artifacts").mkdir(exist_ok=True)
    page = CONCEPT_PAGE if concept_notebook else ARTIFACT_PAGE
    (vault / "artifacts" / "D04 Mix-based augmentation.html").write_text(f"<!-- rft-artifact {json.dumps(head)} -->\n{page}")
    if concept_notebook:
        # written with the concept's first artifact: its notebook, and E05's numbers as its notebook saved them
        nb = toy / "notebooks" / "D04_mix_based_augmentation.py"
        nb.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(HERE / "toy" / "concept_notebook.py", nb)
        (vault / "notebooks").mkdir(exist_ok=True)
        (vault / "notebooks" / "D04.py").symlink_to(Path("../../code/toy/notebooks") / nb.name)
        d04 = vault / D04
        d04.write_text(d04.read_text().replace("concept_repos:", 'notebook: "notebooks/D04.py"\nconcept_repos:', 1))
        (vault / "results").mkdir(exist_ok=True)
        (vault / "results" / "E05.json").write_text(json.dumps({"exp": "E05", "concepts": ["D04", "D02", "root"], "results": {"gap_1k": 0.3, "gap_1k_sd": 0.5}}))
    auto = (plugin / "server" / "rft_results.py").exists()
    if auto:
        # the notebook, written when E08 was planned
        nb = toy / "notebooks" / "E08_toy_schedule_free_run_seeds_0_to_2.py"
        nb.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(HERE / "toy" / "notebook.py", nb)
        (vault / "notebooks").mkdir(exist_ok=True)
        (vault / "notebooks" / "E08.py").symlink_to(Path("../../code/toy/notebooks") / nb.name)
        note = vault / E08
        note.write_text(note.read_text().replace("summary:", 'notebook: "notebooks/E08.py"\nsummary:', 1))
        git(toy, "add", "-A")
        git(toy, "-c", "user.name=bench", "-c", "user.email=bench@example.invalid", "commit", "-q", "-m", "E08's notebook")
    cli = plugin / "server" / "rft_queue.py"
    pair(vault)
    for s in range(3):
        job = {"exp": "E08", "cmd": CMD.format(s=s), "cwd": str(toy.resolve()), "gpus": 0, "label": f"seed {s}"}
        subprocess.run([sys.executable, str(cli), "add", "--vault", str(vault), "--job", json.dumps(job)], check=True, capture_output=True)
    end = time.time() + timeout
    while time.time() < end:
        st = json.loads((vault / ".queue" / "queue.json").read_text())
        if not st.get("jobs"):
            break
        subprocess.run([sys.executable, str(cli), "ensure", "--vault", str(vault)], capture_output=True)
        time.sleep(1)
    else:
        raise SystemExit("the queue did not empty in time")


def artifact(project: Path, plugin: Path) -> None:
    """The record stage, then E08 interpreted and set done, as Claude leaves it: only the artifact is left."""
    record(project, plugin, concept_notebook=has_concept_notebooks(plugin))
    note = project / "vault" / E08
    text = note.read_text().replace("status: running", "status: done", 1).replace("running]", "done]", 1)
    text = text.replace("**Status:** running", "**Status:** done")
    text = text.replace("\n## Directions found", "\nTraining with no stopping rule settles on the toy problem: the three seeds agree within two test points.\n\n## Directions found", 1)
    note.write_text(text)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("base").add_argument("--out", required=True, type=Path)
    sub.add_parser("launch").add_argument("--project", required=True, type=Path)
    for stage in ("record", "artifact"):
        p = sub.add_parser(stage)
        p.add_argument("--project", required=True, type=Path)
        p.add_argument("--plugin", required=True, type=Path)
    a = ap.parse_args(argv)
    if a.cmd == "base":
        base(a.out)
    elif a.cmd == "launch":
        launch(a.project)
    elif a.cmd == "record":
        record(a.project, a.plugin.expanduser().resolve())
    else:
        artifact(a.project, a.plugin.expanduser().resolve())
    return 0


if __name__ == "__main__":
    sys.exit(main())
