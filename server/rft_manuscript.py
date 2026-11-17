"""The manuscript as the tree view's server reads it (docs/design/manuscript.md), as
hooks/lib/manuscript.ts, snippets.ts and verify.ts have it: the registry (manuscript.json), the
snippets with their header, what each rests on (its `% basis:` line and the notes its \\rftnum,
\\rftfig, \\rfttable and \\cite name), and its state: stub, written, review (a basis note changed
since the stamp, in review, superseded or dropped), with the basis notes not verified. The stamps
are written by the session (hooks/lib/manuscript.ts), never here; the server writes the lock and
the snippets' and documents' text the user edits. Standard library only.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

MANUSCRIPT = "manuscript"
SNIPPET_ID = re.compile(r"^S\d+$")
DOC_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
HEAD_RE = re.compile(r"^%\s*rft-snippet\s+(S\d+)\s*·\s*([\w-]+)\s*·\s*(.*?)\s*$")
BASIS_RE = re.compile(r"^%\s*basis:\s*(.*?)\s*$")
FENCE_RE = re.compile(r"^\s*(```|~~~)")
SNIPPET_LINE = re.compile(r"\\rftsnippet\{(S\d+)\}")

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

def manuscript_dir(vault: Path) -> Path:
    return Path(vault) / MANUSCRIPT


def read_registry(vault: Path) -> dict:
    try:
        d = json.loads((manuscript_dir(vault) / "manuscript.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        d = {}
    d = d if isinstance(d, dict) else {}
    return {"locked": d.get("locked") is not False, "next": d.get("next") if isinstance(d.get("next"), int) and d["next"] > 0 else 1,
            "snippets": d.get("snippets") if isinstance(d.get("snippets"), dict) else {},
            "unlocked": [x for x in d.get("unlocked") or [] if isinstance(x, str)]}


def snippet_locked(reg: dict, sid: str) -> bool:
    return bool(reg["locked"]) and sid not in reg["unlocked"]


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


def documents(vault: Path) -> list[dict]:
    d = manuscript_dir(vault) / "documents"
    out = []
    if d.is_dir():
        for sub in sorted(p for p in d.iterdir() if p.is_dir() and DOC_RE.match(p.name)):
            main = sub / "main.tex"
            if not main.is_file():
                continue
            text = main.read_text(encoding="utf-8", errors="replace")
            order = [m.group(1) for m in SNIPPET_LINE.finditer(text) if not re.search(r"(^|[^\\])%", text[text.rfind("\n", 0, m.start()) + 1:m.start()])]
            out.append({"name": sub.name, "path": f"documents/{sub.name}/main.tex", "order": order})
    return out


def snippet_files(vault: Path) -> list[Path]:
    d = manuscript_dir(vault) / "snippets"
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
    if not (manuscript_dir(vault) / "manuscript.json").is_file():
        return {"exists": False}
    reg = read_registry(vault)
    nodes = {n["id"]: n for n in tree["nodes"]}
    names = {n["name"]: n["id"] for n in tree["nodes"]}
    cites = cite_index(nodes, read)
    resolve = lambda ref: ref if ref in nodes else names.get(ref) or (ref.split(" ")[0] if ref.split(" ")[0] in nodes else None)  # noqa: E731
    snippets = []
    for f in snippet_files(vault):
        text = f.read_text(encoding="utf-8", errors="replace")
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
                         "locked": snippet_locked(reg, f.stem)})
    return {"exists": True, "locked": reg["locked"], "unlocked": reg["unlocked"], "documents": documents(vault), "snippets": snippets}
