"""A document as a folder of files (.scratch/local-overleaf, step 2), on the server's side: the
file list (a file or a folder made, renamed, deleted, with what is tracked of it following),
uploads (the bytes as they came, never outside the document's folder), the main file (the one with
\\begin{document}, asked for when several have it), and the engine (pdfLaTeX, XeLaTeX or LuaLaTeX;
bibtex or biber; a bibliography per chapter). The vault is the clean-source fixture's
(tests/fixtures/local-overleaf); the kits are the ones tests/fetch_kits.py fetched.
"""
import hashlib
import io
import json
import os
import shutil
import struct
import sys
import tempfile
import threading
import unittest
import zipfile
import zlib
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import fetch_kits  # noqa: E402
import rft_documents  # noqa: E402
import rft_latex  # noqa: E402
import rft_manuscript  # noqa: E402
import rft_server  # noqa: E402
import test_server  # noqa: E402

KEY, WEB = test_server.KEY, test_server.WEB

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "local-overleaf"
LATEXMK = shutil.which("latexmk")


def png(width: int = 2, height: int = 2) -> bytes:
    """A small PNG, valid enough for \\includegraphics."""
    chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)  # noqa: E731
    rows = b"".join(b"\x00" + b"\x59\x4f\xbf" * width for _ in range(height))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def empty_document(vault: Path, name: str, files: dict[str, str], tracking: dict | None = None) -> Path:
    """A document made as the plugin makes one: its folder, and its tracking file."""
    folder = vault / "documents" / name
    for rel, text in files.items():
        (folder / rel).parent.mkdir(parents=True, exist_ok=True)
        (folder / rel).write_text(text, encoding="utf-8")
    t = vault / "documents" / ".rft" / name / "tracking.json"
    t.parent.mkdir(parents=True, exist_ok=True)
    t.write_text(json.dumps({"version": 1, "copies": [], "values": [], "bib": {}, "allowed": [], **(tracking or {})}))
    return folder


def kit_document(vault: Path, name: str, kit: str) -> Path:
    """A kit's files as a document, unmodified."""
    folder = vault / "documents" / name
    shutil.copytree(fetch_kits.kit(kit), folder)
    (vault / "documents" / ".rft" / name).mkdir(parents=True, exist_ok=True)
    (vault / "documents" / ".rft" / name / "tracking.json").write_text("{}")
    return folder


class Documents(unittest.TestCase):
    """Each test on a fresh copy of the fixture's vault, behind a server of its own."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.vault = Path(self.tmp.name) / "vault"
        shutil.copytree(FIXTURE / "project" / "vault", self.vault)
        self.doc = self.vault / "documents" / "paper"
        self.asked = []
        self.answer = None  # what the session does when asked, when a test plays it
        handler = rft_server.make_handler(rft_server.Vault(self.vault, "demo"), WEB, KEY, lambda verb, request: (self.asked.append((verb, request)), self.answer and self.answer(request)))
        self.server = rft_server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    get = test_server.ServerTest.get
    write = test_server.ServerTest.write

    def ms(self, name: str = "paper") -> dict:
        return next(d for d in json.loads(self.get("/api/manuscript")[2])["documents"] if d["name"] == name)

    def files(self, action: str, path: str, name: str = "paper", **more):
        return self.write("POST", "/api/manuscript/files", {"doc": name, "action": action, "path": path, **more})

    def upload(self, path: str, data: bytes, name: str = "paper", replace: bool = False, **kw):
        return self.write("PUT", f"/api/manuscript/upload?doc={name}&path={quote(path)}{'&replace=1' if replace else ''}", data, ctype="application/octet-stream", **kw)

    def tracking(self, name: str = "paper") -> dict:
        return json.loads((self.vault / "documents" / ".rft" / name / "tracking.json").read_text())

    def states(self, name: str = "paper") -> dict:
        return {c["name"]: c["state"] for c in self.ms(name)["copies"]}

    # ------------------------------------------------------------ the file list (ticket 13)

    def test_a_folder_and_a_file_are_made_from_the_page_and_a_copy_placed_there_is_listed(self):
        self.assertEqual(self.files("new-folder", "chapters")[0], 201)
        status, got = self.files("new-file", "chapters/intro.tex")
        self.assertEqual((status, got["path"]), (201, "chapters/intro.tex"))
        self.assertTrue((self.doc / "chapters").is_dir())
        self.assertEqual((self.doc / "chapters" / "intro.tex").read_bytes(), b"")
        d = next(x for x in got["documents"] if x["name"] == "paper")
        self.assertIn({"path": "chapters", "kind": "folder"}, d["tree"])
        self.assertIn({"path": "chapters/intro.tex", "kind": "file", "size": 0, "edit": True, "show": None}, d["tree"])
        self.assertIn("chapters/intro.tex", d["files"])
        # a copy placed there (as the session writes one: its marker lines, and its entry in the tracking file)
        t = self.tracking()
        (self.doc / "chapters" / "intro.tex").write_text("%%% Definition: CutMix %%%\n" + t["copies"][1]["placed"] + "\n%%% end %%%\n")
        t["copies"].append({**t["copies"][1], "file": "chapters/intro.tex"})
        (self.vault / "documents" / ".rft" / "paper" / "tracking.json").write_text(json.dumps(t))
        copies = [c for c in self.ms()["copies"] if c["file"] == "chapters/intro.tex"]
        self.assertEqual([(c["id"], c["state"], c["line"]) for c in copies], [("S01", "placed", 1)])
        # nothing is made twice, and a file made here is one the editor opens
        self.assertEqual(self.files("new-file", "chapters/intro.tex")[0], 409)
        self.assertEqual(self.files("new-folder", "chapters")[0], 409)
        self.assertEqual(self.files("new-file", "figures/x.png")[0], 400)

    def test_renaming_a_file_keeps_its_copies_and_their_states(self):
        before = self.ms()
        mine = [c["name"] for c in before["copies"] if c["file"] == "sections/method.tex" and c["state"] != "lost"]
        self.assertEqual(len(mine), 4)
        values = {v["index"]: v["state"] for v in before["values"]}
        status, got = self.files("move", "sections/method.tex", to="sections/approach.tex")
        self.assertEqual((status, got["path"], got["from"]), (200, "sections/approach.tex", "sections/method.tex"))
        after = self.ms()
        self.assertFalse((self.doc / "sections" / "method.tex").exists())
        self.assertEqual({c["name"]: c["state"] for c in after["copies"]}, {c["name"]: c["state"] for c in before["copies"]})
        self.assertEqual([c["name"] for c in after["copies"] if c["file"] == "sections/approach.tex"], mine)
        self.assertEqual({v["index"]: v["state"] for v in after["values"]}, values)
        self.assertEqual({v["file"] for v in after["values"]}, {"main.tex", "sections/approach.tex"})
        self.assertNotIn("sections/method.tex", json.dumps(self.tracking()))
        # the main file still takes in the old name: the renamed file reads as not in the document, until the user changes that line
        self.assertEqual(after["notIncluded"], ["sections/approach.tex"])
        # a folder renamed carries what is in it; nothing is overwritten; a file cannot go inside itself
        self.assertEqual(self.files("move", "sections", to="parts")[0], 200)
        self.assertEqual([c["name"] for c in self.ms()["copies"] if c["file"] == "parts/approach.tex"], mine)
        self.assertEqual(self.files("move", "parts/approach.tex", to="main.tex")[0], 409)
        self.assertEqual(self.files("move", "parts", to="parts/inner")[0], 400)
        self.assertEqual(self.files("move", "nothing.tex", to="x.tex")[0], 404)
        # the main file renamed stays the main file
        self.assertEqual(self.files("move", "main.tex", to="paper.tex")[0], 200)
        self.assertEqual(self.ms()["main"], "paper.tex")

    def test_deleting_a_file_with_copies_asks_then_shows_them_as_lost(self):
        status, got = self.files("delete", "sections/method.tex")
        self.assertEqual((status, got["ask"], got["copies"]), (409, True, ["S01#2", "S04", "S03", "S07"]))
        self.assertTrue((self.doc / "sections" / "method.tex").is_file())
        status, got = self.files("delete", "sections/method.tex", sure=True)
        self.assertEqual((status, got["lost"]), (200, ["S01#2", "S04", "S03", "S07"]))
        self.assertFalse((self.doc / "sections" / "method.tex").exists())
        st = self.states()
        self.assertEqual([st[n] for n in ("S01#2", "S04", "S03", "S07")], ["lost"] * 4)
        self.assertEqual(st["S01#1"], "placed")
        # a file with no copy goes without a question; the main file asks; a folder goes with what it holds
        self.assertEqual(self.files("delete", "refs.bib")[0], 200)
        status, got = self.files("delete", "main.tex")
        self.assertEqual((status, got["main"]), (409, True))
        self.assertEqual(self.files("delete", "figures")[0], 200)
        self.assertFalse((self.doc / "figures").exists())
        self.assertEqual(self.files("delete", "figures")[0], 404)

    def test_a_class_and_a_style_file_open_in_the_editor_and_save(self):
        for name in ("paper.cls", "plain2.bst"):
            self.assertEqual(self.files("new-file", name)[0], 201)
            rel = f"documents/paper/{name}"
            f = json.loads(self.get(f"/api/manuscript/file?path={quote(rel)}")[2])
            self.assertEqual(f["text"], "")
            status, got = self.write("PUT", "/api/manuscript/file", {"path": rel, "text": "% mine\n", "version": f["version"]})
            self.assertEqual((status, got["text"]), (200, "% mine\n"))
            self.assertEqual((self.doc / name).read_text(), "% mine\n")
        # what the editor does not open is not served as text
        (self.doc / "data.bin").write_bytes(b"\x00\x01")
        self.assertEqual(self.get("/api/manuscript/file?path=documents/paper/data.bin")[0], 404)
        self.assertEqual(self.get("/api/manuscript/file?path=documents/paper/figures/loss.pdf")[0], 404)

    def test_a_path_never_leaves_the_documents_folder(self):
        outside = Path(self.tmp.name) / "outside"
        outside.mkdir()
        os.symlink(outside, self.doc / "linked")
        for bad in ("../x.tex", "/etc/x.tex", "a/../../x.tex", ".hidden.tex", "a/.git/config.tex", "linked/x.tex", "a\\b.tex", "", " "):
            for action in ("new-file", "new-folder"):
                self.assertIn(self.files(action, bad)[0], (400,), (action, bad))
            self.assertEqual(self.files("move", "refs.bib", to=bad)[0], 400, bad)
            self.assertIn(self.upload(bad, b"x")[0], (400,), bad)
        self.assertEqual(list(outside.iterdir()), [])
        self.assertFalse((self.vault / "documents" / "x.tex").exists())
        self.assertEqual(self.files("new-file", "x.tex", name="nope")[0], 404)
        self.assertEqual(self.files("new-file", "x.tex", name="../paper")[0], 404)
        self.assertEqual(self.write("POST", "/api/manuscript/files", {"doc": "paper", "action": "new-file", "path": "x.tex"}, key=None)[0], 403)
        self.assertFalse((self.doc / "x.tex").exists())

    def test_a_name_that_carries_a_trace_is_refused_with_the_reason(self):
        status, got = self.files("new-file", "E05_notes.tex")
        self.assertEqual(status, 422)
        self.assertIn("the id E05", got["error"])
        self.assertIn("shared as they are", got["error"])
        self.assertEqual(self.files("move", "refs.bib", to="S01.bib")[0], 422)
        self.assertEqual(self.files("new-folder", "rft-notes")[0], 422)
        # an id that is no note's is a name like any other
        self.assertEqual(self.files("new-file", "E99_notes.tex")[0], 201)

    # ------------------------------------------------------------ uploads (ticket 14)

    def test_an_uploaded_image_has_the_same_bytes_and_compiles(self):
        data = png()
        status, got = self.upload("figures/logo.png", data)
        self.assertEqual((status, got["path"], got["size"]), (201, "figures/logo.png", len(data)))
        self.assertEqual(hashlib.sha256((self.doc / "figures" / "logo.png").read_bytes()).hexdigest(), hashlib.sha256(data).hexdigest())
        entry = next(x for x in self.ms()["tree"] if x["path"] == "figures/logo.png")
        self.assertEqual((entry["show"], entry["edit"]), ("image", False))
        # shown to the page carrying the key, not opened as text
        self.assertEqual(self.get("/api/manuscript/raw?doc=paper&path=figures/logo.png")[0], 403)
        status, ctype, body = self.get("/api/manuscript/raw?doc=paper&path=figures/logo.png", headers=[("X-RFT-Token", KEY)])
        self.assertEqual((status, ctype, body), (200, "image/png", data))
        self.assertEqual(self.get("/api/manuscript/raw?doc=paper&path=main.tex", headers=[("X-RFT-Token", KEY)])[0], 404)
        self.assertEqual(self.get("/api/manuscript/file?path=documents/paper/figures/logo.png")[0], 404)
        # a file that is there is replaced only when the user says so
        self.assertEqual(self.upload("figures/logo.png", b"other")[0], 409)
        self.assertEqual((self.doc / "figures" / "logo.png").read_bytes(), data)
        self.assertEqual(self.upload("figures/logo.png", data, replace=True)[0], 201)
        # any text file too, into a folder made on the way
        self.assertEqual(self.upload("notes/todo.txt", "à faire\n".encode())[0], 201)
        self.assertEqual((self.doc / "notes" / "todo.txt").read_bytes(), "à faire\n".encode())
        if not LATEXMK:
            self.skipTest("latexmk is not installed")
        main = (self.doc / "main.tex").read_text()
        (self.doc / "main.tex").write_text(main.replace("\\end{document}", "\\includegraphics[width=1cm]{figures/logo.png}\n\\end{document}"))
        status, r = self.write("POST", "/api/manuscript/compile", {"doc": "paper"})
        self.assertEqual((status, r["ok"], r["errors"]), (200, True, []))

    def test_a_file_over_twenty_megabytes_is_refused_and_nothing_is_written(self):
        status, got = self.upload("figures/big.pdf", b"\x00" * 21_000_000)
        self.assertEqual(status, 413)
        self.assertIn("21.0 MB", got["error"])
        self.assertIn("20.0 MB", got["error"])
        self.assertFalse((self.doc / "figures" / "big.pdf").exists())
        self.assertEqual(rft_documents.upload(self.vault, "paper", "figures/big.pdf", b"\x00" * 20_000_001, set())[0], 413)
        self.assertEqual(sorted(p.name for p in (self.doc / "figures").iterdir()), ["loss.pdf"])

    def test_an_upload_whose_name_carries_a_trace_is_refused(self):
        status, got = self.upload("figures/E05_loss.pdf", b"%PDF-1.4\n")
        self.assertEqual(status, 422)
        self.assertIn("E05", got["error"])
        self.assertFalse((self.doc / "figures" / "E05_loss.pdf").exists())

    def test_an_upload_needs_the_key(self):
        self.assertEqual(self.upload("figures/x.png", png(), key=None)[0], 403)
        self.assertEqual(self.upload("figures/x.png", png(), origin="http://evil.example")[0], 403)
        self.assertFalse((self.doc / "figures" / "x.png").exists())

    # ------------------------------------------------------------ the main file (ticket 15)

    def test_the_main_file_is_the_one_with_begin_document_whatever_its_name(self):
        empty_document(self.vault, "kit", {"example_paper.tex": "\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n", "notes.tex": "% \\begin{document} in a comment\n"})
        d = self.ms("kit")
        self.assertEqual((d["main"], d["mainAsked"], d["path"]), ("example_paper.tex", [], "documents/kit/example_paper.tex"))
        if LATEXMK:
            status, r = self.write("POST", "/api/manuscript/compile", {"doc": "kit"})
            self.assertEqual((status, r["ok"], r["main"]), (200, True, "example_paper.tex"))
            self.assertEqual(self.get("/api/manuscript/pdf?doc=kit", headers=[("X-RFT-Token", KEY)])[2][:5], b"%PDF-")

    def test_the_aau_kit_gets_master_tex(self):
        if fetch_kits.kit("aau-thesis") is None:
            self.skipTest(fetch_kits.missing("aau-thesis"))
        kit_document(self.vault, "thesis", "aau-thesis")
        d = self.ms("thesis")
        # \documentclass is in setup/preamble.tex, \begin{document} in master.tex
        self.assertEqual((d["main"], d["mainAsked"]), ("master.tex", []))
        self.assertIn("\\documentclass", (self.vault / "documents" / "thesis" / "setup" / "preamble.tex").read_text())
        # every file the kit reads through its own \includepaper is in the document
        self.assertEqual(d["notIncluded"], [])

    def test_with_two_candidates_the_page_asks_and_the_choice_is_kept(self):
        body = "\\documentclass{article}\n\\begin{document}\n%s\n\\end{document}\n"
        empty_document(self.vault, "two", {"paper.tex": body % "Paper.", "supplement.tex": body % "Supplement."})
        d = self.ms("two")
        self.assertEqual(d["mainAsked"], ["paper.tex", "supplement.tex"])
        status, r = self.write("POST", "/api/manuscript/compile", {"doc": "two"})
        self.assertEqual(r["ok"], False)
        self.assertIn("choose its main file", r["error"])
        self.assertEqual(self.write("POST", "/api/manuscript/settings", {"doc": "two", "main": "nope.tex"})[0], 404)
        status, got = self.write("POST", "/api/manuscript/settings", {"doc": "two", "main": "supplement.tex"})
        self.assertEqual((status, got["main"]), (200, "supplement.tex"))
        self.assertEqual(self.tracking("two")["main"], "supplement.tex")
        d = self.ms("two")
        self.assertEqual((d["main"], d["mainAsked"], d["notIncluded"]), ("supplement.tex", [], ["paper.tex"]))
        # changed later
        self.assertEqual(self.write("POST", "/api/manuscript/settings", {"doc": "two", "main": "paper.tex"})[0], 200)
        self.assertEqual(self.ms("two")["main"], "paper.tex")
        # a file with no \begin{document} is not a main file; the settings need the key
        (self.vault / "documents" / "two" / "part.tex").write_text("A part.\n")
        self.assertEqual(self.write("POST", "/api/manuscript/settings", {"doc": "two", "main": "part.tex"})[0], 422)
        self.assertEqual(self.write("POST", "/api/manuscript/settings", {"doc": "two", "main": "paper.tex"}, key=None)[0], 403)
        self.assertEqual(self.write("POST", "/api/manuscript/settings", {"doc": "two"})[0], 400)

    def test_a_copy_in_a_file_nothing_takes_in_reads_as_not_in_the_document(self):
        before = self.ms()
        self.assertEqual({c["included"] for c in before["copies"] if c["state"] != "lost"}, {True})
        main = (self.doc / "main.tex").read_text()
        self.assertIn("\\input{sections/method}", main)
        (self.doc / "main.tex").write_text(main.replace("\\input{sections/method}", "% \\input{sections/method}"))
        d = self.ms()
        self.assertEqual(d["notIncluded"], ["sections/method.tex"])
        self.assertEqual({c["name"]: c["included"] for c in d["copies"] if c["file"] == "sections/method.tex" and c["state"] != "lost"},
                         {"S01#2": False, "S04": False, "S03": False, "S07": False})
        used = {s["id"]: {u["file"]: u["count"] for u in s["usedIn"]} for s in json.loads(self.get("/api/manuscript")[2])["snippets"] if s["usedIn"]}
        self.assertEqual(used, {"S01": {"main.tex": 1}, "S02": {"main.tex": 1}, "S05": {"main.tex": 1}})

    # ------------------------------------------------------------ the engine, and the bibliography (ticket 16)

    @unittest.skipUnless(LATEXMK and shutil.which("xelatex") and shutil.which("biber"), "latexmk, xelatex or biber is not installed")
    def test_the_xelatex_fixture_names_the_engine_setting_then_compiles_once_it_is_chosen(self):
        shutil.copytree(FIXTURE / "xelatex-biber", self.vault / "documents" / "note")
        empty_document(self.vault, "note", {})
        self.assertEqual(self.ms("note")["engine"], "pdflatex")
        status, r = self.write("POST", "/api/manuscript/compile", {"doc": "note"})
        self.assertEqual((status, r["ok"]), (200, False))
        self.assertEqual(r["errors"][0]["engine"], "xelatex")
        self.assertIn("Engine", r["errors"][0]["message"])
        self.assertIn("XeLaTeX", r["errors"][0]["message"])
        self.assertEqual(self.write("POST", "/api/manuscript/settings", {"doc": "note", "engine": "latex"})[0], 400)
        status, got = self.write("POST", "/api/manuscript/settings", {"doc": "note", "engine": "xelatex"})
        self.assertEqual((status, got["engine"], self.tracking("note")["engine"]), (200, "xelatex", "xelatex"))
        self.assertEqual(self.ms("note")["engine"], "xelatex")
        status, r = self.write("POST", "/api/manuscript/compile", {"doc": "note"})
        self.assertEqual((r["ok"], r["errors"], r["warnings"], r["engine"]), (True, [], [], "xelatex"))
        self.assertTrue((self.vault / "documents" / ".build" / "note" / "main.bcf").is_file(), "the bibliography went through biber")
        # the compile leaves nothing in the document's folder
        self.assertEqual(sorted(p.name for p in (self.vault / "documents" / "note").iterdir()), ["main.tex", "refs.bib"])

    @unittest.skipUnless(LATEXMK, "latexmk is not installed")
    def test_the_aau_thesis_compiles_through_the_server_with_its_bibliographies_per_chapter(self):
        if fetch_kits.kit("aau-thesis") is None:
            self.skipTest(fetch_kits.missing("aau-thesis"))
        folder = kit_document(self.vault, "thesis", "aau-thesis")
        before = sorted(p.relative_to(folder).as_posix() for p in folder.rglob("*"))
        status, r = self.write("POST", "/api/manuscript/compile", {"doc": "thesis"})
        self.assertEqual((status, r["ok"], r["errors"], r["main"], r["engine"]), (200, True, [], "master.tex", "pdflatex"))
        self.assertEqual([w for w in r["warnings"] if "undefined" in w], [])
        build = self.vault / "documents" / ".build" / "thesis"
        # one bibliography per chapter, each made by bibtex from that chapter's own .aux
        for chapter in ("introduction/introduction", "papers/paperA/paperA", "papers/paperB/paperB"):
            self.assertTrue((build / f"{chapter}.bbl").is_file(), chapter)
        self.assertEqual(sorted(p.relative_to(folder).as_posix() for p in folder.rglob("*")), before, "nothing is left in the document's folder")

    @unittest.skipUnless(LATEXMK, "latexmk is not installed")
    def test_the_icml_kit_compiles_through_the_server_with_pdflatex_and_bibtex(self):
        if fetch_kits.kit("icml2027") is None:
            self.skipTest(fetch_kits.missing("icml2027"))
        kit_document(self.vault, "icml", "icml2027")
        self.assertEqual(self.ms("icml")["main"], "example_paper.tex")
        status, r = self.write("POST", "/api/manuscript/compile", {"doc": "icml"})
        self.assertEqual((status, r["ok"], r["errors"], r["engine"]), (200, True, [], "pdflatex"))
        self.assertEqual([w for w in r["warnings"] if "undefined" in w], [])
        build = self.vault / "documents" / ".build" / "icml"
        self.assertTrue((build / "example_paper.bbl").is_file())
        self.assertFalse((build / "example_paper.bcf").exists(), "bibtex, not biber")

    @unittest.skipUnless(LATEXMK and shutil.which("kpsewhich"), "latexmk is not installed")
    def test_a_document_asking_for_shell_escape_fails_with_a_message_saying_it_is_off(self):
        import subprocess
        if not subprocess.run(["kpsewhich", "minted.sty"], capture_output=True, text=True).stdout.strip():
            self.skipTest("minted is not installed")
        empty_document(self.vault, "code", {"main.tex": "\\documentclass{article}\n\\usepackage{minted}\n\\begin{document}\n\\begin{minted}{python}\nprint(1)\n\\end{minted}\n\\end{document}\n"})
        status, r = self.write("POST", "/api/manuscript/compile", {"doc": "code"})
        self.assertEqual((status, r["ok"]), (200, False))
        self.assertIn("shell escape is off", r["errors"][0]["message"])

    def test_the_main_file_in_a_folder_of_the_document(self):
        empty_document(self.vault, "nested", {"src/paper.tex": "\\documentclass{article}\n\\begin{document}\n\\input{parts/one}\n\\end{document}\n", "src/parts/one.tex": "One.\n", "other.tex": "Other.\n"})
        d = self.ms("nested")
        self.assertEqual((d["main"], d["notIncluded"]), ("src/paper.tex", ["other.tex"]))
        if LATEXMK:
            status, r = self.write("POST", "/api/manuscript/compile", {"doc": "nested"})
            self.assertEqual((r["ok"], r["errors"]), (True, []))
            self.assertEqual(self.get("/api/manuscript/pdf?doc=nested", headers=[("X-RFT-Token", KEY)])[0], 200)

    # ------------------------------------------------------------ templates (tickets 17 and 18)

    def templates(self) -> list[dict]:
        return json.loads(self.get("/api/manuscript")[2])["templates"]

    def load(self, name: str, data: bytes, **kw):
        return self.write("PUT", f"/api/manuscript/template?name={quote(name)}", data, ctype="application/zip", **kw)

    def template_files(self, name: str) -> dict[str, bytes]:
        folder = self.vault / "templates" / name
        return {p.relative_to(folder).as_posix(): p.read_bytes() for p in sorted(folder.rglob("*")) if p.is_file()}

    @staticmethod
    def zipped(files: dict[str, bytes], links: dict[str, str] | None = None) -> bytes:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for name, data in files.items():
                z.writestr(name, data)
            for name, target in (links or {}).items():
                info = zipfile.ZipInfo(name)
                info.external_attr = (0o120777 << 16)  # a symbolic link, as zip -y stores one
                z.writestr(info, target)
        return buf.getvalue()

    def test_the_templates_there_are_built_in_and_in_the_vault(self):
        self.assertEqual(self.templates(), [{"name": "article", "builtIn": True}, {"name": "report", "builtIn": True}])
        kit = self.vault / "templates" / "thesis-xe"
        (kit / "chapters").mkdir(parents=True)
        (kit / "thesis.tex").write_text("\\documentclass{book}\n\\begin{document}\n\\end{document}\n")
        (kit / "chapters" / "one.tex").write_text("One.\n")
        (kit / "template.json").write_text('{"engine": "xelatex"}')
        # the notes' own templates are files of the same folder; a folder named as a built-in one does not hide it
        (self.vault / "templates" / "_experiment.md").write_text("# a note's template\n")
        (self.vault / "templates" / "article").mkdir()
        (self.vault / "templates" / ".hidden").mkdir()
        self.assertEqual(self.templates(), [{"name": "article", "builtIn": True}, {"name": "report", "builtIn": True}, {"name": "thesis-xe", "builtIn": False, "files": 2, "engine": "xelatex"}])

    @unittest.skipUnless(LATEXMK, "latexmk is not installed")
    def test_a_document_from_each_built_in_template_compiles_and_the_scan_finds_nothing(self):
        # what the session writes for a new document (tests/manuscript.test.ts holds newDocument to these files)
        for name in ("article", "report"):
            with self.subTest(name):
                folder = FIXTURE / "built-in" / name
                empty_document(self.vault, f"new-{name}", {p.name: p.read_text() for p in folder.iterdir()}, {"main": "main.tex", "template": name})
                d = self.ms(f"new-{name}")
                self.assertEqual((d["template"], d["main"], d["traces"], d["copies"]), (name, "main.tex", [], []))
                status, r = self.write("POST", "/api/manuscript/compile", {"doc": f"new-{name}"})
                self.assertEqual((status, r["ok"], r["errors"]), (200, True, []))
        # a document made before templates reads as made from the built-in one of its class
        self.assertEqual(self.ms("paper")["template"], "article")

    def test_a_new_document_is_asked_of_the_session_with_its_template(self):
        (self.vault / "templates" / "icml2027").mkdir(parents=True)
        (self.vault / "templates" / "icml2027" / "example_paper.tex").write_text("\\begin{document}\n\\end{document}\n")

        def answer(request):  # the session, as hooks/lib/manuscript.ts newDocument does it
            shutil.copytree(self.vault / "templates" / request["template"], self.vault / "documents" / request["name"])
            empty_document(self.vault, request["name"], {}, {"template": request["template"]})

        self.answer = answer
        status, got = self.write("POST", "/api/manuscript/ask", {"action": "document", "name": "camera-ready", "template": "icml2027"})
        self.assertEqual((status, got["id"]), (200, "camera-ready"))
        self.assertEqual(self.asked[-1], ("RFT_MANUSCRIPT", {"action": "document", "name": "camera-ready", "template": "icml2027"}))
        d = self.ms("camera-ready")
        self.assertEqual((d["template"], d["main"]), ("icml2027", "example_paper.tex"))
        # what an older page sends still makes an article or a report
        self.answer = lambda request: empty_document(self.vault, request["name"], {"main.tex": "x"}, {"template": request["template"]})
        self.assertEqual(self.write("POST", "/api/manuscript/ask", {"action": "document", "name": "old", "kind": "report"})[0], 200)
        self.assertEqual(self.asked[-1][1], {"action": "document", "name": "old", "template": "report"})
        self.assertEqual(self.write("POST", "/api/manuscript/ask", {"action": "document", "name": "x", "template": "neurips"})[0], 404)
        self.assertEqual(self.write("POST", "/api/manuscript/ask", {"action": "document", "name": "paper", "template": "article"})[0], 409)
        self.assertEqual(self.write("POST", "/api/manuscript/ask", {"action": "document", "name": "x", "template": 3})[0], 400)

    def test_the_icml_zip_becomes_a_template_and_a_document_made_from_it_compiles_unmodified(self):
        if fetch_kits.kit_zip("icml2027") is None:
            self.skipTest(fetch_kits.missing("icml2027"))
        data = fetch_kits.kit_zip("icml2027").read_bytes()
        status, got = self.load("icml2027", data)
        self.assertEqual((status, got["name"], got["files"]), (201, "icml2027", 9))
        self.assertIn({"name": "icml2027", "builtIn": False, "files": 9}, got["templates"])
        # its one top folder unwrapped, every file as the kit has it
        kit = fetch_kits.kit("icml2027")
        self.assertEqual(self.template_files("icml2027"), {p.relative_to(kit).as_posix(): p.read_bytes() for p in sorted(kit.rglob("*")) if p.is_file()})
        if not LATEXMK:
            return
        # a document made from it: its files copied as they are (the session's part, tests/manuscript.test.ts)
        shutil.copytree(self.vault / "templates" / "icml2027", self.vault / "documents" / "icml")
        empty_document(self.vault, "icml", {}, {"template": "icml2027"})
        status, r = self.write("POST", "/api/manuscript/compile", {"doc": "icml"})
        self.assertEqual((status, r["ok"], r["errors"], r["main"]), (200, True, [], "example_paper.tex"))

    def test_a_zip_that_would_write_outside_or_holds_a_link_is_refused_and_nothing_is_written(self):
        good = {"kit/main.tex": b"\\begin{document}\\end{document}", "kit/kit.sty": b"% style"}
        outside = Path(self.tmp.name) / "x"
        for why, data in (("..", self.zipped({**good, "kit/../../../x": b"evil"})), ("absolute", self.zipped({**good, "/tmp/x-rft-test": b"evil"})),
                          ("a drive", self.zipped({**good, "C:/x": b"evil"})), ("a backslash", self.zipped({**good, "kit\\..\\x": b"evil"})),
                          ("a link", self.zipped(good, {"kit/secrets": "/etc/passwd"})), ("a link out", self.zipped(good, {"kit/up": "../../.."}))):
            with self.subTest(why):
                status, got = self.load("kit", data)
                self.assertEqual(status, 422, got)
                self.assertIn("nothing was written", got["error"])
                self.assertFalse((self.vault / "templates").exists() and any((self.vault / "templates").iterdir()), "something was written")
                self.assertFalse(outside.exists())
        self.assertEqual(self.load("kit", b"not a zip")[0], 400)
        self.assertEqual(self.load("kit", self.zipped({"__MACOSX/._main.tex": b"junk"}))[0], 400)
        # the size is counted unpacked, before anything is written
        status, got = self.load("big", self.zipped({"big/main.tex": b"x", "big/data.bin": b"\x00" * 51_000_000}))
        self.assertEqual(status, 413)
        self.assertIn("51.0 MB", got["error"])
        self.assertFalse((self.vault / "templates" / "big").exists())
        # the key, as for every write
        self.assertEqual(self.load("kit", self.zipped(good), key=None)[0], 403)
        self.assertFalse((self.vault / "templates" / "kit").exists())

    def test_a_name_that_exists_asks_for_another_and_nothing_is_overwritten(self):
        first = {"main.tex": b"first"}
        self.assertEqual(self.load("kit", self.zipped(first))[0], 201)
        status, got = self.load("kit", self.zipped({"main.tex": b"second"}))
        self.assertEqual((status, got["ask"]), (409, "name"))
        self.assertIn("another name", got["error"])
        self.assertEqual(self.template_files("kit"), first)
        self.assertEqual(self.load("kit-2", self.zipped({"main.tex": b"second"}))[0], 201)
        self.assertEqual(self.template_files("kit-2"), {"main.tex": b"second"})
        for bad in ("article", "report"):
            self.assertEqual(self.load(bad, self.zipped(first))[0], 409)
        for bad in ("", "my kit", "../kit", ".kit", "a/b"):
            self.assertEqual(self.load(bad, self.zipped(first))[0], 400, bad)
        self.assertEqual(sorted(p.name for p in (self.vault / "templates").iterdir()), ["kit", "kit-2"])

    def test_a_zip_as_file_managers_make_them(self):
        # several things at the top: kept as they are; a file manager's and git's own left out; a dotfile of the kit kept
        files = {"main.tex": b"m", "sty/kit.sty": b"s", ".latexmkrc": b"rc", "__MACOSX/._main.tex": b"junk", "sty/.DS_Store": b"junk", ".git/config": b"git"}
        self.assertEqual(self.load("flat", self.zipped(files))[0], 201)
        self.assertEqual(self.template_files("flat"), {".latexmkrc": b"rc", "main.tex": b"m", "sty/kit.sty": b"s"})
        self.assertEqual(rft_documents.template_name("C:\\kits\\ICML 2027 (final).zip"), "ICML-2027-final")
        self.assertEqual(rft_documents.template_name("aauPhdCollectionThesis/"), "aauPhdCollectionThesis")
        self.assertEqual(rft_documents.template_name(".."), "")

    # ------------------------------------------------------------ the .bib of a document with several (ticket 19)

    def test_which_bib_a_file_uses_the_cases_both_sides_are_held_to(self):
        d = json.loads((FIXTURE / "bib.json").read_text(encoding="utf-8"))
        for c in d["cases"]:
            with self.subTest(c["why"]):
                self.assertEqual(rft_manuscript.bib_for(c["files"], c["main"], c["file"], c.get("chosen")), c["want"])
        self.assertEqual(rft_manuscript.taken_in_by({"main.tex": "\\input{a}\n\\input{b}", "a.tex": "\\input{b}", "b.tex": "", "c.tex": ""}, "main.tex"), {"a.tex": "main.tex", "b.tex": "a.tex"})

    def test_the_page_is_told_which_bib_or_that_it_must_ask(self):
        self.assertEqual(json.loads(self.get("/api/manuscript/bib?doc=paper&file=sections/method.tex")[2]), {"bib": "refs.bib"})
        body = "\\begin{document}\n\\include{a}\n\\include{b}\n\\end{document}\n"
        empty_document(self.vault, "two-bibs", {"main.tex": body, "a.tex": "A.\n", "b.tex": "B.\n\\bibliography{b}\n", "a.bib": "", "b.bib": ""})
        self.assertEqual(json.loads(self.get("/api/manuscript/bib?doc=two-bibs&file=b.tex")[2]), {"bib": "b.bib"})
        self.assertEqual(json.loads(self.get("/api/manuscript/bib?doc=two-bibs&file=a.tex")[2]), {"bib": "b.bib"})  # the only one the document names
        (self.vault / "documents" / "two-bibs" / "main.tex").write_text(body.replace("\\end{document}", "\\bibliography{a}\n\\end{document}"))
        self.assertEqual(json.loads(self.get("/api/manuscript/bib?doc=two-bibs&file=a.tex")[2]), {"bib": "a.bib"})  # covered by the main file's
        (self.vault / "documents" / "two-bibs" / "main.tex").write_text(body)
        (self.vault / "documents" / "two-bibs" / "b.tex").write_text("B.\n")
        self.assertEqual(json.loads(self.get("/api/manuscript/bib?doc=two-bibs&file=a.tex")[2]), {"ask": ["a.bib", "b.bib"]})
        # what the user chose, as the session records it, is not asked again
        empty_document(self.vault, "two-bibs", {}, {"bibOf": {"a.tex": "a.bib"}})
        self.assertEqual(json.loads(self.get("/api/manuscript/bib?doc=two-bibs&file=a.tex")[2]), {"bib": "a.bib"})
        self.assertEqual(self.get("/api/manuscript/bib?doc=two-bibs&file=nope.tex")[0], 404)
        self.assertEqual(self.get("/api/manuscript/bib?doc=nope&file=a.tex")[0], 404)
        # the choice goes to the session with the placement
        self.answer = lambda request: empty_document(self.vault, "two-bibs", {}, {"bibOf": {"b.tex": request["bib"]}})
        status, _ = self.write("POST", "/api/manuscript/ask", {"action": "place", "name": "two-bibs", "id": "S01", "file": "b.tex", "bib": "b.bib"})
        self.assertEqual((status, self.asked[-1][1]), (200, {"action": "place", "name": "two-bibs", "id": "S01", "file": "b.tex", "bib": "b.bib"}))

    def test_a_citation_of_an_own_entry_is_listed_as_resting_on_no_reference_note_and_no_file_changes(self):
        before = {p.relative_to(self.doc).as_posix(): p.read_bytes() for p in self.doc.rglob("*") if p.is_file()}
        d = self.ms()
        # zhang2018mixup was added to refs.bib by hand; yun2019cutmix came from the reference note R07
        self.assertEqual({b["key"]: b["from"] for b in d["bib"]}, {"yun2019cutmix": "R07", "zhang2018mixup": None})
        self.assertEqual(d["ownCited"], [{"key": "zhang2018mixup", "file": "main.tex", "line": 26}])
        self.assertEqual({p.relative_to(self.doc).as_posix(): p.read_bytes() for p in self.doc.rglob("*") if p.is_file()}, before)
        # a renamed .bib keeps what is tracked of it, in every file an entry stands in
        t = self.tracking()
        t["bib"]["yun2019cutmix"]["also"] = ["sections/extra.bib"]
        (self.vault / "documents" / ".rft" / "paper" / "tracking.json").write_text(json.dumps(t))
        (self.doc / "sections" / "extra.bib").write_text("")
        self.assertEqual(self.files("move", "sections/extra.bib", to="sections/more.bib")[0], 200)
        self.assertEqual(self.files("move", "refs.bib", to="literature.bib")[0], 200)
        self.assertEqual(self.tracking()["bib"]["yun2019cutmix"], {"from": "R07", "file": "literature.bib", "also": ["sections/more.bib"]})


if __name__ == "__main__":
    unittest.main()
