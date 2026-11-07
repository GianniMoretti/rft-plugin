# Roadmap

Planned work, split into release packages in the order they should ship. Each
package is one minor version (the current release is 0.18.0, which also brings Alex's
changes: note types, light theme, LaTeX, images, code repos) and lists what it contains, how it
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
| 0.19.0 | State of knowledge | 0.16.0 |

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

## 0.19.0 — State of knowledge

- "What we know" in each digest kept current; a result that overturns another marks it
  (`superseded_by:`), so an old result is not relied on.
- `/rft-next`: open directions not explored, experiments proposed and never run, open
  questions, by concept.
- The validator flags concepts grown too large to read in one digest, and suggests a split.
