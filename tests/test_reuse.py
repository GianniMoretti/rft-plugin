"""A document reused (.scratch/local-overleaf, step 4), on the server's side: a duplicate (the
same files and tracking, tied to nothing of the first), a document brought into a folder of
another (a paper becomes a chapter of a thesis by papers: its copies and values tracked under
their new paths with the states they had, what clashes and what remains said, the source
unchanged), and a template's files added to a document (nothing overwritten). The step's referee:
the ICML paper brought into the AAU thesis as paper A, its body taken in by the thesis, compiles.
The vault is the clean-source fixture's; the kits are the ones tests/fetch_kits.py fetched.
"""
import json
import shutil
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import fetch_kits  # noqa: E402
import test_documents  # noqa: E402
from test_documents import LATEXMK, empty_document, kit_document  # noqa: E402

KEY = test_documents.KEY
THESIS = {
    "thesis.tex": "\\documentclass{report}\n\\usepackage{amsthm,graphicx}\n\\usepackage[numbers]{natbib}\n\\newtheorem{definition}{Definition}\n\\newtheorem{lemma}{Lemma}\n"
                  "\\begin{document}\n\\chapter{Introduction}\\label{def:cutmix}\nA thesis by papers. See \\cite{own2020}.\n\\bibliographystyle{plainnat}\n\\bibliography{thesis}\n\\end{document}\n",
    "thesis.bib": "@article{own2020,\n  title={Mine},\n  author={Me},\n  year={2020}\n}\n\n@inproceedings{yun2019cutmix,\n  title={CutMix},\n  author={Yun, S.},\n  year={2019}\n}\n",
}


class Reuse(test_documents.Server):
    def reuse(self, action: str, doc: str = "paper", **more):
        return self.write("POST", "/api/manuscript/reuse", {"doc": doc, "action": action, **more})

    def tree(self, name: str) -> dict[str, bytes]:
        folder = self.vault / "documents" / name
        return {p.relative_to(folder).as_posix(): p.read_bytes() for p in sorted(folder.rglob("*")) if p.is_file()}

    def read(self, name: str) -> dict:
        """What a document reads as: its copies by their marker and file, with their states, and its values."""
        d = self.ms(name)
        return {"copies": [(c["id"], c["marker"], c["file"] if c["state"] != "lost" else None, c["state"], c["markers"]) for c in d["copies"]],
                "values": [(v["kind"], v["from"], v["key"], v["file"], v["state"], v["inCopyOf"]) for v in d["values"]],
                "bib": [(b["key"], b["file"], b["from"]) for b in d["bib"]], "main": d["main"], "engine": d["engine"], "template": d["template"], "traces": d["traces"]}

    # ------------------------------------------------------------ duplicate (ticket 27)

    def test_a_duplicate_reads_with_the_same_copies_states_and_values_as_the_original(self):
        # the original with something of each kind to carry: an allowed occurrence, an engine, and a repository of its own
        t = self.tracking()
        t["allowed"] = [{"file": "main.tex", "match": "E05", "text": "As E05 shows."}]
        t["engine"] = "lualatex"
        (self.vault / "documents" / ".rft" / "paper" / "tracking.json").write_text(json.dumps(t))
        (self.vault / "documents" / ".rft" / "paper" / "git").mkdir()
        (self.vault / "documents" / ".rft" / "paper" / "git" / "HEAD").write_text("ref: refs/heads/main\n")
        before = self.read("paper")
        status, got = self.reuse("duplicate", name="paper-resubmission")
        self.assertEqual((status, got["name"], got["from"], got["files"]), (201, "paper-resubmission", "paper", 4))
        self.assertEqual(self.tree("paper-resubmission"), self.tree("paper"))
        self.assertEqual(self.read("paper-resubmission"), before)
        self.assertEqual(self.read("paper"), before)
        self.assertEqual(self.tracking("paper-resubmission"), self.tracking("paper"))
        self.assertEqual((self.tracking("paper-resubmission")["allowed"], self.tracking("paper-resubmission")["engine"]), (t["allowed"], "lualatex"))
        # connected to no remote, with no history; locked, as a new document is
        d = self.ms("paper-resubmission")
        self.assertEqual((d["repository"], d["locked"]), (False, True))
        self.assertEqual(sorted(p.name for p in (self.vault / "documents" / ".rft" / "paper-resubmission").iterdir()), ["tracking.json"])
        # a snippet's Used in lists both documents
        used = {s["id"]: sorted((u["doc"], u["file"], u["count"]) for u in s["usedIn"]) for s in json.loads(self.get("/api/manuscript")[2])["snippets"]}
        self.assertEqual(used["S01"], [("paper", "main.tex", 1), ("paper", "sections/method.tex", 1), ("paper-resubmission", "main.tex", 1), ("paper-resubmission", "sections/method.tex", 1)])
        # a name that is taken, a name that is none, a document that is none, the key
        self.assertEqual(self.reuse("duplicate", name="paper")[0], 409)
        self.assertEqual(self.reuse("duplicate", name="paper-resubmission")[0], 409)
        self.assertEqual(self.reuse("duplicate", name="My Paper")[0], 400)
        self.assertEqual(self.reuse("duplicate", "nope", name="x")[0], 404)
        self.assertEqual(self.write("POST", "/api/manuscript/reuse", {"doc": "paper", "action": "duplicate", "name": "x"}, key=None)[0], 403)
        self.assertEqual(self.reuse("merge", name="x")[0], 400)
        self.assertFalse((self.vault / "documents" / "x").exists())

    def test_a_change_in_the_duplicate_changes_nothing_in_the_original_and_the_other_way_round(self):
        self.assertEqual(self.reuse("duplicate", name="v2")[0], 201)
        original, tracked = self.tree("paper"), self.tracking("paper")
        # in the duplicate: a file renamed, a copy's file deleted, an engine chosen, a file edited
        self.assertEqual(self.files("move", "refs.bib", "v2", to="literature.bib")[0], 200)
        self.assertEqual(self.files("delete", "sections/method.tex", "v2", sure=True)[0], 200)
        self.assertEqual(self.write("POST", "/api/manuscript/settings", {"doc": "v2", "engine": "xelatex"})[0], 200)
        (self.vault / "documents" / "v2" / "main.tex").write_text("\\documentclass{article}\\begin{document}Other.\\end{document}\n")
        self.assertEqual((self.tree("paper"), self.tracking("paper")), (original, tracked))
        # in the original: the same kind of change
        duplicate, tracked2 = self.tree("v2"), self.tracking("v2")
        self.assertEqual(self.files("move", "sections/method.tex", to="sections/approach.tex")[0], 200)
        (self.doc / "main.tex").write_text("x\n")
        self.assertEqual((self.tree("v2"), self.tracking("v2")), (duplicate, tracked2))

    # ------------------------------------------------------------ bring in (ticket 28)

    def test_a_document_brought_into_a_folder_of_another_keeps_its_copies_and_values_under_their_new_paths(self):
        empty_document(self.vault, "thesis", THESIS, {"copies": [], "values": []})
        source, tracked = self.tree("paper"), self.tracking("paper")
        before = self.read("paper")
        status, got = self.reuse("bring-in", "thesis", source="paper", into="papers/cutmix")
        self.assertEqual((status, got["into"], got["from"], got["files"], got["copies"], got["main"]), (201, "papers/cutmix", "paper", 4, 8, "papers/cutmix/main.tex"))
        # the source is unchanged, and the receiving document keeps its own main file
        self.assertEqual((self.tree("paper"), self.tracking("paper")), (source, tracked))
        after = self.read("thesis")
        self.assertEqual(after["main"], "thesis.tex")
        self.assertEqual(self.ms("thesis")["mainAsked"], [])
        self.assertEqual({k: v for k, v in self.tree("thesis").items() if k.startswith("papers/cutmix/")}, {f"papers/cutmix/{k}": v for k, v in source.items()})
        # its copies under their new paths, with the states they had; its values too, the figure's among them
        under = lambda f: None if f is None else f"papers/cutmix/{f}"  # noqa: E731
        self.assertEqual(after["copies"], [(i, m, under(f), state, markers) for i, m, f, state, markers in before["copies"]])
        self.assertEqual(after["values"], [(k, n, key, under(f), state, inside) for k, n, key, f, state, inside in before["values"]])
        self.assertEqual([v["state"] for v in self.ms("thesis")["values"] if v["kind"] == "figure"], [v["state"] for v in self.ms("paper")["values"] if v["kind"] == "figure"])
        self.assertEqual([c["included"] for c in self.ms("thesis")["copies"] if c["state"] != "lost"], [False] * 7, "not in the thesis until the thesis takes the paper's body in")
        # what clashes is said, with both places, and nothing is renamed
        self.assertEqual(got["keys"], [{"key": "yun2019cutmix", "here": "thesis.bib", "brought": "papers/cutmix/refs.bib"}])
        self.assertEqual(got["labels"], [{"label": "def:cutmix", "here": ["thesis.tex:7"], "brought": ["papers/cutmix/main.tex:32"]}])
        self.assertIn("\\label{def:cutmix}", (self.vault / "documents" / "thesis" / "papers" / "cutmix" / "main.tex").read_text())
        self.assertIn("\\label{def:cutmix}", (self.vault / "documents" / "thesis" / "thesis.tex").read_text())
        # what remains for the user: the lines that name a file of the brought document, which is read from the thesis's top now
        self.assertEqual([(p["file"], p["command"], p["path"], p["to"]) for p in got["paths"]], [
            ("papers/cutmix/main.tex", "input", "sections/method", "papers/cutmix/sections/method"),
            ("papers/cutmix/main.tex", "bibliography", "refs", "papers/cutmix/refs"),
            ("papers/cutmix/sections/method.tex", "includegraphics", "figures/loss.pdf", "papers/cutmix/figures/loss.pdf")])
        # the entry both documents track is found in both .bib files; the user's own stay their own
        self.assertEqual(self.tracking("thesis")["bib"], {"yun2019cutmix": {"from": "R07", "file": "papers/cutmix/refs.bib"}})
        # the user writes the path where the figure is now: still the tree's figure, not a value to look at
        method = self.vault / "documents" / "thesis" / "papers" / "cutmix" / "sections" / "method.tex"
        method.write_text(method.read_text().replace("{figures/loss.pdf}", "{papers/cutmix/figures/loss.pdf}"))
        self.assertEqual([v["state"] for v in self.ms("thesis")["values"] if v["kind"] == "figure"], [v["state"] for v in self.ms("paper")["values"] if v["kind"] == "figure"])
        # brought in once: not into a folder that is there, not into itself, not from nowhere, never outside
        self.assertEqual(self.reuse("bring-in", "thesis", source="paper", into="papers/cutmix")[0], 409)
        self.assertEqual(self.reuse("bring-in", "thesis", source="thesis", into="papers/self")[0], 400)
        self.assertEqual(self.reuse("bring-in", "thesis", source="nope", into="papers/x")[0], 404)
        self.assertEqual(self.reuse("bring-in", "thesis", source="paper", into="../x")[0], 400)
        # the two are not tied afterwards: a change in the paper changes nothing in the thesis
        thesis = self.tree("thesis")
        (self.doc / "main.tex").write_text("x\n")
        self.assertEqual(self.tree("thesis"), thesis)

    @unittest.skipUnless(LATEXMK, "latexmk is not installed")
    def test_the_icml_paper_brought_into_the_aau_thesis_as_paper_a_compiles_with_its_copies_still_tracked(self):
        """Step 4's referee."""
        for kit in ("icml2027", "aau-thesis"):
            if fetch_kits.kit(kit) is None:
                self.skipTest(fetch_kits.missing(kit))
        placing = test_documents.KitsWithASnippet
        # the paper: a document made from the ICML kit, with a section of its own holding a copy of S01 (as ticket 20 makes it)
        kit_document(self.vault, "icml", "icml2027")
        self.assertEqual(self.files("new-file", "sections/method.tex", name="icml")[0], 201)
        (self.vault / "documents" / "icml" / "sections" / "method.tex").write_text("\\section{Method}\nA section of our own.\n")
        main = self.vault / "documents" / "icml" / "example_paper.tex"
        main.write_text(main.read_text().replace("\n\\bibliography{example_paper}", "\n\\input{sections/method}\n\n\\bibliography{example_paper}"))
        self.assertEqual(placing.place_s01(self, "icml", "sections/method.tex"), "example_paper.bib")
        self.assertEqual(self.write("POST", "/api/manuscript/compile", {"doc": "icml"})[1]["ok"], True)
        paper = self.read("icml")
        # the thesis: the AAU kit, its sample paper A making room for ours
        kit_document(self.vault, "thesis", "aau-thesis")
        self.assertEqual(self.files("delete", "papers/paperA", "thesis", sure=True)[0], 200)
        status, got = self.reuse("bring-in", "thesis", source="icml", into="papers/paperA")
        self.assertEqual((status, got["main"], got["copies"]), (201, "papers/paperA/example_paper.tex", 1))
        self.assertIn({"file": "papers/paperA/example_paper.tex", "line": next(p["line"] for p in got["paths"] if p["path"] == "sections/method"), "command": "input", "path": "sections/method", "to": "papers/paperA/sections/method"}, got["paths"])
        d = self.ms("thesis")
        self.assertEqual((d["main"], d["mainAsked"]), ("master.tex", []))
        # its copy tracked in the thesis under its new path, with the state it had
        self.assertEqual(self.read("thesis")["copies"], [(i, m, f"papers/paperA/{f}", state, markers) for i, m, f, state, markers in paper["copies"]])
        # what remains is the user's: the file the thesis takes in for paper A, which takes the paper's body in and names its .bib
        folder = self.vault / "documents" / "thesis"
        (folder / "papers" / "paperA" / "paperA.tex").write_text(
            "\\papertitlepage{%\n  CutMix in the low-data regime}{paper:paperA}{%\n  A. Author\n}{%\n  The paper has been submitted.\n}{%\n  \\noindent\\copyright\\ 2026\n}\n\n"
            "\\input{papers/paperA/sections/method}\n\n\\bibliographystyle{IEEEtran}\n\\bibliography{papers/paperA/example_paper}\n\\cleardoublepage\n")
        status, r = self.write("POST", "/api/manuscript/compile", {"doc": "thesis"})
        self.assertEqual([(e["declare"], e["in"]) for e in r["errors"] if e.get("declare")], [("definition", "papers/paperA/sections/method.tex")])
        placing.declare(self, "thesis", "master.tex", "definition", "Definition")
        status, r = self.write("POST", "/api/manuscript/compile", {"doc": "thesis"})
        self.assertEqual((status, r["ok"], r["errors"], [w for w in r["warnings"] if "undefined" in w]), (200, True, [], []))
        # in the thesis now, as a copy placed: taken in through paper A's file, its entry in paper A's own bibliography
        d = self.ms("thesis")
        self.assertEqual([(c["id"], c["file"], c["state"], c["included"]) for c in d["copies"]], [("S01", "papers/paperA/sections/method.tex", "placed", True)])
        self.assertEqual([b for b in d["bib"] if b["from"]], [{"key": "yun2019cutmix", "file": "papers/paperA/example_paper.bib", "from": "R07"}])
        self.assertEqual(d["traces"], [])
        self.assertIn("\\bibitem{yun2019cutmix}", (self.vault / "documents" / ".build" / "thesis" / "papers" / "paperA" / "paperA.bbl").read_text())
        # the brought-in main file is left as it is, and reads as not in the thesis
        self.assertEqual((folder / "papers" / "paperA" / "example_paper.tex").read_bytes(), main.read_bytes())
        self.assertIn("papers/paperA/example_paper.tex", d["notIncluded"])
        # and the paper itself is unchanged
        self.assertEqual(self.read("icml"), paper)
        placing.alone(self, "thesis", "master.tex")

    # ------------------------------------------------------------ a template's files added (ticket 29)

    def test_adding_a_kit_to_a_document_adds_its_style_files_and_skips_nothing_that_was_the_users(self):
        kit = self.vault / "templates" / "icml2027"
        if fetch_kits.kit("icml2027") is not None:
            shutil.copytree(fetch_kits.kit("icml2027"), kit)
        else:
            kit.mkdir(parents=True)
            for name in ("icml2027.sty", "icml2027.bst", "example_paper.tex", "example_paper.bib"):
                (kit / name).write_text(f"% {name}\n")
        (kit / "template.json").write_text('{"engine": "pdflatex"}')
        mine, tracked = self.tree("paper"), self.tracking("paper")
        status, got = self.reuse("add-template", template="icml2027")
        self.assertEqual((status, got["skipped"]), (200, []))
        for f in ("icml2027.sty", "icml2027.bst"):
            self.assertIn(f, got["added"])
            self.assertEqual((self.doc / f).read_bytes(), (kit / f).read_bytes())
        self.assertEqual(sorted(got["added"]), sorted(p.relative_to(kit).as_posix() for p in kit.rglob("*") if p.is_file() and p.name != "template.json"))
        self.assertFalse((self.doc / "template.json").exists())
        # nothing of the user's changed: their files, the main file, what is tracked
        now = self.tree("paper")
        self.assertEqual({k: v for k, v in now.items() if k in mine}, mine)
        self.assertEqual(self.tracking("paper"), tracked)
        self.assertEqual(self.ms()["main"], "main.tex", "the kit's own example has a \\begin{document} too: the document keeps its main file")
        # added again: every path exists now, so all are skipped and named, none overwritten
        (self.doc / "icml2027.sty").write_text("% mine now\n")
        status, got = self.reuse("add-template", template="icml2027")
        self.assertEqual((status, got["added"]), (200, []))
        self.assertIn("icml2027.sty", got["skipped"])
        self.assertEqual((self.doc / "icml2027.sty").read_text(), "% mine now\n")

    def test_a_template_file_whose_path_exists_is_skipped_and_named(self):
        kit = self.vault / "templates" / "venue"
        (kit / "sections").mkdir(parents=True)
        (kit / "main.tex").write_text("\\documentclass{venue}\n\\begin{document}\nSample.\n\\end{document}\n")
        (kit / "refs.bib").write_text("@misc{sample}\n")
        (kit / "venue.cls").write_text("% the class\n")
        (kit / "sections" / "method.tex").write_text("Sample method.\n")
        (kit / "sections" / "results.tex").write_text("Sample results.\n")
        mine = self.tree("paper")
        status, got = self.reuse("add-template", template="venue")
        self.assertEqual((status, got["added"], got["skipped"]), (200, ["sections/results.tex", "venue.cls"], ["main.tex", "refs.bib", "sections/method.tex"]))
        self.assertEqual({k: v for k, v in self.tree("paper").items() if k in mine}, mine)
        self.assertEqual(self.reuse("add-template", template="article")[0], 400)
        self.assertEqual(self.reuse("add-template", template="nope")[0], 404)
        self.assertEqual(self.reuse("add-template", template="../venue")[0], 404)
        self.assertEqual(self.reuse("add-template", "nope", template="venue")[0], 404)


if __name__ == "__main__":
    unittest.main()
