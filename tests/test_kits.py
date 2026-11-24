"""The referee of folders and templates (.scratch/local-overleaf, step 2): two real kits, the ICML
2027 style files and Aalborg University's PhD thesis as a collection of papers, and a small
fixture of our own that needs XeLaTeX and biber. The kits are not in the repo (tests/fetch_kits.py
fetches them into a cache); a test that needs one skips, saying so, when it is not there. Here:
each kit compiles unmodified, in place, with plain latexmk, as it must before the plugin touches it.
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_kits  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "local-overleaf"


def latexmk(folder: Path, main: str, engine: str = "-pdf") -> tuple[int, str]:
    """Plain latexmk on a folder's main file, with nothing but the folder to read: its exit code and its log."""
    r = subprocess.run(["latexmk", engine, "-interaction=nonstopmode", "-halt-on-error", main], cwd=folder, capture_output=True, text=True, timeout=300,
                       env={"PATH": os.environ["PATH"], "HOME": str(folder.parent)})
    log = folder / f"{Path(main).stem}.log"
    return r.returncode, log.read_text(encoding="utf-8", errors="replace") if log.exists() else r.stdout + r.stderr


def undefined(log: str) -> list[str]:
    """The log's lines on a citation or a reference left undefined."""
    return [line for line in log.splitlines() if "Warning" in line and "undefined" in line]


@unittest.skipUnless(shutil.which("latexmk"), "latexmk is not installed")
class Kits(unittest.TestCase):
    def compiled(self, name: str) -> str:
        kit = fetch_kits.kit(name)
        if kit is None:
            self.skipTest(fetch_kits.missing(name))
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / name
            shutil.copytree(kit, folder)
            main = fetch_kits.KITS[name]["main"]
            code, log = latexmk(folder, main)
            self.assertEqual(code, 0, log[-2000:])
            self.assertTrue((folder / f"{Path(main).stem}.pdf").is_file())
            return log

    def test_the_icml_kit_compiles_unmodified_in_place(self):
        self.assertEqual(undefined(self.compiled("icml2027")), [])

    def test_the_aau_thesis_compiles_unmodified_in_place_with_a_bibliography_per_chapter(self):
        self.assertEqual(undefined(self.compiled("aau-thesis")), [])

    def test_the_fixture_needs_xelatex_and_biber(self):
        if not shutil.which("xelatex") or not shutil.which("biber"):
            self.skipTest("xelatex or biber is not installed")
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp) / "xelatex-biber"
            shutil.copytree(FIXTURE / "xelatex-biber", folder)
            code, log = latexmk(folder, "main.tex", "-xelatex")
            self.assertEqual(code, 0, log[-2000:])
            self.assertEqual(undefined(log), [])
            self.assertTrue((folder / "main.bcf").is_file(), "biber's control file: the bibliography went through biber")
            shutil.rmtree(folder)
            shutil.copytree(FIXTURE / "xelatex-biber", folder)
            code, log = latexmk(folder, "main.tex", "-pdf")
            self.assertNotEqual(code, 0)
            self.assertIn("fontspec", log)

    def test_a_missing_kit_is_said_not_failed(self):
        was = os.environ.get("RFT_KITS")
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["RFT_KITS"] = tmp
            try:
                self.assertIsNone(fetch_kits.kit("icml2027"))
                self.assertIn("python3 tests/fetch_kits.py", fetch_kits.missing("icml2027"))
            finally:
                if was is None:
                    del os.environ["RFT_KITS"]
                else:
                    os.environ["RFT_KITS"] = was


if __name__ == "__main__":
    unittest.main()
