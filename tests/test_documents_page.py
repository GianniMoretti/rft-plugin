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
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import procs  # noqa: E402
import test_phone  # noqa: E402
from test_documents import empty_document, png  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "local-overleaf"
ROWS = "[...document.querySelectorAll('#ms-list .ms-tree > .ms-file')].map(r => r.querySelector('.ms-title').textContent + (r.querySelector('.ms-main') ? ' [main]' : '') + (r.querySelector('.ms-flag') ? ' [out]' : ''))"


@unittest.skipUnless(test_phone.CHROME and test_phone.websocket, "needs Chromium (Playwright's, or RFT_CHROME) and websocket-client")
class DocumentsPage(unittest.TestCase):
    def setUp(self):
        self.tmp = procs.folder("rft-documents-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.vault = self.tmp / "vault"
        shutil.copytree(FIXTURE / "project" / "vault", self.vault)
        body = "\\documentclass{article}\n\\begin{document}\n%s\n\\end{document}\n"
        empty_document(self.vault, "two", {"paper.tex": body % "Paper.", "supplement.tex": body % "Supplement."})
        self.doc = self.vault / "documents" / "paper"
        self.server = procs.start([sys.executable, str(ROOT / "server" / "rft_server.py"), "--vault", str(self.vault), "--web", str(ROOT / "web"),
                                        "--port", "0", "--project", "demo", "--no-watch"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        self.addCleanup(procs.stop, self.server)
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

    def test_a_template_loaded_from_a_zip_and_a_document_made_from_it(self):
        b = self.b
        self.start()
        b.js("document.getElementById('ms-new-doc').click()")
        self.assertTrue(b.wait("!document.getElementById('ms-doc-form').hidden"))
        options = "[...document.querySelectorAll('#ms-doc-template option')].map(o => o.textContent)"
        self.assertEqual(b.js(options), ["Paper (article)", "Thesis chapter (report)"])
        # a zip picked in the page (made here by the page's own zip writer, as a folder picked there is)
        pick = """(async () => {
          const enc = new TextEncoder()
          const zip = new Blob(RftManuscript.zipOf([{ path: 'my kit/paper.tex', bytes: enc.encode(%s) }, { path: 'my kit/kit.sty', bytes: enc.encode('%% the style\\n') },
                                                    { path: 'my kit/figures/ø.png', bytes: new Uint8Array([137, 80, 78, 71, 0, 255]) }]))
          const dt = new DataTransfer()
          dt.items.add(new File([zip], 'my kit.zip', { type: 'application/zip' }))
          const input = document.getElementById('ms-template-zip')
          input.files = dt.files
          input.dispatchEvent(new Event('change', { bubbles: true }))
        })()""" % json.dumps("\\documentclass{article}\n\\begin{document}\nSample text.\n\\end{document}\n")
        b.js(pick)
        self.assertTrue(b.wait(f"{options}.includes('my-kit · 3 files')"), b.js(options))
        self.assertEqual(b.js("document.getElementById('ms-doc-template').value"), "my-kit")
        kit = self.vault / "templates" / "my-kit"
        self.assertEqual({p.relative_to(kit).as_posix(): p.read_bytes() for p in kit.rglob("*") if p.is_file()},
                         {"paper.tex": b"\\documentclass{article}\n\\begin{document}\nSample text.\n\\end{document}\n", "kit.sty": b"% the style\n", "figures/\xc3\xb8.png".encode("latin-1").decode("utf-8"): bytes([137, 80, 78, 71, 0, 255])})
        # the document's name follows the template's; a kit's files come as they are, so there is no title to give
        self.assertEqual(b.js("[document.getElementById('ms-doc-name').value, document.getElementById('ms-doc-title').disabled]"), ["my-kit", True])
        self.shot("template-loaded")
        # the same name again: another is asked for, and nothing is overwritten
        b.js("window.asked = []; window.answers.push('my-kit-b')")
        b.js(pick)
        self.assertTrue(b.wait(f"{options}.includes('my-kit-b · 3 files')"), b.js(options))
        self.assertIn("there is already a template my-kit", b.js("window.asked.join(' | ')"))
        self.assertTrue((self.vault / "templates" / "my-kit-b" / "paper.tex").is_file())
        # Create asks the session, which makes the document from the template (played here); the page opens it on its main file
        b.js("(() => { const s = document.getElementById('ms-doc-template'); s.value = 'my-kit'; s.dispatchEvent(new Event('change', { bubbles: true })) })()")
        b.js("(() => { const n = document.getElementById('ms-doc-name'); n.value = 'camera-ready'; n.dispatchEvent(new Event('input', { bubbles: true })) })()")
        b.js("document.getElementById('ms-doc-ok').click()")
        line = self.server.stdout.readline()
        self.assertEqual(line.split(" ", 1)[0], "RFT_MANUSCRIPT")
        self.assertEqual(json.loads(line.split(" ", 1)[1]), {"action": "document", "name": "camera-ready", "template": "my-kit"})
        shutil.copytree(kit, self.vault / "documents" / "camera-ready")
        empty_document(self.vault, "camera-ready", {}, {"template": "my-kit", "main": "paper.tex"})
        self.assertTrue(b.wait("document.getElementById('ms-doc').value === 'camera-ready' && !!document.querySelector('#ms-head .ms-file') && document.querySelector('#ms-head .ms-file').textContent === 'paper.tex'", 12),
                        b.js("document.getElementById('ms-status').textContent"))
        self.assertEqual(b.js(ROWS), ["figures/", "ø.png", "kit.sty", "paper.tex [main]"])
        self.assertIn("Sample text.", b.js("document.querySelector('#ms-cm .CodeMirror').CodeMirror.getValue()"))
        self.shot("made-from-template")
        self.assertEqual(b.errors, [])

    def test_duplicate_bring_in_and_a_templates_files_from_the_more_menu(self):
        b = self.b
        kit = self.vault / "templates" / "venue"
        kit.mkdir(parents=True)
        (kit / "venue.cls").write_text("% the class\n")
        (kit / "main.tex").write_text("\\documentclass{venue}\n\\begin{document}\nSample.\n\\end{document}\n")
        self.start()
        more = "(what => { const s = document.querySelector('#ms-list .ms-more'); s.value = what; s.dispatchEvent(new Event('change', { bubbles: true })) })"
        report = "[...document.querySelectorAll('#ms-errors .ms-report')].map(x => x.textContent)"
        # a template's files added: what is there is skipped and named, nothing overwritten
        mine = (self.doc / "main.tex").read_bytes()
        b.js("window.answers.push('venue')")
        b.js(f"{more}('add-template')")
        self.assertTrue(b.wait(f"{report}.length === 3"), b.js(report))
        self.assertEqual(b.js(report)[:2], ["Added 1 file of venue to paper: venue.cls.", "Skipped, because paper already has a file of that path (nothing is overwritten): main.tex."])
        self.assertEqual((self.doc / "main.tex").read_bytes(), mine)
        self.assertTrue(b.wait(f"{ROWS}.includes('venue.cls')"))
        self.shot("template-files-added")
        # a duplicate: the page moves to it, with the same files and copies
        copies = "[...document.querySelectorAll('#ms-list .ms-tree > .ms-copy .ms-id')].map(x => x.textContent)"
        before = b.js(copies)
        b.js("window.answers.push('paper-v2')")
        b.js(f"{more}('duplicate')")
        self.assertTrue(b.wait("document.getElementById('ms-doc').value === 'paper-v2'"), "the duplicate is not open")
        self.assertTrue(b.wait(f"{ROWS}.includes('venue.cls') && {copies}.length === {len(before)}"))
        self.assertEqual(b.js(copies), before)
        self.assertEqual((self.vault / "documents" / "paper-v2" / "main.tex").read_bytes(), mine)
        # the document `two` brought into a folder of the duplicate: what was done and what remains is said, each place a click away
        b.js("window.answers.push('two', 'papers/two')")
        b.js(f"{more}('bring-in')")
        self.assertTrue(b.wait(f"{report}.length >= 2 && {report}[0].startsWith('Brought two into papers/two/ of paper-v2: 2 files')"), b.js(report))
        self.assertIn("paper-v2 takes none of them in yet", b.js(report)[1])
        self.assertTrue((self.vault / "documents" / "paper-v2" / "papers" / "two" / "paper.tex").is_file())
        self.assertTrue(b.wait(f"{ROWS}.includes('papers/')"))
        self.assertEqual(b.js("document.querySelectorAll('#ms-list .ms-ask').length"), 0, "the duplicate keeps its own main file")
        self.shot("brought-in")
        self.assertEqual(b.errors, [])


if __name__ == "__main__":
    unittest.main()
