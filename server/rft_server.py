#!/usr/bin/env python3
"""The rft web view's server: local, standard library only.

Serves the page (web/), the tree of the vault as JSON, and one note at a time with its
discussion, and writes: the body of a note, its frontmatter kept as it is (an edit, a footnote, an
accepted suggestion); the `locked:` line of its frontmatter; its `priority:` line, the user's
alone (which also answers Claude's `suggested_priority:`); its dates, the user's too (`due:`,
`start:`, `est:`, which also answer Claude's suggested ones); the deadlines in vault/milestones/
(a new one, its due date, the notes it needs, its status, and Claude's suggested ones accepted or
dismissed); and its discussion, the comments and suggestions on parts of its text, in
vault/.comments/<id>.json (as hooks/lib/comments.ts reads it). A new note, or a note's new type, it never writes itself: it asks the session that runs it,
with a line `RFT_ADD_NODE {"parent", "type", "title"}` or `RFT_SET_TYPE {"id", "type"}` on stdout,
and the plugin makes the change as the rft_add_node or rft_set_type tool does (no model turn), then
answers the note's id once it is on disk. `RFT_ASK {"id", "thread"}` asks the session's Claude to
answer a thread (a model turn). It binds 127.0.0.1 only, takes requests only for a loopback
host name (so a web page elsewhere cannot reach it through DNS rebinding), serves nothing but an
allow-list of page files, and reads or writes a note only by its id, in a markdown file that
resolves inside one of the vault's note folders (experiments/, directions/, references/,
theory/), and a deadline only in milestones/. A write (PUT api/note, POST api/node, api/type, api/comment, api/lock,
api/priority, api/dates, api/milestone) must also come from the page itself (its
Origin) and carry the vault's key, which is in the address the server prints, so neither
another web page nor another user of the machine can change a note. The key is kept in the
user's cache, readable by them alone, so it stays the same across restarts.

It also serves the images a note embeds (GET api/image?note=<id>&src=<as written>), found as
Obsidian finds them: by path, from the note's folder or the vault's top, else by name, nearest
the note, in the vault and then in the Obsidian vault around it (the folder that holds
`.obsidian/`). Only image files, and one outside the vault only for a request carrying the key.

    python3 rft_server.py --vault /abs/project/vault --web /abs/plugin/web [--port 0] [--project NAME]
        [--config /abs/project/.rft/config.json]   (read for `gpus:` and the last milestone id)

It prints `RFT_SERVER_URL http://127.0.0.1:<port>/?token=<key>` once listening, and exits when
its parent process goes away (or, with --watch-stdin, closes its stdin). When a fixed --port is
held by another session's server for the same vault, it prints that address, whose key is the
same, and takes the port over once that server stops; when something else holds it, it serves
on a free port instead.
"""
from __future__ import annotations

import argparse
import datetime
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

# the node types by folder (ID_RE below has their id letters), as TYPES in hooks/lib/vault.ts has them
SUBDIRS = {"experiments": "experiment", "directions": "direction", "references": "reference", "theory": "theory"}
TYPES = tuple(SUBDIRS.values())
PAGE_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
    "/filters.js": ("filters.js", "text/javascript; charset=utf-8"),
    "/kanban.js": ("kanban.js", "text/javascript; charset=utf-8"),
    "/schedule.js": ("schedule.js", "text/javascript; charset=utf-8"),
    "/layout.js": ("layout.js", "text/javascript; charset=utf-8"),
    "/concepts.js": ("concepts.js", "text/javascript; charset=utf-8"),
    "/theme.js": ("theme.js", "text/javascript; charset=utf-8"),
    "/markdown.js": ("markdown.js", "text/javascript; charset=utf-8"),
    "/vendor/d3.v7.9.0.min.js": ("vendor/d3.v7.9.0.min.js", "text/javascript; charset=utf-8"),
    "/vendor/LICENSE-d3.txt": ("vendor/LICENSE-d3.txt", "text/plain; charset=utf-8"),
    "/vendor/katex.v0.16.22.min.js": ("vendor/katex.v0.16.22.min.js", "text/javascript; charset=utf-8"),
    "/vendor/katex.v0.16.22.min.css": ("vendor/katex.v0.16.22.min.css", "text/css; charset=utf-8"),
    "/vendor/LICENSE-katex.txt": ("vendor/LICENSE-katex.txt", "text/plain; charset=utf-8"),
}
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "[::1]"}
ID_RE = re.compile(r"^[EDRT]\d+$")
MAX_NOTE_BYTES = 2_000_000
MAX_NODE_BYTES = 10_000
NODE_WAIT_S = 10.0  # how long a new note may take the session to make
SETTLE_S = 0.3  # how long the notes stay as they are before a new one counts as made
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
               ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".svg": "image/svg+xml"}
MAX_IMAGE_BYTES = 50_000_000
RESCAN_S = 5.0  # a name not found looks through the folders again at most this often
MAX_SCAN_FILES = 2_000_000  # the most files a search by name looks through
SKIP_DIRS = {"node_modules", "__pycache__"}  # with every dot folder: never searched by name
PAGE_CSP = ("default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; "
            "connect-src 'self'; frame-ancestors 'self'")
# an image runs nothing, even an SVG opened on its own
IMAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
# the discussion of each note: vault/.comments/<id>.json, a dot folder Obsidian leaves alone, as
# hooks/lib/comments.ts keeps it
COMMENTS = ".comments"
CONTEXT = 40  # the characters kept on each side of a thread's quote, to find it again
MAX_COMMENT_BYTES = 200_000
MAX_TEXT = 20_000  # the longest message, quote or replacement
KINDS = ("comment", "suggestion")
# a note's priority, highest first, the user's alone; at most this many open notes hold each (low:
# no limit). As PRIORITIES, PRIORITY_LIMITS and OPEN_STATUSES in hooks/lib/vault.ts have them.
PRIORITIES = ("urgent", "high", "medium", "low")
PRIORITY_LIMITS = {"urgent": 1, "high": 5, "medium": 10, "low": None}
OPEN_STATUSES = ("idea", "planned", "running")
SUGGESTION_FIELDS = ("suggested_priority", "suggested_priority_why")
# the deadlines, outside the tree, and the dates of a note: the user's alone. A due date is a day, a
# time and a zone, as DUE_RE in web/schedule.js reads it; an estimate whole days or weeks.
MILESTONES = "milestones"
MILESTONE_RE = re.compile(r"^M(\d+)$")
MILESTONE_STATUSES = ("open", "done", "suggested", "dismissed")
DAY_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
DUE_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?(?:\s*(AoE|UTC|Z|[+-]\d{2}:?\d{2}))?$", re.I)
EST_RE = re.compile(r"^(\d+)\s*([dw])?$", re.I)
DATE_FIELDS = ("due", "start", "est")
DATE_SUGGESTION_FIELDS = ("suggested_start", "suggested_est", "suggested_dates_why")
FORBIDDEN_TITLE = re.compile(r'[\^#|\[\]\\/:*"<>?]')


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


def priority_of(value: str | None) -> str:
    """A priority as written in the frontmatter, or "" when it is none of PRIORITIES."""
    v = unquote(value).lower()
    return v if v in PRIORITIES else ""


def is_locked(fm: dict[str, str]) -> bool:
    """A locked note is the user's to change: Claude only suggests changes to it."""
    return fm.get("locked", "").strip().strip("'\"").lower() in ("true", "yes")


def common_prefix(a: str, b: str) -> int:
    n = 0
    while n < len(a) and n < len(b) and a[n] == b[n]:
        n += 1
    return n


def common_suffix(a: str, b: str) -> int:
    n = 0
    while n < len(a) and n < len(b) and a[-1 - n] == b[-1 - n]:
        n += 1
    return n


def indexes(body: str, s: str) -> list[int]:
    """Every place `s` starts in `body`, overlapping ones too."""
    out, i = [], body.find(s)
    while i >= 0:
        out.append(i)
        i = body.find(s, i + 1)
    return out


def locate(body: str, quote: str, prefix: str, suffix: str) -> tuple[int, int, bool] | None:
    """Where a thread's quote is in a note's body: (start, end, exact). Of several occurrences, the
    one with the most of its context around it. When the quote is gone (the text was edited), not
    exact: the text between the end of what came before it and the start of what came after, when
    both are still there and close together; else, beside the one that is still there, text that
    begins (or ends) as the quote did, at least half of it; else None: the thread is detached. As
    locate() in hooks/lib/comments.ts."""
    best = None
    for i in indexes(body, quote) if quote else []:
        score = common_suffix(body[:i], prefix) + common_prefix(body[i + len(quote):], suffix)
        if best is None or score > best[0]:
            best = (score, i)
    if best:
        return best[1], best[1] + len(quote), True
    if not prefix and not suffix:
        return None
    head, tail = prefix[-24:], suffix[:24]
    starts = [0] if not prefix else [i + len(head) for i in indexes(body, head)]
    ends = [len(body)] if not suffix else indexes(body, tail)
    room = max(3 * len(quote), len(quote) + 120)
    pairs = [(abs((e - s) - len(quote)), s, e) for s in starts for e in ends if 0 <= e - s <= room]
    if pairs:
        _, s, e = min(pairs)
        return s, e, False
    need = max(4, (len(quote) + 1) // 2)
    sides = [(common_prefix(body[s:s + len(quote)], quote), s, s + len(quote)) for s in (starts if prefix else [])]
    sides += [(common_suffix(body[max(0, e - len(quote)):e], quote), max(0, e - len(quote)), e) for e in (ends if suffix else [])]
    sides = [x for x in sides if x[0] >= need]
    if not sides:
        return None
    _, s, e = max(sides, key=lambda x: (x[0], -x[1]))
    return s, e, False


def refreshed(body: str, threads: list[dict]) -> None:
    """The context of each open thread whose quote is still in the body as it was, taken anew from
    the body, so later edits around it leave enough to find it by."""
    for t in threads:
        if t.get("state") != "open":
            continue
        at = locate(body, str(t.get("quote") or ""), str(t.get("prefix") or ""), str(t.get("suffix") or ""))
        if at and at[2]:
            t["prefix"], t["suffix"] = body[max(0, at[0] - CONTEXT):at[0]], body[at[1]:at[1] + CONTEXT]


def stamp() -> str:
    """When a message is written, to the minute, local time."""
    return time.strftime("%Y-%m-%d %H:%M")


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


def topical_tags(tags: list[str], project: str, kind: str) -> list[str]:
    """The tags less the ones every note carries anyway: project, its own type, status."""
    out: list[str] = []
    for t in tags:
        if t not in out and t != project and t != kind and t not in STATUSES:
            out.append(t)
    return out


ROOT_CONCEPT = "root"


def unquote(value: str | None) -> str:
    v = (value or "").strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1]
    return v.strip()


def unquote_json(value: str | None) -> str:
    """A value written with JSON.stringify (escapes and all), or any other quoted or bare one."""
    v = (value or "").strip()
    if len(v) >= 2 and v[0] == v[-1] == '"':
        try:
            return str(json.loads(v)).strip()
        except ValueError:
            pass
    return unquote(v)


def parse_repos(value: str | None) -> list[str]:
    """The paths of a `concept_repos:` value, a one-line list: `["/a/b", "../c"]` (or YAML's
    `['/a/b', ../c]`). Commas alone separate: a path may hold spaces."""
    v = (value or "").strip()
    if not v:
        return []
    items: list = []
    try:
        x = json.loads(v)
        items = [p for p in x if isinstance(p, str)] if isinstance(x, list) else [x] if isinstance(x, str) else []
    except ValueError:
        items = (v[1:-1] if v.startswith("[") and v.endswith("]") else v).split(",")
    out: list[str] = []
    for p in items:
        p = unquote(p)
        if p and p not in out:
            out.append(p)
    return out


def compute_concepts(nodes: dict[str, dict], roots: list[str], project: str,
                     decl: dict[str, tuple], root_repos: dict[str, list[str]] | None = None) -> list[dict]:
    """Concepts, inherited down the tree: a note belongs to its nearest ancestor (or itself)
    declaring `concept:`, else to the project root concept. Sets each node's `concept` and
    returns the concepts depth first, the root concept first. When the only root note declares
    a concept, that concept is the root one: the project above it would hold no note.
    `decl`: name, summary and, optionally, the repos (`concept_repos:`) per declaring note;
    `root_repos`: the repos of notes that declare no concept, which count on the only root note
    alone, as the project's."""
    def make(cid, name, summary, root, parent, depth, repos=()):
        return {"id": cid, "name": name, "summary": summary, "root": root, "parent": parent, "children": [],
                "depth": depth, "count": 0, "total": 0, "statuses": {}, "repos": list(repos)}

    def parts(d):
        return d[0], d[1], (list(d[2]) if len(d) > 2 else [])

    only = roots[0] if len(roots) == 1 and roots[0] in nodes else None
    top = only if only in decl else None
    if top:
        concepts = {ROOT_CONCEPT: make(ROOT_CONCEPT, *parts(decl[top])[:2], top, None, 0, parts(decl[top])[2])}
    else:
        concepts = {ROOT_CONCEPT: make(ROOT_CONCEPT, project, "", None, None, 0, (root_repos or {}).get(only, []))}
    stack = [(r, ROOT_CONCEPT) for r in reversed(roots)]
    while stack:
        nid, current = stack.pop()
        n = nodes.get(nid)
        if n is None:
            continue
        if nid in decl and nid != top:
            name, summary, repos = parts(decl[nid])
            concepts[nid] = make(nid, name, summary, nid, current, concepts[current]["depth"] + 1, repos)
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


def day_of(value: str | None) -> str | None:
    """The day `value` names (YYYY-MM-DD, one of the calendar), or None."""
    v = unquote(value)
    m = DAY_RE.match(v)
    if not m:
        return None
    try:
        datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None
    return v


def due_ok(value: str | None) -> bool:
    """Whether `value` is a due date: a day, with a time and a zone when given."""
    m = DUE_RE.match(unquote(value))
    return bool(m) and day_of(m.group(1)) is not None and (m.group(2) is None or (int(m.group(2)) <= 23 and int(m.group(3)) <= 59))


def est_of(value: str | None) -> int | None:
    """An estimate in whole days (3d, 2w, 4), or None."""
    m = EST_RE.match(unquote(value))
    days = int(m.group(1)) * (7 if (m.group(2) or "").lower() == "w" else 1) if m else 0
    return days or None


def count_of(value: str | None) -> int | None:
    v = unquote(value)
    return int(v) if v.isdigit() and int(v) > 0 else None


def clean_title(title: str) -> str:
    return re.sub(r"\s+", " ", FORBIDDEN_TITLE.sub(" ", title)).strip(" .,-")[:100].strip()


def link_target(value: str | None) -> str | None:
    m = re.search(r"\[\[([^\]|#]+)", value or "")
    return m.group(1).strip() if m else None


def link_targets(value: str | None) -> list[str]:
    return [m.strip() for m in re.findall(r"\[\[([^\]|#]+)", value or "")]
def obsidian_root(folder: Path) -> Path | None:
    """The Obsidian vault the folder is in: the nearest folder, itself or above, holding `.obsidian/`."""
    return next((d for d in (folder, *folder.parents) if (d / ".obsidian").is_dir()), None)


def is_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_TYPES


def distance(a: Path, b: Path) -> int:
    """The steps from folder `a` to folder `b`: up to their common folder, then down."""
    common = 0
    for x, y in zip(a.parts, b.parts):
        if x != y:
            break
        common += 1
    return len(a.parts) + len(b.parts) - 2 * common


class Vault:
    """The tree read from the notes' `parent:` fields, cached until a note changes."""

    def __init__(self, root: Path, project: str, config: Path | None = None):
        self.root = root.resolve()
        self.project = project
        self.config = config
        # tells two servers of the same vault apart from others, without saying where it is
        self.ident = hashlib.sha256(str(self.root).encode()).hexdigest()[:16]
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._ask_lock = threading.Lock()
        self._sig: str | None = None
        self._tree: dict | None = None
        # the folders an image is searched in by name: the vault, then the Obsidian vault around it
        outer = obsidian_root(self.root)
        self.image_tops = [self.root] + ([outer] if outer and outer != self.root else [])
        self._names: dict[Path, tuple[float, dict[str, list[tuple[str, str]]]]] = {}
        self._names_lock = threading.Lock()

    def signature(self) -> str:
        parts = []
        for sub in SUBDIRS:
            d = self.root / sub
            if d.is_dir():
                for f in sorted(d.glob("*.md")):
                    st = f.stat()
                    parts.append(f"{sub}/{f.name}:{st.st_mtime_ns}:{st.st_size}")
        for sub, pattern in ((COMMENTS, "*.json"), (MILESTONES, "*.md")):
            d = self.root / sub
            if d.is_dir():
                for f in sorted(d.glob(pattern)):
                    st = f.stat()
                    parts.append(f"{sub}/{f.name}:{st.st_mtime_ns}:{st.st_size}")
        if self.config and self.config.is_file():
            st = self.config.stat()
            parts.append(f"config:{st.st_mtime_ns}:{st.st_size}")
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
        origins: dict[str, list[str]] = {}
        refs_of: dict[str, list[str]] = {}
        superseded: dict[str, list[str]] = {}
        decl: dict[str, tuple[str, str, list[str]]] = {}
        repos_only: dict[str, list[str]] = {}
        after_of: dict[str, list[str]] = {}
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
                ftype = fm.get("type") if fm.get("type") in TYPES else kind
                nodes[nid] = {"id": nid, "name": name, "title": name[len(id_of(name)):].strip(),
                              "type": ftype, "status": fm.get("status", ""), "date": fm.get("date", ""),
                              "parent": None, "children": [], "path": f"{sub}/{f.name}",
                              "tags": topical_tags(parse_tags(fm.get("tags")), self.project, ftype),
                              "concept": ROOT_CONCEPT, "locked": is_locked(fm), "threads": 0}
                refs[nid] = link_target(fm.get("parent"))
                origins[nid] = link_targets(fm.get("origin"))
                refs_of[nid] = link_targets(fm.get("refs"))
                newer = link_target(fm.get("superseded_by"))
                superseded[nid] = [newer] if newer else []
                summary = unquote_json(fm.get("summary"))
                if summary:
                    nodes[nid]["summary"] = summary
                if priority_of(fm.get("priority")):
                    nodes[nid]["priority"] = priority_of(fm.get("priority"))
                if priority_of(fm.get("suggested_priority")):
                    nodes[nid]["suggestedPriority"] = priority_of(fm.get("suggested_priority"))
                    why = unquote_json(fm.get("suggested_priority_why"))
                    if why:
                        nodes[nid]["suggestedWhy"] = why
                pdf = link_target(fm.get("pdf"))
                if pdf:
                    nodes[nid]["pdf"] = pdf
                # the dates, as hooks/lib/vault.ts reads them: values that are none are left out
                plan = {"due": unquote(fm.get("due")) if due_ok(fm.get("due")) else None,
                        "start": day_of(fm.get("start")), "est": est_of(fm.get("est")),
                        "started": day_of(fm.get("started")), "finished": day_of(fm.get("finished")),
                        "gpus": count_of(fm.get("gpus")), "suggestedStart": day_of(fm.get("suggested_start")),
                        "suggestedEst": est_of(fm.get("suggested_est"))}
                if plan["suggestedStart"] or plan["suggestedEst"]:
                    plan["suggestedDatesWhy"] = unquote_json(fm.get("suggested_dates_why")) or None
                nodes[nid].update({k: v for k, v in plan.items() if v})
                after_of[nid] = link_targets(fm.get("after"))
                cname = unquote(fm.get("concept"))
                repos = parse_repos(fm.get("concept_repos"))
                if cname:
                    decl[nid] = (cname, unquote(fm.get("concept_summary")), repos)
                elif repos:
                    repos_only[nid] = repos
        for n in nodes.values():
            n["threads"] = sum(1 for t in self._threads(n["id"])["threads"] if t.get("state") == "open")
        by_name = {n["name"]: n["id"] for n in nodes.values()}

        def ids(names):
            return [i for i in (by_name.get(r) or (id_of(r) if id_of(r) in nodes else None) for r in names) if i]

        for n in nodes.values():
            for key, names in (("origin", origins), ("refs", refs_of)):
                found = ids(names.get(n["id"], []))
                if found:
                    n[key] = found
            newer = ids(superseded.get(n["id"], []))
            if newer and newer[0] != n["id"]:
                n["supersededBy"] = newer[0]
            after = [i for i in ids(after_of.get(n["id"], [])) if i != n["id"]]
            if after:
                n["after"] = after
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
        concepts = compute_concepts(nodes, roots, self.project, decl, repos_only)
        milestones = self._milestones(by_name, nodes)
        return {"project": self.project, "version": sig, "nodes": list(nodes.values()), "roots": roots, "tags": tags,
                "concepts": concepts, "milestones": milestones, "gpus": self._config().get("gpus") if count_of(str(self._config().get("gpus", ""))) else None}

    def _config(self) -> dict:
        """The project's .rft/config.json, or {} when there is none to read."""
        try:
            data = json.loads(self.config.read_text(encoding="utf-8")) if self.config else {}
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _milestones(self, by_name: dict[str, str], nodes: dict[str, dict]) -> list[dict]:
        """The deadlines in milestones/: due date as written, status, the notes they need by id and
        the names that are none, as hooks/lib/vault.ts loads them."""
        out: list[dict] = []
        d = self.root / MILESTONES
        if not d.is_dir():
            return out
        for f in sorted(d.glob("*.md"), key=lambda p: natural_key(p.name)):
            fm = front(f.read_text(encoding="utf-8", errors="replace"))
            name = f.name[:-3]
            mid = unquote(fm.get("id")) or id_of(name)
            if any(m["id"] == mid for m in out):
                continue
            needs, missing = [], []
            for ref in link_targets(fm.get("needs")):
                nid = by_name.get(ref) or (id_of(ref) if id_of(ref) in nodes else None)
                if nid and nid not in needs:
                    needs.append(nid)
                elif not nid:
                    missing.append(ref)
            m = {"id": mid, "name": name, "title": name[len(id_of(name)):].strip(), "path": f"{MILESTONES}/{f.name}",
                 "status": unquote(fm.get("status")).lower() or "open", "due": unquote(fm.get("due")),
                 "needs": needs, "missing": missing}
            if unquote(fm.get("source")):
                m["source"] = unquote(fm.get("source"))
            if unquote_json(fm.get("why")):
                m["why"] = unquote_json(fm.get("why"))
            out.append(m)
        return out

    def note_path(self, nid: str) -> Path | None:
        """The note's file, only when it resolves to a markdown file inside a note folder (SUBDIRS)."""
        if not ID_RE.match(nid or ""):
            return None
        node = next((n for n in self.tree()["nodes"] if n["id"] == nid), None)
        if node is None:
            return None
        path = (self.root / node["path"]).resolve()
        allowed = [(self.root / s).resolve() for s in SUBDIRS]
        inside = any(path.parent == a for a in allowed)
        return path if inside and path.suffix == ".md" and path.is_file() else None

    def paper(self, nid: str) -> Path | None:
        """The PDF a reference note links (`pdf:`), only when it is a PDF file in the vault's papers/."""
        if not ID_RE.match(nid or ""):
            return None
        node = next((n for n in self.tree()["nodes"] if n["id"] == nid), None)
        if not node or not node.get("pdf"):
            return None
        path = (self.root / node["pdf"]).resolve()
        papers = (self.root / "papers").resolve()
        return path if papers in path.parents and path.suffix.lower() == ".pdf" and path.is_file() else None

    def note(self, nid: str) -> dict | None:
        """A note as the page shows it: its body, version, whether it is locked, and its threads,
        each placed in the body as it is now (`at`: [start, end], or None when detached)."""
        path = self.note_path(nid)
        if path is None:
            return None
        data = path.read_bytes()
        text = data.decode("utf-8", errors="replace")
        body = body_of(text)
        threads = []
        for t in self._threads(nid)["threads"]:
            at = locate(body, str(t.get("quote") or ""), str(t.get("prefix") or ""), str(t.get("suffix") or ""))
            threads.append({**t, "at": [at[0], at[1]] if at else None, "exact": bool(at and at[2])})
        return {"id": nid, "name": path.name[:-3], "body": body, "version": version_of(data),
                "locked": is_locked(front(text)), "threads": threads}

    def inside(self, path: Path) -> bool:
        return self.root in path.parents

    def image(self, nid: str, src: str) -> Path | None:
        """The image file note `nid` embeds as `src` (`![[src]]` or `![](src)`), resolved, as
        Obsidian finds it: a path on disk; else from the note's folder, the vault's top or the
        Obsidian vault's; else by name, the file whose path ends as `src` does that lies nearest
        the note, first in the vault, then in the Obsidian vault. None when there is none."""
        note = self.note_path(nid)
        src = (src or "").strip()
        if note is None or not src or "\x00" in src or len(src) > 4096:
            return None
        if src.lower().startswith("file://"):
            src = src[len("file://"):]
        if not is_image(Path(src)):
            return None
        inner = src.lstrip("/")  # Obsidian reads `/a.png` from its vault's top
        tries = ([Path(src)] if Path(src).is_absolute() else []) + [note.parent / inner, *(t / inner for t in self.image_tops)]
        parts = [p for p in Path(inner).parts if p not in (".", "..")]
        try:
            found = next((p for p in tries if p.is_file()), None)
            for top in self.image_tops if parts else ():
                found = found or self._by_name(top, parts, note.parent)
            path = found.resolve() if found else None
        except OSError:  # a name too long, a folder it may not read
            return None
        # a link named .png that leads to anything else is not an image
        return path if path and is_image(path) else None

    def _by_name(self, top: Path, parts: list[str], near: Path) -> Path | None:
        """The image under `top` whose path ends in `parts`, nearest folder `near`."""
        want = [p.lower() for p in parts]
        for fresh in (False, True):
            hits = []
            for folder, name in self._image_names(top, fresh).get(want[-1], []):
                f = Path(folder)
                tail = f.parts[len(f.parts) - (len(want) - 1):] if len(want) > 1 else ()
                if [x.lower() for x in tail] == want[:-1] and (f / name).is_file():
                    hits.append(f / name)
            if hits:
                return min(hits, key=lambda p: (distance(near, p.parent), str(p)))
        return None

    def _image_names(self, top: Path, fresh: bool) -> dict[str, list[tuple[str, str]]]:
        """The image files under `top` by lowercase name, kept until a name is not found
        (`fresh`): then looked for again, in the vault at once (an image just pasted), in the
        Obsidian vault, often far larger, once the last look is older than RESCAN_S. Dot
        folders, SKIP_DIRS and links to folders are left out."""
        with self._names_lock:
            kept = self._names.get(top)
            wait = 0 if top == self.root else RESCAN_S
            if kept and (not fresh or time.monotonic() - kept[0] < wait):
                return kept[1]
            names: dict[str, list[tuple[str, str]]] = {}
            seen = 0
            for folder, dirs, files in os.walk(top):
                dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in SKIP_DIRS)
                for f in files:
                    if os.path.splitext(f)[1].lower() in IMAGE_TYPES:
                        names.setdefault(f.lower(), []).append((folder, f))
                seen += len(files)
                if seen > MAX_SCAN_FILES:
                    break
            self._names[top] = (time.monotonic(), names)
            return names

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
            out = self._write_note(path, text, head, body)
            data = self._threads(nid)
            if data["threads"]:
                refreshed(split_note(out.decode("utf-8"))[1], data["threads"])
                self._save_threads(nid, data)
        return 200, {"id": nid, "version": version_of(out)}

    @staticmethod
    def _write_note(path: Path, text: str, head: str, body: str) -> bytes:
        """Writes `head` + `body` over the note whose text was `text`, in its newlines."""
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
        return out

    def set_locked(self, nid: str, locked: bool) -> tuple[int, dict]:
        """Locks a note (`locked: true` in its frontmatter: Claude may only suggest changes to it) or
        unlocks it; the rest of the file stays as it is."""
        path = self.note_path(nid)
        if path is None:
            return 404, {"error": "no such note"}
        with self._write_lock:
            try:
                text = path.read_bytes().decode("utf-8")
            except UnicodeDecodeError:
                return 422, {"error": "the note is not UTF-8 text; edit it in an editor"}
            head, body = split_note(text)
            if not head:
                return 422, {"error": "the note has no frontmatter"}
            lines = head.rstrip("\n").split("\n")  # ---, the fields, ---
            fields = [l for l in lines[1:-1] if not re.match(r"locked\s*:", l)]
            if locked:
                fields.append("locked: true")
            self._write_note(path, text, "\n".join([lines[0], *fields, lines[-1]]) + "\n", body)
        return 200, self.note(nid)

    def set_priority(self, nid: str, priority: str | None, dismiss: bool = False) -> tuple[int, dict]:
        """Sets a note's priority (`priority:` after its status; None takes it away), which the
        user alone sets, and drops Claude's suggested priority, now answered; with `dismiss`, drops
        only the suggestion. Refused, naming them, when the open notes holding that priority are
        at its limit and the note is open too (a note that is done or dropped does not count)."""
        path = self.note_path(nid)
        if path is None:
            return 404, {"error": "no such note"}
        with self._write_lock:
            if priority is not None and not dismiss:
                nodes = self.tree()["nodes"]
                me = next((n for n in nodes if n["id"] == nid), None)
                limit = PRIORITY_LIMITS[priority]
                if me and limit is not None and me["status"] in OPEN_STATUSES and me.get("priority") != priority:
                    held = sorted((n["id"] for n in nodes
                                   if n["id"] != nid and n["status"] in OPEN_STATUSES and n.get("priority") == priority),
                                  key=natural_key)
                    if len(held) >= limit:
                        return 409, {"error": f"{priority} is full: {', '.join(held)} already "
                                              f"{'holds' if len(held) == 1 else 'hold'} it (at most {limit} open "
                                              f"note{'' if limit == 1 else 's'}). Lower one of them first.",
                                     "holders": held}
            try:
                text = path.read_bytes().decode("utf-8")
            except UnicodeDecodeError:
                return 422, {"error": "the note is not UTF-8 text; edit it in an editor"}
            head, body = split_note(text)
            if not head:
                return 422, {"error": "the note has no frontmatter"}
            lines = head.rstrip("\n").split("\n")  # ---, the fields, ---
            drop = SUGGESTION_FIELDS if dismiss else ("priority", *SUGGESTION_FIELDS)
            fields = [l for l in lines[1:-1] if not re.match(rf"(?:{'|'.join(drop)})\s*:", l)]
            if priority is not None and not dismiss:
                at = next((i + 1 for i, l in enumerate(fields) if re.match(r"status\s*:", l)), len(fields))
                fields.insert(at, f"priority: {priority}")
            self._write_note(path, text, "\n".join([lines[0], *fields, lines[-1]]) + "\n", body)
        return 200, {"id": nid, "priority": None if dismiss else priority}

    # ------------------------------------------------------------ dates and deadlines

    @staticmethod
    def _fields(text: str) -> tuple[list[str], str, str] | None:
        """A note's frontmatter lines (without the ---), its first and last line, and its body."""
        head, body = split_note(text)
        if not head:
            return None
        lines = head.rstrip("\n").split("\n")
        return lines[1:-1], "\n".join([lines[0], "%s", lines[-1]]) + "\n", body

    def set_dates(self, nid: str, changes: dict, dismiss: bool = False) -> tuple[int, dict]:
        """Sets a note's dates, which the user alone sets: `due` (any note), `start` and `est` (an
        experiment), each a value or None to take it away, after its status; and drops Claude's
        suggested dates, now answered. With `dismiss`, drops only the suggestion."""
        path = self.note_path(nid)
        if path is None:
            return 404, {"error": "no such note"}
        node = next(n for n in self.tree()["nodes"] if n["id"] == nid)
        for key, value in changes.items():
            if value is None:
                continue
            if key == "due" and not due_ok(value):
                return 400, {"error": "due must be a date: 2026-11-13, 2026-11-13 23:59 or 2026-11-13 23:59 AoE"}
            if key == "start" and not day_of(value):
                return 400, {"error": "start must be a date: 2026-11-27"}
            if key == "est" and not est_of(value):
                return 400, {"error": "est must be a number of days or weeks: 3d, 2w"}
            if key in ("start", "est") and node["type"] != "experiment":
                return 422, {"error": f"only experiments have a start and an estimate; {nid} is a {node['type']}"}
        with self._write_lock:
            try:
                text = path.read_bytes().decode("utf-8")
            except UnicodeDecodeError:
                return 422, {"error": "the note is not UTF-8 text; edit it in an editor"}
            parts = self._fields(text)
            if parts is None:
                return 422, {"error": "the note has no frontmatter"}
            fields, frame, body = parts
            drop = DATE_SUGGESTION_FIELDS if dismiss else (*changes.keys(), *DATE_SUGGESTION_FIELDS)
            fields = [l for l in fields if not re.match(rf"(?:{'|'.join(drop)})\s*:", l)]
            at = next((i + 1 for i, l in enumerate(fields) if re.match(r"status\s*:", l)), len(fields))
            new = [f"{k}: {changes[k].strip()}" for k in DATE_FIELDS if not dismiss and changes.get(k) is not None]
            fields[at:at] = new
            self._write_note(path, text, frame % "\n".join(fields), body)
        return 200, {"id": nid, **({} if dismiss else changes)}

    def milestone_path(self, mid: str) -> Path | None:
        """A deadline's file, only when it resolves to a markdown file in milestones/."""
        if not MILESTONE_RE.match(mid or ""):
            return None
        m = next((x for x in self.tree()["milestones"] if x["id"] == mid), None)
        if m is None:
            return None
        path = (self.root / m["path"]).resolve()
        return path if path.parent == (self.root / MILESTONES).resolve() and path.suffix == ".md" and path.is_file() else None

    def _needs_line(self, needs) -> tuple[str | None, str | None]:
        """The `needs:` line for these note ids (None: no line), or an error."""
        if not isinstance(needs, list) or not all(isinstance(x, str) for x in needs):
            return None, "needs must be a list of note ids"
        names = {n["id"]: n["name"] for n in self.tree()["nodes"]}
        unknown = [x for x in needs if x not in names]
        if unknown:
            return None, f"needs: {', '.join(unknown)} {'is' if len(unknown) == 1 else 'are'} not a note of the tree"
        ids = list(dict.fromkeys(needs))
        return (f"needs: [{', '.join(json.dumps(f'[[{names[x]}]]') for x in ids)}]" if ids else None), None

    def add_milestone(self, title: str, due: str, needs) -> tuple[int, dict]:
        """A new deadline the user adds, open: the next free M id (after the config's last one and
        every milestone on disk), in milestones/."""
        title = clean_title(title)
        if not title:
            return 400, {"error": "give the deadline a title"}
        if not due_ok(due):
            return 400, {"error": "due must be a date: 2026-11-13, 2026-11-13 23:59 or 2026-11-13 23:59 AoE"}
        line, err = self._needs_line(needs if needs is not None else [])
        if err:
            return 400, {"error": err}
        with self._write_lock:
            last = self._config().get("lastId", {}).get("M", 0) if isinstance(self._config().get("lastId"), dict) else 0
            taken = [int(m.group(1)) for x in self.tree()["milestones"] if (m := MILESTONE_RE.match(x["id"]))]
            num = max([last if isinstance(last, int) else 0, *taken]) + 1
            mid = f"M{num:02d}"
            d = self.root / MILESTONES
            d.mkdir(exist_ok=True)
            path = d / f"{mid} {title}.md"
            fields = [f"id: {mid}", "type: milestone", "status: open", f"due: {due.strip()}"] + ([line] if line else [])
            path.write_text("---\n" + "\n".join(fields) + f"\n---\n\n# {mid} · {title}\n", encoding="utf-8")
        return 201, {"id": mid, "name": f"{mid} {title}"}

    def update_milestone(self, mid: str, req: dict) -> tuple[int, dict]:
        """Changes a deadline: its `due`, the notes it `needs` (ids), its `status`; or answers Claude's
        suggested one, `accept` (it becomes open) or `dismiss` (it stays, dismissed, so it is not
        suggested again)."""
        path = self.milestone_path(mid)
        if path is None:
            return 404, {"error": "no such deadline"}
        changes: dict[str, str | None] = {}
        if req.get("accept") is True:
            changes["status"] = "status: open"
        elif req.get("dismiss") is True:
            changes["status"] = "status: dismissed"
        if "status" in req:
            if req["status"] not in ("open", "done", "dismissed"):
                return 400, {"error": "status must be open, done or dismissed"}
            changes["status"] = f"status: {req['status']}"
        if "due" in req:
            if not isinstance(req["due"], str) or not due_ok(req["due"]):
                return 400, {"error": "due must be a date: 2026-11-13, 2026-11-13 23:59 or 2026-11-13 23:59 AoE"}
            changes["due"] = f"due: {req['due'].strip()}"
        if "needs" in req:
            line, err = self._needs_line(req["needs"])
            if err:
                return 400, {"error": err}
            changes["needs"] = line
        if not changes:
            return 400, {"error": "nothing to change: give due, needs or status, or accept or dismiss"}
        with self._write_lock:
            text = path.read_text(encoding="utf-8")
            parts = self._fields(text)
            if parts is None:
                return 422, {"error": "the deadline has no frontmatter"}
            fields, frame, body = parts
            for key, line in changes.items():
                at = next((i for i, l in enumerate(fields) if re.match(rf"{key}\s*:", l)), None)
                if at is not None:
                    if line is None:
                        del fields[at]
                    else:
                        fields[at] = line
                elif line is not None:
                    after = next((i + 1 for i, l in enumerate(fields) if re.match(r"(due|status)\s*:", l)), len(fields))
                    fields.insert(after, line)
            self._write_note(path, text, frame % "\n".join(fields), body)
        return 200, {"id": mid}

    # ------------------------------------------------------------ comments and suggestions

    def _comments_file(self, nid: str) -> Path:
        return self.root / COMMENTS / f"{nid}.json"

    def _threads(self, nid: str) -> dict:
        """The note's comments file: {note, next, threads}; empty when there is none, or it is unreadable."""
        try:
            data = json.loads(self._comments_file(nid).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        threads = [t for t in data.get("threads", []) if isinstance(t, dict) and isinstance(t.get("id"), str)] \
            if isinstance(data, dict) else []
        last = max([int(t["id"][1:]) for t in threads if re.fullmatch(r"c\d+", t["id"])] + [0])
        nxt = data.get("next") if isinstance(data, dict) and isinstance(data.get("next"), int) else 0
        return {"note": nid, "next": max(nxt, last + 1), "threads": threads}

    def _save_threads(self, nid: str, data: dict) -> None:
        path = self._comments_file(nid)
        path.parent.mkdir(exist_ok=True)
        tmp = path.with_name(f".{path.name}.rft-tmp")
        try:
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)

    def comment(self, nid: str, req: dict, ask) -> tuple[int, dict]:
        """One change to a note's discussion, by the user. `action`:
        new {kind: comment|suggestion, quote, prefix, suffix, text, replacement?}: a thread on the
          quote, found in the note as it is now (a replacement equal to the quote, or none, makes a
          suggestion an instruction, for Claude to write);
        reply {thread, text}; resolve {thread}: a comment settled; reopen {thread};
        accept {thread}: a suggestion's replacement written into the note, when the quote is still
          there as it was; reject {thread};
        ask {thread}: the session that runs the server asked to answer it (a model turn).
        The answer is the note as api/note gives it."""
        path = self.note_path(nid)
        if path is None:
            return 404, {"error": "no such note"}
        action = req.get("action")
        strs = lambda *ks: all(isinstance(req.get(k), str) for k in ks)
        too_long = any(isinstance(req.get(k), str) and len(req[k]) > MAX_TEXT for k in ("text", "quote", "replacement"))
        if too_long:
            return 413, {"error": f"a message, quote or replacement holds at most {MAX_TEXT} characters"}
        with self._write_lock:
            data = self._threads(nid)
            text = path.read_bytes().decode("utf-8", errors="replace")
            head, body = split_note(text)
            now = stamp()
            if action == "new":
                if req.get("kind") not in KINDS or not strs("quote", "text") or not req["quote"].strip():
                    return 400, {"error": "expected {kind: comment or suggestion, quote, prefix, suffix, text}"}
                kind, quote, message = req["kind"], req["quote"], req["text"].strip()
                repl = req.get("replacement") if isinstance(req.get("replacement"), str) else None
                if repl is not None and repl == quote:
                    repl = None
                if kind == "comment" and not message:
                    return 400, {"error": "write the comment"}
                if kind == "suggestion" and repl is None and not message:
                    return 400, {"error": "change the text, or say what should change"}
                at = locate(body, quote, str(req.get("prefix") or ""), str(req.get("suffix") or ""))
                if not at or not at[2]:
                    return 409, {"error": "the text you selected is no longer in the note: select it again", **self.note(nid)}
                s, e, _ = at
                data["threads"].append({
                    "id": f"c{data['next']}", "kind": kind, "state": "open", "quote": quote,
                    "prefix": body[max(0, s - CONTEXT):s], "suffix": body[e:e + CONTEXT],
                    "replacement": repl if kind == "suggestion" else None, "asked": None,
                    "messages": [{"by": "you", "at": now, "text": message}] if message else [], "closed": None})
                data["next"] += 1
            else:
                t = next((x for x in data["threads"] if x["id"] == req.get("thread")), None)
                if t is None:
                    return 404, {"error": "no such thread"}
                is_open = t.get("state") == "open"
                if action == "reply":
                    if not strs("text") or not req["text"].strip():
                        return 400, {"error": "write the reply"}
                    if not is_open:
                        return 409, {"error": "the thread is closed: reopen it first", **self.note(nid)}
                    t.setdefault("messages", []).append({"by": "you", "at": now, "text": req["text"].strip()})
                elif action in ("resolve", "reject"):
                    if not is_open:
                        return 409, {"error": "the thread is already closed", **self.note(nid)}
                    if (action == "resolve") != (t.get("kind") == "comment"):
                        return 400, {"error": "a comment is resolved; a suggestion is accepted or rejected"}
                    t["state"], t["closed"], t["asked"] = ("resolved" if action == "resolve" else "rejected"), {"by": "you", "at": now}, None
                elif action == "reopen":
                    if is_open:
                        return 409, {"error": "the thread is open", **self.note(nid)}
                    t["state"], t["closed"] = "open", None
                elif action == "accept":
                    if t.get("kind") != "suggestion" or not is_open:
                        return 400, {"error": "only an open suggestion is accepted"}
                    if not isinstance(t.get("replacement"), str):
                        return 409, {"error": "the suggestion has no replacement yet: ask Claude to write one, or reply", **self.note(nid)}
                    at = locate(body, str(t.get("quote") or ""), str(t.get("prefix") or ""), str(t.get("suffix") or ""))
                    if not at or not at[2]:
                        return 409, {"error": "the text changed since the suggestion was made: reject it, or ask Claude for a new one", **self.note(nid)}
                    s, e, _ = at
                    body = body[:s] + t["replacement"] + body[e:]
                    self._write_note(path, text, head, body)
                    t["state"], t["closed"], t["asked"] = "accepted", {"by": "you", "at": now}, None
                elif action == "ask":
                    if not is_open:
                        return 409, {"error": "the thread is closed: reopen it first", **self.note(nid)}
                    try:
                        ask("RFT_ASK", {"id": nid, "thread": t["id"]})
                    except (OSError, ValueError):
                        return 503, {"error": "the Claude Code session that ran /rft is gone"}
                    t["asked"] = now
                else:
                    return 400, {"error": "action must be new, reply, resolve, reopen, accept, reject or ask"}
            refreshed(body.replace("\r\n", "\n"), data["threads"])
            self._save_threads(nid, data)
        return 200, self.note(nid)

    def _wait(self, found) -> dict | None:
        """The note `found` picks out of the tree's nodes once the session has made the change,
        answered once the notes are quiet; None when NODE_WAIT_S passes first."""
        deadline = time.monotonic() + NODE_WAIT_S
        while time.monotonic() < deadline:
            time.sleep(0.1)
            n = found(self.tree()["nodes"])
            if n:
                # the session goes on to write the notes' derived fields, the new one's `up:` too:
                # answered once the notes are quiet, so the page opens the note as it then stays
                sig, quiet = self.signature(), time.monotonic()
                while time.monotonic() - quiet < SETTLE_S and time.monotonic() < deadline:
                    time.sleep(0.1)
                    if (now := self.signature()) != sig:
                        sig, quiet = now, time.monotonic()
                return n
        return None

    def add_node(self, parent: str, kind: str, title: str, ask) -> tuple[int, dict]:
        """A new note under `parent`, made by the session: `ask` hands it the request, and the
        answer is the note's id once it is on disk. One request at a time, so each finds its own."""
        if kind not in TYPES:
            return 400, {"error": f"type must be one of {', '.join(TYPES)}"}
        if not re.search(r"\w", title):
            return 400, {"error": "the title needs a letter or a digit"}
        with self._ask_lock:
            before = {n["id"] for n in self.tree()["nodes"]}
            if parent not in before:
                return 404, {"error": "no such parent note"}
            try:
                ask("RFT_ADD_NODE", {"parent": parent, "type": kind, "title": title})
            except (OSError, ValueError):
                return 503, {"error": "the Claude Code session that ran /rft is gone"}

            def found(nodes):
                new = [n for n in nodes if n["id"] not in before and n["parent"] == parent and n["type"] == kind]
                return next((n for n in new if n["title"] == " ".join(title.split())), new[0]) if new else None

            n = self._wait(found)
            if n:
                return 201, {"id": n["id"], "name": n["name"]}
        return 504, {"error": f"the Claude Code session did not add the note within {NODE_WAIT_S:g} s; "
                              "it may still appear (is the session that ran /rft still open?)"}
    
    def set_type(self, nid: str, kind: str, ask) -> tuple[int, dict]:
        """A note's type changed by the session, which gives it the next id of the type, moves its
        file and renames the links to it: the answer is the new id once the old note is gone."""
        if kind not in TYPES:
            return 400, {"error": f"type must be one of {', '.join(TYPES)}"}
        with self._ask_lock:
            before = {n["id"]: n for n in self.tree()["nodes"]}
            old = before.get(nid)
            if old is None:
                return 404, {"error": "no such note"}
            if old["type"] == kind:
                return 400, {"error": f"the note is already of type {kind}"}
            if old["parent"] is None and kind != "direction":
                return 400, {"error": "the root of the tree stays a direction"}
            try:
                ask("RFT_SET_TYPE", {"id": nid, "type": kind})
            except (OSError, ValueError):
                return 503, {"error": "the Claude Code session that ran /rft is gone"}

            def found(nodes):
                if any(n["id"] == nid for n in nodes):
                    return None
                return next((n for n in nodes if n["id"] not in before and n["type"] == kind
                             and n["title"] == old["title"]), None)

            n = self._wait(found)
            if n:
                return 200, {"id": n["id"], "name": n["name"]}
        return 504, {"error": f"the Claude Code session did not change the note's type within {NODE_WAIT_S:g} s; "
                              "it may still change (is the session that ran /rft still open?)"}


    def move_node(self, nid: str, parent: str, ask, unlock: bool = False) -> tuple[int, dict]:
        """Moves a note and its subtree under `parent`, done by the session as for add_node; the
        answer comes once the note's parent is the new one and the notes are quiet. `unlock`: the
        user agreed in the page to unlock a locked note, which the move then unlocks."""
        with self._ask_lock:
            nodes = {n["id"]: n for n in self.tree()["nodes"]}
            if nid not in nodes or parent not in nodes:
                return 404, {"error": "no such note"}
            if not nodes[nid]["parent"]:
                return 400, {"error": "the root of the tree cannot move"}
            if nodes[nid]["parent"] == parent:
                return 400, {"error": "the note is already there"}
            p = parent
            while p:
                if p == nid:
                    return 400, {"error": "a note cannot move under its own subtree"}
                p = nodes[p]["parent"] if p in nodes else None
            try:
                ask("RFT_MOVE_NODE", {"id": nid, "parent": parent, **({"unlock": True} if unlock else {})})
            except (OSError, ValueError):
                return 503, {"error": "the Claude Code session that ran /rft is gone"}
            deadline = time.monotonic() + NODE_WAIT_S
            while time.monotonic() < deadline:
                time.sleep(0.1)
                now = next((n for n in self.tree()["nodes"] if n["id"] == nid), None)
                if now and now["parent"] == parent:
                    sig, quiet = self.signature(), time.monotonic()
                    while time.monotonic() - quiet < SETTLE_S and time.monotonic() < deadline:
                        time.sleep(0.1)
                        if (later := self.signature()) != sig:
                            sig, quiet = later, time.monotonic()
                    return 200, {"id": nid, "parent": parent}
        return 504, {"error": f"the Claude Code session did not move the note within {NODE_WAIT_S:g} s; "
                              "is the session that ran /rft still open?"}



def ask_session(verb: str, request: dict) -> None:
    """Hands a request to the plugin, which reads this process's stdout line by line."""
    print(f"{verb} {json.dumps(request)}", flush=True)


# ------------------------------------------------------------------ http

def make_handler(vault: Vault, web: Path, token: str | None = None, ask=ask_session):
    """The request handler; without a `token` it never writes. `ask` hands a new note to the session."""
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
            self.send_header("Content-Security-Policy", PAGE_CSP)
            self.end_headers()
            if not head_only:
                self.wfile.write(body)

        def _image(self, q: dict, head_only: bool):
            """GET api/image?note=<id>&src=<as the note writes it>[&token=<key>]: the image, when
            it is in the vault or the request carries the key. Without the key, an image that is
            not in the vault is refused whether it exists or not, so nothing outside can be probed."""
            one = lambda k: (q.get(k) or [""])[0]
            path = vault.image(one("note"), one("src"))
            keyed = bool(token) and secrets.compare_digest(one("token").encode(), token.encode())
            if path is None or not (keyed or vault.inside(path)):
                if keyed:
                    return self._send(404, b"no such image", "text/plain", head_only)
                return self._send(403, b"not in the vault: an image from elsewhere needs the key in the address /rft printed",
                                  "text/plain; charset=utf-8", head_only)
            try:
                st = path.stat()
                if st.st_size > MAX_IMAGE_BYTES:
                    return self._send(413, b"the image is too large", "text/plain", head_only)
                # the browser asks again each time, and the image comes again only once it changed
                tag = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
                same = self.headers.get("If-None-Match") == tag
                data = b"" if head_only or same else path.read_bytes()
            except OSError:
                return self._send(404, b"no such image", "text/plain", head_only)
            self.send_response(304 if same else 200)
            if not same:
                self.send_header("Content-Type", IMAGE_TYPES[path.suffix.lower()])
                self.send_header("Content-Length", str(len(data) if data else st.st_size))
            for k, v in (("Cache-Control", "private, no-cache"), ("ETag", tag), ("X-Content-Type-Options", "nosniff"),
                         ("Referrer-Policy", "no-referrer"), ("Content-Security-Policy", IMAGE_CSP)):
                self.send_header(k, v)
            self.end_headers()
            if data:
                self.wfile.write(data)

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
            if route == "/api/image":
                return self._image(parse_qs(url.query), head_only)
            if route == "/api/paper":
                path = vault.paper((parse_qs(url.query).get("id") or [""])[0])
                if path is None:
                    return self._send(404, b"no saved paper", "text/plain", head_only)
                return self._send(200, path.read_bytes(), "application/pdf", head_only)
            return self._send(404, b"not found", "text/plain", head_only)

        def _refuse(self):
            self._send(405, b"read-only", "text/plain")

        def _may_write(self) -> bool:
            """The page itself asks: its own origin, and the key from the address the server printed."""
            origin = (self.headers.get("Origin") or "").strip().lower()
            host = (self.headers.get("Host") or "").strip().lower()
            key = self.headers.get("X-RFT-Token") or ""
            return bool(token) and origin == f"http://{host}" and secrets.compare_digest(key, token)

        def _write_request(self, route: str, limit: int):
            """The URL and JSON object of a write to `route` from the page itself; None once refused."""
            if not self._host_ok():
                return self._send(403, b"forbidden host", "text/plain")
            url = urlsplit(self.path)
            if url.path != route or not token:
                return self._refuse()
            if not self._may_write():
                return self._json(403, {"error": "the key is missing or out of date: open the address /rft printed"})
            if not (self.headers.get("Content-Type") or "").lower().startswith("application/json"):
                return self._json(415, {"error": "send JSON"})
            try:
                length = int(self.headers.get("Content-Length") or "")
            except ValueError:
                return self._json(411, {"error": "no length"})
            if not 0 <= length <= limit:
                return self._json(413, {"error": "the request is too large"})
            try:
                req = json.loads(self.rfile.read(length))
            except ValueError:
                return self._json(400, {"error": "not JSON"})
            if not isinstance(req, dict):
                return self._json(400, {"error": "expected a JSON object"})
            return url, req

        def do_PUT(self):
            """PUT api/note?id=<id> {"body": "...", "version": "<as read>"} or {"body": "...", "force": true}."""
            got = self._write_request("/api/note", MAX_NOTE_BYTES)
            if got is None:
                return
            url, req = got
            if not isinstance(req.get("body"), str):
                return self._json(400, {"error": "expected {body, version} or {body, force: true}"})
            force = req.get("force") is True
            version = None if force else req.get("version")
            if not force and not isinstance(version, str):
                return self._json(400, {"error": "expected {body, version} or {body, force: true}"})
            nid = (parse_qs(url.query).get("id") or [""])[0]
            return self._json(*vault.write_body(nid, req["body"], version))

        def do_POST(self):
            """POST api/node {"parent": "<id>", "type": one of TYPES, "title": "..."}: a new note
            under `parent`, with the default status; POST api/type {"id": "<id>", "type": one of
            TYPES}: the note's type changed; POST api/move {"id": "<id>", "parent": "<id>", "unlock"?: bool}: the note
            and its subtree under `parent`. The session makes each. POST api/comment {"id":
            "<id>", "action": ...}: a change to the note's discussion (Vault.comment); POST api/lock
            {"id": "<id>", "locked": bool}; POST api/priority {"id": "<id>", "priority": one of
            PRIORITIES or null} or {"id": "<id>", "dismiss": true} (Claude's suggestion only); POST
            api/dates {"id": "<id>", "due"?, "start"?, "est"?: a value or null} or {"id", "dismiss": true}
            (Claude's suggested dates only); POST api/milestone {"title", "due", "needs"?: [ids]} (a new
            deadline), {"id": "M..", "due"?, "needs"?, "status"?} or {"id", "accept" | "dismiss": true}."""
            route = urlsplit(self.path).path
            if route == "/api/dates":
                got = self._write_request("/api/dates", MAX_NODE_BYTES)
                if got is None:
                    return
                _, req = got
                bad = {"error": "expected {id, due?, start?, est?: a value or null} or {id, dismiss: true}"}
                if not isinstance(req.get("id"), str):
                    return self._json(400, bad)
                if req.get("dismiss") is True and len(req) == 2:
                    return self._json(*vault.set_dates(req["id"], {}, dismiss=True))
                changes = {k: v for k, v in req.items() if k != "id"}
                if not changes or any(k not in DATE_FIELDS or not (v is None or isinstance(v, str)) for k, v in changes.items()):
                    return self._json(400, bad)
                return self._json(*vault.set_dates(req["id"], changes))
            if route == "/api/milestone":
                got = self._write_request("/api/milestone", MAX_NODE_BYTES)
                if got is None:
                    return
                _, req = got
                if "id" not in req:
                    if not isinstance(req.get("title"), str) or not isinstance(req.get("due"), str):
                        return self._json(400, {"error": "expected {title, due, needs?} for a new deadline"})
                    return self._json(*vault.add_milestone(req["title"], req["due"], req.get("needs")))
                if not isinstance(req["id"], str) or not all(isinstance(req.get(k, False), bool) for k in ("accept", "dismiss")):
                    return self._json(400, {"error": "expected {id, due?, needs?, status?} or {id, accept: true} or {id, dismiss: true}"})
                return self._json(*vault.update_milestone(req["id"], req))
            if route == "/api/comment":
                got = self._write_request("/api/comment", MAX_COMMENT_BYTES)
                if got is None:
                    return
                _, req = got
                if not isinstance(req.get("id"), str) or not isinstance(req.get("action"), str):
                    return self._json(400, {"error": "expected {id, action, ...}"})
                return self._json(*vault.comment(req["id"], req, ask))
            if route == "/api/lock":
                got = self._write_request("/api/lock", MAX_NODE_BYTES)
                if got is None:
                    return
                _, req = got
                if not isinstance(req.get("id"), str) or not isinstance(req.get("locked"), bool):
                    return self._json(400, {"error": "expected {id, locked: true or false}"})
                return self._json(*vault.set_locked(req["id"], req["locked"]))
            if route == "/api/priority":
                got = self._write_request("/api/priority", MAX_NODE_BYTES)
                if got is None:
                    return
                _, req = got
                bad = {"error": "expected {id, priority: one of " + ", ".join(PRIORITIES) + " or null} or {id, dismiss: true}"}
                if not isinstance(req.get("id"), str):
                    return self._json(400, bad)
                if req.get("dismiss") is True:
                    return self._json(*vault.set_priority(req["id"], None, dismiss=True))
                if "priority" not in req or (req["priority"] is not None and req["priority"] not in PRIORITIES):
                    return self._json(400, bad)
                return self._json(*vault.set_priority(req["id"], req["priority"]))
            if route == "/api/move":
                got = self._write_request("/api/move", MAX_NODE_BYTES)
                if got is None:
                    return
                _, req = got
                if not all(isinstance(req.get(k), str) for k in ("id", "parent")) or not isinstance(req.get("unlock", False), bool):
                    return self._json(400, {"error": "expected {id, parent, unlock?: true or false}"})
                return self._json(*vault.move_node(req["id"], req["parent"], ask, req.get("unlock", False)))
            if route == "/api/type":
                got = self._write_request("/api/type", MAX_NODE_BYTES)
                if got is None:
                    return
                _, req = got
                if not all(isinstance(req.get(k), str) for k in ("id", "type")):
                    return self._json(400, {"error": "expected {id, type}"})
                return self._json(*vault.set_type(req["id"], req["type"], ask))
            got = self._write_request("/api/node", MAX_NODE_BYTES)
            if got is None:
                return
            _, req = got
            if not all(isinstance(req.get(k), str) for k in ("parent", "type", "title")):
                return self._json(400, {"error": "expected {parent, type, title}"})
            return self._json(*vault.add_node(req["parent"], req["type"], req["title"].strip(), ask))

        do_DELETE = do_PATCH = _refuse

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
    ap.add_argument("--config", default=None, help="the project's .rft/config.json (gpus:, the last milestone id)")
    ap.add_argument("--no-watch", action="store_true", help="do not exit with the parent (for manual runs)")
    ap.add_argument("--watch-stdin", action="store_true", help="also exit when stdin is closed")
    a = ap.parse_args(argv)
    vault = Vault(Path(a.vault), a.project, Path(a.config) if a.config else None)
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
