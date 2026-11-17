"""Tests of the web view's server: the JSON endpoint, the note endpoint, editing a note's body,
adding a note through the session, and their safety.

    python3 -m unittest discover -s tests -p "test_*.py"
"""
import base64
import contextlib
import http.client
import io
import json
import os
import queue
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import rft_manuscript  # noqa: E402
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
        cls.asked = []  # the requests handed to the session
        cls.answer = None  # what the session does with one: nothing, unless a test says

        def ask(verb, request):
            cls.asked.append((verb, request))
            if cls.answer:
                cls.answer(request)

        handler = rft_server.make_handler(rft_server.Vault(vault, "demo"), WEB, KEY, ask)
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

    def write(self, method, path, payload, key=KEY, origin=None, ctype="application/json", host=None, port=None):
        """A write as the page sends it, or with one part of it changed."""
        port = port or self.port
        headers = [("Content-Type", ctype), ("Origin", origin or f"http://127.0.0.1:{port}")]
        if key is not None:
            headers.append(("X-RFT-Token", key))
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        status, _, body = self.get(path, host=host, method=method, headers=headers, data=data, port=port)
        return status, json.loads(body) if body.startswith(b"{") else body

    def put(self, nid, payload, **kw):
        return self.write("PUT", f"/api/note?id={nid}", payload, **kw)

    def post(self, payload, **kw):
        return self.write("POST", "/api/node", payload, **kw)

    def plugin(self, request):
        """The session as the server sees it: the new note appears on disk under its parent."""
        names = {"D00": "D00 Root question", "E01": "E01 First run"}
        nid, sub, status = ("E07", "experiments", "planned") if request["type"] == "experiment" else ("D07", "directions", "idea")
        p = self.vault / sub / f"{nid} {request['title']}.md"
        p.write_text(note(nid, request["type"], status, names[request["parent"]], request["title"]))
        self.addCleanup(p.unlink)
        return p

    def session(self, answer):
        """The session does `answer` with each request for this test; the requests are recorded afresh."""
        type(self).answer = answer
        self.asked.clear()
        self.addCleanup(setattr, type(self), "answer", None)

    def scratch_note(self, nid="D07", text=None):
        """A note of its own for a test that writes, removed afterwards."""
        p = self.vault / "directions" / f"{nid} Scratch.md"
        p.write_bytes((text or note(nid, "direction", "idea", "D00 Root question", "Scratch")).encode())
        self.addCleanup(p.unlink)
        return p
    
    def retyped_note(self):
        """A direction of its own, D08, and the session that makes it the experiment E08."""
        old = self.vault / "directions" / "D08 Retyped.md"
        new = self.vault / "experiments" / "E08 Retyped.md"
        old.write_text(note("D08", "direction", "idea", "D00 Root question", "Retyped"))
        self.addCleanup(old.unlink, missing_ok=True)
        self.addCleanup(new.unlink, missing_ok=True)

        def plugin(request):
            new.write_text(note("E08", request["type"], "idea", "D00 Root question", "Retyped"))
            old.unlink()

        return plugin

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

    def test_concept_on_the_only_root_note_is_the_root_concept(self):
        def nodes():
            return {"D00": {"status": "done", "children": ["E01"]}, "E01": {"status": "running", "children": ["D01"]},
                    "D01": {"status": "idea", "children": []}, "E02": {"status": "idea", "children": []}}
        decl = {"D00": ("Geometry", "The study"), "E01": ("Runs", "")}
        # one root note: its concept is the root one, with no project level above
        n = nodes()
        root, runs = rft_server.compute_concepts(n, ["D00"], "demo", decl)
        self.assertEqual((root["id"], root["name"], root["summary"], root["root"], root["parent"], root["children"]),
                         ("root", "Geometry", "The study", "D00", None, ["E01"]))
        self.assertEqual((root["count"], root["total"]), (1, 3))
        self.assertEqual((runs["parent"], runs["depth"]), ("root", 1))
        self.assertEqual((n["D00"]["concept"], n["D01"]["concept"]), ("root", "E01"))
        # a second root note: the project holds it, above the root note's concept
        n = nodes()
        root, geometry, runs = rft_server.compute_concepts(n, ["D00", "E02"], "demo", decl)
        self.assertEqual((root["name"], root["root"], root["children"], root["count"]), ("demo", None, ["D00"], 1))
        self.assertEqual((geometry["id"], geometry["parent"], geometry["depth"], runs["depth"]), ("D00", "root", 1, 2))

    def test_concept_repos(self):
        # a one-line list, JSON or YAML; commas alone separate, a path once
        self.assertEqual(rft_server.parse_repos('["/a b/c", "../d", "/a b/c"]'), ["/a b/c", "../d"])
        self.assertEqual(rft_server.parse_repos("['/a', ../b]"), ["/a", "../b"])
        self.assertEqual(rft_server.parse_repos("/one/path"), ["/one/path"])
        self.assertEqual(rft_server.parse_repos(None), [])
        # each concept carries its own; repos on the only root note without a concept are the project's
        nodes = {"D00": {"status": "done", "children": ["E01"]}, "E01": {"status": "running", "children": []}}
        root, runs = rft_server.compute_concepts(nodes, ["D00"], "demo", {"E01": ("Runs", "", ["/code/runs"])}, {"D00": ["/code/all"]})
        self.assertEqual((root["repos"], runs["repos"]), (["/code/all"], ["/code/runs"]))
        # a two-part declaration, as before, has none
        root, runs = rft_server.compute_concepts(nodes, ["D00"], "demo", {"E01": ("Runs", "")})
        self.assertEqual((root["repos"], runs["repos"]), ([], []))
        # read from the notes: concept_repos on a note that starts a concept, and on the root note
        with tempfile.TemporaryDirectory() as tmp:
            vault = Path(tmp)
            (vault / "directions").mkdir()
            (vault / "experiments").mkdir()
            root_note = note("D00", "direction", "done", "", "Root").replace("---\n\n#", 'concept_repos: ["/code/all"]\n---\n\n#', 1)
            run_note = note("E01", "experiment", "running", "D00 Root", "Run", concept="Runs").replace(
                "---\n\n#", 'concept_repos: ["../code/runs", "/code/b"]\n---\n\n#', 1)
            (vault / "directions" / "D00 Root.md").write_text(root_note)
            (vault / "experiments" / "E01 Run.md").write_text(run_note)
            root, runs = rft_server.Vault(vault, "demo").tree()["concepts"]
            self.assertEqual((root["repos"], runs["repos"]), (["/code/all"], ["../code/runs", "/code/b"]))

    def test_tag_parsing(self):
        self.assertEqual(rft_server.parse_tags('[demo, "theory", #cluster]'), ["demo", "theory", "cluster"])
        self.assertEqual(rft_server.topical_tags(["demo", "experiment", "theory", "done", "theory"], "demo", "experiment"), ["theory"])
        self.assertEqual(rft_server.topical_tags(["demo", "theory", "idea"], "demo", "theory"), [])
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

    def test_summary(self):
        self.assertEqual(rft_server.unquote_json('"Sweep of \\"alpha\\", 3 seeds"'), 'Sweep of "alpha", 3 seeds')
        self.assertEqual(rft_server.unquote_json("plain"), "plain")
        p = self.vault / "directions" / "D02 Summed.md"
        p.write_text(note("D02", "direction", "idea", "D01 Next idea", "Summed").replace("date: 2026-01-01\n", 'date: 2026-01-01\nsummary: "One \\"line\\""\n'))
        try:
            nodes = {n["id"]: n for n in json.loads(self.get("/api/tree")[2])["nodes"]}
            self.assertEqual(nodes["D02"]["summary"], 'One "line"')
            self.assertNotIn("summary", nodes["D01"])
        finally:
            p.unlink()

    def test_superseded_by(self):
        p = self.vault / "directions" / "D02 Overturned.md"
        p.write_text(note("D02", "direction", "idea", "D01 Next idea", "Overturned").replace("date: 2026-01-01\n", 'date: 2026-01-01\nsuperseded_by: "[[D01 Next idea]]"\n'))
        try:
            nodes = {n["id"]: n for n in json.loads(self.get("/api/tree")[2])["nodes"]}
            self.assertEqual(nodes["D02"]["supersededBy"], "D01")
            self.assertNotIn("supersededBy", nodes["D01"])
        finally:
            p.unlink()

    def test_references_and_theory_notes(self):
        ref = self.vault / "references" / "R01 A paper.md"
        thy = self.vault / "theory" / "T01 A definition.md"
        ref.parent.mkdir()
        thy.parent.mkdir()
        ref.write_text(note("R01", "reference", "done", "D01 Next idea", "A paper", ("theory",)))
        thy.write_text(note("T01", "theory", "idea", "R01 A paper", "A definition", ("theory", "definitions")))
        try:
            nodes = {n["id"]: n for n in json.loads(self.get("/api/tree")[2])["nodes"]}
            self.assertEqual((nodes["R01"]["type"], nodes["R01"]["parent"], nodes["R01"]["tags"]), ("reference", "D01", ["theory"]))
            self.assertEqual((nodes["T01"]["type"], nodes["T01"]["parent"], nodes["T01"]["tags"]), ("theory", "R01", ["definitions"]))
            status, _, body = self.get("/api/note?id=T01")
            self.assertEqual(status, 200)
            self.assertIn("Text of T01.", json.loads(body)["body"])
        finally:
            ref.unlink()
            thy.unlink()
            ref.parent.rmdir()
            thy.parent.rmdir()

    def test_types_match_the_plugin(self):
        """The server's folders and id letters are the ones TYPES in hooks/lib/vault.ts gives."""
        ts = (Path(__file__).resolve().parents[1] / "hooks" / "lib" / "vault.ts").read_text()
        table = ts[ts.index("export const TYPES = {"):ts.index("} as const")]
        types = re.findall(r"^  (\w+): \{\n    prefix: '(\w)', dir: '(\w+)'", table, re.M)
        self.assertEqual(len(types), 4)
        self.assertEqual(rft_server.SUBDIRS, {d: t for t, _, d in types})
        self.assertEqual(sorted(re.search(r"\[(\w+)\]", rft_server.ID_RE.pattern).group(1)), sorted(p for _, p, _ in types))

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
        self.assertEqual(self.get("/theme.js")[0], 200)
        self.assertEqual(self.get("/markdown.js")[0], 200)
        self.assertEqual(self.get("/scratchpad.js")[0], 200)
        self.assertEqual(self.get("/vendor/jspdf.v4.2.1.umd.min.js")[0], 200)
        self.assertEqual(self.get("/vendor/svg2pdf.v2.9.0.umd.min.js")[0], 200)
        self.assertEqual(self.get("/vendor/d3.v7.9.0.min.js")[0], 200)
        self.assertEqual(self.get("/vendor/katex.v0.16.22.min.js")[0], 200)
        self.assertEqual(self.get("/vendor/katex.v0.16.22.min.css")[0], 200)
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
        for m in ["GET", "PUT", "DELETE", "PATCH"]:
            self.assertEqual(self.get("/api/node", method=m)[0], 405 if m != "GET" else 404, m)
        # a server without a key never writes
        handler = rft_server.make_handler(rft_server.Vault(self.vault, "demo"), WEB)
        server = rft_server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            port = server.server_address[1]
            self.assertEqual(self.put("E01", {"body": "x", "force": True}, port=port)[0], 405)
            self.assertEqual(self.write("PUT", "/api/scratchpad", {"text": "x", "force": True}, port=port)[0], 405)
            self.assertEqual(self.post({"parent": "D00", "type": "direction", "title": "x"}, port=port)[0], 405)
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

    # ------------------------------------------------------------ the scratchpad

    def pad(self, payload, **kw):
        return self.write("PUT", "/api/scratchpad", payload, **kw)

    def fresh_pad(self):
        """No scratchpad yet; whatever a test writes is removed afterwards."""
        p = self.vault / "Scratchpad.md"
        p.unlink(missing_ok=True)
        self.addCleanup(p.unlink, missing_ok=True)
        return p

    def test_scratchpad_made_on_first_write_and_outside_the_tree(self):
        p = self.fresh_pad()
        tree = json.loads(self.get("/api/tree")[2])
        status, _, body = self.get("/api/scratchpad")
        self.assertEqual((status, json.loads(body)), (200, {"name": "Scratchpad.md", "text": "", "version": None}))
        status, res = self.pad({"text": "- [ ] email the lab\nidea: try X", "version": None})
        self.assertEqual(status, 200)
        self.assertEqual(p.read_text(), "- [ ] email the lab\nidea: try X")  # as given: no newline added
        got = json.loads(self.get("/api/scratchpad")[2])
        self.assertEqual((got["text"], got["version"]), ("- [ ] email the lab\nidea: try X", res["version"]))
        self.assertEqual(self.pad({"text": "", "version": got["version"]})[0], 200)
        self.assertEqual(p.read_text(), "")
        # not a note: the tree, and its version, stay as they were
        self.assertEqual(json.loads(self.get("/api/tree")[2]), tree)
        self.assertEqual([f.name for f in self.vault.iterdir() if f.name.endswith(".rft-tmp")], [])

    def test_scratchpad_refused_when_it_changed(self):
        p = self.fresh_pad()
        # made elsewhere (Obsidian, Claude) after the page read that there was none
        p.write_text("from Obsidian")
        status, res = self.pad({"text": "mine", "version": None})
        self.assertEqual((status, res["text"]), (409, "from Obsidian"))
        # changed elsewhere after the page's last save
        _, ok = self.pad({"text": "mine", "version": res["version"]})
        p.write_text("from Claude")
        status, res = self.pad({"text": "mine, more", "version": ok["version"]})
        self.assertEqual((status, res["text"]), (409, "from Claude"))
        self.assertEqual(p.read_text(), "from Claude")
        # with the version it answered, or with force, the write goes through
        self.assertEqual(self.pad({"text": "mine, more", "version": res["version"]})[0], 200)
        p.write_text("again")
        self.assertEqual(self.pad({"text": "mine, forced", "force": True})[0], 200)
        self.assertEqual(p.read_text(), "mine, forced")

    def test_scratchpad_needs_the_page_and_its_key(self):
        p = self.fresh_pad()
        body = {"text": "changed", "force": True}
        self.assertEqual(self.pad(body, key=None)[0], 403)
        self.assertEqual(self.pad(body, key="wrong")[0], 403)
        self.assertEqual(self.pad(body, origin="http://evil.example")[0], 403)
        self.assertEqual(self.pad(body, host="evil.example")[0], 403)
        self.assertEqual(self.pad(body, ctype="text/plain")[0], 415)
        self.assertEqual(self.pad(b"not json")[0], 400)
        self.assertEqual(self.pad({"text": "no version"})[0], 400)
        self.assertEqual(self.pad({"text": "x", "version": 3})[0], 400)
        self.assertEqual(self.pad({"text": 3, "force": True})[0], 400)
        for m in ["POST", "DELETE", "PATCH"]:
            self.assertEqual(self.get("/api/scratchpad", method=m)[0], 405, m)
        self.assertFalse(p.exists())

    def test_scratchpad_keeps_crlf_and_writes_no_link(self):
        p = self.fresh_pad()
        p.write_bytes(b"a\r\nb\r\n")
        got = json.loads(self.get("/api/scratchpad")[2])
        self.assertEqual(got["text"], "a\nb\n")
        self.assertEqual(self.pad({"text": "a\nb\nc\n", "version": got["version"]})[0], 200)
        self.assertEqual(p.read_bytes(), b"a\r\nb\r\nc\r\n")
        # a link (here to a file outside the vault) is neither read nor written through
        p.unlink()
        os.symlink(self.root / "secret.md", p)
        secret = (self.root / "secret.md").read_bytes()
        self.assertEqual(self.get("/api/scratchpad")[0], 422)
        self.assertEqual(self.pad({"text": "pwned", "force": True})[0], 422)
        self.assertEqual((self.root / "secret.md").read_bytes(), secret)
        self.assertTrue(p.is_symlink())

    # ------------------------------------------------------------ comments, suggestions, lock

    def comment(self, nid, payload, **kw):
        return self.write("POST", "/api/comment", {"id": nid, **payload}, **kw)

    def discussed_note(self, nid="D07", text=None):
        """A scratch note whose comments file goes with it."""
        p = self.scratch_note(nid, text)
        self.addCleanup((self.vault / ".comments" / f"{nid}.json").unlink, missing_ok=True)
        return p

    def test_locate_finds_a_quote_by_its_context(self):
        body = "A cat. The dog runs. A cat sleeps. The end."
        # the second "A cat", by what comes after it
        self.assertEqual(rft_server.locate(body, "A cat", "dog runs. ", " sleeps"), (21, 26, True))
        self.assertEqual(rft_server.locate(body, "A cat", "", ". The dog"), (0, 5, True))
        # the quote edited: the text between its context, not exact
        edited = "A cat. The dog walks. A cat sleeps. The end."
        self.assertEqual(rft_server.locate(edited, "runs", "A cat. The dog ", ". A cat sleeps"), (15, 20, False))
        # its context gone too: detached
        self.assertIsNone(rft_server.locate("Something else entirely.", "runs", "The dog ", ". A cat"))
        self.assertIsNone(rft_server.locate("", "x", "", ""))
        # the quote and the text after it edited: beside what came before, text that begins as it did
        body = "## What\nMixup alpha 0.2 or 1.0, CutMix (alpha 1.0); 200 epochs[^2]."
        self.assertEqual(rft_server.locate(body, "Mixup alpha 0.2 and 1.0", "## What\n", ", CutMix; 200 epochs; 5 seeds["), (8, 31, False))
        # or, before what came after, text that ends as it did
        self.assertEqual(rft_server.locate("A brand new opening of the line, then the end.", "old opening of the line", "gone before ", ", then the end."), (8, 31, False))
        self.assertIsNone(rft_server.locate("Nothing alike here at all.", "Mixup alpha", "## What\n", ", CutMix"))

    def test_a_thread_keeps_its_context_up_to_date(self):
        p = self.discussed_note()
        self.comment("D07", {"action": "new", "kind": "comment", "quote": "Text of D07", "prefix": "", "suffix": "", "text": "?"})
        # the text before the quote rewritten, the quote kept: the next action takes the context anew
        p.write_text(p.read_text().replace("# D07 · Scratch\n\n", "# D07 · Scratch\n\nA new first paragraph.\n\n"))
        self.comment("D07", {"action": "reply", "thread": "c1", "text": "More."})
        saved = json.loads((self.vault / ".comments" / "D07.json").read_text())["threads"][0]
        self.assertEqual(saved["prefix"], " D07 · Scratch\n\nA new first paragraph.\n\n")
        # and so does a save of the note's text from the page
        n = json.loads(self.get("/api/note?id=D07")[2])
        self.put("D07", {"body": n["body"].replace("A new first paragraph.", "Rewritten."), "version": n["version"]})
        saved = json.loads((self.vault / ".comments" / "D07.json").read_text())["threads"][0]
        self.assertTrue(saved["prefix"].endswith("Rewritten.\n\n"))

    def test_a_comment_thread_from_posting_to_history(self):
        self.discussed_note()
        status, n = self.comment("D07", {"action": "new", "kind": "comment", "quote": "Text of D07", "prefix": "Scratch\n\n", "suffix": ".", "text": " Is this right? "})
        self.assertEqual(status, 200)
        [t] = n["threads"]
        self.assertEqual((t["id"], t["kind"], t["state"], t["quote"]), ("c1", "comment", "open", "Text of D07"))
        self.assertEqual(n["body"][t["at"][0]:t["at"][1]], "Text of D07")
        self.assertTrue(t["exact"])
        self.assertEqual(t["prefix"], "\n# D07 · Scratch\n\n")
        self.assertEqual(t["messages"], [{"by": "you", "at": t["messages"][0]["at"], "text": "Is this right?"}])
        self.assertRegex(t["messages"][0]["at"], r"^\d{4}-\d\d-\d\d \d\d:\d\d$")
        nodes = {x["id"]: x for x in json.loads(self.get("/api/tree")[2])["nodes"]}
        self.assertEqual(nodes["D07"]["threads"], 1)
        self.assertEqual(self.comment("D07", {"action": "reply", "thread": "c1", "text": "Yes."})[1]["threads"][0]["messages"][-1]["text"], "Yes.")
        status, n = self.comment("D07", {"action": "resolve", "thread": "c1"})
        self.assertEqual((status, n["threads"][0]["state"], n["threads"][0]["closed"]["by"]), (200, "resolved", "you"))
        # kept as history, and no longer counted as open
        nodes = {x["id"]: x for x in json.loads(self.get("/api/tree")[2])["nodes"]}
        self.assertEqual(nodes["D07"]["threads"], 0)
        self.assertEqual(self.comment("D07", {"action": "reply", "thread": "c1", "text": "More."})[0], 409)
        self.assertEqual(self.comment("D07", {"action": "reopen", "thread": "c1"})[1]["threads"][0]["state"], "open")
        # the next thread gets the next id; the comments file is plain JSON beside the notes
        self.comment("D07", {"action": "new", "kind": "comment", "quote": "Scratch", "prefix": "", "suffix": "", "text": "Title?"})
        saved = json.loads((self.vault / ".comments" / "D07.json").read_text())
        self.assertEqual([x["id"] for x in saved["threads"]], ["c1", "c2"])
        self.assertEqual(saved["next"], 3)

    def test_a_thread_on_text_no_longer_in_the_note_is_refused(self):
        self.discussed_note()
        status, res = self.comment("D07", {"action": "new", "kind": "comment", "quote": "Not here", "prefix": "", "suffix": "", "text": "?"})
        self.assertEqual(status, 409)
        self.assertIn("select it again", res["error"])
        self.assertIn("body", res)
        self.assertFalse((self.vault / ".comments" / "D07.json").exists())

    def test_a_suggestion_accepted_is_written_into_the_note(self):
        p = self.discussed_note()
        before = p.read_text()
        _, n = self.comment("D07", {"action": "new", "kind": "suggestion", "quote": "Text of D07.", "prefix": "", "suffix": "", "text": "", "replacement": "Better text, with $x$."})
        self.assertEqual(n["threads"][0]["replacement"], "Better text, with $x$.")
        status, n = self.comment("D07", {"action": "accept", "thread": "c1"})
        self.assertEqual((status, n["threads"][0]["state"]), (200, "accepted"))
        self.assertEqual(p.read_text(), before.replace("Text of D07.", "Better text, with $x$."))
        self.assertEqual(n["body"], "\n# D07 · Scratch\n\nBetter text, with $x$.\n")
        self.assertEqual(self.comment("D07", {"action": "accept", "thread": "c1"})[0], 400)

    def test_a_suggestion_on_text_that_changed_is_not_accepted(self):
        p = self.discussed_note()
        self.comment("D07", {"action": "new", "kind": "suggestion", "quote": "Text of D07.", "prefix": "", "suffix": "", "text": "", "replacement": "New."})
        p.write_text(p.read_text().replace("Text of D07.", "Text of D07, edited by Claude."))
        changed = p.read_text()
        n = json.loads(self.get("/api/note?id=D07")[2])
        self.assertFalse(n["threads"][0]["exact"])
        status, res = self.comment("D07", {"action": "accept", "thread": "c1"})
        self.assertEqual(status, 409)
        self.assertIn("the text changed", res["error"])
        self.assertEqual(p.read_text(), changed)
        self.assertEqual(self.comment("D07", {"action": "reject", "thread": "c1"})[1]["threads"][0]["state"], "rejected")

    def test_an_instruction_is_a_suggestion_without_a_replacement(self):
        self.discussed_note()
        _, n = self.comment("D07", {"action": "new", "kind": "suggestion", "quote": "Text of D07.", "prefix": "", "suffix": "", "text": "Add the numbers.", "replacement": "Text of D07."})
        self.assertIsNone(n["threads"][0]["replacement"])
        status, res = self.comment("D07", {"action": "accept", "thread": "c1"})
        self.assertEqual(status, 409)
        self.assertIn("no replacement yet", res["error"])
        # a suggestion needs a change or an instruction; a comment needs its text
        self.assertEqual(self.comment("D07", {"action": "new", "kind": "suggestion", "quote": "Scratch", "text": ""})[0], 400)
        self.assertEqual(self.comment("D07", {"action": "new", "kind": "comment", "quote": "Scratch", "text": " "})[0], 400)
        self.assertEqual(self.comment("D07", {"action": "resolve", "thread": "c1"})[0], 400)

    def test_ask_claude_hands_the_thread_to_the_session(self):
        self.discussed_note()
        self.session(None)
        self.comment("D07", {"action": "new", "kind": "comment", "quote": "Scratch", "prefix": "", "suffix": "", "text": "Why?"})
        status, n = self.comment("D07", {"action": "ask", "thread": "c1"})
        self.assertEqual(status, 200)
        self.assertEqual(self.asked, [("RFT_ASK", {"id": "D07", "thread": "c1"})])
        self.assertRegex(n["threads"][0]["asked"], r"^\d{4}-")

        def gone(request):
            raise OSError("broken pipe")

        self.session(gone)
        self.comment("D07", {"action": "new", "kind": "comment", "quote": "Text of D07", "prefix": "", "suffix": "", "text": "And this?"})
        status, res = self.comment("D07", {"action": "ask", "thread": "c2"})
        self.assertEqual(status, 503)
        self.assertIsNone(json.loads(self.get("/api/note?id=D07")[2])["threads"][1]["asked"])

    def test_comments_need_the_page_and_its_key(self):
        self.discussed_note()
        payload = {"action": "new", "kind": "comment", "quote": "Scratch", "prefix": "", "suffix": "", "text": "x"}
        self.assertEqual(self.comment("D07", payload, key=None)[0], 403)
        self.assertEqual(self.comment("D07", payload, origin="http://evil.example")[0], 403)
        self.assertEqual(self.comment("D07", {"action": "dance", "thread": "c1"})[0], 404)
        self.assertEqual(self.comment("D07", {**payload, "text": "x" * 20_001})[0], 413)
        self.assertEqual(self.comment("D99", payload)[0], 404)
        self.assertEqual(self.write("POST", "/api/comment", {"action": "new"})[0], 400)
        self.assertFalse((self.vault / ".comments" / "D07.json").exists())
        self.assertEqual(self.comment("D07", payload)[0], 200)
        self.assertEqual(self.comment("D07", {"action": "dance", "thread": "c1"})[0], 400)

    def test_lock_and_unlock_a_note(self):
        p = self.scratch_note()
        before = p.read_text()
        status, n = self.write("POST", "/api/lock", {"id": "D07", "locked": True})
        self.assertEqual((status, n["locked"]), (200, True))
        self.assertEqual(p.read_text(), before.replace("\n---\n", "\nlocked: true\n---\n", 1))
        nodes = {x["id"]: x for x in json.loads(self.get("/api/tree")[2])["nodes"]}
        self.assertTrue(nodes["D07"]["locked"])
        self.assertFalse(nodes["D00"]["locked"])
        # locking twice keeps one line; unlocking gives the note back as it was
        self.write("POST", "/api/lock", {"id": "D07", "locked": True})
        self.assertEqual(p.read_text().count("locked:"), 1)
        status, n = self.write("POST", "/api/lock", {"id": "D07", "locked": False})
        self.assertEqual((status, n["locked"], p.read_text()), (200, False, before))
        self.assertEqual(self.write("POST", "/api/lock", {"id": "D07", "locked": True}, key=None)[0], 403)
        self.assertEqual(self.write("POST", "/api/lock", {"id": "D07", "locked": "yes"})[0], 400)
        self.assertEqual(p.read_text(), before)

    # ------------------------------------------------------------ priorities

    def priority(self, payload, **kw):
        return self.write("POST", "/api/priority", payload, **kw)

    def nodes(self):
        return {x["id"]: x for x in json.loads(self.get("/api/tree")[2])["nodes"]}

    def with_priority(self, path, priority):
        """A fixture note given `priority` for one test, as it was afterwards."""
        before = path.read_text()
        self.addCleanup(path.write_text, before)
        path.write_text(re.sub(r"(status: \w+\n)", rf"\1priority: {priority}\n", before, count=1))

    def test_priority_set_changed_and_taken_away(self):
        p = self.scratch_note()
        before = p.read_text()
        self.assertEqual(self.priority({"id": "D07", "priority": "high"}), (200, {"id": "D07", "priority": "high"}))
        self.assertEqual(p.read_text(), before.replace("status: idea\n", "status: idea\npriority: high\n", 1))
        self.assertEqual(self.nodes()["D07"]["priority"], "high")
        self.assertNotIn("priority", self.nodes()["D00"])
        # changed in place, one line; null takes it away and gives the note back as it was
        self.priority({"id": "D07", "priority": "low"})
        self.assertEqual(p.read_text().count("priority:"), 1)
        self.assertEqual(self.priority({"id": "D07", "priority": None}), (200, {"id": "D07", "priority": None}))
        self.assertEqual(p.read_text(), before)

    def test_accepting_or_dismissing_claudes_suggestion(self):
        suggestion = 'suggested_priority: high\nsuggested_priority_why: "It unblocks D05"\n'
        text = note("D07", "direction", "idea", "D00 Root question", "Scratch").replace("status: idea\n", "status: idea\n" + suggestion)
        p = self.scratch_note(text=text)
        n = self.nodes()["D07"]
        self.assertEqual((n.get("priority"), n["suggestedPriority"], n["suggestedWhy"]), (None, "high", "It unblocks D05"))
        # dismissed: the suggestion goes, and no priority comes
        self.assertEqual(self.priority({"id": "D07", "dismiss": True}), (200, {"id": "D07", "priority": None}))
        self.assertEqual(p.read_text(), text.replace(suggestion, ""))
        self.assertNotIn("suggestedPriority", self.nodes()["D07"])
        # accepted, or another priority chosen: either answers the suggestion
        p.write_text(text)
        self.priority({"id": "D07", "priority": "medium"})
        self.assertEqual(p.read_text(), text.replace(suggestion, "priority: medium\n"))
        self.assertNotIn("suggestedPriority", self.nodes()["D07"])

    def test_priority_limits_count_the_open_notes_only(self):
        self.with_priority(self.vault / "experiments" / "E01 First run.md", "urgent")  # E01 is running
        self.scratch_note()
        status, err = self.priority({"id": "D07", "priority": "urgent"})
        self.assertEqual((status, err["holders"]), (409, ["E01"]))
        self.assertIn("urgent is full: E01 already holds it (at most 1 open note). Lower one of them first.", err["error"])
        self.assertNotIn("priority", self.nodes()["D07"])
        # the note that holds it may set it again; a note that is done does not count
        self.assertEqual(self.priority({"id": "E01", "priority": "urgent"})[0], 200)
        self.with_priority(self.vault / "directions" / "D00 Root question.md", "low")
        self.assertEqual(self.priority({"id": "D00", "priority": "urgent"})[0], 200)
        # five high ideas fill high; medium still has room, low has no limit
        for i in range(5):
            self.scratch_note(f"D1{i}", note(f"D1{i}", "direction", "idea", "D00 Root question", "Scratch")
                              .replace("status: idea\n", "status: idea\npriority: high\n"))
        status, err = self.priority({"id": "D07", "priority": "high"})
        self.assertEqual((status, err["holders"]), (409, ["D10", "D11", "D12", "D13", "D14"]))
        self.assertIn("D10, D11, D12, D13, D14 already hold it (at most 5 open notes)", err["error"])
        self.assertEqual(self.priority({"id": "D07", "priority": "medium"})[0], 200)
        self.assertEqual(self.priority({"id": "D07", "priority": "low"})[0], 200)

    def test_priority_bad_requests(self):
        p = self.scratch_note()
        before = p.read_text()
        for payload in ({"id": "D07"}, {"id": "D07", "priority": "top"}, {"id": "D07", "priority": 1},
                        {"id": "D07", "priority": "High"}, {"priority": "high"}, {"id": "D07", "dismiss": "yes"}):
            self.assertEqual(self.priority(payload)[0], 400, payload)
        self.assertEqual(self.priority({"id": "D07", "priority": "high"}, key=None)[0], 403)
        self.assertEqual(self.priority({"id": "D07", "priority": "high"}, origin="http://evil.example")[0], 403)
        self.assertEqual(self.priority({"id": "D99", "priority": "high"})[0], 404)
        self.assertEqual(p.read_text(), before)

    def test_priorities_match_the_plugin_and_the_page(self):
        """PRIORITIES, their limits and the open statuses, as hooks/lib/vault.ts and web/kanban.js give them."""
        root = Path(__file__).resolve().parents[1]
        words = lambda s: tuple(re.findall(r"'(\w+)'", s))
        limits = lambda s: {k: None if v == "null" else int(v) for k, v in re.findall(r"(\w+): (\d+|null)", s)}
        ts = (root / "hooks" / "lib" / "vault.ts").read_text()
        self.assertEqual(words(re.search(r"export const PRIORITIES = \[(.*?)\]", ts).group(1)), rft_server.PRIORITIES)
        self.assertEqual(limits(re.search(r"export const PRIORITY_LIMITS[^=]*= \{(.*?)\}", ts).group(1)), rft_server.PRIORITY_LIMITS)
        self.assertEqual(words(re.search(r"export const OPEN_STATUSES[^=]*= \[(.*?)\]", ts).group(1)), rft_server.OPEN_STATUSES)
        js = (root / "web" / "kanban.js").read_text()
        self.assertEqual(words(re.search(r"const PRIORITIES = \[(.*?)\]", js).group(1)), rft_server.PRIORITIES)
        self.assertEqual(limits(re.search(r"const LIMITS = \{(.*?)\}", js).group(1)), rft_server.PRIORITY_LIMITS)
        self.assertEqual(words(re.search(r"const OPEN = \[(.*?)\]", js).group(1)), rft_server.OPEN_STATUSES)

    # ------------------------------------------------------------ dates and deadlines

    def dates(self, payload, **kw):
        return self.write("POST", "/api/dates", payload, **kw)

    def milestone(self, payload, **kw):
        return self.write("POST", "/api/milestone", payload, **kw)

    def scratch_experiment(self, extra=""):
        """An experiment of its own, E17, planned, with more frontmatter after its status."""
        p = self.vault / "experiments" / "E17 Scratch run.md"
        p.write_text(note("E17", "experiment", "planned", "D00 Root question", "Scratch run").replace("status: planned\n", "status: planned\n" + extra))
        self.addCleanup(p.unlink)
        return p

    def milestones_dir(self):
        d = self.vault / "milestones"
        self.addCleanup(shutil.rmtree, d, ignore_errors=True)
        return d

    def test_tree_has_the_dates_and_the_deadlines(self):
        self.scratch_experiment('start: 2026-11-27\nest: 1w\ngpus: 2\nafter: ["[[E01 First run]]"]\nsuggested_est: 4d\n'
                                'suggested_dates_why: "Two seeds fewer"\ndue: soon\n')
        d = self.milestones_dir()
        d.mkdir()
        (d / "M01 Workshop paper.md").write_text('---\nid: M01\ntype: milestone\nstatus: open\ndue: 2026-12-05 23:59 AoE\n'
                                                 'needs: ["[[E17 Scratch run]]", "[[E99 Gone]]"]\n---\n\n# M01 · Workshop paper\n')
        tree = json.loads(self.get("/api/tree")[2])
        e17 = {n["id"]: n for n in tree["nodes"]}["E17"]
        keys = ("start", "est", "gpus", "after", "suggestedEst", "suggestedDatesWhy", "due", "suggestedStart")
        self.assertEqual({k: e17.get(k) for k in keys}, {"start": "2026-11-27", "est": 7, "gpus": 2, "after": ["E01"], "suggestedEst": 4,
                                                         "suggestedDatesWhy": "Two seeds fewer", "due": None, "suggestedStart": None})
        self.assertEqual(tree["milestones"], [{"id": "M01", "name": "M01 Workshop paper", "title": "Workshop paper", "path": "milestones/M01 Workshop paper.md",
                                               "status": "open", "due": "2026-12-05 23:59 AoE", "needs": ["E17"], "missing": ["E99 Gone"]}])
        self.assertIsNone(tree["gpus"])  # no config given

    def test_dates_set_cleared_and_suggestion_answered(self):
        p = self.scratch_experiment('suggested_start: 2026-11-20\nsuggested_est: 4d\nsuggested_dates_why: "Before M01"\n')
        before = p.read_text()
        plain = re.sub(r"suggested_.*\n", "", before)
        # dismissed: the suggestion goes, and no date comes
        self.assertEqual(self.dates({"id": "E17", "dismiss": True}), (200, {"id": "E17"}))
        self.assertEqual(p.read_text(), plain)
        # set (accepting, or setting other dates, answers the suggestion): after the status, due, start, est
        p.write_text(before)
        self.assertEqual(self.dates({"id": "E17", "start": "2026-11-20", "est": "4d"}), (200, {"id": "E17", "start": "2026-11-20", "est": "4d"}))
        self.assertEqual(p.read_text(), plain.replace("status: planned\n", "status: planned\nstart: 2026-11-20\nest: 4d\n"))
        # changed in place, one line; null takes a date away
        self.dates({"id": "E17", "est": "1w"})
        self.assertEqual(p.read_text().count("est:"), 1)
        self.assertEqual((self.nodes()["E17"]["start"], self.nodes()["E17"]["est"]), ("2026-11-20", 7))
        self.dates({"id": "E17", "start": None, "est": None, "due": "2026-12-01 14:00"})
        n = self.nodes()["E17"]
        self.assertEqual((n.get("start"), n.get("est"), n["due"]), (None, None, "2026-12-01 14:00"))
        # any note can have a due date
        self.assertEqual(self.dates({"id": "D01", "due": "2026-12-01"})[0], 200)
        self.addCleanup(self.dates, {"id": "D01", "due": None})

    def test_dates_bad_requests(self):
        p = self.scratch_experiment()
        before = p.read_text()
        for payload in ({"id": "E17"}, {"id": "E17", "start": "soon"}, {"id": "E17", "est": "1.5d"}, {"id": "E17", "due": "next friday"},
                        {"id": "E17", "start": 3}, {"id": "E17", "priority": "high"}, {"start": "2026-11-20"}, {"id": "E17", "dismiss": "yes"}):
            self.assertEqual(self.dates(payload)[0], 400, payload)
        self.assertEqual(self.dates({"id": "D01", "est": "3d"})[0], 422)  # only experiments run
        self.assertEqual(self.dates({"id": "E17", "start": "2026-11-20"}, key=None)[0], 403)
        self.assertEqual(self.dates({"id": "E17", "start": "2026-11-20"}, origin="http://evil.example")[0], 403)
        self.assertEqual(self.dates({"id": "E99", "start": "2026-11-20"})[0], 404)
        self.assertEqual(p.read_text(), before)

    def test_deadline_added_changed_and_answered(self):
        d = self.milestones_dir()
        status, res = self.milestone({"title": "  Workshop: paper? ", "due": "2026-12-05", "needs": ["E01", "E01"]})
        self.assertEqual((status, res), (201, {"id": "M01", "name": "M01 Workshop paper"}))
        p = d / "M01 Workshop paper.md"
        self.assertEqual(p.read_text(), '---\nid: M01\ntype: milestone\nstatus: open\ndue: 2026-12-05\nneeds: ["[[E01 First run]]"]\n---\n\n# M01 · Workshop paper\n')
        # changed: the due date in place, the needs, the status
        self.assertEqual(self.milestone({"id": "M01", "due": "2026-12-05 23:59 AoE", "needs": ["E01", "D01"], "status": "done"}), (200, {"id": "M01"}))
        self.assertEqual(p.read_text(), '---\nid: M01\ntype: milestone\nstatus: done\ndue: 2026-12-05 23:59 AoE\n'
                                        'needs: ["[[E01 First run]]", "[[D01 Next idea]]"]\n---\n\n# M01 · Workshop paper\n')
        self.milestone({"id": "M01", "needs": []})
        self.assertNotIn("needs:", p.read_text())
        # Claude's suggestion: accepted, it is open; dismissed, it stays, so it is not suggested again
        s = d / "M02 Venue X paper.md"
        s.write_text('---\nid: M02\ntype: milestone\nstatus: suggested\ndue: 2027-03-05 23:59 AoE\nsource: https://venue-x.org/dates\n'
                     'why: "Main results in"\n---\n\n# M02 · Venue X paper\n')
        self.assertEqual(self.milestone({"id": "M02", "accept": True})[0], 200)
        self.assertIn("status: open\n", s.read_text())
        self.milestone({"id": "M02", "dismiss": True})
        tree = json.loads(self.get("/api/tree")[2])
        self.assertEqual({m["id"]: m["status"] for m in tree["milestones"]}, {"M01": "done", "M02": "dismissed"})
        self.assertEqual(tree["milestones"][1]["source"], "https://venue-x.org/dates")
        # ids are never reused: the next one after every milestone on disk
        self.assertEqual(self.milestone({"title": "Talk", "due": "2026-12-10"})[1]["id"], "M03")

    def test_deadline_bad_requests(self):
        d = self.milestones_dir()
        for payload in ({"title": "Talk"}, {"title": "Talk", "due": "soon"}, {"title": "  ?? ", "due": "2026-12-10"},
                        {"title": "Talk", "due": "2026-12-10", "needs": ["E99"]}, {"title": "Talk", "due": "2026-12-10", "needs": "E01"},
                        {"due": "2026-12-10"}):
            self.assertEqual(self.milestone(payload)[0], 400, payload)
        self.assertFalse(d.exists())
        self.assertEqual(self.milestone({"title": "Talk", "due": "2026-12-10"}, key=None)[0], 403)
        self.assertEqual(self.milestone({"id": "M09", "status": "done"})[0], 404)
        self.assertEqual(self.milestone({"title": "Talk", "due": "2026-12-10"})[0], 201)
        for payload in ({"id": "M01"}, {"id": "M01", "status": "suggested"}, {"id": "M01", "due": "soon"}, {"id": "M01", "accept": "yes"}):
            self.assertEqual(self.milestone(payload)[0], 400, payload)

    def test_due_dates_read_as_the_page_reads_them(self):
        """DUE_RE and the milestone statuses, as web/schedule.js has them."""
        js = (Path(__file__).resolve().parents[1] / "web" / "schedule.js").read_text()
        self.assertEqual(re.search(r"const DUE_RE = /(.*)/i\n", js).group(1), rft_server.DUE_RE.pattern)
        self.assertEqual(tuple(re.findall(r"'(\w+)'", re.search(r"const MILESTONE_STATUSES = \[(.*?)\]", js).group(1))), rft_server.MILESTONE_STATUSES)

    def test_add_node_asks_the_session_and_answers_the_new_id(self):
        self.session(self.plugin)
        status, res = self.post({"parent": "E01", "type": "direction", "title": "  Then this  "})
        self.assertEqual((status, res), (201, {"id": "D07", "name": "D07 Then this"}))
        # the session is asked for the type, the parent and the title alone: the status is its default
        self.assertEqual(self.asked, [("RFT_ADD_NODE", {"parent": "E01", "type": "direction", "title": "Then this"})])
        nodes = {n["id"]: n for n in json.loads(self.get("/api/tree")[2])["nodes"]}
        self.assertEqual(nodes["D07"]["parent"], "E01")

    def test_add_node_answers_once_the_session_is_done_writing(self):
        def plugin_then_sync(request):
            p = self.plugin(request)

            def sync():  # the derived fields, written a moment after the note
                time.sleep(0.15)
                p.write_text(p.read_text().replace("parent:", 'up: "[[D00 Root question]]"\nparent:'))

            threading.Thread(target=sync).start()

        self.session(plugin_then_sync)
        status, res = self.post({"parent": "D00", "type": "experiment", "title": "Settled"})
        self.assertEqual(status, 201)
        # the note the page then opens is the final one: its first save is no conflict
        n = json.loads(self.get(f"/api/note?id={res['id']}")[2])
        time.sleep(0.3)  # the user types
        self.assertEqual(self.put(res["id"], {"body": n["body"] + "More.\n", "version": n["version"]})[0], 200)

    def test_add_node_bad_requests_reach_no_session(self):
        self.session(self.plugin)
        ok = {"parent": "D00", "type": "experiment", "title": "Fine"}
        for payload, status in [({**ok, "type": "note"}, 400), ({**ok, "title": " ?| "}, 400), ({**ok, "title": None}, 400),
                                ({"parent": "D00", "type": "experiment"}, 400), (["Fine"], 400), (b"not json", 400),
                                ({**ok, "parent": "D42"}, 404), ({**ok, "parent": "../secret"}, 404)]:
            self.assertEqual(self.post(payload)[0], status, payload)
        self.assertEqual(self.post(ok, key=None)[0], 403)
        self.assertEqual(self.post(ok, key="wrong")[0], 403)
        self.assertEqual(self.post(ok, origin="http://evil.example")[0], 403)
        self.assertEqual(self.post(ok, ctype="text/plain")[0], 415)
        self.assertEqual(self.write("POST", "/api/tree", ok)[0], 405)
        self.assertEqual(self.asked, [])

    def test_add_node_without_a_session(self):
        wait = rft_server.NODE_WAIT_S
        rft_server.NODE_WAIT_S = 0.3
        self.addCleanup(setattr, rft_server, "NODE_WAIT_S", wait)
        self.session(None)
        status, res = self.post({"parent": "D00", "type": "direction", "title": "Lost"})
        self.assertEqual(status, 504)
        self.assertIn("is the session that ran /rft still open", res["error"])

        def gone(_):
            raise BrokenPipeError()

        self.session(gone)
        self.assertEqual(self.post({"parent": "D00", "type": "direction", "title": "Lost"})[0], 503)

    def mover(self, request):
        """The session as the server sees it for a move: the note's `parent:` now names the new one."""
        p = self.vault / "directions" / "D01 Next idea.md"
        before = p.read_text()
        self.addCleanup(p.write_text, before)
        names = {"D00": "D00 Root question", "E01": "E01 First run"}
        p.write_text(before.replace('parent: "[[E01 First run]]"', f'parent: "[[{names[request["parent"]]}]]"\norigin: ["[[E01 First run]]"]'))

    def move(self, payload, **kw):
        return self.write("POST", "/api/move", payload, **kw)

    def test_move_asks_the_session_and_answers_once_moved(self):
        self.session(self.mover)
        self.assertEqual(self.move({"id": "D01", "parent": "D00"}), (200, {"id": "D01", "parent": "D00"}))
        self.assertEqual(self.asked, [("RFT_MOVE_NODE", {"id": "D01", "parent": "D00"})])
        nodes = {n["id"]: n for n in json.loads(self.get("/api/tree")[2])["nodes"]}
        self.assertEqual((nodes["D01"]["parent"], nodes["D01"]["origin"]), ("D00", ["E01"]))
        self.assertNotIn("origin", nodes["E01"])

    def test_move_relays_the_unlock_the_user_agreed_to_in_the_page(self):
        self.session(self.mover)
        self.assertEqual(self.move({"id": "D01", "parent": "D00", "unlock": True})[0], 200)
        self.assertEqual(self.asked, [("RFT_MOVE_NODE", {"id": "D01", "parent": "D00", "unlock": True})])

    def verifier(self, status="done", extra=""):
        """E01 with `status` (and `extra` fields), and the session as the server sees it for a
        verification: the note's status as the session writes it."""
        p = self.vault / "experiments" / "E01 First run.md"
        before = p.read_text()
        self.addCleanup(p.write_text, before)
        p.write_text(before.replace("status: running", f"status: {status}{extra}"))

        def answer(request):
            text = p.read_text()
            if request["action"] == "verify":
                text = text.replace(f"status: {status}", 'status: verified\nverified: "2026-11-17 a1b2c3d4"\nlocked: true')
            elif request["action"] == "review":
                text = text.replace("status: verified", "status: review").replace("locked: true\n", "")
            text = text.replace('suggested_verified: "Reran it"\n', "")
            p.write_text(text)

        self.session(answer)

    def verify(self, payload, **kw):
        return self.write("POST", "/api/verify", payload, **kw)

    def test_verify_asks_the_session_and_answers_once_verified(self):
        self.verifier(extra='\nsuggested_verified: "Reran it"')
        nodes = {n["id"]: n for n in json.loads(self.get("/api/tree")[2])["nodes"]}
        self.assertEqual(nodes["E01"]["suggestedVerified"], "Reran it")
        status, res = self.verify({"id": "E01", "action": "verify"})
        self.assertEqual((status, res["locked"]), (200, True))
        self.assertEqual(self.asked, [("RFT_VERIFY", {"id": "E01", "action": "verify"})])
        nodes = {n["id"]: n for n in json.loads(self.get("/api/tree")[2])["nodes"]}
        self.assertEqual((nodes["E01"]["status"], nodes["E01"]["verified"]), ("verified", {"date": "2026-11-17", "fingerprint": "a1b2c3d4"}))
        self.assertNotIn("suggestedVerified", nodes["E01"])
        # verified notes count as finished: an experiment with a result
        self.assertTrue(nodes["E01"].get("hasResult"))
        self.assertEqual(self.verify({"id": "E01", "action": "review"})[0], 200)
        self.assertEqual(json.loads(self.get("/api/note?id=E01")[2])["locked"], False)

    def test_verify_bad_requests_reach_no_session(self):
        self.verifier(status="running")
        for payload, status in [({"id": "E01"}, 400), ({"id": "E01", "action": "approve"}, 400), ({"id": "E01", "action": 1}, 400),
                                ({"id": "E42", "action": "verify"}, 404), ({"id": "E01", "action": "verify"}, 400),
                                ({"id": "E01", "action": "review"}, 400), ({"id": "E01", "action": "dismiss"}, 400)]:
            self.assertEqual(self.verify(payload)[0], status, payload)
        self.assertEqual(self.verify({"id": "E01", "action": "verify"}, key=None)[0], 403)
        self.assertEqual(self.asked, [])

    def test_serves_a_reference_pdf_from_papers_only(self):
        papers = self.vault / "papers" / "Runs"
        papers.mkdir(parents=True)
        (papers / "2020 Doe A paper.pdf").write_bytes(b"%PDF-1.4 x")
        self.addCleanup(lambda: ((papers / "2020 Doe A paper.pdf").unlink(), papers.rmdir(), papers.parent.rmdir()))
        p = self.vault / "directions" / "D01 Next idea.md"
        before = p.read_text()
        self.addCleanup(p.write_text, before)
        p.write_text(before.replace("tags:", 'pdf: "[[papers/Runs/2020 Doe A paper.pdf]]"\ntags:'))
        status, ctype, body = self.get("/api/paper?id=D01")
        self.assertEqual((status, ctype, body), (200, "application/pdf", b"%PDF-1.4 x"))
        self.assertEqual(self.get("/api/paper?id=E01")[0], 404)
        for target in ["../secret.md", "directions/D01 Next idea.md", "papers/../../secret.md"]:
            p.write_text(before.replace("tags:", f'pdf: "[[{target}]]"\ntags:'))
            self.assertEqual(self.get("/api/paper?id=D01")[0], 404, target)

    def test_refs_are_read_as_ids(self):
        p = self.vault / "directions" / "D01 Next idea.md"
        before = p.read_text()
        self.addCleanup(p.write_text, before)
        p.write_text(before.replace("tags:", 'refs: ["[[E01 First run]]", "[[R99 Gone]]"]\ntags:'))
        nodes = {n["id"]: n for n in json.loads(self.get("/api/tree")[2])["nodes"]}
        self.assertEqual(nodes["D01"]["refs"], ["E01"])
        self.assertNotIn("refs", nodes["E01"])

    def test_move_bad_requests_reach_no_session(self):
        self.session(self.mover)
        for payload, status in [({"id": "D01"}, 400), ({"id": "D01", "parent": 3}, 400), ({"id": "D42", "parent": "D00"}, 404),
                                ({"id": "D00", "parent": "E01"}, 400), ({"id": "D01", "parent": "E01"}, 400),
                                ({"id": "E01", "parent": "D01"}, 400), ({"id": "E01", "parent": "E01"}, 400),
                                ({"id": "D01", "parent": "D00", "unlock": "yes"}, 400)]:
            self.assertEqual(self.move(payload)[0], status, payload)
        self.assertEqual(self.move({"id": "D01", "parent": "D00"}, key=None)[0], 403)
        self.assertEqual(self.move({"id": "D01", "parent": "D00"}, origin="http://evil.example")[0], 403)
        self.assertEqual(self.asked, [])

    def test_move_line_on_stdout(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rft_server.ask_session("RFT_MOVE_NODE", {"id": "D01", "parent": "D00"})
        self.assertEqual(out.getvalue(), 'RFT_MOVE_NODE {"id": "D01", "parent": "D00"}\n')

    def test_set_type_asks_the_session_and_answers_the_new_id(self):
        self.session(self.retyped_note())
        status, res = self.write("POST", "/api/type", {"id": "D08", "type": "experiment"})
        self.assertEqual((status, res), (200, {"id": "E08", "name": "E08 Retyped"}))
        self.assertEqual(self.asked, [("RFT_SET_TYPE", {"id": "D08", "type": "experiment"})])
        ids = {n["id"] for n in json.loads(self.get("/api/tree")[2])["nodes"]}
        self.assertIn("E08", ids)
        self.assertNotIn("D08", ids)

    def test_set_type_bad_requests_reach_no_session(self):
        self.session(self.retyped_note())
        ok = {"id": "D08", "type": "experiment"}
        for payload, status in [({**ok, "type": "note"}, 400), ({**ok, "type": "direction"}, 400),
                                ({"id": "D00", "type": "experiment"}, 400), ({**ok, "id": "D42"}, 404),
                                ({**ok, "id": "../secret"}, 404), ({"id": "D08"}, 400), (["D08"], 400)]:
            self.assertEqual(self.write("POST", "/api/type", payload)[0], status, payload)
        self.assertEqual(self.write("POST", "/api/type", ok, key=None)[0], 403)
        self.assertEqual(self.write("POST", "/api/type", ok, origin="http://evil.example")[0], 403)
        self.assertEqual(self.asked, [])

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

    def test_asks_the_session_on_stdout(self):
        proc, port, key = self.start(self.root / "cache")
        result = {}
        req = {"parent": "D00", "type": "direction", "title": "Café, from the page"}
        t = threading.Thread(target=lambda: result.update(answer=self.post(req, key=key, port=port)))
        t.start()
        # the line the plugin reads (hooks/register.tsx), the title in ASCII-only JSON
        self.assertEqual(proc.stdout.readline(), 'RFT_ADD_NODE {"parent": "D00", "type": "direction", "title": "Caf\\u00e9, from the page"}\n')
        self.plugin(req)
        t.join()
        self.assertEqual(result["answer"], (201, {"id": "D07", "name": "D07 Café, from the page"}))

    def test_binds_loopback(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def fetch(port, path):
    """(status, JSON body) of a GET on 127.0.0.1:port, or (None, None) when nothing answers."""
    try:
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        c.request("GET", path)
        r = c.getresponse()
        status, body = r.status, r.read()
        c.close()
        return status, json.loads(body)
    except OSError:
        return None, None


class ImageTest(unittest.TestCase):
    """The images a note embeds: found as Obsidian finds them, the ones outside the vault only with the key."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        obs = Path(cls.tmp.name) / "obs"  # an Obsidian vault, the tree's vault inside it
        vault = obs / "proj" / "vault"
        for d in [obs / ".obsidian", obs / "pics", obs / ".trash", obs / "proj" / "code" / "results",
                  vault / "directions", vault / "experiments" / "attachments", vault / "experiments" / "figs"]:
            d.mkdir(parents=True, exist_ok=True)
        (vault / "directions" / "D00 Root.md").write_text(note("D00", "direction", "done", "", "Root"))
        (vault / "experiments" / "E01 Run.md").write_text(note("E01", "experiment", "done", "D00 Root", "Run"))
        cls.files = {
            "pasted": vault / "experiments" / "attachments" / "Pasted image 20260101.png",
            "near": vault / "experiments" / "attachments" / "dup.png",
            "far": obs / "pics" / "dup.png",
            "spaced": vault / "experiments" / "figs" / "loss plot.png",
            "shared": obs / "pics" / "shared.jpg",
            "code": obs / "proj" / "code" / "results" / "fig3.png",
            "trash": obs / ".trash" / "binned.png",
            "svg": vault / "experiments" / "figs" / "chart.svg",
        }
        for name, p in cls.files.items():
            p.write_bytes(b"\x89PNG " + name.encode())
        (obs / "secret.txt").write_text("secret")
        os.symlink(obs / "secret.txt", vault / "experiments" / "figs" / "secret.png")
        cls.obs, cls.vault = obs, vault
        handler = rft_server.make_handler(rft_server.Vault(vault, "demo"), WEB, KEY)
        cls.server = rft_server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.tmp.cleanup()

    def image(self, src, key=None, note_id="E01", headers=(), host=None):
        """The status, headers and body of the image note `note_id` embeds as `src`."""
        q = f"/api/image?note={note_id}&src={quote(src, safe="")}" + (f"&token={key}" if key else "")
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.putrequest("GET", q, skip_host=True)
        c.putheader("Host", host or f"127.0.0.1:{self.port}")
        for k, v in headers:
            c.putheader(k, v)
        c.endheaders()
        r = c.getresponse()
        body = r.read()
        c.close()
        return r.status, dict(r.getheaders()), body

    def assertServes(self, src, name, key=None):
        status, h, body = self.image(src, key)
        self.assertEqual(status, 200, src)
        self.assertEqual(body, b"\x89PNG " + name.encode(), src)
        return h

    def test_in_the_vault_without_the_key(self):
        # by name, as Obsidian pastes it (attachments/ beside the note), and by a path from the note
        h = self.assertServes("Pasted image 20260101.png", "pasted")
        self.assertEqual(h["Content-Type"], "image/png")
        self.assertServes("figs/loss plot.png", "spaced")
        self.assertServes("./attachments/dup.png", "near")
        self.assertServes("experiments/figs/loss plot.png", "spaced")  # from the vault's top
        self.assertServes("PASTED IMAGE 20260101.PNG", "pasted")  # names match in any case

    def test_the_nearest_of_two_names(self):
        self.assertServes("dup.png", "near")
        self.assertServes("pics/dup.png", "far", KEY)  # a path picks the other one

    def test_outside_the_vault_only_with_the_key(self):
        code = str(self.files["code"])
        for src, name in [("shared.jpg", "shared"), ("results/fig3.png", "code"), (code, "code"),
                          ("file://" + code, "code"), ("../../code/results/fig3.png", "code"), ("/pics/shared.jpg", "shared")]:
            self.assertEqual(self.image(src)[0], 403, src)
            self.assertEqual(self.image(src, "wrong-key")[0], 403, src)
            self.assertServes(src, name, KEY)
        self.assertEqual(self.image("shared.jpg", KEY)[1]["Content-Type"], "image/jpeg")

    def test_nothing_to_probe_without_the_key(self):
        # a missing image and one outside the vault get the same answer without the key
        self.assertEqual(self.image("nowhere.png")[0], 403)
        self.assertEqual(self.image("/no/such/dir/x.png")[0], 403)
        self.assertEqual(self.image("nowhere.png", KEY)[0], 404)

    def test_images_only(self):
        for src in [str(self.obs / "secret.txt"), "figs/secret.png", "../../../secret.txt", "E01 Run.md",
                    "../directions/D00 Root.md", "", "figs/", "figs/loss plot.png\x00.png"]:
            self.assertEqual(self.image(src, KEY)[0], 404, repr(src))
        self.assertEqual(self.image("binned.png", KEY)[0], 404)  # dot folders are not searched by name
        for nid in ["E99", "X01", "../E01", ""]:
            self.assertEqual(self.image("dup.png", KEY, note_id=nid)[0], 404, nid)

    def test_an_svg_runs_nothing(self):
        h = self.assertServes("chart.svg", "svg")
        self.assertEqual(h["Content-Type"], "image/svg+xml")
        self.assertIn("sandbox", h["Content-Security-Policy"])
        self.assertIn("default-src 'none'", h["Content-Security-Policy"])
        self.assertEqual(h["X-Content-Type-Options"], "nosniff")

    def test_sent_again_only_once_changed(self):
        h = self.assertServes("dup.png", "near")
        status, again, body = self.image("dup.png", headers=[("If-None-Match", h["ETag"])])
        self.assertEqual((status, body), (304, b""))
        self.assertEqual(again["ETag"], h["ETag"])

    def test_an_image_just_added_is_found(self):
        self.assertServes("dup.png", "near")  # the vault's names are now known
        p = self.vault / "experiments" / "attachments" / "new.png"
        p.write_bytes(b"\x89PNG new")
        self.addCleanup(p.unlink)
        self.assertServes("new.png", "new")

    def test_loopback_hosts_only(self):
        self.assertEqual(self.image("dup.png", KEY, host="evil.example")[0], 403)

    def test_no_obsidian_vault_around(self):
        # the vault is all there is to search by name
        self.assertEqual(rft_server.Vault(self.vault, "demo").image_tops, [self.vault.resolve(), self.obs.resolve()])
        with tempfile.TemporaryDirectory() as t:
            self.assertEqual(rft_server.Vault(Path(t), "demo").image_tops, [Path(t).resolve()])


class ArtifactTest(unittest.TestCase):
    """Concept artifacts: listed in the tree with their state, each served in a sandbox of its own,
    read-only, its images as a note's are found."""

    RESULT = "CutMix closes the gap at 1k (0.3 ± 0.5 points); Mixup does not."

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        vault = root / "vault"
        for d in ("directions", "experiments", "artifacts"):
            (vault / d).mkdir(parents=True)
        (vault / "directions" / "D00 Root question.md").write_text(note("D00", "direction", "done", "", "Root question"))
        (vault / "directions" / "D04 Mixup.md").write_text(note("D04", "direction", "done", "D00 Root question", "Mixup", concept="Mix-based augmentation"))
        # the same note as the key's vector in tests/artifacts.test.ts
        (vault / "experiments" / "E05 Mixup and CutMix at 1k images.md").write_text(
            '---\nid: E05\ntype: experiment\nstatus: done\ndate: 2026-03-20\nsummary: "CutMix closes the gap at 1k, Mixup does not"\n'
            'parent: "[[D04 Mixup]]"\nsuperseded_by: "[[E06 Cosine]]"\ntags: [demo, experiment, done]\n---\n\n'
            f"# E05 · Mixup and CutMix at 1k images\n\n## What\nMixup and CutMix.\n\n## Result\n\n{cls.RESULT}\n\n## Directions found\n")
        (vault / "experiments" / "E06 Cosine.md").write_text(note("E06", "experiment", "done", "D04 Mixup", "Cosine").replace("Text of E06.", "## Result\n+1 point."))
        (vault / "experiments" / "E07 Third.md").write_text(note("E07", "experiment", "running", "D04 Mixup", "Third").replace("Text of E07.", "## Result\nPartial: +0.5."))
        (vault / "experiments" / "E08 Planned.md").write_text(note("E08", "experiment", "planned", "D04 Mixup", "Planned").replace("Text of E08.", "## Result\n"))
        # planned: no result, whatever its Result holds
        (vault / "experiments" / "E09 Later.md").write_text(note("E09", "experiment", "planned", "D04 Mixup", "Later").replace("Text of E09.", "## Result\nNot run yet."))
        head = {"concept": "D04", "name": "Mix-based augmentation", "updated": "2026-03-01",
                "basis": {"E05": "33efe36b", "E06": "00000000", "E03": "12345678"}}
        cls.page = '<h1>Mix</h1>\n<p><a href="#E05">E05</a> <img src="fig.png"> <img src="data:image/png;base64,AA=="> <img src="https://x.org/a.png"> <img src="/abs/out.png"></p>\n'
        # SVG figures: kept in vault/figures/, named bare or by a path from the artifacts' folder, or outside the vault
        cls.svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="10pt" height="10pt"><rect width="10" height="10"/></svg>'
        (vault / "figures").mkdir()
        (vault / "figures" / "chart.svg").write_bytes(cls.svg)
        (root / "out.svg").write_bytes(cls.svg)
        cls.page += f'<figure><img src="chart.svg" alt="a"><img src="../figures/chart.svg" alt="b"><img src="{root / "out.svg"}" alt="c"></figure>\n'
        cls.file = vault / "artifacts" / "D04 Mix-based augmentation.html"
        cls.file.write_text(f"<!-- rft-artifact {json.dumps(head)} -->\n{cls.page}")
        (vault / "artifacts" / "fig.png").write_bytes(b"\x89PNG fig")
        (root / "out.png").write_bytes(b"\x89PNG out")
        # an artifact that is a link out of the vault, and an html file with no header
        (root / "outside.html").write_text('<!-- rft-artifact {"concept":"D00","name":"x","updated":"","basis":{}} -->\n<p>secret</p>')
        os.symlink(root / "outside.html", vault / "artifacts" / "00 Linked out.html")
        (vault / "artifacts" / "by hand.html").write_text("<p>by hand</p>")
        cls.vault, cls.root = vault, root
        handler = rft_server.make_handler(rft_server.Vault(vault, "demo"), WEB, KEY)
        cls.server = rft_server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.tmp.cleanup()

    get = ServerTest.get

    def tree(self):
        return json.loads(self.get("/api/tree")[2])

    def test_the_tree_lists_the_artifacts_with_what_changed_since(self):
        t = self.tree()
        [a] = t["artifacts"]
        self.assertEqual({k: v for k, v in a.items() if k != "version"}, {
            "concept": "D04", "name": "Mix-based augmentation", "path": "artifacts/D04 Mix-based augmentation.html",
            "updated": "2026-03-01", "stale": True, "changed": ["E06"], "added": ["E07"], "removed": ["E03"]})
        self.assertRegex(a["version"], r"^[0-9a-f]{16}$")
        nodes = {n["id"]: n for n in t["nodes"]}
        self.assertTrue(nodes["E05"]["hasResult"])
        self.assertTrue(nodes["E07"]["hasResult"])
        self.assertNotIn("hasResult", nodes["E08"])
        self.assertNotIn("hasResult", nodes["E09"])
        self.assertFalse(rft_server.has_result("planned", "## Result\nNot run yet."))
        self.assertTrue(rft_server.has_result("dropped", "## Result\nBug in the loader."))
        self.assertNotIn("hasResult", nodes["D04"])

    def test_the_key_of_an_experiment_is_the_plugins(self):
        text = (self.vault / "experiments" / "E05 Mixup and CutMix at 1k images.md").read_text()
        self.assertEqual(rft_server.result_of(text), self.RESULT)
        n = {"id": "E05", "status": "done", "title": "Mixup and CutMix at 1k images",
             "summary": "CutMix closes the gap at 1k, Mixup does not", "supersededBy": "E06"}
        self.assertEqual(rft_server.experiment_key(n, text), "33efe36b")
        self.assertEqual(rft_server.result_of("# E09 · X\n\n```\n## Result\nfake\n```\n\n## Result\nreal\n"), "real")

    def test_a_changed_artifact_changes_the_tree_and_its_version(self):
        before = self.tree()
        self.file.write_text(self.file.read_text().replace("<h1>Mix</h1>", "<h1>Mix, again</h1>"))
        self.addCleanup(self.file.write_text, self.file.read_text().replace("<h1>Mix, again</h1>", "<h1>Mix</h1>"))
        after = self.tree()
        self.assertNotEqual(before["version"], after["version"])
        self.assertNotEqual(before["artifacts"][0]["version"], after["artifacts"][0]["version"])

    def test_the_page_is_served_in_a_sandbox_of_its_own(self):
        status, ctype, body = self.get("/api/artifact?concept=D04&theme=dark")
        self.assertEqual(status, 200)
        self.assertEqual(ctype, "text/html; charset=utf-8")
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", "/api/artifact?concept=D04", headers={"Host": f"127.0.0.1:{self.port}"})
        r = c.getresponse()
        csp = r.getheader("Content-Security-Policy")
        r.read()
        c.close()
        here = f"http://127.0.0.1:{self.port}"
        for part in ("default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", f"img-src {here} data:",
                     "font-src data:", "form-action 'none'", "base-uri 'none'", f"frame-ancestors {here}", "sandbox allow-scripts allow-popups"):
            self.assertIn(part, csp)
        self.assertNotIn("allow-same-origin", csp)
        html = body.decode()
        self.assertIn("<h1>Mix</h1>", html)
        self.assertNotIn("rft-artifact", html)  # the header stays in the file
        self.assertIn('document.documentElement.dataset.theme = "dark"', html)
        self.assertIn((WEB / "frame.css").read_text().strip().splitlines()[0], html)
        self.assertIn((WEB / "frame.js").read_text().strip().splitlines()[0], html)
        self.assertIn((WEB / "latex.js").read_text().strip().splitlines()[0], html)
        # the scripts one after the other, a `;` between: the next one's opening ( calls nothing
        self.assertIn((WEB / "latex.js").read_text() + "\n;\n" + (WEB / "frame.js").read_text(), html)
        self.assertLess(html.index("dataset.theme"), html.index("<h1>Mix</h1>"))
        # a theme that is not one of the two is the light one
        self.assertIn('dataset.theme = "light"', self.get("/api/artifact?concept=D04&theme=%22%3E")[2].decode())

    def test_its_images_are_found_as_a_notes_are_and_from_elsewhere_only_with_the_key(self):
        html = self.get("/api/artifact?concept=D04")[2].decode()
        self.assertIn('src="api/image?artifact=D04&amp;src=fig.png"', html)
        self.assertIn('src="data:image/png;base64,AA=="', html)
        self.assertIn('src="https://x.org/a.png"', html)  # left to the policy, which blocks it
        self.assertIn('src="api/image?artifact=D04&amp;src=%2Fabs%2Fout.png"', html)
        # the frame gets the image key, which reads images and writes nothing, never the vault key
        ikey = rft_server.image_key(KEY)
        for given in (KEY, ikey):
            keyed = self.get(f"/api/artifact?concept=D04&token={given}")[2].decode()
            self.assertIn(f'src="api/image?artifact=D04&amp;src=fig.png&amp;token={ikey}"', keyed)
            self.assertNotIn(KEY, keyed)
        self.assertNotIn("token=", self.get("/api/artifact?concept=D04&token=wrong")[2].decode())
        status, ctype, data = self.get("/api/image?artifact=D04&src=fig.png")
        self.assertEqual((status, ctype, data), (200, "image/png", b"\x89PNG fig"))
        out = quote(str(self.root / "out.png"), safe="")
        self.assertEqual(self.get(f"/api/image?artifact=D04&src={out}")[0], 403)
        self.assertEqual(self.get(f"/api/image?artifact=D04&src={out}&token={KEY}")[2], b"\x89PNG out")
        self.assertEqual(self.get(f"/api/image?artifact=D04&src={out}&token={ikey}")[2], b"\x89PNG out")
        self.assertEqual(self.get("/api/image?artifact=D99&src=fig.png")[0], 403)

    def test_an_svg_comes_inside_the_page(self):
        """The frame has no origin of its own, so a browser blocks an SVG the server sends it (ORB):
        an SVG figure comes inside the page as a data: image, its name kept for its PDF."""
        html = self.get("/api/artifact?concept=D04")[2].decode()
        data = "data:image/svg+xml;base64," + base64.b64encode(self.svg).decode()
        self.assertIn(f'src="{data}" data-rft-src="chart.svg"', html)  # found in figures/
        self.assertIn(f'src="{data}" data-rft-src="../figures/chart.svg"', html)
        # one outside the vault: inside the page only with the key, as api/image serves it
        out = str(self.root / "out.svg")
        self.assertIn(f'src="api/image?artifact=D04&amp;src={quote(out, safe="")}"', html)
        self.assertNotIn(f'data-rft-src="{out}"', html)
        for given in (KEY, rft_server.image_key(KEY)):
            self.assertIn(f'src="{data}" data-rft-src="{out}"', self.get(f"/api/artifact?concept=D04&token={given}")[2].decode())
        # a PNG still comes through api/image, which a browser lets through
        self.assertIn('src="api/image?artifact=D04&amp;src=fig.png"', html)
        self.assertEqual(self.get("/api/image?artifact=D04&src=chart.svg")[0], 200)

    def test_only_an_artifact_of_the_vault_by_its_concept(self):
        for q in ("concept=D99", "concept=root", "concept=..%2Fx", "concept=", "", "concept=D00"):
            self.assertEqual(self.get(f"/api/artifact?{q}")[0], 404, q)
        self.assertEqual(self.get("/api/artifact?concept=D04", host="evil.example")[0], 403)
        listed = [a["path"] for a in self.tree()["artifacts"]]
        self.assertNotIn("artifacts/00 Linked out.html", listed)
        self.assertNotIn("artifacts/by hand.html", listed)

    def test_read_only(self):
        before = self.file.read_bytes()
        for m in ("PUT", "POST", "DELETE", "PATCH"):
            status = self.get("/api/artifact?concept=D04", method=m, headers=[("Origin", f"http://127.0.0.1:{self.port}"), ("X-RFT-Token", KEY)], data=b"{}")[0]
            self.assertIn(status, (403, 404, 405), m)
        self.assertEqual(self.file.read_bytes(), before)

    def test_a_name_with_an_arrow_is_read_back(self):
        head = '<!-- rft-artifact {"concept":"D04","name":"Gap -\\u002d\\u003e zero","updated":"2026-03-01","basis":{}} -->\n<p>x</p>\n'
        self.assertEqual(rft_server.artifact_head(head)["name"], "Gap --> zero")
        self.assertIsNone(rft_server.artifact_head("<p>no header</p>"))

    def test_the_page_script_is_served(self):
        self.assertEqual(self.get("/artifacts.js")[0], 200)


class ManuscriptTest(unittest.TestCase):
    """The manuscript as the page sees it: its snippets with their state, a snippet or document read
    and written (a version kept, a conflict refused), the lock, a compile and its PDF (with the key
    only), comments on a snippet, and what the session makes for the page (new, reviewed, document)."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        vault = Path(cls.tmp.name) / "vault"
        for d in ("directions", "experiments", "references", "results", "manuscript/snippets", "manuscript/documents/paper"):
            (vault / d).mkdir(parents=True)
        (vault / "directions" / "D00 Root question.md").write_text(note("D00", "direction", "done", "", "Root question"))
        cls.e05 = vault / "experiments" / "E05 Mixup.md"
        cls.e05.write_text(note("E05", "experiment", "verified", "D00 Root question", "Mixup").replace("Text of E05.", "## Result\nCutMix  closes the gap: 0.3 ± 0.5 points.\n"))
        (vault / "experiments" / "E06 Planned.md").write_text(note("E06", "experiment", "planned", "D00 Root question", "Planned"))
        (vault / "references" / "R01 Mixup paper.md").write_text(note("R01", "reference", "verified", "D00 Root question", "Mixup paper").replace(
            "Text of R01.", "## Source\n```bibtex\n@article{zhang2018mixup,\n  title={mixup},\n  year={2018}\n}\n```\n"))
        (vault / "results" / "E05.json").write_text(json.dumps({"results": {"gap": 0.3, "seeds": 3}}))
        ms = vault / "manuscript"
        (ms / "documents" / "paper" / "main.tex").write_text(
            "\\documentclass{article}\n\\usepackage{amsthm}\n\\usepackage[numbers]{natbib}\n\\usepackage{rft}\n\\begin{document}\n"
            "\\rftsnippet{S01}\n% \\rftsnippet{S09}\n\\rftsnippet{S02}\n\\bibliographystyle{plainnat}\n\\bibliography{refs}\n\\end{document}\n")
        (ms / "snippets" / "S01.tex").write_text("% rft-snippet S01 · result · CutMix\n% basis: E05\n\\paragraph{CutMix}\nThe gap closes by \\rftnum{E05}{gap} \\cite{zhang2018mixup}.\n")
        (ms / "snippets" / "S02.tex").write_text("% rft-snippet S02 · discussion · Next\n% basis: E06\n\\paragraph{Next}\n% your text\n")
        fp = rft_manuscript.substance_fingerprint("experiment", cls.e05.read_text())
        (ms / "manuscript.json").write_text(json.dumps({"locked": True, "next": 3, "snippets": {"S01": {"stamp": {"E05": fp}}}, "unlocked": []}))
        cls.vault = vault
        cls.asked = []

        def ask(verb, request):
            cls.asked.append((verb, request))
            if cls.answer:
                cls.answer(request)

        cls.answer = None
        handler = rft_server.make_handler(rft_server.Vault(vault, "demo"), WEB, KEY, ask)
        cls.server = rft_server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.tmp.cleanup()

    get = ServerTest.get
    write = ServerTest.write

    def ms(self):
        return json.loads(self.get("/api/manuscript")[2])

    def keep(self, path: Path):
        before = path.read_bytes()
        self.addCleanup(path.write_bytes, before)

    def test_the_same_fingerprint_as_the_plugin(self):
        # the values hooks/lib/verify.ts gives (tests/verify.test.ts)
        e = "---\nid: E05\n---\n# E05 · X\n\n## Result\nCutMix  closes the gap: 0.3 ± 0.5 points.\n<!-- rft-results a -->\n| acc | 71.3 |\n\n## Code\nx\n"
        self.assertEqual(rft_manuscript.substance_fingerprint("experiment", e), "58942782")
        t = "---\nid: T01\n---\n## Statement\nA gap $g = a - b$.\n\n## Builds on\nE05.\n\n## Explanation\n“Proof” — by ε.\n"
        self.assertEqual(rft_manuscript.substance_fingerprint("theory", t), "1a85e809")

    def test_the_snippets_with_their_state(self):
        m = self.ms()
        self.assertEqual((m["exists"], m["locked"], m["documents"][0]["name"], m["documents"][0]["order"]), (True, True, "paper", ["S01", "S02"]))
        s1, s2 = m["snippets"]
        self.assertEqual((s1["kind"], s1["title"], s1["basis"], s1["review"], s1["stub"], s1["locked"]), ("result", "CutMix", ["E05", "R01"], [], False, True))
        self.assertEqual((s2["stub"], s2["unverified"]), (True, ["E06"]))
        # E05's Result changes: S01 in review
        self.keep(self.e05)
        self.e05.write_text(self.e05.read_text().replace("0.3 ± 0.5", "0.4 ± 0.5"))
        self.assertEqual(self.ms()["snippets"][0]["review"], ["E05 changed"])

    def test_a_file_read_and_written_and_a_conflict_refused(self):
        path = self.vault / "manuscript" / "snippets" / "S02.tex"
        self.keep(path)
        f = json.loads(self.get("/api/manuscript/file?path=snippets/S02.tex")[2])
        self.assertTrue(f["locked"])
        text = f["text"].replace("% your text", "Mine.")
        status, got = self.write("PUT", "/api/manuscript/file", {"path": "snippets/S02.tex", "text": text, "version": f["version"]})
        self.assertEqual((status, got["text"]), (200, text))
        self.assertEqual(path.read_text(), text)
        status, got = self.write("PUT", "/api/manuscript/file", {"path": "snippets/S02.tex", "text": "x", "version": f["version"]})
        self.assertEqual((status, got["text"]), (409, text))
        for bad in ("snippets/S09.tex", "../secret.tex", "documents/../x/main.tex", "rft.sty", "manuscript.json"):
            self.assertEqual(self.get(f"/api/manuscript/file?path={quote(bad)}")[0], 404, bad)
            self.assertEqual(self.write("PUT", "/api/manuscript/file", {"path": bad, "text": "x", "force": True})[0], 404, bad)
        self.assertEqual(self.write("PUT", "/api/manuscript/file", {"path": "snippets/S02.tex", "text": "x", "force": True}, key=None)[0], 403)

    def test_the_lock(self):
        reg = self.vault / "manuscript" / "manuscript.json"
        self.keep(reg)
        status, m = self.write("POST", "/api/manuscript/lock", {"locked": False, "id": "S01"})
        self.assertEqual((status, m["unlocked"], m["snippets"][0]["locked"]), (200, ["S01"], False))
        status, m = self.write("POST", "/api/manuscript/lock", {"locked": False})
        self.assertEqual((m["locked"], m["snippets"][1]["locked"]), (False, False))
        self.assertEqual(self.write("POST", "/api/manuscript/lock", {"locked": True, "id": "S42"})[0], 404)
        self.assertEqual(self.write("POST", "/api/manuscript/lock", {"locked": "no"})[0], 400)

    def test_comments_on_a_snippet(self):
        self.addCleanup(lambda: (self.vault / ".comments" / "S01.json").unlink(missing_ok=True))
        n = json.loads(self.get("/api/note?id=S01")[2])
        self.assertEqual((n["name"], n["locked"]), ("S01 CutMix", True))
        status, got = self.write("POST", "/api/comment", {"id": "S01", "action": "new", "kind": "comment", "quote": "closes", "prefix": "The gap ", "suffix": " by", "text": "By how much?"})
        self.assertEqual((status, got["threads"][0]["quote"]), (200, "closes"))
        self.assertEqual(self.ms()["snippets"][0]["threads"], 1)
        # the lock of a note is not the manuscript's
        self.assertEqual(self.write("POST", "/api/lock", {"id": "S01", "locked": False})[0], 404)

    def test_what_the_session_makes_for_the_page(self):
        def answer(request):
            if request["action"] == "new":
                p = self.vault / "manuscript" / "snippets" / "S03.tex"
                p.write_text("% rft-snippet S03 · result · Mine\n% basis: E05\n")
                self.addCleanup(p.unlink)

        type(self).answer = answer
        self.addCleanup(setattr, type(self), "answer", None)
        status, got = self.write("POST", "/api/manuscript/ask", {"action": "new", "kind": "result", "title": "Mine", "basis": ["E05"], "document": "paper"})
        self.assertEqual((status, got["id"]), (200, "S03"))
        self.assertEqual(self.asked[-1], ("RFT_MANUSCRIPT", {"action": "new", "kind": "result", "title": "Mine", "basis": ["E05"], "document": "paper"}))
        for bad in ({"action": "new", "kind": "result"}, {"action": "drop"}, {"action": "document", "name": "My Paper"}):
            self.assertEqual(self.write("POST", "/api/manuscript/ask", bad)[0], 400, bad)
        self.assertEqual(self.write("POST", "/api/manuscript/ask", {"action": "reviewed", "id": "S42"})[0], 404)
        self.assertEqual(self.write("POST", "/api/manuscript/ask", {"action": "document", "name": "paper"})[0], 409)

    @unittest.skipUnless(shutil.which("latexmk") and shutil.which("pdftotext"), "latexmk or pdftotext is not on PATH")
    def test_a_compile_and_its_pdf_with_the_key_only(self):
        self.addCleanup(shutil.rmtree, self.vault / "manuscript" / ".build", True)
        status, r = self.write("POST", "/api/manuscript/compile", {"doc": "paper"})
        self.assertEqual(status, 200)
        self.assertTrue(r["ok"], r)
        self.assertNotIn("pdf", r)  # no path on disk to the page
        self.assertEqual(self.get("/api/manuscript/pdf?doc=paper")[0], 403)
        status, ctype, body = self.get("/api/manuscript/pdf?doc=paper", headers=[("X-RFT-Token", KEY)])
        self.assertEqual((status, ctype, body[:4]), (200, "application/pdf", b"%PDF"))
        self.assertIn("built", self.ms()["documents"][0])
        self.assertEqual(self.write("POST", "/api/manuscript/compile", {"doc": "../x"})[0], 404)
        self.assertEqual(self.write("POST", "/api/manuscript/compile", {"doc": "paper"}, key=None)[0], 403)


class SharedPortTest(unittest.TestCase):
    """Two sessions with the same fixed port: the second shares the first's server, then takes it over."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.procs = []
        self.vaults = {}
        for project in ("one", "two"):
            vault = Path(self.tmp.name) / project / "vault"
            (vault / "directions").mkdir(parents=True)
            (vault / "directions" / "D00 Root.md").write_text(note("D00", "direction", "idea", "", "Root"))
            self.vaults[project] = vault

    def tearDown(self):
        for p in self.procs:
            p.kill()
            p.wait()
            p.stdout.close()
            p.stderr.close()
        self.tmp.cleanup()

    def start(self, project, port):
        """Starts a server for `project`'s vault on `port`, its keys in a cache of the test's own;
        returns it, and the port and key of the address it prints."""
        p = subprocess.Popen(
            [sys.executable, str(SERVER), "--vault", str(self.vaults[project]), "--web", str(WEB),
             "--port", str(port), "--project", project, "--no-watch"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            env={**os.environ, "XDG_CACHE_HOME": str(Path(self.tmp.name) / "cache")})
        self.procs.append(p)
        lines = queue.Queue()
        threading.Thread(target=lambda: lines.put(p.stdout.readline()), daemon=True).start()
        m = re.fullmatch(r"RFT_SERVER_URL http://127\.0\.0\.1:(\d+)/\?token=([\w-]{16})", lines.get(timeout=10).strip())
        self.assertIsNotNone(m)
        return p, int(m.group(1)), m.group(2)

    def test_the_same_vault_shares_the_port_and_takes_it_over(self):
        port = free_port()
        first, at, key = self.start("one", port)
        self.assertEqual(at, port)
        second, at, same = self.start("one", port)
        # the shared address is the first server's, key included
        self.assertEqual((at, same), (port, key))
        self.assertIsNone(second.poll())
        first.kill()
        first.wait()
        deadline = time.time() + 10
        status, tree = fetch(port, "/api/tree")
        while status != 200 and time.time() < deadline:
            time.sleep(0.2)
            status, tree = fetch(port, "/api/tree")
        self.assertEqual(status, 200)
        self.assertEqual(tree["project"], "one")

    def test_another_vault_on_the_port_gets_a_free_one(self):
        port = free_port()
        self.start("one", port)
        _, at, _ = self.start("two", port)
        self.assertNotEqual(at, port)
        self.assertEqual(fetch(at, "/api/tree")[1]["project"], "two")
        self.assertEqual(fetch(port, "/api/tree")[1]["project"], "one")

    def test_the_vault_id_is_a_hash_of_its_folder(self):
        port = free_port()
        self.start("one", port)
        status, body = fetch(port, "/api/id")
        self.assertEqual(status, 200)
        self.assertEqual(body, {"vault": rft_server.Vault(self.vaults["one"], "one").ident})
        self.assertRegex(body["vault"], r"^[0-9a-f]{16}$")


if __name__ == "__main__":
    unittest.main()
