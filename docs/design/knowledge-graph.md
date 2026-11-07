# Design note: a knowledge graph for the tree

Status: proposal (roadmap 0.16.0). Nothing here is built yet.

## The question

Claude should reach everything the tree knows (notes, results, references, concepts, papers)
quickly, without reading files one by one, and ideally across sessions and projects. The
roadmap's idea was to connect the tree to a knowledge-graph store such as Graphiti.

## What rft already has

- **A typed graph, explicitly.** Every note is a node with a type (E, D, R, T), a status, a
  date and tags; the edges are written in the frontmatter: `parent` (where the reasoning came
  from), `refs` (what it builds on, 0.11), `origin` (where it was before a move, 0.9), and
  `concept` (the line of research it belongs to). None of it has to be guessed from text.
- **Search** (`rft_search`, 0.14): ranked full text over every note, filtered by type, status,
  concept and tag, always in sync because it is built from the notes at each call.
- **Papers** (`rft_collect_papers`, 0.13): the PDFs behind the references, by concept.

## Graphiti, as it is today

Graphiti (by Zep) builds a temporal knowledge graph from "episodes" (text or JSON): an LLM
extracts entities and relations from each episode, and the graph keeps when each fact held. It
runs on a graph database server, FalkorDB (the MCP server's default) or Neo4j; Kuzu, the
embedded option, appears to be deprecated. It ships an MCP server, described as experimental.

For rft that means:

| | Graphiti | rft's own graph |
|---|---|---|
| Setup | a database server (Docker) and an LLM API key per project | none |
| Building the graph | an LLM reads every note: cost, time, and relations that may be wrong | read from the frontmatter: exact |
| Staying in sync | re-ingest on every edit | built at each call |
| Free-text facts inside notes ("CutMix closes the gap at 1k") | extracted as entities and relations | found by `rft_search`, not structured |
| Across projects | one graph for many projects | one tree per project |
| Time | facts valid from / until | note dates, `origin` history |

What Graphiti would add is the extraction of facts from the text and a shared memory across
projects. What it costs is a server, an API bill, and a second copy of the truth that can
drift from the notes.

## Recommendation

1. **First, query the graph rft already has** (small, no dependency): a tool `rft_graph` over
   the in-memory model, e.g.
   - the neighbourhood of a note: parent, children, refs, cited by, origin, concept;
   - "what builds on R03" and "which papers back concept X";
   - paths: how D12 was reached from D00, through which results;
   - "done experiments in concept X since June", "directions that came out of E40".
   With `rft_search` this covers "fast access to the whole tree" for one project.
2. **Then, only if cross-project memory is wanted, an optional bridge to Graphiti**: an export
   that sends each note to a Graphiti instance the user runs, as one JSON episode (id, type,
   status, date, title, concept, edges, the Result or Summary text), so the LLM extracts facts
   from the text while the structure comes in exact. The markdown notes stay the source of
   truth; the bridge is one-way, re-sent when a note changes, and off by default.

## Open questions

- Is cross-project memory actually needed (several research projects that share results and
  papers), or is one tree per project enough?
- If the bridge is built: which LLM pays for the extraction, and is sending note text to that
  API acceptable for unpublished results?
- Should `rft_graph` answer in text only, or also feed the tree view (e.g. highlight a path or
  everything citing a paper)?

## Decision

To take with the user: build `rft_graph` (step 1) as 0.16.0, and leave the Graphiti bridge until
the cross-project question has a yes.
