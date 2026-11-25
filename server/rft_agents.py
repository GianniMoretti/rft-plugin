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

import os
import re
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
PRESETS: dict[str, dict] = {}
PRESET_NOTES: dict[str, str] = {}


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
                "model": self.model if self.kind == "model" else "", "preset": self.preset}


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
    return Agent(name, "harness", grant, run=run, locked=locked, web=web, preset=kind if preset else "", limits=limits, problem=problem)


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
    """The user's setup, read again whenever its file changed."""

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
