"""Clean source (docs/adr/0003-a-document-holds-no-trace.md) on the server's side: the fixture
(tests/fixtures/local-overleaf: a small vault with one document as a co-author would see it), the
scan's cases, which hooks/lib/scan.ts is held to as well (tests/scan.test.ts reads them
through their copy, tests/fixtures/local-overleaf.ts), and the step's own check: the document
compiles from its folder alone and the scan finds nothing in it.
"""
import importlib.util
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import rft_latex  # noqa: E402
import rft_manuscript  # noqa: E402
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


def summary(vault: Path) -> dict:
    """The fixture as the page is given it: the vault's notes read as the server's tree has them."""
    nodes, texts = [], {}
    for folder, kind in (("directions", "direction"), ("experiments", "experiment"), ("references", "reference"), ("theory", "theory")):
        for f in sorted((vault / folder).glob("*.md")):
            text = f.read_text(encoding="utf-8")
            nid = f.name.split(" ")[0]
            status = next(line.split(":", 1)[1].strip() for line in text.split("\n") if line.startswith("status:"))
            nodes.append({"id": nid, "name": f.stem, "type": kind, "status": status})
            texts[nid] = text
    return rft_manuscript.summary(vault, {"nodes": nodes}, lambda nid: texts.get(nid, ""))


class Reader(unittest.TestCase):
    """What the server's reader yields of the fixture's document: what expected.json says, as
    hooks/lib/copies.ts and manuscript.ts yield it (tests/copies.test.ts)."""

    @classmethod
    def setUpClass(cls):
        cls.want = json.loads((FIXTURE / "expected.json").read_text(encoding="utf-8"))
        cls.got = summary(VAULT)
        cls.doc = cls.got["documents"][0]

    def test_its_copies_each_with_its_state_and_how_it_was_found(self):
        got = [{"snippet": c["id"], "file": c["file"] if c["state"] != "lost" else None, "state": c["state"], "markers": c["markers"], "marker": c["marker"]} for c in self.doc["copies"]]
        self.assertEqual(got, [{k: c[k] for k in ("snippet", "file", "state", "markers", "marker")} for c in self.want["copies"]])
        self.assertEqual([c["name"] for c in self.doc["copies"]], ["S05", "S01#1", "S01#2", "S04", "S03", "S07", "S02", "S06"])
        self.assertEqual([(c["line"], c["end"]) for c in self.doc["copies"]], [(28, 29), (31, 37), (3, 6), (8, 11), (14, 20), (22, 26), (43, 47), (None, None)])

    def test_where_each_snippet_is_used(self):
        got = {s["id"]: {u["file"]: u["count"] for u in s["usedIn"]} for s in self.got["snippets"] if s["usedIn"]}
        self.assertEqual(got, self.want["usedIn"])

    def test_its_values_each_with_its_state(self):
        keys = ("kind", "file", "from", "key", "state", "inCopyOf")
        self.assertEqual([{k: v[k] for k in keys} for v in self.doc["values"]], [{k: v[k] for k in keys} for v in self.want["values"]])
        self.assertEqual([(v["written"], v["inDocument"], v["now"] if v["kind"] == "number" else None, v["line"]) for v in self.doc["values"]],
                         [("73.2", "73.2", "73.2", 20), ("73.2", "73.2", "73.2", 45), ("81.4", "81.4", "81.6", 45), ("3", "5", "3", 12), ("figures/loss.pdf", "figures/loss.pdf", None, 17)])

    def test_its_bib_and_its_scan(self):
        self.assertEqual({b["key"]: b["from"] for b in self.doc["bib"]}, self.want["bib"])
        self.assertEqual((self.doc["traces"], self.doc["allowedTraces"]), (self.want["scan"], 0))
        self.assertEqual((self.doc["main"], self.doc["files"], self.doc["others"], self.doc["notIncluded"]),
                         ("main.tex", ["main.tex", "refs.bib", "sections/method.tex"], ["figures/loss.pdf"], []))

    def test_markers_and_places_as_the_plugins_side_reads_them(self):
        text = "%%% Section one %%%\nText.\n%%%Definition:  CutMix%%%\nA.\n  %%% END %%%\n%%% Lemma: X %%%\n%%% Lemma: Y %%%\nB.\n%%% end %%%\n%%% end %%%\n"
        self.assertEqual(rft_manuscript.parse_markers(text), [{"words": "Definition:  CutMix", "begin": 2, "end": 4, "content": "A."}, {"words": "Lemma: Y", "begin": 6, "end": 8, "content": "B."}])
        copy = lambda marker, placed, file: {"snippet": "S01", "marker": marker, "file": file, "stamp": "", "placed": placed}  # noqa: E731
        files = {"a.tex": "Intro.\n", "b.tex": "%%% Result: One %%%\nOne  thing.\n%%% end %%%\n%%% Finding: two %%%\nTwo\nthings.\n%%% end %%%\nTwo things.\n"}
        got = rft_manuscript.locate_copies(files, {"copies": [copy("Result: One", "One thing.", "a.tex"), copy("Result: Two", "Two things.", "b.tex"), copy("Result: Two", "Two things.", "b.tex")]})
        self.assertEqual([(c["found"], c["file"], c["begin"], c["end"]) for c in got], [("markers", "b.tex", 0, 2), ("markers", "b.tex", 3, 6), ("text", "b.tex", 7, 7)])
        v = lambda written, before, after: {"kind": "number", "from": "E05", "key": "k", "written": written, "file": "a.tex", "before": before, "after": after}  # noqa: E731
        files = {"a.tex": "It reaches\n  73.2\\% here, and 73.2\\% there; 81 (not ours) and 9 in all.\n"}
        got = rft_manuscript.locate_values(files, {"values": [v("73.2", "reaches ", "\\% "), v("73.2", "and ", "\\% there"), v("80", "; ", " (not ours)"), v("7", "nowhere ", " at all"), v("9", "", "")]})
        self.assertEqual([(x["found"], x["inDocument"], x["line"]) for x in got], [("written", "73.2", 1), ("written", "73.2", 1), ("changed", "81", 1), (None, None, None), ("written", "9", 1)])
        files = {"a.tex": "In our words, the gap closes by 0.3 points overall; the rest, 12 of them, stays.\n"}
        got = rft_manuscript.locate_values(files, {"values": [v("0.3", "The gap closes by ", " points in all."), v("14", "points; the rest, ", " of them, stays."), v("5", "something else entirely ", " was here before")]})
        self.assertEqual([(x["found"], x["inDocument"]) for x in got], [("written", "0.3"), ("changed", "12"), (None, None)])


class Compile(unittest.TestCase):
    @unittest.skipUnless(shutil.which("latexmk") and shutil.which("pdftotext"), "latexmk or pdftotext is not on PATH")
    def test_the_server_compiles_the_document_the_same_with_the_vaults_figures_renamed_away(self):
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp) / "vault"
            shutil.copytree(VAULT, vault)
            (vault / "figures").rename(vault / "figures-away")
            (vault / "results").rename(vault / "results-away")
            r = rft_latex.compile_doc(vault, "paper")
            self.assertTrue(r["ok"], r)
            self.assertEqual((r["errors"], r["warnings"]), ([], []))
            text = " ".join(subprocess.run(["pdftotext", r["pdf"], "-"], capture_output=True, text=True, check=True).stdout.split())
            self.assertIn("It reaches 73.2% top-1 accuracy", text)
            self.assertIn("Definition 1 (CutMix)", text)
            self.assertIn("Figure 1: Training loss", text)
            self.assertIn("Sangdoo Yun", text)
            # nothing generated beside the document, nothing written in its folder
            self.assertEqual(sorted(p.name for p in (vault / "documents").iterdir()), [".build", ".rft", "documents.json", "paper"])
            self.assertEqual(sorted(p.relative_to(vault / "documents" / "paper").as_posix() for p in (vault / "documents" / "paper").rglob("*") if p.is_file()),
                             ["figures/loss.pdf", "main.tex", "refs.bib", "sections/method.tex"])


class Converted(unittest.TestCase):
    """A document of the first design as hooks/lib/convert.ts leaves it (tests/convert.test.ts holds
    the conversion to these files): the step's check, and its copies' states as the page reads them."""
    AFTER = FIXTURE / "first-design" / "after"

    def vault(self, tmp: str) -> Path:
        vault = Path(tmp) / "vault"
        shutil.copytree(VAULT, vault)
        shutil.rmtree(vault / "documents" / "paper")
        shutil.copytree(self.AFTER, vault / "documents" / "paper")
        (vault / "documents" / "paper" / "tracking.json").rename(vault / "documents" / ".rft" / "paper" / "tracking.json")
        return vault

    def test_it_scans_clean_and_its_copies_keep_their_states(self):
        want = json.loads((FIXTURE / "first-design" / "expected.json").read_text(encoding="utf-8"))
        with tempfile.TemporaryDirectory() as tmp:
            vault = self.vault(tmp)
            self.assertEqual(rft_scan.scan_document(vault, "paper", IDS, {"R07", "yun2019cutmix"}), {"traces": [], "allowed": 0})
            doc = summary(vault)["documents"][0]
            self.assertEqual([{"snippet": c["id"], "state": c["state"]} for c in doc["copies"]], want["copies"])
            self.assertEqual([(v["written"], v["state"], v["inCopyOf"]) for v in doc["values"]], [("73.2", "current", None), ("figures/loss.pdf", "current", "S03"), ("73.2", "current", "S02")])
            self.assertEqual((doc["traces"], doc["firstDesign"]), ([], False))
            # as the first design had it, it is said to be so, and its markers and macros are traces
            before = FIXTURE / "first-design" / "before"
            shutil.rmtree(vault / "documents" / "paper")
            shutil.copytree(before, vault / "documents" / "paper")
            (vault / "documents" / ".rft" / "paper" / "tracking.json").unlink()
            doc = summary(vault)["documents"][0]
            self.assertEqual((doc["firstDesign"], doc["copies"], len(doc["traces"]) > 10), (True, [], True))

    @unittest.skipUnless(shutil.which("latexmk") and shutil.which("pdftotext"), "latexmk or pdftotext is not on PATH")
    def test_it_compiles_from_its_folder_alone(self):
        with tempfile.TemporaryDirectory() as tmp:
            doc = Path(tmp) / "paper"
            shutil.copytree(self.AFTER, doc)
            (doc / "tracking.json").unlink()
            r = subprocess.run(["latexmk", "-pdf", "-interaction=nonstopmode", "-halt-on-error", "main.tex"], cwd=doc, capture_output=True, text=True, timeout=180,
                               env={"PATH": __import__("os").environ["PATH"], "HOME": tmp})
            log = (doc / "main.log").read_text(encoding="utf-8", errors="replace") if (doc / "main.log").exists() else r.stdout
            self.assertEqual(r.returncode, 0, log[-2000:])
            warnings = "\n".join(line for line in log.splitlines() if "Warning" in line)
            # the citation of a paper the tree does not hold was undefined before the conversion too
            self.assertEqual(re.findall(r"(Reference|Citation) `(.+?)'", warnings), [("Citation", "zhang2018mixup")] * len(re.findall(r"Citation `zhang2018mixup'", warnings)))
            self.assertNotIn("multiply defined", warnings)
            text = " ".join(subprocess.run(["pdftotext", str(doc / "main.pdf"), "-"], capture_output=True, text=True, check=True).stdout.split())
            for part in ("It reaches 73.2% top-1 accuracy over ?? runs", "Definition 1 (CutMix)", "Lemma 1 (Mixing bound)", "Figure 1: Training loss",
                         "see Definition 1, Lemma 1 and Figure 1", "for 200 epochs", "Sangdoo Yun"):
                self.assertIn(part, text)


if __name__ == "__main__":
    unittest.main()
