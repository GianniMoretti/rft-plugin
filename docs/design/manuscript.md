# Design note: from the tree to a manuscript

Status: proposed 2026-11-17, to be built in the phases at the end.

## The problem

The tree is a good knowledge base, but research ends in writing: papers, a thesis, articles,
later blog posts. Today the path from a result in the tree to a paragraph in a paper goes through
the user's memory and copy-paste: numbers are typed again, a superseded result stays in the draft,
and nothing says which paragraph rests on which experiment.

The manuscript is the place where findings are consolidated into text, one **snippet** of LaTeX at
a time, each linked to the notes it rests on. As with locked notes, the writing is the user's:
Claude proposes what to write and comments on it, and writes only when the user unlocks it.

## Principles

1. **Only what was checked goes in.** A new status, `verified`, set by the user alone, marks a note
   whose claim they checked. Claude proposes snippets only from verified notes.
2. **The user writes.** The manuscript is locked by default: Claude proposes snippets as stubs
   (what to say, which notes back it), comments and suggests; the user writes the text.
3. **Numbers, figures, tables and citations come from the tree**, never typed: macros read them
   from what the notebooks saved and from the reference notes.
4. **A change upstream reaches the text.** When a note a snippet rests on changes or is
   disproved, the note goes to `review` and so does every snippet resting on it.
5. **Cheap for Claude.** Two new tools, loaded only once the vault has a manuscript; the rest
   reuses the comment tools and `rft_set_status`.

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

## The manuscript on disk

```
vault/manuscript/
  manuscript.json             lock, snippet registry and stamps, next id
  snippets/S04.tex            one snippet
  documents/<name>/main.tex   a document: the snippets it uses, in order
  rft.sty                     generated: \rftnum, \rftfig, \rfttable, \rftsnippet, theorem styles
  rft-numbers.tex             generated: every notebook's RESULTS as macros
  refs.bib                    generated: the reference notes' BibTeX
  .build/<name>/              latexmk's output, the PDF
```

- **Snippets are shared, documents assemble them.** A definition is written once and used by the
  paper and the thesis chapter. A document is the user's LaTeX (`\documentclass`, preamble,
  `\usepackage{rft}`, `\bibliography{refs}`), with one `\rftsnippet{S04}` line per snippet; it can
  hold text of its own (an abstract), but what rests on the tree goes in snippets.
- **A snippet** is `snippets/S<nn>.tex`, ids never reused (`next` in `manuscript.json`). It
  opens with two comment lines, valid LaTeX, readable and editable by hand:

  ```latex
  % rft-snippet S04 · result · CutMix at 1k images
  % basis: E05, E02
  ```

  Kinds: definition, theorem, lemma, proposition, corollary, proof, method, result,
  related-work, motivation, discussion, figure, table. The kind sets the stub's environment
  (`\begin{definition}`, `\paragraph{…}`, a `figure` float) and what its outline asks for.
- **`manuscript.json`**:

  ```json
  { "locked": true, "next": 5,
    "snippets": { "S04": { "stamp": { "E05": "a1b2c3d4", "E02": "9f8e7d6c" }, "proposed": "2026-11-17" } },
    "unlocked": ["S07"] }
  ```

## What a snippet rests on

A snippet's **basis** is the notes on its `% basis:` line plus the notes its text names through
the macros: `\rftnum{E05}{…}`, `\rftfig{E08}{…}`, `\rfttable{E08}{…}`, and `\cite{…}` keys that
belong to a reference note. A note can be the basis of many snippets and a snippet can rest on
many notes; the note's drawer lists the snippets resting on it ("Written in: S04, S07"), derived
from the snippets, so nothing is written into the note.

- **Numbers**: `\rftnum{E05}{acc_cutmix}` prints the value of `acc_cutmix` in `results/E05.json`
  (the notebook's `RESULTS`, rounded as it rounds them). An unknown key prints `??` in bold and
  is a LaTeX warning, as an undefined reference is.
- **Figures**: `\rftfig[width=.8\linewidth]{E08}{loss}` includes `figures/E08_loss.pdf`. A
  notebook run saves each matplotlib figure twice, `.svg` for the tree view and the artifacts,
  `.pdf` for LaTeX. A figure given as SVG text has no PDF: the check says so.
- **Tables**: `\rfttable{E08}{accuracy_by_seed}` inputs `tables/E08_accuracy_by_seed.tex`, a
  booktabs `tabular` the notebook run saves beside the `.html` (no float: the snippet gives the
  `table`, its caption and label).
- **Citations**: `refs.bib` is generated from the reference notes. A ```` ```bibtex ```` block in a
  note's Source gives its entry; a single-paper note is cited by its id (`\cite{R07}`), a paper
  of a literature note by its own key (`\cite{zhang2018mixup}`, that note's entry for it). A
  reference with no BibTeX block gets a `@misc` from its title and its first link, and the check
  says it has none. The manual asks Claude to write the BibTeX block when it fills a Source.
- **Stamp and state.** When a snippet is written (by Claude, unlocked) or marked **Reviewed** by the
  user, `manuscript.json` stamps it with the fingerprint of each basis note's substance. A
  snippet is:
  - **stub**: nothing but comments and its heading, waiting for the user's text;
  - **written**;
  - **review**: a basis note's substance no longer matches its stamp, or a basis note is in
    review, superseded or dropped; it says which ("review: E05 superseded by E09"). Numbers
    printed by `\rftnum` follow the note they name; the review flag asks whether the sentence
    around them still holds;
  - and, apart from its state, **unverified** when a basis note is not verified: allowed when the
    user links it, flagged until that note is verified.

## Locked by default

- `manuscript.json` `locked: true` (the default) makes every snippet and document the user's.
  Claude's Edit, Write and shell writes to `vault/manuscript/` are refused, as for a locked
  note; the generated files (`rft.sty`, `rft-numbers.tex`, `refs.bib`, `.build/`) are refused
  always.
- Locked, Claude:
  - **proposes** a snippet as a stub with `rft_set_snippet`: the two header lines, the kind's
    environment, and an outline as comments (the claim, the numbers and which macros give them,
    the caveats, what it relies on), the body left for the user;
  - places a new stub in a document (`\rftsnippet{S04}` after another), since it prints nothing
    the user did not write;
  - **comments and suggests** on the text with `rft_comment` and `rft_suggest`, as on a note
    (snippet ids are accepted wherever a note id is); the user accepts or rejects;
  - never writes the text.
- The user can unlock the whole manuscript (the tab's padlock) or one snippet. Unlocked, Claude
  writes the text with `rft_set_snippet` (whole, or edits), which stamps it; its basis is
  checked as for a stub.

## Claude's tools and rules

Loaded only once `vault/manuscript/manuscript.json` exists (the `manuscript` feature of
`hooks/lib/tools.ts`); before, they wait behind ToolSearch and no rule is added.

- **`rft_manuscript [document | snippet]`**: in a few lines, the documents with their snippets in
  order (id, kind, title, state, unverified basis), the snippets in no document, whether it is
  locked, and **still to write**: the verified notes no snippet rests on, by concept. With a
  snippet: its basis notes with status and summary, what changed since its stamp, its open
  threads, and its file's path (read it with Read).
- **`rft_set_snippet`** `{id?, kind, title, basis, outline?, text?, edits?, document?, after?}`:
  without `id`, a new snippet (a stub, or with `text` when unlocked), placed in `document`;
  with `id`, its text (unlocked only). Refuses a basis note that is not verified, an unknown
  macro key, and text while locked (pointing to `rft_suggest`).
- **Comments** reuse `rft_comments`, `rft_comment` and `rft_suggest` with snippet ids.
- **The rule** (one line, in a vault with a manuscript): propose snippets only from verified notes
  and as stubs while locked; when `rft_manuscript` or `rft_next` lists verified notes with no
  snippet, offer stubs for them as a table (kind, title, basis) and create only the ones the
  user picks; never type a number, figure or table the macros give.
- **`/rft-manuscript [document]`**: starts the manuscript when there is none (the folder, a first
  document from a template: article or thesis chapter), else asks Claude for its proposals as a
  table; nothing is written until the user picks.
- `rft_next` adds the snippets in review and the verified notes still to write; `rft_validate`
  adds a basis note that does not exist, an unknown `\rftnum` key, a figure with no PDF, a
  `\cite` key in no reference note, a reference with no BibTeX.

## The Manuscript tab

A fifth view after Calendar.

- Left: the documents (a menu) and the selected document's snippets in order, then the ones in
  no document, each with its kind, title and state (stub, written, review, unverified); **+
  Snippet** adds one (kind, title, basis from a list of notes).
- Middle: the editor, CodeMirror 5 with its LaTeX mode (vendored in `web/vendor/`, MIT), on a
  snippet or a document's `main.tex`. Above it, the snippet's basis as chips (status dot, id,
  title): a click opens the note in the drawer; **Reviewed** when it is in review; its padlock.
  **Save** or Ctrl/Cmd+S writes it and compiles; a file changed meanwhile asks **Overwrite** or
  **Reload**, as a note does.
- Right: the document's PDF, in the browser's own viewer, and under it the compile's errors, each
  a link to its snippet and line.
- Comments and suggestions on a snippet as on a note: select text, **Comment** or **Suggest**, the
  threads marked in the editor and listed as margin cards, **Ask Claude** to the subagent.
- The note drawer gains **Verify**, Claude's suggested verification (Accept, Dismiss), and
  **Written in** with links to the snippets.
- Compiling is the server's: `latexmk -pdf -interaction=nonstopmode -halt-on-error
  -no-shell-escape`, in `documents/<name>/`, output in `.build/<name>/`, `TEXINPUTS` and
  `BIBINPUTS` pointing at `vault/manuscript/`, stopped after 2 minutes, after `rft.sty`,
  `rft-numbers.tex` and `refs.bib` are generated anew. It needs the page's key, as an edit does,
  and `latexmk` on `PATH`; without it the tab says so. The PDF is served with the key only.
- Later: clicking in the PDF to jump to the source line (SyncTeX and pdf.js); an HTML export for
  blog posts.

## Phases

Each phase ships with its tests and lands on `main`.

1. **Verified and review.** The statuses in the plugin, the server and the page; Claude's
   suggestion through `rft_set_status`; **Verify** in the drawer (asked of the session, as Add
   child is, so one fingerprint code); the stamp and the lock; review on a changed substance (the
   session's watch of the vault), on supersede, on a notebook check that differs or failed; the
   tree, kanban, filters and legend; `rft_next` and `rft_validate`.
2. **The manuscript model and tools.** `manuscript.json`, snippets and their headers, the basis
   and stamps, `rft_manuscript`, `rft_set_snippet`, the guards, comments on snippets, the rule
   and the feature, `rft_next`, `rft_validate`, `/rft-manuscript`.
3. **LaTeX.** Notebook runs save PDF figures and `.tex` tables; `rft.sty`, `rft-numbers.tex`,
   `refs.bib`; the compile. The referee: an end-to-end test on the demo (as
   `tests/test_pipeline.py`) where a snippet using `\rftnum{E05}{…}` compiles and the number
   `pdftotext` reads from the PDF equals `results/E05.json`; and a plugin test where Claude's Edit
   of a snippet in a locked manuscript is refused.
4. **The Manuscript tab.** CodeMirror, the snippet list, the editor, the PDF and errors, the basis
   chips, Reviewed, the padlocks, comments on snippets, the drawer's Verify and Written in.
5. **Documentation.** README, the manual, `/rft-update` for an older vault.
