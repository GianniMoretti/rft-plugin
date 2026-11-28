"""A document as a repository of its own (.scratch/local-overleaf, step 3), on the server's side,
with real git against a bare repository made by the test and a second clone that plays the
co-author. The document's folder holds no .git and the vault's own history keeps its files as
ordinary files; connected, the page is told how far behind and ahead it is; Push records all and
sends, refused on a trace, when behind, and while a conflict is unresolved; Pull merges, leaves a
conflict as git's own lines, and the copies and values read as the co-author left them; a
document is made from a repository. The vault is the clean-source fixture's.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import rft_git  # noqa: E402
import test_documents  # noqa: E402
import test_kits  # noqa: E402

KEY = test_documents.KEY
LATEXMK = shutil.which("latexmk")


def git(cwd: Path, *args: str) -> str:
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError(f"git {' '.join(args)}: {r.stderr or r.stdout}")
    return r.stdout


@unittest.skipUnless(shutil.which("git"), "git is not installed")
class Git(test_documents.Server):
    def setUp(self):
        super().setUp()
        self.tmpdir = Path(self.tmp.name)
        # git as a fresh machine has it: who the user is, and nothing else of this machine's own settings
        config = self.tmpdir / "gitconfig"
        config.write_text("[user]\n\tname = The User\n\temail = user@example.org\n[init]\n\tdefaultBranch = main\n")
        for k, v in {"GIT_CONFIG_GLOBAL": str(config), "GIT_CONFIG_NOSYSTEM": "1"}.items():
            was = os.environ.get(k)
            os.environ[k] = v
            self.addCleanup(lambda k=k, was=was: os.environ.pop(k, None) if was is None else os.environ.__setitem__(k, was))
        self.remote = self.tmpdir / "remote.git"
        git(self.tmpdir, "init", "--quiet", "--bare", "-b", "main", str(self.remote))

    # ------------------------------------------------------------ helpers

    def state(self, name: str = "paper", fetch: bool = False) -> dict:
        status, _, body = self.get(f"/api/manuscript/git?doc={name}{'&fetch=1' if fetch else ''}", headers=[("X-RFT-Token", KEY)])
        self.assertEqual(status, 200)
        return json.loads(body)

    def do(self, action: str, name: str = "paper", **more):
        return self.write("POST", "/api/manuscript/git", {"doc": name, "action": action, **more})

    def connected(self, name: str = "paper") -> None:
        status, got = self.do("connect", name, url=str(self.remote))
        self.assertEqual((status, got.get("error")), (200, None))

    def pushed(self, message: str = "A first version", name: str = "paper") -> dict:
        status, got = self.do("push", name, message=message)
        self.assertEqual((status, got.get("error")), (200, None), got)
        return got

    def coauthor(self) -> Path:
        """A second clone of the remote, elsewhere: the co-author's (or Overleaf's)."""
        there = self.tmpdir / "coauthor"
        if not there.exists():
            git(self.tmpdir, "clone", "--quiet", str(self.remote), str(there))
            git(there, "config", "user.name", "A Coauthor")
            git(there, "config", "user.email", "coauthor@example.org")
        else:
            git(there, "pull", "--quiet")
        return there

    def sent(self, there: Path, message: str) -> None:
        git(there, "add", "--all")
        git(there, "commit", "--quiet", "-m", message)
        git(there, "push", "--quiet")

    def edit(self, path: Path, old: str, new: str) -> None:
        text = path.read_text()
        self.assertEqual(text.count(old), 1, old)
        path.write_text(text.replace(old, new))

    def log(self, name: str = "paper") -> list[str]:
        r = rft_git.run(self.vault, name, "log", "--format=%s")
        return r.stdout.splitlines() if r.returncode == 0 else []

    # ------------------------------------------------------------ a document is a repository (ticket 22)

    def test_the_folder_holds_no_git_and_the_vaults_history_keeps_its_files_as_ordinary_files(self):
        self.assertEqual(self.state(), {"repository": False, "remote": None})
        self.assertFalse(self.ms()["repository"])
        self.connected()
        self.assertTrue(self.ms()["repository"])
        self.assertFalse((self.doc / ".git").exists())
        self.assertEqual([p.name for p in self.doc.rglob(".git*")], [])
        self.assertTrue((self.vault / "documents" / ".rft" / "paper" / "git" / "HEAD").is_file())
        # the vault as a repository of its own: the document's files are its files, the document's git data is not
        git(self.vault, "init", "--quiet")
        seen = git(self.vault, "status", "--porcelain", "--untracked-files=all").splitlines()
        seen = {line[3:].strip('"') for line in seen}
        for f in ("documents/paper/main.tex", "documents/paper/sections/method.tex", "documents/paper/refs.bib", "documents/paper/figures/loss.pdf", "documents/.rft/paper/tracking.json"):
            self.assertIn(f, seen)
        self.assertEqual([f for f in seen if "/git/" in f], [])
        # and the document's own repository does not see the vault's
        self.assertEqual(self.state()["changed"], 4)

    def test_connected_the_page_is_told_how_far_behind_and_ahead_it_is(self):
        self.connected()
        st = self.state()
        self.assertEqual((st["repository"], st["remote"], st["branch"], st["behind"], st["ahead"], st["changed"], st["conflicts"]), (True, str(self.remote), "main", 0, 0, 4, []))
        self.pushed()
        self.assertEqual([self.state()[k] for k in ("behind", "ahead", "changed")], [0, 0, 0])
        # a commit pushed from a second clone: opening the document fetches, and it is 1 behind
        there = self.coauthor()
        (there / "notes.txt").write_text("A note of the co-author's.\n")
        self.sent(there, "A note")
        self.assertEqual(self.state()["behind"], 0, "not known until the remote is asked")
        self.assertEqual([self.state(fetch=True)[k] for k in ("behind", "ahead")], [1, 0])
        # a change of the user's own, recorded by the pull that merges the co-author's: 0 behind, and ahead by what is not sent yet
        self.edit(self.doc / "main.tex", "\\section{Discussion}", "\\section{Discussion}\nA sentence of mine.")
        status, got = self.do("pull")
        self.assertEqual((status, got["behind"], got["ahead"], got["changed"], got["pulled"]), (200, 0, 2, 0, 1))
        self.assertTrue((self.doc / "notes.txt").is_file())
        self.assertEqual(self.pushed("My sentence")["ahead"], 0)

    def test_a_remote_that_cannot_be_reached_is_said_and_blocks_nothing_else(self):
        status, got = self.do("connect", url=str(self.tmpdir / "nowhere.git"))
        self.assertEqual(status, 200)
        self.assertIn("could not be reached", got["error"])
        self.assertIn("could not be reached", self.state(fetch=True)["error"])
        self.assertEqual(self.state()["changed"], 4)
        self.assertEqual(self.ms()["name"], "paper")
        self.assertEqual(self.files("new-file", "extra.tex")[0], 201)
        status, got = self.do("push", message="x")
        self.assertEqual(status, 502)
        self.assertEqual(self.log(), [], "nothing is recorded when nothing can be sent")
        # an address that is none, the key, a document that is none
        for bad in ("", "--upload-pack=evil", "ext::sh -c evil", "two words", "relative/path"):
            self.assertEqual(self.do("connect", url=bad)[0], 400, bad)
        self.assertEqual(self.write("POST", "/api/manuscript/git", {"doc": "paper", "action": "connect", "url": str(self.remote)}, key=None)[0], 403)
        self.assertEqual(self.get("/api/manuscript/git?doc=paper")[0], 403)
        self.assertEqual(self.do("connect", "nope", url=str(self.remote))[0], 404)
        self.assertEqual(self.do("rebase")[0], 400)

    def test_what_ssh_could_not_settle_without_a_prompt_is_said_with_what_to_do(self):
        """Real git, and in ssh's place a program that says what ssh itself said on the user's
        machine on 2026-11-28 (OpenSSH 9.6, LC_ALL=C), each copied as it was printed: a key that
        needs its passphrase with no agent to unlock it; a host met for the first time; a host
        that shows another key than the known one."""
        def ssh_says(*lines: str) -> None:
            script = self.tmpdir / "stand-in" / "ssh"  # git reads the program's name to know how to give it a port
            script.parent.mkdir(exist_ok=True)
            script.write_text("#!/bin/sh\n" + "".join(f"echo {json.dumps(line)} >&2\n" for line in lines) + "exit 255\n")
            script.chmod(0o755)
            os.environ["GIT_SSH_COMMAND"] = str(script)

        was = os.environ.get("GIT_SSH_COMMAND")
        self.addCleanup(lambda: os.environ.pop("GIT_SSH_COMMAND", None) if was is None else os.environ.__setitem__("GIT_SSH_COMMAND", was))
        before = sorted(p.name for p in (self.vault / "documents").iterdir()), sorted(p.name for p in (self.vault / "documents" / ".rft").iterdir())
        locked = ("ssh could use no key for github.com. The page runs git without a prompt, so a key with a passphrase needs an SSH agent that holds it (ssh-add), "
                  "named by IdentityAgent in ~/.ssh/config or by SSH_AUTH_SOCK where Claude Code was started. A public repository can be given by its https address instead")
        new_host = "This machine has never connected to gitlab.com, and the page cannot answer ssh's question about its key: run ssh -T git@gitlab.com once in a terminal and accept it"
        changed = "host.example shows another key than the one this machine has for it: find out why before changing ~/.ssh/known_hosts"

        # a new document from a repository: git's own words, nothing made, then what to do
        ssh_says("git@github.com: Permission denied (publickey).")
        status, got = self.write("POST", "/api/manuscript/clone", {"name": "other", "url": "git@github.com:you/paper.git"})
        self.assertEqual(status, 502)
        self.assertIn("the repository could not be cloned (git@github.com: Permission denied (publickey). fatal: Could not read from remote repository.", got["error"])
        self.assertTrue(got["error"].endswith(f"): nothing was made. {locked}"), got["error"])
        ssh_says("Host key verification failed.")
        status, got = self.write("POST", "/api/manuscript/clone", {"name": "other", "url": "git@gitlab.com:you/paper.git"})
        self.assertEqual(status, 502)
        self.assertIn("(Host key verification failed. fatal: Could not read from remote repository.", got["error"])
        self.assertTrue(got["error"].endswith(f"): nothing was made. {new_host}"), got["error"])
        # a changed key is never something to accept: the words for a new host are not said for it
        ssh_says("@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@", "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @", "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@",
                 "IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!", "Host key for host.example has changed and you have requested strict checking.", "Host key verification failed.")
        status, got = self.write("POST", "/api/manuscript/clone", {"name": "other", "url": "ssh://git@host.example:2222/you/paper.git"})
        self.assertEqual(status, 502)
        self.assertTrue(got["error"].endswith(f"): nothing was made. {changed}"), got["error"])
        self.assertNotIn("accept it", got["error"])
        self.assertEqual((sorted(p.name for p in (self.vault / "documents").iterdir()), sorted(p.name for p in (self.vault / "documents" / ".rft").iterdir())), before)

        # a document connected to such a remote: the same after "could not be reached", on Check and on Push
        ssh_says("git@github.com: Permission denied (publickey).")
        status, got = self.do("connect", url="git@github.com:you/paper.git")
        self.assertEqual(status, 200)
        self.assertTrue(got["error"].startswith("the remote could not be reached (git@github.com: Permission denied (publickey)."), got["error"])
        self.assertTrue(got["error"].endswith(f"). {locked}"), got["error"])
        self.assertEqual(self.state(fetch=True)["error"], got["error"])
        status, got = self.do("push", message="x")
        self.assertEqual(status, 502)
        self.assertTrue(got["error"].endswith(f"). {locked}"), got["error"])
        self.assertEqual(self.log(), [], "nothing is recorded when nothing can be sent")
        # with another port and no user, ssh is named as it would be typed
        ssh_says("Host key verification failed.")
        self.assertEqual(self.do("connect", url="ssh://host.example:2222/you/paper.git")[0], 200)
        self.assertTrue(self.state(fetch=True)["error"].endswith("run ssh -T -p 2222 host.example once in a terminal and accept it"))

        # nothing is added where ssh's words name none of these: a path that is no repository, an https address
        os.environ.pop("GIT_SSH_COMMAND", None)
        status, got = self.write("POST", "/api/manuscript/clone", {"name": "other", "url": str(self.tmpdir / "nowhere.git")})
        self.assertEqual(status, 502)
        self.assertTrue(got["error"].endswith("): nothing was made"), got["error"])
        self.assertEqual(rft_git.ssh_target("https://github.com/you/paper.git"), ("", ""))
        self.assertEqual(rft_git.ssh_target("git@github.com:you/paper.git"), ("git@github.com", "github.com"))

    # ------------------------------------------------------------ push (ticket 23)

    def test_a_push_cloned_elsewhere_compiles_there(self):
        self.assertEqual(self.do("push", message="x")[0], 409, "not connected yet")
        self.connected()
        self.assertEqual(self.do("push", message="  ")[0], 400)
        self.pushed("The paper as it is")
        self.assertEqual(self.log(), ["The paper as it is"])
        there = self.coauthor()
        self.assertEqual(sorted(p.relative_to(there).as_posix() for p in there.rglob("*") if p.is_file() and ".git" not in p.parts),
                         ["figures/loss.pdf", "main.tex", "refs.bib", "sections/method.tex"])
        for f in ("main.tex", "sections/method.tex", "refs.bib", "figures/loss.pdf"):
            self.assertEqual((there / f).read_bytes(), (self.doc / f).read_bytes(), f)
        if LATEXMK:
            code, log = test_kits.latexmk(there, "main.tex")
            self.assertEqual(code, 0, log[-2000:])
            self.assertTrue((there / "main.pdf").is_file())
            self.assertEqual(test_kits.undefined(log), [])
        # a push with nothing new records nothing more
        self.pushed("Again")
        self.assertEqual(self.log(), ["The paper as it is"])

    def test_with_a_trace_in_a_caption_push_is_refused_with_the_file_and_line_and_goes_through_once_allowed(self):
        self.connected()
        self.pushed()
        method = self.doc / "sections" / "method.tex"
        self.edit(method, "\\caption{Training loss}", "\\caption{Training loss of E05}")
        line = next(i for i, text in enumerate(method.read_text().split("\n"), 1) if "of E05" in text)
        status, got = self.do("push", message="A caption")
        self.assertEqual(status, 422)
        self.assertIn(f"sections/method.tex:{line} (E05)", got["error"])
        self.assertEqual([(t["file"], t["line"], t["match"]) for t in got["traces"]], [("sections/method.tex", line, "E05")])
        # nothing was recorded: no commit ever holds the trace
        self.assertEqual(self.log(), ["A first version"])
        self.assertEqual(self.state()["changed"], 1)
        # the user allows that one occurrence (the session records it in the tracking file): the push goes through
        t = self.tracking()
        t["allowed"] = [{"file": "sections/method.tex", "match": "E05", "text": next(x for x in got["traces"])["text"]}]
        (self.vault / "documents" / ".rft" / "paper" / "tracking.json").write_text(json.dumps(t))
        self.pushed("A caption")
        self.assertIn("of E05", (self.coauthor() / "sections" / "method.tex").read_text())

    def test_behind_by_one_commit_push_is_refused_and_offers_pull(self):
        self.connected()
        self.pushed()
        there = self.coauthor()
        (there / "notes.txt").write_text("A note.\n")
        self.sent(there, "A note")
        self.edit(self.doc / "main.tex", "\\section{Discussion}", "\\section{Discussion}\nMine.")
        status, got = self.do("push", message="Mine")
        self.assertEqual((status, got["pull"], got["behind"]), (409, True, 1))
        self.assertIn("pull first", got["error"])
        self.assertEqual(self.log(), ["A first version"])
        self.assertEqual(self.do("pull")[0], 200)
        self.pushed("Mine")
        self.assertIn("Mine.", (self.coauthor() / "main.tex").read_text())

    # ------------------------------------------------------------ pull (ticket 24)

    def test_an_edit_away_from_every_copy_is_merged_and_every_copy_keeps_its_state(self):
        self.connected()
        self.pushed()
        before, values = self.states(), [(v["index"], v["state"]) for v in self.ms()["values"]]
        there = self.coauthor()
        self.edit(there / "main.tex", "\\section{Discussion}", "\\section{Discussion}\nA remark of the co-author's, away from every copy.")
        self.sent(there, "A remark")
        status, got = self.do("pull")
        self.assertEqual((status, got["pulled"], got["conflicts"], got["behind"]), (200, 1, [], 0))
        self.assertIn("A remark of the co-author's", (self.doc / "main.tex").read_text())
        self.assertEqual(self.states(), before)
        self.assertEqual([(v["index"], v["state"]) for v in self.ms()["values"]], values)
        # the answer carries the manuscript as it is then
        self.assertEqual({c["name"]: c["state"] for c in next(d for d in got["manuscript"]["documents"] if d["name"] == "paper")["copies"]}, before)
        self.assertEqual(self.do("pull")[1]["pulled"], 0)

    def test_a_coauthors_rewording_reads_as_adapted_and_a_copy_they_deleted_as_lost(self):
        self.connected()
        self.pushed()
        self.assertEqual([self.states()[n] for n in ("S01#1", "S02")], ["placed", "placed"])
        there = self.coauthor()
        main = there / "main.tex"
        self.edit(main, "CutMix~\\cite{yun2019cutmix} forms", "the CutMix augmentation~\\cite{yun2019cutmix} builds")
        text = main.read_text()
        a, b = text.index("%%% Result: CutMix at 1k images %%%"), text.index("%%% end %%%", text.index("%%% Result: CutMix at 1k images %%%")) + len("%%% end %%%\n")
        main.write_text(text[:a] + "Our results are in the appendix.\n" + text[b:])
        self.sent(there, "Reworded the definition, dropped the result")
        self.assertEqual(self.do("pull")[0], 200)
        st = self.states()
        self.assertEqual([st[n] for n in ("S01#1", "S02")], ["adapted", "lost"])
        self.assertEqual([st[n] for n in ("S05", "S01#2", "S04", "S03", "S07", "S06")], ["placed", "adapted", "review", "placed", "gone", "lost"])

    def test_a_number_of_the_tree_changed_by_a_coauthor_is_flagged_after_the_pull(self):
        self.connected()
        self.pushed()
        abstract = next(v for v in self.ms()["values"] if v["line"] == 20)
        self.assertEqual((abstract["written"], abstract["state"]), ("73.2", "current"))
        there = self.coauthor()
        self.edit(there / "main.tex", "It reaches 73.2\\%", "It reaches 74.0\\%")
        self.sent(there, "Rounded up")
        self.assertEqual(self.do("pull")[0], 200)
        abstract = next(v for v in self.ms()["values"] if v["index"] == abstract["index"])
        self.assertEqual((abstract["state"], abstract["inDocument"], abstract["now"]), ("changed", "74.0", "73.2"))

    def test_a_conflict_shows_gits_lines_and_compile_and_push_wait_until_they_are_gone(self):
        self.connected()
        self.pushed()
        there = self.coauthor()
        self.edit(there / "main.tex", "\\title{CutMix in the low-data regime}", "\\title{CutMix when data is scarce}")
        self.sent(there, "A title")
        self.edit(self.doc / "main.tex", "\\title{CutMix in the low-data regime}", "\\title{CutMix with a thousand images}")
        status, got = self.do("pull")
        self.assertEqual((status, got["conflicts"], got["merging"]), (200, ["main.tex"], True))
        text = (self.doc / "main.tex").read_text()
        for line in ("<<<<<<< HEAD", "\\title{CutMix with a thousand images}", "=======", "\\title{CutMix when data is scarce}", ">>>>>>> "):
            self.assertIn(line, text)
        self.assertEqual(self.state()["conflicts"], ["main.tex"])
        # compile, push and another pull wait
        status, r = self.write("POST", "/api/manuscript/compile", {"doc": "paper"})
        self.assertEqual((status, r["ok"], r["conflicts"]), (200, False, ["main.tex"]))
        self.assertIn("conflict", r["error"])
        status, got = self.do("push", message="Mine")
        self.assertEqual((status, got["conflicts"]), (409, ["main.tex"]))
        self.assertEqual(self.do("pull")[0], 409)
        # resolved in the editor: the lines are gone
        a, b = text.index("<<<<<<< HEAD"), text.index("\n", text.index(">>>>>>> ")) + 1
        f = json.loads(self.get("/api/manuscript/file?path=documents/paper/main.tex")[2])
        status, _ = self.write("PUT", "/api/manuscript/file", {"path": "documents/paper/main.tex", "text": text[:a] + "\\title{CutMix when images are scarce}\n" + text[b:], "version": f["version"]})
        self.assertEqual(status, 200)
        self.assertEqual((self.state()["conflicts"], self.state()["merging"]), ([], True))
        if LATEXMK:
            status, r = self.write("POST", "/api/manuscript/compile", {"doc": "paper"})
            self.assertEqual((r["ok"], r["errors"]), (True, []))
        got = self.pushed("One title")
        self.assertEqual((got["merging"], got["ahead"], got["behind"]), (False, 0, 0))
        self.assertIn("\\title{CutMix when images are scarce}", (self.coauthor() / "main.tex").read_text())

    def test_a_pull_that_would_record_a_trace_is_refused(self):
        self.connected()
        self.pushed()
        there = self.coauthor()
        (there / "notes.txt").write_text("A note.\n")
        self.sent(there, "A note")
        self.edit(self.doc / "main.tex", "\\section{Discussion}", "\\section{Discussion}\nAs E05 shows.")
        status, got = self.do("pull")
        self.assertEqual(status, 422)
        self.assertIn("(E05)", got["error"])
        self.assertEqual(self.log(), ["A first version"])
        self.assertFalse((self.doc / "notes.txt").exists())
        # with nothing of the user's to record, a trace in the document does not stop a pull
        self.edit(self.doc / "main.tex", "\nAs E05 shows.", "")
        self.assertEqual(self.do("pull")[0], 200)
        self.assertTrue((self.doc / "notes.txt").is_file())

    # ------------------------------------------------------------ a document from a repository (ticket 25)

    def test_a_document_made_from_a_repository(self):
        self.connected()
        self.pushed()
        # the repository also holds a line that names a note of this vault: listed, not removed
        there = self.coauthor()
        self.edit(there / "main.tex", "\\section{Discussion}", "\\section{Discussion}\nAs E05 shows.")
        self.sent(there, "A sentence")
        status, got = self.write("POST", "/api/manuscript/clone", {"name": "from-repo", "url": str(self.remote)})
        self.assertEqual((status, got["name"]), (201, "from-repo"))
        folder = self.vault / "documents" / "from-repo"
        self.assertEqual(sorted(p.relative_to(folder).as_posix() for p in folder.rglob("*") if p.is_file()), ["figures/loss.pdf", "main.tex", "refs.bib", "sections/method.tex"])
        self.assertFalse((folder / ".git").exists())
        d = next(x for x in got["documents"] if x["name"] == "from-repo")
        # its main file found, nothing in it tied to the tree yet, its traces listed
        self.assertEqual((d["main"], d["mainAsked"], d["copies"], d["values"], d["repository"], d["template"]), ("main.tex", [], [], [], True, "repository"))
        self.assertEqual([(t["file"], t["match"]) for t in d["traces"]], [("main.tex", "E05")])
        self.assertIn("As E05 shows.", (folder / "main.tex").read_text())
        st = self.state("from-repo")
        self.assertEqual((st["remote"], st["behind"], st["ahead"], st["changed"]), (str(self.remote), 0, 0, 0))
        if LATEXMK:
            status, r = self.write("POST", "/api/manuscript/compile", {"doc": "from-repo"})
            self.assertEqual((r["ok"], r["errors"]), (True, []))
            self.assertEqual(self.state("from-repo")["changed"], 0, "the compile leaves nothing in the folder")
        # a name already taken, an address that cannot be reached, a name that is none: nothing is made
        before = sorted(p.name for p in (self.vault / "documents").iterdir()), sorted(p.name for p in (self.vault / "documents" / ".rft").iterdir())
        self.assertEqual(self.write("POST", "/api/manuscript/clone", {"name": "paper", "url": str(self.remote)})[0], 409)
        self.assertEqual(self.write("POST", "/api/manuscript/clone", {"name": "from-repo", "url": str(self.remote)})[0], 409)
        status, got = self.write("POST", "/api/manuscript/clone", {"name": "other", "url": str(self.tmpdir / "nowhere.git")})
        self.assertEqual(status, 502)
        self.assertIn("nothing was made", got["error"])
        self.assertEqual(self.write("POST", "/api/manuscript/clone", {"name": "My Paper", "url": str(self.remote)})[0], 400)
        self.assertEqual(self.write("POST", "/api/manuscript/clone", {"name": "other", "url": "ext::sh"})[0], 400)
        self.assertEqual(self.write("POST", "/api/manuscript/clone", {"name": "other", "url": str(self.remote)}, key=None)[0], 403)
        self.assertEqual((sorted(p.name for p in (self.vault / "documents").iterdir()), sorted(p.name for p in (self.vault / "documents" / ".rft").iterdir())), before)
        # the two documents share a remote, each with its own git data: a push from one is a pull for the other
        self.edit(folder / "main.tex", "\nAs E05 shows.", "")
        self.assertEqual(self.do("push", "from-repo", message="Without it")[0], 200)
        self.assertEqual(self.state(fetch=True)["behind"], 2)


if __name__ == "__main__":
    unittest.main()
