// rft: the Reasoning Flow Tree plugin. Commands (/rft, /rft-init, /rft-view), the model's
// tools (rft_add_node, rft_set_status, rft_set_tags, rft_tags, rft_tree, rft_validate, rft_sync), the operating rules
// injected into the system prompt, the outline pane, and the web view: /rft starts a local
// server (server/rft_server.py) for the interactive tree page (web/), and makes the notes that
// page adds (addFromView). Everything is
// inert without `.rft/config.json` in the session's folder or a folder above it; that config
// may be a link (`{"tree": "../notes"}`) to a tree kept elsewhere.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RftSnapshot } from '../types'
import { addNode, conceptsReport, exportHtml, initVault, loadActive, rulesText, setConcept, setStatus, setTags, tagsReport, today, treeReport } from './lib/ops'
import { ASSET_PATHS } from './lib/page'
import type { Config, Io, NodeType, Tree } from './lib/vault'
import { LEGEND, MARK, NODE_TYPES, bodyOf, counts, countsLine, isAbsolute, join, locate, readConfig, resolvePath, rooted, signatureOf, sync, validate } from './lib/vault'

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
      'Add a node to the reasoning tree: an experiment (something run or computed), a direction (an idea, question or hypothesis, rejected ones included), a reference (a paper, method or literature review that was read, summarised and commented, with a source that can be checked) or a theory note (a definition, method, taxonomy or argument of the project\'s own, built on the other notes). Assigns the next free id, sanitises the title, writes the note from the template, links it under its parent and regenerates the index and canvas. Create an experiment BEFORE launching it (status planned or running).',
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
      },
      required: ['type', 'title'],
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
      },
      required: ['id', 'status'],
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
  rft_set_concept: {
    description:
      'Make a note the start of a concept (a line of research: the note and its subtree, until a sub-concept starts), rename it, or remove it with name null. Only after the user has confirmed the concept: propose first, never apply silently.',
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
  try {
    s = await refresh($, true)
    h = await mustHere($)
    config = await readConfig(h.io)
  } catch (err) {
    failed.push(`reading the vault (${message(err)})`)
  }
  if (s && config && h) rules = rulesText(treeOf(s), config, shownVault(h, config))
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
        status: str(i.status), date: today(), sections, code: str(i.code), tags: strings(i.tags),
      })
      return `${node.report}\nId: ${node.id}\nNote: ${join(shownVault(h, loaded.config), node.path)}`
    }
    case 'rft_set_tags':
      return setTags(io, loaded, String(i.id ?? ''), strings(i.tags))
    case 'rft_set_concept':
      return setConcept(io, loaded, String(i.id ?? ''), typeof i.name === 'string' ? i.name : null, typeof i.summary === 'string' ? i.summary : undefined)
    case 'rft_concepts':
      return conceptsReport(loaded)
    case 'rft_tags':
      return tagsReport(loaded)
    case 'rft_set_status':
      return setStatus(io, loaded, String(i.id ?? ''), String(i.status ?? ''), str(i.note))
    case 'rft_tree':
      return treeReport(loaded, { root: str(i.root), depth: typeof i.depth === 'number' ? i.depth : undefined, vault: shownVault(h, loaded.config) })
    case 'rft_validate': {
      const v = await validate(io, loaded)
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

// the running server, one per session; a reload of the module kills the child with it
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
            else if (l.startsWith(ADD_NODE)) void addFromView($, l.slice(ADD_NODE.length))
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

const ADD_NODE = 'RFT_ADD_NODE '

/**
 * A note the tree view adds (POST api/node, relayed by the server): made by rft_add_node's code
 * with the type, parent and title alone, so its status is the default, and no model turn is spent.
 */
async function addFromView($: EngineInterface, request: string): Promise<void> {
  try {
    const r = JSON.parse(request) as Record<string, unknown>
    await runTool($, 'rft_add_node', { type: r.type, parent: r.parent, title: r.title })
    await refresh($, true)
  } catch (err) {
    $.ui.toast(`rft: the tree view could not add a note (${message(err)})`)
  }
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

const SUGGEST_CONCEPTS = `Propose a split of the reasoning tree into concepts (rft-manual skill, "Concepts"). Read the current tree with rft_tree and rft_concepts. Suggest 2 to 6 concepts, nested at most two levels: for each, the note that starts it (usually the direction that opened that line of research), a short readable name for the line of research, in words as in a heading (e.g. "Strong augmentation", not a tag like strong-augmentation; never a single experiment), and a one-line summary; say which notes stay in the project root and why. Present the proposal as a short table and ask me to confirm or change it. Do not call rft_set_concept until I say yes.`

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
  // commands, the tools and an open pane are still there
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear' || e.source === 'resume') await start($, false)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    poller?.cancel()
    poller = null
    await stopServer($)

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
        filters: await $.fs.read(join(root, ASSET_PATHS.filters)),
        layout: await $.fs.read(join(root, ASSET_PATHS.layout)),
        concepts: await $.fs.read(join(root, ASSET_PATHS.concepts)),
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
