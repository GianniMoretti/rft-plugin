# Slides

A part of the rft manual (the `rft-manual` skill is its core, with the index of the parts).

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
