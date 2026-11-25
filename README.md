# <img src="docs/logo.svg" width="34" align="top" alt=""> rft: Reasoning Flow Tree for Claude Code

What is the best way to do research now that an AI can help with it, so that it is still your
research? rft's answer: you build a knowledge base of your project, and your agents work from
it.

rft is a plugin for Claude Code for keeping track of a research project. Every question you ask,
experiment you run and paper you read becomes one short note under the note it came from. The
notes are your knowledge base, shown as a live tree in your browser. They are also what Claude
and your other agents start from, so they know what was tried and why, add what they do to it,
and stay within what you allow.

![The tree view of the demo project: directions, experiments, references and a theory note, each under the note it came from](docs/screenshots/tree.png)

**[Read the guide](https://alex-pv01.github.io/rft-guide/)** for everything this page leaves out.

## What it does

- **Keeps a tree of notes.** One note per experiment (`E07`), idea or question (`D03`), paper
  you read (`R02`) and piece of theory (`T01`), each linked to the note it came from. Rejected
  ideas stay in the tree, so it also says why a path was not taken.
- **Serves your agents too.** Claude starts each session from the tree, so it knows what was
  tried and why. It adds an experiment's note before launching it and records the result, so
  its work lands in the same record.
- **Keeps you in charge.** A note's priority is set by you alone. Lock a note and Claude can
  only suggest changes to it. Only you mark a note verified.
- **Shows it live.** A tree in the browser: click a note to read it, filter by tag or status,
  group the notes into lines of research.
- **Stays plain.** The notes are markdown files in your project (`vault/` by default). They work
  in Obsidian, in git and in any editor, and they are the source of truth.
- **Grows with the project.** A kanban and a calendar over the same notes, a queue for
  experiments on your GPUs, result pages per line of research, LaTeX documents and slide decks
  built from verified results, and an inbox for papers to read.

## Install

You need Claude Code 2.1.29x or later, and Python 3 on your `PATH` for the tree view.

At the prompt of a Claude Code session in the terminal:

```
/plugin marketplace add alex-pv01/rft-plugin
/plugin install rft@rft-plugin
```

If you are asked for a scope, choose **user** to have rft in every project. It does nothing in a
project until you activate it there. More in the guide:
[Install](https://alex-pv01.github.io/rft-guide/start/install/).

## Try it in five minutes

This repository holds a small made-up project, already written as a tree. Open it to see what
rft looks like before you set anything up:

```bash
git clone https://github.com/alex-pv01/rft-plugin
cd rft-plugin/examples/demo
claude
```

In the session, type `/rft`. It prints an address like `http://127.0.0.1:41234/?token=…`: open
it in a browser on the same machine, and you see the tree in the picture above. Click a note to
read it. Type `/rft-next` to list what is still open, or ask Claude about the project in your
own words. `/rft stop` stops the view.

The guide walks through it with pictures:
[First run on the demo](https://alex-pv01.github.io/rft-guide/start/first-run/).

## Use it in your project

In a Claude Code session in your project's folder, give rft the question the project starts
from:

```
/rft-init Can strong augmentation replace early stopping on small datasets?
```

That creates the `vault/` folder with your question as the first note. From there, work with
Claude as usual and it keeps the tree. See
[Activate it in your project](https://alex-pv01.github.io/rft-guide/start/activate/), and
[Notes in one folder, code in others](https://alex-pv01.github.io/rft-guide/start/notes-and-code/)
if your code lives apart from your notes.

## The guide

| | |
|---|---|
| **Start** | [What rft is](https://alex-pv01.github.io/rft-guide/) · [Install](https://alex-pv01.github.io/rft-guide/start/install/) · [First run](https://alex-pv01.github.io/rft-guide/start/first-run/) · [Activate](https://alex-pv01.github.io/rft-guide/start/activate/) |
| **Every day** | [What changes once it is active](https://alex-pv01.github.io/rft-guide/using/once-active/) · [The tree view](https://alex-pv01.github.io/rft-guide/using/tree-view/) · [Handoffs](https://alex-pv01.github.io/rft-guide/using/handoffs/) |
| **Planning** | [Kanban and priorities](https://alex-pv01.github.io/rft-guide/using/kanban/) · [Deadlines, meetings and the calendar](https://alex-pv01.github.io/rft-guide/using/calendar/) · [The experiment queue](https://alex-pv01.github.io/rft-guide/using/queue/) |
| **Reading** | [The inbox and reading notes](https://alex-pv01.github.io/rft-guide/using/inbox/) · [Agents](https://alex-pv01.github.io/rft-guide/using/agents/) |
| **Results** | [Concepts and artifacts](https://alex-pv01.github.io/rft-guide/using/concepts/) · [Code repos](https://alex-pv01.github.io/rft-guide/using/code-repos/) · [Notebooks and figures](https://alex-pv01.github.io/rft-guide/using/notebooks-figures/) |
| **Writing** | [Snippets and documents](https://alex-pv01.github.io/rft-guide/using/documents/) · [Slides](https://alex-pv01.github.io/rft-guide/using/slides/) |
| **Reference** | [Commands](https://alex-pv01.github.io/rft-guide/reference/commands/) · [Statuses](https://alex-pv01.github.io/rft-guide/reference/statuses/) · [Configuration](https://alex-pv01.github.io/rft-guide/reference/configuration/) · [Obsidian](https://alex-pv01.github.io/rft-guide/reference/obsidian/) |

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) says how to run the plugin from a clone, how to run its
tests and where each part of the code lives. The guide has a repository of its own,
[alex-pv01/rft-guide](https://github.com/alex-pv01/rft-guide).

## Credits and license

rft was created by Gianni Moretti
([GianniMoretti/rft-plugin](https://github.com/GianniMoretti/rft-plugin)); this repository is a
fork that continues it. MIT licensed: see [`LICENSE`](LICENSE).
