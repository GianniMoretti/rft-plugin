# Grilling

A part of the rft manual (the `rft-manual` skill is its core, with the index of the parts).

A grilling is a session in the chat in which you question the user about **one direction** until
its plan is agreed. `/rft-grill-me <question, note id or concept>` asks for one. Offer one when a
direction is opened with no experiment planned under it; never start one unasked.

## Rounds

- Before round one, look up what the tree already holds: `rft_search`, `rft_map` of the concept,
  `rft_code` when the concept links code. Round one opens with what you found: the notes nearest
  to the question, and any that already answer it (done, dropped, discussed, superseded).
- A round is **every question that can be asked now**: those whose answer does not depend on one
  still open. Number them. Give each the answer you recommend, and word it so that "yes" accepts
  it. Then stop and wait. Never pad a round; there is no cap on its size.
- Facts are yours to find (the tree, the code, a paper, a venue's page). Ask the user only for
  decisions.
- Push back: when an answer leaves the hypothesis unfalsifiable, an experiment with no outcome
  that would change the plan, or the referee resting on your judgment or theirs, say so and ask
  again.

## The seven subjects

A grilling ends when each is settled, or set aside in the user's words ("no milestone").

1. **The question.** The claim as a hypothesis that can fail; the result that would change the
   user's mind; what is in scope and what is not.
2. **Its place in the tree.** What the tree already holds on it, its parent, its concept (an
   existing one, or a new one: `rft_set_concept` only once agreed), what it would overturn.
3. **Literature.** What must be known before any run, as named searches, each with the question
   it answers.
4. **Preliminary experiments.** The cheapest decisive ones; the reference whose setup each starts
   from; what each outcome would mean, including the one that ends the direction; code and
   compute.
5. **Order and priority.** What runs first, what waits for what.
6. **Milestone.** A deadline or a meeting this serves, if any.
7. **The referee.** What would show the result is right and depends neither on the user's
   judgment nor on yours: a published number reproduced, a run of the untouched original code, a
   test someone else wrote. Always asked; "you check it again" is not one.

**A quick look for prior art** may run while the user answers: a few web searches, in a
background subagent when you have one, never holding up a round. Say what it finds as *not
read*, save each with `rft_inbox` (the why names the grilled direction), and write none of it
as a reference. A thorough search is only named here (subject 3) and run after the grilling.

## What is written, and when

**While the grilling runs, only the grilled direction**, in these sections, each added (after
Why, before Status) once it has something in it. The user's answer to a question is the agreement
for what goes in them.

- **Hypothesis**: the claim, and the result that would change the user's mind.
- **Scope**: what is in, and what is not.
- **Plan**: the searches, the experiments in order, the milestone; a subject set aside is said
  here. Plain lines while the grilling runs, links to the notes once the proposal is confirmed.
- **Referee**: the check.
- **Open questions**: what is not settled yet. A later session resumes from it; remove it when
  it is empty.

A question that is not a note yet gets its note (`rft_add_node`, direction, `idea`, these
sections passed in `sections`) only once round one agreed its wording, parent and concept. A
verified or locked note is never edited: the grilled direction is a new direction under it, and a
change to the locked note goes through `rft_suggest`. A note that is not a direction: the grilled
direction is a new one under it. A direction the tree already answers: say what it holds and ask
whether to stop or to reopen it as a new direction that says what changed.

**Everything else waits for the proposal.** A sub-direction, an alternative the user rejects, a
definition, a search, an experiment: keep it in the chat (and in Plan or Open questions) until
the end. This is the one place where an idea is not recorded the moment it comes up.

## The proposal

One numbered table closes the grilling: every write it would make, one per row. Ask which rows
to apply and write only those.

| row | written as |
|---|---|
| sub-direction | `rft_add_node`, direction, `idea` |
| rejected alternative | `rft_add_node`, direction, `discussed`, the user's reason in Status |
| definition that settled | `rft_add_node`, theory, `idea` |
| literature search | `rft_add_node`, reference, tags `["literature"]`, `planned`, title `Literature on <topic>`, the question it answers in **Search** |
| preliminary experiment | `rft_add_node`, experiment, `planned`: What, Why, `refs`, what each outcome means, the referee's check it must pass; `after:` and `gpus:` when they apply |
| priority | `rft_suggest_priority` (`planning.md`) |
| start and estimate | `rft_suggest_dates` |
| milestone | `rft_add_deadline`, or `rft_suggest_deadline` for a venue's date read from its page |

- A note already under the direction that the grilling refined is a row too ("E12: What and Why
  rewritten"), edited in place: never a second note for the same run or search.
- An experiment with no reference to start from is not blocked: its row says **a search is
  missing** and names the search row that would supply one.
- A planned literature note is run later with `/rft-literature <its id>`, which fills that note.
- After the confirmed rows: turn Plan's lines into links, `rft_validate`, then `rft_handoff`.
  No code is written and nothing is queued: the planned notes are the brief for the session
  that runs them.

## How a grilling ends

- **Agreed**: every subject settled or set aside, and the proposal confirmed with at least one
  search or experiment. `rft_set_status` the grilled direction `planned` (one already `planned`
  or `running` keeps its status).
- **Not worth pursuing**: the tree already answers it, no experiment would decide it, or no
  referee is possible. `rft_set_status` `discussed` with the reason; no rows. This is a result.
- **Stopped early**: the user says stop. The proposal holds what is settled, the rest stays
  under Open questions, the status is not changed.
