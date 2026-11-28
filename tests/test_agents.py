"""Tests of the agents the user sets up (server/rft_agents.py and the server's use of it), against
the cases the plugin's side is held to as well (tests/fixtures/agents; tests/agents.test.ts reads
them through their copy, tests/fixtures/agents.ts), with a fake model and a fake harness
(tests/agents_fakes.py): no test reaches a real agent or the network.

    python3 -m unittest tests.test_agents
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
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


def note(nid, kind, status, parent, title):
    p = f'"[[{parent}]]"' if parent else '""'
    return f"---\nid: {nid}\ntype: {kind}\nstatus: {status}\ndate: 2026-01-01\nparent: {p}\ntags: [demo, {kind}, {status}]\n---\n\n# {nid} · {title}\n\nText of {nid}.\n"


class Served(unittest.TestCase):
    """A vault with the fixture's note, served as from a terminal, with a setup file of the test's."""

    AGENTS = ""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.vault = root / "vault"
        (self.vault / "directions").mkdir(parents=True)
        (self.vault / "experiments").mkdir()
        (self.vault / "directions" / "D00 Does the thing work.md").write_text(note("D00", "direction", "done", "", "Does the thing work"))
        (self.vault / "directions" / "D01 A better variant.md").write_text(note("D01", "direction", "idea", "D00 Does the thing work", "A better variant"))
        self.e02 = root / CASES["note"]["file"]
        self.e02.write_text(CASES["note"]["text"], encoding="utf-8")
        self.model = FakeModel("Yes: 5 seeds.")
        self.addCleanup(self.model.close)
        self.harness = FakeHarness(root / "harness")
        self.setup_file = root / "agents.toml"
        self.env = {"TEST_KEY": "sk-secret"}
        self.write_setup(self.AGENTS)
        self.relay = rft_server.Relay()
        self.v = rft_server.Vault(self.vault, "demo")
        self.v.arxiv_meta = None
        handler = rft_server.make_handler(self.v, WEB, KEY, ask=self.relay.ask, relay=self.relay, agents=rft_agents.Setups(self.setup_file, self.env))
        self.server = rft_server.http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.server.server_address[1]
        import threading
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def write_setup(self, text):
        self.setup_file.write_text(text.replace("MODEL_URL", self.model.url))

    def call(self, method, path, payload=None):
        headers = {"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.port}", "X-RFT-Token": KEY}
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method, headers=headers,
                                     data=None if payload is None else json.dumps(payload).encode())
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as err:
            return err.code, json.loads(err.read() or b"{}")

    def comment(self, **payload):
        return self.call("POST", "/api/comment", {"id": "E02", **payload})

    def threads(self):
        return json.loads((self.vault / ".comments" / "E02.json").read_text())["threads"]

    def put_thread(self, thread):
        (self.vault / ".comments").mkdir(exist_ok=True)
        (self.vault / ".comments" / "E02.json").write_text(json.dumps({"note": "E02", "next": 2, "threads": [thread]}))

    def files(self):
        """Every file of the vault with its bytes: what a test compares before and after."""
        return {str(p.relative_to(self.vault)): p.read_bytes() for p in sorted(self.vault.rglob("*")) if p.is_file()}

    def wait(self, key="thread:E02:c1"):
        return self.v.runner.tasks.wait(key)


MODELS = """
[agents.qwen]
kind = "model"
url = "MODEL_URL"
model = "qwen3:14b"

[agents.remote]
kind = "model"
url = "MODEL_URL"
model = "big"
key = "TEST_KEY"
"""


class AnswerThreadTest(Served):
    """What the server writes for an agent's answer, case for case with the plugin."""

    def test_case_by_case_a_reply_a_new_text_to_accept_or_nothing(self):
        for agent in (None, "qwen"):
            for case in CASES["threads"]:
                self.put_thread(case["thread"])
                before = self.files()
                status, got = self.v.answer_thread("E02", case["thread"]["id"], case["answer"], agent, CASES["now"])
                if case["want"] is None:
                    self.assertEqual(status, 409, case["name"])
                    self.assertEqual(self.files(), before, case["name"])
                    continue
                self.assertEqual((status, got), (200, {"answered": True}), case["name"])
                want = json.loads(json.dumps(case["want"]))
                if agent:
                    # signed: the message it added says which agent wrote it
                    for m in want["messages"][len(case["thread"]["messages"]):]:
                        m["agent"] = agent
                self.assertEqual(self.threads(), [want], case["name"])
                # the note is the user's to change, by accepting
                self.assertEqual(self.e02.read_text(encoding="utf-8"), CASES["note"]["text"], case["name"])
                after = self.files()
                self.assertEqual([k for k in after if after[k] != before.get(k)], [".comments/E02.json"], case["name"])

    def test_a_thread_or_a_note_that_is_gone(self):
        self.put_thread(CASES["threads"][0]["thread"])
        before = self.files()
        self.assertEqual(self.v.answer_thread("E02", "c9", "Yes.")[0], 404)
        self.assertEqual(self.v.answer_thread("E77", "c1", "Yes.")[0], 404)
        self.assertEqual(self.v.answer_thread("E02", "c1", "   ")[0], 200)  # as the plugin: "(no answer)"
        self.assertEqual(self.threads()[0]["messages"][-1]["text"], "(no answer)")
        self.assertNotEqual(self.files(), before)


class ModelThreadTest(Served):
    """Ask on a thread, answered by a model the user set up, with no chat connected."""

    AGENTS = MODELS

    def new_thread(self, kind="comment", text="Is this right?"):
        status, got = self.comment(action="new", kind=kind, quote="Text of E02.", prefix="", suffix="", text=text)
        self.assertEqual(status, 200, got)
        return got["threads"][-1]["id"]

    def test_a_reply_from_the_model_signed_with_its_name(self):
        tid = self.new_thread()
        note_before = self.e02.read_bytes()
        status, got = self.comment(action="ask", thread=tid, agent="qwen")
        self.assertEqual(status, 200, got)
        task = self.wait()
        self.assertEqual((task.state, task.error, task.agent), ("done", "", "qwen"))
        t = self.threads()[0]
        self.assertEqual(t["messages"][-1], {"by": "claude", "at": t["messages"][-1]["at"], "agent": "qwen", "text": "Yes: 5 seeds."})
        self.assertIsNone(t["asked"])
        self.assertNotIn("asking", t)
        self.assertEqual(self.e02.read_bytes(), note_before)
        # the page reads who answered, and the task that did
        shown = self.call("GET", "/api/note?id=E02")[1]["threads"][0]
        self.assertEqual((shown["messages"][-1]["agent"], shown["task"]["state"], shown["task"]["agent"]), ("qwen", "done", "qwen"))

    def test_the_prompt_is_self_contained_and_nothing_else_is_sent(self):
        tid = self.new_thread()
        self.comment(action="ask", thread=tid, agent="qwen")
        self.wait()
        (req,) = self.model.requests
        self.assertEqual(req["path"], "/v1/chat/completions")
        self.assertEqual((req["body"]["model"], req["body"]["stream"], len(req["body"]["messages"])), ("qwen3:14b", False, 1))
        self.assertNotIn("authorization", req["headers"])  # no key named: none sent
        prompt = req["body"]["messages"][0]["content"]
        for part in ("Text of E02.", "## Result", "Is this right?", "> Text of E02.", "It is a comment", "The note E02 Variant run"):
            self.assertIn(part, prompt)
        # no tool, skill or file of any harness is named
        for word in ("rft_", "Read(", "Grep", "ToolSearch", "AskUserQuestion", "manual", "skill", "the file", self.tmp.name):
            self.assertNotIn(word, prompt)

    def test_a_key_goes_in_the_header_from_the_variable_the_entry_names(self):
        tid = self.new_thread()
        self.comment(action="ask", thread=tid, agent="remote")
        self.assertEqual(self.wait().state, "done")
        self.assertEqual(self.model.requests[0]["headers"]["authorization"], "Bearer sk-secret")
        self.assertNotIn("sk-secret", json.dumps(self.model.requests[0]["body"]))
        self.assertEqual(self.threads()[0]["messages"][-1]["agent"], "remote")

    def test_a_new_text_waits_for_the_user_who_accepts_or_rejects_it(self):
        for decision in ("accept", "reject"):
            self.e02.write_text(CASES["note"]["text"], encoding="utf-8")
            (self.vault / ".comments" / "E02.json").unlink(missing_ok=True)
            tid = self.new_thread("suggestion", "Say how many seeds.")
            self.model.answer = "<replacement>Text of E02, over 5 seeds.</replacement>\nThe note gave no seed count."
            self.assertEqual(self.comment(action="ask", thread=tid, agent="qwen")[0], 200)
            self.assertEqual(self.wait().state, "done")
            t = self.threads()[0]
            self.assertEqual((t["replacement"], t["messages"][-1]["text"], t["messages"][-1]["agent"], t["state"]), ("Text of E02, over 5 seeds.", "The note gave no seed count.", "qwen", "open"))
            self.assertEqual(self.e02.read_text(encoding="utf-8"), CASES["note"]["text"])  # nothing written until the user accepts
            self.assertEqual(self.comment(action=decision, thread=tid)[0], 200)
            want = CASES["note"]["text"].replace("Text of E02.", "Text of E02, over 5 seeds.") if decision == "accept" else CASES["note"]["text"]
            self.assertEqual(self.e02.read_text(encoding="utf-8"), want)
            self.assertIn("It is a suggestion", self.model.prompts[-1])
            self.assertIn("<replacement>", self.model.prompts[-1])
            self.assertNotIn("Begin with the first words", self.model.prompts[-1])  # a comment's words, not a suggestion's

    def test_a_malformed_new_text_is_a_plain_reply(self):
        tid = self.new_thread("suggestion", "Say how many seeds.")
        self.model.answer = "<replacement>\nText of E02, over 5 seeds."
        self.comment(action="ask", thread=tid, agent="qwen")
        self.assertEqual(self.wait().state, "done")
        t = self.threads()[0]
        self.assertIsNone(t["replacement"])
        self.assertEqual(t["messages"][-1]["text"], "<replacement>\nText of E02, over 5 seeds.")
        self.assertEqual(self.comment(action="accept", thread=tid)[0], 409)  # there is no new text to accept

    def test_a_model_that_thinks_aloud_first(self):
        tid = self.new_thread()
        self.model.answer = "<think>\nThe user asks about seeds.\n</think>\n\nYes: 5 seeds."
        self.comment(action="ask", thread=tid, agent="qwen")
        self.wait()
        self.assertEqual(self.threads()[0]["messages"][-1]["text"], "Yes: 5 seeds.")

    def failing(self, says, **how):
        tid = self.new_thread()
        before = None
        for k, v in how.items():
            setattr(self.model, k, v)
        status, got = self.comment(action="ask", thread=tid, agent=how.get("agent", "qwen"))
        self.assertEqual(status, 200, got)
        task = self.wait()
        self.assertEqual(task.state, "failed")
        self.assertIn(says, task.error)
        t = self.threads()[0]
        # nothing was written, and the thread no longer waits
        self.assertEqual((len(t["messages"]), t["asked"], t["replacement"]), (1, None, None))
        self.assertNotIn("asking", t)
        self.assertEqual(self.e02.read_text(encoding="utf-8"), CASES["note"]["text"])
        shown = self.call("GET", "/api/note?id=E02")[1]["threads"][0]
        self.assertEqual((shown["task"]["state"], shown["task"]["agent"]), ("failed", "qwen"))
        self.assertIn(says, shown["task"]["error"])
        return task

    def test_a_model_that_answers_an_error(self):
        self.failing("qwen answered 404: model not found", answer='{"error": "model not found"}', status=404)

    def test_a_model_that_answers_what_is_no_chat_answer(self):
        self.failing("not as a chat endpoint does", raw=b"<html>hello</html>")

    def test_a_model_that_answers_nothing(self):
        self.failing("answered with nothing", answer="  \n")

    def test_a_model_that_is_not_running(self):
        self.model.close()
        self.failing("cannot be reached at 127.0.0.1")

    def test_a_key_that_is_not_set_and_an_agent_that_is_none(self):
        tid = self.new_thread()
        before = self.files()
        del self.env["TEST_KEY"]
        status, got = self.comment(action="ask", thread=tid, agent="remote")
        self.assertEqual(status, 409)
        self.assertIn("TEST_KEY is not set", got["error"])
        status, got = self.comment(action="ask", thread=tid, agent="nobody")
        self.assertEqual(status, 409)
        self.assertIn('"nobody" is no agent', got["error"])
        self.assertEqual(self.comment(action="ask", thread=tid, agent=3)[0], 409)
        self.assertEqual(self.files(), before)
        self.assertEqual(self.model.requests, [])

    def test_the_setups_default_answers_when_the_page_names_no_one(self):
        self.write_setup('[defaults]\nthread = "qwen"\n' + MODELS)
        tid = self.new_thread()
        self.assertEqual(self.comment(action="ask", thread=tid)[0], 200)
        self.assertEqual(self.wait().agent, "qwen")
        self.assertEqual(self.threads()[0]["messages"][-1]["agent"], "qwen")

    def test_with_no_default_and_no_one_named_it_is_the_chats_as_before(self):
        tid = self.new_thread()
        before = self.files()
        status, got = self.comment(action="ask", thread=tid)
        self.assertEqual(status, 503)  # served from a terminal, no chat connected
        self.assertEqual(got["error"], "no Claude Code chat is connected: pick one of your agents (qwen, remote), or run /rft in a chat")
        self.assertEqual(self.files(), before)
        # with no agent that may take it, the page is told how to set one up
        self.write_setup("")
        status, got = self.comment(action="ask", thread=tid)
        self.assertEqual(status, 503)
        self.assertTrue(got["error"].startswith(rft_server.NO_SESSION))
        self.assertIn("set up an agent of your own", got["error"])
        self.assertIn("Agents in the guide", got["error"])
        self.write_setup(self.AGENTS)
        status, got = self.comment(action="ask", thread=tid, agent="chat")
        self.assertEqual(status, 503)
        self.assertEqual(self.model.requests, [])

    def test_a_long_note_is_given_around_the_quoted_text(self):
        long = CASES["note"]["text"].replace("## Result\n", "## Result\n" + "START " + "x" * 90_000 + "\n") + "y" * 90_000 + " END\n"
        self.e02.write_text(long, encoding="utf-8")
        tid = self.new_thread()
        self.comment(action="ask", thread=tid, agent="qwen")
        self.wait()
        prompt = self.model.prompts[-1]
        self.assertIn("Text of E02.", prompt)
        self.assertIn("the part of it around the quoted text", prompt)
        self.assertNotIn("START", prompt)
        self.assertNotIn(" END", prompt)
        self.assertLess(len(prompt), rft_agents.NOTE_CHARS + 3000)
        # a comment's answer is asked for as the reply alone: a small model otherwise copies the way the thread is written
        self.assertTrue(prompt.endswith('Begin with the first words of the reply itself: no heading, no name or number of the thread, and no ">" before your lines.'), prompt[-200:])


class TaskTest(Served):
    """A launched task: one at a time per thread, shown, limited in time, cancelled by the user."""

    AGENTS = MODELS + 'thread_seconds = 1\n'  # the last entry, remote: one second for a thread

    def asked(self, agent="qwen", delay=0.0):
        status, got = self.comment(action="new", kind="comment", quote="Text of E02.", prefix="", suffix="", text="Is this right?")
        tid = got["threads"][-1]["id"]
        self.model.delay = delay
        status, got = self.comment(action="ask", thread=tid, agent=agent)
        self.assertEqual(status, 200, got)
        return tid, got

    def shown(self):
        return self.call("GET", "/api/note?id=E02")[1]["threads"][0]

    def untouched(self):
        t = self.threads()[0]
        self.assertEqual((len(t["messages"]), t["asked"], t["replacement"]), (1, None, None))
        self.assertNotIn("asking", t)
        self.assertEqual(self.e02.read_text(encoding="utf-8"), CASES["note"]["text"])

    def test_a_running_task_is_shown_on_its_thread_with_the_agents_name(self):
        tid, got = self.asked(delay=0.6)
        t = got["threads"][0]
        self.assertEqual((t["asking"], t["task"]["state"], t["task"]["agent"], t["task"]["limit"]), ("qwen", "running", "qwen", 120))
        self.assertIsNotNone(t["asked"])
        self.assertEqual(self.shown()["task"]["state"], "running")
        self.assertEqual(self.wait().state, "done")
        self.assertEqual(self.shown()["task"]["state"], "done")

    def test_a_second_ask_while_one_runs_is_refused_and_not_queued(self):
        tid, _ = self.asked(delay=0.6)
        status, got = self.comment(action="ask", thread=tid, agent="qwen")
        self.assertEqual(status, 409)
        self.assertIn("qwen is already answering", got["error"])
        status, got = self.comment(action="ask", thread=tid, agent="remote")
        self.assertEqual(status, 409)
        self.assertEqual(self.wait().state, "done")
        self.assertEqual(len(self.model.requests), 1)
        self.assertEqual(len(self.threads()[0]["messages"]), 2)

    def test_cancelled_nothing_is_written_even_when_the_agent_answers_afterwards(self):
        tid, _ = self.asked(delay=1.0)
        status, got = self.comment(action="cancel", thread=tid)
        self.assertEqual(status, 200, got)
        self.assertEqual((got["threads"][0]["asked"], got["threads"][0].get("asking")), (None, None))
        task = self.wait()
        self.assertEqual((task.state, task.error), ("cancelled", ""))
        import time
        time.sleep(1.3)  # the model answers now, to no one
        self.untouched()
        self.assertEqual(self.shown()["task"]["state"], "cancelled")
        # and the thread can be asked again
        self.model.delay = 0
        self.assertEqual(self.comment(action="ask", thread=tid, agent="qwen")[0], 200)
        self.assertEqual(self.wait().state, "done")
        self.assertEqual(self.threads()[0]["messages"][-1]["agent"], "qwen")

    def test_nothing_to_cancel(self):
        status, got = self.comment(action="new", kind="comment", quote="Text of E02.", prefix="", suffix="", text="Is this right?")
        tid = got["threads"][-1]["id"]
        self.assertEqual(self.comment(action="cancel", thread=tid)[0], 409)
        self.comment(action="ask", thread=tid, agent="qwen")
        self.wait()
        self.assertEqual(self.comment(action="cancel", thread=tid)[0], 409)  # it has answered

    def test_out_of_time_nothing_is_written_and_the_reason_stays_until_the_next_ask(self):
        tid, _ = self.asked(agent="remote", delay=2.0)
        task = self.wait()
        self.assertEqual(task.state, "failed")
        # with where its limit is set: the default is short for a model on a slow machine
        self.assertEqual(task.error, "remote did not answer within 1 seconds. To give it longer, raise its Seconds for a thread under Agents… (thread_seconds in the setup file), at most 3600")
        import time
        time.sleep(1.3)
        self.untouched()
        shown = self.shown()
        self.assertEqual(shown["task"]["state"], "failed")
        self.assertIn("did not answer within 1 seconds", shown["task"]["error"])
        self.assertIn("did not answer", self.shown()["task"]["error"])  # still there at the next look
        self.model.delay = 0
        self.comment(action="ask", thread=tid, agent="qwen")
        self.assertEqual(self.wait().state, "done")
        self.assertEqual(self.shown()["task"]["error"], "")

    def test_a_thread_closed_while_the_agent_was_at_it_gets_no_answer(self):
        tid, _ = self.asked(delay=0.5)
        self.assertEqual(self.comment(action="resolve", thread=tid)[0], 200)
        task = self.wait()
        self.assertEqual(task.state, "failed")
        self.assertIn("resolved", task.error)
        t = self.threads()[0]
        self.assertEqual((len(t["messages"]), t["state"]), (1, "resolved"))

    def test_after_a_restart_a_task_that_was_running_shows_as_failed_and_can_be_asked_again(self):
        tid, _ = self.asked(delay=0.2)
        self.wait()
        # as a server that was stopped mid-task left it: the thread waits for an agent no server runs
        data = json.loads((self.vault / ".comments" / "E02.json").read_text())
        data["threads"][0].update(asked="2026-11-25 10:00", asking="qwen")
        data["threads"][0]["messages"] = data["threads"][0]["messages"][:1]
        (self.vault / ".comments" / "E02.json").write_text(json.dumps(data))
        self.v.runner = rft_agents.Runner(self.v.runner.setups)  # a new server's memory
        shown = self.shown()
        self.assertEqual((shown["task"]["state"], shown["asked"]), ("failed", None))
        self.assertIn("restarted while qwen was answering", shown["task"]["error"])
        self.untouched()
        self.assertEqual(self.shown()["task"]["state"], "failed")  # said until the next ask, not once and gone
        self.assertEqual(self.comment(action="ask", thread=tid, agent="qwen")[0], 200)
        self.assertEqual(self.wait().state, "done")
        self.assertEqual(self.shown()["task"]["state"], "done")


HARNESSES = """
[agents.reader]
kind = "harness"
run = [PY, HARNESS, "--full", "{prompt}"]
locked = [PY, HARNESS, "--locked", "{prompt}"]
grant = "read"
thread_seconds = 2

[agents.writer]
kind = "harness"
run = [PY, HARNESS, "--full"]
locked = [PY, HARNESS, "--locked"]
grant = "change"

[agents.loose]
kind = "harness"
run = [PY, HARNESS, "--full"]
grant = "read"

[agents.absent]
kind = "harness"
run = ["rft-no-such-harness"]
locked = ["rft-no-such-harness", "--locked"]
"""


class HarnessThreadTest(Served):
    """Ask on a thread, answered by a harness the server launches, locked below the full grant."""

    AGENTS = HARNESSES.replace("PY", json.dumps(sys.executable)).replace("HARNESS", json.dumps(str(HERE / "fake_harness.py")))

    def setUp(self):
        super().setUp()
        self.v.runner.harness_env = self.harness.env

    def set(self, *a, **k):
        self.harness.set(*a, **k)
        self.v.runner.harness_env = self.harness.env

    def ask(self, agent, kind="comment", text="Is this right?"):
        status, got = self.comment(action="new", kind=kind, quote="Text of E02.", prefix="", suffix="", text=text)
        tid = got["threads"][-1]["id"]
        return tid, self.comment(action="ask", thread=tid, agent=agent)

    def test_below_the_full_grant_it_is_run_with_its_locked_command_in_the_vault(self):
        self.set("Yes: 5 seeds.")
        before = self.files()
        tid, (status, got) = self.ask("reader")
        self.assertEqual(status, 200, got)
        self.assertEqual(self.wait().state, "done")
        (run,) = self.harness.runs
        self.assertEqual(run["argv"][0], "--locked")
        self.assertEqual(run["cwd"], os.path.realpath(self.vault))
        self.assertEqual(run["stdin"], "")  # the prompt stood in the command
        t = self.threads()[0]
        self.assertEqual((t["messages"][-1]["text"], t["messages"][-1]["agent"]), ("Yes: 5 seeds.", "reader"))
        # the server wrote the answer: the thread's file is the one change of the vault
        after = self.files()
        self.assertEqual([k for k in after if after[k] != before.get(k)], [".comments/E02.json"])
        self.assertEqual(set(after), set(before) | {".comments/E02.json"})

    def test_with_the_full_grant_it_is_run_with_its_own_command_and_the_prompt_on_its_input(self):
        self.set("Yes.")
        tid, (status, got) = self.ask("writer")
        self.assertEqual(self.wait().state, "done")
        (run,) = self.harness.runs
        self.assertEqual(run["argv"], ["--full"])
        self.assertIn("Text of E02.", run["stdin"])

    def test_the_prompt_names_the_file_and_asks_for_no_change(self):
        tid, _ = self.ask("reader", "suggestion", "Say how many seeds.")
        self.wait()
        prompt = self.harness.runs[0]["prompt"]
        for part in ("`experiments/E02 Variant run.md` in the folder you run in", "Change no file", "It is a suggestion", "<replacement>", "> Text of E02.", "Say how many seeds."):
            self.assertIn(part, prompt)
        for word in ("rft_", "ToolSearch", "AskUserQuestion", "skill", self.tmp.name):
            self.assertNotIn(word, prompt)

    def test_a_harness_with_no_locked_command_is_never_run_below_the_full_grant(self):
        before = None
        status, got = self.comment(action="new", kind="comment", quote="Text of E02.", prefix="", suffix="", text="Is this right?")
        before = self.files()
        status, got = self.comment(action="ask", thread=got["threads"][-1]["id"], agent="loose")
        self.assertEqual(status, 409)
        self.assertIn("no locked command", got["error"])
        self.assertEqual(self.harness.runs, [])
        self.assertEqual(self.files(), before)
        # and were it reached all the same, the launch itself refuses
        loose = self.v.runner.setup().agents["loose"]
        with self.assertRaises(rft_agents.AgentError):
            rft_agents.run_harness(loose, "p", rft_agents.Run(), self.vault, 5, self.harness.env)
        self.assertEqual(self.harness.runs, [])

    def failed(self, agent, says):
        tid, (status, got) = self.ask(agent)
        self.assertEqual(status, 200, got)
        task = self.wait()
        self.assertEqual(task.state, "failed", task.error)
        self.assertIn(says, task.error)
        t = self.threads()[0]
        self.assertEqual((len(t["messages"]), t["asked"]), (1, None))
        self.assertEqual(self.e02.read_text(encoding="utf-8"), CASES["note"]["text"])
        return task

    def test_a_harness_that_ends_with_an_error(self):
        self.set("usage: tool [options]\nnot logged in", exit=2)
        self.failed("reader", "reader ended with an error (code 2): not logged in")

    def test_a_command_that_is_not_on_this_machine(self):
        self.failed("absent", "the command rft-no-such-harness is not found")

    def test_a_harness_that_prints_nothing(self):
        self.set("\n  \n")
        self.failed("reader", "answered with nothing")

    def test_out_of_time_the_harness_is_ended(self):
        self.set("late", sleep=30)
        task = self.failed("reader", "reader did not answer within 2 seconds. To give it longer, raise its Seconds for a thread under Agents…")
        self.assertFalse(alive(self.harness.runs[0]["pid"]))

    def test_cancelled_the_harness_is_ended_and_nothing_is_written(self):
        self.set("late", sleep=30)
        tid, (status, got) = self.ask("writer")
        import time
        end = time.time() + 5
        while not self.harness.runs and time.time() < end:
            time.sleep(0.05)
        pid = self.harness.runs[0]["pid"]
        self.assertTrue(alive(pid))
        self.assertEqual(self.comment(action="cancel", thread=tid)[0], 200)
        self.assertEqual(self.wait().state, "cancelled")
        end = time.time() + 5
        while alive(pid) and time.time() < end:
            time.sleep(0.05)
        self.assertFalse(alive(pid))
        self.assertEqual(len(self.threads()[0]["messages"]), 1)


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    # ended but not yet reaped by its parent counts as ended
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rsplit(")", 1)[1].split()[0] != "Z"
    except OSError:
        return False


class PresetTest(unittest.TestCase):
    def test_the_ready_made_entries(self):
        s = setup_of('[agents.claude]\nkind = "claude-code"\ngrant = "read"\n[agents.opus]\nkind = "claude-code"\ngrant = "change"\nmodel = "opus"\n[agents.codex]\nkind = "codex"\ngrant = "read"\n')
        self.assertEqual(s.errors, [])
        claude, opus, codex = s.agents["claude"], s.agents["opus"], s.agents["codex"]
        locked = claude.command()
        self.assertEqual(locked[:2], ["claude", "-p"])
        for flag in ("--restricted", "--strict-mcp-config", "--tools"):
            self.assertIn(flag, locked)
        tools = locked[locked.index("--tools") + 1].split(",")
        self.assertEqual(sorted(tools), ["Glob", "Grep", "Read", "WebFetch", "WebSearch"])  # none that writes or runs a command
        self.assertEqual(claude.tasks(), ["thread", "process"])
        self.assertEqual(opus.command()[:3], ["claude", "--model", "opus"])
        self.assertNotIn("--restricted", opus.command())
        self.assertEqual((claude.describe()["unverified"], codex.describe()["unverified"]), (False, False))
        self.assertIn("read-only", codex.command())
        self.assertEqual(codex.command()[:3], ["codex", "--search", "exec"])  # --search is a flag of codex itself, not of exec
        self.assertNotIn("read-only", setup_of('[agents.c]\nkind = "codex"\ngrant = "change"\n').agents["c"].command())
        self.assertEqual(set(rft_agents.PRESET_NOTES), set(rft_agents.PRESETS))
        # an entry's own commands win over the ready-made ones
        mine = setup_of('[agents.c]\nkind = "codex"\ngrant = "read"\nweb = false\nlocked = ["codex", "exec", "--sandbox", "read-only", "-"]\n').agents["c"]
        self.assertEqual((mine.command()[1], mine.tasks()), ("exec", ["thread"]))


import rft_inbox  # noqa: E402
import rft_reading  # noqa: E402

LINK = "https://arxiv.org/abs/2406.01234"
ITEM_KEY = "arxiv:2406.01234"
INBOX = f"# Inbox\n\n- [Mixup at scale]({LINK}) — maybe relevant to D01 · high · added 2026-11-20\n- https://b.org/y\n"
MINE = "> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E02? SECRET-OF-THE-USER"
GOOD = next(c for c in CASES["process"] if "error" not in c["want"])

PROCESSORS = HARNESSES + """
[agents.web]
kind = "harness"
run = [PY, HARNESS, "--full"]
locked = [PY, HARNESS, "--locked"]
web = true
grant = "read"
process_seconds = 2

[agents.blind]
kind = "harness"
run = [PY, HARNESS, "--full"]
locked = [PY, HARNESS, "--locked"]
web = true

[agents.qwen]
kind = "model"
url = "MODEL_URL"
model = "qwen3:14b"
"""


class ProcessTest(Served):
    """Process on an inbox item, by a harness the server launches, with no chat connected."""

    AGENTS = PROCESSORS.replace("PY", json.dumps(sys.executable)).replace("HARNESS", json.dumps(str(HERE / "fake_harness.py")))
    TASK = f"item:0:{ITEM_KEY}"

    def setUp(self):
        super().setUp()
        self.v.runner.harness_env = self.harness.env
        (self.vault / "Inbox.md").write_text(INBOX, encoding="utf-8")
        self.today = rft_server.datetime.date.today().isoformat()

    def set(self, *a, **k):
        self.harness.set(*a, **k)
        self.v.runner.harness_env = self.harness.env

    def inbox(self, **payload):
        return self.call("POST", "/api/inbox", payload)

    def process(self, agent="web", **more):
        return self.inbox(action="process", key=ITEM_KEY, agent=agent, **more)

    def reading(self):
        path = self.vault / "Reading notes" / "arxiv-2406.01234.md"
        return rft_reading.Note(path.read_text(encoding="utf-8")) if path.exists() else None

    def item(self):
        return rft_inbox.Inbox((self.vault / "Inbox.md").read_text(encoding="utf-8")).shown()[0]

    def write_mine(self):
        status, got = self.call("PUT", "/api/reading", {"key": ITEM_KEY, "text": MINE, "version": None})
        self.assertEqual(status, 200, got)

    def test_case_by_case_the_impression_and_the_brief_or_nothing(self):
        for case in CASES["process"]:
            (self.vault / "Inbox.md").write_text(INBOX, encoding="utf-8")
            shutil.rmtree(self.vault / "Reading notes", ignore_errors=True)
            before = self.files()
            status, got = self.v.save_process(ITEM_KEY, 0, case["answer"], "web", "2026-11-25")
            want = case["want"]
            if "error" in want:
                self.assertNotEqual(status, 200, case["name"])
                self.assertIn(want["error"], got["error"], case["name"])
                self.assertEqual(self.files(), before, case["name"])  # nothing is saved, not the half of it either
                continue
            self.assertEqual(status, 200, (case["name"], got))
            note = self.reading()
            self.assertEqual(note.impression, {"date": "2026-11-25", "text": "\n".join(want["impression"]), "by": "web"}, case["name"])
            self.assertEqual(self.item()["brief"], {"date": "2026-11-25", "lines": want["brief"]}, case["name"])
            after = self.files()
            self.assertEqual(sorted(k for k in after if after[k] != before.get(k)), ["Inbox.md", "Reading notes/arxiv-2406.01234.md"], case["name"])
            # every other line of the inbox is as it was
            self.assertEqual([l for l in after["Inbox.md"].decode().split("\n") if not l.startswith("  - ")], INBOX.split("\n"), case["name"])
        self.assertGreater(len([c for c in CASES["process"] if "error" in c["want"]]), 8)

    def test_a_harness_processes_an_item_with_no_chat_connected(self):
        self.set(GOOD["answer"])
        before = self.files()
        status, got = self.process()
        self.assertEqual(status, 200, got)
        self.assertEqual((got["asked"], got["agent"], got["item"]["task"]["state"]), (True, "web", "running"))
        task = self.wait(self.TASK)
        self.assertEqual((task.state, task.error), ("done", ""))
        (run,) = self.harness.runs
        self.assertEqual((run["argv"], run["cwd"]), (["--locked"], os.path.realpath(self.vault)))
        note = self.reading()
        self.assertEqual(note.impression, {"date": self.today, "text": "\n".join(GOOD["want"]["impression"]), "by": "web"})
        self.assertIn(f"## web's impression ({self.today})", note.text())
        self.assertEqual(self.item()["brief"], {"date": self.today, "lines": GOOD["want"]["brief"]})
        after = self.files()
        self.assertEqual(sorted(k for k in after if after[k] != before.get(k)), ["Inbox.md", "Reading notes/arxiv-2406.01234.md"])
        # the page reads the brief, that the note has an impression, and the task
        status, shown = self.call("GET", "/api/inbox")
        self.assertEqual((shown["items"][0]["brief"]["lines"], shown["notes"][ITEM_KEY]["impression"], shown["items"][0]["task"]["state"]), (GOOD["want"]["brief"], True, "done"))
        self.assertEqual(self.call("GET", f"/api/reading?key={urllib.parse.quote(ITEM_KEY)}")[1]["impression"]["by"], "web")

    def test_the_prompt_is_self_contained_and_never_holds_the_users_part(self):
        self.write_mine()
        self.set(GOOD["answer"])
        self.process()
        self.assertEqual(self.wait(self.TASK).state, "done")
        run = self.harness.runs[0]
        given = json.dumps(run)
        for secret in ("SECRET-OF-THE-USER", "The gain vanishes", "Same subset sizes"):
            self.assertNotIn(secret, given)
        prompt = run["stdin"]
        for part in ("Mixup at scale (https://arxiv.org/abs/2406.01234)", "maybe relevant to D01", "<impression>", "### Left open", "<brief>", "<unreadable>",
                     "Do not open the folder `Reading notes/` or the file `Inbox.md`", "Change no file", "aim for 2000 to 2500 characters", "Above 3000 characters nothing is saved"):
            self.assertIn(part, prompt)
        for word in ("rft_", "ToolSearch", "AskUserQuestion", "skill", "manual", self.tmp.name):
            self.assertNotIn(word, prompt)
        # and the user's part is as they wrote it, beside the agent's impression
        note = self.reading()
        self.assertEqual(note.mine, MINE)
        self.assertEqual(note.impression["by"], "web")

    def test_a_second_process_before_the_mark_rewrites_the_impression(self):
        self.set(GOOD["answer"])
        self.process()
        self.wait(self.TASK)
        self.set(GOOD["answer"].replace("Mixup still helps at ViT-H scale.", "Mixup helps, again."))
        self.assertEqual(self.process()[0], 200)
        self.assertEqual(self.wait(self.TASK).state, "done")
        note = self.reading()
        self.assertIn("Mixup helps, again.", note.impression["text"])
        self.assertEqual(note.text().count("impression ("), 1)
        self.assertEqual(len(self.item()["brief"]["lines"]), 3)

    def test_an_item_marked_as_read_keeps_its_impression(self):
        self.set(GOOD["answer"])
        self.process()
        self.wait(self.TASK)
        self.assertEqual(self.inbox(action="read", key=ITEM_KEY, read=True)[0], 200)
        before = self.files()
        status, got = self.process()
        self.assertEqual(status, 409)
        self.assertIn("frozen", got["error"])
        self.assertEqual(len(self.harness.runs), 1)
        self.assertEqual(self.files(), before)

    def test_marked_as_read_while_the_agent_was_reading_nothing_is_saved(self):
        self.set(GOOD["answer"])
        self.process()
        self.wait(self.TASK)
        first = self.files()
        self.set(GOOD["answer"].replace("Mixup still helps", "CHANGED"), sleep=0.7)
        self.process()
        self.assertEqual(self.inbox(action="read", key=ITEM_KEY, read=True)[0], 200)
        marked = self.files()
        task = self.wait(self.TASK)
        self.assertEqual(task.state, "failed")
        self.assertIn("frozen", task.error)
        self.assertEqual(self.files(), marked)
        self.assertNotIn(b"CHANGED", marked["Reading notes/arxiv-2406.01234.md"])

    def nothing_saved(self, says, state="failed"):
        before = self.files()
        status, got = self.process()
        self.assertEqual(status, 200, got)
        task = self.wait(self.TASK)
        self.assertEqual(task.state, state, task.error)
        self.assertIn(says, task.error)
        self.assertEqual(self.files(), before)
        shown = self.call("GET", "/api/inbox")[1]["items"][0]
        self.assertEqual(shown["task"]["state"], state)
        self.assertIn(says, shown["task"]["error"])
        self.assertIsNone(shown["brief"])

    def test_an_answer_missing_a_brief_line_saves_nothing_and_shows_why(self):
        self.set(next(c for c in CASES["process"] if c["name"].startswith("a brief of two lines"))["answer"])
        self.nothing_saved("a brief is three lines")

    def test_an_item_the_agent_could_not_read(self):
        self.set("<unreadable>The page asks for a login.</unreadable>")
        self.nothing_saved("web could not read the item: The page asks for a login.")

    def test_a_harness_that_fails_or_runs_out_of_time(self):
        self.set("boom", exit=1)
        self.nothing_saved("ended with an error (code 1): boom")
        self.set(GOOD["answer"], sleep=30)
        self.nothing_saved("web did not answer within 2 seconds. To give it longer, raise its Seconds for Process under Agents… (process_seconds in the setup file)")

    def test_cancelled_nothing_is_saved_and_one_task_per_item(self):
        self.set(GOOD["answer"], sleep=30)
        before = self.files()
        self.assertEqual(self.process()[0], 200)
        status, got = self.process()
        self.assertEqual(status, 409)
        self.assertIn("web is already answering", got["error"])
        status, got = self.inbox(action="cancel", key=ITEM_KEY)
        self.assertEqual(status, 200, got)
        self.assertEqual(self.wait(self.TASK).state, "cancelled")
        self.assertEqual(self.files(), before)
        self.assertEqual(self.inbox(action="cancel", key=ITEM_KEY)[0], 409)
        self.assertEqual(self.inbox(action="cancel", key="https://b.org/y")[0], 409)

    def test_only_a_harness_that_may_read_the_project_and_the_web_is_offered_process(self):
        agents = {a["name"]: a for a in self.call("GET", "/api/agents")[1]["agents"]}
        self.assertEqual([n for n, a in agents.items() if "process" in a["tasks"]], ["web"])
        self.assertIn("a model cannot fetch the item", agents["qwen"]["why_not"]["process"])
        self.assertIn('grant = "read"', agents["blind"]["why_not"]["process"])
        self.assertIn("web = true", agents["reader"]["why_not"]["process"])
        before = self.files()
        for name, says in (("qwen", "Process needs a harness"), ("blind", "may read the project"), ("reader", "read the web"), ("loose", "no locked command"), ("nobody", "is no agent")):
            status, got = self.process(name)
            self.assertEqual(status, 409, name)
            self.assertIn(says, got["error"], name)
        self.assertEqual((self.harness.runs, self.model.requests, self.files()), ([], [], before))

    def test_with_no_agent_named_and_no_default_it_is_the_chats_as_before(self):
        before = self.files()
        status, got = self.inbox(action="process", key=ITEM_KEY)
        self.assertEqual(status, 503)
        self.assertEqual(got["error"], "no Claude Code chat is connected: pick one of your agents (web), or run /rft in a chat")
        self.assertEqual(self.inbox(action="process", key=ITEM_KEY, agent="chat")[0], 503)
        self.assertEqual((self.harness.runs, self.files()), ([], before))

    def test_the_setups_default_processes_when_the_page_names_no_one(self):
        self.write_setup('[defaults]\nprocess = "web"\n' + self.AGENTS)
        self.set(GOOD["answer"])
        self.assertEqual(self.inbox(action="process", key=ITEM_KEY)[0], 200)
        self.assertEqual(self.wait(self.TASK).agent, "web")

    def test_discuss_still_needs_a_chat(self):
        self.set(GOOD["answer"])
        self.process()
        self.wait(self.TASK)
        status, got = self.inbox(action="read", key=ITEM_KEY, read=True)
        self.assertEqual(status, 200)
        self.assertEqual(got["waiting"], [ITEM_KEY])  # the mark is saved and the discussion waits for a chat
        status, got = self.inbox(action="discuss", key=ITEM_KEY, agent="web")
        self.assertEqual(status, 503)
        self.assertEqual(len(self.harness.runs), 1)

    def test_an_item_that_left_the_inbox_while_the_agent_was_reading(self):
        self.set(GOOD["answer"], sleep=0.6)
        self.process()
        self.assertEqual(self.inbox(action="discard", key=ITEM_KEY)[0], 200)
        left = self.files()
        task = self.wait(self.TASK)
        self.assertEqual(task.state, "failed")
        self.assertIn("no longer in the inbox", task.error)
        self.assertEqual(self.files(), left)


# What people read about agents is the guide's Agents page, in the guide's repository. Its example
# setup is loaded with this code, and the page checked against it, by that repository's
# scripts/check_agents.py (the test that stood here, moved with the text).


BY_HAND = """# my agents, kept by hand
[defaults]
thread = "qwen"   # the small one
process = "reader"

# a local model
[agents.qwen]
kind = "model"
url = "http://localhost:11434/v1"
model = "qwen3:14b"
thread_seconds = 30   # it is fast

# a harness of mine
[agents.reader]
kind = "harness"
run = ["tool", "{prompt}"]
locked = ["tool", "--read-only", "{prompt}"]
web = true
grant = "read"
"""


class EditSetupTest(unittest.TestCase):
    """The setup file changed from the page: one agent at a time, every other line kept."""

    def edit(self, text, name, fields, env=None):
        return rft_agents.edited(text, name, None if fields is None else rft_agents.checked_fields(fields), {} if env is None else env)

    def test_the_first_agent_makes_the_file(self):
        out = self.edit("", "qwen", {"kind": "model", "url": " http://localhost:11434/v1/ ", "model": "qwen3:14b"})
        self.assertTrue(out.startswith("# The agents you set up for rft"))
        self.assertTrue(out.endswith('\n[agents.qwen]\nkind = "model"\nurl = "http://localhost:11434/v1"\nmodel = "qwen3:14b"\n'))
        s = setup_of(out)
        self.assertEqual((s.errors, list(s.agents), s.agents["qwen"].tasks()), ([], ["qwen"], ["thread"]))

    def test_an_agent_added_leaves_every_line_there_was(self):
        out = self.edit(BY_HAND, "deep seek", {"kind": "model", "url": "https://api.deepseek.com/v1", "model": "deepseek-chat", "key": "DEEPSEEK_API_KEY"})
        self.assertTrue(out.startswith(BY_HAND))
        self.assertEqual(out[len(BY_HAND):], '\n[agents."deep seek"]\nkind = "model"\nurl = "https://api.deepseek.com/v1"\nmodel = "deepseek-chat"\nkey = "DEEPSEEK_API_KEY"\n')
        s = setup_of(out, env={"DEEPSEEK_API_KEY": "x"})
        self.assertEqual((s.errors, list(s.agents)), ([], ["qwen", "reader", "deep seek"]))
        # a ready-made harness, with its grant
        out = self.edit(out, "claude", {"kind": "claude-code", "grant": "read", "url": "ignored", "key": "IGNORED"})
        self.assertTrue(out.endswith('\n[agents.claude]\nkind = "claude-code"\ngrant = "read"\n'))
        self.assertEqual(setup_of(out).agents["claude"].tasks(), ["thread", "process"])

    def test_an_agent_changed_keeps_its_other_lines_and_everyone_elses(self):
        out = self.edit(BY_HAND, "qwen", {"kind": "model", "url": "http://localhost:11434/v1", "model": "qwen3:4b"})
        self.assertEqual(out, BY_HAND.replace('model = "qwen3:14b"', 'model = "qwen3:4b"'))  # the one word, and the comment and the limit stay
        self.assertEqual(setup_of(out).agents["qwen"].limits["thread"], 30)
        # saved again as it is, the file is the same
        self.assertEqual(self.edit(out, "qwen", {"kind": "model", "url": "http://localhost:11434/v1", "model": "qwen3:4b"}), out)

    def test_a_time_limit_from_the_form_is_written_changed_and_taken_out(self):
        model = {"kind": "model", "url": "http://localhost:11434/v1", "model": "qwen3:14b"}
        # given with a new agent, it is its last line; a model gets none for Process, which it cannot do
        out = self.edit("", "qwen", {**model, "thread_seconds": " 600 ", "process_seconds": "900"})
        self.assertTrue(out.endswith('\n[agents.qwen]\nkind = "model"\nurl = "http://localhost:11434/v1"\nmodel = "qwen3:14b"\nthread_seconds = 600\n'), out)
        self.assertEqual(setup_of(out).agents["qwen"].limits, {"thread": 600, "process": 600})
        # left empty, no line is written and the default holds
        out = self.edit("", "qwen", {**model, "thread_seconds": ""})
        self.assertNotIn("_seconds", out)
        self.assertEqual(setup_of(out).agents["qwen"].limits["thread"], 120)
        # a harness takes both
        out = self.edit("", "cc", {"kind": "claude-code", "grant": "read", "thread_seconds": 300, "process_seconds": "1800"})
        self.assertTrue(out.endswith('\n[agents.cc]\nkind = "claude-code"\ngrant = "read"\nthread_seconds = 300\nprocess_seconds = 1800\n'), out)
        self.assertEqual(setup_of(out).agents["cc"].limits, {"thread": 300, "process": 1800})
        # saved with the limit it already has, the file is the same: the line and its comment stay
        self.assertEqual(self.edit(BY_HAND, "qwen", {**model, "thread_seconds": "30"}), BY_HAND)
        # another limit: the one line changes
        out = self.edit(BY_HAND, "qwen", {**model, "thread_seconds": "600"})
        self.assertEqual(out, BY_HAND.replace("thread_seconds = 30   # it is fast", "thread_seconds = 600"))
        self.assertEqual(setup_of(out).agents["qwen"].limits["thread"], 600)
        # emptied: the line is taken out, the default is back, and nothing else moved
        out = self.edit(BY_HAND, "qwen", {**model, "thread_seconds": ""})
        self.assertEqual(out, BY_HAND.replace("thread_seconds = 30   # it is fast\n", ""))
        self.assertEqual(setup_of(out).agents["qwen"].limits["thread"], 120)
        # a limit for Process written by hand in a model's entry is not the form's to take out
        odd = BY_HAND.replace("thread_seconds = 30   # it is fast", "process_seconds = 700")
        self.assertEqual(self.edit(odd, "qwen", {**model, "thread_seconds": "", "process_seconds": ""}), odd)
        # what is no number of seconds is refused, in the form's own words
        for bad in ("0", "3601", "two minutes", "1.5", "-5", 0, 4000, 2.5, True, ["60"]):
            with self.assertRaises(rft_agents.SetupError, msg=repr(bad)) as got:
                self.edit(BY_HAND, "qwen", {**model, "thread_seconds": bad})
            self.assertIn("Seconds for a thread is a whole number from 1 to 3600, or empty for the default", str(got.exception), repr(bad))
        with self.assertRaises(rft_agents.SetupError) as got:
            self.edit("", "cc", {"kind": "claude-code", "grant": "read", "process_seconds": "soon"})
        self.assertIn("Seconds for Process is a whole number", str(got.exception))

    def test_an_agent_removed_takes_its_lines_and_its_default(self):
        out = self.edit(BY_HAND, "qwen", None)
        self.assertEqual(out, """# my agents, kept by hand
[defaults]
process = "reader"

# a harness of mine
[agents.reader]
kind = "harness"
run = ["tool", "{prompt}"]
locked = ["tool", "--read-only", "{prompt}"]
web = true
grant = "read"
""")
        s = setup_of(out)
        self.assertEqual((s.errors, list(s.agents), s.defaults), ([], ["reader"], {"process": "reader"}))
        with self.assertRaises(rft_agents.SetupError):
            self.edit(out, "qwen", None)

    def test_what_the_page_does_not_write(self):
        refused = {
            "a harness by its commands": ("mine", {"kind": "harness", "grant": "read"}, "written by hand"),
            "the chat's name": ("chat", {"kind": "model", "url": "http://localhost:1/v1", "model": "m"}, "is not \"chat\""),
            "a name of other characters": ("a/b", {"kind": "model", "url": "http://localhost:1/v1", "model": "m"}, "a name is"),
            "a key itself": ("x", {"kind": "model", "url": "https://a.example/v1", "model": "m", "key": "sk-abc.123"}, "NAME of the environment variable"),
            "no address": ("x", {"kind": "model", "model": "m"}, "needs url"),
            "no model": ("x", {"kind": "model", "url": "http://localhost:1/v1"}, "needs model"),
            "a grant that is none": ("x", {"kind": "codex", "grant": "all"}, "grant is one of"),
            "a name another agent has in other case": ("Qwen", {"kind": "model", "url": "http://localhost:1/v1", "model": "m"}, 'another agent is named "qwen"'),
        }
        for what, (name, fields, says) in refused.items():
            with self.assertRaises(rft_agents.SetupError, msg=what) as got:
                self.edit(BY_HAND, name, fields)
            self.assertIn(says, str(got.exception), what)

    def test_a_file_the_page_cannot_change_safely_is_left_alone(self):
        for what, text in {
            "agents as an inline table": 'agents = { qwen = { kind = "model", url = "http://localhost:1/v1", model = "m" } }\n',
            "an agent by dotted keys": '[agents]\nqwen.kind = "model"\nqwen.url = "http://localhost:1/v1"\nqwen.model = "m"\n',
            "not TOML": "[agents.qwen\nkind =\n",
        }.items():
            with self.assertRaises(rft_agents.SetupError, msg=what) as got:
                self.edit(text, "qwen", {"kind": "model", "url": "http://localhost:2/v1", "model": "n"})
            self.assertIn("edit it by hand", str(got.exception), what)
        # an entry that is wrong as written can be put right from the page, or taken out
        wrong = BY_HAND + '\n[agents.bad]\nkind = "model"\n'
        self.assertEqual(setup_of(wrong).errors[0]["name"], "bad")
        self.assertEqual(setup_of(self.edit(wrong, "bad", {"kind": "model", "url": "http://localhost:1/v1", "model": "m"})).errors, [])
        self.assertEqual(self.edit(wrong, "bad", None), BY_HAND)


class SetupRouteTest(Served):
    """POST api/agents: the form of the page."""

    AGENTS = None  # no setup file at all

    def write_setup(self, text):
        if text is not None:
            super().write_setup(text)

    def agents(self, **payload):
        return self.call("POST", "/api/agents", payload)

    def test_from_no_file_to_a_model_that_answers_a_thread(self):
        self.assertFalse(self.setup_file.exists())
        got = self.call("GET", "/api/agents")[1]
        self.assertEqual((got["found"], got["agents"], got["path"], got["kinds"]), (False, [], str(self.setup_file), ["model", "claude-code", "codex"]))
        vault_before = self.files()
        status, got = self.agents(action="models", url=self.model.url)
        self.assertEqual((status, got), (200, {"models": ["qwen3:14b", "qwen3:4b"]}))
        self.assertEqual(self.model.requests[-1]["path"], "/v1/models")
        status, got = self.agents(action="save", name="qwen", kind="model", url=self.model.url, model="qwen3:4b")
        self.assertEqual(status, 200, got)
        self.assertEqual(([a["name"] for a in got["agents"]], got["found"]), (["qwen"], True))
        self.assertEqual(oct(self.setup_file.stat().st_mode & 0o777), "0o600")  # the user's alone
        self.assertIn('model = "qwen3:4b"', self.setup_file.read_text())
        self.assertEqual(self.files(), vault_before)  # nothing of it is in the vault
        # and it answers a thread at once, with no restart
        status, got = self.comment(action="new", kind="comment", quote="Text of E02.", prefix="", suffix="", text="Is this right?")
        self.assertEqual(self.comment(action="ask", thread=got["threads"][-1]["id"], agent="qwen")[0], 200)
        self.assertEqual(self.wait().state, "done")
        self.assertEqual(self.model.requests[-1]["body"]["model"], "qwen3:4b")

    def test_the_form_reads_an_entry_changes_it_and_removes_it(self):
        self.agents(action="save", name="far", kind="model", url="https://api.example.com/v1", model="big", key="TEST_KEY")
        self.assertEqual(self.agents(action="entry", name="far"), (200, {"name": "far", "kind": "model", "url": "https://api.example.com/v1", "model": "big", "key": "TEST_KEY", "grant": "text", "by_hand": False, "thread_seconds": "", "process_seconds": ""}))
        self.assertNotIn("sk-secret", self.setup_file.read_text())
        told = json.dumps(self.call("GET", "/api/agents")[1])
        self.assertNotIn("TEST_KEY", told)   # the list never names the variable; the form's own read does
        self.agents(action="save", name="cc", kind="claude-code", grant="read", model="opus")
        self.assertEqual(self.agents(action="entry", name="cc")[1], {"name": "cc", "kind": "claude-code", "url": "", "model": "opus", "key": "", "grant": "read", "by_hand": False, "thread_seconds": "", "process_seconds": ""})
        # a time limit: saved from the form, told to the list, read back by the form, and taken out when emptied
        status, got = self.agents(action="save", name="cc", kind="claude-code", grant="read", model="opus", thread_seconds="300", process_seconds="")
        self.assertEqual((status, got["limits"], got["max_limit"], [a["limits"] for a in got["agents"]]), (200, {"thread": 120, "process": 600}, 3600, [{"thread": 120, "process": 600}, {"thread": 300, "process": 600}]))
        self.assertIn("thread_seconds = 300\n", self.setup_file.read_text())
        self.assertEqual([self.agents(action="entry", name="cc")[1][k] for k in ("thread_seconds", "process_seconds")], [300, ""])
        # a page from before the limits were the form's sends none: the line stays
        self.agents(action="save", name="cc", kind="claude-code", grant="read", model="opus")
        self.assertIn("thread_seconds = 300\n", self.setup_file.read_text())
        status, got = self.agents(action="save", name="cc", kind="claude-code", grant="read", model="opus", thread_seconds="4000")
        self.assertEqual((status, "Seconds for a thread is a whole number from 1 to 3600" in got["error"]), (422, True))
        self.agents(action="save", name="cc", kind="claude-code", grant="read", model="opus", thread_seconds="", process_seconds="")
        self.assertNotIn("_seconds", self.setup_file.read_text())
        status, got = self.agents(action="save", name="far", kind="model", url="https://api.example.com/v1", model="bigger", key="TEST_KEY")
        self.assertEqual((status, [a["model"] for a in got["agents"]]), (200, ["bigger", ""]))
        status, got = self.agents(action="remove", name="far")
        self.assertEqual((status, [a["name"] for a in got["agents"]]), (200, ["cc"]))
        self.assertEqual(self.agents(action="entry", name="far")[0], 404)
        self.assertEqual(self.agents(action="remove", name="far")[0], 422)

    def test_what_is_refused_leaves_the_file_as_it_was(self):
        self.agents(action="save", name="qwen", kind="model", url=self.model.url, model="qwen3:4b")
        before = self.setup_file.read_bytes()
        for payload, status, says in (
            (dict(action="save", name="x", kind="model", url=self.model.url, model="m", key="sk-abc.123"), 422, "NAME of the environment variable"),
            (dict(action="save", name="x", kind="harness", grant="change"), 422, "written by hand"),
            (dict(action="save", name="chat", kind="model", url=self.model.url, model="m"), 422, "chat"),
            (dict(action="save", name=3), 400, "expected"),
            (dict(action="burn", name="qwen"), 400, "action must be"),
            (dict(action="models", url="ftp://x"), 502, "address"),
            (dict(action="models", url="http://127.0.0.1:1/v1"), 502, "nothing answers at 127.0.0.1:1"),
            (dict(action="models", url=self.model.url, key="NOT_SET_ANYWHERE"), 502, "NOT_SET_ANYWHERE is not set"),
        ):
            got = self.agents(**payload)
            self.assertEqual(got[0], status, payload)
            self.assertIn(says, got[1]["error"], payload)
            self.assertEqual(self.setup_file.read_bytes(), before, payload)

    def test_only_the_page_with_the_key_changes_the_setup(self):
        body = json.dumps({"action": "save", "name": "qwen", "kind": "model", "url": self.model.url, "model": "m"}).encode()
        for headers in ({"Content-Type": "application/json", "Origin": f"http://127.0.0.1:{self.port}"},                       # no key
                        {"Content-Type": "application/json", "Origin": "http://evil.example", "X-RFT-Token": KEY},            # another page
                        {"Content-Type": "application/json", "X-RFT-Token": "wrong", "Origin": f"http://127.0.0.1:{self.port}"}):
            req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/agents", data=body, headers=headers, method="POST")
            with self.assertRaises(urllib.error.HTTPError) as got:
                urllib.request.urlopen(req, timeout=5)
            self.assertEqual(got.exception.code, 403)
        self.assertFalse(self.setup_file.exists())
        self.assertEqual(self.model.requests, [])


if __name__ == "__main__":
    unittest.main()
