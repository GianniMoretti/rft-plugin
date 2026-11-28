#!/usr/bin/env python3
"""The rft web view's server: local, standard library only.

Serves the page (web/), the tree of the vault as JSON, and one note at a time with its
discussion, and writes: the body of a note, its frontmatter kept as it is (an edit, a footnote, an
accepted suggestion); the `locked:` line of its frontmatter; its `priority:` line, the user's
alone (which also answers Claude's `suggested_priority:`); its dates, the user's too (`due:`,
`start:`, `est:`, which also answer Claude's suggested ones); the deadlines in vault/milestones/
(a new one, its due date, the notes it needs, its status, and Claude's suggested ones accepted or
dismissed); the meetings in vault/meetings/ (a new one, its times, how often it comes back, an
occurrence skipped or moved, the notes it needs, or the meeting deleted); its discussion, the comments and suggestions on parts of its text, in
vault/.comments/<id>.json (as hooks/lib/comments.ts reads it); and the user's scratchpad, quick
notes and to-dos in vault/Scratchpad.md; the inbox, links saved to read later in vault/Inbox.md (a
link added, an item's reading priority or why changed, an item discarded; for an arXiv paper its title, asked of arXiv's API in the background, the one host beyond
this machine the server ever contacts, and only for a link the user saved); and the slide decks in vault/decks/ (the user's edit of one, a
new one, its lock: rft_decks.py beside it). It serves each concept's artifact (vault/artifacts/<id> <name>.html,
written by Claude with rft_set_artifact) read-only, as a page of its own in a sandbox (GET api/artifact?concept=<id>):
no script of it reaches the network, the page that frames it, or a write; the tree lists the artifacts
with what changed since they were written. A new note, or a note's new type, it never writes itself: it asks the session that runs it,
with a line `RFT_ADD_NODE {"parent", "type", "title"}` or `RFT_SET_TYPE {"id", "type"}` on stdout,
and the plugin makes the change as the rft_add_node or rft_set_type tool does (no model turn), then
answers the note's id once it is on disk. `RFT_ASK {"id", "thread"}` asks the session's Claude to
answer a thread (a model turn). It binds 127.0.0.1 only, takes requests only for a loopback
host name (so a web page elsewhere cannot reach it through DNS rebinding), serves nothing but an
allow-list of page files, and reads or writes a note only by its id, in a markdown file that
resolves inside one of the vault's note folders (experiments/, directions/, references/,
theory/), a deadline only in milestones/, a meeting only in meetings/, and the scratchpad only as a plain file at the vault's
top. It shows the experiment queue (GET api/queue: the GPUs, the jobs waiting and running, the
history; rft_queue.py beside it) and takes the user's changes to it (POST api/queue: a job moved,
cancelled or retried, the queue paused, the GPUs it may use); a job's output (GET api/queue/output)
goes only to a request carrying the key; all three answer 404 until this machine is paired with
the queue (rft_queue.py machine add), so the page shows no monitor. A write (PUT api/note, PUT api/scratchpad, PUT api/reading, POST api/inbox, POST api/node, api/type, api/comment, api/lock, api/verify,
api/priority, api/dates, api/milestone, api/meeting, api/queue, PUT and POST api/deck, api/deck/lock) must also come from the page itself (its
Origin) and carry the vault's key, which is in the address the server prints, so neither
another web page nor another user of the machine can change a note. The key is kept in the
user's cache, readable by them alone, so it stays the same across restarts.

It also serves the images a note embeds (GET api/image?note=<id>&src=<as written>), found as
Obsidian finds them: by path, from the note's folder or the vault's top, else by name, nearest
the note, in the vault and then in the Obsidian vault around it (the folder that holds
`.obsidian/`). Only image files, and one outside the vault only for a request carrying the key.

    python3 rft_server.py --vault /abs/project/vault --web /abs/plugin/web [--port 0] [--project NAME]
        [--config /abs/project/.rft/config.json]   (read for `gpus:` and the last milestone and meeting ids)

It prints `RFT_SERVER_URL http://127.0.0.1:<port>/?token=<key>` once listening, and exits when
its parent process goes away (or, with --watch-stdin, closes its stdin). When a fixed --port is
held by another session's server for the same vault, it prints that address, whose key is the
same, and takes the port over once that server stops; when something else holds it, it serves
on a free port instead.

With --terminal (rft_serve.py, which reads the project's config) it runs from a terminal and has no
session: api/id says so, its port is recorded in the user's cache (rft/hosts/<vault id>), and what
the page asks of the session is handed to a chat's server, which finds it on its port or by the
record, prints its address, and takes those requests (GET api/session/next, with the key, every
RELAY_POLL_S) for its plugin; with no chat taking them, they are refused at once (Relay).
"""
from __future__ import annotations

import argparse
import base64
import datetime
import errno
import hashlib
import http.client
import http.server
import json
import os
import re
import secrets
import shutil
import signal
import socket
import stat
import sys
import threading
import time
from pathlib import Path
from html import escape as html_escape, unescape as html_unescape
from urllib.parse import parse_qs, quote, urlsplit

import rft_decks  # the slide decks as the page reads them
import rft_documents  # a document as a folder of files: its file list, uploads, main file and engine
import rft_git  # a document as a repository of its own: connect, pull, push, clone
import rft_latex  # the manuscript's LaTeX: its generated files and the compile
import rft_manuscript  # the manuscript as the page shows it
import rft_notebook
import rft_inbox  # the inbox, links saved to read later, as the page shows it
import rft_agents  # the agents the user set up: models and harnesses, each with a grant (docs/adr/0006)
import rft_reading  # an inbox item's reading note: the user's part, written by the page, and Claude's impression
import rft_papers  # for an arXiv item's title, asked as the downloader asks it
import rft_queue  # the experiment queue, beside this file
import rft_style  # the project's figure tokens, which the artifacts' and the slides' colours follow

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
    "/scratchpad.js": ("scratchpad.js", "text/javascript; charset=utf-8"),
    "/agents.js": ("agents.js", "text/javascript; charset=utf-8"),
    "/inbox.js": ("inbox.js", "text/javascript; charset=utf-8"),
    "/reading.js": ("reading.js", "text/javascript; charset=utf-8"),
    "/queue.js": ("queue.js", "text/javascript; charset=utf-8"),
    "/artifacts.js": ("artifacts.js", "text/javascript; charset=utf-8"),
    "/phone.js": ("phone.js", "text/javascript; charset=utf-8"),
    "/manuscript.js": ("manuscript.js", "text/javascript; charset=utf-8"),
    "/slides.js": ("slides.js", "text/javascript; charset=utf-8"),
    "/slide-edit.js": ("slide-edit.js", "text/javascript; charset=utf-8"),
    "/slide-tools.js": ("slide-tools.js", "text/javascript; charset=utf-8"),
    "/decks.js": ("decks.js", "text/javascript; charset=utf-8"),
    # the Manuscript tab's editor
    "/vendor/codemirror.v5.65.16.min.js": ("vendor/codemirror.v5.65.16.min.js", "text/javascript; charset=utf-8"),
    "/vendor/codemirror.v5.65.16.min.css": ("vendor/codemirror.v5.65.16.min.css", "text/css; charset=utf-8"),
    "/vendor/LICENSE-codemirror.txt": ("vendor/LICENSE-codemirror.txt", "text/plain; charset=utf-8"),
    "/vendor/d3.v7.9.0.min.js": ("vendor/d3.v7.9.0.min.js", "text/javascript; charset=utf-8"),
    "/vendor/LICENSE-d3.txt": ("vendor/LICENSE-d3.txt", "text/plain; charset=utf-8"),
    "/vendor/katex.v0.16.22.min.js": ("vendor/katex.v0.16.22.min.js", "text/javascript; charset=utf-8"),
    "/vendor/katex.v0.16.22.min.css": ("vendor/katex.v0.16.22.min.css", "text/css; charset=utf-8"),
    "/vendor/LICENSE-katex.txt": ("vendor/LICENSE-katex.txt", "text/plain; charset=utf-8"),
    # an artifact's SVG figure as a PDF, made in the page (loaded the first time one is asked for)
    "/vendor/jspdf.v4.2.1.umd.min.js": ("vendor/jspdf.v4.2.1.umd.min.js", "text/javascript; charset=utf-8"),
    "/vendor/svg2pdf.v2.9.0.umd.min.js": ("vendor/svg2pdf.v2.9.0.umd.min.js", "text/javascript; charset=utf-8"),
    "/vendor/LICENSE-jspdf.txt": ("vendor/LICENSE-jspdf.txt", "text/plain; charset=utf-8"),
    "/vendor/LICENSE-svg2pdf.txt": ("vendor/LICENSE-svg2pdf.txt", "text/plain; charset=utf-8"),
    # the Manuscript's PDF drawn in the page where the browser shows none in a frame (Chrome on Android)
    "/vendor/pdf.v4.10.38.min.mjs": ("vendor/pdf.v4.10.38.min.mjs", "text/javascript; charset=utf-8"),
    "/vendor/pdf.worker.v4.10.38.min.mjs": ("vendor/pdf.worker.v4.10.38.min.mjs", "text/javascript; charset=utf-8"),
    "/vendor/LICENSE-pdfjs.txt": ("vendor/LICENSE-pdfjs.txt", "text/plain; charset=utf-8"),
}
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "[::1]"}
ID_RE = re.compile(r"^[EDRT]\d+$")
MAX_NOTE_BYTES = 2_000_000
MAX_NODE_BYTES = 10_000
MAX_INBOX_LINK = 2_000  # characters: a link pasted into the inbox, and the line on why
MAX_INBOX_WHY = 500
NODE_WAIT_S = 10.0  # how long a new note may take the session to make
SETTLE_S = 0.3  # how long the notes stay as they are before a new one counts as made
RELAY_POLL_S = 0.25  # how often a chat asks the terminal's server for what the page asks of the session
RELAY_ALIVE_S = 2.0  # how long after it last asked a chat still counts as there
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
               ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".svg": "image/svg+xml"}
MAX_IMAGE_BYTES = 50_000_000
# an image pasted or dropped on a slide (decks/assets/): its types, and the most a request carrying one as base64 may be
DECK_ASSETS = "assets"
DECK_ASSET_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg"}
MAX_ASSET_BYTES = 28_000_000
RESCAN_S = 5.0  # a name not found looks through the folders again at most this often
MAX_SCAN_FILES = 2_000_000  # the most files a search by name looks through
SKIP_DIRS = {"node_modules", "__pycache__"}  # with every dot folder: never searched by name
PAGE_CSP = ("default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; "
            "connect-src 'self'; frame-src 'self' blob:; frame-ancestors 'self'")
# frame-src: the page's own frames (the artifacts, and the marimo editors of the experiments'
# notebooks, which this server passes on under notebook/<name>/), and the manuscript's PDF (fetched
# with the key, shown from a blob: address only the page itself can make)
# where the notebooks' editors answer, through this server (rft_notebook.Editors): its own port, the
# only one a browser on another machine (an SSH tunnel to it) may reach
NOTEBOOK_PREFIX = f"/{rft_notebook.EDITOR_PATH}/"
NOTEBOOK_GONE = ("<!doctype html><meta charset=utf-8><meta name=color-scheme content='light dark'>"
                 "<title>The notebook's editor stopped</title><body style='font:14px/1.5 sans-serif;margin:2em'>"
                 "<p>This notebook's editor is not running: it stops once nobody has had it open for "
                 f"{rft_notebook.EDITOR_IDLE_MINUTES // 60} hours, and with the tree view's server.</p>"
                 "<p>Close the notebook pane and open it again to start it.</p>").encode()
# a concept's artifact: a page of Claude's, served as a document of its own in a sandbox (an opaque
# origin: it reads no storage and makes no write as the page), its scripts inline, nothing from
# elsewhere; `{here}` is the server's own address, for its images and the page that frames it
ARTIFACT_CSP = ("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src {here} data:; "
                "media-src {here} data:; font-src data:; form-action 'none'; base-uri 'none'; frame-ancestors {here}; "
                "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox")
ARTIFACTS = "artifacts"
# where an artifact's figures are kept: looked in first after the artifacts' own folder
FIGURES = "figures"
# an SVG an artifact shows comes inside its page, as a data: image: the sandboxed frame has no origin
# of its own, and a browser blocks an SVG answer to it (ORB); up to this size
MAX_INLINE_SVG = 10_000_000
# the scripts inside an artifact's frame, in this order: the LaTeX of its tables, then its runtime
FRAME_SCRIPTS = ("latex.js", "frame.js")
# its first line, as hooks/lib/vault.ts reads it: JSON in an HTML comment
ARTIFACT_HEAD = re.compile(r"^<!-- rft-artifact (\{.*\}) -->[ \t]*(?:\r?\n|$)")
MAX_ARTIFACT_BYTES = 1_000_000
CONCEPT_ID_RE = re.compile(r"^(root|[EDRT]\d+)$")
FENCE_RE = re.compile(r"^\s*(```|~~~)")
IMG_SRC_RE = re.compile(r"(<img\b[^>]*?\bsrc\s*=\s*)([\"'])(.*?)\2", re.I | re.S)
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
# the meetings, outside the tree: once at `when:`, or coming back `every:` day, week or month up to
# `until:`, but on the days in `skip:`, with occurrences `moved:` elsewhere; as web/schedule.js reads
# them (the same patterns), which also says on which days they fall
MEETINGS = "meetings"
MEETING_RE = re.compile(r"^G(\d+)$")
DURATION_RE = re.compile(r"^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?$", re.I)
EVERY_RE = re.compile(r"^(?:every\s+)?(?:(\d+)\s*)?(d|w|m|days?|weeks?|months?|daily|weekly|monthly)(?:\s+on\s+the\s+(first|second|third|fourth|fifth|last)\s+([a-z]{3,}))?$", re.I)
MOVED_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})\s*(?:→|->)\s*(.+)$")
MEETING_FIELDS = ("when", "duration", "every", "until", "skip", "moved", "needs")
WEEKDAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
# the user's quick notes and to-dos: one markdown file at the vault's top, outside the tree (no
# note folder holds it, so neither the tree nor its version sees it), as web/scratchpad.js shows it
SCRATCHPAD = "Scratchpad.md"
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


def fnv(text: str) -> str:
    """FNV-1a over the UTF-16 code units of `text`, as 8 hex digits, as hooks/lib/artifacts.ts has it."""
    h = 0x811C9DC5
    data = text.encode("utf-16-le", "surrogatepass")
    for i in range(0, len(data), 2):
        h ^= data[i] | (data[i + 1] << 8)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def result_of(text: str) -> str:
    """The text of a note's `## Result` section, trimmed ('' when it has none), as resultOf in
    hooks/lib/vault.ts: from the heading to the next `## ` heading, neither inside a fenced block."""
    lines, fenced, heads = body_of(text).split("\n"), False, []
    for i, line in enumerate(lines):
        if FENCE_RE.match(line):
            fenced = not fenced
        if not fenced and line.startswith("## "):
            heads.append(i)
    start = next((i for i in heads if lines[i][3:].strip() == "Result"), None)
    if start is None:
        return ""
    end = next((i for i in heads if i > start), len(lines))
    return "\n".join(lines[start + 1:end]).strip()


def has_result(status: str, text: str) -> bool:
    """Whether an experiment has a result: done, or a Result that says something once it runs (a
    planned experiment or an idea has none, whatever its Result holds), as hasResultIn in hooks/lib/vault.ts."""
    return status in FINISHED or (status not in ("planned", "idea") and result_of(text) != "")


def experiment_key(n: dict, text: str) -> str:
    """What a concept's artifact is written from, for one experiment, as experimentKey in hooks/lib/artifacts.ts."""
    return fnv(f"{n['id']}|{n['status']}|{n['title']}|{n.get('summary') or ''}|{n.get('supersededBy') or ''}|{result_of(text)}")


def image_key(key: str) -> str:
    """The key an artifact's frame gets for its images: it reads image files as the vault key does,
    and writes nothing, so a script of the artifact that learns it can change no note."""
    return hashlib.sha256(f"{key}:images".encode()).hexdigest()[:32]


def artifact_head(text: str) -> dict | None:
    """The header of an artifact file (its first line), or None when it has none."""
    m = ARTIFACT_HEAD.match(text)
    if not m:
        return None
    try:
        head = json.loads(m.group(1))
    except ValueError:
        return None
    return head if isinstance(head, dict) and isinstance(head.get("concept"), str) and head["concept"] else None


def artifact_page(text: str) -> str:
    """An artifact file without its header line."""
    m = ARTIFACT_HEAD.match(text)
    return text[m.end():] if m else text


def wrap_artifact(html: str, js: str, css: str, theme: str) -> str:
    """The artifact as a document: its theme, the base style and the frame's runtime first in its
    head, as wrap in web/artifacts.js builds it for the standalone page."""
    js = re.sub(r"</(script)", r"<\\/\1", js, flags=re.I)
    css = re.sub(r"</(style)", r"<\\/\1", css, flags=re.I)
    pre = (f'<meta charset="utf-8"><script>document.documentElement.dataset.theme = "{theme}"</script>'
           f"<style>{css}</style><script>{js}</script>")
    m = re.search(r"<head\b[^>]*>", html, re.I)
    if m:
        return html[:m.end()] + pre + html[m.end():]
    m = re.search(r"<html\b[^>]*>", html, re.I)
    if m:
        return html[:m.end()] + f"<head>{pre}</head>" + html[m.end():]
    return f"<!doctype html><html><head>{pre}</head><body>{html}</body></html>"


def id_of(name: str) -> str:
    return name.split(" ")[0]


def natural_key(name: str):
    m = re.match(r"^([A-Za-z]+)(\d+)(.*)$", name)
    return (m.group(1), int(m.group(2)), m.group(3)) if m else (name, 0, "")


STATUSES = {"planned", "running", "done", "review", "verified", "idea", "dropped", "discussed", "moved"}
# done, and the two a done note goes on to: verified (the user checked its claim) and review (it may no longer hold)
FINISHED = ("done", "review", "verified")


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


REPRODUCED_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}) (ok|differs|failed|unchecked)(?: @([0-9a-f]{4,40}(?:\+dirty)?))?(?: in (\d+(?:\.\d+)?) s)?$")


VERIFIED_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}) ([0-9a-f]{8})$")


def parse_verified(value: str | None) -> dict | None:
    """A note's verification stamp (`verified: <date> <fingerprint>`, written when the user verifies
    it), as parseVerified in hooks/lib/vault.ts reads it: {date, fingerprint}; None when it is not one."""
    m = VERIFIED_RE.match(unquote(value))
    return {"date": m.group(1), "fingerprint": m.group(2)} if m else None


def parse_reproduced(value: str | None) -> dict | None:
    """An experiment notebook's last run (`reproduced:`, written by rft_run_notebook), as parseReproduced
    in hooks/lib/vault.ts reads it: {date, state, commit?, seconds?}; None when it is not one."""
    m = REPRODUCED_RE.match(unquote(value))
    if not m:
        return None
    out = {"date": m.group(1), "state": m.group(2)}
    if m.group(3):
        out["commit"] = m.group(3)
    if m.group(4):
        out["seconds"] = float(m.group(4)) if "." in m.group(4) else int(m.group(4))
    return out


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


def duration_ok(value: str | None) -> bool:
    """Whether `value` is a meeting's length: 1h, 45m, 1h30m."""
    m = DURATION_RE.match(unquote(value))
    return bool(m) and (m.group(1) is not None or m.group(2) is not None) and 60 * int(m.group(1) or 0) + int(m.group(2) or 0) > 0


def every_ok(value: str | None) -> bool:
    """Whether `value` says how often a meeting comes back: week, 2 weeks, month, month on the first Tuesday."""
    m = EVERY_RE.match(re.sub(r"\s+", " ", unquote(value)))
    if not m or (m.group(2).lower().endswith("ly") and m.group(1) is not None) or not 1 <= int(m.group(1) or 1) <= 99:
        return False
    return not m.group(3) or (m.group(2).lower()[0] == "m" and any(d.startswith(m.group(4).lower()) for d in WEEKDAYS))


def moved_ok(value: str | None) -> bool:
    """Whether `value` is an occurrence moved: `2026-12-01 → 2026-12-02 10:00`."""
    m = MOVED_RE.match(unquote(value))
    return bool(m) and day_of(m.group(1)) is not None and due_ok(m.group(2))


def list_items(value: str | None) -> list[str]:
    """The items of a one-line list as written: `[2026-12-22, "2026-12-29"]`."""
    v = (value or "").strip()
    if v.startswith("[") and v.endswith("]"):
        v = v[1:-1]
    return [x for x in (unquote(p) for p in v.split(",")) if x]


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
        self._write_lock = threading.RLock()  # taken again by a read that tidies a thread whose agent is gone
        self._waiting: set[str] = set()  # the read inbox items whose discussion found no chat (by key)
        self._waiting_lock = threading.Lock()
        self._ask_lock = threading.Lock()
        self._compile_lock = threading.Lock()
        self._git_lock = threading.Lock()
        self._sig: str | None = None
        self._tree: dict | None = None
        # the folders an image is searched in by name: the vault, then the Obsidian vault around it
        outer = obsidian_root(self.root)
        self.image_tops = [self.root] + ([outer] if outer and outer != self.root else [])
        self._names: dict[Path, tuple[float, dict[str, list[tuple[str, str]]]]] = {}
        self._names_lock = threading.Lock()
        # the experiment queue (vault/.queue/): the monitor reads it, and the user reorders, pauses,
        # cancels and retries jobs; its runner, a process of its own, runs them
        self.queue = rft_queue.Queue(self.root)
        # an arXiv item's title in the inbox: asked one at a time, with the pause arXiv asks for
        self.arxiv_meta = rft_papers.arxiv_meta
        self.arxiv_pause = 3.0
        self._arxiv_lock = threading.Lock()
        self._arxiv_last = 0.0
        # the agents the user set up, and the tasks this server launched (rft_agents.Runner); None
        # until a server gives it one: the page then has the session alone
        self.runner: rft_agents.Runner | None = None

    def signature(self) -> str:
        parts = []
        for sub in SUBDIRS:
            d = self.root / sub
            if d.is_dir():
                for f in sorted(d.glob("*.md")):
                    st = f.stat()
                    parts.append(f"{sub}/{f.name}:{st.st_mtime_ns}:{st.st_size}")
        for sub, pattern in ((COMMENTS, "*.json"), (MILESTONES, "*.md"), (MEETINGS, "*.md"), (ARTIFACTS, "*.html")):
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
        texts: dict[str, str] = {}  # the experiments', for the keys their concept's artifact is written from
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
                notebook = unquote(fm.get("notebook"))
                if notebook:
                    nodes[nid]["notebook"] = notebook
                reproduced = parse_reproduced(fm.get("reproduced"))
                if reproduced:
                    nodes[nid]["reproduced"] = reproduced
                verified = parse_verified(fm.get("verified"))
                if verified:
                    nodes[nid]["verified"] = verified
                suggested_verified = unquote_json(fm.get("suggested_verified"))
                if suggested_verified:
                    nodes[nid]["suggestedVerified"] = suggested_verified
                # the dates, as hooks/lib/vault.ts reads them: values that are none are left out
                plan = {"due": unquote(fm.get("due")) if due_ok(fm.get("due")) else None,
                        "start": day_of(fm.get("start")), "est": est_of(fm.get("est")),
                        "started": day_of(fm.get("started")), "finished": day_of(fm.get("finished")),
                        "gpus": count_of(fm.get("gpus")), "suggestedStart": day_of(fm.get("suggested_start")),
                        "suggestedEst": est_of(fm.get("suggested_est"))}
                if plan["suggestedStart"] or plan["suggestedEst"]:
                    plan["suggestedDatesWhy"] = unquote_json(fm.get("suggested_dates_why")) or None
                nodes[nid].update({k: v for k, v in plan.items() if v})
                if ftype == "experiment":
                    texts[nid] = text
                    if has_result(nodes[nid]["status"], text):
                        nodes[nid]["hasResult"] = True
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
        meetings = self._meetings(by_name, nodes)
        artifacts = self._artifacts(nodes, roots, texts)
        return {"project": self.project, "version": sig, "nodes": list(nodes.values()), "roots": roots, "tags": tags,
                "concepts": concepts, "milestones": milestones, "meetings": meetings, "artifacts": artifacts, "gpus": self._config().get("gpus") if count_of(str(self._config().get("gpus", ""))) else None}

    def _config(self) -> dict:
        """The project's .rft/config.json, or {} when there is none to read."""
        try:
            data = json.loads(self.config.read_text(encoding="utf-8")) if self.config else {}
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _artifact_files(self):
        """The artifact files: each `artifacts/*.html` inside that folder (no link out of it), with its header, by name."""
        d = (self.root / ARTIFACTS)
        if not d.is_dir():
            return
        top = d.resolve()
        for f in sorted(d.glob("*.html"), key=lambda p: p.name):
            try:
                if f.is_symlink() or f.resolve().parent != top or not f.is_file() or f.stat().st_size > MAX_ARTIFACT_BYTES:
                    continue
                data = f.read_bytes()
            except OSError:
                continue
            head = artifact_head(data.decode("utf-8", errors="replace"))
            if head:
                yield f, data, head

    def _artifacts(self, nodes: dict[str, dict], roots: list[str], texts: dict[str, str]) -> list[dict]:
        """Each concept's artifact, with what changed since it was written: the keys of the concept's
        own experiments with a result now, against those in its header, as artifactState in
        hooks/lib/artifacts.ts has it (in the order of the tree)."""
        order: list[str] = []
        stack = list(reversed(roots))
        while stack:
            nid = stack.pop()
            order.append(nid)
            stack.extend(reversed(nodes[nid]["children"]))
        out, seen = [], set()
        for f, data, head in self._artifact_files():
            cid = head["concept"]
            if cid in seen:
                continue
            seen.add(cid)
            now = {i: experiment_key(nodes[i], texts[i]) for i in order
                   if nodes[i]["concept"] == cid and nodes[i]["type"] == "experiment" and nodes[i].get("hasResult")}
            basis = head.get("basis") if isinstance(head.get("basis"), dict) else {}
            changed = [i for i in now if i in basis and basis[i] != now[i]]
            added = [i for i in now if i not in basis]
            removed = [i for i in basis if i not in now]
            out.append({"concept": cid, "name": str(head.get("name") or cid), "path": f"{ARTIFACTS}/{f.name}",
                        "updated": str(head.get("updated") or ""), "version": version_of(data),
                        "stale": bool(changed or added or removed), "changed": changed, "added": added, "removed": removed})
        return out

    def artifact(self, cid: str) -> str | None:
        """A concept's artifact page, without its header; None when the concept has none."""
        if not CONCEPT_ID_RE.match(cid or ""):
            return None
        if not any(a["concept"] == cid for a in self.tree()["artifacts"]):
            return None
        for _f, data, head in self._artifact_files():
            if head["concept"] == cid:
                return artifact_page(data.decode("utf-8", errors="replace"))
        return None

    def artifact_image(self, cid: str, src: str) -> Path | None:
        """An image a concept's artifact shows, found as a note's are, from the artifacts' folder."""
        if not CONCEPT_ID_RE.match(cid or "") or not any(a["concept"] == cid for a in self.tree()["artifacts"]):
            return None
        return self._find_image(self.root / ARTIFACTS, src, [self.root / FIGURES])

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

    def _meetings(self, by_name: dict[str, str], nodes: dict[str, dict]) -> list[dict]:
        """The meetings in meetings/: their fields as written, the notes they need by id and the names
        that are none, as hooks/lib/vault.ts loads them."""
        out: list[dict] = []
        d = self.root / MEETINGS
        if not d.is_dir():
            return out
        for f in sorted(d.glob("*.md"), key=lambda p: natural_key(p.name)):
            fm = front(f.read_text(encoding="utf-8", errors="replace"))
            name = f.name[:-3]
            gid = unquote(fm.get("id")) or id_of(name)
            if any(m["id"] == gid for m in out):
                continue
            needs, missing = [], []
            for ref in link_targets(fm.get("needs")):
                nid = by_name.get(ref) or (id_of(ref) if id_of(ref) in nodes else None)
                if nid and nid not in needs:
                    needs.append(nid)
                elif not nid:
                    missing.append(ref)
            m = {"id": gid, "name": name, "title": name[len(id_of(name)):].strip(), "path": f"{MEETINGS}/{f.name}",
                 "when": unquote(fm.get("when")), "skip": list_items(fm.get("skip")), "moved": list_items(fm.get("moved")),
                 "needs": needs, "missing": missing}
            for k in ("duration", "every", "until"):
                if unquote(fm.get(k)):
                    m[k] = unquote(fm.get(k))
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
        each placed in the body as it is now (`at`: [start, end], or None when detached). A
        manuscript's snippet (S..) reads the same way: its LaTeX as the body, locked as the manuscript is."""
        path = self.text_path(nid)
        if path is None:
            return None
        data = path.read_bytes()
        text = data.decode("utf-8", errors="replace")
        body = body_of(text)
        threads = []
        for t in self._threads(nid)["threads"]:
            at = locate(body, str(t.get("quote") or ""), str(t.get("prefix") or ""), str(t.get("suffix") or ""))
            task = self.runner.tasks.get(thread_key(nid, t["id"])) if self.runner else None
            if self.runner and task is None and isinstance(t.get("asking"), str):
                # it waits for an agent this server never launched: the server was restarted meanwhile
                task = self.runner.tasks.lost(thread_key(nid, t["id"]), t["asking"], f"{nid} {t['id']}")
                self._unask(nid, t["id"], t["asking"])
                t = {**t, "asked": None}
                t.pop("asking", None)
            threads.append({**t, "at": [at[0], at[1]] if at else None, "exact": bool(at and at[2]),
                            **({"task": task.describe()} if task else {})})
        if rft_manuscript.SNIPPET_ID.match(nid):
            h = rft_manuscript.header(text)
            return {"id": nid, "name": f"{nid} {h['title']}" if h else nid, "body": body, "version": version_of(data),
                    "locked": rft_manuscript.snippet_locked(rft_manuscript.read_registry(self.root), nid), "threads": threads}
        if rft_manuscript.DOC_RE.match(nid) and not ID_RE.match(nid):
            return {"id": nid, "name": f"the document {nid}", "body": body, "version": version_of(data),
                    "locked": rft_manuscript.document_locked(rft_manuscript.read_docs_registry(self.root), nid), "threads": threads}
        return {"id": nid, "name": path.name[:-3], "body": body, "version": version_of(data),
                "locked": is_locked(front(text)), "threads": threads}

    def text_path(self, nid: str) -> Path | None:
        """A note's file, a snippet's (S.., snippets/S...tex) or a document's (by its name,
        documents/<name>/main.tex): what the page reads, edits and discusses."""
        if rft_manuscript.SNIPPET_ID.match(nid or ""):
            path = (rft_manuscript.snippets_dir(self.root) / f"{nid}.tex").resolve()
            return path if path.parent == rft_manuscript.snippets_dir(self.root).resolve() and path.is_file() else None
        if rft_manuscript.DOC_RE.match(nid or "") and not ID_RE.match(nid):
            if not rft_manuscript.is_document(self.root, nid):
                return None
            path = rft_manuscript.documents_dir(self.root) / nid / (rft_latex.main_file(self.root, nid) or "main.tex")
            return path if path.is_file() and not path.is_symlink() else None
        return self.note_path(nid)

    def inside(self, path: Path) -> bool:
        return self.root in path.parents

    def notebook_link(self, nid: str) -> Path | None:
        """The vault's link to an experiment's notebook (its `notebook:`), when the note has one and it
        names a place in the vault; where the link leads is rft_notebook's to check."""
        n = next((x for x in self.tree()["nodes"] if x["id"] == nid), None)
        rel = (n or {}).get("notebook")
        if not rel:
            return None
        path = Path(os.path.normpath(self.root / rel))
        return path if self.inside(path) and (path.is_symlink() or path.is_file()) else None

    def image(self, nid: str, src: str) -> Path | None:
        """The image file note `nid` embeds as `src` (`![[src]]` or `![](src)`), resolved, as
        Obsidian finds it: a path on disk; else from the note's folder, the vault's top or the
        Obsidian vault's; else by name, the file whose path ends as `src` does that lies nearest
        the note, first in the vault, then in the Obsidian vault. None when there is none."""
        note = self.note_path(nid)
        return None if note is None else self._find_image(note.parent, src)

    def _find_image(self, near: Path, src: str, also: list[Path] = ()) -> Path | None:
        """The image `src` names, seen from the folder `near` (then from the folders `also`), as
        `image` finds a note's."""
        src = (src or "").strip()
        if not src or "\x00" in src or len(src) > 4096:
            return None
        if src.lower().startswith("file://"):
            src = src[len("file://"):]
        if not is_image(Path(src)):
            return None
        inner = src.lstrip("/")  # Obsidian reads `/a.png` from its vault's top
        tries = ([Path(src)] if Path(src).is_absolute() else []) + [near / inner, *(a / inner for a in also), *(t / inner for t in self.image_tops)]
        parts = [p for p in Path(inner).parts if p not in (".", "..")]
        try:
            found = next((p for p in tries if p.is_file()), None)
            for top in self.image_tops if parts else ():
                found = found or self._by_name(top, parts, near)
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
        path = self.text_path(nid)
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

    def meeting_path(self, gid: str) -> Path | None:
        """A meeting's file, only when it resolves to a markdown file in meetings/."""
        if not MEETING_RE.match(gid or ""):
            return None
        m = next((x for x in self.tree()["meetings"] if x["id"] == gid), None)
        if m is None:
            return None
        path = (self.root / m["path"]).resolve()
        return path if path.parent == (self.root / MEETINGS).resolve() and path.suffix == ".md" and path.is_file() else None

    def _meeting_lines(self, req: dict, new: bool) -> tuple[dict[str, str | None], str | None]:
        """The frontmatter lines a meeting's request gives (None: the line goes), or an error."""
        lines: dict[str, str | None] = {}
        if "when" in req or new:
            if not isinstance(req.get("when"), str) or not due_ok(req["when"]):
                return {}, "when must be a date and a time: 2026-11-24 14:00 (a day alone for all day; AoE, UTC or +01:00 after the time)"
            lines["when"] = f"when: {req['when'].strip()}"
        for key, ok, what in (("duration", duration_ok, "a length: 1h, 45m, 1h30m"),
                              ("every", every_ok, "how often it comes back: week, 2 weeks, month, month on the first Tuesday"),
                              ("until", lambda v: day_of(v) is not None, "a day: 2027-06-30")):
            if key not in req or (new and req[key] in (None, "")):
                continue
            if req[key] is None:
                lines[key] = None
            elif not isinstance(req[key], str) or not ok(req[key]):
                return {}, f"{key} must be {what}"
            else:
                lines[key] = f"{key}: {req[key].strip()}"
        if "skip" in req:
            if not isinstance(req["skip"], list) or not all(isinstance(x, str) and day_of(x) for x in req["skip"]):
                return {}, "skip must be a list of days: [\"2026-12-22\"]"
            days = sorted(dict.fromkeys(x.strip() for x in req["skip"]))
            lines["skip"] = f"skip: [{', '.join(days)}]" if days else None
        if "moved" in req:
            if not isinstance(req["moved"], list) or not all(isinstance(x, str) and moved_ok(x) for x in req["moved"]):
                return {}, "moved must be a list of occurrences moved: [\"2026-12-01 → 2026-12-02 10:00\"]"
            items = sorted({x.strip()[:10]: x.strip() for x in req["moved"]}.values())
            lines["moved"] = f"moved: [{', '.join(json.dumps(x, ensure_ascii=False) for x in items)}]" if items else None
        if "needs" in req:
            line, err = self._needs_line(req["needs"])
            if err:
                return {}, err
            lines["needs"] = line
        return lines, None

    def add_meeting(self, title: str, req: dict) -> tuple[int, dict]:
        """A new meeting the user adds: the next free G id (after the config's last one and every
        meeting on disk), in meetings/."""
        title = clean_title(title)
        if not title:
            return 400, {"error": "give the meeting a title"}
        lines, err = self._meeting_lines(req, new=True)
        if err:
            return 400, {"error": err}
        if lines.get("until") and not lines.get("every"):
            return 400, {"error": "until is the last day of a meeting that comes back: give every too"}
        if lines.get("until") and req["until"].strip() < req["when"].strip()[:10]:
            return 400, {"error": "until is before its first day"}
        with self._write_lock:
            last = self._config().get("lastId", {}).get("G", 0) if isinstance(self._config().get("lastId"), dict) else 0
            taken = [int(m.group(1)) for x in self.tree()["meetings"] if (m := MEETING_RE.match(x["id"]))]
            num = max([last if isinstance(last, int) else 0, *taken]) + 1
            gid = f"G{num:02d}"
            d = self.root / MEETINGS
            d.mkdir(exist_ok=True)
            fields = [f"id: {gid}", "type: meeting"] + [lines[k] for k in MEETING_FIELDS if lines.get(k)]
            (d / f"{gid} {title}.md").write_text("---\n" + "\n".join(fields) + f"\n---\n\n# {gid} · {title}\n", encoding="utf-8")
        return 201, {"id": gid, "name": f"{gid} {title}"}

    def update_meeting(self, gid: str, req: dict) -> tuple[int, dict]:
        """Changes a meeting: its `when`, `duration`, `every`, `until` (a value, or None to take it
        away), the days it `skip`s and the occurrences `moved` (each list whole, as the page has worked
        it out), the notes it `needs`; or `delete: true` removes it."""
        path = self.meeting_path(gid)
        if path is None:
            return 404, {"error": "no such meeting"}
        if req.get("delete") is True:
            with self._write_lock:
                path.unlink()
            return 200, {"id": gid, "deleted": True}
        if req.get("when", "") is None:
            return 400, {"error": "a meeting keeps its when: delete it instead"}
        lines, err = self._meeting_lines(req, new=False)
        if err:
            return 400, {"error": err}
        if not lines:
            return 400, {"error": "nothing to change: give when, duration, every, until, skip, moved or needs, or delete"}
        with self._write_lock:
            text = path.read_text(encoding="utf-8")
            parts = self._fields(text)
            if parts is None:
                return 422, {"error": "the meeting has no frontmatter"}
            fields, frame, body = parts
            for key in MEETING_FIELDS:
                if key not in lines:
                    continue
                line = lines[key]
                at = next((i for i, l in enumerate(fields) if re.match(rf"{key}\s*:", l)), None)
                if at is not None:
                    if line is None:
                        del fields[at]
                    else:
                        fields[at] = line
                elif line is not None:
                    # after the fields that come before it, in their order
                    before = MEETING_FIELDS[:MEETING_FIELDS.index(key)] + ("type", "id")
                    after = max((i + 1 for i, l in enumerate(fields) if any(re.match(rf"{k}\s*:", l) for k in before)), default=len(fields))
                    fields.insert(after, line)
            self._write_note(path, text, frame % "\n".join(fields), body)
        return 200, {"id": gid}

    # ------------------------------------------------------------ the scratchpad

    def _scratchpad_file(self) -> Path | None:
        """The scratchpad's file at the vault's top; None when that name is held by something else
        than a plain file (a folder, a link), which is then neither read nor written."""
        path = self.root / SCRATCHPAD
        return None if path.is_symlink() or (path.exists() and not path.is_file()) else path

    def scratchpad(self) -> tuple[int, dict]:
        """The scratchpad as the page shows it: its text (newlines as \\n) and version; empty, with
        no version, until it is first written."""
        path = self._scratchpad_file()
        if path is None:
            return 422, {"error": f"{SCRATCHPAD} in the vault is not a plain file"}
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            return 200, {"name": SCRATCHPAD, "text": "", "version": None}
        text = data.decode("utf-8", errors="replace").replace("\r\n", "\n")
        return 200, {"name": SCRATCHPAD, "text": text, "version": version_of(data)}

    def write_scratchpad(self, text: str, version: str | None, force: bool = False) -> tuple[int, dict]:
        """Writes the scratchpad, as it is given (made when there is none), in the newlines the
        file had. Refused, with the text as it is now, when the file changed since `version` (None:
        it was not made yet), unless `force`."""
        path = self._scratchpad_file()
        if path is None:
            return 422, {"error": f"{SCRATCHPAD} in the vault is not a plain file"}
        with self._write_lock:
            try:
                data = path.read_bytes()
            except FileNotFoundError:
                data = None
            now = None if data is None else version_of(data)
            if not force and version != now:
                return 409, {"error": "the scratchpad changed since it was read", "version": now,
                             "text": "" if data is None else data.decode("utf-8", errors="replace").replace("\r\n", "\n")}
            try:
                old = "" if data is None else data.decode("utf-8")
            except UnicodeDecodeError:
                return 422, {"error": f"{SCRATCHPAD} is not UTF-8 text; edit it in an editor"}
            text = text.replace("\r\n", "\n")
            # (a lone surrogate, which JSON can carry and UTF-8 cannot, becomes "?")
            out = (text.replace("\n", "\r\n") if "\r\n" in old else text).encode("utf-8", errors="replace")
            # a new file renamed over the old one: a reader never sees half of it
            tmp = path.with_name(f".{path.name}.rft-tmp")
            try:
                tmp.write_bytes(out)
                if data is not None:
                    os.chmod(tmp, stat.S_IMODE(path.stat().st_mode))
                os.replace(tmp, path)
            finally:
                tmp.unlink(missing_ok=True)
        return 200, {"name": SCRATCHPAD, "version": version_of(out)}

    # ------------------------------------------------------------ the inbox

    def _inbox_file(self) -> Path | None:
        """The inbox's file at the vault's top; None when that name is held by something else than
        a plain file, which is then neither read nor written."""
        path = self.root / rft_inbox.INBOX
        return None if path.is_symlink() or (path.exists() and not path.is_file()) else path

    def inbox(self) -> tuple[int, dict]:
        """The inbox as the page shows it: its items, in the file's order; none until the file is made."""
        path = self._inbox_file()
        if path is None:
            return 422, {"error": f"{rft_inbox.INBOX} in the vault is not a plain file"}
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            return 200, self._inbox_answer([])
        return 200, self._inbox_answer(rft_inbox.Inbox(data.decode("utf-8", errors="replace")).shown())

    def _inbox_answer(self, items: list[dict]) -> dict:
        """The inbox as the page shows it: its items, in the file's order; of each item that has a
        reading note, what the note holds (`notes`, by the item's key: whether the user's part
        holds something, whether Claude's impression is there); and the read items whose
        discussion found no chat to start in (`waiting`, by key)."""
        notes = {}
        for item in items:
            if item["key"] in notes:
                continue
            try:
                note = self._reading_at(item["key"])[1]
            except (rft_reading.ReadingError, OSError):
                continue
            if note:
                notes[item["key"]] = {"mine": bool(note.mine), "impression": bool(note.impression)}
        read = {i["key"] for i in items if i["read"]}
        with self._waiting_lock:
            self._waiting &= read
            waiting = sorted(self._waiting)
        if self.runner:
            # the task an agent of the user's has on an item: running, or why it saved nothing
            seen: dict[str, int] = {}
            shown = []
            for item in items:
                n = seen.get(item["key"], 0)
                seen[item["key"]] = n + 1
                task = self.runner.tasks.get(item_key(item["key"], n))
                shown.append({**item, "task": task.describe()} if task else item)
            items = shown
        return {"name": rft_inbox.INBOX, "items": items, "notes": notes, "waiting": waiting}

    def _inbox_edit(self, edit) -> tuple[int, dict]:
        """One change to the inbox: `edit(box)` changes the file as read and answers (status,
        what to say), or raises InboxError (a 400 in its words). On a 200 the file is written when
        its text changed (made, when there was none), as a new file renamed over the old one, and
        the answer has the items as they are now."""
        path = self._inbox_file()
        if path is None:
            return 422, {"error": f"{rft_inbox.INBOX} in the vault is not a plain file"}
        with self._write_lock:
            try:
                data = path.read_bytes()
            except FileNotFoundError:
                data = None
            try:
                old = "" if data is None else data.decode("utf-8")
            except UnicodeDecodeError:
                return 422, {"error": f"{rft_inbox.INBOX} is not UTF-8 text; edit it in an editor"}
            box = rft_inbox.Inbox(old)
            try:
                status, answer = edit(box)
            except rft_inbox.InboxError as e:
                return 400, {"error": str(e)}
            if status != 200:
                return status, answer
            new = box.text()
            if new != old:
                tmp = path.with_name(f".{path.name}.rft-tmp")
                try:
                    # (a lone surrogate, which JSON can carry and UTF-8 cannot, becomes "?")
                    tmp.write_bytes(new.encode("utf-8", errors="replace"))
                    if data is not None:
                        os.chmod(tmp, stat.S_IMODE(path.stat().st_mode))
                    os.replace(tmp, path)
                finally:
                    tmp.unlink(missing_ok=True)
            shown = box.shown()
        return 200, {**answer, **self._inbox_answer(shown)}

    def _reference_of(self, key: str) -> str | None:
        """The reference note whose Source names this link, when one does."""
        for node in self.tree()["nodes"]:
            if node["type"] != "reference":
                continue
            path = self.note_path(node["id"])
            try:
                text = path.read_text(encoding="utf-8", errors="replace") if path else ""
            except OSError:
                continue
            if key in rft_inbox.links_in(rft_inbox.source_of(text)):
                return node["id"]
        return None

    def add_inbox(self, link: str, why: str = "") -> tuple[int, dict]:
        """Saves a link in the inbox with today's date: one new line in the file. A link that is
        already in the inbox, among the processed items or the Source of a reference note is not
        added (409, saying where it is). A link the user discarded comes back as the item it was,
        its reading note with it (`restored`: the day it was discarded and why): pasting it again
        is the user's act (docs/adr/0007). An arXiv paper's title is asked for afterwards."""
        got = rft_inbox.link_at(rft_inbox.one_line(link))
        if not got or rft_inbox.strip(got[3]):
            return 400, {"error": "not a link: paste a URL, an arXiv id or a DOI"}
        key = got[0]
        ref = self._reference_of(key)

        def edit(box):
            found = box.find(key)
            if found and found[0] == "item":
                when = f", added {found[1]['added']}" if found[1]["added"] else ""
                return 409, {"error": f"already in the inbox{when}", "duplicate": {"in": "inbox", "key": key}}
            if found and found[0] == "discarded":
                return 200, {"item": box.restore(key), "restored": {"discarded": found[1]["discarded"], "reason": found[1]["reason"]}}
            if found:
                when = f" on {found[1]['date']}" if found[1]["date"] else ""
                how = f" ({found[1]['outcome']})" if found[1]["outcome"] else ""
                return 409, {"error": f"already processed{when}{how}", "duplicate": {"in": "processed", "key": key}}
            if ref:
                return 409, {"error": f"already in the tree: {ref} is a reference of it", "duplicate": {"in": "tree", "id": ref}}
            return 200, {"item": box.add(link, why, today=time.strftime("%Y-%m-%d"))}

        status, answer = self._inbox_edit(edit)
        if status == 200 and "restored" in answer:
            with self._write_lock:
                self._return_reading(key)
            answer.update(self._inbox_answer(answer["items"]))
        # (an item that came back is as it was: no title is asked for it)
        if status == 200 and "restored" not in answer and key.startswith("arxiv:") and not answer["item"]["title"]:
            threading.Thread(target=self._arxiv_title, args=(key,), daemon=True).start()
        return status, answer

    def change_inbox(self, action: str, key: str, nth: int = 0, value="", ask=None, confirm: bool = False) -> tuple[int, dict]:
        """One change to an item of the inbox, named by its link's key (and which one, when a link
        was typed twice): its reading priority ("priority": one plain word in the item's line, ""
        for none), its why ("why": "" for none), the user's mark that they have read it ("read":
        True sets it, with today's date, False takes it off), or the item discarded ("discard": its
        lines move under Discarded as they are, with today's date, and it is kept whole:
        docs/adr/0007). Only that item's lines change; 409 when the item is no longer there.

        Marking an item as read starts its discussion: asked of the session, as a turn of the chat
        (docs/adr/0001, 0004). With no chat the mark is saved all the same and the item is said to
        wait (`waiting`); nothing is queued. A discard asks nothing, whatever the item's reading
        note holds: the note is kept, moved to the discarded ones with the last item of its link
        (`confirm`, which a page from before this still sends, changes nothing)."""
        today = time.strftime("%Y-%m-%d")

        def edit(box):
            if action == "discard":
                done = box.discard(key, nth, "", today)
                return (200, {"discarded": done}) if done else (409, {"error": "that item is no longer in the inbox"})
            if action == "read":
                item = box.change(key, nth, read=(box.nth(key, nth) or {}).get("read") or today) if value else box.change(key, nth, read="")
            else:
                item = box.change(key, nth, priority=value) if action == "priority" else box.change(key, nth, why=value)
            return (200, {"item": item}) if item else (409, {"error": "that item is no longer in the inbox"})

        status, answer = self._inbox_edit(edit)
        if status != 200:
            return status, answer
        if action == "discard" and not any(i["key"] == key for i in answer["items"]):
            with self._write_lock:
                self._keep_reading(key)
            answer["notes"].pop(key, None)
        if action == "read":
            with self._waiting_lock:
                self._waiting.discard(key)
            if value:
                answer["asked"] = self._ask_discussion(key, nth, ask) is None
                answer["waiting"] = self._inbox_answer(answer["items"])["waiting"]
        return status, answer

    def _ask_discussion(self, key: str, nth: int, ask) -> str | None:
        """Asks the session to discuss a read item, as a turn of its chat. None when a chat took
        it; else why not, and the item waits: its row says so and its Discuss button asks again."""
        try:
            if ask is None:
                raise NoSession(NO_SESSION)
            ask("RFT_DISCUSS", {"key": key, "nth": nth})
        except (OSError, ValueError) as err:
            with self._waiting_lock:
                self._waiting.add(key)
            return gone(err)
        with self._waiting_lock:
            self._waiting.discard(key)
        return None

    def process_inbox(self, key: str, nth: int, ask, discuss: bool = False, agent=None) -> tuple[int, dict]:
        """The user asks to process an item: asked of the session, where Claude reads it on its own
        and saves its impression and its brief, as a turn of the chat (docs/adr/0001). `discuss`:
        the user asks to discuss an item they marked as read, where Claude opens their part of its
        reading note (docs/adr/0004); 409 when the item is not marked. Nothing is written and
        nothing waits: with no chat to ask, it is refused at once (503), and so is an item that
        is no longer in the inbox (409)."""
        status, got = self.inbox()
        if status != 200:
            return status, got
        same = [i for i in got["items"] if i["key"] == key]
        if nth >= len(same):
            return 409, {"error": "that item is no longer in the inbox"}
        if discuss:
            if not same[nth]["read"]:
                return 409, {"error": "that item is not marked as read"}
            why = self._ask_discussion(key, nth, ask)
            return (503, {"error": why}) if why else (200, {"asked": True, "item": same[nth]})
        try:
            who = self.runner.pick("process", agent) if self.runner else None
        except rft_agents.NoAgent as err:
            return 409, {"error": str(err)}
        if who is not None:
            return self._launch_process(who, key, nth, same[nth])
        try:
            ask("RFT_PROCESS", {"key": key, "nth": nth})
        except (OSError, ValueError) as err:
            return 503, {"error": self._no_one(err, "process")}
        return 200, {"asked": True, "item": same[nth]}

    def _no_one(self, err: Exception, task: str) -> str:
        """Why a thread or an item found no one to go to: no chat is connected, and what the user
        can do about it with agents of their own (a server that knows of none says what it did)."""
        why = gone(err)
        if not self.runner or not isinstance(err, NoSession):
            return why
        able = [a.name for a in self.runner.setup().for_task(task)]
        if able:
            return f"no Claude Code chat is connected: pick one of your agents ({', '.join(able)}), or run /rft in a chat"
        return f"{why}. Or set up an agent of your own, which needs no chat: see Agents in the guide, https://alex-pv01.github.io/rft-guide/using/agents/ ({self.runner.setup().path})"

    def _frozen(self, item: dict) -> str | None:
        """Why an item's impression may not be written again: the user marked it as read and it
        has one, which is what their reading is compared with (docs/adr/0004)."""
        if not item["read"]:
            return None
        try:
            note = self._reading_at(item["key"])[1]
        except (rft_reading.ReadingError, OSError) as err:
            return str(err)
        if note and note.impression:
            return f"you marked this item as read on {item['read']}, and its impression is frozen from then on: it is what your reading is compared with"
        return None

    def _launch_process(self, agent, key: str, nth: int, item: dict) -> tuple[int, dict]:
        """Starts a harness of the user's on an inbox item (docs/adr/0001, since agents): it reads
        the item and the notes, locked, and answers with its impression and its brief, which this
        server saves (save_process). It is never handed the user's part of the reading note."""
        frozen = self._frozen(item)
        if frozen:
            return 409, {"error": frozen}
        prompt = rft_agents.process_prompt(item, rft_reading.PARTS, rft_reading.IMPRESSION_CHARS, rft_reading.DIR, rft_inbox.INBOX)
        runner = self.runner

        def work(run):
            answer = runner.answer(agent, prompt, run, "process", self.root)
            status, got = self.save_process(key, nth, answer, agent.name, run=run)
            if status != 200:
                raise rft_agents.AgentError(got["error"])

        try:
            task = runner.tasks.start(item_key(key, nth), agent.name, item["title"] or item["url"], agent.limits["process"], work, kind="process")
        except rft_agents.Busy as err:
            return 409, {"error": str(err)}
        return 200, {"asked": True, "agent": agent.name, "item": {**item, "task": task.describe()}}

    def save_process(self, key: str, nth: int, answer: str, agent: str, today: str | None = None, run=None) -> tuple[int, dict]:
        """Saves what an agent answered to Process: its impression in the item's reading note,
        headed with the agent's name, and its brief under the item in the inbox. Both or neither:
        an answer that lacks either, a brief that is not three lines, an impression without its
        five parts or longer than a screen, an item that left the inbox or was marked as read
        meanwhile, each saves nothing and says why. The user's part of the reading note and every
        other line of the inbox stay as they were. `run`: the task's, asked before the write
        whether it was stopped meanwhile."""
        try:
            impression, brief = rft_agents.split_process(answer, agent)
            lines = rft_reading.impression_lines(impression)
        except (rft_agents.AgentError, rft_reading.ReadingError) as err:
            return 422, {"error": str(err) if isinstance(err, rft_agents.AgentError) else f"{agent}'s impression was not saved: {err}"}
        today = today or datetime.date.today().isoformat()

        def edit(box):
            item = box.nth(key, nth)
            if not item:
                return 409, {"error": "that item is no longer in the inbox: nothing was saved"}
            frozen = self._frozen(item)
            if frozen:
                return 409, {"error": frozen}
            try:
                path, note, data = self._reading_at(key)
                if note is None:
                    note = rft_reading.Note.new(key, item["url"], item["title"])
            except rft_reading.ReadingError as err:
                return 422, {"error": str(err)}
            try:
                box.brief(key, nth, "\n".join(brief), today)
            except rft_inbox.InboxError as err:
                return 422, {"error": f"{agent}'s brief was not saved: {err}"}
            note.set_impression(lines, today, agent)
            if run is not None:
                run.commit()  # rft_agents.Cancelled when the task was stopped meanwhile: nothing is written
            path.parent.mkdir(exist_ok=True)
            tmp = path.with_name(f".{path.name}.rft-tmp")
            try:
                tmp.write_bytes(note.text().encode("utf-8", errors="replace"))
                if data is not None:
                    os.chmod(tmp, stat.S_IMODE(path.stat().st_mode))
                os.replace(tmp, path)
            finally:
                tmp.unlink(missing_ok=True)
            return 200, {"saved": True}

        return self._inbox_edit(edit)

    def cancel_process(self, key: str, nth: int) -> tuple[int, dict]:
        """The user stops the agent of theirs that is at an item: nothing is saved."""
        if not self.runner or not self.runner.tasks.cancel(item_key(key, nth)):
            return 409, {"error": "no agent of yours is processing this item"}
        return self.inbox()

    # ------------------------------------------------------------ reading notes

    def _reading_dir(self) -> Path | None:
        """The reading notes' folder at the vault's top; None when that name is held by something
        else than a folder (a file, a link), which is then neither read nor written."""
        path = self.root / rft_reading.DIR
        return None if path.is_symlink() or (path.exists() and not path.is_dir()) else path

    def _reading_at(self, key: str) -> tuple[Path, rft_reading.Note | None, bytes | None]:
        """The file of the reading note of the item with this key, the note in it and its bytes
        (None twice when the item has none yet). ReadingError when the folder or the file is not
        a plain one."""
        folder = self._reading_dir()
        if folder is None:
            raise rft_reading.ReadingError(f"{rft_reading.DIR} in the vault is not a folder")
        held: dict[str, bytes] = {}

        def read(name: str) -> str | None:
            path = folder / name
            if path.is_symlink() or (path.exists() and not path.is_file()):
                raise rft_reading.ReadingError(f"{rft_reading.DIR}/{name} is not a plain file")
            try:
                held[name] = path.read_bytes()
            except FileNotFoundError:
                return None
            return held[name].decode("utf-8", errors="replace")

        name, note = rft_reading.find(read, key)
        return folder / name, note, held.get(name)

    def _kept_dir(self) -> Path | None:
        """The folder of the reading notes kept for discarded items, inside the reading notes';
        None when either name is held by something else than a folder."""
        folder = self._reading_dir()
        if folder is None:
            return None
        path = folder / rft_reading.DISCARDED
        return None if path.is_symlink() or (path.exists() and not path.is_dir()) else path

    def _keep_reading(self, key: str) -> None:
        """Moves the reading note of a discarded item, as it is, to the folder of the kept ones
        (docs/adr/0007), under the first name of its family that is free there. A note that
        cannot be moved stays where it is: nothing is removed."""
        try:
            path, note, _ = self._reading_at(key)
            kept = self._kept_dir()
            if not note or kept is None:
                return
            kept.mkdir(exist_ok=True)
            for n in range(rft_reading.TRIES):
                to = kept / rft_reading.file_name(key, n)
                if not to.exists() and not to.is_symlink():
                    os.replace(path, to)
                    return
        except (rft_reading.ReadingError, OSError):
            pass

    def _return_reading(self, key: str) -> None:
        """Moves the reading note kept for a discarded item back beside the others: the latest of
        its name's family in the kept ones that is of this item. A note the item already has is
        not written over: the kept one then stays where it is."""
        try:
            kept = self._kept_dir()
            if kept is None or not kept.is_dir():
                return
            found = None
            for n in range(rft_reading.TRIES):
                path = kept / rft_reading.file_name(key, n)
                if path.is_symlink() or not path.is_file():
                    continue
                if rft_reading.Note(path.read_bytes().decode("utf-8", errors="replace")).key == key:
                    found = path
            if found is None:
                return
            to, note, _ = self._reading_at(key)
            if note is None:
                os.replace(found, to)
        except (rft_reading.ReadingError, OSError):
            pass

    def _inbox_item(self, key: str) -> dict | None:
        """The first item of the inbox with this key."""
        status, got = self.inbox()
        return next((i for i in got["items"] if i["key"] == key), None) if status == 200 else None

    def reading(self, key: str) -> tuple[int, dict]:
        """The reading note of an inbox item as the page shows it: the user's part (`text`,
        newlines as \n) and its version, which is of that part alone, so that an impression saved
        meanwhile is no change to it (None until the item has a note); Claude's impression
        ({"date", "text"}), or None; and the item. 409 when no item of the inbox has the key: a
        reading note is an inbox item's."""
        item = self._inbox_item(key)
        if not item:
            return 409, {"error": "that item is no longer in the inbox"}
        try:
            path, note, _ = self._reading_at(key)
        except rft_reading.ReadingError as e:
            return 422, {"error": str(e)}
        return 200, {"key": key, "item": item, "name": f"{rft_reading.DIR}/{path.name}", "text": note.mine if note else "",
                     "version": version_of(note.mine.encode("utf-8", errors="replace")) if note else None,
                     "impression": note.impression if note else None}

    def write_reading(self, key: str, text: str, version: str | None, force: bool = False) -> tuple[int, dict]:
        """Writes the user's part of an item's reading note, and nothing else of the file: the
        head and Claude's impression stay byte for byte. The file is made on the first write that
        has something in it, never for an empty part. Refused, with the part as it is now, when it
        changed since `version` (None: the item had no note yet), unless `force`."""
        item = self._inbox_item(key)
        if not item:
            return 409, {"error": "that item is no longer in the inbox"}
        with self._write_lock:
            try:
                path, note, data = self._reading_at(key)
            except rft_reading.ReadingError as e:
                return 422, {"error": str(e)}
            now = version_of(note.mine.encode("utf-8", errors="replace")) if note else None
            if not force and version != now:
                return 409, {"error": "the reading note changed since it was read", "version": now, "text": note.mine if note else ""}
            if data is not None:
                try:
                    note = rft_reading.Note(data.decode("utf-8"))
                except UnicodeDecodeError:
                    return 422, {"error": f"{rft_reading.DIR}/{path.name} is not UTF-8 text; edit it in an editor"}
            if note is None:
                if not rft_reading.lines_of(text):
                    return 200, {"key": key, "name": f"{rft_reading.DIR}/{path.name}", "version": None}
                note = rft_reading.Note.new(key, item["url"], item["title"])
            try:
                changed = note.set_mine(text)
            except rft_reading.ReadingError as e:
                return 400, {"error": str(e)}
            if changed:
                path.parent.mkdir(exist_ok=True)
                tmp = path.with_name(f".{path.name}.rft-tmp")
                try:
                    # (a lone surrogate, which JSON can carry and UTF-8 cannot, becomes "?")
                    tmp.write_bytes(note.text().encode("utf-8", errors="replace"))
                    if data is not None:
                        os.chmod(tmp, stat.S_IMODE(path.stat().st_mode))
                    os.replace(tmp, path)
                finally:
                    tmp.unlink(missing_ok=True)
            return 200, {"key": key, "name": f"{rft_reading.DIR}/{path.name}", "version": version_of(note.mine.encode("utf-8", errors="replace"))}

    def _arxiv_title(self, key: str) -> None:
        """Asks arXiv's API for the title of an item just saved and writes it on the item's line.
        A lookup that fails leaves the item as it is; no other host is asked anything."""
        with self._arxiv_lock:
            time.sleep(max(0.0, self.arxiv_pause - (time.monotonic() - self._arxiv_last)))
            try:
                title = self.arxiv_meta(key[len("arxiv:"):])["title"]
            except Exception:
                return
            finally:
                self._arxiv_last = time.monotonic()
        self._inbox_edit(lambda box: (200, {"item": box.set_title(key, title)}))

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
        The answer is the note as api/note gives it. A manuscript's snippet (S..) is discussed the same way."""
        path = self.text_path(nid)
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
                        agent = self.runner.pick("thread", req.get("agent")) if self.runner else None
                    except rft_agents.NoAgent as err:
                        return 409, {"error": str(err), **self.note(nid)}
                    if agent is None:
                        # the connected chat answers, as a turn of its own or in a subagent
                        try:
                            ask("RFT_ASK", {"id": nid, "thread": t["id"]})
                        except (OSError, ValueError) as err:
                            return 503, {"error": self._no_one(err, "thread")}
                        t.pop("asking", None)
                    else:
                        try:
                            self._launch_thread(agent, nid, path, body, t)
                        except rft_agents.Busy as err:
                            return 409, {"error": str(err), **self.note(nid)}
                        t["asking"] = agent.name
                    t["asked"] = now
                elif action == "cancel":
                    # the user stops the agent of theirs that is at this thread: nothing is written
                    if not self.runner or not isinstance(t.get("asking"), str) or not self.runner.tasks.cancel(thread_key(nid, t["id"])):
                        return 409, {"error": "no agent of yours is answering this thread", **self.note(nid)}
                    t["asked"] = None
                    t.pop("asking", None)
                else:
                    return 400, {"error": "action must be new, reply, resolve, reopen, accept, reject, ask or cancel"}
            refreshed(body.replace("\r\n", "\n"), data["threads"])
            self._save_threads(nid, data)
        return 200, self.note(nid)

    def _subject(self, nid: str) -> tuple[str, str]:
        """What a thread is on, in words: (note | snippet | document, its name)."""
        if rft_manuscript.SNIPPET_ID.match(nid):
            return "snippet", nid
        if rft_manuscript.DOC_RE.match(nid) and not ID_RE.match(nid):
            return "document", nid
        path = self.note_path(nid)
        return "note", path.name[:-3] if path else nid

    def _launch_thread(self, agent, nid: str, path: Path, body: str, t: dict) -> None:
        """Starts an agent of the user's on a thread: it is given the thread and the text it is on,
        and its answer is written into the thread by this server (answer_thread). The note is never
        changed by it. rft_agents.Busy when an agent is already at the thread."""
        runner = self.runner
        what, name = self._subject(nid)
        at = locate(body, str(t.get("quote") or ""), str(t.get("prefix") or ""), str(t.get("suffix") or ""))
        rel = None
        if agent.kind != "model":
            try:
                rel = path.resolve().relative_to(self.root).as_posix()
            except ValueError:
                rel = None
        prompt = rft_agents.thread_prompt(what, name, body, json.loads(json.dumps(t)), at, rel)
        tid = t["id"]

        def work(run):
            answer = runner.answer(agent, prompt, run, "thread", self.root)
            status, got = self.answer_thread(nid, tid, answer, agent.name, run=run)
            if status != 200:
                raise rft_agents.AgentError(got["error"])

        def over(state):
            if state != "done":
                self._unask(nid, tid, agent.name)

        runner.tasks.start(thread_key(nid, tid), agent.name, f"{nid} {tid}", agent.limits["thread"], work, over)

    def _unask(self, nid: str, tid: str, agent: str) -> None:
        """A thread no longer waits for an agent that gave no answer."""
        with self._write_lock:
            data = self._threads(nid)
            t = next((x for x in data["threads"] if x["id"] == tid), None)
            if t is None or t.get("asking") != agent:
                return
            t["asked"] = None
            t.pop("asking", None)
            self._save_threads(nid, data)

    def answer_thread(self, nid: str, tid: str, answer: str, agent: str | None = None, now: str | None = None, run=None) -> tuple[int, dict]:
        """Writes an agent's answer into its thread: the new text between <replacement> and
        </replacement> as the suggestion's replacement, for the user to accept or reject, and the
        rest as a message; with no such pair, or where a new text does not fit (a comment thread,
        the quoted text changed, the new text is the quoted text), all of it as a message. The
        note is never changed. Nothing is written for a thread that is gone or closed. As
        answerThread in hooks/lib/comments.ts, case for case (tests/fixtures/agents). `run`: the
        task's, asked before the write whether it was stopped meanwhile."""
        path = self.text_path(nid)
        if path is None:
            return 404, {"error": "the note is gone"}
        text, new = rft_agents.split_answer(answer)
        with self._write_lock:
            data = self._threads(nid)
            t = next((x for x in data["threads"] if x["id"] == tid), None)
            if t is None:
                return 404, {"error": f"{nid} has no thread {tid} any more"}
            if t.get("state") != "open":
                return 409, {"error": f"{nid} {tid} is {t.get('state')}: the answer was not written"}
            body = body_of(path.read_bytes().decode("utf-8", errors="replace"))
            now = now or stamp()
            by = {"by": "claude", "at": now, **({"agent": agent} if agent else {})}
            fits = False
            if new is not None and t.get("kind") == "suggestion":
                at = locate(body, str(t.get("quote") or ""), str(t.get("prefix") or ""), str(t.get("suffix") or ""))
                repl = new.replace("\r\n", "\n")
                fits = bool(at and at[2]) and len(repl) <= MAX_TEXT and repl != t.get("quote") and len(text) <= MAX_TEXT
            if fits:
                t["replacement"] = repl
                message = text
            else:
                message = text if new is None else f"{text}\n\n{new}".strip()
                if new is None and not message:
                    message = "(no answer)"
                if not message or len(message) > MAX_TEXT:
                    return 409, {"error": "the answer is empty" if not message else f"the answer is longer than {MAX_TEXT} characters"}
            if run is not None:
                run.commit()  # rft_agents.Cancelled when the task was stopped meanwhile: nothing is written
            if message:
                t.setdefault("messages", []).append({**by, "text": message})
            t["asked"] = None
            t.pop("asking", None)
            refreshed(body.replace("\r\n", "\n"), data["threads"])
            self._save_threads(nid, data)
        return 200, {"answered": True}

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
            except (OSError, ValueError) as err:
                return 503, {"error": gone(err)}

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
            except (OSError, ValueError) as err:
                return 503, {"error": gone(err)}

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


    # ---------------------------------------------------------------- the manuscript

    def manuscript(self) -> dict:
        """Snippets and documents as the page shows them (rft_manuscript.summary), with each
        snippet's and document's open threads, each document's last PDF, and whether latexmk is there."""
        texts: dict[str, str] = {}
        paths = {n["id"]: n["path"] for n in self.tree()["nodes"]}

        def read(nid: str) -> str:
            if nid not in texts:
                try:
                    texts[nid] = (self.root / paths[nid]).read_text(encoding="utf-8", errors="replace")
                except (KeyError, OSError):
                    texts[nid] = ""
            return texts[nid]

        out = rft_manuscript.summary(self.root, self.tree(), read)
        if not out["exists"]:
            return out
        for x in out["snippets"] + out["documents"]:
            x["threads"] = sum(1 for t in self._threads(x.get("id") or x["name"])["threads"] if t.get("state") == "open")
        for d in out["documents"]:
            pdf = rft_latex.build_dir(self.root, d["name"], d["main"]) / f"{Path(d['main']).stem}.pdf"
            if pdf.is_file():
                d["built"] = int(pdf.stat().st_mtime)
        out["latexmk"] = bool(shutil.which("latexmk"))
        out["templates"] = rft_documents.templates(self.root)
        return out

    def manuscript_path(self, rel: str) -> Path | None:
        """A file the page may read and write: a snippet (snippets/S<n>.tex, an existing one) or a
        text file of a document (documents/<name>/…: .tex, .bib, a class or style file and the
        like, rft_manuscript.EDITED; an existing one, no hidden file or folder)."""
        if not re.fullmatch(r"snippets/S\d+\.tex|documents/[a-z0-9][a-z0-9-]*/[^\\\x00]+", rel or ""):
            return None
        if rel.startswith("documents/") and not rft_manuscript.EDITED.search(rel):
            return None
        if any(part in ("", ".", "..") or part.startswith(".") for part in rel.split("/")):
            return None
        path = self.root / rel
        if not path.is_file() or path.is_symlink():
            return None
        base = (self.root / "/".join(rel.split("/")[:2])).resolve() if rel.startswith("documents/") else rft_manuscript.snippets_dir(self.root).resolve()
        return path if base in path.resolve().parents else None

    def manuscript_file(self, rel: str) -> tuple[int, dict]:
        path = self.manuscript_path(rel)
        if path is None:
            return 404, {"error": "no such snippet or document"}
        data = path.read_bytes()
        out = {"path": rel, "text": data.decode("utf-8", errors="replace"), "version": version_of(data)}
        if rel.startswith("snippets/"):
            out["locked"] = rft_manuscript.snippet_locked(rft_manuscript.read_registry(self.root), Path(rel).stem)
        else:
            name = rel.split("/")[1]
            out["locked"] = rft_manuscript.document_locked(rft_manuscript.read_docs_registry(self.root), name)
        return 200, out

    def write_manuscript_file(self, rel: str, text: str, version: str | None) -> tuple[int, dict]:
        """The user's edit of a snippet or a document, refused with the file as it is now when it
        changed since `version` (None: write anyway)."""
        path = self.manuscript_path(rel)
        if path is None:
            return 404, {"error": "no such snippet or document"}
        with self._write_lock:
            data = path.read_bytes()
            if version is not None and version != version_of(data):
                return 409, {"error": "the file changed since it was opened", **self.manuscript_file(rel)[1]}
            self._write_note(path, data.decode("utf-8", errors="replace"), "", text)
        return self.manuscript_file(rel)

    def set_manuscript_lock(self, level: str, locked: bool, one: str | None = None) -> tuple[int, dict]:
        """Locks or unlocks, for Claude, the snippets (`level` snippets) or the documents
        (`documents`): all of them, or (`one`) one snippet or document while they are locked."""
        if level not in ("snippets", "documents"):
            return 400, {"error": "level must be snippets or documents"}
        path = (rft_manuscript.snippets_dir(self.root) / "snippets.json") if level == "snippets" else (rft_manuscript.documents_dir(self.root) / "documents.json")
        if not path.is_file():
            return 404, {"error": f"this vault has no {level} yet"}
        if one is not None and (self.text_path(one) is None or not (rft_manuscript.SNIPPET_ID if level == "snippets" else rft_manuscript.DOC_RE).match(one)):
            return 404, {"error": f"no such {level[:-1]}"}
        with self._write_lock:
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
            except ValueError:
                return 422, {"error": f"{path.name} is not JSON: fix it by hand"}
            if one is None:
                raw["locked"] = locked
            else:
                unlocked = [x for x in raw.get("unlocked") or [] if x != one]
                raw["unlocked"] = unlocked if locked else unlocked + [one]
            tmp = path.with_name(f".{path.name}.rft-tmp")
            tmp.write_text(json.dumps(raw, indent=2) + "\n", encoding="utf-8")
            os.replace(tmp, path)
        return 200, self.manuscript()

    def vault_ids(self) -> set[str]:
        """The ids a document's files must not carry: the vault's notes and snippets."""
        return {n["id"] for n in self.tree()["nodes"]} | {p.stem for p in rft_manuscript.snippet_files(self.root)}

    def document_files(self, req: dict) -> tuple[int, dict]:
        """What the user does in a document's file list (rft_documents): `new-file` or
        `new-folder` {doc, path}; `move` {doc, path, to} a file or a folder renamed or moved, what
        is tracked of it following; `delete` {doc, path, sure?} (one that holds copies, or the main
        file, only once `sure`). The answer carries the manuscript as it is then."""
        doc, action, path = req.get("doc"), req.get("action"), req.get("path")
        if not isinstance(doc, str) or not isinstance(path, str) or ("to" in req and not isinstance(req["to"], str)):
            return 400, {"error": "expected {doc, action: new-file, new-folder, move or delete, path, to?, sure?}"}
        with self._write_lock:
            if action == "new-file":
                status, out = rft_documents.new_file(self.root, doc, path, self.vault_ids())
            elif action == "new-folder":
                status, out = rft_documents.new_folder(self.root, doc, path, self.vault_ids())
            elif action == "move":
                status, out = rft_documents.move(self.root, doc, path, req.get("to"), self.vault_ids())
            elif action == "delete":
                status, out = rft_documents.delete(self.root, doc, path, req.get("sure") is True)
            else:
                return 400, {"error": "action must be new-file, new-folder, move or delete"}
        return status, ({**out, **self.manuscript()} if status < 300 else out)

    def document_upload(self, doc: str, path: str, data: bytes, replace: bool) -> tuple[int, dict]:
        """A file uploaded into a document (rft_documents.upload), its bytes as they came."""
        with self._write_lock:
            status, out = rft_documents.upload(self.root, doc, path, data, self.vault_ids(), replace)
        return status, ({**out, **self.manuscript()} if status < 300 else out)

    # ---------------------------------------------------------------- a document's repository

    def document_traces(self, doc: str) -> list[dict]:
        """The traces of the tree the scan finds in a document now (those the user allowed left out)."""
        ms = self.manuscript()
        d = next((x for x in ms.get("documents", []) if x["name"] == doc), None)
        return list(d["traces"]) if d else []

    def document_git(self, doc: str, fetching: bool = False) -> tuple[int, dict]:
        """A document's repository as the page shows it (rft_git.state); `fetching` asks its remote first."""
        if not rft_manuscript.is_document(self.root, doc):
            return 404, {"error": "no such document"}
        with self._git_lock:
            return 200, rft_git.state(self.root, doc, fetching)

    def document_git_do(self, req: dict) -> tuple[int, dict]:
        """What the user does to a document's repository from the page: `connect` {doc, url};
        `push` {doc, message}, which records every change and sends it, refused on a trace, when
        behind, or while a conflict is unresolved; `pull` {doc}, which merges the remote's changes.
        One at a time. The answer carries the repository's state, and after a pull the manuscript."""
        doc, action = req.get("doc"), req.get("action")
        if not isinstance(doc, str) or not rft_manuscript.is_document(self.root, doc):
            return 404, {"error": "no such document"}
        with self._git_lock:
            if action == "connect":
                return rft_git.connect(self.root, doc, req.get("url"))
            if action == "push":
                return rft_git.push(self.root, doc, req.get("message"), self.document_traces(doc))
            if action == "pull":
                status, out = rft_git.pull(self.root, doc, self.document_traces(doc))
                return status, ({**out, "manuscript": self.manuscript()} if status < 300 else out)
        return 400, {"error": "action must be connect, push or pull"}

    def document_clone(self, req: dict) -> tuple[int, dict]:
        """A new document from a repository's address {name, url}: cloned, its git data kept apart,
        nothing in it tied to the tree yet. The traces in what came are listed in the page, not removed."""
        name = req.get("name")
        if not (rft_manuscript.documents_dir(self.root) / "documents.json").is_file():
            return 409, {"error": "start the documents first, with a first document (Start, or /rft-manuscript)"}
        with self._git_lock:
            status, out = rft_git.clone(self.root, name, req.get("url"))
            if status < 300:
                rft_documents.write_raw(self.root, name, {"version": 1, "template": "repository", "copies": [], "values": [], "bib": {}, "allowed": []})
                out = {**out, "git": rft_git.state(self.root, name), **self.manuscript()}
        return status, out

    def document_bib(self, doc: str, file: str) -> tuple[int, dict]:
        """The .bib a file of a document uses, for what a placement there cites (rft_manuscript.bib_for):
        `{bib}`, or `{ask: [...]}` when the document has several and nothing says which, so the
        page asks the user before it asks the session."""
        if not rft_manuscript.is_document(self.root, doc):
            return 404, {"error": "no such document"}
        files, _ = rft_manuscript.document_texts(self.root, doc)
        if file not in files or not rft_manuscript.TEX_FILE.search(file):
            return 404, {"error": f"{doc} has no .tex file {file}"}
        tracking = rft_manuscript.read_tracking(self.root, doc)
        return 200, rft_manuscript.bib_for(files, rft_manuscript.main_of(files, tracking["main"])[0], file, tracking["bibOf"])

    def document_reuse(self, req: dict) -> tuple[int, dict]:
        """A document reused (rft_documents): `duplicate` {doc, name} a second document with the
        same files and tracking; `bring-in` {doc, source, into} the document `source` copied into a
        new folder of `doc`, its tracking carried, what clashes and what remains said;
        `add-template` {doc, template} a template's files added, nothing overwritten. The answer
        carries the manuscript as it is then."""
        doc, action = req.get("doc"), req.get("action")
        if not isinstance(doc, str):
            return 400, {"error": "expected {action: duplicate, bring-in or add-template, doc, …}"}
        with self._write_lock:
            if action == "duplicate":
                status, out = rft_documents.duplicate(self.root, doc, req.get("name"))
            elif action == "bring-in":
                status, out = rft_documents.bring_in(self.root, doc, req.get("source"), req.get("into"))
            elif action == "add-template":
                status, out = rft_documents.add_template(self.root, doc, req.get("template"))
            else:
                return 400, {"error": "action must be duplicate, bring-in or add-template"}
        return status, ({**out, **self.manuscript()} if status < 300 else out)

    def load_template(self, name: str, data: bytes) -> tuple[int, dict]:
        """A template loaded from a zip into the vault's templates/ (rft_documents.load_template)."""
        with self._write_lock:
            status, out = rft_documents.load_template(self.root, name, data)
        return status, ({**out, **self.manuscript()} if status < 300 else out)

    def document_settings(self, req: dict) -> tuple[int, dict]:
        """A document's main file ({doc, main}) or its engine ({doc, engine}), kept in its tracking file."""
        doc = req.get("doc")
        if not isinstance(doc, str) or ("main" in req) == ("engine" in req):
            return 400, {"error": "expected {doc, main: a .tex file of it} or {doc, engine: pdflatex, xelatex or lualatex}"}
        with self._write_lock:
            status, out = rft_documents.set_main(self.root, doc, req["main"]) if "main" in req else rft_documents.set_engine(self.root, doc, req["engine"])
        return status, ({**out, **self.manuscript()} if status < 300 else out)

    def compile_manuscript(self, doc: str | None = None, snippet: str | None = None) -> tuple[int, dict]:
        """Compiles a document (rft_latex.compile_doc), or a snippet alone (compile_snippet), one compile at a time."""
        # a pull left a conflict in the document: nothing compiles until git's lines are gone
        bad = rft_git.conflicts(self.root, doc) if snippet is None and rft_manuscript.is_document(self.root, doc or "") and rft_git.available() else []
        if bad:
            return 200, {"ok": False, "conflicts": bad, "error": f"{', '.join(bad)} still {'holds' if len(bad) == 1 else 'hold'} a conflict from the last pull (the lines git wrote, <<<<<<< to >>>>>>>): resolve {'it' if len(bad) == 1 else 'them'} in the editor, then compile"}
        with self._compile_lock:
            r = rft_latex.compile_snippet(self.root, snippet) if snippet is not None else rft_latex.compile_doc(self.root, doc or "")
        r.pop("pdf", None)  # a path on disk: the page asks api/manuscript/pdf
        return (404 if str(r.get("error", "")).startswith("no ") else 200), r

    def manuscript_pdf(self, doc: str | None = None, snippet: str | None = None) -> Path | None:
        build = rft_manuscript.documents_dir(self.root) / ".build"
        if snippet is not None:
            pdf = build / "_snippets" / f"{snippet}.pdf" if rft_manuscript.SNIPPET_ID.match(snippet) else None
        else:
            pdf = rft_latex.pdf_path(self.root, doc) if rft_manuscript.is_document(self.root, doc or "") else None
        return pdf if pdf is not None and pdf.is_file() else None

    def manuscript_saved(self, nid: str) -> tuple[int, dict]:
        """What a note gives a document, for the page's Insert: the numbers its run saved (each as
        the text a document holds), its figures that have a PDF, its tables that have LaTeX, and
        whether it is a reference (cited)."""
        node = next((n for n in self.tree()["nodes"] if n["id"] == nid), None)
        if node is None:
            return 404, {"error": "no such note"}
        names = lambda folder, ext: sorted(p.name[len(nid) + 1:-len(ext)] for p in (self.root / folder).glob(f"{nid}_*{ext}") if p.is_file())  # noqa: E731
        return 200, {"id": nid, "numbers": rft_manuscript.saved_numbers(self.root, nid) or {}, "figures": names("figures", ".pdf"), "tables": names("tables", ".tex"),
                     "reference": node["type"] == "reference"}

    def manuscript_ask(self, req: dict, ask) -> tuple[int, dict]:
        """What the session does for the page, as it does for Claude (hooks/lib/manuscript.ts), so
        stamps, copies and a document's tracking file are made in one place: `new` {kind, title,
        basis} a snippet the user starts; `reviewed` {id} its stamp taken anew; `document` {name,
        kind} a new document; `place` {name, id, file?, after?} a copy of a snippet, `move` {name,
        id, file?, after?} and `remove` {name, id} a copy (S04, or S04#2: the second of S04 there);
        `take` or `keep` {name, id} a copy in review answered; `take-value` or `keep-value` {name,
        index} a value of the tree answered; `point` {name, id, file, from, to} a lost copy found
        again, or a passage made a copy of a snippet; `markers` {name, id} a copy's marker lines
        put back; `allow` {name, file, match, text} a trace allowed; `declare` {name, environment}
        a \\newtheorem line added; `convert` {name} a document of the first design brought to clean
        source; `insert` {name, kind, id, match, file, from, to} a note's saved number, figure or
        table, or a citation of a reference, written as plain LaTeX at a line and column of a file
        and tracked. The answer comes once the files show it."""
        action = req.get("action")
        sdir, ddir = rft_manuscript.snippets_dir(self.root), rft_manuscript.documents_dir(self.root)
        stamp = lambda p: p.stat().st_mtime_ns if p.is_file() else 0  # noqa: E731
        if action == "new":
            if not all(isinstance(req.get(k), str) and req[k].strip() for k in ("kind", "title")) or not isinstance(req.get("basis"), list):
                return 400, {"error": "expected {action: new, kind, title, basis: [ids]}"}
            before = {p.stem for p in rft_manuscript.snippet_files(self.root)}
            found = lambda: next((p.stem for p in rft_manuscript.snippet_files(self.root) if p.stem not in before), None)  # noqa: E731
        elif action == "reviewed":
            sid = req.get("id")
            if not isinstance(sid, str) or not rft_manuscript.SNIPPET_ID.match(sid) or self.text_path(sid) is None:
                return 404, {"error": "no such snippet"}
            reg, was = sdir / "snippets.json", stamp(sdir / "snippets.json")
            found = lambda: sid if stamp(reg) != was else None  # noqa: E731
        elif action == "document":
            # `template`: a built-in one or a folder of the vault's templates/ (`kind`, article or report, is what an older page sends)
            name, template, title = req.get("name"), req.get("template", req.get("kind", "article")), req.get("title", "")
            if not isinstance(name, str) or not rft_manuscript.DOC_RE.match(name) or not isinstance(template, str) \
                    or not isinstance(title, str) or len(title) > 200 or "\n" in title:
                return 400, {"error": "expected {action: document, name: lowercase letters, digits and dashes, template: one of the templates, title?: one line}"}
            if template not in [x["name"] for x in rft_documents.templates(self.root)]:
                return 404, {"error": f"no template {template}"}
            req = {**{k: v for k, v in req.items() if k != "kind"}, "template": template}
            if (ddir / name).exists():
                return 409, {"error": f"there is already a document {name}"}
            found = lambda: name if rft_manuscript.is_document(self.root, name) else None  # noqa: E731
        elif action in ("place", "move", "remove", "take", "keep", "take-value", "keep-value", "point", "markers", "allow", "declare", "convert", "insert"):
            name, sid = req.get("name"), req.get("id")
            if not isinstance(name, str) or not rft_manuscript.is_document(self.root, name):
                return 404, {"error": "no such document"}
            for k in ("file", "after", "match", "text", "environment", "bib"):
                if k in req and not isinstance(req[k], str):
                    return 400, {"error": f"{k} must be text"}
            for k in ("index", "from", "to"):
                if k in req and (not isinstance(req[k], int) or isinstance(req[k], bool) or req[k] < 0):
                    return 400, {"error": f"{k} must be a number"}
            if action in ("place", "point"):
                if not isinstance(sid, str) or not (rft_manuscript.SNIPPET_ID if action == "place" else rft_manuscript.COPY_REF).match(sid):
                    return 400, {"error": f"expected {{action: {action}, name, id: a snippet}}"}
                if action == "point" and not all(k in req for k in ("file", "from", "to")):
                    return 400, {"error": "expected {action: point, name, id, file, from, to}"}
            elif action in ("move", "remove", "take", "keep", "markers"):
                if not isinstance(sid, str) or not rft_manuscript.COPY_REF.match(sid):
                    return 400, {"error": f"expected {{action: {action}, name, id: a copy (S04, or S04#2)}}"}
                copies = rft_manuscript.locate_copies(rft_manuscript.document_texts(self.root, name)[0], rft_manuscript.read_tracking(self.root, name))
                several = {c["snippet"] for c in copies if c["nth"] > 1}
                if sid not in {f"{c['snippet']}#{c['nth']}" for c in copies} | {c["snippet"] for c in copies if c["snippet"] not in several}:
                    return 404, {"error": f"{name} holds no copy {sid}" + (": name which one (S04#2)" if sid in several else "")}
            elif action in ("take-value", "keep-value"):
                if "index" not in req or req["index"] >= len(rft_manuscript.read_tracking(self.root, name)["values"]):
                    return 404, {"error": f"{name} tracks no such value"}
            elif action == "allow":
                if not all(isinstance(req.get(k), str) for k in ("file", "match", "text")):
                    return 400, {"error": "expected {action: allow, name, file, match, text}"}
            elif action == "insert":
                # {name, kind, id: the note, match: its number's, figure's or table's name, file, from: the line, to: the column}
                if req.get("kind") not in ("number", "figure", "table", "citation") or not isinstance(sid, str) or self.text_path(sid) is None \
                        or not all(k in req for k in ("file", "from", "to")) or (req["kind"] != "citation" and not isinstance(req.get("match"), str)):
                    return 400, {"error": "expected {action: insert, name, kind: number, figure, table or citation, id: a note, match: its name there, file, from: a line, to: a column}"}
            elif action == "declare" and not isinstance(req.get("environment"), str):
                return 400, {"error": "expected {action: declare, name, environment}"}
            # the document's own files and its tracking file: whichever the session writes shows it answered
            watched = lambda: [ddir / rft_manuscript.TRACKING / name / "tracking.json", *(p for p in (ddir / name).rglob("*") if p.is_file())]  # noqa: E731
            marks = lambda: sorted((str(p), stamp(p)) for p in watched())  # noqa: E731
            was = marks()
            found = lambda: (sid or name) if marks() != was else None  # noqa: E731
        else:
            return 400, {"error": "action must be new, reviewed, document, place, move, remove, take, keep, take-value, keep-value, point, markers, allow, declare, convert or insert"}
        with self._ask_lock:
            try:
                ask("RFT_MANUSCRIPT", {k: v for k, v in req.items() if k in ("action", "id", "kind", "title", "basis", "name", "after", "file", "index", "match", "text", "environment", "from", "to", "template", "bib")})
            except (OSError, ValueError) as err:
                return 503, {"error": gone(err)}
            deadline = time.monotonic() + NODE_WAIT_S
            while time.monotonic() < deadline:
                time.sleep(0.1)
                got = found()
                if got:
                    return 200, {"id": got, **self.manuscript()}
        return 504, {"error": f"the Claude Code session did not answer within {NODE_WAIT_S:g} s; is the session that ran /rft still open?"}

    # ---------------------------------------------------------------- the figure style

    def style(self) -> dict:
        """The project's figure tokens as the notebooks draw with them (rft_style.resolve): the
        page's artifacts and slides take their colours from them too."""
        return rft_style.resolve(rft_notebook.project_style(self.root))

    # ---------------------------------------------------------------- slide decks

    def decks(self) -> dict:
        """The decks in decks/ (rft_decks.entry each): what each is for, its lock, its slides, its version."""
        out = []
        for p in rft_decks.deck_files(self.root):
            try:
                data = p.read_bytes()
            except OSError:
                continue
            e = rft_decks.entry(p, data, version_of(data))
            if not any(x["id"] == e["id"] for x in out):
                out.append(e)
        return {"decks": out}

    def deck_path(self, did: str) -> Path | None:
        """A deck's file: a markdown file directly in decks/ whose name starts with the id `did`."""
        if not rft_decks.DECK_ID.match(did or ""):
            return None
        for p in rft_decks.deck_files(self.root):
            if rft_decks.id_of(p.stem) == did and not p.is_symlink():
                return p
        return None

    def deck(self, did: str) -> tuple[int, dict]:
        path = self.deck_path(did)
        if path is None:
            return 404, {"error": "no such deck"}
        data = path.read_bytes()
        return 200, {**rft_decks.entry(path, data, version_of(data)), "text": data.decode("utf-8", errors="replace")}

    def write_deck(self, did: str, text: str, version: str | None) -> tuple[int, dict]:
        """The user's edit of a deck, refused with the deck as it is now when it changed since
        `version` (None: write anyway)."""
        path = self.deck_path(did)
        if path is None:
            return 404, {"error": "no such deck"}
        with self._write_lock:
            data = path.read_bytes()
            if version is not None and version != version_of(data):
                return 409, {"error": "the deck changed since it was opened", **self.deck(did)[1]}
            self._write_note(path, data.decode("utf-8", errors="replace"), "", text)
        return self.deck(did)

    def add_deck(self, title: str, items: list[str], subtitle: str = "") -> tuple[int, dict]:
        """A new deck the user starts: the next free P id (after the config's last one and every deck
        on disk), in decks/, locked, for what `items` names (as `for:` writes them), its title slide."""
        title = clean_title(title)
        if not title:
            return 400, {"error": "give the deck a title"}
        if any(not re.fullmatch(r"[GM]\d+(?: \d{4}-\d{2}-\d{2})?", x) for x in items):
            return 400, {"error": "a deck is for a meeting's occurrence (G01 2026-11-24), a once-only meeting (G04) or a deadline (M04)"}
        subtitle = re.sub(r"\s+", " ", subtitle or "").strip()[:200]
        with self._write_lock:
            cfg = self._config().get("lastId")
            last = cfg.get("P", 0) if isinstance(cfg, dict) else 0
            taken = [int(rft_decks.DECK_ID.match(rft_decks.id_of(p.stem)).group(1)) for p in rft_decks.deck_files(self.root)]
            did = f"P{max([last if isinstance(last, int) else 0, *taken]) + 1:02d}"
            d = rft_decks.decks_dir(self.root)
            d.mkdir(exist_ok=True)
            path = d / f"{did} {title}.md"
            path.write_text(rft_decks.new_text(did, title, items, subtitle), encoding="utf-8")
        return 201, self.deck(did)[1]

    def set_deck_lock(self, did: str, locked: bool) -> tuple[int, dict]:
        """Locks a deck (the user's to write: Claude proposes an outline) or unlocks it (Claude may write it too)."""
        path = self.deck_path(did)
        if path is None:
            return 404, {"error": "no such deck"}
        with self._write_lock:
            text = path.read_bytes().decode("utf-8", errors="replace")
            self._write_note(path, text, "", rft_decks.with_lock(text, locked))
        return self.deck(did)

    def figures(self) -> dict:
        """The figures the notebooks saved (figures/<note id>_<name>.svg), by name, for a slide to pick one."""
        d = self.root / FIGURES
        names = [p.name for p in d.iterdir() if p.is_file() and p.suffix.lower() == ".svg"] if d.is_dir() else []
        return {"figures": sorted(names, key=natural_key)}

    def add_deck_asset(self, did: str, mime: str, data: str) -> tuple[int, dict]:
        """An image the user pasted or dropped on a slide: kept in decks/assets/ under its deck's
        name and the next number (`P03-1.png`), which the slide then shows by that name."""
        path = self.deck_path(did)
        if path is None:
            return 404, {"error": "no such deck"}
        ext = DECK_ASSET_TYPES.get(mime)
        if ext is None:
            return 400, {"error": f"not an image a slide shows ({', '.join(sorted(DECK_ASSET_TYPES))})"}
        try:
            raw = base64.b64decode(data, validate=True) if isinstance(data, str) else b""
        except ValueError:
            raw = b""
        if not raw:
            return 400, {"error": "expected the image as base64"}
        assets = path.parent / DECK_ASSETS
        with self._write_lock:
            assets.mkdir(exist_ok=True)
            taken = [int(m.group(1)) for p in assets.iterdir() if (m := re.fullmatch(re.escape(did) + r"-(\d+)\.\w+", p.name))]
            name = f"{did}-{max(taken, default=0) + 1}{ext}"
            (assets / name).write_bytes(raw)
        return 201, {"file": name}

    def deck_image(self, did: str, src: str) -> Path | None:
        """An image a deck shows, found as a note's are, from the decks' folder (then the notebooks' figures)."""
        path = self.deck_path(did)
        return None if path is None else self._find_image(path.parent, src, [self.root / FIGURES])

    def verify(self, nid: str, action: str, ask) -> tuple[int, dict]:
        """The user verifies a note (`verify`: verified, locked and stamped with a fingerprint of
        its claim), dismisses Claude's suggestion to (`dismiss`), or sends a verified note back to
        review (`review`, unlocked). Done by the session, as add_node is, so the stamp is computed
        in one place (hooks/lib/verify.ts); the answer comes once the note shows it."""
        if action not in ("verify", "dismiss", "review"):
            return 400, {"error": "action must be verify, dismiss or review"}
        with self._ask_lock:
            n = next((n for n in self.tree()["nodes"] if n["id"] == nid), None)
            if n is None:
                return 404, {"error": "no such note"}
            if action == "verify" and n["status"] == "verified":
                return 400, {"error": "the note is verified already"}
            if action == "verify" and n["status"] not in ("done", "review"):
                return 400, {"error": f"the note is {n['status']}: only a done note, or one in review, is verified"}
            if action == "review" and n["status"] != "verified":
                return 400, {"error": "only a verified note goes back to review"}
            if action == "dismiss" and not n.get("suggestedVerified"):
                return 400, {"error": "Claude suggested no verification for this note"}
            try:
                ask("RFT_VERIFY", {"id": nid, "action": action})
            except (OSError, ValueError) as err:
                return 503, {"error": gone(err)}

            def found(nodes):
                m = next((m for m in nodes if m["id"] == nid), None)
                if m is None:
                    return None
                if action == "verify":
                    return m if m["status"] == "verified" and m.get("verified") else None
                if action == "review":
                    return m if m["status"] == "review" else None
                return m if not m.get("suggestedVerified") else None

            if self._wait(found):
                return 200, self.note(nid)
        return 504, {"error": f"the Claude Code session did not answer within {NODE_WAIT_S:g} s; "
                              "it may still (is the session that ran /rft still open?)"}

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
            except (OSError, ValueError) as err:
                return 503, {"error": gone(err)}
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



# an artifact's series colours in the dark theme, as web/frame.css has them: the project's tokens are
# for a light page, as its figures are
FRAME_DARK = {"accent": "#9775fa", "series": ["#9775fa", "#20c997", "#fd7e14", "#4dabf7", "#f06595", "#adb5bd"]}


def style_css(t: dict) -> str:
    """The project's tokens as an artifact's colours (frame.css's --accent and --c1 … --c6), in the light theme."""
    cats = t["categorical"]
    vars_ = [f"--accent: light-dark({t['accent']}, {FRAME_DARK['accent']})"]
    vars_ += [f"--c{i + 1}: light-dark({cats[i % len(cats)]}, {d})" for i, d in enumerate(FRAME_DARK["series"])]
    return "\n/* the project's figure tokens (.rft/config.json \"style\") */\n:root { " + "; ".join(vars_) + "; }\n"


def item_key(key: str, nth: int = 0) -> str:
    """What a task on an inbox item is known by."""
    return f"item:{nth}:{key}"


def thread_key(nid: str, tid: str) -> str:
    """What a task on a thread is known by."""
    return f"thread:{nid}:{tid}"


def ask_session(verb: str, request: dict) -> None:
    """Hands a request to the plugin, which reads this process's stdout line by line."""
    print(f"{verb} {json.dumps(request)}", flush=True)


class NoSession(OSError):
    """A server run from a terminal, and no chat that ran /rft on its tree to make what the page asks."""


NO_SESSION = ("this needs a Claude Code chat on this tree, and the view is served from a terminal: "
              "run /rft in a chat, which then makes it")


def gone(err: Exception) -> str:
    """Why a request for the session failed, as the page shows it."""
    return str(err) if isinstance(err, NoSession) else "the Claude Code session that ran /rft is gone"


class Relay:
    """What the page asks of the session, when the server runs from a terminal (rft_serve.py) and has
    no session of its own: the server of a chat that ran /rft on the same tree takes the requests
    (GET api/session/next) every RELAY_POLL_S and prints them for its plugin, as if the page had
    asked it. A chat counts as there for RELAY_ALIVE_S after it last asked."""

    def __init__(self):
        self._cond = threading.Condition()
        self._pending: list[dict] = []
        self._seen = float("-inf")

    def alive(self) -> bool:
        return time.monotonic() - self._seen < RELAY_ALIVE_S

    def ask(self, verb: str, request: dict) -> None:
        """Answers once a chat has taken the request; NoSession at once when no chat is there, or
        when none takes it in time (it is then dropped, so no chat makes it later)."""
        item = {"verb": verb, "request": request}
        with self._cond:
            if not self.alive():
                raise NoSession(NO_SESSION)
            self._pending.append(item)
            end = time.monotonic() + RELAY_ALIVE_S
            while any(x is item for x in self._pending):
                left = end - time.monotonic()
                if left <= 0:
                    self._pending = [x for x in self._pending if x is not item]
                    raise NoSession(NO_SESSION)
                self._cond.wait(left)

    def take(self) -> list[dict]:
        """The requests waiting for a chat, handed to the one asking."""
        with self._cond:
            self._seen = time.monotonic()
            got, self._pending = self._pending, []
            self._cond.notify_all()
            return got


def follow(port: int, token: str, ask=ask_session) -> None:
    """Hands this session what the page asks of it through the terminal's server on `port`, as its
    own server would; returns once that server stops answering."""
    while True:
        try:
            c = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            c.request("GET", "/api/session/next", headers={"X-RFT-Token": token})
            r = c.getresponse()
            body = r.read()
            c.close()
            if r.status != 200:
                return
            for item in json.loads(body)["requests"]:
                ask(item["verb"], item["request"])
        except (OSError, http.client.HTTPException, ValueError, KeyError, TypeError):
            # the terminal's server stopped, mid-answer too (IncompleteRead is no OSError)
            return
        time.sleep(RELAY_POLL_S)


# ------------------------------------------------------------------ http

def make_handler(vault: Vault, web: Path, token: str | None = None, ask=ask_session, editors=None, relay=None, agents=None):
    """The request handler; without a `token` it never writes. `ask` hands a new note to the session;
    `editors` serves the experiments' notebooks (rft_notebook.Editors); a `relay` (a server run from a
    terminal) hands the requests for the session to the chats that ask for them. `agents`: the user's
    setup of agents (rft_agents.Setups); without one the page has the session alone, as before."""
    web = web.resolve()

    if agents is not None:
        vault.runner = rft_agents.Runner(agents)

    def agents_now() -> dict:
        """The agents the page may pick from, and whether a chat is there to be one of them."""
        setup = agents.get() if agents is not None else rft_agents.Setup(Path(""))
        # a server with a setup to write says where it is and what the page's form may add
        more = {"path": str(agents.path), "kinds": list(rft_agents.FORM_KINDS)} if agents is not None else {}
        return {**setup.describe(), "chat": relay.alive() if relay else True, **more}

    def change_agents(req: dict) -> tuple[int, dict]:
        """The user's setup changed from the page, one agent at a time (rft_agents.Setups.change):
        save {name, kind, url?, model?, key?, grant?}, remove {name}; entry {name}: an agent as the
        form shows it for a change; models {url, key?}: the models an endpoint says it has. The
        file is the user's own, outside the vault; a key is never taken, only its variable's name."""
        action, name = req.get("action"), req.get("name")
        try:
            if action == "models":
                if not isinstance(req.get("url"), str) or not isinstance(req.get("key", ""), str):
                    return 400, {"error": "expected {action: models, url, key?}"}
                return 200, {"models": rft_agents.list_models(req["url"], req.get("key", ""), agents.env)}
            if not isinstance(name, str):
                return 400, {"error": "expected {action: save | remove | entry | models, name, ...}"}
            if action == "entry":
                got = agents.entry(name)
                return (200, got) if got else (404, {"error": f"{name} is no agent of the setup"})
            if action == "save":
                agents.change(name, {k: req.get(k, "") for k in ("kind", "url", "model", "key", "grant")})
            elif action == "remove":
                agents.change(name, None)
            else:
                return 400, {"error": "action must be save, remove, entry or models"}
        except rft_agents.SetupError as err:
            return 422, {"error": str(err), **agents_now()}
        except rft_agents.AgentError as err:
            return 502, {"error": str(err)}
        return 200, agents_now()
    editors = editors if editors is not None else rft_notebook.Editors()

    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "rft"
        sys_version = ""

        def log_message(self, fmt, *args):  # quiet: the plugin reads stdout for the URL only
            pass

        def _send(self, status: int, body: bytes, ctype: str, head_only: bool = False, csp: str = PAGE_CSP):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", csp)
            self.end_headers()
            if not head_only:
                self.wfile.write(body)

        def _artifact(self, q: dict, head_only: bool):
            """GET api/artifact?concept=<id>[&theme=dark][&y=<px>][&token=<image key>]: the concept's artifact
            as a document of its own, in a sandbox: its theme, the base style and the frame's runtime first,
            its images through api/image (with the image key when this request carries it or the vault key:
            never the vault key itself, which a script of the page could read)."""
            one = lambda k: (q.get(k) or [""])[0]
            cid = one("concept")
            page = vault.artifact(cid)
            if page is None:
                return self._send(404, b"no artifact for this concept", "text/plain", head_only)
            given = one("token").encode()
            keyed = bool(token) and (secrets.compare_digest(given, token.encode()) or secrets.compare_digest(given, image_key(token).encode()))

            def image(m):
                src = m.group(3)
                if re.match(r"^\s*(data:|https?:|//)", src, re.I):
                    return m.group(0)
                q = m.group(2)
                svg = inline_svg(html_unescape(src))
                if svg is not None:  # inside the page: an SVG from the server would be blocked
                    return f"{m.group(1)}{q}{svg}{q} data-rft-src={q}{html_escape(src, quote=True)}{q}"
                url = f"api/image?artifact={cid}&amp;src={quote(html_unescape(src), safe='')}" + (f"&amp;token={image_key(token)}" if keyed else "")
                return f"{m.group(1)}{q}{url}{q}"

            def inline_svg(src: str) -> str | None:
                """An SVG the artifact shows as a data: image, when it is one it may show: in the vault,
                or anywhere with the key, as api/image serves it; None for any other image."""
                path = vault.artifact_image(cid, src)
                if path is None or path.suffix.lower() != ".svg" or not (keyed or vault.inside(path)):
                    return None
                try:
                    if path.stat().st_size > MAX_INLINE_SVG:
                        return None
                    data = path.read_bytes()
                except OSError:
                    return None
                return "data:image/svg+xml;base64," + base64.b64encode(data).decode("ascii")

            theme = "dark" if one("theme") == "dark" else "light"
            def text(name: str) -> str:
                try:
                    return (web / name).read_text(encoding="utf-8")
                except OSError:  # a plugin folder without it: the page without it
                    return ""
            # each script ends where the next begins: `;` keeps one's opening ( from calling the last
            js, css = "\n;\n".join(text(f) for f in FRAME_SCRIPTS), text("frame.css") + style_css(vault.style())
            doc = wrap_artifact(IMG_SRC_RE.sub(image, page), js, css, theme)
            here = f"http://{(self.headers.get('Host') or '').strip()}"
            self._send(200, doc.encode("utf-8"), "text/html; charset=utf-8", head_only, ARTIFACT_CSP.format(here=here))

        def _image(self, q: dict, head_only: bool):
            """GET api/image?note=<id>&src=<as the note writes it>[&token=<key>]: the image, when
            it is in the vault or the request carries the key. Without the key, an image that is
            not in the vault is refused whether it exists or not, so nothing outside can be probed."""
            one = lambda k: (q.get(k) or [""])[0]
            path = (vault.artifact_image(one("artifact"), one("src")) if one("artifact")
                    else vault.deck_image(one("deck"), one("src")) if one("deck") else vault.image(one("note"), one("src")))
            given = one("token").encode()
            keyed = bool(token) and (secrets.compare_digest(given, token.encode()) or secrets.compare_digest(given, image_key(token).encode()))
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

        def _queue_log(self, q: dict, head_only: bool):
            """GET api/queue/output?id=<job>: a job's output, only for the page carrying the key
            (X-RFT-Token, a header no other page can send): a log may hold what a note does not.
            The monitor follows it by byte, in bounded pieces (rft_queue.read_log): with no `from`,
            its last 64 KB from a line's start; with `from=<end of the last piece>`, what came since.
            `raw=1`: the whole log, as a file to save. `lines=<n>`: its last lines (older pages).
            Whatever goes wrong is answered as an error, never a dropped connection."""
            given = self.headers.get("X-RFT-Token") or ""
            if not token or not secrets.compare_digest(given, token):
                return self._json(403, {"error": "the key is missing or out of date: open the address /rft printed"}, head_only)
            jid = (q.get("id") or [""])[0]
            one = lambda k: (q.get(k) or [""])[0]  # noqa: E731
            try:
                if one("raw") == "1":
                    return self._log_file(jid, head_only)
                if "from" in q or "lines" not in q:
                    try:
                        start = int(one("from")) if one("from") else None
                    except ValueError:
                        start = None
                    return self._json(200, vault.queue.read_log(jid, start), head_only)
                try:
                    lines = int(one("lines"))
                except ValueError:
                    lines = 40
                return self._json(200, {"id": jid, "text": vault.queue.log(jid, lines)}, head_only)
            except rft_queue.NotFound as err:
                return self._json(404, {"error": str(err)}, head_only)
            except (rft_queue.QueueError, OSError) as err:
                return self._json(409, {"error": str(err)}, head_only)
            except Exception as err:  # noqa: BLE001 - said to the page, which shows it, instead of a dropped connection
                return self._json(500, {"error": f"the log was not read: {type(err).__name__}: {err}"}, head_only)

        def _log_file(self, jid: str, head_only: bool):
            """A job's whole output as a file to save, sent in pieces as it is on disk now."""
            path = vault.queue.log_path(jid)
            if path is None or not path.is_file():
                return self._json(404, {"error": f"{jid} has no output yet"}, head_only)
            with open(path, "rb") as f:
                size = os.fstat(f.fileno()).st_size
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Content-Length", str(size))
                self.send_header("Content-Disposition", f'attachment; filename="{jid}.log"')
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Content-Security-Policy", PAGE_CSP)
                self.end_headers()
                if head_only:
                    return
                left = size
                while left > 0:
                    data = f.read(min(1 << 20, left))
                    if not data:
                        break
                    self.wfile.write(data)
                    left -= len(data)

        def _json(self, status: int, obj, head_only=False):
            self._send(status, json.dumps(obj, ensure_ascii=False).encode(), "application/json; charset=utf-8", head_only)

        def _host_ok(self) -> bool:
            host = (self.headers.get("Host") or "").strip().lower()
            name = host.rsplit(":", 1)[0] if not host.startswith("[") else host.split("]")[0] + "]"
            return name in LOOPBACK_HOSTS

        def _proxy(self):
            """A request under notebook/<name>/: passed on as it came to the marimo editor of that name
            (rft_notebook.Editors, which serves under that path), and its answer back as it went; a
            websocket's bytes both ways until either end closes. The editor checks its own key (in the
            address, then its cookie), so the page reaches it through this port alone."""
            head_only = self.command == "HEAD"
            if not self._host_ok():
                return self._send(403, b"forbidden host", "text/plain", head_only)
            name = self.path[len(NOTEBOOK_PREFIX):].split("/", 1)[0].split("?", 1)[0]
            port = editors.port_of(name) if name else None
            if port is None:
                return self._send(502, NOTEBOOK_GONE, "text/html; charset=utf-8", head_only)
            hop = {t.strip().lower() for t in (self.headers.get("Connection") or "").split(",")}
            upgrade = "upgrade" in hop and bool(self.headers.get("Upgrade"))
            lines = [f"{self.command} {self.path} HTTP/1.1"]
            for k, v in self.headers.items():
                if "\r" in v or "\n" in v:
                    return self._send(400, b"bad header", "text/plain", head_only)
                if k.lower() in ("connection", "keep-alive", "proxy-connection") or (k.lower() == "upgrade" and not upgrade):
                    continue
                lines.append(f"{k}: {v}")
            # one request a connection (this server answers HTTP/1.0), a websocket for as long as it lasts
            lines.append("Connection: Upgrade" if upgrade else "Connection: close")
            try:
                up = socket.create_connection(("127.0.0.1", port), timeout=10)
            except OSError:
                return self._send(502, NOTEBOOK_GONE, "text/html; charset=utf-8", head_only)
            self.close_connection = True
            try:
                up.settimeout(None)
                up.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1"))
            except (OSError, UnicodeEncodeError):
                up.close()
                return

            def inward():  # what the browser sends after the head: a body, a websocket's frames
                try:
                    while data := self.rfile.read1(65536):
                        up.sendall(data)
                    up.shutdown(socket.SHUT_WR)
                except (OSError, ValueError):
                    pass
            threading.Thread(target=inward, daemon=True).start()
            try:
                while data := up.recv(65536):
                    self.wfile.write(data)
            except (OSError, ValueError):
                pass
            finally:
                up.close()
                try:
                    self.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

        def _proxy_only(self):
            """DELETE, PATCH, OPTIONS: an editor's under notebook/; read-only elsewhere."""
            if self.path.startswith(NOTEBOOK_PREFIX):
                return self._proxy()
            self._refuse()

        do_DELETE = do_PATCH = do_OPTIONS = _proxy_only

        def do_HEAD(self):
            self.do_GET(head_only=True)

        def do_GET(self, head_only: bool = False):
            if self.path.startswith(NOTEBOOK_PREFIX):
                return self._proxy()
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
                return self._json(200, {"vault": vault.ident, **({"terminal": True} if relay else {})}, head_only)
            if route == "/api/agents":
                return self._json(200, agents_now(), head_only)
            if route == "/api/session/next":
                # a chat's server takes what the page asked of the session (Relay): never a page,
                # which sends an Origin, and only with the key
                if relay is None:
                    return self._send(404, b"not found", "text/plain", head_only)
                given = self.headers.get("X-RFT-Token") or ""
                if self.headers.get("Origin") or not token or not secrets.compare_digest(given, token):
                    return self._json(403, {"error": "the key is missing or out of date"}, head_only)
                return self._json(200, {"requests": [] if head_only else relay.take()}, head_only)
            if route == "/api/note":
                nid = (parse_qs(url.query).get("id") or [""])[0]
                note = vault.note(nid)
                return self._json(200, note, head_only) if note else self._json(404, {"error": "no such note"}, head_only)
            if route == "/api/image":
                return self._image(parse_qs(url.query), head_only)
            if route == "/api/artifact":
                return self._artifact(parse_qs(url.query), head_only)
            if route == "/api/scratchpad":
                return self._json(*vault.scratchpad(), head_only)
            if route == "/api/inbox":
                return self._json(*vault.inbox(), head_only)
            if route == "/api/reading":
                return self._json(*vault.reading((parse_qs(url.query).get("key") or [""])[0]), head_only)
            if route == "/api/style":
                return self._json(200, vault.style(), head_only)
            if route == "/api/decks":
                return self._json(200, vault.decks(), head_only)
            if route == "/api/figures":
                return self._json(200, vault.figures(), head_only)
            if route == "/api/deck":
                return self._json(*vault.deck((parse_qs(url.query).get("id") or [""])[0]), head_only)
            if route == "/api/manuscript":
                return self._json(200, vault.manuscript(), head_only)
            if route == "/api/manuscript/file":
                return self._json(*vault.manuscript_file((parse_qs(url.query).get("path") or [""])[0]), head_only)
            if route == "/api/manuscript/saved":
                return self._json(*vault.manuscript_saved((parse_qs(url.query).get("id") or [""])[0]), head_only)
            if route == "/api/manuscript/pdf":
                # the PDF only for the page carrying the key: a document may hold what no note shows
                given = self.headers.get("X-RFT-Token") or ""
                if not token or not secrets.compare_digest(given, token):
                    return self._json(403, {"error": "the key is missing or out of date: open the address /rft printed"}, head_only)
                q = parse_qs(url.query)
                pdf = vault.manuscript_pdf((q.get("doc") or [None])[0], (q.get("snippet") or [None])[0])
                if pdf is None:
                    return self._json(404, {"error": "not compiled yet"}, head_only)
                return self._send(200, pdf.read_bytes(), "application/pdf", head_only)
            if route == "/api/manuscript/git":
                # a document's repository: its remote is the user's own, so only for the page carrying the key
                given = self.headers.get("X-RFT-Token") or ""
                if not token or not secrets.compare_digest(given, token):
                    return self._json(403, {"error": "the key is missing or out of date: open the address /rft printed"}, head_only)
                q = parse_qs(url.query)
                return self._json(*vault.document_git((q.get("doc") or [""])[0], (q.get("fetch") or [""])[0] == "1"), head_only)
            if route == "/api/manuscript/bib":
                q = parse_qs(url.query)
                return self._json(*vault.document_bib((q.get("doc") or [""])[0], (q.get("file") or [""])[0]), head_only)
            if route == "/api/manuscript/raw":
                # an image or a PDF of a document, for the page carrying the key
                given = self.headers.get("X-RFT-Token") or ""
                if not token or not secrets.compare_digest(given, token):
                    return self._json(403, {"error": "the key is missing or out of date: open the address /rft printed"}, head_only)
                q = parse_qs(url.query)
                got = rft_documents.shown(vault.root, (q.get("doc") or [""])[0], (q.get("path") or [""])[0])
                if got is None:
                    return self._json(404, {"error": "no such image or PDF in that document"}, head_only)
                return self._send(200, got[0].read_bytes(), got[1], head_only, csp=IMAGE_CSP)
            # no queue until this machine is paired with it (rft_queue.Queue.pair): the page shows no monitor
            if route.startswith("/api/queue") and not vault.queue.paired():
                return self._json(404, {"error": NOT_PAIRED}, head_only)
            if route == "/api/queue":
                return self._json(*queue_snapshot(vault.queue), head_only)
            # a job's output: api/queue/output (api/queue/log for older pages, though ad and tracker
            # blockers refuse addresses like it, taking them for an analytics beacon)
            if route in ("/api/queue/output", "/api/queue/log"):
                return self._queue_log(parse_qs(url.query), head_only)
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

        def _bytes_request(self, route: str, limit: int):
            """The URL and the body, as bytes, of an upload to `route` from the page itself; None
            once refused. A body over `limit` is refused before it is read, with its size said."""
            if not self._host_ok():
                return self._send(403, b"forbidden host", "text/plain")
            url = urlsplit(self.path)
            if url.path != route or not token:
                return self._refuse()
            if not self._may_write():
                return self._json(403, {"error": "the key is missing or out of date: open the address /rft printed"})
            try:
                length = int(self.headers.get("Content-Length") or "")
            except ValueError:
                return self._json(411, {"error": "no length"})
            if length < 0:
                return self._json(400, {"error": "no length"})
            if length > limit:
                # the body is read and dropped while it is a few files' worth, so the page gets its answer; a larger one is not read at all
                left = length if length <= 3 * limit else 0
                while left > 0:
                    left -= len(self.rfile.read(min(left, 1 << 20))) or left
                self.close_connection = True
                return self._json(413, {"error": f"the file is {rft_documents.megabytes(length)}: a file of a document is at most {rft_documents.megabytes(limit)}"})
            return url, self.rfile.read(length)

        def do_PUT(self):
            """PUT api/note?id=<id> {"body": "...", "version": "<as read>"} or {"body": "...", "force": true};
            PUT api/scratchpad {"text": "...", "version": "<as read>" or null} or {"text": "...", "force": true};
            PUT api/reading {"key": an inbox item's key, "text": the user's part of its reading note, "version": "<as
            read>" or null} or {"key", "text", "force": true}."""
            if self.path.startswith(NOTEBOOK_PREFIX):
                return self._proxy()
            if urlsplit(self.path).path == "/api/manuscript/upload":
                # PUT api/manuscript/upload?doc=<name>&path=<in the document>[&replace=1], the body the file's bytes
                got = self._bytes_request("/api/manuscript/upload", rft_documents.MAX_UPLOAD)
                if got is None:
                    return
                url, data = got
                q = parse_qs(url.query)
                return self._json(*vault.document_upload((q.get("doc") or [""])[0], (q.get("path") or [""])[0], data, (q.get("replace") or [""])[0] == "1"))
            if urlsplit(self.path).path == "/api/manuscript/template":
                # PUT api/manuscript/template?name=<name>, the body a zip of the template's files
                got = self._bytes_request("/api/manuscript/template", rft_documents.MAX_TEMPLATE)
                if got is None:
                    return
                url, data = got
                return self._json(*vault.load_template((parse_qs(url.query).get("name") or [""])[0], data))
            if urlsplit(self.path).path == "/api/manuscript/file":
                got = self._write_request("/api/manuscript/file", MAX_NOTE_BYTES)
                if got is None:
                    return
                _, req = got
                force = req.get("force") is True
                version = None if force else req.get("version")
                if not isinstance(req.get("path"), str) or not isinstance(req.get("text"), str) or not (force or isinstance(version, str)):
                    return self._json(400, {"error": "expected {path, text, version} or {path, text, force: true}"})
                return self._json(*vault.write_manuscript_file(req["path"], req["text"], version))
            if urlsplit(self.path).path == "/api/deck":
                got = self._write_request("/api/deck", MAX_NOTE_BYTES)
                if got is None:
                    return
                _, req = got
                force = req.get("force") is True
                version = None if force else req.get("version")
                if not isinstance(req.get("id"), str) or not isinstance(req.get("text"), str) or not (force or isinstance(version, str)):
                    return self._json(400, {"error": "expected {id, text, version} or {id, text, force: true}"})
                return self._json(*vault.write_deck(req["id"], req["text"], version))
            if urlsplit(self.path).path == "/api/reading":
                got = self._write_request("/api/reading", MAX_NOTE_BYTES)
                if got is None:
                    return
                _, req = got
                force = req.get("force") is True
                version, key = req.get("version", False), req.get("key")
                if (not isinstance(key, str) or not key or len(key) > MAX_INBOX_LINK or not isinstance(req.get("text"), str)
                        or not (force or version is None or isinstance(version, str))):
                    return self._json(400, {"error": "expected {key, text, version} (null before the note is made) or {key, text, force: true}"})
                return self._json(*vault.write_reading(key, req["text"], None if force else version, force))
            if urlsplit(self.path).path == "/api/scratchpad":
                got = self._write_request("/api/scratchpad", MAX_NOTE_BYTES)
                if got is None:
                    return
                _, req = got
                force = req.get("force") is True
                version = req.get("version", False)
                if not isinstance(req.get("text"), str) or not (force or version is None or isinstance(version, str)):
                    return self._json(400, {"error": "expected {text, version} (null before the file is made) or {text, force: true}"})
                return self._json(*vault.write_scratchpad(req["text"], None if force else version, force))
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
            deadline), {"id": "M..", "due"?, "needs"?, "status"?} or {"id", "accept" | "dismiss": true}; POST
            api/meeting {"title", "when", "duration"?, "every"?, "until"?, "needs"?} (a new meeting), {"id": "G..",
            "when"?, "duration"?, "every"?, "until"?, "skip"?: [days], "moved"?: ["<day> → <when>"], "needs"?} or
            {"id", "delete": true}.
            POST api/notebook {"id": "<id>"}: the address of the experiment's notebook in its repo's
            marimo editor ({"url"}, under notebook/ on this server), the editor started first if need be.
            POST api/inbox {"link": a URL, an arXiv id or a DOI, "why"?: "one line"}: the link saved in
            the inbox ({"item", "items"}; with "restored" when it is a discarded item that came
            back as it was), or 409 with where it already is; {"action": "priority" |
            "why" | "discard", "key": the item's key, "nth"?: which of the items with that key,
            "priority" | "why"?: the new value, "" for none}: the item's reading priority or why
            changed ({"item", "items"}), or the item moved under Discarded, kept whole with its
            reading note ({"discarded", "items"}); {"action": "read", "key", "nth"?, "read": true | false}:
            the user's mark that they have read the item set or taken off ({"item", "items"}; set,
            the session is asked to discuss the item: "asked", false when there is no chat, and
            the item is then among "waiting"); {"action": "process" | "discuss", "key", "nth"?}:
            the session asked to process the item, or to discuss a read one, in its chat
            ({"asked", "item"}), 503 at once when there is no chat."""
            if self.path.startswith(NOTEBOOK_PREFIX):
                return self._proxy()
            route = urlsplit(self.path).path
            if route == "/api/queue":
                got = self._write_request("/api/queue", MAX_NODE_BYTES)
                if got is None:
                    return
                if not vault.queue.paired():
                    return self._json(404, {"error": NOT_PAIRED})
                return self._json(*queue_change(vault.queue, got[1]))
            if route == "/api/notebook":
                got = self._write_request("/api/notebook", MAX_NODE_BYTES)
                if got is None:
                    return
                nid = got[1].get("id")
                if not isinstance(nid, str):
                    return self._json(400, {"error": 'expected {"id": "<id>"}'})
                path = vault.notebook_link(nid)
                if path is None:
                    return self._json(404, {"error": f"{nid} has no notebook in the vault"})
                try:
                    return self._json(200, {"url": editors.open(path, rft_notebook.project_style(vault.root))})
                except rft_notebook.NotebookError as e:
                    return self._json(502, {"error": str(e)})
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
            if route == "/api/meeting":
                got = self._write_request("/api/meeting", MAX_NODE_BYTES)
                if got is None:
                    return
                _, req = got
                if "id" not in req:
                    if not isinstance(req.get("title"), str) or not isinstance(req.get("when"), str):
                        return self._json(400, {"error": "expected {title, when, duration?, every?, until?, needs?} for a new meeting"})
                    return self._json(*vault.add_meeting(req["title"], req))
                if not isinstance(req["id"], str) or not isinstance(req.get("delete", False), bool) or any(k not in (*MEETING_FIELDS, "id", "delete") for k in req):
                    return self._json(400, {"error": "expected {id, when?, duration?, every?, until?, skip?, moved?, needs?} or {id, delete: true}"})
                return self._json(*vault.update_meeting(req["id"], req))
            if route == "/api/agents":
                got = self._write_request("/api/agents", MAX_NODE_BYTES)
                if got is None:
                    return
                if agents is None:
                    return self._json(404, {"error": "this server has no setup of agents to change"})
                return self._json(*change_agents(got[1]))
            if route == "/api/comment":
                got = self._write_request("/api/comment", MAX_COMMENT_BYTES)
                if got is None:
                    return
                _, req = got
                if not isinstance(req.get("id"), str) or not isinstance(req.get("action"), str):
                    return self._json(400, {"error": "expected {id, action, ...}"})
                return self._json(*vault.comment(req["id"], req, ask))
            if route == "/api/inbox":
                got = self._write_request("/api/inbox", MAX_NODE_BYTES)
                if got is None:
                    return
                _, req = got
                action = req.get("action", "add")
                if action in ("priority", "why", "discard"):
                    key, nth, value, confirm = req.get("key"), req.get("nth", 0), req.get(action, ""), req.get("confirm", False)
                    if (not isinstance(key, str) or not key or len(key) > MAX_INBOX_LINK or type(nth) is not int or nth < 0 or type(confirm) is not bool
                            or not isinstance(value, str) or len(value) > MAX_INBOX_WHY or (action != "discard" and action not in req)):
                        return self._json(400, {"error": 'expected {"action": "priority" | "why" | "discard", "key": the item\'s key, "nth"?: which of them, "priority" | "why": the new value, "confirm"?: true (of an older page: it changes nothing)}'})
                    return self._json(*vault.change_inbox(action, key, nth, value, confirm=confirm))
                if action == "read":
                    key, nth, value = req.get("key"), req.get("nth", 0), req.get("read")
                    if not isinstance(key, str) or not key or len(key) > MAX_INBOX_LINK or type(nth) is not int or nth < 0 or type(value) is not bool:
                        return self._json(400, {"error": 'expected {"action": "read", "key": the item\'s key, "nth"?: which of them, "read": true to mark it as read, false to take the mark off}'})
                    return self._json(*vault.change_inbox(action, key, nth, value, ask=ask))
                if action in ("process", "discuss"):
                    key, nth = req.get("key"), req.get("nth", 0)
                    if not isinstance(key, str) or not key or len(key) > MAX_INBOX_LINK or type(nth) is not int or nth < 0:
                        return self._json(400, {"error": 'expected {"action": "process" | "discuss", "key": the item\'s key, "nth"?: which of them}'})
                    return self._json(*vault.process_inbox(key, nth, ask, discuss=action == "discuss", agent=req.get("agent")))
                if action == "cancel":
                    key, nth = req.get("key"), req.get("nth", 0)
                    if not isinstance(key, str) or not key or len(key) > MAX_INBOX_LINK or type(nth) is not int or nth < 0:
                        return self._json(400, {"error": 'expected {"action": "cancel", "key": the item\'s key, "nth"?: which of them}'})
                    return self._json(*vault.cancel_process(key, nth))
                if action != "add":
                    return self._json(400, {"error": 'expected "action": "add", "priority", "why", "read", "discard", "process", "discuss" or "cancel"'})
                link, why = req.get("link"), req.get("why", "")
                if not isinstance(link, str) or not isinstance(why, str) or len(link) > MAX_INBOX_LINK or len(why) > MAX_INBOX_WHY:
                    return self._json(400, {"error": 'expected {"link": a URL, an arXiv id or a DOI, "why"?: one line}'})
                return self._json(*vault.add_inbox(link, why))
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
            if route == "/api/deck":
                got = self._write_request("/api/deck", MAX_NODE_BYTES)
                if got is None:
                    return
                _, req = got
                items = req.get("for", [])
                if not isinstance(req.get("title"), str) or not isinstance(items, list) or not all(isinstance(x, str) for x in items) \
                        or not isinstance(req.get("subtitle", ""), str):
                    return self._json(400, {"error": "expected {title, for?: [items], subtitle?}"})
                return self._json(*vault.add_deck(req["title"], items, req.get("subtitle", "")))
            if route == "/api/deck/asset":
                got = self._write_request("/api/deck/asset", MAX_ASSET_BYTES)
                if got is None:
                    return
                _, req = got
                if not isinstance(req.get("id"), str) or not isinstance(req.get("type"), str) or not isinstance(req.get("data"), str):
                    return self._json(400, {"error": "expected {id, type, data: the image as base64}"})
                return self._json(*vault.add_deck_asset(req["id"], req["type"], req["data"]))
            if route == "/api/deck/lock":
                got = self._write_request("/api/deck/lock", MAX_NODE_BYTES)
                if got is None:
                    return
                _, req = got
                if not isinstance(req.get("id"), str) or not isinstance(req.get("locked"), bool):
                    return self._json(400, {"error": "expected {id, locked: true or false}"})
                return self._json(*vault.set_deck_lock(req["id"], req["locked"]))
            if route == "/api/manuscript/compile":
                got = self._write_request("/api/manuscript/compile", MAX_NODE_BYTES)
                if got is None:
                    return
                _, req = got
                if not (isinstance(req.get("doc"), str) or isinstance(req.get("snippet"), str)):
                    return self._json(400, {"error": "expected {doc} or {snippet}"})
                return self._json(*vault.compile_manuscript(req.get("doc"), req.get("snippet")))
            if route == "/api/manuscript/reuse":
                got = self._write_request("/api/manuscript/reuse", MAX_NODE_BYTES)
                if got is None:
                    return
                return self._json(*vault.document_reuse(got[1]))
            if route == "/api/manuscript/git":
                got = self._write_request("/api/manuscript/git", MAX_NODE_BYTES)
                if got is None:
                    return
                return self._json(*vault.document_git_do(got[1]))
            if route == "/api/manuscript/clone":
                got = self._write_request("/api/manuscript/clone", MAX_NODE_BYTES)
                if got is None:
                    return
                return self._json(*vault.document_clone(got[1]))
            if route == "/api/manuscript/files":
                got = self._write_request("/api/manuscript/files", MAX_NODE_BYTES)
                if got is None:
                    return
                return self._json(*vault.document_files(got[1]))
            if route == "/api/manuscript/settings":
                got = self._write_request("/api/manuscript/settings", MAX_NODE_BYTES)
                if got is None:
                    return
                return self._json(*vault.document_settings(got[1]))
            if route == "/api/manuscript/lock":
                got = self._write_request("/api/manuscript/lock", MAX_NODE_BYTES)
                if got is None:
                    return
                _, req = got
                if not isinstance(req.get("locked"), bool) or ("id" in req and not isinstance(req["id"], str)) or req.get("level") not in ("snippets", "documents"):
                    return self._json(400, {"error": "expected {level: snippets or documents, locked: true or false, id?: a snippet or document}"})
                return self._json(*vault.set_manuscript_lock(req["level"], req["locked"], req.get("id")))
            if route == "/api/manuscript/ask":
                got = self._write_request("/api/manuscript/ask", MAX_NODE_BYTES)
                if got is None:
                    return
                return self._json(*vault.manuscript_ask(got[1], ask))
            if route == "/api/verify":
                got = self._write_request("/api/verify", MAX_NODE_BYTES)
                if got is None:
                    return
                _, req = got
                if not all(isinstance(req.get(k), str) for k in ("id", "action")):
                    return self._json(400, {"error": "expected {id, action: verify, dismiss or review}"})
                return self._json(*vault.verify(req["id"], req["action"], ask))
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

    return Handler


def queue_snapshot(q) -> tuple[int, dict]:
    """GET api/queue: the GPUs, the jobs waiting and running, the last ones that ended. A queue with
    work and no runner (the machine restarted, the runner stopped) gets one."""
    try:
        snap = q.snapshot(100)
    except rft_queue.QueueError as err:
        return 500, {"error": str(err)}
    if not snap["runner"] and any(j["state"] == "running" or (j["state"] == "pending" and not snap["paused"]) for j in snap["jobs"]):
        try:
            q.wake()
        except OSError:
            pass
    return 200, snap


NOT_PAIRED = "no machine is paired with this vault's experiment queue, so there is no queue: /rft-machine add pairs this one"

QUEUE_OPS = ('expected {op: "move", id, before?: "top" or a job id or null}, {op: "cancel", id}, {op: "retry", id}, '
             '{op: "pause", paused: true or false} or {op: "gpus", allowed: [GPU indices] or null}')


def queue_change(q, req: dict) -> tuple[int, dict]:
    """POST api/queue: the user's change to the queue, from the monitor."""
    op, jid = req.get("op"), req.get("id")
    try:
        if op == "move" and isinstance(jid, str) and (req.get("before") is None or isinstance(req.get("before"), str)):
            return 200, {"job": q.move(jid, req.get("before"))}
        if op == "cancel" and isinstance(jid, str):
            return 200, {"job": q.cancel(jid, "cancelled in the tree view")}
        if op == "retry" and isinstance(jid, str):
            return 200, {"job": q.retry(jid, by="user")}
        if op == "pause" and isinstance(req.get("paused"), bool):
            return 200, q.pause(req["paused"])
        if op == "gpus" and "allowed" in req:
            return 200, q.allow(req["allowed"])
    except rft_queue.NotFound as err:
        return 404, {"error": str(err)}
    except rft_queue.QueueError as err:
        return 409, {"error": str(err)}
    return 400, {"error": QUEUE_OPS}


def cache_root() -> Path:
    """The plugin's folder in the user's cache (XDG_CACHE_HOME, else ~/.cache)."""
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "rft"


def vault_key(vault: Path) -> str:
    """The key for writes to this vault, kept in the user's cache readable by them alone (XDG_CACHE_HOME,
    else ~/.cache), so an address with it, or a browser that remembers it, still works after a restart."""
    keys = cache_root() / "keys"
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


def id_on(port: int) -> dict:
    """What the rft server listening on `port` says it is (GET api/id), or {} when it is not one."""
    try:
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
        c.request("GET", "/api/id")
        r = c.getresponse()
        body = r.read()
        c.close()
        got = json.loads(body) if r.status == 200 else {}
        return got if isinstance(got, dict) else {}
    except (OSError, http.client.HTTPException, ValueError):
        return {}


def vault_on(port: int) -> str | None:
    """The vault id of the rft server listening on `port`, or None when it is not one."""
    return id_on(port).get("vault")


def host_record(vault: Vault) -> Path:
    """Where the terminal's server of `vault` writes its port, for the chats on the tree to find it
    on a port of its own (no `webPort`)."""
    return cache_root() / "hosts" / vault.ident


def write_host_record(vault: Vault, port: int) -> None:
    path = host_record(vault)
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = path.with_name(f"{path.name}.{os.getpid()}")
        tmp.write_text(json.dumps({"port": port, "pid": os.getpid()}))
        os.replace(tmp, path)
    except OSError:
        pass  # the chats find it on the configured port only


def drop_host_record(vault: Vault) -> None:
    """Removes the record, when it is this process's."""
    path = host_record(vault)
    try:
        if json.loads(path.read_text()).get("pid") == os.getpid():
            path.unlink()
    except (OSError, ValueError, AttributeError):
        pass


def terminal_host(vault: Vault, ports) -> int | None:
    """The port of a server of `vault` run from a terminal: the one its record names, else one of
    `ports`; None when there is none (a record left by one that was killed counts for nothing)."""
    try:
        recorded = int(json.loads(host_record(vault).read_text())["port"])
    except (OSError, ValueError, KeyError, TypeError):
        recorded = None
    for port in dict.fromkeys([recorded, *ports]):
        if port:
            got = id_on(port)
            if got.get("vault") == vault.ident and got.get("terminal") is True:
                return port
    return None


def take_over(port: int, handler, every: float = 1.0):
    """Binds `port` as soon as it is free: when the session that serves it there ends."""
    while True:
        time.sleep(every)
        try:
            return bind(port, handler)
        except OSError:
            pass


def watch_parent(server, watch_stdin: bool, on_exit=None):
    """Exit when the parent dies (we are re-parented), and with --watch-stdin when it closes our stdin;
    `on_exit` runs first (the notebook editors are stopped)."""
    parent = os.getppid()

    def leave():
        if on_exit:
            try:
                on_exit()
            except Exception:
                pass
        os._exit(0)

    def by_pid():
        while True:
            time.sleep(2)
            if os.getppid() != parent:
                leave()

    def by_stdin():
        try:
            while sys.stdin.buffer.read(1024):
                pass
        except Exception:
            pass
        leave()

    threading.Thread(target=by_pid, daemon=True).start()
    if watch_stdin and not sys.stdin.isatty():
        threading.Thread(target=by_stdin, daemon=True).start()


def serve_session(a, vault: Vault, token: str, handler, announce):
    """The server of a chat that ran /rft, bound, after it printed its address. When the tree is
    served from a terminal, its address is the chat's: the chat makes what the page asks of the
    session there (follow), and serves it itself once the terminal stops. When another chat serves
    the tree on the configured port, its address is the chat's too, and its port once it ends."""
    at = None  # the port of the address printed
    while True:
        host = terminal_host(vault, [a.port, at])
        if host:
            if at is None:
                announce(host)
                at = host
            follow(host, token)
            time.sleep(RELAY_POLL_S)
            continue
        port = at if at is not None else a.port
        try:
            server = bind(port, handler)
        except OSError as err:
            if not port or err.errno != errno.EADDRINUSE:
                raise
            if at is not None:
                # the address printed is the one the plugin shows: the port is waited for, whoever
                # holds it a moment (as take_over waits for it)
                time.sleep(1.0)
                continue
            if vault_on(port) == vault.ident:
                # another chat's server of this vault, with the same key: its address is ours, and
                # its port once it stops (or a terminal's server that takes it over meanwhile)
                announce(port)
                at = port
                time.sleep(1.0)
                continue
            print(f"rft: port {port} is taken, serving on a free port", file=sys.stderr, flush=True)
            server = bind(0, handler)
            announce(server.server_address[1])
            return server
        if at is None:
            announce(server.server_address[1])
        return server


def serve_terminal(a, vault: Vault, handler, url, say):
    """The server run from a terminal (rft_serve.py), bound; None when another terminal serves the
    tree already. A chat's server on the configured port keeps it until that chat ends."""
    other = terminal_host(vault, [a.port])
    if other:
        say(f"rft: {a.project} is already served from another terminal, at {url(other)}")
        return None
    try:
        server = bind(a.port, handler)
    except OSError as err:
        if not a.port or err.errno != errno.EADDRINUSE:
            raise
        if vault_on(a.port) == vault.ident:
            say(f"rft: a Claude Code chat serves {a.project} at {url(a.port)}; this terminal serves it once that chat ends")
            server = take_over(a.port, handler)
        else:
            say(f"rft: port {a.port} is taken, serving on a free port")
            server = bind(0, handler)
    port = server.server_address[1]
    write_host_record(vault, port)
    say(f"rft: the tree view of {a.project} is at {url(port)}  (Ctrl+C stops it)")
    return server


CHAT_ON = ("a Claude Code chat on this tree is connected: it makes what the page asks of the session "
           "(Add child, Change type, Move, Verify, the Manuscript's changes, Ask Claude, Process, Discuss)")
CHAT_OFF = ("no Claude Code chat is connected: the page's Add child, Change type, Move, Verify, "
            "Manuscript changes and Discuss are refused until /rft runs in one; a thread and Process "
            "go to an agent of your setup, when you have one that may take them")


def watch_chats(relay: Relay, say, every: float = 0.5) -> None:
    """Says in the terminal when a chat starts or stops making what the page asks of the session."""
    was = False
    while True:
        time.sleep(every)
        now = relay.alive()
        if now != was:
            say(f"rft {time.strftime('%H:%M')}: {CHAT_ON if now else CHAT_OFF}")
            was = now


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--vault", required=True)
    ap.add_argument("--web", required=True)
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--project", default="project")
    ap.add_argument("--config", default=None, help="the project's .rft/config.json (gpus:, the last milestone and meeting ids)")
    ap.add_argument("--no-watch", action="store_true", help="do not exit with the parent (for manual runs)")
    ap.add_argument("--watch-stdin", action="store_true", help="also exit when stdin is closed")
    ap.add_argument("--terminal", action="store_true",
                    help="run from a terminal (rft_serve.py): a chat that runs /rft on the tree makes what the page asks of the session")
    a = ap.parse_args(argv)
    vault = Vault(Path(a.vault), a.project, Path(a.config) if a.config else None)
    token = vault_key(Path(a.vault))
    editors = rft_notebook.Editors()
    relay = Relay() if a.terminal else None
    handler = make_handler(vault, Path(a.web), token, ask=relay.ask if relay else ask_session, editors=editors, relay=relay,
                           agents=rft_agents.Setups())
    if not a.no_watch:
        watch_parent(None, a.watch_stdin, on_exit=editors.stop_all)

    def leave(*_):
        # the editors run in process groups of their own, so they are stopped too
        editors.stop_all()
        if relay:
            drop_host_record(vault)
        os._exit(0)

    # stopped from outside, or (from a terminal) the terminal closed, unless run to outlive it (nohup)
    signal.signal(signal.SIGTERM, leave)
    if a.terminal and signal.getsignal(signal.SIGHUP) is not signal.SIG_IGN:
        signal.signal(signal.SIGHUP, leave)

    def url(port: int) -> str:
        return f"http://127.0.0.1:{port}/?token={token}"

    def say(text: str):
        print(text, flush=True)

    try:
        if relay:
            server = serve_terminal(a, vault, handler, url, say)
            if server is None:
                return
            threading.Thread(target=watch_chats, args=(relay, say), daemon=True).start()
        else:
            server = serve_session(a, vault, token, handler, lambda port: print(f"RFT_SERVER_URL {url(port)}", flush=True))
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        editors.stop_all()
        if relay:
            drop_host_record(vault)


if __name__ == "__main__":
    main()
