#!/usr/bin/env python3
"""The rft web view's server: read-only, local, standard library only.

Serves the page (web/), the tree of the vault as JSON, and the text of one note at a time.
It binds 127.0.0.1 only, answers GET and HEAD only, takes requests only for a loopback host
name (so a web page elsewhere cannot reach it through DNS rebinding), serves nothing but an
allow-list of page files, and reads a note only by its id, from a markdown file that resolves
inside the vault's experiments/ or directions/ folder.

    python3 rft_server.py --vault /abs/project/vault --web /abs/plugin/web [--port 0] [--project NAME]

It prints `RFT_SERVER_URL http://127.0.0.1:<port>/` once listening, and exits when its parent
process goes away (or, with --watch-stdin, closes its stdin).
"""
from __future__ import annotations

import argparse
import hashlib
import http.server
import json
import os
import re
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
    "/vendor/d3.v7.9.0.min.js": ("vendor/d3.v7.9.0.min.js", "text/javascript; charset=utf-8"),
    "/vendor/LICENSE-d3.txt": ("vendor/LICENSE-d3.txt", "text/plain; charset=utf-8"),
}
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "[::1]"}
ID_RE = re.compile(r"^[ED]\d+$")


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


def body_of(text: str) -> str:
    t = text.replace("\r\n", "\n")
    if not t.startswith("---\n"):
        return t
    end = t.find("\n---", 4)
    if end < 0:
        return t
    nl = t.find("\n", end + 4)
    return "" if nl < 0 else t[nl + 1:]


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


def link_target(value: str | None) -> str | None:
    m = re.search(r"\[\[([^\]|#]+)", value or "")
    return m.group(1).strip() if m else None


class Vault:
    """The tree read from the notes' `parent:` fields, cached until a note changes."""

    def __init__(self, root: Path, project: str):
        self.root = root.resolve()
        self.project = project
        self._lock = threading.Lock()
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
                              "tags": topical_tags(parse_tags(fm.get("tags")), self.project)}
                refs[nid] = link_target(fm.get("parent"))
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
        return {"project": self.project, "version": sig, "nodes": list(nodes.values()), "roots": roots, "tags": tags}

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
        text = path.read_text(encoding="utf-8", errors="replace")
        return {"id": nid, "name": path.name[:-3], "body": body_of(text)}


# ------------------------------------------------------------------ http

def make_handler(vault: Vault, web: Path):
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
            if route == "/api/note":
                nid = (parse_qs(url.query).get("id") or [""])[0]
                note = vault.note(nid)
                return self._json(200, note, head_only) if note else self._json(404, {"error": "no such note"}, head_only)
            return self._send(404, b"not found", "text/plain", head_only)

        def _refuse(self):
            self._send(405, b"read-only", "text/plain")

        do_POST = do_PUT = do_DELETE = do_PATCH = _refuse

    return Handler


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
    server = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(vault, Path(a.web)))
    server.daemon_threads = True
    if not a.no_watch:
        watch_parent(server, a.watch_stdin)
    print(f"RFT_SERVER_URL http://127.0.0.1:{server.server_address[1]}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
