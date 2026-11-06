---
name: rft-manual
description: Operating manual of the Reasoning Flow Tree, the tree of experiment (E..), direction (D..), reference (R..) and theory (T..) notes that records a research project's reasoning, grouped into concepts (lines of research) that can link the code repositories they run on. Use in a project with .rft/config.json whenever an experiment is planned, launched or finished, an idea or question comes up (even a rejected one), a paper or literature review is read, a definition, method or taxonomy is written down, an idea is dropped or moved, a new line of research opens (propose a concept, ask for its code), work starts on an experiment whose concept links code, or the user asks about the tree, the vault, its concepts, its code or what was tried.
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

## When to create and update nodes

1. **Before launching an experiment**, create its node: `rft_add_node` with `type: experiment`,
   `parent` = the direction it tests, `status` `planned` (or `running` if it starts now),
   `what` / `why` filled and its topical `tags`. Do this *before* starting the run, not after.
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
5. **When a definition, method, taxonomy or argument of the project's own is written down**:
   `rft_add_node` with `type: theory`, `parent` = the note it builds on most, and every other
   note it builds on linked under **Builds on**. Statuses: `idea` draft, `running` being worked
   out, `done` settled, `dropped` refuted.
6. **When an idea is dropped or moved**: `rft_set_status` with `dropped` or `moved` and a `note`
   saying why, or where it went.
7. **Record real results only.** Never write expected, invented or rounded-up numbers; if a run
   failed, say so. Keep the numbers consistent with the project's README and result files: the
   vault is the map, the result files are the record.
8. The vault is part of the repository: commit it with the work it describes.

## Tools

| tool | use |
|---|---|
| `rft_add_node` | create a note (next free id, sanitised title, template sections, linked under its parent) |
| `rft_set_status` | change a status, optionally appending real results or the reason |
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

Editing note bodies (What, Why, Result, ...) with the ordinary file tools is fine. After editing
notes by hand — above all a `parent:` field — run `rft_sync`, then `rft_validate`, and fix every
error. Never edit `up:` / `down:` by hand, nor the list under `## The tree` in the index.

A note made with the wrong type is fixed with `rft_set_type`, never renamed by hand: its id, its
folder and every link to it change together.

## Note layout

Frontmatter: `id`, `type` (`experiment` | `direction` | `reference` | `theory`), `status`, `date` (YYYY-MM-DD),
`parent: "[[<parent name>]]"` (`""` for the root), `children`, `up`, `down`,
`tags: [<project>, <type>, <topical tags...>, <status>]`, and on a note that starts a
concept `concept: "<name>"`, `concept_summary: "<one line>"` and, when it links code,
`concept_repos: ["<path>", ...]` (on one line). Body:
`# <ID> · <Title>`, the Parent / Status / Date lines (and Code / data for experiments), then the
sections — experiments: What, Why, Result, Directions found; directions: Idea, Why, Status;
references: Source, Summary, Method, Key results, Relevance, Directions found; theory notes:
Statement, Builds on, Explanation, Open questions, Status — and last **Children in the tree**, a list of links to the children.
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
