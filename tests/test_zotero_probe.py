"""Tests of the live probe of zotero.org (tests/zotero_probe.py) as a program: that it runs from its
first call to its last, says so when an answer differs, deletes what it made and nothing else, and
records nothing of the user's.

The stand-in below is NOT zotero.org and is no referee of it: it answers as this repository's
design expects zotero.org to, which is exactly what the probe exists to check against the real one.
These tests only show that the probe itself works, before it is run with a key.

    python3 -m unittest tests.test_zotero_probe
"""
import io
import json
import os
import re
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import procs  # noqa: E402
import zotero_probe  # noqa: E402

KEY, USER, NAME, SHOWN = "SECRETKEY0123456789", "4242", "ada", "Ada L"
THEIRS = "USERITEM"  # an item of the user's own, there before the probe and after it


class Library:
    """A library as the design expects zotero.org to keep one. `quirk` makes one answer differ."""

    def __init__(self, write: bool = True, quirk: str = ""):
        self.write, self.quirk = write, quirk
        self.version = 100
        self.items = {THEIRS: {"key": THEIRS, "version": 90, "data": {"itemType": "book", "title": "A book of the user's", "collections": ["USERCOLL"]}}}
        self.collections = {"USERCOLL": {"key": "USERCOLL", "version": 80, "data": {"name": "Thesis", "parentCollection": False}}}
        self.gone = {"items": [], "collections": []}  # (version, key)
        self.asked: list[tuple[str, str]] = []
        self.made = 0

    def new_key(self) -> str:
        self.made += 1
        return f"PROBE{self.made:03d}"

    def shown(self, kind: str, obj: dict) -> dict:
        return {**obj, "library": {"type": "user", "id": int(USER), "name": SHOWN},
                "links": {"self": {"href": f"https://api.zotero.org/users/{USER}/{kind}/{obj['key']}"}, "alternate": {"href": f"https://www.zotero.org/{NAME}/items/{obj['key']}", "type": "text/html"}}}


def handler(lib: Library):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def answer(self, status: int, body=None, headers: dict | None = None, text: str | None = None):
            data = (text if text is not None else "" if body is None else json.dumps(body)).encode()
            self.send_response(status)
            self.send_header("Last-Modified-Version", str(lib.version))
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def handle_one(self, method: str):
            u = urlsplit(self.path)
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            lib.asked.append((method, self.path))
            if u.path == f"/doi/{zotero_probe.A_DOI}":
                return self.answer(200, {"title": "Deep learning", "type": "article-journal", "author": [{"family": "LeCun"}, {"family": "Bengio"}, {"family": "Hinton"}]})
            if self.headers.get("Zotero-API-Key") != KEY:
                return self.answer(403, text="Forbidden")
            if u.path == "/keys/current":
                return self.answer(200, {"userID": int(USER), "username": NAME, "displayName": SHOWN, "access": {"user": {"library": True, "write": lib.write, "notes": True, "files": True}}})
            m = re.fullmatch(rf"/users/{USER}/(items|collections)(?:/([A-Z0-9]+))?(?:/(top|collections|items/top))?", u.path)
            if u.path == f"/users/{USER}/deleted":
                since = int(q["since"])
                return self.answer(200, {**{k: [key for v, key in rows if v > since] for k, rows in lib.gone.items()}, "searches": [], "tags": [], "settings": []})
            if not m:
                return self.answer(404, text="Not found")
            kind, key, rest = m.groups()
            store = getattr(lib, kind)
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length)) if length else None
            if method == "POST" and not key:
                if not isinstance(body, list):
                    return self.answer(400, text="expected a list")
                made = {}
                lib.version += 1
                for n, fields in enumerate(body):
                    k = lib.new_key()
                    store[k] = {"key": k, "version": lib.version, "data": {"collections": [], **fields} if kind == "items" else dict(fields)}
                    made[str(n)] = lib.shown(kind, store[k])
                return self.answer(200, {"successful": made, "success": {n: o["key"] for n, o in made.items()}, "unchanged": {}, "failed": {}})
            if method == "GET" and kind == "items" and not key and rest == "top":
                if q.get("format") == "versions" and self.headers.get("If-Modified-Since-Version") == str(lib.version):
                    return self.answer(304)
                keys = sorted(lib.items)
                return self.answer(200, text="\n".join(keys[:int(q.get("limit", 100))]) + "\n", headers={"Total-Results": str(len(keys)), "Link": f'<https://api.zotero.org/users/{USER}/items/top?start=1>; rel="next"'})
            if method == "GET" and kind == "items" and not key:
                since = int(q["since"])
                return self.answer(200, {k: o["version"] for k, o in lib.items.items() if o["version"] > since and (q.get("includeTrashed") == "1" or not o["data"].get("deleted"))})
            if key not in store:
                return self.answer(404, text="Not found")
            obj = store[key]
            if method == "GET" and kind == "collections" and rest == "collections":
                return self.answer(200, [lib.shown(kind, c) for c in lib.collections.values() if c["data"].get("parentCollection") == key])
            if method == "GET" and kind == "collections" and rest == "items/top":
                return self.answer(200, text="".join(f"{k}\n" for k, o in sorted(lib.items.items()) if key in o["data"]["collections"] and not o["data"].get("deleted")))
            if method == "GET":
                return self.answer(200, lib.shown(kind, obj))
            if self.headers.get("If-Unmodified-Since-Version") != str(obj["version"]):
                return self.answer(412, text="Precondition failed")
            if method == "PATCH":
                if lib.quirk == "refuse a change":
                    return self.answer(500, text="Internal error")
                silent = lib.quirk == "a change of collection is not a change" and set(body) == {"collections"}
                lib.version += 1
                obj["data"].update(body)
                if not silent:
                    obj["version"] = lib.version
                return self.answer(204)
            if method == "DELETE":
                lib.version += 1
                del store[key]
                lib.gone[kind].append((lib.version, key))
                if kind == "collections":
                    for item in lib.items.values():
                        item["data"]["collections"] = [c for c in item["data"]["collections"] if c != key]
                return self.answer(204)
            return self.answer(405, text="Not allowed")

        def do_GET(self):
            self.handle_one("GET")

        def do_POST(self):
            self.handle_one("POST")

        def do_PATCH(self):
            self.handle_one("PATCH")

        def do_DELETE(self):
            self.handle_one("DELETE")

    return Handler


class ZoteroProbeTest(unittest.TestCase):
    def stand_in(self, **kw) -> tuple[Library, str]:
        lib = Library(**kw)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler(lib))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return lib, f"http://127.0.0.1:{server.server_address[1]}"

    def probe(self, base: str, *args, key: str = KEY) -> tuple[int, str]:
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"ZOTERO_API_KEY": key}):
            code = zotero_probe.main(["--api", base, "--doi", f"{base}/doi", *args], out=out, ask=lambda text: out.write(text) and "")
        return code, out.getvalue()

    def untouched(self, lib: Library):
        """The user's own item and collection are as they were, and nothing the probe made is left."""
        self.assertEqual(lib.items, Library().items)
        self.assertEqual(lib.collections, Library().collections)
        self.assertFalse([path for method, path in lib.asked if method != "GET" and ("USERITEM" in path or "USERCOLL" in path)])

    def test_every_answer_as_expected_nothing_left_and_nothing_of_the_user_recorded(self):
        lib, base = self.stand_in()
        folder = procs.folder("rft-zotero-probe-")
        code, said = self.probe(base, "--record", str(folder), "--pause")
        self.assertEqual(code, 0, said)
        self.assertNotIn("DIFFERS", said)
        self.assertIn("answers: 0 differ from what the design expects.", said)
        self.assertGreaterEqual(said.count("[as expected]"), 13)
        self.assertIn("Cleaned up: everything the probe made is deleted", said)
        # it stopped before cleaning up, with the two links of the item it made
        self.assertRegex(said, r"zotero://select/library/items/PROBE\d+\n  on zotero.org: https://www.zotero.org/ada/items/PROBE\d+")
        self.untouched(lib)
        self.assertEqual(len(lib.gone["items"]), 2)
        self.assertEqual(len(lib.gone["collections"]), 3)
        # what is recorded: the calls and their answers, with no key, no user id, no name, and nothing of the user's library
        text = (folder / "probe.json").read_text(encoding="utf-8")
        got = json.loads(text)
        for secret in (KEY, USER, NAME, SHOWN, THEIRS, "USERCOLL", "A book of the user's"):
            self.assertNotIn(secret, text, secret)
        self.assertIn("/users/0/items", text)
        self.assertEqual([r["ok"] for r in got["rows"] if r["ok"] is False], [])
        self.assertTrue(all(c["step"] for c in got["calls"]))
        # the key and the user's names are not printed either
        for secret in (KEY, SHOWN, THEIRS):
            self.assertNotIn(secret, said.replace("https://www.zotero.org/ada/", ""), secret)

    def test_it_says_so_when_zotero_answers_otherwise_and_still_cleans_up(self):
        # an item added to a collection that is not named as changed: what the sync's reading of Zotero rests on
        lib, base = self.stand_in(quirk="a change of collection is not a change")
        code, said = self.probe(base)
        self.assertEqual(code, 1, said)
        self.assertIn("[DIFFERS]", said)
        self.assertRegex(said, r"\[DIFFERS\] \d+\. an item already in the library is added to a collection")
        self.assertRegex(said, r"answers: [1-9]\d* differ from what the design expects \(")
        self.assertIn("Cleaned up", said)
        self.untouched(lib)

    def test_a_refused_change_is_a_difference_and_what_was_made_is_deleted_all_the_same(self):
        lib, base = self.stand_in(quirk="refuse a change")
        code, said = self.probe(base)
        self.assertEqual(code, 1, said)
        self.assertIn("[DIFFERS]", said)
        self.assertIn("Cleaned up", said)
        self.untouched(lib)

    def test_without_a_key_or_with_one_that_cannot_write_nothing_is_asked_or_made(self):
        lib, base = self.stand_in()
        code, said = self.probe(base, key="")
        self.assertEqual((code, lib.asked), (2, []))
        self.assertIn("ZOTERO_API_KEY is not set", said)
        self.assertIn("never paste it in a chat", said)
        lib, base = self.stand_in(write=False)
        code, said = self.probe(base)
        self.assertEqual((code, [m for m, _ in lib.asked]), (2, ["GET"]))
        self.assertIn("it needs read and write on the personal library", said)
        self.untouched(lib)
        lib, base = self.stand_in()
        code, said = self.probe(base, key="another key")
        self.assertEqual(code, 2, said)
        self.untouched(lib)

    def test_the_doi_can_be_left_out(self):
        lib, base = self.stand_in()
        code, said = self.probe(base, "--no-doi")
        self.assertEqual(code, 0, said)
        self.assertFalse([p for _, p in lib.asked if p.startswith("/doi/")])
        self.assertNotIn("doi.org describes", said)


if __name__ == "__main__":
    unittest.main()
