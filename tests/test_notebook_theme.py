"""The notebook's editor in the page's theme (web/artifacts.js notebookStyle, web/app.js themeNotebook).

marimo runs at whatever version uv resolves, so what the page leans on is checked against the one
installed: the variables it sets are ones marimo's stylesheets still read, and, in a browser, the
framed editor comes out in the page's colours, its widgets too, and follows the theme's button
with its kernel as it was.

    python3 -m unittest tests.test_notebook_theme

Skipped without uv; the browser's part also without Chromium and websocket-client (tests/test_phone.py).
"""
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))
sys.path.insert(0, str(ROOT / "server"))
import rft_notebook  # noqa: E402
from test_notebook import HAS_UV, note, uv_project  # noqa: E402
from test_phone import CHROME, READY, Browser, tap_node, websocket  # noqa: E402

NOTEBOOK = '''\
import marimo
app = marimo.App()


@app.cell
def _():
    import marimo as mo
    import time
    return mo, time


@app.cell
def _(mo, time):
    mo.vstack([mo.md(f"started {time.time()!r}"), mo.ui.checkbox(label="augment", value=True)])
    return
'''

# a notebook with a stylesheet of its own (marimo's css_file), which sets one of the variables the page sets
STYLED = '''\
import marimo
app = marimo.App(css_file="own.css")


@app.cell
def _():
    import marimo as mo
    return (mo,)


@app.cell
def _(mo):
    mo.ui.checkbox(label="augment", value=True)
    return
'''
OWN_CSS = ":root, body, .marimo, .marimo:is(.dark *) { --link: rgb(1, 2, 3); }\n"

# the frame's document; a colour as the three numbers it is drawn with, however it is written
FRAME = "document.querySelector('#nb-frame iframe').contentDocument"
PX = ("const px = c => { const x = document.createElement('canvas').getContext('2d'); x.fillStyle = c; x.fillRect(0, 0, 1, 1);"
      " return [...x.getImageData(0, 0, 1, 1).data].slice(0, 3).join(' ') };")
# what the page's own tokens come to in its theme
PAGE = ("(() => { %s const out = {}; for (const k of ['bg', 'fg', 'accent']) { const e = document.createElement('i');"
        " e.style.color = `var(--${k})`; document.body.appendChild(e); out[k] = px(getComputedStyle(e).color); e.remove() }"
        " return out })()" % PX)
# what the editor is drawn with: its page, and a widget inside its own shadow root
EDITOR = ("(() => { %s const d = %s; const box = d.querySelector('marimo-checkbox'); const b = box && box.shadowRoot && box.shadowRoot.querySelector('button');"
          " const started = [...d.querySelectorAll('.output')].map(e => e.textContent).find(t => /started/.test(t)) || '';"
          " return { theme: d.body.className, bg: px(getComputedStyle(d.body).backgroundColor), fg: px(getComputedStyle(d.body).color),"
          " font: getComputedStyle(d.body).fontFamily, box: b ? px(getComputedStyle(b).backgroundColor) : null, started: (started.match(/started [\\d.]+/) || [''])[0] } })()"
          % (PX, FRAME))
# a cell's own run button (each cell has a second, greyed, to stop it)
RUN = "%s.querySelectorAll('.marimo-cell [data-testid=run-button]:not([disabled])')[%%d].click()" % FRAME
CELLS = "(() => { const f = document.querySelector('#nb-frame iframe'); return Boolean(f && f.contentDocument && f.contentDocument.querySelectorAll('.marimo-cell').length > 1) })()"
WIDGET = "(() => { const b = %s.querySelector('marimo-checkbox'); return Boolean(b && b.shadowRoot && b.shadowRoot.querySelector('button')) })()" % FRAME


def names(block: str) -> list[str]:
    source = (ROOT / "web" / "artifacts.js").read_text()
    body = source[source.index(f"const {block} = {{"):]
    return re.findall(r"'(--[a-z0-9-]+)':", body[:body.index("\n  }")])


@unittest.skipUnless(HAS_UV, "uv is not on PATH")
class MarimoStillReadsTheseTest(unittest.TestCase):
    """Each variable the page sets in the editor is one the installed marimo's stylesheets read."""

    @classmethod
    def setUpClass(cls):
        got = subprocess.run(["uv", "run", "--no-project", "--with", "marimo", "python", "-c", "import marimo; print(marimo.__file__)"],
                             capture_output=True, text=True, timeout=300, cwd=tempfile.gettempdir())
        if got.returncode:
            raise unittest.SkipTest(f"marimo could not be had: {got.stderr.strip()[-200:]}")
        package = Path(got.stdout.strip().splitlines()[-1]).parent
        cls.css = "\n".join(p.read_text(errors="replace") for p in sorted((package / "_static").rglob("*.css")))
        cls.python = "\n".join(p.read_text(errors="replace") for p in sorted(package.glob("*.py")))

    def test_the_colours_are_variables_marimo_reads(self):
        self.assertGreater(len(names("NOTEBOOK_VARS")), 15)
        gone = [k for k in names("NOTEBOOK_VARS") if f"var({k}" not in self.css]
        self.assertEqual(gone, [], "marimo's stylesheets no longer read these")

    def test_the_fonts_are_variables_marimo_reads(self):
        self.assertEqual(len(names("NOTEBOOK_FONTS")), 3)
        gone = [k for k in names("NOTEBOOK_FONTS") if f"var({k}" not in self.css]
        self.assertEqual(gone, [], "marimo's stylesheets no longer read these")

    def test_the_pages_stylesheet_goes_under_the_name_of_marimos_custom_one(self):
        # the name marimo gives a notebook's own stylesheet, which it carries into each widget's shadow root
        self.assertIn("marimo-custom", self.python)
        self.assertIn("style.title = 'marimo-custom'", (ROOT / "web" / "app.js").read_text())


@unittest.skipUnless(HAS_UV and CHROME and websocket, "needs uv, Chromium (Playwright's, or RFT_CHROME) and websocket-client")
class NotebookThemeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="rft-nbtheme-")).resolve()
        vault = cls.tmp / "vault"
        (vault / "directions").mkdir(parents=True)
        (vault / "experiments").mkdir()
        (vault / "directions" / "D00 Root.md").write_text(note("D00", "direction", "done", "", "Root"))
        (vault / "experiments" / "E02 Baseline.md").write_text(note(
            "E02", "experiment", "done", "D00 Root", "Baseline", 'notebook: "notebooks/E02.py"\n'))
        (vault / "experiments" / "E03 Styled.md").write_text(note(
            "E03", "experiment", "done", "D00 Root", "Styled", 'notebook: "notebooks/E03.py"\n'))
        uv_project(cls.tmp / "toy", NOTEBOOK)
        (cls.tmp / "toy" / "notebooks" / "E03_styled.py").write_text(STYLED)
        (cls.tmp / "toy" / "notebooks" / "own.css").write_text(OWN_CSS)
        rft_notebook.link("../../toy/notebooks/E02_baseline.py", vault / "notebooks" / "E02.py")
        rft_notebook.link("../../toy/notebooks/E03_styled.py", vault / "notebooks" / "E03.py")
        cls.server = subprocess.Popen([sys.executable, str(ROOT / "server" / "rft_server.py"), "--vault", str(vault),
                                       "--web", str(ROOT / "web"), "--port", "0", "--project", "demo", "--no-watch"],
                                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        cls.url = re.search(r"RFT_SERVER_URL (\S+)", cls.server.stdout.readline()).group(1)
        (cls.tmp / "profile").mkdir()
        cls.b = Browser(cls.tmp / "profile")
        cls.b.call("Emulation.setDeviceMetricsOverride", width=1500, height=950, deviceScaleFactor=1, mobile=False)

    @classmethod
    def tearDownClass(cls):
        cls.b.close()
        cls.server.terminate()  # its editors with it
        cls.server.wait(20)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def same(self, editor, page, theme):
        self.assertIn(theme, editor["theme"])
        self.assertEqual(editor["bg"], page["bg"], "the editor's background is the page's")
        self.assertEqual(editor["fg"], page["fg"], "the editor's text is the page's")
        self.assertEqual(editor["box"], page["accent"], "a ticked box inside a widget's shadow root is the page's accent")
        self.assertTrue(editor["font"].startswith("ui-sans-serif"), editor["font"])

    def test_the_editor_is_drawn_in_the_pages_theme_and_follows_its_button(self):
        b = self.b
        b.open(self.url)
        b.js("localStorage.setItem('rft:theme', 'dark')")
        b.open(self.url)
        self.assertEqual(b.js("document.documentElement.dataset.theme"), "dark")
        b.js(tap_node("E02"))
        if not b.wait(CELLS, 180):
            self.fail("the editor did not open: " + str(b.js("document.getElementById('nb-msg').textContent")))
        time.sleep(2)
        # the cells run, one after the other
        b.js(RUN % 0)
        time.sleep(3)
        b.js(RUN % 1)
        self.assertTrue(b.wait(WIDGET, 60), "the cell's widget did not appear")
        time.sleep(1)
        dark = b.js(EDITOR)
        self.same(dark, b.js(PAGE), "dark")
        self.assertTrue(dark["started"])
        # the theme's button: the editor with it, and what its kernel had computed still there
        b.js("document.getElementById('theme').click()")
        self.assertEqual(b.js("document.documentElement.dataset.theme"), "light")
        self.assertTrue(b.wait("(() => { try { return %s.body.classList.contains('light') && %s } catch (e) { return false } })()" % (FRAME, WIDGET), 90),
                        "the editor did not come back in the light theme")
        time.sleep(1)
        light = b.js(EDITOR)
        self.same(light, b.js(PAGE), "light")
        self.assertNotEqual(light["bg"], dark["bg"])
        self.assertEqual(light["started"], dark["started"], "the kernel was not the same one")
        self.assertEqual(b.errors, [])

    def test_a_notebooks_own_stylesheet_has_the_last_word(self):
        b = self.b
        b.open(self.url)
        b.js("localStorage.setItem('rft:theme', 'dark')")
        b.open(self.url)
        b.js(tap_node("E03"))
        if not b.wait(CELLS, 180):
            self.fail("the editor did not open: " + str(b.js("document.getElementById('nb-msg').textContent")))
        time.sleep(2)
        b.js(RUN % 0)
        time.sleep(3)
        b.js(RUN % 1)
        self.assertTrue(b.wait(WIDGET, 60), "the cell's widget did not appear")
        time.sleep(1)
        got = b.js("(() => { %s const d = %s; const s = getComputedStyle(d.body); const root = d.querySelector('marimo-checkbox').shadowRoot;"
                   " return { bg: px(s.backgroundColor), link: s.getPropertyValue('--link').trim(),"
                   " inside: getComputedStyle(root.querySelector('.marimo')).getPropertyValue('--link').trim(),"
                   " box: px(getComputedStyle(root.querySelector('button')).backgroundColor) } })()" % (PX, FRAME))
        page = b.js(PAGE)
        self.assertEqual(got["bg"], page["bg"], "the page's colours where the notebook sets none")
        self.assertEqual(got["link"], "rgb(1, 2, 3)", "the notebook's own where it sets one")
        self.assertEqual(got["box"], page["accent"], "the page's colours inside a widget")
        self.assertEqual(got["inside"], "rgb(1, 2, 3)", "the notebook's own inside a widget")
        self.assertEqual(b.errors, [])


if __name__ == "__main__":
    unittest.main()
