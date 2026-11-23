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
    return ("// Copied from tests/fixtures/local-overleaf/ by tests/fixtures/local-overleaf/to_ts.py: edit those files, then run it.\n"
            f"export const FILES: Record<string, string> = {json.dumps(files, indent=1, ensure_ascii=False)}\n"
            f"export const EXPECTED = {json.dumps(want, indent=1, ensure_ascii=False)}\n"
            f"export const TRACES = {json.dumps(traces, indent=1, ensure_ascii=False)}\n")


if __name__ == "__main__":
    OUT.write_text(module(), encoding="utf-8")
    print(f"wrote {OUT}")
