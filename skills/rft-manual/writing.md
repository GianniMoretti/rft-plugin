# Verified notes, snippets, documents and slides

A part of the rft manual (the `rft-manual` skill is its core, with the index of the parts).

## Verified notes

- **`verified`** says the user checked what a note claims: an experiment's Result, a theory note's
  Statement and Explanation, a reference's Source and Key results, a direction's Idea. Only the
  user verifies a note, in the tree view, which locks it and stamps it (`verified: <date>
  <fingerprint>` of those sections). Only verified notes become snippets.
- **Suggest it** when a result is final: `rft_set_status {id, status: "verified", note: what was
  checked and how}` writes `suggested_verified:`, which the user accepts or dismisses. It is
  refused, with what is missing, unless the note is done (or in review), not superseded, and: an
  experiment with a notebook reproduced (`reproduced: … ok`); a direction with a verified note
  under it. Edits that write `status: verified` or `verified:` are refused.
- **Review** (↺): a verified note goes there by itself, unlocked, with a History line, when what it
  claims changes (an accepted suggestion, an edit), when it is superseded, or when its notebook's
  run differs or fails. Set one there yourself with `rft_set_status {id, status: "review", note:
  why}` when you find its claim may no longer hold (the session asks the user first, as the note is
  locked). A verified note's other status changes are the user's. `rft_next` lists the notes in
  review and your suggestions waiting.

## Snippets and documents

Verified notes become writing at two levels. Without them (the user starts them with
`/rft-manuscript` or the tree view's Manuscript tab) the tools wait behind ToolSearch and none of
this applies.

- **Snippets** (`<vault>/snippets/S<nn>.tex`) are the building blocks: atomic LaTeX, written once and
  reused, so a definition reads the same in every document. Each opens with
  `% rft-snippet S04 · result · CutMix at 1k images` and `% basis: E05, E02`. Kinds: definition,
  theorem, lemma, proposition, corollary, proof, method, result, related-work, motivation,
  discussion, figure, table.
- **Documents** (`<vault>/documents/<name>/main.tex`) are built with them. A snippet enters a document
  as a copy of its text between `% rft-begin S04 <fingerprint>` and `% rft-end S04`, which the user
  may adapt to the narrative; a document has text of its own too. When a snippet changes, its copies
  go to review (the user takes the new text or keeps theirs); a copy that differs from its snippet
  is "adapted". Never rewrite a copy to follow its snippet yourself.
- **A snippet rests on notes**: its `% basis:` line, and the notes its macros and citations name.
  Never type a number, figure or table of the tree: `\rftnum{E05}{acc.1k}` prints a number of
  `results/E05.json` (the notebook's RESULTS, by path), `\rftfig[width=…]{E08}{loss}` its figure,
  `\rfttable{E08}{by_seed}` its table (the snippet gives the `table`, caption and label).
  `\cite{R07}` cites a reference note; a paper of a literature note is cited by its own key, from
  the ```` ```bibtex ```` block of its entry. When you fill a reference's Source, add its BibTeX in
  such a block: `refs.bib` is made from them.
- **Locked by default**, both levels: the user writes. You:
  - propose snippets only from verified notes, and where to place them. When `rft_manuscript` or
    `rft_next` lists verified notes no snippet rests on, offer two tables, snippets (kind, title,
    basis, what it would say) and placements (which snippet, which document, after which copy or
    heading, why there), and do only what the user picks: stubs with `rft_set_snippet {kind, title,
    basis, outline}` (the outline says the claim, the numbers and the macros that give them, the
    caveats; the body is left to the user), copies with `rft_set_document {name, place, after}`;
  - move or remove a copy only when asked (`rft_set_document {name, move | remove, after}`);
  - comment and suggest when asked, with `rft_comment` and `rft_suggest` and the snippet's id or the
    document's name, as on a note; never write their text (Edit, Write and shell writes to them are
    refused).
- **Unlocked** (by the user's padlocks: all snippets or one, all documents or one): write a snippet
  with `rft_set_snippet {id, text}` or `{id, edits}` (its basis checked, it is stamped; its copies go
  to review), and edit an unlocked document's own text with Edit, keeping its copies' marker lines.
- **Review**: a snippet whose basis note changed since its stamp, went to review, was superseded or
  dropped is in review (`rft_manuscript` says why): point it out and suggest how its text should
  follow; the user marks it **Reviewed**. A copy whose snippet changed is the user's to answer.
- The registries, each document's `.blocks.json` and the generated files (`rft.sty`,
  `rft-numbers.tex`, `refs.bib`, `.build/`) are never edited by hand. The server compiles a document
  or a snippet alone when the user asks; `rft_validate` names a basis that is no note, a macro that
  names nothing saved, an unknown citation, a cited reference with no BibTeX, a copy of no snippet
  and a `\ref{S02}` in a document that holds no copy of S02.

## Slides

Slide decks for meetings and talks are Markdown files in the vault's `decks/` folder (`P01 Weekly
wrap-up.md`), edited and presented in the tree view's Slides tab. Slides are separated by a line
`---`; a slide may open with `<!-- slide layout="title|default|section|two-cols|figure" -->`
(`two-cols` split at a line `::right::`); everything after a line `note:` is the speaker's notes.
`for:` says where it is presented: `G01 2026-11-24` (a meeting's occurrence, by the day its rule
gives it), `G04` (a once-only meeting), `M04` (a deadline); one deck may be for several.

- **The decks are the user's to write.** A deck is locked unless its frontmatter says `locked:
  false`, and a new deck is made in the Slides tab (+ Deck, or + Slides on a meeting in the
  Calendar). Your Edit, Write and shell writes of a locked deck or of a new deck are refused.
- **Asked for slides, propose an outline in the chat**: per slide, its heading, what it shows
  (the claim, the numbers with the notes they come from, the figure: a notebook's figure is
  `![[<id>_<name>.svg]]`) and its speaker note. The user writes it, or unlocks the deck for you.
- **In an unlocked deck, a box or a line places what the layout cannot**: an annotation on a
  figure, a diagram. They are comment lines in the slide's text, before its `note:`, in whole
  numbers of the 1920 × 1080 slide, the later in the text in front:

  ```markdown
  <!-- box x="1180" y="620" w="520" color="contrast" size="40" -->
  gap closes here
  <!-- /box -->
  <!-- box shape="ellipse" x="980" y="410" w="160" h="120" outline="contrast" -->
  <!-- /box -->
  <!-- line from="1180 660" to="1130 500" arrow="end" outline="contrast" -->
  ```

  A box takes `x`, `y`, `w` and holds Markdown (none: a plain shape; a figure alone fills its
  width); `h` fixes its height, which is its text's otherwise. Its other options: `shape` (`rect`,
  `ellipse`), `fill`, `outline`, `color` (its text's), `weight` (`thin`, `medium`, `thick`), `size`
  (its text's), `align` (`left`, `center`, `right`), `valign` (`top`, `middle`, `bottom`). A line
  takes `from`, `to` and `arrow` (`start`, `end`, `both`), `outline`, `weight`. A colour is a
  figure token's name (`text`, `muted`, `accent`, `contrast`, `baseline`, `neutral`, `axis`,
  `grid`, `fill`, `c1` to `c6`) or `#rrggbb`. A slide's options line also takes `split="60"`
  (two columns: the left one's share, 10 to 90) and `title-color`, `title-size` (its heading's
  own).
- `rft_validate` names a `for:` that is no meeting or deadline, a day the meeting does not fall
  on, a skipped occurrence, a recurring meeting named with no day, and each box, line or slide
  option it cannot read in full, by slide and line: run it after writing them.
