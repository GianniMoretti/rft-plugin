# Literature

A part of the rft manual (the `rft-manual` skill is its core, with the index of the parts).

The tree should start from what is already known, not from scratch.

- **A new field: ask first.** When the work turns to a field, method or question the tree does
  not cover yet (no reference or concept about it), ask the user whether to run a thorough
  literature search before planning experiments. Do not start the search unasked: it takes
  time.
- **A new concept: offer a search.** When you propose a concept, offer a literature search for
  it; once agreed, its literature note goes under the concept's start note.
- **`/rft-literature <topic, note id or concept>`** asks for the search directly. Search with the
  tools you have (web search, deep research, arXiv); read each source before writing about it;
  write the whole search as **one literature note** under the note or concept it is about:
  `rft_add_node` with `type: reference`, `tags: ["literature"]`, title `Literature on <topic>`,
  and sections **Search** (what, with which tools, when), **Papers** (one `### <year> <first
  author> — <title>` entry per key paper, usually 4 to 10: a link that can be checked, what it
  claims and how, key results as reported, what it means for the project), **Synthesis** and
  **Relevance**. Not a note per paper: a paper gets a reference note of its own only once the
  user chooses it. Then call `rft_collect_papers` with the note's id, give a short synthesis
  (known, open, setups to start from) and list the directions it suggests and the papers worth
  a note of their own: add them only once the user chooses. The tree shows literature notes in
  a colour of their own (cyan; `▤` in the pane).
- **Every paper of a search goes to the inbox.** Once the literature note is written, save each
  paper it lists as an entry with `rft_inbox {link, title, why}`, the why naming the search and
  its note ("entry of R07, literature search on <topic>"): the user may then read it closely,
  keep a reading note of it and decide what it becomes. A search also turns up more papers than
  it reads: those that look worth reading and were not read are neither written about nor
  dropped, and are saved the same way ("from the literature search on <topic>, not read"). Say
  how many of each were saved. A paper already in the inbox, processed or a reference of its own
  is reported by the tool and not added. This is for a search made from now on: a literature
  note that already exists is left as it is unless the user asks for its papers. The user
  processes them when they choose (`inbox.md`).
- **Papers in the vault.** `rft_collect_papers(ids?)` downloads, in the background, the PDFs of
  reference notes whose **Source** has an arXiv id or link, or a PDF link on an open-access
  host (OpenReview, PMLR, ACL Anthology, NeurIPS and CVF proceedings, JMLR, bioRxiv...), into
  `papers/<concept>/<year> <first author> <title>.pdf`, and links each from its note with
  `pdf:` (in a literature note, one PDF per `###` entry, linked by a `PDF:` line in the entry). Run again after concepts change: saved PDFs move to their concept's folder. It never
  downloads from paywalled publishers; for those, the note keeps its DOI.
- **Experiments start from a paper.** A proposed experiment says which reference's setup it
  starts from (baseline, data, protocol) and links it in `refs` (rule 5 of "When to create and update nodes", in the
  core). If there is
  none, say so: it is a sign a search is missing.
- Never invent a citation, an author, a year or a result.
