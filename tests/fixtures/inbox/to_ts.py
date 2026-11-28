"""The inbox fixture as a module the plugin's tests can import (they load code only): the file,
the items it should yield and the cases, copied into tests/fixtures/inbox.ts. tests/test_inbox.py
fails when the copy is behind; run this file to write it again.

    python3 tests/fixtures/inbox/to_ts.py
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "inbox.ts"


def module() -> str:
    text = (HERE / "Inbox.md").read_text(encoding="utf-8")
    want = json.loads((HERE / "expected.json").read_text(encoding="utf-8"))
    cases = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))
    return ("// Copied from tests/fixtures/inbox/ by tests/fixtures/inbox/to_ts.py: edit those files, then run it.\n"
            f"export const INBOX_MD: string = {json.dumps(text)}\n"
            f"export const EXPECTED = {json.dumps(want, indent=1)}\n"
            f"export const CASES = {json.dumps(cases, indent=1)}\n")


if __name__ == "__main__":
    OUT.write_text(module(), encoding="utf-8")
    print(f"wrote {OUT}")
