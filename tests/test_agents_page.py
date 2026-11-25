"""The agents in the page (.scratch/agents), by real clicks in headless Chromium with the server
behind it: with no setup the page is the one it was and its requests name no agent; with a setup
the picker lists who may take a task and says where each runs, a model answers a thread and a
harness processes an item, each signed; served from a terminal with no chat, the chat is not
offered; and the picker fits a phone. The model and the harness are the tests' fakes
(tests/agents_fakes.py). It needs Chromium (Playwright's, or RFT_CHROME) and the websocket-client
module, and skips without them. RFT_AGENTS_SHOTS=<dir> also saves a screenshot of each step.

    python3 -m unittest tests.test_agents_page -v
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_phone  # noqa: E402
from agents_fakes import HARNESS, FakeHarness, FakeModel  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
CASES = json.loads((ROOT / "tests" / "fixtures" / "agents" / "cases.json").read_text(encoding="utf-8"))
GOOD = next(c for c in CASES["process"] if "error" not in c["want"])
URL = re.compile(r"http://127\.0\.0\.1:\d+/\?token=[\w-]+")
QUOTE = "The starting question of the project."
THREAD = {"id": "c1", "kind": "comment", "state": "open", "quote": QUOTE, "prefix": "", "suffix": "", "replacement": None, "asked": None,
          "messages": [{"by": "you", "at": "2026-11-25 10:02", "text": "Is it still the question?"}], "closed": None}
SETUP = """
[agents.qwen]
kind = "model"
url = "MODEL_URL"
model = "qwen3:14b"

[agents.far]
kind = "model"
url = "https://api.example.com/v1"
model = "big"
key = "RFT_TEST_NO_SUCH_KEY"

[agents.reader]
kind = "harness"
run = [PY, HARNESS]
locked = [PY, HARNESS, "--locked"]
web = true
grant = "read"
"""
PICK = "(() => { const s = document.querySelector(%s + ' .agent-pick select'); return s && { value: s.value, options: [...s.options].map(o => [o.value, o.disabled, o.textContent]), where: s.parentElement.querySelector('.agent-where').textContent } })()"
ROW = "[...document.querySelectorAll('#inbox-list .inbox-item')].find(li => li.dataset.key.includes('%s'))"
SENT = "window.sent.filter(r => r.url.includes(%s)).map(r => JSON.parse(r.body))"


@unittest.skipUnless(test_phone.CHROME and test_phone.websocket, "needs Chromium (Playwright's, or RFT_CHROME) and websocket-client")
class AgentsPage(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="rft-agents-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.vault = self.tmp / "vault"
        test_phone.demo_vault(self.vault)
        (self.vault / ".comments").mkdir(exist_ok=True)
        (self.vault / ".comments" / "D00.json").write_text(json.dumps({"note": "D00", "next": 2, "threads": [THREAD]}))
        self.model = FakeModel("Yes, it still is.")
        self.addCleanup(self.model.close)
        self.harness = FakeHarness(self.tmp / "harness", GOOD["answer"])
        self.setup_file = self.tmp / "agents.toml"
        self.shots = os.environ.get("RFT_AGENTS_SHOTS")
        self.n = 0
        self.lines = []

    def serve(self, setup=None, terminal=False):
        if setup is not None:
            self.setup_file.write_text(setup.replace("MODEL_URL", self.model.url).replace("PY", json.dumps(sys.executable)).replace("HARNESS", json.dumps(str(HARNESS))))
        env = {**os.environ, **self.harness.env, "RFT_AGENTS": str(self.setup_file), "XDG_CACHE_HOME": str(self.tmp / "cache")}
        env.pop("RFT_TEST_NO_SUCH_KEY", None)
        args = [sys.executable, str(ROOT / "server" / "rft_server.py"), "--vault", str(self.vault), "--web", str(ROOT / "web"), "--port", "0", "--project", "demo", "--no-watch"]
        self.server = subprocess.Popen(args + (["--terminal"] if terminal else []), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
        self.addCleanup(self.server.wait, 10)
        self.addCleanup(self.server.terminate)
        url = None
        while url is None:
            line = self.server.stdout.readline()
            self.assertTrue(line, "the server said no address")
            m = URL.search(line)
            url = m.group(0) if m else None
        # what the server says afterwards (what it asks of the session) is kept
        threading.Thread(target=lambda: self.lines.extend(iter(self.server.stdout.readline, "")), daemon=True).start()
        (self.tmp / "profile").mkdir(exist_ok=True)
        self.b = test_phone.Browser(self.tmp / "profile")
        self.addCleanup(self.b.close)
        self.b.call("Emulation.setDeviceMetricsOverride", width=1500, height=900, deviceScaleFactor=1, mobile=False)
        self.b.open(url)
        # every write the page sends is kept, as it was sent
        self.b.js("window.sent = []; (() => { const f = window.fetch; window.fetch = (u, o) => { if (o && o.body) window.sent.push({ url: String(u), body: o.body }); return f(u, o) } })()")
        return url

    def shot(self, name):
        if self.shots:
            self.n += 1
            Path(self.shots).mkdir(parents=True, exist_ok=True)
            self.b.shot(Path(self.shots) / f"{self.n:02d}-{name}.png")

    def open_note(self):
        self.b.js(test_phone.page("tree"))
        self.b.js(test_phone.tap_node("D00"))
        self.assertTrue(self.b.wait("!!document.querySelector('#threads .thread[data-thread=c1] [data-act=ask]')"), "the thread did not draw")

    def open_inbox(self):
        self.b.js("document.getElementById('inbox-toggle').click()")
        self.assertTrue(self.b.wait("document.querySelectorAll('#inbox-list .inbox-process').length > 0"), "the inbox did not draw")

    def threads(self):
        return json.loads((self.vault / ".comments" / "D00.json").read_text())["threads"]

    def test_with_no_setup_the_page_is_as_it_was_and_names_no_agent(self):
        self.serve()
        b = self.b
        self.open_note()
        self.assertEqual(b.js("document.querySelectorAll('.agent-pick').length"), 0)
        # one small way into the setup, and nothing else of agents
        self.assertEqual(b.js("[...document.querySelectorAll('#threads .agent-open')].map(e => e.textContent)"), ["Set up an agent"])
        self.assertEqual(b.js("document.querySelector('#threads [data-act=ask]').getAttribute('aria-label')"), "Ask Claude")
        b.js("document.querySelector('#threads [data-act=ask]').click()")
        self.assertTrue(b.wait("window.sent.some(r => r.url.includes('api/comment'))"))
        self.assertEqual(b.js(SENT % "'api/comment'"), [{"id": "D00", "thread": "c1", "action": "ask"}])
        self.assertTrue(b.wait("!!document.querySelector('#threads .t-asked')"))
        self.assertIn("Claude is answering", b.js("document.querySelector('#threads .t-asked').textContent"))
        self.assertEqual(b.js("!!document.querySelector('#threads [data-act=cancel]')"), False)  # the chat's turn is not the server's to stop
        self.open_inbox()
        self.assertEqual(b.js("document.querySelectorAll('.agent-pick').length"), 0)
        b.js(ROW % "arxiv:2406.01234" + ".querySelector('.inbox-process').click()")
        self.assertTrue(b.wait("window.sent.some(r => r.url.includes('api/inbox'))"))
        self.assertEqual(b.js(SENT % "'api/inbox'"), [{"action": "process", "key": "arxiv:2406.01234", "nth": 0}])
        # both went to the session, as before
        import time
        end = time.time() + 5
        while time.time() < end and not any(line.startswith("RFT_PROCESS ") for line in self.lines):
            time.sleep(0.05)
        self.assertEqual([line.split(" ", 1)[0] for line in self.lines], ["RFT_ASK", "RFT_PROCESS"])
        self.assertEqual([json.loads(line.split(" ", 1)[1]) for line in self.lines], [{"id": "D00", "thread": "c1"}, {"key": "arxiv:2406.01234", "nth": 0}])
        self.assertEqual((self.model.requests, self.harness.runs, b.errors), ([], [], []))
        self.shot("no-setup")

    def type(self, selector, text):
        self.b.js("(() => { const e = document.querySelector(%s); e.focus(); e.value = %s; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })) })()" % (json.dumps(selector), json.dumps(text)))

    FIELD = "dialog.agent-setup .agent-field:nth-of-type(%d) %s"

    def test_from_no_setup_a_model_is_added_in_the_page_and_answers(self):
        self.serve()
        b = self.b
        self.assertFalse(self.setup_file.exists())
        self.open_note()
        b.js("document.querySelector('#threads .agent-open').click()")
        self.assertTrue(b.wait("!!document.querySelector('dialog.agent-setup[open]')"), "no dialog")
        # nothing is prefilled: where the model is, is the user's to say
        self.assertEqual(b.js("[...document.querySelectorAll('dialog.agent-setup input')].map(i => i.value)"), ["", "", "", ""])
        self.assertEqual(b.js("[...document.querySelectorAll('dialog.agent-setup .agent-form select')][0].value"), "model")
        self.shot("dialog-empty")
        # a list asked before the address is said
        b.js("[...document.querySelectorAll('dialog.agent-setup button')].find(x => x.textContent === 'List its models').click()")
        self.assertTrue(b.wait("document.querySelector('dialog.agent-setup .agent-msg').textContent.includes('Say where the model is first')"))
        self.type(self.FIELD % (1, "input"), "qwen")
        self.type(self.FIELD % (3, "input"), self.model.url)
        b.js("[...document.querySelectorAll('dialog.agent-setup button')].find(x => x.textContent === 'List its models').click()")
        self.assertTrue(b.wait("document.querySelectorAll('#agent-models option').length === 2"), b.js("document.querySelector('dialog.agent-setup .agent-msg').textContent"))
        self.assertIn("It has 2: qwen3:14b, qwen3:4b", b.js("document.querySelector('dialog.agent-setup .agent-msg').textContent"))
        self.type(self.FIELD % (5, "input"), "qwen3:4b")
        self.shot("dialog-filled")
        b.js("document.querySelector('dialog.agent-setup button[type=submit]').click()")
        self.assertTrue(b.wait("document.querySelectorAll('dialog.agent-setup .agent-list li').length === 1"), b.js("document.querySelector('dialog.agent-setup .agent-msg').textContent"))
        self.assertIn("qwen is saved in", b.js("document.querySelector('dialog.agent-setup .agent-msg').textContent"))
        self.assertIn("model qwen3:4b · text only · runs on this machine", b.js("document.querySelector('dialog.agent-setup .agent-list li').textContent"))
        written = self.setup_file.read_text()
        self.assertTrue(written.endswith(f'[agents.qwen]\nkind = "model"\nurl = "{self.model.url}"\nmodel = "qwen3:4b"\n'), written)
        self.shot("dialog-saved")
        # a key itself is refused, in the form's own words, and the file stays
        self.type(self.FIELD % (1, "input"), "far")
        self.type(self.FIELD % (3, "input"), "https://api.example.com/v1")
        self.type(self.FIELD % (4, "input"), "sk-abc.123")
        self.type(self.FIELD % (5, "input"), "big")
        b.js("document.querySelector('dialog.agent-setup button[type=submit]').click()")
        self.assertTrue(b.wait("document.querySelector('dialog.agent-setup .agent-msg').textContent.includes('NAME of the environment variable')"))
        self.assertEqual(self.setup_file.read_text(), written)
        # its variable's name is taken; not set, the agent is saved and out of reach, saying why
        self.type(self.FIELD % (4, "input"), "RFT_TEST_NO_SUCH_KEY")
        b.js("document.querySelector('dialog.agent-setup button[type=submit]').click()")
        self.assertTrue(b.wait("document.querySelectorAll('dialog.agent-setup .agent-list li').length === 2"))
        self.assertIn("the environment variable RFT_TEST_NO_SUCH_KEY is not set", b.js("document.querySelectorAll('dialog.agent-setup .agent-list li')[1].textContent"))
        # changed: another model of the same endpoint
        b.js("[...document.querySelectorAll('dialog.agent-setup .agent-list li')][0].querySelector('button').click()")
        self.assertTrue(b.wait("document.querySelector(%s).value === 'qwen3:4b'" % json.dumps(self.FIELD % (5, "input"))))
        self.assertEqual(b.js("document.querySelector(%s).value" % json.dumps(self.FIELD % (3, "input"))), self.model.url)
        self.type(self.FIELD % (5, "input"), "qwen3:14b")
        b.js("document.querySelector('dialog.agent-setup button[type=submit]').click()")
        self.assertTrue(b.wait("document.querySelector('dialog.agent-setup .agent-list li').textContent.includes('model qwen3:14b')"))
        self.assertIn('model = "qwen3:14b"', self.setup_file.read_text())
        # removed, by two presses
        b.js("[...document.querySelectorAll('dialog.agent-setup .agent-list li')][1].querySelectorAll('button')[1].click()")
        self.assertEqual(b.js("document.querySelectorAll('dialog.agent-setup .agent-list li').length"), 2)
        b.js("[...document.querySelectorAll('dialog.agent-setup .agent-list li')][1].querySelectorAll('button')[1].click()")
        self.assertTrue(b.wait("document.querySelectorAll('dialog.agent-setup .agent-list li').length === 1"))
        self.assertNotIn("far", self.setup_file.read_text())
        b.js("document.querySelector('dialog.agent-setup .agent-head button').click()")
        # the picker is there now, and the model answers
        self.assertTrue(b.wait("!!document.querySelector('#threads .agent-pick select')"), "no picker after the setup")
        b.js("(() => { const s = document.querySelector('#threads .agent-pick select'); s.value = 'qwen'; s.dispatchEvent(new Event('change', { bubbles: true })) })()")
        b.js("document.querySelector('#threads [data-act=ask]').click()")
        self.assertTrue(b.wait("[...document.querySelectorAll('#threads .thread[data-thread=c1] .t-who')].some(w => w.textContent.startsWith('qwen'))", 15), "qwen's reply did not show")
        self.assertEqual(self.model.requests[-1]["body"]["model"], "qwen3:14b")
        self.assertEqual(b.errors, [])
        self.shot("after-setup")

    def test_the_setup_on_a_phone(self):
        self.serve()
        b = self.b
        b.size(360, 740)
        b.js("location.reload()")
        b.wait(test_phone.READY)
        b.js(test_phone.page("tree"))
        b.js(test_phone.tap_node("D00"))
        self.assertTrue(b.wait("!!document.querySelector('#threads .agent-open')"), "no way into the setup on the phone")
        b.js("document.querySelector('#threads .agent-open').click()")
        self.assertTrue(b.wait("!!document.querySelector('dialog.agent-setup[open]')"))
        box = b.js("(() => { const d = document.querySelector('dialog.agent-setup').getBoundingClientRect(); const small = [...document.querySelectorAll('dialog.agent-setup input, dialog.agent-setup select, dialog.agent-setup button')].filter(e => e.offsetParent && e.getBoundingClientRect().height < 44).map(e => e.textContent || e.placeholder); return [d.left, d.right, small, document.documentElement.scrollWidth] })()")
        self.assertGreaterEqual(box[0], 0)
        self.assertLessEqual(box[1], 360)
        self.assertEqual(box[2], [])
        self.assertLessEqual(box[3], 360)
        self.shot("phone-dialog")

    def test_a_model_answers_a_thread_picked_beside_the_buttons(self):
        self.serve(SETUP)
        b = self.b
        self.open_note()
        self.assertTrue(b.wait("!!document.querySelector('#threads .agent-pick select')"), "no picker")
        pick = b.js(PICK % "'#threads'")
        # a chat is connected: it is the default, and today's wording stays
        self.assertEqual(pick["value"], "chat")
        self.assertEqual([(o[0], o[1]) for o in pick["options"]], [("chat", False), ("qwen", False), ("far", True), ("reader", False)])
        self.assertIn("RFT_TEST_NO_SUCH_KEY is not set", pick["options"][2][2])
        self.assertEqual(b.js("document.querySelector('#threads [data-act=ask]').getAttribute('aria-label')"), "Ask Claude")
        self.shot("picker")
        b.js("(() => { const s = document.querySelector('#threads .agent-pick select'); s.value = 'qwen'; s.dispatchEvent(new Event('change', { bubbles: true })) })()")
        self.assertEqual(b.js(PICK % "'#threads'")["where"], "runs on this machine")
        self.assertEqual(b.js("document.querySelector('#threads [data-act=ask]').getAttribute('aria-label')"), "Ask qwen")
        b.js("document.querySelector('#threads [data-act=ask]').click()")
        self.assertTrue(b.wait("[...document.querySelectorAll('#threads .thread[data-thread=c1] .t-who')].some(w => w.textContent.startsWith('qwen'))", 15), "qwen's reply did not show")
        self.assertEqual(b.js(SENT % "'api/comment'"), [{"id": "D00", "thread": "c1", "action": "ask", "agent": "qwen"}])
        self.assertIn("Yes, it still is.", b.js("document.querySelector('#threads .thread[data-thread=c1] .t-msgs').textContent"))
        last = self.threads()[0]["messages"][-1]
        self.assertEqual((last["agent"], last["text"]), ("qwen", "Yes, it still is."))
        self.assertIn(QUOTE, self.model.prompts[0])
        self.assertFalse(any(line.startswith("RFT_ASK ") for line in self.lines))  # the chat was not asked
        # the pick is kept for the next thread and the next visit
        b.js("location.reload()")
        b.wait(test_phone.READY)
        self.open_note()
        self.assertTrue(b.wait("document.querySelector('#threads .agent-pick select') && document.querySelector('#threads .agent-pick select').value === 'qwen'"))
        self.assertEqual(b.errors, [])
        self.shot("answered")

    def test_a_model_that_fails_says_why_on_the_thread(self):
        self.serve(SETUP)
        b = self.b
        self.model.status, self.model.answer = 500, '{"error": {"message": "out of memory"}}'
        b.js("localStorage.setItem('rft-agent-thread', 'qwen')")
        self.open_note()
        self.assertTrue(b.wait("document.querySelector('#threads [data-act=ask]').getAttribute('aria-label') === 'Ask qwen'"))
        b.js("document.querySelector('#threads [data-act=ask]').click()")
        self.assertTrue(b.wait("(document.querySelector('#threads .thread[data-thread=c1] .t-error') || {}).textContent"), "no failure shown")
        self.assertIn("Not answered: qwen answered 500: out of memory", b.js("document.querySelector('#threads .thread[data-thread=c1] .t-error').textContent"))
        self.assertEqual(len(self.threads()[0]["messages"]), 1)
        self.shot("failed")

    def test_a_running_task_is_shown_and_cancelled(self):
        self.serve(SETUP)
        b = self.b
        self.model.delay = 20
        b.js("localStorage.setItem('rft-agent-thread', 'qwen')")
        self.open_note()
        self.assertTrue(b.wait("document.querySelector('#threads [data-act=ask]').getAttribute('aria-label') === 'Ask qwen'"))
        b.js("document.querySelector('#threads [data-act=ask]').click()")
        self.assertTrue(b.wait("!!document.querySelector('#threads [data-act=cancel]')"), "no Cancel")
        self.assertIn("qwen is answering", b.js("document.querySelector('#threads .t-asked').textContent"))
        self.shot("running")
        b.js("document.querySelector('#threads [data-act=cancel]').click()")
        self.assertTrue(b.wait("!document.querySelector('#threads .t-asked')"), "still shown as answering")
        t = self.threads()[0]
        self.assertEqual((len(t["messages"]), t["asked"]), (1, None))

    def test_a_harness_processes_an_item_and_a_model_is_not_offered(self):
        self.serve(SETUP)
        b = self.b
        self.open_inbox()
        self.assertTrue(b.wait("!!document.querySelector('#inbox .agent-pick select')"), "no picker")
        pick = b.js(PICK % "'#inbox'")
        self.assertEqual([(o[0], o[1]) for o in pick["options"]], [("chat", False), ("qwen", True), ("far", True), ("reader", False)])
        self.assertIn("Process needs a harness", pick["options"][1][2])
        b.js("(() => { const s = document.querySelector('#inbox .agent-pick select'); s.value = 'reader'; s.dispatchEvent(new Event('change', { bubbles: true })) })()")
        self.assertEqual(b.js(PICK % "'#inbox'")["where"], "runs here, sends text to its provider")
        # the second item: it has no brief yet
        row = ROW % "lilianweng"
        self.assertEqual(b.js(row + ".querySelector('.inbox-briefed') === null"), True)
        b.js(row + ".querySelector('.inbox-process').click()")
        self.assertTrue(b.wait(row + ".querySelector('.inbox-briefed') !== null", 15), "no brief shown")
        sent = b.js(SENT % "'api/inbox'")
        self.assertEqual((sent[0]["action"], sent[0]["agent"]), ("process", "reader"))
        inbox = (self.vault / "Inbox.md").read_text()
        self.assertIn("briefed", inbox.split("lilianweng")[1].split("\n- ")[0])
        notes = list((self.vault / "Reading notes").glob("*.md"))
        self.assertEqual(len(notes), 1)
        self.assertIn("## reader's impression (", notes[0].read_text())
        self.assertEqual(self.harness.runs[0]["argv"], ["--locked"])
        self.assertFalse(any(line.startswith("RFT_PROCESS ") for line in self.lines))
        # the reading note's view says whose impression it is
        b.js(row + ".querySelector('.inbox-note').click()")
        self.assertTrue(b.wait("[...document.querySelectorAll('#reading *')].some(e => e.children.length === 0 && e.textContent.startsWith(\"reader's impression\"))"), "the impression is not said to be reader's")
        self.assertEqual(b.errors, [])
        self.shot("processed")

    def test_from_a_terminal_with_no_chat_the_chat_is_not_offered(self):
        self.serve(SETUP, terminal=True)
        b = self.b
        self.open_note()
        self.assertTrue(b.wait("!!document.querySelector('#threads .agent-pick select')"), "no picker")
        pick = b.js(PICK % "'#threads'")
        self.assertEqual((pick["value"], pick["options"][0][:2]), ("qwen", ["chat", True]))
        self.assertIn("no Claude Code chat is connected", pick["options"][0][2])
        b.js("document.querySelector('#threads [data-act=ask]').click()")
        self.assertTrue(b.wait("[...document.querySelectorAll('#threads .thread[data-thread=c1] .t-who')].some(w => w.textContent.startsWith('qwen'))", 15), "qwen's reply did not show")
        self.open_inbox()
        self.assertEqual(b.js(PICK % "'#inbox'")["value"], "reader")
        self.shot("terminal")

    def test_the_picker_on_a_phone(self):
        self.serve(SETUP)
        b = self.b
        b.size(360, 740)
        b.js("location.reload()")
        b.wait(test_phone.READY)
        b.js(test_phone.page("tree"))
        b.js(test_phone.tap_node("D00"))
        self.assertTrue(b.wait("!!document.querySelector('#threads .agent-pick select')"), "no picker on the phone")
        box = b.js("(() => { const s = document.querySelector('#threads .agent-pick select'); s.scrollIntoView(); const r = s.getBoundingClientRect(); return [r.left, r.right, r.height, parseFloat(getComputedStyle(s).fontSize), document.documentElement.scrollWidth] })()")
        self.assertGreaterEqual(box[0], 0)
        self.assertLessEqual(box[1], 360)
        self.assertGreaterEqual(box[2], 44)   # a finger's target
        self.assertGreaterEqual(box[3], 16)   # no zoom on focus
        self.assertLessEqual(box[4], 360)     # nothing wider than the screen
        self.shot("phone-thread")
        b.js("document.getElementById('drawer-close') && document.getElementById('drawer-close').click()")
        b.js("document.getElementById('inbox-toggle').click()")
        self.assertTrue(b.wait("!!document.querySelector('#inbox .agent-pick select')"), "no picker in the inbox on the phone")
        box = b.js("(() => { const r = document.querySelector('#inbox .agent-pick select').getBoundingClientRect(); return [r.left, r.right, r.height, document.documentElement.scrollWidth] })()")
        self.assertTrue(box[0] >= 0 and box[1] <= 360 and box[2] >= 44 and box[3] <= 360, box)
        self.shot("phone-inbox")


if __name__ == "__main__":
    unittest.main()
