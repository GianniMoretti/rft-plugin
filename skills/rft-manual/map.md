# The project map and the state of knowledge

A part of the rft manual (the `rft-manual` skill is its core, with the index of the parts).

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
- **A concept grown past 40 notes of its own** is more than one digest can stand for:
  `rft_validate` says so; propose a split into sub-concepts at the notes that open its sub-lines.

## State of knowledge

The map says what holds now, not only what was done.

- **A result that overturns another** (a corrected number, a bug found in the run, a
  better-controlled rerun that changes the conclusion) marks the old note:
  `rft_supersede(id, by, why)` writes `superseded_by:` and a dated History line. The map, search
  and graph then show it as `[superseded by …]`; never quote or build on such a result without
  saying it was overturned. Then rewrite the concept's digest so its key results are the ones
  that hold. `rft_supersede(id)` without `by` clears the mark.
- **What is still open**: `rft_next [concept]` (and `/rft-next` for the user) lists the user's
  priorities first (the open notes they made urgent, high or medium), then, by concept, the
  experiments running, those planned and never run, the directions with nothing tried under them
  (the higher priorities first, then the oldest, with their age) and the open questions of the
  digests, and last the suggested priorities still waiting for the user. Call it when asked what
  to do next and before proposing new work: pick up an open thread before opening a new one, and
  what the user made urgent or high before the rest.

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

## Status notes (optional)

The tree records how the reasoning went; a status note records what it adds up to. Keep them in
`<vault>/status/`, one dated file each (`Claims and status, YYYY-MM-DD.md`), linked from
`00 Index.md`: claims grouped by strength (proved, consistent, weak, cannot claim), each linked
to the experiments that support it, then next steps. Every next step that is a new idea also
gets a direction node.
