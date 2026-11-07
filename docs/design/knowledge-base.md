# Design note: the tree as a knowledge base

Status: adopted for 0.16–0.19 (roadmap). 0.16.0 to 0.19.0 are built.

## The problem

rft started as a record of how the reasoning went: which question led to which experiment, what
came out, what was dropped. In a project that runs for months the vault grows to hundreds of
notes (a real project tree has about 400), and it becomes something else as well: the
knowledge base Claude works from, and the thing that decides what to do next.

Read as a history, a large tree is expensive. At every session start Claude got up to 160 lines
of titles, then opened note files to learn what they say; a rebalance read most of the tree.
What Claude needs most of the time is not the history but the state: what holds now, what was
ruled out, what is open.

## Principles

1. **Read in layers.** Claude never starts from note files.
   - Layer 1, the project map: every concept with two lines on its state. Injected at session
     start in a large tree.
   - Layer 2, a concept's digest: state, key results, dead ends, open questions, and one line per
     note.
   - Layer 3, a note's file, opened only for the detail.
2. **Claude writes the summaries, the plugin keeps them honest.** A one-line `summary:` per note
   is written by Claude when it creates the note and updated when its result arrives: a small
   cost each time, but a summary aimed at what matters. Concept digests are written by Claude
   too, and cached; the plugin computes a fingerprint of each concept's notes (id, status,
   title, summary) and says when a digest no longer matches.
3. **The notes stay the source of truth.** Summaries live in the notes' frontmatter, digests in
   plain markdown files in the vault (`map/`), readable in Obsidian. Nothing is kept outside the
   vault, nothing needs a server.
4. **State apart from history** (0.19). A digest says what is known now; a result that overturns
   another marks it, so Claude does not build on a superseded number.
5. **Answer questions, not files** (0.17). Search answers with summaries and where a note sits;
   a hook points Claude to it before it greps the vault.
6. **Measure.** Each package is measured on the replica: session-start context, and the tokens
   of a fixed set of questions and of one rebalance.

## 0.16.0, as built

- `summary:` (one line, at most 240 characters) in every note's frontmatter. `rft_add_node` and
  `rft_set_status` take a `summary`; `rft_set_summary` sets many at once (for back-filling).
- `map/<id> <concept>.md` (`map/00 <name>.md` for the project's top concept): frontmatter
  `type: digest`, `concept:` (its id), `basis:` (the fingerprint it was written against),
  `updated:`; the body holds `**State:**` and free sections (Key results, Dead ends, Open
  questions). `rft_set_digest` writes it and removes an older file of the same concept.
- `rft_map`: without a concept, the project map (concepts in order, with their state or summary,
  counts, and whether the digest is missing or out of date, then the experiments in progress);
  with one, its digest, its sub-concepts and its notes one per line with their summaries.
- Session start: a tree of more than 60 notes is injected as the project map instead of the
  grouped list of titles; the rules tell Claude to read `rft_map` before note files and to keep
  summaries and digests current.
- Validation: on a new vault (`requireSummaries`), each note without a summary is a warning;
  otherwise one line counts them. Out-of-date digests are a warning each.
- `/rft-summarize [concept]` asks Claude to write the missing summaries (in batches) and the
  digests, concept by concept.

## 0.17.0, as built

- `rft_search` weighs a note's summary like its title, and answers with the summary, the status,
  the parent and the concept of each hit; the matched line only when it holds a query word the
  title and summary lack. Concepts whose name or digest hold at least half the query's words come
  first, with their state.
- `rft_add_node` answers with up to three notes close to the new one (its title and summary match
  at least half their words), parent excluded: "have we tried this?".
- `rft_graph <id>`: parent, children, siblings, refs, cited by, origin, one line each with the
  summary; `mode: path` gives the chain from the top of the tree.
- A `tool.call` hook: a Grep or Glob in the vault, or a shell grep / rg / find naming it, gets a
  reminder (model context only, the result is untouched) to use rft_search, rft_map and
  rft_graph, until one of them is used in the session. Reading a single note is left alone.

## 0.18.0, as built

- `candidates(loaded, {scope})` (hooks/lib/rebalance.ts): tf-idf vectors of each note's title,
  summary (both counted twice) and tags, or the start of its body when it has no summary. A
  concept's profile is the sum of its own notes' vectors plus its name; a note is compared with
  its own concept leaving itself out. References add 0.3 × the share of the note's refs that the
  concept's other notes also use. A note is a candidate when its best other concept (not one on
  its own concept path, not one started inside its subtree) fits at least 0.12, by 0.08 more
  and 1.4 times its own; a note whose ancestor already goes to the same concept is dropped, so
  a branch is proposed whole. With the nearest note in the target concept as a suggested parent.
- Weak candidates (one line each, at most 15, after the clear ones): past a lower bar (fit 0.08,
  gain 0.03, ratio 1.15), or whose title names another concept (a word of its name found in no
  concept's name outside it) that they fit at least as well as their own.
- `/rft-rebalance` embeds that list (at most 15, clearest first) in the prompt and asks Claude to
  judge only those; with none, it says so and asks nothing. `--full` keeps the 0.16 prompt.
- No clustering of the note graph: on the replica the text and reference signal alone gives a
  short, plausible list (5 candidates out of 400 notes, in 0.6 s).
- Measured on the replica: `--full` cost $0.98 (30 turns, about 744K input tokens) and proposed
  4 moves (1 clear, 3 it called less certain); the candidates cost $0.61 (17 turns, about 331K)
  and proposed the clear one, rejecting the other 4 candidates with reasons. The 3 uncertain
  moves of the full run were not among the candidates: the list trades some recall for cost.
- With the weak tier (0.18.1): 3 clear and 15 weak candidates; $0.28, 12 turns, about 320K
  input tokens. Claude proposed the same clear move, looked at the note it had missed (one of the full run's
  uncertain moves, now a weak candidate) and kept it where the result that produced it is.

## 0.19.0, as built

- `superseded_by: "[[<note>]]"` on a note whose result a newer one overturns, set or cleared by
  `rft_supersede` with a dated History line; refused on itself or a loop. The map, search (ranked
  lower, ×0.6), graph (Superseded by / Supersedes) and the tree view's drawer show it; it is part
  of the concept fingerprint, so the digest goes out of date; the validator warns when it names
  no note. `rft_next` leaves superseded notes out.
- `rft_next [concept]` and `/rft-next` (no model turn): by concept, running experiments, planned
  experiments never run, directions with no experiment under them (oldest first, age in days),
  and the `## Open questions` of the digest.
- `rft_validate` flags a concept with more than 40 notes of its own and suggests a split.
- Not done: keeping "what we know" current is left to Claude through the rules (rewrite the
  digest after a result, and after a supersede); the plugin only says when a digest is stale.

## Not in scope

Extracting structure from code (graphify does that, and can run beside rft), embeddings or a
vector store (BM25 over summaries first; to be reconsidered only if recall measurably fails),
and cross-project memory.
