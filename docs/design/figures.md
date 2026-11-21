# Design note: one figure style per project, in code

Status: designed 2026-11-21. Step 1 (below) is what gets built first.

## The problem

A notebook's figures are drawn with whatever each repo's `notebooks/figures.py` sets, or with
matplotlib's defaults: tab10 colours, a full box, a legend in the corner, 10 pt text on a white
background. The same SVG then goes to a concept's artifact (whose series colours, `--c1`…`--c6`,
are the view's own), to the manuscript (a PDF scaled to a column, its text shrunk below 6 pt) and
to a slide (a third set of colours, `--slide-*`). Nothing ties the three together, nothing
enforces the project's palette, and Claude never looks at a figure: it writes the artifact from
the figures' captions.

## The reference

The user's reference is Thomas Fel's figures: *Into the Rabbit Hull* (arXiv 2510.08638) and the
block-sparse featurizers paper (arXiv 2606.25234). Read from their arXiv sources (the figure
files themselves, their colours and fonts as the PDFs hold them), not from memory:

- **Colours** are Tailwind's: Rabbit Hull's series `#F0B100` `#2B7FFF` `#3F8F4E` `#999999`, its
  diagrams `#EC003F` `#00B8DB` `#8E50FF`; BSF's ordered family `#A5B4FC` `#6366F1` `#8B5CF6`
  `#A855F7` `#C026D3` `#DB2777` `#E11D48` (K = 2 … 32, light to dark), its baseline `#020617`.
  Text is slate (`#0F172B`), never pure black; neutral shapes slate-200 (`#E2E9F1`).
- **An ordered parameter is one family**, light to dark; the baseline is near-black and dotted;
  a ceiling or floor a thin dashed grey; spread a pale band of the series' colour behind a line of
  1–1.5 pt with small round markers.
- **Titles weigh one word**: "**Vanilla** BSF", "**Minkowski** Representation Hypothesis".
  **Coloured words are the legend**: "**Directional** steering" in the pink of its arrows.
- **Small multiples** share one y label and one frameless legend row below them; grids are faint
  (`#B0B0B0`, thin), the top and right spines gone, the whitespace generous.
- Text in Inter (Figma) or Helvetica (Keynote), DejaVu Sans in the plain matplotlib plots.
- What code cannot give: the hero figures are composed by hand in Keynote, Figma or Illustrator
  (cards, image grids, dashed highlight boxes, arrows). The plots inside them are matplotlib.

## Design

1. **Tokens, per project.** `.rft/config.json` may hold `"style"`: `text`, `muted`, `axis`,
   `grid`, `neutral`, `fill`, `accent` (the series the figure is about), `contrast` (the one point
   that must stand out), `baseline`, `categorical` (colours in order), `ramp` (an ordered
   parameter, light to dark), `font`, `headingFont`, `background` (`transparent`, or a colour).
   What it leaves out takes the default, the reference's look above. The user's own palette is
   their project's tokens, never the plugin's default.
2. **Style as code.** `server/rft_style.py` is a module with the default tokens, `use(medium)`
   (matplotlib's settings from the tokens, for `paper`, `screen` or `slide`: the text size to
   figure size of each) and helpers that draw the reference's conventions: `figure`, `colors`,
   `ramp`, `band`, `baseline`, `reference`, `highlight`, `label_lines`, `title` (one bold word),
   `legend_below`. It is copied into each repo's `notebooks/` folder (first on every notebook's
   `sys.path`) with the project's tokens written in, before each run and each editor started, so
   a fresh clone draws the same figures. Each new notebook gets a cell that imports it (`rs`) and
   applies the style; the run applies it too, for notebooks written before it.
3. **Transparent backgrounds**, drawn for a light page (a paper) unless the project says
   otherwise: in the view's dark theme a figure sits on a light card, as a slide does.
4. **The same tokens in the page**: an artifact's series colours and a slide's accent come from
   them.

Later steps: a figure rendered once per medium (the paper's PDF at the column's width, the
slide's at 1080p, the artifact's); a check of each saved figure at no model turn (the default
palette, text too small for its medium, more than six series, axes with no label, a legend where
labels at the lines' ends fit, no spread when the results have one); and a preview Claude looks at
once before placing a new figure.

## How it is checked

The cases the user confirmed: (a) E08's training loss, two methods over three seeds, the claim's
method in the accent and the other grey, in a paper's column; (b) a concept's five experiments
compared, one superseded and greyed; (c) a figure given as SVG text (used as it is) and one with
twelve series. The referee is the reference itself: the same data drawn with matplotlib's
defaults, with the default tokens and with the user's palette, beside the reference's figures.
