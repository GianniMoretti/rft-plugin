# Roadmap

Planned work, split into release packages in the order they should ship. Each
package is one minor version (the current release is 0.23.0; 0.20.0 brought Alex's PR #5: comments
and suggestions, locked notes, priorities, deadlines and the calendar) and lists what it contains, how it
could be done, and when it is done. A package builds only on the ones before it.

| Version | Package | Depends on |
|---------|---------|------------|
| 0.8.0 | Tree view (done) | – |
| 0.9.0 | Moving branches (done) | – |
| 0.10.0 | Rebalancing (done) | 0.9.0 |
| 0.11.0 | References on every node (done) | – |
| 0.12.0 | Literature-driven workflow (done) | 0.11.0 |
| 0.13.0 | Paper collection (done) | 0.11.0 |
| 0.14.0 | Search index (done) | – |
| 0.15.0 | Alex's PR #4 merged (done) | – |
| 0.16.0 | Project map (done) | 0.14.0 |
| 0.17.0 | Recall (done) | 0.16.0 |
| 0.18.0 | Cheaper rebalancing (done) | 0.16.0 |
| 0.19.0 | State of knowledge (done) | 0.16.0 |
| 0.20.0 | Alex's PR #5 merged (done) | – |
| 0.21.0 | Lean tool list (done) | 0.20.0 |
| 0.22.0 | Rules on demand (done) | 0.20.0 |
| 0.23.0 | Fixes from the PR #5 review (done) | 0.20.0 |
| 0.24.0 | Ask Claude in a subagent (done) | 0.20.0 |
| 0.25.0 | One note per literature search (done) | – |
| 0.26.0 | /rft-update (done) | – |
| 1.0.0 | One release with everything, measured | 0.21.0–0.26.0 |

---

## 0.8.0 — Tree view (done)

Small changes to the page only; no change to the note format.

- **A compact concept legend.** With many concepts the legend in Regions mode grows too tall.
  Make it collapsible (state kept in localStorage), and show only the top-level concepts with an
  expand arrow for their sub-concepts.
- **The concept tree in every layout.** Today the concept tree is top-down only; offer the same
  Top-down / Left-right / Radial switch as the reasoning tree, sharing the layout code.

Done when: a demo vault with 15+ concepts keeps the legend to one line when collapsed, and the
concept tree renders and click-through works in all three layouts.

## 0.9.0 — Moving branches (done)

The basic operation the rest of the restructuring relies on.

- **Move a branch.** Move a node and its subtree under another node, as a tool
  (`rft_move_node`) and from the page ("Move under…" in the drawer; drag later, if useful). The
  parent, children, up/down fields, index and canvas follow; concepts are recomputed. Refuse a
  move under the node's own descendant.
- **Keep the history of a move.** A moved note keeps where it came from, so the reasoning that
  led to it is not lost: a frontmatter field `origin:` holding the past parents, oldest first
  (the first entry is the parent at creation), and the dates in a `## History` section. The
  drawer shows them, and the page can draw them as faint dashed "came from" links, toggled on
  and off.

Done when: moving a branch from the page and from the tool leaves `rft_validate` clean, the
`origin:` history is written, and the dashed links show the old position.

## 0.10.0 — Rebalancing (done)

- **Rebalance the tree.** After a while some branches grow out of one line of research but
  belong under another concept. A command (`/rft-rebalance`) asks Claude to propose a new
  structure where each branch sits under its most pertinent concept, as a table of moves
  (branch, from, to, why). Nothing moves until the user confirms; confirmed moves go through
  `rft_move_node`, so each keeps its `origin:`.

Done when: on the demo vault, `/rft-rebalance` proposes moves, applies only the confirmed ones,
and the old positions stay visible as "came from" links.

## 0.11.0 — References on every node (done)

The data side of the literature work: where references live and how they are checked.

- **Every node has its supporting bibliography.** A `refs:` field linking R notes (and a
  `## References` section in the body for free text) on every experiment and direction.
  `rft_validate` warns when it is empty; the drawer lists the references.
- **Experiments built on a reference paper.** The manual asks that a proposed experiment name
  the paper(s) whose setup it starts from (baseline, data, protocol), linked in `refs:`.

Done when: `rft_add_node` accepts refs, the validator warns on nodes without them, and the
drawer links to the R notes.

## 0.12.0 — Literature-driven workflow (done)

Mostly changes to the manual (`rft-manual`), so Claude behaves this way in every project.

- **Literature first when a new field comes up.** When the chat starts on a field the tree does
  not cover yet, Claude asks whether to run a thorough literature search first, so the work
  starts from prior results instead of from scratch. The search ends in R notes.
- **A literature search when a concept opens.** Proposing a new concept comes with the offer of
  a search; its R notes are placed under the concept.
- **`/rft-literature <topic, note id or concept>`** asks for a search directly.

Done when: in a test project, opening a new field and a new concept each lead Claude to offer
a search, and the results land as R notes linked to the right nodes.

## 0.13.0 — Paper collection (done)

- **Background paper collection.** During a search, a tool downloads the papers in the
  background into the vault, in folders that follow the concepts
  (`vault/papers/<concept>/<year> <first author> <short title>.pdf`), linked from their R notes.
  Only open-access sources (arXiv, open-access PDFs); respect publishers' terms. Folders follow
  the concepts when a node is moved or rebalanced.

Done when: a search fills `vault/papers/` without blocking the chat, every PDF is linked from an
R note, and non-open-access papers are listed but not downloaded.

## 0.14.0 — Search index (done)

The simple first step towards fast access to the whole tree.

- **`rft_search`.** A full-text index of notes, results, references and concepts, built from
  the markdown notes (which stay the source of truth). Done as an in-memory BM25 ranking over
  the notes the tools already load at each call, instead of SQLite: it can never be out of
  date, and nothing is stored. Claude queries it instead of reading files one by one.

Done when: `rft_search` answers "what did we try on X" from the index on a large vault, and the
index is rebuilt after every edit.

## From a tree to a knowledge base

Once a vault holds hundreds of notes, it is no longer only a record of how the reasoning went:
it is the knowledge base Claude works from, and what steers the next step. Reading it note by
note then costs more tokens with every session. The packages from 0.16 on make it readable in
layers, keep what is known now apart from the history, and make it answer questions directly.
The design is in [design/knowledge-base.md](design/knowledge-base.md); it replaces the earlier
knowledge-graph note ([design/knowledge-graph.md](design/knowledge-graph.md)), whose `rft_graph`
idea is part of 0.17. Code graphs (e.g. graphify) can run beside rft and are out of scope.

## 0.16.0 — Project map (done)

- **A one-line summary on every note** (`summary:` in the frontmatter), written by Claude when
  it creates the note and updated when a result arrives (`rft_add_node`, `rft_set_status`,
  `rft_set_summary`).
- **A digest per concept** (`map/<id> <concept>.md` in the vault): the state of that line of
  research, key results, dead ends, open questions. Claude writes it (`rft_set_digest`); the
  plugin knows when it is out of date (a fingerprint of the concept's notes).
- **`rft_map`**: the project map (each concept with its state) or one concept (its digest and
  one line per note). Claude reads it before opening note files.
- **A layered session start**: a large tree is injected as the project map instead of the list
  of titles; a small tree stays as it is.
- **`/rft-summarize`**: writes the missing summaries and digests of an existing vault.

Done when: on a replica of a real research vault, the session-start context and the tokens of a typical
question ("what do we know about X") are measured before and after.

## 0.17.0 — Recall (done)

- `rft_search` weighs summaries and answers compactly (summary, where in the tree, the matching
  line), so a question is answered without opening files.
- A hook that, when Claude is about to grep or read inside the vault, points it to `rft_search`
  and `rft_map` first.
- A "have we tried this?" check before an experiment is planned: similar experiments and dead
  ends, from search and digests.
- Graph questions (`rft_graph`): a note's neighbourhood, what cites a reference, the path from
  D00 to a note.

Done when: on the replica, a question answered by search is measured against the same question
before (tokens, turns).

## 0.18.0 — Cheaper rebalancing (done)

- Candidates first: notes whose text and references sit closer to another concept than to their
  own (similarity over summaries and refs, clustering of the note graph), with their summaries.
  `/rft-rebalance` proposes moves from that short list; `--full` keeps the old behaviour.
- Measured on the replica against 0.10's rebalancing.

## 0.19.0 — State of knowledge (done)

- "What we know" in each digest kept current; a result that overturns another marks it
  (`superseded_by:`), so an old result is not relied on.
- `/rft-next`: open directions not explored, experiments proposed and never run, open
  questions, by concept.
- The validator flags concepts grown too large to read in one digest, and suggests a split.

---

## 0.20.0 — Alex's PR #5 merged (done)

- Comments and suggestions on a note's text (Overleaf-style), with **Ask Claude**; locked notes;
  a kanban view and the user's priorities; deadlines (milestones), experiment dates, GPUs, a
  calendar page and `rft.ics`; a markdown renderer with footnotes and highlights.
- Merged with 0.16–0.19 as it was: 204 plugin tests and 74 server tests pass.
- Its cost, measured at the start of a session in a vault that uses none of it: the rules grow
  by about 2,500 characters (four bullets: priorities, dates, locks, comments) and the tool
  definitions from 19,700 to 27,300 characters (seven new tools, plus priority fields on
  `rft_add_node`). About 2,500 tokens more in every session. The next two packages take
  this back.

## 0.21.0 — Lean tool list (done)

Every tool used to be registered with `isDeferred: false`, so all 30 schemas sat in the prompt
from the start. A deferred tool shows only its name until the model loads it with ToolSearch.

- In the prompt from the start: `rft_add_node`, `rft_set_status`, `rft_set_summary`,
  `rft_search`, `rft_map`, `rft_graph`, `rft_next`, `rft_move_node` (`hooks/lib/tools.ts`).
- A feature's tools join them when the vault uses it, decided at activation: the date tools
  when there is a milestone or a note with `due:` or `start:`, the priority tool when a note has
  a priority or a suggested one, the comment tools when there is a comments file or a locked
  note. Every other tool is deferred. No `tool.describe` hook was needed: the placement is given
  at registration, and a later activation registers a tool again when its placement changed.
- `rft_add_node`'s description is shorter.
- Measured:
  - Tool definitions in the prompt, in a vault that uses none of the features: from 27,300 to
    8,800 characters.
  - Session start on the replica vault (a trivial prompt, input tokens): 47,108 in 0.19,
    50,652 in 0.20, 45,131 now. That is 5,500 fewer than 0.20 and 2,000 fewer than 0.19.
  - Headless check: asked for the tags and the validator, Claude loaded `rft_tags` and
    `rft_validate` through ToolSearch and answered in 4 turns.
- Tests: `tests/tools.test.ts` covers a vault with no features and each feature's trigger, and
  checks that a deferred tool still answers.

## 0.22.0 — Rules on demand (done)

- The four PR #5 rules enter the session's rules only when the vault uses the feature, on the
  same conditions that bring its tools into the prompt (`hooks/lib/tools.ts`): priorities when
  a note has `priority:` or a suggested one, dates when there is a milestone or a note with
  `due:` or `start:`, locks when a note is locked, comments when a comments file exists.
  Locks are now a group of their own: a locked note brings `rft_suggest` only, not the comment
  tools.
- For the features not in use, one line instead: priorities, dates and the text of a locked
  note are the user's to set, and edits that change them are refused with the tool to suggest
  a change instead. The refusals (`priorityText`, `datesText`, `lockedText`) already say the
  rest; **Ask Claude**'s prompt says how to answer a thread on its own.
- Activation reads the vault once, for the features, the project map and the deadlines.
- Measured:
  - Rules: about 2,200 characters shorter in a vault with none of the features, about 300
    longer than 0.19's.
  - Session start on the replica vault: 45,131 input tokens in 0.21, 44,455 now (50,652 in
    0.20, 47,108 in 0.19).
  - Headless check in a copy of the demo vault, which has no priorities: asked to make a note
    urgent, Claude wrote a suggested priority and did not touch `priority:` (3 turns).
- Tests: in `tests/tools.test.ts`, the rules with no features, with some, and with all of them.

## 0.23.0 — Fixes from the PR #5 review (done)

- **Footnotes are searched.** `withoutChildren` (vault.ts) cuts the "Children in the tree" list
  the way `childrenAt` finds it, so the footnotes after it stay in `rft_search` and in the
  rebalance words; the children's links still do not count as the note's words.
- **The shell guards decide on the files a command writes** (`hooks/lib/shell.ts`). The command
  is split into words with its quotes and escapes, a `cd` moves the folder, and the files written
  are read from it: redirections, `tee`, `sed -i`, `perl -i`, `awk -i inplace`, `mv` and `cp`
  (both ends), `rm`, `truncate`, `dd of=`. A glob matches as the shell would. A locked note is
  refused when it is one of those files; a priority or a date when the command holds such a line
  and writes a file in the vault. A command that only reads a note, or writes elsewhere while
  mentioning `priority:`, now passes. A script run by an interpreter (python, node, a shell `-c`,
  a heredoc) may write anything: for it the guards keep the old rule, the note or vault it names.
- **`started:` and `finished:`** are written by `rft_set_status` only in a vault that uses dates
  (a milestone, or a note with `due:` or `start:`).
- Tests: `tests/shell.test.ts` (15 commands that write a note, 10 that do not, scripts, globs,
  and the guard through tool calls both ways), a footnote search, `rft_set_status` in a vault
  with no dates. 221 plugin tests and 74 server tests pass.

## 0.24.0 — Ask Claude in a subagent (done)

- **Ask Claude** starts a background subagent of the plugin's own type, `rft:thread`
  (`$.agent.register`, hidden from the model by `agent.offer`), instead of a turn of the
  session. The main conversation does not grow with each answer, and the answer starts at once,
  without waiting for the session to be idle.
- **The subagent only reads** (Read, Grep, Glob). A subagent the plugin starts runs beneath the
  plugin's own call, where the plugin's hooks do not answer it: neither the rft tools nor the
  guards of locked notes, priorities and dates would hold there (seen in a real session). So its
  final message is the answer, and the plugin writes it into the thread when its
  `turn.complete` arrives: a reply, or for a suggestion the text between `<replacement>` tags, a
  replacement the user accepts or rejects. A suggestion is no longer applied to the note by
  Claude; when the quoted text moved since, the replacement goes into the reply.
- **Its report is dropped** before the main conversation reads it: the task notification, or the
  hand-back message (`peer`) naming the subagent's id. The transcript keeps a dim
  "Prompt dropped by a hook" line and no model turn.
- When no subagent starts, the thread goes to the session as before (`askText`).
- Checked in a real session: Ask Claude on a comment and on a suggestion each answered in the
  thread, the note unchanged, and no new turn in the main transcript. 227 plugin tests pass.

## 0.25.0 — One note per literature search (done)

- **`/rft-literature` writes one literature note**, not a reference note per paper: an R note
  tagged `literature`, titled `Literature on <topic>`, with sections Search, Papers (one `###`
  entry per paper: link, claims, key results, relevance), Synthesis, Relevance and Directions
  found. Notes for single papers, like directions and experiments, come only once the user
  chooses them. The session rules and the manual say the same.
- **A colour of its own**: cyan in the web view (and its legend), on the canvas and in the
  Mermaid diagram; `▤` before its title in the pane, with a line in the pane's legend.
- **PDFs per paper**: `rft_collect_papers` on a literature note downloads each entry's
  open-access paper and links it with a `PDF:` line at the end of the entry. A saved PDF of a
  literature note is not moved when its concept changes.
- Tests: the note's sections, its papers, the download plan and the PDF lines, its colour in the
  diagram and on the canvas; the /rft-literature prompt. 228 plugin tests and 74 server tests
  pass.

## 0.26.0 — /rft-update (done)

- **The vault's format** is the config's `version` (`FORMAT` in vault.ts, now 2): it grows only
  when what a vault holds changes, not with each release. New vaults get the current one; a
  config with none is format 1.
- **`/rft-update`** lists what the vault lacks next to what this plugin makes: the folders and
  templates of each note type (an outdated template is replaced by the current one), the
  config's format, and the changes of any migration between the two formats (`MIGRATIONS` in
  update.ts, empty so far: add one when a format change has to rewrite what is there).
  `/rft-update apply` writes them, then runs rft_sync and rft_validate. No model turn.
- **Notes are not changed.** `--sections` also adds the sections each note's type has gained, as
  empty headings before its children list; locked notes are left as they are and named.
- **A toast at session start** when the vault's format is older (or newer) than the plugin's,
  read from the config alone.
- The demo vault in `examples/demo` is updated to format 2.
- Checked on a copy of a real vault from format 1: two folders, four templates and the config
  written, the diagram refreshed, 0 errors and 0 warnings, the notes untouched, and a second run
  with nothing to do; 0 model turns. 232 plugin tests pass.

## 1.0.0 — One release with everything, measured

- A fixed benchmark on a replica vault (a copy, never the real one), run headless before and
  after: the size of the session start (rules and tool definitions), and the cost and turns of
  four tasks: a recall question, adding an experiment, a rebalance, `/rft-next`.
- Target: the session start no larger than 0.19's, and each task no costlier than in 0.19.
- An end-to-end check of the tree view in a browser: comments, suggestions, Ask Claude,
  kanban, calendar, the lock dialog.
- README, the manual skill and this roadmap describe one coherent plugin.

---

## Backlog

Ideas for possible future work, not scheduled in a package yet. None open at the moment.

