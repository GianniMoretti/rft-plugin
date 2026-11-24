"""A document's repository in the page (.scratch/local-overleaf, step 3), by real clicks in
headless Chromium, with the server and real git behind it: a bare repository made by the test and
a second clone that plays the co-author. Connect by an address, Push with a message, Check and
Pull what the co-author sent, a conflict shown as git's own lines with Compile and Push waiting,
resolved in the editor, and a document made from a repository. It needs Chromium and the
websocket-client module, and skips without them. RFT_DOCUMENTS_SHOTS=<dir> saves screenshots.

    python3 -m unittest tests.test_git_page -v
"""
import json
import os
import shutil
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_documents_page  # noqa: E402
import test_phone  # noqa: E402
from test_git import git  # noqa: E402

HEAD = "(document.querySelector('#ms-head .ms-git') || { textContent: '' }).textContent"


@unittest.skipUnless(test_phone.CHROME and test_phone.websocket and shutil.which("git"), "needs Chromium, websocket-client and git")
class GitPage(test_documents_page.DocumentsPage):
    def setUp(self):
        # git as a fresh machine has it, for the server too
        self.home = Path(__import__("tempfile").mkdtemp(prefix="rft-git-page-"))
        self.addCleanup(shutil.rmtree, self.home, True)
        config = self.home / "gitconfig"
        config.write_text("[user]\n\tname = The User\n\temail = user@example.org\n[init]\n\tdefaultBranch = main\n")
        for k, v in {"GIT_CONFIG_GLOBAL": str(config), "GIT_CONFIG_NOSYSTEM": "1"}.items():
            was = os.environ.get(k)
            os.environ[k] = v
            self.addCleanup(lambda k=k, was=was: os.environ.pop(k, None) if was is None else os.environ.__setitem__(k, was))
        super().setUp()
        self.remote = self.home / "remote.git"
        git(self.home, "init", "--quiet", "--bare", "-b", "main", str(self.remote))

    def coauthor(self) -> Path:
        there = self.home / "coauthor"
        if not there.exists():
            git(self.home, "clone", "--quiet", str(self.remote), str(there))
            git(there, "config", "user.name", "A Coauthor")
            git(there, "config", "user.email", "coauthor@example.org")
        else:
            git(there, "pull", "--quiet")
        return there

    def sent(self, there: Path, message: str) -> None:
        git(there, "add", "--all")
        git(there, "commit", "--quiet", "-m", message)
        git(there, "push", "--quiet")

    def press(self, word: str) -> None:
        self.assertTrue(self.b.wait("[...document.querySelectorAll('#ms-head .ms-git button')].some(b => b.textContent === %s && !b.disabled)" % json.dumps(word)), f"no {word} button: {self.b.js(HEAD)}")
        self.b.js("[...document.querySelectorAll('#ms-head .ms-git button')].find(b => b.textContent === %s).click()" % json.dumps(word))

    def says(self, text: str, timeout: float = 15.0) -> None:
        self.assertTrue(self.b.wait(f"{HEAD}.includes({json.dumps(text)})", timeout), f"the head says: {self.b.js(HEAD)!r}")

    def test_connect_push_pull_and_a_conflict_resolved_in_the_editor(self):
        b = self.b
        self.start()
        self.says("Not shared")
        self.shot("git-not-shared")
        # connect by its address: nothing is sent yet
        b.js("window.answers.push(%s)" % json.dumps(str(self.remote)))
        self.press("Connect to a repository…")
        self.says("4 files changed since the last push or pull")
        self.assertFalse((self.doc / ".git").exists())
        self.assertEqual(git(self.home, "--git-dir", str(self.remote), "branch", "--list").strip(), "")
        # push, with a message
        b.js("window.asked = []; window.answers.push('The paper as it is')")
        self.press("Push…")
        self.says("0 behind · 0 ahead · nothing changed")
        self.assertIn("What changed in paper?", b.js("window.asked.join(' | ')"))
        there = self.coauthor()
        self.assertEqual(git(there, "log", "--format=%s").strip(), "The paper as it is")
        self.shot("git-pushed")
        # the co-author sends a note and a new title; Check says the document is behind; Pull brings them
        (there / "notes.txt").write_text("A note of the co-author's.\n")
        text = (there / "main.tex").read_text()
        (there / "main.tex").write_text(text.replace("\\title{CutMix in the low-data regime}", "\\title{CutMix when data is scarce}"))
        self.sent(there, "A note and a title")
        self.press("Check")
        self.says("1 commit behind")
        # meanwhile the user changed the same line, in the editor
        b.js("(() => { const cm = document.querySelector('#ms-cm .CodeMirror').CodeMirror; cm.setValue(cm.getValue().replace('\\\\title{CutMix in the low-data regime}', '\\\\title{CutMix with a thousand images}')) })()")
        b.js("document.querySelector('#ms-head [aria-label=Save]').click()")
        self.assertTrue(b.wait("document.getElementById('ms-status').textContent === 'Saved'"))
        self.press("Pull")
        self.says("conflict in main.tex")
        self.assertTrue((self.doc / "notes.txt").is_file())
        self.assertTrue(b.wait(f"{test_documents_page.ROWS}.includes('notes.txt')"))
        self.assertTrue(b.wait("[...document.querySelectorAll('#ms-list .ms-sub')].some(x => x.textContent === 'Conflicts')"), "no Conflicts in the list")
        editor = "document.querySelector('#ms-cm .CodeMirror').CodeMirror.getValue()"
        self.assertTrue(b.wait(f"{editor}.includes('<<<<<<< HEAD') && {editor}.includes('>>>>>>> ')"), "git's lines are not in the editor")
        self.shot("git-conflict")
        # Pull and Push wait, and so does Compile
        self.assertTrue(b.js("[...document.querySelectorAll('#ms-head .ms-git button')].filter(x => ['Pull', 'Push…'].includes(x.textContent)).every(x => x.disabled)"))
        b.js("document.getElementById('ms-compile').click()")
        self.assertTrue(b.wait("(document.getElementById('ms-errors').textContent || '').includes('conflict')", 20), b.js("document.getElementById('ms-errors').textContent"))
        # resolved in the editor: one title kept, git's lines deleted
        b.js("""(() => { const cm = document.querySelector('#ms-cm .CodeMirror').CodeMirror; const t = cm.getValue()
          const a = t.indexOf('<<<<<<< HEAD'), z = t.indexOf('\\n', t.indexOf('>>>>>>> ')) + 1
          cm.setValue(t.slice(0, a) + '\\\\title{CutMix when images are scarce}\\n' + t.slice(z)) })()""")
        b.js("document.querySelector('#ms-head [aria-label=Save]').click()")
        self.says("a pull to finish: Push records it")
        b.js("window.answers.push('One title')")
        self.press("Push…")
        self.says("0 behind · 0 ahead · nothing changed")
        self.assertIn("\\title{CutMix when images are scarce}", (self.coauthor() / "main.tex").read_text())
        # a trace of the tree: Push is refused and the editor goes to it
        b.js("(() => { const cm = document.querySelector('#ms-cm .CodeMirror').CodeMirror; cm.setValue(cm.getValue().replace('\\\\section{Discussion}', '\\\\section{Discussion}\\nAs E05 shows.')) })()")
        b.js("document.querySelector('#ms-head [aria-label=Save]').click()")
        self.says("1 file changed")
        b.js("window.answers.push('A sentence')")
        self.press("Push…")
        time.sleep(1.5)
        self.says("1 file changed")
        self.assertNotIn("As E05 shows.", git(there, "--git-dir", str(self.remote), "show", "main:main.tex"))
        self.assertIn("As E05 shows", b.js("(() => { const cm = document.querySelector('#ms-cm .CodeMirror').CodeMirror; return cm.getLine(cm.getCursor().line) })()"))
        self.assertEqual(b.errors, [])

    def test_a_document_from_a_repository(self):
        b = self.b
        # the repository: the paper, pushed by someone
        there = self.home / "seed"
        shutil.copytree(self.doc, there)
        git(there, "init", "--quiet", "-b", "main")
        git(there, "config", "user.name", "A Coauthor")
        git(there, "config", "user.email", "coauthor@example.org")
        git(there, "add", "--all")
        git(there, "commit", "--quiet", "-m", "The paper")
        git(there, "push", "--quiet", str(self.remote), "main")
        self.start()
        b.js("document.getElementById('ms-new-doc').click()")
        self.assertTrue(b.wait("!document.getElementById('ms-doc-form').hidden"))
        b.js("(() => { const n = document.getElementById('ms-doc-name'); n.value = 'from-overleaf'; n.dispatchEvent(new Event('input', { bubbles: true })) })()")
        b.js("window.answers.push(%s)" % json.dumps(str(self.remote)))
        b.js("document.getElementById('ms-doc-clone').click()")
        self.assertTrue(b.wait("document.getElementById('ms-doc').value === 'from-overleaf'", 20), b.js("document.getElementById('ms-status').textContent"))
        self.assertEqual(b.js(test_documents_page.ROWS), ["figures/", "loss.pdf", "sections/", "method.tex", "main.tex [main]", "refs.bib"])
        self.says("0 behind · 0 ahead · nothing changed")
        folder = self.vault / "documents" / "from-overleaf"
        self.assertFalse((folder / ".git").exists())
        self.assertEqual((folder / "main.tex").read_bytes(), (self.doc / "main.tex").read_bytes())
        # nothing in it is tied to the tree yet
        self.assertEqual(b.js("document.querySelectorAll('#ms-list .ms-tree > .ms-copy').length"), 0)
        self.shot("git-cloned")
        self.assertEqual(b.errors, [])


# the file list's own tests are tests/test_documents_page.py's: not run again from here
for _name in [n for n in dir(test_documents_page.DocumentsPage) if n.startswith("test_")]:
    setattr(GitPage, _name, None)


if __name__ == "__main__":
    unittest.main()
