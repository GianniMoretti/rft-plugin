"""The reading note fixture as a module the plugin's tests can import (they load code only): the
cases and the three scenarios, copied into tests/fixtures/reading-note.ts; and the scenarios as a
page to read, SCENARIOS.md, beside them. tests/test_reading.py fails when either copy is behind;
run this file to write them again.

    python3 tests/fixtures/reading-note/to_ts.py
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "reading-note.ts"
PAGE = HERE / "SCENARIOS.md"

WHO = {"given": "Given", "user": "The user, on the page", "claude": "Claude, with `rft_inbox`"}


def module() -> str:
    cases = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))
    scenarios = json.loads((HERE / "scenarios.json").read_text(encoding="utf-8"))
    return ("// Copied from tests/fixtures/reading-note/ by tests/fixtures/reading-note/to_ts.py: edit those files, then run it.\n"
            f"export const CASES = {json.dumps(cases, indent=1)}\n"
            f"export const SCENARIOS = {json.dumps(scenarios, indent=1)}\n")


def fence(text: str) -> str:
    ticks = "````" if "```" in text else "```"
    return f"{ticks}markdown\n{text}{'' if text.endswith(chr(10)) else chr(10)}{ticks}\n"


def page() -> str:
    """The scenarios in words, each step with what is asked, what is answered and the files as they
    are after it: what the user reads to confirm the fixture."""
    scenarios = json.loads((HERE / "scenarios.json").read_text(encoding="utf-8"))
    out = ["# Reading notes: the three cases, step by step", "",
           "Written from tests/fixtures/reading-note/scenarios.json by to_ts.py: edit that file, not this one.", "",
           "Claude proposed these cases; the user tried the feature and read them on 2026-11-24 and asked for no change.",
           "Case C was written again on 2026-11-27, when a discard came to keep the item and its reading note",
           "(docs/adr/0007): it was \"a discard after quoting asks first\". The user has not read the new C yet.", "",
           "Each step says who acts and what happens, the call it is tested with, what the answer must say, and the",
           "files it changes, as they are after it. `{today}` is the day the test runs. A step of the user's is run",
           "against the page's server (tests/test_reading.py), a step of Claude's against the plugin's tool",
           "(tests/reading.test.ts); each starts from the files the step before it left. A \"given\" step is not",
           "run: it is what the user or Claude did outside the two (saving the link, writing a note of the tree).", ""]
    for name, scenario in scenarios.items():
        out += [f"## {scenario['title']}", ""]
        for n, step in enumerate(scenario["steps"]):
            out += [f"### {name}{n}. {WHO[step['who']]}", "", step["does"], ""]
            if "page" in step:
                call = step["page"]
                chat = {True: ", a chat connected", False: ", no chat connected"}.get(step.get("chat"), "")
                out += [f"- Asked: `{call['method']} {call['path']}` `{json.dumps(call['body'], ensure_ascii=False)}`{chat}",
                        f"- Answered: {step['status']}" + (f", with `{json.dumps(step['answer'], ensure_ascii=False)}`" if step.get("answer") else "")]
            if "tool" in step:
                short = {k: (v if len(str(v)) < 80 else f"{str(v)[:60]}…") for k, v in step["tool"].items()}
                out += [f"- Asked: `rft_inbox {json.dumps(short, ensure_ascii=False)}`"]
                out += [f"- The answer says: {json.dumps(s, ensure_ascii=False)}" for s in step.get("says", [])]
                out += [f"- The answer never says: {json.dumps(s, ensure_ascii=False)}" for s in step.get("never", [])]
            files = step.get("files") or {}
            if "page" in step or "tool" in step:
                out += ["- Files: " + ("none changes" if not files else "only these change")]
            out += [""]
            for path, text in files.items():
                out += [f"`{path}`" + (": no longer there" if text is None else ""), ""]
                if text is not None:
                    out += [fence(text)]
    return "\n".join(out).rstrip("\n") + "\n"


if __name__ == "__main__":
    OUT.write_text(module(), encoding="utf-8")
    PAGE.write_text(page(), encoding="utf-8")
    print(f"wrote {OUT} and {PAGE}")
