"""The agents a user set up to work on the project (docs/adr/0006): models, which answer text
with text, and harnesses, which can act. Standard library only.

The setup is one file per user, outside any vault: `$RFT_AGENTS`, else `agents.toml` in the user's
configuration folder (`$XDG_CONFIG_HOME/rft/`, `~/.config/rft/`). It holds no key: a model's key is
named by the environment variable that has it.

    [defaults]
    thread = "qwen"            # who answers a comment thread unless the user picks another
    process = "claude"         # who processes an inbox item

    [agents.qwen]              # a model: any endpoint that speaks the OpenAI chat format
    kind = "model"
    url = "http://localhost:11434/v1"
    model = "qwen3:14b"
    # key = "DEEPSEEK_API_KEY" # the NAME of the variable that holds the key, when one is needed

    [agents.claude]            # a harness with a ready-made entry: "claude-code" or "codex"
    kind = "claude-code"
    grant = "read"

    [agents.mine]              # any other harness, by its commands
    kind = "harness"
    run = ["mytool", "exec", "{prompt}"]                    # the prompt is put where {prompt} stands,
    locked = ["mytool", "exec", "--read-only", "{prompt}"]  # or given on its input when it stands nowhere
    web = true                 # it can read a page on the web
    grant = "read"

A grant is what the user allows an agent: "text" (text in, text out: the default), "read" (read the
project) or "change" (change the project). It is the user's word and is never worked out from the
model. A model is text only whatever its entry says. A harness below "change" is run with its
locked command, the one that switches off its own writing and shell tools, and is not usable when
it has none. An agent is offered only the tasks its grant allows: a thread needs none; Process
needs a harness that may read the project and can read the web.

An entry that is wrong is reported with its reason and left out; the others still load.
"""
from __future__ import annotations

import http.client
import json
import os
import re
import signal
import socket
import subprocess
import threading
import time
import tomllib
import urllib.parse
from pathlib import Path

GRANTS = ("text", "read", "change")
GRANT_WORDS = {"text": "text only", "read": "read the project", "change": "change the project"}
TASKS = ("thread", "process")
#: seconds an agent has for a task, unless its entry says otherwise (`thread_seconds`, `process_seconds`)
LIMITS = {"thread": 120, "process": 600}
MAX_LIMIT = 3600
#: the connected Claude Code chat, in the picker: no entry of the file may take its name
CHAT = "chat"
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}\Z")
ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")
LOOPBACK = ("localhost", "127.0.0.1", "::1")
PLACE = "{prompt}"

#: Ready-made harness entries, by `kind`: {run, locked, web}. Filled where the commands are checked
#: (see PRESET_NOTES); an entry's own `run`, `locked` and `web` win over them.
PRESETS: dict[str, dict] = {
    # Claude Code. The prompt is given on its input. Locked: only its tools that read (files of the
    # folder it runs in, and the web) exist at all (--tools) and those same ones are allowed without
    # asking (--allowedTools: with no one to ask, a web tool is refused otherwise), no settings of the
    # user's or the project's are read (so no plugin's tools or hooks), and no MCP server is started.
    "claude-code": {
        "run": ["claude", "-p", "--no-session-persistence"],
        "locked": ["claude", "-p", "--restricted", "--strict-mcp-config", "--tools", "Read,Grep,Glob,WebFetch,WebSearch",
                   "--allowedTools", "Read,Grep,Glob,WebFetch,WebSearch", "--disable-slash-commands", "--no-session-persistence"],
        "web": True, "model_flag": "--model",
    },
    # Codex. The prompt is given on its input (`-`). Locked: its read-only sandbox. `--search`
    # (live web search) and `--model` are flags of `codex` itself, so they stand before `exec`.
    "codex": {
        "run": ["codex", "--search", "exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "--ephemeral", "-"],
        "locked": ["codex", "--search", "exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "-"],
        "web": True, "model_flag": "--model",
    },
}
#: the ready-made entries nobody has run on a real install yet: the page says so
UNVERIFIED: tuple[str, ...] = ()
PRESET_NOTES: dict[str, str] = {
    "claude-code": "Flags from `claude --help` of Claude Code 2.1.332. Tried for real on 2026-11-25: the locked command read a file of its "
                   "folder, listed its tools as Glob, Grep, Read, WebFetch and WebSearch, and could not create a file when asked to by any means; "
                   "launched by the server on a demo vault it answered a suggestion thread and processed arXiv 1710.09412 (without --allowedTools "
                   "its web tools were refused, there being no one to ask).",
    "codex": "Flags from `codex --help` and `codex exec --help` of codex-cli 0.172.0. Tried for real on 2026-11-25, launched locked by the "
             "server on a demo vault: it answered a thread and processed arXiv 1710.09412 with its web search, and asked to create a file three "
             "ways it could not. On that machine (Ubuntu 24.04, kernel.apparmor_restrict_unprivileged_userns = 1) its sandbox, bubblewrap, could "
             "not start at all ('bwrap: loopback: Failed RTM_NEWADDR'), so it could run no command and read no note either: that a WORKING "
             "read-only sandbox reads and does not write is Codex's documentation's word, not something seen here.",
}


class SetupError(ValueError):
    """What is wrong with the setup file or one of its entries, in words for the user."""


def setup_path(env=None) -> Path:
    env = os.environ if env is None else env
    if env.get("RFT_AGENTS"):
        return Path(env["RFT_AGENTS"]).expanduser()
    base = Path(env["XDG_CONFIG_HOME"]).expanduser() if env.get("XDG_CONFIG_HOME") else Path.home() / ".config"
    return base / "rft" / "agents.toml"


class Agent:
    """One entry of the setup, checked. `kind`: "model" or "harness"; `grant`: one of GRANTS;
    a model has `url`, `model` and `key` (the variable's name, or ""); a harness has `run`,
    `locked` (None when it has no locked command), `web` and `preset` (its ready-made kind, or "");
    `limits`: seconds per task; `problem`: why it cannot be used as it is, or ""."""

    def __init__(self, name: str, kind: str, grant: str = "text", **more):
        self.name, self.kind, self.grant = name, kind, grant
        self.url: str = more.get("url", "")
        self.model: str = more.get("model", "")
        self.key: str = more.get("key", "")
        self.run: list[str] = more.get("run", [])
        self.locked: list[str] | None = more.get("locked")
        self.web: bool = more.get("web", False)
        self.preset: str = more.get("preset", "")
        self.given_model: str = more.get("given_model", "")  # the model a harness was told to run
        self.limits: dict[str, int] = {**LIMITS, **more.get("limits", {})}
        self.problem: str = more.get("problem", "")

    def command(self) -> list[str] | None:
        """The command this harness is run with under its grant: its own with the full grant, the
        locked one below it; None when it has no locked command and so may not be run."""
        return self.run if self.grant == "change" else self.locked

    def tasks(self) -> list[str]:
        """The tasks this agent may be given."""
        if self.problem:
            return []
        if self.kind == "model":
            return ["thread"]
        return ["thread", "process"] if self.grant != "text" and self.web else ["thread"]

    def where(self) -> str:
        """Where it runs, as the picker says it before the user clicks."""
        if self.kind == "model":
            host = urllib.parse.urlsplit(self.url).hostname or ""
            return "runs on this machine" if host in LOOPBACK else f"sends text to {host}"
        return "runs here, sends text to its provider"

    def describe(self) -> dict:
        """What the page is told of it: never a key, a variable's name or a command."""
        return {"name": self.name, "kind": self.kind, "grant": self.grant, "grant_words": GRANT_WORDS[self.grant],
                "where": self.where(), "tasks": self.tasks(), "problem": self.problem,
                "model": self.model if self.kind == "model" else "", "preset": self.preset, "unverified": self.preset in UNVERIFIED,
                "why_not": {t: why_not(self, t) for t in TASKS if t not in self.tasks()}}


def _strings(value, what: str) -> list[str]:
    if not isinstance(value, list) or not value or not all(isinstance(x, str) and x for x in value):
        raise SetupError(f'{what} is a list of words, as in ["tool", "exec", "{PLACE}"]')
    if sum(x.count(PLACE) for x in value) > 1:
        raise SetupError(f"{what} names {PLACE} more than once")
    return list(value)


def _limits(entry: dict) -> dict[str, int]:
    out = {}
    for task in TASKS:
        value = entry.get(f"{task}_seconds")
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_LIMIT:
            raise SetupError(f"{task}_seconds is a number of seconds from 1 to {MAX_LIMIT}")
        out[task] = value
    return out


def agent_of(name: str, entry, env) -> Agent:
    """One entry, checked. SetupError when it cannot be read at all; an entry that reads but cannot
    be used as it is (a key that is not set, a harness with no locked command) comes back with its
    `problem`, so the picker can show it and say why."""
    if not NAME.match(name):
        raise SetupError("a name is 1 to 40 letters, digits, spaces, dots, dashes or underscores, and starts with a letter or a digit")
    if name.lower() == CHAT:
        raise SetupError(f'"{CHAT}" is the name of the connected Claude Code chat: give this agent another')
    if not isinstance(entry, dict):
        raise SetupError("an agent is a table: [agents.<name>] with its kind")
    kind = entry.get("kind")
    grant = entry.get("grant", "text")
    if grant not in GRANTS:
        raise SetupError(f'grant is one of "text", "read" or "change", not {grant!r}')
    limits = _limits(entry)
    if kind == "model":
        url, model, key = entry.get("url"), entry.get("model"), entry.get("key", "")
        if not isinstance(url, str) or urllib.parse.urlsplit(url).scheme not in ("http", "https") or not urllib.parse.urlsplit(url).hostname:
            raise SetupError('a model needs url, the address of its endpoint, as in "http://localhost:11434/v1"')
        if not isinstance(model, str) or not model.strip():
            raise SetupError("a model needs model, the name its endpoint knows it by")
        if not isinstance(key, str) or (key and not ENV_NAME.match(key)):
            raise SetupError("key is the NAME of the environment variable that holds the key, never the key itself")
        problem = f"the environment variable {key} is not set" if key and not env.get(key) else ""
        # a model answers text with text whatever its entry says: there is nothing to grant it
        return Agent(name, "model", "text", url=url.rstrip("/"), model=model.strip(), key=key, limits=limits, problem=problem)
    preset = PRESETS.get(kind) if isinstance(kind, str) else None
    if kind != "harness" and preset is None:
        known = ", ".join(f'"{k}"' for k in ("model", "harness", *sorted(PRESETS)))
        raise SetupError(f"kind is one of {known}, not {kind!r}")
    run = _strings(entry["run"], "run") if "run" in entry else (list(preset["run"]) if preset else None)
    if run is None:
        raise SetupError("a harness needs run, the command that runs it once with a prompt and prints its answer")
    locked = _strings(entry["locked"], "locked") if "locked" in entry else (list(preset["locked"]) if preset and preset.get("locked") else None)
    web = entry.get("web", preset["web"] if preset else False)
    if not isinstance(web, bool):
        raise SetupError("web is true or false: whether it can read a page on the web")
    model = entry.get("model", "")
    if not isinstance(model, str):
        raise SetupError("model is the name of the model the harness is told to run")
    if model and preset and preset.get("model_flag"):
        run, locked = [*run[:1], preset["model_flag"], model, *run[1:]], (None if locked is None else [*locked[:1], preset["model_flag"], model, *locked[1:]])
    problem = ""
    if grant != "change" and locked is None:
        problem = (f'it has no locked command, so it can only be run with grant = "change": '
                   f"give it locked, the command that runs it with its own writing and shell tools switched off")
    return Agent(name, "harness", grant, run=run, locked=locked, web=web, preset=kind if preset else "", limits=limits, problem=problem, given_model=model)


class Setup:
    """The setup as read. `agents`: by name, in the file's order; `defaults`: per task, the name of
    an agent that may do it; `errors`: what was left out and why, each {name, error} (name "" for
    the file itself); `path`: the file; `found`: whether there is one."""

    def __init__(self, path: Path, agents=None, defaults=None, errors=None, found=False):
        self.path, self.agents, self.defaults, self.errors, self.found = path, agents or {}, defaults or {}, errors or [], found

    def describe(self) -> dict:
        return {"found": self.found, "agents": [a.describe() for a in self.agents.values()],
                "defaults": dict(self.defaults), "errors": list(self.errors)}

    def for_task(self, task: str) -> list[Agent]:
        return [a for a in self.agents.values() if task in a.tasks()]


def read_setup(text: str, path: Path, env=None) -> Setup:
    env = os.environ if env is None else env
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as err:
        return Setup(path, errors=[{"name": "", "error": f"{path.name} cannot be read as TOML: {err}"}], found=True)
    agents: dict[str, Agent] = {}
    errors: list[dict] = []
    table = data.get("agents", {})
    if not isinstance(table, dict):
        table, errors = {}, [{"name": "", "error": "agents is a table of entries: [agents.<name>]"}]
    for name, entry in table.items():
        try:
            if any(n.lower() == name.lower() for n in agents):
                raise SetupError("another agent has this name in other letter case")
            agents[name] = agent_of(name, entry, env)
        except SetupError as err:
            errors.append({"name": name, "error": str(err)})
    defaults: dict[str, str] = {}
    given = data.get("defaults", {})
    if not isinstance(given, dict):
        given = {}
        errors.append({"name": "", "error": "defaults is a table: [defaults] with thread and process"})
    for task, name in given.items():
        if task not in TASKS:
            errors.append({"name": "", "error": f'defaults has no task "{task}": it has thread and process'})
        elif name == CHAT:
            defaults[task] = CHAT
        elif name not in agents:
            errors.append({"name": "", "error": f'the default for {task}, "{name}", is no agent of this file'})
        elif task not in agents[name].tasks():
            a = agents[name]
            errors.append({"name": "", "error": f'the default for {task}, "{name}", may not do it: {a.problem or why_not(a, task)}'})
        else:
            defaults[task] = name
    return Setup(path, agents, defaults, errors, found=True)


def why_not(agent: Agent, task: str) -> str:
    """Why an agent is not offered a task, in words."""
    if agent.problem:
        return agent.problem
    if task == "process":
        if agent.kind == "model":
            return "a model cannot fetch the item or read the project: Process needs a harness"
        if agent.grant == "text":
            return 'Process needs a harness that may read the project (grant = "read")'
        if not agent.web:
            return "Process needs a harness that can read the web (web = true)"
    return ""


class Setups:
    """The user's setup, read again whenever its file changed, and changed from the page: one
    agent added, changed or removed at a time (`edited`), every other line kept."""

    def change(self, name: str, fields: dict | None) -> Setup:
        """Adds or changes an agent (`fields`, as the page's form gives them), or removes it
        (None), and writes the file. SetupError, and nothing written, when it cannot."""
        try:
            text = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            text = ""
        except (OSError, UnicodeDecodeError) as err:
            raise SetupError(f"{self.path} cannot be read ({err}): {BY_HAND}") from None
        new = edited(text, name, None if fields is None else checked_fields(fields), self.env)
        try:
            write_setup(self.path, new)
        except OSError as err:
            raise SetupError(f"{self.path} cannot be written: {err.strerror or err}") from None
        return self.get()

    def entry(self, name: str) -> dict | None:
        """An agent's entry as the page's form shows it for a change: what `describe` leaves out
        (its address, the NAME of its key's variable), never a key."""
        a = self.get().agents.get(name)
        if a is None:
            return None
        return {"name": a.name, "kind": "model" if a.kind == "model" else (a.preset or "harness"), "url": a.url, "model": a.model if a.kind == "model" else a.given_model,
                "key": a.key, "grant": a.grant, "by_hand": a.kind != "model" and not a.preset}

    def __init__(self, path: Path | None = None, env=None):
        self.path = path or setup_path(env)
        self.env = env
        self._seen: tuple | None = None
        self._setup = Setup(self.path)

    def get(self) -> Setup:
        try:
            st = self.path.stat()
            seen = (st.st_mtime_ns, st.st_size)
        except OSError:
            seen = None
        # a key set or unset since shows at once, so the entries are checked again each time the
        # file is read; the file itself only when it changed
        if seen != self._seen or seen is not None:
            if seen is None:
                self._setup = Setup(self.path)
            else:
                try:
                    text = self.path.read_text(encoding="utf-8")
                    self._setup = read_setup(text, self.path, self.env)
                except (OSError, UnicodeDecodeError) as err:
                    self._setup = Setup(self.path, errors=[{"name": "", "error": f"{self.path.name} cannot be read: {err}"}], found=True)
            self._seen = seen
        return self._setup


# ------------------------------------------------------------------ running an agent

MAX_ANSWER_BYTES = 2_000_000
THINK = re.compile(r"\A\s*<think>.*?</think>", re.S)


class AgentError(Exception):
    """Why an agent gave no answer, in words for the user."""


class Cancelled(AgentError):
    """The task was cancelled, or ran out of time, before its answer was written."""


class Run:
    """One run of an agent, as the task that started it holds it: what stops it, and whether its
    answer may still be written. An answer is written only by a run that `commit()`s first; a run
    that was stopped never does, even when its agent answers afterwards."""

    def __init__(self):
        self._lock = threading.Lock()
        self._stoppers: list = []
        self.stopped: str = ""  # why it was stopped: "cancelled", or the words of its time limit
        self.committed = False

    def on_stop(self, stop) -> None:
        """`stop()` is called when the run is stopped, at once when it already was."""
        with self._lock:
            if not self.stopped:
                self._stoppers.append(stop)
                return
        stop()

    def stop(self, why: str) -> bool:
        """Stops the run; False when its answer is already being written."""
        with self._lock:
            if self.committed:
                return False
            if self.stopped:
                return True
            self.stopped = why
            stoppers, self._stoppers = self._stoppers, []
        for stop in stoppers:
            try:
                stop()
            except Exception:  # noqa: BLE001 - a stopper that fails leaves the others to run
                pass
        return True

    def commit(self) -> None:
        """Called before the answer is written; Cancelled when the run was stopped meanwhile."""
        with self._lock:
            if self.stopped:
                raise Cancelled(self.stopped)
            self.committed = True

    def check(self) -> None:
        if self.stopped:
            raise Cancelled(self.stopped)


def call_model(agent: Agent, prompt: str, run: Run, env=None) -> str:
    """The model's answer to one prompt, over the OpenAI-compatible chat call. Nothing but the
    prompt is sent, and the key, read from the variable the entry names, in the header."""
    env = os.environ if env is None else env
    url = urllib.parse.urlsplit(agent.url + "/chat/completions")
    host = url.hostname or ""
    port = url.port or (443 if url.scheme == "https" else 80)
    seconds = agent.limits["thread"]
    conn = (http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection)(host, port, timeout=seconds)

    def hang_up():
        sock = conn.sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        conn.close()

    run.on_stop(hang_up)
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if agent.key:
        key = env.get(agent.key)
        if not key:
            raise AgentError(f"the environment variable {agent.key} is not set")
        headers["Authorization"] = f"Bearer {key}"
    body = json.dumps({"model": agent.model, "messages": [{"role": "user", "content": prompt}], "stream": False}).encode("utf-8")
    at = f"{host}:{port}"
    try:
        run.check()
        conn.request("POST", url.path + (f"?{url.query}" if url.query else ""), body=body, headers=headers)
        resp = conn.getresponse()
        data = resp.read(MAX_ANSWER_BYTES + 1)
    except (OSError, http.client.HTTPException) as err:
        run.check()
        if isinstance(err, (TimeoutError, socket.timeout)):
            raise AgentError(f"{agent.name} did not answer within {seconds} seconds") from None
        if isinstance(err, ConnectionRefusedError):
            raise AgentError(f"{agent.name} cannot be reached at {at}: nothing answers there (is it running?)") from None
        if isinstance(err, socket.gaierror):
            raise AgentError(f"{agent.name} cannot be reached: the host {host} is not found") from None
        raise AgentError(f"{agent.name} cannot be reached at {at}: {err or type(err).__name__}") from None
    finally:
        conn.close()
    run.check()
    if resp.status != 200:
        said = one_line(data[:400].decode("utf-8", errors="replace"))
        try:
            # the endpoint's own words for it, when it gives them as such endpoints do
            err = json.loads(data).get("error")
            said = one_line(err if isinstance(err, str) else err["message"])
        except (ValueError, AttributeError, KeyError, TypeError):
            pass
        raise AgentError(f"{agent.name} answered {resp.status}{f': {said}' if said else ''}")
    if len(data) > MAX_ANSWER_BYTES:
        raise AgentError(f"{agent.name}'s answer is too long to keep")
    try:
        text = json.loads(data)["choices"][0]["message"]["content"]
        if not isinstance(text, str):
            raise TypeError
    except (ValueError, KeyError, IndexError, TypeError):
        raise AgentError(f"{agent.name} answered, but not as a chat endpoint does: check its url") from None
    # a model that thinks aloud first: its thinking is not its answer
    text = THINK.sub("", text, count=1)
    if not text.strip():
        raise AgentError(f"{agent.name} answered with nothing")
    return text


def run_harness(agent: Agent, prompt: str, run: Run, cwd: Path | None, seconds: int, more_env=None) -> str:
    """The harness's answer to one prompt: what it prints, run once in `cwd`. It is run with the
    command its grant allows, the locked one below the full grant, and never when it has none. The
    prompt is put where the command says {prompt}, or given on its input. Stopping the run ends the
    harness and every process it started."""
    command = agent.command()
    if command is None:
        raise AgentError(f"{agent.name} has no locked command, so it is not run below the full grant")
    on_input = not any(PLACE in word for word in command)
    argv = [word.replace(PLACE, prompt) for word in command]
    try:
        proc = subprocess.Popen(argv, cwd=str(cwd) if cwd else None, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env={**os.environ, **(more_env or {})}, start_new_session=True)
    except FileNotFoundError:
        raise AgentError(f"{agent.name} cannot be run: the command {command[0]} is not found on this machine") from None
    except OSError as err:
        raise AgentError(f"{agent.name} cannot be run: {err.strerror or err}") from None

    def end():
        # the harness and what it started: it leads a process group of its own
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(proc.pid, sig)
            except (ProcessLookupError, PermissionError):
                return
            try:
                proc.wait(2)
                return
            except subprocess.TimeoutExpired:
                continue

    run.on_stop(end)
    try:
        out, err = proc.communicate(prompt.encode("utf-8") if on_input else b"", timeout=seconds + 5)
    except subprocess.TimeoutExpired:
        end()
        proc.communicate()
        run.check()
        raise AgentError(f"{agent.name} did not answer within {seconds} seconds") from None
    finally:
        if proc.poll() is None:
            end()
    run.check()
    if proc.returncode != 0:
        last = [line for line in err.decode("utf-8", errors="replace").splitlines() if line.strip()][-1:]
        raise AgentError(f"{agent.name} ended with an error (code {proc.returncode}){f': {one_line(last[0])}' if last else ''}")
    if len(out) > MAX_ANSWER_BYTES:
        raise AgentError(f"{agent.name}'s answer is too long to keep")
    text = out.decode("utf-8", errors="replace")
    if not text.strip():
        raise AgentError(f"{agent.name} answered with nothing")
    return text


def one_line(text: str, most: int = 300) -> str:
    text = " ".join(text.split())
    return text if len(text) <= most else text[:most - 1] + "…"


# ------------------------------------------------------------------ a thread

REPLACEMENT = re.compile(r"<replacement>\n?([\s\S]*?)\n?</replacement>")
#: how much of a long note a prompt holds: this much around the quoted part
NOTE_CHARS = 60_000


def split_answer(answer: str) -> tuple[str, str | None]:
    """An answer to a thread as (message, new text): the new text is what stands between the first
    <replacement> and </replacement>, None when there is no such pair. As answerThread in
    hooks/lib/comments.ts."""
    m = REPLACEMENT.search(answer)
    if not m:
        return answer.strip(), None
    return answer.replace(m.group(0), "", 1).strip(), m.group(1)


def quoted(text: str) -> str:
    return "\n".join(f"> {line}" for line in text.split("\n"))


def thread_text(thread: dict, place: str) -> str:
    """A thread in words, whole: what it is on, what was proposed, where it stands, who said what."""
    kind = thread.get("kind")
    what = "comment" if kind == "comment" else ("suggestion, an instruction (no replacement text yet)" if thread.get("replacement") is None else "suggestion")
    lines = [f"{thread.get('id')} · {what}", quoted(str(thread.get("quote") or ""))]
    if kind == "suggestion" and thread.get("replacement") is not None:
        lines += ["Replacement:", quoted(str(thread["replacement"]))]
    lines.append(place)
    for m in thread.get("messages") or []:
        who = "user" if m.get("by") == "you" else (m.get("agent") or "claude")
        lines.append(f"- {who} · {m.get('at')}: " + str(m.get("text") or "").replace("\n", "\n  "))
    return "\n".join(lines)


def note_part(body: str, at: tuple[int, int] | None) -> tuple[str, bool]:
    """The note's text for a prompt: whole, or the part around the quote when it is very long."""
    if len(body) <= NOTE_CHARS:
        return body, True
    mid = (at[0] + at[1]) // 2 if at else 0
    start = max(0, min(mid - NOTE_CHARS // 2, len(body) - NOTE_CHARS))
    return body[start:start + NOTE_CHARS], False


def thread_prompt(what: str, name: str, body: str, thread: dict, at: tuple[int, int, bool] | None, path: str | None = None) -> str:
    """What an agent is asked to answer one thread: self-contained, with the text it is about in
    it, and naming no tool of any harness. `what`: note, snippet or document; `path`: the file,
    relative to the folder a harness runs in (None for a model, which reads nothing)."""
    if at is None:
        place = f"The quoted text is no longer in the {what}."
    elif at[2]:
        place = f"The quoted text is in the {what} as quoted."
    else:
        place = f"The quoted text changed since; that part of the {what} now reads:\n{quoted(body[at[0]:at[1]])}"
    part, whole = note_part(body, at)
    kind = {"snippet": "a snippet, a building block in LaTeX,", "document": "a document, in LaTeX,"}.get(what, "a note, in markdown,")
    if thread.get("kind") == "comment":
        todo = (f"It is a comment: a discussion of this part of the {what}. Your whole answer is your reply in the thread, "
                "as the user will read it: markdown, short, and nothing about what you did.")
    else:
        how = "written as the instruction says" if thread.get("replacement") is None else f"from the proposed replacement, adapted only where the {what} needs it"
        todo = (f"It is a suggestion. Your answer is the new text for the quoted part, between <replacement> and </replacement>, {how}, "
                f"then one line on why. Give the new text for the quoted part only, in the {what}'s own form, and nothing around it inside the tags. "
                "The user accepts or rejects it. When the suggestion is unclear or looks wrong, write no replacement: your whole answer is then your reply.")
    reads = (f"\n\nIt is the file `{path}` in the folder you run in. Read what else the question needs (its code, results or references, the notes it names) "
             "and nothing more. Change no file: your answer is written into the thread for you.") if path else ""
    return "\n".join([
        f"You answer one discussion thread on {kind} of a research project kept as a tree of notes. "
        "Your answer is written into the thread exactly as you give it.",
        "",
        f"The {what} {name}, {'as it is now' if whole else 'the part of it around the quoted text (it is long)'}:",
        "<text>", part, "</text>" + reads,
        "",
        "The thread:",
        thread_text(thread, place),
        "",
        todo,
    ])


# ------------------------------------------------------------------ Process

IMPRESSION_BLOCK = re.compile(r"<impression>\n?([\s\S]*?)\n?</impression>")
BRIEF_BLOCK = re.compile(r"<brief>\n?([\s\S]*?)\n?</brief>")
UNREADABLE = re.compile(r"<unreadable>([\s\S]*?)</unreadable>")
LIST_MARK = re.compile(r"^(?:[-*+]|[0-9]+[.)])[ \t]+")
BRIEF_LINES = 3


def split_process(answer: str, agent: str) -> tuple[str, list[str]]:
    """An answer to Process as (the impression's text, the brief's three lines). AgentError, in
    words for the user, when the agent says it could not read the item, when either block is
    missing, or when the brief is not three lines: nothing is then saved. Whether the impression
    has its five parts is for whoever writes it to say (rft_reading.impression_lines)."""
    cannot = UNREADABLE.search(answer)
    if cannot:
        raise AgentError(f"{agent} could not read the item: {one_line(cannot.group(1)) or 'it gave no reason'}")
    imp, brief = IMPRESSION_BLOCK.search(answer), BRIEF_BLOCK.search(answer)
    if not imp or not imp.group(1).strip():
        raise AgentError(f"{agent}'s answer has no impression (nothing between <impression> and </impression>): nothing was saved")
    if not brief:
        raise AgentError(f"{agent}'s answer has no brief (nothing between <brief> and </brief>): nothing was saved")
    lines = [LIST_MARK.sub("", " ".join(line.split()), count=1) for line in brief.group(1).split("\n")]
    lines = [line for line in lines if line]
    if len(lines) != BRIEF_LINES:
        raise AgentError(f"{agent}'s brief has {len(lines)} line{'' if len(lines) == 1 else 's'}, and a brief is three lines "
                         "(what the item claims, which notes it touches, the outcome it recommends): nothing was saved")
    return imp.group(1), lines


def process_prompt(item: dict, parts, chars: int, reading_dir: str, inbox: str) -> str:
    """What a harness is asked to process one inbox item: self-contained, naming no tool of any
    harness, and never holding the user's part of the item's reading note (docs/adr/0004). It
    runs in the vault, locked. `parts`: the impression's headings, in order."""
    name = f"{item['title']} ({item['url']})" if item.get("title") else item["url"]
    why = f' The user saved it with this line on why: "{item["why"]}".' if item.get("why") else ""
    heads = "\n".join(f"### {p}\n..." for p in parts)
    return "\n".join([
        "You read one item a researcher saved to read later and write your own reading of it, for the researcher to compare with theirs.",
        "",
        f"The item: {name}.{why}",
        "",
        "Read the item itself, the page or the paper at its link (for an arXiv paper, its abstract page and as much of the paper as your reading needs). "
        "Write from the item alone: not from its title, not from what you remember of it.",
        "",
        "You run in the folder of the researcher's project: a tree of notes in markdown, in the folders directions/ (D..), experiments/ (E..), "
        "references/ (R..) and theory/ (T..), each file named by its id and title. Search and read them to find the notes this item bears on, and name those by id. "
        f"Do not open the folder `{reading_dir}/` or the file `{inbox}`: the researcher's own reading is there, and yours must be written without it. "
        "Change no file: your answer is saved for you.",
        "",
        "Answer in exactly this form and nothing else.",
        "",
        "<impression>",
        heads,
        "</impression>",
        "<brief>",
        "one line: what the item claims",
        "one line: which notes of the tree it touches, by id",
        "one line: the one outcome you recommend (reference, literature entry, direction, discard or later), with where it would go",
        "</brief>",
        "",
        f"The impression has these {len(parts)} parts, each under its heading, in this order, none empty, and is about one screen: "
        f"aim for {chars * 2 // 3} to {chars * 5 // 6} characters in all, headings included. Above {chars} characters nothing is saved, so count before you answer and cut. "
        f"{parts[0]}: what the item claims. {parts[1]}: how it gets there. {parts[2]}: its key results, with their numbers and where they are in the item (table, figure, section). "
        f"{parts[3]}: the notes of the tree it bears on, by id, and how. {parts[4]}: what it leaves open. The brief is exactly three lines.",
        "",
        "If you cannot read the item (a paywall, a dead link, a page that asks for a login), write neither: answer only "
        "<unreadable>why, in one line</unreadable>.",
    ])


# ------------------------------------------------------------------ tasks

class Busy(Exception):
    """An agent is already at this thread or item."""


class Task:
    """One launched task: `key` (what it is on), `agent`, `what` (in words), `state` (running,
    done, failed or cancelled), `error` (why it failed), `started` and `ended` (seconds)."""

    def __init__(self, key: str, agent: str, what: str, limit: int):
        self.key, self.agent, self.what, self.limit = key, agent, what, limit
        self.state, self.error = "running", ""
        self.started, self.ended = time.time(), None
        self.run = Run()

    def describe(self) -> dict:
        return {"key": self.key, "agent": self.agent, "what": self.what, "state": self.state, "error": self.error,
                "started": int(self.started), "ended": None if self.ended is None else int(self.ended), "limit": self.limit}


class Tasks:
    """The tasks launched by this server, in its memory: one at a time per thread or item, each
    with a time limit. A task that ended is kept, with why it failed, until the next one on the
    same thing."""

    def __init__(self):
        self._lock = threading.Lock()
        self._tasks: dict[str, Task] = {}

    def start(self, key: str, agent: str, what: str, limit: int, work, on_end=None) -> Task:
        """Runs `work(run)` in the background. It returns once the answer is written (after
        run.commit()), or raises: AgentError with why. `on_end(state)` is called when it is over,
        however it ended, with the state it ends in. Busy when a task on `key` is still running."""
        with self._lock:
            had = self._tasks.get(key)
            if had and had.state == "running":
                raise Busy(f"{had.agent} is already answering {what}")
            task = self._tasks[key] = Task(key, agent, what, limit)
        timer = threading.Timer(limit, lambda: task.run.stop(f"{agent} did not answer within {limit} seconds"))
        timer.daemon = True

        def go():
            state, error = "done", ""
            try:
                work(task.run)
            except Cancelled as err:
                why = str(err)
                state, error = ("cancelled", "") if why == "cancelled" else ("failed", why)
            except AgentError as err:
                state, error = "failed", str(err)
            except Exception as err:  # noqa: BLE001 - a task never takes the server down
                state, error = "failed", f"{agent} could not answer: {one_line(str(err)) or type(err).__name__}"
            finally:
                timer.cancel()
            # what the end leaves to tidy (a thread that no longer waits) is done before the task
            # reads as over, so that no one sees it failed and still waiting
            if on_end:
                try:
                    on_end(state)
                except Exception:  # noqa: BLE001
                    pass
            with self._lock:
                task.state, task.error, task.ended = state, error, time.time()

        timer.start()
        threading.Thread(target=go, daemon=True, name=f"rft-agent-{key}").start()
        return task

    def get(self, key: str) -> Task | None:
        with self._lock:
            return self._tasks.get(key)

    def lost(self, key: str, agent: str, what: str) -> Task:
        """A task this server has no memory of (it was restarted while the agent was at it): kept
        as failed, so the page says so until the next one on the same thing."""
        with self._lock:
            task = self._tasks.get(key)
            if task is None:
                task = self._tasks[key] = Task(key, agent, what, 0)
                task.state, task.ended = "failed", time.time()
                task.error = f"the server was restarted while {agent} was answering: ask again"
            return task

    def all(self) -> list[dict]:
        with self._lock:
            return [t.describe() for t in self._tasks.values()]

    def cancel(self, key: str) -> bool:
        """Stops the task on `key`; False when none is running, or its answer is being written."""
        task = self.get(key)
        return bool(task and task.state == "running" and task.run.stop("cancelled"))

    def wait(self, key: str, seconds: float = 10) -> Task | None:
        """For the tests: the task on `key`, once it is over."""
        end = time.time() + seconds
        while time.time() < end:
            task = self.get(key)
            if task is None or task.state != "running":
                return task
            time.sleep(0.01)
        return self.get(key)


class NoAgent(Exception):
    """The agent asked for cannot do the task; in words for the user."""


class Runner:
    """The user's agents at work for one server: the setup, read as it changes, and the tasks."""

    def __init__(self, setups: Setups | None = None, env=None):
        self.setups = setups
        self.env = env if env is not None else (setups.env if setups is not None else None)
        #: what a harness's process is given beside this process's environment (the tests' fake harness)
        self.harness_env: dict[str, str] | None = None
        self.tasks = Tasks()

    def setup(self) -> Setup:
        return self.setups.get() if self.setups is not None else Setup(Path(""))

    def pick(self, task: str, name=None) -> Agent | None:
        """Who does a task: the agent the page named, else the setup's default for it; None for
        the connected chat. NoAgent when the one named is none, or may not do it."""
        setup = self.setup()
        if name is None:
            name = setup.defaults.get(task, CHAT)
        if not isinstance(name, str):
            raise NoAgent("agent is the name of an agent")
        if name == CHAT:
            return None
        agent = setup.agents.get(name)
        if agent is None:
            raise NoAgent(f'"{one_line(name, 60)}" is no agent of your setup ({setup.path})')
        if task not in agent.tasks():
            raise NoAgent(f"{agent.name} may not do this: {why_not(agent, task) or 'its grant does not allow it'}")
        return agent

    def answer(self, agent: Agent, prompt: str, run: Run, task: str = "thread", cwd: Path | None = None) -> str:
        """The agent's answer to a prompt, as text. A harness is run in `cwd`, the vault."""
        if agent.kind == "model":
            return call_model(agent, prompt, run, self.env)
        return run_harness(agent, prompt, run, cwd, agent.limits[task], self.harness_env)


# ------------------------------------------------------------------ changing the setup from the page

#: the kinds an entry may be given from the page: a model, or a harness with a ready-made entry.
#: Any other harness is written by hand: a wrong command there is what breaks the lock.
FORM_KINDS = ("model", *PRESETS)
MANAGED = ("kind", "url", "model", "key", "grant")
TABLE = re.compile(r"^[ \t]*\[")
AGENT_TABLE = re.compile(r"""^[ \t]*\[[ \t]*agents[ \t]*\.[ \t]*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))[ \t]*\][ \t]*(?:#.*)?$""")
DEFAULTS_TABLE = re.compile(r"^[ \t]*\[[ \t]*defaults[ \t]*\][ \t]*(?:#.*)?$")
KEY_LINE = re.compile(r"^[ \t]*([A-Za-z0-9_-]+)[ \t]*=")
BARE = re.compile(r"[A-Za-z0-9_-]+\Z")
NEW_FILE = ("# The agents you set up for rft: models (text in, text out) and harnesses, each with a grant.\n"
            "# The page writes this file when you add an agent there; you may edit it by hand too.\n"
            "# It holds no key: a model's key is NAMED by the environment variable that has it.\n")
BY_HAND = "the file was not changed: edit it by hand"


def _name_in(header: re.Match) -> str:
    if header.group(1) is not None:
        return json.loads(f'"{header.group(1)}"')
    return header.group(2) if header.group(2) is not None else header.group(3)


def _blocks(lines: list[str]) -> list[tuple[int, int]]:
    """The tables of the file as (first line, one past the last): each runs to the next table's
    header, less the blank lines and comments that stand just above that header (they are the
    next table's)."""
    starts = [n for n, line in enumerate(lines) if TABLE.match(line)]
    out = []
    for i, a in enumerate(starts):
        b = starts[i + 1] if i + 1 < len(starts) else len(lines)
        if i + 1 < len(starts):
            while b > a + 1 and (not lines[b - 1].strip() or lines[b - 1].lstrip().startswith("#")):
                b -= 1
        else:
            while b > a + 1 and not lines[b - 1].strip():
                b -= 1
        out.append((a, b))
    return out


def _entry_lines(name: str, fields: dict) -> list[str]:
    head = name if BARE.match(name) else json.dumps(name, ensure_ascii=False)
    return [f"[agents.{head}]", *(f"{k} = {json.dumps(fields[k], ensure_ascii=False)}" for k in MANAGED if fields.get(k) not in (None, ""))]


def checked_fields(fields: dict) -> dict:
    """What the page's form gave for an entry, as the lines the file gets. SetupError in words for
    the user. A harness that has no ready-made entry is not written from the page."""
    kind = fields.get("kind")
    if kind not in FORM_KINDS:
        raise SetupError(f"from the page an agent is a model, or one of the ready-made harnesses ({', '.join(PRESETS)}): any other harness is written by hand, with its commands")
    out = {"kind": kind}
    for k in ("url", "model", "key", "grant"):
        v = fields.get(k, "")
        if not isinstance(v, str):
            raise SetupError(f"{k} is text")
        out[k] = v.strip()
    out["url"] = out["url"].rstrip("/")
    if kind == "model":
        out["grant"] = ""  # a model is text only: there is nothing to grant it
    else:
        out["url"] = out["key"] = ""
        out["grant"] = out["grant"] or "text"
    return out


def edited(text: str, name: str, fields: dict | None, env=None) -> str:
    """The setup file's text with one agent added or changed (`fields`, as checked_fields gives
    them) or removed (None). Every other line stays as it is: the comments, the other agents, and
    in a changed entry what the page does not manage (its time limits, its own commands). A
    removed agent is no longer anyone's default. SetupError, and nothing to write, when the entry
    is wrong, when the file is one the page cannot change safely (agents written another way than
    as [agents.<name>] tables), or when the change would not read back as meant."""
    env = os.environ if env is None else env
    before = read_setup(text, Path("agents.toml"), env)
    if any(e["name"] == "" and "TOML" in e["error"] for e in before.errors):
        raise SetupError(f"the setup file cannot be read as it is ({before.errors[0]['error']}): {BY_HAND}")
    if not NAME.match(name) or name.lower() == CHAT:
        raise SetupError("a name is 1 to 40 letters, digits, spaces, dots, dashes or underscores, starts with a letter or a digit, and is not \"chat\"")
    lines = text.split("\n") if text else []
    if lines and lines[-1] == "":
        lines.pop()
    blocks = _blocks(lines)
    mine = [(a, b) for a, b in blocks if (h := AGENT_TABLE.match(lines[a])) and _name_in(h) == name]
    known = {n for n in list(before.agents) + [e["name"] for e in before.errors] if n}
    if len(mine) > 1 or (name in known and not mine):
        raise SetupError(f"{name} is not written as one [agents.{name}] table: {BY_HAND}")
    clash = next((n for n in known if n.lower() == name.lower() and n != name), None)
    if clash and fields is not None:
        raise SetupError(f'another agent is named "{clash}": pick another name')
    if fields is None:
        if not mine:
            raise SetupError(f"{name} is no agent of the setup")
        a, b = mine[0]
        while a > 0 and lines[a - 1].lstrip().startswith("#") and (a < 2 or not TABLE.match(lines[a - 2])):
            a -= 1  # the comment that stands on it goes with it (not a file's first lines, which head the file)
            if a == 0:
                a = mine[0][0]
                break
        while b < len(lines) and not lines[b].strip():
            b += 1  # and the blank lines after it
        del lines[a:b]
        while lines and not lines[-1].strip():
            lines.pop()
        for a, b in _blocks(lines):
            if DEFAULTS_TABLE.match(lines[a]):
                gone = [n for n in range(a + 1, b) if re.match(r'^[ \t]*(?:thread|process)[ \t]*=[ \t]*(["\'])' + re.escape(name) + r"\1[ \t]*(?:#.*)?$", lines[n])]
                for n in reversed(gone):
                    del lines[n]
    else:
        new = _entry_lines(name, fields)
        if mine:
            a, b = mine[0]
            kept = [line for line in lines[a + 1:b] if not ((k := KEY_LINE.match(line)) and k.group(1) in MANAGED)]
            lines[a:b] = [lines[a].rstrip() if AGENT_TABLE.match(lines[a]) else new[0], *new[1:], *kept]
        else:
            if not lines:
                lines = NEW_FILE.rstrip("\n").split("\n")
            while lines and not lines[-1].strip():
                lines.pop()
            lines += ["", *new]
    out = "\n".join(lines) + "\n"
    after = read_setup(out, Path("agents.toml"), env)
    same = lambda s, skip: {n: a.describe() for n, a in s.agents.items() if n != skip}  # noqa: E731
    if same(after, name) != same(before, name) or [e for e in after.errors if e not in before.errors and e["name"] != name and not (fields is None and name in e["error"])]:
        raise SetupError(f"the change would touch more than {name}: {BY_HAND}")
    if fields is None:
        if name in after.agents or any(e["name"] == name for e in after.errors):
            raise SetupError(f"{name} could not be taken out: {BY_HAND}")
        return out
    wrong = next((e["error"] for e in after.errors if e["name"] == name), None)
    if wrong:
        raise SetupError(wrong)
    got = after.agents.get(name)
    if got is None or got.kind != ("model" if fields["kind"] == "model" else "harness"):
        raise SetupError(f"{name} would not read back as written: {BY_HAND}")
    return out


def write_setup(path: Path, text: str) -> None:
    """Writes the setup file, the user's alone, as a new file renamed over the old one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.rft-tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def list_models(url: str, key: str = "", env=None, seconds: int = 10) -> list[str]:
    """The models an endpoint says it has (GET <url>/models, as OpenAI-compatible endpoints
    answer it), by name. AgentError in words for the user. `key`: the NAME of the variable that
    holds the key, when the endpoint needs one."""
    env = os.environ if env is None else env
    parts = urllib.parse.urlsplit(url.strip().rstrip("/") + "/models")
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise AgentError('the address is that of the endpoint, as in "http://localhost:11434/v1"')
    if key and not ENV_NAME.match(key):
        raise AgentError("key is the NAME of the environment variable that holds the key, never the key itself")
    headers = {"Accept": "application/json"}
    if key:
        if not env.get(key):
            raise AgentError(f"the environment variable {key} is not set where the server runs")
        headers["Authorization"] = f"Bearer {env[key]}"
    at = f"{parts.hostname}:{parts.port or (443 if parts.scheme == 'https' else 80)}"
    conn = (http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection)(parts.hostname, parts.port, timeout=seconds)
    try:
        conn.request("GET", parts.path + (f"?{parts.query}" if parts.query else ""), headers=headers)
        resp = conn.getresponse()
        data = resp.read(MAX_ANSWER_BYTES + 1)
    except ConnectionRefusedError:
        raise AgentError(f"nothing answers at {at} (is it running?)") from None
    except socket.gaierror:
        raise AgentError(f"the host {parts.hostname} is not found") from None
    except (OSError, http.client.HTTPException) as err:
        raise AgentError(f"{at} cannot be reached: {err or type(err).__name__}") from None
    finally:
        conn.close()
    if resp.status != 200:
        raise AgentError(f"{at} answered {resp.status} when asked for its models: check the address{' and the key' if resp.status in (401, 403) else ''}")
    try:
        got = json.loads(data)
        rows = got["data"] if isinstance(got, dict) and "data" in got else got["models"]
        names = sorted({str(r["id"] if "id" in r else r["name"]) for r in rows})
    except (ValueError, KeyError, TypeError):
        raise AgentError(f"{at} answered, but not with a list of models: check the address (it usually ends in /v1)") from None
    return names
