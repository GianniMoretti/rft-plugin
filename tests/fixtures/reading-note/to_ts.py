"""The reading note fixture as a module the plugin's tests can import (they load code only): the
cases and the three scenarios, copied into tests/fixtures/reading-note.ts. tests/test_reading.py
fails when the copy is behind; run this file to write it again.

    python3 tests/fixtures/reading-note/to_ts.py
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "reading-note.ts"


def module() -> str:
    cases = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))
    scenarios = json.loads((HERE / "scenarios.json").read_text(encoding="utf-8"))
    return ("// Copied from tests/fixtures/reading-note/ by tests/fixtures/reading-note/to_ts.py: edit those files, then run it.\n"
            f"export const CASES = {json.dumps(cases, indent=1)}\n"
            f"export const SCENARIOS = {json.dumps(scenarios, indent=1)}\n")


if __name__ == "__main__":
    OUT.write_text(module(), encoding="utf-8")
    print(f"wrote {OUT}")
