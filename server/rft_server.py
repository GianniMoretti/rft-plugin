#!/usr/bin/env python3
"""The rft web view's server: local, standard library only.

Serves the page (web/), the tree of the vault as JSON, and the text of one note at a time, and
writes one thing: the body of a note, its frontmatter kept as it is. It binds 127.0.0.1 only,
takes requests only for a loopback host name (so a web page elsewhere cannot reach it through
DNS rebinding), serves nothing but an allow-list of page files, and reads or writes a note only
by its id, in a markdown file that resolves inside the vault's experiments/ or directions/
folder. A write (PUT api/note) must also come from the page itself (its Origin) and carry the
vault's key, which is in the address the server prints, so neither another web page nor another
user of the machine can change a note. The key is kept in the user's cache, readable by them
alone, so it stays the same across restarts.

    python3 rft_server.py --vault /abs/project/vault --web /abs/plugin/web [--port 0] [--project NAME]

It prints `RFT_SERVER_URL http://127.0.0.1:<port>/?token=<key>` once listening, and exits when
its parent process goes away (or, with --watch-stdin, closes its stdin). When a fixed --port is
held by another session's server for the same vault, it prints that address, whose key is the
same, and takes the port over once that server stops; when something else holds it, it serves
on a free port instead.
"""
from __future__ import annotations

import argparse
import errno
import hashlib
import http.client
import http.server
import json
import os
import re
import secrets
import stat
import sys
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

SUBDIRS = {"experiments": "experiment", "directions": "direction"}
PAGE_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
    "/filters.js": ("filters.js", "text/javascript; charset=utf-8"),
    "/layout.js": ("layout.js", "text/javascript; charset=utf-8"),
    "/concepts.js": ("concepts.js", "text/javascript; charset=utf-8"),
    "/vendor/d3.v7.9.0.min.js": ("vendor/d3.v7.9.0.min.js", "text/javascript; charset=utf-8"),
    "/vendor/LICENSE-d3.txt": ("vendor/LICENSE-d3.txt", "text/plain; charset=utf-8"),
}
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "[::1]"}
ID_RE = re.compile(r"^[ED]\d+$")
MAX_NOTE_BYTES = 2_000_000


# ------------------------------------------------------------------ the vault

def front(text: str) -> dict[str, str]:
    """The one-line `key: value` fields of a note's frontmatter."""
    m = re.match(r"---\n(.*?)\n---", text.replace("\r\n", "\n"), re.S)
    out: dict[str, str] = {}
    for line in m.group(1).split("\n") if m else []:
        if ":" in line and not line[:1].isspace():
            k, _, v = line.partition(":")
            out[k.strip()] = v.strip()
    return out


def split_note(text: str) -> tuple[str, str]:
    """The frontmatter, through its closing `---` line, and the body, with LF newlines."""
    t = text.replace("\r\n", "\n")
    if not t.startswith("---\n"):
        return "", t
    end = t.find("\n---", 4)
    if end < 0:
        return "", t
    nl = t.find("\n", end + 4)
    return (t + "\n", "") if nl < 0 else (t[:nl + 1], t[nl + 1:])


def body_of(text: str) -> str:
    return split_note(text)[1]


def version_of(data: bytes) -> str:
    return hashlib.sha1(data).hexdigest()[:16]


def id_of(name: str) -> str:
    return name.split(" ")[0]


def natural_key(name: str):
    m = re.match(r"^([A-Za-z]+)(\d+)(.*)$", name)
    return (m.group(1), int(m.group(2)), m.group(3)) if m else (name, 0, "")


STATUSES = {"planned", "running", "done", "idea", "dropped", "discussed", "moved"}


def parse_tags(value: str | None) -> list[str]:
    """The tags of a one-line `tags:` value: `[a, b]`, `a, b` or `#a #b`."""
    v = (value or "").strip()
    if v.startswith("[") and v.endswith("]"):
        v = v[1:-1]
    return [t.strip().strip("'\"").lstrip("#") for t in re.split(r"[,\s]+", v) if t.strip().strip("'\"").lstrip("#")]


def topical_tags(tags: list[str], project: str) -> list[str]:
    """The tags less the ones every note carries anyway: project, type, status."""
    out: list[str] = []
    for t in tags:
        if t not in out and t != project and t not in ("experiment", "direction") and t not in STATUSES:
            out.append(t)
    return out


ROOT_CONCEPT = "root"


def unquote(value: str | None) -> str:
    v = (value or "").strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1]
    return v.strip()


def compute_concepts(nodes: dict[str, dict], roots: list[str], project: str,
                     decl: dict[str, tuple[str, str]]) -> list[dict]:
    """Concepts, inherited down the tree: a note belongs to its nearest ancestor (or itself)
    declaring `concept:`, else to the project root concept. Sets each node's `concept` and
    returns the concepts depth first, the root concept first."""
    def make(cid, name, summary, root, parent, depth):
        return {"id": cid, "name": name, "summary": summary, "root": root, "parent": parent, "children": [],
                "depth": depth, "count": 0, "total": 0, "statuses": {}}

    concepts = {ROOT_CONCEPT: make(ROOT_CONCEPT, project, "", None, None, 0)}
    stack = [(r, ROOT_CONCEPT) for r in reversed(roots)]
    while stack:
        nid, current = stack.pop()
        n = nodes.get(nid)
        if n is None:
            continue
        if nid in decl:
            name, summary = decl[nid]
            concepts[nid] = make(nid, name, summary, nid, current, concepts[current]["depth"] + 1)
            concepts[current]["children"].append(nid)
            current = nid
        n["concept"] = current
        c = concepts[current]
        c["count"] += 1
        c["statuses"][n["status"]] = c["statuses"].get(n["status"], 0) + 1
        stack.extend((k, current) for k in reversed(n["children"]))

    order: list[dict] = []

    def total(cid):
        c = concepts[cid]
        order.append(c)
        c["total"] = c["count"] + sum(total(k) for k in c["children"])
        return c["total"]

    total(ROOT_CONCEPT)
    return order


def link_target(value: str | None) -> str | None:
    m = re.search(r"\[\[([^\]|#]+)", value or "")
    return m.group(1).strip() if m else None


class Vault:
    """The tree read from the notes' `parent:` fields, cached until a note changes."""

    def __init__(self, root: Path, project: str):
        self.root = root.resolve()
        self.project = project
        # tells two servers of the same vault apart from others, without saying where it is
        self.ident = hashlib.sha256(str(self.root).encode()).hexdigest()[:16]
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._sig: str | None = None
        self._tree: dict | None = None

    def signature(self) -> str:
        parts = []
        for sub in SUBDIRS:
            d = self.root / sub
            if d.is_dir():
                for f in sorted(d.glob("*.md")):
                    st = f.stat()
                    parts.append(f"{sub}/{f.name}:{st.st_mtime_ns}:{st.st_size}")
        return hashlib.sha1("|".join(parts).encode()).hexdigest()[:16]

    def tree(self) -> dict:
        with self._lock:
            sig = self.signature()
            if sig != self._sig or self._tree is None:
                self._tree = self._load(sig)
                self._sig = sig
            return self._tree

    def _load(self, sig: str) -> dict:
        nodes: dict[str, dict] = {}
        refs: dict[str, str | None] = {}
        decl: dict[str, tuple[str, str]] = {}
        for sub, kind in SUBDIRS.items():
            d = self.root / sub
            if not d.is_dir():
                continue
            for f in sorted(d.glob("*.md"), key=lambda p: natural_key(p.name)):
                text = f.read_text(encoding="utf-8", errors="replace")
                fm = front(text)
                name = f.name[:-3]
                nid = fm.get("id") or id_of(name)
                if nid in nodes:
                    continue
                ftype = fm.get("type") if fm.get("type") in ("experiment", "direction") else kind
                nodes[nid] = {"id": nid, "name": name, "title": name[len(id_of(name)):].strip(),
                              "type": ftype, "status": fm.get("status", ""), "date": fm.get("date", ""),
                              "parent": None, "children": [], "path": f"{sub}/{f.name}",
                              "tags": topical_tags(parse_tags(fm.get("tags")), self.project),
                              "concept": ROOT_CONCEPT}
                refs[nid] = link_target(fm.get("parent"))
                cname = unquote(fm.get("concept"))
                if cname:
                    decl[nid] = (cname, unquote(fm.get("concept_summary")))
        by_name = {n["name"]: n["id"] for n in nodes.values()}
        for n in nodes.values():
            ref = refs.get(n["id"])
            pid = by_name.get(ref) or (id_of(ref) if ref and id_of(ref) in nodes else None) if ref else None
            if pid and pid != n["id"]:
                n["parent"] = pid
        for n in nodes.values():  # break cycles
            seen, p = {n["id"]}, n["parent"]
            while p:
                if p in seen:
                    n["parent"] = None
                    break
                seen.add(p)
                p = nodes[p]["parent"] if p in nodes else None
        roots = []
        for n in nodes.values():
            (nodes[n["parent"]]["children"] if n["parent"] else roots).append(n["id"])
        key = lambda i: natural_key(nodes[i]["name"])
        for n in nodes.values():
            n["children"].sort(key=key)
        roots.sort(key=key)
        counts: dict[str, int] = {}
        for n in nodes.values():
            for t in n["tags"]:
                counts[t] = counts.get(t, 0) + 1
        tags = [{"tag": t, "count": c} for t, c in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]
        concepts = compute_concepts(nodes, roots, self.project, decl)
        return {"project": self.project, "version": sig, "nodes": list(nodes.values()), "roots": roots, "tags": tags,
                "concepts": concepts}

    def note_path(self, nid: str) -> Path | None:
        """The note's file, only when it resolves to a markdown file inside experiments/ or directions/."""
        if not ID_RE.match(nid or ""):
            return None
        node = next((n for n in self.tree()["nodes"] if n["id"] == nid), None)
        if node is None:
            return None
        path = (self.root / node["path"]).resolve()
        allowed = [(self.root / s).resolve() for s in SUBDIRS]
        inside = any(path.parent == a for a in allowed)
        return path if inside and path.suffix == ".md" and path.is_file() else None

    def note(self, nid: str) -> dict | None:
        path = self.note_path(nid)
        if path is None:
            return None
        data = path.read_bytes()
        return {"id": nid, "name": path.name[:-3], "body": body_of(data.decode("utf-8", errors="replace")),
                "version": version_of(data)}

    def write_body(self, nid: str, body: str, version: str | None) -> tuple[int, dict]:
        """Replaces a note's body, keeping its frontmatter byte for byte. Refused, with the note as
        it is now, when the file changed since `version` (None: write anyway)."""
        path = self.note_path(nid)
        if path is None:
            return 404, {"error": "no such note"}
        with self._write_lock:
            data = path.read_bytes()
            if version is not None and version != version_of(data):
                return 409, {"error": "the note changed since it was opened", "id": nid,
                             "body": body_of(data.decode("utf-8", errors="replace")), "version": version_of(data)}
            try:
                text = data.decode("utf-8")
            except UnicodeDecodeError:
                return 422, {"error": "the note is not UTF-8 text; edit it in an editor"}
            head, _ = split_note(text)
            body = body.replace("\r\n", "\n")
            if body and not body.endswith("\n"):
                body += "\n"
            new = head + body
            if "\r\n" in text:
                new = new.replace("\n", "\r\n")
            out = new.encode("utf-8")
            # a new file renamed over the note: a reader never sees half of it
            tmp = path.with_name(f".{path.name}.rft-tmp")
            try:
                tmp.write_bytes(out)
                os.chmod(tmp, stat.S_IMODE(path.stat().st_mode))
                os.replace(tmp, path)
            finally:
                tmp.unlink(missing_ok=True)
        return 200, {"id": nid, "version": version_of(out)}


# ------------------------------------------------------------------ http

def make_handler(vault: Vault, web: Path, token: str | None = None):
    """The request handler; without a `token` it never writes."""
    web = web.resolve()

    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "rft"
        sys_version = ""

        def log_message(self, fmt, *args):  # quiet: the plugin reads stdout for the URL only
            pass

        def _send(self, status: int, body: bytes, ctype: str, head_only: bool = False):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy",
                             "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; "
                             "connect-src 'self'; frame-ancestors 'self'")
            self.end_headers()
            if not head_only:
                self.wfile.write(body)

        def _json(self, status: int, obj, head_only=False):
            self._send(status, json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8", head_only)

        def _host_ok(self) -> bool:
            host = (self.headers.get("Host") or "").strip().lower()
            name = host.rsplit(":", 1)[0] if not host.startswith("[") else host.split("]")[0] + "]"
            return name in LOOPBACK_HOSTS

        def do_HEAD(self):
            self.do_GET(head_only=True)

        def do_GET(self, head_only: bool = False):
            if not self._host_ok():
                return self._send(403, b"forbidden host", "text/plain", head_only)
            url = urlsplit(self.path)
            route = url.path
            if route in PAGE_FILES:
                rel, ctype = PAGE_FILES[route]
                path = (web / rel).resolve()
                if path.parent not in (web, web / "vendor") or not path.is_file():
                    return self._send(404, b"not found", "text/plain", head_only)
                return self._send(200, path.read_bytes(), ctype, head_only)
            if route == "/api/tree":
                return self._json(200, vault.tree(), head_only)
            if route == "/api/id":
                return self._json(200, {"vault": vault.ident}, head_only)
            if route == "/api/note":
                nid = (parse_qs(url.query).get("id") or [""])[0]
                note = vault.note(nid)
                return self._json(200, note, head_only) if note else self._json(404, {"error": "no such note"}, head_only)
            return self._send(404, b"not found", "text/plain", head_only)

        def _refuse(self):
            self._send(405, b"read-only", "text/plain")

        def _may_write(self) -> bool:
            """The page itself asks: its own origin, and the key from the address the server printed."""
            origin = (self.headers.get("Origin") or "").strip().lower()
            host = (self.headers.get("Host") or "").strip().lower()
            key = self.headers.get("X-RFT-Token") or ""
            return bool(token) and origin == f"http://{host}" and secrets.compare_digest(key, token)

        def do_PUT(self):
            """PUT api/note?id=<id> {"body": "...", "version": "<as read>"} or {"body": "...", "force": true}."""
            if not self._host_ok():
                return self._send(403, b"forbidden host", "text/plain")
            url = urlsplit(self.path)
            if url.path != "/api/note" or not token:
                return self._refuse()
            if not self._may_write():
                return self._json(403, {"error": "the key is missing or out of date: open the address /rft printed"})
            if not (self.headers.get("Content-Type") or "").lower().startswith("application/json"):
                return self._json(415, {"error": "send JSON"})
            try:
                length = int(self.headers.get("Content-Length") or "")
            except ValueError:
                return self._json(411, {"error": "no length"})
            if not 0 <= length <= MAX_NOTE_BYTES:
                return self._json(413, {"error": "the note is too large"})
            try:
                req = json.loads(self.rfile.read(length))
            except ValueError:
                return self._json(400, {"error": "not JSON"})
            if not isinstance(req, dict) or not isinstance(req.get("body"), str):
                return self._json(400, {"error": "expected {body, version} or {body, force: true}"})
            force = req.get("force") is True
            version = None if force else req.get("version")
            if not force and not isinstance(version, str):
                return self._json(400, {"error": "expected {body, version} or {body, force: true}"})
            nid = (parse_qs(url.query).get("id") or [""])[0]
            return self._json(*vault.write_body(nid, req["body"], version))

        do_POST = do_DELETE = do_PATCH = _refuse

    return Handler


def vault_key(vault: Path) -> str:
    """The key for writes to this vault, kept in the user's cache readable by them alone (XDG_CACHE_HOME,
    else ~/.cache), so an address with it, or a browser that remembers it, still works after a restart."""
    keys = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "rft" / "keys"
    path = keys / hashlib.sha1(str(vault.resolve()).encode()).hexdigest()[:16]
    try:
        if path.stat().st_mode & 0o077 == 0:
            key = path.read_text().strip()
            if re.fullmatch(r"[\w-]{16,}", key):
                return key
    except OSError:
        pass
    key = secrets.token_urlsafe(12)
    try:
        keys.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.unlink(missing_ok=True)
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as f:
            f.write(key)
    except OSError:
        pass  # a key for this run only
    return key


def bind(port: int, handler):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    server.daemon_threads = True
    return server


def vault_on(port: int) -> str | None:
    """The vault id of the rft server listening on `port`, or None when it is not one."""
    try:
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        c.request("GET", "/api/id")
        r = c.getresponse()
        body = r.read()
        c.close()
        return json.loads(body).get("vault") if r.status == 200 else None
    except (OSError, ValueError, AttributeError):
        return None


def take_over(port: int, handler, every: float = 1.0):
    """Binds `port` as soon as it is free: when the session that serves it there ends."""
    while True:
        time.sleep(every)
        try:
            return bind(port, handler)
        except OSError:
            pass


def watch_parent(server, watch_stdin: bool):
    """Exit when the parent dies (we are re-parented), and with --watch-stdin when it closes our stdin."""
    parent = os.getppid()

    def by_pid():
        while True:
            time.sleep(2)
            if os.getppid() != parent:
                os._exit(0)

    def by_stdin():
        try:
            while sys.stdin.buffer.read(1024):
                pass
        except Exception:
            pass
        os._exit(0)

    threading.Thread(target=by_pid, daemon=True).start()
    if watch_stdin and not sys.stdin.isatty():
        threading.Thread(target=by_stdin, daemon=True).start()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--vault", required=True)
    ap.add_argument("--web", required=True)
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--project", default="project")
    ap.add_argument("--no-watch", action="store_true", help="do not exit with the parent (for manual runs)")
    ap.add_argument("--watch-stdin", action="store_true", help="also exit when stdin is closed")
    a = ap.parse_args(argv)
    vault = Vault(Path(a.vault), a.project)
    token = vault_key(Path(a.vault))
    handler = make_handler(vault, Path(a.web), token)
    if not a.no_watch:
        watch_parent(None, a.watch_stdin)

    def announce(port: int):
        print(f"RFT_SERVER_URL http://127.0.0.1:{port}/?token={token}", flush=True)

    try:
        server = bind(a.port, handler)
    except OSError as err:
        if not a.port or err.errno != errno.EADDRINUSE:
            raise
        if vault_on(a.port) == vault.ident:
            # another session serves this vault there, with the same key: its address is ours, and
            # its port once it stops
            announce(a.port)
            server = take_over(a.port, handler)
        else:
            print(f"rft: port {a.port} is taken, serving on a free port", file=sys.stderr, flush=True)
            server = bind(0, handler)
            announce(server.server_address[1])
    else:
        announce(server.server_address[1])
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
