---
name: rft-manual
description: Manual of the Reasoning Flow Tree (rft) plugin, for a project with .rft/config.json: how experiment, direction, reference and theory notes are created, updated and linked. A short core indexing its parts (concepts and code, literature, map, artifacts, notebooks, planning, queue, writing, comments, inbox): read only the part needed.
---

# Reasoning Flow Tree (rft)

The project's reasoning lives in an Obsidian-compatible vault (by default `vault/`, see
`.rft/config.json`, which may sit in a folder above the session's or link to a tree kept
elsewhere; the session rules give the vault's path): **one markdown note per experiment,
direction, reference and theory note**, linked parent → children as a tree. The notes are the
source of truth; the index, the canvas and the children / up / down fields are derived from their
`parent:` field by the rft tools. Concepts group the notes into lines of research, each with the
code repositories its work runs on (`concepts-code.md`).

## The manual's parts

This file is the core: what the notes are, and when to create and update them. Every other
subject has a part of its own, a file beside this one (in this skill's base directory, which the
session's rules name too). Read a part with the Read tool before working on its subject, and only
the parts the work at hand needs:

| part | read it when | its tools |
|---|---|---|
| `concepts-code.md` | a line of research opens, a concept is proposed, renamed or split; code is linked to a concept; before planning, launching or analysing an experiment whose concept links code | `rft_concepts`, `rft_set_concept`, `rft_set_repos`, `rft_code`, `rft_set_code` |
| `literature.md` | the work turns to a field the tree does not cover; a literature search is asked for (`/rft-literature`); papers are saved in the vault | `rft_collect_papers` |
| `map.md` | answering what was tried or what holds now; writing summaries and digests (`/rft-summarize`); a result overturns another; choosing what to do next; moving a branch (`/rft-rebalance`); a status note | `rft_map`, `rft_search`, `rft_graph`, `rft_set_summary`, `rft_set_digest`, `rft_supersede`, `rft_next`, `rft_move_node` |
| `artifacts.md` | a concept's page of results is written or updated (`/rft-artifact`) | `rft_artifact`, `rft_set_artifact` |
| `notebooks.md` | an experiment's results are meant to last, or it has a notebook; a notebook is written, run, or differs from its note; a figure is drawn | `rft_set_notebook`, `rft_run_notebook` |
| `planning.md` | a priority, a deadline, a meeting, a start date or an estimate comes up | `rft_suggest_priority`, `rft_suggest_dates`, `rft_add_deadline`, `rft_add_meeting`, `rft_suggest_deadline` |
| `queue.md` | this machine is paired with the experiment queue, or the user asks to pair it; a run is queued, ended or failed; a script is written for the queue | `rft_machine`, `rft_queue`, `rft_jobs`, `rft_job` |
| `writing.md` | a result is final (suggest verifying it), or a verified note's claim may no longer hold; snippets, documents or slides come up | `rft_manuscript`, `rft_set_snippet`, `rft_set_document` |
| `comments.md` | a note is locked; a comment or suggestion of the tree view is to be answered; a note has footnotes or highlights | `rft_comments`, `rft_comment`, `rft_suggest` |
| `inbox.md` | the user saves something to read later, or asks what waits in the inbox | `rft_inbox` |

This file's own tools: `rft_add_node`, `rft_set_status`, `rft_set_tags`, `rft_tags`, `rft_set_refs`,
`rft_set_type`, `rft_tree`, `rft_sync`, `rft_validate`, `rft_handoff`. A tool that is not in the
prompt loads through ToolSearch by its name; its description says how to call it.

## Node types

- **Experiment (E..)**, in `experiments/`: something that was *run or computed* and produced a
  result: a training grid, a numerical check, a measurement, a literature search for a yes or no
  answer.
- **Direction (D..)**, in `directions/`: an *idea, question or hypothesis*: what to try, why, and
  whether it was pursued. Ideas discussed and rejected get a note too, so the tree records why a
  path was not taken.
- **Reference (R..)**, in `references/`: what was *found in the literature*: a paper, a method
  or a literature review, summarised, with the project's own reading of it. New directions,
  theory notes and sometimes experiments come out of it. A literature search is one literature
  note (tagged `literature`) that lists its papers; a paper gets a note of its own only when the
  user chooses it.
- **Theory (T..)**, in `theory/`: the project's *own understanding*: definitions of concepts,
  methods, taxonomies of methodologies, proofs and arguments, built on directions, experiments
  and references.
- **D00** is the root: the starting question of the project.
- Every note has **exactly one parent**, the note it comes from. If a note comes from several
  notes, pick the main parent and link the others in the text (a theory note lists them under
  **Builds on**). Directions are usually tested by experiments, experiment results and
  references open new directions, and theory notes gather what the others established.

## Statuses and marks

| status | meaning | mark |
|---|---|---|
| `planned` | decided, not started | → |
| `running` | in progress, partial results possible | … |
| `done` | finished, result recorded | ✓ |
| `review` | was verified; its claim changed since, or was overturned: the user checks it again | ↺ |
| `verified` | the user checked what it claims (only they set it; it locks the note) | ✔ |
| `idea` | proposed, not decided | ? |
| `dropped` | tried or considered and abandoned (say why) | ✗ |
| `discussed` | discussed and deliberately not pursued | · |
| `moved` | moved to another project or idea (say where) | ↗ |

## Naming

- File name = `<ID> <short title>.md`, e.g. `E04 Stage 1, synthetic tree.md`.
- **Never use `^`, `#`, `|`, `[`, `]` in titles** (they break wikilinks: `^` is a block
  reference, `#` a heading, `|` an alias), nor `\ / : * " < > ?` (file names). Write "a power
  of t", not "t^p". `rft_add_node` sanitises titles, but choose clean ones.
- IDs are assigned by `rft_add_node` and **never reused**, even when a note is dropped.

## Topical tags

Besides the project, type and status tags (added by the tools), every new note gets **1–3 short
topical tags**: what it is about, so the tree view can filter by them (`ablation`, `optimisation`,
`cluster`, `radius`).

- Lowercase kebab-case: `radial-rule`, not `Radial rule` or `radial_rule` (the tools convert).
- **Reuse the vocabulary**: the session's rules list the tags in use, most used first
  (`rft_tags` gives them all, with counts); pick existing tags when they fit and invent a new
  one only for a genuinely new topic. Prefer a few broad tags over many narrow ones.
- Pass them as `tags` to `rft_add_node`; change them later with `rft_set_tags` (it replaces the
  topical tags and keeps the project, type and status ones).
- Do not retro-tag existing notes unless the user asks.

## When to create and update nodes

1. **Before launching an experiment**, create its node: `rft_add_node` with `type: experiment`,
   `parent` = the direction it tests, `status` `planned` (or `running` if it starts now),
   `what` / `why` filled, its topical `tags`, and `refs`: the reference(s) whose setup it starts
   from (baseline, data, protocol). Do this *before* starting the run, not after.
   In a concept with code, call `rft_code` first and plan from the code as it is now; the note's
   `## Code` section says how the run uses the code. On a machine paired with the experiment
   queue, every run is then queued with `rft_queue` (`queue.md`), not started in the
   background: the plugin sets the note running when its job starts. If its results are meant for
   a paper, a thesis or the docs, ask whether to give it a notebook (`rft_set_notebook`,
   `notebooks.md`); not for an exploratory run.
2. **When it finishes or gives a partial result** (for a queued run: the user is told when its
   job ends, and the session start lists the jobs whose result is not recorded yet): when its
   notebook's run wrote the numbers in **Result**, write what they mean around the table, what
   failed and the caveats; otherwise fill **Result** yourself (numbers with spread over seeds,
   processed from the run's outputs; `rft_jobs <job>` says how a job ended). Fill **Directions
   found**; in a concept with code, `rft_set_code`'s `reproduce` adds what the Result's source
   line and the run records do not say (config, data). Then `rft_set_status` (`done`, or keep
   `running` for partial results). The `note` argument appends to Result.
3. **When a new idea or question comes up** (from a result, the user, a discussion), even if it
   is rejected at once: `rft_add_node` with `type: direction` and `parent` = the note it comes
   from, and its topical `tags`. A rejected idea gets status `discussed`.
4. **When a paper, method or literature review is read**: `rft_add_node` with
   `type: reference`, `parent` = the note that led to it, and its topical `tags`. Fill
   **Source** with a link that can be checked (DOI, arXiv id or URL), **Summary**, **Method**,
   **Key results** as the source reports them (with the table, figure or section), and the
   project's reading under **Relevance**. Only sources actually read: never invent a citation,
   nor a result the source does not report. Statuses: `planned` to read, `running` reading,
   `done` summarised, `dropped` not relevant (the `note` argument appends to Relevance).
5. **References on every node.** Experiments and directions name what they build on in `refs:`
   (links to R notes): `refs` in `rft_add_node`, or `rft_set_refs` later. A paper that is not in
   the tree yet becomes a reference note first (rule 4). A free-text `## References` section in
   the body is fine for sources that do not deserve a note. When the config has
   `"requireRefs": true` (new vaults), `rft_validate` warns about experiments and directions in
   work with no refs; rejected, dropped and moved ones need none.
6. **When a definition, method, taxonomy or argument of the project's own is written down**:
   `rft_add_node` with `type: theory`, `parent` = the note it builds on most, and every other
   note it builds on linked under **Builds on**. Statuses: `idea` draft, `running` being worked
   out, `done` settled, `dropped` refuted.
7. **When an idea is dropped or moved**: `rft_set_status` with `dropped` or `moved` and a `note`
   saying why, or where it went (`moved`: to another project or idea outside this tree).
8. **When a branch sits under the wrong line of research** (it grew out of one note but belongs
   under another, often another concept): propose the move to the user, and only once they agree
   call `rft_move_node` with the note, the new parent and a few words of `why`. The whole subtree
   moves with it; the note keeps its old parents in `origin:` and a dated line under
   `## History`, so where the reasoning came from is not lost. Never move a note by editing its
   `parent:` by hand: that loses the history.
9. **Record real results only.** Never write expected, invented or rounded-up numbers; if a run
   failed, say so. Keep the numbers consistent with the project's README and result files: the
   vault is the map, the result files are the record.
10. The vault is part of the repository: commit it with the work it describes.

## Working on the notes

Before proposing an experiment or an idea, `rft_search` whether the tree already has it; to
answer "what did we try on X", look at the map and search first, and read only the notes that
match.

Editing note bodies (What, Why, Result, ...) with the ordinary file tools is fine. After editing
notes by hand — above all a `parent:` field — run `rft_sync`: it answers with the tree's check
(no `rft_validate` after it); fix every error. Never edit `up:` / `down:` by hand, nor the list
under `## The tree` in the index.

A note made with the wrong type is fixed with `rft_set_type`, never renamed by hand: its id, its
folder and every link to it change together.

## Handoffs

A long session costs more with every request; a new one starts from the rules and the tree. To
carry work over, bring the notes up to date, then `rft_handoff {done, next, unrecorded}` (2,000
characters in all, notes by id): the next session in the folder, or this one after `/clear`,
gets it in its rules. `unrecorded` is what neither a note nor a commit holds; the plugin adds
the repositories with uncommitted changes. `/rft-handoff` asks for one.

## Note layout

Frontmatter: `id`, `type` (`experiment` | `direction` | `reference` | `theory`), `status`, `date` (YYYY-MM-DD),
`summary: "<one line>"`, `superseded_by: "[[<newer note>]]"` when a newer result overturns it,
`priority: <urgent | high | medium | low>` when the user gave it one (theirs alone),
`suggested_priority:` and `suggested_priority_why: "<one line>"` while your suggestion waits,
`parent: "[[<parent name>]]"` (`""` for the root), `children`, `up`, `down`,
`tags: [<project>, <type>, <topical tags...>, <status>]`, and on a note that starts a
concept `concept: "<name>"`, `concept_summary: "<one line>"` and, when it links code,
`concept_repos: ["<path>", ...]` (on one line); a note that was moved has
`origin: ["[[<first parent>]]", ...]`, its past parents oldest first; `refs: ["[[R03 …]]", ...]`
lists the reference notes it builds on; a reference whose paper was saved has
`pdf: "[[papers/<concept>/<file>.pdf]]"`. Body:
`# <ID> · <Title>`, the Parent / Status / Date lines (and Code / data for experiments), then the
sections — experiments: What, Why, Result, Directions found; directions: Idea, Why, Status;
references: Source, Summary, Method, Key results, Relevance, Directions found; theory notes:
Statement, Builds on, Explanation, Open questions, Status — then **History** on a moved note
(one dated line per move), and last **Children in the tree**, a list of links to the children.
A locked note has `locked: true`; footnote texts (`[^1]: …`) come after the sections.
In a concept with code, experiments and directions also have a **Code** section, before Result
(experiments) or Status (directions).

## Viewing

`/rft` starts the interactive tree view (a local page; the user opens its address in a
browser) and the outline pane; `/rft text` prints the tree; `/rft-view` writes a standalone
`<vault>/tree.html`; `/rft-update` brings a vault made by an older version up to date (point the user to it when a session says the vault is older); Obsidian shows `Reasoning tree.canvas`. The user can edit a note's text
(not its frontmatter), add notes with their default status, lock a note, set its priority (on the
kanban, which shows the notes in one column per status), add footnotes and highlights, and
comment on and suggest changes to a note's text in the tree view, so re-read a note before
changing it, and the tree (`rft_tree`) before relying on the copy you were given. The tree view's
scratchpad, `<vault>/Scratchpad.md`, holds the user's quick notes and to-dos: it is not a note of
the tree; read it when they point you to it, and change it only when they ask. The tree view's
monitor (the icon at the top left; `?jobs` in the address opens it) shows this machine's GPUs, the
experiment queue and the jobs that ended; there the user reorders, pauses, cancels and retries
jobs and keeps GPUs out of the queue, so read `rft_jobs` before saying what runs or waits.
`/rft-jobs` prints the same in the terminal.
