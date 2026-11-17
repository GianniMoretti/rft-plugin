# Design note: from the tree to snippets and documents

Status: built 2026-11-17 as snippets placed by reference (`\\rftsnippet`); revised the same day
to two levels, snippets and documents, a document holding copies of its snippets (below). The
user-facing description is the README's "Snippets and documents" and "Statuses"; Claude's is the
manual's "Verified notes" and "Snippets and documents". Later: clicking in the PDF to jump to the
source line, an HTML export for blog posts.

## The problem

The tree is a good knowledge base, but research ends in writing: papers, a thesis, articles,
later blog posts. Today the path from a result in the tree to a paragraph in a paper goes through
the user's memory and copy-paste: numbers are typed again, a superseded result stays in the draft,
nothing says which paragraph rests on which experiment, and a definition drifts from one document
to the next.

## Two levels: snippets, the building blocks; documents, what is built with them

- **Snippets** consolidate what the tree found, one atomic unit of LaTeX at a time (a definition,
  a theorem, a result, a method, related work), each resting on the notes it states. They are
  written once and reused: the same definition in the paper and the thesis, in the same words.
- **Documents** (a paper, a thesis chapter, an article) are built from snippets. A snippet enters
  a document as a **copy of its content**, at the place the user approved, kept referenced to the
  snippet it came from. In the document the copy may be adapted to the narrative; the document has
  text of its own too (transitions, an abstract, the structure).
- **A change goes up one level at a time, never silently.** A note that changes sends its snippets
  to review; a snippet that changes sends its copies to review in every document holding one. The
  document's text is never rewritten by itself: the user takes the new text or keeps theirs.
- As with locked notes, the writing is the user's: Claude proposes snippets (from verified notes)
  and where to place them, comments and suggests, and writes only where the user unlocks it.

## Principles

1. **Only what was checked goes in.** A new status, `verified`, set by the user alone, marks a note
   whose claim they checked. Claude proposes snippets only from verified notes.
2. **The user writes.** Snippets and documents are locked by default: Claude proposes snippets as
   stubs and placements as a table, comments and suggests; the user writes and accepts.
3. **Numbers, figures, tables and citations come from the tree**, never typed: macros read them
   from what the notebooks saved and from the reference notes, in snippets and in their copies.
4. **Provenance and drift are visible.** Each copy names its snippet and the version it was taken
   from; a copy adapted to its document says so; a copy whose snippet changed since is in review.
5. **Cheap for Claude.** Three tools, loaded only once the vault has snippets or documents; the
   rest reuses the comment tools and `rft_set_status`.

## Two new statuses: verified and review

Statuses become: idea, planned, running, done, **review**, **verified**, dropped, discussed, moved.
Everything that treats `done` as finished (results, the calendar, notebooks, artifacts) treats
`review` and `verified` the same way.

- **Verified**: the user checked the note's claim. Any type can be verified:
  - an experiment: its result (with a notebook, only once its last run reproduced it: `ok`);
  - a theory note: its definition, theorem, proof or argument;
  - a reference: the paper read and its summary checked against the source;
  - a direction: a hypothesis confirmed (at least one verified note under it).
- **Only the user verifies.** In the tree view: **Verify** in the drawer, on a note that is done or
  in review. Claude suggests it: `rft_set_status {id, status: "verified", note}` writes
  `suggested_verified: "<why, one line>"` instead of the status, and the user accepts or
  dismisses it in the drawer (as a suggested priority). Claude's edits that write `status:
  verified` or `verified:` are refused. A suggestion whose prerequisites are not met (above) is
  refused with what is missing; the user can verify anyway, after a warning.
- **Verifying locks the note** (`locked: true`) and stamps it: `verified: "2026-11-17 a1b2c3d4"`,
  the date and a fingerprint of what the note claims, its **substance**:
  - experiment: `## Result` (the notebook's table included);
  - theory: `## Statement` and `## Explanation`;
  - reference: `## Source` and `## Key results`;
  - direction: `## Idea`;
  whitespace collapsed, so reflowing a paragraph changes nothing. Other sections (Code, Directions
  found, History) and the frontmatter are not substance.
- **Review**: a verified note whose claim may no longer hold. The plugin sets it, **unlocks the
  note** and writes a History line with the reason, when:
  - its substance no longer matches the stamp: an accepted suggestion, the user's own edit (in the
    drawer or Obsidian), a notebook recording new numbers;
  - it is superseded (`rft_supersede`, which already asks the user to unlock a locked note);
  - its notebook's check `differs` or `failed`;
  - the user, or Claude, sets it by hand (`rft_set_status review`; on a locked note the plugin
    asks the user first, as for a move).
  The user then verifies it again (locked and stamped anew) or gives it another status.
- **Seen**: the tree draws a verified note at full strength with a ring, a note in review with a
  dashed ring; the kanban has a Review and a Verified column after Done; filters and the legend
  know both. `rft_next` lists the notes in review (to check again) and Claude's suggested
  verifications waiting for the user.

## On disk

```
vault/snippets/
  snippets.json               the lock, each snippet's stamp (its notes), the next id
  S04.tex                     one snippet
vault/documents/
  documents.json              the documents' lock
  paper/main.tex              a document: its own text, and copies of snippets
  paper/.blocks.json          each copy's snippet text when it was taken (for the review's then/now)
  rft.sty, rft-numbers.tex, refs.bib, .build/   generated when a document or snippet compiles
```

- **A snippet** opens with two comment lines, valid LaTeX, readable and editable by hand:
  `% rft-snippet S04 · result · CutMix at 1k images` and `% basis: E05, E02`. Kinds: definition,
  theorem, lemma, proposition, corollary, proof, method, result, related-work, motivation,
  discussion, figure, table; the kind sets the stub's environment. Ids are never reused.
- **A copy in a document** is the snippet's text (below its header) between two comment lines:

  ```latex
  % rft-begin S04 3f2a1c9d
  …the snippet's text, as taken, or adapted…
  % rft-end S04
  ```

  `3f2a1c9d` is the fingerprint of the snippet's content when it was taken (or last reviewed):
  its text without comments, whitespace collapsed, so an outline comment changes nothing. A
  snippet is copied at most once in a document.
- **A copy's state**: **in review** when its snippet's content no longer matches the stamp (the
  snippet changed since); **adapted** when its text differs from the snippet's (the user fitted it
  to the narrative: shown, not flagged); **its snippet is in review** when the snippet's notes
  changed (shown, so the copy is looked at too); **gone** when the snippet no longer exists. In
  review, the user **takes the new text** (the copy replaced by the snippet's text, restamped) or
  **keeps theirs** (restamped, their text kept). `.blocks.json` keeps the snippet's text at the
  stamp so the review shows the snippet then and now.
- **Used in**: a snippet lists the documents holding a copy of it, adapted or not.

## What a snippet rests on

A snippet's **basis** is the notes on its `% basis:` line plus the notes its text names through
the macros: `\rftnum{E05}{…}`, `\rftfig{E08}{…}`, `\rfttable{E08}{…}`, and `\cite{…}` keys that
belong to a reference note. A note can be the basis of many snippets and a snippet can rest on
many notes; the note's drawer lists them ("Written in"), derived from the snippets.

- **Numbers**: `\rftnum{E05}{acc.1k}` prints the value at that path of `results/E05.json`. An
  unknown key prints `??` in bold and is a LaTeX warning.
- **Figures**: `\rftfig[width=.8\linewidth]{E08}{loss}` includes `figures/E08_loss.pdf`, which a
  notebook's run saves from a matplotlib figure beside its SVG.
- **Tables**: `\rfttable{E08}{by_seed}` inputs `tables/E08_by_seed.tex`, a booktabs tabular the
  run saves beside the HTML.
- **Citations**: `refs.bib` is made from the reference notes' ```` ```bibtex ```` blocks: a
  single-paper note cited by its id (`\cite{R07}`) or its key, a literature note's papers by their
  keys; a reference with no block gets a `@misc`.
- **Stamp and state**: when a snippet is written (by Claude, unlocked) or marked **Reviewed** by
  the user, `snippets.json` stamps it with the fingerprint of each basis note's substance. A
  snippet is a **stub** (nothing but its outline and environment), **written**, or **in review**
  (a basis note changed since the stamp, is in review, superseded or dropped), and flagged
  **unverified** when a basis note is not verified (the user may link one; Claude may not).

## Locks

- **Snippets** (`snippets.json`, locked by default): Claude proposes stubs and comments or suggests
  on the text; the user unlocks all of them, or one, for Claude to write too.
- **Documents** (`documents.json`, each locked by default): their text is the user's. Claude
  proposes placements (which snippet, where) as a table and places only the ones the user picks,
  with `rft_set_document`; it edits a document's text only once the user unlocks that document.
  A document's discussion works as a snippet's: comments and suggestions the user accepts.
- The generated files, the registries and `.blocks.json` are the plugin's: Claude's edits of them
  are refused, as are its edits of a locked snippet or document and a new snippet made by hand.

## Claude's tools and rules

Loaded once `vault/snippets/snippets.json` exists (the `manuscript` feature of
`hooks/lib/tools.ts`); before, they wait behind ToolSearch and no rule is added.

- **`rft_manuscript [snippet | document]`**: the library (each snippet with its kind, title, state,
  basis, and the documents using it), each document's outline (its copies in order with their
  state), and the verified notes still to write. With a snippet: its notes with what their
  notebooks saved (as macros), and where it is used. With a document: its sections and copies.
- **`rft_set_snippet`** `{id?, kind, title, basis, outline?, text?, edits?}`: a new snippet resting
  on verified notes (a stub while locked), or an unlocked snippet's text. Snippets only.
- **`rft_set_document`** `{name, place?, after?, move?, remove?}`: a placement the user agreed to:
  a snippet's copy placed after another copy or a section heading (or at the end), moved, or
  removed. Placing copies the snippet's current text and stamps it.
- **Comments** reuse `rft_comments`, `rft_comment` and `rft_suggest` with a snippet id or a
  document's name.
- **`/rft-manuscript [document]`**: starts the two levels when there are none (a first document),
  else asks Claude for proposals, snippets to write and placements, as a table; nothing is written
  until the user picks. `/rft-manuscript new <name> [article|report]` adds a document.
- `rft_next` adds the snippets in review, the copies in review by document, the stubs, the verified
  notes still to write; `rft_validate` adds a basis that is no note, a macro naming nothing saved,
  an unknown citation, a reference with no BibTeX, a copy of no snippet, and a `\ref{S02}` in a
  document that holds no copy of S02.

## The Manuscript tab

One tab, two views, **Snippets** and **Documents**.

- **Snippets**: the library by kind, each with its state, unverified flag, open threads and how many
  documents use it; **+ Snippet** (kind, title, notes); the open snippet in the editor (CodeMirror,
  LaTeX mode) with its notes as chips, **Reviewed**, its padlock, **Used in** with each document
  and whether its copy is adapted; the snippet compiled alone (a minimal wrapper) beside it.
- **Documents**: the document menu, **+ Document**, its padlock; its outline (sections and copies,
  each copy with its state); **Place** a snippet from the library after a copy or a section; a
  copy in review shows the snippet then and now, with **Take the new text** and **Keep mine**; the
  editor on `main.tex`, copies highlighted; the PDF and its errors beside it.
- Comments and suggestions on a selection, in both views; **Ask Claude** answers in the thread.
- Compiling is the server's (latexmk, shell escape off, 2 minutes), with the key; the PDF goes
  only to the page carrying it. A failed compile keeps the last good PDF.

