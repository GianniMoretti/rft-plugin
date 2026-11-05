// The operations behind the commands and tools: set up a vault, add a node, change a status,
// export the HTML view, and the operating rules injected into a session. Each takes an `Io`
// and returns plain text for the model or the person.

import type { PageAssets } from './page'
import { staticPage } from './page'
import type { Config, Io, Loaded, NodeType, RftNode, Tree } from './vault'
import {
  CONFIG_PATH, ID_RE, INDEX, LEGEND, MERMAID, NODE_TYPES, STATUSES, SUBDIR, TEMPLATES, TYPES,
  MARK, ROOT_CONCEPT, compactTree, conceptOrder, conceptPath, counts, countsLine, defaultConfig, front, idOf, indexTemplate,
  isNodeType, join, load, nextId, noteText, orList, readConfig, removeField, resolveId, sanitiseTitle, setField, statusSummary,
  subtreeOf, sync, tagCounts, validate, withChildListed, withChildUnlisted, withMove, withRefs, withStatus, withTopicalTags, writeConfig,
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
  // a new tree asks for references from the start; an adopted one opts in later
  config.requireRefs = true
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
  for (const t of NODE_TYPES) await ensure(`templates/_${t}.md`, TEMPLATES[t](opts.project))
  if (hasNotes) {
    delete config.requireRefs
    config.mermaid = await io.exists(join(v, MERMAID))
    const loaded = await load(io, config)
    // the project's name as the notes already spell it: the most common first tag
    const tally = new Map<string, number>()
    for (const text of Object.values(loaded.texts)) {
      const first = front(text).tags?.replace(/^\[/, '').split(',')[0]?.trim()
      if (first && !isNodeType(first)) tally.set(first, (tally.get(first) ?? 0) + 1)
    }
    const common = [...tally].sort((a, b) => b[1] - a[1])[0]
    if (common) config.project = common[0]
    for (const id of Object.keys(loaded.tree.nodes)) {
      const m = ID_RE.exec(id)
      if (m) config.lastId[m[1]!] = Math.max(config.lastId[m[1]!] ?? 0, Number(m[2]))
    }
    await writeConfig(io, config)
    const c = counts(loaded.tree)
    const check = await validate(io, loaded)
    return {
      isAdopted: true,
      config,
      text:
        `RFT is now active. Adopted the existing vault ${v}/ (${countsLine(c)})` +
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
  tags?: string[]
  /** Ids or names of the notes it builds on (references). */
  refs?: string[]
}

/** Note names for references given by id or name; unknown ones refused. */
function refNames(tree: Tree, refs: string[]): string[] {
  const out: string[] = []
  for (const r of refs) {
    const id = resolveId(tree, r)
    if (!id) throw new RftError(`reference "${r}" is not a note of the tree (add it first with rft_add_node, type reference)`)
    if (!out.includes(tree.nodes[id]!.name)) out.push(tree.nodes[id]!.name)
  }
  return out
}

export async function addNode(io: Io, loaded: Loaded, input: AddInput): Promise<RftNode & { report: string }> {
  const { tree, config } = loaded
  if (!isNodeType(input.type)) throw new RftError(`type must be ${orList(NODE_TYPES.map(t => `"${t}"`))}`)
  const title = sanitiseTitle(input.title ?? '')
  if (!title) throw new RftError('the title is empty once the characters that break links are removed')
  const status = input.status ?? TYPES[input.type].status
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
  // another session on the same tree may have added notes since `loaded` was read
  const onDisk = await readConfig(io)
  if (onDisk) for (const [p, last] of Object.entries(onDisk.lastId)) config.lastId[p] = Math.max(config.lastId[p] ?? 0, last)
  const id = nextId(loaded, input.type, await idsIn(io, join(config.vault, SUBDIR[input.type])))
  const name = `${id} ${title}`
  const path = `${SUBDIR[input.type]}/${name}.md`
  const parentName = parent ? tree.nodes[parent]!.name : null
  const refs = refNames(tree, input.refs ?? [])
  const text = noteText(id, { ...input, title, status, refs }, config.project, parentName)
  await io.write(join(config.vault, path), text)
  const prefix = TYPES[input.type].prefix
  config.lastId[prefix] = Math.max(config.lastId[prefix] ?? 0, Number(id.slice(1)))
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

/** The ids of the notes in a folder of the vault, as it is on disk now. */
async function idsIn(io: Io, dir: string): Promise<string[]> {
  if (!(await io.exists(dir))) return []
  return (await io.list(dir)).map(f => idOf(f.name)).filter(id => ID_RE.test(id))
}

export async function setTags(io: Io, loaded: Loaded, ref: string, tags: string[]): Promise<string> {
  const id = resolveId(loaded.tree, ref)
  if (!id) throw new RftError(`"${ref}" is not a note of the tree`)
  const n = loaded.tree.nodes[id]!
  const next = withTopicalTags(loaded.texts[id]!, n, loaded.config.project, tags)
  await io.write(join(loaded.config.vault, n.path), next)
  const fresh = await load(io, loaded.config)
  Object.assign(loaded, fresh)
  const now = fresh.tree.nodes[id]!.tags
  return `${n.name}: tags ${now.length ? now.join(', ') : '(none)'}${n.tags.join() !== now.join() ? ` (were ${n.tags.join(', ') || 'none'})` : ''}.`
}

/** Replaces the notes a note builds on (`refs:`); an empty list removes them. */
export async function setRefs(io: Io, loaded: Loaded, ref: string, refs: string[]): Promise<string> {
  const id = resolveId(loaded.tree, ref)
  if (!id) throw new RftError(`"${ref}" is not a note of the tree`)
  const n = loaded.tree.nodes[id]!
  const names = refNames(loaded.tree, refs)
  if (names.includes(n.name)) throw new RftError(`${n.name} cannot reference itself`)
  await io.write(join(loaded.config.vault, n.path), withRefs(loaded.texts[id]!, names))
  const fresh = await load(io, loaded.config)
  Object.assign(loaded, fresh)
  const odd = (fresh.tree.nodes[id]!.refs ?? []).filter(r => fresh.tree.nodes[r]!.type !== 'reference')
  return `${n.name}: ${names.length ? `refs ${names.map(x => idOf(x)).join(', ')}` : 'no refs'}.` +
    (odd.length ? ` Note: ${odd.join(', ')} ${odd.length === 1 ? 'is' : 'are'} not a reference.` : '')
}

// ---------------------------------------------------------------- concepts

/** Concept names name a line of research: short, and free of what breaks Obsidian links. */
export function checkConceptName(name: string): string {
  const n = name.trim().replace(/\s+/g, ' ')
  if (!n) throw new RftError('the concept name is empty')
  if (/[\^#|[\]]/.test(n)) throw new RftError('a concept name cannot contain ^ # | [ or ]')
  if (n.length > 60) throw new RftError('keep the concept name short (60 characters at most): it names a line of research')
  return n
}

/** Sets, renames or (with a null or empty name) removes the concept a note declares. */
export async function setConcept(io: Io, loaded: Loaded, ref: string, name: string | null, summary?: string): Promise<string> {
  const id = resolveId(loaded.tree, ref)
  if (!id) throw new RftError(`"${ref}" is not a note of the tree`)
  const n = loaded.tree.nodes[id]!
  const was = loaded.tree.concepts?.[id]
  let text = loaded.texts[id]!
  let said: string
  if (name === null || !name.trim()) {
    if (!was) return `${n.name} declares no concept: nothing to remove.`
    text = removeField(removeField(text, 'concept'), 'concept_summary')
    said = `${n.name} no longer starts the concept "${was.name}": its notes now belong to the enclosing concept.`
  } else {
    const clean = checkConceptName(name)
    text = setField(text, 'concept', JSON.stringify(clean), 'tags')
    if (summary !== undefined) {
      const one = summary.trim().replace(/\s+/g, ' ')
      text = one ? setField(text, 'concept_summary', JSON.stringify(one), 'concept') : removeField(text, 'concept_summary')
    }
    said = was
      ? `${n.name}: concept "${was.name}" ${was.name === clean ? 'kept' : `renamed to "${clean}"`}${summary !== undefined ? ', summary updated' : ''}.`
      : `${n.name} now starts the concept "${clean}".`
  }
  await io.write(join(loaded.config.vault, n.path), text)
  const fresh = await load(io, loaded.config)
  Object.assign(loaded, fresh)
  const c = fresh.tree.concepts?.[id]
  return c ? `${said} It holds ${c.count} note(s) (${c.total} with its sub-concepts).` : said
}

/** The concept tree as compact text. */
export function conceptsReport(loaded: Loaded): string {
  const concepts = loaded.tree.concepts ?? {}
  const lines = conceptOrder(concepts).map(c => {
    const where = c.root ? `@${c.root}` : 'project root'
    const sub = c.total > c.count ? ` (+${c.total - c.count} in sub-concepts)` : ''
    const stats = statusSummary(c.statuses)
    return `${'  '.repeat(c.depth)}- ${c.name} [${where}] ${c.count} note(s)${sub}${stats ? ` ${stats}` : ''}${c.summary ? ` — ${c.summary}` : ''}`
  })
  const declared = lines.length - 1
  return `${declared ? `${declared} concept(s)` : 'No concepts yet: every note is in the project root concept'}. Marks: ${LEGEND}.\n${lines.join('\n')}`
}

/**
 * The tree for the session-start context: grouped by concept when there are concepts (a
 * header per concept, its own notes one per line), else the indented tree.
 */
export function groupedTree(tree: Tree): string {
  const concepts = tree.concepts ?? {}
  if (Object.keys(concepts).length <= 1) return compactTree(tree)
  const own: Record<string, string[]> = {}
  const walk = (id: string) => {
    const n = tree.nodes[id]
    if (!n) return
    ;(own[n.concept] ??= []).push(id)
    n.children.forEach(walk)
  }
  tree.roots.forEach(walk)
  const out: string[] = []
  for (const c of conceptOrder(concepts)) {
    const path = conceptPath(concepts, c.id).map(id => concepts[id]!.name).join(' › ')
    const notes = own[c.id] ?? []
    if (!notes.length && c.id === ROOT_CONCEPT) continue
    out.push(`## ${path}${c.root ? ` (from ${c.root})` : ''}${c.summary ? ` — ${c.summary}` : ''}`)
    let prev: string | null = null
    for (const id of notes) {
      const n = tree.nodes[id]!
      // the parent is said when it is not the note on the line above
      out.push(`${MARK[n.status] ?? '-'} ${n.name}${n.parent && n.parent !== prev ? ` ← ${n.parent}` : ''}`)
      prev = id
    }
  }
  return out.join('\n')
}

export function tagsReport(loaded: Loaded): string {
  const list = tagCounts(loaded.tree)
  return list.length
    ? `Topical tags in use (reuse these before inventing new ones):\n${list.map(t => `- ${t.tag} (${t.count})`).join('\n')}`
    : 'No topical tags yet: pick 1-3 short lowercase kebab-case ones per note.'
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

/**
 * Moves a note and its subtree under another parent. The note keeps where it came from
 * (`origin:` and a `## History` line); the old parent stops listing it, the new one lists it,
 * and the derived files follow. Concepts move with their notes.
 */
export async function moveNode(io: Io, loaded: Loaded, ref: string, parentRef: string, date: string, why?: string): Promise<string> {
  const { tree, config } = loaded
  const id = resolveId(tree, ref)
  if (!id) throw new RftError(`"${ref}" is not a note of the tree`)
  const to = resolveId(tree, parentRef)
  if (!to) throw new RftError(`the new parent "${parentRef}" is not a note of the tree`)
  const n = tree.nodes[id]!
  if (!n.parent) throw new RftError(`${n.name} is a root of the tree: it has no parent to move away from`)
  if (n.parent === to) throw new RftError(`${n.name} is already under ${tree.nodes[to]!.name}`)
  const sub = subtreeOf(tree, id)
  if (sub.has(to)) throw new RftError(`${tree.nodes[to]!.name} is ${to === id ? 'the note itself' : 'below the note'}: a note cannot move under its own subtree`)
  const old = tree.nodes[n.parent]!
  const conceptWas = tree.concepts?.[n.concept]?.name
  await io.write(join(config.vault, n.path), withMove(loaded.texts[id]!, old.name, tree.nodes[to]!.name, date, why))
  const prev = loaded.texts[old.id]!
  const next = withChildUnlisted(prev, n.name)
  if (next !== prev) await io.write(join(config.vault, old.path), next)
  const fresh = await load(io, config)
  const report = await sync(io, fresh)
  Object.assign(loaded, fresh)
  const conceptNow = fresh.tree.concepts?.[fresh.tree.nodes[id]!.concept]?.name
  const lines = [
    `Moved ${n.name}${sub.size > 1 ? ` and the ${sub.size - 1} note(s) below it` : ''} from ${old.name} to ${fresh.tree.nodes[to]!.name}.`,
    `Its origin keeps ${old.id}. Updated ${report.changed.length} derived file(s).`,
  ]
  if (conceptWas !== conceptNow) lines.push(`Its concept is now "${conceptNow}" (was "${conceptWas}").`)
  return lines.join('\n')
}

// ---------------------------------------------------------------- text for the model

/** `vault`: where the notes are as the session sees them, as in `rulesText`. */
export function treeReport(loaded: Loaded, opts: { root?: string; depth?: number; vault?: string } = {}): string {
  const { tree, config } = loaded
  const c = counts(tree)
  const root = opts.root ? resolveId(tree, opts.root) : undefined
  if (opts.root && !root) throw new RftError(`"${opts.root}" is not a note of the tree`)
  const body = compactTree(tree, { root: root ?? undefined, depth: opts.depth, withStatus: false })
  return [
    `${config.project}: ${countsLine(c)} in ${opts.vault ?? config.vault}/. Marks: ${LEGEND}.`,
    body || '(empty tree)',
  ].join('\n')
}

const MAX_LINES = 160

/** `vault`: where the notes are as the session sees them, when the tree is not in its folder. */
export function rulesText(tree: Tree, config: Config, vault = config.vault): string {
  let lines = groupedTree(tree).split('\n')
  if (lines.length > MAX_LINES) lines = [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more (rft_tree shows them)`]
  return `# Reasoning Flow Tree (rft) is active in this project

The reasoning of this research project is kept as a tree of Obsidian notes in \`${vault}/\`: one note per experiment (E.., something run or computed), per direction (D.., an idea, question or hypothesis, rejected ones included), per reference (R.., a paper, method or literature review that was read: its summary and your comments) and per theory note (T.., the project's own definitions, methods, taxonomies and arguments, built on the other notes), each with exactly one parent; D00 is the starting question. The notes are the source of truth. Keep the tree up to date as you work, with the rft tools:

- Before launching an experiment (a training run, a grid, a numerical check, a measurement, a literature search for a yes or no answer), create its node first: rft_add_node with type experiment, parent = the direction it tests, status planned or running, and What / Why filled.
- When it finishes or gives a partial result, write the real numbers in its note (Result, with spread over seeds and what failed; Directions found; Code / data: commit, script, results folder, machine), then rft_set_status. Record only results that were actually obtained, never expected or invented ones.
- Every new idea or question, from a result, a reference, the user or a discussion, even if rejected: rft_add_node with type direction, parent = the note it comes from. Rejected ideas get status discussed; abandoned ones dropped; moved ones moved, with the reason (rft_set_status note).
- A paper, method or literature review that was read: rft_add_node with type reference, parent = the note that led to it (a review may hold one reference per key paper). Fill Source with a link that can be checked (DOI, arXiv id or URL), Summary, Method, Key results as the source reports them (and where), and your reading under Relevance. Only sources actually read: never invent a citation, or a result the source does not report. Status planned = to read, running = reading, done = summarised, dropped = not relevant.
- A definition, method, taxonomy, proof or argument of the project's own: rft_add_node with type theory, parent = the note it builds on most, every other note it builds on linked under Builds on. Status idea = draft, running = being worked out, done = settled, dropped = refuted.
- Experiments and directions name what they build on: refs (rft_add_node's refs, or rft_set_refs) links the reference notes (R..) behind them, above all the paper(s) whose setup an experiment starts from (baseline, data, protocol). A paper that is not in the tree yet becomes a reference note first.
- Give every new note 1-3 short topical tags (lowercase kebab-case, e.g. \`ablation\`, \`optimisation\`), reusing the ones rft_tags lists before inventing new ones; rft_set_tags changes them. Do not retro-tag old notes unless asked.
- Statuses: ${STATUSES.join(', ')}. Marks: ${LEGEND}.
- The tools assign ids (never reused) and strip ^ # | [ ] from titles. After editing notes by hand, run rft_sync (children / up / down, 00 Index.md, the canvas) and rft_validate.
- Concepts group the tree into lines of research: a note with \`concept:\` starts one, its subtree inherits it until a sub-concept starts. When a direction opens a new line of research, PROPOSE a short concept name to the user; apply it with rft_set_concept only after they confirm, never silently. rft_concepts shows the concept tree.
- A branch that sits under the wrong line of research: propose moving it, and once the user agrees use rft_move_node (the subtree follows, the note keeps its origin and a History line). Never move a note by editing its parent: by hand.
- The rft-manual skill is the full manual; rft_tree shows the current tree.

The tree at the start of this session${Object.keys(tree.concepts ?? {}).length > 1 ? ', by concept (← parent, when not the line above)' : ''}:
${lines.join('\n')}`
}

// ---------------------------------------------------------------- export

export async function exportHtml(io: Io, loaded: Loaded, assets: PageAssets): Promise<string> {
  const path = join(loaded.config.vault, 'tree.html')
  const { tree, texts, config, signature } = loaded
  await io.write(path, staticPage(assets, tree, texts, config.project, signature.length.toString(36)))
  return path
}
