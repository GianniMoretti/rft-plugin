"""A document as a folder of files (docs/design/manuscript.md): what the user does to it from the
page's file list. A file or a folder made, renamed, moved or deleted; an image, a PDF or any other
file uploaded, its bytes as they came; which file is the main one; which engine compiles it.
Standard library only.

Nothing here reads LaTeX or decides what a copy is: the copies, their states and what is written
out are the session's (hooks/lib/manuscript.ts). The server writes a document's tracking file
(documents/.rft/<name>/tracking.json) only to carry what the user did to the files: the paths of
what was renamed or moved, the main file and the engine. Whatever else the file holds is left as
it is.

Every path is one inside the document's folder, checked the same way (`inside`): no absolute
path, no `..`, no backslash, no hidden name, and nothing reached through a link. A name that
carries a trace of the tree (an id of a note or a snippet, the plugin's name) is refused, since
the folder is shared as it is (docs/adr/0003-a-document-holds-no-trace.md).
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rft_manuscript  # noqa: E402
import rft_scan  # noqa: E402
from rft_results import write_atomic  # noqa: E402

MAX_UPLOAD = 20_000_000
MAX_NAME = 200
FORBIDDEN = set('\\\x00<>:"|?*')
TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf"}

Answer = tuple[int, dict]


def megabytes(n: int) -> str:
    return f"{n / 1_000_000:.1f} MB"


def folder_of(vault: Path, doc: str) -> Path | None:
    """A document's folder, when `doc` is one."""
    return rft_manuscript.documents_dir(vault) / doc if rft_manuscript.is_document(vault, doc) else None


def clean(rel: object) -> str | None:
    """A path inside a document as it is kept: its parts joined by `/`; None when it is not one a
    file of a document may have."""
    if not isinstance(rel, str) or not rel.strip() or len(rel) > 4 * MAX_NAME or FORBIDDEN & set(rel) or rel.startswith("/"):
        return None
    parts = [p for p in rel.strip().split("/") if p != ""]
    if not parts or any(p in (".", "..") or p.startswith(".") or p != p.strip() or len(p) > MAX_NAME or any(ord(c) < 32 for c in p) for p in parts):
        return None
    return "/".join(parts)


def inside(folder: Path, rel: str) -> Path | None:
    """The file or folder `rel` names inside `folder`, when nothing on the way to it is a link."""
    at = folder
    for part in rel.split("/"):
        at = at / part
        if at.is_symlink():
            return None
    return at if folder.resolve() in at.resolve().parents else None


def trace_in_name(rel: str, ids: set[str]) -> str:
    """Why a name will not do in a folder that is shared as it is; '' when it will."""
    found = rft_scan.traces_in_name(rel, ids)
    if not found:
        return ""
    words = ", ".join(dict.fromkeys(f"the id {t['match']}" if t["kind"] == "id" else f"the plugin's {t['match']}" for t in found))
    return f"{rel} names a part of your tree ({words}), and a document's files are shared as they are: give the file another name"


def _target(vault: Path, doc: str, rel: object, ids: set[str] | None = None) -> tuple[Path, str, Path] | Answer:
    """The document's folder, a path inside it and the file it names; or the refusal."""
    folder = folder_of(vault, doc)
    if folder is None:
        return 404, {"error": "no such document"}
    path = clean(rel)
    if path is None:
        return 400, {"error": "not a path a file of a document may have: letters, digits and the usual signs, folders with /, no name starting with a dot"}
    target = inside(folder, path)
    if target is None:
        return 400, {"error": f"{path} is not inside the document's folder"}
    if ids is not None and (why := trace_in_name(path, ids)):
        return 422, {"error": why}
    return folder, path, target


# ---------------------------------------------------------------- the tracking file, for paths and settings only

def tracking_path(vault: Path, doc: str) -> Path:
    return rft_manuscript.documents_dir(vault) / rft_manuscript.TRACKING / doc / "tracking.json"


def read_raw(vault: Path, doc: str) -> dict:
    """A tracking file as it is written, every field kept; one that is missing or broken reads as empty."""
    try:
        d = json.loads(tracking_path(vault, doc).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        d = {}
    return d if isinstance(d, dict) else {}


def write_raw(vault: Path, doc: str, d: dict) -> None:
    d.setdefault("version", 1)
    write_atomic(tracking_path(vault, doc), json.dumps(d, indent=2, ensure_ascii=False) + "\n")


def moved(path: object, old: str, new: str) -> object:
    """A path of the tracking file after `old` (a file, or a folder with what is in it) became `new`."""
    if not isinstance(path, str):
        return path
    if path == old:
        return new
    return new + path[len(old):] if path.startswith(old + "/") else path


def carry(d: dict, old: str, new: str) -> dict:
    """A tracking file's content after a file or folder was renamed or moved: every path it keeps
    follows (a copy's file, a value's, a figure's own path, an entry's .bib, an allowed
    occurrence's, the main file, the .bib chosen for a file)."""
    for c in d.get("copies") or []:
        if isinstance(c, dict):
            c["file"] = moved(c.get("file"), old, new)
    for v in d.get("values") or []:
        if isinstance(v, dict):
            v["file"] = moved(v.get("file"), old, new)
            if v.get("kind") == "figure":
                v["written"] = moved(v.get("written"), old, new)
    for e in (d.get("bib") or {}).values() if isinstance(d.get("bib"), dict) else []:
        if isinstance(e, dict):
            e["file"] = moved(e.get("file"), old, new)
    for a in d.get("allowed") or []:
        if isinstance(a, dict):
            a["file"] = moved(a.get("file"), old, new)
    if isinstance(d.get("main"), str) and d["main"]:
        d["main"] = moved(d["main"], old, new)
    if isinstance(d.get("bibOf"), dict):
        d["bibOf"] = {moved(k, old, new): moved(v, old, new) for k, v in d["bibOf"].items()}
    return d


# ---------------------------------------------------------------- the file list

def new_file(vault: Path, doc: str, rel: object, ids: set[str]) -> Answer:
    """An empty file, its folders made on the way."""
    got = _target(vault, doc, rel, ids)
    if not isinstance(got[0], Path):
        return got
    folder, path, target = got
    if target.exists() or target.is_symlink():
        return 409, {"error": f"{doc} already has {path}"}
    if not rft_manuscript.EDITED.search(path):
        return 400, {"error": f"{path}: a file made here is one the editor opens (.tex, .bib, .sty, .cls, .bst, .bbx, .txt, .md); upload any other"}
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"")
    except OSError as err:
        return 400, {"error": f"{path} could not be made ({err.strerror or err})"}
    return 201, {"path": path}


def new_folder(vault: Path, doc: str, rel: object, ids: set[str]) -> Answer:
    got = _target(vault, doc, rel, ids)
    if not isinstance(got[0], Path):
        return got
    folder, path, target = got
    if target.exists() or target.is_symlink():
        return 409, {"error": f"{doc} already has {path}"}
    try:
        target.mkdir(parents=True)
    except OSError as err:
        return 400, {"error": f"{path} could not be made ({err.strerror or err})"}
    return 201, {"path": path}


def move(vault: Path, doc: str, rel: object, to: object, ids: set[str]) -> Answer:
    """A file or a folder renamed or moved inside its document. What the tracking file keeps of it
    follows, so a file's copies and values stay its own. Nothing is overwritten, and no text is
    changed: a line that takes the file in by its old name is the user's to change."""
    got = _target(vault, doc, rel)
    if not isinstance(got[0], Path):
        return got
    folder, old, source = got
    got = _target(vault, doc, to, ids)
    if not isinstance(got[0], Path):
        return got
    _, new, target = got
    if not source.exists():
        return 404, {"error": f"{doc} has no {old}"}
    if new == old:
        return 200, {"path": new}
    if new.startswith(old + "/"):
        return 400, {"error": f"{old} cannot go inside itself"}
    if target.exists() or target.is_symlink():
        return 409, {"error": f"{doc} already has {new}: nothing is overwritten"}
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(source, target)
    except OSError as err:
        return 400, {"error": f"{old} could not be moved ({err.strerror or err})"}
    if tracking_path(vault, doc).is_file():
        write_raw(vault, doc, carry(read_raw(vault, doc), old, new))
    return 200, {"path": new, "from": old}


def copies_in(vault: Path, doc: str, rel: str) -> list[str]:
    """The copies of snippets found in a file, or in the files of a folder, as the page names them."""
    files, _ = rft_manuscript.document_texts(vault, doc)
    located = rft_manuscript.locate_copies(files, rft_manuscript.read_tracking(vault, doc))
    several = {c["snippet"] for c in located if c["nth"] > 1}
    return [f"{c['snippet']}#{c['nth']}" if c["snippet"] in several else c["snippet"]
            for c in located if c["found"] and (c["file"] == rel or c["file"].startswith(rel + "/"))]


def delete(vault: Path, doc: str, rel: object, sure: bool = False) -> Answer:
    """A file, or a folder with all it holds, deleted. One that holds copies of snippets, or is
    the main file, is deleted only once the user said so (`sure`): the answer before that says
    what would be lost. The copies stay tracked, and are then shown as lost."""
    got = _target(vault, doc, rel)
    if not isinstance(got[0], Path):
        return got
    folder, path, target = got
    if not target.exists() and not target.is_symlink():
        return 404, {"error": f"{doc} has no {path}"}
    whole = target.is_dir() and not target.is_symlink()
    held = copies_in(vault, doc, path)
    files, _ = rft_manuscript.document_texts(vault, doc)
    main, _ = rft_manuscript.main_of(files, rft_manuscript.read_tracking(vault, doc)["main"])
    is_main = bool(main) and (main == path or main.startswith(path + "/"))
    if (held or is_main) and not sure:
        what = []
        if is_main:
            what.append(f"{main} is the document's main file")
        if held:
            what.append(f"{'it holds' if not whole else 'its files hold'} {len(held)} cop{'y' if len(held) == 1 else 'ies'} of snippets ({', '.join(held)}), which will be shown as lost")
        return 409, {"error": f"{path}: {'; '.join(what)}. Delete it anyway?", "ask": True, "copies": held, "main": is_main}
    try:
        if whole:
            shutil.rmtree(target)
        else:
            target.unlink()
    except OSError as err:
        return 400, {"error": f"{path} could not be deleted ({err.strerror or err})"}
    return 200, {"path": path, "lost": held}


def upload(vault: Path, doc: str, rel: object, data: bytes, ids: set[str], replace: bool = False) -> Answer:
    """A file of the user's machine put in the document, its bytes as they came. Refused above
    MAX_UPLOAD with its size said, under a name that carries a trace of the tree, and over a
    file that is there unless the user said to replace it."""
    got = _target(vault, doc, rel, ids)
    if not isinstance(got[0], Path):
        return got
    folder, path, target = got
    if len(data) > MAX_UPLOAD:
        return 413, {"error": f"{path} is {megabytes(len(data))}: a file of a document is at most {megabytes(MAX_UPLOAD)}"}
    if target.is_dir():
        return 409, {"error": f"{path} is a folder of {doc}"}
    if target.exists() and not replace:
        return 409, {"error": f"{doc} already has {path}", "ask": True}
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        if inside(folder, path) is None:
            return 400, {"error": f"{path} is not inside the document's folder"}
        write_atomic(target, data)
    except OSError as err:
        return 400, {"error": f"{path} could not be written ({err.strerror or err})"}
    return 201, {"path": path, "size": len(data)}


def shown(vault: Path, doc: str, rel: object) -> tuple[Path, str] | None:
    """An image or a PDF of a document, for the page to show: its file and its type."""
    got = _target(vault, doc, rel)
    if not isinstance(got[0], Path):
        return None
    _, path, target = got
    kind = TYPES.get(target.suffix.lower())
    return (target, kind) if kind and target.is_file() else None


# ---------------------------------------------------------------- the main file and the engine

def set_main(vault: Path, doc: str, rel: object) -> Answer:
    """The user says which file is the main one: a .tex file of the document, recorded in its tracking file."""
    got = _target(vault, doc, rel)
    if not isinstance(got[0], Path):
        return got
    _, path, target = got
    if not rft_manuscript.TEX_FILE.search(path) or not target.is_file():
        return 404, {"error": f"{doc} has no .tex file {path}"}
    text = target.read_bytes().decode("utf-8", errors="replace")
    if not rft_manuscript.BEGIN_DOCUMENT.search(rft_manuscript.uncommented(text)):
        return 422, {"error": f"{path} has no \\begin{{document}}: the main file is the one that has it"}
    write_raw(vault, doc, {**read_raw(vault, doc), "main": path})
    return 200, {"main": path}


def set_engine(vault: Path, doc: str, engine: object) -> Answer:
    """The engine a document compiles with, recorded in its tracking file."""
    if folder_of(vault, doc) is None:
        return 404, {"error": "no such document"}
    if engine not in rft_manuscript.ENGINES:
        return 400, {"error": f"the engine is one of {', '.join(rft_manuscript.ENGINES)}"}
    write_raw(vault, doc, {**read_raw(vault, doc), "engine": engine})
    return 200, {"engine": engine}
