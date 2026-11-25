"""The agents fixture as a module the plugin's tests can import (they load code only): the cases,
copied into tests/fixtures/agents.ts; and the same cases as a page to read, SCENARIOS.md, beside
them. tests/test_agents.py fails when either copy is behind; run this file to write them again.

    python3 tests/fixtures/agents/to_ts.py
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "agents.ts"
PAGE = HERE / "SCENARIOS.md"


def cases() -> dict:
    return json.loads((HERE / "cases.json").read_text(encoding="utf-8"))


def module() -> str:
    return ("// Copied from tests/fixtures/agents/ by tests/fixtures/agents/to_ts.py: edit cases.json, then run it.\n"
            f"export const CASES = {json.dumps(cases(), indent=1)}\n")


def fence(text: str) -> str:
    ticks = "````" if "```" in text else "```"
    text = text.replace("\r", "␍")  # a carriage return, shown: a file read back would lose it
    return f"{ticks}\n{text}{'' if text.endswith(chr(10)) else chr(10)}{ticks}\n"


def short(text: str, most: int = 900) -> str:
    return text if len(text) <= most else f"{text[:most]}\n… ({len(text)} characters in all)"


def page() -> str:
    """The cases in words: what an agent answered, and what the app makes of it."""
    d = cases()
    out = ["# Agents: what an agent's answer becomes, case by case", "",
           "Written from tests/fixtures/agents/cases.json by to_ts.py: edit that file, not this one.", "",
           "Claude proposed these cases on 2026-11-25; the user has not read them yet.", "",
           "An agent answers with text and the app writes it. Each case gives the answer as it came and what",
           "must be in the vault afterwards. Both sides are held to them: the page's server",
           "(tests/test_agents.py) and the plugin (tests/agents.test.ts).", "",
           "## A thread", "",
           f"Every thread is on the sentence `{d['threads'][0]['thread']['quote']}` of the note {d['note']['id']}.",
           "The note itself is never changed by an answer: a new text waits for the user to accept it.", ""]
    for n, c in enumerate(d["threads"], 1):
        t, w = c["thread"], c["want"]
        kind = "a comment" if t["kind"] == "comment" else ("a suggestion with no new text yet" if t["replacement"] is None else f"a suggestion with the new text `{t['replacement']}`")
        out += [f"### T{n}. {c['name']}", "", f"The thread is {kind}" + ("" if t["state"] == "open" else f", {t['state']}") + ". The agent answers:", "", fence(c["answer"])]
        if w is None:
            out += ["Nothing is written, and the page says the thread was not answered.", ""]
            continue
        said = w["messages"][len(t["messages"]):]
        out += ["- The thread's new text: " + ("unchanged" if w["replacement"] == t["replacement"] else f"`{json.dumps(w['replacement'], ensure_ascii=False)}`, for the user to accept or reject"),
                "- Added to the thread: " + (f"`{json.dumps(said[0]['text'], ensure_ascii=False)}`" if said else "no message"), ""]
    out += ["## Process", "",
            "The agent is asked for its impression between `<impression>` and `</impression>` and its brief",
            "between `<brief>` and `</brief>`, or for `<unreadable>why</unreadable>` when it could not read the item.",
            "Either both are saved or nothing is.", ""]
    for n, c in enumerate(d["process"], 1):
        w = c["want"]
        out += [f"### P{n}. {c['name']}", "", "The agent answers:", "", fence(short(c["answer"]))]
        if "error" in w:
            out += [f"Nothing is saved. The item shows why, in words that hold: `{w['error']}`", ""]
        else:
            out += ["Saved as the impression, in the item's reading note:", "", fence("\n".join(w["impression"])),
                    "Saved as the brief, under the item in the inbox:", "", fence("\n".join(w["brief"]))]
    return "\n".join(out).rstrip("\n") + "\n"


if __name__ == "__main__":
    OUT.write_text(module(), encoding="utf-8")
    PAGE.write_text(page(), encoding="utf-8")
    print(f"wrote {OUT} and {PAGE}")
