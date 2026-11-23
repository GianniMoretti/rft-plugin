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


# --------------------------------------------------------------------------- the slide tools: real drags and keys

ALT, CTRL, SHIFT = 1, 2, 8
KEYS = {"ArrowLeft": ("ArrowLeft", 37), "ArrowUp": ("ArrowUp", 38), "ArrowRight": ("ArrowRight", 39), "ArrowDown": ("ArrowDown", 40),
        "Delete": ("Delete", 46), "Escape": ("Escape", 27), "Enter": ("Enter", 13), "z": ("KeyZ", 90), "y": ("KeyY", 89), "d": ("KeyD", 68),
        "c": ("KeyC", 67), "x": ("KeyX", 88), "v": ("KeyV", 86), "a": ("KeyA", 65), "b": ("KeyB", 66), "i": ("KeyI", 73),
        "]": ("BracketRight", 221), "[": ("BracketLeft", 219)}
ITEM = re.compile(r"^<!--[ \t]*(?:box|line)\b.*-->[ \t]*$", re.M)
OPT = re.compile(r'([a-z-]+)="([^"]*)"')


def item_line(text: str, n: int, k: int) -> str:
    """The comment line of slide `n`'s box or line `k`, as written."""
    return ITEM.findall(slides_of(text)[n - 1])[k]


class Tools(unittest.TestCase):
    """What the tests of the slide tools share: a deck of their own (the fixture, as P04), the mouse and the keys."""

    ID, NAME = "P04", "P04 Round trip.md"

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="rft-slides-"))
        vault = cls.tmp / "vault"
        demo_vault(vault)
        cls.orig = (FIXTURES / DECK).read_text().replace("id: P02", f"id: {cls.ID}")
        cls.file = vault / "decks" / cls.NAME
        cls.file.write_text(cls.orig)
        shutil.copy(FIXTURES / "E08_loss.svg", vault / "decks" / "E08_loss.svg")
        cls.vault = vault
        cls.server = subprocess.Popen([sys.executable, str(ROOT / "server" / "rft_server.py"), "--vault", str(vault),
                                       "--web", str(ROOT / "web"), "--port", "0", "--project", "demo", "--no-watch"],
                                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        cls.url = re.search(r"RFT_SERVER_URL (\S+)", cls.server.stdout.readline()).group(1)
        (cls.tmp / "profile").mkdir()
        cls.b = Browser(cls.tmp / "profile")
        cls.b.call("Emulation.setDeviceMetricsOverride", width=1600, height=1000, deviceScaleFactor=1, mobile=False)
        cls.b.open(cls.url)
        cls.b.js(page("slides"))
        cls.shots = os.environ.get("RFT_SLIDES_SHOTS")
        if cls.shots:
            Path(cls.shots).mkdir(parents=True, exist_ok=True)

    @classmethod
    def tearDownClass(cls):
        cls.b.close()
        cls.server.terminate()
        cls.server.wait(10)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # ---- the deck

    CM = "document.querySelector('#sl-cm .CodeMirror').CodeMirror"

    def text(self) -> str:
        return self.b.js(f"{self.CM}.getValue()")

    def start(self, n: int, text: str | None = None):
        """The deck open with its text as it was first (or `text`), nothing to undo, slide `n` in view."""
        b = self.b
        self.assertTrue(b.wait("document.querySelectorAll('.sl-item').length >= 2"), "the decks are not listed")
        if not b.js(f"document.getElementById('sl-name').textContent.startsWith('{self.ID}')"):
            b.js(f"[...document.querySelectorAll('.sl-item')].find(li => li.querySelector('.sl-id').textContent === '{self.ID}').click()")
        self.assertTrue(b.wait(f"document.getElementById('sl-name').textContent.startsWith('{self.ID}') && !!document.querySelector('#sl-preview .slide')"), "the deck did not open")
        want = self.orig if text is None else text
        b.js(f"(() => {{ const cm = {self.CM}; cm.setValue({json.dumps(want)}); cm.clearHistory() }})()")
        slides = len(slides_of(want))
        self.assertTrue(b.wait(f"document.querySelectorAll('#sl-thumbs .sl-thumb').length === {slides}"))
        self.to(n)

    def to(self, n: int):
        b = self.b
        b.js(f"document.querySelectorAll('#sl-thumbs .sl-thumb')[{n - 1}].click()")
        self.assertTrue(b.wait(f"!!document.querySelector('#sl-preview .slide[data-slide=\"{n}\"]') && !!document.querySelector('#sl-preview .sl-edit')"), f"slide {n} is not the one in view, with its tools")
        b.wait("[...document.querySelectorAll('#sl-preview img')].every(i => i.complete && i.naturalWidth > 0)")
        self.n = n
        self.left, self.top, self.scale = b.js("(() => { const r = document.querySelector('#sl-preview .slide').getBoundingClientRect(); return [r.left, r.top, r.width / 1920] })()")

    def items(self, text: str | None = None):
        return placed(slides_of(self.text() if text is None else text)[self.n - 1])

    def drawn(self):
        return measure(self.b, "#sl-preview", self.n)

    # ---- the mouse and the keys

    def px(self, x: float, y: float):
        """A point of the slide, in its units, on the screen."""
        return self.left + x * self.scale, self.top + y * self.scale

    def mouse(self, kind: str, x: float, y: float, modifiers=0, down=False):
        self.b.call("Input.dispatchMouseEvent", type=kind, x=x, y=y, button="none" if kind == "mouseMoved" and not down else "left",
                    buttons=1 if down or kind == "mousePressed" else 0, clickCount=0 if kind == "mouseMoved" else 1, modifiers=modifiers)

    def click(self, x: float, y: float, modifiers=0):
        """A click at a point of the slide (its units)."""
        sx, sy = self.px(x, y)
        self.mouse("mouseMoved", sx, sy, modifiers)
        self.mouse("mousePressed", sx, sy, modifiers)
        self.mouse("mouseReleased", sx, sy, modifiers)

    def drag(self, sx: float, sy: float, dx: float, dy: float, modifiers=0, release=True):
        """A press at a point of the screen, the mouse moved by `dx`, `dy` pixels in steps, and let go."""
        self.mouse("mouseMoved", sx, sy, modifiers)
        self.mouse("mousePressed", sx, sy, modifiers)
        for i in range(1, 7):
            self.mouse("mouseMoved", sx + dx * i / 6, sy + dy * i / 6, modifiers, down=True)
        if release:
            self.mouse("mouseReleased", sx + dx, sy + dy, modifiers)

    def handle(self, h: str):
        """The middle of a handle of the one selected, on the screen."""
        got = self.b.js("(() => { const el = document.querySelector('#sl-preview .sl-handle[data-h=%s]'); if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()" % json.dumps(h))
        self.assertIsNotNone(got, f"no handle {h}: nothing is selected")
        return got

    def key(self, key: str, modifiers=0, commands=None):
        code, vk = KEYS[key]
        extra = {"commands": commands} if commands else {}
        self.b.call("Input.dispatchKeyEvent", type="rawKeyDown", key=key, code=code, windowsVirtualKeyCode=vk, modifiers=modifiers, **extra)
        self.b.call("Input.dispatchKeyEvent", type="keyUp", key=key, code=code, windowsVirtualKeyCode=vk, modifiers=modifiers)

    def selected(self):
        return self.b.js("[...document.querySelectorAll('#sl-preview .sl-frame, #sl-preview circle.sl-handle[data-h=a]')].length")

    # ---- what an action may change

    def changed(self, before: str, k: int, want: dict, tol=1.0):
        """The deck's text is `before` with these options of the slide's box or line `k` changed and nothing else:
        each within `tol` of its value (a number, or a point), an option it had not put where it belongs."""
        after = self.text()
        old = item_line(before, self.n, k)
        got = dict(OPT.findall(item_line(after, self.n, k)))
        line = old
        for name, value in want.items():
            self.assertIn(name, got, f"{name} is not written: {item_line(after, self.n, k)}")
            values = [int(v) for v in got[name].split()]
            for a, e in zip(values, value if isinstance(value, (list, tuple)) else [value]):
                self.assertAlmostEqual(a, e, delta=tol, msg=f"{name} of {item_line(after, self.n, k)}")
            if re.search(rf'\s{name}="', line):
                line = re.sub(rf'(\s{name}=)"[^"]*"', rf'\1"{got[name]}"', line)
            else:
                self.assertEqual(name, "h", "only a height is added by a drag")
                line = re.sub(r'(\sw="[^"]*")', rf'\1 h="{got[name]}"', line)
        self.assertEqual(after, before.replace(old, line), "every other byte of the deck as it was")
        return got


@unittest.skipUnless(CHROME and websocket, "needs Chromium (Playwright's, or RFT_CHROME) and websocket-client")
class RoundTripTest(Tools):
    """Each action of the tools gives a text that, drawn again, has the box or line where it was dropped, and that differs from the text before in nothing else."""

    def test_1_a_box_moved_and_the_move_undone(self):
        b = self.b
        self.start(2)
        before = self.text()
        box = self.items()[0]
        was = self.drawn()[0]["rect"]
        sx, sy = self.px(box["x"] + box["w"] / 2, box["y"] + 20)
        dx, dy = -83.25, 41.5
        self.drag(sx, sy, dx, dy, ALT)
        self.changed(before, 0, {"x": box["x"] + dx / self.scale, "y": box["y"] + dy / self.scale})
        # drawn again from the text within a pixel of where it was dropped
        now = self.drawn()[0]["rect"]
        self.assertAlmostEqual((now[0] - was[0]) * self.scale, dx, delta=1)
        self.assertAlmostEqual((now[1] - was[1]) * self.scale, dy, delta=1)
        self.assertEqual(self.selected(), 1)
        if self.shots:
            b.shot(Path(self.shots) / "tools-selected.png")
        # the editor's cursor is in its text
        line = b.js(f"{self.CM}.getLine({self.CM}.getCursor().line)")
        self.assertEqual(line, item_line(self.text(), 2, 0))
        # one drag is one step of the editor's history
        self.key("z", CTRL)
        self.assertEqual(self.text(), before)
        self.key("z", CTRL | SHIFT)
        self.changed(before, 0, {"x": box["x"] + dx / self.scale, "y": box["y"] + dy / self.scale})
        # and it is saved as the text is
        self.assertTrue(b.wait("document.getElementById('sl-status').textContent === 'Saved'"), "the deck was not saved")
        self.assertEqual(self.file.read_text(), self.text())
        self.assertEqual(b.errors, [])

    def test_2_handles(self):
        self.start(2)
        # a shape with nothing in it is taken by its outline
        ellipse = self.items()[1]
        self.click(ellipse["x"] + ellipse["w"] / 2, ellipse["y"] + ellipse["h"] / 2)
        self.assertEqual(self.selected(), 0, "a hollow shape is not taken by its middle")
        self.click(ellipse["x"] + ellipse["w"] / 2, ellipse["y"])
        self.assertEqual(self.selected(), 1)
        before = self.text()
        self.drag(*self.handle("se"), 40.5, 25.25, ALT)
        self.changed(before, 1, {"w": ellipse["w"] + 40.5 / self.scale, "h": ellipse["h"] + 25.25 / self.scale})
        before, ellipse = self.text(), self.items()[1]
        self.drag(*self.handle("nw"), -20, 10, ALT)
        d = (-20 / self.scale, 10 / self.scale)
        self.changed(before, 1, {"x": ellipse["x"] + d[0], "y": ellipse["y"] + d[1], "w": ellipse["w"] - d[0], "h": ellipse["h"] - d[1]})
        drawn = self.drawn()[1]["rect"]
        now = self.items()[1]
        for a, e in zip(drawn, (now["x"], now["y"], now["w"], now["h"])):
            self.assertAlmostEqual(a, e, delta=1)

        # a box as high as its text: its side changes its width only; its bottom gives it a height
        box = self.items()[0]
        self.click(box["x"] + box["w"] / 2, box["y"] + 20)
        before = self.text()
        self.drag(*self.handle("e"), 30, 12, ALT)
        got = self.changed(before, 0, {"w": box["w"] + 30 / self.scale})
        self.assertNotIn("h", got)
        before = self.text()
        high = self.drawn()[0]["rect"][3]
        self.drag(*self.handle("s"), 5, 45, ALT)
        self.changed(before, 0, {"h": high + 45 / self.scale})
        self.assertAlmostEqual(self.drawn()[0]["rect"][3], high + 45 / self.scale, delta=1)

        # a line by its ends, and as a whole
        line = self.items()[2]
        mid = ((line["from"][0] + line["to"][0]) / 2, (line["from"][1] + line["to"][1]) / 2)
        self.click(*mid)
        before = self.text()
        self.drag(*self.handle("b"), 33, -21, ALT)
        self.changed(before, 2, {"to": [line["to"][0] + 33 / self.scale, line["to"][1] - 21 / self.scale]})
        before, line = self.text(), self.items()[2]
        mid = ((line["from"][0] + line["to"][0]) / 2, (line["from"][1] + line["to"][1]) / 2)
        self.drag(*self.px(*mid), 50, 30, ALT)
        d = (50 / self.scale, 30 / self.scale)
        got = self.changed(before, 2, {"from": [line["from"][0] + d[0], line["from"][1] + d[1]], "to": [line["to"][0] + d[0], line["to"][1] + d[1]]})
        # moved as one: both ends by the same whole numbers
        f, t = [int(v) for v in got["from"].split()], [int(v) for v in got["to"].split()]
        self.assertEqual((f[0] - line["from"][0], f[1] - line["from"][1]), (t[0] - line["to"][0], t[1] - line["to"][1]))
        tips = self.drawn()[2]["tips"]
        self.assertAlmostEqual(tips[0][0], t[0], delta=1)
        self.assertAlmostEqual(tips[0][1], t[1], delta=1)
        self.assertEqual(self.b.errors, [])

    def test_3_a_figure_keeps_its_proportions(self):
        self.start(3)
        k = next(i for i, it in enumerate(self.items()) if it["kind"] == "box" and it["h"] is None)
        fig = self.items()[k]
        self.click(fig["x"] + fig["w"] / 2, fig["y"] + 60)
        before = self.text()
        self.drag(*self.handle("se"), 60, 0, ALT)
        got = self.changed(before, k, {"w": fig["w"] + 60 / self.scale})
        self.assertNotIn("h", got, "a figure's box takes no height: it follows the figure's")
        img = self.drawn()[k]["img"]
        self.assertAlmostEqual(img[2] / img[3], 800 / 500, delta=0.01)
        # by its bottom: the width follows
        before, fig = self.text(), self.items()[k]
        high = self.drawn()[k]["rect"][3]
        self.drag(*self.handle("s"), 0, -30, ALT)
        got = self.changed(before, k, {"w": fig["w"] * (high - 30 / self.scale) / high}, tol=2)
        self.assertNotIn("h", got)
        self.assertEqual(self.b.errors, [])

    def test_4_keys(self):
        self.start(2)
        before = self.text()
        box = self.items()[0]
        self.click(box["x"] + box["w"] / 2, box["y"] + 20)
        for _ in range(3):
            self.key("ArrowRight")
        self.key("ArrowDown", SHIFT)
        self.key("ArrowLeft")
        self.changed(before, 0, {"x": box["x"] + 2, "y": box["y"] + 10}, tol=0)
        # Ctrl+D: a copy beside it, in front of the others, before the notes, and selected
        before = self.text()
        self.key("d", CTRL)
        old = item_line(before, 2, 0)
        copy = old.replace(f'x="{box["x"] + 2}" y="{box["y"] + 10}"', f'x="{box["x"] + 22}" y="{box["y"] + 30}"')
        self.assertEqual(self.text(), before.replace("\n\nnote:", f"\n\n{copy}\ngap closes here\n<!-- /box -->\n\nnote:"))
        self.assertEqual([g["k"] for g in self.drawn()], [0, 1, 2, 3])
        line = self.b.js(f"{self.CM}.getLine({self.CM}.getCursor().line)")
        self.assertEqual(line, copy, "the copy is the one selected")
        # Delete removes it, with the blank line it leaves
        self.key("Delete")
        self.assertEqual(self.text(), before)
        self.assertEqual(self.selected(), 0)
        # Ctrl+]: in front of the next one, their lines changing places
        self.click(box["x"] + 2 + box["w"] / 2, box["y"] + 30)
        self.key("]", CTRL)
        a, e = "\n".join([item_line(before, 2, 0), "gap closes here", "<!-- /box -->"]), "\n".join([item_line(before, 2, 1), "<!-- /box -->"])
        self.assertEqual(self.text(), before.replace(a, "@").replace(e, a).replace("@", e))
        self.assertEqual(self.drawn()[1].get("text"), "gap closes here")
        self.assertEqual(self.selected(), 1)
        self.key("[", CTRL)
        self.assertEqual(self.text(), before)
        self.key("Escape")
        self.assertEqual(self.selected(), 0)
        self.assertEqual(self.b.errors, [])

    def test_5_copied_as_text_to_another_slide(self):
        self.start(2)
        before = self.text()
        line = self.items()[2]
        self.click((line["from"][0] + line["to"][0]) / 2, (line["from"][1] + line["to"][1]) / 2)
        self.assertEqual(self.selected(), 1)
        self.key("c", CTRL, ["copy"])
        self.to(3)
        self.b.js("document.getElementById('sl-preview').focus()")
        self.key("v", CTRL, ["paste"])
        arrow = item_line(before, 2, 2)
        self.assertTrue(self.b.wait(f"{self.CM}.getValue().endsWith({json.dumps(arrow)} + '\\n')"), f"not pasted: {self.text()[-200:]!r}")
        self.assertEqual(self.text(), before.rstrip("\n") + "\n\n" + arrow + "\n")
        # cut takes it away again
        self.key("x", CTRL, ["cut"])
        self.assertEqual(self.text(), before)
        # pasted where it was copied from, it lies beside the one it copies
        self.to(2)
        self.b.js("document.getElementById('sl-preview').focus()")
        self.key("v", CTRL, ["paste"])
        f, t = line["from"], line["to"]
        beside = arrow.replace(f'from="{f[0]} {f[1]}" to="{t[0]} {t[1]}"', f'from="{f[0] + 20} {f[1] + 20}" to="{t[0] + 20} {t[1] + 20}"')
        self.assertEqual(self.text(), before.replace("\n\nnote:", f"\n\n{beside}\n\nnote:"))
        self.assertEqual(self.b.errors, [])

    def test_6_snapping_and_the_edge(self):
        self.start(2)
        before = self.text()
        box = self.items()[0]
        sx, sy = self.px(box["x"] + box["w"] / 2, box["y"] + 20)
        # dropped 2 pixels short of the slide's middle, and 1 below the line's end: it goes to both
        line = self.items()[2]
        dx = (960 - (box["x"] + box["w"] / 2)) * self.scale + 2
        dy = (line["from"][1] - box["y"]) * self.scale + 1
        self.drag(sx, sy, dx, dy, release=False)
        self.assertEqual(self.b.js("document.querySelectorAll('#sl-preview .sl-guide').length"), 2, "the guides it is snapped to are shown")
        self.mouse("mouseReleased", sx + dx, sy + dy)
        self.changed(before, 0, {"x": 960 - box["w"] // 2, "y": line["from"][1]}, tol=0)
        self.assertEqual(self.b.js("document.querySelectorAll('#sl-preview .sl-guide').length"), 0)
        # with Alt it stays where it is dropped
        self.start(2)
        self.drag(sx, sy, dx, dy, ALT)
        got = self.changed(before, 0, {"x": box["x"] + dx / self.scale, "y": box["y"] + dy / self.scale})
        self.assertNotEqual((int(got["x"]), int(got["y"])), (960 - box["w"] // 2, line["from"][1]))
        # dragged off the slide, 40 units of it stay on
        self.start(2)
        self.drag(sx, sy, -1200, 0, ALT)
        self.changed(before, 0, {"x": 40 - box["w"]}, tol=0)
        self.start(2)
        self.drag(sx, sy, 0, 900, ALT)
        self.changed(before, 0, {"y": 1080 - 40}, tol=0)
        self.assertEqual(self.b.errors, [])

    def test_7_the_text_edited_by_hand_while_a_box_is_selected(self):
        b = self.b
        self.start(2)
        box = self.items()[0]
        self.click(box["x"] + box["w"] / 2, box["y"] + 20)
        self.assertEqual(self.selected(), 1)
        before = self.text()
        # typed in the editor: its text, then a new line above it
        b.js(f"(() => {{ const cm = {self.CM}; const l = cm.getCursor().line + 1; cm.replaceRange(' for good', {{ line: l, ch: cm.getLine(l).length }}) }})()")
        b.js(f"{self.CM}.replaceRange('A line typed above\\n\\n', {{ line: {self.CM}.getCursor().line - 2, ch: 0 }})")
        self.assertEqual(self.text(), before.replace("gap closes here", "gap closes here for good").replace("Three seeds, mean and spread", "A line typed above\n\nThree seeds, mean and spread"))
        drawn = self.drawn()
        self.assertEqual(drawn[0]["text"], "gap closes here for good")
        self.assertEqual(self.selected(), 1, "it is still the one selected")
        frame = b.js("(() => { const f = document.querySelector('#sl-preview .sl-frame'); return [f.x.baseVal.value, f.y.baseVal.value, f.width.baseVal.value] })()")
        self.assertEqual(frame, [box["x"], box["y"], box["w"]])
        # the cursor put in a line's text selects the line on the slide
        at = self.text().split("\n").index(item_line(self.text(), 2, 2))
        b.js(f"(() => {{ const cm = {self.CM}; cm.focus(); cm.setCursor({{ line: {at}, ch: 3 }}) }})()")
        self.assertEqual(b.js("document.querySelectorAll('#sl-preview circle.sl-handle').length"), 2)
        self.assertEqual(b.js("document.querySelectorAll('#sl-preview .sl-frame').length"), 0)
        self.assertEqual(b.errors, [])

    def test_8_the_text_hidden(self):
        b = self.b
        self.start(2)
        wide = self.scale
        b.js("document.querySelector('#sl-tools [data-tool=text]').click()")
        self.assertTrue(b.wait("getComputedStyle(document.querySelector('#slides .ms-editor')).display === 'none'"))
        self.assertTrue(b.wait(f"document.querySelector('#sl-preview .slide').getBoundingClientRect().width > {wide * 1920 * 1.5}"), "the slide takes the text's room")
        self.to(2)
        before = self.text()
        box = self.items()[0]
        self.drag(*self.px(box["x"] + box["w"] / 2, box["y"] + 20), 50, 20, ALT)
        self.changed(before, 0, {"x": box["x"] + 50 / self.scale, "y": box["y"] + 20 / self.scale})
        b.js("document.querySelector('#sl-tools [data-tool=text]').click()")
        self.assertTrue(b.wait("getComputedStyle(document.querySelector('#slides .ms-editor')).display !== 'none'"))
        self.assertEqual(b.errors, [])


if __name__ == "__main__":
    unittest.main()
