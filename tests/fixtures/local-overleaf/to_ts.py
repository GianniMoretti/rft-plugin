"""The local-overleaf fixture as a module the plugin's tests can import (they load code only):
every file of the small project, by its path, what readers must yield and the scan's cases, copied into
tests/fixtures/local-overleaf.ts. tests/test_clean_source.py fails when the copy is behind; run
this file to write it again.

    python3 tests/fixtures/local-overleaf/to_ts.py
"""
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "local-overleaf.ts"
BINARY = {".pdf", ".png", ".jpg"}


def module() -> str:
    root = HERE / "project"
    files = {}
    for p in sorted(root.rglob("*")):
        if p.is_file():
            # a binary file is only ever copied and compared by the plugin's side: a stand-in for its bytes is enough
            files[p.relative_to(root).as_posix()] = f"%PDF stand-in {hashlib.sha1(p.read_bytes()).hexdigest()[:12]}\n" if p.suffix in BINARY else p.read_text(encoding="utf-8")
    want = json.loads((HERE / "expected.json").read_text(encoding="utf-8"))
    traces = json.loads((HERE / "traces.json").read_text(encoding="utf-8"))
    first = {"expected": json.loads((HERE / "first-design" / "expected.json").read_text(encoding="utf-8"))}
    for part in ("before", "after"):
        folder = HERE / "first-design" / part
        first[part] = {q.relative_to(folder).as_posix(): f"%PDF stand-in {hashlib.sha1(q.read_bytes()).hexdigest()[:12]}\n" if q.suffix in BINARY else q.read_text(encoding="utf-8")
                       for q in sorted(folder.rglob("*")) if q.is_file()} if folder.is_dir() else {}
    built = {t.name: {q.relative_to(t).as_posix(): q.read_text(encoding="utf-8") for q in sorted(t.rglob("*")) if q.is_file()} for t in sorted((HERE / "built-in").iterdir()) if t.is_dir()}
    return ("// Copied from tests/fixtures/local-overleaf/ by tests/fixtures/local-overleaf/to_ts.py: edit those files, then run it.\n"
            f"export const FILES: Record<string, string> = {json.dumps(files, indent=1, ensure_ascii=False)}\n"
            f"export const EXPECTED = {json.dumps(want, indent=1, ensure_ascii=False)}\n"
            f"export const TRACES = {json.dumps(traces, indent=1, ensure_ascii=False)}\n"
            "// the built-in templates' files, made with the title \"Small data & more\": what a new document from each holds (the server's tests compile them)\n"
            f"export const BUILT_IN: Record<string, Record<string, string>> = {json.dumps(built, indent=1, ensure_ascii=False)}\n"
            "// the same document as the first design had it (before), and as its conversion must leave it (after: its folder, and tracking.json)\n"
            f"export const FIRST_DESIGN: {{ before: Record<string, string>; after: Record<string, string>; expected: {{ copies: {{ snippet: string; state: string }}[] }} }} = {json.dumps(first, indent=1, ensure_ascii=False)}\n")


if __name__ == "__main__":
    OUT.write_text(module(), encoding="utf-8")
    print(f"wrote {OUT}")
