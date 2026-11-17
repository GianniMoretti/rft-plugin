"""End to end, with no model: an experiment of the demo project (examples/demo, with the toy repo
of bench/) queued, run by the real runner, its notebook run after its last job, and its result in
the note, the vault and its concept's artifact; then made again from a fresh clone, from what the
run records say alone.

This is the check that does not depend on the plugin's own judgment: the numbers the pipeline
wrote must come back, exactly, from the recorded commit and patch in a clone where nothing of the
first run is reused, after the original repo has moved on.

Skipped without uv (the notebook runs in the toy repo's uv environment) or with RFT_SKIP_UV=1.

    python3 -m unittest tests.test_pipeline
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
sys.path.insert(0, str(ROOT / "bench"))
import lifecycle  # noqa: E402
import rft_latex  # noqa: E402
import rft_notebook  # noqa: E402
import rft_queue  # noqa: E402
import rft_results  # noqa: E402

HAS_UV = bool(shutil.which("uv")) and not os.environ.get("RFT_SKIP_UV")
HAS_TEX = bool(shutil.which("latexmk") and shutil.which("pdftotext"))

# the manuscript: a document as /rft-manuscript writes it (documentTemplate in hooks/lib/manuscript.ts),
# and a snippet that takes E08's numbers and table by name
DOCUMENT = r"""\documentclass[11pt]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{amsmath,amssymb,amsthm}
\usepackage{graphicx,booktabs}
\usepackage[numbers]{natbib}
\usepackage{rft}
\usepackage{hyperref}
\title{demo}
\begin{document}
\maketitle
\rftsnippet{S01}
\end{document}
"""
SNIPPET = r"""% rft-snippet S01 · result · A schedule with no stopping rule
% basis: E08
\paragraph{A schedule with no stopping rule}
The toy run reaches a mean accuracy of \rftnum{E08}{acc_mean} (std \rftnum{E08}{acc_std}) over \rftnum{E08}{seeds} seeds.
\begin{table}[h]\centering\caption{Accuracy by seed}\rfttable{E08}{accuracy_by_seed}\end{table}
"""
SEEDS = (0, 1, 2)

# E08's notebook as rft_set_notebook writes it: the RUNS cell (runsCell in hooks/lib/notebooks.ts),
# then the cells that read each run's output folder and set RESULTS, TABLES and FIGURES
NOTEBOOK = '''import marimo

app = marimo.App(app_title="E08 · Toy schedule-free run, seeds 0 to 2")


@app.cell(hide_code=True)
def _():
    import json as _json
    import pathlib as _pathlib
    RUNS = sorted((_r for _r in (_json.loads(_p.read_text()) for _p in _pathlib.Path("runs").glob("E08/*/rft-run.json")) if _r.get("state") == "done"), key=lambda _r: _r.get("started") or 0)
    return


@app.cell
def _():
    import json
    import pathlib
    import statistics
    m = sorted((json.loads((pathlib.Path(r["out"]) / "metrics.json").read_text()) for r in RUNS), key=lambda x: x["seed"])
    return


@app.cell
def _():
    accs = [r["acc"] for r in m]
    RESULTS = {"acc_mean": round(statistics.mean(accs), 4), "acc_std": round(statistics.stdev(accs), 4), "seeds": len(accs)}
    TABLES = {"Accuracy by seed": [{"seed": r["seed"], "accuracy": r["acc"]} for r in m]}
    FIGURES = {"Training loss": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
               + "".join(f'<circle r="1" cx="{i}" cy="{r["loss"][-1] * 10:.2f}"/>' for i, r in enumerate(m)) + "</svg>"}
    return


if __name__ == "__main__":
    app.run()
'''

PAGE = """<h1>Mix-based augmentation</h1>
<p><a href="#E05">E05</a>: CutMix closes the gap at 1k (0.3 ± 0.5 points).</p>
<h2>A schedule that needs no stopping</h2>
<p><a href="#E08">E08</a> runs the toy problem with no stopping rule.</p>
<rft-table src="E08_accuracy_by_seed"></rft-table>
<img src="../figures/E08_training_loss.svg" alt="Training loss">
<h2>The concept's experiments side by side</h2>
<rft-table src="D04_results_by_experiment"></rft-table>
<img src="../figures/D04_accuracy_by_experiment.svg" alt="Accuracy by experiment">
"""


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args],
                          check=True, capture_output=True, text=True).stdout.strip()


@unittest.skipUnless(HAS_UV, "uv is not on PATH")
class PipelineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()
        self.project = self.base / "project"
        lifecycle.base(self.project)
        lifecycle.launch(self.project)
        self.vault = self.project / "vault"
        self.toy = self.project / lifecycle.TOY
        # E08, planned under D05 with its notebook written (the rules ask for it when an experiment is planned)
        (self.vault / lifecycle.E08).write_text(lifecycle.E08_NOTE.replace("status: running", "status: planned")
                                                .replace("summary:", 'notebook: "notebooks/E08.py"\nsummary:', 1))
        nb = self.toy / "notebooks" / "E08_toy_schedule_free_run_seeds_0_to_2.py"
        nb.parent.mkdir()
        nb.write_text(NOTEBOOK)
        rft_notebook.link(f"../../{lifecycle.TOY}/notebooks/{nb.name}", self.vault / "notebooks" / "E08.py")
        # and the concept's notebook, on D04, which compares its experiments from their saved RESULTS
        cnb = self.toy / "notebooks" / "D04_mix_based_augmentation.py"
        shutil.copy(ROOT / "bench" / "toy" / "concept_notebook.py", cnb)
        rft_notebook.link(f"../../{lifecycle.TOY}/notebooks/{cnb.name}", self.vault / "notebooks" / "D04.py")
        d04 = self.vault / lifecycle.D04
        d04.write_text(d04.read_text().replace("concept_repos:", 'notebook: "notebooks/D04.py"\nconcept_repos:', 1))
        git(self.toy, "add", "-A")
        git(self.toy, "commit", "-q", "-m", "E08's notebook, D04's notebook")
        # the concept's artifact, written when E08 was planned: E08's table and figure placed by name
        (self.vault / "artifacts").mkdir()
        head = {"concept": "D04", "name": "Mix-based augmentation", "updated": "2026-11-15", "basis": {}}
        self.artifact = self.vault / "artifacts" / "D04 Mix-based augmentation.html"
        self.artifact.write_text(f"<!-- rft-artifact {json.dumps(head)} -->\n{PAGE}")
        # an uncommitted change the runs pick up: 25 epochs, not 30
        train = self.toy / "train.py"
        train.write_text(train.read_text().replace('"--epochs", type=int, default=30', '"--epochs", type=int, default=25'))

    def tearDown(self):
        q = rft_queue.Queue(self.vault, wake=lambda: None)
        for j in q.read()["jobs"]:
            if j["state"] == "running":
                q.cancel(j["id"], "test over")

    def queue_and_wait(self):
        for s in SEEDS:
            job = {"exp": "E08", "cmd": f"python3 train.py --seed {s}", "cwd": str(self.toy), "gpus": 0, "label": f"seed {s}"}
            r = subprocess.run([sys.executable, str(ROOT / "server" / "rft_queue.py"), "add", "--vault", str(self.vault), "--job", json.dumps(job)],
                               capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(r.stdout)["job"]["out"], str(self.toy / "runs" / "E08" / f"q{s + 1}"))
        end = time.time() + 300
        while time.time() < end:
            if not json.loads((self.vault / ".queue" / "queue.json").read_text())["jobs"]:
                return
            time.sleep(0.5)
        self.fail("the queue did not empty in 5 minutes")

    def test_queue_to_artifact_with_no_model_then_a_fresh_clone_makes_the_same_numbers(self):
        self.queue_and_wait()
        q = rft_queue.Queue(self.vault, wake=lambda: None)
        hist = sorted(q.history(), key=lambda j: int(j["id"][1:]))
        self.assertEqual([(j["id"], j["state"], j.get("kind", "run")) for j in hist],
                         [("q1", "done", "run"), ("q2", "done", "run"), ("q3", "done", "run"), ("q4", "done", "notebook")])
        runs, nb = hist[:3], hist[3]
        # each run's record: the commit and the uncommitted change it ran, its outputs
        commit = git(self.toy, "rev-parse", "--short=10", "HEAD")
        for j in runs:
            self.assertEqual((j["commit"], j["dirty"]), (commit, True))
            self.assertIn("default=25", Path(j["patch"]).read_text())
            self.assertEqual(json.loads((Path(j["out"]) / "rft-run.json").read_text())["state"], "done")
            self.assertTrue((Path(j["out"]) / "metrics.json").exists())
        self.assertEqual(nb["outcome"]["state"], "ok")
        self.assertTrue(nb["outcome"]["recorded"])
        # the numbers, from the runs' outputs, in the note: no one typed them
        accs = [json.loads((Path(j["out"]) / "metrics.json").read_text())["acc"] for j in runs]
        saved = json.loads((self.vault / "results" / "E08.json").read_text())
        self.assertEqual(saved["results"]["seeds"], 3)
        self.assertEqual(saved["results"]["acc_mean"], round(sum(accs) / 3, 4))
        self.assertEqual([r["id"] for r in saved["runs"]], ["q1", "q2", "q3"])
        note = (self.vault / lifecycle.E08).read_text()
        self.assertIn(f"| acc_mean | {saved['results']['acc_mean']} |", note)
        self.assertIn(f"runs q1, q2, q3 (code {commit}+patch)", note)
        self.assertIn(f'reproduced: "{time.strftime("%Y-%m-%d")} ok @{commit}', note)
        # the artifact: E08's table filled from the notebook's TABLES, its figure saved where the page names it
        page = self.artifact.read_text()
        for a in accs:
            self.assertIn(f"<td>{rft_results.number_text(a)}</td>", page)
        self.assertTrue(page.startswith("<!-- rft-artifact "))
        self.assertIn("<svg", (self.vault / "figures" / "E08_training_loss.svg").read_text())
        # and the concept's comparisons, its notebook run after E08's, at no model turn either
        self.assertEqual(saved["concepts"][0], "D04")
        self.assertIn(f"<tr><td>E08</td><td>{rft_results.number_text(saved['results']['acc_mean'])}</td>", page)
        self.assertIn("<svg", (self.vault / "figures" / "D04_accuracy_by_experiment.svg").read_text())
        self.assertIn(f'reproduced: "{time.strftime("%Y-%m-%d")} ok @{commit}', d04_text := (self.vault / lifecycle.D04).read_text())
        self.assertNotIn("rft-results", d04_text)

        # the manuscript: a snippet that names E08's numbers and table compiles, and its PDF holds
        # exactly what the run saved, the per-seed accuracies included: no one typed them
        if HAS_TEX:
            ms = self.vault / "manuscript"
            (ms / "documents" / "paper").mkdir(parents=True)
            (ms / "documents" / "paper" / "main.tex").write_text(DOCUMENT)
            (ms / "snippets").mkdir()
            (ms / "snippets" / "S01.tex").write_text(SNIPPET)
            built = rft_latex.compile_doc(self.vault, "paper")
            self.assertTrue(built["ok"], built)
            self.assertEqual(built["warnings"], [])
            pdf = subprocess.run(["pdftotext", built["pdf"], "-"], capture_output=True, text=True, check=True).stdout
            r = saved["results"]
            self.assertIn(f"mean accuracy of {rft_results.number_text(r['acc_mean'])} (std {rft_results.number_text(r['acc_std'])}) over 3 seeds", " ".join(pdf.split()))
            for a in accs:
                self.assertIn(rft_results.number_text(a), pdf)

        # the original moves on: a commit that would change every number
        train = self.toy / "train.py"
        train.write_text(train.read_text().replace("default=25", "default=3"))
        git(self.toy, "commit", "-q", "-am", "fewer epochs")

        # a fresh clone, from the run records alone: their commit, their patch, their commands
        clone = self.base / "clone"
        subprocess.run(["git", "clone", "-q", str(self.toy), str(clone)], check=True)
        git(clone, "checkout", "-q", runs[0]["commit"])
        git(clone, "apply", runs[0]["patch"])
        for j in runs:
            out = clone / "runs" / "E08" / j["id"]
            out.mkdir(parents=True)
            subprocess.run(["bash", "-c", j["cmd"]], cwd=clone / Path(j["cwd"]).relative_to(self.toy), check=True,
                           env={**os.environ, "RFT_OUT": str(out)}, capture_output=True)
            (out / "rft-run.json").write_text(json.dumps({**j, "out": str(out)}))
        again = rft_notebook.run(clone / "notebooks" / "E08_toy_schedule_free_run_seeds_0_to_2.py", 300)
        self.assertTrue(again["ok"], again.get("error"))
        self.assertEqual(again["results"], saved["results"])
        self.assertEqual(again["tables"], {"Accuracy by seed": {"columns": ["seed", "accuracy"], "rows": [[s, a] for s, a in zip(SEEDS, accs)]}})


if __name__ == "__main__":
    unittest.main()
