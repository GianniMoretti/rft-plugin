# Design note: slide decks for meetings and talks

Status: designed 2026-11-21; phase 1 built the same day. The user-facing description is the README's
"Slides", Claude's the manual's "Slides".

## The problem

Research is presented as well as written: the weekly wrap-up with supervisors (what was done,
what is next), a paper presented to the lab, a talk at a workshop. Today that goes through
PowerPoint or Google Slides, outside the tree: numbers are typed again, a figure is pasted as a
screenshot, a deck shown on Tuesday still holds the number that was superseded on Monday, and
nothing ties the deck to the meeting it was made for.

## What a deck is

- **A Markdown file in the vault**, `vault/decks/P03 Weekly wrap-up.md`: one deck, its slides
  separated by a line `---`, as Obsidian's Slides plugin reads them. The text is the source of
  truth; the editor's preview, the presentation and the PDF are all drawn from it by one renderer,
  so what is edited is what is shown. A deck stays readable and editable by hand, in Obsidian or
  any editor, diffs as text in git, and costs Claude few tokens to read.
- **Not a canvas of positioned objects** (PowerPoint's model): that format is costly to build an
  editor for, unreadable in a diff, poorly written by Claude, and closed to Obsidian. The
  PowerPoint feel (boxes dragged and resized on the slide) is direct manipulation of the rendered
  slide that writes the box's attributes back into the text (as Slidev's `v-drag` does): "Boxes
  and lines" and "The slide tools" below.
- **Ids** P01, P02, ... (P for presentation), never reused, like the meetings' G and the
  deadlines' M. The folder is outside the tree: a deck is no note.

## On disk

```markdown
---
id: P03
type: deck
for: [G01 2026-11-24]
locked: true
---

# CutMix at 1k images
Since 17 Nov: [[E05]] verified, [[E08]] running

---
<!-- slide layout="two-cols" -->

## Accuracy holds at 1k images

![[E08_loss.svg]]

::right::

- 3 seeds so far
- the gap closes at 10k

note: say why 1k and not 10k
```

- **Frontmatter**: `id`, `type: deck`, `for:` (what it is presented at, below), `locked:`
  (below), and later `theme:`. The title is the file's name after the id, as a meeting's is.
- **Slides**: split at a line that is exactly `---` (outside a code block). A slide may open with
  `<!-- slide layout="…" -->`, an HTML comment so Obsidian's reading view hides it.
- **Layouts** (phase 1): `default` (a heading, then the content), `title` (centred title and
  subtitle; the first slide's default), `section` (a divider), `two-cols` (split at a line
  `::right::`), `figure` (one image filling the slide under its heading).
- **Speaker notes**: everything after a line starting `note:` (any case), as Obsidian's Advanced
  Slides plugin and reveal.js read them. Notes are never shown on the slide or in the PDF.
- **Content**: the Markdown notes use (web/markdown.js), so wikilinks to notes, KaTeX math,
  images found as Obsidian finds them (`![[E08_loss.svg]]` finds the notebook's figure in
  `vault/figures/`), lists, tables, code.
- **The canvas** is a fixed 1920×1080 slide, scaled to fit the editor, the screen or the PDF page,
  so a slide is laid out the same everywhere.

## Boxes and lines

Designed and built 2026-11-23 (the format: read from the text and drawn; the tools that write it
are below). A layout places a slide's content in its **slots** (the heading, a column, the
figure, the caption). What the user places themselves is a **box** or a **line**, written as
comment lines in the slide's text, as its options line is:

```markdown
## Accuracy holds at 1k images

![[E08_loss.svg]]

<!-- box x="1180" y="620" w="520" color="accent" size="40" -->
gap closes here
<!-- /box -->

<!-- box shape="ellipse" x="980" y="410" w="160" h="120" outline="contrast" -->
<!-- /box -->

<!-- line from="1180 660" to="1130 500" arrow="end" outline="contrast" -->
```

- **A box** has a place and a size (`x y w h`, whole numbers on the 1920×1080 slide), a shape
  (a rectangle, or `shape="ellipse"`), an optional `fill` and `outline` (its `weight` `thin`,
  `medium` or `thick`: 2, 4 or 8 units), and Markdown content: text, a figure of the tree (by
  reference, so it follows its notebook), an image, or nothing. A text box, a labelled rectangle
  and a placed figure are all boxes. A box may leave `h` out: its height then follows its text,
  which is never shrunk to fit. Its text takes `color`, `size`, `align` (`left`, `center`,
  `right`) and, in a box with a height, `valign` (`top`, `middle`, `bottom`). A figure or an image
  alone in a box fills its width, its proportions kept.
- **A line** runs between two points (`from`, `to`), with `arrow="start"`, `"end"` or `"both"`,
  an `outline` and a `weight`. It is not attached to the boxes it points at.
- **A colour** is the name of one of the project's figure tokens (`text`, `muted`, `accent`,
  `contrast`, `baseline`, `neutral`, `axis`, `grid`, `fill`, and `c1` to `c6`, the categorical
  ones) or `#rrggbb`; the tools write the name, so a change of tokens recolours the deck. Colour,
  size and alignment apply to a whole box, never to a run of words.
- **Order**: a box belongs to its slide wherever its lines sit in the slide's text; the tools
  write new ones after the slot content and before `note:`. Later in the text is nearer the front,
  and all of them are in front of the layout.
- **By hand**: a box left unclosed runs to the end of its slide (to the next box, or to the
  speaker's notes, when one comes first); that, a position that is no whole number and an
  unknown option, value or colour name are listed under the text, by slide and line, and by
  `rft_validate`, and the slide still draws: such a box at the slide's corner, 480 wide, in the
  layout's style; a colour there is none of as the text's; a line with no place not at all.
  Inside a box that is closed, a line `note:` and a line's comment are the box's text.
- **Checked** by `tests/test_slides.py`: a deck written by hand, each box and line measured in
  headless Chromium against the numbers in its text, in the slide beside the text, its thumbnail,
  the presentation and the pages the PDF is printed from.
- **In Obsidian**, the reading view hides the comment lines and shows a box's text as an
  ordinary paragraph.
- **Not** Advanced Slides' `<grid drag="w h" drop="x y">`, the first plan: it renders only with
  that plugin, plain Obsidian does not read its content as Markdown, and it has no lines or
  ellipses.

## The slide tools

Designed 2026-11-23; built so far: move and resize, add and style, a box's Markdown edited over it, figures and images
(`web/slide-tools.js` on the slide, `web/slide-edit.js` the edits of the text). The editor's slide is an editing surface, with a toolbar
above it. Every action is an edit of the deck's text and of nothing else, and changes only the
lines of what it acts on; the text pane stays beside the slide (a toggle hides it), its cursor
and the slide's selection in step, and undo is one history for both.

- **Boxes and lines**: selected by a click (several by shift-click or a dragged rectangle),
  moved by a drag, resized by handles (a line by its two ends), snapping to the slide's centre
  and edges and to other boxes; nudged by the arrow keys; deleted, duplicated, copied and pasted
  as their text; brought forward and sent back; several aligned and distributed.
- **Added** from the toolbar: Text, Rectangle, Ellipse, Line, Arrow, Figure (a picker of the
  tree's figures, by note), Image (also pasted or dropped, saved in `vault/decks/assets/`). A
  figure or image keeps its proportions.
- **Text** is edited in place as its Markdown source: a double-click opens it over the box or
  slot at the slide's size, Esc or a click outside draws it again. Math, wikilinks and macros
  stay exact, and nothing converts HTML back to Markdown.
- **Slots**: their content is selected, edited in place and dragged to another slot, but not
  freely; **Detach** makes it a box in the same place. The columns' divider is dragged
  (`split="60"` on the slide's options line), the heading's colour and size may be set per slide
  (`title-color`, `title-size`), and a gallery changes the slide's layout.
- **Not**: rotation, grouping, lines attached to boxes, freehand drawing, cropping, opacity, a
  style on a run of words, editing on a phone.
- The lock is as it was: these are the user's edits. On an unlocked deck Claude writes boxes and
  lines as text.

Checked by three slides built with the tools (a two-column wrap-up slide; a figure annotated
with an ellipse, an arrow and a line of text; a diagram of three labelled rectangles and two
arrows), by a test that drags in headless Chromium and requires the box within 1 px of where
it was dropped and every other byte of the deck as it was, and by the user rebuilding one of
their own slides and comparing the two PDFs.

## What a deck is for

`for:` lists where the deck is presented; a deck may be for nothing (a talk not in the calendar
yet) or for several (a practice talk and the real one: one deck, so a change reaches both).

- **A meeting's occurrence**: `G01 2026-11-24`, the meeting's id and the day its rule gives that
  occurrence. A once-only meeting may be named by its id alone.
- **A deadline**: `M04` (a talk, a defence).

An occurrence keeps its deck however it is moved: the day is the rule's day, as in the meeting's
own `moved: ["2026-11-24 → 2026-11-25 10:00"]`, so a deck for the 24th is shown on the 25th. The
Calendar draws the deck's mark on that occurrence and its popover lists the deck (**Open**) or
offers **+ Slides** (a deck `for:` that occurrence, titled after the meeting and the day).

`rft_validate` warns about a `for:` that names no meeting or deadline, a day that is no
occurrence of the meeting, an occurrence that was skipped (the deck is presented nowhere), and a
recurring meeting named without a day (which occurrence?).

## Locks

The decks are the user's to write, as the snippets are.

- A deck is **locked** unless its frontmatter says `locked: false`; the Slides tab writes
  `locked: true` in every new deck and has a padlock to change it.
- Claude's Edit, Write and shell writes in `vault/decks/` are refused on a locked deck, and for a
  new deck made by hand (decks are numbered by the plugin). Claude proposes an **outline** instead:
  in the chat first; with `rft_set_deck` (phase 3) a new deck whose slides are its outline (a
  heading and what the slide should show, as a comment), for the user to write.
- On an unlocked deck Claude may write the text too.

## The Slides tab

A tab after Manuscript, its page icon a slide on an easel.

- **The list**: the decks for what comes next first (soonest occurrence or deadline first, with
  its name and day), then those for nothing, then the past ones (latest first). Each shows its
  padlock. **+ Deck**: a title and what it is for (the meetings' next occurrences, the deadlines
  ahead, or nothing).
- **The editor**: CodeMirror on the deck's text, saved as it is typed (as a note's text is, with
  the version it was read at: a deck changed on disk meanwhile is not overwritten); beside it the
  slide the cursor is in, drawn as it will be shown; above them the slides as thumbnails, a click
  going to the slide's text.
- **Present**: full screen from the slide in view (or the first), → ↓ space PageDown next, ← ↑
  PageUp back, Home and End, Esc out; the slide number in a corner.
- **PDF**: the browser's print of the deck alone, one slide per 16:9 page, speaker notes left out:
  Save as PDF in the print dialog. Each page is the slide's own 1920 × 1080 (20 × 11.25 in): a
  slide scaled down to a smaller page prints its background and images only in part, in
  Chromium. No .pptx export.

## Phases

1. **Decks, the tab and the calendar**: the file format above; `api/decks` (the list, each deck's
   `for:` and lock) and `api/deck` (read and write, with the version; a new deck; the lock),
   images resolved as a note's are; the Slides tab (list, editor, preview, thumbnails, Present,
   PDF); the Calendar's marks, **Open** and **+ Slides**; the lock's guard on Claude's writes and
   `rft_validate`'s warnings.
2. **The tree's data**: `{{num E05 acc.1k}}`, `{{fig E08 loss}}`, `{{table E08 by_seed}}`, as the
   manuscript's macros; note chips drawn with their status (superseded, in review); the deck
   stamped with the results it shows and **out of date** when one changes, in the tab and in
   `rft_next` for a meeting in the next 7 days.
3. **Claude's outline**: `rft_deck {for}` (what a deck for that occurrence would be built from:
   the notes whose status changed since the meeting's previous occurrence, newly verified notes,
   deadlines at risk, the needs of the next one, `rft_next`), `rft_set_deck` (a new deck as an
   outline; an unlocked deck's text or edits), `/rft-slides [G01]`; comments and suggestions on a
   deck as on a snippet.
4. **The slide tools** (designed 2026-11-23, ahead of phases 2 and 3; "Boxes and lines" and "The
   slide tools" above), in six steps: the format (boxes and lines parsed and drawn, usable by
   typing: built 2026-11-23); move and resize on the slide (built 2026-11-23); the toolbar's Text, Rectangle, Ellipse, Line and Arrow,
   colours and text edited in place (built 2026-11-23); figures picked from the tree and images dropped or pasted
   into `vault/decks/assets/` (built 2026-11-23); slots (edit in place, Detach, the columns' divider, a layout
   gallery); several selected at once (Align, Distribute).
   **Later**: thumbnails dragged to reorder; builds (one list item at a time); a presenter window
   (notes, the next slide, a timer) kept in step over a BroadcastChannel; themes
   (`vault/decks/themes/<name>.css`).
5. **Interactive slides**: a ```` ```rft-widget ```` block of HTML and JS run in the sandbox the
   concept artifacts use (an opaque origin, no network, only the vendored libraries), given saved
   results only (nothing is computed live during a talk), with a still image for the PDF and the
   thumbnails.

## Why our renderer and not reveal.js

reveal.js gives transitions, an overview and a speaker view, but its speaker view writes a page of
inline scripts that the tree view's Content-Security-Policy (`script-src 'self'`) refuses, and its
Markdown is not the notes' (wikilinks, images found as Obsidian finds them, KaTeX). A slide here is
web/markdown.js's HTML in a 1920×1080 box scaled to fit; presenting is that box full screen with
the keys above; the PDF is the browser's print. Builds and a presenter window are phase 4, written
for this page.

## How it is checked

The acceptance cases, each a test on a fixture vault and a run in the tree view:

- **(a) The weekly wrap-up**: a deck for G01's occurrence of 2026-11-24, a weekly meeting. Moved
  to the 25th, the deck is shown on the 25th and the Slides tab lists it for the 25th; skipped,
  `rft_validate` warns that the deck is presented nowhere.
- **(b) A paper presented to the lab**: a deck for a once-only meeting (`for: [G04]`), built from
  a reference note and its figures, with no numbers of the tree (in phase 2, never stamped).
- **(c) A practice talk and the real one**: one deck `for: [G03 2026-12-01, M04]`, listed for
  both, its mark on both in the Calendar.

And for the renderer: a deck's slides split and their notes taken out as written (fences, a `---`
in a code block, no frontmatter); the preview, the presentation and the printed page drawn by the
same function.
