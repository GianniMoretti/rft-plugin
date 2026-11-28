#!/usr/bin/env python3
"""A stand-in for a harness (Claude Code, Codex) in the tests: a command that is given a prompt and
prints its answer. It does what its environment says and records what it was given.

    FAKE_HARNESS_RECORD   a file: one JSON line per run, {argv, cwd, prompt, stdin}
    FAKE_HARNESS_ANSWER   a file holding the text it prints (default: "ok")
    FAKE_HARNESS_SLEEP    seconds it waits before answering (a harness that hangs)
    FAKE_HARNESS_EXIT     its exit code (default 0); the answer is then printed on stderr
    FAKE_HARNESS_WRITE    a path it tries to write to, as a harness that was not locked would

The prompt is its last argument, or its standard input when that argument is `-` or there is none.
"""
import json
import os
import sys
import time


def main() -> int:
    argv = sys.argv[1:]
    stdin = "" if sys.stdin.isatty() else sys.stdin.read()
    prompt = stdin if not argv or argv[-1] == "-" else argv[-1]
    record = os.environ.get("FAKE_HARNESS_RECORD")
    if record:
        with open(record, "a", encoding="utf-8") as f:
            f.write(json.dumps({"argv": argv, "cwd": os.getcwd(), "prompt": prompt, "stdin": stdin, "pid": os.getpid()}) + "\n")
    wait = float(os.environ.get("FAKE_HARNESS_SLEEP") or 0)
    if wait:
        time.sleep(wait)
    target = os.environ.get("FAKE_HARNESS_WRITE")
    if target:
        with open(target, "w", encoding="utf-8") as f:
            f.write("written by the harness\n")
    answer = "ok"
    path = os.environ.get("FAKE_HARNESS_ANSWER")
    if path:
        with open(path, encoding="utf-8") as f:
            answer = f.read()
    code = int(os.environ.get("FAKE_HARNESS_EXIT") or 0)
    (sys.stderr if code else sys.stdout).write(answer)
    return code


if __name__ == "__main__":
    sys.exit(main())
