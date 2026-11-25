"""The reading note of an inbox item: what was written on reading it, in two parts, the user's
(quotes from the item and lines of their own) and Claude's impression. One markdown file per item
in a folder at the vault's top (Reading notes/, beside Inbox.md), outside the tree, made on the
first write and tied to the item by its link.

    # Mixup at scale
    <https://arxiv.org/abs/2406.01234>

    ## My reading

    > The gain vanishes below 1k images (Sec. 4.2)

    Same subset sizes as E05?

    ## Claude's impression (2026-11-24)

    ### Claims
    ...

The user's part is what stands between the first `## My reading` heading and the last `## Claude's
impression` heading (the file's end, when there is none); the impression is what follows that
heading. Two writers, each of its own part: the page's server writes the user's part (here), the
plugin the impression (hooks/lib/reading.ts), and each leaves every other line as it was, in the
endings the file has. The plugin gives Claude the user's part only once the user marked the item as
read (docs/adr/0004).

hooks/lib/reading.ts reads the same file the same way, pattern for pattern, and
tests/fixtures/reading-note holds both to one list of cases. As in rft_inbox.py, nothing is left to
what Python and JavaScript each take a word to mean. Standard library only.
"""
from __future__ import annotations

import rft_inbox
from rft_inbox import rx

DIR = "Reading notes"
MINE_HEAD = "## My reading"
IMPRESSION_HEAD = "## Claude's impression"
MINE = rx(r"^##[ \t]+my[ \t]+reading[ \t]*\Z", True)
# the heading of the impression: Claude's, or that of another agent the user set up, by its name
AGENT = r"[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}"
IMPRESSION = rx(rf"^##[ \t]+({AGENT})['’]s[ \t]+impression(?:[ \t]+\(([0-9]{{4}}-[0-9]{{2}}-[0-9]{{2}})\))?[ \t]*\Z", True)
PARTS = ("Claims", "How", "Key results", "Bearing on", "Left open")  # every impression has each, once, in this order
IMPRESSION_CHARS = 3000  # about one screen
PART = rx(r"^#{1,6}[ \t]+(.*?)[ \t]*:?[ \t]*#*[ \t]*\Z")
TRAIL = rx(r"[ \t]+\Z")
SAYS = ("An impression has five parts, each under its heading and in this order: " + ", ".join(f"### {p}" for p in PARTS)
        + " (what the item claims; how it gets there; its key results, with their numbers and where they are in the item; "
        "its bearing on notes of the tree, named by id; what it leaves open)")
BLANK = rx(r"^[ \t]*\Z")
SCHEME = rx(r"^https?://", True)
UNSAFE = rx(r"[^A-Za-z0-9._-]+")
EDGE = rx(r"^[-.]+|[-.]+\Z")
NAME_CHARS = 100
TRIES = 50  # how many files of one name's family are looked at for an item's own


class ReadingError(ValueError):
    """What cannot be written in a reading note, in words for the user."""


def file_name(key: str, n: int = 0) -> str:
    """The file of the item with this key: its key in the characters a file name may have. `n`:
    the next name of the family, for a second item whose key gives the same name."""
    stem = EDGE.sub("", EDGE.sub("", UNSAFE.sub("-", SCHEME.sub("", key, count=1)))[:NAME_CHARS]) or "item"
    return f"{stem}.md" if n == 0 else f"{stem}-{n + 1}.md"


def name_of(key: str, title: str = "") -> str:
    """What a reading note is headed: the item's title, else what the inbox's list calls it."""
    title = rft_inbox.one_line(title)
    if title:
        return title
    if key.startswith("arxiv:"):
        return f"arXiv {key[6:]}"
    if key.startswith("doi:"):
        return f"doi {key[4:]}"
    return SCHEME.sub("", key, count=1)


def lines_of(text: str) -> list[str]:
    """A text as lines, without the blank ones at its two ends."""
    lines = text.replace("\r\n", "\n").split("\n")
    while lines and BLANK.match(lines[0]):
        lines.pop(0)
    while lines and BLANK.match(lines[-1]):
        lines.pop()
    return lines


class Note:
    """The file as read: its lines, as they are, and what they hold. `key`: the item it is of, by
    the first link of its head; `mine`: the user's part; `impression`: Claude's ({"date", "text"}),
    or None when it has none."""

    def __init__(self, text: str):
        raw = text.split("\n")
        self.cr = [n < len(raw) - 1 and line.endswith("\r") for n, line in enumerate(raw)]
        self.lines = [line[:-1] if cr else line for line, cr in zip(raw, self.cr)]
        self.crlf = any(self.cr)
        self._read()

    @classmethod
    def new(cls, key: str, url: str, title: str = "") -> "Note":
        """The note of an item that has none yet: its head alone. Not a file until a part is written."""
        for link in (f"<{url}>", url):
            note = cls(f"# {name_of(key, title)}\n{link}\n")
            if note.key == key:
                return note
        raise ReadingError("the item's link would not read back from its reading note")

    def _read(self) -> None:
        imp = next((n for n in range(len(self.lines) - 1, -1, -1) if IMPRESSION.match(self.lines[n])), None)
        stop = len(self.lines) if imp is None else imp
        mine = next((n for n in range(stop) if MINE.match(self.lines[n])), None)
        self.key = None
        for line in self.lines[:stop if mine is None else mine]:
            got = rft_inbox.link_at(rft_inbox.strip(line))
            if got:
                self.key = got[0]
                break
        self.mine = "" if mine is None else "\n".join(lines_of("\n".join(self.lines[mine + 1:stop])))
        self.impression = None
        if imp is not None:
            head = IMPRESSION.match(self.lines[imp])
            self.impression = {"date": head.group(2) or "", "text": "\n".join(lines_of("\n".join(self.lines[imp + 1:])))}
            if head.group(1).lower() != "claude":
                self.impression["by"] = head.group(1)  # another agent's, by its name
        self._at = (mine, imp)

    def text(self) -> str:
        """The file again: as it was read, when nothing changed."""
        return "\n".join(line + ("\r" if cr else "") for line, cr in zip(self.lines, self.cr))

    def _splice(self, a: int, b: int, new: list[str]) -> None:
        """Lines a to b replaced by new ones, with the file's endings."""
        if a == len(self.lines) and a > 0:
            self.cr[a - 1] = self.crlf  # the last line had no ending: it has the file's now
        self.lines[a:b] = new
        self.cr[a:b] = [self.crlf] * len(new)
        self.cr[-1] = False  # nothing ends the last line
        self._read()

    def set_impression(self, impression: list[str], today: str, by: str = "Claude") -> None:
        """Writes the impression of the day: its heading, which names who wrote it, and its lines
        in place of the impression the file had (everything from that heading on), or at the
        file's end. The user's part and every line before it stay as they were. As withImpression
        in hooks/lib/reading.ts."""
        block = [f"## {by}'s impression ({today})", "", *impression, ""]
        mine, imp = self._at
        if imp is not None:
            self._splice(imp, len(self.lines), block)
            return
        at = len(self.lines)
        while at > 0 and BLANK.match(self.lines[at - 1]):
            at -= 1
        # a note with no part yet gets the user's, empty, before the impression: the file always shows the two
        head = [MINE_HEAD, ""] if mine is None else []
        self._splice(at, len(self.lines), ([""] if at > 0 else []) + head + block)

    def set_mine(self, text: str) -> bool:
        """Writes the user's part: its heading and its lines, in place of what the part held, or
        before the impression (at the file's end, when there is none) when the file had no such
        part. Every other line stays as it was. False, and nothing changed, when the part already
        says this. ReadingError when a line of it would read as the heading of the impression."""
        new = lines_of(text)
        if any(IMPRESSION.match(line) for line in new):
            raise ReadingError(f'a line of your part reads as the heading of Claude\'s part, or of another agent\'s (as "{IMPRESSION_HEAD}"): write it another way')
        mine, imp = self._at
        if "\n".join(new) == self.mine and (mine is not None or not new):
            return False
        stop = len(self.lines) if imp is None else imp
        block = [MINE_HEAD, "", *new, ""] if new else [MINE_HEAD, ""]
        if mine is not None:
            self._splice(mine, stop, block)
            return True
        at = stop
        while at > 0 and BLANK.match(self.lines[at - 1]):
            at -= 1
        self._splice(at, stop, ([""] if at > 0 else []) + block)
        return True


def impression_lines(text: str) -> list[str]:
    """An impression as it is written in the file: its five parts under their headings, a blank
    line between two. ReadingError when a part is missing, empty, twice or out of its place, when
    there is a heading that is none of the five or text before the first, or when it is longer
    than a screen. As impressionLines in hooks/lib/reading.ts."""
    out: list[str] = []
    part = -1
    body: list[str] = []

    def close():
        nonlocal body
        kept = lines_of("\n".join(body))
        if part >= 0 and not kept:
            raise ReadingError(f'the part "{PARTS[part]}" of the impression is empty. {SAYS}')
        if part < 0 and kept:
            raise ReadingError(f"the impression starts with text under no heading. {SAYS}")
        if part >= 0:
            out.extend(([""] if out else []) + [f"### {PARTS[part]}", "", *kept])
        body = []

    for line in (TRAIL.sub("", l) for l in lines_of(text)):
        h = PART.match(line)
        if not h:
            body.append(line)
            continue
        name = rft_inbox.one_line(h.group(1))
        at = next((n for n, p in enumerate(PARTS) if p.lower() == name.lower()), -1)
        if at < 0:
            raise ReadingError(f'"{name}" is not a part of an impression. {SAYS}')
        if at != part + 1:
            where = "there twice or out of its place" if at <= part else f'before "{PARTS[part + 1]}"'
            raise ReadingError(f'the part "{PARTS[at]}" is {where}. {SAYS}')
        close()
        part = at
    close()
    if part != len(PARTS) - 1:
        raise ReadingError(f'the impression has no part "{PARTS[part + 1]}". {SAYS}')
    chars = len("\n".join(out))
    if chars > IMPRESSION_CHARS:
        raise ReadingError(f"an impression is about one screen, at most {IMPRESSION_CHARS} characters, and this has {chars}: keep what the user needs to compare it with their own reading")
    return out


def find(read, key: str) -> tuple[str, Note | None]:
    """The file of the item with this key, by name, and the note in it: the first of its name's
    family that is of this item (or names no item at all), else the first name that is free, with
    no note. `read(name)`: the file's text, or None when there is no such file."""
    for n in range(TRIES):
        name = file_name(key, n)
        text = read(name)
        if text is None:
            return name, None
        note = Note(text)
        if note.key in (key, None):
            return name, note
    raise ReadingError("too many reading notes share this item's file name")
