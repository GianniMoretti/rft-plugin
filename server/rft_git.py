"""A document as a git repository of its own (docs/design/manuscript.md), so that it can be shared
through GitHub and, from there, with Overleaf. Standard library only; git is run as a program.

- **Where**: the document's folder (documents/<name>/) is the work tree, and its git data is kept
  among the plugin's files, in documents/.rft/<name>/git/. The folder holds no `.git`: the vault's
  own history keeps the document's files as ordinary files, and a `.gitignore` in the git data
  keeps that out of the vault's history.
- **Who**: the user, from the page. The server runs git on the page's request; nothing here is a
  tool of the session's, and Claude running git against a document's repository is refused
  (hooks/lib/guards.ts). The remote is an address the user pastes, reached over their own SSH keys
  or credentials: the plugin creates no repository and stores no secret. Git never prompts
  (GIT_TERMINAL_PROMPT=0, ssh in batch mode): a remote that cannot be reached is an error said in
  the page, which blocks nothing else.
- **Push** records every change of the document with the message the user typed, and sends it.
  It is refused, with the reason and the place, when the scan finds a trace of the tree (so that
  no commit ever holds one: a trace recorded once would stay in the history), when the document
  is behind its remote, and while a conflict is unresolved.
- **Pull** fetches and merges. Changes not yet recorded are recorded first, under a message that
  says so (refused on a trace, as a push is). A conflict is left as git's own lines in the files,
  and compiling and pushing wait until they are gone; the next push records the merge.
- **A document from a repository**: the repository cloned as a new document, its files as they
  came.

    state    {repository, remote, branch, ahead, behind, changed, conflicts, merging, error?}
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rft_manuscript  # noqa: E402

GIT = "git"  # the folder of a document's git data, in documents/.rft/<name>/
REMOTE = "origin"
FETCH_S, PUSH_S, CLONE_S, LOCAL_S = 30, 120, 120, 30
MARKER = re.compile(r"^(<{7} |>{7} |={7}$|\|{7} )", re.M)
# an address git may be given: https, ssh (as a URL or as git@host:path), git, a file:// URL or an absolute path
ADDRESS = re.compile(r"^(?:(?:https?|ssh|git|file)://\S+|[\w.-]+@[\w.-]+:\S+|/\S.*)$")

Answer = tuple[int, dict]


def available() -> bool:
    return bool(shutil.which("git"))


def git_dir(vault: Path, doc: str) -> Path:
    return rft_manuscript.documents_dir(vault) / rft_manuscript.TRACKING / doc / GIT


def work_tree(vault: Path, doc: str) -> Path:
    return rft_manuscript.documents_dir(vault) / doc


def is_repository(vault: Path, doc: str) -> bool:
    return (git_dir(vault, doc) / "HEAD").is_file()


def run(vault: Path, doc: str, *args: str, timeout: float = LOCAL_S) -> subprocess.CompletedProcess:
    """git on a document's repository: its git data and its work tree named, never found by
    walking up from a folder. It never prompts, and its hooks are not run."""
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "true", "LC_ALL": "C", "GIT_OPTIONAL_LOCKS": "0",
           "GIT_SSH_COMMAND": os.environ.get("GIT_SSH_COMMAND") or "ssh -oBatchMode=yes -oConnectTimeout=15"}
    for k in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        env.pop(k, None)
    cmd = ["git", f"--git-dir={git_dir(vault, doc)}", f"--work-tree={work_tree(vault, doc)}", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never",
           "-c", "core.quotePath=false", *args]
    try:
        return subprocess.run(cmd, cwd=work_tree(vault, doc), env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(cmd, 124, "", f"git did not answer within {timeout:g} s")
    except OSError as err:
        return subprocess.CompletedProcess(cmd, 127, "", str(err))


def said(r: subprocess.CompletedProcess) -> str:
    """What git said went wrong, in a line or two."""
    lines = [line.strip() for line in (r.stderr or r.stdout or "").splitlines() if line.strip() and not line.startswith("hint:")]
    return " ".join(lines[-3:])[:400] or f"git exited with {r.returncode}"


def address_problem(url: object) -> str:
    """Why an address will not do as a remote; '' when it will."""
    if not isinstance(url, str) or not url.strip():
        return "give the repository's address (git@github.com:you/paper.git, or https://…)"
    u = url.strip()
    if len(u) > 500 or u.startswith("-") or any(ord(c) < 32 for c in u) or not ADDRESS.match(u):
        return "that is not a repository's address: git@github.com:you/paper.git, https://github.com/you/paper.git, or a path"
    return ""


def init(vault: Path, doc: str) -> str:
    """Makes the document a repository of its own, its git data outside its folder; '' or what went wrong."""
    if is_repository(vault, doc):
        return ""
    g = git_dir(vault, doc)
    g.mkdir(parents=True, exist_ok=True)
    r = run(vault, doc, "-c", "init.defaultBranch=main", "init", "--quiet")
    if r.returncode != 0:
        shutil.rmtree(g, ignore_errors=True)
        return said(r)
    run(vault, doc, "config", "--unset", "core.worktree")  # the work tree is named each time: the vault may move
    (g / ".gitignore").write_text("*\n", encoding="utf-8")  # the vault's own history keeps the document's files, not this
    return ""


def branch(vault: Path, doc: str) -> str:
    r = run(vault, doc, "symbolic-ref", "--short", "HEAD")
    return r.stdout.strip() if r.returncode == 0 else ""


def has_commits(vault: Path, doc: str, ref: str = "HEAD") -> bool:
    return run(vault, doc, "rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}").returncode == 0


def remote(vault: Path, doc: str) -> str:
    r = run(vault, doc, "config", "--get", f"remote.{REMOTE}.url")
    return r.stdout.strip() if r.returncode == 0 else ""


def changed(vault: Path, doc: str) -> list[str]:
    """The files changed, added or deleted since the last record."""
    r = run(vault, doc, "status", "--porcelain", "--untracked-files=all")
    return [line[3:].split(" -> ")[-1].strip('"') for line in r.stdout.splitlines() if line.strip()] if r.returncode == 0 else []


def conflicts(vault: Path, doc: str) -> list[str]:
    """The files of a document that still hold a conflict: left unmerged by a pull, and with
    git's own lines (<<<<<<<, =======, >>>>>>>) still in them."""
    if not is_repository(vault, doc):
        return []
    r = run(vault, doc, "diff", "--name-only", "--diff-filter=U")
    out = []
    for rel in dict.fromkeys(line.strip() for line in r.stdout.splitlines() if line.strip()) if r.returncode == 0 else []:
        path = work_tree(vault, doc) / rel
        try:
            text = path.read_bytes().decode("utf-8", errors="replace") if path.is_file() and not path.is_symlink() else ""
        except OSError:
            text = ""
        if MARKER.search(text) and re.search(r"^<{7} ", text, re.M) and re.search(r"^>{7} ", text, re.M):
            out.append(rel)
    return out


def merging(vault: Path, doc: str) -> bool:
    return (git_dir(vault, doc) / "MERGE_HEAD").is_file()


def fetch(vault: Path, doc: str) -> str:
    """Fetches the remote; '' or what went wrong."""
    if not remote(vault, doc):
        return ""
    r = run(vault, doc, "fetch", "--quiet", "--prune", REMOTE, timeout=FETCH_S)
    return "" if r.returncode == 0 else f"the remote could not be reached ({said(r)})"


def state(vault: Path, doc: str, fetching: bool = False) -> dict:
    """A document's repository as the page shows it: whether it is one, its remote, how far
    behind and ahead of it the document is, how many files changed since the last record, the
    files holding a conflict. `fetching`: ask the remote first; an error there is said, and the
    rest is as it was last known."""
    if not available():
        return {"repository": False, "error": "git is not on PATH: install git to share a document"}
    if not rft_manuscript.is_document(vault, doc):
        return {"repository": False, "error": "no such document"}
    if not is_repository(vault, doc):
        return {"repository": False, "remote": None}
    out: dict = {"repository": True, "remote": remote(vault, doc) or None, "branch": branch(vault, doc), "ahead": 0, "behind": 0}
    if fetching and out["remote"]:
        err = fetch(vault, doc)
        if err:
            out["error"] = err
    b = out["branch"]
    upstream = f"refs/remotes/{REMOTE}/{b}"
    here, there = has_commits(vault, doc), bool(b) and has_commits(vault, doc, upstream)
    if here and there:
        r = run(vault, doc, "rev-list", "--left-right", "--count", f"HEAD...{upstream}")
        if r.returncode == 0 and len(r.stdout.split()) == 2:
            out["ahead"], out["behind"] = (int(x) for x in r.stdout.split())
    elif here or there:
        r = run(vault, doc, "rev-list", "--count", "HEAD" if here else upstream)
        out["ahead" if here else "behind"] = int(r.stdout.strip() or 0) if r.returncode == 0 else 0
    out["changed"] = len(changed(vault, doc))
    out["conflicts"] = conflicts(vault, doc)
    out["merging"] = merging(vault, doc)
    return out


def connect(vault: Path, doc: str, url: object) -> Answer:
    """Connects a document to a remote by its address: the document becomes a repository if it
    is not one, the remote is named, and it is fetched. Nothing is recorded or sent."""
    if not available():
        return 503, {"error": "git is not on PATH: install git to share a document"}
    if not rft_manuscript.is_document(vault, doc):
        return 404, {"error": "no such document"}
    why = address_problem(url)
    if why:
        return 400, {"error": why}
    err = init(vault, doc)
    if err:
        return 500, {"error": f"the document could not be made a repository ({err})"}
    u = str(url).strip()
    r = run(vault, doc, "remote", "set-url" if remote(vault, doc) else "add", REMOTE, u)
    if r.returncode != 0:
        return 500, {"error": said(r)}
    # a document with nothing recorded yet takes the remote's own branch name, when the remote has one
    if not has_commits(vault, doc):
        head = run(vault, doc, "ls-remote", "--symref", REMOTE, "HEAD", timeout=FETCH_S)
        m = re.search(r"^ref: refs/heads/(\S+)\s+HEAD", head.stdout, re.M) if head.returncode == 0 else None
        if m:
            run(vault, doc, "symbolic-ref", "HEAD", f"refs/heads/{m.group(1)}")
    return 200, state(vault, doc, fetching=True)


def trace_words(traces: list[dict]) -> str:
    """The first traces of a scan, each with its place, as a refusal says them."""
    shown = [f"{t['file']}{'' if t.get('line') is None else ':' + str(t['line'])} ({t['match']})" for t in traces[:5]]
    return ", ".join(shown) + (f" and {len(traces) - 5} more" if len(traces) > 5 else "")


def record(vault: Path, doc: str, message: str) -> str:
    """Records every change of the document as one commit; '' or what went wrong. Nothing to
    record (and no merge to conclude) is not an error."""
    r = run(vault, doc, "add", "--all")
    if r.returncode != 0:
        return said(r)
    if not changed(vault, doc) and not merging(vault, doc):
        return ""
    r = run(vault, doc, "commit", "--quiet", "--no-verify", "-m", message)
    if r.returncode != 0:
        if "tell me who you are" in (r.stderr or "") or "user.email" in (r.stderr or ""):
            return "git does not know who you are: run git config --global user.name \"Your Name\" and git config --global user.email you@example.org once, then try again"
        return said(r)
    return ""


def push(vault: Path, doc: str, message: object, traces: list[dict]) -> Answer:
    """Records all and sends. Refused, with the reason and the place: on a trace of the tree, when
    the document is behind its remote, while a conflict is unresolved."""
    if not is_repository(vault, doc) or not remote(vault, doc):
        return 409, {"error": f"{doc} is connected to no repository yet: connect it first"}
    if not isinstance(message, str) or not message.strip() or len(message) > 2000:
        return 400, {"error": "say what changed: the message the push is recorded with"}
    bad = conflicts(vault, doc)
    if bad:
        return 409, {"error": f"{', '.join(bad)} still {'holds' if len(bad) == 1 else 'hold'} a conflict (the lines git wrote, <<<<<<< to >>>>>>>): resolve {'it' if len(bad) == 1 else 'them'} in the editor first", "conflicts": bad}
    if traces:
        return 422, {"error": f"the document holds {len(traces)} trace{'s' if len(traces) != 1 else ''} of your tree, which a push would share: {trace_words(traces)}. Remove {'them' if len(traces) != 1 else 'it'}, or allow a false alarm (Traces of the tree, in the list)",
                     "traces": traces[:40]}
    err = fetch(vault, doc)
    if err:
        return 502, {"error": err}
    st = state(vault, doc)
    if st["behind"] and not st["merging"]:
        return 409, {"error": f"{doc} is behind its remote by {st['behind']} commit{'s' if st['behind'] != 1 else ''}: pull first", "pull": True, "behind": st["behind"]}
    err = record(vault, doc, message.strip())
    if err:
        return 500, {"error": f"the changes could not be recorded ({err})"}
    if not has_commits(vault, doc):
        return 409, {"error": f"{doc} has nothing to send yet"}
    r = run(vault, doc, "push", "--quiet", "--set-upstream", REMOTE, "HEAD", timeout=PUSH_S)
    if r.returncode != 0:
        return 502, {"error": f"recorded, but not sent ({said(r)})", **state(vault, doc)}
    return 200, state(vault, doc, fetching=True)


def pull(vault: Path, doc: str, traces: list[dict]) -> Answer:
    """Fetches and merges the remote's changes. What was not recorded yet is recorded first
    (refused on a trace, as a push is). A conflict is left in the files as git's own lines."""
    if not is_repository(vault, doc) or not remote(vault, doc):
        return 409, {"error": f"{doc} is connected to no repository yet: connect it first"}
    bad = conflicts(vault, doc)
    if bad:
        return 409, {"error": f"{', '.join(bad)} still {'holds' if len(bad) == 1 else 'hold'} a conflict from the last pull: resolve {'it' if len(bad) == 1 else 'them'} in the editor, then push", "conflicts": bad}
    err = fetch(vault, doc)
    if err:
        return 502, {"error": err}
    b = branch(vault, doc)
    upstream = f"refs/remotes/{REMOTE}/{b}"
    if not has_commits(vault, doc, upstream):
        return 200, {**state(vault, doc), "pulled": 0, "note": "the remote has nothing yet"}
    pending = bool(changed(vault, doc)) or merging(vault, doc)
    if pending and traces:
        return 422, {"error": f"a pull first records your changes, and the document holds {len(traces)} trace{'s' if len(traces) != 1 else ''} of your tree, which would stay in its history: {trace_words(traces)}. Remove {'them' if len(traces) != 1 else 'it'}, or allow a false alarm, then pull",
                     "traces": traces[:40]}
    if pending:
        err = record(vault, doc, f"Changes before a pull, {time.strftime('%Y-%m-%d %H:%M')}")
        if err:
            return 500, {"error": f"your changes could not be recorded before the pull ({err})"}
    before = state(vault, doc)["behind"]
    if has_commits(vault, doc):
        r = run(vault, doc, "merge", "--no-edit", "--allow-unrelated-histories", upstream, timeout=PUSH_S)
    else:
        r = run(vault, doc, "reset", "--quiet", "--hard", upstream)  # nothing of its own recorded and nothing in its folder to lose
    st = state(vault, doc)
    if r.returncode != 0 and not st["conflicts"] and not st["merging"]:
        return 500, {"error": f"the pull could not be merged ({said(r)})", **st}
    return 200, {**st, "pulled": before}


def clone(vault: Path, name: str, url: object) -> Answer:
    """A new document from a repository: cloned into documents/<name>/, its git data kept apart
    as every document's is. A name that is taken or an address that cannot be reached makes nothing."""
    if not available():
        return 503, {"error": "git is not on PATH: install git to share a document"}
    if not isinstance(name, str) or not rft_manuscript.DOC_RE.match(name):
        return 400, {"error": "a document's name is lowercase letters, digits and dashes, e.g. paper or thesis-ch3"}
    why = address_problem(url)
    if why:
        return 400, {"error": why}
    folder, g = work_tree(vault, name), git_dir(vault, name)
    if folder.exists() or g.parent.exists():
        return 409, {"error": f"there is already a document {name}"}
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "true", "LC_ALL": "C",
           "GIT_SSH_COMMAND": os.environ.get("GIT_SSH_COMMAND") or "ssh -oBatchMode=yes -oConnectTimeout=15"}
    for k in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        env.pop(k, None)
    g.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["git", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never", "clone", "--quiet", f"--separate-git-dir={g}", "--", str(url).strip(), str(folder)]
    try:
        r = subprocess.run(cmd, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, errors="replace", timeout=CLONE_S)
    except subprocess.TimeoutExpired:
        r = subprocess.CompletedProcess(cmd, 124, "", f"git did not answer within {CLONE_S} s")
    except OSError as err:
        r = subprocess.CompletedProcess(cmd, 127, "", str(err))
    if r.returncode != 0:
        shutil.rmtree(folder, ignore_errors=True)
        shutil.rmtree(g.parent, ignore_errors=True)
        return 502, {"error": f"the repository could not be cloned ({said(r)}): nothing was made"}
    # the folder holds no .git: the git data is named each time
    link = folder / ".git"
    if link.is_file():
        link.unlink()
    run(vault, name, "config", "--unset", "core.worktree")
    (g / ".gitignore").write_text("*\n", encoding="utf-8")
    return 201, {"name": name}
