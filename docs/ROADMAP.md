# Roadmap

Planned work, split into release packages in the order they should ship. Each
package is one minor version (the current release is 0.14.0) and lists what it contains, how it
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
| 0.15.0 | Knowledge graph | 0.14.0 |

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

## 0.15.0 — Knowledge graph

- **Connect the tree to a knowledge-graph store** (e.g. Graphiti or a similar graph memory), if
  the search index turns out not to be enough. Still to be scoped: which store, what goes in
  (notes, results, references, concepts as nodes and edges), and how it stays in sync with the
  markdown notes.

Done when: scoped in a design note first; the implementation follows from it.
