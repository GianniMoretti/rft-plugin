# Experiment notebooks and figures

A part of the rft manual (the `rft-manual` skill is its core, with the index of the parts).

## Experiment notebooks

An experiment in a concept with code can have a **notebook** that makes the numbers of its Result,
so no one types them, a reader can rerun them, and the concept's artifact rests on numbers that
were reproduced. **It is the user's choice, per experiment.** An exploratory run (does it work, a
quick check, development) gets none, and you do not ask. When an experiment's results are meant
to last (figures or tables for a paper, a thesis or the docs, a result to verify or to cite in a
snippet), ask the user once whether to give it a notebook for reproducibility. If they decline,
write `notebook: no` in its frontmatter and do not ask again. Never write one unasked. It is a marimo notebook in the concept's first repo (`notebooks/<id>_<title>.py`),
linked from the vault (`vault/notebooks/<id>.py`) and the note (`notebook:`); it runs in the
repo's own uv environment, from the repo's root.

- **Write it once the user wants one** (best while the experiment is planned), with `rft_set_notebook(id, cells)`: plain Python, one
  string per cell (a markdown cell as `mo.md("...")`; `mo` is imported for you); or `file`, a
  notebook already in the repo. Its first cell (written for you) gives `RUNS`: the experiment's
  runs in the queue that ended well, oldest first, each its record with `out` (its output folder,
  `$RFT_OUT`), `label` and `commit`; read each run's outputs from `out`. After an expensive run,
  rebuild from its saved outputs, never retrain; a short experiment may run from scratch. Set:
  - `RESULTS`: a dict of the numbers the note reports, rounded as it reports them
    (`{"gap_1k": 4.1, "gap_1k_sd": 0.6}`);
  - `FIGURES`: `{name: matplotlib figure or SVG text}`, saved as `figures/<id>_<name>.svg`;
  - `TABLES`: `{name: DataFrame, list of row dicts, or dict of columns}`, saved as
    `tables/<id>_<name>.html` (the name is its caption);
  - `LATEX` (optional): `{a table's name: the tabular the notebook typeset for it}`, for a table
    the paper prints with more than columns and rows (cell colours, grouped headers, multirow).
    The view's LaTeX button then copies that tabular in a table float, and `\rfttable` inputs it,
    in place of the plain one; say in a `%` line above it which packages it needs. It can also be a
    whole float (`\begin{table*}` with its caption, label and width): the button copies it as it
    is, and `\rfttable` inputs the lines above the float and its tabular.
- **When its jobs end**, on a machine paired with the experiment queue, the queue's runner runs
  it (a job of its own, `notebook`, no GPU; with no queue, run it with `rft_run_notebook` once
  its runs end, which does the same) and, at no model turn: writes `RESULTS` in the note's Result as a table between two `rft-results`
  comment lines, with the notebook, commit and runs they come from; saves `RESULTS`
  (`results/<id>.json`), the figures and the tables; fills the tables into the artifacts that
  name them; and stamps the note (`reproduced:`). The session then says the numbers are in the
  Result: read it, write what they mean around the table (and the summary), and set the status.
  Never type the numbers yourself, and never read the runs' or the cells' outputs into the chat.
- **Run it now** with `rft_run_notebook(id)`: a Result with no table and no number yet gets the
  table (recorded); else the numbers are checked against it: ok, differs or failed, in a few
  lines. On differs, find out which side is wrong: fix the notebook, or, if its numbers are right
  (new runs, a fixed bug), run it with `record: true`, which rewrites the table and puts the
  artifact out of date. On failed, read the end of the traceback and fix the notebook or what it
  reads.
- **A concept's notebook**, on the note that starts it (`rft_set_notebook <its id>`), makes the
  figures and tables that compare the concept's experiments: its first cell (written for you)
  gives `EXPERIMENTS`, each of its experiments' `RESULTS` by id, read from what their notebooks
  saved (an experiment joins it once its notebook has run). It sets `FIGURES` and `TABLES` (saved
  as `figures/<concept id>_<name>.svg`, `tables/<concept id>_<name>.html`) and runs again whenever
  one of its experiments' notebooks records new numbers, so the artifact's comparisons follow
  them at no model turn. Write one when the artifact needs a comparison across experiments; never
  draw it on the page.
- **Figures** follow the project's figure style (Figures, below): draw them with `rs`, never with
  colours, fonts or sizes of your own. Plotting code beyond it (a figure several notebooks share)
  goes in one module in the repo's `notebooks/` folder, first on every notebook's `sys.path`.
- **Change it** with Edit: it is plain Python.
- **Never write `reproduced:` or the Result's table**: only a notebook's run writes them (your
  edits of either are refused).
- `rft_artifact` lists the results no notebook reproduced, and what each notebook saved.

## Figures

Every figure of a notebook is drawn in the **project's figure style**: `rft_style.py`, which the
run and the editor put beside the notebook with the project's tokens (`.rft/config.json`
`"style"`; left out, the default: slate text, faint grids, transparent backgrounds for a light
page). A new notebook has a cell that imports it as `rs` and applies it (`rs.use()`, sized for a
paper's column); the run applies it to older notebooks too. Never set colours, fonts, sizes or
`plt.style` yourself, and never edit `rft_style.py` (it is written again from the tokens).

- `fig, ax = rs.figure()` (a paper's column), `rs.figure("wide")`, `rs.figure(ncols=3)` for small
  multiples (one y label, on the first).
- **One message per figure**: say it in the title, one word in bold, `rs.title(ax, "CutMix",
  "closes the gap", color=rs.TOKENS["accent"])`: the bold word in the series' colour is its legend.
- **The series the claim is about** stands out, the rest are grey: `rs.highlight(ax, "CutMix")`.
- **An ordered parameter** (K, size, depth) is one family, light to dark: `colors = rs.ramp(len(K))`.
  Unordered categories take the default cycle, at most six; beyond, small multiples.
- **Spread** over seeds as a pale band: `rs.band(ax, x, mean, sd, label=…)` (markers on by default;
  `marker=None` for long curves). A baseline: `rs.baseline(ax, x, y, label="SAE")`. A ceiling,
  floor or target: `rs.reference(ax, y, "ceiling")`.
- **Labels, not legends**: `rs.label_lines(ax)` names each line at its end in its colour; for small
  multiples, `rs.legend_below(fig)`, one row under them.
- Axis labels with units; no title that only repeats the axes; a superseded result greyed or
  hatched, never left in the accent.
