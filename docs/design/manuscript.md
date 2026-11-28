# Design note: from the tree to snippets and documents

Status: built 2026-11-17 as snippets placed by reference (`\\rftsnippet`); revised the same day
to two levels, snippets and documents, a document holding copies of its snippets. Revised
2026-11-24 to **clean source** (`docs/adr/0003-a-document-holds-no-trace.md`): a document's files
are plain LaTeX that names nothing of the tree, so they can be shared with co-authors as they are;
what ties a document to the tree is kept in a tracking file outside its folder. This note says
what is built now; a document of the first design (copies between `% rft-begin` and `% rft-end`
lines, macros in its text) is converted once, the first time it is read. The user-facing
description is the guide's "Snippets and documents" and "Statuses" (https://alex-pv01.github.io/rft-guide/using/documents/,
https://alex-pv01.github.io/rft-guide/reference/statuses/); Claude's is the manual's
"Verified notes" and "Snippets and documents". Revised 2026-11-24 again to **folders and
templates**: a document is a folder of files made from a template, with a file list, a main file
of any name and an engine of its own; to **git**: a document is a repository of its own, pushed
and pulled by the user from the page, and through GitHub opened in Overleaf; and to **reuse**:
Duplicate, Bring in, a template's files added. Later: clicking in the PDF to jump to the source
line.

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
3. **Numbers, figures, tables and citations come from the tree**, never typed: in a snippet,
   macros read them from what the notebooks saved and from the reference notes; placing a snippet
   writes them out, and each written value is watched, so one the tree has since changed is said.
4. **Provenance and drift are visible.** The plugin knows each copy's snippet and the version it
   was taken from; a copy adapted to its document says so; a copy whose snippet changed since is
   in review; a copy the plugin can no longer find is shown as lost, never dropped silently.
5. **A document's files hold no trace of the tree.** They compile from their folder alone, and
   nothing in them names a note, a snippet or the plugin. A scan finds whatever still does.
6. **Cheap for Claude.** Three tools, loaded only once the vault has snippets or documents; the
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
  S04.tex                     one snippet, with its macros
vault/documents/
  documents.json              the documents' lock
  paper/                      a document: a folder of plain LaTeX, shared as it is
    main.tex                  its main file (any name): its own text, and copies of snippets
    sections/method.tex       any other .tex file it takes in
    refs.bib                  the entries it cites, and the user's own
    figures/loss.pdf          the figures its copies include, under their own names, and uploads
    icml2027.sty, icml2027.bst    its template's files, the document's own from then on
  .rft/paper/tracking.json    what ties the document to the tree, and its main file, engine and
                              template (the plugin's)
  .rft/paper/git/             the document's own git data, once it is connected to a repository
  .rft/paper/first-design/    a converted document's files as they were
  .build/                     what compiling leaves (a document's, and a snippet's alone)
  rft.sty, rft-numbers.tex, refs.bib   generated for a snippet compiled alone
vault/templates/
  icml2027/                   a template of the vault's own: a folder (beside the notes' own
    template.json             templates, which are files); its settings, which are not copied
```

- **A document is a folder made from a template** (`hooks/lib/templates.ts`). A template is a
  folder copied into the new document as it is, sample text included, with no tie afterwards: a
  template changed later changes no document, and nothing changes a document's template for it
  (the preamble is rewritten by hand). `article` and `report` are built in (what a document's kind
  was: a document made before reads as made from the one of its class). A folder of
  `vault/templates/` is the vault's own; the page loads one from a zip, or from a folder it sends
  as a zip (`server/rft_documents.py`: every entry checked before anything is written, links and
  paths leaving the folder refused, 50 MB and 2000 files at most). No network gallery.
- **Its main file** is the one with `\begin{document}`, whatever its name (`mainOf` in
  `copies.ts`, `main_of` on the server): the AAU thesis has `\documentclass` in
  `setup/preamble.tex` and `\begin{document}` in `master.tex`. It is recorded in the tracking
  file once there is no doubt; with several candidates the page asks, and compiling waits.
- **What is in the document** is what the main file takes in, through `\input`, `\include`,
  `\subfile` or a template's own command (`\includepaper`), named from the main file's folder.
  A `.tex` file nothing takes in is flagged, and a copy in it is not counted as placed (in the
  outline, in Used in, in `rft_manuscript`).
- **Its files are the user's to arrange** (the page's file list, `server/rft_documents.py`):
  create, rename, move, delete, upload (20 MB a file). The server writes the tracking file only
  to carry a renamed file's paths and the main file and engine the user chose; all that concerns
  copies and values stays the session's. A name that carries a trace is refused.
- **Its engine** is its own (pdfLaTeX, XeLaTeX or LuaLaTeX); latexmk picks bibtex or biber, and
  runs bibtex per chapter for a bibliography per chapter. Shell escape stays off.
- **Its `.bib` files are ordinary files of the document.** An entry a placed snippet brings goes
  into the `.bib` the file it is placed in uses (`bibFor` / `bib_for`, held to
  `tests/fixtures/local-overleaf/bib.json`): the nearest `\bibliography` or `\addbibresource`
  that covers the file, else what the user chose for it, else the one `.bib` the document names.
  With several and nothing to tell them apart the page asks, once. The user's own entries are
  allowed; a citation that rests on one is said in the page, never in the file.
- **A document is a git repository of its own** (`server/rft_git.py`), once the user connects it
  to a remote by its address. Its folder is the work tree and its git data is among the plugin's
  files (`documents/.rft/<name>/git/`, named on every call), so the folder holds no `.git` and
  the vault's own history keeps the document's files as ordinary files. Git is run by the server
  on the page's request, never through the session, and never prompts; the plugin creates no
  repository and stores no secret. **Push** records all with the user's message and sends; it
  fetches first, and is refused on a trace of the tree, when behind, and while a conflict is
  unresolved, so that nothing is recorded that cannot be sent and no commit ever holds a trace.
  **Pull** fetches and merges; what was not recorded yet is recorded first (refused on a trace,
  as a push is). A conflict stays in the files as git's own lines, and compiling, pulling and
  pushing wait until they are gone. After a pull nothing is rewritten: the copies and values are
  read again from the files (by markers, else by text, else lost; a number a co-author changed
  is no longer the tree's). A document is also made from a repository (cloned; a passage
  declared a copy in it gets its two marker lines, as in any document). Talking to Overleaf
  directly is out of scope: its GitHub sync is the bridge.
- **A thesis is one document**; there is no document inside a document. **Duplicate** makes a
  second document with the same files and tracking, tied to nothing of the first. **Bring in**
  copies a document's files into a new folder of another, once, its tracking carried under the
  new paths (a figure's file is then found in that folder, whether its path in the text has the
  folder before it or not); it rewrites nothing, and says what remains (the body to take in, the
  lines that name a file of the brought document) and what clashes (labels, `.bib` keys).
  **Add a template's files** copies a template into a document without overwriting anything.
- **A snippet** opens with two comment lines, valid LaTeX, readable and editable by hand:
  `% rft-snippet S04 · result · CutMix at 1k images` and `% basis: E05, E02`. Kinds: definition,
  theorem, lemma, proposition, corollary, proof, method, result, related-work, motivation,
  discussion, figure, table; the kind sets the stub's environment. Ids are never reused. A snippet
  stays in the vault and keeps its macros.
- **A copy in a document** is the snippet **written out** as plain LaTeX, between two marker
  lines that say only its kind and title:

  ```latex
  %%% Result: CutMix at 1k images %%%
  …the snippet's text, as placed, or adapted…
  %%% end %%%
  ```

  Written out: `\rftnum{E05}{acc.1k}` as the number, `\rftfig{E08}{loss}` as
  `\includegraphics{figures/loss.pdf}` with the file copied into the document under its own name,
  `\rfttable` as the tabular, `\cite{R07}` as the entry's key with the entry added to the
  document's `.bib`, `\label{S04}` as a label made from the kind and the title (`res:cutmix-at-1k-images`),
  the snippet's comments left out. A macro that names nothing saved refuses the placement, and so
  does a text that would still carry an id. A snippet may have several copies in one document
  (a thesis by papers states a definition in two of them); a copy is named by its snippet, and by
  its number when there are several (`S04#2`). A second copy's labels get names of their own.
- **The tracking file** records, per copy, its snippet, its marker's words, its file, the
  fingerprint of the snippet's content it answers to and the snippet as it was written out; per
  number, figure and table written out, where it came from, what was written, and the text before
  and after it; the `.bib` entries that came from reference notes; the occurrences the user
  allowed in the scan.
- **A copy is found** by its marker lines (in its file, or in another when it was moved by hand),
  else by its text, else it is **lost**. A marker with no `%%% end %%%` is the user's own comment.
  The user points to a lost copy again (a selection in the page) or drops it; a copy found by its
  text gets its marker lines back on request. A passage a co-author wrote can be made a copy of a
  snippet the same way, its text kept.
- **A copy's state**: **in review** when its snippet's content no longer matches the stamp (the
  snippet changed since); **adapted** when its text differs from the snippet as written out (the
  user fitted it to the narrative: shown, not flagged); **its snippet is in review** when the
  snippet's notes changed (shown, so the copy is looked at too); **gone** when the snippet no
  longer exists; **lost** when it is not found. In review, the user **takes the new text** (the
  snippet written out again in its place) or **keeps theirs** (it answers to the snippet as it is
  now, their text kept).
- **A written value's state**: **current**; **in review** when the tree now says something else
  (a notebook saved another number, a figure was saved again); **changed** when something else
  stands in the document, so it is no longer the tree's; **lost** when its place is not found.
  The user **takes** the tree's (the literal replaced, the figure copied again) or **keeps
  theirs** (not flagged again until the tree changes). Taking a number inside a copy does not
  make the copy adapted.
- **Used in**: a snippet lists, per document, each file with a copy of it and how many.
- **The scan** reads a document's folder for traces: the plugin's names and macros, the first
  design's markers, the ids of notes and snippets that exist in this vault (in texts and file
  names), and `.bib` entries of the tree that the document does not cite. An id that is no note's
  is not flagged; an occurrence the user allows is remembered. Claude's edit of an unlocked
  document is refused when it would write a trace.
- **Compiling a document** runs latexmk in its folder, with nothing of the vault or the plugin on
  its path, its output in `.build/<name>/`: what compiles here compiles in Overleaf. A snippet's
  environment that the document does not declare is an error the page answers with one action,
  which adds its `\newtheorem` line to the preamble.

## What a snippet rests on

A snippet's **basis** is the notes on its `% basis:` line plus the notes its text names through
the macros: `\rftnum{E05}{…}`, `\rftfig{E08}{…}`, `\rfttable{E08}{…}`, and `\cite{…}` keys that
belong to a reference note. A note can be the basis of many snippets and a snippet can rest on
many notes; the note's drawer lists them ("Written in"), derived from the snippets.

- **Numbers**: `\rftnum{E05}{acc.1k}` gives the value at that path of `results/E05.json`, as the
  notebook rounded it. Compiled alone, an unknown key prints `??` in bold and is a LaTeX warning.
- **Figures**: `\rftfig[width=.8\linewidth]{E08}{loss}` gives `figures/E08_loss.pdf`, which a
  notebook's run saves from a matplotlib figure beside its SVG.
- **Tables**: `\rfttable{E08}{by_seed}` gives `tables/E08_by_seed.tex`, a booktabs tabular the
  run saves beside the HTML.
- **Citations**: a single-paper reference note is cited by its id (`\cite{R07}`) or by the key of
  its ```` ```bibtex ```` block, a literature note's papers by their keys; a reference with no
  block gets a `@misc`.
- The macros are a snippet's alone. A document holds what they gave when the snippet was placed.
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
  One lock covers all a document's files, and unlocked, Claude writes its `.tex` and `.bib` files
  only: a class or style file is its template's (a venue's kit forbids changing it to gain
  space), an uploaded file is the user's.
  A document's discussion works as a snippet's: comments and suggestions the user accepts.
- The generated files, the registries and the tracking files (`documents/.rft/`) are the
  plugin's: Claude's edits of them are refused, as are its edits of a locked snippet or document,
  a new snippet made by hand, and an edit of an unlocked document that would write a trace.

## Claude's tools and rules

Loaded once `vault/snippets/snippets.json` exists (the `manuscript` feature of
`hooks/lib/tools.ts`); before, they wait behind ToolSearch and no rule is added.

- **`rft_manuscript [snippet | document]`**: the library (each snippet with its kind, title, state,
  basis, and where it is used), each document's copies in order with their state, and the
  verified notes still to write. With a snippet: its notes with what their notebooks saved (as
  macros), and where it is used. With a document: its outline across its files, its lost copies,
  its values to look at and its traces.
- **`rft_set_snippet`** `{id?, kind, title, basis, outline?, text?, edits?}`: a new snippet resting
  on verified notes (a stub while locked), or an unlocked snippet's text. Snippets only.
- **`rft_set_document`** `{name, place?, file?, after?, move?, remove?, template?}`: with a
  template and a name no document has, the document made from it; else a placement the user
  agreed to: a snippet's copy placed in a `.tex` file of the document, after another copy or a
  section heading (or before the bibliography), moved, or removed. Placing writes the snippet out,
  copies its figures in, adds its entries to the `.bib` and records the copy in the tracking file;
  removing takes out what only that copy used.
- **Comments** reuse `rft_comments`, `rft_comment` and `rft_suggest` with a snippet id or a
  document's name.
- **`/rft-manuscript [document]`**: starts the two levels when there are none (a first document),
  else asks Claude for proposals, snippets to write and placements, as a table; nothing is written
  until the user picks. `/rft-manuscript new <name> [template]` adds a document.
- `rft_next` adds the snippets in review, the copies in review and the lost copies by document
  and file, the values the tree changed, the stubs, the verified notes still to write;
  `rft_validate` adds a basis that is no note, a macro naming nothing saved, an unknown citation,
  a reference with no BibTeX, and per document its copies of no snippet, its lost copies, its
  values to look at and the traces in its files.

## The Manuscript tab

One tab, two views, **Snippets** and **Documents**.

- **Snippets**: the library by kind, each with its state, unverified flag, open threads and how many
  documents use it; **+ Snippet** (kind, title, notes); the open snippet in the editor (CodeMirror,
  LaTeX mode) with its notes as chips, **Reviewed**, its padlock, **Used in** with each document
  and file, how many copies it has there and whether one is adapted; the snippet compiled alone
  (a minimal wrapper, with its macros) beside it.
- **Documents**: the document menu, **+ Document** (from a template, or one loaded there from a
  zip or a folder), its padlock, its engine and its main file; the document's files and folders
  (made, renamed, deleted, uploaded there), a text file opened in the editor, an image or a PDF
  shown, the open file with its outline (sections and copies, each copy with its state); its
  repository in its head (Connect, how far behind and ahead, Check, Pull, Push) and the files
  holding a conflict; **More…** (Duplicate, Bring in, Add a template's files); **Place** a snippet from the library in the open file, after a copy or a
  section; **Selection is a copy** ties a passage to a snippet; a copy in review shows the snippet
  as it was placed and as it is now, with **Take the new text** and **Keep mine**; **Lost
  copies** (the selection is it, or drop it), **Values to look at** (take the tree's, or keep
  mine), **Traces of the tree** (allow a false alarm); copies highlighted in the editor, where
  their marker lines are; the PDF and its errors beside it, an undeclared environment with the
  action that declares it.
- Comments and suggestions on a selection, in both views; **Ask Claude** answers in the thread.
- Compiling is the server's (latexmk, shell escape off, 2 minutes), with the key; the PDF goes
  only to the page carrying it. A failed compile keeps the last good PDF.

