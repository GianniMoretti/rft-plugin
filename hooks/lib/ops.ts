// The operations behind the commands and tools: set up a vault, add a node, change a status,
// export the HTML view, and the operating rules injected into a session. Each takes an `Io`
// and returns plain text for the model or the person.

import { treeHtml } from './html'
import type { Config, Io, Loaded, NodeType, RftNode, Tree } from './vault'
import {
  CONFIG_PATH, DIRECTION_TEMPLATE, EXPERIMENT_TEMPLATE, INDEX, LEGEND, MERMAID, STATUSES, SUBDIR,
  compactTree, counts, defaultConfig, front, indexTemplate, join, load, nextId, noteText, readConfig,
  resolveId, sanitiseTitle, sync, validate, withChildListed, withStatus, writeConfig,
} from './vault'

export const today = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

export class RftError extends Error {}

export async function loadActive(io: Io): Promise<Loaded> {
  const config = await readConfig(io)
  if (!config) throw new RftError(`RFT is not active in this project (no ${CONFIG_PATH}). Run /rft-init first.`)
  return load(io, config)
}

// ---------------------------------------------------------------- init

export type InitResult = { text: string; isAdopted: boolean; config: Config }

/**
 * Activates RFT: writes `.rft/config.json` and, unless the vault folder already holds notes
 * (which are adopted as they are), the skeleton: templates, `00 Index.md` and the D00 root.
 */
export async function initVault(io: Io, opts: { project: string; question: string; vault?: string; date: string }): Promise<InitResult> {
  if (await io.exists(CONFIG_PATH)) {
    const config = (await readConfig(io))!
    return { text: `RFT is already active here (vault: ${config.vault}/).`, isAdopted: true, config }
  }
  const config = defaultConfig(opts.project)
  if (opts.vault) config.vault = opts.vault
  const v = config.vault
  let hasNotes = false
  for (const sub of Object.values(SUBDIR)) {
    const dir = join(v, sub)
    if ((await io.exists(dir)) && (await io.list(dir)).some(f => f.name.endsWith('.md'))) hasNotes = true
  }
  const written: string[] = []
  const ensure = async (rel: string, text: string) => {
    if (await io.exists(join(v, rel))) return
    await io.write(join(v, rel), text)
    written.push(rel)
  }
  await ensure('templates/_experiment.md', EXPERIMENT_TEMPLATE(opts.project))
  await ensure('templates/_direction.md', DIRECTION_TEMPLATE(opts.project))
  if (hasNotes) {
    config.mermaid = await io.exists(join(v, MERMAID))
    const loaded = await load(io, config)
    // the project's name as the notes already spell it: the most common first tag
    const tally = new Map<string, number>()
    for (const text of Object.values(loaded.texts)) {
      const first = front(text).tags?.replace(/^\[/, '').split(',')[0]?.trim()
      if (first && !['experiment', 'direction'].includes(first)) tally.set(first, (tally.get(first) ?? 0) + 1)
    }
    const common = [...tally].sort((a, b) => b[1] - a[1])[0]
    if (common) config.project = common[0]
    for (const id of Object.keys(loaded.tree.nodes)) {
      const m = /^([ED])(\d+)$/.exec(id)
      if (m) config.lastId[m[1] as 'E' | 'D'] = Math.max(config.lastId[m[1] as 'E' | 'D'], Number(m[2]))
    }
    await writeConfig(io, config)
    const c = counts(loaded.tree)
    const check = await validate(io, loaded)
    return {
      isAdopted: true,
      config,
      text:
        `RFT is now active. Adopted the existing vault ${v}/ (${c.direction} directions, ${c.experiment} experiments)` +
        (written.length ? `; added ${written.join(', ')}` : '') +
        `. Validation: ${check.errors.length} errors, ${check.warnings.length} warnings` +
        (check.errors.length + check.warnings.length ? ' (ask Claude to run rft_validate, then rft_sync).' : '.'),
    }
  }
  for (const sub of Object.values(SUBDIR)) await ensure(`${sub}/.gitkeep`, '')
  await ensure(INDEX, indexTemplate(opts.project))
  await writeConfig(io, config)
  const loaded = await load(io, config)
  const root = await addNode(io, loaded, {
    type: 'direction', title: opts.question || `${opts.project}, the starting question`, parent: null,
    status: 'idea', date: opts.date,
    sections: { Idea: opts.question || 'The starting question of the project: to be written.' },
  })
  return {
    isAdopted: false,
    config: loaded.config,
    text: `RFT is now active. Created ${v}/ with ${root.name} as the root, the templates and ${INDEX}.`,
  }
}

// ---------------------------------------------------------------- add / status

export type AddInput = {
  type: NodeType
  title: string
  parent: string | null
  status?: string
  date: string
  sections?: Record<string, string>
  code?: string
}

export async function addNode(io: Io, loaded: Loaded, input: AddInput): Promise<RftNode & { report: string }> {
  const { tree, config } = loaded
  if (input.type !== 'experiment' && input.type !== 'direction') throw new RftError('type must be "experiment" or "direction"')
  const title = sanitiseTitle(input.title ?? '')
  if (!title) throw new RftError('the title is empty once the characters that break links are removed')
  const status = input.status ?? (input.type === 'experiment' ? 'planned' : 'idea')
  if (!(STATUSES as readonly string[]).includes(status)) throw new RftError(`status must be one of ${STATUSES.join(', ')}`)
  const isEmpty = Object.keys(tree.nodes).length === 0
  let parent: string | null = null
  if (input.parent) {
    parent = resolveId(tree, input.parent)
    if (!parent) throw new RftError(`parent "${input.parent}" is not a note of the tree (give its id, e.g. D03)`)
  } else if (!isEmpty) {
    throw new RftError('parent is required: every note but the root D00 comes from a parent note')
  } else if (input.type !== 'direction') {
    throw new RftError('the root of the tree must be a direction (D00, the starting question)')
  }
  const id = nextId(loaded, input.type)
  const name = `${id} ${title}`
  const path = `${SUBDIR[input.type]}/${name}.md`
  const parentName = parent ? tree.nodes[parent]!.name : null
  const text = noteText(id, { ...input, title, status }, config.project, parentName)
  await io.write(join(config.vault, path), text)
  const prefix = id[0] as 'E' | 'D'
  config.lastId[prefix] = Math.max(config.lastId[prefix], Number(id.slice(1)))
  await writeConfig(io, config)
  if (parent) {
    const p = tree.nodes[parent]!
    const prev = loaded.texts[parent]!
    const next = withChildListed(prev, name)
    if (next !== prev) await io.write(join(config.vault, p.path), next)
  }
  const fresh = await load(io, config)
  const report = await sync(io, fresh)
  Object.assign(loaded, fresh)
  const node = fresh.tree.nodes[id]!
  return {
    ...node,
    report: `Created ${path}${parent ? ` under ${parentName}` : ' as the root'} (status ${status}). Updated ${report.changed.length} derived file(s).`,
  }
}

export async function setStatus(io: Io, loaded: Loaded, ref: string, status: string, note?: string): Promise<string> {
  const id = resolveId(loaded.tree, ref)
  if (!id) throw new RftError(`"${ref}" is not a note of the tree`)
  if (!(STATUSES as readonly string[]).includes(status)) throw new RftError(`status must be one of ${STATUSES.join(', ')}`)
  const n = loaded.tree.nodes[id]!
  const prev = loaded.texts[id]!
  await io.write(join(loaded.config.vault, n.path), withStatus(prev, n, status, note))
  const fresh = await load(io, loaded.config)
  const report = await sync(io, fresh)
  Object.assign(loaded, fresh)
  return `${n.name}: ${n.status} → ${status}${note ? ' (note added)' : ''}. Updated ${report.changed.length} derived file(s).`
}

// ---------------------------------------------------------------- text for the model

export function treeReport(loaded: Loaded, opts: { root?: string; depth?: number } = {}): string {
  const { tree, config } = loaded
  const c = counts(tree)
  const root = opts.root ? resolveId(tree, opts.root) : undefined
  if (opts.root && !root) throw new RftError(`"${opts.root}" is not a note of the tree`)
  const body = compactTree(tree, { root: root ?? undefined, depth: opts.depth, withStatus: false })
  return [
    `${config.project}: ${c.direction} directions, ${c.experiment} experiments in ${config.vault}/. Marks: ${LEGEND}.`,
    body || '(empty tree)',
  ].join('\n')
}

const MAX_LINES = 160

export function rulesText(tree: Tree, config: Config): string {
  let lines = compactTree(tree).split('\n')
  if (lines.length > MAX_LINES) lines = [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more (rft_tree shows them)`]
  return `# Reasoning Flow Tree (rft) is active in this project

The reasoning of this research project is kept as a tree of Obsidian notes in \`${config.vault}/\`: one note per experiment (E.., something run or computed) and per direction (D.., an idea, question or hypothesis, rejected ones included), each with exactly one parent; D00 is the starting question. The notes are the source of truth. Keep the tree up to date as you work, with the rft tools:

- Before launching an experiment (a training run, a grid, a numerical check, a measurement, a proof, a literature check), create its node first: rft_add_node with type experiment, parent = the direction it tests, status planned or running, and What / Why filled.
- When it finishes or gives a partial result, write the real numbers in its note (Result, with spread over seeds and what failed; Directions found; Code / data: commit, script, results folder, machine), then rft_set_status. Record only results that were actually obtained, never expected or invented ones.
- Every new idea or question, from a result, the user or a discussion, even if rejected: rft_add_node with type direction, parent = the note it comes from. Rejected ideas get status discussed; abandoned ones dropped; moved ones moved, with the reason (rft_set_status note).
- Statuses: ${STATUSES.join(', ')}. Marks: ${LEGEND}.
- The tools assign ids (never reused) and strip ^ # | [ ] from titles. After editing notes by hand, run rft_sync (children / up / down, 00 Index.md, the canvas) and rft_validate.
- The rft-manual skill is the full manual; rft_tree shows the current tree.

The tree at the start of this session:
${lines.join('\n')}`
}

// ---------------------------------------------------------------- export

export async function exportHtml(io: Io, loaded: Loaded, generated: string): Promise<string> {
  const path = join(loaded.config.vault, 'tree.html')
  await io.write(path, treeHtml(loaded.tree, loaded.texts, loaded.config.project, generated))
  return path
}
