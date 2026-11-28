# Contributing to rft

This file is for people changing the plugin's code: how to run it from a clone, how to run its
tests, and where each part lives. How to install and use rft is in the guide, https://alex-pv01.github.io/rft-guide/
(its own repository, [alex-pv01/rft-guide](https://github.com/alex-pv01/rft-guide)): a change to
what a person sees or types is finished when the guide's page is changed too.

## Development

```bash
claude plugin validate .
claude plugin test .
python3 -m unittest discover -s tests -p "test_*.py"
claude --plugin-dir .
```

The first two check and test the mod, the third tests the server (and, with Chromium and
`websocket-client` installed, the page at a phone's size: `tests/test_phone.py`, which
`RFT_PHONE_SHOTS=<dir>` makes save a screenshot of each screen; a slide's boxes and lines where
their text puts them, in the tab, the presentation and the PDF's pages, and the slide tools by
real drags and keys (the box where it was dropped, every other byte of the deck as it was):
`tests/test_slides.py`, which `RFT_SLIDES_SHOTS=<dir>` makes save the slides and the PDF; and, with uv, the notebook's
editor in the view's theme against the marimo uv installs: `tests/test_notebook_theme.py`), and
the last starts a session with the plugin loaded from this folder.

- `hooks/register.tsx`: the hooks module (commands, tools, prompt injection, the outline pane,
  the server's lifecycle). `hooks/lib/specs.ts`: the tools' descriptions and input schemas, as
  the model is sent them; `hooks/lib/prompts.ts`: what the commands ask of Claude;
  `hooks/lib/guards.ts`: the guards on Claude's own edits and shell commands (what only the user
  or a tool may write), each call taken apart once and read by all of them.
- `hooks/lib/vault.ts`: the vault model; `hooks/lib/ops.ts` the operations; `hooks/lib/page.ts`
  the standalone page.
- `hooks/lib/comments.ts`: comments, suggestions and locked notes, as Claude's tools see them.
- `hooks/lib/artifacts.ts`: concept artifacts, their stamp, what changed since, and the checks.
- `hooks/lib/notebooks.ts`: experiment notebooks: the marimo file from plain cells, the link, the
  run's RESULTS checked against the Result, and its stamp.
- `hooks/lib/priority.ts`: priorities, their limits and Claude's suggested ones.
- `hooks/lib/verify.ts`: verified notes: a note's substance and its fingerprint, Claude's
  suggestion, the user's verification, and review when the claim changes.
- `hooks/lib/snippets.ts` and `hooks/lib/manuscript.ts`: snippets and documents: their files,
  registries and copies, what a snippet rests on and its state, a copy's state, `rft_manuscript`,
  `rft_set_snippet`, `rft_set_document`.
- `hooks/lib/decks.ts`: slide decks as the session sees them: their files, their lock, and
  `rft_validate`'s warnings.
- `hooks/lib/handoff.ts`: the handoff a session leaves for the next one in its folder: its file,
  who gets it in full, the repositories checked for uncommitted work.
- `hooks/lib/inbox.ts`: the inbox as the session reads and writes it (`rft_inbox`, `/rft-inbox`,
  the Process and Discuss prompts); `server/rft_inbox.py` the same file as the page reads and
  writes it. Both are held to one fixture, `tests/fixtures/inbox/`.
- `hooks/lib/reading.ts`: an inbox item's reading note as the session reads it and writes its
  impression, what `rft_inbox` refuses of it and checks at closing; `server/rft_reading.py` the
  same file as the page writes the user's part. Both are held to one fixture,
  `tests/fixtures/reading-note/`, whose `SCENARIOS.md` states the three cases step by step.
- `hooks/lib/tools.ts`: which tools sit in the prompt from the start, and which only report;
  `hooks/lib/shell.ts` the files a shell command writes (the guards' input); `hooks/lib/answers.ts` the subagents that
  answer threads; `hooks/lib/update.ts` `/rft-update` and the vault's format.
- `web/`: the tree view (`index.html`, `app.js`, `app.css`; `filters.js`, `kanban.js`, `layout.js` and
  `concepts.js` hold the pure filter, kanban, radial layout and concept logic; `artifacts.js` a
  concept artifact's state, links and frame, `frame.js` and `frame.css` the runtime and base style
  inside the artifact's frame, `latex.js` its tables as LaTeX; `markdown.js` the note
  renderer, footnotes and the map from the page back to the note's text; `scratchpad.js` the
  scratchpad's to-dos and lists, and its panel; `inbox.js` the inbox's panel; `reading.js` an inbox item's reading note; `queue.js` the experiment queue's monitor;
  `theme.js` the light and
  dark themes; `manuscript.js` the Manuscript tab; `slides.js` a deck's slides, layouts, boxes and lines and what it
  is for, `decks.js` the Slides tab, `slide-tools.js` the tools on its slide and `slide-edit.js` their edits of the deck's text; vendored d3 and CodeMirror), one codebase for the live view and `/rft-view`, which shows the
  threads read-only.
- `server/rft_server.py`: the local server (Python standard library); `server/rft_notebook.py` an
  experiment's notebook: the vault's link followed, the run in its repo's uv environment (its
  `RESULTS`, `FIGURES` and `TABLES`), the marimo editors the tree view frames;
  `server/rft_latex.py` the generated LaTeX and the compile of a document or a snippet;
  `server/rft_style.py` the figure style the notebooks draw with;
  `server/rft_manuscript.py` snippets and documents as the page reads them; `server/rft_decks.py`
  the slide decks as the page reads and writes them;
  `server/rft_results.py` what a run leaves in the vault (the Result's table, the check, the saved
  numbers, figures and tables, the artifacts' tables, the stamp); `server/rft_queue.py` the
  experiment queue: its runner, the run records, the notebook run after an experiment's jobs, its
  command line (what the queue tools call) and what `api/queue` reads and changes.
  `hooks/lib/queue.ts`: the queue as Claude and the session see it; `hooks/lib/machine.ts` the
  machine it runs on (no queue until one is paired).
- `skills/rft-manual/`: the manual, `SKILL.md` (its core and the index of its parts) and one file
  per part (`hooks/lib/manual.ts` lists them; `tests/test_manual.py` holds the files, the index
  and what the plugin cites together); `tests/`: the mod's tests on an in-memory vault, the
  outline pane on every surface, and the server's tests; `tests/test_pipeline.py` the end-to-end
  check, with no model: an experiment of the demo queued, run, its notebook run after its jobs,
  its numbers in the note and its table in the artifact, then the same `RESULTS` made again from
  a fresh clone at the recorded commit and patch.
- `bench/bench.py`: the token benchmark. It runs tasks headless (`claude -p`) on fresh copies of a
  project, once per plugin folder, and prints the requests, input tokens, output tokens and cost of
  each: `python3 bench/bench.py --project <copy> --tasks tasks.json --plugin old=<folder>
  --plugin new=. --runs 5 --model claude-opus-5-5`. Requests are counted per message id of the
  transcript (tool calls sent together are one request); `first` is what the first request sent.
  The project is copied, never changed. A task may name a setup that
  brings the copy to its stage: `bench/lifecycle.json` measures one experiment's lifecycle
  (planned and queued; its jobs ended and its result to record) on the demo with a toy repo
  (`python3 bench/lifecycle.py base --out <dir>` makes the project).
