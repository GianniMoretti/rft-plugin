"""Tests of the web view's server: the JSON endpoint, the note endpoint and its path safety.

    python3 -m unittest discover -s tests -p "test_*.py"
"""
import http.client
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import rft_server  # noqa: E402

WEB = Path(__file__).resolve().parents[1] / "web"


def note(nid, kind, status, parent, title, tags=()):
    p = f'"[[{parent}]]"' if parent else '""'
    t = ", ".join(["demo", kind, *tags, status])
    return (f"---\nid: {nid}\ntype: {kind}\nstatus: {status}\ndate: 2026-01-01\nparent: {p}\ntags: [{t}]\n---\n\n"
            f"# {nid} · {title}\n\nText of {nid}.\n")


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        vault = root / "vault"
        (vault / "directions").mkdir(parents=True)
        (vault / "experiments").mkdir()
        (vault / "directions" / "D00 Root question.md").write_text(note("D00", "direction", "done", "", "Root question"))
        (vault / "experiments" / "E01 First run.md").write_text(note("E01", "experiment", "running", "D00 Root question", "First run", ("theory", "cluster")))
        (vault / "directions" / "D01 Next idea.md").write_text(note("D01", "direction", "idea", "E01 First run", "Next idea", ("theory",)))
        # a secret outside the vault, and a note that is a link to it
        (root / "secret.md").write_text(note("E09", "experiment", "done", "D00 Root question", "Secret"))
        os.symlink(root / "secret.md", vault / "experiments" / "E09 Linked out.md")
        (vault / "00 Index.md").write_text("index")
        cls.vault = vault
        handler = rft_server.make_handler(rft_server.Vault(vault, "demo"), WEB)
        cls.server = rft_server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.tmp.cleanup()

    def get(self, path, host=None, method="GET"):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.putrequest(method, path, skip_host=True)
        c.putheader("Host", host or f"127.0.0.1:{self.port}")
        c.endheaders()
        r = c.getresponse()
        body = r.read()
        c.close()
        return r.status, r.getheader("Content-Type") or "", body

    def test_tree_json(self):
        status, ctype, body = self.get("/api/tree")
        self.assertEqual(status, 200)
        self.assertIn("application/json", ctype)
        tree = json.loads(body)
        self.assertEqual(tree["project"], "demo")
        self.assertEqual(tree["roots"], ["D00"])
        nodes = {n["id"]: n for n in tree["nodes"]}
        self.assertEqual(nodes["E01"]["parent"], "D00")
        self.assertEqual(nodes["D00"]["children"], ["E01", "E09"])
        self.assertEqual(nodes["D01"]["status"], "idea")
        self.assertTrue(tree["version"])
        # topical tags only: the project, type and status tags are left out
        self.assertEqual(nodes["E01"]["tags"], ["theory", "cluster"])
        self.assertEqual(nodes["D00"]["tags"], [])
        self.assertEqual(tree["tags"], [{"tag": "theory", "count": 2}, {"tag": "cluster", "count": 1}])

    def test_tag_parsing(self):
        self.assertEqual(rft_server.parse_tags('[demo, "theory", #cluster]'), ["demo", "theory", "cluster"])
        self.assertEqual(rft_server.topical_tags(["demo", "experiment", "theory", "done", "theory"], "demo"), ["theory"])
        self.assertEqual(rft_server.parse_tags(None), [])

    def test_version_changes_with_the_notes(self):
        before = json.loads(self.get("/api/tree")[2])["version"]
        p = self.vault / "directions" / "D02 Added.md"
        p.write_text(note("D02", "direction", "idea", "D01 Next idea", "Added"))
        try:
            after = json.loads(self.get("/api/tree")[2])
            self.assertNotEqual(after["version"], before)
            self.assertIn("D02", [n["id"] for n in after["nodes"]])
        finally:
            p.unlink()

    def test_note_by_id(self):
        status, _, body = self.get("/api/note?id=E01")
        self.assertEqual(status, 200)
        n = json.loads(body)
        self.assertEqual(n["name"], "E01 First run")
        self.assertIn("Text of E01.", n["body"])
        self.assertNotIn("status: running", n["body"])

    def test_note_path_safety(self):
        for q in ["../secret", "../../etc/passwd", "E01/../../secret", "%2e%2e%2fsecret", "D00%00", "", "X1", "E999"]:
            self.assertEqual(self.get(f"/api/note?id={q}")[0], 404, q)
        # a note that is a link out of the vault is listed but never read
        self.assertEqual(self.get("/api/note?id=E09")[0], 404)
        self.assertIsNone(rft_server.Vault(self.vault, "demo").note_path("E09"))

    def test_only_the_page_files(self):
        self.assertEqual(self.get("/")[0], 200)
        self.assertEqual(self.get("/app.js")[0], 200)
        self.assertEqual(self.get("/vendor/d3.v7.9.0.min.js")[0], 200)
        for p in ["/../server/rft_server.py", "/vendor/../../server/rft_server.py", "/%2e%2e/%2e%2e/etc/passwd",
                  "/00%20Index.md", "/vault/00%20Index.md", "/.rft/config.json", "/api", "/app.js/../index.html"]:
            self.assertEqual(self.get(p)[0], 404, p)

    def test_loopback_hosts_only(self):
        self.assertEqual(self.get("/api/tree", host="evil.example")[0], 403)
        self.assertEqual(self.get("/api/tree", host=f"evil.example:{self.port}")[0], 403)
        self.assertEqual(self.get("/api/tree", host="localhost:9999")[0], 200)  # an ssh -L forward
        self.assertEqual(self.get("/api/tree", host="[::1]:1234")[0], 200)

    def test_read_only(self):
        for m in ["POST", "PUT", "DELETE", "PATCH"]:
            self.assertEqual(self.get("/api/tree", method=m)[0], 405, m)

    def test_binds_loopback(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")


if __name__ == "__main__":
    unittest.main()
