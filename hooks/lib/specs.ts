// The model's tools as they are registered: each one's description and input schema. What a tool
// does is in runTool (register.tsx); which ones sit in the prompt from the start is in tools.ts.
// A description is sent with every request while its tool is in the prompt, so each says what the
// tool is for and what its answer holds, and leaves the how to the manual.

import { MAX_TIMEOUT_S } from './notebooks'
import { KINDS } from './snippets'
import { NODE_TYPES } from './vault'

export const TOOLS = {
  rft_add_node: {
    description:
      'Add a node to the reasoning tree: an experiment (something run or computed), a direction (an idea, question or hypothesis, rejected ones included), a reference (a paper, method or literature review that was read, summarised and commented, with a source that can be checked) or a theory note (a definition, method, taxonomy or argument of the project\'s own, built on the other notes). Assigns the id and links it under its parent. Create an experiment BEFORE launching it (status planned or running). In a concept that links code, the note gets a ## Code section with the repos\' commits: pass sections.Code after reading the code, or use rft_set_code later. Several notes go in ONE call (notes), never one call each. The answer ends with the tree\'s check, synced: no rft_sync or rft_validate after it.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: NODE_TYPES },
        title: { type: 'string', description: 'Short title, no id (the id is assigned). Avoid ^ # | [ ].' },
        parent: { type: 'string', description: 'Id (e.g. D03) or full name of the parent note; omit only for the root D00 of an empty tree.' },
        status: { type: 'string', enum: ['planned', 'running', 'done', 'idea', 'dropped', 'discussed', 'moved'], description: 'Default: planned for experiments and references, idea for directions and theory notes.' },
        what: { type: 'string', description: 'Experiment: what is run or computed (model, data, arms, seeds, where).' },
        why: { type: 'string', description: 'Why: which direction it tests and what is expected, or where the idea comes from.' },
        idea: { type: 'string', description: 'Direction: the idea or question in a few sentences.' },
        result: { type: 'string', description: 'Experiment: real results only (numbers with spread, failures, caveats).' },
        code: { type: 'string', description: 'Experiment: commit, script, results folder, machine.' },
        sections: { type: 'object', additionalProperties: { type: 'string' }, description: 'Other sections by heading, e.g. {"Status": "..."}. A reference has Source, Summary, Method, Key results, Relevance; a theory note Statement, Builds on, Explanation, Open questions.' },
        tags: { type: 'array', items: { type: 'string' }, description: '1-3 short topical tags, lowercase kebab-case, reused from the ones in use when they fit (the project, type and status tags are added anyway).' },
        refs: { type: 'array', items: { type: 'string' }, description: 'Ids of the reference notes (R..) it builds on: for an experiment, the paper(s) whose setup it starts from; for a direction, the work it extends. Add missing references first.' },
        summary: { type: 'string', description: 'One line (at most 240 characters) on what the note is about, specific enough to read instead of the note: what is tested and on what, the idea, the paper\'s main claim. Always give it.' },
        suggested_priority: { type: 'string', enum: ['urgent', 'high', 'medium', 'low'], description: 'Optional, only with a clear reason: a priority to suggest; the user accepts or dismisses it.' },
        priority_why: { type: 'string', description: 'With suggested_priority: why, in one line (what it unblocks, what makes it pressing or not).' },
        notes: { type: 'array', items: { type: 'object' }, description: 'Several notes at once, added in order: each an object with the fields above (a field given beside notes holds for every note that does not give its own, e.g. a shared type, parent or refs). A later note names an earlier one of the list as parent, or among its refs, by its place: "#1" is the first.' },
      },
    },
  },
  rft_set_repos: {
    description:
      'Link code repositories on this machine to a concept: the folders holding the code its experiments and directions run on. Set on the note that starts the concept, or on the root note for code of the whole project. A sub-concept\'s notes work with its own repos first, then with those inherited from the concepts above. Replaces the list; an empty list removes it. Use the path the user gives; never guess one. Answers each repo\'s git state, whether sessions started there reach this tree, and the notes that now need a ## Code section (rft_set_code).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id (e.g. D04) of the note that starts the concept, or of the root note.' },
        repos: { type: 'array', items: { type: 'string' }, description: 'Repository folders: absolute, ~/..., or relative to the tree\'s folder (the one holding .rft/). Highest priority first.' },
      },
      required: ['id', 'repos'],
    },
  },
  rft_code: {
    description:
      'The code context of a note: the repos its concept links (its own first, then inherited), each one\'s branch and commit now, the commit its ## Code section was last checked against, and the commits and changed files since (uncommitted changes included). Call it before working on an experiment (planning, launching, analysing results) or relying on a note\'s code references.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Id (e.g. E12) or full name of the note.' } },
      required: ['id'],
    },
  },
  rft_set_code: {
    description:
      'Write or update the ## Code section of a note whose concept links code: how the experiment or direction relates to the code (entry points, files, functions, configs, what has to change; a short pointer for a direction), checked against the code as it is now. Records each repo\'s current commit, so rft_code can list later changes. reproduce, for an experiment with results: the commit of the run, the command and config, where the raw outputs are and how they were processed into Result. text or reproduce left out keeps what the section holds.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id (e.g. E12) or full name of the note.' },
        text: { type: 'string', description: 'How the note relates to the code (markdown).' },
        reproduce: { type: 'string', description: 'How to reproduce the note\'s results from the code (markdown).' },
      },
      required: ['id'],
    },
  },
  rft_set_notebook: {
    description:
      'Give an experiment its marimo notebook, or a concept its own (on the note that starts it: the figures and tables comparing its experiments, from EXPERIMENTS, their saved RESULTS by id; it runs again after each of them). An experiment\'s makes the numbers of its Result: from its runs\' saved outputs after an expensive run, from scratch for a short one. Only for an experiment the user wants one for (ask them when its results are meant to last: figures or tables for a paper, a thesis or the docs; never for an exploratory run): once its runs end it writes RESULTS in its Result (on a machine paired with the experiment queue, the queue\'s runner runs it then, at no model turn; else rft_run_notebook). Pass cells (plain Python, one string per cell; the tool writes marimo\'s format, with mo imported and a first cell setting RUNS: the queue\'s runs of the experiment that ended well, each a dict with out, its output folder ($RFT_OUT), label and commit) and it is written in the concept\'s first repo as notebooks/<id>_<title>.py; or file, a notebook already in the repo. Either way it is linked from the vault (notebooks/<id>.py) and the note (notebook:). It runs in the repo\'s uv environment with the repo\'s root as working folder and the notebook\'s folder first on sys.path. Set RESULTS, a dict of the numbers the note reports, rounded as it should report them; and for the concept\'s artifact, FIGURES ({name: matplotlib figure or SVG text}) and TABLES ({name: DataFrame, list of row dicts or dict of columns}). Draw FIGURES with the project\'s figure style, rs (rft_style beside the notebook, imported and applied in a cell written for you): fig, ax = rs.figure() (a paper\'s column; ncols=3 for small multiples), rs.band(ax, x, mean, sd, label=…), rs.baseline, rs.reference, rs.highlight(ax, "<the series the claim is about>"), rs.label_lines(ax) or rs.legend_below(fig), rs.title(ax, "<bold word>", "<rest>"), rs.ramp(n) for an ordered parameter; never set colours, fonts or sizes of your own (the manual\'s notebooks.md, Figures). Change it later with Edit (plain Python), not with this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id (e.g. E12) or full name of the experiment.' },
        cells: { type: 'array', items: { type: 'string' }, description: 'The notebook\'s cells, in order: plain Python, a markdown cell as mo.md("..."); one cell sets RESULTS = {...}.' },
        file: { type: 'string', description: 'A notebook already in the repo instead: its path in the repo, or absolute.' },
        replace: { type: 'boolean', description: 'Write the notebook anew from cells over the one there.' },
      },
      required: ['id'],
    },
  },
  rft_run_notebook: {
    description:
      `Run an experiment's notebook now (in its repo's uv environment, without the browser): its RESULTS are written in the note's Result as a table when the Result has none and no number yet (or with record), else checked against it. Answers in a few lines: recorded, ok (every number of RESULTS is in the Result), differs (the numbers that are not), failed (the end of the traceback), or nothing to check; never the cells' outputs. With the numbers recorded or ok, it saves RESULTS, FIGURES and TABLES in the vault (results/, figures/, tables/) for the artifacts. Stamps the note (reproduced:). A run longer than the timeout is stopped: a notebook that retrains for longer is a launch, not a check.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id (e.g. E12) or full name of the experiment.' },
        timeout: { type: 'number', description: `Seconds the run may take (${MAX_TIMEOUT_S} at most, the default).` },
        record: { type: 'boolean', description: 'Write RESULTS in the Result\'s table, replacing the one there: when its numbers are right and the Result\'s are not (new runs, a fixed bug).' },
      },
      required: ['id'],
    },
  },
  rft_set_status: {
    description:
      'Change the status of a node (frontmatter, tag and the Status line) and optionally append a note: for an experiment to its Result section, for a reference to its Relevance section, for a direction or a theory note to its Status section (say why it was dropped or where it was moved). Regenerates the index and canvas. verified only suggests it (the user verifies, in the tree view; note: what was checked and how); review takes a verified note back (note: why).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id (e.g. E12) or full name of the note.' },
        status: { type: 'string', enum: ['planned', 'running', 'done', 'review', 'verified', 'idea', 'dropped', 'discussed', 'moved'] },
        note: { type: 'string', description: 'Optional text to append (real results, or the reason).' },
        summary: { type: 'string', description: 'The note\'s one-line summary, updated with what it found (the key number) or why it was dropped.' },
      },
      required: ['id', 'status'],
    },
  },
  rft_suggest_priority: {
    description:
      'Suggest a priority for a note: urgent, high, medium or low (among the open notes at most 1 urgent, 5 high and 10 medium). Priorities are the user\'s alone: this writes only a suggestion with its reason, which the user accepts or dismisses in the tree view (the kanban, or the note\'s drawer); you never set priority: yourself, and edits that change it are refused. Suggest one when you have a clear reason: it unblocks other work, the user said it matters, it is cheap and decisive, or it no longer matters as much.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id (e.g. E12) or full name of the note.' },
        priority: { type: 'string', enum: ['urgent', 'high', 'medium', 'low'] },
        why: { type: 'string', description: 'Why, in one line (at most 240 characters): shown to the user next to the suggestion.' },
      },
      required: ['id', 'priority', 'why'],
    },
  },
  rft_suggest_dates: {
    description:
      'Suggest a start (a day) and/or an estimate (3d, 2w) for an experiment, with why. Dates are the user\'s: due:, start: and est: are set by them in the tree view (the Calendar, or the note\'s drawer), and your edits that change them are refused; this writes only a suggestion, which the user accepts or dismisses. Suggest when you can say why: a deadline needs it done by then, it waits for another run, the GPUs are taken until then, or the code shows how long a run takes. The plan keeps to the user\'s dates until they accept.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id (e.g. E12) or full name of the experiment.' },
        start: { type: 'string', description: 'The day to start, YYYY-MM-DD.' },
        est: { type: 'string', description: 'How long the run takes, in days or weeks: 3d, 2w.' },
        why: { type: 'string', description: 'Why, in one line (at most 240 characters): shown to the user next to the suggestion.' },
      },
      required: ['id', 'why'],
    },
  },
  rft_add_deadline: {
    description:
      'Add a deadline the user gave you (a submission they named, a talk, a thesis chapter): a milestone in the vault\'s milestones/, outside the tree, with the notes it needs done first. A meeting (a supervisor meeting, a reading group, a call), once or recurring, is rft_add_meeting instead. The plugin asks the user to confirm it in a dialog you cannot answer; if they decline, nothing is added: do not try again unless they ask. Never add a deadline the user did not give you: for a paper submission you think fits, use rft_suggest_deadline.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What is due, e.g. "Workshop paper", "Thesis chapter 3".' },
        due: { type: 'string', description: 'When: 2026-11-13 (the day), 2026-11-13 14:00 (local time), or 2026-11-13 23:59 AoE (AoE, UTC or +01:00).' },
        needs: { type: 'array', items: { type: 'string' }, description: 'Ids of the notes that must be done before it (experiments, mostly).' },
      },
      required: ['title', 'due'],
    },
  },
  rft_add_meeting: {
    description:
      'Add a meeting the user gave you, once or recurring (a weekly supervisor meeting, a reading group every other Thursday, a call on the first Tuesday of each month): one note in the vault\'s meetings/, outside the tree, shown in the tree view\'s Calendar. With needs, it is a deadline too: those notes must be done by its next occurrence. The plugin asks the user to confirm it in a dialog you cannot answer; if they decline, nothing is added: do not try again unless they ask. The user skips or moves a single occurrence in the Calendar; never write a meeting\'s file yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'E.g. "Supervisor meeting", "Reading group".' },
        when: { type: 'string', description: 'The (first) occurrence: 2026-11-24 14:00 (local time), 2026-11-24 16:00 UTC (or +01:00, AoE), or a day alone for one all day.' },
        duration: { type: 'string', description: 'How long: 1h, 45m, 1h30m.' },
        every: { type: 'string', description: 'For a recurring one, how often from when on: day, week, 2 weeks, month (the same date), month on the first Tuesday (second, third, fourth, fifth, last; any weekday). Leave out for a single meeting.' },
        until: { type: 'string', description: 'The last day a recurring one may fall on: 2027-06-30. Leave out for no end.' },
        needs: { type: 'array', items: { type: 'string' }, description: 'Ids of the notes that must be done by its next occurrence, when the user said so (e.g. "I need E12 for the meeting").' },
      },
      required: ['title', 'when'],
    },
  },
  rft_suggest_deadline: {
    description:
      'Suggest a paper submission deadline (or another one from an official page) the work could aim for: a milestone with status suggested, which the user accepts or dismisses in the tree view\'s Calendar; it is not planned for until then. Read the dates from the venue\'s official dates page now (web search, fetch), never from memory: deadlines move every year. Give that page as source, the exact time and zone it states (most are 23:59 AoE), and one milestone per date (abstract, paper, supplementary). Suggest only when the user names a venue or asks for deadlines.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'E.g. "CVPR 2027 paper", "CVPR 2027 abstract".' },
        due: { type: 'string', description: 'As the official page states it: 2026-11-13 23:59 AoE, or a day.' },
        source: { type: 'string', description: 'The official dates page it was read from (https://…).' },
        why: { type: 'string', description: 'Why this venue fits the work, in one line.' },
        needs: { type: 'array', items: { type: 'string' }, description: 'Ids of the notes the paper needs done first.' },
      },
      required: ['title', 'due', 'source', 'why'],
    },
  },
  rft_set_summary: {
    description:
      'Set the one-line summary (summary: in the frontmatter) of one or more notes: what the note is about and, once known, what it found, with the key number. Summaries are what rft_map and later sessions read instead of the notes, so make them specific. Takes many at once, for filling in an existing tree.',
    inputSchema: {
      type: 'object',
      properties: {
        summaries: { type: 'object', additionalProperties: { type: 'string' }, description: 'Note id → one line (at most 240 characters), e.g. {"E12": "Mixup on CIFAR-100 1k: +2.1±0.4 top-1 over the baseline, gap closes at 10k"}.' },
      },
      required: ['summaries'],
    },
  },
  rft_map: {
    description:
      'The tree in layers, cheaper than reading notes. Without concept: the project map, each concept with its state (from its digest) and counts, and the experiments in progress. With a concept: its digest (state, key results, dead ends, open questions), its sub-concepts, and its notes one per line with their summaries. Read it before opening note files; it says when a digest is missing or out of date.',
    inputSchema: {
      type: 'object',
      properties: { concept: { type: 'string', description: 'A concept, by name or the id of the note that starts it; omit for the project map.' } },
    },
  },
  rft_supersede: {
    description:
      'Mark a note whose result a newer one overturns (superseded_by: in its frontmatter, and a dated History line): a corrected number, a bug found in the run, a better-controlled rerun that changes the conclusion. rft_map, rft_search and rft_graph then show it as superseded, so nobody builds on the old result. Without by, clears the mark. Then update the concept\'s digest. On a locked note the plugin asks the user to unlock it first; if they keep it locked, nothing changes.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The note whose result no longer holds (id or full name).' },
        by: { type: 'string', description: 'The note whose result holds instead; omit to clear the mark.' },
        why: { type: 'string', description: 'A few words: what changed (kept in the History line).' },
      },
      required: ['id'],
    },
  },
  rft_next: {
    description:
      'What is still open, concept by concept: experiments running, experiments planned and never run, directions with nothing tried under them (oldest first, with their age), and the open questions of the digests. Use it when asked what to do next, or before proposing new work, so open threads are picked up before new ones are opened.',
    inputSchema: {
      type: 'object',
      properties: { concept: { type: 'string', description: 'A concept (name or start note id): it and its sub-concepts; omit for the whole tree.' } },
    },
  },
  rft_set_digest: {
    description:
      'Write the digest of a concept (vault map/): where that line of research stands, for whoever reads it next instead of its notes. Write it from the notes (rft_map <concept>, then the files you need), never from memory. Stamped with the state of its notes, so rft_map can say when it goes out of date.',
    inputSchema: {
      type: 'object',
      properties: {
        concept: { type: 'string', description: 'The concept, by name or the id of the note that starts it.' },
        state: { type: 'string', description: 'One or two sentences: where the line of research stands now (what holds, what is being tried).' },
        text: { type: 'string', description: 'Markdown sections: ## Key results (numbers, with the note ids), ## Dead ends (what was ruled out and why, with ids), ## Open questions (and the notes that hold them). Short: a page at most.' },
      },
      required: ['concept', 'state', 'text'],
    },
  },
  rft_artifact: {
    description:
      "What a concept's artifact (vault artifacts/: one HTML page of the results of its own experiments, shown in the tree view) is written from: where it is and whether it is up to date, the page (whole while it is short, else its outline), each result that is new or changed since the page was written in full (every one before there is a page) and the others by id, the experiments without a result, its sub-concepts, and how to write the page. Call it before rft_set_artifact.",
    inputSchema: {
      type: 'object',
      properties: {
        concept: { type: 'string', description: 'The concept, by name or the id of the note that starts it.' },
        full: { type: 'boolean', description: 'Every result in full, not only the new and changed ones: as many as fit one answer, the rest named.' },
        notes: { type: 'array', items: { type: 'string' }, description: 'Only these results (ids), in full: the ones an answer named and did not give.' },
        section: { type: 'string', description: "Only this part of the page as it is written, by its number or heading in the outline: the exact text for an edit's old_str." },
      },
      required: ['concept'],
    },
  },
  rft_manuscript: {
    description:
      'Snippets and documents. Snippets (vault snippets/: LaTeX building blocks S.., each resting on verified notes), each with its state (stub, written, review, unverified basis) and the documents using it; documents (vault documents/, built from copies of snippets), each copy\'s state (to review when its snippet changed since, adapted); the verified notes still to write. With a snippet id: its notes with what their notebooks saved (as \\rftnum, \\rftfig, \\rfttable). With a document: its outline.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'A snippet id (S04), or a document\'s name.' } },
    },
  },
  rft_set_snippet: {
    description:
      'A snippet, the building block. Without id: a new one resting on verified notes (basis); while snippets are locked, a stub only (kind, title, basis, outline: what it should say), which the user writes. With id: its text or edits, only once the user unlocked it. Numbers, figures and tables only through \\rftnum{E05}{key}, \\rftfig{E08}{name}, \\rfttable{E08}{name}; citations \\cite{R07}. Stamped with its basis, so a change to those notes puts it in review. It enters a document only through rft_set_document.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'An existing snippet (S04), to write its text; leave out for a new one.' },
        kind: { type: 'string', enum: [...KINDS] },
        title: { type: 'string' },
        basis: { type: 'array', items: { type: 'string' }, description: 'The verified notes it rests on (ids).' },
        outline: { type: 'array', items: { type: 'string' }, description: 'A stub\'s lines for the user: the claim, the numbers and the macros that give them, the caveats.' },
        text: { type: 'string', description: 'The LaTeX, when the snippet is unlocked.' },
        edits: { type: 'array', items: { type: 'object', properties: { old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['old_str', 'new_str'] } },
      },
    },
  },
  rft_set_document: {
    description:
      'A document\'s structure, only as the user agreed: place a copy of a snippet (its text now, stamped; the copy is then the document\'s, and goes to review when the snippet changes), move a copy, or remove one. Propose placements as a table first.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The document.' },
        place: { type: 'string', description: 'A snippet to copy in (S04).' },
        move: { type: 'string', description: 'A copy to move (S04).' },
        remove: { type: 'string', description: 'A copy to take out (S04).' },
        after: { type: 'string', description: 'Where: after a copy (S03) or a heading\'s title; default: before the bibliography.' },
      },
      required: ['name'],
    },
  },
  rft_set_artifact: {
    description:
      "Write a concept's artifact: the whole page (html) or changes to it (edits, applied in order, all or none, each old_str found on the page exactly once). Stamped with the results it was written from, so the plugin says when they change. Prose and layout: its charts and tables are the notebooks' FIGURES and TABLES, placed by the names rft_artifact lists, never drawn or typed by hand. Only numbers that are in the notes; link every note id as <a href=\"#E05\">E05</a>. The answer names results left off the page, links to no note, superseded results cited alone, and files the view would block.",
    inputSchema: {
      type: 'object',
      properties: {
        concept: { type: 'string', description: 'The concept, by name or the id of the note that starts it.' },
        html: { type: 'string', description: 'The whole page: an HTML fragment or document with its own <style>; the notebooks\' figures as <img src="../figures/<file>.svg"> and tables as <rft-table src="<name>"></rft-table>; nothing loaded from elsewhere.' },
        edits: {
          type: 'array', description: 'Changes to the page as it is: old_str exactly as on the page (once), new_str its replacement (empty deletes it).',
          items: { type: 'object', properties: { old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['old_str', 'new_str'] },
        },
      },
      required: ['concept'],
    },
  },
  rft_move_node: {
    description:
      'Move a note and its whole subtree under another parent, when it belongs to another line of research. The note keeps where it came from (origin: and a dated History line), the old parent stops listing it, the new one lists it, and the index and canvas follow. Only after the user has agreed to the move. A locked note: the plugin asks the user to unlock it first; if they keep it locked, it does not move.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id (e.g. E12) or full name of the note to move.' },
        parent: { type: 'string', description: 'Id or full name of the new parent; not the note itself or a note below it.' },
        why: { type: 'string', description: 'Optional: why it moves, a few words kept in its History line.' },
      },
      required: ['id', 'parent'],
    },
  },
  rft_set_refs: {
    description:
      'Replace the references a note builds on (refs: in its frontmatter, links to R notes): the paper(s) behind an experiment\'s setup or a direction\'s idea. Add a missing paper first as a reference note.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id (e.g. E12) or full name of the note.' },
        refs: { type: 'array', items: { type: 'string' }, description: 'Ids of the reference notes (an empty list removes them).' },
      },
      required: ['id', 'refs'],
    },
  },
  rft_search: {
    description:
      'Search every note of the tree (titles, tags, concepts and text) and get the best matches with the line that matched: use it to find what was tried, measured or read on a subject before reading files one by one, or before proposing an experiment that may already exist. Filters narrow by type, status, concept or tag; with filters alone it lists the newest notes that pass.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for, e.g. "label smoothing calibration".' },
        type: { type: 'string', enum: NODE_TYPES },
        status: { type: 'string', enum: ['planned', 'running', 'done', 'review', 'verified', 'idea', 'dropped', 'discussed', 'moved'] },
        concept: { type: 'string', description: 'A concept, by name or start note id: its notes and its sub-concepts\'.' },
        tag: { type: 'string', description: 'A topical tag.' },
        limit: { type: 'number', description: 'How many notes at most (default 10).' },
      },
    },
  },
  rft_graph: {
    description:
      'A note\'s place in the tree, one line per note with its summary: around (default) its parent, children, the notes beside it, what it builds on (refs), what cites it, where it was before a move; path, how the reasoning reached it from the top. Use it for "what came out of E12", "what builds on R03", "how did we get to D40".',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id (e.g. E12) or full name of the note.' },
        mode: { type: 'string', enum: ['around', 'path'], description: 'around (default) or path.' },
      },
      required: ['id'],
    },
  },
  rft_collect_papers: {
    description:
      'Download the papers of reference notes into the vault, in the background: from arXiv (an arXiv id or link under Source) and from open-access proceedings (a PDF link), into papers/<concept>/<year> <first author> <title>.pdf, each linked from its note (pdf:). Also moves saved PDFs when a note\'s concept changed. Returns at once; never downloads from paywalled publishers. Use after a literature search, or when asked.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Reference notes (ids); omit for every reference in the tree.' },
      },
    },
  },
  rft_set_tags: {
    description:
      'Replace the topical tags of a node (the project, type and status tags stay). Tags are made lowercase kebab-case; reuse the ones in use (rft_tags lists them all).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id (e.g. E12) or full name of the note.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'The new topical tags (an empty list removes them).' },
      },
      required: ['id', 'tags'],
    },
  },
  rft_set_type: {
    description:
      'Change the type of a note made with the wrong one (e.g. an experiment that is really a direction). The note gets the next free id of the new type (the old id is not reused) and moves to that type\'s folder; its text is kept, the type\'s missing sections are added, and every link to it in the vault is renamed. Regenerates the index and canvas. The root D00 stays a direction.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id (e.g. E12) or full name of the note.' },
        type: { type: 'string', enum: NODE_TYPES, description: 'The type the note should have.' },
      },
      required: ['id', 'type'],
    },
  },
  rft_set_concept: {
    description:
      'Make a note the start of a concept (a line of research: the note and its subtree, until a sub-concept starts), rename it, or remove it with name null. Only after the user has confirmed the concept: propose first, never apply silently. For a new concept, also ask whether code for it already exists on this machine, and where (rft_set_repos).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id (e.g. D04) or full name of the note that starts the concept, usually a direction.' },
        name: { type: ['string', 'null'], description: 'A short name for the line of research (not one experiment); null removes the concept.' },
        summary: { type: 'string', description: 'Optional one-line summary; an empty string removes it.' },
      },
      required: ['id', 'name'],
    },
  },
  rft_concepts: {
    description: 'Show the concept tree: every concept with its starting note, note count, status counts and summary.',
    inputSchema: { type: 'object', properties: {} },
  },
  rft_tags: {
    description: 'List the topical tags in use in the vault, with how many notes carry each: check it before inventing a new tag.',
    inputSchema: { type: 'object', properties: {} },
  },
  rft_inbox: {
    description:
      'The inbox: links the user saved to read later and has not decided about (Inbox.md in the vault, outside the tree; no note, no id). With no field it lists the items, the most pressing first. With a link it saves one ("save this for later"), or says where the link already is (the inbox, a processed item, a reference\'s Source) and adds nothing. A reading priority is the user\'s alone: this tool does not set one, and a why that reads as one is refused. An item is read and discussed only when the user asks to process it.',
    inputSchema: {
      type: 'object',
      properties: {
        link: { type: 'string', description: 'What to save: a URL, an arXiv id or a DOI.' },
        why: { type: 'string', description: 'One line on why it was saved, in the user\'s terms (a note id it may bear on).' },
        title: { type: 'string', description: 'Its title, only when known for certain (from the page or the paper itself); never guessed.' },
      },
    },
  },
  rft_handoff: {
    description:
      'Leave a handoff for the next session in this folder, which starts from it and the tree (a new session, or this one after /clear): done, next and unrecorded, 2,000 characters at most in all. Bring the notes up to date first: it points at notes by id and does not repeat them. Its answer lists the repositories with uncommitted changes. With no field it shows the handoff.',
    inputSchema: {
      type: 'object',
      properties: {
        done: { type: 'string', description: 'What this session did and decided, by note id.' },
        next: { type: 'string', description: 'What to do first, in order; what is running, where its output goes and what to check in it.' },
        unrecorded: { type: 'string', description: 'What neither a note nor a commit holds: uncommitted code, a log half read, a decision not written down. "nothing" when there is none.' },
        folder: { type: 'string', description: "To show another session folder's handoff." },
        clear: { type: 'boolean', description: "Remove this folder's handoff." },
      },
    },
  },
  rft_tree: {
    description: 'Show the current reasoning tree as an indented list with status marks, the whole tree or the subtree of one node.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'Id of the node whose subtree to show; omit for the whole tree.' },
        depth: { type: 'number', description: 'Levels to show below the root; omit for all.' },
      },
    },
  },
  rft_validate: {
    description:
      'Check the vault: ids, types, statuses, titles without ^ # | [ ], parents that exist, broken wikilinks, and derived fields and index in sync. Returns errors and warnings.',
    inputSchema: { type: 'object', properties: {} },
  },
  rft_sync: {
    description:
      'Regenerate everything derived from the parent fields: children / up / down frontmatter, the tree in 00 Index.md, the Obsidian canvas (and the Mermaid diagram when enabled). Run after editing notes by hand. The answer ends with the tree\'s check: no rft_validate after it.',
    inputSchema: {
      type: 'object',
      properties: { relayout: { type: 'boolean', description: 'Discard manual moves of canvas cards.' } },
    },
  },
  rft_comments: {
    description:
      'The comments and suggestions on a note: threads on a part of its text, written by the user in the tree view, or by you. Each with its quote, state, replacement, messages, and whether the quoted text is still in the note. Without id: the notes with open threads. Answer a thread when the user asks you to (the tree view\'s Ask Claude sends you the thread).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Id (e.g. E12) or full name of the note; omit for every note with open threads.' } },
    },
  },
  rft_comment: {
    description:
      'Write in a note\'s discussion, never in the note itself. With thread: your reply in that thread; on an open suggestion of a note that is not locked, once you made the change in the note yourself, applied: true closes it (text: what you changed). Without thread: a new comment on quote, the exact text of the note it is about.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id (e.g. E12) or full name of the note.' },
        thread: { type: 'string', description: 'The thread to answer, e.g. c3.' },
        quote: { type: 'string', description: 'A new comment: the exact text of the note below its frontmatter, markdown included, occurring once in it.' },
        text: { type: 'string', description: 'The reply or comment (markdown), short: the user reads it in the note drawer.' },
        applied: { type: 'boolean', description: 'On a suggestion thread: you made the change in the note yourself; closes the thread.' },
      },
      required: ['id'],
    },
  },
  rft_suggest: {
    description:
      'Propose a change to a note\'s text without making it: the user accepts or rejects it in the tree view, and an accepted one is written into the note. The only way to change a locked note. With thread: the replacement for that open suggestion (an instruction gets its text, or a revised one). Without thread: a new suggestion replacing quote with replacement.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id (e.g. E12) or full name of the note.' },
        thread: { type: 'string', description: 'The suggestion thread to answer, e.g. c3.' },
        quote: { type: 'string', description: 'A new suggestion: the exact text to replace, below the frontmatter, markdown included, occurring once in the note.' },
        replacement: { type: 'string', description: 'The new text for the quote, in markdown (an empty string deletes it).' },
        text: { type: 'string', description: 'Optional: why, in a line or two.' },
      },
      required: ['id', 'replacement'],
    },
  },
  rft_queue: {
    description:
      'Queue a run of an experiment on this machine\'s GPUs instead of launching it yourself in the background: a runner (a process of its own, it outlives the session) starts it once enough GPUs are free, in the user\'s order (they reorder, pause and cancel it in the tree view), with CUDA_VISIBLE_DEVICES set to its GPUs, and records how it ended. The command runs as `bash -c` in cwd with the session\'s environment only: activate the conda or venv in the command (`source ~/miniconda3/bin/activate env && python train.py ...`) or give the interpreter\'s full path. Create the experiment\'s note first (rft_add_node).',
    inputSchema: {
      type: 'object',
      properties: {
        exp: { type: 'string', description: 'The experiment it runs, e.g. E14.' },
        cmd: { type: 'string', description: 'The shell command, as you would type it in cwd.' },
        cwd: { type: 'string', description: 'The folder to run it in (absolute, or relative to the session\'s folder); default: the session\'s folder.' },
        gpus: { type: 'integer', description: 'How many GPUs it takes (0: none); default: the note\'s gpus:, else 1.' },
        label: { type: 'string', description: 'A few words that tell this run from the experiment\'s others, e.g. "seed 2" or "lr 3e-4".' },
        top: { type: 'boolean', description: 'First in line instead of last; only when the user asks.' },
      },
      required: ['exp', 'cmd'],
    },
  },
  rft_jobs: {
    description:
      'The experiment queue in a few lines: the GPUs, the jobs running and waiting (in order, with why each waits), the last ones that ended, and the experiments whose result is still to record. With id: one job (log: the last lines of its output) or one experiment\'s jobs.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'A job (q7) or an experiment (E14).' },
        log: { type: 'integer', description: 'With a job id: how many of the last lines of its output to show (at most 200). Rarely needed: a job\'s answer shows the commit it ran and, when it failed, the end of its traceback.' },
      },
    },
  },
  rft_job: {
    description:
      'Change the experiment queue, only when the user asks (the order and the queue are theirs). move: a waiting job to the top, the end, or before another waiting job. cancel: a waiting job leaves the queue, a running one is stopped with all it started (the experiment\'s status is left to you). retry: a job that ended is queued again, first in line. pause: no new job starts (those running go on); resume: they start again. Answers in a line, a move or a retry with the new waiting order, so no rft_jobs is needed after it.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['move', 'cancel', 'retry', 'pause', 'resume'] },
        id: { type: 'string', description: 'The job, e.g. q7 (move, cancel, retry).' },
        before: { type: 'string', description: 'move: "top", "end" (the default), or the waiting job it goes before, e.g. q3.' },
        why: { type: 'string', description: 'cancel: why, in a few words.' },
      },
      required: ['action'],
    },
  },
  rft_machine: {
    description:
      'Pair this machine with the experiment queue, which turns the queue on (until then there is none: no rft_queue, runner or monitor), or say how it stands. Only when the user asks to set up the queue or /rft-machine add asked you; never inspect the machine by hand for it. probe: what the plugin reads of the machine with no model (its NVIDIA GPUs, the disks for the runs\' outputs, the most room first, conda and uv); a machine with no NVIDIA GPU cannot be paired. add: pairs it, with runs_dir (where the runs\' outputs go) and keep_out (the GPUs the user keeps for their own work): ask the user both first, suggesting the probe\'s outputs folder and no GPU kept out; it answers what is on and the queue\'s rules. status: the pairing, the GPUs, the room left and the queue, in a few lines. Only this machine can be paired for now.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['probe', 'add', 'status'] },
        runs_dir: { type: 'string', description: 'add: the root of the runs\' outputs (absolute, or ~/…); default: the one probe suggests.' },
        keep_out: { type: 'array', items: { type: 'integer' }, description: 'add: the indices of the GPUs kept out of the queue for the user\'s own work; default none.' },
      },
      required: ['action'],
    },
  },
} as const
