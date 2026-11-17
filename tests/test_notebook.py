"""Tests of experiment notebooks on the Python side: server/rft_notebook.py (the vault's link
followed to the notebook in its repo, the run in the repo's uv environment, the marimo editors the
tree view frames) and the server's part (the notebook and its last run in api/tree, POST
api/notebook, the page's policy).

The tests marked `uv` run marimo for real in a throwaway uv project, and are skipped when uv is
not on PATH (RFT_SKIP_UV=1 skips them too). They are the check that does not depend on the code's
own judgment: the notebook must give back the numbers it was written to reproduce.

    python3 -m unittest discover -s tests -p "test_*.py"
"""
import http.client
import json
import math
import os
import shutil
import socket
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import rft_notebook  # noqa: E402
import rft_server  # noqa: E402

WEB = Path(__file__).resolve().parents[1] / "web"
KEY = "test-key-456"
HAS_UV = bool(shutil.which("uv")) and not os.environ.get("RFT_SKIP_UV")

NOTEBOOK = '''\
import marimo
app = marimo.App()


@app.cell
def _():
    import json
    from helper import gap
    with open("data/runs.json") as f:
        runs = json.load(f)
    return


@app.cell
def _():
    RESULTS = {"gap_1k": gap(runs, 0), "gap_10k": gap(runs, 1), "seeds": len(runs["seeds"])}
    return
'''


def uv_project(root: Path, notebook: str = NOTEBOOK, name: str = "E02_baseline.py") -> Path:
    """A uv project with no dependencies: a notebook that imports a module beside it and reads data by a path from the root."""
    (root / "notebooks").mkdir(parents=True)
    (root / "data").mkdir()
    (root / "pyproject.toml").write_text('[project]\nname = "toy"\nversion = "0.1.0"\nrequires-python = ">=3.10"\ndependencies = []\n')
    (root / "data" / "runs.json").write_text(json.dumps({"gaps": [4.1, 0.8], "seeds": [0, 1, 2, 3, 4]}))
    (root / "notebooks" / "helper.py").write_text("def gap(runs, i):\n    return runs['gaps'][i]\n")
    (root / "notebooks" / name).write_text(notebook)
    return root / "notebooks" / name


class HelperTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()

    def test_the_link_is_followed_to_the_notebook_and_its_uv_project(self):
        nb = uv_project(self.base / "code" / "toy")
        link = self.base / "vault" / "notebooks" / "E02.py"
        rft_notebook.link("../../code/toy/notebooks/E02_baseline.py", link)
        self.assertTrue(link.is_symlink())
        self.assertEqual(os.readlink(link), "../../code/toy/notebooks/E02_baseline.py")
        self.assertEqual(rft_notebook.resolve(link), (nb, self.base / "code" / "toy"))
        self.assertEqual(rft_notebook.project_root(nb), self.base / "code" / "toy")
        self.assertIsNone(rft_notebook.project_root(self.base / "vault" / "x.py"))

    def test_a_link_replaces_a_link_but_never_a_file(self):
        uv_project(self.base / "toy")
        link = self.base / "vault" / "notebooks" / "E02.py"
        rft_notebook.link("../../toy/notebooks/helper.py", link)
        rft_notebook.link("../../toy/notebooks/E02_baseline.py", link)
        self.assertEqual(os.readlink(link), "../../toy/notebooks/E02_baseline.py")
        mine = self.base / "vault" / "notebooks" / "E03.py"
        mine.write_text("mine")
        with self.assertRaises(rft_notebook.NotebookError):
            rft_notebook.link("../../toy/notebooks/E02_baseline.py", mine)
        self.assertEqual(mine.read_text(), "mine")

    def test_resolve_refuses_what_is_not_a_notebook_of_a_uv_project(self):
        (self.base / "loose").mkdir()
        (self.base / "loose" / "nb.py").write_text("")
        nb = uv_project(self.base / "toy")
        (self.base / "toy" / "notes.md").write_text("")
        for bad, why in [(self.base / "loose" / "nb.py", "pyproject"), (self.base / "toy" / "none.py", "no notebook"),
                         (self.base / "toy" / "notes.md", ".py")]:
            with self.assertRaises(rft_notebook.NotebookError) as e:
                rft_notebook.resolve(bad)
            self.assertIn(why, str(e.exception))
        self.assertEqual(rft_notebook.resolve(nb)[0], nb)

    def test_results_become_json(self):
        class Scalar:  # a numpy scalar, as far as JSON goes
            def item(self):
                return 0.5
        got = rft_notebook.jsonable({"a": (1, 2), "b": Scalar(), "c": math.nan, "d": math.inf, "e": {"f": None, "g": True}, "h": object})
        self.assertEqual(got, {"a": [1, 2], "b": 0.5, "c": "nan", "d": "inf", "e": {"f": None, "g": True}, "h": str(object)})
        json.dumps(got, allow_nan=False)

    def test_the_end_of_an_error_only(self):
        text = "\n".join(f"line {i}" for i in range(40))
        self.assertEqual(rft_notebook.tail(text, 3), "line 37\nline 38\nline 39")
        self.assertEqual(rft_notebook.tail("one\n\n", 5), "one")

    def test_without_uv_the_run_says_so(self):
        nb = uv_project(self.base / "toy")
        got = rft_notebook.run(nb, 5, uv="no-such-uv-here")
        self.assertFalse(got["ok"])
        self.assertIn("uv", got["error"])


@unittest.skipUnless(HAS_UV, "uv is not on PATH")
class UvRunTest(unittest.TestCase):
    """The notebook runs in its repo's own environment, with the repo's root as working folder and
    the notebook's folder first on sys.path, as the marimo editor runs it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()

    def test_a_run_through_the_vault_link_gives_back_the_results(self):
        nb = uv_project(self.base / "code" / "toy")
        link = self.base / "vault" / "notebooks" / "E02.py"
        rft_notebook.link("../../code/toy/notebooks/E02_baseline.py", link)
        got = rft_notebook.run(link, 240)
        self.assertTrue(got["ok"], got.get("error"))
        self.assertEqual(got["results"], {"gap_1k": 4.1, "gap_10k": 0.8, "seeds": 5})
        self.assertEqual(got["file"], str(nb))
        self.assertIsNone(got["commit"])  # not a git repo
        self.assertGreaterEqual(got["seconds"], 0)

    def test_a_failing_cell_gives_the_end_of_its_traceback(self):
        nb = uv_project(self.base / "toy", NOTEBOOK.replace("data/runs.json", "data/missing.json"))
        got = rft_notebook.run(nb, 240)
        self.assertFalse(got["ok"])
        self.assertIn("FileNotFoundError", got["error"].splitlines()[-1])
        self.assertLessEqual(len(got["error"].splitlines()), 15)

    def test_a_run_past_its_timeout_is_stopped(self):
        slow = 'import marimo\napp = marimo.App()\n\n\n@app.cell\ndef _():\n    import time\n    time.sleep(60)\n    return\n'
        nb = uv_project(self.base / "toy", slow)
        rft_notebook.run(nb, 240)  # once, so the environment is made before the clock starts
        t = time.time()
        got = rft_notebook.run(nb, 3)
        self.assertLess(time.time() - t, 30)
        self.assertFalse(got["ok"])
        self.assertIn("timed out", got["error"])

    def test_the_editor_serves_the_repo_with_its_own_key_and_stops(self):
        nb = uv_project(self.base / "toy")
        editors = rft_notebook.Editors()
        self.addCleanup(editors.stop_all)
        url = editors.open(nb)
        u = urlsplit(url)
        self.assertEqual(u.hostname, "127.0.0.1")
        self.assertIn("file=notebooks/E02_baseline.py", u.query)
        self.assertIn("access_token=", u.query)
        self.assertEqual(editors.open(nb), url)  # the same server, the same key
        c = http.client.HTTPConnection("127.0.0.1", u.port, timeout=10)
        c.request("GET", "/")
        r = c.getresponse()
        r.read()
        self.assertIn(r.status, (302, 303, 401, 403))  # nothing without the key
        c.request("GET", f"/?{u.query}")
        r = c.getresponse()
        r.read()
        self.assertIn("set-cookie", {k.lower() for k, _ in r.getheaders()})
        c.close()
        editors.stop_all()
        time.sleep(0.5)
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", u.port), timeout=2).close()


class FakeEditors:
    def __init__(self):
        self.opened = []
        self.fail = None

    def open(self, path):
        self.opened.append(Path(path))
        if self.fail:
            raise rft_notebook.NotebookError(self.fail)
        return "http://127.0.0.1:9/?file=notebooks/E02_baseline.py&access_token=abc"


def note(nid, kind, status, parent, title, extra=""):
    p = f'"[[{parent}]]"' if parent else '""'
    return (f"---\nid: {nid}\ntype: {kind}\nstatus: {status}\ndate: 2026-01-01\nparent: {p}\ntags: [demo, {kind}, {status}]\n{extra}---\n\n"
            f"# {nid} · {title}\n\n## Result\nGap 4.1 ± 0.6.\n")


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        base = Path(cls.tmp.name).resolve()
        vault = base / "vault"
        (vault / "directions").mkdir(parents=True)
        (vault / "experiments").mkdir()
        (vault / "directions" / "D00 Root.md").write_text(note("D00", "direction", "done", "", "Root"))
        (vault / "experiments" / "E01 Plain.md").write_text(note("E01", "experiment", "done", "D00 Root", "Plain"))
        (vault / "experiments" / "E02 Baseline.md").write_text(note(
            "E02", "experiment", "done", "D00 Root", "Baseline",
            'notebook: "notebooks/E02.py"\nreproduced: "2026-11-15 ok @a1b2c3d4e5 in 6.1 s"\n'))
        (vault / "experiments" / "E03 Escapes.md").write_text(note(
            "E03", "experiment", "done", "D00 Root", "Escapes", 'notebook: "../../outside.py"\n'))
        uv_project(base / "toy")
        rft_notebook.link("../../toy/notebooks/E02_baseline.py", vault / "notebooks" / "E02.py")
        cls.vault = vault
        cls.editors = FakeEditors()
        handler = rft_server.make_handler(rft_server.Vault(vault, "demo"), WEB, KEY, editors=cls.editors)
        cls.server = rft_server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.tmp.cleanup()

    def request(self, method, path, payload=None, key=KEY):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Host": f"127.0.0.1:{self.port}"}
        data = None
        if payload is not None:
            data = json.dumps(payload).encode()
            headers.update({"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.port}", "Content-Length": str(len(data))})
            if key:
                headers["X-RFT-Token"] = key
        c.request(method, path, body=data, headers=headers)
        r = c.getresponse()
        body = r.read()
        hdrs = dict(r.getheaders())
        c.close()
        return r.status, hdrs, json.loads(body) if body.startswith(b"{") else body

    def test_the_tree_carries_the_notebook_and_its_last_run(self):
        _, _, tree = self.request("GET", "/api/tree")
        nodes = {n["id"]: n for n in tree["nodes"]}
        self.assertEqual(nodes["E02"]["notebook"], "notebooks/E02.py")
        self.assertEqual(nodes["E02"]["reproduced"], {"date": "2026-11-15", "state": "ok", "commit": "a1b2c3d4e5", "seconds": 6.1})
        self.assertNotIn("notebook", nodes["E01"])
        self.assertNotIn("reproduced", nodes["E01"])

    def test_opening_a_notebook_needs_the_key_and_answers_the_editors_address(self):
        status, _, _ = self.request("POST", "/api/notebook", {"id": "E02"}, key=None)
        self.assertEqual(status, 403)
        self.assertEqual(self.editors.opened, [])
        status, _, got = self.request("POST", "/api/notebook", {"id": "E02"})
        self.assertEqual(status, 200)
        self.assertEqual(got["url"], "http://127.0.0.1:9/?file=notebooks/E02_baseline.py&access_token=abc")
        self.assertEqual(self.editors.opened[-1], self.vault / "notebooks" / "E02.py")

    def test_no_notebook_no_note_and_a_link_out_of_the_vault_are_refused(self):
        self.editors.opened.clear()
        for nid in ("E01", "E99", "E03"):
            status, _, got = self.request("POST", "/api/notebook", {"id": nid})
            self.assertEqual(status, 404, nid)
            self.assertIn("error", got)
        self.assertEqual(self.editors.opened, [])

    def test_an_editor_that_cannot_start_says_why(self):
        self.editors.fail = "uv is not on PATH"
        self.addCleanup(setattr, self.editors, "fail", None)
        status, _, got = self.request("POST", "/api/notebook", {"id": "E02"})
        self.assertEqual(status, 502)
        self.assertIn("uv is not on PATH", got["error"])

    def test_the_page_may_frame_the_local_editors_only(self):
        _, hdrs, _ = self.request("GET", "/")
        csp = {k.lower(): v for k, v in hdrs.items()}["content-security-policy"]
        # and the manuscript's PDF, from a blob: address only the page itself can make
        self.assertIn("frame-src 'self' blob: http://127.0.0.1:*;", csp)
        self.assertNotIn("https:", csp)


if __name__ == "__main__":
    unittest.main()
