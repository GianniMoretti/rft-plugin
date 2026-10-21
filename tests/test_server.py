"""Tests of the web view's server: the JSON endpoint, the note endpoint, editing a note's body,
and their safety.

    python3 -m unittest discover -s tests -p "test_*.py"
"""
import http.client
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import rft_server  # noqa: E402

WEB = Path(__file__).resolve().parents[1] / "web"
SERVER = Path(__file__).resolve().parents[1] / "server" / "rft_server.py"
KEY = "test-key-123"


def note(nid, kind, status, parent, title, tags=(), concept=None):
    p = f'"[[{parent}]]"' if parent else '""'
    t = ", ".join(["demo", kind, *tags, status])
    c = f'concept: "{concept}"\nconcept_summary: "About {concept}"\n' if concept else ""
    return (f"---\nid: {nid}\ntype: {kind}\nstatus: {status}\ndate: 2026-01-01\nparent: {p}\ntags: [{t}]\n{c}---\n\n"
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
        (vault / "experiments" / "E01 First run.md").write_text(note("E01", "experiment", "running", "D00 Root question", "First run", ("theory", "cluster"), "Runs"))
        (vault / "directions" / "D01 Next idea.md").write_text(note("D01", "direction", "idea", "E01 First run", "Next idea", ("theory",)))
        # a secret outside the vault, and a note that is a link to it
        (root / "secret.md").write_text(note("E09", "experiment", "done", "D00 Root question", "Secret"))
        os.symlink(root / "secret.md", vault / "experiments" / "E09 Linked out.md")
        (vault / "00 Index.md").write_text("index")
        cls.vault = vault
        cls.root = root
        handler = rft_server.make_handler(rft_server.Vault(vault, "demo"), WEB, KEY)
        cls.server = rft_server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.tmp.cleanup()

    def get(self, path, host=None, method="GET", headers=(), data=None, port=None):
        c = http.client.HTTPConnection("127.0.0.1", port or self.port, timeout=5)
        c.putrequest(method, path, skip_host=True)
        c.putheader("Host", host or f"127.0.0.1:{port or self.port}")
        for k, v in headers:
            c.putheader(k, v)
        if data is not None:
            c.putheader("Content-Length", str(len(data)))
        c.endheaders(data)
        r = c.getresponse()
        body = r.read()
        c.close()
        return r.status, r.getheader("Content-Type") or "", body

    def put(self, nid, payload, key=KEY, origin=None, ctype="application/json", host=None, port=None):
        """A PUT api/note as the page sends it, or with one part of it changed."""
        port = port or self.port
        headers = [("Content-Type", ctype), ("Origin", origin or f"http://127.0.0.1:{port}")]
        if key is not None:
            headers.append(("X-RFT-Token", key))
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        status, _, body = self.get(f"/api/note?id={nid}", host=host, method="PUT", headers=headers, data=data, port=port)
        return status, json.loads(body) if body.startswith(b"{") else body

    def scratch_note(self, nid="D07", text=None):
        """A note of its own for a test that writes, removed afterwards."""
        p = self.vault / "directions" / f"{nid} Scratch.md"
        p.write_bytes((text or note(nid, "direction", "idea", "D00 Root question", "Scratch")).encode())
        self.addCleanup(p.unlink)
        return p

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

    def test_concept_tree(self):
        tree = json.loads(self.get("/api/tree")[2])
        nodes = {n["id"]: n for n in tree["nodes"]}
        # E01 starts "Runs"; D01 below it inherits it; D00 stays in the project root concept
        self.assertEqual((nodes["D00"]["concept"], nodes["E01"]["concept"], nodes["D01"]["concept"]), ("root", "E01", "E01"))
        root, runs = tree["concepts"]
        self.assertEqual((root["id"], root["name"], root["root"], root["children"]), ("root", "demo", None, ["E01"]))
        self.assertEqual((runs["name"], runs["summary"], runs["root"], runs["parent"]), ("Runs", "About Runs", "E01", "root"))
        self.assertEqual((runs["count"], runs["total"], runs["statuses"]), (2, 2, {"running": 1, "idea": 1}))
        self.assertEqual(root["total"], 4)

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
        self.assertEqual(self.get("/layout.js")[0], 200)
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
        for m in ["POST", "DELETE", "PATCH"]:
            self.assertEqual(self.get("/api/note?id=E01", method=m)[0], 405, m)
        # a server without a key never writes
        handler = rft_server.make_handler(rft_server.Vault(self.vault, "demo"), WEB)
        server = rft_server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            port = server.server_address[1]
            self.assertEqual(self.put("E01", {"body": "x", "force": True}, port=port)[0], 405)
        finally:
            server.shutdown()
            server.server_close()

    def test_edit_body_keeps_frontmatter(self):
        p = self.scratch_note()
        before = p.read_text()
        n = json.loads(self.get("/api/note?id=D07")[2])
        self.assertEqual(n["body"], "\n# D07 · Scratch\n\nText of D07.\n")
        status, res = self.put("D07", {"body": "\n# D07 · Scratch\n\nRewritten, with [[E01 First run]].", "version": n["version"]})
        self.assertEqual(status, 200)
        front = before[:before.index("---\n", 4) + 4]
        self.assertEqual(p.read_text(), front + "\n# D07 · Scratch\n\nRewritten, with [[E01 First run]].\n")
        again = json.loads(self.get("/api/note?id=D07")[2])
        self.assertEqual(again["version"], res["version"])
        self.assertNotEqual(again["version"], n["version"])
        # the tree still reads the note's frontmatter
        nodes = {x["id"]: x for x in json.loads(self.get("/api/tree")[2])["nodes"]}
        self.assertEqual((nodes["D07"]["status"], nodes["D07"]["parent"]), ("idea", "D00"))
        self.assertEqual([f.name for f in p.parent.iterdir() if f.name.startswith(".")], [])

    def test_edit_refused_when_the_note_changed(self):
        p = self.scratch_note()
        n = json.loads(self.get("/api/note?id=D07")[2])
        p.write_text(p.read_text() + "Added by Claude.\n")
        status, res = self.put("D07", {"body": "Mine.", "version": n["version"]})
        self.assertEqual(status, 409)
        self.assertIn("Added by Claude.", res["body"])
        self.assertIn("Added by Claude.", p.read_text())
        # with the version it answered, or with force, the write goes through
        self.assertEqual(self.put("D07", {"body": "Mine.", "version": res["version"]})[0], 200)
        self.assertTrue(p.read_text().endswith("---\nMine.\n"))
        p.write_text(p.read_text() + "Again.\n")
        self.assertEqual(self.put("D07", {"body": "Mine, forced.", "force": True})[0], 200)
        self.assertTrue(p.read_text().endswith("---\nMine, forced.\n"))

    def test_edit_needs_the_page_and_its_key(self):
        p = self.scratch_note()
        before = p.read_bytes()
        body = {"body": "Changed.", "force": True}
        self.assertEqual(self.put("D07", body, key=None)[0], 403)
        self.assertEqual(self.put("D07", body, key="wrong")[0], 403)
        self.assertEqual(self.put("D07", body, origin="http://evil.example")[0], 403)
        self.assertEqual(self.put("D07", body, origin="null")[0], 403)
        self.assertEqual(self.put("D07", body, host="evil.example")[0], 403)
        self.assertEqual(self.put("D07", body, ctype="text/plain")[0], 415)
        status, _, _ = self.get("/api/note?id=D07", method="PUT", headers=[("X-RFT-Token", KEY)], data=b"{}")
        self.assertEqual(status, 403)  # no Origin: not the page
        self.assertEqual(p.read_bytes(), before)
        # through an ssh -L forward the page's origin is the forwarded one
        self.assertEqual(self.put("D07", body, host="localhost:9999", origin="http://localhost:9999")[0], 200)

    def test_edit_bad_requests(self):
        p = self.scratch_note()
        before = p.read_bytes()
        self.assertEqual(self.put("D07", b"not json")[0], 400)
        self.assertEqual(self.put("D07", {"body": "No version."})[0], 400)
        self.assertEqual(self.put("D07", {"body": 3, "force": True})[0], 400)
        self.assertEqual(self.put("D07", ["Changed."])[0], 400)
        # refused on the declared length, before any of the body is read
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.putrequest("PUT", "/api/note?id=D07")
        for k, v in [("Content-Type", "application/json"), ("Origin", f"http://127.0.0.1:{self.port}"), ("X-RFT-Token", KEY),
                     ("Content-Length", str(rft_server.MAX_NOTE_BYTES + 1))]:
            c.putheader(k, v)
        c.endheaders()
        self.assertEqual(c.getresponse().status, 413)
        c.close()
        self.assertEqual(p.read_bytes(), before)

    def test_edit_path_safety(self):
        secret = (self.root / "secret.md").read_bytes()
        for q in ["../secret", "E01/../../secret", "%2e%2e%2fsecret", "D00%00", "", "X1", "E999", "E09"]:
            self.assertEqual(self.put(q, {"body": "pwned", "force": True})[0], 404, q)
        self.assertEqual((self.root / "secret.md").read_bytes(), secret)

    def test_edit_keeps_crlf_newlines(self):
        p = self.scratch_note(text=note("D07", "direction", "idea", "D00 Root question", "Scratch").replace("\n", "\r\n"))
        self.assertEqual(self.put("D07", {"body": "One\nTwo\r\n", "force": True})[0], 200)
        data = p.read_bytes()
        self.assertTrue(data.endswith(b"---\r\nOne\r\nTwo\r\n"))
        self.assertNotIn(b"\n", data.replace(b"\r\n", b""))

    def start(self, cache):
        """The server as the plugin runs it, its cache in `cache`: its process, port and key."""
        proc = subprocess.Popen([sys.executable, str(SERVER), "--vault", str(self.vault), "--web", str(WEB), "--no-watch"],
                                stdout=subprocess.PIPE, text=True, env={**os.environ, "XDG_CACHE_HOME": str(cache)})
        self.addCleanup(lambda: (proc.kill(), proc.wait(), proc.stdout.close()))
        m = re.fullmatch(r"RFT_SERVER_URL http://127\.0\.0\.1:(\d+)/\?token=([\w-]{16})", proc.stdout.readline().strip())
        self.assertIsNotNone(m)
        return proc, int(m.group(1)), m.group(2)

    def test_prints_an_address_with_its_key(self):
        cache = self.root / "cache"
        proc, port, key = self.start(cache)
        self.scratch_note()
        self.assertEqual(self.put("D07", {"body": "Changed.", "force": True}, key=KEY, port=port)[0], 403)
        self.assertEqual(self.put("D07", {"body": "Changed.", "force": True}, key=key, port=port)[0], 200)
        # the key is the vault's: the same after a restart, in a file only its owner reads
        proc.kill()
        proc.wait()
        self.assertEqual(self.start(cache)[2], key)
        (path,) = (cache / "rft" / "keys").iterdir()
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        # a key file others can read is not trusted: a new key replaces it
        path.chmod(0o644)
        fresh = self.start(cache)[2]
        self.assertNotEqual(fresh, key)
        self.assertEqual(path.read_text(), fresh)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_binds_loopback(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")


if __name__ == "__main__":
    unittest.main()
