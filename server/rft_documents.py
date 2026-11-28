"""A document as a folder of files (docs/design/manuscript.md): what the user does to it from the
page's file list. A file or a folder made, renamed, moved or deleted; an image, a PDF or any other
file uploaded, its bytes as they came; which file is the main one; which engine compiles it. And
the templates a document is made from: those there are (two built in, and the folders of the
vault's templates/), and one loaded from a zip (the page sends a folder as a zip too), checked
entry by entry before anything is written. And what reuses a document: a duplicate (a second
document with the same files and the same tracking, tied to nothing of the first), a document
brought into a folder of another (a paper becomes a chapter of a thesis by papers: its files
copied once, its tracking carried under their new paths, what clashes and what remains for the
user said, nothing rewritten), and a template's files added to a document (nothing overwritten).
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

import io
import json
import os
import re
import shutil
import stat
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rft_manuscript  # noqa: E402
import rft_scan  # noqa: E402
from rft_results import write_atomic  # noqa: E402

MAX_UPLOAD = 20_000_000
MAX_NAME = 200
FORBIDDEN = set('\\\x00<>:"|?*')
TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".pdf": "application/pdf"}

# templates (hooks/lib/templates.ts): two built in, and the folders of the vault's templates/
TEMPLATES = "templates"
BUILT_IN = ("article", "report")
TEMPLATE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
TEMPLATE_SETTINGS = "template.json"
MAX_TEMPLATE = 50_000_000  # a template's files, unpacked, and the zip that brings them
MAX_TEMPLATE_FILES = 2000

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
            if v.get("kind") == "figure" and v.get("base"):
                v["base"] = moved(v["base"], old, new)  # its path in the text is read from that folder: the folder follows
            elif v.get("kind") == "figure":
                v["written"] = moved(v.get("written"), old, new)
    for e in (d.get("bib") or {}).values() if isinstance(d.get("bib"), dict) else []:
        if isinstance(e, dict):
            e["file"] = moved(e.get("file"), old, new)
            if isinstance(e.get("also"), list):
                e["also"] = [moved(x, old, new) for x in e["also"]]
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


# ---------------------------------------------------------------- templates

def templates_dir(vault: Path) -> Path:
    return Path(vault) / TEMPLATES


def templates(vault: Path) -> list[dict]:
    """The templates a document can be made from: the built-in ones, then the vault's own (each
    folder of templates/, with how many files it has and the engine it names, if any)."""
    out = [{"name": name, "builtIn": True} for name in BUILT_IN]
    d = templates_dir(vault)
    for p in sorted(d.iterdir(), key=lambda x: x.name) if d.is_dir() else []:
        if not p.is_dir() or p.is_symlink() or not TEMPLATE_NAME.match(p.name) or p.name in BUILT_IN:
            continue
        files = [f for f in p.rglob("*") if f.is_file() and f.name != ".DS_Store" and f.relative_to(p).as_posix() != TEMPLATE_SETTINGS]
        try:
            said = json.loads((p / TEMPLATE_SETTINGS).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            said = {}
        engine = said.get("engine") if isinstance(said, dict) and said.get("engine") in rft_manuscript.ENGINES else None
        out.append({"name": p.name, "builtIn": False, "files": len(files), **({"engine": engine} if engine else {})})
    return out


def template_name(raw: object) -> str:
    """A template's name made from a zip's or a folder's: its extension dropped, what a folder's
    name may not hold made a dash."""
    name = re.sub(r"\.zip$", "", str(raw or "").strip().replace("\\", "/").rstrip("/").split("/")[-1], flags=re.I)
    return re.sub(r"-{2,}", "-", re.sub(r"[^A-Za-z0-9._-]+", "-", name)).strip("-.")[:60]


def _entry_problem(name: str, info: zipfile.ZipInfo) -> str:
    """Why an entry of a zip makes the whole zip refused; '' when it does not."""
    if stat.S_ISLNK(info.external_attr >> 16):
        return f"{name} is a link, and a template holds files only"
    parts = name.split("/")
    if name.startswith("/") or "\\" in name or re.match(r"^[A-Za-z]:", name) or ".." in parts:
        return f"{name} would be written outside the template's folder"
    if any(not p or p == "." or p != p.strip() or len(p) > MAX_NAME or any(ord(c) < 32 for c in p) for p in parts):
        return f"{name} is not a name a file can have here"
    return ""


def load_template(vault: Path, name: object, data: bytes) -> Answer:
    """A template loaded from a zip: kept as templates/<name>/, and offered from then on. A zip
    whose files are all in one top folder is unwrapped. Refused, with nothing written: a name
    that is taken (another is asked for), an entry that is a link or that would be written outside
    the folder, and a template over MAX_TEMPLATE unpacked or MAX_TEMPLATE_FILES files. What a
    file manager or git leaves in a zip (__MACOSX, .DS_Store, .git) is left out."""
    vault = Path(vault)
    if not isinstance(name, str) or not TEMPLATE_NAME.match(name) or len(name) > 60:
        return 400, {"error": "a template's name is letters, digits, dots and dashes, e.g. icml2027", "ask": "name"}
    if name in BUILT_IN:
        return 409, {"error": f"{name} is a built-in template: give this one another name", "ask": "name"}
    target = templates_dir(vault) / name
    if target.exists() or target.is_symlink():
        return 409, {"error": f"there is already a template {name}: give this one another name (nothing is overwritten)", "ask": "name"}
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, ValueError):
        return 400, {"error": "that file is not a zip"}
    with z:
        entries: list[tuple[zipfile.ZipInfo, list[str]]] = []
        for info in z.infolist():
            if info.is_dir():
                continue
            parts = info.filename.split("/")
            if "__MACOSX" in parts or parts[-1] == ".DS_Store" or ".git" in parts[:-1]:
                continue
            why = _entry_problem(info.filename, info)
            if why:
                return 422, {"error": f"{why}: the zip was refused and nothing was written"}
            entries.append((info, parts))
        if not entries:
            return 400, {"error": "the zip holds no file"}
        if len({parts[0] for _, parts in entries}) == 1 and all(len(parts) > 1 for _, parts in entries):
            entries = [(info, parts[1:]) for info, parts in entries]  # one top folder: unwrapped
        total = sum(info.file_size for info, _ in entries)
        if total > MAX_TEMPLATE or len(entries) > MAX_TEMPLATE_FILES:
            return 413, {"error": f"the template is {megabytes(total)} in {len(entries)} files unpacked: a template is at most {megabytes(MAX_TEMPLATE)} and {MAX_TEMPLATE_FILES} files; nothing was written"}
        staging = templates_dir(vault) / f".loading-{name}-{os.getpid()}"
        try:
            if staging.exists():
                shutil.rmtree(staging)
            written = 0
            for info, parts in entries:
                with z.open(info) as f:
                    chunk = f.read(MAX_TEMPLATE - written + 1)  # what the entry really holds, whatever its header says
                written += len(chunk)
                if written > MAX_TEMPLATE:
                    raise ValueError(f"the template is over {megabytes(MAX_TEMPLATE)} unpacked")
                path = staging.joinpath(*parts)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(chunk)
            os.replace(staging, target)
        except (OSError, ValueError, zipfile.BadZipFile, RuntimeError) as err:
            shutil.rmtree(staging, ignore_errors=True)
            return 422, {"error": f"the zip could not be unpacked ({err}): nothing was written"}
    return 201, {"name": name, "files": len(entries)}


# ---------------------------------------------------------------- a document reused: duplicate, bring in, a template's files added

def _files(folder: Path) -> list[Path]:
    """Every file under a folder, in the order of their paths; a link, and what a linked folder holds, left out."""
    out: list[Path] = []

    def visit(d: Path) -> None:
        for p in sorted(d.iterdir(), key=lambda x: x.name):
            if p.is_symlink():
                continue
            if p.is_dir():
                visit(p)
            elif p.is_file():
                out.append(p)

    if folder.is_dir() and not folder.is_symlink():
        visit(folder)
    return out


def _copy_tree(source: Path, target: Path) -> int:
    """A folder's files copied as they are (links left out); how many."""
    n = 0
    for p in _files(source):
        rel = p.relative_to(source)
        (target / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(p, target / rel)
        n += 1
    return n


def duplicate(vault: Path, doc: str, name: object) -> Answer:
    """A second document made from a document: its files, and its tracking file as it is (its
    copies and values, its allowed occurrences, its main file, engine and template). Tied to
    nothing of the first from then on, connected to no remote and with no history; locked, as a
    new document is."""
    source = folder_of(vault, doc)
    if source is None:
        return 404, {"error": "no such document"}
    if not isinstance(name, str) or not rft_manuscript.DOC_RE.match(name):
        return 400, {"error": "a document's name is lowercase letters, digits and dashes, e.g. paper-resubmission"}
    target = rft_manuscript.documents_dir(vault) / name
    if target.exists() or tracking_path(vault, name).parent.exists():
        return 409, {"error": f"there is already a document {name}"}
    files, _ = rft_manuscript.document_texts(vault, doc)
    main, asked = rft_manuscript.main_of(files, rft_manuscript.read_tracking(vault, doc)["main"])
    try:
        n = _copy_tree(source, target)
        target.mkdir(parents=True, exist_ok=True)
        d = read_raw(vault, doc)
        if main and not asked:
            d["main"] = main  # a document from before its main file was recorded keeps reading the same file
        d.setdefault("copies", [])
        write_raw(vault, name, d)
    except OSError as err:
        shutil.rmtree(target, ignore_errors=True)
        shutil.rmtree(tracking_path(vault, name).parent, ignore_errors=True)
        return 400, {"error": f"{doc} could not be duplicated ({err.strerror or err})"}
    return 201, {"name": name, "from": doc, "files": n}


TAKES_A_FILE = re.compile(r"\\(includegraphics|input|include|subfile|bibliography|addbibresource|lstinputlisting|includepdf|includesvg)\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]+)\}")
LABEL = re.compile(r"\\label\{([^}]*)\}")
ENDINGS = ("", ".tex", ".bib", ".pdf", ".png", ".jpg", ".jpeg", ".eps", ".svg")


def _lines(text: str):
    """A text's lines, comments left out, with their numbers from 1."""
    return ((i, rft_manuscript.uncommented(line)) for i, line in enumerate(text.split("\n"), 1))


def bring_in(vault: Path, doc: str, source: object, into: object) -> Answer:
    """A document's files copied into a new folder of another document, once: a paper becomes a
    chapter of a thesis by papers. Its tracking is carried under the new paths (its copies and
    values keep their states; a figure's file is found in that folder). Nothing is rewritten: the
    answer says what remains for the user (`main`: the brought-in main file, whose body the
    receiving document is to take in; `paths`: the lines of the brought files that name a file of
    theirs, which is now read from the receiving document's top) and what clashes (`labels` and
    `keys` that both documents define, each with both places). The two documents are not tied
    afterwards, and the source is unchanged."""
    here = folder_of(vault, doc)
    if here is None or not isinstance(source, str) or folder_of(vault, source) is None:
        return 404, {"error": "no such document"}
    if source == doc:
        return 400, {"error": "a document is not brought into itself: duplicate it, then bring the duplicate in"}
    got = _target(vault, doc, into)
    if not isinstance(got[0], Path):
        return got
    _, folder, target = got
    if target.exists() or target.is_symlink():
        return 409, {"error": f"{doc} already has {folder}: bring {source} into a folder that is not there yet"}
    there = folder_of(vault, source)
    theirs, _ = rft_manuscript.document_texts(vault, source)
    mine, _ = rft_manuscript.document_texts(vault, doc)
    tracked = rft_manuscript.read_tracking(vault, source)
    main, asked = rft_manuscript.main_of(theirs, tracked["main"])
    # what clashes, said before anything is merged: labels and .bib keys both documents define
    tex = lambda files: sorted(f for f in files if rft_manuscript.TEX_FILE.search(f))  # noqa: E731
    places = lambda files, prefix="": {  # noqa: E731
        label: [f"{prefix}{f}:{i}" for f in tex(files) for i, line in _lines(files[f]) if label in LABEL.findall(line)]
        for label in dict.fromkeys(m for f in tex(files) for _, line in _lines(files[f]) for m in LABEL.findall(line))}
    here_labels, their_labels = places(mine), places(theirs, f"{folder}/")
    labels = [{"label": k, "here": here_labels[k], "brought": their_labels[k]} for k in their_labels if k in here_labels]
    bibs = lambda files, prefix="": {k: f"{prefix}{f}" for f in sorted(files) if f.lower().endswith(".bib") for k in rft_manuscript.bib_keys(files[f])}  # noqa: E731
    here_keys, their_keys = bibs(mine), bibs(theirs, f"{folder}/")
    keys = [{"key": k, "here": here_keys[k], "brought": their_keys[k]} for k in their_keys if k in here_keys]
    # the lines that name a file of the brought document: read from the receiving document's top from now on
    names = {p.relative_to(there).as_posix() for p in _files(there)}
    base = main.rsplit("/", 1)[0] + "/" if "/" in main else ""
    paths = []
    for f in tex(theirs):
        for i, line in _lines(theirs[f]):
            for m in TAKES_A_FILE.finditer(line):
                for name in (x.strip() for x in m.group(2).split(",")):
                    if any(base + name + e in names for e in ENDINGS):
                        paths.append({"file": f"{folder}/{f}", "line": i, "command": m.group(1), "path": name, "to": f"{folder}/{base}{name}"})
    try:
        n = _copy_tree(there, target)
    except OSError as err:
        shutil.rmtree(target, ignore_errors=True)
        return 400, {"error": f"{source} could not be brought in ({err.strerror or err})"}
    # the receiving document keeps its main file: the brought one has a \\begin{document} too, and is not to be asked about
    my_main, my_asked = rft_manuscript.main_of(mine, rft_manuscript.read_tracking(vault, doc)["main"])
    # the tracking carried: every path under the new folder; an entry both track keeps the receiving document's, with the brought .bib too
    raw, d = read_raw(vault, source), read_raw(vault, doc)
    under = lambda path: f"{folder}/{path}" if isinstance(path, str) and path else path  # noqa: E731
    d.setdefault("copies", []).extend({**c, "file": under(c.get("file"))} for c in raw.get("copies") or [] if isinstance(c, dict))
    for v in raw.get("values") or []:
        if isinstance(v, dict):
            v = {**v, "file": under(v.get("file"))}
            if v.get("kind") == "figure":
                v["base"] = f"{folder}/{v['base']}" if v.get("base") else folder
            d.setdefault("values", []).append(v)
    for key, e in (raw.get("bib") or {}).items() if isinstance(raw.get("bib"), dict) else []:
        if not isinstance(e, dict):
            continue
        files = [under(e.get("file")), *(under(x) for x in e.get("also") or [])]
        had = d.setdefault("bib", {}).get(key)
        if isinstance(had, dict):
            had["also"] = list(dict.fromkeys([*(had.get("also") or []), *files]))
        else:
            d["bib"][key] = {"from": e.get("from"), "file": files[0], **({"also": files[1:]} if files[1:] else {})}
    d.setdefault("allowed", []).extend({**a, "file": under(a.get("file"))} for a in raw.get("allowed") or [] if isinstance(a, dict))
    if isinstance(raw.get("bibOf"), dict):
        d["bibOf"] = {**(d.get("bibOf") if isinstance(d.get("bibOf"), dict) else {}), **{under(k): under(v) for k, v in raw["bibOf"].items()}}
    if my_main and not my_asked:
        d["main"] = my_main
    write_raw(vault, doc, d)
    return 201, {"doc": doc, "from": source, "into": folder, "files": n, "copies": len(raw.get("copies") or []),
                 "main": f"{folder}/{main}" if main and not asked else None, "paths": paths, "labels": labels, "keys": keys}


def add_template(vault: Path, doc: str, template: object) -> Answer:
    """A template's files added to a document that has its own: every file whose path the
    document does not have is copied in (`added`); one whose path exists is skipped and named
    (`skipped`), never overwritten. The settings file is not copied, and nothing in the document
    is changed: its preamble is the user's to rewrite for the new class or style."""
    folder = folder_of(vault, doc)
    if folder is None:
        return 404, {"error": "no such document"}
    if template in BUILT_IN:
        return 400, {"error": f"the built-in template {template} is a main file and an empty .bib, which {doc} has: there is nothing to add"}
    if not isinstance(template, str) or not TEMPLATE_NAME.match(template):
        return 404, {"error": "no such template"}
    source = templates_dir(vault) / template
    if not source.is_dir() or source.is_symlink():
        return 404, {"error": f"no template {template}"}
    added, skipped = [], []
    for p in _files(source):
        rel = p.relative_to(source).as_posix()
        if rel == TEMPLATE_SETTINGS or p.name == ".DS_Store":
            continue
        target = inside(folder, rel)
        if target is None:
            skipped.append(rel)
            continue
        if target.exists() or target.is_symlink():
            skipped.append(rel)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(p, target)
        added.append(rel)
    return 200, {"doc": doc, "template": template, "added": added, "skipped": skipped}
