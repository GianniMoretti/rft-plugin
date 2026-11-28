"""The project's figure style (server/rft_style.py; docs/design/figures.md): matplotlib's settings
from the tokens, the helpers that draw the reference's conventions, and how rft_notebook.py puts
the module beside a notebook with the project's tokens.

    python3 -m unittest tests.test_style
"""
import importlib.util
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import rft_notebook  # noqa: E402

try:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np
except ImportError:  # the module's drawing needs matplotlib; its writer does not
    matplotlib = None

PHD = {"text": "#211A52", "accent": "#4D4875", "baseline": "#76818B", "font": "Arial",
       "categorical": ["#4D4875", "#7A72CC", "#AFAAE0"], "ramp": ["#AFAAE0", "#594FBF", "#211A52"]}


def load(tokens, folder):
    """rft_style as a notebook's folder has it, with `tokens` written in."""
    rft_notebook.ensure_style(folder, tokens)
    name = f"rft_style_{abs(hash(json.dumps(tokens, sort_keys=True)))}"
    spec = importlib.util.spec_from_file_location(name, Path(folder) / "rft_style.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class WriterTest(unittest.TestCase):
    def test_the_tokens_written_in_and_only_when_they_change(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertTrue(rft_notebook.ensure_style(d, PHD))
            path = Path(d) / "rft_style.py"
            text = path.read_text()
            line = next(l for l in text.splitlines() if l.startswith("PROJECT: dict = "))
            self.assertEqual(json.loads(re.match(r"PROJECT: dict = (\{.*\})  #", line).group(1)), PHD)
            before = path.stat().st_mtime_ns
            rft_notebook.ensure_style(d, PHD)
            self.assertEqual(path.stat().st_mtime_ns, before)  # the same: not written again
            rft_notebook.ensure_style(d, {})
            self.assertIn("PROJECT: dict = {}  #", path.read_text())

    def test_only_known_tokens_of_text_go_in(self):
        src = rft_notebook.style_source({"accent": "#123456", "evil": "__import__('os')", "ramp": [1, 2], "font": "Inter"})
        line = next(l for l in src.splitlines() if l.startswith("PROJECT: dict = "))
        self.assertIn('"accent": "#123456"', line)
        self.assertIn('"font": "Inter"', line)
        self.assertNotIn("evil", line)
        self.assertNotIn("ramp", line)

    def test_the_project_style_is_the_config_s_whose_vault_it_is(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / ".rft").mkdir()
            (root / "vault").mkdir()
            (root / ".rft" / "config.json").write_text(json.dumps({"vault": "vault", "style": PHD}))
            self.assertEqual(rft_notebook.project_style(root / "vault"), PHD)
            (root / "other").mkdir()
            self.assertEqual(rft_notebook.project_style(root / "other"), {})  # another folder: not this config's vault
            (root / ".rft" / "config.json").write_text(json.dumps({"vault": "vault"}))
            self.assertEqual(rft_notebook.project_style(root / "vault"), {})


@unittest.skipIf(matplotlib is None, "matplotlib is not installed")
class StyleTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(plt.close, "all")
        plt.rcdefaults()

    def test_tokens_left_out_or_invalid_take_the_default(self):
        rs = load({"accent": "#4D4875", "grid": "red", "categorical": ["#111111"], "font": ""}, self.tmp.name)
        self.assertEqual(rs.TOKENS["accent"], "#4D4875")
        self.assertEqual(rs.TOKENS["grid"], rs.DEFAULT["grid"])  # not a colour as #RRGGBB
        self.assertEqual(rs.TOKENS["categorical"], rs.DEFAULT["categorical"])  # one colour is no list of them
        self.assertEqual(rs.TOKENS["font"], rs.DEFAULT["font"])

    def test_use_sets_matplotlib_from_the_tokens_for_each_medium(self):
        rs = load(PHD, self.tmp.name)
        self.assertTrue(rs.use("paper"))
        rc = matplotlib.rcParams
        self.assertEqual(rc["font.size"], 8)
        from matplotlib import font_manager
        have = {f.name for f in font_manager.fontManager.ttflist}
        self.assertEqual(rc["font.sans-serif"][0], "Arial" if "Arial" in have else rc["font.sans-serif"][0])
        self.assertTrue(set(rc["font.sans-serif"]) <= have | {"DejaVu Sans"})  # only fonts it has: no warning at each figure
        self.assertEqual(rc["text.color"], "#211A52")
        self.assertEqual([c.upper() for c in rc["axes.prop_cycle"].by_key()["color"]], PHD["categorical"])
        self.assertFalse(rc["axes.spines.top"] or rc["axes.spines.right"])
        self.assertTrue(rc["savefig.transparent"])
        rs.use("slide")
        self.assertEqual(rc["font.size"], 16)
        with self.assertRaises(ValueError):
            rs.use("poster")

    def test_a_figure_saved_with_a_transparent_background(self):
        rs = load({}, self.tmp.name)
        rs.use()
        fig, ax = rs.figure()
        self.assertEqual([round(x, 2) for x in fig.get_size_inches()], [3.25, 2.3])
        ax.plot([1, 2], [1, 2])
        import io
        buf = io.StringIO()
        fig.savefig(buf, format="svg")
        svg = buf.getvalue()
        self.assertNotRegex(svg, r"fill:\s*#ffffff")  # no white page behind it
        fig2, axes = rs.figure(ncols=3)
        self.assertEqual(len(axes), 3)
        self.assertEqual(round(fig2.get_size_inches()[0], 2), 6.75)  # small multiples are wide

    def test_ramp_light_to_dark_and_colours_in_order(self):
        rs = load(PHD, self.tmp.name)
        self.assertEqual(rs.ramp(3), PHD["ramp"])
        five = rs.ramp(5)
        self.assertEqual((five[0], five[-1], len(five)), ("#AFAAE0", "#211A52", 5))
        self.assertEqual(rs.colors(4), PHD["categorical"] + [PHD["categorical"][0]])

    def test_highlight_greys_the_others_and_keeps_baselines(self):
        rs = load({}, self.tmp.name)
        rs.use()
        fig, ax = rs.figure()
        x = np.arange(5)
        a = rs.band(ax, x, x * 1.0, 0.1, label="Baseline")
        b = rs.band(ax, x, x * 0.8, 0.1, label="CutMix")
        base = rs.baseline(ax, x, x * 0.5, label="SAE")
        rs.reference(ax, 3, "ceiling")
        rs.highlight(ax, "CutMix")
        self.assertEqual(b.get_color(), rs.TOKENS["accent"])
        self.assertEqual(a.get_color(), rs.TOKENS["neutral"])
        self.assertEqual(base.get_color(), rs.TOKENS["baseline"])
        self.assertGreater(b.get_zorder(), a.get_zorder())
        self.assertIn("ceiling", ax.get_legend_handles_labels()[1])  # a reference is named in the legend

    def test_labels_at_the_lines_ends_kept_apart(self):
        rs = load({}, self.tmp.name)
        rs.use()
        fig, ax = rs.figure()
        x = np.arange(10)
        rs.band(ax, x, x * 1.0, label="one")
        rs.band(ax, x, x * 1.0 + 0.01, label="two")  # ending at the same place
        ax.legend()
        labels = rs.label_lines(ax)
        self.assertEqual(sorted(t.get_text() for t in labels), ["one", "two"])
        self.assertIsNone(ax.get_legend())
        fig.canvas.draw()
        y = sorted(t.get_window_extent().y0 for t in labels)
        self.assertGreater(y[1] - y[0], 5)  # apart, not on top of each other

    def test_a_title_with_one_word_in_bold(self):
        rs = load({}, self.tmp.name)
        rs.use()
        fig, ax = rs.figure()
        box = rs.title(ax, "Vanilla", "BSF", color=rs.TOKENS["accent"])
        parts = box.get_child().get_children()
        self.assertEqual([p.get_text() for p in parts], ["Vanilla", "BSF"])
        self.assertEqual([p._text.get_fontweight() for p in parts], ["bold", "normal"])
        self.assertEqual(ax.get_title(), "Vanilla BSF")  # kept invisible, so the layout makes room
        fig.canvas.draw()

    def test_one_legend_below_small_multiples(self):
        rs = load({}, self.tmp.name)
        rs.use()
        fig, axes = rs.figure(ncols=2)
        for ax in axes:
            rs.band(ax, [1, 2], [1, 2], label="K=2")
            rs.baseline(ax, [1, 2], [0, 1], label="SAE")
            ax.legend()
        leg = rs.legend_below(fig)
        self.assertEqual([t.get_text() for t in leg.get_texts()], ["K=2", "SAE"])
        self.assertTrue(all(ax.get_legend() is None for ax in axes))


if __name__ == "__main__":
    unittest.main()
