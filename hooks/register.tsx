// rft: the Reasoning Flow Tree plugin. Commands (/rft, /rft-init, /rft-concepts, /rft-literature, /rft-rebalance,
// /rft-summarize, /rft-next, /rft-view), the model's tools (rft_add_node, rft_set_status, rft_set_summary, rft_map, rft_set_digest, rft_move_node, rft_set_refs, rft_search,
// rft_graph, rft_supersede, rft_next, rft_collect_papers, rft_set_tags, rft_set_type, rft_set_concept, rft_concepts, rft_set_repos, rft_code,
// rft_set_code, rft_tags, rft_tree, rft_validate, rft_sync), the operating rules
// injected into the system prompt, the outline pane, and the web view: /rft starts a local
// server (server/rft_server.py) for the interactive tree page (web/), and makes the notes that
// page adds, retypes or moves (fromView). Everything is
// inert without `.rft/config.json` in the session's folder or a folder above it; that config
// may be a link (`{"tree": "../notes"}`) to a tree kept elsewhere.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RftSnapshot } from '../types'
import type { CodeEnv, Git } from './lib/ops'
import { addNode, codeReport, conceptsReport, exportHtml, initVault, loadActive, moveNode, rulesText, setCode, setConcept, setRefs, setRepos, setStatus, setTags, setType, tagsReport, today, treeReport } from './lib/ops'
import { ASSET_PATHS } from './lib/page'
import type { Config, Io, Loaded, NodeType, Tree } from './lib/vault'
import { OPEN_HOSTS, planPapers } from './lib/papers'
import { searchReport, similarNotes } from './lib/search'
import { graphReport } from './lib/graph'
import { candidates, candidatesReport } from './lib/rebalance'
import { nextReport, supersede } from './lib/knowledge'
import { RECALL_HINT, searchesVault } from './lib/recall'
import { SMALL_TREE, mapGaps, mapReport, mapWarnings, projectMap, readDigests, resolveConcept, setDigest, setSummaries } from './lib/map'
import { LEGEND, MARK, NODE_TYPES, bodyOf, counts, countsLine, isAbsolute, join, locate, readConfig, resolveId, resolvePath, rooted, setField, signatureOf, sync, validate } from './lib/vault'

const PANE = 'rft-tree'
const TITLE = 'Reasoning tree'
const POLL_MS = 4000

const snapshot = atom({ plugin: 'rft', key: 'snapshot' } as const, null)
const collapsed = atom({ plugin: 'rft', key: 'collapsed' } as const, [])
const selected = atom({ plugin: 'rft', key: 'selected' } as const, null)
const note = atom({ plugin: 'rft', key: 'note' } as const, null)
const webUrl = atom({ plugin: 'rft', key: 'webUrl' } as const, null)

const ioOf = ($: EngineInterface): Io => ({
  read: path => $.fs.read(path),
  write: (path, text) => $.fs.write(path, text),
  list: path => $.fs.list(path),
  exists: path => $.fs.exists(path),
  remove: async path => {
    const argv = /^[A-Za-z]:/.test(path) ? ['cmd', '/c', 'del', '/f', '/q', path.replace(/\//g, '\\')] : ['rm', '-f', '--', path]
    const r = await $.process.run(argv)
    if (r.exitCode !== 0 || (await $.fs.exists(path))) throw new Error(r.stderr.trim() || `${argv[0]} left the file in place`)
  },
})

/** The tree a session works on: its files and folder, the link that led there, the session's folder. */
type Here = { io: Io; root: string; link: string | null; cwd: string }

/** This session's tree, from its folder up and through a link; why a link leads nowhere; or null. */
async function locateHere($: EngineInterface): Promise<Here | { problem: string } | null> {
  const cwd = resolvePath(await $.session.cwd(), '.')
  const found = await locate(ioOf($), cwd)
  if (!found) return null
  if (found.root === null) return { problem: found.problem }
  return { io: rooted(ioOf($), found.root), root: found.root, link: found.link, cwd }
}

/** This session's tree; throws, with the reason, when there is none to work on. */
async function mustHere($: EngineInterface): Promise<Here> {
  const h = await locateHere($)
  if (!h) throw new Error(NOT_ACTIVE)
  if ('problem' in h) throw new Error(h.problem)
  return h
}

const vaultOf = (h: Here, config: Config) => (isAbsolute(config.vault) ? config.vault : join(h.root, config.vault))

/** The vault as the session is told about it: as configured when the tree is in its own folder. */
const shownVault = (h: Here, config: Config) => (h.root === h.cwd ? config.vault : vaultOf(h, config))

const treeOf = (s: RftSnapshot): Tree => ({ nodes: s.nodes, roots: s.roots, concepts: s.concepts })

const TOOLS = {
  rft_add_node: {
    description:
      'Add a node to the reasoning tree: an experiment (something run or computed), a direction (an idea, question or hypothesis, rejected ones included), a reference (a paper, method or literature review that was read, summarised and commented, with a source that can be checked) or a theory note (a definition, method, taxonomy or argument of the project\'s own, built on the other notes). Assigns the next free id, sanitises the title, writes the note from the template, links it under its parent and regenerates the index and canvas. Create an experiment BEFORE launching it (status planned or running). In a concept that links code, an experiment or direction gets a ## Code section with the repos\' current commits: read the code first and pass its description as sections.Code, or write it after with rft_set_code.',
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
        tags: { type: 'array', items: { type: 'string' }, description: '1-3 short topical tags, lowercase kebab-case, reused from rft_tags when they fit (the project, type and status tags are added anyway).' },
        refs: { type: 'array', items: { type: 'string' }, description: 'Ids of the reference notes (R..) it builds on: for an experiment, the paper(s) whose setup it starts from; for a direction, the work it extends. Add missing references first.' },
        summary: { type: 'string', description: 'One line (at most 240 characters) on what the note is about, specific enough to read instead of the note: what is tested and on what, the idea, the paper\'s main claim. Always give it.' },
      },
      required: ['type', 'title'],
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
  rft_set_status: {
    description:
      'Change the status of a node (frontmatter, tag and the Status line) and optionally append a note: for an experiment to its Result section, for a reference to its Relevance section, for a direction or a theory note to its Status section (say why it was dropped or where it was moved). Regenerates the index and canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Id (e.g. E12) or full name of the note.' },
        status: { type: 'string', enum: ['planned', 'running', 'done', 'idea', 'dropped', 'discussed', 'moved'] },
        note: { type: 'string', description: 'Optional text to append (real results, or the reason).' },
        summary: { type: 'string', description: 'The note\'s one-line summary, updated with what it found (the key number) or why it was dropped.' },
      },
      required: ['id', 'status'],
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
      'Mark a note whose result a newer one overturns (superseded_by: in its frontmatter, and a dated History line): a corrected number, a bug found in the run, a better-controlled rerun that changes the conclusion. rft_map, rft_search and rft_graph then show it as superseded, so nobody builds on the old result. Without by, clears the mark. Then update the concept\'s digest.',
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
  rft_move_node: {
    description:
      'Move a note and its whole subtree under another parent, when it belongs to another line of research. The note keeps where it came from (origin: and a dated History line), the old parent stops listing it, the new one lists it, and the index and canvas follow. Only after the user has agreed to the move.',
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
        status: { type: 'string', enum: ['planned', 'running', 'done', 'idea', 'dropped', 'discussed', 'moved'] },
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
      'Replace the topical tags of a node (the project, type and status tags stay). Tags are made lowercase kebab-case; reuse the vocabulary rft_tags lists.',
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
      'Regenerate everything derived from the parent fields: children / up / down frontmatter, the tree in 00 Index.md, the Obsidian canvas (and the Mermaid diagram when enabled). Run after editing notes by hand.',
    inputSchema: {
      type: 'object',
      properties: { relayout: { type: 'boolean', description: 'Discard manual moves of canvas cards.' } },
    },
  },
} as const

// Module state: reset on a reload, when `session.start` runs again and sets it anew.
// The rules for the system prompt are fixed at activation so the prompt cache holds.
let rules: string | null = null
// the vault's folder and the session's, for the recall hint; whether rft_search, rft_map or
// rft_graph was used yet this session (the hint stops then)
let recall: { vault: string; cwd: string; used: boolean } | null = null
let poller: { cancel: () => void } | null = null
// a prompt a command wants Claude to answer, submitted by the poller
let pendingPrompt: string | null = null
const registeredTools = new Set<string>()

const EMPTY: RftSnapshot = { isActive: false, vault: '', project: '', nodes: {}, roots: [], concepts: {}, signature: '', problems: [], error: null }

/** Re-reads the vault into the snapshot when its notes changed (or always, with `force`). */
async function refresh($: EngineInterface, force = false): Promise<RftSnapshot | null> {
  const h = await locateHere($)
  const prev = await read($, snapshot)
  const config = h && !('problem' in h) ? await readConfig(h.io) : null
  if (!h || 'problem' in h || !config) {
    const why = h && 'problem' in h ? h.problem : null
    if (prev?.isActive !== false || prev.error !== why) await update($, snapshot, () => ({ ...EMPTY, error: why }))
    return null
  }
  const io = h.io
  const vault = vaultOf(h, config)
  if (!force && prev?.isActive && !prev.error && prev.signature === (await signatureOf(io, config.vault))) return prev
  try {
    const loaded = await loadActive(io)
    const next: RftSnapshot = {
      isActive: true, vault, project: config.project, nodes: loaded.tree.nodes,
      roots: loaded.tree.roots, concepts: loaded.tree.concepts ?? {}, signature: loaded.signature, problems: loaded.problems, error: null,
    }
    await update($, snapshot, () => next)
    const shown = await read($, note)
    if (shown && loaded.tree.nodes[shown.id]) {
      const text = loaded.texts[shown.id] ?? ''
      if (text !== shown.text) await update($, note, () => ({ id: shown.id, text }))
    }
    return next
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, snapshot, s => ({ ...(s ?? EMPTY), isActive: true, vault, project: config.project, error: message }))
    return null
  }
}

/** In a project with `.rft/config.json`: the snapshot, the rules, the tools, the poll, the pane. */
async function activate($: EngineInterface, shouldOpen: boolean): Promise<void> {
  const failed: string[] = []
  let s: RftSnapshot | null = null
  let config: Config | null = null
  let h: Here | null = null
  recall = null
  try {
    s = await refresh($, true)
    h = await mustHere($)
    config = await readConfig(h.io)
  } catch (err) {
    failed.push(`reading the vault (${message(err)})`)
  }
  if (s && config && h) {
    // a large tree starts from the project map; a small one from its list of notes
    let map: string | undefined
    if (Object.keys(s.nodes).length > SMALL_TREE) {
      try {
        const loaded = await loadActive(h.io)
        map = projectMap(loaded, await readDigests(h.io, loaded))
      } catch { /* the list of notes instead */ }
    }
    rules = rulesText(treeOf(s), config, shownVault(h, config), { cwd: h.cwd, root: h.root, home: await homeOf($) }, map)
    recall = { vault: resolvePath(h.root, vaultOf(h, config)), cwd: h.cwd, used: false }
  }
  // each registration on its own, so one refusal leaves the rest working
  for (const [name, spec] of Object.entries(TOOLS)) {
    if (registeredTools.has(name)) continue
    try {
      await $.tool.register({ name, description: spec.description, inputSchema: spec.inputSchema as Record<string, unknown>, isDeferred: false })
      registeredTools.add(name)
    } catch (err) {
      failed.push(`tool ${name} (${message(err)})`)
    }
  }
  try {
    poller?.cancel()
    poller = $.clock.every(POLL_MS, () => { void poll($) })
  } catch (err) {
    failed.push(`the refresh timer (${message(err)})`)
  }
  if (shouldOpen) void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
  if (failed.length) reportFailures($, failed)
}

/** A session's start, past the commands: the tree when there is one, else why its link leads nowhere. */
async function start($: EngineInterface, shouldOpen: boolean): Promise<void> {
  let isActive = false
  try {
    const h = await locateHere($)
    if (h && 'problem' in h) {
      await update($, snapshot, () => ({ ...EMPTY, error: h.problem }))
      $.ui.toast(`rft: ${h.problem}`)
    } else if (h) isActive = (await readConfig(h.io)) !== null
  } catch { /* treated as inactive */ }
  if (isActive) await activate($, shouldOpen)
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

function reportFailures($: EngineInterface, failed: string[]): void {
  $.ui.toast(`rft: could not set up ${failed.join('; ')}`)
}

/** Each command on its own, so one refusal leaves the others registered. */
async function registerCommands($: EngineInterface): Promise<void> {
  const failed: string[] = []
  const attempt = async (name: string, run: () => Promise<unknown>) => {
    try { await run() } catch (err) { failed.push(`/${name} (${message(err)})`) }
  }
  await attempt('rft', () => $.command.register({ name: 'rft', description: 'Open the interactive tree view (/rft list: the outline pane, /rft text: print it, /rft stop: stop the server)', argumentHint: '[list|text|stop]' }))
  await attempt('rft-init', () => $.command.register({ name: 'rft-init', description: 'Activate the Reasoning Flow Tree in this project and create its vault', argumentHint: '[starting question]' }))
  await attempt('rft-concepts', () => $.command.register({ name: 'rft-concepts', description: 'Print the concept tree (/rft-concepts suggest: ask Claude to propose a concept split)', argumentHint: '[suggest]' }))
  await attempt('rft-literature', () => $.command.register({ name: 'rft-literature', description: 'Ask Claude for a literature search on a topic, a note or a concept, ending in reference notes', argumentHint: '<topic, note id or concept>' }))
  await attempt('rft-rebalance', () => $.command.register({ name: 'rft-rebalance', description: 'Ask Claude to propose moving branches under the line of research they belong to; nothing moves until you confirm', argumentHint: '[concept or note id] [--full]' }))
  await attempt('rft-next', () => $.command.register({ name: 'rft-next', description: 'What is still open, by concept: running and planned experiments, unexplored directions, open questions', argumentHint: '[concept]' }))
  await attempt('rft-summarize', () => $.command.register({ name: 'rft-summarize', description: 'Ask Claude to write the missing one-line note summaries and concept digests (the project map)', argumentHint: '[concept]' }))
  await attempt('rft-view', () => $.command.register({ name: 'rft-view', description: 'Write a standalone HTML view of the tree to <vault>/tree.html' }))
  if (failed.length) reportFailures($, failed)
}

async function poll($: EngineInterface): Promise<void> {
  void submitPending($)
  try { await refresh($) } catch { /* tried again at the next tick */ }
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : typeof v === 'string' ? v.split(',') : [])

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)

const answer = (text: string, isError = false) =>
  isError ? { isError: true as const, result: text, text } : { result: text, text }

/** Git in a folder, through the host: no shell, the repo's hooks off. */
const gitOf = ($: EngineInterface): Git => async (dir, args) => {
  try {
    const r = await $.process.run(['git', '-C', dir, ...args], { timeoutMs: 20000 })
    return { ok: r.exitCode === 0, out: r.stdout, err: r.stderr }
  } catch (err) {
    return { ok: false, out: '', err: message(err) }
  }
}

async function homeOf($: EngineInterface): Promise<string | undefined> {
  try {
    return (await $.env.get('HOME')) || undefined
  } catch {
    return undefined
  }
}

/** How the tools reach the code of the tree's concepts. */
const codeEnv = async ($: EngineInterface, h: Here): Promise<CodeEnv> => ({ root: h.root, git: gitOf($), home: await homeOf($), date: today() })

/** Runs one of the rft tools; its text is the tool's result. */
async function runTool($: EngineInterface, name: string, i: Record<string, unknown>): Promise<string> {
  const h = await mustHere($)
  const io = h.io
  const loaded = await loadActive(io)
  switch (name) {
    case 'rft_add_node': {
      const sections: Record<string, string> = {}
      for (const [k, v] of Object.entries((i.sections as Record<string, unknown> | undefined) ?? {})) if (str(v)) sections[k] = String(v)
      if (str(i.what)) sections.What = String(i.what)
      if (str(i.why)) sections.Why = String(i.why)
      if (str(i.idea)) sections.Idea = String(i.idea)
      if (str(i.result)) sections.Result = String(i.result)
      const node = await addNode(io, loaded, {
        type: i.type as NodeType, title: String(i.title ?? ''), parent: str(i.parent) ?? null,
        status: str(i.status), date: today(), sections, code: str(i.code), tags: strings(i.tags), refs: strings(i.refs), summary: str(i.summary),
      }, await codeEnv($, h))
      const similar = similarNotes(loaded, node.id)
      return `${node.report}\nId: ${node.id}\nNote: ${join(shownVault(h, loaded.config), node.path)}${similar ? `\n${similar}` : ''}`
    }
    case 'rft_set_repos':
      return setRepos(io, loaded, await codeEnv($, h), String(i.id ?? ''), strings(i.repos))
    case 'rft_code':
      return codeReport(io, loaded, await codeEnv($, h), String(i.id ?? ''))
    case 'rft_set_code':
      return setCode(io, loaded, await codeEnv($, h), String(i.id ?? ''), typeof i.text === 'string' ? i.text : undefined, typeof i.reproduce === 'string' ? i.reproduce : undefined)
    case 'rft_move_node':
      return moveNode(io, loaded, String(i.id ?? ''), String(i.parent ?? ''), today(), str(i.why))
    case 'rft_set_refs':
      return setRefs(io, loaded, String(i.id ?? ''), strings(i.refs))
    case 'rft_search':
      return searchReport(loaded, str(i.query) ?? '', { type: str(i.type), status: str(i.status), concept: str(i.concept), tag: str(i.tag) },
        typeof i.limit === 'number' && i.limit > 0 ? Math.min(50, Math.floor(i.limit)) : 10, await readDigests(io, loaded))
    case 'rft_graph':
      return graphReport(loaded, String(i.id ?? ''), i.mode === 'path' ? 'path' : 'around')
    case 'rft_collect_papers':
      return collectPapers($, h, loaded, strings(i.ids))
    case 'rft_set_tags':
      return setTags(io, loaded, String(i.id ?? ''), strings(i.tags))
    case 'rft_set_type':
      return setType(io, loaded, String(i.id ?? ''), String(i.type ?? ''))
    case 'rft_set_concept':
      return setConcept(io, loaded, String(i.id ?? ''), typeof i.name === 'string' ? i.name : null, typeof i.summary === 'string' ? i.summary : undefined)
    case 'rft_concepts':
      return conceptsReport(loaded)
    case 'rft_tags':
      return tagsReport(loaded)
    case 'rft_set_status':
      return setStatus(io, loaded, String(i.id ?? ''), String(i.status ?? ''), str(i.note), str(i.summary))
    case 'rft_set_summary': {
      const given: Record<string, string> = {}
      for (const [k, v] of Object.entries((i.summaries as Record<string, unknown> | undefined) ?? {})) if (typeof v === 'string') given[k] = v
      if (!Object.keys(given).length) throw new Error('summaries is empty: give {"<id>": "<one line>"}')
      return setSummaries(io, loaded, given)
    }
    case 'rft_supersede':
      return supersede(io, loaded, String(i.id ?? ''), str(i.by) ?? null, str(i.why), today())
    case 'rft_next':
      return nextReport(io, loaded, today(), str(i.concept))
    case 'rft_map':
      return mapReport(io, loaded, str(i.concept))
    case 'rft_set_digest':
      return setDigest(io, loaded, String(i.concept ?? ''), String(i.state ?? ''), String(i.text ?? ''), today())
    case 'rft_tree':
      return treeReport(loaded, { root: str(i.root), depth: typeof i.depth === 'number' ? i.depth : undefined, vault: shownVault(h, loaded.config) })
    case 'rft_validate': {
      const v = await validate(io, loaded, { root: h.root, home: await homeOf($) })
      v.warnings.push(...(await mapWarnings(io, loaded)))
      const lines = [v.errors.length
        ? `FAILED: ${v.errors.length} error(s), ${v.warnings.length} warning(s).`
        : `OK: no errors, ${v.warnings.length} warning(s).`]
      if (v.errors.length) lines.push('Errors:', ...v.errors.map(x => `- ${x}`))
      if (v.warnings.length) lines.push('Warnings:', ...v.warnings.map(x => `- ${x}`))
      return lines.join('\n')
    }
    case 'rft_sync': {
      const r = await sync(io, loaded, { relayout: i.relayout === true })
      return r.changed.length
        ? `Updated ${r.changed.length} file(s):\n${r.changed.map(c => `- ${c}`).join('\n')}`
        : 'Everything was already in sync.'
    }
    default:
      throw new Error(`unknown rft tool ${name}`)
  }
}

async function selectNode($: EngineInterface, id: string): Promise<void> {
  if ((await read($, selected)) === id) {
    await update($, selected, () => null)
    await update($, note, () => null)
    return
  }
  const s = await read($, snapshot)
  const n = s?.nodes[id]
  if (!s || !n) return
  let text: string
  try { text = await $.fs.read(join(s.vault, n.path)) } catch { text = '(the note could not be read)' }
  await update($, selected, () => id)
  await update($, note, () => ({ id, text }))
}

async function toggleFold($: EngineInterface, id: string): Promise<void> {
  await update($, collapsed, list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]))
}

async function foldAll($: EngineInterface, ids: string[]): Promise<void> {
  await update($, collapsed, () => ids)
}

// ---------------------------------------------------------------- the web view's server

// the running server, one per session and kept across a /clear; a reload of the module kills the
// child with it
let server: { url: string; stop: () => void } | null = null

/** Starts the web view's server, or answers the running one's URL. */
async function startServer($: EngineInterface): Promise<string> {
  if (server) return server.url
  const h = await mustHere($)
  const config = await readConfig(h.io)
  if (!config) throw new Error(NOT_ACTIVE)
  const vault = vaultOf(h, config)
  const root = $.plugin.root
  const args = [
    join(root, 'server/rft_server.py'), '--vault', vault, '--web', join(root, 'web'),
    '--project', config.project, '--port', String(config.webPort ?? 0),
  ]
  const failures: string[] = []
  for (const python of ['python3', 'python']) {
    try {
      return await spawnServer($, [python, ...args])
    } catch (err) {
      failures.push(`${python}: ${message(err)}`)
    }
  }
  throw new Error(`the web view needs Python 3 on PATH (${failures.join('; ')})`)
}

/** Runs one server child for the session and resolves its URL once it listens. */
async function spawnServer($: EngineInterface, argv: string[]): Promise<string> {
  const child = $.process.spawn({ argv })
  let found: (url: string) => void = () => undefined
  let failed: (err: Error) => void = () => undefined
  const listening = new Promise<string>((resolve, reject) => { found = resolve; failed = reject })
  // the loop is the child's life: it runs on after this call returns, until the child exits,
  // `stop` ends it, or the module unloads
  void (async () => {
    let line = ''
    let err = ''
    try {
      for await (const chunk of child) {
        if (chunk.stream === 'stdout') {
          // whole lines: the address once, then a line for each note the tree view adds
          const lines = (line + chunk.text).split('\n')
          line = lines.pop()!
          for (const l of lines) {
            const m = /RFT_SERVER_URL (\S+)/.exec(l)
            if (m) found(m[1]!)
            else {
              const asked = FROM_VIEW.find(a => l.startsWith(a.line))
              if (asked) void fromView($, asked, l.slice(asked.line.length))
            }
          }
        } else err += chunk.text
      }
      failed(new Error(err.trim().split('\n').pop() || 'the server exited'))
    } catch (e) {
      failed(e instanceof Error ? e : new Error(String(e)))
    }
    if (server?.stop === stop) {
      server = null
      try { await update($, webUrl, () => null) } catch { /* the session is gone */ }
    }
  })()
  const stop = () => { void child.return?.(undefined as never) }
  const late = $.clock.sleep(8000).then(() => { throw new Error('the server did not start within 8 s') })
  late.catch(() => undefined)
  try {
    const url = await Promise.race([listening, late])
    server = { url, stop }
    await update($, webUrl, () => url)
    return url
  } catch (err) {
    stop()
    throw err
  }
}

const FROM_VIEW = [
  { line: 'RFT_ADD_NODE ', tool: 'rft_add_node', fields: ['type', 'parent', 'title'], what: 'add a note' },
  { line: 'RFT_SET_TYPE ', tool: 'rft_set_type', fields: ['id', 'type'], what: "change a note's type" },
  { line: 'RFT_MOVE_NODE ', tool: 'rft_move_node', fields: ['id', 'parent'], what: 'move a note' },
] as const

/** A change the tree view asks for (POST api/node, api/type or api/move, relayed by the server). */
async function fromView($: EngineInterface, asked: (typeof FROM_VIEW)[number], request: string): Promise<void> {
  try {
    const r = JSON.parse(request) as Record<string, unknown>
    await runTool($, asked.tool, Object.fromEntries(asked.fields.map(f => [f, r[f]])))
    await refresh($, true)
  } catch (err) {
    $.ui.toast(`rft: the tree view could not ${asked.what} (${message(err)})`)
  }
}

// ---------------------------------------------------------------- papers

const PAPER = 'RFT_PAPER '
const PAPERS_DONE = 'RFT_PAPERS_DONE '

/** Starts the background download of reference papers (server/rft_papers.py); answers at once. */
async function collectPapers($: EngineInterface, h: Here, loaded: Loaded, ids: string[]): Promise<string> {
  const plan = planPapers(loaded, ids.map(id => resolveId(loaded.tree, id) ?? id))
  const lines: string[] = []
  const fetches = plan.jobs.filter(j => j.op === 'fetch').length
  const moves = plan.jobs.length - fetches
  if (plan.jobs.length) {
    const args = [join($.plugin.root, 'server/rft_papers.py'), '--vault', vaultOf(h, loaded.config), '--jobs', JSON.stringify(plan.jobs), '--hosts', OPEN_HOSTS.join(',')]
    let started = false
    for (const python of ['python3', 'python']) {
      try { runPapers($, h, $.process.spawn({ argv: [python, ...args] })); started = true; break } catch { /* the next one */ }
    }
    if (!started) throw new Error('collecting papers needs Python 3 on PATH')
    lines.push(`Started in the background: ${fetches} paper(s) to download${moves ? `, ${moves} to move to their concept's folder` : ''}. Each note gets a pdf: link when its file is saved; a toast says when all are done.`)
  } else lines.push('Nothing to download or move.')
  if (plan.saved.length) lines.push(`Already saved: ${plan.saved.join(', ')}.`)
  if (plan.skipped.length) lines.push('Not downloaded:', ...plan.skipped.map(s => `- ${s.id}: ${s.why}`))
  return lines.join('\n')
}

/** Follows the downloader: links each saved file from its note, one note at a time, then reports. */
function runPapers($: EngineInterface, h: Here, child: ReturnType<EngineInterface['process']['spawn']>): void {
  let chain = Promise.resolve()
  const failed: string[] = []
  void (async () => {
    let line = ''
    try {
      for await (const chunk of child) {
        if (chunk.stream !== 'stdout') continue
        const lines = (line + chunk.text).split('\n')
        line = lines.pop()!
        for (const l of lines) {
          if (l.startsWith(PAPER)) {
            const r = JSON.parse(l.slice(PAPER.length)) as { id: string; ok: boolean; file?: string; error?: string }
            if (!r.ok) { failed.push(`${r.id} (${r.error})`); continue }
            chain = chain.then(() => linkPaper(h, r.id, r.file!)).catch(err => { failed.push(`${r.id} (${message(err)})`) })
          } else if (l.startsWith(PAPERS_DONE)) {
            const d = JSON.parse(l.slice(PAPERS_DONE.length)) as { ok: number; failed: number }
            await chain
            $.ui.toast(`rft: ${d.ok} paper(s) saved in the vault's papers/ folder${failed.length ? `; not saved: ${failed.join(', ')}` : ''}`)
            await refresh($, true)
          }
        }
      }
    } catch (err) {
      $.ui.toast(`rft: collecting papers stopped (${message(err)})`)
    }
  })()
}

/** Writes `pdf: "[[<file>]]"` into the reference note (read afresh: the user may have edited it). */
async function linkPaper(h: Here, id: string, file: string): Promise<void> {
  const loaded = await loadActive(h.io)
  const n = loaded.tree.nodes[id]
  if (!n) return
  const text = loaded.texts[id]!
  const next = setField(text, 'pdf', `"[[${file}]]"`, 'tags')
  if (next !== text) await h.io.write(join(loaded.config.vault, n.path), next)
}

async function stopServer($: EngineInterface): Promise<boolean> {
  const was = server
  server = null
  was?.stop()
  await update($, webUrl, () => null)
  return was !== null
}

// ---------------------------------------------------------------- the desktop's browser pane

// the desktop app serves its built-in browser to the session as this MCP server
const BROWSER = 'Claude_Browser'

type BrowserOpen = { isOpened: true; isReused: boolean; isHidden: boolean } | { isOpened: false; why: string }

const textOf = (r: { content?: readonly { type: string; text?: string }[] }) =>
  (r.content ?? []).map(b => (b.type === 'text' ? b.text ?? '' : '')).join('\n')

/** The tabs `tabs_context` lists: its JSON, then a line saying whether the pane shows. */
function parseTabs(text: string): { tabs: { tabId: string; origin: string }[]; isHidden: boolean } {
  let tabs: { tabId: string; origin: string }[] = []
  try {
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { tabs?: { tabId: string; origin: string }[] }
    tabs = (json.tabs ?? []).filter(t => typeof t.tabId === 'string' && typeof t.origin === 'string')
  } catch { /* no tabs we can read: open a new one */ }
  return { tabs, isHidden: /hidden|not open/i.test(text.slice(text.lastIndexOf('}') + 1)) }
}

/**
 * Shows the tree view in the desktop's browser pane: the tab already on it when there is one,
 * else a new tab. Resolves why not when the session has no browser pane or a call fails.
 */
async function openInBrowser($: EngineInterface, url: string): Promise<BrowserOpen> {
  // the address carries the server's key (?token=); a tab is matched on scheme, host and port
  const origin = /^[a-z]+:\/\/[^/?#]+/i.exec(url)?.[0] ?? url
  try {
    let found: { tabId: string } | undefined
    let isHidden = false
    try {
      const ctx = await $.mcp.call(BROWSER, 'tabs_context', {})
      if (!ctx.isError) {
        const parsed = parseTabs(textOf(ctx))
        found = parsed.tabs.find(t => t.origin.replace(/\/+$/, '') === origin)
        isHidden = parsed.isHidden
      }
    } catch { /* tabs_context missing: preview_start still opens a tab */ }
    if (found) {
      const nav = await $.mcp.call(BROWSER, 'navigate', { url, tabId: found.tabId })
      if (nav.isError) throw new Error(textOf(nav) || 'navigate failed')
      const front = await $.mcp.call(BROWSER, 'tabs_select', { tabId: found.tabId })
      if (front.isError) throw new Error(textOf(front) || 'tabs_select failed')
      return { isOpened: true, isReused: true, isHidden }
    }
    const opened = await $.mcp.call(BROWSER, 'preview_start', { url })
    if (opened.isError) throw new Error(textOf(opened) || 'preview_start failed')
    return { isOpened: true, isReused: false, isHidden: false }
  } catch (err) {
    return { isOpened: false, why: message(err) }
  }
}

async function isOnDesktop($: EngineInterface): Promise<boolean> {
  try {
    return (await $.session.surfaces()).includes('desktop')
  } catch {
    return false
  }
}

const webHelp = (url: string) => {
  const port = /:(\d+)\//.exec(url)?.[1] ?? '<port>'
  return [
    `Tree view: ${url}`,
    'Open it in the desktop app\'s built-in browser (Ctrl+Shift+B, Cmd+Shift+B on macOS) and paste the URL in its address bar, or in any browser on this machine.',
    `On a remote machine, forward the port first: ssh -L ${port}:127.0.0.1:${port} <host>, then open ${url} locally.`,
    'The outline stays in the pane; /rft stop stops the server.',
  ].join('\n')
}

/** Submits a prompt a command queued; called from the poller, outside any command's dispatch. */
async function submitPending($: EngineInterface): Promise<void> {
  const text = pendingPrompt
  if (!text) return
  pendingPrompt = null
  try {
    await $.prompt.submit({ text })
  } catch (err) {
    $.ui.toast(`rft: could not ask Claude (${message(err)}); ask it yourself, e.g. "propose concepts for the tree"`)
  }
}

/**
 * The literature search: `subject` is a topic in words, a note id or a concept name; the
 * references go under that note, the concept's start note, or the note the topic belongs to.
 */
const literaturePrompt = (subject: string, where: string | null) => `Run a thorough literature search on ${JSON.stringify(subject)} for this project (rft-manual skill, "Literature"). ${where ? `Place the references under ${where}.` : 'First find where it belongs in the tree (rft_tree, rft_concepts): the note or concept it is about; if it opens a new field, ask me where to put it before adding notes.'} Use the search tools you have (web search, deep research, arXiv); prefer peer-reviewed papers, well-known preprints and surveys, the most cited and the most recent. Read each source before writing about it. For each key paper (usually 4 to 10), add one reference note with rft_add_node (type reference): Source with a link that can be checked (DOI, arXiv id or URL), Summary, Method, Key results as the paper reports them (with the table or section), and under Relevance what it means for this project; status done once summarised from the paper itself, planned if only found. Never invent a citation or a result. Once the notes are written, call rft_collect_papers with their ids: it saves the open-access PDFs in the background. Then give me a short synthesis: what is known, what is open, which setups an experiment could start from; list the directions it suggests and ask which ones to add. Do not add directions or experiments until I say which.`

/** The rebalancing request; `scope` (a concept name or a note id) narrows it to one part of the tree. */
const rebalancePrompt = (scope: string) => `Propose a rebalancing of the reasoning tree (rft-manual skill, "Restructuring the tree")${scope ? `, limited to ${JSON.stringify(scope)} (a concept or a note: consider the branches in it, and moves into it or out of it)` : ''}. Over time some branches grow out of one line of research but belong to another: an experiment hung under the note that happened to come before it, an idea that opened a different line, a branch that would sit better under another concept. Start from the map: rft_map, then rft_map <concept> for the concepts involved (their digests and one-line note summaries); read a note's file only when its summary leaves the move in doubt. For each branch that clearly belongs elsewhere, propose one move: the note to move (its subtree goes with it), its parent now, the new parent, and why in one line. Keep the tree's history in mind: a note that came out of a result stays where the reasoning produced it unless it really is part of another line; when in doubt, leave it. Moves only: if a new concept would help, say so separately (rft_set_concept, after the user agrees). Present the moves as a short numbered table, say what you would leave as it is, and ask me which moves to apply. Do not call rft_move_node until I say yes; then apply only the moves I confirm, each with its why, and finish with rft_validate.`

/** The rebalancing request from the plugin's short list of candidates. */
const candidatesPrompt = (scope: string, list: string) => `Propose a rebalancing of the reasoning tree (rft-manual skill, "Restructuring the tree")${scope ? `, limited to ${JSON.stringify(scope)}` : ''}. The plugin compared every note with the concepts (its title, summary, tags and references against each concept's notes) and found these candidates, notes that sit closer to another concept than to their own:\n\n${list}\n\nJudge only these; do not survey the rest of the tree. The weak candidates, if any, are listed one line each: most of them stay where they are, so look further only at those whose line suggests a real misplacement (a note about one line of research hung under another). For each candidate you look at, check it against the two concepts (rft_map <concept> if their state is not clear to you, rft_graph <id> for its neighbours) and open a note's file only when that leaves the move in doubt. The fit is a hint from shared words, not a verdict: a note that came out of a result stays where the reasoning produced it unless it really is part of another line; when in doubt, leave it. For each move you keep: the note to move (its subtree goes with it), its parent now, the new parent (the nearest note named is a start, pick the right one), and why in one line. Moves only: if a new concept would help, say so separately (rft_set_concept, after the user agrees). Present the moves as a short numbered table, say which candidates you would leave and why in a few words, and ask me which moves to apply. Do not call rft_move_node until I say yes; then apply only the moves I confirm, each with its why, and finish with rft_validate.`

/** The back-fill of the map: summaries of the notes without one, then the digests, concept by concept. */
const summarizePrompt = (scope: string) => `Fill in the project map of the reasoning tree${scope ? ` for the concept ${JSON.stringify(scope)} and its sub-concepts` : ''} (rft-manual skill, "The project map"). Work concept by concept, the smallest sub-concepts first: call rft_map <concept> to see its notes and which have no summary; read those notes (their Idea, What, Why, Result, Summary, Relevance, Statement: the parts that say what the note is and what it found, not the boilerplate) and set a one-line summary for each with rft_set_summary, many per call (at most 20). A summary says what the note is about and, if it has one, its result with the key number; for a dropped or discussed direction, why. Never invent a result: when the note has none, say what it tests. Then, with all its summaries set, write the concept's digest with rft_set_digest: its state in one or two sentences, then ## Key results, ## Dead ends and ## Open questions, each point with the note ids. Go on to the next concept without asking me, and at the end run rft_validate and tell me how many summaries and digests you wrote.`

const SUGGEST_CONCEPTS = `Propose a split of the reasoning tree into concepts (rft-manual skill, "Concepts"). Read the current tree with rft_tree and rft_concepts. Suggest 2 to 6 concepts, nested at most two levels: for each, the note that starts it (usually the direction that opened that line of research), a short readable name for the line of research, in words as in a heading (e.g. "Strong augmentation", not a tag like strong-augmentation; never a single experiment), and a one-line summary; say which notes stay in the project root and why. Present the proposal as a short table and ask me to confirm or change it, and for each concept whether code for it already exists on this machine and where. Do not call rft_set_concept until I say yes, nor rft_set_repos before I give a path.`

const NOT_ACTIVE = 'RFT is not active in this project. Run /rft-init [starting question] to set it up.'

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await registerCommands($)
    // a server of an earlier load of this module died with it
    if (!server) await update($, webUrl, () => null)
    // the desktop shows the tree view in its browser pane (/rft); the outline opens on asking
    await start($, options.autoOpen !== false && !(await isOnDesktop($)))

    return next(e)
  })

  // a /clear (or /resume) ends the session and goes on in a fresh one with no session.start: its
  // state starts empty and session.end stopped the poll, so the tree is taken up again here; the
  // commands, the tools, an open pane and, after a /clear, the tree view's server are still there
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear' || e.source === 'resume') await start($, false)
    const url = server?.url
    if (e.source === 'clear' && url) await update($, webUrl, () => url)

    return next(e)
  })

  // a /clear goes on in the same folder, so the tree view's server, and a browser tab on it, live
  // on; any other end stops it (a resume may go on in another folder)
  on('session.end', async ($, e, next) => {
    poller?.cancel()
    poller = null
    if (e.reason !== 'clear') await stopServer($)

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!rules) return composed

    return { ...composed, sections: [...composed.sections, { id: 'rft:rules', text: rules, scope: 'session' as const }] }
  })

  // ---------------------------------------------------------------- commands

  on('command.run', { command: 'rft' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'stop') return { text: (await stopServer($)) ? 'The tree view server is stopped.' : 'The tree view server was not running.' }
    const s = await refresh($, true)
    if (!s) {
      const was = await read($, snapshot)
      return { text: !was?.isActive && was?.error ? was.error : NOT_ACTIVE }
    }
    if (arg === 'text') {
      const h = await mustHere($)
      const loaded = await loadActive(h.io)
      return { text: treeReport(loaded, { vault: shownVault(h, loaded.config) }) }
    }
    const openList = () => { void $.ui.open({ id: PANE, title: TITLE, focus: true }).catch(() => undefined) }
    if (arg === 'list') {
      openList()
      return { text: 'Outline pane opened.' }
    }
    let url: string
    try {
      url = await startServer($)
    } catch (err) {
      openList()
      return { text: `The outline is in the pane, but the tree view could not start: ${message(err)}.\n/rft-view writes a standalone vault/tree.html instead.` }
    }
    // on the desktop the tree view opens in the app's own browser pane; elsewhere the outline
    // pane opens and the address is printed
    if (await isOnDesktop($)) {
      const shown = await openInBrowser($, url)
      if (shown.isOpened) {
        return {
          text: [
            `Tree view ${shown.isReused ? 'shown again' : 'opened'} in the browser pane: ${url}`,
            shown.isHidden ? 'The browser pane is hidden: press Ctrl+Shift+B (Cmd+Shift+B on macOS) to show it.' : '',
            '/rft list opens the outline pane; /rft stop stops the server.',
          ].filter(Boolean).join('\n'),
        }
      }
      $.ui.log(`rft: could not open the browser pane (${shown.why}); showing the address instead`, { to: 'debug' })
      openList()
      // the link leads the reply: a click opens it (the app asks where); why is in the debug log
      return { text: webHelp(url) }
    }
    openList()
    return { text: webHelp(url) }
  })

  on('command.run', { command: 'rft-init' }, async ($, e) => {
    const cwd = resolvePath(await $.session.cwd(), '.')
    // a folder that already works on a tree, its own, an enclosing one or a linked one, gets no second
    const h = await locateHere($)
    if (h && 'problem' in h) return { text: `${h.problem}. Fix or remove that link: /rft-init does not start a second tree under it.` }
    if (h && h.root !== cwd) {
      return { text: `RFT is already active here: this folder works on the reasoning tree in ${h.root}${h.link ? ` (linked by ${h.link})` : ''}. /rft-init does not start a second tree under it.` }
    }
    const project = cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'project'
    const question = e.args.trim()
    const res = await initVault(rooted(ioOf($), cwd), { project, question, date: today() })
    await activate($, true)
    const context = !res.isAdopted && !question
      ? ['The rft vault was created with a placeholder root note D00. Ask the user for the starting question of the project and write it into the Idea and Why sections of D00.']
      : undefined

    return { text: res.text, context }
  })

  on('command.run', { command: 'rft-concepts' }, async ($, e) => {
    try {
      const loaded = await loadActive((await mustHere($)).io)
      if (e.args.trim() !== 'suggest') return { text: conceptsReport(loaded) }
      // a prompt cannot be submitted from the command's own hook (the turn would wait on it), and a
      // timer started here ends with it: the session's poller submits it at its next tick
      pendingPrompt = SUGGEST_CONCEPTS
      return { text: `${conceptsReport(loaded)}\n\nClaude will propose a concept split in a moment; nothing changes until you confirm it.` }
    } catch (err) {
      return { text: message(err) }
    }
  })

  on('command.run', { command: 'rft-literature' }, async ($, e) => {
    try {
      const loaded = await loadActive((await mustHere($)).io)
      const subject = e.args.trim()
      if (!subject) return { text: 'Usage: /rft-literature <topic, note id or concept>, e.g. /rft-literature D12 or /rft-literature "mixup on small data".' }
      // a note id, or a concept by name: its references go there
      const id = resolveId(loaded.tree, subject)
      const concept = Object.values(loaded.tree.concepts ?? {}).find(c => c.root && c.name.toLowerCase() === subject.toLowerCase())
      const where = id ? loaded.tree.nodes[id]!.name : concept ? `${loaded.tree.nodes[concept.root!]!.name} (the start of the concept "${concept.name}")` : null
      pendingPrompt = literaturePrompt(id ? `${loaded.tree.nodes[id]!.title}` : concept ? concept.name : subject, where)
      return { text: `Claude will search the literature on ${where ?? JSON.stringify(subject)} in a moment and add what it reads as reference notes; directions and experiments only after you choose.` }
    } catch (err) {
      return { text: message(err) }
    }
  })

  on('command.run', { command: 'rft-rebalance' }, async ($, e) => {
    try {
      const loaded = await loadActive((await mustHere($)).io)
      if (Object.keys(loaded.tree.nodes).length < 3) return { text: 'The tree has too few notes to rebalance.' }
      // --full: Claude reads the map of the whole tree; otherwise it judges the plugin's candidates
      const full = /(^|\s)--full(\s|$)/.test(e.args)
      const scope = e.args.replace(/(^|\s)--full(?=\s|$)/, ' ').trim()
      if (full) pendingPrompt = rebalancePrompt(scope)
      else {
        const list = candidates(loaded, { scope: scope || undefined })
        if (!list.length) return { text: `${conceptsReport(loaded)}\n\nNo note sits clearly closer to another concept than to its own${scope ? ` in ${scope}` : ''}: nothing to propose. /rft-rebalance --full asks Claude to look at the whole tree anyway.` }
        pendingPrompt = candidatesPrompt(scope, candidatesReport(loaded, list))
      }
      // submitted by the poller, as for /rft-concepts suggest
      return { text: `${conceptsReport(loaded)}\n\nClaude will propose moves in a moment, as a table${full ? '' : ', from the candidates the plugin found'}; nothing moves until you confirm.` }
    } catch (err) {
      return { text: message(err) }
    }
  })

  on('command.run', { command: 'rft-next' }, async ($, e) => {
    try {
      const io = (await mustHere($)).io
      return { text: await nextReport(io, await loadActive(io), today(), e.args.trim() || undefined) }
    } catch (err) {
      return { text: message(err) }
    }
  })

  on('command.run', { command: 'rft-summarize' }, async ($, e) => {
    try {
      const io = (await mustHere($)).io
      const loaded = await loadActive(io)
      const scope = e.args.trim()
      const c = scope ? resolveConcept(loaded.tree, scope) : null
      if (scope && !c) return { text: `"${scope}" is not a concept: /rft-concepts lists them.` }
      const gaps = await mapGaps(io, loaded, c ?? undefined)
      if (!gaps.notes && !gaps.digests.length) return { text: `The map${c ? ` of "${c.name}"` : ''} is complete: every note has a summary and every concept a current digest.` }
      pendingPrompt = summarizePrompt(c ? c.name : '')
      return {
        text: `To write${c ? ` in "${c.name}"` : ''}: ${gaps.notes} note summar${gaps.notes === 1 ? 'y' : 'ies'} and ${gaps.digests.length} digest(s)${gaps.digests.length ? ` (${gaps.digests.slice(0, 8).join(', ')}${gaps.digests.length > 8 ? ', …' : ''})` : ''}. ` +
          'Claude will start in a moment, concept by concept. It reads every note without a summary once, so on a large tree this is a long, one-off job; /rft-summarize <concept> does one line of research at a time.',
      }
    } catch (err) {
      return { text: message(err) }
    }
  })

  on('command.run', { command: 'rft-view' }, async $ => {
    try {
      const h = await mustHere($)
      const io = h.io
      const loaded = await loadActive(io)
      const root = $.plugin.root
      const assets = {
        html: await $.fs.read(join(root, ASSET_PATHS.html)),
        css: await $.fs.read(join(root, ASSET_PATHS.css)),
        js: await $.fs.read(join(root, ASSET_PATHS.js)),
        d3: await $.fs.read(join(root, ASSET_PATHS.d3)),
        katex: await $.fs.read(join(root, ASSET_PATHS.katex)),
        katexCss: await $.fs.read(join(root, ASSET_PATHS.katexCss)),
        filters: await $.fs.read(join(root, ASSET_PATHS.filters)),
        layout: await $.fs.read(join(root, ASSET_PATHS.layout)),
        concepts: await $.fs.read(join(root, ASSET_PATHS.concepts)),
        theme: await $.fs.read(join(root, ASSET_PATHS.theme)),
      }
      const path = await exportHtml(io, loaded, assets)

      return { text: `Wrote ${path} (${Object.keys(loaded.tree.nodes).length} notes): open file://${isAbsolute(path) ? path : join(h.root, path)} in a browser.` }
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---------------------------------------------------------------- tools

  // the rft tools are answered here; after any other tool that may have touched the vault the
  // snapshot is re-read when the notes changed, which redraws the pane
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool.startsWith('mcp__rft__')) {
      if (recall && /^mcp__rft__rft_(search|map|graph)$/.test(tool)) recall.used = true
      try {
        const out = await runTool($, tool.slice('mcp__rft__'.length), e as unknown as Record<string, unknown>)
        await refresh($, true)
        return answer(out)
      } catch (err) {
        return answer(err instanceof Error ? err.message : String(err), true)
      }
    }
    const ran = await next(e)
    if (rules && !READ_ONLY.test(tool)) await poll($)
    // a search of the notes before the tree's own search: point to it, until it is used
    if (recall && !recall.used && !ran.deny && !ran.isError && searchesVault(tool, e as unknown as Record<string, unknown>, recall.vault, recall.cwd)) {
      return { ...ran, context: [...(ran.context ?? []), RECALL_HINT] }
    }
    return ran
  }).catch(($, e, next) =>
    next.called ? next(e) : String(e.tool).startsWith('mcp__rft__') ? answer('rft: the tool failed', true) : next(e))

  // ---------------------------------------------------------------- the pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = ui
    const s = await read($, snapshot)
    if (!s || !s.isActive) {
      return (
        <Box flexDirection="column">
          <Text bold>Reasoning Flow Tree</Text>
          {s?.error ? <Text color="error">{s.error}</Text> : <Text dimColor>{NOT_ACTIVE}</Text>}
        </Box>
      )
    }
    const tree = treeOf(s)
    const folded = new Set(await read($, collapsed))
    const sel = await read($, selected)
    const view = await read($, note)
    const url = await read($, webUrl)
    const cols = Math.max(24, e.props.bodyColumns || e.viewport?.columns || 60)
    const c = counts(tree)

    const rows: JSX.Element[] = []
    const visit = (id: string, depth: number) => {
      const n = tree.nodes[id]
      if (!n) return
      const isFolded = folded.has(id)
      const indent = '  '.repeat(depth)
      const room = Math.max(6, cols - indent.length - n.id.length - 8)
      const title = n.title.length > room ? n.title.slice(0, room - 1) + '…' : n.title
      rows.push(
        <Box key={`row-${id}`} flexDirection="row">
          <Text>{indent}</Text>
          {n.children.length
            ? <Button key={`fold-${id}`} plain onPress={() => toggleFold($, id)}>{isFolded ? '▸' : '▾'}</Button>
            : <Text dimColor>·</Text>}
          <Text color={STATUS_COLOR[n.status] ?? 'inactive'}>{` ${MARK[n.status] ?? '-'} `}</Text>
          <Button key={`node-${id}`} label={`${n.id} ${title}${isFolded ? ` +${n.children.length}` : ''}`} plain onPress={() => selectNode($, id)} />
          {sel === id ? <Text color="claude">{' ◀'}</Text> : null}
        </Box>,
      )
      if (!isFolded) for (const k of n.children) visit(k, depth + 1)
    }
    for (const r of tree.roots) visit(r, 0)

    let detail: JSX.Element | null = null
    const shown = view ? tree.nodes[view.id] : undefined
    if (view && shown) {
      const parent = shown.parent ? tree.nodes[shown.parent] : undefined
      detail = (
        <Box key="detail" flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Text bold>{shown.name}</Text>
            <Text color={STATUS_COLOR[shown.status] ?? 'inactive'}>{`${MARK[shown.status] ?? ''} ${shown.status}`}</Text>
          </Box>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="close-note" label="Close" onPress={() => selectNode($, shown.id)} />
            {parent ? <Button key={`up-${parent.id}`} label={`↑ ${parent.id}`} onPress={() => selectNode($, parent.id)} /> : null}
            {shown.children.map(k => <Button key={`down-${k}`} label={`↓ ${k}`} onPress={() => selectNode($, k)} />)}
          </Box>
          <Markdown key="note-text" text={paneMarkdown(bodyOf(view.text))} />
        </Box>
      )
    }

    // the pane is the outline; the interactive tree is the web view /rft serves
    const foldable = Object.values(tree.nodes).filter(n => n.children.length && n.parent).map(n => n.id)

    return (
      <Box flexDirection="column">
        <Text bold>{`${s.project}: ${countsLine(c)}`}</Text>
        {url
          ? <Text color="claude">{`Tree view: ${url}`}</Text>
          : <Text dimColor>Run /rft for the interactive tree view in a browser.</Text>}
        {s.error ? <Text color="error">{s.error}</Text> : null}
        {s.problems.length ? <Text color="warning">{`${s.problems.length} problem(s), e.g. ${s.problems[0]}`}</Text> : null}
        <Text dimColor>{LEGEND}</Text>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="fold-all" label="Fold all" onPress={() => foldAll($, foldable)} />
          <Button key="unfold-all" label="Unfold all" onPress={() => foldAll($, [])} />
        </Box>
        {detail}
        <Box key="outline" flexDirection="column" marginTop={1}>{rows}</Box>
      </Box>
    )
  })
}

const READ_ONLY = /^(Read|Grep|Glob|LS|WebFetch|WebSearch|ToolSearch|TodoWrite)$/

const STATUS_COLOR: Record<string, 'success' | 'warning' | 'suggestion' | 'error' | 'inactive' | 'ide'> = {
  done: 'success', running: 'warning', planned: 'suggestion', idea: 'suggestion',
  dropped: 'error', discussed: 'inactive', moved: 'ide',
}

/** Obsidian links as bold text, embeds as a mention: the pane's Markdown has no vault to link into. */
const paneMarkdown = (body: string) =>
  body
    .replace(/!\[\[([^\]]+)\]\]/g, '_(embedded: $1)_')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?\|([^\]]+)\]\]/g, '**$2**')
    .replace(/\[\[([^\]|#]+)(?:#[^\]]*)?\]\]/g, '**$1**')
