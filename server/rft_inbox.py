"""The inbox: links the user saved to read later, in one markdown file at the vault's top
(Inbox.md, beside the scratchpad's), outside the tree. The file is the user's: they paste into it
and edit it in Obsidian, so it is read as it is typed and nothing here rewrites it. A write, when
there is one, changes single lines and leaves the rest as it was.

    # Inbox

    - [Mixup at scale](https://arxiv.org/abs/2406.01234) — maybe relevant to D04 · high · added 2026-11-16
      - briefed 2026-11-23: claims …
      - touches R07, E12
      - recommends: reference under D04
    - https://example.org/blog/post

    ## Processed

    - 2026-11-23 [Mixup at scale](https://arxiv.org/abs/2406.01234) → R15
    - 2026-11-23 https://example.org/blog/post — discarded: superseded by R07

An item is a top-level list line that starts with a link: a markdown link, a URL, an arXiv id or a
DOI. After the link, parts set apart by `·`: why it was saved (after a dash), its reading priority
as one word, `added <date>`. A brief is the indented list lines under it, the first starting
`briefed <date>:`. Any other line (free text, a to-do, a heading of the user's own) is not an item.
hooks/lib/inbox.ts reads the same file the same way; tests/fixtures/inbox holds both to one file.
Standard library only.
"""
from __future__ import annotations

import re
from urllib.parse import urlsplit

INBOX = "Inbox.md"
PRIORITIES = ("urgent", "high", "medium", "low")

ARXIV_ID = r"(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})"
ARXIV_URL = re.compile(rf"^https?://(?:www\.|export\.)?arxiv\.org/(?:abs|pdf)/({ARXIV_ID})(?:v\d+)?(?:\.pdf)?/?(?:[?#].*)?$", re.I)
ARXIV_BARE = re.compile(rf"^(?:arxiv:\s*)?({ARXIV_ID})(?:v\d+)?$", re.I)
DOI_ID = r"10\.\d{4,9}/\S+"
DOI_URL = re.compile(rf"^https?://(?:dx\.)?doi\.org/({DOI_ID})$", re.I)
DOI_BARE = re.compile(rf"^(?:doi:\s*)?({DOI_ID})$", re.I)
# a link at the start of an item: [title](target), <target>, or the target itself
MD_LINK = re.compile(r"^\[([^\]]*)\]\(\s*<?([^)\s>]+)>?\s*\)")
ANGLE = re.compile(r"^<([^>\s]+)>")
BARE = re.compile(rf"^(?:https?://\S+|arxiv:\s*{ARXIV_ID}(?:v\d+)?|{ARXIV_ID}(?:v\d+)?|doi:\s*{DOI_ID}|{DOI_ID})", re.I)
ITEM = re.compile(r"^[-*+][ \t]+(.*)$")
SUB = re.compile(r"^[ \t]+[-*+][ \t]+(.*)$")
PROCESSED = re.compile(r"^##[ \t]+processed[ \t]*$", re.I)
HEADING = re.compile(r"^#{1,2}[ \t]")
BRIEFED = re.compile(r"^briefed[ \t]+(\d{4}-\d{2}-\d{2})[ \t]*:?[ \t]*(.*)$", re.I)
ADDED = re.compile(r"^added[ \t]+(\d{4}-\d{2}-\d{2})$", re.I)
DATED = re.compile(r"^(\d{4}-\d{2}-\d{2})[ \t]+(.*)$")
DASH = re.compile(r"^(?:—|–|->|-{1,2}|→)[ \t]*")  # `->` before `-`, or its `>` is left behind


def target_of(target: str) -> tuple[str, str] | None:
    """A link's identity and the address that opens it: `arxiv:<id>` whatever the form the paper
    was given in (abs, pdf, a version), `doi:<doi>`, or the URL without its fragment and trailing
    slash. None when it is none of these."""
    t = target.strip()
    m = ARXIV_URL.match(t) or ARXIV_BARE.match(t)
    if m:
        return f"arxiv:{m.group(1)}", f"https://arxiv.org/abs/{m.group(1)}"
    m = DOI_URL.match(t) or DOI_BARE.match(t)
    if m:
        return f"doi:{m.group(1).lower()}", f"https://doi.org/{m.group(1)}"
    if not re.match(r"^https?://", t, re.I):
        return None
    try:
        u = urlsplit(t)
    except ValueError:
        return None
    if not u.netloc:
        return None
    key = f"{u.scheme.lower()}://{u.netloc.lower()}{u.path.rstrip('/')}" + (f"?{u.query}" if u.query else "")
    return key, t


def link_at(text: str) -> tuple[str, str, str, str] | None:
    """The link a line's text starts with: its key, its address, its title and the text after it."""
    m = MD_LINK.match(text)
    if m:
        got = target_of(m.group(2))
        return (*got, m.group(1).strip(), text[m.end():]) if got else None
    m = ANGLE.match(text)
    if m:
        got = target_of(m.group(1))
        return (*got, "", text[m.end():]) if got else None
    m = BARE.match(text)
    if not m or (m.end() < len(text) and not text[m.end()].isspace()):
        return None
    raw = m.group(0)
    if re.match(r"^https?://", raw, re.I):
        raw = raw.rstrip(".,;")
    got = target_of(raw)
    return (*got, "", text[m.end():]) if got else None


def tail_of(tail: str) -> tuple[str, str, str]:
    """What follows an item's link: why it was saved, its reading priority, the day it was added.
    A priority word counts only as a part of its own (or as all there is): inside a why it is the
    why's."""
    why, priority, added = [], "", ""
    for part in (p.strip() for p in DASH.sub("", tail.strip(), count=1).split("·")):
        a = ADDED.match(part)
        if a and not added:
            added = a.group(1)
        elif part.lower() in PRIORITIES and not priority:
            priority = part.lower()
        elif part:
            why.append(part)
    return " · ".join(why), priority, added


class Inbox:
    """The file as read: its lines, as they are, and what they hold. `items` and `processed` are
    in the file's order; each item knows its lines (`at`: the first, and one past its last)."""

    def __init__(self, text: str):
        self.crlf = "\r\n" in text
        self.lines = text.replace("\r\n", "\n").split("\n")
        self.items: list[dict] = []
        self.processed: list[dict] = []
        seen: set[str] = set()
        done = False
        i = 0
        while i < len(self.lines):
            line = self.lines[i]
            i += 1
            if HEADING.match(line):
                done = bool(PROCESSED.match(line))
                continue
            m = ITEM.match(line)
            if not m:
                continue
            rest = m.group(1).strip()
            if done:
                d = DATED.match(rest)
                got = link_at(d.group(2) if d else rest)
                if got:
                    key, _, title, tail = got
                    self.processed.append({"date": d.group(1) if d else "", "key": key, "title": title,
                                           "outcome": DASH.sub("", tail.strip(), count=1).strip()})
                continue
            got = link_at(rest)
            if not got:
                continue
            key, url, title, tail = got
            why, priority, added = tail_of(tail)
            subs = []
            while i < len(self.lines) and SUB.match(self.lines[i]):
                subs.append(SUB.match(self.lines[i]).group(1).strip())
                i += 1
            b = BRIEFED.match(subs[0]) if subs else None
            brief = {"date": b.group(1), "lines": [s for s in [b.group(2).strip(), *subs[1:]] if s]} if b else None
            self.items.append({"key": key, "url": url, "title": title, "why": why, "priority": priority, "added": added,
                               "duplicate": key in seen, "brief": brief, "at": (i - len(subs) - 1, i)})
            seen.add(key)

    def text(self) -> str:
        """The file again: as it was read, when nothing changed."""
        out = "\n".join(self.lines)
        return out.replace("\n", "\r\n") if self.crlf else out

    def shown(self) -> list[dict]:
        """The items as the page and the tool show them (without their place in the file)."""
        return [{k: v for k, v in item.items() if k != "at"} for item in self.items]
