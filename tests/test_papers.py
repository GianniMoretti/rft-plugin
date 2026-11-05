"""The paper downloader (server/rft_papers.py) against a local HTTP server: names, the hosts it
accepts, PDFs only, moves inside papers/, and one line per job."""
import http.server
import io
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import rft_papers  # noqa: E402

PDF = b"%PDF-1.4 fake paper\n"
ARXIV = b"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><entry>
<title>mixup: Beyond Empirical
  Risk Minimization</title><published>2017-10-25T17:56:24Z</published>
<author><name>Hongyi Zhang</name></author><author><name>Moustapha Cisse</name></author>
</entry></feed>"""


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        body = {"/paper.pdf": PDF, "/page.pdf": b"<html>login</html>"}.get(self.path)
        if body is None:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.end_headers()
        self.wfile.write(body)


class PapersTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.vault = Path(tmp.name)

    def run_jobs(self, jobs, hosts=("127.0.0.1",)):
        out = io.StringIO()
        rft_papers.run(jobs, self.vault, hosts, out=out, pause=0)
        return [json.loads(l.split(" ", 1)[1]) for l in out.getvalue().splitlines()]

    def test_names(self):
        self.assertEqual(rft_papers.file_name("2017", "Zhang", "mixup: Beyond Empirical Risk Minimization"),
                         "2017 Zhang mixup Beyond Empirical Risk Minimization.pdf")
        self.assertEqual(rft_papers.file_name("", "", "A | b [c] / d"), "A b c d.pdf")
        self.assertEqual(rft_papers.parse_arxiv(ARXIV), {"title": "mixup: Beyond Empirical Risk Minimization", "author": "Zhang", "year": "2017"})

    def test_fetches_a_pdf_into_its_folder_once(self):
        job = {"op": "fetch", "id": "R01", "url": f"{self.base}/paper.pdf", "dir": "papers/Mixing", "title": "Mixing images", "year": ""}
        first, done = self.run_jobs([job])
        self.assertEqual(first, {"id": "R01", "ok": True, "file": "papers/Mixing/Mixing images.pdf"})
        self.assertEqual(done, {"ok": 1, "failed": 0})
        self.assertEqual((self.vault / first["file"]).read_bytes(), PDF)
        # the same paper again reuses the file
        self.assertEqual(self.run_jobs([job])[0]["file"], first["file"])

    def test_refuses_other_hosts_non_pdfs_and_paths_outside_papers(self):
        lines = self.run_jobs([
            {"op": "fetch", "id": "R01", "url": f"{self.base}/paper.pdf", "dir": "papers/A", "title": "x"},
            {"op": "fetch", "id": "R02", "url": f"{self.base}/page.pdf", "dir": "papers/A", "title": "x"},
            {"op": "fetch", "id": "R03", "url": f"{self.base}/paper.pdf", "dir": "../outside", "title": "x"},
        ], hosts=("example.org",))
        self.assertIn("not an open-access source", lines[0]["error"])
        lines = self.run_jobs([
            {"op": "fetch", "id": "R02", "url": f"{self.base}/page.pdf", "dir": "papers/A", "title": "x"},
            {"op": "fetch", "id": "R03", "url": f"{self.base}/paper.pdf", "dir": "../outside", "title": "x"},
        ])
        self.assertEqual([l["ok"] for l in lines[:2]], [False, False])
        self.assertIn("not answer with a PDF", lines[0]["error"])
        self.assertIn("outside the vault's papers/ folder", lines[1]["error"])
        self.assertEqual(lines[2], {"ok": 0, "failed": 2})
        self.assertFalse((self.vault.parent / "outside").exists())

    def test_moves_a_saved_pdf_to_the_new_concept_folder(self):
        old = self.vault / "papers" / "Old" / "2017 Zhang mixup.pdf"
        old.parent.mkdir(parents=True)
        old.write_bytes(PDF)
        line = self.run_jobs([{"op": "move", "id": "R01", "from": "papers/Old/2017 Zhang mixup.pdf", "dir": "papers/New"}])[0]
        self.assertEqual(line, {"id": "R01", "ok": True, "file": "papers/New/2017 Zhang mixup.pdf"})
        self.assertFalse(old.parent.exists())
        bad = self.run_jobs([{"op": "move", "id": "R02", "from": "../secret.pdf", "dir": "papers/New"}])[0]
        self.assertIn("outside", bad["error"])


if __name__ == "__main__":
    unittest.main()
