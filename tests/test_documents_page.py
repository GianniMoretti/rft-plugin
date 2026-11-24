"""A document's file list in the page (.scratch/local-overleaf, step 2), by real clicks, drops and
keys in headless Chromium, with the server behind it: a folder and a file made, a file renamed
(its copies kept), a file with copies deleted (asked first, then shown as lost), an image dropped
on a folder (its bytes on disk as they were) and shown instead of opened as text, the engine
chosen, the main file asked for and chosen. The vault is the clean-source fixture's. It needs
Chromium (Playwright's, or RFT_CHROME) and the websocket-client module, and skips without them.
RFT_DOCUMENTS_SHOTS=<dir> also saves a screenshot of each step.

    python3 -m unittest tests.test_documents_page -v
"""
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_phone  # noqa: E402
from test_documents import empty_document, png  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "local-overleaf"
ROWS = "[...document.querySelectorAll('#ms-list .ms-tree > .ms-file')].map(r => r.querySelector('.ms-title').textContent + (r.querySelector('.ms-main') ? ' [main]' : '') + (r.querySelector('.ms-flag') ? ' [out]' : ''))"


@unittest.skipUnless(test_phone.CHROME and test_phone.websocket, "needs Chromium (Playwright's, or RFT_CHROME) and websocket-client")
class DocumentsPage(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="rft-documents-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.vault = self.tmp / "vault"
        shutil.copytree(FIXTURE / "project" / "vault", self.vault)
        body = "\\documentclass{article}\n\\begin{document}\n%s\n\\end{document}\n"
        empty_document(self.vault, "two", {"paper.tex": body % "Paper.", "supplement.tex": body % "Supplement."})
        self.doc = self.vault / "documents" / "paper"
        self.server = subprocess.Popen([sys.executable, str(ROOT / "server" / "rft_server.py"), "--vault", str(self.vault), "--web", str(ROOT / "web"),
                                        "--port", "0", "--project", "demo", "--no-watch"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        self.addCleanup(self.server.wait, 10)
        self.addCleanup(self.server.terminate)
        self.url = re.search(r"RFT_SERVER_URL (\S+)", self.server.stdout.readline()).group(1)
        (self.tmp / "profile").mkdir()
        self.b = test_phone.Browser(self.tmp / "profile")
        self.addCleanup(self.b.close)
        self.b.call("Emulation.setDeviceMetricsOverride", width=1500, height=900, deviceScaleFactor=1, mobile=False)
        self.shots = os.environ.get("RFT_DOCUMENTS_SHOTS")
        self.n = 0

    def shot(self, name):
        if self.shots:
            self.n += 1
            Path(self.shots).mkdir(parents=True, exist_ok=True)
            self.b.shot(Path(self.shots) / f"{self.n:02d}-{name}.png")

    def start(self, doc="paper"):
        b = self.b
        b.open(self.url)
        b.js(test_phone.page("manuscript"))
        self.assertTrue(b.wait("!!document.querySelector('[data-ms-level=documents]') && !document.getElementById('ms-body').hidden"), "the manuscript tab did not open")
        b.js("document.querySelector('[data-ms-level=documents]').click()")
        self.assertTrue(b.wait("document.querySelectorAll('#ms-list .ms-tree > .ms-file').length > 0"), "no file list")
        if doc != "paper":
            b.js("(() => { const s = document.getElementById('ms-doc'); s.value = %s; s.dispatchEvent(new Event('change', { bubbles: true })) })()" % json.dumps(doc))
            time.sleep(0.5)
        # what the page asks in a dialog is answered here, and kept
        b.js("window.asked = []; window.answers = []; window.prompt = (q, v) => { window.asked.push(q); return window.answers.shift() ?? null }; window.confirm = q => { window.asked.push(q); return true }")

    def act(self, row, label):
        """A click on a row's own action, by its label."""
        self.b.js("[...document.querySelectorAll('#ms-list .ms-row-act')].find(b => b.getAttribute('aria-label') === %s).click()" % json.dumps(label))

    def bar(self, word):
        self.b.js("[...document.querySelectorAll('#ms-list .ms-files-bar button')].find(b => b.textContent === %s).click()" % json.dumps(word))

    def tracking(self, name="paper"):
        return json.loads((self.vault / "documents" / ".rft" / name / "tracking.json").read_text())

    def test_the_file_list_by_clicks_and_a_drop(self):
        b = self.b
        self.start()
        self.assertEqual(b.js(ROWS), ["figures/", "loss.pdf", "sections/", "method.tex", "main.tex [main]", "refs.bib"])
        self.shot("list")
        # a folder and a file in it, made from the page; the new file opens in the editor
        b.js("window.answers.push('chapters')")
        self.bar("+ Folder")
        self.assertTrue(b.wait(f"{ROWS}.includes('chapters/')"), "no folder row")
        self.assertTrue((self.doc / "chapters").is_dir())
        b.js("window.answers.push('intro.tex')")
        self.act("chapters", "New file in chapters")
        self.assertTrue(b.wait("document.querySelector('#ms-head .ms-file') && document.querySelector('#ms-head .ms-file').textContent === 'chapters/intro.tex'"), "the new file is not open")
        self.assertEqual((self.doc / "chapters" / "intro.tex").read_bytes(), b"")
        b.js("(() => { const cm = document.querySelector('#ms-cm .CodeMirror').CodeMirror; cm.setValue('An introduction.\\n'); })()")
        b.js("document.querySelector('#ms-head [aria-label=Save]').click()")
        self.assertTrue(b.wait("document.getElementById('ms-status').textContent === 'Saved'"), "not saved")
        self.assertEqual((self.doc / "chapters" / "intro.tex").read_text(), "An introduction.\n")
        self.shot("made")
        # a file renamed: its copies stay its own, and the page says the main file no longer takes it in
        b.js("window.answers.push('sections/approach.tex')")
        self.act("sections/method.tex", "Rename sections/method.tex")
        self.assertTrue(b.wait(f"{ROWS}.includes('approach.tex [out]')"), b.js(ROWS))
        self.assertTrue((self.doc / "sections" / "approach.tex").is_file())
        self.assertEqual({c["file"] for c in self.tracking()["copies"]}, {"main.tex", "sections/approach.tex"})
        copies = "[...document.querySelectorAll('#ms-list .ms-tree > .ms-copy .ms-id')].map(x => x.textContent)"
        self.assertEqual(b.js(copies), ["S01#2", "S04", "S03", "S07", "S05", "S01#1", "S02"])
        self.shot("renamed")
        # a file that holds copies is deleted only after the question that names them; they are then lost
        b.js("window.asked = []")
        self.act("sections/approach.tex", "Delete sections/approach.tex")
        self.assertTrue(b.wait(f"!{ROWS}.includes('approach.tex [out]')"), "still listed")
        self.assertIn("4 copies of snippets (S01#2, S04, S03, S07)", b.js("window.asked.join(' | ')"))
        self.assertFalse((self.doc / "sections" / "approach.tex").exists())
        self.assertTrue(b.wait("[...document.querySelectorAll('#ms-list .ms-sub')].some(x => x.textContent === 'Lost copies')"))
        lost = b.js("(() => { const h = [...document.querySelectorAll('#ms-list .ms-sub')].find(x => x.textContent === 'Lost copies'); return [...h.nextElementSibling.querySelectorAll('.ms-id')].map(x => x.textContent) })()")
        self.assertEqual(lost, ["S01#2", "S04", "S03", "S07", "S06"])
        self.shot("deleted")
        # an image dropped on a folder goes into it, byte for byte, and is shown, not opened as text
        data = png(8, 8)
        b.js("""(() => {
          const bytes = Uint8Array.from(atob(%s), c => c.charCodeAt(0))
          const dt = new DataTransfer()
          dt.items.add(new File([bytes], 'logo.png', { type: 'image/png' }))
          const row = [...document.querySelectorAll('#ms-list .ms-folder')].find(r => r.dataset.folder === 'figures')
          row.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
          row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
        })()""" % json.dumps(base64.b64encode(data).decode()))
        self.assertTrue(b.wait(f"{ROWS}.includes('logo.png')"), b.js("document.getElementById('ms-status').textContent"))
        self.assertEqual((self.doc / "figures" / "logo.png").read_bytes(), data)
        b.js("[...document.querySelectorAll('#ms-list .ms-tree > .ms-file')].find(r => r.querySelector('.ms-title').textContent === 'logo.png').click()")
        self.assertTrue(b.wait("!document.getElementById('ms-view').hidden && !!document.querySelector('#ms-view img') && document.querySelector('#ms-view img').naturalWidth === 8"), "the image is not shown")
        self.assertTrue(b.js("document.getElementById('ms-cm').hidden"))
        self.shot("image")
        b.js("[...document.querySelectorAll('#ms-view button')].find(x => x.textContent === 'Back to the text').click()")
        self.assertTrue(b.js("document.getElementById('ms-view').hidden && !document.getElementById('ms-cm').hidden"))
        # a file too large is said before it is sent
        b.js("""(() => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(21000000)], 'big.pdf'))
          document.getElementById('ms-list').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt })) })()""")
        time.sleep(0.5)
        self.assertFalse((self.doc / "big.pdf").exists())
        # the engine, chosen in the document's head
        b.js("(() => { const s = document.querySelector('#ms-head select[aria-label=Engine]'); s.value = 'xelatex'; s.dispatchEvent(new Event('change', { bubbles: true })) })()")
        self.assertTrue(b.wait("document.querySelector('#ms-head select[aria-label=Engine]').value === 'xelatex'"))
        deadline = time.time() + 5
        while time.time() < deadline and self.tracking().get("engine") != "xelatex":
            time.sleep(0.1)
        self.assertEqual(self.tracking()["engine"], "xelatex")
        self.assertEqual(b.errors, [])

    def test_the_main_file_is_asked_for_and_chosen(self):
        b = self.b
        self.start("two")
        self.assertTrue(b.wait("!!document.querySelector('#ms-list .ms-ask')"), "the page does not ask")
        self.assertEqual(b.js("[...document.querySelectorAll('#ms-list .ms-ask button')].map(x => x.textContent)"), ["paper.tex", "supplement.tex"])
        self.shot("asked")
        b.js("[...document.querySelectorAll('#ms-list .ms-ask button')].find(x => x.textContent === 'supplement.tex').click()")
        self.assertTrue(b.wait("!document.querySelector('#ms-list .ms-ask')"), "still asking")
        self.assertEqual(self.tracking("two")["main"], "supplement.tex")
        self.assertEqual(b.js(ROWS), ["paper.tex [out]", "supplement.tex [main]"])
        # changed later, in the document's head
        b.js("(() => { const s = [...document.querySelectorAll('#ms-head select')].find(x => x.getAttribute('aria-label') === 'Main file'); s.value = 'paper.tex'; s.dispatchEvent(new Event('change', { bubbles: true })) })()")
        self.assertTrue(b.wait(f"{ROWS}.join() === 'paper.tex [main],supplement.tex [out]'"), b.js(ROWS))
        self.assertEqual(self.tracking("two")["main"], "paper.tex")
        self.shot("chosen")
        self.assertEqual(b.errors, [])


if __name__ == "__main__":
    unittest.main()
