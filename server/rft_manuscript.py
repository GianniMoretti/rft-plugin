"""Snippets and documents as the tree view's server reads them (docs/design/manuscript.md), as
hooks/lib/manuscript.ts, snippets.ts and verify.ts have them. Snippets (vault/snippets/): each with
its header, what it rests on (its `% basis:` line and the notes its \\rftnum, \\rftfig, \\rfttable
and \\cite name), its state (stub, written, review: a basis note changed since the stamp, in
review, superseded or dropped; the basis notes not verified), and the documents using it.
Documents (vault/documents/<name>/main.tex): their copies of snippets, each with its state (review:
its snippet changed since it was taken; adapted; gone). The stamps and the copies are written by the
session (hooks/lib/manuscript.ts), never here; the server writes the locks and the text the user
edits. Standard library only.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

SNIPPETS = "snippets"
DOCUMENTS = "documents"
SNIPPET_ID = re.compile(r"^S\d+$")
DOC_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
HEAD_RE = re.compile(r"^%\s*rft-snippet\s+(S\d+)\s*·\s*([\w-]+)\s*·\s*(.*?)\s*$")
BASIS_RE = re.compile(r"^%\s*basis:\s*(.*?)\s*$")
FENCE_RE = re.compile(r"^\s*(```|~~~)")
BEGIN_RE = re.compile(r"^%\s*rft-begin\s+(S\d+)\s+([0-9a-f]{8})\s*$")
END_RE = re.compile(r"^%\s*rft-end\s+(S\d+)\s*$")

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


def document_names(vault: Path) -> list[str]:
    d = documents_dir(vault)
    return sorted(p.name for p in d.iterdir() if p.is_dir() and DOC_RE.match(p.name) and (p / "main.tex").is_file()) if d.is_dir() else []


def snippet_files(vault: Path) -> list[Path]:
    d = snippets_dir(vault)
    files = [p for p in d.glob("S*.tex") if SNIPPET_ID.match(p.stem)] if d.is_dir() else []
    return sorted(files, key=lambda p: int(p.stem[1:]))


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
    docs = []
    for name in document_names(vault):
        text = (documents_dir(vault) / name / "main.tex").read_text(encoding="utf-8", errors="replace")
        copies = []
        for b in parse_blocks(text):
            s = by_id.get(b["id"])
            state = "gone" if s is None else "review" if contents[b["id"]] != b["stamp"] \
                else "adapted" if content_fingerprint(b["content"]) != b["stamp"] else "sync"
            copies.append({"id": b["id"], "state": state, "line": b["begin"] + 1, "snippetReview": bool(s and s["review"])})
            if s is not None:
                s["usedIn"].append({"doc": name, "state": state})
        held = {c["id"] for c in copies}
        refs = list(dict.fromkeys(m for m in re.findall(r"\\(?:ref|cref|Cref|autoref|eqref|nameref)\{(S\d+)\}", uncommented(text)) if m not in held))
        docs.append({"name": name, "path": f"{DOCUMENTS}/{name}/main.tex", "locked": document_locked(dreg, name), "copies": copies, "refsMissing": refs})
    return {"exists": True, "locked": reg["locked"], "unlocked": reg["unlocked"], "docsLocked": dreg["locked"], "docsUnlocked": dreg["unlocked"],
            "documents": docs, "snippets": snippets}
