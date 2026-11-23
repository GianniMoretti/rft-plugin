"""Clean source (docs/adr/0003-a-document-holds-no-trace.md) on the server's side: the fixture
(tests/fixtures/local-overleaf: a small vault with one document as a co-author would see it), the
scan's cases, which hooks/lib/scan.ts is held to as well (tests/scan.test.ts reads them
through their copy, tests/fixtures/local-overleaf.ts), and the step's own check: the document
compiles from its folder alone and the scan finds nothing in it.
"""
import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import rft_scan  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "local-overleaf"
VAULT = FIXTURE / "project" / "vault"
IDS = {"D01", "T02", "E05", "E08", "R07", "S01", "S02", "S03", "S04", "S05", "S06"}


class Fixture(unittest.TestCase):
    def test_the_copy_the_plugins_tests_read_is_the_fixture(self):
        spec = importlib.util.spec_from_file_location("to_ts", FIXTURE / "to_ts.py")
        to_ts = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(to_ts)
        self.assertEqual(to_ts.OUT.read_text(encoding="utf-8"), to_ts.module(),
                         "tests/fixtures/local-overleaf.ts is behind the fixture: python3 tests/fixtures/local-overleaf/to_ts.py")

    def test_the_document_compiles_from_its_folder_alone(self):
        """The step's check: nothing of the vault or the plugin on the path, plain latexmk."""
        if not shutil.which("latexmk"):
            self.skipTest("latexmk is not installed")
        with tempfile.TemporaryDirectory() as tmp:
            doc = Path(tmp) / "paper"
            shutil.copytree(VAULT / "documents" / "paper", doc)
            r = subprocess.run(["latexmk", "-pdf", "-interaction=nonstopmode", "-halt-on-error", "main.tex"], cwd=doc, capture_output=True, text=True, timeout=180,
                               env={"PATH": __import__("os").environ["PATH"], "HOME": tmp})
            log = (doc / "main.log").read_text(encoding="utf-8", errors="replace") if (doc / "main.log").exists() else r.stdout
            self.assertEqual(r.returncode, 0, log[-2000:])
            self.assertTrue((doc / "main.pdf").is_file())
            for bad in ("undefined", "multiply defined", "Citation"):
                self.assertNotIn(bad, "\n".join(line for line in log.splitlines() if "Warning" in line), bad)


class Scan(unittest.TestCase):
    def test_the_cases_both_sides_are_held_to(self):
        d = json.loads((FIXTURE / "traces.json").read_text(encoding="utf-8"))
        key = lambda t: (t["file"], t["line"] or 0, t["kind"], t["match"])  # noqa: E731
        for c in d["cases"]:
            with self.subTest(c["why"]):
                got = rft_scan.scan_files(list(c["files"].items()), set(d["ids"]), set(d["treeKeys"]), c.get("allowed"))
                self.assertEqual(sorted(({k: t[k] for k in ("file", "line", "kind", "match")} for t in got["traces"]), key=key), sorted(c["traces"], key=key))
                self.assertEqual(got["allowed"], c.get("allowedCount", 0))

    def test_the_fixtures_document_scans_clean(self):
        self.assertEqual(rft_scan.scan_document(VAULT, "paper", IDS, {"R07", "yun2019cutmix"}), {"traces": [], "allowed": 0})

    def test_each_kind_of_trace_added_is_reported_with_its_file_and_line_and_an_allowed_one_is_not(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            shutil.copytree(VAULT, vault)
            doc = vault / "documents" / "paper"
            main = (doc / "main.tex").read_text()
            (doc / "main.tex").write_text(main.replace("\\usepackage{hyperref}", "\\usepackage{hyperref}\n\\usepackage{rft}").replace("%%% Result: CutMix at 1k images %%%", "% rft-begin S02 3f2a1c9d"))
            with (doc / "sections" / "method.tex").open("a") as f:
                f.write("As E05 shows.\n")
            (doc / "refs.bib").write_text((doc / "refs.bib").read_text().replace("zhang2018mixup", "R07"))
            (doc / "figures" / "E08_loss.pdf").write_bytes(b"%PDF\n\xff\x00")
            (doc / ".blocks.json").write_text('{\n  "S01": "text"\n}\n')
            got = rft_scan.scan_document(vault, "paper", IDS, {"R07", "yun2019cutmix"})
            self.assertEqual([(t["file"], t["line"], t["kind"], t["match"]) for t in got["traces"]], [
                (".blocks.json", 2, "id", "S01"), ("figures/E08_loss.pdf", None, "id", "E08"), ("main.tex", 8, "plugin", "rft"),
                ("main.tex", 44, "marker", "rft-begin"), ("main.tex", 44, "id", "S02"), ("refs.bib", 8, "id", "R07"), ("refs.bib", 8, "reference", "R07"),
                ("sections/method.tex", 27, "id", "E05")])
            tracking = vault / "documents" / ".rft" / "paper" / "tracking.json"
            t = json.loads(tracking.read_text())
            t["allowed"] = [{"file": "sections/method.tex", "match": "E05", "text": "As E05 shows."}]
            tracking.write_text(json.dumps(t))
            again = rft_scan.scan_document(vault, "paper", IDS, {"R07", "yun2019cutmix"})
            self.assertEqual((len(again["traces"]), again["allowed"]), (7, 1))


if __name__ == "__main__":
    unittest.main()
