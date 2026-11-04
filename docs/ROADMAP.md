# Roadmap

Planned work, not started. Each item has the idea and a first note on how it could be done.

## Tree view

- **A compact concept legend.** With many concepts the legend in Regions mode grows too tall.
  Make it collapsible (remember the state), or show only the top-level concepts with an expand
  arrow per concept, or move it into the Filters panel.
- **The concept tree in every layout.** Today the concept tree is top-down only; offer the same
  Top-down / Left-right / Radial switch as the reasoning tree.

## Restructuring the tree

- **Move a branch.** Move a node and its subtree under another node, from the page (drag, or
  "Move under…" in the drawer) and as a tool (`rft_move_node`). The parent, children, up/down
  fields, index and canvas follow; concepts are recomputed.
- **Rebalance the tree.** After a while some branches grow out of one line of research but
  belong under another concept. A command (e.g. `/rft-rebalance`) asks Claude to propose a new
  structure where each branch sits under its most pertinent concept, as a table of moves to
  confirm (nothing moves until the user says yes).
- **Keep the history of a move.** A moved note keeps where it came from, so the reasoning that
  led to it is not lost: e.g. a frontmatter field `origin: "[[E12 …]]"` (the parent at creation,
  kept across moves, possibly a list of past parents with dates). The page can draw these as
  faint dashed "came from" links, toggled on and off, and the drawer shows them.

## Literature

- **Every node has its supporting bibliography.** A `## References` section (or a `refs:`
  field linking R notes) on every experiment and direction; `rft_validate` warns when it is
  empty.
- **Literature first when a new field comes up.** When the chat starts on a field the tree does
  not cover yet, Claude asks whether to run a thorough literature search first, so the work
  starts from prior results instead of from scratch. The search ends in R (reference) notes.
- **Experiments built on a reference paper.** A proposed experiment names the paper(s) whose
  setup it starts from (baseline, data, protocol), linked as R notes.
- **A literature search when a concept opens.** Opening a new concept starts with a search, its
  R notes placed under the concept.
- **Background paper collection.** During a search, a tool downloads the papers (open-access
  PDFs, arXiv) in the background into the vault, in folders that follow the concepts
  (e.g. `vault/papers/<concept>/<year> <first author> <short title>.pdf`), linked from their R
  notes. Only open-access sources; respect publishers' terms.

## Knowledge base

- **Fast access to the whole tree for Claude.** Connect the tree to a knowledge-graph store
  (e.g. Graphiti or a similar graph memory) so Claude can query every note, result and paper
  quickly instead of reading files. Still to be scoped: which store, what goes in (notes,
  results, references, concepts as nodes and edges), how it stays in sync with the markdown
  notes (which stay the source of truth), and whether a simpler local index (SQLite full-text
  search exposed as an `rft_search` tool) is enough first.
