"""The web view on a phone: an audit in headless Chromium at two Android sizes (360×780 and 412×915).

On every page and every sheet (a note, its editor, the filters, the scratchpad, the ⋯ menu):
  - nothing scrolls sideways but what is made to (the kanban's columns, a timeline, a wide formula);
  - every control on screen is a 44 px touch target (Apple's 44 pt, Material's 48 dp, WCAG 2.5.5),
    the marks of a drawing (the tree's notes, the calendar's bars) at least 24 px (WCAG 2.5.8),
    links inside running text excepted (WCAG's inline exception);
  - every field's text is at least 16 px;
  - an icon alone in its button sits at the button's centre;
  - the app's own bars leave the content at least all but 128 px of the screen;
  - every page is a labelled button on screen;
  - the phone's Back closes what is open (a note, the note it came from first, the filters, the
    scratchpad), and never leaves the page.
No script error on any screen. It needs Chromium (Playwright's, or RFT_CHROME) and the websocket-client
module, and skips without them. RFT_PHONE_SHOTS=<dir> also saves a screenshot of each screen.

    python3 -m unittest tests.test_phone -v
"""
import base64
import datetime
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

try:
    import websocket  # websocket-client
except ImportError:  # pragma: no cover
    websocket = None

ROOT = Path(__file__).resolve().parents[1]
SIZES = [(360, 780), (412, 915)]


def find_chrome():
    if os.environ.get("RFT_CHROME"):
        return os.environ["RFT_CHROME"]
    found = sorted(glob.glob(os.path.expanduser("~/.cache/ms-playwright/chromium-*/chrome-linux/chrome")))
    if found:
        return found[-1]
    for name in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable"):
        if shutil.which(name):
            return shutil.which(name)
    return None


CHROME = find_chrome()

# --------------------------------------------------------------------------- the audit, in the page

AUDIT_JS = r"""
(() => {
  const W = innerWidth, H = innerHeight, out = []
  // what is made to scroll sideways
  const HSCROLL = '.kb-cols, .cal-body, .tl-scroll, .cal-deadlines, #note pre, #note .katex-display, #note .table-wrap, .ms-thread pre, .drawer-actions, .sl-thumbs, .CodeMirror, .jobs-list, .jobs-tabs'
  // links inside running text: WCAG 2.5.8's inline exception
  const INLINE = '#note a, .t-text a, .fn-pop a, .drawer-origin a, .drawer-superseded a, .art-summary a, .drawer-concept a, .drawer-code a, .ms-empty a, .art-state a, .hint a, .editor-hint a, .edit-nokey a'
  // the marks of a drawing: 24 px
  const DENSE = '#canvas g.node, #canvas g.fold, #canvas .badge, #concept-canvas .cnode, #concept-canvas .cfocus, .cal-body *'
  const SKIP = '.CodeMirror *, #tooltip, #tooltip *, iframe'
  const shown = el => {
    if (el.closest('[hidden]')) return false
    if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  const name = el => {
    const t = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 28)
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
    return `${el.id ? '#' + el.id : el.tagName.toLowerCase() + cls}${t ? ` "${t}"` : ''}`
  }
  const inScroller = el => Boolean(el.parentElement && el.parentElement.closest(HSCROLL))
  // on top at its centre (what a tap there reaches), its centre brought into the screen
  const reachable = el => {
    const r = el.getBoundingClientRect()
    const x = Math.min(Math.max(r.left + r.width / 2, 1), W - 1), y = Math.min(Math.max(r.top + r.height / 2, 1), H - 1)
    const hit = document.elementFromPoint(x, y)
    return Boolean(hit && (hit === el || el.contains(hit) || hit.contains(el) || (hit.closest('label') && hit.closest('label') === el.closest('label'))))
  }

  if (document.documentElement.scrollWidth > W + 1) out.push(`the page scrolls sideways (${document.documentElement.scrollWidth} px wide)`)
  for (const el of document.querySelectorAll('body *')) {
    if (el.matches(SKIP) || el.matches(HSCROLL) || !shown(el)) continue
    const s = getComputedStyle(el)
    if ((s.overflowX === 'auto' || s.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 2) out.push(`${name(el)} scrolls sideways (${el.scrollWidth} in ${el.clientWidth} px)`)
  }

  const CONTROLS = 'button, a[href], a[title], input:not([type=hidden]), select, textarea, summary, [role=tab], [role=button], [role=radio], [tabindex="0"], label, #canvas g.node, #canvas g.fold, #concept-canvas .cnode, #concept-canvas .cfocus'
  for (const el of document.querySelectorAll(CONTROLS)) {
    if (el.matches(SKIP) || el.matches(INLINE) || !shown(el)) continue
    if (el.tagName === 'LABEL' && !el.querySelector('input[type=checkbox], input[type=radio]')) continue
    if (el.matches('input[type=checkbox], input[type=radio]') && el.closest('label')) continue // its label is the target
    if (el.matches('input, select, textarea') && el.closest('label') && !el.closest('label').querySelector('input[type=checkbox], input[type=radio]')) { /* a field in a label: its own target */ }
    const r = el.getBoundingClientRect()
    const off = r.right > W + 1 || r.left < -1 || r.top < -1 || r.bottom > H + 1
    if (off && !inScroller(el) && !el.closest('#canvas, #concept-canvas, #drawer, #filters, #pad, #inbox, #jobs, .kb-cols, .cal-body, .ms-body, .sl-body, #kanban, #calendar, #manuscript, #slides, #legend, #bar-more')) {
      out.push(`${name(el)} is off the screen (x ${Math.round(r.left)}–${Math.round(r.right)}, y ${Math.round(r.top)}–${Math.round(r.bottom)})`)
      continue
    }
    if (r.right > W + 1 && !inScroller(el)) { out.push(`${name(el)} is cut at the right edge (x ${Math.round(r.left)}–${Math.round(r.right)})`); continue }
    if (off || !reachable(el)) continue // scrolled away, or under a sheet: not a target now
    const min = el.matches(DENSE) || el.closest('.cal-body') ? 24 : 44
    // an SVG group's own box is its drawing; a fold handle's target is its widest circle
    let w = r.width, h = r.height
    if (w < min - 0.5 || h < min - 0.5) out.push(`${name(el)} is ${Math.round(w)}×${Math.round(h)} px (< ${min})`)
  }

  // an icon alone in its button (a badge or a dot on it aside): at its centre, though the button is wider than the icon
  const pseudo = (el, p) => { const s = getComputedStyle(el, p); return !/^(none|normal)$/.test(s.content) && s.position !== 'absolute' }
  for (const el of document.querySelectorAll('button, a.icon-btn')) {
    if (el.matches(SKIP) || !shown(el) || !reachable(el)) continue
    const kids = [...el.children].filter(k => shown(k) && getComputedStyle(k).position !== 'absolute')
    if (!kids.length || kids.some(k => k.tagName.toLowerCase() !== 'svg') || pseudo(el, '::before') || pseudo(el, '::after')) continue
    if ([...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue
    const r = el.getBoundingClientRect(), ks = kids.map(k => k.getBoundingClientRect())
    const dx = (Math.min(...ks.map(k => k.left)) + Math.max(...ks.map(k => k.right))) / 2 - (r.left + r.width / 2)
    const dy = (Math.min(...ks.map(k => k.top)) + Math.max(...ks.map(k => k.bottom))) / 2 - (r.top + r.height / 2)
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) out.push(`${name(el)}: its icon is ${dx.toFixed(1)}, ${dy.toFixed(1)} px off the button's centre`)
  }

  for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea')) {
    if (el.matches(SKIP) || !shown(el) || !reachable(el)) continue
    const px = parseFloat(getComputedStyle(el).fontSize)
    if (px < 15.5) out.push(`${name(el)}: text ${px} px (< 16)`)
  }

  const main = document.querySelector('main').getBoundingClientRect()
  const tabs = [...document.querySelectorAll('[data-show]')]
  const tabsTop = Math.min(...tabs.filter(shown).map(t => t.getBoundingClientRect().top), H)
  const content = Math.min(main.bottom, tabsTop >= main.top + 40 ? tabsTop : main.bottom) - main.top
  if (H - content > 128) out.push(`the app's bars take ${Math.round(H - content)} px of ${H} (> 128)`)

  for (const t of tabs) {
    if (!shown(t)) { out.push(`page ${t.dataset.show}: no button on screen`); continue }
    const r = t.getBoundingClientRect()
    if (r.right > W + 1 || r.left < -1 || r.bottom > H + 1 || r.top < -1) out.push(`page ${t.dataset.show}: its button is off the screen`)
    const label = (t.innerText || '').trim() || (getComputedStyle(t, '::after').content || '').replace(/^none$|^normal$|^""$/, '')
    if (!label) out.push(`page ${t.dataset.show}: its button has no visible name`)
  }
  return out
})()
"""

# --------------------------------------------------------------------------- the page's states

READY = "document.querySelectorAll('#nodes g.node').length > 0"


def page(v):
    return f"document.querySelector('[data-show={v}]').click()"


def tap_node(note_id):
    return ("(() => { const g = [...document.querySelectorAll('#nodes g.node')].find(n => n.__data__ && n.__data__.data.id === %s);"
            " g.dispatchEvent(new MouseEvent('click', { bubbles: true })); })()" % json.dumps(note_id))


OPEN_MENU = "(() => { const b = document.getElementById('bar-more-toggle'); if (b) b.click() })()"
# the queue's button, as web/queue.js shows it where the queue runs (the test's server has no queue), with its count
QUEUE_BUTTON = ("(() => { document.getElementById('jobs-toggle').hidden = false;"
                " const b = document.getElementById('jobs-badge'); b.textContent = '17'; b.hidden = false })()")
# the Manuscript's document compiled and its PDF pane open
MS_PDF = [page("manuscript"), "document.querySelector('[data-ms-level=documents]').click()",
          "(() => { const s = document.getElementById('ms-doc'); s.value = 'two-pages'; s.dispatchEvent(new Event('change', { bubbles: true })) })()",
          "document.querySelector('.phone-panes[data-for=ms-body] [data-pane=pdf]').click()",
          "document.getElementById('ms-compile').click()",
          "new Promise(done => { const t0 = Date.now(), t = setInterval(() => { if (document.querySelector('#ms-pdf-pages canvas[data-drawn]') || Date.now() - t0 > 60000) { clearInterval(t); done(true) } }, 100) })"]
# each page of the PDF drawn: the dark pixels on its canvas (-1: not drawn)
PDF_INK = ("[...document.querySelectorAll('#ms-pdf-pages canvas.ms-pdf-page')].map(c => { if (!c.width) return -1;"
           " const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;"
           " for (let i = 0; i < d.length; i += 4) if (d[i] < 128 && d[i + 3] > 0) n++; return n })")
SCREENS = [
    ("tree", [page("tree"), QUEUE_BUTTON]),
    ("menu", [page("tree"), OPEN_MENU]),
    ("note", [page("tree"), tap_node("D00")]),
    ("note-edit", [page("tree"), tap_node("E07"), "document.getElementById('drawer-edit').click()"]),
    ("filters", [page("tree"), "document.getElementById('filters-toggle').click()"]),
    ("pad", [page("tree"), "document.getElementById('pad-toggle').click()"]),
    ("inbox", [page("tree"), "document.getElementById('inbox-toggle').click()"]),
    ("concepts", [page("concepts")]),
    ("kanban", [page("kanban")]),
    ("timeline", [page("calendar"), "document.querySelector('[data-cal-mode=timeline]').click()"]),
    ("month", [page("calendar"), "document.querySelector('[data-cal-mode=month]').click()"]),
    ("manuscript", [page("manuscript")]),
    ("manuscript-pdf", MS_PDF),
    ("slides", [page("slides")]),
    ("slides-text", [page("slides"), "document.querySelector('.sl-item').click()"]),
]


def demo_vault(dst: Path):
    """The demo project, with what the calendar, the scratchpad and the Slides tab show."""
    shutil.copytree(ROOT / "examples" / "demo" / "vault", dst)
    today = datetime.date.today()
    day = lambda n: (today + datetime.timedelta(days=n)).isoformat()  # noqa: E731
    for name, start, est in (("E04", day(-3), "1w"), ("E06", day(4), "5d")):
        p = next((dst / "experiments").glob(f"{name} *.md"))
        p.write_text(p.read_text().replace("\n---\n", f"\nstart: {start}\nest: {est}\n---\n", 1))
    (dst / "milestones").mkdir()
    (dst / "milestones" / "M01 Workshop paper.md").write_text(
        f'---\nid: M01\ntype: milestone\nstatus: open\ndue: {day(10)} 23:59 AoE\nneeds: ["[[E06 CutMix with cosine schedule on three datasets]]"]\n---\n\n# M01 · Workshop paper\n')
    (dst / "meetings").mkdir()
    (dst / "meetings" / "G01 Supervisor meeting.md").write_text(
        f"---\nid: G01\ntype: meeting\nwhen: {day(-14)} 14:00\nduration: 1h\nevery: week\n---\n\n# G01 · Supervisor meeting\n")
    (dst / "decks").mkdir()
    (dst / "decks" / "P01 Weekly wrap-up.md").write_text(
        "---\nid: P01\ntype: deck\nlocked: true\n---\n\n# Weekly wrap-up\n\n---\n\n## E06 so far\n\n- CutMix holds at 1k\n- next: three seeds\n")
    (dst / "Scratchpad.md").write_text("- [ ] read the CutMix ablation\n- [x] mail the supervisor\n- a note\n")
    shutil.copy(Path(__file__).resolve().parent / "fixtures" / "inbox" / "Inbox.md", dst / "Inbox.md")
    # a document of two pages, for the Manuscript's PDF
    (dst / "documents" / "two-pages").mkdir(parents=True)
    (dst / "documents" / "documents.json").write_text('{"locked": true, "unlocked": []}\n')
    (dst / "documents" / "two-pages" / "main.tex").write_text(
        "\\documentclass{article}\n\\begin{document}\n\\section{One}\nThe first page.\n\\newpage\n\\section{Two}\nThe second page.\n\\end{document}\n")
    # urgent and high full (1 and 5 open notes), so a card's priority menu names the notes holding them
    open_notes = sorted(p for p in dst.glob("*/*.md") if re.search(r"^status: (idea|planned|running)$", p.read_text(), re.M))
    for p, prio in zip(open_notes, ["urgent"] + ["high"] * 5):
        p.write_text(p.read_text().replace("\n---\n", f"\npriority: {prio}\n---\n", 1))


class Browser:
    """Headless Chromium over the DevTools protocol, with a phone's screen and touch."""

    def __init__(self, profile: Path):
        self.proc = subprocess.Popen([CHROME, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
                                      "--remote-debugging-port=0", f"--user-data-dir={profile}", "about:blank"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        port_file = profile / "DevToolsActivePort"
        for _ in range(100):
            if port_file.exists() and port_file.read_text().strip():
                break
            time.sleep(0.1)
        port = port_file.read_text().split()[0]
        for _ in range(50):
            try:
                tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json"))
                break
            except OSError:
                time.sleep(0.1)
        tab = next(t for t in tabs if t["type"] == "page")
        self.ws = websocket.create_connection(tab["webSocketDebuggerUrl"], suppress_origin=True, timeout=30)
        self.n = 0
        self.errors = []
        self.call("Runtime.enable")
        self.call("Page.enable")

    def call(self, method, **params):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("method") == "Runtime.exceptionThrown":
                d = m["params"]["exceptionDetails"]
                self.errors.append((d.get("exception") or {}).get("description") or d.get("text"))
            if m.get("id") == self.n:
                if "error" in m:
                    raise RuntimeError(f"{method}: {m['error']}")
                return m.get("result", {})

    def js(self, expr):
        r = self.call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        if r.get("exceptionDetails"):
            raise RuntimeError(f"{expr[:80]}: {r['exceptionDetails'].get('exception', {}).get('description')}")
        return r.get("result", {}).get("value")

    def wait(self, expr, timeout=8.0):
        end = time.time() + timeout
        while time.time() < end:
            if self.js(expr):
                return True
            time.sleep(0.1)
        return False

    def size(self, w, h):
        self.call("Emulation.setDeviceMetricsOverride", width=w, height=h, deviceScaleFactor=2, mobile=True)
        self.call("Emulation.setTouchEmulationEnabled", enabled=True, maxTouchPoints=5)

    def open(self, url):
        self.call("Page.navigate", url=url)
        time.sleep(0.3)
        if not self.wait(READY):
            raise RuntimeError("the tree did not draw")

    def tap(self, selector):
        """A finger's tap at the middle of the element."""
        x, y = self.js("(() => { const r = document.querySelector(%s).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2] })()" % json.dumps(selector))
        self.call("Input.dispatchTouchEvent", type="touchStart", touchPoints=[{"x": x, "y": y}])
        self.call("Input.dispatchTouchEvent", type="touchEnd", touchPoints=[])

    def shot(self, path):
        Path(path).write_bytes(base64.b64decode(self.call("Page.captureScreenshot", format="png")["data"]))

    def close(self):
        try:
            self.ws.close()
        finally:
            self.proc.terminate()
            self.proc.wait(10)


@unittest.skipUnless(CHROME and websocket, "needs Chromium (Playwright's, or RFT_CHROME) and websocket-client")
class PhoneTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="rft-phone-"))
        demo_vault(cls.tmp / "vault")
        cls.server = subprocess.Popen([sys.executable, str(ROOT / "server" / "rft_server.py"), "--vault", str(cls.tmp / "vault"),
                                       "--web", str(ROOT / "web"), "--port", "0", "--project", "demo", "--no-watch"],
                                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        line = cls.server.stdout.readline()
        cls.url = re.search(r"RFT_SERVER_URL (\S+)", line).group(1)
        (cls.tmp / "profile").mkdir()
        cls.b = Browser(cls.tmp / "profile")
        cls.shots = os.environ.get("RFT_PHONE_SHOTS")

    @classmethod
    def tearDownClass(cls):
        cls.b.close()
        cls.server.terminate()
        cls.server.wait(10)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def screen(self, steps):
        # each screen from a fresh start: the page keeps which panels were open
        self.b.js("try { localStorage.clear() } catch (e) {}")
        self.b.open(self.url)
        for s in steps:
            self.b.js(s)
            time.sleep(0.45)
        time.sleep(0.4)

    def test_layout_on_every_screen(self):
        found = {}
        for w, h in SIZES:
            self.b.size(w, h)
            for name, steps in SCREENS:
                self.screen(steps)
                if self.shots:
                    os.makedirs(self.shots, exist_ok=True)
                    self.b.shot(os.path.join(self.shots, f"{w}-{name}.png"))
                for f in self.b.js(AUDIT_JS):
                    found.setdefault(f"{w}px {name}", []).append(f)
        if self.b.errors:
            found["script errors"] = list(self.b.errors)
        report = "\n".join(f"{k}:\n  " + "\n  ".join(v) for k, v in found.items())
        n = sum(len(v) for v in found.values())
        self.assertEqual(n, 0, f"{n} problems on {len(found)} screens\n{report}")

    def back_closes(self, w, h, steps, is_open, label):
        self.b.size(w, h)
        self.screen(steps)
        self.assertTrue(self.b.js(is_open), f"{label}: did not open")
        self.b.js("history.back()")
        time.sleep(0.8)
        here = self.b.js("location.origin + location.pathname")
        self.assertTrue(self.url.startswith(here or "-"), f"{label}: Back left the page (now at {here})")
        self.assertFalse(self.b.js(is_open), f"{label}: still open after Back")

    def test_compiled_pdf_is_drawn(self):
        # Chrome on Android shows no PDF in a frame (a broken page): pdf.js draws its pages, the width of the pane
        if not shutil.which("latexmk"):
            self.skipTest("needs latexmk")
        for w, h in SIZES:
            self.b.size(w, h)
            self.screen(MS_PDF)
            self.assertTrue(self.b.wait("document.querySelectorAll('#ms-pdf-pages canvas.ms-pdf-page').length === 2", 60),
                            f"{w}px: no pages drawn; status: {self.b.js('document.getElementById("ms-status").textContent')!r},"
                            f" note: {self.b.js('document.getElementById("ms-pdf-note").textContent')!r}")
            self.assertTrue(self.b.wait(f"{PDF_INK}.every(n => n > 50)", 15), f"{w}px: ink per page {self.b.js(PDF_INK)}")
            self.assertTrue(self.b.js("document.getElementById('ms-pdf-frame').hidden"), f"{w}px: the frame is shown")
            fit = self.b.js("(() => { const p = document.getElementById('ms-pdf-pages'), c = p.querySelector('canvas');"
                            " return [c.clientWidth, p.clientWidth, c.width / c.clientWidth] })()")
            self.assertGreater(fit[0], fit[1] - 24, f"{w}px: a page {fit[0]} px wide in a pane of {fit[1]}")
            self.assertAlmostEqual(fit[2], 2, delta=0.05, msg=f"{w}px: drawn at {fit[2]}× (the screen's 2×)")
        self.assertEqual(self.b.errors, [])

    def test_latex_pane_draws_its_text(self):
        # the editor is filled while its pane is hidden (one pane at a time): shown, its text is drawn, clear of the line numbers
        self.b.size(412, 915)
        self.screen(MS_PDF[:3] + ["document.querySelector('.phone-panes[data-for=ms-body] [data-pane=text]').click()"])
        got = self.b.js("(() => { const g = document.querySelector('#ms-cm .CodeMirror-gutters'), l = document.querySelector('#ms-cm .CodeMirror-line');"
                        " return l ? [g.getBoundingClientRect().right, l.getBoundingClientRect().left, l.textContent] : null })()")
        self.assertIsNotNone(got, "no line of the document drawn")
        self.assertIn("documentclass", got[2])
        self.assertGreaterEqual(got[1], got[0] - 0.5, f"its text starts at x {got[1]}, under the line numbers (to x {got[0]})")

    def test_suggestion_keeps_what_is_typed(self):
        # the Manuscript reads its threads again every 4 s: a suggestion being written keeps its text and the keyboard
        self.b.size(412, 915)
        self.screen(MS_PDF[:3] + ["document.querySelector('.phone-panes[data-for=ms-body] [data-pane=text]').click()",
                                  "document.querySelector('#ms-cm .CodeMirror').CodeMirror.setSelection({ line: 3, ch: 0 }, { line: 3, ch: 9 })",
                                  "document.querySelector('.ms-sel-btn[data-kind=suggestion]').click()"])
        self.assertTrue(self.b.js("!!document.querySelector('.ms-composer')"), "no composer")
        self.b.js("document.querySelector('.ms-composer textarea:not(.ms-repl-box)').focus()")
        self.b.call("Input.insertText", text="Say wh")
        time.sleep(5)  # a poll of the threads
        self.b.call("Input.insertText", text="ich page")
        typed = ("(() => { const m = document.querySelector('.ms-composer textarea:not(.ms-repl-box)'), r = document.querySelector('.ms-composer .ms-repl-box');"
                 " return m && [m.value, r && r.value, document.activeElement === m, m.selectionStart] })()")
        self.assertEqual(self.b.js(typed), ["Say which page", "The first", True, 14])
        # a thread posted meanwhile (Claude's, another tab's): the discussion is drawn again, what is typed and the cursor kept
        token = re.search(r"token=([^&#]+)", self.url).group(1)
        posted = self.b.js("fetch('api/comment', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RFT-Token': %s },"
                           " body: JSON.stringify({ id: 'two-pages', action: 'new', kind: 'comment', quote: 'second', prefix: 'The ', suffix: ' page.', text: 'elsewhere' }) }).then(r => r.status)"
                           % json.dumps(token))
        self.assertEqual(posted, 200)
        self.assertTrue(self.b.wait("document.querySelectorAll('#ms-threads .ms-thread').length === 1", 8), "the new thread is not shown")
        self.assertEqual(self.b.js(typed), ["Say which page", "The first", True, 14])

    def test_back_closes_what_is_open(self):
        w, h = SIZES[0]
        self.back_closes(w, h, [page("tree"), tap_node("D00")], "!document.getElementById('drawer').hidden", "a note")
        self.back_closes(w, h, [page("tree"), "document.getElementById('filters-toggle').click()"], "!document.getElementById('filters').hidden", "the filters")
        self.back_closes(w, h, [page("tree"), "document.getElementById('pad-toggle').click()"], "!document.getElementById('pad').hidden", "the scratchpad")
        self.back_closes(w, h, [page("tree"), "document.getElementById('inbox-toggle').click()"], "!document.getElementById('inbox').hidden", "the inbox")

    def test_inbox_takes_a_link_at_its_top(self):
        box = self.tmp / "vault" / "Inbox.md"
        before = box.read_text(encoding="utf-8")
        self.addCleanup(box.write_text, before, encoding="utf-8")
        w, h = SIZES[0]
        self.b.size(w, h)
        self.screen([page("tree"), "document.getElementById('inbox-toggle').click()"])
        # the field is at the top of the page-sized panel, over the list, and a finger's size
        at = self.b.js("(() => { const r = id => document.getElementById(id).getBoundingClientRect(), f = r('inbox-link'), y = r('inbox-why'), s = r('inbox-save'), l = r('inbox-list');"
                       " return [f.top - r('inbox').top < 80, s.bottom <= l.top, Math.min(f.height, y.height, s.height, s.width) >= 44, f.width > innerWidth - 40,"
                       " document.getElementById('inbox-link').disabled, document.activeElement.id] })()")
        self.assertEqual(at, [True, True, True, True, False, "inbox-close"])
        n = self.b.js("document.querySelectorAll('#inbox-list .inbox-item').length")

        def paste(link, why=""):
            for field, text in (("inbox-link", link), ("inbox-why", why)):
                self.b.js(f"(() => {{ const f = document.getElementById('{field}'); f.focus(); f.select() }})()")
                if text:
                    self.b.call("Input.insertText", text=text)
            self.b.tap("#inbox-save")

        paste("https://example.org/phone/post/", "from the phone")
        last = ("(() => { const li = document.querySelector('#inbox-list .inbox-item[data-key=\"https://example.org/phone/post\"]');"
                " return [li.querySelector('.inbox-link').textContent, li.querySelector('.inbox-under').textContent] })()")
        self.assertTrue(self.b.wait(f"document.querySelectorAll('#inbox-list .inbox-item').length === {n + 1}"), "the item is not in the list")
        today = datetime.date.today().isoformat()
        self.assertEqual(self.b.js(last), ["example.org/phone/post", f"from the phoneadded {today}Process"])
        self.assertEqual(self.b.js("[document.getElementById('inbox-link').value, document.getElementById('inbox-why').value, document.getElementById('inbox-add-msg').hidden,"
                                   " document.getElementById('inbox-count').textContent, document.getElementById('inbox-badge').textContent]"), ["", "", True, f"{n + 1} items", str(n + 1)])
        lines, now = before.split("\n"), box.read_text(encoding="utf-8").split("\n")
        put = lines.index("- see also the list in Scratchpad") + 1
        self.assertEqual(now, lines[:put] + [f"- https://example.org/phone/post/ — from the phone · added {today}"] + lines[put:])
        # the same link again, and one that was processed: not added, and the page says where each is
        for link, said in (("https://EXAMPLE.org/phone/post#top", f"Not added: already in the inbox, added {today}."),
                           ("arXiv:2111.06377", "Not added: already processed on 2026-11-10 (R03)."),
                           ("something to read", "Not added: not a link: paste a URL, an arXiv id or a DOI.")):
            paste(link)
            self.assertTrue(self.b.wait(f"document.getElementById('inbox-add-msg').textContent === {json.dumps(said)}"), f"{link}: {self.b.js('document.getElementById(`inbox-add-msg`).textContent')}")
            self.assertEqual(self.b.js("document.getElementById('inbox-link').value"), link)  # what was typed stays, to be mended
        time.sleep(2.5)  # a poll of the file leaves what was said
        self.assertEqual(self.b.js("document.getElementById('inbox-add-msg').textContent"), said)
        self.assertEqual(box.read_text(encoding="utf-8").split("\n"), now)
        self.assertEqual(self.b.js("(() => { const m = document.getElementById('inbox-add-msg').getBoundingClientRect(); return m.right <= innerWidth && innerWidth === %d && document.documentElement.scrollWidth <= innerWidth })()" % w), True)
        self.assertEqual(self.b.errors, [])

    def test_inbox_item_takes_a_reading_priority_a_why_and_a_discard(self):
        box = self.tmp / "vault" / "Inbox.md"
        before = box.read_text(encoding="utf-8")
        self.addCleanup(box.write_text, before, encoding="utf-8")
        lines = before.split("\n")
        today = datetime.date.today().isoformat()
        w, h = SIZES[0]
        self.b.size(w, h)
        self.screen([page("tree"), "document.getElementById('inbox-toggle').click()"])
        keys = "[...document.querySelectorAll('#inbox-list .inbox-item')].map(li => li.dataset.key + ' ' + li.dataset.nth).join('|')"
        pressed = "[...document.querySelectorAll('[data-inbox-order]')].map(b => b.dataset.inboxOrder + ' ' + b.getAttribute('aria-pressed')).join('|')"
        blog, mae, mixup = "https://lilianweng.github.io/posts/2021-05-31-contrastive 0", "https://openreview.net/forum?id=abc123 0", "arxiv:2406.01234"
        by_priority = [mae, f"{mixup} 0", "arxiv:2501.00001 0", "doi:10.1109/cvpr.2022.01553 0", blog, "arxiv:2311.09876 0", f"{mixup} 1", "doi:10.1007/s11263-021-01453-z 0"]
        by_date = ["arxiv:2501.00001 0", f"{mixup} 0", "doi:10.1109/cvpr.2022.01553 0", blog, "arxiv:2311.09876 0", f"{mixup} 1", "doi:10.1007/s11263-021-01453-z 0", mae]
        row = lambda k: "document.querySelector(%s)" % json.dumps('#inbox-list .inbox-item[data-key="%s"][data-nth="%s"]' % tuple(k.rsplit(" ", 1)))
        self.assertEqual(self.b.js(keys).split("|"), by_priority)
        self.assertEqual(self.b.js(pressed), "priority true|date false")
        # the reading priority, the why and ✕ of every item are a finger's size, on the screen; so are the order's buttons
        small = self.b.js("[...document.querySelectorAll('#inbox-list select.prio, #inbox-list .inbox-x, #inbox-list button.inbox-why, #inbox [data-inbox-order]')]"
                          ".filter(e => { const r = e.getBoundingClientRect(); return !(r.height >= 44 && r.width >= 44 && r.left >= 0 && r.right <= innerWidth) })"
                          ".map(e => e.className + ' ' + e.textContent.slice(0, 20) + ' ' + JSON.stringify(e.getBoundingClientRect()))")
        self.assertEqual(small, [])
        self.assertEqual(self.b.js("[document.querySelectorAll('#inbox-list select.prio').length, document.querySelectorAll('#inbox-list .inbox-x').length,"
                                   " document.querySelectorAll('#inbox-list button.inbox-why').length, innerWidth, document.documentElement.scrollWidth <= innerWidth]"), [8, 8, 8, w, True])
        self.assertEqual(self.b.js(f"[{row(mae)}.querySelector('select.prio').className, {row(mae)}.querySelector('select.prio').value, {row(blog)}.querySelector('select.prio').className]"),
                         ["prio p-urgent", "urgent", "prio"])
        # by date, and still so after the page is loaded again; the file is as it was
        self.b.tap("[data-inbox-order=date]")
        self.assertTrue(self.b.wait(f"{keys} === {json.dumps('|'.join(by_date))}"), self.b.js(keys))
        self.b.open(self.url)
        self.assertTrue(self.b.wait(f"!document.getElementById('inbox').hidden && {keys} === {json.dumps('|'.join(by_date))}"), self.b.js(keys))
        self.assertEqual(self.b.js(pressed), "priority false|date true")
        self.assertEqual(box.read_text(encoding="utf-8"), before)
        self.b.tap("[data-inbox-order=priority]")
        self.assertTrue(self.b.wait(f"{keys} === {json.dumps('|'.join(by_priority))}"), self.b.js(keys))
        # a reading priority from the menu: one plain word in the item's line, and the item moves up
        self.b.js(f"(() => {{ const s = {row(blog)}.querySelector('select.prio'); s.focus(); s.value = 'urgent'; s.dispatchEvent(new Event('change', {{ bubbles: true }})) }})()")
        self.assertTrue(self.b.wait(f"{keys}.startsWith({json.dumps(blog + '|' + mae)})"), self.b.js(keys))
        at = lines.index("- https://lilianweng.github.io/posts/2021-05-31-contrastive/")
        lines[at] += " · urgent"
        self.assertEqual(box.read_text(encoding="utf-8").split("\n"), lines)
        self.assertEqual(self.b.js(f"[{row(blog)}.querySelector('select.prio').className, document.activeElement === {row(blog)}.querySelector('select.prio')]"), ["prio p-urgent", True])
        self.b.js("document.activeElement.blur()")

        def tap(selector):  # an item may be under the fold of the list
            self.b.js(f"document.querySelector({json.dumps(selector)}).scrollIntoView({{ block: 'center' }})")
            self.b.tap(selector)

        def key(name, code):
            for kind in ("keyDown", "keyUp"):
                self.b.call("Input.dispatchKeyEvent", type=kind, key=name, code=name, windowsVirtualKeyCode=code)

        # a why: a tap opens a field, Esc gives the edit up and not the panel, Enter saves it
        paper = "arxiv:2311.09876 0"
        why = f"{row(paper)}.querySelector('.inbox-why')?.textContent"
        tap(f"#inbox-list .inbox-item[data-key='arxiv:2311.09876'] .inbox-why")
        self.assertTrue(self.b.wait("document.activeElement.className === 'inbox-why-edit'"), "no field for the why")
        self.assertEqual(self.b.js("(() => { const r = document.activeElement.getBoundingClientRect(); return r.height >= 44 && r.right <= innerWidth && parseFloat(getComputedStyle(document.activeElement).fontSize) >= 16 })()"), True)
        self.b.call("Input.insertText", text="given up")
        key("Escape", 27)
        self.assertEqual(self.b.js(f"[document.getElementById('inbox').hidden, {why}, document.querySelectorAll('.inbox-why-edit').length]"), [False, "+ why", 0])
        tap(f"#inbox-list .inbox-item[data-key='arxiv:2311.09876'] .inbox-why")
        self.assertTrue(self.b.wait("document.activeElement.className === 'inbox-why-edit'"), "no field for the why")
        self.b.call("Input.insertText", text="for the related work")
        key("Enter", 13)
        self.assertTrue(self.b.wait(f"{why} === 'for the related work'", 4), self.b.js("document.getElementById('inbox-msg').textContent"))
        at = lines.index("- 2311.09876")
        lines[at] += " — for the related work"
        self.assertEqual(box.read_text(encoding="utf-8").split("\n"), lines)
        # a why that would read as a reading priority is not taken: the foot says so, and it stays in its field
        tap(f"#inbox-list .inbox-item[data-key='arxiv:2311.09876'] .inbox-why")
        self.assertTrue(self.b.wait("document.activeElement.className === 'inbox-why-edit'"), "no field for the why")
        self.b.js("document.activeElement.select()")
        self.b.call("Input.insertText", text="urgent")
        key("Enter", 13)
        self.assertTrue(self.b.wait("document.getElementById('inbox-msg').textContent.startsWith('Not changed: ')"), "nothing said of a why not taken")
        self.assertEqual(self.b.js("[document.querySelector('.inbox-why-edit').value, document.getElementById('inbox-msg').classList.contains('error')]"), ["urgent", True])
        # the sentence wraps in the foot: the page is no wider for it
        self.assertEqual(self.b.js("(() => { const m = document.getElementById('inbox-msg').getBoundingClientRect(); return [innerWidth, m.left >= 0 && m.right <= innerWidth, document.documentElement.scrollWidth <= innerWidth] })()"), [w, True, True])
        key("Escape", 27)
        self.assertEqual(self.b.js(f"[document.getElementById('inbox').hidden, {why}]"), [False, "for the related work"])
        self.assertEqual(box.read_text(encoding="utf-8").split("\n"), lines)
        # ✕ asks once: a first tap changes nothing, and leaving it takes the question back
        x = "#inbox-list .inbox-item[data-key='arxiv:2311.09876'] .inbox-x"
        said = f"document.querySelector({json.dumps(x)}).textContent"
        tap(x)
        self.assertTrue(self.b.wait(f"{said} === 'Discard?'"), self.b.js(said))
        self.assertEqual(self.b.js("(() => { const r = document.querySelector('.inbox-x.armed').getBoundingClientRect(); return r.right <= innerWidth && r.height >= 44 })()"), True)
        self.b.js("document.activeElement.blur()")
        self.assertTrue(self.b.wait(f"{said} === '✕'"), self.b.js(said))
        self.assertEqual(box.read_text(encoding="utf-8").split("\n"), lines)
        # a second tap discards it: out of the list, and one line under Processed
        tap(x)
        self.assertTrue(self.b.wait(f"{said} === 'Discard?'"), self.b.js(said))
        tap(x)
        self.assertTrue(self.b.wait(f"!{row(paper)}", 4), self.b.js("document.getElementById('inbox-msg').textContent"))
        self.assertEqual(self.b.js("[document.querySelectorAll('#inbox-list .inbox-item').length, document.getElementById('inbox-count').textContent, document.getElementById('inbox-badge').textContent]"), [7, "7 items", "7"])
        del lines[at]
        self.assertEqual(lines[-1], "")
        lines[-1:] = [f"- {today} https://arxiv.org/abs/2311.09876 — discarded", ""]
        self.assertEqual(box.read_text(encoding="utf-8").split("\n"), lines)
        # the link saved again is said to have been discarded
        self.b.js("(() => { const f = document.getElementById('inbox-link'); f.focus(); f.select() })()")
        self.b.call("Input.insertText", text="2311.09876")
        self.b.tap("#inbox-save")
        note = f"Not added: already processed on {today} (discarded)."
        self.assertTrue(self.b.wait(f"document.getElementById('inbox-add-msg').textContent === {json.dumps(note)}"), self.b.js("document.getElementById('inbox-add-msg').textContent"))
        self.assertEqual(self.b.js("[innerWidth, visualViewport.offsetTop, document.documentElement.scrollWidth <= innerWidth]"), [w, 0, True])
        self.assertEqual(self.b.errors, [])

    def test_inbox_process_is_a_chip_and_a_brief_shows_at_a_tap(self):
        box = self.tmp / "vault" / "Inbox.md"
        before = box.read_text(encoding="utf-8")
        w, h = SIZES[0]
        self.b.size(w, h)
        self.screen([page("tree"), "document.getElementById('inbox-toggle').click()"])

        def tap(selector):  # an item may be under the fold of the list
            self.b.js(f"document.querySelector({json.dumps(selector)}).scrollIntoView({{ block: 'center' }})")
            self.b.tap(selector)

        # Process on every item and the mark of the briefed one: a finger's size, on the screen
        small = self.b.js("[...document.querySelectorAll('#inbox-list .inbox-process, #inbox-list .inbox-briefed')]"
                          ".filter(e => { const r = e.getBoundingClientRect(); return !(r.height >= 44 && r.width >= 44 && r.left >= 0 && r.right <= innerWidth) })"
                          ".map(e => e.className + ' ' + e.textContent.slice(0, 20) + ' ' + JSON.stringify(e.getBoundingClientRect()))")
        self.assertEqual(small, [])
        self.assertEqual(self.b.js("[document.querySelectorAll('#inbox-list .inbox-process').length, [...document.querySelectorAll('#inbox-list .inbox-briefed')].map(b => b.textContent + ' ' + b.closest('li').dataset.key),"
                                   " [...document.querySelectorAll('#inbox-list .inbox-process')].every(b => b.textContent === 'Process' && !b.disabled), innerWidth, document.documentElement.scrollWidth <= innerWidth]"),
                         [8, ["briefed 2026-11-20 arxiv:2406.01234"], True, w, True])
        # the brief is shut until its mark is tapped; then its lines, under the item and within the screen
        mark, brief = "#inbox-list .inbox-briefed", "document.querySelector('#inbox-list .inbox-brief')"
        state = (f"(() => {{ const b = {brief}, r = b.getBoundingClientRect(); return [b.hidden, document.querySelector({json.dumps(mark)}).getAttribute('aria-expanded'),"
                 " [...b.children].map(l => l.textContent), b.hidden || (r.left >= 0 && r.right <= innerWidth && r.height > 0)] })()")
        lines = ["claims strong augmentation still helps at ViT-H scale", "touches R07, E12", "recommends: reference under D04"]
        self.assertEqual(self.b.js(state), [True, "false", lines, True])
        tap(mark)
        self.assertTrue(self.b.wait(f"!{brief}.hidden"), "the brief is not shown")
        self.assertEqual(self.b.js(state), [False, "true", lines, True])
        self.assertEqual(self.b.js(f"{brief}.closest('li').dataset.key"), "arxiv:2406.01234")
        # it stays open when the list is drawn again
        self.b.tap("[data-inbox-order=date]")
        self.assertTrue(self.b.wait("document.querySelector('[data-inbox-order=date]').getAttribute('aria-pressed') === 'true'"))
        self.assertEqual(self.b.js(state), [False, "true", lines, True])
        self.b.tap("[data-inbox-order=priority]")
        tap(mark)
        self.assertTrue(self.b.wait(f"{brief}.hidden"), "the brief is not shut")
        # Process asks the chat: the foot says so, the button waits against a second tap, nothing is written
        foot = "document.getElementById('inbox-msg').textContent"
        first = "#inbox-list .inbox-item[data-key='arxiv:2406.01234'][data-nth='0'] .inbox-process"
        tap(first)
        self.assertTrue(self.b.wait(f"{foot} === 'Asked in the chat: Claude starts from its brief there.'", 4), self.b.js(foot))
        self.assertEqual(self.b.js(f"[document.querySelector({json.dumps(first)}).disabled, document.getElementById('inbox-msg').classList.contains('error')]"), [True, False])
        other = "#inbox-list .inbox-item[data-key='arxiv:2311.09876'] .inbox-process"
        tap(other)
        self.assertTrue(self.b.wait(f"{foot} === 'Asked in the chat: Claude reads it and gives its brief there.'", 4), self.b.js(foot))
        self.assertEqual(self.b.js("[...document.querySelectorAll('#inbox-list .inbox-process')].filter(b => b.disabled).length"), 2)
        self.assertEqual(self.b.js("(() => { const m = document.getElementById('inbox-msg').getBoundingClientRect(); return [innerWidth, m.left >= 0 && m.right <= innerWidth, document.documentElement.scrollWidth <= innerWidth] })()"), [w, True, True])
        self.assertEqual(box.read_text(encoding="utf-8"), before)
        self.assertEqual(self.b.errors, [])
        # a page that may not write has no Process; the brief is still read
        self.b.js("try { localStorage.clear() } catch (e) {}")
        self.b.open(re.sub(r"\?token=[^&#]+", "", self.url))
        self.b.js("document.getElementById('inbox-toggle').click()")
        self.assertTrue(self.b.wait("document.querySelectorAll('#inbox-list .inbox-item').length === 8"), "the read-only page lists no items")
        self.assertEqual(self.b.js("[document.querySelectorAll('#inbox-list .inbox-process').length, document.querySelectorAll('#inbox-list .inbox-briefed').length]"), [0, 1])
        tap(mark)
        self.assertTrue(self.b.wait(f"!{brief}.hidden"), "the brief is not shown on a read-only page")

    def test_back_returns_from_a_deck_to_the_decks(self):
        w, h = SIZES[0]
        self.back_closes(w, h, [page("slides"), "document.querySelector('.sl-item').click()"],
                         "document.getElementById('sl-body').dataset.pane === 'text' && !!document.querySelector('#sl-cm .CodeMirror')", "a deck's text")
        self.assertEqual(self.b.js("document.getElementById('sl-body').dataset.pane"), "list")

    def test_comment_on_a_selection_by_touch(self):
        """A long press selects (no mouseup), the bar comes once the selection rests, a tap on Comment opens the composer."""
        w, h = SIZES[0]
        self.b.size(w, h)
        self.screen([page("tree"), tap_node("D00")])
        self.assertTrue(self.b.wait("[...document.querySelectorAll('#note p')].some(p => p.textContent.length > 40)"))
        self.b.js("""(() => { const p = [...document.querySelectorAll('#note p')].find(p => p.textContent.length > 40);
            const t = document.createTreeWalker(p, NodeFilter.SHOW_TEXT).nextNode();
            getSelection().setBaseAndExtent(t, 0, t, Math.min(20, t.length)) })()""")
        self.assertTrue(self.b.wait("!document.getElementById('sel-bar').hidden"), "no bar under a touch selection")
        r = self.b.js("(() => { const r = document.getElementById('sel-bar').getBoundingClientRect(); return [r.top, r.bottom] })()")
        self.assertLessEqual(r[1], h, "the bar is below the screen")
        self.b.tap("#sel-bar [data-compose=comment]")
        self.assertTrue(self.b.wait("!document.getElementById('composer').hidden"), "a tap on Comment did not open the composer")

    def test_back_returns_to_the_note_a_link_came_from(self):
        w, h = SIZES[0]
        self.b.size(w, h)
        self.screen([page("tree"), tap_node("D00")])
        self.assertTrue(self.b.wait("[...document.querySelectorAll('#note a')].some(a => /E01/.test(a.textContent))"))
        self.b.js("[...document.querySelectorAll('#note a')].find(a => /E01/.test(a.textContent)).click()")
        self.assertTrue(self.b.wait("/E01/.test(document.querySelector('#note h1') && document.querySelector('#note h1').textContent)"))
        self.b.js("history.back()")
        self.assertTrue(self.b.wait("/D00/.test(document.querySelector('#note h1') && document.querySelector('#note h1').textContent)"),
                        "Back from E01 did not show D00 again")
        self.b.js("history.back()")
        self.assertTrue(self.b.wait("document.getElementById('drawer').hidden"), "the second Back did not close the note")


if __name__ == "__main__":
    unittest.main()
