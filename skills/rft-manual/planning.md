# Priorities, deadlines and dates

A part of the rft manual (the `rft-manual` skill is its core, with the index of the parts).

## Priorities

A note's priority (`priority:` in its frontmatter: `urgent`, `high`, `medium` or `low`) is the
user's alone. They set it in the tree view (the kanban, or the note's drawer); a new note has
none. Among the open notes (idea, planned, running) at most 1 is urgent, 5 high and 10 medium;
low has no limit, and a note that is done, dropped, discussed or moved does not count.

- **Never set, change or remove `priority:`** yourself. Edit, Write and shell writes that change
  it are refused; no rft tool writes it.
- **Suggest one** when you have a clear reason: it unblocks other work, the user said it matters,
  it is cheap and decisive, or it matters less than its priority says. `rft_suggest_priority {id,
  priority, why}` writes `suggested_priority:` and a one-line `suggested_priority_why:`, or pass
  `suggested_priority` and `priority_why` to `rft_add_node` for a new note of work to do. The user
  accepts it (it becomes the priority) or dismisses it in the tree view. Do not suggest one for
  every note: leave it out when you have no reason.
- When a priority is full, a suggestion of it can only be accepted once the user lowers one of the
  notes that hold it; the tool's answer names them, so tell the user when it matters.
- `rft_validate` warns about a priority that is none of the four and about a limit exceeded by
  hand edits.

## Deadlines and dates

Deadlines of any kind (a submission, a rebuttal, a talk, a thesis chapter) are
**milestones**: one note each in the vault's `milestones/` folder, outside the reasoning tree,
with `due:` and the notes that must be done first (`needs:`). Experiments carry the plan of their
run: `start:` (a day) and `est:` (whole days or weeks: `3d`, `2w`); any note can have a `due:` of
its own. A due date is a day, a local time, or a time in a zone:
`2026-11-13`, `2026-11-13 14:00`, `2026-11-13 23:59 AoE` (or `UTC`, `+01:00`).

- **The dates are the user's.** Never write `due:`, `start:` or `est:`, on a note or a milestone:
  Edit, Write and shell writes that change them are refused. The user sets them in the tree view's
  Calendar (dragging a run, + Deadline) or the note's drawer.
- **Suggest a start or an estimate** when you can say why (a deadline needs the run done by then,
  it waits for another run, the GPUs are taken until then, the code shows how long a run takes):
  `rft_suggest_dates {id, start, est, why}`. The user accepts or dismisses it.
- **A deadline the user gives you** ("the thesis chapter is due Friday, I need E12 in it"):
  `rft_add_deadline {title, due, needs}`. The plugin asks the user to confirm it in a dialog you
  cannot answer; if they decline, leave it.
- **A meeting the user gives you**, once or recurring ("supervisor meeting every Tuesday at 14:00
  until June", "reading group on the first Thursday of each month", "the talk on 3 Dec at 10:30"):
  `rft_add_meeting {title, when, duration, every, until, needs}`, confirmed in a dialog as a
  deadline is. It is a note in `meetings/`: `when:` (the first one), `duration:` (1h, 45m),
  `every:` (day, week, 2 weeks, month on the same date, month on the first Tuesday … the last
  Friday), `until:` (its last day), `skip:` and `moved:` (single occurrences, which the user sets
  in the Calendar). With `needs:` ("I need E12 for the meeting") it is a deadline too, at its next
  occurrence. Its times are the user's: never write them, nor a meeting's file.
- **Paper submissions**: only when the user names a venue or asks which deadlines fit, find the
  venue's official dates page and read it now (web search, fetch), never from memory: dates move
  every year, and extensions happen. Suggest one milestone per date (abstract, paper,
  supplementary) with `rft_suggest_deadline {title, due, source, why, needs}`, with the time and
  zone the page states (most are 23:59 AoE). It waits, dashed, in the Calendar until the user
  accepts or dismisses it.
- Write `gpus:` on an experiment that takes more than one GPU (from its command and config), and
  `after:` (wikilinks) on one that waits for another run. With `gpus:` in `.rft/config.json`, the
  plugin reports the days the planned and running experiments need more GPUs than there are.
- In a vault that uses dates, `rft_set_status` records `started:` the day a run starts and `finished:` the day it is done:
  the calendar's runs, and real durations to set against the estimates.
- **Planning** is backwards from each deadline, in whole days: what a deadline needs must end by
  its due day, so a note's latest start is the due day less its estimate (less those of the notes
  that come after it). Slack is the days between its earliest start (today, its `start:`, the end
  of the notes it waits for) and that latest start. A deadline is **at risk** at 0 days of slack or
  less, or when a note it needs was dropped, superseded or is missing. `rft_next` lists the
  deadlines first, nearest first, with what puts each at risk; session start names the ones of the
  next 14 days at risk. When one is at risk, say so and propose what would save it (a suggested
  start, a smaller run, a priority suggestion), without changing the dates.
- `rft_next` also lists the meetings of the next 7 days.
- The vault's `rft.ics` holds the deadlines, the meetings and the planned runs (never the
  suggestions), for any calendar app to import; `rft_sync` keeps it current.
