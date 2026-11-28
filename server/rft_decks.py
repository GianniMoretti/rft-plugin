"""Slide decks as the tree view's server reads and writes them (docs/design/presentations.md), as
web/slides.js and hooks/lib/decks.ts have them: one Markdown file each in vault/decks/, `P03
Weekly wrap-up.md`, its frontmatter saying what it is for (`for:`, meetings' occurrences and
deadlines, as written) and whether it is locked (unless `locked: false`, it is the user's to
write: Claude's writes of it are refused by the session). The server lists the decks, gives one's
text with its version, writes the user's edits, a new deck and the lock. What a `for:` item
resolves to (an occurrence moved or skipped) is the page's to work out, with web/schedule.js.
Standard library only.
"""
from __future__ import annotations

import re
from pathlib import Path

DECKS = "decks"
DECK_ID = re.compile(r"^P(\d+)$")
SEP = re.compile(r"^---\s*$")
FENCE = re.compile(r"^\s*(```|~~~)")


def decks_dir(vault: Path) -> Path:
    return vault / DECKS


def unquote(v: str) -> str:
    v = (v or "").strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1].strip()
    return v


def front_lines(text: str) -> tuple[list[str], int] | None:
    """The frontmatter's lines and the line the body starts at (0-based), or None when there is none."""
    lines = text.replace("\r\n", "\n").split("\n")
    if not lines or not SEP.match(lines[0]):
        return None
    end = next((i for i in range(1, len(lines)) if SEP.match(lines[i])), None)
    return None if end is None else (lines[1:end], end + 1)


def fields_of(text: str) -> dict[str, str | list[str]]:
    """The frontmatter's fields as written: a value on the key's line, or a block list of `- item`
    lines under it (as frontOf in web/slides.js)."""
    got = front_lines(text)
    out: dict[str, str | list[str]] = {}
    key = None
    for line in got[0] if got else []:
        m = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", line)
        if m:
            key = m.group(1)
            out[key] = m.group(2).strip() or []
            continue
        item = re.match(r"^\s*-\s+(.*)$", line)
        if item and key and isinstance(out.get(key), list):
            out[key].append(unquote(item.group(1)))
    return {k: (v if v != [] else "") for k, v in out.items()}


def list_items(value: str | list[str]) -> list[str]:
    """The items of a list as written: `[G01 2026-11-24, M04]`, a block list, or one item alone."""
    if isinstance(value, list):
        return [x for x in (unquote(str(v)) for v in value) if x]
    v = (value or "").strip()
    if v.startswith("[") and v.endswith("]"):
        v = v[1:-1]
    return [x for x in (unquote(p) for p in v.split(",")) if x]


def is_locked(fields: dict) -> bool:
    """A deck is locked unless its frontmatter says `locked: false`."""
    v = fields.get("locked", "")
    return not (isinstance(v, str) and unquote(v).lower() == "false")


def slide_count(text: str) -> int:
    """How many slides the deck has: its body split at a line `---` outside code."""
    got = front_lines(text)
    lines = text.replace("\r\n", "\n").split("\n")
    n, fenced = 1, False
    for line in lines[got[1] if got else 0:]:
        if FENCE.match(line):
            fenced = not fenced
        elif not fenced and SEP.match(line):
            n += 1
    return n


def id_of(name: str) -> str:
    return name.split(" ", 1)[0]


def deck_files(vault: Path) -> list[Path]:
    """The decks in vault/decks/, by id (a file whose name starts with no P id left out)."""
    d = decks_dir(vault)
    if not d.is_dir():
        return []
    files = [p for p in d.glob("*.md") if p.is_file() and DECK_ID.match(id_of(p.stem))]
    return sorted(files, key=lambda p: int(DECK_ID.match(id_of(p.stem)).group(1)))


def entry(path: Path, data: bytes, version: str) -> dict:
    """A deck as api/decks lists it: its id, name and title, what it is for, its lock and slides."""
    text = data.decode("utf-8", errors="replace")
    fields = fields_of(text)
    name = path.stem
    did = unquote(fields.get("id", "")) if isinstance(fields.get("id"), str) else ""
    did = did if DECK_ID.match(did) else id_of(name)
    return {"id": did, "name": name, "title": name[len(id_of(name)):].strip(), "path": f"{DECKS}/{path.name}",
            "for": list_items(fields.get("for", "")), "locked": is_locked(fields), "slides": slide_count(text), "version": version}


def with_lock(text: str, locked: bool) -> str:
    """The deck's text with `locked:` set in its frontmatter (added after the last field when it has
    none, and a frontmatter made when there is none)."""
    nl = "\r\n" if "\r\n" in text else "\n"
    t = text.replace("\r\n", "\n")
    line = f"locked: {'true' if locked else 'false'}"
    got = front_lines(t)
    if got is None:
        out = f"---\n{line}\n---\n\n{t}"
    else:
        lines = t.split("\n")
        end = got[1] - 1  # the closing ---
        at = next((i for i in range(1, end) if re.match(r"^locked:", lines[i])), None)
        if at is None:
            lines.insert(end, line)
        else:
            lines[at] = line
        out = "\n".join(lines)
    return out.replace("\n", nl) if nl != "\n" else out


def new_text(did: str, title: str, items: list[str], subtitle: str) -> str:
    """A new deck: its frontmatter (locked, as every new deck is) and a title slide."""
    fields = [f"id: {did}", "type: deck"]
    if items:
        fields.append("for: [" + ", ".join(items) + "]")
    fields.append("locked: true")
    body = f"# {title}\n" + (f"{subtitle}\n" if subtitle else "")
    return "---\n" + "\n".join(fields) + "\n---\n\n" + body
