"""The inbox: links the user saved to read later, in one markdown file at the vault's top
(Inbox.md, beside the scratchpad's), outside the tree. The file is the user's: they paste into it
and edit it in Obsidian, so it is read as it is typed and nothing here rewrites it. A write (an
item added, its why or its reading priority set, a title found for it, the item taken out with
what was decided for it) changes single lines and leaves the rest as it was.

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
as one word, `added <date>`, and `read <date>` once the user marked it as read. A brief is the
indented list lines under it, the first starting `briefed <date>:`. Any other line (free text, a to-do, a heading of the user's own) is not an item.

hooks/lib/inbox.ts reads and writes the same file the same way, pattern for pattern, and
tests/fixtures/inbox holds both to one file and one list of cases. So that the two cannot differ on
a line no case has, nothing here is left to what Python and JavaScript each take a word to mean:
white space is the set spelled out in WS (not `\\s`, `strip()` or `isspace()`), digits are `[0-9]`,
letters match without case in ASCII alone, a pattern ends at the end of the text (`\\Z`) and `.`
takes any character. Standard library only.
"""
from __future__ import annotations

import re

INBOX = "Inbox.md"
PRIORITIES = ("urgent", "high", "medium", "low")


class InboxError(ValueError):
    """What cannot be added to the inbox, in words for the user."""


def rx(pattern: str, nocase: bool = False) -> re.Pattern:
    return re.compile(pattern, re.A | re.S | (re.I if nocase else 0))


# white space, for inside a character class
WS = r" \t\n\v\f\r   -     　"
EDGES = rx(rf"^[{WS}]+|[{WS}]+\Z")
SPACES = rx(rf"[{WS}]+")
ARXIV_ID = r"(?:[0-9]{4}\.[0-9]{4,5}|[a-z-]+(?:\.[A-Z]{2})?/[0-9]{7})"
ARXIV_URL = rx(rf"^https?://(?:www\.|export\.)?arxiv\.org/(?:abs|pdf|html)/({ARXIV_ID})(?:v[0-9]+)?(?:\.pdf)?/?(?:[?#].*)?\Z", True)
ARXIV_BARE = rx(rf"^(?:arxiv:[{WS}]*)?({ARXIV_ID})(?:v[0-9]+)?\Z", True)
DOI_ID = rf"10\.[0-9]{{4,9}}/[^{WS}]+"
DOI_URL = rx(rf"^https?://(?:dx\.)?doi\.org/({DOI_ID})\Z", True)
DOI_BARE = rx(rf"^(?:doi:[{WS}]*)?({DOI_ID})\Z", True)
# a web address in its parts: scheme, host, path, query; the fragment is not part of what it is
URL = rx(rf"^(https?)://([^/?#{WS}]+)([^?#]*)(?:\?([^#]*))?(?:#.*)?\Z", True)
# a link at the start of an item: [title](target), <target>, or the target itself
MD_LINK = rx(rf"^\[([^\]]*)\]\([{WS}]*<?([^){WS}>]+)>?[{WS}]*\)")
ANGLE = rx(rf"^<([^>{WS}]+)>")
BARE = rx(rf"^(?:https?://[^{WS}]+|arxiv:[{WS}]*{ARXIV_ID}(?:v[0-9]+)?|{ARXIV_ID}(?:v[0-9]+)?|doi:[{WS}]*{DOI_ID}|{DOI_ID})", True)
WEB = rx(r"^https?://", True)
# the links anywhere in a text (a reference's Source): a URL, an arXiv id said to be one, a DOI
LINKS = rx(rf"(https?://[^{WS})>\]\"']+)|\barxiv(?:\.org/(?:abs|pdf|html)/|:?[{WS}]*)({ARXIV_ID})(?:v[0-9]+)?(?![0-9])"
           rf"|\b(10\.[0-9]{{4,9}}/[^{WS})>\]\"']+)", True)
ITEM = rx(r"^[-*+][ \t]+(.*)\Z")
SUB = rx(r"^[ \t]+[-*+][ \t]+(.*)\Z")
PROCESSED = rx(r"^##[ \t]+processed[ \t]*\Z", True)
HEADING = rx(r"^#{1,2}[ \t]")
SOURCE = rx(r"^##[ \t]+Source[ \t]*\Z")
BRIEFED = rx(r"^briefed[ \t]+([0-9]{4}-[0-9]{2}-[0-9]{2})[ \t]*:?[ \t]*(.*)\Z", True)
ADDED = rx(r"^added[ \t]+([0-9]{4}-[0-9]{2}-[0-9]{2})\Z", True)
# the user's mark that they have read the item, and the day they set it (docs/adr/0004)
READ = rx(r"^read[ \t]+([0-9]{4}-[0-9]{2}-[0-9]{2})\Z", True)
DATED = rx(r"^([0-9]{4}-[0-9]{2}-[0-9]{2})[ \t]+(.*)\Z")
DASH = rx(r"^(?:—|–|->|-{1,2}|→)[ \t]*")  # `->` before `-`, or its `>` is left behind
ENDS = rx(r"[.,;]+\Z")  # what ends a sentence, not an address


def strip(text: str) -> str:
    return EDGES.sub("", text)


def one_line(text: str) -> str:
    return strip(SPACES.sub(" ", text or ""))


def target_of(target: str) -> tuple[str, str] | None:
    """A link's identity and the address that opens it: `arxiv:<id>` whatever the form the paper
    was given in (abs, pdf, html, a version), `doi:<doi>`, or the URL without its fragment and
    trailing slash. None when it is none of these."""
    t = strip(target)
    m = ARXIV_URL.match(t) or ARXIV_BARE.match(t)
    if m:
        return f"arxiv:{m.group(1)}", f"https://arxiv.org/abs/{m.group(1)}"
    m = DOI_URL.match(t) or DOI_BARE.match(t)
    if m:
        return f"doi:{m.group(1).lower()}", f"https://doi.org/{m.group(1)}"
    m = URL.match(t)
    if not m:
        return None
    scheme, host, path, query = m.groups()
    return f"{scheme.lower()}://{host.lower()}{path.rstrip('/')}" + (f"?{query}" if query else ""), t


def link_at(text: str) -> tuple[str, str, str, str] | None:
    """The link a line's text starts with: its key, its address, its title and the text after it."""
    m = MD_LINK.match(text)
    if m:
        got = target_of(m.group(2))
        return (*got, strip(m.group(1)), text[m.end():]) if got else None
    m = ANGLE.match(text)
    if m:
        got = target_of(m.group(1))
        return (*got, "", text[m.end():]) if got else None
    m = BARE.match(text)
    if not m or (m.end() < len(text) and not SPACES.match(text[m.end()])):
        return None
    raw = m.group(0)
    if WEB.match(raw):
        raw = ENDS.sub("", raw)
    got = target_of(raw)
    return (*got, "", text[m.end():]) if got else None


def tail_of(tail: str) -> tuple[str, str, str, str]:
    """What follows an item's link: why it was saved, its reading priority, the day it was added,
    the day the user marked it as read. A priority word counts only as a part of its own (or as all
    there is): inside a why it is the why's."""
    why, priority, added, read = [], "", "", ""
    for part in (strip(p) for p in DASH.sub("", strip(tail), count=1).split("·")):
        a, r = ADDED.match(part), READ.match(part)
        if a and not added:
            added = a.group(1)
        elif r and not read:
            read = r.group(1)
        elif part.lower() in PRIORITIES and not priority:
            priority = part.lower()
        elif part:
            why.append(part)
    return " · ".join(why), priority, added, read


def links_in(text: str) -> list[str]:
    """The identities of the links a text names, each once, in its order."""
    out: list[str] = []
    for m in LINKS.finditer(text):
        url, arxiv, doi = m.groups()
        got = target_of(ENDS.sub("", url)) if url else None
        key = got[0] if got else f"arxiv:{arxiv}" if arxiv else f"doi:{ENDS.sub('', doi).lower()}" if doi else ""
        if key and key not in out:
            out.append(key)
    return out


def source_of(note: str) -> str:
    """A note's `## Source` section (a reference says there what it is a note of), else nothing."""
    out, inside = [], False
    for line in note.replace("\r\n", "\n").split("\n"):
        if HEADING.match(line):
            inside = bool(SOURCE.match(line))
        elif inside:
            out.append(line)
    return "\n".join(out)


def tail_text(why: str = "", priority: str = "", added: str = "", read: str = "") -> str:
    """What follows an item's link, as the plugin writes it."""
    parts = (priority, f"added {added}" if added else "", f"read {read}" if read else "")
    return (f" \u2014 {why}" if why else "") + "".join(f" \u00b7 {p}" for p in parts if p)


def item_line(url: str, title: str = "", why: str = "", priority: str = "", added: str = "") -> str:
    """An item's line as the plugin writes it."""
    return f"- {f'[{title}]({url})' if title else url}{tail_text(why, priority, added)}"


class Inbox:
    """The file as read: its lines, as they are, and what they hold. `items` and `processed` are
    in the file's order; each item knows its lines (`at`: the first, and one past its last)."""

    def __init__(self, text: str):
        raw = text.split("\n")
        # each line apart from how it ended (`cr`: with a carriage return before its newline), so
        # that a file goes back with the endings it had, mixed or not
        self.cr = [n < len(raw) - 1 and line.endswith("\r") for n, line in enumerate(raw)]
        self.lines = [line[:-1] if cr else line for line, cr in zip(raw, self.cr)]
        self.crlf = any(self.cr)
        self._read()

    def _read(self) -> None:
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
            rest = strip(m.group(1))
            if done:
                d = DATED.match(rest)
                got = link_at(d.group(2) if d else rest)
                if got:
                    key, _, title, tail = got
                    self.processed.append({"date": d.group(1) if d else "", "key": key, "title": title,
                                           "outcome": strip(DASH.sub("", strip(tail), count=1))})
                continue
            got = link_at(rest)
            if not got:
                continue
            key, url, title, tail = got
            why, priority, added, read = tail_of(tail)
            subs = []
            while i < len(self.lines) and SUB.match(self.lines[i]):
                subs.append(strip(SUB.match(self.lines[i]).group(1)))
                i += 1
            b = BRIEFED.match(subs[0]) if subs else None
            brief = {"date": b.group(1), "lines": [s for s in [strip(b.group(2)), *subs[1:]] if s]} if b else None
            self.items.append({"key": key, "url": url, "title": title, "why": why, "priority": priority, "added": added, "read": read,
                               "duplicate": key in seen, "brief": brief, "at": (i - len(subs) - 1, i)})
            seen.add(key)

    def text(self) -> str:
        """The file again: as it was read, when nothing changed."""
        return "\n".join(line + ("\r" if cr else "") for line, cr in zip(self.lines, self.cr))

    def shown(self) -> list[dict]:
        """The items as the page and the tool show them (without their place in the file)."""
        return [{k: v for k, v in item.items() if k != "at"} for item in self.items]

    def find(self, key: str) -> tuple[str, dict] | None:
        """What already holds this link: ("item", the first item with it), else ("processed", the
        latest processed item with it), else None."""
        for item in self.items:
            if item["key"] == key:
                return "item", item
        for done in reversed(self.processed):
            if done["key"] == key:
                return "processed", done
        return None

    def add(self, link: str, why: str = "", priority: str = "", title: str = "", today: str = "") -> dict:
        """Adds an item at the end of the open list (before the processed ones), as one new line,
        and answers it. The caller looks for a duplicate first (`find`). InboxError when the link
        is none, the reading priority is not one, or the line would not read back as meant."""
        got = link_at(one_line(link))
        if not got or strip(got[3]):
            raise InboxError("not a link: give a URL, an arXiv id or a DOI")
        key, url, own, _ = got
        why, priority = one_line(why), one_line(priority).lower()
        title = one_line(title or own).replace("[", "(").replace("]", ")")
        if priority and priority not in PRIORITIES:
            raise InboxError(f"a reading priority is {', '.join(PRIORITIES[:-1])} or {PRIORITIES[-1]}")
        want = {"key": key, "why": why, "priority": priority, "added": today, "read": ""}
        line = None
        for t in ([title, ""] if title else [""]):  # a title the line cannot carry is left out
            back = Inbox(item_line(url, t, why, priority, today)).shown()
            if len(back) == 1 and all(back[0][k] == v for k, v in {**want, "title": t}.items()):
                line = item_line(url, t, why, priority, today)
                break
        if line is None:
            raise InboxError("the why would read as a reading priority or a date: say it in other words")
        if not any(strip(l) for l in self.lines):
            self.lines, self.cr, at = ["# Inbox", "", line, ""], [self.crlf] * 3 + [False], 2
        else:
            # the end of the open list: before the processed heading and the blank lines above it
            stop = next((n for n, l in enumerate(self.lines) if PROCESSED.match(l)), len(self.lines))
            end = stop
            while end > 0 and not strip(self.lines[end - 1]):
                end -= 1
            # after free text or a heading, a blank line first; one after it when nothing follows
            # or the processed heading is right there
            before = [""] if end > 0 and not (ITEM.match(self.lines[end - 1]) or SUB.match(self.lines[end - 1])) else []
            after = [""] if end == stop else []
            self._put(end, before + [line] + after)
            at = end + len(before)
        self._read()
        return next({k: v for k, v in i.items() if k != "at"} for i in self.items if i["at"][0] == at)

    def _put(self, end: int, put: list[str]) -> None:
        """New lines before line `end` (after the last one, when there is none), with the file's endings."""
        if end == len(self.lines) and end > 0:
            self.cr[end - 1] = self.crlf  # the last line had no ending: it has the file's now
        self.lines[end:end] = put
        self.cr[end:end] = [self.crlf] * len(put)
        self.cr[-1] = False  # nothing ends the last line

    def nth(self, key: str, nth: int = 0) -> dict | None:
        """The item with this link: the first, or the `nth` after it when the link was typed more than once."""
        same = [i for i in self.items if i["key"] == key]
        return same[nth] if 0 <= nth < len(same) else None

    def _link(self, n: int) -> tuple[int, int]:
        """Where the link of the item on line `n` starts and ends in its line."""
        m = ITEM.match(self.lines[n])
        rest = strip(m.group(1))
        start = m.start(1) + m.group(1).index(rest)
        return start, start + len(rest) - len(link_at(rest)[3])

    def change(self, key: str, nth: int = 0, why: str | None = None, priority: str | None = None, read: str | None = None) -> dict | None:
        """Sets why an item was saved, its reading priority, or the user's mark that they have read
        it (`read`: the day it is set) (None leaves one as it is, "" takes it away): what follows
        the link on its line is written again, the link and what is before it stay as typed, and so
        does the whole line when nothing changes. None when the inbox has no such item. InboxError
        when the reading priority is not one, the day is not a day, or the why would not read back
        as a why."""
        item = self.nth(key, nth)
        if not item:
            return None
        why = item["why"] if why is None else one_line(why)
        priority = item["priority"] if priority is None else one_line(priority).lower()
        read = item["read"] if read is None else one_line(read)
        if priority and priority not in PRIORITIES:
            raise InboxError(f"a reading priority is {', '.join(PRIORITIES[:-1])} or {PRIORITIES[-1]}")
        if read and not READ.match(f"read {read}"):
            raise InboxError("the read mark carries the day it was set, as 2026-11-24")
        n = item["at"][0]
        if (why, priority, read) != (item["why"], item["priority"], item["read"]):
            new = self.lines[n][:self._link(n)[1]] + tail_text(why, priority, item["added"], read)
            back = Inbox(new).shown()
            want = {**{k: item[k] for k in ("key", "title", "added")}, "why": why, "priority": priority, "read": read}
            if len(back) != 1 or any(back[0][k] != v for k, v in want.items()):
                raise InboxError("the why would read as a reading priority or a date: say it in other words")
            self.lines[n] = new
            self._read()
        return next({k: v for k, v in i.items() if k != "at"} for i in self.items if i["at"][0] == n)

    def close(self, key: str, nth: int = 0, outcome: str = "discarded", today: str = "") -> dict | None:
        """Takes an item out of the inbox with what was decided for it: its line and its brief go
        (and a blank line with them, where that would leave two or one at the file's top), and one line with the day, the link and the outcome is added at the end of the processed
        ones (under a `## Processed` heading, made when there is none). An outcome that starts with
        an arrow is the note the item became (`→ R15`) and is written as it is; any other follows a
        dash (`— discarded: why`). Answers the processed item, or None when the inbox has no such item."""
        item = self.nth(key, nth)
        if not item:
            return None
        outcome = one_line(outcome)
        arrow = outcome.startswith("\u2192")
        line = want = None
        for t in ([item["title"], ""] if item["title"] else [""]):  # a title the line cannot carry is left out
            link = f"[{t}]({item['url']})" if t else item["url"]
            new = "- " + (f"{today} " if today else "") + link + (f" {outcome}" if arrow else f" \u2014 {outcome}" if outcome else "")
            want = {"date": today, "key": key, "title": t, "outcome": strip(outcome[1:]) if arrow else outcome}
            if Inbox(f"## Processed\n{new}").processed == [want]:
                line = new
                break
        if line is None:
            raise InboxError("the outcome would not read back as it is: say it in other words")
        a, b = item["at"]
        del self.lines[a:b]
        del self.cr[a:b]
        if not self.lines:
            self.lines, self.cr = [""], [False]
        # where the item was: a blank line that is now the file's first, or the second of two, goes
        if len(self.lines) > 1 and a < len(self.lines) and not strip(self.lines[a]) and (a == 0 or not strip(self.lines[a - 1])):
            del self.lines[a]
            del self.cr[a]
        self.cr[-1] = False
        head = next((n for n, l in enumerate(self.lines) if PROCESSED.match(l)), None)
        if head is None:
            # at the file's end, a blank line before the heading unless one is there
            stop = len(self.lines)
            end = stop - 1 if self.lines[-1] == "" else stop
            put = ([""] if end > 0 and strip(self.lines[end - 1]) else []) + ["## Processed", "", line]
        else:
            # the end of the processed ones: before the next heading and the blank lines above it
            stop = next((n for n in range(head + 1, len(self.lines)) if HEADING.match(self.lines[n])), len(self.lines))
            end = stop
            while end > head + 1 and not strip(self.lines[end - 1]):
                end -= 1
            put = ([] if ITEM.match(self.lines[end - 1]) or SUB.match(self.lines[end - 1]) else [""]) + [line]
        self._put(end, put + ([""] if end == stop else []))
        self._read()
        return want

    def set_title(self, key: str, title: str) -> dict | None:
        """Gives the first untitled item with this link its title: the link on its line becomes
        `[title](address)` and the rest of the line stays as typed. None, and nothing changed, when
        no untitled item has the link, or the line would not read back as the same item."""
        title = one_line(title).replace("[", "(").replace("]", ")")
        item = next((i for i in self.items if i["key"] == key and not i["title"]), None)
        if not item or not title:
            return None
        n = item["at"][0]
        line = self.lines[n]
        start, end = self._link(n)
        new = f"{line[:start]}[{title}]({item['url']}){line[end:]}"
        back = Inbox(new).shown()
        want = {**{k: item[k] for k in ("key", "why", "priority", "added", "read")}, "title": title}
        if len(back) != 1 or any(back[0][k] != v for k, v in want.items()):
            return None
        self.lines[n] = new
        self._read()
        return next({k: v for k, v in i.items() if k != "at"} for i in self.items if i["at"][0] == n)
