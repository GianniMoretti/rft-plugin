// rft: the Reasoning Flow Tree plugin. Commands (/rft, /rft-init, /rft-view), the model's
// tools (rft_add_node, rft_set_status, rft_tree, rft_validate, rft_sync), the operating rules
// injected into the system prompt, and the live tree pane. Everything is inert in a project
// without `.rft/config.json`.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RftSnapshot } from '../types'
import { addNode, exportHtml, initVault, loadActive, rulesText, setStatus, today, treeReport } from './lib/ops'
import { treeSvg } from './lib/svg'
import type { Config, Io, NodeType, Tree } from './lib/vault'
import { LEGEND, MARK, bodyOf, counts, join, readConfig, signatureOf, sync, validate } from './lib/vault'

const PANE = 'rft-tree'
const TITLE = 'Reasoning tree'
const POLL_MS = 4000

const snapshot = atom({ plugin: 'rft', key: 'snapshot' } as const, null)
const collapsed = atom({ plugin: 'rft', key: 'collapsed' } as const, [])
const selected = atom({ plugin: 'rft', key: 'selected' } as const, null)
const note = atom({ plugin: 'rft', key: 'note' } as const, null)
const orientation = atom({ plugin: 'rft', key: 'orientation' } as const, 'TD')
const zoom = atom({ plugin: 'rft', key: 'zoom' } as const, 'fit')

const ioOf = ($: EngineInterface): Io => ({
  read: path => $.fs.read(path),
  write: (path, text) => $.fs.write(path, text),
  list: path => $.fs.list(path),
  exists: path => $.fs.exists(path),
})

const treeOf = (s: RftSnapshot): Tree => ({ nodes: s.nodes, roots: s.roots })

const TOOLS = {
  rft_add_node: {
    description:
      'Add a node to the reasoning tree: an experiment (something run or computed) or a direction (an idea, question or hypothesis, rejected ones included). Assigns the next free id, sanitises the title, writes the note from the template, links it under its parent and regenerates the index and canvas. Create an experiment BEFORE launching it (status planned or running).',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['experiment', 'direction'] },
        title: { type: 'string', description: 'Short title, no id (the id is assigned). Avoid ^ # | [ ].' },
        parent: { type: 'string', description: 'Id (e.g. D03) or full name of the parent note; omit only for the root D00 of an empty tree.' },
        status: { type: 'string', enum: ['planned', 'running', 'done', 'idea', 'dropped', 'discussed', 'moved'], description: 'Default: planned for experiments, idea for directions.' },
        what: { type: 'string', description: 'Experiment: what is run or computed (model, data, arms, seeds, where).' },
        why: { type: 'string', description: 'Why: which direction it tests and what is expected, or where the idea comes from.' },
        idea: { type: 'string', description: 'Direction: the idea or question in a few sentences.' },
        result: { type: 'string', description: 'Experiment: real results only (numbers with spread, failures, caveats).' },
        code: { type: 'string', description: 'Experiment: commit, script, results folder, machine.' },
        sections: { type: 'object', additionalProperties: { type: 'string' }, description: 'Other sections by heading, e.g. {"Status": "..."}.' },
      },
      required: ['type', 'title'],
    },
  },
  rft_set_status: {
    description:
      'Change the status of a node (frontmatter, tag and the Status line) and optionally append a note: for an experiment to its Result section, for a direction to its Status section (say why it was dropped or where it was moved). Regenerates the index and canvas.',
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
const registeredTools = new Set<string>()

const EMPTY: RftSnapshot = { isActive: false, vault: '', project: '', nodes: {}, roots: [], signature: '', problems: [], error: null }

/** Re-reads the vault into the snapshot when its notes changed (or always, with `force`). */
async function refresh($: EngineInterface, force = false): Promise<RftSnapshot | null> {
  const io = ioOf($)
  const config = await readConfig(io)
  const prev = await read($, snapshot)
  if (!config) {
    if (prev?.isActive !== false) await update($, snapshot, () => EMPTY)
    return null
  }
  if (!force && prev?.isActive && !prev.error && prev.signature === (await signatureOf(io, config.vault))) return prev
  try {
    const loaded = await loadActive(io)
    const next: RftSnapshot = {
      isActive: true, vault: config.vault, project: config.project, nodes: loaded.tree.nodes,
      roots: loaded.tree.roots, signature: loaded.signature, problems: loaded.problems, error: null,
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
    await update($, snapshot, s => ({ ...(s ?? EMPTY), isActive: true, vault: config.vault, project: config.project, error: message }))
    return null
  }
}

/** In a project with `.rft/config.json`: the snapshot, the rules, the tools, the poll, the pane. */
async function activate($: EngineInterface, shouldOpen: boolean): Promise<void> {
  const failed: string[] = []
  let s: RftSnapshot | null = null
  let config: Config | null = null
  try {
    s = await refresh($, true)
    config = await readConfig(ioOf($))
  } catch (err) {
    failed.push(`reading the vault (${message(err)})`)
  }
  if (s && config) rules = rulesText(treeOf(s), config)
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
  await attempt('rft', () => $.command.register({ name: 'rft', description: 'Show the reasoning tree pane (/rft text prints it inline)', argumentHint: '[text]' }))
  await attempt('rft-init', () => $.command.register({ name: 'rft-init', description: 'Activate the Reasoning Flow Tree in this project and create its vault', argumentHint: '[starting question]' }))
  await attempt('rft-view', () => $.command.register({ name: 'rft-view', description: 'Write a standalone HTML view of the tree to <vault>/tree.html' }))
  if (failed.length) reportFailures($, failed)
}

async function poll($: EngineInterface): Promise<void> {
  try { await refresh($) } catch { /* tried again at the next tick */ }
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)

const answer = (text: string, isError = false) =>
  isError ? { isError: true as const, result: text, text } : { result: text, text }

/** Runs one of the rft tools; its text is the tool's result. */
async function runTool($: EngineInterface, name: string, i: Record<string, unknown>): Promise<string> {
  const io = ioOf($)
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
        status: str(i.status), date: today(), sections, code: str(i.code),
      })
      return `${node.report}\nId: ${node.id}\nNote: ${join(loaded.config.vault, node.path)}`
    }
    case 'rft_set_status':
      return setStatus(io, loaded, String(i.id ?? ''), String(i.status ?? ''), str(i.note))
    case 'rft_tree':
      return treeReport(loaded, { root: str(i.root), depth: typeof i.depth === 'number' ? i.depth : undefined })
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

async function flipOrientation($: EngineInterface): Promise<void> {
  await update($, orientation, o => (o === 'TD' ? 'LR' : 'TD'))
}

async function flipZoom($: EngineInterface): Promise<void> {
  await update($, zoom, v => (v === 'fit' ? 'full' : 'fit'))
}

// The commands' names must not be a skill's: the plugin's skill is `rft-manual` (`/rft:rft-manual`).

const NOT_ACTIVE = 'RFT is not active in this project. Run /rft-init [starting question] to set it up.'

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await registerCommands($)
    let isActive = false
    try { isActive = (await readConfig(ioOf($))) !== null } catch { /* treated as inactive */ }
    if (isActive) await activate($, options.autoOpen !== false)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    poller?.cancel()
    poller = null

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!rules) return composed

    return { ...composed, sections: [...composed.sections, { id: 'rft:rules', text: rules, scope: 'session' as const }] }
  })

  // ---------------------------------------------------------------- commands

  on('command.run', { command: 'rft' }, async ($, e) => {
    const s = await refresh($, true)
    if (!s) return { text: NOT_ACTIVE }
    const text = treeReport(await loadActive(ioOf($)))
    if (e.args.trim() === 'text') return { text }
    const placed = await $.ui.open({ id: PANE, title: TITLE, focus: true })

    return { text: placed.isPlaced ? 'Reasoning tree pane opened.' : text }
  })

  on('command.run', { command: 'rft-init' }, async ($, e) => {
    const cwd = await $.session.cwd()
    const project = cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'project'
    const question = e.args.trim()
    const res = await initVault(ioOf($), { project, question, date: today() })
    await activate($, true)
    const context = !res.isAdopted && !question
      ? ['The rft vault was created with a placeholder root note D00. Ask the user for the starting question of the project and write it into the Idea and Why sections of D00.']
      : undefined

    return { text: res.text, context }
  })

  on('command.run', { command: 'rft-view' }, async $ => {
    try {
      const io = ioOf($)
      const loaded = await loadActive(io)
      const path = await exportHtml(io, loaded, today())
      const cwd = await $.session.cwd()

      return { text: `Wrote ${path} (${Object.keys(loaded.tree.nodes).length} notes): open file://${join(cwd, path)} in a browser.` }
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
          <Text dimColor>{NOT_ACTIVE}</Text>
        </Box>
      )
    }
    const tree = treeOf(s)
    const folded = new Set(await read($, collapsed))
    const sel = await read($, selected)
    const view = await read($, note)
    const orient = await read($, orientation)
    const z = await read($, zoom)
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

    let picture: JSX.Element | null = null
    if ('Svg' in ui) {
      const { Svg } = ui
      const { svg, layout } = treeSvg(tree, { collapsed: folded, orientation: orient, selected: sel })
      const size = z === 'full' ? { width: layout.width, height: layout.height } : {}
      picture = svg.length < 130000
        ? <Svg source={svg} alt={`The reasoning tree: ${c.direction ?? 0} directions, ${c.experiment ?? 0} experiments`} isInteractive {...size} />
        : <Text dimColor>The tree is too large to draw: fold some branches.</Text>
    }
    const foldable = Object.values(tree.nodes).filter(n => n.children.length && n.parent).map(n => n.id)

    return (
      <Box flexDirection="column">
        <Text bold>{`${s.project}: ${c.direction ?? 0} directions, ${c.experiment ?? 0} experiments`}</Text>
        <Text dimColor>{LEGEND}</Text>
        {s.error ? <Text color="error">{s.error}</Text> : null}
        {s.problems.length ? <Text color="warning">{`${s.problems.length} problem(s), e.g. ${s.problems[0]}`}</Text> : null}
        <Box flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
          {picture ? <Button key="orient" label={orient === 'TD' ? 'Left-right' : 'Top-down'} onPress={() => flipOrientation($)} /> : null}
          {picture ? <Button key="zoom" label={z === 'fit' ? 'Actual size' : 'Fit'} onPress={() => flipZoom($)} /> : null}
          <Button key="fold-all" label="Fold all" onPress={() => foldAll($, foldable)} />
          <Button key="unfold-all" label="Unfold all" onPress={() => foldAll($, [])} />
        </Box>
        {picture}
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
