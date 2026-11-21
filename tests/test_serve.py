"""The tree view served from a terminal (server/rft_serve.py), and the chats that run /rft beside it."""
from __future__ import annotations

import http.client
import json
import os
import queue
import re
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import rft_serve  # noqa: E402
import rft_server  # noqa: E402

WEB = Path(__file__).resolve().parents[1] / "web"
SERVER = Path(__file__).resolve().parents[1] / "server" / "rft_server.py"
SERVE = Path(__file__).resolve().parents[1] / "server" / "rft_serve.py"
URL = re.compile(r"http://127\.0\.0\.1:(\d+)/\?token=([\w-]{16})")


def note(nid, kind, status, parent, title):
    p = f'"[[{parent}]]"' if parent else '""'
    return (f"---\nid: {nid}\ntype: {kind}\nstatus: {status}\ndate: 2026-01-01\nparent: {p}\n"
            f"tags: [demo, {kind}, {status}]\n---\n\n# {nid} · {title}\n\nText of {nid}.\n")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def fetch(port, path):
    """(status, JSON body or None) of a GET on 127.0.0.1:port, or (None, None) when nothing answers."""
    try:
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        c.request("GET", path)
        r = c.getresponse()
        status, body = r.status, r.read()
        c.close()
        return status, (json.loads(body) if body.startswith(b"{") else None)
    except OSError:
        return None, None


class Proc:
    """A server process and the lines it prints, read as they come."""

    def __init__(self, argv, env, cwd=None, hup=signal.SIG_DFL):
        def signals():
            # as from a terminal: Ctrl+C stops it even when the tests run in the background
            # (which ignores SIGINT); SIGHUP as given (SIG_IGN: as under nohup)
            signal.signal(signal.SIGINT, signal.SIG_DFL)
            signal.signal(signal.SIGHUP, hup)

        self.p = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, cwd=cwd,
                                  preexec_fn=signals)
        self.lines = queue.Queue()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.p.stdout:
            self.lines.put(line.rstrip("\n"))

    def line(self, pattern, timeout=10):
        """The next line matching `pattern` (lines before it are skipped)."""
        end = time.time() + timeout
        while True:
            try:
                line = self.lines.get(timeout=max(0.01, end - time.time()))
            except queue.Empty:
                raise AssertionError(f"no line matching {pattern!r} within {timeout} s") from None
            if re.search(pattern, line):
                return line

    def address(self):
        """(port, key) of the first address it prints."""
        m = URL.search(self.line(URL.pattern))
        return int(m.group(1)), m.group(2)

    def stop(self, sig=signal.SIGKILL):
        if self.p.poll() is None:
            self.p.send_signal(sig)
        self.p.wait(10)


class TerminalTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "project"
        self.vault = self.root / "vault"
        (self.vault / "directions").mkdir(parents=True)
        (self.vault / "experiments").mkdir()
        (self.vault / "directions" / "D00 Root.md").write_text(note("D00", "direction", "idea", "", "Root"))
        self.port = free_port()
        self.config({"version": 2, "vault": "vault", "project": "demo", "webPort": self.port})
        self.env = {**os.environ, "XDG_CACHE_HOME": str(Path(self.tmp.name) / "cache")}
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            p.stop()
            p.p.stdout.close()
            p.p.stderr.close()
        self.tmp.cleanup()

    def config(self, cfg, root=None):
        (root or self.root).joinpath(".rft").mkdir(parents=True, exist_ok=True)
        (root or self.root).joinpath(".rft", "config.json").write_text(json.dumps(cfg))

    def terminal(self, *args, cwd=None, hup=signal.SIG_DFL):
        """rft_serve.py, as typed in a terminal in `cwd` (the project's folder by default)."""
        p = Proc([sys.executable, str(SERVE), *args], self.env, cwd=cwd or self.root, hup=hup)
        self.procs.append(p)
        return p

    def chat(self, port=None):
        """The server of a chat that ran /rft, as the plugin starts it."""
        p = Proc([sys.executable, str(SERVER), "--vault", str(self.vault), "--web", str(WEB), "--project", "demo",
                  "--port", str(self.port if port is None else port), "--no-watch"], self.env)
        self.procs.append(p)
        return p

    def ask(self, port, key, title):
        """The page's Add child: (status, reply, seconds it took)."""
        body = json.dumps({"parent": "D00", "type": "direction", "title": title})
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
        t = time.time()
        c.request("POST", "/api/node", body, {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{port}", "X-RFT-Token": key})
        r = c.getresponse()
        reply = json.loads(r.read())
        c.close()
        return r.status, reply, time.time() - t

    def make(self, title, nid="D01"):
        """What the plugin does with an RFT_ADD_NODE line: the note on disk."""
        (self.vault / "directions" / f"{nid} {title}.md").write_text(note(nid, "direction", "idea", "D00 Root", title))

    def add_through(self, chat, port, key, title, nid="D01"):
        """Add child on `port`, made by `chat` as its plugin would: the page's answer."""
        result = {}
        t = threading.Thread(target=lambda: result.update(answer=self.ask(port, key, title)))
        t.start()
        line = chat.line(r"^RFT_ADD_NODE ")
        self.assertEqual(json.loads(line.split(" ", 1)[1]), {"parent": "D00", "type": "direction", "title": title})
        self.make(title, nid)
        t.join(20)
        return result["answer"]

    def until(self, check, timeout=10):
        end = time.time() + timeout
        while time.time() < end:
            if check():
                return True
            time.sleep(0.1)
        return False

    # ------------------------------------------------------------ finding the tree

    def test_finds_the_tree_from_a_subfolder_and_through_a_link(self):
        sub = self.root / "code" / "deep"
        sub.mkdir(parents=True)
        args = rft_serve.server_args(str(sub))
        self.assertEqual(args[args.index("--vault") + 1], str(self.vault))
        self.assertEqual(args[args.index("--port") + 1], str(self.port))
        self.assertEqual(args[args.index("--project") + 1], "demo")
        self.assertEqual(args[args.index("--config") + 1], str(self.root / ".rft" / "config.json"))
        self.assertIn("--terminal", args)
        # a repository whose config links to the tree kept elsewhere
        repo = Path(self.tmp.name) / "repo"
        self.config({"tree": "../project"}, root=repo)
        args = rft_serve.server_args(str(repo))
        self.assertEqual(args[args.index("--vault") + 1], str(self.vault))
        self.assertEqual(rft_serve.server_args(str(repo), port=0)[args.index("--port") + 1], "0")

    def test_says_so_where_there_is_no_tree(self):
        nowhere = Path(self.tmp.name) / "nowhere"
        nowhere.mkdir()
        r = subprocess.run([sys.executable, str(SERVE)], cwd=nowhere, env=self.env, capture_output=True, text=True, timeout=20)
        self.assertEqual(r.returncode, 1)
        self.assertIn("RFT is not active here", r.stderr)
        # a link to a folder with no tree
        self.config({"tree": "../missing"}, root=nowhere)
        r = subprocess.run([sys.executable, str(SERVE)], cwd=nowhere, env=self.env, capture_output=True, text=True, timeout=20)
        self.assertEqual(r.returncode, 1)
        self.assertIn("holds no reasoning tree", r.stderr)

    # ------------------------------------------------------------ no chat

    def test_serves_the_address_of_slash_rft_and_refuses_the_session_s_work_at_once(self):
        t = self.terminal(cwd=self.root / "vault")
        port, key = t.address()
        self.assertEqual(port, self.port)
        # the key is the vault's, the one /rft prints
        self.assertEqual(key, self.chat_key())
        self.assertEqual(fetch(port, "/api/id")[1]["terminal"], True)
        self.assertEqual(fetch(port, "/api/tree")[1]["project"], "demo")
        status, reply, took = self.ask(port, key, "Lost")
        self.assertEqual(status, 503)
        self.assertIn("run /rft in a chat", reply["error"])
        self.assertLess(took, 1.0)
        self.assertFalse((self.vault / "directions" / "D01 Lost.md").exists())

    def chat_key(self):
        """The key a chat's server prints for this vault."""
        old = os.environ.get("XDG_CACHE_HOME")
        os.environ["XDG_CACHE_HOME"] = self.env["XDG_CACHE_HOME"]
        try:
            return rft_server.vault_key(self.vault)
        finally:
            if old is None:
                del os.environ["XDG_CACHE_HOME"]
            else:
                os.environ["XDG_CACHE_HOME"] = old

    # ------------------------------------------------------------ a chat beside it

    def test_a_chat_shows_the_terminal_s_address_and_makes_what_the_page_asks(self):
        t = self.terminal()
        port, key = t.address()
        c = self.chat()
        self.assertEqual(c.address(), (port, key))
        t.line("a Claude Code chat on this tree is connected")
        status, reply, _ = self.add_through(c, port, key, "From the phone")
        self.assertEqual((status, reply), (201, {"id": "D01", "name": "D01 From the phone"}))
        # the chat ends: the page is told at once again, and the terminal says so
        c.stop()
        t.line("no Claude Code chat is connected", timeout=5)
        status, reply, took = self.ask(port, key, "Later")
        self.assertEqual(status, 503)
        self.assertLess(took, 1.0)
        # the terminal still serves
        self.assertEqual(fetch(port, "/api/tree")[0], 200)

    def test_a_chat_finds_the_terminal_on_a_port_of_its_own(self):
        self.config({"version": 2, "vault": "vault", "project": "demo"})
        t = self.terminal()
        port, key = t.address()
        c = self.chat(port=0)
        self.assertEqual(c.address(), (port, key))
        self.assertEqual(self.add_through(c, port, key, "Found")[0], 201)

    def test_the_chat_serves_the_address_once_the_terminal_stops(self):
        t = self.terminal()
        port, key = t.address()
        c = self.chat()
        self.assertEqual(c.address(), (port, key))
        record = Path(self.env["XDG_CACHE_HOME"]) / "rft" / "hosts" / rft_server.Vault(self.vault, "demo").ident
        self.assertEqual(json.loads(record.read_text())["port"], port)
        t.stop(signal.SIGINT)  # Ctrl+C
        self.assertFalse(record.exists())
        self.assertTrue(self.until(lambda: fetch(port, "/api/id")[1] == {"vault": rft_server.Vault(self.vault, "demo").ident}))
        # the chat's own server now: it hands the page's requests to its plugin directly
        self.assertEqual(self.add_through(c, port, key, "Direct")[0], 201)

    def test_the_terminal_serves_the_port_once_the_chat_that_holds_it_ends(self):
        c = self.chat()
        port, key = c.address()
        t = self.terminal()
        t.line("a Claude Code chat serves demo at .*this terminal serves it once that chat ends")
        self.assertNotIn("terminal", fetch(port, "/api/id")[1])
        c.stop()
        t.line("the tree view of demo is at", timeout=10)
        self.assertEqual(fetch(port, "/api/id")[1].get("terminal"), True)
        # and a chat that starts later makes what the page asks there
        later = self.chat()
        self.assertEqual(later.address(), (port, key))
        self.assertEqual(self.add_through(later, port, key, "Later")[0], 201)

    def test_closing_the_terminal_stops_it_unless_run_under_nohup(self):
        record = Path(self.env["XDG_CACHE_HOME"]) / "rft" / "hosts" / rft_server.Vault(self.vault, "demo").ident
        t = self.terminal()
        t.address()
        self.assertTrue(record.exists())
        t.stop(signal.SIGHUP)
        self.assertEqual(t.p.returncode, 0)
        self.assertFalse(record.exists())
        kept = self.terminal(hup=signal.SIG_IGN)
        port, _ = kept.address()
        kept.p.send_signal(signal.SIGHUP)
        time.sleep(0.5)
        self.assertIsNone(kept.p.poll())
        self.assertEqual(fetch(port, "/api/id")[1].get("terminal"), True)

    def test_a_second_terminal_says_the_first_serves_the_tree(self):
        self.config({"version": 2, "vault": "vault", "project": "demo"})
        port, _ = self.terminal().address()
        r = subprocess.run([sys.executable, str(SERVE)], cwd=self.root, env=self.env, capture_output=True, text=True, timeout=20)
        self.assertEqual(r.returncode, 0)
        self.assertIn(f"already served from another terminal, at http://127.0.0.1:{port}/", r.stdout)

    def test_only_a_server_with_the_key_takes_the_requests(self):
        # a chat's own server, on a port of its own (started before the terminal, or it would follow it)
        c = self.chat(port=free_port())
        other, _ = c.address()
        self.assertEqual(fetch(other, "/api/session/next")[0], 404)
        t = self.terminal()
        port, key = t.address()
        self.assertNotEqual(port, other)

        def take(headers):
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            c.request("GET", "/api/session/next", headers=headers)
            r = c.getresponse()
            r.read()
            c.close()
            return r.status

        self.assertEqual(take({}), 403)
        self.assertEqual(take({"X-RFT-Token": "wrong-key-1234567"}), 403)
        # a page, even one carrying the key, never takes them
        self.assertEqual(take({"X-RFT-Token": key, "Origin": f"http://127.0.0.1:{port}"}), 403)
        self.assertEqual(take({"X-RFT-Token": key}), 200)


class RelayTest(unittest.TestCase):
    def setUp(self):
        alive = rft_server.RELAY_ALIVE_S
        rft_server.RELAY_ALIVE_S = 0.3
        self.addCleanup(setattr, rft_server, "RELAY_ALIVE_S", alive)

    def test_a_request_no_chat_takes_in_time_is_dropped(self):
        r = rft_server.Relay()
        with self.assertRaises(rft_server.NoSession):
            r.ask("RFT_ADD_NODE", {"title": "nobody"})
        r.take()  # a chat asks once, then is gone
        with self.assertRaises(rft_server.NoSession):
            r.ask("RFT_ADD_NODE", {"title": "too late"})
        # a chat that comes back later is not handed what the page gave up on
        self.assertEqual(r.take(), [])

    def test_a_terminal_that_stops_mid_answer_ends_the_following_quietly(self):
        # the headers, then the connection closes before the body: http.client's IncompleteRead,
        # which is no OSError, must not end the chat's server
        with socket.socket() as srv:
            srv.bind(("127.0.0.1", 0))
            srv.listen(1)

            def answer():
                conn, _ = srv.accept()
                conn.recv(4096)
                conn.sendall(b"HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: 16\r\n\r\n")
                conn.close()

            threading.Thread(target=answer, daemon=True).start()
            asked = []
            rft_server.follow(srv.getsockname()[1], "key", ask=lambda *x: asked.append(x))
        self.assertEqual(asked, [])

    def test_a_request_answers_once_taken(self):
        r = rft_server.Relay()
        r.take()
        done = threading.Event()
        threading.Thread(target=lambda: (r.ask("RFT_ASK", {"id": "D01", "thread": "t1"}), done.set())).start()
        self.assertTrue(self_until(lambda: r._pending))
        self.assertFalse(done.is_set())
        self.assertEqual(r.take(), [{"verb": "RFT_ASK", "request": {"id": "D01", "thread": "t1"}}])
        self.assertTrue(done.wait(1))


def self_until(check, timeout=2):
    end = time.time() + timeout
    while time.time() < end:
        if check():
            return True
        time.sleep(0.01)
    return False


if __name__ == "__main__":
    unittest.main()
