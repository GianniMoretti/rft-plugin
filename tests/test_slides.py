"""A slide's boxes and lines (docs/design/presentations.md), drawn in headless Chromium at a desktop's size.

The deck tests/fixtures/slides/P02 Annotated figure.md is written by hand: a figure with a text box,
an ellipse and an arrow on it, and a diagram of boxes and lines. This file reads their places from
the deck's text itself (the numbers in its comments, not what the page's parser made of them) and
measures where the page draws them:
  - every box at its x, y, w and h, every line's ends at its from and to, within 1 unit of the
    1920 × 1080 slide, in the slide beside the text, its thumbnail, the presentation and the pages
    the PDF is printed from;
  - a colour named in the text is the project's token; a figure alone in a box fills its width;
  - a box or a line written wrong is listed under the text, and its slide is still drawn.
No script error. It needs Chromium (Playwright's, or RFT_CHROME) and the websocket-client module, and
skips without them. RFT_SLIDES_SHOTS=<dir> also saves a screenshot of each slide and the deck's PDF.

    python3 -m unittest tests.test_slides -v
"""
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_phone import CHROME, ROOT, Browser, demo_vault, page, websocket  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "slides"
DECK = "P02 Annotated figure.md"
WRONG = """---
id: P03
type: deck
locked: false
---

# Written wrong

<!-- line from="100 900" to="900" -->
<!-- line from="100 950" to="900 950" arrow="end" -->

<!-- box x="left" y="200" w="600" fill="coral" -->
still drawn
"""

# --------------------------------------------------------------------------- the deck's text, read here


def slides_of(text: str) -> list[str]:
    """The deck's slides as text, its frontmatter left out (no code block in the fixture)."""
    body = re.sub(r"\A---\n.*?\n---\n", "", text, flags=re.S)
    return re.split(r"^---\s*$", body, flags=re.M)


def placed(slide: str) -> list[dict]:
    """A slide's boxes and lines in the order written: a box's x, y, w and h (None: as high as its text), a line's two ends."""
    out = []
    for m in re.finditer(r"^<!--\s*(box|line)\b(.*?)-->\s*$", slide, flags=re.M):
        o = dict(re.findall(r'([a-z-]+)="([^"]*)"', m.group(2)))
        if m.group(1) == "box":
            out.append({"kind": "box", "x": int(o["x"]), "y": int(o["y"]), "w": int(o["w"]), "h": int(o["h"]) if "h" in o else None, "o": o})
        else:
            out.append({"kind": "line", "from": [int(v) for v in o["from"].split()], "to": [int(v) for v in o["to"].split()], "arrow": o.get("arrow", ""), "o": o})
    return out


# --------------------------------------------------------------------------- the slide as drawn, measured in the page

# The slide `n` drawn in `root`, in the slide's own units: each box's rectangle, each line's ends
# (the tip of its arrow's head where it has one), as the screen has them.
MEASURE = r"""
((root, n) => {
  const slide = document.querySelector(`${root} .slide[data-slide="${n}"]`)
  if (!slide) return null
  const r = slide.getBoundingClientRect(), s = r.width / 1920
  const at = (x, y) => [(x - r.left) / s, (y - r.top) / s]
  return [...slide.querySelectorAll(':scope > [data-item]')].map(el => {
    if (el.matches('.slide-box')) {
      const b = el.getBoundingClientRect(), img = el.querySelector('img')
      const i = img ? img.getBoundingClientRect() : null
      return { kind: 'box', k: +el.dataset.item, rect: [...at(b.left, b.top), b.width / s, b.height / s], text: el.textContent.trim(),
        img: i ? [...at(i.left, i.top), i.width / s, i.height / s] : null,
        border: getComputedStyle(el).borderTopColor, borderWidth: getComputedStyle(el).borderTopWidth, background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }
    }
    const m = el.getScreenCTM(), line = el.querySelector('line'), heads = [...el.querySelectorAll('polygon')]
    const screen = (x, y) => at(m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f)
    return { kind: 'line', k: +el.dataset.item,
      ends: [screen(line.x1.baseVal.value, line.y1.baseVal.value), screen(line.x2.baseVal.value, line.y2.baseVal.value)],
      tips: heads.map(h => screen(h.points[0].x, h.points[0].y)), color: getComputedStyle(line).stroke }
  })
})
"""


def measure(b: Browser, root: str, n: int):
    return b.js(f"{MEASURE}({json.dumps(root)}, {n})")


def rgb(hex_: str) -> str:
    return "rgb(%d, %d, %d)" % tuple(int(hex_[i:i + 2], 16) for i in (1, 3, 5))


@unittest.skipUnless(CHROME and websocket, "needs Chromium (Playwright's, or RFT_CHROME) and websocket-client")
class SlidesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="rft-slides-"))
        vault = cls.tmp / "vault"
        demo_vault(vault)
        shutil.copy(FIXTURES / DECK, vault / "decks" / DECK)
        shutil.copy(FIXTURES / "E08_loss.svg", vault / "decks" / "E08_loss.svg")
        (vault / "decks" / "P03 Written wrong.md").write_text(WRONG)
        cls.slides = slides_of((FIXTURES / DECK).read_text())
        cls.server = subprocess.Popen([sys.executable, str(ROOT / "server" / "rft_server.py"), "--vault", str(vault),
                                       "--web", str(ROOT / "web"), "--port", "0", "--project", "demo", "--no-watch"],
                                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        cls.url = re.search(r"RFT_SERVER_URL (\S+)", cls.server.stdout.readline()).group(1)
        (cls.tmp / "profile").mkdir()
        cls.b = Browser(cls.tmp / "profile")
        cls.b.call("Emulation.setDeviceMetricsOverride", width=1600, height=1000, deviceScaleFactor=1, mobile=False)
        cls.b.open(cls.url)
        cls.b.js(page("slides"))
        cls.tokens = json.loads(cls.b.js("fetch('api/style').then(r => r.text())"))
        cls.shots = os.environ.get("RFT_SLIDES_SHOTS")
        if cls.shots:
            Path(cls.shots).mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        cls.b.close()
        cls.server.terminate()
        cls.server.wait(10)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def open_deck(self, did: str):
        b = self.b
        self.assertTrue(b.wait("document.querySelectorAll('.sl-item').length >= 3"), "the decks are not listed")
        b.js("[...document.querySelectorAll('.sl-item')].find(li => li.querySelector('.sl-id').textContent === %s).click()" % json.dumps(did))
        self.assertTrue(b.wait("document.getElementById('sl-name').textContent.startsWith(%s) && !!document.querySelector('#sl-preview .slide')" % json.dumps(did)), f"{did} did not open")

    def to_slide(self, n: int):
        self.b.js(f"document.querySelectorAll('#sl-thumbs .sl-thumb')[{n - 1}].click()")
        self.assertTrue(self.b.wait(f"!!document.querySelector('#sl-preview .slide[data-slide=\"{n}\"]')"), f"slide {n} is not the one in view")
        # its figures loaded, so a box as high as its figure has its height
        self.b.wait("[...document.querySelectorAll('#sl-preview img, #sl-thumbs img')].every(i => i.complete && i.naturalWidth > 0)")

    def check(self, where: str, n: int, got):
        """What is drawn of slide `n` in `where` is where the deck's text puts it, within 1 unit of the slide."""
        want = placed(self.slides[n - 1])
        self.assertIsNotNone(got, f"{where}: slide {n} is not drawn")
        self.assertEqual([g["kind"] for g in got], [w["kind"] for w in want], f"{where}, slide {n}: what is drawn, in the text's order")
        for k, (w, g) in enumerate(zip(want, got)):
            what = f"{where}, slide {n}, item {k}"
            self.assertEqual(g["k"], k, what)
            if w["kind"] == "box":
                for name, a, e in zip("xywh", g["rect"], (w["x"], w["y"], w["w"], w["h"])):
                    if e is not None:
                        self.assertAlmostEqual(a, e, delta=1, msg=f"{what}: its {name}")
            else:
                starts, ends = w["arrow"] in ("start", "both"), w["arrow"] in ("end", "both")
                self.assertEqual(len(g["tips"]), int(starts) + int(ends), f"{what}: its arrow's heads")
                first = g["tips"][0] if starts else g["ends"][0]
                last = g["tips"][-1] if ends else g["ends"][1]
                for name, a, e in (("from", first, w["from"]), ("to", last, w["to"])):
                    for axis, av, ev in zip("xy", a, e):
                        self.assertAlmostEqual(av, ev, delta=1, msg=f"{what}: its {name}'s {axis}")

    def test_1_where_they_are_drawn(self):
        b = self.b
        self.open_deck("P02")
        for n in (2, 3):
            self.to_slide(n)
            self.check("the slide beside the text", n, measure(b, "#sl-preview", n))
            self.check("the thumbnail", n, measure(b, "#sl-thumbs", n))
            if self.shots:
                b.shot(Path(self.shots) / f"slide-{n}-editor.png")
            b.js("document.getElementById('sl-present').click()")
            self.assertTrue(b.wait(f"!!document.querySelector('#sl-show .slide[data-slide=\"{n}\"]')"), "the presentation did not start")
            b.wait("[...document.querySelectorAll('#sl-show img')].every(i => i.complete && i.naturalWidth > 0)")
            self.check("the presentation", n, measure(b, "#sl-show", n))
            if self.shots:
                b.shot(Path(self.shots) / f"slide-{n}-present.png")
            b.js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))")
            self.assertTrue(b.wait("document.getElementById('sl-show').hidden"), "the presentation did not stop")
        # the pages the PDF is printed from, as the print shows them
        b.js("window.print = () => { window.__printed = true }")
        b.js("document.getElementById('sl-pdf').click()")
        self.assertTrue(b.wait("window.__printed === true"), "the deck was not sent to the printer")
        b.call("Emulation.setEmulatedMedia", media="print")
        try:
            for n in (2, 3):
                self.check("the PDF's page", n, measure(b, "#sl-print", n))
            if self.shots:
                pdf = b.call("Page.printToPDF", printBackground=True, preferCSSPageSize=True)
                (Path(self.shots) / "deck.pdf").write_bytes(base64.b64decode(pdf["data"]))
        finally:
            b.call("Emulation.setEmulatedMedia", media="")
            b.js("window.dispatchEvent(new Event('afterprint'))")
        self.assertEqual(b.errors, [])

    def test_2_colours_and_figures(self):
        b = self.b
        self.open_deck("P02")
        self.to_slide(2)
        text, ellipse, arrow = measure(b, "#sl-preview", 2)
        contrast = rgb(self.tokens["contrast"])
        self.assertEqual(text["text"], "gap closes here")
        self.assertEqual(text["color"], contrast)
        self.assertEqual((ellipse["border"], ellipse["borderWidth"]), (contrast, "4px"))
        self.assertEqual(arrow["color"], contrast)
        self.to_slide(3)
        got = measure(b, "#sl-preview", 3)
        want = placed(self.slides[2])
        box = got[0]
        self.assertEqual((box["background"], box["border"], box["text"]), (rgb(self.tokens["fill"]), rgb(self.tokens["accent"]), "Encoder"))
        figure = next(g for g, w in zip(got, want) if w["kind"] == "box" and w["h"] is None)
        # the figure fills its box's width inside the outline (2 units a side), its proportions kept (800 × 500)
        x, y, w, h = figure["img"]
        self.assertAlmostEqual(w, figure["rect"][2] - 4, delta=1)
        self.assertAlmostEqual(h, w * 500 / 800, delta=1)
        self.assertAlmostEqual(figure["rect"][3], h + 4, delta=1)
        filled = next(g for g in got if g["kind"] == "box" and g["text"] == "a filled ellipse")
        self.assertEqual((filled["background"], filled["color"]), (rgb(self.tokens["categorical"][2]), "rgb(255, 255, 255)"))
        self.assertEqual(b.errors, [])

    def test_3_written_wrong(self):
        b = self.b
        self.open_deck("P03")
        self.assertTrue(b.wait("!document.getElementById('sl-problems').hidden"), "nothing is said to be wrong")
        said = b.js("[...document.querySelectorAll('#sl-problems div')].map(d => d.textContent)")
        self.assertEqual([s.split(": ")[0] for s in said], ["slide 1, line 9"] + ["slide 1, line 12"] * 3)
        self.assertIn('to="900" is no point', said[0])
        self.assertIn('x="left" is no whole number', said[1])
        self.assertIn('no colour "coral"', said[2])
        self.assertIn("this box is not closed", said[3])
        got = measure(b, "#sl-preview", 1)
        # the line with no place left out, the one after it drawn, the box at the slide's left edge
        self.assertEqual([(g["kind"], g["k"]) for g in got], [("line", 1), ("box", 2)])
        self.assertEqual(got[1]["text"], "still drawn")
        self.assertAlmostEqual(got[1]["rect"][0], 0, delta=1)
        self.assertAlmostEqual(got[1]["rect"][1], 200, delta=1)
        self.assertEqual(b.errors, [])


if __name__ == "__main__":
    unittest.main()
