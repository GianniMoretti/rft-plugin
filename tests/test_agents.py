"""Tests of the agents the user sets up (server/rft_agents.py and the server's use of it), against
the cases the plugin's side is held to as well (tests/fixtures/agents; tests/agents.test.ts reads
them through their copy, tests/fixtures/agents.ts), with a fake model and a fake harness
(tests/agents_fakes.py): no test reaches a real agent or the network.

    python3 -m unittest tests.test_agents
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "server"))
sys.path.insert(0, str(HERE))
from agents_fakes import FakeHarness, FakeModel  # noqa: E402

FIXTURE = HERE / "fixtures" / "agents"
_spec = importlib.util.spec_from_file_location("agents_to_ts", FIXTURE / "to_ts.py")
to_ts = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(to_ts)
CASES = json.loads((FIXTURE / "cases.json").read_text(encoding="utf-8"))


class FixtureTest(unittest.TestCase):
    def test_the_plugin_tests_read_the_same_fixture(self):
        self.assertEqual(to_ts.OUT.read_text(encoding="utf-8"), to_ts.module(),
                         "tests/fixtures/agents.ts is behind the fixture: python3 tests/fixtures/agents/to_ts.py")
        self.assertEqual(to_ts.PAGE.read_text(encoding="utf-8"), to_ts.page(),
                         "tests/fixtures/agents/SCENARIOS.md is behind the fixture: python3 tests/fixtures/agents/to_ts.py")

    def test_the_cases_cover_what_the_spec_names(self):
        names = " | ".join(c["name"] for c in CASES["threads"] + CASES["process"])
        for said in ("tag left open", "two replacements", "comment thread", "brief of two lines", "no impression", "longer than a screen", "could not be read"):
            self.assertIn(said, names)
        self.assertTrue(all(c["want"] is None or c["want"]["asked"] is None for c in CASES["threads"]))


class FakeModelTest(unittest.TestCase):
    def ask(self, fake, key="k"):
        req = urllib.request.Request(fake.url + "/chat/completions", data=json.dumps({"model": "m", "messages": [{"role": "user", "content": "hello"}]}).encode(),
                                     headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.loads(r.read())

    def test_it_answers_the_chat_call_and_records_what_it_was_sent(self):
        fake = FakeModel("the answer")
        self.addCleanup(fake.close)
        self.assertEqual(self.ask(fake)["choices"][0]["message"]["content"], "the answer")
        self.assertEqual(fake.prompts, ["hello"])
        self.assertEqual(fake.requests[0]["path"], "/v1/chat/completions")
        self.assertEqual(fake.requests[0]["headers"]["authorization"], "Bearer k")

    def test_it_fails_when_told_to(self):
        fake = FakeModel("no such model", status=404)
        self.addCleanup(fake.close)
        with self.assertRaises(urllib.error.HTTPError) as got:
            self.ask(fake)
        self.assertEqual(got.exception.code, 404)


class FakeHarnessTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fake = FakeHarness(Path(self.tmp.name) / "harness", "the answer")

    def run_it(self, *args, stdin=None):
        return subprocess.run(self.fake.command(*args), input=stdin, capture_output=True, text=True, cwd=self.tmp.name,
                              env={**os.environ, **self.fake.env}, timeout=20)

    def test_the_prompt_as_its_last_argument_or_on_its_input(self):
        got = self.run_it("--locked", "say hello", stdin="")
        self.assertEqual((got.returncode, got.stdout), (0, "the answer"))
        got = self.run_it("--locked", "-", stdin="from stdin")
        self.assertEqual(got.stdout, "the answer")
        first, second = self.fake.runs
        self.assertEqual((first["argv"], first["prompt"], first["cwd"]), (["--locked", "say hello"], "say hello", os.path.realpath(self.tmp.name)))
        self.assertEqual(second["prompt"], "from stdin")

    def test_it_fails_and_writes_when_told_to(self):
        target = Path(self.tmp.name) / "written.txt"
        self.fake.set("it broke", exit=3, write=target)
        got = self.run_it("p", stdin="")
        self.assertEqual((got.returncode, got.stdout, got.stderr), (3, "", "it broke"))
        self.assertTrue(target.exists())


if __name__ == "__main__":
    unittest.main()
