# Design note: the tree as a knowledge base

Status: adopted for 0.16–0.19 (roadmap). 0.16.0 (project map) is built.

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

## Not in scope

Extracting structure from code (graphify does that, and can run beside rft), embeddings or a
vector store (BM25 over summaries first; to be reconsidered only if recall measurably fails),
and cross-project memory.
