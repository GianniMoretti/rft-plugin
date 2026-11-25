"""Stand-ins for the agents a user sets up, for the tests: a model (an HTTP server that answers the
OpenAI-compatible chat call with a fixed text) and a harness (tests/fake_harness.py). Each records
exactly what it was given, so a test can say what an agent was and was not handed.
"""
from __future__ import annotations

import http.server
import json
import os
import sys
import threading
import time
from pathlib import Path

HARNESS = Path(__file__).resolve().parent / "fake_harness.py"


class FakeModel:
    """A model at http://127.0.0.1:<port>/v1. `answer`: the text it answers with; `status`: the
    HTTP status it answers with instead (the body is then `answer`, as it is); `delay`: seconds it
    waits first; `raw`: a body sent as it is with status 200 (what is no chat answer at all).
    `requests`: what it was sent, each {path, headers, body}."""

    def __init__(self, answer: str = "ok", status: int = 200, delay: float = 0, raw: bytes | None = None):
        self.answer, self.status, self.delay, self.raw = answer, status, delay, raw
        self.requests: list[dict] = []
        fake = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                size = int(self.headers.get("Content-Length") or 0)
                data = self.rfile.read(size)
                try:
                    body = json.loads(data)
                except ValueError:
                    body = None
                fake.requests.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})
                if fake.delay:
                    time.sleep(fake.delay)
                if fake.raw is not None:
                    out, status = fake.raw, 200
                elif fake.status != 200:
                    out, status = fake.answer.encode("utf-8"), fake.status
                else:
                    out, status = json.dumps({"choices": [{"index": 0, "message": {"role": "assistant", "content": fake.answer}, "finish_reason": "stop"}]}).encode("utf-8"), 200
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(out)))
                    self.end_headers()
                    self.wfile.write(out)
                except OSError:
                    pass  # the asker gave up (a cancelled task)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}/v1"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def prompts(self) -> list[str]:
        """Every text it was sent, of every message of every request."""
        return [m.get("content", "") for r in self.requests for m in (r["body"] or {}).get("messages", [])]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class FakeHarness:
    """The fake harness as a command, with a folder of its own for its answer and its record.
    `command(*args)`: the argv that runs it; `env`: what to add to the environment of the process
    that runs it (or of the server that launches it); `runs`: what each run was given."""

    def __init__(self, folder: Path, answer: str = "ok", sleep: float = 0, exit: int = 0, write: Path | None = None):
        self.folder = Path(folder)
        self.folder.mkdir(parents=True, exist_ok=True)
        self.record = self.folder / "runs.jsonl"
        self.answer_file = self.folder / "answer.txt"
        self.set(answer, sleep, exit, write)

    def set(self, answer: str = "ok", sleep: float = 0, exit: int = 0, write: Path | None = None) -> None:
        self.answer_file.write_text(answer, encoding="utf-8")
        self.env = {"FAKE_HARNESS_RECORD": str(self.record), "FAKE_HARNESS_ANSWER": str(self.answer_file),
                    "FAKE_HARNESS_SLEEP": str(sleep) if sleep else "", "FAKE_HARNESS_EXIT": str(exit) if exit else "",
                    "FAKE_HARNESS_WRITE": str(write) if write else ""}

    def command(self, *args: str) -> list[str]:
        return [sys.executable, str(HARNESS), *args]

    def apply(self) -> None:
        """Puts its settings in this process's environment, which a launched harness inherits."""
        os.environ.update(self.env)

    @property
    def runs(self) -> list[dict]:
        try:
            return [json.loads(line) for line in self.record.read_text(encoding="utf-8").splitlines() if line]
        except OSError:
            return []
