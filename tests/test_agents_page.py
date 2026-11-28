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
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import procs  # noqa: E402
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
        self.tmp = procs.folder("rft-agents-")
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
        self.server = procs.start(args + (["--terminal"] if terminal else []), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
        self.addCleanup(procs.stop, self.server)
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
        # beside the thread, one small way into the setup, and nothing else of agents there
        self.assertEqual(b.js("[...document.querySelectorAll('#threads .agent-open')].map(e => e.textContent)"), ["Set up an agent"])
        self.assertEqual(b.js("document.querySelector('#threads [data-act=ask]').getAttribute('aria-label')"), "Ask Claude")
        self.compose("comment")
        self.assertEqual(b.js("[document.getElementById('composer-agent').hidden, document.getElementById('composer-ask').textContent]"), [True, "Post and ask Claude"])
        b.js("document.getElementById('composer-cancel').click()")
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
        self.assertEqual(b.js("[...document.querySelectorAll('dialog.agent-setup input')].map(i => i.value)"), ["", "", "", "", "", ""])
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

    def test_how_long_an_agent_has_is_set_in_the_form(self):
        self.serve(SETUP)
        b = self.b
        self.open_note()
        b.js("document.getElementById('agents-open').click()")
        self.assertTrue(b.wait("!!document.querySelector('dialog.agent-setup[open]')"), "no dialog")
        shown = "[7, 8].map(n => { const l = document.querySelector('dialog.agent-setup .agent-field:nth-of-type(' + n + ')'); return [l.querySelector('span').textContent, l.hidden, l.querySelector('input').value, l.querySelector('input').placeholder] })"
        empty = [["Seconds for a thread", False, "", "120 (the default)"], ["Seconds for Process", True, "", "600 (the default)"]]
        limit = json.dumps(self.FIELD % (7, "input"))
        row = "[...document.querySelectorAll('dialog.agent-setup .agent-list li')].find(li => li.querySelector('.agent-name').textContent === 'qwen')"
        save = "document.querySelector('dialog.agent-setup button[type=submit]').click()"
        # a new agent: a model has a time for a thread and none for Process, and nothing is filled in
        self.assertEqual(b.js(shown), empty)
        b.js("(() => { const s = document.querySelector('dialog.agent-setup .agent-form select'); s.value = 'claude-code'; s.dispatchEvent(new Event('change', { bubbles: true })) })()")
        self.assertEqual([r[1] for r in b.js(shown)], [False, False])
        # qwen is given ten minutes for a thread
        b.js(row + ".querySelector('button').click()")
        self.assertTrue(b.wait("document.querySelector(%s).value === 'qwen3:14b'" % json.dumps(self.FIELD % (5, "input"))), "the entry did not come")
        self.assertEqual(b.js(shown), empty)
        self.type(self.FIELD % (7, "input"), "600")
        self.shot("limit-filled")
        b.js(save)
        self.assertTrue(b.wait("document.querySelector('dialog.agent-setup .agent-msg').textContent.includes('qwen is saved in')"), b.js("document.querySelector('dialog.agent-setup .agent-msg').textContent"))
        self.assertIn('model = "qwen3:14b"\nthread_seconds = 600\n', self.setup_file.read_text())
        self.assertIn("model qwen3:14b · text only · runs on this machine · 600 s for a thread", b.js(row + ".textContent"))
        # a model's save says nothing of Process
        self.assertEqual(b.js(SENT % "'api/agents'")[-1], {"action": "save", "name": "qwen", "kind": "model", "url": self.model.url, "key": "", "model": "qwen3:14b", "grant": "text", "thread_seconds": "600"})
        self.shot("limit-saved")
        # the form shows it again, and emptied it is the default again
        b.js(row + ".querySelector('button').click()")
        self.assertTrue(b.wait("document.querySelector(%s).value === '600'" % limit), "the limit did not come back")
        self.type(self.FIELD % (7, "input"), "")
        b.js(save)
        self.assertTrue(b.wait("!%s.textContent.includes('s for a thread')" % row), "the limit is still said")
        self.assertNotIn("_seconds", self.setup_file.read_text())
        # what is no number of seconds the browser itself refuses: nothing is sent, and the file stays
        before, sent = self.setup_file.read_text(), len(b.js(SENT % "'api/agents'"))
        b.js(row + ".querySelector('button').click()")
        self.assertTrue(b.wait("document.querySelector(%s).value === 'qwen3:14b'" % json.dumps(self.FIELD % (5, "input"))))
        self.type(self.FIELD % (7, "input"), "4000")
        self.assertTrue(b.js("document.querySelector(%s).validity.rangeOverflow" % limit))
        b.js(save)
        import time
        time.sleep(0.5)
        self.assertEqual((self.setup_file.read_text(), len(b.js(SENT % "'api/agents'")) - sent), (before, 1))  # the one request: the entry read for the form
        self.assertEqual(b.errors, [])

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

    ENTRY = "(() => { const e = document.getElementById('agents-open'), r = e.getBoundingClientRect(); return { text: e.textContent, seen: r.width > 0 && r.height > 0 && getComputedStyle(e).visibility === 'visible', left: r.left, right: r.right, height: r.height } })()"

    def test_a_standing_way_into_the_setup_in_the_bar_and_behind_the_phones_menu(self):
        """What the user met on 2026-11-28: with no agent set up, the way into the setup stood only
        beside an open thread or above an inbox with items, so on a note with no thread there was
        none. The bar holds one whatever is open; on a phone it is in the menu behind the three
        dots; a page without the vault's key is offered none."""
        url = self.serve()
        b = self.b
        (self.vault / ".comments" / "D00.json").unlink()  # no thread anywhere
        b.js("location.reload()")
        b.wait(test_phone.READY)
        b.js(test_phone.page("tree"))
        b.js(test_phone.tap_node("D00"))
        self.assertTrue(b.wait("!document.getElementById('agents-entry').hidden"), "no entry in the bar")
        # the note is open with no thread, the inbox is closed: nothing else of agents is on the page
        seen = "[...document.querySelectorAll(%s)].filter(x => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0 }).length"
        self.assertEqual(b.js("[%s, %s, document.querySelectorAll('#threads .thread').length]" % (seen % "'.agent-open'", seen % "'.agent-pick'")), [0, 0, 0])
        e = b.js(self.ENTRY)
        self.assertEqual((e["text"], e["seen"]), ("Agents…", True))
        self.assertLessEqual(e["right"], 1500)
        b.js("document.getElementById('agents-open').click()")
        self.assertTrue(b.wait("!!document.querySelector('dialog.agent-setup[open]')"), "the entry opened no dialog")
        self.assertEqual(b.js("[...document.querySelectorAll('dialog.agent-setup input')].map(i => i.value)"), ["", "", "", "", "", ""])
        b.js("document.querySelector('dialog.agent-setup .agent-head button').click()")
        self.assertTrue(b.wait("!document.querySelector('dialog.agent-setup')"))
        self.shot("bar-entry")

        # a phone keeps it behind the three dots, a row a finger can press
        b.size(360, 740)
        b.js("location.reload()")
        b.wait(test_phone.READY)
        self.assertTrue(b.wait("!document.getElementById('agents-entry').hidden"))
        self.assertFalse(b.js(self.ENTRY)["seen"], "on a phone the entry is in the menu, not in the bar")
        b.js("document.getElementById('bar-more-toggle').click()")
        self.assertTrue(b.wait("document.getElementById('bar-more').classList.contains('open')"))
        e = b.js(self.ENTRY)
        self.assertEqual((e["text"], e["seen"]), ("Agents…", True))
        self.assertGreaterEqual(e["left"], 0)
        self.assertLessEqual(e["right"], 360)
        self.assertGreaterEqual(e["height"], 44)
        self.assertLessEqual(b.js("document.documentElement.scrollWidth"), 360)
        self.shot("phone-menu")
        b.js("document.getElementById('agents-open').click()")
        self.assertTrue(b.wait("!!document.querySelector('dialog.agent-setup[open]')"), "the menu's row opened no dialog")
        self.assertFalse(b.js("document.getElementById('bar-more').classList.contains('open')"), "a choice closes the menu")
        self.assertEqual(b.errors, [])

        # a page that does not carry the key may not change the setup, and is shown no way in
        (self.tmp / "other").mkdir()
        other = test_phone.Browser(self.tmp / "other")
        self.addCleanup(other.close)
        other.call("Emulation.setDeviceMetricsOverride", width=1500, height=900, deviceScaleFactor=1, mobile=False)
        other.open(url.split("?")[0])
        self.assertTrue(other.wait("!!(window.RftAgents && window.RftAgents.state().path)"), "the agents did not load")
        self.assertEqual(other.js("[document.getElementById('agents-entry').hidden, window.RftAgents.canSetup()]"), [True, False])
        self.assertFalse(other.js(self.ENTRY)["seen"])

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

    SELECT = """(() => { const p = [...document.querySelectorAll('#note p')].find(p => p.textContent.length > 40);
        const t = document.createTreeWalker(p, NodeFilter.SHOW_TEXT).nextNode();
        getSelection().setBaseAndExtent(t, 0, t, Math.min(20, t.length));
        document.getElementById('note').dispatchEvent(new MouseEvent('mouseup', { bubbles: true })) })()"""
    CHOOSE = "(() => { const s = document.querySelector(%s + ' .agent-pick select'); s.value = %s; s.dispatchEvent(new Event('change', { bubbles: true })) })()"

    def compose(self, kind):
        """A passage of the note selected, and the box to write a comment, a suggestion or a footnote on it opened."""
        b = self.b
        b.js(self.SELECT)
        self.assertTrue(b.wait("!document.getElementById('sel-bar').hidden"), "no bar under the selection")
        b.js("document.querySelector('#sel-bar [data-compose=%s]').click()" % kind)
        self.assertTrue(b.wait("!document.getElementById('composer').hidden"), "the box did not open")

    def test_the_first_thread_of_a_note_is_asked_of_the_agent_picked_where_it_is_written(self):
        # a note with no thread has no Discussion under it, so nothing to pick in there: the picker is also in the box
        (self.vault / ".comments" / "D00.json").unlink()
        self.serve(SETUP)
        b = self.b
        b.js(test_phone.page("tree"))
        b.js(test_phone.tap_node("D00"))
        self.assertTrue(b.wait("[...document.querySelectorAll('#note p')].some(p => p.textContent.length > 40)"), "the note did not draw")
        self.assertEqual(b.js("[document.getElementById('threads').hidden, [...document.querySelectorAll('.agent-pick')].filter(e => e.getClientRects().length).length]"), [True, 0])
        self.compose("suggestion")
        self.assertEqual(b.js(PICK % "'#composer'")["value"], "chat")
        self.assertIn("ask Claude to write the new text", b.js("document.getElementById('composer-ask').title"))
        b.js("document.getElementById('composer-cancel').click()")
        # a footnote is asked of nobody
        self.compose("footnote")
        self.assertEqual(b.js("[document.getElementById('composer-agent').hidden, document.querySelectorAll('#composer .agent-pick').length]"), [True, 0])
        b.js("document.getElementById('composer-cancel').click()")
        self.compose("comment")
        pick = b.js(PICK % "'#composer'")
        self.assertEqual(pick["value"], "chat")
        self.assertEqual([(o[0], o[1]) for o in pick["options"]], [("chat", False), ("qwen", False), ("far", True), ("reader", False)])
        self.assertEqual(b.js("document.getElementById('composer-ask').textContent"), "Post and ask Claude")
        self.type("#composer-text", "Is it still the question?")
        b.js(self.CHOOSE % (json.dumps("#composer"), json.dumps("qwen")))
        # the button says who, the picker where it runs, and what was typed is still there
        self.assertEqual(b.js("document.getElementById('composer-ask').textContent"), "Post and ask qwen")
        self.assertEqual(b.js(PICK % "'#composer'"), {**pick, "value": "qwen", "where": "runs on this machine"})
        self.assertEqual(b.js("document.getElementById('composer-text').value"), "Is it still the question?")
        self.shot("composer")
        b.js("document.getElementById('composer-ask').click()")
        self.assertTrue(b.wait("[...document.querySelectorAll('#threads .thread .t-who')].some(w => w.textContent.startsWith('qwen'))", 15), "qwen's reply did not show")
        made = self.threads()[0]
        sent = b.js(SENT % "'api/comment'")
        self.assertEqual([(r["action"], r.get("agent")) for r in sent], [("new", None), ("ask", "qwen")])
        self.assertEqual(sent[1], {"id": "D00", "thread": made["id"], "action": "ask", "agent": "qwen"})
        self.assertEqual([(m["by"], m.get("agent"), m["text"]) for m in made["messages"]], [("you", None, "Is it still the question?"), ("claude", "qwen", "Yes, it still is.")])
        self.assertFalse(any(line.startswith("RFT_ASK ") for line in self.lines))  # the chat was not asked
        # the thread is there now, and so is the Discussion's own picker, with the same pick
        self.assertEqual(b.js(PICK % "'#threads'")["value"], "qwen")
        self.assertEqual(b.errors, [])
        self.shot("composer-answered")

    def test_in_a_document_the_picker_is_in_the_box_a_comment_is_written_in(self):
        self.serve(SETUP)
        b = self.b
        b.js(test_phone.page("manuscript"))
        b.js("document.querySelector('[data-ms-level=documents]').click()")
        self.assertTrue(b.wait("[...document.getElementById('ms-doc').options].some(o => o.value === 'two-pages')"), "no document")
        b.js("(() => { const s = document.getElementById('ms-doc'); s.value = 'two-pages'; s.dispatchEvent(new Event('change', { bubbles: true })) })()")
        self.assertTrue(b.wait("(() => { const c = document.querySelector('#ms-cm .CodeMirror'); return !!c && c.CodeMirror.lineCount() > 3 })()"), "the document's text did not draw")
        self.assertEqual(b.js("document.querySelectorAll('#ms-threads .agent-pick').length"), 0)
        b.js("document.querySelector('#ms-cm .CodeMirror').CodeMirror.setSelection({ line: 3, ch: 0 }, { line: 3, ch: 9 })")
        b.js("document.querySelector('.ms-sel-btn[data-kind=comment]').click()")
        self.assertTrue(b.wait("!!document.querySelector('.ms-composer')"), "the box did not open")
        self.assertEqual(b.js(PICK % "'.ms-composer'")["value"], "chat")
        self.assertEqual(b.js("document.querySelectorAll('#ms-threads .agent-pick').length"), 1)
        b.js("document.querySelector('.ms-composer textarea').focus()")
        b.call("Input.insertText", text="Which page?")
        b.js(self.CHOOSE % (json.dumps(".ms-composer"), json.dumps("qwen")))
        self.assertTrue(b.wait("[...document.querySelectorAll('.ms-composer button')].some(x => x.textContent === 'Post and ask qwen')"), "the button does not say who")
        self.assertEqual(b.js("document.querySelector('.ms-composer textarea').value"), "Which page?")
        self.shot("document-composer")
        b.js("[...document.querySelectorAll('.ms-composer button')].find(x => x.textContent === 'Post and ask qwen').click()")
        self.assertTrue(b.wait("window.sent.some(r => r.url.includes('api/comment') && JSON.parse(r.body).action === 'ask')"), "nothing was asked")
        sent = b.js(SENT % "'api/comment'")
        self.assertEqual([(r["action"], r.get("agent")) for r in sent], [("new", None), ("ask", "qwen")])
        self.assertTrue(b.wait("[...document.querySelectorAll('#ms-threads .ms-thread')].some(t => t.textContent.includes('Yes, it still is.'))", 15), "qwen's reply did not show")
        # with the box closed and a thread open, the picker stands above the threads, once
        self.assertEqual(b.js("[document.querySelectorAll('.ms-composer').length, document.querySelectorAll('#ms-threads .agent-pick').length]"), [0, 1])
        self.assertEqual(b.errors, [])

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
        b.js("""(() => { const p = [...document.querySelectorAll('#note p')].find(p => p.textContent.length > 40);
            const t = document.createTreeWalker(p, NodeFilter.SHOW_TEXT).nextNode();
            p.scrollIntoView(); getSelection().setBaseAndExtent(t, 0, t, Math.min(20, t.length)) })()""")
        self.assertTrue(b.wait("!document.getElementById('sel-bar').hidden"), "no bar under a touch selection")
        b.tap("#sel-bar [data-compose=comment]")
        self.assertTrue(b.wait("!!document.querySelector('#composer .agent-pick select')"), "no picker in the box on the phone")
        box = b.js("(() => { const r = document.querySelector('#composer .agent-pick select').getBoundingClientRect(), c = document.getElementById('composer').getBoundingClientRect(); return [r.left, r.right, r.height, c.left, c.right, document.documentElement.scrollWidth] })()")
        self.assertTrue(box[0] >= 0 and box[1] <= 360 and box[2] >= 44 and box[3] >= 0 and box[4] <= 360 and box[5] <= 360, box)
        self.shot("phone-composer")
        b.js("document.getElementById('composer-cancel').click()")
        b.js("document.getElementById('drawer-close') && document.getElementById('drawer-close').click()")
        b.js("document.getElementById('inbox-toggle').click()")
        self.assertTrue(b.wait("!!document.querySelector('#inbox .agent-pick select')"), "no picker in the inbox on the phone")
        box = b.js("(() => { const r = document.querySelector('#inbox .agent-pick select').getBoundingClientRect(); return [r.left, r.right, r.height, document.documentElement.scrollWidth] })()")
        self.assertTrue(box[0] >= 0 and box[1] <= 360 and box[2] >= 44 and box[3] <= 360, box)
        self.shot("phone-inbox")


if __name__ == "__main__":
    unittest.main()
