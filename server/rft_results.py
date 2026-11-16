"""What an experiment notebook's run leaves in the vault, at no model turn. Standard library only.

A notebook (server/rft_notebook.py runs it) hands back RESULTS, the numbers the experiment's note
reports, and may hand back FIGURES and TABLES. `apply` takes that run to the vault:

- **Checked**: each number of RESULTS against the note's Result, at the precision the Result
  writes it (as checkResults did in hooks/lib/notebooks.ts): ok, differs, failed or unchecked.
- **Recorded**: the numbers written into the note's Result as a table between two comment lines
  (BLOCK_BEGIN … BLOCK_END), with where they come from: the notebook, its commit, the queue's runs
  of the experiment and theirs. A run records when asked (`record`: the runner, once an
  experiment's jobs end, and rft_run_notebook with record: true), or when nothing would be lost:
  the Result has no table yet and writes no number. A locked note is left as it is. So Claude
  never copies a number into a note: it writes what they mean around them.
- **Saved**, when the numbers are recorded or check ok (so what the vault shows is what the note
  says): RESULTS as results/<id>.json; each figure as figures/<id>_<name>.svg, which a concept's
  artifact names as ../figures/<file>; each table as tables/<id>_<name>.html, which an artifact
  takes in with <rft-table src="<id>_<name>"></rft-table> (filled in here, and when the artifact
  is written: hooks/lib/artifacts.ts).
- **Stamped**: the note's `reproduced:` line, the run's date, state, commit and time.

    python3 rft_notebook.py apply --vault V --exp E08 [--record]   (runs the notebook, then this)
"""
from __future__ import annotations

import html
import json
import math
import os
import re
from pathlib import Path

import rft_queue  # beside this file: the runs of the experiment, from the queue's history

RESULTS_DIR = "results"
FIGURES_DIR = "figures"
TABLES_DIR = "tables"
ARTIFACTS_DIR = "artifacts"
SUBDIRS = ("experiments", "directions", "references", "theory")
BLOCK_BEGIN = "<!-- rft-results: the notebook's RESULTS, written by its run; rft_run_notebook rewrites it -->"
BLOCK_END = "<!-- /rft-results -->"
BLOCK_RE = re.compile(r"^<!-- rft-results\b.*?-->[ \t]*\n.*?^<!-- /rft-results -->[ \t]*$", re.M | re.S)
FENCE_RE = re.compile(r"^\s*(```|~~~)")
TABLE_TAG = re.compile(r'(<rft-table\s+src\s*=\s*["\']([^"\']+)["\']\s*>)(.*?)(</rft-table>)', re.S | re.I)
# a number in prose, as NUMBER in hooks/lib/notebooks.ts reads it (JavaScript's \w and \d: ASCII)
NUMBER = re.compile(r"(?<![\w.])([-−]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:[eE]([-+]?\d+))?(?![\w.]*\d)", re.A)
MAX_FIGURE = 10_000_000  # the largest SVG an artifact takes in
SHOWN_RUNS = 6


# ---------------------------------------------------------------- RESULTS against the Result

def numbers_in(text: str) -> list[tuple[float, float]]:
    """The numbers of a text, each with how close a value must be to read as it (half its last digit)."""
    out = []
    for m in NUMBER.finditer(text):
        frac, exp = m.group(3) or "", int(m.group(4) or 0)
        try:
            x = float(f"{'-' if m.group(1) else ''}{m.group(2).replace(',', '')}{'.' + frac if frac else ''}e{exp}")
        except (ValueError, OverflowError):
            continue
        if math.isfinite(x):
            out.append((x, 0.5 * 10 ** (exp - len(frac)) * (1 + 1e-9)))
    return out


def leaves(x, key: str = "", found: list | None = None, skipped: list | None = None):
    """The numbers of RESULTS by their path (`a.b`, `a[0]`), and the paths of what is not a number."""
    found = [] if found is None else found
    skipped = [] if skipped is None else skipped
    if isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x):
        found.append((key or "RESULTS", x))
    elif isinstance(x, list):
        for i, v in enumerate(x):
            leaves(v, f"{key}[{i}]", found, skipped)
    elif isinstance(x, dict):
        for k, v in x.items():
            leaves(v, f"{key}.{k}" if key else str(k), found, skipped)
    else:
        skipped.append(key or "RESULTS")
    return found, skipped


def check(results, text: str) -> tuple[list[dict], list[str]]:
    """Each number of RESULTS, and whether the text writes it (at the precision the text gives)."""
    found, skipped = leaves(results)
    nums = numbers_in(text)
    return [{"key": k, "value": v, "found": any(abs(v - x) <= tol for x, tol in nums)} for k, v in found], skipped


# ---------------------------------------------------------------- notes

def split_note(text: str) -> tuple[list[str] | None, str]:
    """The frontmatter's lines and the body; (None, text) when there is no frontmatter."""
    t = text.replace("\r\n", "\n")
    if not t.startswith("---\n"):
        return None, t
    end = t.find("\n---", 4)
    if end < 0:
        return None, t
    nl = t.find("\n", end + 4)
    return t[4:end].split("\n"), "" if nl < 0 else t[nl + 1:]


def join_note(head: list[str] | None, body: str) -> str:
    return body if head is None else "---\n" + "\n".join(head) + "\n---\n" + body


def unquote(v: str | None) -> str:
    v = (v or "").strip()
    return re.sub(r'^"(.*)"$', r"\1", re.sub(r"^'(.*)'$", r"\1", v)).strip()


def field(text: str, key: str) -> str:
    head, _ = split_note(text)
    for line in head or []:
        if line.startswith(key + ":"):
            return unquote(line[len(key) + 1:])
    return ""


def set_field(text: str, key: str, value: str, after: str | None = None) -> str:
    """A one-line frontmatter field set in place, else after `after` (or children:, or parent:), as setField in hooks/lib/vault.ts."""
    head, body = split_note(text)
    if head is None:
        return text
    line = f"{key}: {value}"
    at = next((i for i, l in enumerate(head) if l.startswith(key + ":")), None)
    if at is not None:
        head[at] = line
        head[at + 1:] = [l for l in head[at + 1:] if not l.startswith(key + ":")]
    else:
        pos = len(head)
        for a in [x for x in (after, "children", "parent") if x]:
            i = next((i for i, l in enumerate(head) if l.startswith(a + ":")), None)
            if i is not None:
                pos = i + 1
                break
        head.insert(pos, line)
    return join_note(head, body)


def _headings(lines: list[str]) -> list[int]:
    out, fenced = [], False
    for i, line in enumerate(lines):
        if FENCE_RE.match(line):
            fenced = not fenced
        if not fenced and line.startswith("## "):
            out.append(i)
    return out


def _section(lines: list[str], title: str) -> tuple[int, int] | None:
    heads = _headings(lines)
    start = next((i for i in heads if lines[i][3:].strip() == title), None)
    if start is None:
        return None
    return start, next((i for i in heads if i > start), len(lines))


def result_of(text: str) -> str:
    """The text of a note's `## Result` section, trimmed, as result_of in rft_server.py."""
    lines = split_note(text)[1].split("\n")
    at = _section(lines, "Result")
    return "\n".join(lines[at[0] + 1:at[1]]).strip() if at else ""


def with_block(text: str, block: str) -> str:
    """The note with `block` as the table at the top of its Result: in place of the one there, else
    first in the section (made before Directions found or the children list when there is none)."""
    head, body = split_note(text)
    lines = body.split("\n")
    at = _section(lines, "Result")
    if at is None:
        before = _section(lines, "Directions found") or _section(lines, "Children in the tree")
        where = before[0] if before else len(lines)
        lines[where:where] = ["## Result", block, ""]
        return join_note(head, "\n".join(lines))
    inner = "\n".join(lines[at[0] + 1:at[1]])
    if BLOCK_RE.search(inner):
        inner = BLOCK_RE.sub(lambda _m: block, inner, count=1)
    else:
        rest = inner.strip("\n")
        inner = block + ("\n\n" + rest if rest else "") + "\n"
    lines[at[0] + 1:at[1]] = (inner.rstrip("\n") + "\n").split("\n")
    return join_note(head, "\n".join(lines))


def note_path(vault: Path, exp: str) -> Path | None:
    """An experiment's note, by its id."""
    for sub in SUBDIRS:
        for f in sorted((vault / sub).glob(f"{exp} *.md")) + sorted((vault / sub).glob(f"{exp}.md")):
            return f
    return None


def write_atomic(path: Path, data: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    if isinstance(data, bytes):
        tmp.write_bytes(data)
    else:
        tmp.write_text(data, encoding="utf-8")
    os.replace(tmp, path)


# ---------------------------------------------------------------- what is written

def number_text(v) -> str:
    """A value as RESULTS gives it (the notebook rounds to what the note reports)."""
    return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)


def seconds_text(s) -> str | None:
    if not isinstance(s, (int, float)) or not math.isfinite(s):
        return None
    s = round(float(s), 1)
    return str(int(s)) if s.is_integer() else str(s)


def reproduced_line(date: str, state: str, commit: str | None, dirty: bool | None, seconds) -> str:
    """The `reproduced:` value, as reproducedLine in hooks/lib/vault.ts writes it."""
    sec = seconds_text(seconds)
    return f"{date} {state}" + (f" @{commit}{'+dirty' if dirty else ''}" if commit else "") + (f" in {sec} s" if sec is not None else "")


def runs_of(vault: Path, exp: str, only: list[str] | None = None) -> list[dict]:
    """The queue's runs of the experiment that ended well (its notebook's runs left out), oldest first."""
    try:
        hist = rft_queue.Queue(vault, probe=lambda: [], wake=lambda: None).history()
    except (rft_queue.QueueError, OSError):
        return []
    out = [j for j in hist if j.get("exp") == exp and j.get("state") == "done" and j.get("kind", "run") != "notebook"
           and (only is None or j["id"] in only)]
    return sorted(out, key=lambda j: (j.get("started") or 0, int(j["id"][1:]) if j["id"][1:].isdigit() else 0))


def provenance(outcome: dict, runs: list[dict], date: str, repo_rel: str | None) -> str:
    """Where the numbers come from, in a line: the notebook at its commit, and the runs it read."""
    nb = repo_rel or outcome.get("file") or "the notebook"
    at = f" at {outcome['commit']}{' with uncommitted changes' if outcome.get('dirty') else ''}" if outcome.get("commit") else ""
    parts = [f"From `{nb}`{at}, {date}"]
    if runs:
        ids = [j["id"] for j in runs]
        shown = ", ".join(ids) if len(ids) <= SHOWN_RUNS else f"{', '.join(ids[:SHOWN_RUNS])} and {len(ids) - SHOWN_RUNS} more"
        commits = sorted({f"{j['commit']}{'+patch' if j.get('patch') else ''}" for j in runs if j.get("commit")})
        parts.append(f"runs {shown}" + (f" (code {', '.join(commits)})" if commits else ""))
    return "; ".join(parts) + "."


def results_block(results, line: str) -> str:
    """The Result's table of RESULTS, between its comment lines."""
    found, skipped = leaves(results)
    rows = [(k, number_text(v)) for k, v in found]
    if skipped:
        flat = {}

        def walk(x, key=""):
            if isinstance(x, dict):
                for k, v in x.items():
                    walk(v, f"{key}.{k}" if key else str(k))
            elif isinstance(x, list):
                for i, v in enumerate(x):
                    walk(v, f"{key}[{i}]")
            else:
                flat[key or "RESULTS"] = x
        walk(results)
        rows = [(k, number_text(v)) for k, v in flat.items()]
    cell = lambda t: str(t).replace("|", "\\|").replace("\n", " ")  # noqa: E731
    return "\n".join([BLOCK_BEGIN, "| RESULTS | value |", "|---|---|", *[f"| {cell(k)} | {cell(v)} |" for k, v in rows],
                      "", f"*{line}*", BLOCK_END])


def slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", str(name).lower()).strip("_")[:40].rstrip("_")
    return s or "figure"


def table_html(caption: str, t: dict) -> str:
    """A table of the notebook (columns and rows) as the HTML an artifact takes in; numbers right-aligned by the page's style."""
    esc = lambda v: html.escape(number_text(v) if v is not None else "")  # noqa: E731
    head = "".join(f"<th>{html.escape(str(c))}</th>" for c in t.get("columns") or [])
    body = "\n".join("<tr>" + "".join(f"<td>{esc(v)}</td>" for v in row) + "</tr>" for row in t.get("rows") or [])
    return f"<table>\n<caption>{html.escape(caption)}</caption>\n<thead><tr>{head}</tr></thead>\n<tbody>\n{body}\n</tbody>\n</table>"


def fill_tables(page: str, tables: dict[str, str]) -> tuple[str, list[str]]:
    """Each <rft-table src="name"> of a page filled with that table, when it is one of `tables`; the page and the names filled."""
    filled: list[str] = []

    def one(m):
        name = m.group(2)
        if name not in tables:
            return m.group(0)
        filled.append(name)
        return f"{m.group(1)}\n{tables[name]}\n{m.group(4)}"
    return TABLE_TAG.sub(one, page), filled


def refresh_artifacts(vault: Path, tables: dict[str, str]) -> list[str]:
    """The artifacts whose <rft-table> names one of `tables`, filled again; their paths in the vault.
    The header (what the page was written from) is kept: a table is the note's numbers, not a new result."""
    out = []
    d = vault / ARTIFACTS_DIR
    for f in sorted(d.glob("*.html")) if d.is_dir() else []:
        try:
            text = f.read_text(encoding="utf-8")
        except OSError:
            continue
        new, filled = fill_tables(text, tables)
        if filled and new != text:
            write_atomic(f, new)
            out.append(f"{ARTIFACTS_DIR}/{f.name}")
    return out


def save(vault: Path, exp: str, outcome: dict, date: str, runs: list[dict]) -> tuple[dict, list[str]]:
    """RESULTS, the figures and the tables of a run, kept in the vault; what was saved, and what was not (why)."""
    notes: list[str] = []
    figures, tables = [], {}
    for name, svg in (outcome.get("figures") or {}).items():
        if not isinstance(svg, str) or "<svg" not in svg[:2000]:
            notes.append(f"figure {name!r}: not an SVG")
            continue
        if len(svg.encode()) > MAX_FIGURE:
            notes.append(f"figure {name!r}: larger than {MAX_FIGURE // 1_000_000} MB")
            continue
        file = f"{exp}_{slug(name)}.svg"
        write_atomic(vault / FIGURES_DIR / file, svg)
        figures.append(f"{FIGURES_DIR}/{file}")
    for name, t in (outcome.get("tables") or {}).items():
        if not isinstance(t, dict) or not isinstance(t.get("columns"), list):
            notes.append(f"table {name!r}: not a table")
            continue
        key = f"{exp}_{slug(name)}"
        tables[key] = table_html(str(name), t)
        write_atomic(vault / TABLES_DIR / f"{key}.html", tables[key] + "\n")
    notes.extend(f"{n}" for n in outcome.get("notes") or [])
    record = {"exp": exp, "date": date, "results": outcome.get("results"), "commit": outcome.get("commit"),
              "dirty": outcome.get("dirty"), "notebook": outcome.get("file"),
              "runs": [{"id": j["id"], "label": j.get("label") or "", "out": j.get("out"), "commit": j.get("commit"),
                        "patch": j.get("patch")} for j in runs],
              "figures": figures, "tables": [f"{TABLES_DIR}/{k}.html" for k in tables]}
    write_atomic(vault / RESULTS_DIR / f"{exp}.json", json.dumps(record, ensure_ascii=False, indent=1) + "\n")
    saved = {"results": f"{RESULTS_DIR}/{exp}.json", "figures": figures, "tables": sorted(tables),
             "artifacts": refresh_artifacts(vault, tables)}
    return saved, notes


# ---------------------------------------------------------------- the run, applied

def apply(vault, exp: str, outcome: dict, date: str, record: bool = False, runs: list[str] | None = None) -> dict:
    """A notebook's run (rft_notebook.run's answer) taken to the experiment's note and the vault:
    checked, recorded, saved and stamped, as the module's docstring says. The answer: the state,
    the checks, what was recorded and saved, and the notes of what was not."""
    vault = Path(vault)
    path = note_path(vault, exp)
    out = {k: outcome.get(k) for k in ("ok", "seconds", "commit", "dirty", "file", "error") if outcome.get(k) is not None}
    if path is None:
        return {**out, "ok": False, "state": "failed", "error": f"no note {exp} in the vault"}
    out["note"] = str(path.relative_to(vault))
    text = path.read_text(encoding="utf-8")
    locked = field(text, "locked").lower() in ("true", "yes")
    result = result_of(text)
    recorded = False
    if not outcome.get("ok"):
        state = "failed"
    elif outcome.get("results") is None:
        state, out["why"] = "unchecked", "no RESULTS"
    else:
        checks, skipped = check(outcome["results"], result)
        out["checks"], out["skipped"] = checks, skipped
        if not checks:
            state, out["why"] = "unchecked", "no number in RESULTS"
        else:
            has_block = bool(BLOCK_RE.search(result))
            if (record or (not has_block and not numbers_in(result))) and (locked and not numbers_in(result)):
                state, out["why"] = "unchecked", "locked"  # nothing to check against, and not ours to write
            elif record or (not has_block and not numbers_in(result)):
                if locked:
                    state, out["why"] = "ok" if all(c["found"] for c in checks) else "differs", "locked"
                else:
                    ran = runs_of(vault, exp, runs)
                    rel = None
                    if outcome.get("file"):
                        top = rft_queue.repo_of(Path(outcome["file"]).parent)
                        rel = os.path.relpath(outcome["file"], top) if top else None
                    text = with_block(text, results_block(outcome["results"], provenance(outcome, ran, date, rel)))
                    recorded, state = True, "ok"
                    out["checks"] = [{**c, "found": True} for c in checks]
            else:
                state = "ok" if all(c["found"] for c in checks) else "differs"
    out["state"], out["recorded"], out["locked"] = state, recorded, locked
    if state == "ok" and outcome.get("results") is not None:
        out["saved"], out["notes"] = save(vault, exp, outcome, date, runs_of(vault, exp, runs))
    stamp = reproduced_line(date, state, outcome.get("commit"), outcome.get("dirty"), outcome.get("seconds"))
    text = set_field(text, "reproduced", json.dumps(stamp), after="notebook")
    write_atomic(path, text)
    out["reproduced"] = stamp
    return out
