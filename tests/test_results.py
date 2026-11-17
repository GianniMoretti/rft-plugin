"""Tests of what a notebook's run leaves in the vault (server/rft_results.py): RESULTS checked
against the note's Result, or written into it as a table, never over numbers Claude wrote unless
asked; the numbers, figures and tables saved for the artifacts only when they are the note's; an
artifact's <rft-table> filled again; the run stamped. And server/rft_notebook.py's part: FIGURES
and TABLES out of a real run (marimo in a throwaway uv project; skipped without uv).

    python3 -m unittest discover -s tests -p "test_*.py"
"""
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import rft_notebook  # noqa: E402
import rft_queue  # noqa: E402
import rft_results  # noqa: E402

HAS_UV = bool(shutil.which("uv")) and not os.environ.get("RFT_SKIP_UV")
NAME = "E02 Variant run"


def note(result: str, extra: str = "") -> str:
    return f"""---
id: E02
type: experiment
status: running
parent: "[[D01 A better variant]]"
children: []
notebook: "notebooks/E02.py"{extra}
tags: [demo, experiment, running]
---

# E02 · Variant run

## What
Three seeds.

## Result
{result}
## Directions found

## Children in the tree
"""


def outcome(**kw):
    base = {"ok": True, "seconds": 6.14, "commit": "a1b2c3d4e5", "dirty": False, "file": "/code/sfree/notebooks/E02_variant_run.py",
            "results": {"gap_1k": 4.1, "gap_10k": 0.8, "seeds": 3},
            "figures": {"Gap by size": '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'},
            "tables": {"Gap by size": {"columns": ["size", "gap"], "rows": [[1000, 4.1], [10000, 0.8]]}}}
    base.update(kw)
    return base


class CheckTest(unittest.TestCase):
    """As checkResults in hooks/lib/notebooks.ts had it: the same numbers read the same way."""

    def test_a_number_matches_one_in_the_text_at_the_precision_the_text_gives(self):
        checks, _ = rft_results.check({"a": 4.1234, "b": 0.31, "c": -2.5, "d": 41.2, "e": 5}, "Gap 4.1 ± 0.3; loss −2.5; 41.2% at 5 seeds.")
        self.assertEqual([(c["key"], c["found"]) for c in checks], [("a", True), ("b", True), ("c", True), ("d", True), ("e", True)])
        self.assertFalse(rft_results.check({"a": 4.16}, "Gap 4.1")[0][0]["found"])
        self.assertTrue(rft_results.check({"n": 12500}, "12,500 images")[0][0]["found"])
        self.assertFalse(rft_results.check({"n": 3}, "E03 and resnet3")[0][0]["found"])  # a number inside a word is not one

    def test_nested_values_by_their_path_lists_by_index_and_what_is_not_a_number_apart(self):
        checks, skipped = rft_results.check({"gap": {"1k": 4.1, "sizes": [1000, 10000]}, "model": "resnet18", "ok": True}, "at 1000 and 10000 images: 4.1")
        self.assertEqual([(c["key"], c["found"]) for c in checks], [("gap.1k", True), ("gap.sizes[0]", True), ("gap.sizes[1]", True)])
        self.assertEqual(skipped, ["model", "ok"])
        self.assertEqual(rft_results.check(3.5, "is 3.5")[0], [{"key": "RESULTS", "value": 3.5, "found": True}])


class ApplyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.vault = Path(self.tmp.name) / "vault"
        (self.vault / "experiments").mkdir(parents=True)
        self.path = self.vault / "experiments" / f"{NAME}.md"

    def write(self, result: str, extra: str = ""):
        self.path.write_text(note(result, extra))

    def text(self):
        return self.path.read_text()

    def test_an_empty_result_gets_the_table_and_the_run_is_saved_and_stamped(self):
        self.write("")
        got = rft_results.apply(self.vault, "E02", outcome(), "2026-11-16")
        self.assertEqual((got["state"], got["recorded"]), ("ok", True))
        t = self.text()
        result = rft_results.result_of(t)
        self.assertTrue(result.startswith(rft_results.BLOCK_BEGIN))
        self.assertIn("| gap_1k | 4.1 |\n| gap_10k | 0.8 |\n| seeds | 3 |", result)
        self.assertIn("*From `/code/sfree/notebooks/E02_variant_run.py` at a1b2c3d4e5, 2026-11-16.*", result)
        self.assertTrue(result.endswith(rft_results.BLOCK_END))
        self.assertIn('reproduced: "2026-11-16 ok @a1b2c3d4e5 in 6.1 s"', t)
        self.assertLess(t.index("notebook:"), t.index("reproduced:"))
        # the numbers, the figure and the table, kept for the artifacts
        saved = json.loads((self.vault / "results" / "E02.json").read_text())
        self.assertEqual((saved["results"], saved["commit"], saved["figures"]), (outcome()["results"], "a1b2c3d4e5", ["figures/E02_gap_by_size.svg"]))
        self.assertIn("<svg", (self.vault / "figures" / "E02_gap_by_size.svg").read_text())
        table = (self.vault / "tables" / "E02_gap_by_size.html").read_text()
        self.assertIn("<caption>Gap by size</caption>", table)
        self.assertIn("<tr><td>1000</td><td>4.1</td></tr>", table)
        # and as LaTeX, for the manuscript's \\rfttable; no PDF for a figure given as SVG text
        self.assertIn("1000 & 4.1 \\\\", (self.vault / "tables" / "E02_gap_by_size.tex").read_text())
        self.assertFalse((self.vault / "figures" / "E02_gap_by_size.pdf").exists())
        self.assertEqual(got["saved"]["tables"], ["E02_gap_by_size"])
        # what each figure is called and each table holds, for rft_artifact to say without opening the files
        self.assertEqual(saved["captions"], {"figures/E02_gap_by_size.svg": "Gap by size"})
        self.assertEqual(saved["contents"]["E02_gap_by_size"], {"caption": "Gap by size", "columns": ["size", "gap"], "rows": [[1000, 4.1], [10000, 0.8]], "more_rows": 0})
        # the rest of the note as it was
        self.assertIn("## What\nThree seeds.\n", t)
        self.assertIn("\n## Directions found\n", t)

    def test_a_matplotlib_figure_is_kept_as_pdf_too(self):
        self.write("")
        pdf = base64.b64encode(b"%PDF-1.4 figure").decode()
        rft_results.apply(self.vault, "E02", outcome(pdfs={"Gap by size": pdf}), "2026-11-16")
        self.assertEqual((self.vault / "figures" / "E02_gap_by_size.pdf").read_bytes(), b"%PDF-1.4 figure")
        # a later run that gives it as SVG text only: the old PDF goes, it would no longer match
        rft_results.apply(self.vault, "E02", outcome(), "2026-11-17", record=True)
        self.assertFalse((self.vault / "figures" / "E02_gap_by_size.pdf").exists())
        # what is not a PDF is not kept
        rft_results.apply(self.vault, "E02", outcome(pdfs={"Gap by size": base64.b64encode(b"<html>").decode()}), "2026-11-17", record=True)
        self.assertFalse((self.vault / "figures" / "E02_gap_by_size.pdf").exists())

    def test_prose_with_no_number_is_kept_under_the_table(self):
        self.write("Running on GPU one.\n")
        got = rft_results.apply(self.vault, "E02", outcome(), "2026-11-16")
        self.assertTrue(got["recorded"])
        self.assertTrue(rft_results.result_of(self.text()).endswith(f"{rft_results.BLOCK_END}\n\nRunning on GPU one."))

    def test_numbers_claude_wrote_are_checked_not_overwritten(self):
        self.write("Gap 4.1 at 1k and 0.8 at 10k, over 3 seeds.\n")
        got = rft_results.apply(self.vault, "E02", outcome(), "2026-11-16")
        self.assertEqual((got["state"], got["recorded"]), ("ok", False))
        self.assertNotIn(rft_results.BLOCK_BEGIN, self.text())
        self.assertTrue((self.vault / "results" / "E02.json").exists())
        self.write("Gap 4.6 at 1k and 0.8 at 10k, over 3 seeds.\n")
        got = rft_results.apply(self.vault, "E02", outcome(), "2026-11-17")
        self.assertEqual(got["state"], "differs")
        self.assertEqual([c["key"] for c in got["checks"] if not c["found"]], ["gap_1k"])
        self.assertNotIn("saved", got)  # what the vault shows stays what the note says
        self.assertIn('reproduced: "2026-11-17 differs @a1b2c3d4e5 in 6.1 s"', self.text())
        # asked to record: the table goes above Claude's text, which stays
        got = rft_results.apply(self.vault, "E02", outcome(), "2026-11-17", record=True)
        self.assertEqual((got["state"], got["recorded"]), ("ok", True))
        self.assertIn("Gap 4.6 at 1k", self.text())
        self.assertIn("| gap_1k | 4.1 |", self.text())

    def test_a_table_is_rewritten_in_place_and_checked_when_not_asked_to_record(self):
        self.write("")
        rft_results.apply(self.vault, "E02", outcome(), "2026-11-16")
        once = self.text()
        self.assertEqual(rft_results.apply(self.vault, "E02", outcome(), "2026-11-16")["state"], "ok")
        self.assertEqual(self.text(), once)
        got = rft_results.apply(self.vault, "E02", outcome(results={"gap_1k": 3.9, "gap_10k": 0.8, "seeds": 4}), "2026-11-16")
        self.assertEqual(got["state"], "differs")
        rft_results.apply(self.vault, "E02", outcome(results={"gap_1k": 3.9, "gap_10k": 0.8, "seeds": 4}), "2026-11-16", record=True)
        t = self.text()
        self.assertEqual(t.count(rft_results.BLOCK_BEGIN), 1)
        self.assertIn("| gap_1k | 3.9 |", t)
        self.assertNotIn("| gap_1k | 4.1 |", t)

    def test_a_locked_note_is_left_as_it_is_but_stamped(self):
        self.write("", "\nlocked: true")
        got = rft_results.apply(self.vault, "E02", outcome(), "2026-11-16", record=True)
        self.assertEqual((got["state"], got["recorded"], got["why"]), ("unchecked", False, "locked"))
        self.assertNotIn(rft_results.BLOCK_BEGIN, self.text())
        self.assertIn('reproduced: "2026-11-16 unchecked', self.text())
        # a locked note with numbers of its own is checked against them, never written
        self.write("Gap 4.1 at 1k and 0.8 at 10k, over 3 seeds.\n", "\nlocked: true")
        got = rft_results.apply(self.vault, "E02", outcome(results={"gap_1k": 4.2, "gap_10k": 0.8, "seeds": 3}), "2026-11-16", record=True)
        self.assertEqual((got["state"], got["recorded"], got["why"]), ("differs", False, "locked"))
        self.assertNotIn(rft_results.BLOCK_BEGIN, self.text())

    def test_a_verified_note_whose_run_differs_or_fails_goes_to_review(self):
        verified = '\nverified: "2026-11-16 a1b2c3d4"\nlocked: true'
        self.write("Gap 4.1 at 1k and 0.8 at 10k, over 3 seeds.\n", verified)
        self.path.write_text(self.text().replace("status: running", "status: verified").replace(", running]", ", verified]"))
        # reproduced: still verified, still locked
        got = rft_results.apply(self.vault, "E02", outcome(), "2026-11-17")
        self.assertEqual(got["state"], "ok")
        self.assertNotIn("review", got)
        self.assertIn("status: verified", self.text())
        # differs: review, unlocked, and why
        got = rft_results.apply(self.vault, "E02", outcome(results={"gap_1k": 4.6, "gap_10k": 0.8, "seeds": 3}), "2026-11-18")
        self.assertEqual((got["state"], got["review"]), ("differs", True))
        t = self.text()
        self.assertIn("status: review", t)
        self.assertIn("tags: [demo, experiment, review]", t)
        self.assertNotIn("locked:", t)
        self.assertIn("## History\n- 2026-11-18: to review, its notebook's run differs from its Result\n", t)
        self.assertLess(t.index("## History"), t.index("## Children in the tree"))
        self.assertIn("Gap 4.1 at 1k", t)  # its Result as it was
        # failed, on a verified note: the same
        self.path.write_text(t.replace("status: review", "status: verified"))
        got = rft_results.apply(self.vault, "E02", {"ok": False, "seconds": 0.4, "error": "KeyError"}, "2026-11-19")
        self.assertTrue(got["review"])
        self.assertIn("- 2026-11-19: to review, its notebook's run failed\n", self.text())

    def test_a_failed_run_and_a_run_with_no_results(self):
        self.write("")
        got = rft_results.apply(self.vault, "E02", {"ok": False, "seconds": 0.4, "error": "Traceback…\nKeyError: 'x'", "commit": "a1b2c3d4e5", "dirty": True}, "2026-11-16")
        self.assertEqual(got["state"], "failed")
        self.assertIn('reproduced: "2026-11-16 failed @a1b2c3d4e5+dirty in 0.4 s"', self.text())
        self.assertEqual(rft_results.apply(self.vault, "E02", outcome(results=None), "2026-11-16")["why"], "no RESULTS")
        self.assertEqual(rft_results.apply(self.vault, "E99", outcome(), "2026-11-16")["state"], "failed")

    def test_the_runs_it_read_are_named_with_their_code(self):
        self.write("")
        q = self.vault / ".queue"
        q.mkdir()
        rows = [{"id": "q4", "exp": "E02", "state": "done", "started": 2, "commit": "b2c3d4e5f6", "patch": "/r/code.patch"},
                {"id": "q3", "exp": "E02", "state": "done", "started": 1, "commit": "b2c3d4e5f6"},
                {"id": "q5", "exp": "E02", "state": "failed", "started": 3},
                {"id": "q6", "exp": "E02", "state": "done", "started": 4, "kind": "notebook"},
                {"id": "q7", "exp": "E09", "state": "done", "started": 5}]
        (q / "history.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows))
        rft_results.apply(self.vault, "E02", outcome(), "2026-11-16")
        self.assertIn("; runs q3, q4 (code b2c3d4e5f6, b2c3d4e5f6+patch).*", self.text())
        self.assertEqual([r["id"] for r in json.loads((self.vault / "results" / "E02.json").read_text())["runs"]], ["q3", "q4"])

    def test_an_artifact_takes_in_a_table_by_name_and_keeps_its_header(self):
        self.write("")
        art = self.vault / "artifacts" / "D01 Variants.html"
        art.parent.mkdir()
        head = '<!-- rft-artifact {"concept": "D01", "name": "Variants", "updated": "2026-11-15", "basis": {}} -->\n'
        art.write_text(head + '<h1>Variants</h1>\n<rft-table src="E02_gap_by_size"></rft-table>\n<rft-table src="E09_other">kept</rft-table>\n')
        got = rft_results.apply(self.vault, "E02", outcome(), "2026-11-16")
        self.assertEqual(got["saved"]["artifacts"], ["artifacts/D01 Variants.html"])
        page = art.read_text()
        self.assertTrue(page.startswith(head))
        self.assertIn('<rft-table src="E02_gap_by_size">\n<table>\n<caption>Gap by size</caption>', page)
        self.assertIn('<rft-table src="E09_other">kept</rft-table>', page)
        rft_results.apply(self.vault, "E02", outcome(tables={"Gap by size": {"columns": ["size", "gap"], "rows": [[1000, 3.9]]}}), "2026-11-16", record=True)
        page = art.read_text()
        self.assertEqual(page.count("<caption>Gap by size</caption>"), 1)
        self.assertIn("<td>3.9</td>", page)

    def test_what_is_not_a_figure_or_a_table_is_said_not_saved(self):
        self.write("")
        got = rft_results.apply(self.vault, "E02", outcome(figures={"x": "a plot"}, tables={"y": [1, 2]}, notes=["figure 'z': a Plotly figure"]), "2026-11-16")
        self.assertEqual(got["saved"]["figures"], [])
        self.assertEqual(sorted(got["notes"]), sorted(["figure 'x': not an SVG", "table 'y': not a table", "figure 'z': a Plotly figure"]))

    def test_the_tables_of_a_notebook_in_every_shape(self):
        notes = []
        self.assertEqual(rft_notebook.table_of("a", [{"seed": 0, "acc": 0.9}, {"seed": 1, "lr": 3e-4}], notes),
                         {"columns": ["seed", "acc", "lr"], "rows": [[0, 0.9, None], [1, None, 0.0003]]})
        self.assertEqual(rft_notebook.table_of("b", {"size": [1000, 10000], "gap": [4.1, 0.8]}, notes),
                         {"columns": ["size", "gap"], "rows": [[1000, 4.1], [10000, 0.8]]})
        self.assertEqual(rft_notebook.table_of("c", [["size", "gap"], [1000, 4.1]], notes), {"columns": ["size", "gap"], "rows": [[1000, 4.1]]})

        class Frame:  # what a pandas DataFrame answers
            columns = ["gap"]

            class index:
                name = "size"

            def to_dict(self, orient):
                return {"columns": ["gap"], "index": [1000, 10000], "data": [[4.1], [0.8]]}
        self.assertEqual(rft_notebook.table_of("d", Frame(), notes), {"columns": ["size", "gap"], "rows": [[1000, 4.1], [10000, 0.8]]})
        self.assertIsNone(rft_notebook.table_of("e", 42, notes))
        self.assertEqual(len(notes), 1)


def direction(nid, title, parent, extra=""):
    return f"""---
id: {nid}
type: direction
status: running
parent: {f'"[[{parent}]]"' if parent else '""'}
children: []
tags: [demo, direction, running]{extra}
---

# {nid} · {title}

## Idea
x
"""


class ConceptNotebookTest(unittest.TestCase):
    """A concept's notebook, on its start note: its experiments' numbers in, comparisons out."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.vault = Path(self.tmp.name) / "vault"
        for d in ("experiments", "directions"):
            (self.vault / d).mkdir(parents=True)
        (self.vault / "directions" / "D00 Does the thing work.md").write_text(direction("D00", "Does the thing work", "", '\nconcept: "Project"'))
        (self.vault / "directions" / "D01 A better variant.md").write_text(direction("D01", "A better variant", "D00 Does the thing work", '\nconcept: "Variants"\nnotebook: "notebooks/D01.py"'))
        (self.vault / "experiments" / f"{NAME}.md").write_text(note(""))

    def test_an_experiments_numbers_name_the_concepts_it_belongs_to(self):
        rft_results.apply(self.vault, "E02", outcome(), "2026-11-16")
        # the project's own concept, on the root note, is "root" (as the tree has it)
        self.assertEqual(json.loads((self.vault / "results" / "E02.json").read_text())["concepts"], ["D01", "root"])
        self.assertEqual(rft_results.concept_notebooks(self.vault, "E02"), ["D01"])

    def test_a_concept_run_saves_its_comparisons_fills_its_artifact_and_stamps_its_note(self):
        art = self.vault / "artifacts" / "D01 Variants.html"
        art.parent.mkdir()
        art.write_text('<!-- rft-artifact {"concept": "D01", "name": "Variants", "updated": "x", "basis": {}} -->\n<rft-table src="D01_gap_by_experiment"></rft-table>\n')
        got = rft_results.apply_concept(self.vault, "D01", outcome(results=None, figures={"Gap by experiment": "<svg/>"},
                                                                  tables={"Gap by experiment": {"columns": ["experiment", "gap"], "rows": [["E02", 4.1]]}}), "2026-11-16")
        self.assertEqual((got["state"], got["kind"]), ("ok", "concept"))
        self.assertEqual(got["saved"]["figures"], ["figures/D01_gap_by_experiment.svg"])
        self.assertIn("<tr><td>E02</td><td>4.1</td></tr>", art.read_text())
        self.assertIn('reproduced: "2026-11-16 ok @a1b2c3d4e5 in 6.1 s"', (self.vault / "directions" / "D01 A better variant.md").read_text())
        self.assertNotIn("rft-results", (self.vault / "directions" / "D01 A better variant.md").read_text())  # a concept's note has no Result to write
        failed = rft_results.apply_concept(self.vault, "D01", {"ok": False, "error": "KeyError: 'E09'"}, "2026-11-17")
        self.assertEqual((failed["state"], "saved" in failed), ("failed", False))


class BackfillTest(unittest.TestCase):
    """/rft-update notebooks: every notebook run again, experiments then concepts, in check mode."""

    def test_every_notebook_again_in_check_mode_the_concept_once_and_a_bar_for_the_monitor(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            for d in ("experiments", "directions"):
                (vault / d).mkdir(parents=True)
            (vault / "directions" / "D00 Does the thing work.md").write_text(direction("D00", "Does the thing work", ""))
            (vault / "directions" / "D01 A better variant.md").write_text(direction("D01", "A better variant", "D00 Does the thing work", '\nconcept: "Variants"\nnotebook: "notebooks/D01.py"'))
            hand = "Gap 4.6 at 1k and 0.8 at 10k, over 3 seeds.\n"  # numbers written by hand, which a rerun never replaces
            (vault / "experiments" / f"{NAME}.md").write_text(note(hand))
            (vault / "experiments" / "E03 Other.md").write_text(note("").replace("E02", "E03").replace("Variant run", "Other").replace('notebook: "notebooks/E02.py"', 'notebook: "notebooks/E03.py"'))
            ran, said = [], []
            real = rft_notebook.run

            def fake(path, timeout, uv="uv"):
                ran.append(Path(path).name)
                if Path(path).name == "E03.py":
                    return {"ok": False, "error": "Traceback (most recent call last):\nFileNotFoundError: runs/E03"}
                return outcome()
            rft_notebook.run = fake
            try:
                got = rft_notebook.backfill(vault, 30, out=lambda line, **_: said.append(line))
            finally:
                rft_notebook.run = real
            self.assertEqual(ran, ["E02.py", "E03.py", "D01.py"])  # experiments first, the concept once, last
            self.assertIn(hand.strip(), (vault / "experiments" / f"{NAME}.md").read_text())
            self.assertNotIn(rft_results.BLOCK_BEGIN, (vault / "experiments" / f"{NAME}.md").read_text())
            self.assertEqual(got["summary"], "rerun of 3 notebooks: 1 ok, 1 differs, 1 failed (differs: E02; failed: E03)")
            self.assertEqual(got["state"], "failed")
            self.assertIn("E02: differs: gap_1k 4.1", "\n".join(said))
            self.assertIn("E03: failed: FileNotFoundError: runs/E03", "\n".join(said))
            # the monitor reads the bar
            log = Path(tmp) / "q.log"
            log.write_text("\n".join(said[:3]) + "\n")
            bar = rft_queue.progress_of(log)["bars"][0]
            self.assertEqual((bar["desc"], bar["n"], bar["total"]), ("notebooks", "1", "3"))


TOY = '''import marimo
app = marimo.App()


@app.cell
def _():
    import json
    rows = json.load(open("data/runs.json"))
    return


@app.cell
def _():
    RESULTS = {"gap_1k": rows["gaps"][0], "seeds": len(rows["seeds"])}
    FIGURES = {"Gaps": '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>', "Bad": 3}
    TABLES = {"Gaps": {"size": [1000, 10000], "gap": rows["gaps"]}}
    return
'''


@unittest.skipUnless(HAS_UV, "uv is not on PATH")
class RealRunTest(unittest.TestCase):
    """A real notebook run (marimo in a throwaway uv project), applied to a vault: the check that
    does not depend on the code's own judgment is that the numbers the notebook makes land in the
    note, and its figure and table in the vault."""

    def test_a_run_applied_end_to_end(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve()
            repo = base / "code"
            (repo / "notebooks").mkdir(parents=True)
            (repo / "data").mkdir()
            (repo / "pyproject.toml").write_text('[project]\nname = "toy"\nversion = "0.1.0"\nrequires-python = ">=3.10"\ndependencies = []\n')
            (repo / "data" / "runs.json").write_text(json.dumps({"gaps": [4.1, 0.8], "seeds": [0, 1, 2]}))
            (repo / "notebooks" / "E02_variant_run.py").write_text(TOY)
            subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
            vault = base / "vault"
            (vault / "experiments").mkdir(parents=True)
            (vault / "experiments" / f"{NAME}.md").write_text(note(""))
            rft_notebook.link("../../code/notebooks/E02_variant_run.py", vault / "notebooks" / "E02.py")
            got = rft_notebook.apply_run(vault, "E02", 300, date="2026-11-16")
            self.assertEqual((got["state"], got["recorded"]), ("ok", True), got.get("error"))
            self.assertIn("| gap_1k | 4.1 |\n| seeds | 3 |", (vault / "experiments" / f"{NAME}.md").read_text())
            self.assertIn("From `notebooks/E02_variant_run.py`", (vault / "experiments" / f"{NAME}.md").read_text())
            self.assertEqual(got["saved"]["figures"], ["figures/E02_gaps.svg"])
            self.assertEqual(got["notes"], ["figure 'Bad': a int, not a matplotlib figure or SVG text"])
            self.assertIn("<tr><td>10000</td><td>0.8</td></tr>", (vault / "tables" / "E02_gaps.html").read_text())


if __name__ == "__main__":
    unittest.main()
