---
name: rft-manual
description: Operating manual of the Reasoning Flow Tree, the tree of experiment (E..) and direction (D..) notes that records a research project's reasoning, grouped into concepts (lines of research). Use in a project with .rft/config.json whenever an experiment is planned, launched or finished, an idea or question comes up (even a rejected one), an idea is dropped or moved, a new line of research opens (propose a concept), or the user asks about the tree, the vault, its concepts or what was tried.
---

# Reasoning Flow Tree (rft)

The project's reasoning lives in an Obsidian-compatible vault (by default `vault/`, see
`.rft/config.json`, which may sit in a folder above the session's or link to a tree kept
elsewhere; the session rules give the vault's path): **one markdown note per experiment and
per direction**, linked parent →
children as a tree. The notes are the source of truth; the index, the canvas and the
children / up / down fields are derived from their `parent:` field by the rft tools.

## Node types

- **Experiment (E..)**, in `experiments/`: something that was *run or computed* and produced a
  result: a training grid, a numerical check, a measurement, a proof, a literature check.
- **Direction (D..)**, in `directions/`: an *idea, question or hypothesis*: what to try, why, and
  whether it was pursued. Ideas discussed and rejected get a note too, so the tree records why a
  path was not taken.
- **D00** is the root: the starting question of the project.
- Every note has **exactly one parent**, the note it comes from. If an idea comes from several
  notes, pick the main parent and link the others in the text. Directions are usually tested by
  experiments, and experiment results open new directions.

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
topical tags**: what it is about, so the tree view can filter by them (`theory`, `ablation`,
`literature`, `cluster`, `radius`).

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
concept above them belong to the project itself. Concepts are explicit, never inferred:

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

## When to create and update nodes

1. **Before launching an experiment**, create its node: `rft_add_node` with `type: experiment`,
   `parent` = the direction it tests, `status` `planned` (or `running` if it starts now),
   `what` / `why` filled and its topical `tags`. Do this *before* starting the run, not after.
2. **When it finishes or gives a partial result**: edit its note to fill **Result** (numbers with
   spread over seeds, what failed and why, caveats), **Directions found**, and **Code / data**
   (commit, script, results folder, machine); then `rft_set_status` (`done`, or keep `running`
   for partial results). The `note` argument appends to Result.
3. **When a new idea or question comes up** (from a result, the user, a discussion), even if it
   is rejected at once: `rft_add_node` with `type: direction` and `parent` = the note it comes
   from, and its topical `tags`. A rejected idea gets status `discussed`.
4. **When an idea is dropped or moved**: `rft_set_status` with `dropped` or `moved` and a `note`
   saying why, or where it went.
5. **Record real results only.** Never write expected, invented or rounded-up numbers; if a run
   failed, say so. Keep the numbers consistent with the project's README and result files: the
   vault is the map, the result files are the record.
6. The vault is part of the repository: commit it with the work it describes.

## Tools

| tool | use |
|---|---|
| `rft_add_node` | create a note (next free id, sanitised title, template sections, linked under its parent) |
| `rft_set_status` | change a status, optionally appending real results or the reason |
| `rft_set_tags` | replace a note's topical tags |
| `rft_tags` | the topical tags in use, with counts: check before inventing one |
| `rft_set_concept` | set, rename or remove (name null) the concept a note starts, after the user confirms |
| `rft_concepts` | the concept tree: names, start notes, counts, statuses |
| `rft_tree` | the current tree, or the subtree of one node (`root`, `depth`) |
| `rft_validate` | errors (bad ids, statuses, titles, missing parents, broken links) and warnings |
| `rft_sync` | regenerate children / up / down, the tree in `00 Index.md`, the canvas |

Editing note bodies (What, Why, Result, ...) with the ordinary file tools is fine. After editing
notes by hand — above all a `parent:` field — run `rft_sync`, then `rft_validate`, and fix every
error. Never edit `up:` / `down:` by hand, nor the list under `## The tree` in the index.

## Note layout

Frontmatter: `id`, `type` (`experiment` | `direction`), `status`, `date` (YYYY-MM-DD),
`parent: "[[<parent name>]]"` (`""` for the root), `children`, `up`, `down`,
`tags: [<project>, <type>, <topical tags...>, <status>]`, and on a note that starts a
concept `concept: "<name>"` and `concept_summary: "<one line>"`. Body:
`# <ID> · <Title>`, the Parent / Status / Date lines (and Code / data for experiments), then the
sections — experiments: What, Why, Result, Directions found; directions: Idea, Why, Status —
and last **Children in the tree**, a list of links to the children.

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
