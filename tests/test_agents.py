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


import rft_agents  # noqa: E402
import rft_server  # noqa: E402

WEB = HERE.parent / "web"
KEY = "test-key-123"

SETUP = """
[defaults]
thread = "qwen"
process = "reader"

[agents.qwen]
kind = "model"
url = "http://localhost:11434/v1/"
model = "qwen3:14b"

[agents.deepseek]
kind = "model"
url = "https://api.deepseek.com/v1"
model = "deepseek-chat"
key = "TEST_DEEPSEEK_KEY"
grant = "change"

[agents.reader]
kind = "harness"
run = ["tool", "exec", "{prompt}"]
locked = ["tool", "exec", "--read-only", "{prompt}"]
web = true
grant = "read"
process_seconds = 30

[agents.writer]
kind = "harness"
run = ["tool", "exec"]
grant = "change"

[agents.offline]
kind = "harness"
run = ["tool", "exec"]
locked = ["tool", "exec", "--read-only"]
grant = "read"
"""


def setup_of(text, env=None):
    return rft_agents.read_setup(text, Path("agents.toml"), {"TEST_DEEPSEEK_KEY": "sk-secret"} if env is None else env)


class SetupTest(unittest.TestCase):
    def test_models_and_harnesses_with_their_grants_and_tasks(self):
        s = setup_of(SETUP)
        self.assertEqual(s.errors, [])
        self.assertEqual(list(s.agents), ["qwen", "deepseek", "reader", "writer", "offline"])
        d = {a["name"]: a for a in s.describe()["agents"]}
        self.assertEqual((d["qwen"]["kind"], d["qwen"]["grant"], d["qwen"]["tasks"], d["qwen"]["where"]), ("model", "text", ["thread"], "runs on this machine"))
        # a model is text only whatever its entry says, and one elsewhere names its host
        self.assertEqual((d["deepseek"]["grant"], d["deepseek"]["tasks"], d["deepseek"]["where"]), ("text", ["thread"], "sends text to api.deepseek.com"))
        self.assertEqual((d["reader"]["grant"], d["reader"]["tasks"], d["reader"]["where"]), ("read", ["thread", "process"], "runs here, sends text to its provider"))
        self.assertEqual((d["writer"]["grant"], d["writer"]["tasks"]), ("change", ["thread"]))  # no web: no Process
        self.assertEqual(d["offline"]["tasks"], ["thread"])
        self.assertEqual(s.defaults, {"thread": "qwen", "process": "reader"})
        self.assertEqual(s.agents["qwen"].url, "http://localhost:11434/v1")
        self.assertEqual(s.agents["reader"].limits, {"thread": 120, "process": 30})
        self.assertEqual([a.name for a in s.for_task("process")], ["reader"])

    def test_a_harness_is_run_locked_below_the_full_grant(self):
        s = setup_of(SETUP)
        self.assertEqual(s.agents["reader"].command(), ["tool", "exec", "--read-only", "{prompt}"])
        self.assertEqual(s.agents["writer"].command(), ["tool", "exec"])
        s = setup_of('[agents.loose]\nkind = "harness"\nrun = ["tool"]\ngrant = "read"\nweb = true\n')
        loose = s.agents["loose"]
        self.assertIsNone(loose.command())
        self.assertEqual(loose.tasks(), [])
        self.assertIn("no locked command", loose.describe()["problem"])
        # and with nothing said of a grant it is text only, so the same holds
        s = setup_of('[agents.loose]\nkind = "harness"\nrun = ["tool"]\n')
        self.assertEqual((s.agents["loose"].grant, s.agents["loose"].tasks()), ("text", []))

    def test_a_key_is_named_never_held_and_never_told_to_the_page(self):
        s = setup_of(SETUP)
        told = json.dumps(s.describe())
        self.assertNotIn("sk-secret", told)
        self.assertNotIn("TEST_DEEPSEEK_KEY", told)
        self.assertNotIn("--read-only", told)
        missing = setup_of(SETUP, env={})
        self.assertEqual(missing.agents["deepseek"].describe()["problem"], "the environment variable TEST_DEEPSEEK_KEY is not set")
        self.assertEqual(missing.agents["deepseek"].tasks(), [])
        self.assertEqual(missing.agents["qwen"].tasks(), ["thread"])
        held = setup_of('[agents.x]\nkind = "model"\nurl = "https://a.example/v1"\nmodel = "m"\nkey = "sk-abc.123"\n')
        self.assertEqual(list(held.agents), [])
        self.assertIn("NAME of the environment variable", held.errors[0]["error"])
        self.assertNotIn("sk-abc", json.dumps(held.describe()))

    def test_a_wrong_entry_is_reported_and_the_others_still_load(self):
        wrong = {
            "grant": ('[agents.a]\nkind = "model"\nurl = "http://localhost:1/v1"\nmodel = "m"\ngrant = "all"', "grant is one of"),
            "no url": ('[agents.a]\nkind = "model"\nmodel = "m"', "needs url"),
            "no model": ('[agents.a]\nkind = "model"\nurl = "http://localhost:1/v1"', "needs model"),
            "no command": ('[agents.a]\nkind = "harness"', "needs run"),
            "a command as a sentence": ('[agents.a]\nkind = "harness"\nrun = "tool exec"', "list of words"),
            "the prompt twice": ('[agents.a]\nkind = "harness"\nrun = ["t", "{prompt}", "{prompt}"]', "more than once"),
            "kind": ('[agents.a]\nkind = "robot"', "kind is one of"),
            "the chat's name": ('[agents.Chat]\nkind = "model"\nurl = "http://localhost:1/v1"\nmodel = "m"', "connected Claude Code chat"),
            "a limit": ('[agents.a]\nkind = "model"\nurl = "http://localhost:1/v1"\nmodel = "m"\nthread_seconds = 0', "thread_seconds"),
        }
        good = '\n[agents.good]\nkind = "model"\nurl = "http://127.0.0.1:1/v1"\nmodel = "m"\n'
        for name, (text, says) in wrong.items():
            s = setup_of(text + good)
            self.assertEqual(list(s.agents), ["good"], name)
            self.assertEqual(len(s.errors), 1, name)
            self.assertIn(says, s.errors[0]["error"], name)
            self.assertNotEqual(s.errors[0]["name"], "", name)
        two = setup_of('[agents.Qwen]\nkind = "model"\nurl = "http://localhost:1/v1"\nmodel = "m"\n[agents.qwen]\nkind = "model"\nurl = "http://localhost:1/v1"\nmodel = "m"\n')
        self.assertEqual((list(two.agents), two.errors[0]["name"]), (["Qwen"], "qwen"))
        self.assertIn("another agent has this name", two.errors[0]["error"])
        broken = setup_of("[agents.a\nkind =")
        self.assertEqual((broken.agents, broken.errors[0]["name"]), ({}, ""))
        self.assertIn("cannot be read as TOML", broken.errors[0]["error"])

    def test_a_default_names_an_agent_that_may_do_the_task(self):
        s = setup_of(SETUP.replace('process = "reader"', 'process = "qwen"'))
        self.assertEqual(s.defaults, {"thread": "qwen"})
        self.assertIn("Process needs a harness", s.errors[0]["error"])
        s = setup_of(SETUP.replace('thread = "qwen"', 'thread = "nobody"'))
        self.assertIn('"nobody", is no agent', s.errors[0]["error"])
        s = setup_of(SETUP.replace('thread = "qwen"', 'thread = "chat"'))
        self.assertEqual((s.defaults["thread"], s.errors), ("chat", []))
        self.assertIn("grant", rft_agents.why_not(setup_of(SETUP.replace('grant = "read"\nprocess_seconds', 'process_seconds')).agents["reader"], "process"))
        self.assertIn("web", rft_agents.why_not(s.agents["writer"], "process"))

    def test_the_file_is_found_by_the_environment_and_read_again_when_it_changes(self):
        self.assertEqual(rft_agents.setup_path({"RFT_AGENTS": "/x/a.toml"}), Path("/x/a.toml"))
        self.assertEqual(rft_agents.setup_path({"XDG_CONFIG_HOME": "/cfg"}), Path("/cfg/rft/agents.toml"))
        self.assertEqual(rft_agents.setup_path({}), Path.home() / ".config" / "rft" / "agents.toml")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "agents.toml"
            env = {}
            setups = rft_agents.Setups(path, env)
            got = setups.get()
            self.assertEqual((got.found, got.agents, got.errors), (False, {}, []))
            path.write_text(SETUP)
            got = setups.get()
            self.assertTrue(got.found)
            self.assertEqual(got.agents["deepseek"].tasks(), [])
            env["TEST_DEEPSEEK_KEY"] = "sk-secret"  # the key set since: no change of the file is needed
            self.assertEqual(setups.get().agents["deepseek"].tasks(), ["thread"])
            path.write_text(SETUP + '\n[agents.more]\nkind = "model"\nurl = "http://localhost:2/v1"\nmodel = "m"\n')
            self.assertIn("more", setups.get().agents)
            path.unlink()
            self.assertEqual((setups.get().found, setups.get().agents), (False, {}))
            path.write_bytes(b"\xff\xfe not text")
            self.assertIn("cannot be read", setups.get().errors[0]["error"])


class AgentsRouteTest(unittest.TestCase):
    """GET api/agents: what the page's picker lists."""

    def serve(self, agents=None, relay=None):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        vault = Path(tmp.name) / "vault"
        (vault / "directions").mkdir(parents=True)
        v = rft_server.Vault(vault, "demo")
        handler = rft_server.make_handler(v, WEB, KEY, ask=relay.ask if relay else (lambda *a: None), relay=relay, agents=agents)
        server = rft_server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        import threading
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return server.server_address[1], Path(tmp.name)

    def get(self, port):
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/agents", timeout=5) as r:
            return json.loads(r.read())

    def test_with_no_setup_the_page_has_the_session_alone(self):
        port, _ = self.serve()
        self.assertEqual(self.get(port), {"found": False, "agents": [], "defaults": {}, "errors": [], "chat": True})

    def test_the_agents_of_the_setup_and_whether_a_chat_is_there(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "agents.toml"
            path.write_text(SETUP)
            relay = rft_server.Relay()
            port, _ = self.serve(rft_agents.Setups(path, {}), relay)
            got = self.get(port)
            self.assertEqual([a["name"] for a in got["agents"]], ["qwen", "deepseek", "reader", "writer", "offline"])
            self.assertFalse(got["chat"])
            self.assertEqual(got["defaults"], {"thread": "qwen", "process": "reader"})
            self.assertIn("TEST_DEEPSEEK_KEY is not set", got["agents"][1]["problem"])
            relay.take()  # a chat's server asked for what waits: a chat is there
            self.assertTrue(self.get(port)["chat"])


if __name__ == "__main__":
    unittest.main()
