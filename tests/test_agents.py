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
        self.assertEqual(self.files(), before)
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


if __name__ == "__main__":
    unittest.main()
