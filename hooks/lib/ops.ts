// The operations behind the commands and tools: set up a vault, add a node, change a status,
// export the HTML view, and the operating rules injected into a session. Each takes an `Io`
// and returns plain text for the model or the person.

import type { PageAssets } from './page'
import { staticPage } from './page'
import type { CodeRepo, Concept, Config, Io, Loaded, NodeType, RftNode, Tree } from './vault'
import {
  CANVAS, CODE, CONFIG_PATH, ID_RE, INDEX, LEGEND, MARK, MERMAID, NODE_TYPES, ROOT_CONCEPT, STATUSES, SUBDIR,
  TEMPLATES, TYPES, codeRepos, codeSection, compactTree, conceptOrder, conceptPath, counts, countsLine,
  declaredConcept, defaultConfig, front, idOf, indexTemplate, isAbsolute, isInGit, isNodeType, join, load, locate,
  needsCode, nextId, noteText, orList, readConfig, removeField, renameLinks, repoAbs, reposLine, resolveId, retyped,
  sanitiseTitle, setField, statusSummary, subtreeOf, sync, tagCounts, unquote, validate, walk, withCardRenamed,
  withChildListed, withChildUnlisted, withCodeSection, withLinksRenamed, withMove, withRefs, withStatus,
  withTopicalTags, writeConfig,
} from './vault'
import { cleanSummary, withSummary } from './map'

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
  config.requireSummaries = true
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
    delete config.requireSummaries
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
  /** One line on what the note is (and, for a result, what it found). */
  summary?: string
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

/**
 * `env`: how to reach the code; with it, an experiment or direction in a concept that links code
 * gets a `## Code` section with each repo's current commit (`sections.Code` is its description).
 */
export async function addNode(io: Io, loaded: Loaded, input: AddInput, env?: CodeEnv): Promise<RftNode & { report: string }> {
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
  const id = await freshId(io, loaded, input.type)
  const name = `${id} ${title}`
  const path = `${SUBDIR[input.type]}/${name}.md`
  const parentName = parent ? tree.nodes[parent]!.name : null
  // a new note starts no concept: it is in its parent's
  const concept = parent ? tree.nodes[parent]!.concept : ROOT_CONCEPT
  const repos = env && parent && needsCode({ type: input.type, status }) ? codeRepos(tree.concepts, concept) : []
  let sections = input.sections
  let codeSaid = ''
  if (env && repos.length) {
    const stamped = await stamp(io, env, tree.concepts, concept, repos)
    const description = sections?.[CODE]?.trim() ?? ''
    sections = { ...sections, [CODE]: [...stamped.lines, ...(description ? ['', description] : [])].join('\n') }
    codeSaid = ` Its concept links code: ${stamped.said.join('; ')}.` + (description
      ? ` The ${CODE} section holds your description, checked against these commits.`
      : ' Read the code as it is now (the current commit and uncommitted changes) and write how this note relates to it with rft_set_code.')
  }
  const refs = refNames(tree, input.refs ?? [])
  const summary = input.summary?.trim() ? cleanSummary(input.summary) : undefined
  const text = noteText(id, { ...input, sections, title, status, refs, summary }, config.project, parentName)
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
    report: `Created ${path}${parent ? ` under ${parentName}` : ' as the root'} (status ${status}). Updated ${report.changed.length} derived file(s).${codeSaid}${summary ? '' : ' It has no summary: give it one line with rft_set_summary.'}`,
  }
}

/** The ids of the notes in a folder of the vault, as it is on disk now. */
async function idsIn(io: Io, dir: string): Promise<string[]> {
  if (!(await io.exists(dir))) return []
  return (await io.list(dir)).map(f => idOf(f.name)).filter(id => ID_RE.test(id))
}

async function freshId(io: Io, loaded: Loaded, type: NodeType): Promise<string> {
  const { config } = loaded
  const onDisk = await readConfig(io)
  if (onDisk) for (const [p, last] of Object.entries(onDisk.lastId)) config.lastId[p] = Math.max(config.lastId[p] ?? 0, last)
  return nextId(loaded, type, await idsIn(io, join(config.vault, SUBDIR[type])))
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
  const was = declaredConcept(loaded.tree.concepts, id)
  let text = loaded.texts[id]!
  let said: string
  if (name === null || !name.trim()) {
    if (!was) return `${n.name} declares no concept: nothing to remove.`
    text = removeField(removeField(text, 'concept'), 'concept_summary')
    said = `${n.name} no longer starts the concept "${was.name}": its notes now belong to the enclosing concept.`
    // the only root note's repos are the project's, with or without a concept
    const isTop = loaded.tree.roots.length === 1 && loaded.tree.roots[0] === id
    if (was.repos.length && !isTop) {
      text = removeField(text, 'concept_repos')
      said += ` Its code links (${was.repos.join(', ')}) went with it.`
    }
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
  const c = declaredConcept(fresh.tree.concepts, id)
  if (!c) return said
  said += ` It holds ${c.count} note(s) (${c.total} with its sub-concepts).`
  if (!was) {
    const above = codeRepos(fresh.tree.concepts, c.id).filter(r => r.concept !== c.id)
    if (above.length) said += ` It inherits code from the concepts above: ${above.map(r => `${r.path} (${fresh.tree.concepts![r.concept]!.name})`).join(', ')}.`
    said += ' Ask the user whether code for this line of research already exists on this machine, and where; if so, link it with rft_set_repos (never guess a path).'
  }
  return said
}

/** ` · code: a, b`: the repos a concept links itself, or nothing. */
const codeOf = (c: Concept) => (c.repos?.length ? ` · code: ${c.repos.join(', ')}` : '')

/** The concept tree as compact text. */
export function conceptsReport(loaded: Loaded): string {
  const concepts = loaded.tree.concepts ?? {}
  const order = conceptOrder(concepts)
  const lines = order.map(c => {
    const where = c.root ? `@${c.root}` : 'project root'
    const sub = c.total > c.count ? ` (+${c.total - c.count} in sub-concepts)` : ''
    const stats = statusSummary(c.statuses)
    return `${'  '.repeat(c.depth)}- ${c.name} [${where}] ${c.count} note(s)${sub}${stats ? ` ${stats}` : ''}${c.summary ? ` — ${c.summary}` : ''}${codeOf(c)}`
  })
  const declared = order.filter(c => c.root).length
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
    out.push(`## ${path}${c.root ? ` (from ${c.root})` : ''}${c.summary ? ` — ${c.summary}` : ''}${codeOf(c)}`)
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

export async function setStatus(io: Io, loaded: Loaded, ref: string, status: string, note?: string, summary?: string): Promise<string> {
  const id = resolveId(loaded.tree, ref)
  if (!id) throw new RftError(`"${ref}" is not a note of the tree`)
  if (!(STATUSES as readonly string[]).includes(status)) throw new RftError(`status must be one of ${STATUSES.join(', ')}`)
  const n = loaded.tree.nodes[id]!
  const prev = loaded.texts[id]!
  let next = withStatus(prev, n, status, note)
  if (summary?.trim()) next = withSummary(next, summary)
  await io.write(join(loaded.config.vault, n.path), next)
  const fresh = await load(io, loaded.config)
  const report = await sync(io, fresh)
  Object.assign(loaded, fresh)
  const nudge = !summary?.trim() && note?.trim() && (status === 'done' || status === 'dropped')
    ? ' Update its one-line summary with what it found (rft_set_summary).' : ''
  return `${n.name}: ${n.status} → ${status}${note ? ' (note added)' : ''}${summary?.trim() ? ', summary updated' : ''}. Updated ${report.changed.length} derived file(s).${nudge}`
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

// ---------------------------------------------------------------- code

/** Runs git in a folder: whether it exited 0, and what it wrote. */
export type Git = (dir: string, args: string[]) => Promise<{ ok: boolean; out: string; err: string }>

/**
 * How the code is reached: the tree's folder (relative repo paths start there), git, the home
 * folder (for `~/…`), and today's date (when a note's code references were checked).
 */
export type CodeEnv = { root: string; git: Git; home?: string; date: string }

export type RepoState =
  | { kind: 'git'; commit: string | null; branch: string; dirty: number }
  | { kind: 'plain' }
  | { kind: 'missing' }
  | { kind: 'error'; why: string }

/** The length of a recorded commit: short, and safe from clashes in large repos. */
const COMMIT_LEN = 10
const MAX_LOG = 30
const MAX_STAT = 40

const firstLine = (s: string) => s.trim().split('\n')[0] ?? ''

/** A repo's state now: its branch, commit and uncommitted changes to tracked files. */
export async function repoState(io: Io, env: CodeEnv, path: string): Promise<RepoState> {
  const abs = repoAbs(env.root, path, env.home)
  if (!(await io.exists(abs))) return { kind: 'missing' }
  // told by the folders, not by git's message, which is in the user's language
  if (!(await isInGit(io, abs))) return { kind: 'plain' }
  const r = await env.git(abs, ['status', '--porcelain=v2', '--branch', '--untracked-files=no'])
  if (!r.ok) return { kind: 'error', why: firstLine(r.err) || 'git failed' }
  let commit: string | null = null
  let branch = ''
  let dirty = 0
  for (const line of r.out.split('\n')) {
    const oid = /^# branch\.oid (\S+)/.exec(line)
    const head = /^# branch\.head (\S+)/.exec(line)
    if (oid) commit = /^[0-9a-f]{7,}$/.test(oid[1]!) ? oid[1]!.slice(0, COMMIT_LEN) : null
    else if (head) branch = head[1] === '(detached)' ? 'detached HEAD' : head[1]!
    else if (line.trim() && !line.startsWith('#')) dirty++
  }
  return { kind: 'git', commit, branch: branch || 'detached HEAD', dirty }
}

export function stateText(st: RepoState): string {
  switch (st.kind) {
    case 'git':
      return `${st.branch} @ ${st.commit ?? '(no commits yet)'}, ${st.dirty ? `uncommitted changes in ${st.dirty} file(s)` : 'clean'}`
    case 'plain': return 'not under git (no commit can be recorded)'
    case 'missing': return 'not found'
    case 'error': return `git failed (${st.why})`
  }
}

/** A repo line of a `## Code` section: the repo, the commit it was checked against, when, and where it comes from. */
export function repoLine(path: string, st: RepoState, date: string, inheritedFrom?: string): string {
  const where = st.kind === 'git'
    ? st.commit ? ` @ ${st.commit} (${st.branch}${st.dirty ? `, uncommitted changes in ${st.dirty} file(s)` : ''})` : ` (${st.branch}, no commits yet)`
    : st.kind === 'plain' ? ' (not under git)' : st.kind === 'missing' ? ' (not found)' : ` (git failed: ${st.why})`
  return `- \`${path}\`${where} · checked ${date}${inheritedFrom ? ` · inherited from ${inheritedFrom}` : ''}`
}

/** The repo lines for a note of concept `own`, each repo's state read now, and the same said in words. */
async function stamp(io: Io, env: CodeEnv, concepts: Record<string, Concept> | undefined, own: string, repos: CodeRepo[]): Promise<{ lines: string[]; said: string[] }> {
  const lines: string[] = []
  const said: string[] = []
  for (const r of repos) {
    const st = await repoState(io, env, r.path)
    const from = r.concept !== own ? concepts?.[r.concept]?.name ?? r.concept : undefined
    lines.push(repoLine(r.path, st, env.date, from))
    said.push(`${r.path}${from ? ` (inherited from ${from})` : ''}: ${stateText(st)}`)
  }
  return { lines, said }
}

/** What changed in a repo since `commit`: the commits, then the files changed, uncommitted changes included. */
async function changesSince(env: CodeEnv, abs: string, commit: string): Promise<string[]> {
  const known = await env.git(abs, ['cat-file', '-e', `${commit}^{commit}`])
  if (!known.ok) return [`The commit ${commit} is not in this repository (rebased, or another clone?): check the references against the code as it is now.`]
  const out: string[] = []
  const log = await env.git(abs, ['log', '--oneline', '--no-decorate', '-n', String(MAX_LOG + 1), `${commit}..HEAD`])
  const commits = log.out.split('\n').filter(Boolean)
  if (commits.length) {
    out.push(`Commits since (newest first):`, ...commits.slice(0, MAX_LOG).map(l => `  ${l}`))
    if (commits.length > MAX_LOG) out.push(`  … more (git -C ${abs} log ${commit}..HEAD)`)
  } else out.push('No commits since.')
  // from the commit to the working tree: committed and uncommitted changes to tracked files
  const stat = (await env.git(abs, ['diff', '--stat=120', commit])).out.split('\n').filter(Boolean)
  if (stat.length) {
    const files = stat.slice(0, -1)
    out.push(`Files changed since, uncommitted changes included (${firstLine(stat[stat.length - 1]!)}):`, ...files.slice(0, MAX_STAT).map(l => `  ${l.trim()}`))
    if (files.length > MAX_STAT) out.push(`  … ${files.length - MAX_STAT} more (git -C ${abs} diff --stat ${commit})`)
  } else out.push('No file changed since.')
  return out
}

/** How a concept is named in the tools' answers. */
const conceptLabel = (c: Concept | undefined) => (c?.root ? `concept "${c.name}" (from ${c.root})` : 'the project')

/** A path as given: `~/…` made absolute, a trailing slash dropped. */
const givenPath = (p: string, home?: string) => {
  const t = p.trim().replace(/(.)\/+$/, '$1')
  return home && (t === '~' || t.startsWith('~/')) ? repoAbs('/', t, home) : t
}

/** Whether a session started in `abs` works on this tree, and what to do when it does not. */
async function reach(io: Io, env: CodeEnv, abs: string): Promise<string> {
  const found = await locate(io, abs)
  if (found && found.root === env.root) return 'Sessions started there work on this tree.'
  if (found && found.root === null) return `Sessions started there do not reach this tree: ${found.problem}.`
  if (found) return `Sessions started there work on another tree, in ${found.root}.`
  return `Sessions started there find no tree: a .rft/config.json there holding {"tree": "${env.root}"} would link them to this one. Ask the user before writing it into the repo.`
}

/**
 * Links code repos to the concept a note starts (or, on the only root note, to the whole
 * project), replacing the list; an empty list removes it. Every path must exist.
 */
export async function setRepos(io: Io, loaded: Loaded, env: CodeEnv, ref: string, repos: string[]): Promise<string> {
  const { tree, config } = loaded
  const id = resolveId(tree, ref)
  if (!id) throw new RftError(`"${ref}" is not a note of the tree`)
  const n = tree.nodes[id]!
  const isTop = tree.roots.length === 1 && tree.roots[0] === id
  if (!declaredConcept(tree.concepts, id) && !isTop) {
    throw new RftError(`${n.name} starts no concept. Code is linked to a concept: propose one to the user and set it with rft_set_concept first, or link code of the whole project on the root note${tree.roots.length === 1 ? ` (${tree.roots[0]})` : ''}`)
  }
  const list = [...new Set(repos.map(p => givenPath(p, env.home)).filter(Boolean))]
  const missing: string[] = []
  for (const p of list) if (!(await io.exists(repoAbs(env.root, p, env.home)))) missing.push(p)
  if (missing.length) {
    throw new RftError(`not found: ${missing.join(', ')}${missing.some(p => !isAbsolute(p)) ? ` (a relative path starts from the tree's folder, ${env.root})` : ''}. Ask the user for the path; do not guess one.`)
  }
  const prev = loaded.texts[id]!
  const fm = front(prev)
  const had = tree.concepts?.[declaredConcept(tree.concepts, id)?.id ?? ROOT_CONCEPT]?.repos ?? []
  const text = list.length
    ? setField(prev, 'concept_repos', reposLine(list), fm.concept_summary !== undefined ? 'concept_summary' : unquote(fm.concept) ? 'concept' : 'tags')
    : removeField(prev, 'concept_repos')
  await io.write(join(config.vault, n.path), text)
  const fresh = await load(io, config)
  Object.assign(loaded, fresh)
  const concepts = fresh.tree.concepts ?? {}
  const cid = declaredConcept(concepts, id)?.id ?? ROOT_CONCEPT
  const label = conceptLabel(concepts[cid])
  if (!list.length) {
    return had.length
      ? `${n.name}: ${label} links no code any more (was ${had.join(', ')}). rft_validate lists the Code sections that still name it.`
      : `${n.name}: ${label} linked no code: nothing to remove.`
  }
  const out = [`${n.name}: ${label} now links, by priority:`]
  for (const p of list) {
    const abs = repoAbs(env.root, p, env.home)
    out.push(`- ${p}${abs !== p ? ` (${abs})` : ''}: ${stateText(await repoState(io, env, p))}. ${await reach(io, env, abs)}`)
  }
  const above = codeRepos(concepts, cid).filter(r => r.concept !== cid)
  if (above.length) out.push(`Inherited from the concepts above, after these: ${above.map(r => `${r.path} (${concepts[r.concept]!.name})`).join(', ')}.`)
  const notes: string[] = []
  walk(fresh.tree, x => { if (needsCode(x)) notes.push(x.id) }, [id])
  if (notes.length) {
    out.push(`Now read the code as it is now and give each of these notes a ## ${CODE} section with rft_set_code (how it relates to the code; for an experiment with results, how to reproduce them): ${notes.join(', ')}.`)
  }
  return out.join('\n')
}

/**
 * A note's code context: the repos its concept links (its own first, then inherited), each
 * one's state now, the commit the note's `## Code` section was checked against, and the commits
 * and files changed since.
 */
export async function codeReport(io: Io, loaded: Loaded, env: CodeEnv, ref: string): Promise<string> {
  const { tree } = loaded
  const id = resolveId(tree, ref)
  if (!id) throw new RftError(`"${ref}" is not a note of the tree`)
  const n = tree.nodes[id]!
  const concepts = tree.concepts ?? {}
  const c = concepts[n.concept]
  const repos = codeRepos(concepts, n.concept)
  if (!repos.length) {
    return `${n.name} is in ${conceptLabel(c)}, which links no code, nor does any concept above it. If code for it exists, ask the user where and link it with rft_set_repos on the note that starts the concept.`
  }
  const cs = codeSection(loaded.texts[id]!)
  const out = [`${n.name}, in ${conceptLabel(c)}. Its code, by priority:`]
  for (const [i, r] of repos.entries()) {
    const abs = repoAbs(env.root, r.path, env.home)
    const st = await repoState(io, env, r.path)
    const from = r.concept === n.concept ? "its concept's own" : `inherited from ${concepts[r.concept]?.name ?? r.concept}`
    out.push(`${i + 1}. ${r.path}${abs !== r.path ? ` (${abs})` : ''}, ${from}: now ${stateText(st)}.`)
    const rec = cs?.repos.find(x => x.path === r.path)
    if (!cs) continue
    if (!rec) out.push('   Not in the note\'s Code section yet.')
    else if (!rec.commit) out.push('   The Code section records no commit for it.')
    else if (st.kind !== 'git' || !st.commit) out.push(`   Checked at ${rec.commit}; the repo has no commit to compare with now.`)
    else if ((st.commit.startsWith(rec.commit) || rec.commit.startsWith(st.commit)) && !st.dirty) out.push(`   Checked at ${rec.commit}: nothing changed since.`)
    else out.push(`   Checked at ${rec.commit}.`, ...(await changesSince(env, abs, rec.commit)).map(l => `   ${l}`))
  }
  out.push(cs
    ? 'Read the changes to what the note refers to (git -C <repo> diff <checked commit> -- <files>), against the code as it is now; then update the Code section with rft_set_code, which records the current commits. Keep the Reproduce part as it is unless a result was redone.'
    : `The note has no ## ${CODE} section: read the code as it is now and write one with rft_set_code.`)
  return out.join('\n')
}

/**
 * Writes a note's `## Code` section: the repos its concept links, each with its commit now (what
 * the references were checked against), the description and the Reproduce part. Left undefined,
 * the description or the Reproduce part keeps what the section held.
 */
export async function setCode(io: Io, loaded: Loaded, env: CodeEnv, ref: string, description?: string, reproduce?: string): Promise<string> {
  const { tree, config } = loaded
  const id = resolveId(tree, ref)
  if (!id) throw new RftError(`"${ref}" is not a note of the tree`)
  const n = tree.nodes[id]!
  const concepts = tree.concepts ?? {}
  const repos = codeRepos(concepts, n.concept)
  if (!repos.length) {
    const c = concepts[n.concept]
    throw new RftError(`${n.name} is in ${conceptLabel(c)}, which links no code: link a repo first with rft_set_repos on ${c?.root ?? 'the root note'}, once the user gives its path`)
  }
  const prev = loaded.texts[id]!
  const was = codeSection(prev)
  const { lines, said } = await stamp(io, env, concepts, n.concept, repos)
  const text = withCodeSection(prev, n.type, { repos: lines, description, reproduce })
  await io.write(join(config.vault, n.path), text)
  const fresh = await load(io, config)
  Object.assign(loaded, fresh)
  const now = codeSection(text)
  let out = `${n.name}: ## ${CODE} ${was ? 'updated' : 'written'}, checked against ${said.join('; ')}.`
  if (!now?.description) out += ' It holds no description yet: pass text, how the note relates to the code.'
  if (n.type === 'experiment' && n.status === 'done' && !now?.reproduce) out += ' A done experiment says how to reproduce its results: pass reproduce.'
  return out
}

// ---------------------------------------------------------------- type

/**
 * Changes a note's type as if it had been made with that type: the next free id of the type
 * (the old id is never reused), the file moved to the type's folder, the type's sections (no
 * text lost), and every link to it in the vault renamed. The root stays a direction.
 */
export async function setType(io: Io, loaded: Loaded, ref: string, type: string): Promise<string> {
  const { tree, config, texts } = loaded
  const old = resolveId(tree, ref)
  if (!old) throw new RftError(`"${ref}" is not a note of the tree`)
  if (!isNodeType(type)) throw new RftError(`type must be ${orList(NODE_TYPES.map(t => `"${t}"`))}`)
  const n = tree.nodes[old]!
  if (n.type === type) throw new RftError(`${n.name} is already of type ${type}`)
  if (!n.parent && type !== 'direction') throw new RftError('the root of the tree stays a direction (D00, the starting question)')
  const id = await freshId(io, loaded, type)
  const name = `${id} ${n.title}`
  const path = `${SUBDIR[type]}/${name}.md`
  // the note in its new place first: whatever fails after, no text is lost
  await io.write(join(config.vault, path), withLinksRenamed(retyped(texts[old]!, n, type, id, config.project), n.name, name))
  const prefix = TYPES[type].prefix
  config.lastId[prefix] = Math.max(config.lastId[prefix] ?? 0, Number(id.slice(1)))
  await writeConfig(io, config)
  const linked = await renameLinks(io, config.vault, n.name, name, [n.path, path])
  const canvas = join(config.vault, CANVAS)
  if (config.canvas && (await io.exists(canvas))) await io.write(canvas, withCardRenamed(await io.read(canvas), old, id))
  try {
    await io.remove(join(config.vault, n.path))
  } catch (err) {
    throw new RftError(`${path} is written, but ${n.path} could not be removed (${err instanceof Error ? err.message : String(err)}): delete it by hand, then run rft_sync`)
  }
  const fresh = await load(io, config)
  const report = await sync(io, fresh)
  Object.assign(loaded, fresh)
  return `${n.name} → ${name} (${n.type} → ${type}), now ${path}. Links renamed in ${linked.length} file(s); updated ${report.changed.length} derived file(s).`
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

/**
 * What the session is told of the code: the project's repos when there are no concepts (the
 * grouped tree names each concept's), and the concepts whose code the session's folder is in.
 */
function codeContext(tree: Tree, where: { cwd?: string; root?: string; home?: string }): string {
  const concepts = tree.concepts ?? {}
  const out: string[] = []
  const top = concepts[ROOT_CONCEPT]
  if (top?.repos.length && Object.keys(concepts).length <= 1) out.push(`The project's code (every note works with it): ${top.repos.join(', ')}.`)
  if (where.cwd && where.root) {
    const hits: string[] = []
    for (const c of conceptOrder(concepts)) {
      for (const p of c.repos ?? []) {
        const abs = repoAbs(where.root, p, where.home)
        if (where.cwd === abs || where.cwd.startsWith(abs.replace(/\/$/, '') + '/')) hits.push(c.root ? `concept "${c.name}" (from ${c.root})` : 'the whole project')
      }
    }
    if (hits.length) out.push(`This session runs in the code of ${orList([...new Set(hits)])}: new experiments and directions from here usually belong under it, and their Code sections refer to this repository.`)
  }
  return out.length ? `\n${out.join('\n')}\n` : ''
}

/**
 * `vault`: where the notes are as the session sees them, when the tree is not in its folder;
 * `where`: the session's folder and the tree's (and the home folder), to say which concept's code
 * the session runs in.
 */
export function rulesText(tree: Tree, config: Config, vault = config.vault, where: { cwd?: string; root?: string; home?: string } = {}, map?: string): string {
  let lines = (map ?? groupedTree(tree)).split('\n')
  if (lines.length > MAX_LINES) lines = [...lines.slice(0, MAX_LINES), `… ${lines.length - MAX_LINES} more (${map ? 'rft_map' : 'rft_tree'} shows them)`]
  return `# Reasoning Flow Tree (rft) is active in this project

The reasoning of this research project is kept as a tree of Obsidian notes in \`${vault}/\`: one note per experiment (E.., something run or computed), per direction (D.., an idea, question or hypothesis, rejected ones included), per reference (R.., a paper, method or literature review that was read: its summary and your comments) and per theory note (T.., the project's own definitions, methods, taxonomies and arguments, built on the other notes), each with exactly one parent; D00 is the starting question. The notes are the source of truth. Keep the tree up to date as you work, with the rft tools:

- Read the tree in layers, not file by file: rft_map gives the project map (each concept and where it stands), rft_map <concept> a concept's digest and its notes with one-line summaries, rft_search finds notes on a subject (answering with their summaries), rft_graph <id> a note's neighbours or the path to it. Open a note's file only when you need its detail; do not grep the vault.
- Every note has a one-line \`summary:\` you write: what it is about and, once known, what it found (with the key number). Pass summary to rft_add_node; when a result arrives or a direction is dropped, update it (rft_set_status summary, or rft_set_summary). Keep it specific: it is what you and later sessions read instead of the note.
- Each concept can have a digest (vault \`map/\`): its state, key results, dead ends, open questions. After a piece of work changes a concept (a result, a dropped line, a new branch), or when rft_map says its digest is missing or out of date and you have read its notes, rewrite it with rft_set_digest.
- When a result overturns an earlier one (a corrected number, a bug in the run, a better-controlled rerun), mark the old note with rft_supersede (id, by, why) and update the concept's digest: a note shown as [superseded by …] is not to be built on.
- When asked what to do next, or before opening new work, call rft_next: running and planned experiments, directions with nothing tried under them, the digests' open questions.
- Before launching an experiment (a training run, a grid, a numerical check, a measurement, a literature search for a yes or no answer), create its node first: rft_add_node with type experiment, parent = the direction it tests, status planned or running, and What / Why filled.
- When it finishes or gives a partial result, write the real numbers in its note (Result, with spread over seeds and what failed; Directions found; Code / data: commit, script, results folder, machine), then rft_set_status. Record only results that were actually obtained, never expected or invented ones.
- Every new idea or question, from a result, a reference, the user or a discussion, even if rejected: rft_add_node with type direction, parent = the note it comes from. Rejected ideas get status discussed; abandoned ones dropped; moved ones moved, with the reason (rft_set_status note).
- Literature first. When the work turns to a field or question the tree does not cover yet, ASK the user whether to run a thorough literature search before experimenting (the user can also run /rft-literature <topic>), so the work starts from prior results. When you propose a new concept, offer a search for it too; its reference notes go under the concept's start note.
- A paper, method or literature review that was read: rft_add_node with type reference, parent = the note that led to it (a review may hold one reference per key paper). Fill Source with a link that can be checked (DOI, arXiv id or URL), Summary, Method, Key results as the source reports them (and where), and your reading under Relevance. Only sources actually read: never invent a citation, or a result the source does not report. Status planned = to read, running = reading, done = summarised, dropped = not relevant.
- A definition, method, taxonomy, proof or argument of the project's own: rft_add_node with type theory, parent = the note it builds on most, every other note it builds on linked under Builds on. Status idea = draft, running = being worked out, done = settled, dropped = refuted.
- Experiments and directions name what they build on: refs (rft_add_node's refs, or rft_set_refs) links the reference notes (R..) behind them, above all the paper(s) whose setup an experiment starts from (baseline, data, protocol). A paper that is not in the tree yet becomes a reference note first.
- Give every new note 1-3 short topical tags (lowercase kebab-case, e.g. \`ablation\`, \`optimisation\`), reusing the ones rft_tags lists before inventing new ones; rft_set_tags changes them. Do not retro-tag old notes unless asked.
- Statuses: ${STATUSES.join(', ')}. Marks: ${LEGEND}.
- The tools assign ids (never reused) and strip ^ # | [ ] from titles. After editing notes by hand, run rft_sync (children / up / down, 00 Index.md, the canvas) and rft_validate.
- A note made with the wrong type: rft_set_type (the next id of the new type, the file moved, every link renamed), never a rename by hand.
- Concepts group the tree into lines of research: a note with \`concept:\` starts one, its subtree inherits it until a sub-concept starts. When a direction opens a new line of research, PROPOSE a short concept name to the user; apply it with rft_set_concept only after they confirm, never silently. rft_concepts shows the concept tree.
- A branch that sits under the wrong line of research: propose moving it, and once the user agrees use rft_move_node (the subtree follows, the note keeps its origin and a History line). Never move a note by editing its parent: by hand.
- To find what was tried, measured or read on a subject, use rft_search (titles, summaries, tags, concepts and text, best first, with the concepts whose digest matches) before reading note files one by one; check it before proposing an experiment that may already exist. rft_add_node also lists the close notes already in the tree: if one already answers or ruled out the new one, tell the user.
- Code: a concept can link the code repositories its work runs on (\`concept_repos:\` on its starting note; on the root note, the whole project's). Its notes work with its own repos first, then those of the concepts above it. When you create a concept, ask the user whether code for it already exists and where; link it with rft_set_repos (never guess a path), then read the code and give the concept's experiments and directions a ## Code section with rft_set_code.
- The ## Code section of an experiment or direction says how it relates to the code: entry points, files, functions, configs, what has to change (a short pointer for a direction). Write it from the code as it is now (the current commit and uncommitted changes), not as an older note saw it; rft_set_code records the commit it was checked against. Before working on such an experiment (planning, launching, analysing), call rft_code: it lists what changed since that commit; read the changes and update the references with rft_set_code.
- Results go in the experiment's own note: read the run's outputs where its repo keeps them, process them (seeds aggregated, tables) and write the numbers in Result; record how to reproduce them (the commit of the run, the command and config, where the raw outputs are, how they were processed) with rft_set_code's reproduce.
- The rft-manual skill is the full manual; rft_map shows the project map, rft_tree the whole tree.
${codeContext(tree, where)}
${map ? 'The project map at the start of this session (each concept with its state; rft_map <concept> for its notes)' : `The tree at the start of this session${Object.keys(tree.concepts ?? {}).length > 1 ? ', by concept (← parent, when not the line above)' : ''}`}:
${lines.join('\n')}`
}

// ---------------------------------------------------------------- export

export async function exportHtml(io: Io, loaded: Loaded, assets: PageAssets): Promise<string> {
  const path = join(loaded.config.vault, 'tree.html')
  const { tree, texts, config, signature } = loaded
  await io.write(path, staticPage(assets, tree, texts, config.project, signature.length.toString(36)))
  return path
}
