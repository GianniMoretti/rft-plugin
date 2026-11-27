#!/usr/bin/env python3
"""The five scenarios of a grilling (/rft-grill-me), each run headless on a fresh copy of the demo
project (examples/demo) and judged on the vault's files only: what was written, and when.

    python3 bench/grilling.py --list
        the scenarios: what each is, the messages its user sends and what is checked. No run.
    python3 bench/grilling.py --plugin . [--only NAME ...] [--model M] [--out report.json] [--keep DIR]
        runs them (all, or the ones named) and prints each check as passed or FAILED

A scenario (grilling.json) is a list of sessions, each a list of the user's messages: the command,
then scripted answers. A session is one `claude -p` kept open on a stream of messages, not one
process per message: the command only queues its prompt, which the plugin submits a moment later,
and a process given the command alone has ended by then. The vault is read after every message, so
"nothing is written before the proposal is confirmed" is seen, not inferred from the end state.

The checks read the notes' files and nothing else, but for one: whether a resumed grilling asks
again for what the note answers can only be read in its questions, so that check looks at the
titles of the questions of the reply and is marked (reply).

The scripted user allows no web search and no subagent, so the quick look for prior art does not
run, and has no dialog to confirm a deadline in, so every script says there is no milestone.
It costs tokens (a round of a grilling is about a dollar): it is not part of the tests, and is run
on request.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEMO = HERE.parent / "examples" / "demo"
TOOLS = "mcp__rft__*,Read,Grep,Glob,Edit,Write"
FOLDERS = ("directions", "experiments", "references", "theory", "milestones", "meetings")
SECTIONS = ("Hypothesis", "Scope", "Plan", "Referee", "Open questions")


# ---------------------------------------------------------------- the vault, as the checks read it

def snapshot(work: Path) -> dict[str, str]:
    """Every note of the vault: its path in the vault -> its text."""
    vault = work / "vault"
    return {str(p.relative_to(vault)): p.read_text(encoding="utf-8")
            for sub in FOLDERS if (vault / sub).is_dir() for p in sorted((vault / sub).glob("*.md"))}


def front(text: str) -> dict[str, str]:
    found = re.match(r"---\n(.*?)\n---\n", text, re.S)
    return dict(m.groups() for m in re.finditer(r"(?m)^([a-z_]+): *(.*)$", found.group(1))) if found else {}


def own(text: str) -> str:
    """A note without what the tools derive from the notes below it: its children, in the frontmatter and in the list under its last heading (links, or `- none yet`)."""
    text = re.sub(r"(?m)^(children|down): .*\n", "", text)
    return re.sub(r"## Children in the tree\n(?:- [^\n]*(?:\n|\Z))*", "## Children in the tree\n", text)


def section(text: str, heading: str) -> str:
    found = re.search(rf"(?m)^## {re.escape(heading)}[ \t]*\n(.*?)(?=^## |\Z)", text, re.S)
    return found.group(1).strip() if found else ""


def find(snap: dict[str, str], note: str) -> str:
    """The path of the note with this id."""
    return next(p for p in snap if Path(p).name.startswith(note + " "))


def added(before: dict[str, str], after: dict[str, str]) -> list[str]:
    return [p for p in after if p not in before]


def changed(before: dict[str, str], after: dict[str, str], derived: bool = False) -> list[str]:
    """The notes of `before` whose text differs in `after` (or that are gone); `derived`: a change of the children list alone counts too."""
    same = (lambda a, b: a == b) if derived else (lambda a, b: own(a) == own(b))
    return [p for p in before if p not in after or not same(before[p], after[p])]


def kind(text: str) -> str:
    f = front(text)
    return "literature" if f.get("type") == "reference" and "literature" in f.get("tags", "") else f.get("type", "?")


def parent(text: str) -> str:
    """The id of the note's parent."""
    found = re.match(r'"?\[\[([A-Z]\d+)', front(text).get("parent", ""))
    return found.group(1) if found else ""


def names(paths: list[str]) -> str:
    return ", ".join(Path(p).stem for p in paths) or "none"


def questions(reply: str) -> list[str]:
    """The titles of the numbered questions of a round, as a reply words them (Q1 - Title: …)."""
    return [m.group(1).strip(" *") for m in re.finditer(r"(?m)^\W*Q\d+\W+(.{3,90}?)(?:\*\*|:|\?|$)", reply)]


# ---------------------------------------------------------------- the checks, one list per scenario
# Each takes the snapshots (0: the start; i: after the i-th message, counted across sessions) and
# the replies (i - 1: to the i-th message), and yields (what is checked, whether it holds, what was seen).

def planned_experiment(s, replies):
    d05 = find(s[0], "D05")
    yield "round one only asks: no note changed, none added", not changed(s[0], s[1], True) and not added(s[0], s[1]), f"changed {names(changed(s[0], s[1], True))}; added {names(added(s[0], s[1]))}"
    for i in (2, 3):
        yield f"before the proposal is confirmed (message {i}), only D05 is written", set(changed(s[0], s[i])) <= {d05} and not added(s[0], s[i]), f"changed {names(changed(s[0], s[i]))}; added {names(added(s[0], s[i]))}"
    new = added(s[0], s[-1])
    yield "no second experiment: no experiment note was added", not [p for p in new if kind(s[-1][p]) == "experiment"], f"added {names(new)}"
    yield "no search was asked for: no literature note was added", not [p for p in new if kind(s[-1][p]) == "literature"], f"added {names(new)}"
    yield "D05 holds its Hypothesis and its Referee", all(section(s[-1][d05], h) for h in ("Hypothesis", "Referee")), f"sections with text: {[h for h in SECTIONS if section(s[-1][d05], h)]}"
    yield "D05 is still planned", front(s[-1][d05]).get("status") == "planned", front(s[-1][d05]).get("status")


def new_question(s, replies):
    yield "round one only asks: no note changed, none added", not changed(s[0], s[1], True) and not added(s[0], s[1]), f"changed {names(changed(s[0], s[1], True))}; added {names(added(s[0], s[1]))}"
    for i in (2, 3):
        new = added(s[0], s[i])
        yield f"before the proposal is confirmed (message {i}), the only new note is the grilled direction", len(new) <= 1 and all(kind(s[i][p]) == "direction" for p in new), f"added {names(new)}"
        yield f"before the proposal is confirmed (message {i}), no other note is changed", not changed(s[0], s[i]), f"changed {names(changed(s[0], s[i]))}"
    new = added(s[0], s[-1])
    grilled = [p for p in added(s[0], s[3])]
    yield "the grilled direction was created once round one agreed where it goes", len(grilled) == 1, f"added by message 3: {names(grilled)}"
    searches = [p for p in new if kind(s[-1][p]) == "literature"]
    yield "one literature note, at planned", len(searches) == 1 and front(s[-1][searches[0]]).get("status") == "planned", f"{names(searches)}: {[front(s[-1][p]).get('status') for p in searches]}"
    if grilled and searches:
        yield "the literature note sits under the grilled direction and says what it must answer", parent(s[-1][searches[0]]) == front(s[-1][grilled[0]]).get("id") and bool(section(s[-1][searches[0]], "Search")), f"parent {parent(s[-1][searches[0]])}; Search: {section(s[-1][searches[0]], 'Search')[:80]!r}"
        yield "the grilled direction is planned", front(s[-1][grilled[0]]).get("status") == "planned", front(s[-1][grilled[0]]).get("status")
    yield "no experiment was planned before the search is read", not [p for p in new if kind(s[-1][p]) == "experiment"], f"added {names(new)}"
    yield "no note of the tree before the grilling was changed", not changed(s[0], s[-1]), f"changed {names(changed(s[0], s[-1]))}"


def already_answered(s, replies):
    for i in (1, 2):
        yield f"after message {i}, every note is byte for byte as it was, and none was added", s[i] == s[0], f"changed {names(changed(s[0], s[i], True))}; added {names(added(s[0], s[i]))}"
    yield "(reply) round one asks whether to stop or to reopen", bool(re.search(r"(?i)\bstop\b", replies[0])) and bool(re.search(r"(?i)\breopen", replies[0])), replies[0][-200:]


def locked(s, replies):
    d09 = find(s[0], "D09")
    for i in range(1, len(s)):
        yield f"after message {i}, D09 is as the user locked it (but for the list of its children)", own(s[i][d09]) == own(s[0][d09]), "unchanged" if own(s[i][d09]) == own(s[0][d09]) else "its text differs"
    new = added(s[0], s[-1])
    under = [p for p in new if kind(s[-1][p]) == "direction" and parent(s[-1][p]) == "D09"]
    yield "the grilled direction is a new direction under D09", len(under) == 1, f"added {names(new)}"
    if under:
        yield "the new direction holds its Hypothesis and its Referee", all(section(s[-1][under[0]], h) for h in ("Hypothesis", "Referee")), f"sections with text: {[h for h in SECTIONS if section(s[-1][under[0]], h)]}"
    yield "no other note of the tree before the grilling was changed", not changed(s[0], s[-1]), f"changed {names(changed(s[0], s[-1]))}"


def cut_and_resumed(s, replies):
    d09 = find(s[0], "D09")
    yield "round one only asks: no note changed, none added", s[1] == s[0], f"changed {names(changed(s[0], s[1], True))}; added {names(added(s[0], s[1]))}"
    yield "the answers given before the cut are in D09: Hypothesis and Scope", all(section(s[2][d09], h) for h in ("Hypothesis", "Scope")), f"sections with text: {[h for h in SECTIONS if section(s[2][d09], h)]}"
    yield "what was left open is in D09: Open questions", bool(section(s[2][d09], "Open questions")), section(s[2][d09], "Open questions")[:120]
    yield "nothing but D09 was written before the cut", set(changed(s[0], s[2])) <= {d09} and not added(s[0], s[2]), f"changed {names(changed(s[0], s[2]))}; added {names(added(s[0], s[2]))}"
    yield "the new session leaves the Hypothesis as it was written", section(s[3][d09], "Hypothesis") == section(s[2][d09], "Hypothesis"), "unchanged" if section(s[3][d09], "Hypothesis") == section(s[2][d09], "Hypothesis") else "rewritten"
    asked = questions(replies[2])
    again = [q for q in asked if re.search(r"(?i)hypothes|change your mind|\bscope\b", q)]
    yield "(reply) the new session asks questions, and none for the hypothesis or the scope again", bool(asked) and not again, f"questions: {asked}"


CHECKS = {
    "planned-experiment": planned_experiment,
    "new-question": new_question,
    "already-answered": already_answered,
    "locked": locked,
    "cut-and-resumed": cut_and_resumed,
}


# ---------------------------------------------------------------- a session kept open

class Session:
    """One headless session on `work`, fed the user's messages one at a time."""

    def __init__(self, work: Path, plugin: Path, model: str | None):
        cmd = ["claude", "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
               "--plugin-dir", str(plugin), "--allowedTools", TOOLS]
        if model:
            cmd += ["--model", model]
        # its own process group, so that everything it started ends with it
        self.proc = subprocess.Popen(cmd, cwd=work, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
        self.cost = 0.0
        self.tools: list[str] = []

    def say(self, text: str, timeout: int) -> str:
        """Sends one message and waits for Claude's answer to it. A command answers first with its own
        line, at no model turn, and its prompt is answered next: the answer is the first result with a turn."""
        assert self.proc.stdin and self.proc.stdout
        self.proc.stdin.write(json.dumps({"type": "user", "message": {"role": "user", "content": text}}) + "\n")
        self.proc.stdin.flush()
        end = time.time() + timeout
        while time.time() < end:
            ready, _, _ = select.select([self.proc.stdout], [], [], 5)
            if not ready:
                continue
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("the session ended before it answered")
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "assistant":
                self.tools += [c["name"] for c in event["message"].get("content", []) if c.get("type") == "tool_use"]
            if event.get("type") == "result" and event.get("num_turns"):
                self.cost = max(self.cost, float(event.get("total_cost_usd") or 0))
                return str(event.get("result") or "")
        raise TimeoutError(f"no answer in {timeout}s")

    def close(self) -> None:
        try:
            os.killpg(self.proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            self.proc.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(self.proc.pid, signal.SIGKILL)


def prepare(work: Path, setup: list[dict]) -> None:
    shutil.copytree(DEMO, work, symlinks=True)
    for step in setup:
        path = work / step["file"]
        text = path.read_text(encoding="utf-8")
        if step["after"] not in text:
            raise RuntimeError(f"setup: {step['file']} has no line {step['after']!r}")
        path.write_text(text.replace(step["after"], f"{step['after']}\n{step['insert']}", 1), encoding="utf-8")


def run(scenario: dict, plugin: Path, model: str | None, timeout: int, keep: Path | None) -> dict:
    with tempfile.TemporaryDirectory(prefix="rft-bench-") as tmp:
        work = Path(tmp) / "project"
        prepare(work, scenario.get("setup", []))
        snaps, replies, tools, cost, error = [snapshot(work)], [], [], 0.0, None
        try:
            for messages in scenario["sessions"]:
                session = Session(work, plugin, model)
                try:
                    for message in messages:
                        replies.append(session.say(message, timeout))
                        snaps.append(snapshot(work))
                finally:
                    cost += session.cost
                    tools += session.tools
                    session.close()
        except (RuntimeError, TimeoutError) as err:
            error = f"{type(err).__name__}: {err} (at message {len(replies) + 1})"
        if keep:
            shutil.copytree(work, keep / scenario["name"], dirs_exist_ok=True)
        try:
            checks = [] if error else [{"what": what, "ok": bool(ok), "seen": str(seen)} for what, ok, seen in CHECKS[scenario["name"]](snaps, replies)]
        except Exception as err:  # a check that could not read what it needed has failed, with why
            checks = [{"what": "the checks could be read from the vault", "ok": False, "seen": f"{type(err).__name__}: {err}"}]
        return {"name": scenario["name"], "error": error, "checks": checks, "cost": round(cost, 4), "tools": tools, "replies": replies,
                "written": [{"changed": changed(snaps[0], s), "added": added(snaps[0], s)} for s in snaps[1:]]}


def describe(scenarios: list[dict]) -> str:
    out = []
    for sc in scenarios:
        out += [f"{sc['name']}: {sc['what']}"]
        out += [f"  setup: in {Path(step['file']).name}, `{step['insert']}` after `{step['after']}`" for step in sc.get("setup", [])]
        for i, messages in enumerate(sc["sessions"]):
            out += [f"  session {i + 1}:"] + [f"    > {m}" for m in messages]
        doc = CHECKS[sc["name"]]
        src = Path(__file__).read_text(encoding="utf-8")
        body = src[src.index(f"def {doc.__name__}("):].split("\n\n\n", 1)[0]
        out += ["  checked:"] + [f"    - {m.group(1)}" for m in re.finditer(r'yield f?"((?:[^"\\]|\\.)*)"', body)] + [""]
    return "\n".join(out)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", action="store_true", help="print the scenarios and what each checks; run nothing")
    ap.add_argument("--plugin", type=Path, help="the plugin's folder")
    ap.add_argument("--only", nargs="+", help="the scenarios to run, by name")
    ap.add_argument("--model", help="the model of every session (claude -p --model); absent, the default one")
    ap.add_argument("--timeout", type=int, default=900, help="seconds to wait for the answer to one message")
    ap.add_argument("--out", type=Path, help="write the full report here (the replies, what was written after each message)")
    ap.add_argument("--keep", type=Path, help="copy each scenario's project here when it ends, to read its notes")
    args = ap.parse_args(argv)
    scenarios = json.loads((HERE / "grilling.json").read_text(encoding="utf-8"))
    unknown = [n for n in args.only or [] if n not in CHECKS]
    if unknown or [s["name"] for s in scenarios] != list(CHECKS):
        print(f"unknown scenario(s) {unknown}: the scenarios are {', '.join(CHECKS)}", file=sys.stderr)
        return 2
    if args.list:
        print(describe(scenarios))
        return 0
    if not args.plugin:
        ap.error("--plugin is needed to run")
    if args.keep:
        args.keep.mkdir(parents=True, exist_ok=True)
    reports, failed = [], 0
    for sc in scenarios:
        if args.only and sc["name"] not in args.only:
            continue
        print(f"{sc['name']}: {sc['what']}", flush=True)
        report = run(sc, args.plugin.resolve(), args.model, args.timeout, args.keep)
        reports.append(report)
        if report["error"]:
            failed += 1
            print(f"  NOT RUN TO ITS END  {report['error']}")
        for check in report["checks"]:
            failed += not check["ok"]
            print(f"  {'passed' if check['ok'] else 'FAILED'}  {check['what']}" + ("" if check["ok"] else f"\n          seen: {check['seen']}"))
        print(f"  cost: ${report['cost']:.2f}\n", flush=True)
    if args.out:
        args.out.write_text(json.dumps(reports, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{sum(len(r['checks']) for r in reports)} checks, {failed} failed; ${sum(r['cost'] for r in reports):.2f} in all")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
