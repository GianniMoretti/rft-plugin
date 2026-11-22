# Concept artifacts

A part of the rft manual (the `rft-manual` skill is its core, with the index of the parts).

A concept can have an **artifact**: one HTML page of the results of its own experiments
(`vault/artifacts/<id> <name>.html`), which the tree view shows in the note drawer when the user
clicks the concept (its name on a region or badge, its node in the concept view, the concept path
in a note's header). Where the digest is a note for you, the artifact is a page for the user: the
key results as tables and small charts, what failed, what is still running.

- **`rft_artifact <concept>`** first: where the page is and whether it is up to date, each
  experiment with a result (in full when it is new or changed since the page was written; `full`
  for all), the experiments without one, the sub-concepts (whose own artifacts the view links:
  leave them off this page), and how to write the page.
- **`rft_set_artifact`** writes it: `html` for the whole page, `edits` (`old_str` → `new_str`,
  each found on the page once, all or none) to change part of it. It is stamped with a key per
  experiment with a result (status, title, summary, superseding note, Result), so the plugin
  says which results changed, are new, or left since: `rft_set_status`, `rft_map`, `rft_next`
  and `rft_validate` say when it is out of date. An experiment has a result once it is done, or
  once its Result says something while it runs or after; a planned one has none.
- **When**: in a vault with artifacts, at the end of a task that recorded results, update the
  artifact of each concept that got them, once per concept, with edits; a concept with results
  and no artifact gets one then too. `/rft-artifact [concept]` asks for one, or for every one
  missing or out of date.
- **The page** is prose and layout, HTML with its own `<style>`. **Its charts and tables come from
  notebooks**: an experiment's notebook, or the concept's for comparisons across its experiments
  (`notebooks.md`), saves `FIGURES` and `TABLES`, placed by name (below). Never draw a
  chart of results by hand: a chart or table the page needs that no notebook makes, ask the user
  whether to make it in a notebook; if not, leave the chart out and type a short table from the
  notes' own numbers. The view loads nothing from elsewhere (no CDN, no fetch); it gives each SVG
  figure a button that downloads it as a PDF, and each table one that copies it as a LaTeX
  `table` float. Its base
  style follows the view's light and dark themes: `var(--fg)`, `--muted`, `--bg`, `--panel`,
  `--line`, `--accent`, `--good`, `--bad`, and `--c1` … `--c6` for series. Link every note id,
  `<a href="#E05">E05</a>` (or `data-note="E05"` on any element): the view opens the note and
  marks the link with its status, superseded results struck through.
- **A notebook's figures and tables** (its `FIGURES` and `TABLES`, saved by its run) go on the
  page by the names `rft_artifact` lists: `<img src="../figures/E08_training_loss.svg">` and
  `<rft-table src="E08_accuracy_by_seed"></rft-table>`. The plugin fills an `<rft-table>` with
  the table when the page is written, and again whenever the notebook's run writes it anew; write
  their numbers nowhere else on the page, and say what they show.
- **Only numbers that are in the notes**, with their spread over seeds; a superseded result is
  cited with the note that replaced it. `rft_set_artifact` names the results left off the page,
  links to no note, superseded results cited alone, and files the view would block.
- **Never write the files by hand** (Edit, Write and shell writes there are refused): only
  `rft_set_artifact` stamps them. Reading them is fine.
