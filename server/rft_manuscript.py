"""Snippets and documents as the tree view's server reads them (docs/design/manuscript.md,
docs/adr/0003-a-document-holds-no-trace.md), as hooks/lib/manuscript.ts, copies.ts, snippets.ts and
verify.ts have them. Snippets (vault/snippets/): each with its header, what it rests on (its
`% basis:` line and the notes its \\rftnum, \\rftfig, \\rfttable and \\cite name), its state (stub,
written, review: a basis note changed since the stamp, in review, superseded or dropped; the basis
notes not verified), and the documents and files using it. Documents (vault/documents/<name>/, a
folder of plain LaTeX that names nothing of the tree): their copies of snippets, found from their
marker lines (`%%% Definition: CutMix %%%` … `%%% end %%%`) and the document's tracking file
(vault/documents/.rft/<name>/tracking.json), each with its state (placed; adapted; review: its
snippet changed since; gone: no such snippet; lost: not found in the document any more); the
tree's numbers, figures and tables written in them, each held against the tree as it is now; the
traces of the tree in their files (rft_scan). The stamps, the copies and the tracking file are
written by the session (hooks/lib/manuscript.ts), never here; the server writes the locks and the
text the user edits. Both sides are held to tests/fixtures/local-overleaf/expected.json.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rft_scan  # noqa: E402
from rft_results import number_text, tex_text  # noqa: E402

SNIPPETS = "snippets"
DOCUMENTS = "documents"
TRACKING = ".rft"  # documents/.rft/<name>/: the plugin's own files of a document, outside its folder
SNIPPET_ID = re.compile(r"^S\d+$")
DOC_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
HEAD_RE = re.compile(r"^%\s*rft-snippet\s+(S\d+)\s*·\s*([\w-]+)\s*·\s*(.*?)\s*$")
BASIS_RE = re.compile(r"^%\s*basis:\s*(.*?)\s*$")
FENCE_RE = re.compile(r"^\s*(```|~~~)")
BEGIN_RE = re.compile(r"^%\s*rft-begin\s+(S\d+)\s+([0-9a-f]{8})\s*$")
END_RE = re.compile(r"^%\s*rft-end\s+(S\d+)\s*$")
COPY_REF = re.compile(r"^S\d+(?:#\d+)?$")
MARK_END_RE = re.compile(r"^\s*%%%\s*end\s*%%%\s*$", re.I)
MARK_RE = re.compile(r"^\s*%%%\s*(\S.*?)\s*%%%\s*$")
# any command that takes a file in: \input, \include, \subfile, and a template's own (\includepaper); what its argument names must be a file of the document
INCLUDE_RE = re.compile(r"\\(?!include(?:only|graphics|pdf|svg)\b)[A-Za-z]*(?:input|include|subfile)[A-Za-z]*\*?\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}")
BEGIN_DOCUMENT = re.compile(r"\\begin\s*\{document\}")
ENGINES = ("pdflatex", "xelatex", "lualatex")
TEXT_FILE = re.compile(r"\.(tex|ltx|bib)$", re.I)
TEX_FILE = re.compile(r"\.(tex|ltx)$", re.I)
MAX_FILE = 2_000_000

# the sections that hold what a note of each type claims, as SUBSTANCE in hooks/lib/verify.ts
SUBSTANCE = {"experiment": ["Result"], "theory": ["Statement", "Explanation"], "reference": ["Source", "Key results"], "direction": ["Idea"]}


def fnv(text: str) -> str:
    """FNV-1a over the UTF-16 code units of `text`, as fnv1a in hooks/lib/vault.ts."""
    h = 0x811C9DC5
    data = text.encode("utf-16-le", "surrogatepass")
    for i in range(0, len(data), 2):
        h ^= data[i] | (data[i + 1] << 8)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def body_of(text: str) -> str:
    t = text.replace("\r\n", "\n")
    if not t.startswith("---\n"):
        return t
    end = t.find("\n---", 4)
    if end < 0:
        return t
    nl = t.find("\n", end + 4)
    return "" if nl < 0 else t[nl + 1:]


def section_of(text: str, title: str) -> str:
    """A note's `## <title>` section, trimmed, as sectionText in hooks/lib/vault.ts."""
    lines, fenced, heads = body_of(text).split("\n"), False, []
    for i, line in enumerate(lines):
        if FENCE_RE.match(line):
            fenced = not fenced
        if not fenced and line.startswith("## "):
            heads.append(i)
    start = next((i for i in heads if lines[i][3:].strip() == title), None)
    if start is None:
        return ""
    end = next((i for i in heads if i > start), len(lines))
    return "\n".join(lines[start + 1:end]).strip()


def substance_of(kind: str, text: str) -> str:
    """What a note claims, as compared: its sections, comments left out, whitespace collapsed (substanceOf in verify.ts)."""
    out = []
    for s in SUBSTANCE.get(kind, []):
        t = re.sub(r"\s+", " ", re.sub(r"<!--[\s\S]*?-->", " ", section_of(text, s))).strip()
        out.append(f"{s}: {t}")
    return "\n".join(out)


def substance_fingerprint(kind: str, text: str) -> str:
    return fnv(substance_of(kind, text))


# ---------------------------------------------------------------- the files

def snippets_dir(vault: Path) -> Path:
    return Path(vault) / SNIPPETS


def documents_dir(vault: Path) -> Path:
    return Path(vault) / DOCUMENTS


def _json(path: Path) -> dict:
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        d = {}
    return d if isinstance(d, dict) else {}


def read_registry(vault: Path) -> dict:
    """The snippets' registry (snippets/snippets.json): the lock, the next id, each snippet's stamp."""
    d = _json(snippets_dir(vault) / "snippets.json")
    return {"locked": d.get("locked") is not False, "next": d.get("next") if isinstance(d.get("next"), int) and d["next"] > 0 else 1,
            "snippets": d.get("snippets") if isinstance(d.get("snippets"), dict) else {},
            "unlocked": [x for x in d.get("unlocked") or [] if isinstance(x, str)]}


def read_docs_registry(vault: Path) -> dict:
    """The documents' registry (documents/documents.json): the lock."""
    d = _json(documents_dir(vault) / "documents.json")
    return {"locked": d.get("locked") is not False, "unlocked": [x for x in d.get("unlocked") or [] if isinstance(x, str)]}


def snippet_locked(reg: dict, sid: str) -> bool:
    return bool(reg["locked"]) and sid not in reg["unlocked"]


def document_locked(reg: dict, name: str) -> bool:
    return bool(reg["locked"]) and name not in reg["unlocked"]


def header(text: str) -> dict | None:
    lines = text.replace("\r\n", "\n").split("\n")
    m = HEAD_RE.match(lines[0] if lines else "")
    if not m:
        return None
    b = BASIS_RE.match(lines[1]) if len(lines) > 1 else None
    basis = list(dict.fromkeys(x for x in re.split(r"[,\s]+", b.group(1)) if x)) if b else []
    return {"id": m.group(1), "kind": m.group(2), "title": m.group(3), "basis": basis}


def body_after_header(text: str) -> str:
    lines = text.replace("\r\n", "\n").split("\n")
    skip = (2 if len(lines) > 1 and BASIS_RE.match(lines[1]) else 1) if lines and HEAD_RE.match(lines[0]) else 0
    return "\n".join(lines[skip:])


def uncommented(text: str) -> str:
    return "\n".join(re.sub(r"(^|[^\\])%.*$", r"\1", line) for line in text.split("\n"))


CITE_RE = re.compile(r"\\(?:cite|citep|citet|citealp|citeauthor|citeyear|parencite|textcite|autocite)\*?(?:\[[^\]]*\]){0,2}\{([^}]*)\}")


def uses_in(text: str) -> dict:
    """The notes a snippet's macros name and the keys it cites, comments left out (usesIn in manuscript.ts)."""
    t = uncommented(text)
    pairs = lambda rx: [(a.strip(), b.strip()) for a, b in re.findall(rx, t)]  # noqa: E731
    cites = list(dict.fromkeys(k.strip() for m in CITE_RE.findall(t) for k in m.split(",") if k.strip()))
    return {"nums": pairs(r"\\rftnum\{([^}]*)\}\{([^}]*)\}"), "figs": pairs(r"\\rftfig(?:\[[^\]]*\])?\{([^}]*)\}\{([^}]*)\}"),
            "tables": pairs(r"\\rfttable\{([^}]*)\}\{([^}]*)\}"), "cites": cites}


def is_stub(text: str) -> bool:
    rest = uncommented(body_after_header(text))
    rest = re.sub(r"\\(?:begin|end)\{[^}]*\}(?:\[[^\]]*\])?", "", rest)
    rest = re.sub(r"\\(?:paragraph|label|caption|centering)\*?(?:\{[^}]*\})?", "", rest)
    return not rest.strip()


def content_of(snippet_text: str) -> str:
    """What a snippet gives a document: its text below the header, blank lines at either end left out (contentOf in snippets.ts)."""
    return re.sub(r"^(\s*\n)+", "", body_after_header(snippet_text)).rstrip()


def content_fingerprint(content: str) -> str:
    """A content's fingerprint: its text without comments, whitespace collapsed (contentFingerprint in snippets.ts)."""
    return fnv(re.sub(r"\s+", " ", uncommented(content)).strip())


def parse_blocks(text: str) -> list[dict]:
    """The copies of snippets a document holds, in order (parseBlocks in snippets.ts): id, stamp, begin and end lines, content."""
    lines = text.replace("\r\n", "\n").split("\n")
    out, i = [], 0
    while i < len(lines):
        m = BEGIN_RE.match(lines[i])
        if m:
            end = next((j for j in range(i + 1, len(lines)) if (e := END_RE.match(lines[j])) and e.group(1) == m.group(1)), None)
            if end is not None:
                out.append({"id": m.group(1), "stamp": m.group(2), "begin": i, "end": end, "content": "\n".join(lines[i + 1:end])})
                i = end
        i += 1
    return out


def is_first_design(text: str) -> bool:
    """Whether a text is of the first design (isFirstDesign in hooks/lib/convert.ts): its markers,
    its package or its macros. The session converts such a document to clean source, once."""
    return bool(re.search(r"^\s*%\s*rft-(?:begin|end)\b", text, re.M) or re.search(r"\\usepackage(?:\[[^\]]*\])?\{rft\}", text)
                or re.search(r"\\rft(?:num|fig|table|snippet)\b", uncommented(text)))


def is_document(vault: Path, name: str) -> bool:
    """Whether documents/<name>/ is a document: a folder the plugin made one (it has a tracking
    file), or one from before a main file could have any name (it has a main.tex)."""
    d = documents_dir(vault)
    folder = d / name
    return bool(isinstance(name, str) and DOC_RE.match(name) and folder.is_dir() and not folder.is_symlink()
                and ((d / TRACKING / name / "tracking.json").is_file() or (folder / "main.tex").is_file()))


def document_names(vault: Path) -> list[str]:
    d = documents_dir(vault)
    return sorted(p.name for p in d.iterdir() if is_document(vault, p.name)) if d.is_dir() else []


def main_of(files: dict[str, str], recorded: str) -> tuple[str, list[str]]:
    """A document's main file (mainOf in hooks/lib/copies.ts): the one its tracking file records,
    while the document has it; else the one file with \\begin{document}, whatever its name. With
    several such files and none recorded the user is asked: the second answer lists them, and the
    first is what is read meanwhile. `files`: the document's .tex and .bib texts by path."""
    tex = sorted(f for f in files if TEX_FILE.search(f))
    if recorded in tex:
        return recorded, []
    found = [f for f in tex if BEGIN_DOCUMENT.search(uncommented(files[f]))]
    if len(found) == 1:
        return found[0], []
    if found:
        return ("main.tex" if "main.tex" in found else found[0]), found
    return ("main.tex" if "main.tex" in tex else tex[0] if tex else ""), []


def snippet_files(vault: Path) -> list[Path]:
    d = snippets_dir(vault)
    files = [p for p in d.glob("S*.tex") if SNIPPET_ID.match(p.stem)] if d.is_dir() else []
    return sorted(files, key=lambda p: int(p.stem[1:]))


# ---------------------------------------------------------------- a document's copies and values

def read_tracking(vault: Path, name: str) -> dict:
    """A document's tracking file (parseTracking in hooks/lib/tracking.ts): what is missing or
    malformed is left out; a file that is missing reads as a document tied to nothing yet."""
    d = _json(documents_dir(vault) / TRACKING / name / "tracking.json")
    text = lambda v: v if isinstance(v, str) else ""  # noqa: E731
    rows = lambda v: [x for x in v if isinstance(x, dict)] if isinstance(v, list) else []  # noqa: E731
    copies = [{"snippet": text(c.get("snippet")), "marker": text(c.get("marker")), "file": text(c.get("file")), "stamp": text(c.get("stamp")),
               "placed": text(c.get("placed")), **({"seen": c["seen"]} if text(c.get("seen")) else {})}
              for c in rows(d.get("copies")) if text(c.get("snippet")) and text(c.get("file"))]
    values = [{"kind": v["kind"], "from": text(v.get("from")), "key": text(v.get("key")), "written": text(v.get("written")), "file": text(v.get("file")),
               "before": text(v.get("before")), "after": text(v.get("after")), **({"kept": v["kept"]} if text(v.get("kept")) else {})}
              for v in rows(d.get("values")) if v.get("kind") in ("number", "figure", "table") and text(v.get("from")) and text(v.get("file"))]
    bib = {k: {"from": text(e.get("from")), "file": text(e.get("file"))} for k, e in (d.get("bib") if isinstance(d.get("bib"), dict) else {}).items()
           if isinstance(e, dict) and text(e.get("from"))}
    bib_of = {k: v for k, v in (d.get("bibOf") if isinstance(d.get("bibOf"), dict) else {}).items() if text(v)}
    return {"main": text(d.get("main")), "engine": d.get("engine") if d.get("engine") in ENGINES else "pdflatex", "template": text(d.get("template")),
            "copies": copies, "values": values, "bib": bib, "bibOf": bib_of,
            "allowed": [a for a in rows(d.get("allowed")) if text(a.get("file")) and text(a.get("match"))]}


def document_texts(vault: Path, name: str) -> tuple[dict[str, str], list[str]]:
    """A document's .tex and .bib files by their path inside it, and its other files' paths."""
    folder = documents_dir(vault) / name
    files, others = {}, []
    for p in rft_scan.document_files(folder):
        rel, text = p.relative_to(folder).as_posix(), None
        if TEXT_FILE.search(rel) and not p.is_symlink() and p.stat().st_size <= MAX_FILE:
            try:
                text = p.read_bytes().decode("utf-8").replace("\r\n", "\n")
            except (OSError, UnicodeDecodeError):
                text = None
        if text is None:
            others.append(rel)
        else:
            files[rel] = text
    return files, others


# what the page's editor opens (the rest is shown, or only listed), and what it shows instead of opening
EDITED = re.compile(r"\.(tex|ltx|bib|sty|cls|bst|bbx|cbx|lbx|def|cfg|clo|txt|md)$", re.I)
SHOWN = {".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image", ".svg": "image", ".pdf": "pdf"}


def tree_of(vault: Path, name: str) -> list[dict]:
    """Every file and folder of a document, by its path inside it, folders first met first: each
    with its `kind` (file or folder), a file with its size and how the page takes it (`edit`: in
    the editor; `show`: an image or a PDF, shown; neither: only listed). Hidden files and folders
    are the document's too (a .latexmkrc, a .gitignore), and listed; links are not followed."""
    folder = documents_dir(vault) / name
    out: list[dict] = []

    def visit(d: Path) -> None:
        for p in sorted(d.iterdir(), key=lambda x: (not (x.is_dir() and not x.is_symlink()), x.name)):
            rel = p.relative_to(folder).as_posix()
            if p.is_dir() and not p.is_symlink():
                out.append({"path": rel, "kind": "folder"})
                visit(p)
            else:
                try:
                    size = p.lstat().st_size
                except OSError:
                    size = 0
                edit = bool(EDITED.search(rel)) and not p.is_symlink() and size <= MAX_FILE
                out.append({"path": rel, "kind": "file", "size": size, "edit": edit, "show": None if p.is_symlink() else SHOWN.get(p.suffix.lower())})

    if folder.is_dir():
        visit(folder)
    return out


def template_of(main_text: str) -> str:
    """The template a document made before templates is read as: the built-in one of its class
    (`report` for a report, else `article`), as its kind was."""
    m = re.search(r"\\documentclass(?:\[[^\]]*\])?\{(\w+)\}", uncommented(main_text))
    return "report" if m and m.group(1) == "report" else "article"


def parse_markers(text: str) -> list[dict]:
    """The marker pairs of a text, in order (parseMarkers in hooks/lib/copies.ts). A marker with
    no `%%% end %%%` before the next marker is a comment of the user's own."""
    lines = text.replace("\r\n", "\n").split("\n")
    out, opened = [], None
    for i, line in enumerate(lines):
        if MARK_END_RE.match(line):
            if opened:
                out.append({**opened, "end": i, "content": "\n".join(lines[opened["begin"] + 1:i])})
            opened = None
        else:
            m = MARK_RE.match(line)
            if m:
                opened = {"words": m.group(1), "begin": i}
    return out


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def _squeeze(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def _uncommented_line(line: str) -> str:
    return re.sub(r"(^|[^\\])%.*$", r"\1", line)


def reading_order(files: dict[str, str], main: str):
    """The order a document is read in (readingOrder in copies.ts): its main file, each file it
    takes in at the line that names it, then the files nothing takes in. Returns `at(file, line)`,
    a place's rank in that order, and the files the main file reaches."""
    spans: list[tuple[str, int, int, int]] = []
    seen: set[str] = set()
    base = 0
    folder = main.rsplit("/", 1)[0] + "/" if "/" in main else ""  # what a file takes in is named from the main file's folder

    def visit(file: str) -> None:
        nonlocal base
        if file in seen or file not in files:
            return
        seen.add(file)
        lines = files[file].split("\n")
        start = 0

        def flush(to: int) -> None:
            nonlocal base, start
            if to < start:
                return
            spans.append((file, start, to, base))
            base += to - start + 1
            start = to + 1

        for i, line in enumerate(lines):
            for m in INCLUDE_RE.finditer(_uncommented_line(line)):
                name = folder + re.sub(r"^\./", "", m.group(1).strip())
                target = name if name in files else f"{name}.tex"
                if target not in files or target in seen:
                    continue
                flush(i)
                visit(target)
        flush(len(lines) - 1)

    visit(main)
    included = set(seen)
    for f in sorted(files):
        if TEX_FILE.search(f):
            visit(f)

    def at(file: str, line: int) -> int:
        return next((b + (line - a) for f, a, to, b in spans if f == file and a <= line <= to), sys.maxsize)

    return at, included


BIB_NAMED = re.compile(r"\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}")


def taken_in_by(files: dict[str, str], main: str) -> dict[str, str]:
    """The file that takes each .tex file in (takenInBy in copies.ts): the first that does, in the
    order the document is read. The main file, and a file nothing takes in, have none."""
    folder = main.rsplit("/", 1)[0] + "/" if "/" in main else ""
    parent: dict[str, str] = {}
    seen: set[str] = set()

    def visit(file: str) -> None:
        if file in seen or file not in files:
            return
        seen.add(file)
        for line in files[file].split("\n"):
            for m in INCLUDE_RE.finditer(_uncommented_line(line)):
                name = folder + re.sub(r"^\./", "", m.group(1).strip())
                target = name if name in files else f"{name}.tex"
                if target in files and target not in seen:
                    parent[target] = file
                    visit(target)

    visit(main)
    for f in sorted(files):
        if TEX_FILE.search(f):
            visit(f)
    return parent


def bib_for(files: dict[str, str], main: str, file: str, chosen: dict[str, str] | None = None) -> dict:
    """The .bib a file of a document uses, for an entry a placed snippet brings (bibFor in
    copies.ts; the cases both are held to: tests/fixtures/local-overleaf/bib.json). `{"bib": path}`,
    or `{"ask": [paths]}` when the document has several and nothing says which."""
    folder = main.rsplit("/", 1)[0] + "/" if "/" in main else ""
    path = lambda name: folder + (name if name.lower().endswith(".bib") else f"{name}.bib")  # noqa: E731
    named = lambda f: [path(n.strip()) for m in BIB_NAMED.finditer(uncommented(files.get(f, ""))) for n in m.group(1).split(",") if n.strip()]  # noqa: E731
    parent = taken_in_by(files, main)
    chain, at = [], file
    while at and at not in chain:
        chain.append(at)
        at = parent.get(at, "")
    for f in chain:
        if named(f):
            return {"bib": named(f)[0]}
    for f in chain:
        if (chosen or {}).get(f):
            return {"bib": chosen[f]}
    everywhere = list(dict.fromkeys(b for f in sorted(files) if TEX_FILE.search(f) for b in named(f)))
    there = sorted(f for f in files if f.lower().endswith(".bib"))
    options = everywhere or there
    if len(options) == 1:
        return {"bib": options[0]}
    return {"ask": sorted(options)} if options else {"bib": f"{folder}refs.bib"}


def _squeezed(text: str) -> tuple[str, list[int]]:
    """A text with each run of whitespace made one space, and where each of its characters was."""
    out, at, gap = [], [], False
    for i, ch in enumerate(text):
        if ch.isspace():
            gap = bool(out)
            continue
        if gap:
            out.append(" ")
            at.append(i - 1)
            gap = False
        out.append(ch)
        at.append(i)
    return "".join(out), at


def _line_of(text: str, offset: int) -> int:
    return text.count("\n", 0, offset)


def locate_copies(files: dict[str, str], tracking: dict) -> list[dict]:
    """The copies of a tracking file, each found in the document's files (locateCopies in
    copies.ts): by a marker pair with its words (in its file first, else in another: it was
    moved), else by its text, else lost. `begin` and `end`: its first and last line, markers
    included (from 0)."""
    names = sorted(f for f in files if TEX_FILE.search(f))
    markers = [{"file": f, **m, "taken": False} for f in names for m in parse_markers(files[f])]
    counts: dict[str, int] = {}
    out = []
    for index, c in enumerate(tracking["copies"]):
        counts[c["snippet"]] = counts.get(c["snippet"], 0) + 1
        out.append({**c, "index": index, "nth": counts[c["snippet"]], "found": None, "begin": None, "end": None, "content": None})
    for c in out:
        same = [m for m in markers if not m["taken"] and _norm(m["words"]) == _norm(c["marker"])]
        m = next((x for x in same if x["file"] == c["file"]), same[0] if same else None)
        if m:
            m["taken"] = True
            c.update(found="markers", file=m["file"], begin=m["begin"], end=m["end"], content=m["content"])
    claimed = lambda file, a, b: any(c["found"] and c["file"] == file and c["begin"] <= b and c["end"] >= a for c in out)  # noqa: E731
    for c in out:
        want = _squeeze(c.get("seen") or c["placed"])
        if c["found"] or not want:
            continue
        for file in [c["file"]] + [f for f in names if f != c["file"]]:
            if file not in files:
                continue
            sq, at = _squeezed(files[file])
            k, hit = sq.find(want), -1
            while k >= 0:
                a, b = _line_of(files[file], at[k]), _line_of(files[file], at[k + len(want) - 1])
                if not claimed(file, a, b):
                    hit = k
                    break
                k = sq.find(want, k + 1)
            if hit < 0:
                continue
            a, b = _line_of(files[file], at[hit]), _line_of(files[file], at[hit + len(want) - 1])
            m = next((x for x in markers if not x["taken"] and x["file"] == file and x["begin"] < a and x["end"] > b and _squeeze(x["content"]) == want), None)
            if m:
                m["taken"] = True
                c.update(found="markers", file=file, begin=m["begin"], end=m["end"], content=m["content"])
            else:
                c.update(found="text", file=file, begin=a, end=b, content="\n".join(files[file].split("\n")[a:b + 1]))
            break
    return out


def _flexible(s: str) -> str:
    """A text as a pattern that takes any spacing where the text has some."""
    return r"\s+".join(re.escape(p) for p in re.split(r"\s+", s))


NEAR = (1000, 12, 6)  # how much of the text on each side of a value is asked to match: all that was kept, then less


def locate_values(files: dict[str, str], tracking: dict) -> list[dict]:
    """Each tracked value found in its file by the text before and after it (locateValues in
    copies.ts): `written` when it stands as it was written, `changed` when something else stands
    between its before and after, None when its place is not found."""
    taken: dict[str, list[tuple[int, int]]] = {}
    out = []
    for index, v in enumerate(tracking["values"]):
        text = files.get(v["file"])
        got = {**v, "index": index, "found": None, "offset": None, "line": None, "inDocument": None}
        out.append(got)
        if text is None:
            continue

        def take(found: str, pattern: str) -> bool:
            for m in re.finditer(pattern, text):
                offset, there = m.end(1), m.group(2)
                if any(offset < b and offset + len(there) > a for a, b in taken.get(v["file"], [])):
                    continue
                taken.setdefault(v["file"], []).append((offset, offset + max(1, len(there))))
                got.update(found=found, offset=offset, line=_line_of(text, offset), inDocument=there)
                return True
            return False

        # by all the text kept on each side; then by less of it, so that a word changed nearby does not lose the value
        around = lambda n: (_flexible(v["before"][-n:]), _flexible(v["after"][:n]))  # noqa: E731
        if any(take("written", "({})({})(?={})".format(around(n)[0], _flexible(v["written"]), around(n)[1])) for n in NEAR):
            continue
        if v["kind"] == "table":
            continue
        for n in NEAR[:2]:
            if len(_squeeze(v["before"][-n:])) + len(_squeeze(v["after"][:n])) >= 6 and take("changed", "({})([^\\n]{{0,80}}?)(?={})".format(*around(n))):
                break
    return out


def copy_at(copies: list[dict], file: str, line: int) -> dict | None:
    return next((c for c in copies if c["found"] and c["file"] == file and c["begin"] <= line <= c["end"]), None)


def bib_keys(bib: str) -> list[str]:
    return [k for k in re.findall(r"^\s*@\w+\s*\{\s*([^,\s]+)\s*,", bib, re.M) if not re.fullmatch(r"string|comment|preamble", k, re.I)]


def own_cited(files: dict[str, str], tracking: dict) -> list[dict]:
    """The citations of a document that rest on no reference note (ownCited in manuscript.ts):
    each key cited in its .tex files whose entry, in one of its .bib files, is the user's own."""
    own = {k for f in files if f.lower().endswith(".bib") for k in bib_keys(files[f])} - set(tracking["bib"])
    out = []
    for file in sorted(f for f in files if TEX_FILE.search(f)) if own else []:
        for i, line in enumerate(files[file].split("\n")):
            out.extend({"key": key, "file": file, "line": i + 1} for key in sorted(rft_scan.cited_keys(line)) if key in own)
    return out


def _leaves(x, key: str = "", out: dict | None = None) -> dict:
    out = {} if out is None else out
    if isinstance(x, list):
        for i, v in enumerate(x):
            _leaves(v, f"{key}[{i}]", out)
    elif isinstance(x, dict):
        for k, v in x.items():
            _leaves(v, f"{key}.{k}" if key else str(k), out)
    elif key:
        out[key] = x
    return out


def saved_numbers(vault: Path, nid: str) -> dict[str, str] | None:
    """The numbers a note's run saved (results/<id>.json), each as the text a document holds
    (savedNumbers in hooks/lib/writeout.ts); None when the note has no saved run."""
    try:
        d = json.loads((Path(vault) / "results" / f"{nid}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    out = {}
    for k, v in _leaves(d.get("results") if isinstance(d, dict) else None).items():
        if v is None or isinstance(v, bool) or "{" in k or "}" in k:
            continue
        out[k] = tex_text(number_text(v))
    return out


def figure_token(path: Path) -> str | None:
    """A saved figure's version, as both sides can tell it: its size and the second it was written."""
    try:
        st = path.stat()
    except OSError:
        return None
    return f"{st.st_size}@{int(st.st_mtime)}"


def values_of(vault: Path, name: str, files: dict[str, str], tracking: dict, copies: list[dict]) -> list[dict]:
    """A document's tracked values, each found in its file and held against the tree as it is now
    (valuesOf in hooks/lib/manuscript.ts): current, review, changed or lost."""
    vault = Path(vault)
    numbers: dict[str, dict | None] = {}
    out = []
    for v in locate_values(files, tracking):
        same = False
        if v["kind"] == "number":
            if v["from"] not in numbers:
                numbers[v["from"]] = saved_numbers(vault, v["from"])
            now = (numbers[v["from"]] or {}).get(v["key"])
            same = now == v["written"]
        elif v["kind"] == "table":
            try:
                now = (vault / "tables" / f"{v['from']}_{v['key']}.tex").read_text(encoding="utf-8").replace("\r\n", "\n").strip()
            except OSError:
                now = None
            same = now == v["written"]
        else:
            theirs = vault / "figures" / f"{v['from']}_{v['key']}.pdf"
            now = figure_token(theirs)
            try:
                same = now is not None and v["found"] == "written" and theirs.read_bytes() == (documents_dir(vault) / name / v["written"]).read_bytes()
            except OSError:
                same = False
        state = "lost" if not v["found"] else "changed" if v["found"] == "changed" else "current" if now is not None and (same or now == v.get("kept")) else "review"
        inside = copy_at(copies, v["file"], v["line"]) if v["line"] is not None else None
        out.append({"index": v["index"], "kind": v["kind"], "from": v["from"], "key": v["key"], "written": v["written"], "file": v["file"],
                    "line": None if v["line"] is None else v["line"] + 1, "state": state, "now": now, "inDocument": v["inDocument"],
                    "inCopyOf": inside["snippet"] if inside else None})
    return out


# ---------------------------------------------------------------- the state

def cite_index(nodes: dict[str, dict], read) -> dict[str, str]:
    """Each citation key and the reference note it stands for (citeIndex in manuscript.ts)."""
    out: dict[str, str] = {}
    for n in nodes.values():
        if n["type"] != "reference":
            continue
        out[n["id"]] = n["id"]
        for block in re.findall(r"```bibtex\n([\s\S]*?)```", read(n["id"])):
            for key in re.findall(r"@\w+\s*\{\s*([^,\s]+)\s*,", block):
                out.setdefault(key, n["id"])
    return out


def summary(vault: Path, tree: dict, read) -> dict:
    """The manuscript as the page shows it: its lock, its documents, each snippet with its state.
    `tree`: the server's tree; `read(id)`: a note's text."""
    vault = Path(vault)
    if not (snippets_dir(vault) / "snippets.json").is_file() and not (documents_dir(vault) / "documents.json").is_file():
        return {"exists": False}
    reg = read_registry(vault)
    dreg = read_docs_registry(vault)
    nodes = {n["id"]: n for n in tree["nodes"]}
    names = {n["name"]: n["id"] for n in tree["nodes"]}
    cites = cite_index(nodes, read)
    resolve = lambda ref: ref if ref in nodes else names.get(ref) or (ref.split(" ")[0] if ref.split(" ")[0] in nodes else None)  # noqa: E731
    snippets = []
    contents: dict[str, str] = {}
    for f in snippet_files(vault):
        text = f.read_text(encoding="utf-8", errors="replace")
        contents[f.stem] = content_fingerprint(content_of(text))
        h = header(text) or {"id": f.stem, "kind": "", "title": "", "basis": []}
        u = uses_in(body_after_header(text))
        ids, missing = [], []
        for ref in h["basis"] + [a for a, _ in u["nums"] + u["figs"] + u["tables"]]:
            nid = resolve(ref)
            if nid and nid not in ids:
                ids.append(nid)
            elif not nid and ref not in missing:
                missing.append(ref)
        for key in u["cites"]:
            nid = cites.get(key)
            if nid and nid not in ids:
                ids.append(nid)
        stamp = (reg["snippets"].get(f.stem) or {}).get("stamp") or {}
        review, unverified = [], []
        for nid in ids:
            n = nodes[nid]
            if n.get("supersededBy"):
                review.append(f"{nid} superseded by {n['supersededBy']}")
            elif n["status"] == "review":
                review.append(f"{nid} in review")
            elif n["status"] == "dropped":
                review.append(f"{nid} dropped")
            elif stamp.get(nid) and stamp[nid] != substance_fingerprint(n["type"], read(nid)):
                review.append(f"{nid} changed")
            if n["status"] not in ("verified", "review"):
                unverified.append(nid)
        snippets.append({"id": f.stem, "kind": h["kind"], "title": h["title"], "declared": h["basis"], "basis": ids,
                         "missing": missing, "review": review, "unverified": unverified, "stub": is_stub(text),
                         "locked": snippet_locked(reg, f.stem), "usedIn": []})
    by_id = {s["id"]: s for s in snippets}
    ids = set(nodes) | set(by_id)
    docs = []
    for name in document_names(vault):
        files, others = document_texts(vault, name)
        tracking = read_tracking(vault, name)
        main, asked = main_of(files, tracking["main"])
        _, included = reading_order(files, main)
        located = locate_copies(files, tracking)
        several = {c["snippet"] for c in located if c["nth"] > 1}
        copies = []
        for c in located:
            s = by_id.get(c["snippet"])
            state = "lost" if not c["found"] else "gone" if s is None else "review" if contents[c["snippet"]] != c["stamp"] \
                else "adapted" if content_fingerprint(c["content"]) != content_fingerprint(c["placed"]) else "placed"
            copies.append({"id": c["snippet"], "name": f"{c['snippet']}#{c['nth']}" if c["snippet"] in several else c["snippet"], "nth": c["nth"],
                           "marker": c["marker"], "file": c["file"], "state": state, "markers": c["found"] == "markers",
                           "line": None if c["begin"] is None else c["begin"] + 1, "end": None if c["end"] is None else c["end"] + 1,
                           "placed": c["placed"], "snippetReview": bool(c["found"] and s and s["review"]),
                           # a copy in a file the main file never takes in is not in the document
                           "included": bool(c["found"] and c["file"] in included)})
            if s is not None and c["found"] and c["file"] in included:
                use = next((u for u in s["usedIn"] if u["doc"] == name and u["file"] == c["file"]), None)
                if use is None:
                    use = {"doc": name, "file": c["file"], "count": 0, "states": []}
                    s["usedIn"].append(use)
                use["count"] += 1
                use["states"].append(state)
        scan = rft_scan.scan_document(vault, name, ids, set(cites))
        docs.append({"name": name, "path": f"{DOCUMENTS}/{name}/{main}", "main": main, "mainAsked": asked,
                     "mainCandidates": [f for f in sorted(files) if TEX_FILE.search(f) and BEGIN_DOCUMENT.search(uncommented(files[f]))], "engine": tracking["engine"],
                     "template": tracking["template"] or template_of(files.get(main, "")), "files": sorted(files), "others": others, "tree": tree_of(vault, name),
                     "notIncluded": sorted(f for f in files if TEX_FILE.search(f) and f not in included),
                     "locked": document_locked(dreg, name), "copies": copies, "values": values_of(vault, name, files, tracking, located),
                     "bib": [{"key": k, "file": f, "from": (tracking["bib"].get(k) or {}).get("from")} for f in sorted(files) if f.lower().endswith(".bib") for k in bib_keys(files[f])],
                     "ownCited": own_cited(files, tracking),
                     "traces": scan["traces"], "allowedTraces": scan["allowed"],
                     "firstDesign": any(is_first_design(text) for f, text in files.items() if TEX_FILE.search(f))})
    return {"exists": True, "locked": reg["locked"], "unlocked": reg["unlocked"], "docsLocked": dreg["locked"], "docsUnlocked": dreg["unlocked"],
            "documents": docs, "snippets": snippets}
