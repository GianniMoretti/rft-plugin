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
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import procs  # noqa: E402
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
        cls.tmp = procs.folder("rft-slides-")
        cls.addClassCleanup(shutil.rmtree, cls.tmp, True)
        vault = cls.tmp / "vault"
        demo_vault(vault)
        shutil.copy(FIXTURES / DECK, vault / "decks" / DECK)
        shutil.copy(FIXTURES / "E08_loss.svg", vault / "decks" / "E08_loss.svg")
        (vault / "decks" / "P03 Written wrong.md").write_text(WRONG)
        cls.slides = slides_of((FIXTURES / DECK).read_text())
        cls.server = procs.start([sys.executable, str(ROOT / "server" / "rft_server.py"), "--vault", str(vault),
                                  "--web", str(ROOT / "web"), "--port", "0", "--project", "demo", "--no-watch"],
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        cls.addClassCleanup(procs.stop, cls.server)
        cls.url = re.search(r"RFT_SERVER_URL (\S+)", cls.server.stdout.readline()).group(1)
        (cls.tmp / "profile").mkdir()
        cls.b = Browser(cls.tmp / "profile")
        cls.addClassCleanup(cls.b.close)
        cls.b.call("Emulation.setDeviceMetricsOverride", width=1600, height=1000, deviceScaleFactor=1, mobile=False)
        cls.b.open(cls.url)
        cls.b.js(page("slides"))
        cls.tokens = json.loads(cls.b.js("fetch('api/style').then(r => r.text())"))
        cls.shots = os.environ.get("RFT_SLIDES_SHOTS")
        if cls.shots:
            Path(cls.shots).mkdir(parents=True, exist_ok=True)

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
        cls.tmp = procs.folder("rft-slides-")
        cls.addClassCleanup(shutil.rmtree, cls.tmp, True)
        vault = cls.tmp / "vault"
        demo_vault(vault)
        cls.orig = (FIXTURES / DECK).read_text().replace("id: P02", f"id: {cls.ID}")
        cls.file = vault / "decks" / cls.NAME
        cls.file.write_text(cls.orig)
        shutil.copy(FIXTURES / "E08_loss.svg", vault / "decks" / "E08_loss.svg")
        cls.vault = vault
        cls.server = procs.start([sys.executable, str(ROOT / "server" / "rft_server.py"), "--vault", str(vault),
                                  "--web", str(ROOT / "web"), "--port", "0", "--project", "demo", "--no-watch"],
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        cls.addClassCleanup(procs.stop, cls.server)
        cls.url = re.search(r"RFT_SERVER_URL (\S+)", cls.server.stdout.readline()).group(1)
        (cls.tmp / "profile").mkdir()
        cls.b = Browser(cls.tmp / "profile")
        cls.addClassCleanup(cls.b.close)
        cls.b.call("Emulation.setDeviceMetricsOverride", width=1600, height=1000, deviceScaleFactor=1, mobile=False)
        cls.b.open(cls.url)
        cls.b.js(page("slides"))
        cls.shots = os.environ.get("RFT_SLIDES_SHOTS")
        if cls.shots:
            Path(cls.shots).mkdir(parents=True, exist_ok=True)

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

    pressed = (0.0, 0.0, 0.0)  # the last press: when and where

    def mouse(self, kind: str, x: float, y: float, modifiers=0, down=False):
        if kind == "mousePressed":
            # two presses at one point are two clicks, not a double click: half a second apart
            t, px, py = Tools.pressed
            if abs(px - x) < 6 and abs(py - y) < 6 and time.time() - t < 0.5:
                time.sleep(0.5 - (time.time() - t))
            Tools.pressed = (time.time(), x, y)
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
        return self.b.js("[...document.querySelectorAll('#sl-preview .sl-frame:not(.sl-slot-frame):not(.sl-drop), #sl-preview circle.sl-handle[data-h=a]')].length")

    def slot(self, name: str):
        """Where a slot is drawn, in the slide's units: x, y, w, h."""
        got = self.b.js("(() => { const s = document.querySelector('#sl-preview .slide'), el = s.querySelector('[data-slot=%s]'); if (!el) return null;"
                        " const r = s.getBoundingClientRect(), b = el.getBoundingClientRect(), k = r.width / 1920; return [(b.left - r.left) / k, (b.top - r.top) / k, b.width / k, b.height / k] })()" % name)
        self.assertIsNotNone(got, f"the slide has no slot {name}")
        return got

    def slot_selected(self):
        """The slot selected on the slide, by its place (x, y), or None."""
        return self.b.js("(() => { const f = document.querySelector('#sl-preview .sl-slot-frame'); return f ? [f.x.baseVal.value, f.y.baseVal.value] : null })()")

    def twice(self, x: float, y: float):
        """A double click at a point of the slide (its units)."""
        at = self.px(x, y)
        self.mouse("mouseMoved", *at)
        for n in (1, 2):
            self.b.call("Input.dispatchMouseEvent", type="mousePressed", x=at[0], y=at[1], button="left", buttons=1, clickCount=n)
            self.b.call("Input.dispatchMouseEvent", type="mouseReleased", x=at[0], y=at[1], button="left", buttons=0, clickCount=n)
        Tools.pressed = (0.0, 0.0, 0.0)

    def press(self, selector: str):
        """A real click in the middle of an element of the page."""
        at = self.b.js("(() => { const el = document.querySelector(%s); if (!el) return null; const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()" % json.dumps(selector))
        self.assertIsNotNone(at, f"nothing at {selector}")
        self.mouse("mouseMoved", *at)
        self.mouse("mousePressed", *at)
        self.mouse("mouseReleased", *at)

    def tool(self, name: str):
        self.press(f"#sl-tools [data-tool={name}]")

    def colour(self, tool: str, name: str):
        """A colour taken from a tool's swatches."""
        self.tool(tool)
        self.press(f"#sl-tools .sl-menu [data-color=\"{name}\"]")

    def choose(self, tool: str, value: str):
        """A value chosen in one of the bar's lists (its own pop-up is the browser's, not the page's)."""
        self.b.js("(() => { const s = document.querySelector('#sl-tools [data-tool=%s]'); s.value = %s; s.dispatchEvent(new Event('change', { bubbles: true })) })()" % (tool, json.dumps(value)))

    def type(self, text: str):
        self.b.call("Input.insertText", text=text)

    def draw(self, tool: str, a, b, modifiers=ALT):
        """A tool that adds, dragged on the slide from point `a` to point `b` (the slide's units)."""
        self.tool(tool)
        sx, sy = self.px(*a)
        ex, ey = self.px(*b)
        self.drag(sx, sy, ex - sx, ey - sy, modifiers)

    def source(self):
        """The Markdown open over a box, or None."""
        return self.b.js("(() => { const t = document.querySelector('#sl-preview .sl-source'); return t ? t.value : null })()")

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


def without_items(text: str, n: int) -> str:
    """A deck's text with slide `n`'s boxes and lines taken out, each with the blank line after it."""
    slides = re.split(r"(^---[ \t]*$)", re.sub(r"\A---\n.*?\n---\n", "", text, flags=re.S), flags=re.M)
    front = text[:len(text) - len("".join(slides))]
    body = slides[2 * (n - 1)]
    body = re.sub(r"^<!--[ \t]*box\b.*?^<!--[ \t]*/box[ \t]*-->[ \t]*\n\n?", "", body, flags=re.M | re.S)
    body = re.sub(r"^<!--[ \t]*line\b.*-->[ \t]*\n\n?", "", body, flags=re.M)
    slides[2 * (n - 1)] = body
    return front + "".join(slides)


@unittest.skipUnless(CHROME and websocket, "needs Chromium (Playwright's, or RFT_CHROME) and websocket-client")
class BuildTest(Tools):
    """Boxes and lines added and styled with the tools, and a box's Markdown edited over it."""

    ID, NAME = "P05", "P05 Built.md"

    def test_1_scenario_b_built_with_the_tools_is_the_text_written_by_hand(self):
        b = self.b
        bare = without_items(self.orig, 2)
        self.assertNotIn("<!-- box", slides_of(bare)[1])
        self.assertIn("<!-- box", slides_of(bare)[2])
        self.start(2, bare)
        want = placed(slides_of(self.orig)[1])
        text, ellipse, arrow = want
        # a box of text: dragged out to its width, typed, coloured, sized
        self.draw("addText", (text["x"], text["y"]), (text["x"] + text["w"], text["y"] + 70))
        self.assertEqual(self.source(), "Text", "its Markdown is open over it")
        self.type("gap closes here")
        self.key("Escape")
        self.assertIsNone(self.source())
        self.colour("color", "contrast")
        self.press("#sl-tools [data-tool=size]")
        self.type("40")
        self.key("Enter")
        # an ellipse around the point, its outline coloured and weighted
        self.draw("ellipse", (ellipse["x"], ellipse["y"]), (ellipse["x"] + ellipse["w"], ellipse["y"] + ellipse["h"]))
        self.colour("outline", "contrast")
        self.choose("weight", "thick")
        self.choose("weight", "medium")
        # an arrow from the text to it
        self.draw("arrow", arrow["from"], arrow["to"])
        self.colour("outline", "contrast")
        self.assertEqual(self.text(), self.orig)
        if self.shots:
            b.shot(Path(self.shots) / "scenario-b-built.png")
        # each of those was one step: the arrow's colour, the arrow
        self.key("z", CTRL)
        self.key("z", CTRL)
        self.assertEqual(self.text(), without_items(self.orig, 2).replace("\n\nnote:", "\n\n" + "\n\n".join(
            "\n".join(blk) for blk in ([item_line(self.orig, 2, 0), "gap closes here", "<!-- /box -->"], [item_line(self.orig, 2, 1), "<!-- /box -->"])) + "\n\nnote:"))
        self.assertEqual(b.errors, [])

    def test_2_a_click_adds_at_the_usual_size_and_a_shape_takes_a_label(self):
        b = self.b
        bare = without_items(self.orig, 2)
        self.start(2, bare)
        self.tool("rect")
        self.assertEqual(b.js("document.querySelector('#sl-tools [data-tool=rect]').getAttribute('aria-pressed')"), "true")
        self.click(400, 300, ALT)
        made = '<!-- box x="240" y="200" w="320" h="200" outline="text" -->'
        self.assertEqual(self.text(), bare.replace("\n\nnote:", f"\n\n{made}\n<!-- /box -->\n\nnote:"))
        self.assertEqual(b.js("document.querySelector('#sl-tools [data-tool=rect]').getAttribute('aria-pressed')"), "false", "the tool is put down once used")
        self.assertEqual(self.selected(), 1)
        # filled with a token's colour, then with one of your own
        self.colour("fill", "fill")
        self.assertIn('h="200" fill="fill" outline="text"', self.text())
        self.tool("fill")
        self.press("#sl-tools .sl-menu .sl-hex")
        self.type("#E4E3F5")
        self.key("Enter")
        self.assertIn('h="200" fill="#E4E3F5" outline="text"', self.text())
        self.assertEqual(self.drawn()[0]["background"], "rgb(228, 227, 245)")
        # Enter opens its Markdown; its first label sits in its middle
        self.key("Enter")
        self.assertEqual(self.source(), "")
        self.type("Encoder")
        self.click(1500, 900)  # a click outside draws it again
        self.assertIsNone(self.source())
        labelled = '<!-- box x="240" y="200" w="320" h="200" fill="#E4E3F5" outline="text" align="center" valign="middle" -->'
        self.assertEqual(self.text(), bare.replace("\n\nnote:", f"\n\n{labelled}\nEncoder\n<!-- /box -->\n\nnote:"))
        # its alignment changed, and taken away again by the same button
        self.click(400, 300)
        self.tool("left")
        self.assertIn('align="left" valign="middle"', self.text())
        self.tool("left")
        self.assertIn('outline="text" valign="middle" -->', self.text())
        self.tool("top")
        self.tool("top")
        self.assertIn('outline="text" -->', self.text())
        # a line made an arrow, thin
        self.tool("line")
        self.click(700, 700, ALT)
        self.assertIn('\n\n<!-- line from="700 700" to="1000 700" -->\n\nnote:', self.text())
        self.choose("ends", "both")
        self.choose("weight", "thin")
        self.assertIn('\n\n<!-- line from="700 700" to="1000 700" arrow="both" weight="thin" -->\n\nnote:', self.text())
        self.choose("ends", "")
        self.assertIn('\n\n<!-- line from="700 700" to="1000 700" weight="thin" -->\n\nnote:', self.text())
        self.assertEqual(b.errors, [])

    def test_3_a_box_s_markdown_edited_over_it(self):
        b = self.b
        self.start(2)
        before = self.text()
        box = self.items()[0]
        at = self.px(box["x"] + box["w"] / 2, box["y"] + 30)
        # a double click opens it, at the slide's size
        self.mouse("mouseMoved", *at)
        for n in (1, 2):
            self.b.call("Input.dispatchMouseEvent", type="mousePressed", x=at[0], y=at[1], button="left", buttons=1, clickCount=n)
            self.b.call("Input.dispatchMouseEvent", type="mouseReleased", x=at[0], y=at[1], button="left", buttons=0, clickCount=n)
        self.assertEqual(self.source(), "gap closes here")
        shown = b.js("(() => { const t = document.querySelector('#sl-preview .sl-source'), r = t.getBoundingClientRect(); return [r.left, r.top, r.width, parseFloat(getComputedStyle(t).fontSize)] })()")
        sx, sy = self.px(box["x"], box["y"])
        self.assertAlmostEqual(shown[0], sx, delta=1)
        self.assertAlmostEqual(shown[1], sy, delta=1)
        self.assertAlmostEqual(shown[2], box["w"] * self.scale, delta=1)
        self.assertEqual(shown[3], 40)
        # bold and italic go around what is selected of the source
        self.key("a", CTRL, ["selectAll"])
        self.tool("bold")
        self.assertEqual(self.source(), "**gap closes here**")
        self.key("i", CTRL)
        self.assertEqual(self.source(), "***gap closes here***")
        self.key("i", CTRL)
        self.assertEqual(self.source(), "**gap closes here**")
        self.assertEqual(self.text(), before, "nothing is written while it is open")
        self.key("Escape")
        self.assertIsNone(self.source())
        self.assertEqual(self.text(), before.replace("gap closes here", "**gap closes here**"))
        self.assertTrue(b.js("!!document.querySelector('#sl-preview .slide-box strong')"))
        # the keys are the slide's again: the arrow moves the box
        self.key("ArrowRight")
        self.assertIn(f'x="{box["x"] + 1}"', item_line(self.text(), 2, 0))
        # a box of text left empty is removed
        self.key("Enter")
        self.key("a", CTRL, ["selectAll"])
        self.key("Delete", commands=["deleteBackward"])
        self.assertEqual(self.source(), "")
        self.key("Escape")
        self.assertEqual(self.text(), without_items(self.orig, 2).replace("\n\nnote:", "\n\n" + "\n".join([item_line(self.orig, 2, 1), "<!-- /box -->", "", item_line(self.orig, 2, 2)]) + "\n\nnote:"))
        self.assertEqual(b.errors, [])

    def test_4_text_longer_than_its_box_is_marked_in_the_editor_only(self):
        b = self.b
        self.start(2)
        box = self.items()[0]
        self.click(box["x"] + box["w"] / 2, box["y"] + 30)
        self.assertEqual(b.js("document.querySelector('#sl-tools [data-tool=fit]').disabled"), True)
        # its bottom dragged up, under its text's height: the text stays whole, a mark says so
        high = self.drawn()[0]["rect"][3]
        self.drag(*self.handle("s"), 0, -(high - 30) * self.scale, ALT)
        got = dict(OPT.findall(item_line(self.text(), 2, 0)))
        self.assertAlmostEqual(int(got["h"]), 30, delta=1)
        self.assertEqual(b.js("document.querySelectorAll('#sl-preview .sl-warn').length"), 1)
        font = b.js("getComputedStyle(document.querySelector('#sl-preview .slide-box-text')).fontSize")
        self.assertEqual(font, "40px", "the text is not shrunk to fit")
        b.js("document.getElementById('sl-present').click()")
        self.assertTrue(b.wait("!!document.querySelector('#sl-show .slide')"))
        self.assertEqual(b.js("document.querySelectorAll('#sl-show .sl-warn, #sl-show .sl-edit').length"), 0)
        time.sleep(0.4)  # the full screen it asked for has come, or has been refused
        b.js("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))")
        self.assertTrue(b.wait("document.getElementById('sl-show').hidden && !document.fullscreenElement"), "the presentation did not stop")
        # its height given back to its text
        self.tool("fit")
        self.assertEqual(self.text(), self.orig)
        self.assertEqual(b.js("document.querySelectorAll('#sl-preview .sl-warn').length"), 0)
        self.assertEqual(b.errors, [])


# a picture made in the page (a canvas, `w` by `h`) and handed to the slide as the browser hands a pasted or a dropped one
PICTURE = """(async (how, w, h, x, y) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h
  const g = c.getContext('2d'); g.fillStyle = '#8B5CF6'; g.fillRect(0, 0, w, h)
  const blob = await new Promise(done => c.toBlob(done, 'image/png'))
  const dt = new DataTransfer(); dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }))
  const stage = document.getElementById('sl-preview')
  if (how === 'paste') { stage.focus(); document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })) }
  else stage.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }))
  return blob.size
})"""


@unittest.skipUnless(CHROME and websocket, "needs Chromium (Playwright's, or RFT_CHROME) and websocket-client")
class PicturesTest(Tools):
    """A figure of the tree picked for a slide, and an image of the user's pasted or dropped on it."""

    ID, NAME = "P06", "P06 Pictures.md"

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        (cls.vault / "figures").mkdir(exist_ok=True)
        for name in ("E06_accuracy.svg", "E06_loss.svg", "E04_curve.svg"):
            shutil.copy(FIXTURES / "E08_loss.svg", cls.vault / "figures" / name)

    def test_1_a_figure_picked_from_the_tree(self):
        b = self.b
        self.start(2)
        before = self.text()
        self.tool("figure")
        self.assertTrue(b.wait("document.querySelectorAll('#sl-tools .sl-figures .sl-figure').length === 3"), "the tree's figures are not listed")
        heads = b.js("[...document.querySelectorAll('#sl-tools .sl-figures-note')].map(h => h.textContent)")
        self.assertEqual([h.split(" ")[0] for h in heads], ["E04", "E06"])
        self.assertIn("CutMix with cosine schedule", heads[1], "by the note that made them, named")
        self.assertEqual(b.js("[...document.querySelectorAll('#sl-tools .sl-figure')].map(f => f.textContent)"), ["curve", "accuracy", "loss"])
        self.press('#sl-tools .sl-figure[data-figure="E06_accuracy.svg"]')
        made = '<!-- box x="560" y="240" w="800" -->\n![[E06_accuracy.svg]]\n<!-- /box -->'
        self.assertEqual(self.text(), before.replace("\n\nnote:", f"\n\n{made}\n\nnote:"))
        self.assertTrue(b.wait("(() => { const i = document.querySelector('#sl-preview .slide-box.figure img'); return !!i && i.complete && i.naturalWidth > 0 })()"), "the figure is not drawn")
        fig = self.drawn()[3]
        self.assertEqual([round(v) for v in fig["rect"][:3]], [560, 240, 800])
        self.assertAlmostEqual(fig["img"][3], 800 * 500 / 800, delta=1)
        self.assertEqual(self.selected(), 1)

        # its notebook run again, the figure wider than it was: the box keeps its width, its height follows
        (self.vault / "figures" / "E06_accuracy.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 200" width="800" height="200"><rect width="800" height="200" fill="#8B5CF6"/></svg>')
        b.js("(() => { const i = document.querySelector('#sl-preview .slide-box.figure img'); i.src = i.src + '&again=1' })()")
        self.assertTrue(b.wait("(() => { const i = document.querySelector('#sl-preview .slide-box.figure img'); return i.complete && i.naturalHeight === 200 })()"))
        again = self.drawn()[3]
        self.assertEqual([round(v) for v in again["rect"][:3]], [560, 240, 800])
        self.assertAlmostEqual(again["rect"][3], 200, delta=1)
        self.assertAlmostEqual(again["img"][2] / again["img"][3], 4, delta=0.02, msg="not cropped, not stretched")
        self.assertEqual(b.errors, [])

    def test_2_an_image_pasted_and_one_dropped(self):
        b = self.b
        self.start(2)
        before = self.text()
        assets = self.vault / "decks" / "assets"
        size = b.js(f"{PICTURE}('paste', 400, 200, 0, 0)")
        self.assertTrue(b.wait(f"{self.CM}.getValue().includes('![[P06-1.png]]')"), "the pasted image is not on the slide")
        # 400 by 200, in the slide's middle; its file with the decks, under the deck's name
        made = '<!-- box x="760" y="440" w="400" -->\n![[P06-1.png]]\n<!-- /box -->'
        self.assertEqual(self.text(), before.replace("\n\nnote:", f"\n\n{made}\n\nnote:"))
        self.assertEqual((assets / "P06-1.png").stat().st_size, size)
        self.assertTrue(b.wait("(() => { const i = document.querySelector('#sl-preview .slide-box.figure img'); return !!i && i.complete && i.naturalWidth === 400 })()"), "the image is not drawn")
        got = self.drawn()[3]
        self.assertAlmostEqual(got["img"][2] / got["img"][3], 2, delta=0.02)
        # dropped: around the point it is dropped at; wider than half the slide, it is brought to that
        x, y = self.px(600, 500)
        b.js(f"{PICTURE}('drop', 1600, 400, {x}, {y})")
        self.assertTrue(b.wait(f"{self.CM}.getValue().includes('![[P06-2.png]]')"), "the dropped image is not on the slide")
        dropped = dict(OPT.findall(item_line(self.text(), 2, 4)))
        self.assertEqual(int(dropped["w"]), 960)
        self.assertAlmostEqual(int(dropped["x"]), 600 - 480, delta=1)
        self.assertAlmostEqual(int(dropped["y"]), 500 - 120, delta=1)
        self.assertNotIn("h", dropped)
        self.assertTrue((assets / "P06-2.png").is_file())
        # resized by a corner, it keeps its proportions, and still has no height of its own
        self.assertTrue(b.wait("[...document.querySelectorAll('#sl-preview img')].every(i => i.complete && i.naturalWidth > 0)"))
        self.click(600, 500)
        text = self.text()
        self.drag(*self.handle("se"), -80, 0, ALT)
        got = self.changed(text, 4, {"w": 960 - 80 / self.scale})
        self.assertNotIn("h", got)
        img = self.drawn()[4]["img"]
        self.assertAlmostEqual(img[2] / img[3], 4, delta=0.02)
        self.assertEqual(b.errors, [])


COLUMNS = """---
id: P07
type: deck
locked: false
---

# Slots

---

<!-- slide layout="two-cols" -->

## Two columns

- on the left
- [[E06 CutMix with cosine schedule on three datasets]]

::right::

on the right

note: swap them
"""


@unittest.skipUnless(CHROME and websocket, "needs Chromium (Playwright's, or RFT_CHROME) and websocket-client")
class SlotsTest(Tools):
    """A layout's slots on the slide: selected, edited in place, changed over, taken out; the columns' divide; the heading's own colour and size; the layouts."""

    ID, NAME = "P07", "P07 Slots.md"

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        (cls.vault / "figures").mkdir(exist_ok=True)
        shutil.copy(FIXTURES / "E08_loss.svg", cls.vault / "figures" / "E06_loss.svg")

    def test_1_scenario_a_a_wrap_up_slide_in_two_columns(self):
        b = self.b
        self.start(3)
        # a new slide in two columns, from the gallery
        self.tool("layout")
        self.assertEqual(b.js("document.querySelectorAll('#sl-tools .sl-layouts .sl-layout').length"), 10)
        self.press('#sl-tools .sl-layout[data-layout="two-cols"][data-fresh="true"]')
        fresh = self.orig + "\n---\n\n<!-- slide layout=\"two-cols\" -->\n\n## Title\n\n::right::\n"
        self.assertEqual(self.text(), fresh)
        self.assertTrue(b.wait("!!document.querySelector('#sl-preview .slide.layout-two-cols[data-slide=\"4\"]')"), "the new slide is not the one in view")
        self.assertTrue(b.wait("document.querySelectorAll('#sl-thumbs .sl-thumb').length === 4"))
        self.to(4)
        # E06's loss in the left column
        left = self.slot("left")
        self.click(left[0] + left[2] / 2, left[1] + 200)
        self.assertEqual([round(v) for v in self.slot_selected()], [round(left[0]), round(left[1])])
        self.tool("figure")
        self.assertTrue(b.wait("document.querySelectorAll('#sl-tools .sl-figures .sl-figure').length === 1"))
        self.press('#sl-tools .sl-figure[data-figure="E06_loss.svg"]')
        self.assertEqual(self.text(), fresh.replace("## Title\n\n::right::", "## Title\n\n![[E06_loss.svg]]\n\n::right::"))
        self.assertTrue(b.wait("(() => { const i = document.querySelector('#sl-preview [data-slot=left] img'); return !!i && i.complete && i.naturalWidth > 0 })()"), "the figure is not in the left column")
        # three bullets typed in the right one
        right = self.slot("right")
        self.twice(right[0] + right[2] / 2, right[1] + 200)
        self.assertEqual(self.source(), "")
        self.type("- one seed so far\n- CutMix holds\n- next: three seeds")
        self.key("Escape")
        self.assertIsNone(self.source())
        # the heading typed over
        head = self.slot("head")
        self.twice(head[0] + 200, head[1] + head[3] / 2)
        self.assertEqual(self.source(), "## Title")
        self.key("a", CTRL, ["selectAll"])
        self.type("## E06 so far")
        self.key("Escape")
        # the divide dragged to 60 / 40
        at = b.js("(() => { const r = document.querySelector('#sl-preview .sl-divide').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()")
        cols = b.js("(() => { const s = document.querySelector('#sl-preview .slide'), c = s.querySelector('.slide-cols'); const r = s.getBoundingClientRect(), b = c.getBoundingClientRect(), k = r.width / 1920; return [(b.left - r.left) / k, b.width / k] })()")
        self.drag(at[0], at[1], (0.6 - 0.5) * (cols[1] - 80) * self.scale, 5)
        want = self.orig + ("\n---\n\n<!-- slide layout=\"two-cols\" split=\"60\" -->\n\n## E06 so far\n\n![[E06_loss.svg]]\n\n::right::\n\n"
                            "- one seed so far\n- CutMix holds\n- next: three seeds\n")
        self.assertEqual(self.text(), want)
        left, right = self.slot("left"), self.slot("right")
        self.assertAlmostEqual(left[2] / (left[2] + right[2]), 0.6, delta=0.002)
        self.assertEqual(b.js("document.querySelectorAll('#sl-preview [data-slot=right] li').length"), 3)
        if self.shots:
            b.shot(Path(self.shots) / "scenario-a-built.png")
        # dragged back to the middle, the option is gone
        at = b.js("(() => { const r = document.querySelector('#sl-preview .sl-divide').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()")
        self.drag(at[0], at[1], -(0.6 - 0.5) * (cols[1] - 80) * self.scale, 0)
        self.assertEqual(self.text(), want.replace(' split="60"', ""))
        self.assertEqual(b.errors, [])

    def test_2_a_slot_selected_edited_and_taken_out_of_its_layout(self):
        b = self.b
        self.start(2)
        before = self.text()
        # the caption: a click selects it, and puts the editor's cursor in its text
        cap = self.slot("caption")
        self.click(cap[0] + cap[2] / 2, cap[1] + cap[3] / 2)
        self.assertEqual([round(v) for v in self.slot_selected()], [round(cap[0]), round(cap[1])])
        self.assertEqual(self.selected(), 0)
        self.assertEqual(b.js(f"{self.CM}.getLine({self.CM}.getCursor().line)"), "Three seeds, mean and spread")
        # it cannot be dragged freely: the text is as it was
        self.drag(*self.px(cap[0] + cap[2] / 2, cap[1] + cap[3] / 2), 120, -160)
        self.assertEqual(self.text(), before)
        # Enter opens its Markdown over it
        self.click(cap[0] + cap[2] / 2, cap[1] + cap[3] / 2)
        self.key("Enter")
        self.assertEqual(self.source(), "Three seeds, mean and spread")
        self.key("a", CTRL, ["selectAll"])
        self.type("Three seeds, *mean* and spread")
        self.key("Escape")
        typed = before.replace("Three seeds, mean and spread", "Three seeds, *mean* and spread")
        self.assertEqual(self.text(), typed)
        self.assertTrue(b.js("!!document.querySelector('#sl-preview [data-slot=caption] em')"))
        # Detach: a box in the same place
        para = "(() => { const s = document.querySelector('#sl-preview .slide'), el = [...s.querySelectorAll('p')].find(p => p.textContent.startsWith('Three seeds')), r = s.getBoundingClientRect(), q = el.getBoundingClientRect(), k = r.width / 1920; return [(q.left - r.left) / k, (q.top - r.top) / k, q.width / k] })()"
        was, cap = b.js(para), self.slot("caption")
        self.assertIsNotNone(self.slot_selected())
        self.tool("detach")
        box = f'<!-- box x="{round(cap[0] - 20)}" y="{round(cap[1] - 12)}" w="{round(cap[2] + 40)}" -->'
        self.assertEqual(self.text(), typed.replace("Three seeds, *mean* and spread\n\n", "").replace("\n\nnote:", f"\n\n{box}\nThree seeds, *mean* and spread\n<!-- /box -->\n\nnote:"))
        self.assertEqual(self.selected(), 1, "the box it became is selected")
        now = b.js(para)
        for a, e in zip(now[:2], was[:2]):
            self.assertAlmostEqual(a, e, delta=1.5)
        # the figure taken out: its box is where the figure was
        fig = b.js("(() => { const s = document.querySelector('#sl-preview .slide'), el = s.querySelector('[data-slot=figure] img'), r = s.getBoundingClientRect(), q = el.getBoundingClientRect(), k = r.width / 1920; return [(q.left - r.left) / k, (q.top - r.top) / k, q.width / k, q.height / k] })()")
        self.click(fig[0] + 60, fig[1] + 60)
        self.assertIsNotNone(self.slot_selected())
        self.tool("detach")
        self.assertIn(f'<!-- box x="{round(fig[0])}" y="{round(fig[1])}" w="{round(fig[2])}" -->\n![[E08_loss.svg]]\n<!-- /box -->\n\nnote:', self.text())
        self.assertTrue(b.wait("(() => { const i = document.querySelector('#sl-preview .slide-box.figure img'); return !!i && i.complete && i.naturalWidth > 0 })()"))
        got = self.drawn()[-1]["img"]
        for a, e in zip(got, fig):
            self.assertAlmostEqual(a, e, delta=1.5)
        self.assertEqual(b.js("document.querySelectorAll('#sl-preview [data-slot=figure]').length"), 0)
        self.assertEqual(b.errors, [])

    def test_3_the_heading_s_own_colour_and_size_and_the_slide_s_layout(self):
        b = self.b
        self.start(2)
        before = self.text()
        head = self.slot("head")
        self.click(head[0] + 200, head[1] + head[3] / 2)
        self.colour("color", "contrast")
        self.press("#sl-tools [data-tool=size]")
        self.type("80")
        self.key("Enter")
        opts = '<!-- slide layout="figure" title-color="contrast" title-size="80" -->'
        self.assertEqual(self.text(), before.replace('<!-- slide layout="figure" -->', opts))
        look = b.js("(() => { const h = document.querySelector('#sl-preview [data-slot=head] h2'), c = getComputedStyle(h); return [c.color, c.fontSize] })()")
        self.assertEqual(look, ["rgb(236, 0, 63)", "80px"])
        self.assertEqual(b.js("getComputedStyle(document.querySelector('#sl-preview [data-slot=caption]')).color") == "rgb(236, 0, 63)", False, "the heading alone")
        # the gallery: this slide in another layout; the default is not written
        self.tool("layout")
        self.assertEqual(b.js("document.querySelector('#sl-tools .sl-layout[data-layout=figure][data-fresh=false]').getAttribute('aria-pressed')"), "true")
        self.press('#sl-tools .sl-layout[data-layout="two-cols"][data-fresh="false"]')
        self.assertEqual(self.text(), before.replace('<!-- slide layout="figure" -->', opts.replace("figure", "two-cols")))
        self.assertTrue(b.js("!!document.querySelector('#sl-preview .slide.layout-two-cols')"))
        self.tool("layout")
        self.press('#sl-tools .sl-layout[data-layout="default"][data-fresh="false"]')
        self.assertEqual(self.text(), before.replace('<!-- slide layout="figure" -->', '<!-- slide title-color="contrast" title-size="80" -->'))
        # the colour and the size given back: the line goes with its last option
        head = self.slot("content")
        self.click(head[0] + 200, head[1] + 30)
        self.colour("color", "")
        self.press("#sl-tools [data-tool=size]")
        self.key("a", CTRL, ["selectAll"])
        self.key("Delete", commands=["deleteBackward"])
        self.key("Enter")
        self.assertEqual(self.text(), before.replace('<!-- slide layout="figure" -->\n\n', ""))
        self.assertEqual(b.errors, [])

    def test_4_a_column_s_content_dragged_to_the_other_column(self):
        b = self.b
        self.start(2, COLUMNS)
        left, right = self.slot("left"), self.slot("right")
        sx, sy = self.px(left[0] + left[2] / 2, left[1] + 300)
        ex, ey = self.px(right[0] + right[2] / 2, right[1] + 300)
        # not yet selected, a drag from it takes nothing of it along
        self.drag(sx, sy, ex - sx, ey - sy)
        self.assertEqual(self.text(), COLUMNS)
        self.click(left[0] + left[2] / 2, left[1] + 300)
        self.assertIsNotNone(self.slot_selected())
        self.drag(sx, sy, ex - sx, ey - sy, release=False)
        self.assertEqual(b.js("document.querySelectorAll('#sl-preview .sl-drop').length"), 1, "the column it would go to is shown")
        self.mouse("mouseReleased", ex, ey)
        self.assertEqual(self.text(), COLUMNS.replace("- on the left\n- [[E06 CutMix with cosine schedule on three datasets]]\n\n::right::\n\non the right",
                                                      "on the right\n\n::right::\n\n- on the left\n- [[E06 CutMix with cosine schedule on three datasets]]"))
        self.assertEqual([round(v) for v in self.slot_selected()], [round(right[0]), round(right[1])], "it is the one selected, where it went")
        # dropped anywhere else, nothing changes
        after = self.text()
        self.drag(ex, ey, 0, -260)
        self.assertEqual(self.text(), after)
        # a link in a slot is still a link: a click on it opens its note
        link = b.js("(() => { const a = document.querySelector('#sl-preview [data-slot=right] a[data-go]'); if (!a) return null; const r = a.getClientRects()[0]; return [r.left + r.width / 2, r.top + r.height / 2] })()")
        self.assertIsNotNone(link, "the note is not linked")
        self.mouse("mouseMoved", *link)
        self.mouse("mousePressed", *link)
        self.mouse("mouseReleased", *link)
        self.assertTrue(b.wait("!document.getElementById('drawer').hidden"), "the note did not open")
        self.assertEqual(b.errors, [])


@unittest.skipUnless(CHROME and websocket, "needs Chromium (Playwright's, or RFT_CHROME) and websocket-client")
class SeveralTest(Tools):
    """Several boxes and lines at once: selected by Shift and by a dragged rectangle, moved together, brought in line, spaced evenly."""

    ID, NAME = "P08", "P08 Several.md"

    def label(self, text: str):
        self.key("Enter")
        self.assertEqual(self.source(), "")
        self.type(text)
        self.key("Escape")

    def test_1_scenario_c_a_diagram_from_nothing(self):
        b = self.b
        bare = without_items(self.orig, 3)
        self.assertNotIn("<!--", slides_of(bare)[2])
        self.start(3, bare)
        # three rectangles, each drawn and labelled, neither in line nor evenly apart
        for name, (x, y) in (("Encoder", (140, 300)), ("Bottleneck", (700, 340)), ("Decoder", (1420, 280))):
            self.draw("rect", (x, y), (x + 360, y + 160))
            self.label(name)
        box = lambda x, y, name: f'<!-- box x="{x}" y="{y}" w="360" h="160" outline="text" align="center" valign="middle" -->\n{name}\n<!-- /box -->'  # noqa: E731
        tail = bare[len(bare.rstrip("\n")):]  # the blank lines the deck ends with stay where they are
        drawn = bare.rstrip("\n") + "\n\n" + "\n\n".join([box(140, 300, "Encoder"), box(700, 340, "Bottleneck"), box(1420, 280, "Decoder")]) + tail
        self.assertEqual(self.text(), drawn)
        # a rectangle dragged around the three selects them
        self.drag(*self.px(100, 250), 1750 * self.scale, 300 * self.scale)
        self.assertEqual(self.selected(), 3)
        self.assertEqual(b.js("document.querySelectorAll('#sl-preview .sl-handle').length"), 0, "several selected have no handles")
        # their middles in line: on the middle of the rectangle around them (280 to 500)
        self.tool("alignMiddle")
        inline = bare.rstrip("\n") + "\n\n" + "\n\n".join([box(140, 310, "Encoder"), box(700, 310, "Bottleneck"), box(1420, 310, "Decoder")]) + tail
        self.assertEqual(self.text(), inline)
        # evenly apart: the outer two stay, 280 between each
        self.tool("spreadX")
        even = inline.replace('x="700"', 'x="780"')
        self.assertEqual(self.text(), even)
        self.assertEqual(self.selected(), 3, "they stay selected")
        # each of the two was one step
        self.key("z", CTRL)
        self.assertEqual(self.text(), inline)
        self.key("z", CTRL)
        self.assertEqual(self.text(), drawn)
        self.key("z", CTRL | SHIFT)
        self.key("z", CTRL | SHIFT)
        self.assertEqual(self.text(), even)
        # two arrows between them: pressed and let go near the sides' middles, they start and end on them
        for a, e in ((500, 780), (1140, 1420)):
            self.draw("arrow", (a + 5, 393), (e - 6, 388), 0)
        want = even.rstrip("\n") + '\n\n<!-- line from="500 390" to="780 390" arrow="end" -->\n\n<!-- line from="1140 390" to="1420 390" arrow="end" -->' + tail
        self.assertEqual(self.text(), want)
        got = self.drawn()
        self.assertEqual([round(g["rect"][1]) for g in got[:3]], [310, 310, 310])
        gaps = [got[i + 1]["rect"][0] - (got[i]["rect"][0] + got[i]["rect"][2]) for i in (0, 1)]
        self.assertAlmostEqual(gaps[0], gaps[1], delta=0.5)
        self.assertEqual([[round(v) for v in g["tips"][0]] for g in got[3:]], [[780, 390], [1420, 390]])
        self.assertEqual([g["text"] for g in got[:3]], ["Encoder", "Bottleneck", "Decoder"])
        if self.shots:
            b.shot(Path(self.shots) / "scenario-c-built.png")
        self.assertEqual(b.errors, [])

    def test_2_several_moved_copied_and_removed_together(self):
        b = self.b
        self.start(2)
        before = self.text()
        text, ellipse, arrow = self.items()
        # Shift and a click add to what is selected, and take away from it
        self.click(text["x"] + 60, text["y"] + 30)
        self.click((arrow["from"][0] + arrow["to"][0]) / 2, (arrow["from"][1] + arrow["to"][1]) / 2, SHIFT)
        self.assertEqual(self.selected(), 2)
        self.click(ellipse["x"] + ellipse["w"] / 2, ellipse["y"], SHIFT)
        self.assertEqual(self.selected(), 3)
        self.click(ellipse["x"] + ellipse["w"] / 2, ellipse["y"], SHIFT)
        self.assertEqual(self.selected(), 2)
        # dragged by one of them, both move by the same whole numbers; the ellipse stays
        self.drag(*self.px(text["x"] + 60, text["y"] + 30), -70, 35, ALT)
        dx, dy = round(-70 / self.scale), round(35 / self.scale)
        f, t = arrow["from"], arrow["to"]
        moved = before.replace(f'x="{text["x"]}" y="{text["y"]}"', f'x="{text["x"] + dx}" y="{text["y"] + dy}"').replace(
            f'from="{f[0]} {f[1]}" to="{t[0]} {t[1]}"', f'from="{f[0] + dx} {f[1] + dy}" to="{t[0] + dx} {t[1] + dy}"')
        self.assertEqual(self.text(), moved)
        self.assertEqual(self.selected(), 2)
        # one step of the history for the move of both
        self.key("z", CTRL)
        self.assertEqual(self.text(), before)
        self.key("z", CTRL | SHIFT)
        self.assertEqual(self.text(), moved)
        # the arrow keys move both; Ctrl+A takes all three
        self.key("ArrowDown", SHIFT)
        self.assertEqual(self.text(), moved.replace(f'y="{text["y"] + dy}"', f'y="{text["y"] + dy + 10}"').replace(
            f'from="{f[0] + dx} {f[1] + dy}" to="{t[0] + dx} {t[1] + dy}"', f'from="{f[0] + dx} {f[1] + dy + 10}" to="{t[0] + dx} {t[1] + dy + 10}"'))
        self.key("a", CTRL)
        self.assertEqual(self.selected(), 3)
        # copied together, pasted on another slide as their text, a blank line between them
        self.start(2)
        self.click(text["x"] + 60, text["y"] + 30)
        self.click(ellipse["x"] + ellipse["w"] / 2, ellipse["y"], SHIFT)
        self.key("c", CTRL, ["copy"])
        self.to(3)
        b.js("document.getElementById('sl-preview').focus()")
        self.key("v", CTRL, ["paste"])
        both = "\n".join([item_line(before, 2, 0), "gap closes here", "<!-- /box -->", "", item_line(before, 2, 1), "<!-- /box -->"])
        self.assertTrue(b.wait(f"{self.CM}.getValue().endsWith({json.dumps(both)} + '\\n')"), "the two are not pasted")
        self.assertEqual(self.text(), before.rstrip("\n") + "\n\n" + both + "\n")
        self.assertEqual(self.selected(), 2, "what was pasted is selected")
        # Delete removes both
        self.key("Delete")
        self.assertEqual(self.text(), before)
        self.assertEqual(b.errors, [])

    def test_3_a_dragged_rectangle_and_one_alone_in_line_with_the_slide(self):
        b = self.b
        self.start(3)
        its = self.items()
        # around the two lines at the right: both, though the rectangle holds neither whole
        self.drag(*self.px(1500, 660), 60 * self.scale, 180 * self.scale, release=False)
        self.assertEqual(b.js("document.querySelectorAll('#sl-preview .sl-marquee').length"), 1)
        self.mouse("mouseReleased", *self.px(1560, 840))
        self.assertEqual(self.selected(), 2)
        self.assertEqual(b.js("document.querySelectorAll('#sl-preview .sl-marquee').length"), 0)
        self.assertEqual(sorted(b.js("[...document.querySelectorAll('#sl-preview .sl-frame')].map(f => f.tagName)")), ["line", "line"])
        # with Shift, a second rectangle adds to them
        self.drag(*self.px(100, 220), 500 * self.scale, 120 * self.scale, SHIFT)
        self.assertEqual(self.selected(), 3)
        # a click on the slide itself selects nothing
        self.click(1850, 1040)
        self.assertEqual(self.selected(), 0)
        # one alone is brought in line with the slide
        before = self.text()
        first = its[0]
        self.click(first["x"] + 30, first["y"] + 20)
        self.tool("alignCenter")
        self.changed(before, 0, {"x": (1920 - first["w"]) // 2}, tol=0)
        self.assertEqual(b.js("document.querySelector('#sl-tools [data-tool=spreadX]').disabled"), True)
        self.assertEqual(b.errors, [])


if __name__ == "__main__":
    unittest.main()
