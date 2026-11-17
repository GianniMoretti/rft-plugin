"""The LaTeX of snippets and documents: the generated rft.sty, rft-numbers.tex and refs.bib, a
document (holding copies of snippets) compiled by latexmk whose PDF, read back with pdftotext, holds
the numbers results/*.json holds, and a snippet compiled alone.

The compile is skipped without latexmk or pdftotext.

    python3 -m unittest tests.test_latex
"""
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))
import rft_latex  # noqa: E402
import rft_manuscript  # noqa: E402
import rft_results  # noqa: E402

HAS_TEX = bool(shutil.which("latexmk") and shutil.which("pdftotext") and shutil.which("pdflatex"))

REFERENCE = """---
id: R01
type: reference
status: verified
tags: [demo, reference, verified]
---

# R01 · Mixup paper

## Source
Zhang et al., mixup: Beyond Empirical Risk Minimization, ICLR 2018, https://arxiv.org/abs/1710.09412
```bibtex
@inproceedings{zhang2018mixup,
  title = {mixup: Beyond Empirical Risk Minimization},
  author = {Zhang, Hongyi and Cisse, Moustapha and Dauphin, Yann N. and Lopez-Paz, David},
  booktitle = {ICLR},
  year = {2018}
}
```

## Key results
Mixup helps.
"""

LITERATURE = """---
id: R02
type: reference
status: done
tags: [demo, literature, reference, done]
---

# R02 · Literature on augmentation

## Papers
### CutMix
```bibtex
@inproceedings{yun2019cutmix,
  title = {CutMix},
  author = {Yun, Sangdoo},
  booktitle = {ICCV},
  year = {2019}
}
```
"""

BARE = """---
id: R03
type: reference
status: planned
tags: [demo, reference, planned]
---

# R03 · A paper with no BibTeX

## Source
Doe 2020, doi 10.1234/abcd.5678.
"""

DOC = r"""\documentclass[11pt]{article}
\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage{amsmath,amssymb,amsthm}
\usepackage{graphicx,booktabs}
\usepackage[numbers]{natbib}
\usepackage{rft}
\usepackage{hyperref}
\title{Small data}
\begin{document}
\maketitle
%(S01)s
%(S02)s
\bibliographystyle{plainnat}
\bibliography{refs}
\end{document}
"""

S01 = r"""% rft-snippet S01 · result · Training length at 1k images
% basis: E05
\paragraph{Training length at 1k images}
Long training reaches \rftnum{E05}{acc.1k} percent at 1k images over \rftnum{E05}{seeds} seeds, as mixup suggested \citep{zhang2018mixup} and CutMix \citep{yun2019cutmix}; see \citet{R01} and \citet{R03}.
\begin{table}[h]
  \centering
  \caption{Accuracy by seed}\label{S01}
  \rfttable{E05}{accuracy_by_seed}
\end{table}
\begin{figure}[h]
  \centering
  \rftfig[width=.3\linewidth]{E05}{loss}
  \caption{Loss}
\end{figure}
"""

S02 = r"""% rft-snippet S02 · definition · Augmentation gap
% basis: E05
\begin{definition}[Augmentation gap]\label{S02}
The gap is \rftnum{E05}{nope}.
\end{definition}
"""


def copy_of(sid: str, snippet: str) -> str:
    """A copy of a snippet as a document holds it (blockText in hooks/lib/snippets.ts)."""
    content = rft_manuscript.content_of(snippet)
    return f"% rft-begin {sid} {rft_manuscript.content_fingerprint(content)}\n{content}\n% rft-end {sid}"


class GeneratedTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.vault = Path(self.tmp.name) / "vault"
        (self.vault / "references").mkdir(parents=True)
        (self.vault / "references" / "R01 Mixup paper.md").write_text(REFERENCE)
        (self.vault / "references" / "R02 Literature on augmentation.md").write_text(LITERATURE)
        (self.vault / "references" / "R03 A paper with no BibTeX.md").write_text(BARE)
        (self.vault / "results").mkdir()
        (self.vault / "results" / "E05.json").write_text(json.dumps({"exp": "E05", "results": {"acc": {"1k": 71.3, "10k": 88.25}, "seeds": 3, "model": "resnet_18", "ok": True}}))

    def test_numbers_are_every_saved_result_by_its_path(self):
        tex = rft_latex.numbers_tex(self.vault)
        self.assertIn(r"\@namedef{rft@num@E05@acc.1k}{71.3}", tex)
        self.assertIn(r"\@namedef{rft@num@E05@acc.10k}{88.25}", tex)
        self.assertIn(r"\@namedef{rft@num@E05@seeds}{3}", tex)
        self.assertIn(r"\@namedef{rft@num@E05@model}{resnet\_18}", tex)
        self.assertNotIn("@ok}", tex)

    def test_the_bibliography_from_the_reference_notes(self):
        bib = rft_latex.refs_bib(self.vault)
        self.assertIn("@inproceedings{zhang2018mixup,", bib)  # as written
        self.assertIn("@inproceedings{R01,\n  title = {mixup: Beyond", bib)  # and under the note's id
        self.assertIn("@inproceedings{yun2019cutmix,", bib)  # a literature note's paper, by its own key
        self.assertNotIn("{R02,", bib)  # a literature note is not one paper
        self.assertIn("@misc{R03,\n  title = {{A paper with no BibTeX}},\n  note = {10.1234/abcd.5678}\n}", bib)

    def test_a_table_as_booktabs(self):
        t = {"columns": ["seed", "accuracy", "note"], "rows": [[0, 71.2, "a_b"], [1, 71.4, "± 0.1"], [2, None, "x"]]}
        self.assertEqual(rft_results.table_tex(t), "\n".join([
            r"\begin{tabular}{rrl}", r"\toprule", r"seed & accuracy & note \\", r"\midrule",
            r"0 & 71.2 & a\_b \\", r"1 & 71.4 & $\pm$ 0.1 \\", r"2 &  & x \\", r"\bottomrule", r"\end{tabular}", ""]))

    def test_errors_and_warnings_read_from_a_log(self):
        ms = self.vault / "documents"
        log = "\n".join([
            f"{self.vault}/snippets/S02.tex:4: Undefined control sequence.",
            "l.4 The gap is \\rftnu",
            "./main.tex:12: LaTeX Error: File `x.sty' not found.",
            "Package rft Warning: No number nope of E05 (results/E05.json) on input line 4.",
            "LaTeX Warning: Citation `nobody' on page 1 undefined on input line 3.",
        ])
        errors, warnings = rft_latex.read_log(log, ms, "paper")
        self.assertEqual([(e["file"], e.get("snippet"), e["line"], e["message"]) for e in errors], [
            ("snippets/S02.tex", "S02", 4, "Undefined control sequence."),
            ("documents/paper/main.tex", None, 12, "LaTeX Error: File `x.sty' not found."),
        ])
        self.assertEqual(warnings, ["No number nope of E05 (results/E05.json)", "Citation nobody undefined"])

    def documents(self, doc: str = DOC):
        """The snippets in snippets/, and the paper holding a copy of each."""
        ms = self.vault / "documents"
        (ms / "paper").mkdir(parents=True)
        (ms / "paper" / "main.tex").write_text(doc % {"S01": copy_of("S01", S01), "S02": copy_of("S02", S02)})
        (self.vault / "snippets").mkdir()
        (self.vault / "snippets" / "S01.tex").write_text(S01)
        (self.vault / "snippets" / "S02.tex").write_text(S02)
        return ms

    @unittest.skipUnless(HAS_TEX, "latexmk, pdflatex or pdftotext is not on PATH")
    def test_a_document_compiles_and_its_pdf_holds_the_saved_numbers(self):
        ms = self.documents()
        (self.vault / "tables").mkdir()
        (self.vault / "tables" / "E05_accuracy_by_seed.tex").write_text(
            rft_results.table_tex({"columns": ["seed", "accuracy"], "rows": [[0, 71.25], [1, 71.35]]}))
        # a figure as a notebook's run saves it: a PDF (here, one page made by pdflatex)
        fig = Path(self.tmp.name) / "fig"
        fig.mkdir()
        (fig / "f.tex").write_text(r"\documentclass{article}\pagestyle{empty}\begin{document}LOSSCURVE\end{document}")
        subprocess.run(["pdflatex", "-interaction=nonstopmode", "f.tex"], cwd=fig, capture_output=True, check=True)
        (self.vault / "figures").mkdir()
        shutil.copy(fig / "f.pdf", self.vault / "figures" / "E05_loss.pdf")

        r = rft_latex.compile_doc(self.vault, "paper")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["errors"], [])
        self.assertEqual(r["warnings"], ["No number nope of E05 (results/E05.json)"])
        text = subprocess.run(["pdftotext", "-layout", r["pdf"], "-"], capture_output=True, text=True, check=True).stdout
        saved = json.loads((self.vault / "results" / "E05.json").read_text())["results"]
        # the numbers in the PDF are the saved ones: no one typed them
        self.assertIn(f"reaches {rft_results.number_text(saved['acc']['1k'])} percent", text)
        self.assertIn(f"over {saved['seeds']} seeds", text)
        self.assertIn("71.25", text)  # the table
        self.assertIn("LOSSCURVE", text)  # the figure
        self.assertIn("Definition 1 (Augmentation gap). The gap is ??", text)
        self.assertIn("mixup: beyond empirical risk minimization", text.lower())  # the bibliography
        self.assertIn("[2] Sangdoo Yun. Cutmix. In ICCV, 2019.", text)
        for f in ("rft.sty", "rft-numbers.tex", "refs.bib"):
            self.assertTrue((ms / f).is_file(), f)

    @unittest.skipUnless(HAS_TEX, "latexmk, pdflatex or pdftotext is not on PATH")
    def test_an_error_names_its_file_and_line(self):
        ms = self.documents(DOC.replace("\\maketitle", "\\maketitle\n\\notacommand here"))
        r = rft_latex.compile_doc(self.vault, "paper")
        self.assertFalse(r["ok"])
        self.assertEqual([(e["file"], e["line"], e["message"]) for e in r["errors"]], [("documents/paper/main.tex", 12, "Undefined control sequence.")])
        # a snippet compiled alone: its errors at its own lines
        (self.vault / "snippets" / "S03.tex").write_text("% rft-snippet S03 · result · X\n% basis: E05\nFine.\n\\notacommand here\n")
        r = rft_latex.compile_snippet(self.vault, "S03")
        self.assertEqual([(e.get("snippet"), e["line"], e["message"]) for e in r["errors"]], [("S03", 4, "Undefined control sequence.")])
        self.assertTrue((ms / "rft.sty").is_file())

    @unittest.skipUnless(HAS_TEX, "latexmk, pdflatex or pdftotext is not on PATH")
    def test_a_snippet_compiles_alone(self):
        self.documents()
        r = rft_latex.compile_snippet(self.vault, "S01")
        self.assertTrue(r["ok"], r)
        self.assertTrue(r["pdf"].endswith("documents/.build/_snippets/S01.pdf"))
        text = " ".join(subprocess.run(["pdftotext", r["pdf"], "-"], capture_output=True, text=True, check=True).stdout.split())
        self.assertIn("Long training reaches 71.3 percent at 1k images over 3 seeds", text)
        self.assertIn("mixup: beyond empirical risk minimization", text.lower())  # it cites: its bibliography too
        r = rft_latex.compile_snippet(self.vault, "S02")  # no citation, no bibliography
        self.assertTrue(r["ok"], r)

    def test_no_such_document_or_snippet(self):
        self.assertEqual(rft_latex.compile_doc(self.vault, "../x"), {"ok": False, "error": "no document ../x"})
        self.assertEqual(rft_latex.compile_snippet(self.vault, "S99"), {"ok": False, "error": "no snippet S99"})


if __name__ == "__main__":
    unittest.main()
