---
name: rft-manual
description: Operating manual of the Reasoning Flow Tree, the tree of experiment (E..), direction (D..), reference (R..) and theory (T..) notes that records a research project's reasoning, grouped into concepts (lines of research) that can link the code repositories they run on. Use in a project with .rft/config.json whenever an experiment is planned, launched or finished, an idea or question comes up (even a rejected one), a paper or literature review is read, a new field comes up (offer a literature search first), a definition, method or taxonomy is written down, an idea is dropped or moved, a branch belongs under another note (move it), a new line of research opens (propose a concept, ask for its code), work starts on an experiment whose concept links code, or the user asks about the tree, the vault, its concepts, its code or what was tried (start from rft_map).
---

# Reasoning Flow Tree (rft)

The project's reasoning lives in an Obsidian-compatible vault (by default `vault/`, see
`.rft/config.json`, which may sit in a folder above the session's or link to a tree kept
elsewhere; the session rules give the vault's path): **one markdown note per experiment,
direction, reference and theory note**, linked parent → children as a tree. The notes are the source of truth; the index, the canvas and the
children / up / down fields are derived from their `parent:` field by the rft tools.

## Node types

- **Experiment (E..)**, in `experiments/`: something that was *run or computed* and produced a
  result: a training grid, a numerical check, a measurement, a literature search for a yes or no
  answer.
- **Direction (D..)**, in `directions/`: an *idea, question or hypothesis*: what to try, why, and
  whether it was pursued. Ideas discussed and rejected get a note too, so the tree records why a
  path was not taken.
- **Reference (R..)**, in `references/`: what was *found in the literature*: a paper, a method
  or a literature review, summarised, with the project's own reading of it. New directions,
  theory notes and sometimes experiments come out of it. A review can hold one child reference
  per key paper.
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
- **Reuse the vocabulary**: call `rft_tags` first and pick existing tags when they fit; invent
  a new one only for a genuinely new topic. Prefer a few broad tags over many narrow ones.
- Pass them as `tags` to `rft_add_node`; change them later with `rft_set_tags` (it replaces the
  topical tags and keeps the project, type and status ones).
- Do not retro-tag existing notes unless the user asks.

## Concepts

Concepts split the tree into **lines of research**. A note with `concept: "<name>"` (and an
optional `concept_summary: "<one line>"`) in its frontmatter starts a concept: it and its whole
subtree belong to it, until a descendant starts a sub-concept. Concepts nest; notes with no
concept above them belong to the project itself; a concept on the root note covers the whole tree
and takes the project's place at the top of the concept tree. Concepts are explicit, never inferred:

- **Propose, then apply.** When a direction opens a new line of research (not a single
  experiment), propose a concept to the user: the note it starts at, a short name and a
  one-line summary. Call `rft_set_concept` only after they confirm. Never set, rename or remove
  a concept silently.
- **Names** are short and readable, in words as in a heading: `Strong augmentation`, not
  `strong-augmentation` and not the title of one experiment. No `^ # | [ ]`. Avoid reusing a
  name.
- Start a concept at the direction that opened the line, usually; nest at most two or three
  levels, and leave shared setup (the starting question, baselines everyone builds on) in the
  project root when it is not a line of its own.
- `rft_concepts` shows the concept tree; `rft_set_concept(id, name, summary?)` sets or renames
  one, and `name: null` removes it. `/rft-concepts suggest` asks you to propose a full split:
  answer with a short table (start note, name, summary, what stays in the root) and wait for
  the user's yes before applying anything.
- **Ask for the code.** Once a new concept is set, ask the user whether code for that line of
  research already exists on this machine, and where (see Code below).

## Code

A concept can link the **code repositories** its work runs on: folders on this machine, in
`concept_repos:` on the note that starts it (on the root note, the code of the whole project).

```yaml
concept: "Schedule-free training"
concept_summary: "Training without a stopping rule"
concept_repos: ["/home/me/code/sfree", "../code/train-utils"]
```

- **Priority.** A note works with its concept's own repos first, then with those its concept
  inherits from the concepts above it, nearest first. A sub-concept's code is the most specific;
  its parent's is context.
- **Linking.** When a concept is created, ask whether code for it already exists and where. Link
  it with `rft_set_repos(id, repos)` using the path the user gives (absolute, `~/…`, or relative
  to the tree's folder, the one holding `.rft/`); never guess a path. An empty list removes the
  link. Its answer gives each repo's git state, whether sessions started in the repo reach this
  tree (if not, it says which `.rft/config.json` link would do it: ask before writing it into the
  repo), and the notes that now need a Code section.
- **After linking, read the code** as it is now, and give every experiment and direction of the
  concept (sub-concepts included) a `## Code` section with `rft_set_code`. Ideas `discussed` or
  `moved` need none.
- **The `## Code` section** says how the note relates to the code: entry points, files,
  functions and classes, configs, what has to change, where outputs go. A direction gets a short
  pointer (where the idea would land in the code). It opens with one line per repo, written by
  the plugin, never by hand:
  `` - `../code/sfree` @ 3f2a1c9d0e (main) · checked 2026-11-06 ``: the commit the references
  were checked against. `rft_set_code(id, text?, reproduce?)` writes the section and records
  each repo's current commit; `text` or `reproduce` left out keeps what the section holds.
- **The current state comes first.** Plan and propose changes from the code as it is now (the
  current commit and the uncommitted changes), not from the commit an older note recorded.
- **Before working on an experiment** (planning it, launching it, analysing its results) whose
  concept links code, call `rft_code(id)`: it lists, per repo, the commit the note was checked
  against, the commits since and the files changed (uncommitted changes included). Read the
  changes that touch what the note refers to (`git -C <repo> diff <commit> -- <files>`), update
  the references, and call `rft_set_code` to record the current commits. `rft_add_node` writes
  the section at creation, stamped: pass its description as `sections.Code` once you have read
  the code, or fill it right after with `rft_set_code`.
- **Results live in the experiment's note.** Each repo keeps its outputs its own way (logs,
  CSVs, checkpoints, tracker exports): read them where the repo puts them, process them (seeds
  aggregated, tables, the figures that matter) and write the numbers in **Result**, so the note
  can be discussed without the repo. Then record how to reproduce them with `rft_set_code`'s
  `reproduce`: the commit the run used (and whether the tree had uncommitted changes), the
  command and config, where the raw outputs are, and how they were processed into Result (the
  script or command). The Reproduce part keeps the commit of the run even when the references
  are checked again later.
- `rft_validate` warns about repos that are missing or not under git, `concept_repos` on a note
  that starts no concept, and notes whose Code section is missing or names repos the concept no
  longer links.

## Literature

The tree should start from what is already known, not from scratch.

- **A new field: ask first.** When the work turns to a field, method or question the tree does
  not cover yet (no reference or concept about it), ask the user whether to run a thorough
  literature search before planning experiments. Do not start the search unasked: it takes
  time.
- **A new concept: offer a search.** When you propose a concept, offer a literature search for
  it; once agreed, its reference notes go under the concept's start note.
- **`/rft-literature <topic, note id or concept>`** asks for the search directly. Search with the
  tools you have (web search, deep research, arXiv); read each source before writing about it;
  add one reference note per key paper (usually 4 to 10) under the note or concept it is about,
  with **Source** (DOI, arXiv id or URL), **Summary**, **Method**, **Key results** as reported
  and **Relevance**; `done` once summarised from the paper itself, `planned` if only found.
  Then call `rft_collect_papers` with the new notes' ids, give a short synthesis (known, open,
  setups to start from) and list the directions it suggests: add them only once the user
  chooses.
- **Papers in the vault.** `rft_collect_papers(ids?)` downloads, in the background, the PDFs of
  reference notes whose **Source** has an arXiv id or link, or a PDF link on an open-access
  host (OpenReview, PMLR, ACL Anthology, NeurIPS and CVF proceedings, JMLR, bioRxiv...), into
  `papers/<concept>/<year> <first author> <title>.pdf`, and links each from its note with
  `pdf:`. Run again after concepts change: saved PDFs move to their concept's folder. It never
  downloads from paywalled publishers; for those, the note keeps its DOI.
- **Experiments start from a paper.** A proposed experiment says which reference's setup it
  starts from (baseline, data, protocol) and links it in `refs` (rule 5 below). If there is
  none, say so: it is a sign a search is missing.
- Never invent a citation, an author, a year or a result.

## The project map

A large tree is a knowledge base: read it in layers, not file by file.

1. **`rft_map`**: the project map, each concept with its state and counts, and the experiments
   in progress. A tree of more than 60 notes starts each session from it.
2. **`rft_map <concept>`**: the concept's digest (state, key results, dead ends, open questions),
   its sub-concepts, and its notes one per line with their summaries.
3. **The note's file**, only for the detail you need.

To answer a question, search instead of reading: **`rft_search`** answers with each matching
note's summary, where it sits and, when it adds something, the line that matched, and puts first
the concepts whose digest matches; **`rft_graph <id>`** gives a note's neighbours (parent,
children, the notes beside it, what it builds on, what cites it, where it was before a move), or
with `mode: path` how the reasoning reached it from the top. Do not grep the vault: a Grep, Glob
or shell search of it gets a reminder until one of these tools has been used in the session.

**Have we tried this?** `rft_add_node` answers with the notes already in the tree that are close
to the new one (title and summary). If one of them already answers it, or a dead end ruled it
out, say so to the user before running anything.

What keeps the layers useful:

- **Every note has a one-line `summary:`** that you write: what the note is about and, once
  known, what it found, with the key number ("Mixup on CIFAR-100 1k: +2.1±0.4 top-1, gap closes
  at 10k"); for a dropped direction, why. Give it to `rft_add_node`; update it when the result
  arrives (`rft_set_status` with `summary`) or with `rft_set_summary`. Never put an expected
  result in it.
- **Each concept can have a digest** in the vault's `map/` folder, written with
  `rft_set_digest(concept, state, text)`: the state in one or two sentences, then
  `## Key results`, `## Dead ends`, `## Open questions`, each point with note ids. Write it from
  the notes, never from memory. It is stamped with the state of the concept's notes (ids,
  statuses, titles, summaries); when they change, `rft_map` and `rft_validate` say it is out of
  date. Rewrite it after a piece of work that changes the concept, or when you have read its
  notes and it is missing or out of date.
- **`/rft-summarize [concept]`** writes the missing summaries and digests of an existing tree,
  concept by concept (a one-off job on a large tree).

## Restructuring the tree

A note's parent is where the reasoning came from; a concept is the line of research it belongs
to. Over time the two drift apart: a branch grows out of one note but belongs to another line.

- **Move a branch** with `rft_move_node(id, parent, why)`, after the user agrees. The subtree
  moves with it, and the note keeps its past parents in `origin:` plus a dated line under
  `## History`, so the path that led to it stays readable (the tree view's **Came from** draws
  it).
- **`/rft-rebalance [concept or id]`** gives you a short list of candidates the plugin found:
  notes whose title, summary, tags and references sit closer to another concept than to their
  own, each with its fit to both and the nearest note in the other concept, then one line each for
  the weak ones (only slightly closer, or naming another concept in the title; most stay). Judge only those
  (the fit is a hint from shared words, not a verdict); check a candidate with `rft_map
  <concept>` or `rft_graph <id>` and open its file only when in doubt. With `--full` you review
  the whole tree, or one part of it, instead. Start from the map (`rft_map`, `rft_map <concept>`): the summaries say what
  each note is; open a note's file only when its summary leaves a move in doubt. Answer
  with a short numbered table (note, parent now, new parent, why), say what you would leave as
  it is, and wait: apply only the moves the user confirms, each with its `why`, then run
  `rft_validate`. When in doubt, leave a note where the reasoning produced it. Propose a new
  concept separately, never as part of a move.

## When to create and update nodes

1. **Before launching an experiment**, create its node: `rft_add_node` with `type: experiment`,
   `parent` = the direction it tests, `status` `planned` (or `running` if it starts now),
   `what` / `why` filled, its topical `tags`, and `refs`: the reference(s) whose setup it starts
   from (baseline, data, protocol). Do this *before* starting the run, not after.
   In a concept with code, call `rft_code` first and plan from the code as it is now; the note's
   `## Code` section says how the run uses the code.
2. **When it finishes or gives a partial result**: edit its note to fill **Result** (numbers with
   spread over seeds, what failed and why, caveats, processed from the run's outputs),
   **Directions found**, and **Code / data** (commit, script, results folder, machine); in a
   concept with code, record how to reproduce the results with `rft_set_code`'s `reproduce`;
   then `rft_set_status` (`done`, or keep `running` for partial results). The `note` argument
   appends to Result.
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

## Tools

| tool | use |
|---|---|
| `rft_add_node` | create a note (next free id, sanitised title, template sections, linked under its parent) |
| `rft_set_status` | change a status, optionally appending real results or the reason, and updating the summary |
| `rft_set_summary` | set the one-line summary of one or more notes |
| `rft_map` | the project map, or one concept's digest and notes with their summaries |
| `rft_set_digest` | write a concept's digest (state, key results, dead ends, open questions) |
| `rft_move_node` | move a note and its subtree under another parent, keeping its origin, after the user agrees |
| `rft_set_refs` | replace the reference notes a note builds on (`refs:`) |
| `rft_search` | search every note (titles, summaries, tags, concepts, text), best first with each summary, matching concepts first; filters by type, status, concept, tag |
| `rft_graph` | a note's neighbours (parent, children, siblings, refs, cited by, origin), or the path from the top to it |
| `rft_collect_papers` | download the open-access PDFs of reference notes into `papers/<concept>/`, in the background |
| `rft_set_tags` | replace a note's topical tags |
| `rft_set_type` | change the type of a note made with the wrong one (new id, file moved, links renamed) |
| `rft_tags` | the topical tags in use, with counts: check before inventing one |
| `rft_set_concept` | set, rename or remove (name null) the concept a note starts, after the user confirms |
| `rft_concepts` | the concept tree: names, start notes, counts, statuses, linked code |
| `rft_set_repos` | link code repos to a concept (or, on the root note, to the project); an empty list removes them |
| `rft_code` | a note's code context: its repos by priority, the commit it was checked against, what changed since |
| `rft_set_code` | write or update a note's `## Code` section (description, Reproduce), recording each repo's current commit |
| `rft_tree` | the current tree, or the subtree of one node (`root`, `depth`) |
| `rft_validate` | errors (bad ids, statuses, titles, missing parents, broken links) and warnings |
| `rft_sync` | regenerate children / up / down, the tree in `00 Index.md`, the canvas |

Before proposing an experiment or an idea, `rft_search` whether the tree already has it; to
answer "what did we try on X", look at the map and search first, and read only the notes that
match.

Editing note bodies (What, Why, Result, ...) with the ordinary file tools is fine. After editing
notes by hand — above all a `parent:` field — run `rft_sync`, then `rft_validate`, and fix every
error. Never edit `up:` / `down:` by hand, nor the list under `## The tree` in the index.

A note made with the wrong type is fixed with `rft_set_type`, never renamed by hand: its id, its
folder and every link to it change together.

## Note layout

Frontmatter: `id`, `type` (`experiment` | `direction` | `reference` | `theory`), `status`, `date` (YYYY-MM-DD),
`summary: "<one line>"`,
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
In a concept with code, experiments and directions also have a **Code** section, before Result
(experiments) or Status (directions).

## Status notes (optional)

The tree records how the reasoning went; a status note records what it adds up to. Keep them in
`<vault>/status/`, one dated file each (`Claims and status, YYYY-MM-DD.md`), linked from
`00 Index.md`: claims grouped by strength (proved, consistent, weak, cannot claim), each linked
to the experiments that support it, then next steps. Every next step that is a new idea also
gets a direction node.

## Viewing

`/rft` starts the interactive tree view (a local page; the user opens its address in a
browser) and the outline pane; `/rft text` prints the tree; `/rft-view` writes a standalone
`<vault>/tree.html`; Obsidian shows `Reasoning tree.canvas`. The user can edit a note's text
(not its frontmatter) and add notes, with their default status, in the tree view, so re-read a
note before changing it, and the tree (`rft_tree`) before relying on the copy you were given.
