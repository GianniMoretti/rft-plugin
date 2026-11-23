"""The scan for traces (docs/adr/0003-a-document-holds-no-trace.md), as hooks/lib/scan.ts has it.
A document's files are shared with co-authors as they are, so they hold no trace of the tree. A
trace is:

- **plugin**: a name or a macro of the plugin (\\rftnum, \\usepackage{rft}, rft.sty);
- **marker**: a marker of the first design (% rft-begin S04 3f2a1c9d, % rft-end S04);
- **id**: the id of a note or a snippet that exists in this vault, in a text or a file's name;
- **reference**: an entry of a .bib that a reference note holds and the document does not cite.

An id that is no note's and no snippet's is not flagged ("Table S1"), and an entry the tree does
not know is the user's own. An occurrence the user allowed is remembered in the document's tracking
file (documents/.rft/<name>/tracking.json) and not flagged again. Both sides are held to
tests/fixtures/local-overleaf/traces.json. Standard library only.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

DOCUMENTS = "documents"
TRACKING = ".rft"
# `rft` where a word starts, in lower case as the plugin writes it (an acronym RFT is the user's own)
PLUGIN_RE = re.compile(r"(?<![A-Za-z])\\?rft[\w@-]*", re.A)
OLD_MARKER_RE = re.compile(r"^\s*%\s*rft-(?:begin|end)\b.*$")
ID_RE = re.compile(r"(?<![A-Za-z0-9])[A-Z]\d+(?![A-Za-z0-9])", re.A)
CITES_RE = re.compile(r"\\[A-Za-z]*cite[A-Za-z]*\*?(?:\[[^\]]*\]){0,2}\{([^}]*)\}")
BIB_ENTRY_RE = re.compile(r"^\s*@(\w+)\s*\{\s*([^,\s]+)\s*,")
# files read as bytes only: their names are scanned, their content is not
BINARY_RE = re.compile(r"\.(pdf|png|jpe?g|gif|eps|ps|tiff?|bmp|ico|zip|gz|tgz|otf|ttf|woff2?|pfb|xlsx?|docx?)$", re.I)
MAX_TEXT = 2_000_000


def uncommented(text: str) -> str:
    return "\n".join(re.sub(r"(^|[^\\])%.*$", r"\1", line) for line in text.split("\n"))


def traces_in_text(text: str, ids: set[str]) -> list[dict]:
    """The traces in a text, line by line: the plugin's names, the first design's markers, and the ids of `ids`."""
    out = []
    for i, raw in enumerate(text.replace("\r\n", "\n").split("\n"), 1):
        shown = raw.strip()
        if OLD_MARKER_RE.match(raw):
            out.append({"line": i, "kind": "marker", "match": re.sub(r"^%\s*", "", shown).split()[0], "text": shown})
        else:
            out.extend({"line": i, "kind": "plugin", "match": m.group(0), "text": shown} for m in PLUGIN_RE.finditer(raw))
        out.extend({"line": i, "kind": "id", "match": m.group(0), "text": shown} for m in ID_RE.finditer(raw) if m.group(0) in ids)
    return out


def traces_in_name(rel: str, ids: set[str]) -> list[dict]:
    """The traces in a file's path inside the document."""
    return [{"line": None, "kind": "plugin", "match": m.group(0), "text": ""} for m in PLUGIN_RE.finditer(rel)] + \
           [{"line": None, "kind": "id", "match": m.group(0), "text": ""} for m in ID_RE.finditer(rel) if m.group(0) in ids]


def cited_keys(text: str) -> set[str]:
    """The keys a text cites, comments left out; `*` among them when it cites everything (\\nocite{*})."""
    return {k.strip() for m in CITES_RE.findall(uncommented(text)) for k in m.split(",") if k.strip()}


def uncited_entries(bib: str, cited: set[str], tree_keys: set[str]) -> list[dict]:
    """The entries of a .bib that the tree holds (`tree_keys`) and the document does not cite."""
    if "*" in cited:
        return []
    out = []
    for i, raw in enumerate(bib.replace("\r\n", "\n").split("\n"), 1):
        m = BIB_ENTRY_RE.match(raw)
        if m and m.group(2) in tree_keys and m.group(2) not in cited:
            out.append({"line": i, "kind": "reference", "match": m.group(2), "text": raw.strip()})
    return out


def scan_files(files: list[tuple[str, str | None]], ids: set[str], tree_keys: set[str], allowed: list[dict] | None = None) -> dict:
    """The traces of a document given as its files (path inside it, text or None for one not read):
    those still flagged, and how many the user allowed."""
    found: list[dict] = []
    cited: set[str] = set()
    for rel, text in files:
        if text is not None and re.search(r"\.(tex|ltx)$", rel, re.I):
            cited |= cited_keys(text)
    for rel, text in files:
        found.extend({"file": rel, **t} for t in traces_in_name(rel, ids))
        if text is None:
            continue
        found.extend({"file": rel, **t} for t in traces_in_text(text, ids))
        if rel.lower().endswith(".bib"):
            found.extend({"file": rel, **t} for t in uncited_entries(text, cited, tree_keys))
    ok = {(a.get("file"), a.get("match"), a.get("text", "")) for a in allowed or [] if isinstance(a, dict)}
    traces = [t for t in found if (t["file"], t["match"], t["text"]) not in ok]
    return {"traces": traces, "allowed": len(found) - len(traces)}


def document_files(folder: Path) -> list[Path]:
    """Every file of a document's folder, in the order of their paths; links are not followed."""
    out = []

    def visit(d: Path) -> None:
        for p in sorted(d.iterdir(), key=lambda x: x.name):
            if p.is_symlink():
                out.append(p)
            elif p.is_dir():
                visit(p)
            else:
                out.append(p)

    if folder.is_dir():
        visit(folder)
    return out


def allowed_of(vault: Path, name: str) -> list[dict]:
    """The occurrences the user allowed in a document, from its tracking file."""
    try:
        d = json.loads((Path(vault) / DOCUMENTS / TRACKING / name / "tracking.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return [a for a in d.get("allowed") or [] if isinstance(a, dict)] if isinstance(d, dict) else []


def scan_document(vault: Path, name: str, ids: set[str], tree_keys: set[str]) -> dict:
    """The scan of a document's folder (documents/<name>/), with what its tracking file allows."""
    folder = Path(vault) / DOCUMENTS / name
    files: list[tuple[str, str | None]] = []
    for p in document_files(folder):
        rel, text = p.relative_to(folder).as_posix(), None
        if not p.is_symlink() and not BINARY_RE.search(rel) and p.stat().st_size <= MAX_TEXT:
            try:
                text = p.read_bytes().decode("utf-8")
            except (OSError, UnicodeDecodeError):
                text = None
            if text is not None and "\x00" in text:
                text = None
        files.append((rel, text))
    return scan_files(files, ids, tree_keys, allowed_of(vault, name))
