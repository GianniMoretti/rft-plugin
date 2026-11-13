// The vault model: reads the notes of a reasoning-tree vault, derives the tree from their
// `parent:` fields, and writes back everything derived from it (children / up / down
// frontmatter, the tree list of `00 Index.md`, the Obsidian canvas, the optional Mermaid
// diagram). The markdown notes are the source of truth; nothing here keeps state of its own.
//
// Every file access goes through `Io`, so the same code runs on the engine's `$.fs` and on
// an in-memory vault in tests.

import type { Milestone } from './dates'
import { S } from './dates'

/**
 * Everything that differs between node types: the id letter, the folder, the default status,
 * the sections of a new note, the section a status note goes to, and the colours of the canvas
 * card (an Obsidian preset) and the Mermaid box (a class and its style).
 */
export const TYPES = {
  experiment: {
    prefix: 'E', dir: 'experiments', plural: 'experiments', status: 'planned', code: true,
    sections: ['What', 'Why', 'Result', 'Directions found'], noteIn: 'Result',
    canvas: '5', mermaid: ['exp', 'fill:#d5f2ec,stroke:#12a594,color:#0f3a33'],
  },
  direction: {
    prefix: 'D', dir: 'directions', plural: 'directions', status: 'idea', code: false,
    sections: ['Idea', 'Why', 'Status'], noteIn: 'Status',
    canvas: '6', mermaid: ['dir', 'fill:#e9ddf7,stroke:#8e4ec6,color:#2b1a40'],
  },
  reference: {
    prefix: 'R', dir: 'references', plural: 'references', status: 'planned', code: false,
    sections: ['Source', 'Summary', 'Method', 'Key results', 'Relevance', 'Directions found'], noteIn: 'Relevance',
    canvas: '#d6336c', mermaid: ['ref', 'fill:#fde2ec,stroke:#d6336c,color:#4a0d26'],
  },
  theory: {
    prefix: 'T', dir: 'theory', plural: 'theory notes', status: 'idea', code: false,
    sections: ['Statement', 'Builds on', 'Explanation', 'Open questions', 'Status'], noteIn: 'Status',
    canvas: '#3b5bdb', mermaid: ['thy', 'fill:#dde4ff,stroke:#3b5bdb,color:#14215c'],
  },
} as const

export type NodeType = keyof typeof TYPES
export type Prefix = (typeof TYPES)[NodeType]['prefix']

export const NODE_TYPES = Object.keys(TYPES) as NodeType[]

export const isNodeType = (t: unknown): t is NodeType => (NODE_TYPES as unknown[]).includes(t)

/** An id: a type's letter and a number, the two captured. */
export const ID_RE = new RegExp(`^([${NODE_TYPES.map(t => TYPES[t].prefix).join('')}])(\\d+)$`)

/** `a or b`, `a, b or c`. */
export const orList = (items: string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}` : items.join('')

export const STATUSES = ['planned', 'running', 'done', 'idea', 'dropped', 'discussed', 'moved'] as const
export type Status = (typeof STATUSES)[number]

export const MARK: Record<string, string> = {
  done: '✓', running: '…', planned: '→', idea: '?', dropped: '✗', discussed: '·', moved: '↗',
}

export const LEGEND =
  '✓ done · … running · → planned · ? idea · ✗ dropped · · discussed, not pursued · ↗ moved'

/**
 * A note's priority, highest first: `priority:` in its frontmatter, set by the user alone (the
 * tree view's kanban and drawer); Claude only suggests one (`suggested_priority:`, with
 * `suggested_priority_why:`). A new note has none. web/kanban.js and server/rft_server.py hold
 * the same lists.
 */
export const PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const
export type Priority = (typeof PRIORITIES)[number]
export const isPriority = (p: unknown): p is Priority => (PRIORITIES as readonly unknown[]).includes(p)
/** How many open notes may hold each priority at once; low has no limit. */
export const PRIORITY_LIMITS: Record<Priority, number | null> = { urgent: 1, high: 5, medium: 10, low: null }
/** The statuses of work still to do: only their notes count towards the priority limits. */
export const OPEN_STATUSES: readonly string[] = ['idea', 'planned', 'running']

/** Characters that break Obsidian wikilinks or file names. */
export const FORBIDDEN = /[\^#|[\]\\/:*"<>?]/

export type RftNode = {
  id: string
  /** The file name without `.md`: `<id> <title>`, what wikilinks name. */
  name: string
  title: string
  type: NodeType
  status: string
  date: string
  parent: string | null
  children: string[]
  /** Relative to the vault folder, e.g. `experiments/E01 First run.md`. */
  path: string
  /** Topical tags: the note's tags less the project, type and status ones. */
  tags: string[]
  /** The id of its concept: the nearest ancestor (or itself) declaring one, else `root`. */
  concept: string
  /** `locked: true` in its frontmatter: the user's to change; Claude only suggests changes to it. */
  locked: boolean
  /** Its past parents, oldest first (`origin:`, written when the note is moved). */
  origin?: string[]
  /** The notes it builds on, usually references (`refs:`). */
  refs?: string[]
  /** One line on what the note is and, once known, what it found (`summary:`, written by Claude). */
  summary?: string
  /** The note whose result overturns this one's (`superseded_by:`): do not build on this one. */
  supersededBy?: string
  /** Its priority (`priority:`), the user's alone; none until they give it one. */
  priority?: Priority
  /** The priority Claude suggests for it (`suggested_priority:`), until the user accepts or dismisses it. */
  suggestedPriority?: Priority
  /** Why Claude suggests it (`suggested_priority_why:`). */
  suggestedWhy?: string
  /** Its own deadline (`due:`, as written: a day, a time, a zone), the user's. */
  due?: string
  /** An experiment's planned start (`start:`, a day), the user's. */
  start?: string
  /** An experiment's estimate in days (`est:` 3d, 2w), the user's. */
  est?: number
  /** The notes it waits for (`after:`): it starts once they could end. */
  after?: string[]
  /** The day it started running and the day it was done (`started:`, `finished:`, written by rft_set_status). */
  started?: string
  finished?: string
  /** How many GPUs an experiment's run takes (`gpus:`; one when not given). */
  gpus?: number
  /** The start and estimate Claude suggests (`suggested_start:`, `suggested_est:`), until the user answers, and why. */
  suggestedStart?: string
  suggestedEst?: number
  suggestedDatesWhy?: string
}

export type Tree = {
  nodes: Record<string, RftNode>
  roots: string[]
  /** The concepts by id: `root` (the top one) and one per other note that declares `concept:`. */
  concepts?: Record<string, Concept>
}

/**
 * The id of the top concept: the project, which holds every note without a concept ancestor,
 * or, when the tree's only root note declares a concept, that concept, which holds them all.
 */
export const ROOT_CONCEPT = 'root'

/**
 * A line of research: the subtree of the note that declares it (`concept:` in its
 * frontmatter), less the subtrees of the sub-concepts declared below it.
 */
export type Concept = {
  /** The declaring note's id; `root` for the top concept. */
  id: string
  name: string
  summary: string
  /** The declaring note; null for the project. */
  root: string | null
  parent: string | null
  children: string[]
  depth: number
  /** The notes of this concept itself, without its sub-concepts. */
  count: number
  /** With its sub-concepts. */
  total: number
  /** Status counts of its own notes. */
  statuses: Record<string, number>
  /**
   * The code repositories it links (`concept_repos:`), as written: absolute, `~/…` or relative
   * to the tree's folder. Its notes also work with the repos of the concepts above it, after these.
   */
  repos: string[]
}

export type Config = {
  version: number
  vault: string
  project: string
  canvas: boolean
  mermaid: boolean
  /** The last id given per type letter: ids are never reused. */
  lastId: Record<string, number>
  /** The web view's port; 0 or absent: a free one. */
  webPort?: number
  /** Warn about experiments and directions with no `refs:` (on for new vaults, off for adopted ones). */
  requireRefs?: boolean
  /** Warn about each note with no `summary:` (on for new vaults; adopted ones get one counting line). */
  requireSummaries?: boolean
  /** How many GPUs the experiments share: days on which planned and running ones need more are reported. */
  gpus?: number
}

export type Io = {
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  list: (path: string) => Promise<{ name: string; kind: string; mtimeMs: number; size: number }[]>
  exists: (path: string) => Promise<boolean>
  remove: (path: string) => Promise<void>
}

export const CONFIG_PATH = '.rft/config.json'
export const SUBDIR = Object.fromEntries(NODE_TYPES.map(t => [t, TYPES[t].dir])) as Record<NodeType, string>
export const PREFIX = Object.fromEntries(NODE_TYPES.map(t => [t, TYPES[t].prefix])) as Record<NodeType, Prefix>
export const INDEX = '00 Index.md'
export const CANVAS = 'Reasoning tree.canvas'
export const MERMAID = 'Reasoning tree (diagram).md'
/** The deadlines' folder in the vault, outside the tree, and their id letter. */
export const MILESTONES = 'milestones'
export const MILESTONE_RE = /^M(\d+)$/
/** The calendar file of the deadlines and the planned runs, regenerated. */
export const ICS = 'rft.ics'

export const join = (...parts: string[]) =>
  parts.filter(p => p !== '' && p !== '.').join('/').replace(/\/+/g, '/')

// ---------------------------------------------------------------- config

export const defaultConfig = (project: string): Config => ({
  version: 1, vault: 'vault', project, canvas: true, mermaid: false,
  lastId: Object.fromEntries(NODE_TYPES.map(t => [TYPES[t].prefix, 0])),
})

export async function readConfig(io: Io): Promise<Config | null> {
  if (!(await io.exists(CONFIG_PATH))) return null
  let raw: Partial<Config> = {}
  try {
    raw = JSON.parse(await io.read(CONFIG_PATH)) as Partial<Config>
  } catch {
    raw = {}
  }
  const base = defaultConfig(raw.project ?? 'project')
  return { ...base, ...raw, lastId: { ...base.lastId, ...(raw.lastId ?? {}) } }
}

export const writeConfig = (io: Io, config: Config) =>
  io.write(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n')

// ---------------------------------------------------------------- where the tree is

export const isAbsolute = (path: string) => /^([A-Za-z]:)?[\\/]/.test(path)

/** `rel` from `base` as an absolute path with `/` separators, `.` and `..` resolved. */
export function resolvePath(base: string, rel: string): string {
  const full = isAbsolute(rel) ? rel : `${base}/${rel}`
  const drive = /^[A-Za-z]:/.exec(full)?.[0] ?? ''
  const parts: string[] = []
  for (const part of full.slice(drive.length).split(/[\\/]+/)) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return `${drive}/${parts.join('/')}`
}

/** The same files with relative paths taken from `root` instead of the session's folder. */
export const rooted = (io: Io, root: string): Io => {
  const at = (path: string) => (isAbsolute(path) ? path : join(root, path))
  return {
    read: path => io.read(at(path)),
    write: (path, text) => io.write(at(path), text),
    list: path => io.list(at(path)),
    exists: path => io.exists(at(path)),
    remove: path => io.remove(at(path)),
  }
}

/** A tree's root folder, and the link that led to it; or, root null, why the link leads nowhere. */
export type Located = { root: string; link: string | null } | { root: null; link: string; problem: string }

/** The target of a config that is a link to a tree elsewhere (`{"tree": "../notes"}`), else null. */
async function linkIn(io: Io, path: string): Promise<string | null> {
  try {
    const tree = (JSON.parse(await io.read(path)) as { tree?: unknown }).tree
    return typeof tree === 'string' && tree.trim() ? tree.trim() : null
  } catch {
    return null
  }
}

/**
 * The tree a session in `cwd` works on: the nearest folder, from `cwd` up, with `.rft/config.json`.
 * A config that is a link leads to the tree's own folder, one step only. Null when there is none.
 */
export async function locate(io: Io, cwd: string): Promise<Located | null> {
  for (let dir = resolvePath(cwd, '.'); ; dir = resolvePath(dir, '..')) {
    const file = join(dir, CONFIG_PATH)
    if (await io.exists(file)) {
      const target = await linkIn(io, file)
      if (target === null) return { root: dir, link: null }
      const root = resolvePath(dir, target)
      const there = join(root, CONFIG_PATH)
      if (!(await io.exists(there))) return { root: null, link: file, problem: `${file} links to ${root}, which holds no reasoning tree (no ${CONFIG_PATH})` }
      if ((await linkIn(io, there)) !== null) return { root: null, link: file, problem: `${file} links to ${root}, which is itself a link: point it at the tree's own folder` }
      return { root, link: file }
    }
    if (resolvePath(dir, '..') === dir) return null
  }
}

// ---------------------------------------------------------------- frontmatter

const normalise = (text: string) => text.replace(/\r\n/g, '\n')

/** The one-line `key: value` fields of the frontmatter, values as written. */
export function front(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(normalise(text))
  const out: Record<string, string> = {}
  for (const line of m ? m[1]!.split('\n') : []) {
    const at = line.indexOf(':')
    if (at <= 0 || /^\s/.test(line)) continue
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return out
}

/** The first wikilink target in a value (`"[[D00 Root]]"` gives `D00 Root`). */
export const linkTarget = (value: string | undefined): string | null => {
  const m = /\[\[([^\]|#]+)/.exec(value ?? '')
  return m ? m[1]!.trim() : null
}

export const linksIn = (value: string | undefined): string[] =>
  [...(value ?? '').matchAll(/\[\[([^\]|#]+)/g)].map(m => m[1]!.trim())

/** Splits a note into its frontmatter lines and its body (after the closing `---`). */
function split(text: string): { head: string[]; body: string } | null {
  const t = normalise(text)
  if (!t.startsWith('---\n')) return null
  const end = t.indexOf('\n---', 4)
  if (end < 0) return null
  const after = t.indexOf('\n', end + 4)
  return { head: t.slice(4, end).split('\n'), body: after < 0 ? '' : t.slice(after + 1) }
}

const joinNote = (head: string[], body: string) => `---\n${head.join('\n')}\n---\n${body}`

/**
 * Sets a one-line frontmatter field: in place when it exists, else after `after`
 * (or `children:`, or at the end).
 */
export function setField(text: string, key: string, value: string, after?: string): string {
  const parts = split(text)
  if (!parts) return text
  const head = [...parts.head]
  const line = `${key}: ${value}`
  const at = head.findIndex(l => l.startsWith(key + ':'))
  if (at >= 0) {
    head[at] = line
    // drop duplicates of the key, keeping the first
    for (let i = head.length - 1; i > at; i--) if (head[i]!.startsWith(key + ':')) head.splice(i, 1)
  } else {
    const anchor = [after, 'children', 'parent'].filter(Boolean) as string[]
    let pos = head.length
    for (const a of anchor) {
      const i = head.findIndex(l => l.startsWith(a + ':'))
      if (i >= 0) { pos = i + 1; break }
    }
    head.splice(pos, 0, line)
  }
  return joinNote(head, parts.body)
}

export const bodyOf = (text: string) => split(text)?.body ?? normalise(text)

// ---------------------------------------------------------------- names and ids

/** Natural order of note names: by id letter, then id number, then the rest. */
export function compareNames(a: string, b: string): number {
  const pa = /^([A-Za-z]+)(\d+)(.*)$/.exec(a)
  const pb = /^([A-Za-z]+)(\d+)(.*)$/.exec(b)
  if (pa && pb) {
    if (pa[1] !== pb[1]) return pa[1]! < pb[1]! ? -1 : 1
    const d = Number(pa[2]) - Number(pb[2])
    if (d !== 0) return d
    return pa[3]! < pb[3]! ? -1 : pa[3]! > pb[3]! ? 1 : 0
  }
  return a < b ? -1 : a > b ? 1 : 0
}

export const idOf = (name: string) => name.split(' ')[0] ?? name

// ---------------------------------------------------------------- tags

/** The tags of a one-line `tags:` value: `[a, b]`, `a, b` or `#a #b`. */
export function parseTags(value: string | undefined): string[] {
  const v = (value ?? '').trim().replace(/^\[|\]$/g, '')
  return v.split(/[,\s]+/).map(t => t.trim().replace(/^["']|["']$/g, '').replace(/^#/, '')).filter(Boolean)
}

/**
 * The tags every note carries anyway: the project, its own type and its status. Another type's
 * name is a topical tag like any other (a direction may be tagged `theory`).
 */
export const isReservedTag = (tag: string, project: string, type: string) =>
  tag === project || tag === type || (STATUSES as readonly string[]).includes(tag)

export const topicalTags = (tags: string[], project: string, type: string) =>
  [...new Set(tags.filter(t => !isReservedTag(t, project, type)))]

/** A topical tag as the manual wants it: lowercase kebab-case. */
export const sanitiseTag = (tag: string) =>
  tag.toLowerCase().replace(/^#/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

export const isKebab = (tag: string) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(tag)

/** The topical tags in use with their counts, most used first. */
export function tagCounts(tree: Tree): { tag: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const n of Object.values(tree.nodes)) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1))
}

/** The `tags:` line: project, type, the topical tags, status (the order the notes use). */
export const tagsLine = (project: string, type: string, topical: string[], status: string) =>
  `[${[project, type, ...topical, status].filter(Boolean).join(', ')}]`

/** Replaces a note's topical tags, keeping its project, type and status tags. */
export function withTopicalTags(text: string, n: RftNode, project: string, tags: string[]): string {
  return setField(text, 'tags', tagsLine(project, n.type, topicalTags(tags.map(sanitiseTag).filter(Boolean), project, n.type), n.status))
}

/**
 * Makes a title safe for Obsidian: `^` becomes "to the power", `[ ]` become `( )`,
 * `#` becomes "no.", `|` `:` `/` `\` become commas or dashes, and `* " < > ?` go.
 */
export function sanitiseTitle(title: string): string {
  return title
    .replace(/\^/g, ' to the power ')
    .replace(/\[/g, '(').replace(/\]/g, ')')
    .replace(/#/g, 'no. ')
    .replace(/[|:]/g, ',')
    .replace(/[/\\]/g, '-')
    .replace(/[*"<>?]/g, '')
    .replace(/\s+,/g, ',')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,-]+|[\s.,-]+$/g, '')
    .slice(0, 100)
    .trim()
}

export const formatId = (prefix: Prefix, n: number) => `${prefix}${String(n).padStart(2, '0')}`

// ---------------------------------------------------------------- loading

export type Loaded = {
  config: Config
  tree: Tree
  /** File text per node id, as read. */
  texts: Record<string, string>
  /** Problems met while reading (unparsable notes, duplicate ids, missing parents). */
  problems: string[]
  /** Changes when any note is added, removed or edited. */
  signature: string
  /** The deadlines in the vault's `milestones/`, by id. */
  milestones: Milestone[]
}

export async function signatureOf(io: Io, vault: string): Promise<string> {
  const parts: string[] = []
  for (const sub of [...Object.values(SUBDIR), MILESTONES]) {
    const dir = join(vault, sub)
    if (!(await io.exists(dir))) continue
    for (const f of await io.list(dir)) {
      if (f.kind === 'file' && f.name.endsWith('.md')) parts.push(`${sub}/${f.name}:${f.mtimeMs}:${f.size}`)
    }
  }
  return parts.sort().join('|')
}

export async function load(io: Io, config: Config): Promise<Loaded> {
  const nodes: Record<string, RftNode> = {}
  const texts: Record<string, string> = {}
  const problems: string[] = []
  const parentRef: Record<string, string | null> = {}
  const originRef: Record<string, string[]> = {}
  const refsRef: Record<string, string[]> = {}
  const supersededRef: Record<string, string | null> = {}
  const afterRef: Record<string, string[]> = {}
  for (const [type, sub] of Object.entries(SUBDIR) as [NodeType, string][]) {
    const dir = join(config.vault, sub)
    if (!(await io.exists(dir))) continue
    const files = (await io.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.md'))
    for (const f of files.sort((a, b) => compareNames(a.name, b.name))) {
      const name = f.name.slice(0, -3)
      const path = `${sub}/${f.name}`
      const text = normalise(await io.read(join(config.vault, path)))
      const fm = front(text)
      const id = fm.id || idOf(name)
      if (nodes[id]) {
        problems.push(`duplicate id ${id}: ${nodes[id]!.path} and ${path}`)
        continue
      }
      const fmType = isNodeType(fm.type) ? fm.type : type
      nodes[id] = {
        id, name, title: name.slice(idOf(name).length).trim(), type: fmType,
        status: fm.status ?? '', date: fm.date ?? '', parent: null, children: [], path,
        tags: topicalTags(parseTags(fm.tags), config.project, fmType),
        concept: ROOT_CONCEPT,
        locked: ['true', 'yes'].includes(unquote(fm.locked).toLowerCase()),
      }
      const summary = unquoteJson(fm.summary)
      if (summary) nodes[id]!.summary = summary
      const priority = unquote(fm.priority).toLowerCase()
      if (isPriority(priority)) nodes[id]!.priority = priority
      const suggested = unquote(fm.suggested_priority).toLowerCase()
      if (isPriority(suggested)) {
        nodes[id]!.suggestedPriority = suggested
        const why = unquoteJson(fm.suggested_priority_why)
        if (why) nodes[id]!.suggestedWhy = why
      }
      readPlan(nodes[id]!, fm)
      afterRef[id] = linksIn(fm.after)
      texts[id] = text
      parentRef[id] = linkTarget(fm.parent)
      originRef[id] = linksIn(fm.origin)
      refsRef[id] = linksIn(fm.refs)
      supersededRef[id] = linkTarget(fm.superseded_by)
    }
  }
  const byName: Record<string, string> = {}
  for (const n of Object.values(nodes)) byName[n.name] = n.id
  const idsOf = (refs: string[]) => refs.map(ref => byName[ref] ?? (nodes[idOf(ref)] ? idOf(ref) : null)).filter((id): id is string => id !== null)
  for (const n of Object.values(nodes)) {
    const past = idsOf(originRef[n.id]!)
    if (past.length) n.origin = past
    const refs = idsOf(refsRef[n.id]!)
    if (refs.length) n.refs = refs
    const by = supersededRef[n.id] ? idsOf([supersededRef[n.id]!])[0] : undefined
    if (by && by !== n.id) n.supersededBy = by
    const after = idsOf(afterRef[n.id]!).filter(id => id !== n.id)
    if (after.length) n.after = after
  }
  for (const n of Object.values(nodes)) {
    const ref = parentRef[n.id]
    if (!ref) continue
    // by name; else by a leading id (the parent was renamed but kept its id)
    const pid = byName[ref] ?? (nodes[idOf(ref)] ? idOf(ref) : undefined)
    if (pid && pid !== n.id) n.parent = pid
    else problems.push(`${n.id}: parent "${ref}" not found`)
  }
  // break cycles: a node whose ancestor chain returns to itself becomes a root
  for (const n of Object.values(nodes)) {
    const seen = new Set<string>([n.id])
    let p = n.parent
    while (p) {
      if (seen.has(p)) {
        problems.push(`${n.id}: the parent chain forms a cycle`)
        n.parent = null
        break
      }
      seen.add(p)
      p = nodes[p]?.parent ?? null
    }
  }
  const roots: string[] = []
  for (const n of Object.values(nodes)) {
    if (n.parent) nodes[n.parent]!.children.push(n.id)
    else roots.push(n.id)
  }
  const byNameCmp = (a: string, b: string) => compareNames(nodes[a]!.name, nodes[b]!.name)
  for (const n of Object.values(nodes)) n.children.sort(byNameCmp)
  roots.sort(byNameCmp)
  const tree: Tree = { nodes, roots }
  tree.concepts = computeConcepts(tree, config.project, conceptDeclarations(texts))
  const milestones = await loadMilestones(io, config.vault, byName, nodes)
  return { config, tree, texts, problems, signature: await signatureOf(io, config.vault), milestones }
}

/** A whole number above 0, or undefined. */
const count = (v: string | undefined) => (/^\d+$/.test(unquote(v)) && Number(unquote(v)) > 0 ? Number(unquote(v)) : undefined)

/** A note's dates and GPUs, read from its frontmatter; a value that is none is left out (the validator names it). */
function readPlan(n: RftNode, fm: Record<string, string>) {
  const due = unquote(fm.due)
  if (due && S.parseDue(due)) n.due = due
  const start = S.parseDay(fm.start)
  if (start) n.start = start
  const est = S.parseEst(fm.est)
  if (est) n.est = est
  const started = S.parseDay(fm.started)
  if (started) n.started = started
  const finished = S.parseDay(fm.finished)
  if (finished) n.finished = finished
  const gpus = count(fm.gpus)
  if (gpus) n.gpus = gpus
  const sStart = S.parseDay(fm.suggested_start)
  if (sStart) n.suggestedStart = sStart
  const sEst = S.parseEst(fm.suggested_est)
  if (sEst) n.suggestedEst = sEst
  if ((sStart || sEst) && unquoteJson(fm.suggested_dates_why)) n.suggestedDatesWhy = unquoteJson(fm.suggested_dates_why)
}

/** The deadlines in `milestones/`: their due date, status, and the notes they need (by id; the names that are none apart). */
export async function loadMilestones(io: Io, vault: string, byName: Record<string, string>, nodes: Record<string, RftNode>): Promise<Milestone[]> {
  const dir = join(vault, MILESTONES)
  if (!(await io.exists(dir))) return []
  const out: Milestone[] = []
  const files = (await io.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.md'))
  for (const f of files.sort((a, b) => compareNames(a.name, b.name))) {
    const name = f.name.slice(0, -3)
    const fm = front(normalise(await io.read(join(dir, f.name))))
    const id = unquote(fm.id) || idOf(name)
    if (out.some(m => m.id === id)) continue
    const needs: string[] = []
    const missing: string[] = []
    for (const ref of linksIn(fm.needs)) {
      const nid = byName[ref] ?? (nodes[idOf(ref)] ? idOf(ref) : null)
      if (nid) { if (!needs.includes(nid)) needs.push(nid) } else missing.push(ref)
    }
    const m: Milestone = {
      id, name, title: name.slice(idOf(name).length).trim(), path: `${MILESTONES}/${f.name}`,
      status: unquote(fm.status).toLowerCase() || 'open', due: S.parseDue(unquote(fm.due)), dueText: unquote(fm.due), needs, missing,
    }
    if (unquote(fm.source)) m.source = unquote(fm.source)
    if (unquoteJson(fm.why)) m.why = unquoteJson(fm.why)
    out.push(m)
  }
  return out
}

// ---------------------------------------------------------------- concepts

/** A frontmatter value without the quotes YAML allows around it. */
export const unquote = (v: string | undefined) => (v ?? '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim()

/** A value written with JSON.stringify (escapes and all), or any other quoted or bare one. */
export function unquoteJson(v: string | undefined): string {
  const t = (v ?? '').trim()
  if (/^".*"$/.test(t)) {
    try { return String(JSON.parse(t)).trim() } catch { /* not JSON: as written */ }
  }
  return unquote(t)
}

/** What a note's frontmatter says of a concept: its name (empty when it declares none), summary, repos. */
export type Declaration = { name: string; summary: string; repos?: string[] }

/**
 * The notes that declare a concept (`concept:`, `concept_summary:`, `concept_repos:` in the
 * frontmatter), and those that link repos without one: on the only root note those are the
 * project's own.
 */
export function conceptDeclarations(texts: Record<string, string>): Record<string, Declaration> {
  const out: Record<string, Declaration> = {}
  for (const [id, text] of Object.entries(texts)) {
    const fm = front(text)
    const name = unquote(fm.concept)
    const repos = parseRepos(fm.concept_repos)
    if (name || repos.length) out[id] = { name, summary: name ? unquote(fm.concept_summary) : '', repos }
  }
  return out
}

/**
 * Concept membership, inherited down the tree: every note belongs to its nearest ancestor (or
 * itself) declaring a concept, else to the project root concept. Sets `concept` on every node.
 * When the only root note declares a concept, that concept is the root one: the project above
 * it would hold no note. The repos the only root note links are the root concept's either way.
 */
export function computeConcepts(tree: Tree, project: string, decl: Record<string, Declaration>): Record<string, Concept> {
  const make = (id: string, name: string, summary: string, root: string | null, parent: string | null, depth: number, repos: string[] = []): Concept =>
    ({ id, name, summary, root, parent, children: [], depth, count: 0, total: 0, statuses: {}, repos })
  const only = tree.roots.length === 1 ? tree.roots[0]! : null
  const top = only && tree.nodes[only] && decl[only]?.name ? only : null
  const rootRepos = only ? decl[only]?.repos ?? [] : []
  const concepts: Record<string, Concept> = {
    [ROOT_CONCEPT]: top ? make(ROOT_CONCEPT, decl[top]!.name, decl[top]!.summary, top, null, 0, rootRepos) : make(ROOT_CONCEPT, project, '', null, null, 0, rootRepos),
  }
  const visit = (id: string, current: string) => {
    const n = tree.nodes[id]
    if (!n) return
    const d = id === top ? undefined : decl[id]
    if (d?.name) {
      concepts[id] = make(id, d.name, d.summary, id, current, concepts[current]!.depth + 1, d.repos)
      concepts[current]!.children.push(id)
      current = id
    }
    n.concept = current
    const c = concepts[current]!
    c.count += 1
    c.statuses[n.status] = (c.statuses[n.status] ?? 0) + 1
    for (const k of n.children) visit(k, current)
  }
  for (const r of tree.roots) visit(r, ROOT_CONCEPT)
  const total = (id: string): number => {
    const c = concepts[id]!
    c.total = c.count + c.children.reduce((s, k) => s + total(k), 0)
    return c.total
  }
  total(ROOT_CONCEPT)
  return concepts
}

/** The concept a note declares, if any (the root concept too, when the root note declares it). */
export function declaredConcept(concepts: Record<string, Concept> | undefined, id: string): Concept | undefined {
  return Object.values(concepts ?? {}).find(c => c.root === id)
}

/** The concept ids from the root concept down to `id`. */
export function conceptPath(concepts: Record<string, Concept>, id: string): string[] {
  const out: string[] = []
  for (let c: Concept | undefined = concepts[id]; c; c = c.parent ? concepts[c.parent] : undefined) out.unshift(c.id)
  return out
}

/** The concepts in tree order (depth first from the root concept). */
export function conceptOrder(concepts: Record<string, Concept>): Concept[] {
  const out: Concept[] = []
  const go = (id: string) => { const c = concepts[id]; if (!c) return; out.push(c); c.children.forEach(go) }
  go(ROOT_CONCEPT)
  return out
}

export const statusSummary = (statuses: Record<string, number>) =>
  STATUSES.filter(st => statuses[st]).map(st => `${MARK[st]}${statuses[st]}`).join(' ')

// ---------------------------------------------------------------- code repos

/** A repo a note works with, and the concept that links it: the note's own, or one above it. */
export type CodeRepo = { path: string; concept: string }

const cleanRepos = (list: string[]) => [...new Set(list.map(p => unquote(p)).filter(Boolean))]

/** The paths of a `concept_repos:` value, a one-line list: `["/a/b", "../c"]` (or YAML's `['/a/b', ../c]`). */
export function parseRepos(value: string | undefined): string[] {
  const v = (value ?? '').trim()
  if (!v) return []
  try {
    const x: unknown = JSON.parse(v)
    if (Array.isArray(x)) return cleanRepos(x.filter((p): p is string => typeof p === 'string'))
    if (typeof x === 'string') return cleanRepos([x])
  } catch { /* a YAML list, or a bare path */ }
  // commas alone separate: a path may hold spaces
  return cleanRepos(v.replace(/^\[|\]$/g, '').split(','))
}

/** The `concept_repos:` value: a one-line list Obsidian reads as a list property. */
export const reposLine = (repos: string[]) => `[${repos.map(p => JSON.stringify(p)).join(', ')}]`

/**
 * The repos the notes of a concept work with, by priority: the concept's own, then those of each
 * concept above it, nearest first; a path once, at its highest place.
 */
export function codeRepos(concepts: Record<string, Concept> | undefined, id: string): CodeRepo[] {
  const out: CodeRepo[] = []
  const seen = new Set<string>()
  for (let c = concepts?.[id]; c; c = c.parent ? concepts?.[c.parent] : undefined) {
    for (const path of c.repos ?? []) {
      if (seen.has(path)) continue
      seen.add(path)
      out.push({ path, concept: c.id })
    }
  }
  return out
}

/** Where a repo is on disk: an absolute path, `~/…` in the home folder, else from the tree's folder `root`. */
export function repoAbs(root: string, path: string, home?: string): string {
  if (home && (path === '~' || path.startsWith('~/'))) return resolvePath(home, path.slice(2) || '.')
  return resolvePath(root, path)
}

/**
 * The notes a concept's code concerns: experiments and directions, less the ideas discussed and
 * not pursued, or moved elsewhere.
 */
export const needsCode = (n: { type: string; status: string }) => (n.type === 'experiment' || n.type === 'direction') && n.status !== 'discussed' && n.status !== 'moved'

export const CODE = 'Code'
const REPRODUCE = '**Reproduce:**'

/** A repo line of a `## Code` section, as rft_set_code writes it: ``- `path` @ <commit> (…) · checked <date>``. */
const REPO_LINE = /^- `([^`]+)`(?: @ ([0-9a-f]{7,40})\b)?/

export type CodeSection = {
  /** The repos it was last checked against, with the commit of each (null: none recorded). */
  repos: { path: string; commit: string | null; line: string }[]
  /** How the note relates to the code. */
  description: string
  /** How to reproduce the note's results, after `**Reproduce:**`. */
  reproduce: string
}

/** The body's lines, each with whether it is a `## ` heading outside a fenced block. */
function bodyLines(body: string): { line: string; isHeading: boolean }[] {
  let isFenced = false
  return body.split('\n').map(line => {
    if (/^\s*(```|~~~)/.test(line)) isFenced = !isFenced
    return { line, isHeading: !isFenced && line.startsWith('## ') }
  })
}

/** Where a section's lines are among `lines`: from its heading to the next heading; null when absent. */
function sectionAt(lines: { line: string; isHeading: boolean }[], title: string): { start: number; end: number } | null {
  const start = lines.findIndex(l => l.isHeading && l.line.slice(3).trim() === title)
  if (start < 0) return null
  const next = lines.findIndex((l, i) => i > start && l.isHeading)
  return { start, end: next < 0 ? lines.length : next }
}

/** A note's `## Code` section, read back; null when it has none. */
export function codeSection(text: string): CodeSection | null {
  const lines = bodyLines(bodyOf(text))
  const at = sectionAt(lines, CODE)
  if (!at) return null
  const inner = lines.slice(at.start + 1, at.end).map(l => l.line)
  let i = 0
  while (i < inner.length && !inner[i]!.trim()) i++
  const repos: CodeSection['repos'] = []
  for (let m; i < inner.length && (m = REPO_LINE.exec(inner[i]!)); i++) repos.push({ path: m[1]!, commit: m[2] ?? null, line: inner[i]! })
  const rest = inner.slice(i)
  const r = rest.findIndex(l => l.startsWith(REPRODUCE))
  const description = (r < 0 ? rest : rest.slice(0, r)).join('\n').trim()
  const reproduce = r < 0 ? '' : [rest[r]!.slice(REPRODUCE.length), ...rest.slice(r + 1)].join('\n').trim()
  return { repos, description, reproduce }
}

/**
 * The note with its `## Code` section written: the repo lines, the description, the Reproduce
 * part. A description or reproduce left undefined keeps what the section held. A new section
 * goes before the one status notes go to (Result for an experiment, Status for a direction),
 * else before the children list, else last.
 */
export function withCodeSection(text: string, type: NodeType, parts: { repos: string[]; description?: string; reproduce?: string }): string {
  const t = normalise(text)
  const head = split(t)
  const body = head ? head.body : t
  const was = codeSection(t)
  const description = (parts.description ?? was?.description ?? '').trim()
  const reproduce = (parts.reproduce ?? was?.reproduce ?? '').trim()
  const block = [
    `## ${CODE}`,
    ...parts.repos,
    ...(description ? ['', description] : []),
    ...(reproduce ? ['', `${REPRODUCE} ${reproduce}`] : []),
    '',
  ]
  const lines = bodyLines(body)
  const raw = lines.map(l => l.line)
  const at = sectionAt(lines, CODE)
  if (at) raw.splice(at.start, at.end - at.start, ...block)
  else {
    const before = sectionAt(lines, TYPES[type].noteIn) ?? sectionAt(lines, 'Children in the tree')
    if (before) raw.splice(before.start, 0, ...block)
    else raw.push(...(raw[raw.length - 1]?.trim() ? [''] : []), ...block)
  }
  const next = raw.join('\n')
  return head ? joinNote(head.head, next) : next
}

/** Removes a one-line frontmatter field, if present. */
export function removeField(text: string, key: string): string {
  const parts = split(text)
  if (!parts) return text
  return joinNote(parts.head.filter(l => !l.startsWith(key + ':')), parts.body)
}

// ---------------------------------------------------------------- tree text

export function walk(tree: Tree, visit: (n: RftNode, depth: number) => boolean | void, from?: string[]) {
  const go = (id: string, depth: number) => {
    const n = tree.nodes[id]
    if (!n) return
    if (visit(n, depth) === false) return
    for (const k of n.children) go(k, depth + 1)
  }
  for (const r of from ?? tree.roots) go(r, 0)
}

/** The index list: `- ✓ [[D00 Root]]`, four spaces per level, as Obsidian nests lists. */
export function indexLines(tree: Tree): string[] {
  const lines: string[] = []
  walk(tree, (n, d) => { lines.push(`${'    '.repeat(d)}- ${MARK[n.status] ?? ''} [[${n.name}]]`) })
  return lines
}

/** A compact plain-text tree for the model or a terminal: `  ✓ D00 Root (done)`. */
export function compactTree(tree: Tree, opts: { root?: string; depth?: number; withStatus?: boolean } = {}): string {
  const lines: string[] = []
  const from = opts.root ? [opts.root] : undefined
  walk(tree, (n, d) => {
    if (opts.depth !== undefined && d > opts.depth) return false
    const more = opts.depth !== undefined && d === opts.depth && n.children.length ? ` [+${n.children.length}]` : ''
    lines.push(`${'  '.repeat(d)}${MARK[n.status] ?? '-'} ${n.name}${opts.withStatus ? ` (${n.status})` : ''}${more}`)
  }, from)
  return lines.join('\n')
}

export function counts(tree: Tree): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(NODE_TYPES.map(t => [t, 0]))
  for (const n of Object.values(tree.nodes)) {
    out[n.type] = (out[n.type] ?? 0) + 1
    out[n.status] = (out[n.status] ?? 0) + 1
  }
  return out
}

/** `3 directions, 5 experiments`: the note count of every type, by id letter as notes sort. */
export const countsLine = (c: Record<string, number>) =>
  [...NODE_TYPES].sort((a, b) => (TYPES[a].prefix < TYPES[b].prefix ? -1 : 1)).map(t => `${c[t] ?? 0} ${TYPES[t].plural}`).join(', ')

// ---------------------------------------------------------------- derived files

const linkList = (names: string[]) => '[' + names.map(n => `"[[${n}]]"`).join(', ') + ']'

/** The frontmatter fields derived from the tree: children, up and down. */
export function derivedFields(tree: Tree, n: RftNode): Record<string, string> {
  const kids = n.children.map(k => tree.nodes[k]!.name)
  const up = n.parent ? `"[[${tree.nodes[n.parent]!.name}]]"` : '""'
  return { children: linkList(kids), up, down: linkList(kids) }
}

/** The same links in any order: a hand-ordered `children:` list is kept as it is. */
const sameLinks = (a: string | undefined, b: string) => {
  const x = linksIn(a).sort(), y = linksIn(b).sort()
  return a !== undefined && x.length === y.length && x.every((v, i) => v === y[i])
}

export function withDerived(tree: Tree, n: RftNode, text: string): string {
  const f = derivedFields(tree, n)
  const current = front(text).children
  let out = sameLinks(current, f.children!) ? text : setField(text, 'children', f.children!, 'parent')
  out = setField(out, 'up', f.up!, 'children')
  out = setField(out, 'down', f.down!, 'up')
  return out
}

/** Rewrites the list under `## The tree`, keeping the section's prose lines. */
export function withIndexTree(index: string, tree: Tree): string {
  const text = normalise(index)
  const marker = '## The tree\n'
  const at = text.indexOf(marker)
  const lines = indexLines(tree)
  if (at < 0) return text.replace(/\n*$/, '\n\n') + marker + '\n' + lines.join('\n') + '\n'
  const head = text.slice(0, at + marker.length)
  const rest = text.slice(at + marker.length)
  const nxt = rest.indexOf('\n## ')
  const section = nxt >= 0 ? rest.slice(0, nxt) : rest
  const intro = section.split('\n').filter(l => l && !l.trimStart().startsWith('- '))
  const tail = nxt >= 0 ? rest.slice(nxt) : '\n'
  const body = (intro.length ? intro.join('\n') + '\n\n' : '') + lines.join('\n') + '\n'
  return head + body + tail
}

type CanvasNode = { id: string; type: string; text: string; x: number; y: number; width: number; height: number; color: string }
const CW = 300, CH = 110, CGX = 40, CGY = 70
const STATUS_COLOR: Record<string, string> = { running: '2', planned: '3', idea: '3', dropped: '1', discussed: '1' }

/** The Obsidian canvas: parents centred over their children; moved cards keep their place. */
export function canvasJson(tree: Tree, previous?: string, relayout = false): string {
  const pos = new Map<string, [number, number]>()
  let nextX = 0
  const place = (id: string, depth: number) => {
    const kids = tree.nodes[id]!.children
    for (const k of kids) place(k, depth + 1)
    let x: number
    if (kids.length) x = (pos.get(kids[0]!)![0] + pos.get(kids[kids.length - 1]!)![0]) / 2
    else { x = nextX; nextX += CW + CGX }
    pos.set(id, [x, depth * (CH + CGY)])
  }
  for (const r of tree.roots) place(r, 0)
  const old = new Map<string, [number, number, number, number]>()
  if (previous && !relayout) {
    try {
      for (const nd of (JSON.parse(previous) as { nodes?: CanvasNode[] }).nodes ?? []) {
        old.set(nd.id, [nd.x, nd.y, nd.width ?? CW, nd.height ?? CH])
      }
    } catch { /* an unreadable canvas is laid out afresh */ }
  }
  const nodes: CanvasNode[] = []
  const edges: { id: string; fromNode: string; fromSide: string; toNode: string; toSide: string }[] = []
  for (const [id, [px, py]] of pos) {
    const n = tree.nodes[id]!
    const [x, y, w, h] = old.get(id) ?? [px, py, CW, CH]
    const color = STATUS_COLOR[n.status] ?? TYPES[n.type]?.canvas ?? '0'
    const text = `**${id}** · ${MARK[n.status] ?? ''} ${n.status}\n\n[[${n.name}|${n.title}]]`
    nodes.push({ id, type: 'text', text, x: Math.trunc(x), y: Math.trunc(y), width: w, height: h, color })
    if (n.parent) edges.push({ id: `${n.parent}-${id}`, fromNode: n.parent, fromSide: 'bottom', toNode: id, toSide: 'top' })
  }
  return JSON.stringify({ nodes, edges }, null, 1)
}

/** The canvas with note `from`'s card given to `to`, so a note that changes id keeps its place. */
export function withCardRenamed(canvas: string, from: string, to: string): string {
  try {
    const c = JSON.parse(canvas) as { nodes?: CanvasNode[] }
    for (const nd of c.nodes ?? []) if (nd.id === from) nd.id = to
    return JSON.stringify(c, null, 1)
  } catch {
    return canvas
  }
}

export function mermaidNote(tree: Tree): string {
  // children before their parent, the order the canvas layout visits them
  const ids: string[] = []
  const post = (id: string) => { for (const k of tree.nodes[id]!.children) post(k); ids.push(id) }
  for (const r of tree.roots) post(r)
  const cls = (n: RftNode) =>
    ({ running: 'run', planned: 'todo', idea: 'todo', dropped: 'drop', discussed: 'drop', moved: 'drop' } as Record<string, string>)[n.status] ??
    (TYPES[n.type]?.mermaid[0] ?? 'dir')
  const lines = ['flowchart TD']
  for (const id of ids) lines.push(`    ${id}["${tree.nodes[id]!.name.replace(/"/g, "'")}"]:::${cls(tree.nodes[id]!)}`)
  for (const id of ids) if (tree.nodes[id]!.parent) lines.push(`    ${tree.nodes[id]!.parent} --> ${id}`)
  if (ids.length) lines.push(`    class ${ids.join(',')} internal-link`)
  lines.push(
    ...NODE_TYPES.map(t => `    classDef ${TYPES[t].mermaid[0]} ${TYPES[t].mermaid[1]}`),
    '    classDef run fill:#ffe1cc,stroke:#f76b15,color:#4a2104',
    '    classDef todo fill:#fff3c4,stroke:#c9a300,color:#3d3200',
    '    classDef drop fill:#f3f3f3,stroke:#999999,color:#555555',
  )
  return (
    '# Reasoning tree (diagram)\n\n' +
    'Generated by the rft plugin from the `parent:` fields: do not edit. Purple = direction, ' +
    'green = experiment, pink = reference, blue = theory, orange = running, yellow = idea / planned, grey = dropped, discussed ' +
    'or moved. Click a box to open the note. Open in reading view.\n\n' +
    '```mermaid\n' + lines.join('\n') + '\n```\n'
  )
}

export type SyncReport = { changed: string[] }

/** Writes every derived file whose content differs from what the tree implies. */
export async function sync(io: Io, loaded: Loaded, opts: { relayout?: boolean } = {}): Promise<SyncReport> {
  const { config, tree, texts } = loaded
  const changed: string[] = []
  const put = async (rel: string, next: string, prev?: string) => {
    if (prev === next) return
    await io.write(join(config.vault, rel), next)
    changed.push(rel)
  }
  for (const n of Object.values(tree.nodes)) {
    const prev = texts[n.id]!
    let next = withDerived(tree, n, prev)
    for (const k of n.children) next = withChildListed(next, tree.nodes[k]!.name)
    texts[n.id] = next
    await put(n.path, next, prev)
  }
  const indexPath = join(config.vault, INDEX)
  const index = (await io.exists(indexPath)) ? normalise(await io.read(indexPath)) : indexTemplate(config.project)
  await put(INDEX, withIndexTree(index, tree), (await io.exists(indexPath)) ? index : undefined)
  if (config.canvas) {
    const cp = join(config.vault, CANVAS)
    const prev = (await io.exists(cp)) ? await io.read(cp) : undefined
    await put(CANVAS, canvasJson(tree, prev, opts.relayout), prev)
  }
  if (config.mermaid) {
    const mp = join(config.vault, MERMAID)
    await put(MERMAID, mermaidNote(tree), (await io.exists(mp)) ? await io.read(mp) : undefined)
  }
  // the calendar file, once there is a date to show; its stamp kept while nothing else changes
  const ip = join(config.vault, ICS)
  const prevIcs = (await io.exists(ip)) ? await io.read(ip) : undefined
  const calendar = (stamp: string) => S.ics({ project: config.project, nodes: Object.values(tree.nodes), milestones: loaded.milestones ?? [], stamp })
  const kept = prevIcs && /DTSTAMP:(\d{8}T\d{6}Z)/.exec(prevIcs)
  const same = kept ? calendar(kept[1]!) : null
  if (!(same && same.text === prevIcs)) {
    const fresh = calendar(new Date().toISOString())
    if (fresh.events || prevIcs !== undefined) await put(ICS, fresh.text, prevIcs)
  }
  loaded.signature = await signatureOf(io, config.vault)
  return { changed }
}

// ---------------------------------------------------------------- validation

export type Validation = { errors: string[]; warnings: string[] }

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i
const stripCode = (text: string) => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')

async function allFiles(io: Io, dir: string, rel = ''): Promise<string[]> {
  const out: string[] = []
  for (const f of await io.list(join(dir, rel))) {
    if (f.name.startsWith('.')) continue
    const r = rel ? `${rel}/${f.name}` : f.name
    if (f.kind === 'dir') out.push(...(await allFiles(io, dir, r)))
    else out.push(r)
  }
  return out
}

/** Experiments and directions being or done carry references; rejected or moved ones need none. */
export const needsRefs = (n: RftNode) =>
  (n.type === 'experiment' || n.type === 'direction') && !['discussed', 'dropped', 'moved'].includes(n.status)

/** Whether a folder is in a git repository: it or a folder above it holds `.git`. */
export async function isInGit(io: Io, abs: string): Promise<boolean> {
  for (let dir = abs; ; dir = resolvePath(dir, '..')) {
    if (await io.exists(join(dir, '.git'))) return true
    if (resolvePath(dir, '..') === dir) return false
  }
}

/**
 * `root`: the tree's folder, which relative repo paths start from (else they are left to `io`);
 * `home`: the home folder, for `~/…` paths.
 */
export async function validate(io: Io, loaded: Loaded, opts: { root?: string; home?: string } = {}): Promise<Validation> {
  const { config, tree, texts } = loaded
  const errors = [...loaded.problems]
  const warnings: string[] = []
  const files = await allFiles(io, config.vault)
  const names = new Set<string>()
  for (const f of files) {
    const base = f.split('/').pop()!
    names.add(base.toLowerCase())
    if (base.endsWith('.md')) names.add(base.slice(0, -3).toLowerCase())
  }
  const roots = tree.roots.filter(r => tree.nodes[r]!.type === 'direction')
  if (tree.roots.length === 0) errors.push('the tree is empty: no D00 root note')
  if (tree.roots.length > 1) warnings.push(`${tree.roots.length} roots (${tree.roots.join(', ')}): every note but the root should have a parent`)
  if (roots.length === 0 && tree.roots.length) errors.push('no direction is a root: the root should be D00, the starting question')
  for (const n of Object.values(tree.nodes)) {
    const text = texts[n.id]!
    const fm = front(text)
    if (!fm.id) errors.push(`${n.path}: no id in the frontmatter`)
    else if (fm.id !== idOf(n.name)) errors.push(`${n.path}: frontmatter id ${fm.id} does not match the file name`)
    if (!ID_RE.test(n.id)) errors.push(`${n.path}: id ${n.id} is not ${orList(NODE_TYPES.map(t => `${TYPES[t].prefix}<number>`))}`)
    else if (n.id[0] !== PREFIX[n.type]) errors.push(`${n.path}: id ${n.id} does not match type ${n.type}`)
    if (!isNodeType(fm.type)) errors.push(`${n.path}: type "${fm.type ?? ''}" is not ${orList(NODE_TYPES)}`)
    if (!SUBDIR[n.type] || !n.path.startsWith(SUBDIR[n.type] + '/')) warnings.push(`${n.path}: a ${n.type} note outside ${SUBDIR[n.type]}/`)
    if (!(STATUSES as readonly string[]).includes(n.status)) errors.push(`${n.path}: status "${n.status}" is not one of ${STATUSES.join(', ')}`)
    if (FORBIDDEN.test(n.name)) errors.push(`${n.path}: the title contains a character that breaks links (^ # | [ ] \\ / : * " < > ?)`)
    if (!n.title) warnings.push(`${n.path}: no title after the id`)
    if (fm.concept !== undefined) {
      const cname = unquote(fm.concept)
      if (!cname) errors.push(`${n.id}: \`concept:\` is empty (give the concept a name, or remove the field)`)
      else if (/[\^#|[\]]/.test(cname)) errors.push(`${n.id}: concept name "${cname}" contains ^ # | [ or ]`)
    } else if (fm.concept_summary !== undefined) warnings.push(`${n.id}: concept_summary without concept`)
    if (fm.superseded_by !== undefined && !n.supersededBy) warnings.push(`${n.id}: superseded_by names no note of the tree (rft_supersede sets or clears it)`)
    if (fm.priority !== undefined && !n.priority) warnings.push(`${n.id}: priority "${unquote(fm.priority)}" is not ${orList([...PRIORITIES])} (the user sets it in the tree view)`)
    if (fm.suggested_priority !== undefined && !n.suggestedPriority) warnings.push(`${n.id}: suggested_priority "${unquote(fm.suggested_priority)}" is not ${orList([...PRIORITIES])} (rft_suggest_priority writes it)`)
    warnings.push(...planWarnings(n, fm, tree))
    const notRefs = (n.refs ?? []).filter(r => tree.nodes[r]!.type !== 'reference')
    if (notRefs.length) warnings.push(`${n.id}: refs ${notRefs.join(', ')} ${notRefs.length === 1 ? 'is not a reference' : 'are not references'} (R notes)`)
    if (config.requireRefs && needsRefs(n) && !(n.refs ?? []).length && n.parent) {
      warnings.push(`${n.id}: no references (refs:) — name the paper(s) it builds on with rft_set_refs, or add them first as R notes`)
    }
    if (fm.concept_repos !== undefined) {
      const isTop = tree.roots.length === 1 && tree.roots[0] === n.id
      if (!unquote(fm.concept) && !isTop) {
        warnings.push(`${n.id}: concept_repos without concept, ignored (repos belong to a concept, or to the root note for the whole project)`)
      } else {
        for (const p of parseRepos(fm.concept_repos)) {
          const at = opts.root ? repoAbs(opts.root, p, opts.home) : p
          if (!(await io.exists(at))) warnings.push(`${n.id}: repo ${p} not found${isAbsolute(p) ? '' : " (a relative path starts from the tree's folder)"}`)
          else if (!(await isInGit(io, at))) warnings.push(`${n.id}: repo ${p} is not in a git repository, so the commits its notes were checked against cannot be recorded`)
        }
      }
    }
    const repos = codeRepos(tree.concepts, n.concept)
    if (repos.length && needsCode(n)) {
      const cs = codeSection(text)
      const linked = new Set(repos.map(r => r.path))
      if (!cs) warnings.push(`${n.id}: its concept links code (${repos.map(r => r.path).join(', ')}) but the note has no ## ${CODE} section (rft_set_code writes it)`)
      else {
        const stale = cs.repos.filter(r => !linked.has(r.path)).map(r => r.path)
        const absent = repos.filter(r => !cs.repos.some(x => x.path === r.path)).map(r => r.path)
        if (stale.length) warnings.push(`${n.id}: ## ${CODE} names ${stale.join(', ')}, which its concept no longer links (rft_set_code updates it)`)
        if (absent.length) warnings.push(`${n.id}: ## ${CODE} does not cover ${absent.join(', ')} (rft_set_code adds it)`)
      }
    }
    const odd = n.tags.filter(t => !isKebab(t))
    if (odd.length) warnings.push(`${n.id}: tag(s) ${odd.join(', ')} not lowercase kebab-case (rft_set_tags fixes them)`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(n.date)) warnings.push(`${n.path}: date "${n.date}" is not YYYY-MM-DD`)
    const f = derivedFields(tree, n)
    if (!sameLinks(fm.children, f.children!) || (fm.up ?? '') !== f.up || (fm.down ?? '') !== f.down) {
      warnings.push(`${n.id}: children / up / down frontmatter out of date (rft_sync fixes it)`)
    }
    const listed = new Set(linksIn(childrenAt(text)?.body))
    const missing = n.children.filter(k => !listed.has(tree.nodes[k]!.name))
    if (missing.length) warnings.push(`${n.id}: "Children in the tree" does not list ${missing.join(', ')} (rft_sync adds them)`)
  }
  for (const p of PRIORITIES) {
    const limit = PRIORITY_LIMITS[p]
    const held = Object.values(tree.nodes).filter(n => n.priority === p && OPEN_STATUSES.includes(n.status)).map(n => n.id).sort(compareNames)
    if (limit !== null && held.length > limit) warnings.push(`${held.length} open notes are ${p} (${held.join(', ')}), more than the ${limit} allowed: the user lowers some in the tree view`)
  }
  warnings.push(...milestoneWarnings(loaded))
  const seenNames = new Map<string, string>()
  for (const c of Object.values(tree.concepts ?? {})) {
    const key = c.name.toLowerCase()
    const other = seenNames.get(key)
    if (other !== undefined) warnings.push(`concept name "${c.name}" is used twice (${other} and ${c.root ?? 'the project'})`)
    else seenNames.set(key, c.root ?? 'the project')
  }
  const linkSources = files.filter(f => f.endsWith('.md') && !f.startsWith('templates/'))
  for (const f of linkSources) {
    const text = stripCode(await io.read(join(config.vault, f)))
    for (const m of text.matchAll(/!?\[\[([^\]|#]*)[^\]]*\]\]/g)) {
      const target = m[1]!.trim()
      // an embedded image is no link of the tree, and may be anywhere in the Obsidian vault
      // around this one, where the tree view finds it
      if (!target || (m[0].startsWith('!') && IMAGE_FILE.test(target))) continue
      const base = target.split('/').pop()!.toLowerCase()
      if (!names.has(base) && !names.has(base + '.md')) errors.push(`${f}: broken link [[${target}]]`)
    }
  }
  const indexPath = join(config.vault, INDEX)
  if (!(await io.exists(indexPath))) warnings.push(`${INDEX} is missing (rft_sync creates it)`)
  else if (withIndexTree(await io.read(indexPath), tree) !== normalise(await io.read(indexPath))) {
    warnings.push(`the tree in ${INDEX} is out of date (rft_sync fixes it)`)
  }
  return { errors, warnings }
}

const DUE_HINT = `(${S.DUE_EXAMPLES})`

/** What is wrong with a note's dates, GPUs and `after:`, as warnings. */
function planWarnings(n: RftNode, fm: Record<string, string>, tree: Tree): string[] {
  const out: string[] = []
  const bad = (key: string, ok: unknown, what: string) => {
    if (fm[key] !== undefined && unquote(fm[key]) !== '' && !ok) out.push(`${n.id}: ${key} "${unquote(fm[key])}" ${what}`)
  }
  bad('due', n.due, `is not a date ${DUE_HINT}`)
  bad('start', n.start, 'is not a date (2026-11-27)')
  bad('est', n.est, 'is not a number of days or weeks (3d, 2w)')
  bad('started', n.started, 'is not a date (2026-11-27)')
  bad('finished', n.finished, 'is not a date (2026-11-27)')
  bad('gpus', n.gpus, 'is not a whole number of GPUs')
  if ((n.start || n.est) && n.type !== 'experiment') out.push(`${n.id}: start and est plan a run, and only experiments run (a ${n.type} can have a due date)`)
  const lost = linksIn(fm.after).filter(ref => !Object.values(tree.nodes).some(x => x.name === ref || x.id === idOf(ref)))
  if (lost.length) out.push(`${n.id}: after names ${lost.map(r => `[[${r}]]`).join(', ')}, which ${lost.length === 1 ? 'is' : 'are'} not a note of the tree`)
  return out
}

/** What is wrong with the deadlines: a due date that is none, an unknown status, needs that will not be done. */
function milestoneWarnings(loaded: Loaded): string[] {
  const out: string[] = []
  const { tree } = loaded
  for (const m of loaded.milestones ?? []) {
    if (!MILESTONE_RE.test(m.id)) out.push(`${m.path}: id ${m.id} is not M<number>`)
    if (!m.due) out.push(`${m.name}: ${m.dueText ? `due "${m.dueText}" is not a date` : 'no due date'} ${DUE_HINT}`)
    if (!S.MILESTONE_STATUSES.includes(m.status)) out.push(`${m.name}: status "${m.status}" is not ${orList(S.MILESTONE_STATUSES)}`)
    if (m.status === 'suggested' && !m.source) out.push(`${m.name}: a suggested deadline names the official page it was read from (source:)`)
    if (m.status !== 'open' && m.status !== 'suggested') continue
    const replace = 'the user replaces it or takes it out of needs'
    for (const id of m.needs) {
      const n = tree.nodes[id]!
      if (n.supersededBy) out.push(`${m.name} needs ${n.name}, which was superseded by ${n.supersededBy}: ${replace}`)
      else if (['dropped', 'discussed', 'moved'].includes(n.status)) out.push(`${m.name} needs ${n.name}, which was ${n.status}: ${replace}`)
    }
    for (const ref of m.missing) out.push(`${m.name} needs [[${ref}]], which is not a note of the tree`)
  }
  return out
}

// ---------------------------------------------------------------- creating notes

export type NewNode = {
  type: NodeType
  title: string
  parent: string | null
  status?: string
  date: string
  /** Section texts by heading (`What`, `Why`, `Result`, `Idea`, `Status`, ...). */
  sections?: Record<string, string>
  code?: string
  /** Topical tags, sanitised to kebab-case. */
  tags?: string[]
  /** Names of the notes it builds on (references). */
  refs?: string[]
  /** One line on what the note is (and what it found). */
  summary?: string
  /** The priority Claude suggests for it, and why: the note itself starts with none. */
  suggestedPriority?: Priority
  suggestedWhy?: string
}

/** `taken`: ids in use beyond the loaded ones, e.g. notes another session added since. */
export function nextId(loaded: Loaded, type: NodeType, taken: string[] = []): string {
  const prefix = PREFIX[type]
  const ids = [...Object.keys(loaded.tree.nodes), ...taken]
  let max = loaded.config.lastId[prefix] ?? 0
  for (const id of ids) {
    const m = ID_RE.exec(id)
    if (m && m[1] === prefix) max = Math.max(max, Number(m[2]))
  }
  // D00 is the root: an empty vault's first direction is D00, every other id starts at 01
  const isEmpty = type === 'direction' && !ids.some(id => id.startsWith('D'))
  return formatId(prefix, isEmpty && max === 0 ? 0 : max + 1)
}

/** What a new experiment's Code / data line says until it is filled. */
const CODE_HINT = 'commit, script, results folder, machine'

export function noteText(id: string, n: NewNode, project: string, parentName: string | null): string {
  const t = TYPES[n.type]
  const status = n.status ?? t.status
  const s = n.sections ?? {}
  const parentLink = parentName ? `[[${parentName}]]` : '(root)'
  const topical = topicalTags((n.tags ?? []).map(sanitiseTag).filter(Boolean), project, n.type)
  const head = [
    '---', `id: ${id}`, `type: ${n.type}`, `status: ${status}`,
    ...(n.suggestedPriority ? [`suggested_priority: ${n.suggestedPriority}`, `suggested_priority_why: ${JSON.stringify(n.suggestedWhy ?? '')}`] : []),
    `date: ${n.date}`,
    ...(n.summary?.trim() ? [`summary: ${JSON.stringify(n.summary.trim().replace(/\s+/g, ' '))}`] : []),
    `parent: ${parentName ? `"[[${parentName}]]"` : '""'}`, 'children: []', 'up: ""', 'down: []',
    `tags: ${tagsLine(project, n.type, topical, status)}`, ...(n.refs?.length ? [`refs: ${linkList(n.refs)}`] : []), '---', '',
    `# ${id} · ${n.title}`, '',
    `**Parent:** ${parentLink}  `,
    `**Status:** ${status} · **Date:** ${n.date}${t.code ? '  ' : ''}`,
  ]
  if (t.code) head.push(`**Code / data:** ${s['Code / data'] ?? n.code ?? CODE_HINT}`)
  const own: readonly string[] = t.sections
  // a Code section goes before the section status notes go to (Result, Status, ...)
  const at = own.indexOf(t.noteIn)
  const order = s[CODE]?.trim() ? [...own.slice(0, at), CODE, ...own.slice(at)] : own
  const extra = Object.keys(s).filter(k => !order.includes(k) && k !== 'Code / data' && k !== 'Children in the tree')
  const blocks = [...order, ...extra].map(k => `## ${k}\n${(s[k] ?? '').trim()}${s[k]?.trim() ? '\n' : ''}`)
  return head.join('\n') + '\n\n' + blocks.join('\n') + '\n## Children in the tree\n'
}

/**
 * The "Children in the tree" list: from its heading to the next section, or to the note's
 * footnote texts (`[^1]: …`), which the tree view writes after it, at the end of the note.
 */
export function childrenAt(t: string): { start: number; end: number; body: string } | null {
  const m = /## Children in the tree\n/.exec(t)
  if (!m) return null
  const start = m.index + m[0].length
  const stop = /^(## |\[\^[^\]\s]+\]:)/m.exec(t.slice(start))
  const end = stop ? start + stop.index : t.length
  return { start, end, body: t.slice(start, end) }
}

/** Adds `- [[child]]` to the parent's "Children in the tree" section, creating it when missing. */
export function withChildListed(text: string, childName: string): string {
  const line = `- [[${childName}]]`
  const t = normalise(text)
  const c = childrenAt(t)
  if (!c) return t.replace(/\n*$/, '\n\n') + `## Children in the tree\n${line}\n`
  if (linksIn(c.body).includes(childName)) return t
  const kept = c.body.split('\n').filter(l => l.trim() !== '')
  return t.slice(0, c.start) + [...kept, line].join('\n') + '\n' + (c.end < t.length ? '\n' : '') + t.slice(c.end)
}

/** Sets `refs:` (note names); an empty list removes the field. */
export function withRefs(text: string, names: string[]): string {
  return names.length ? setField(text, 'refs', linkList(names), 'tags') : removeField(text, 'refs')
}

/** Drops `- [[child]]` from the "Children in the tree" section (the note moved elsewhere). */
export function withChildUnlisted(text: string, childName: string): string {
  const t = normalise(text)
  const c = childrenAt(t)
  if (!c) return t
  const kept = c.body.split('\n').filter(l => !linksIn(l).includes(childName))
  return t.slice(0, c.start) + kept.join('\n') + t.slice(c.end)
}

/**
 * A note moved from `from` to `to` (both note names): its `parent:` and `**Parent:**` line, the
 * old parent added at the end of `origin:` (past parents, oldest first), and a dated line under
 * `## History`, so the reasoning that led to the note stays findable.
 */
export function withMove(text: string, from: string, to: string, date: string, why?: string): string {
  let out = setField(text, 'parent', `"[[${to}]]"`)
  const past = linksIn(front(out).origin)
  out = setField(out, 'origin', linkList([...past, from]), 'parent')
  out = out.replace(/(\*\*Parent:\*\*\s*)(\[\[[^\]]*\]\]|\(root\))/, `$1[[${to}]]`)
  return withHistory(out, `- ${date}: moved from [[${from}]] to [[${to}]]${why?.trim() ? ` (${why.trim().replace(/\s+/g, ' ')})` : ''}`)
}

/** A dated line added under `## History` (made before "Children in the tree" when missing). */
export function withHistory(out: string, line: string): string {
  const heading = '## History'
  const at = out.indexOf(`\n${heading}\n`)
  if (at < 0) {
    // before "Children in the tree", which stays the last section
    const kids = out.indexOf('\n## Children in the tree')
    return kids < 0
      ? out.replace(/\n*$/, '\n\n') + `${heading}\n${line}\n`
      : out.slice(0, kids).replace(/\n*$/, '\n\n') + `${heading}\n${line}\n` + out.slice(kids)
  }
  const start = at + heading.length + 2
  const nxt = out.indexOf('\n## ', start - 1)
  const end = nxt < 0 ? out.length : nxt
  const sec = out.slice(start, end).replace(/\s+$/, '')
  return out.slice(0, start) + (sec ? sec + '\n' : '') + line + '\n' + out.slice(end)
}

/** The ids of `id` and every note below it. */
export function subtreeOf(tree: Tree, id: string): Set<string> {
  const out = new Set<string>()
  const go = (k: string) => { out.add(k); tree.nodes[k]?.children.forEach(go) }
  go(id)
  return out
}

// ---------------------------------------------------------------- changing a note's type

/** `[[from]]`, `[[folder/from|alias]]`, `![[from#heading]]` and the like as links to `to`. */
export function withLinksRenamed(text: string, from: string, to: string): string {
  const name = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(`\\[\\[(?:[^\\]|#\\n]*/)?${name}(?=\\]\\]|[|#])`, 'g'), () => `[[${to}`)
}

/** Renames the links to note `from` in the vault's markdown files, the templates and `skip` aside; answers the files changed. */
export async function renameLinks(io: Io, vault: string, from: string, to: string, skip: string[] = []): Promise<string[]> {
  const changed: string[] = []
  for (const f of await allFiles(io, vault)) {
    if (!f.endsWith('.md') || f.startsWith('templates/') || skip.includes(f)) continue
    const prev = await io.read(join(vault, f))
    const next = withLinksRenamed(prev, from, to)
    if (next === prev) continue
    await io.write(join(vault, f), next)
    changed.push(f)
  }
  return changed
}

/**
 * A note's text as a note of another type with id `id`: the id, type and type tag, the heading,
 * the Code / data line (experiments alone have one; one holding more than the hint stays), and
 * the sections: the new type's in its order, each with the text it had, then the note's other
 * sections, less the old type's empty ones. No text is lost.
 */
export function retyped(text: string, n: RftNode, type: NodeType, id: string, project: string): string {
  const CHILDREN = 'Children in the tree'
  let out = setField(setField(normalise(text), 'id', id), 'type', type)
  out = setField(out, 'tags', tagsLine(project, type, topicalTags(n.tags, project, type), n.status))
  out = out.replace(new RegExp(`^# ${n.id}\\b`, 'm'), `# ${id}`)
  const code = /^\*\*Code \/ data:\*\*(.*)$/m.exec(out)
  if (TYPES[type].code && !code) out = out.replace(/^(\*\*Status:\*\*.*?) *$/m, `$1  \n**Code / data:** ${CODE_HINT}`)
  if (!TYPES[type].code && code && code[1]!.trim() === CODE_HINT) out = out.replace(/ *\n\*\*Code \/ data:\*\*.*\n/, '\n')
  const parts = split(out)
  if (!parts) return out
  // the body by `## ` section; a heading inside a code block is text
  const lead: string[] = []
  const found: { title: string; lines: string[] }[] = []
  let lines = lead
  let isFenced = false
  for (const line of parts.body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) isFenced = !isFenced
    if (!isFenced && line.startsWith('## ')) {
      lines = []
      found.push({ title: line.slice(3).trim(), lines })
    } else lines.push(line)
  }
  const textOf = (s?: { lines: string[] }) => (s ? s.lines.join('\n').replace(/^\n+/, '').replace(/\s+$/, '') : '')
  const first = (title: string) => found.find(s => s.title === title)
  const block = (title: string, t: string) => `## ${title}\n${t}${t ? '\n' : ''}`
  const now: readonly string[] = TYPES[type].sections
  const was: readonly string[] = TYPES[n.type].sections
  // a section the new type places itself: its first of that heading, and the children list
  const isTypeSection = (s: { title: string }) => s === first(s.title) && (now.includes(s.title) || s.title === CHILDREN)
  const kept = found.filter(s => !isTypeSection(s) && !(was.includes(s.title) && !textOf(s)))
  const blocks = [...now.map(t => block(t, textOf(first(t)))), ...kept.map(s => block(s.title, textOf(s)))]
  const top = lead.join('\n').replace(/\s*$/, '\n\n')
  return joinNote(parts.head, top + blocks.join('\n') + '\n' + block(CHILDREN, textOf(first(CHILDREN))))
}

export function resolveId(tree: Tree, ref: string | null | undefined): string | null {
  if (!ref) return null
  const r = ref.replace(/^\[\[|\]\]$/g, '').trim()
  if (tree.nodes[r]) return r
  const byName = Object.values(tree.nodes).find(n => n.name === r)
  if (byName) return byName.id
  const id = idOf(r).toUpperCase()
  return tree.nodes[id] ? id : null
}

/** Status changes: frontmatter, the status tag, the `**Status:**` line and an optional note. */
export function withStatus(text: string, n: RftNode, status: string, note?: string): string {
  let out = setField(text, 'status', status)
  const fm = front(out)
  if (fm.tags) {
    const tags = fm.tags.replace(/^\[|\]$/g, '').split(',').map(t => t.trim()).filter(Boolean)
    const kept = tags.filter(t => !(STATUSES as readonly string[]).includes(t))
    if (kept.length !== tags.length) out = setField(out, 'tags', `[${[...kept, status].join(', ')}]`)
  }
  out = out.replace(/(\*\*Status:\*\*\s*)[a-z]+/, `$1${status}`)
  if (note?.trim()) {
    const heading = `## ${TYPES[n.type]?.noteIn ?? 'Status'}`
    const at = out.indexOf(heading + '\n')
    if (at < 0) out = out.replace(/\n*$/, '\n\n') + `${heading}\n${note.trim()}\n`
    else {
      const start = at + heading.length + 1
      const nxt = out.indexOf('\n## ', start - 1)
      const end = nxt < 0 ? out.length : nxt
      const sec = out.slice(start, end).replace(/\s+$/, '')
      out = out.slice(0, start) + (sec ? sec + '\n' : '') + note.trim() + '\n' + out.slice(end)
    }
  }
  return out
}

// ---------------------------------------------------------------- skeleton

export function indexTemplate(project: string): string {
  return `---
type: index
---

# ${project} — the reasoning tree

One note per experiment (E..), direction (D..), reference (R..) and theory note (T..); each links
to its parent and lists its children. Legend: ${LEGEND}.

## The tree

## How to keep it up to date
The rft plugin maintains this list, the canvas and the children / up / down fields from the
\`parent:\` field of every note: create and update notes with its tools (rft_add_node,
rft_set_status), or edit notes by hand and run rft_sync.

## Elsewhere
Code, results, reports, related notes.
`
}

export const EXPERIMENT_TEMPLATE = (project: string) => `---
id: E__
type: experiment
status: planned
date: YYYY-MM-DD
parent: "[[D__ title]]"
children: []
tags: [${project}, experiment]
---

# E__ · Title

**Parent:** [[D__ title]]
**Status:** planned · **Date:** YYYY-MM-DD
**Code / data:** commit, script, results folder, machine

## What
What was run or computed: model, data, arms / conditions, seeds, where.

## Why
Which direction it tests, and what we expected.

## Result
Numbers (with spread over seeds), what failed and why, caveats.

## Directions found

## Children in the tree
`

export const DIRECTION_TEMPLATE = (project: string) => `---
id: D__
type: direction
status: idea
date: YYYY-MM-DD
parent: "[[E__ title]]"
children: []
tags: [${project}, direction]
---

# D__ · Title

**Parent:** [[E__ title]]
**Status:** idea · **Date:** YYYY-MM-DD

## Idea
The idea or question, in a few sentences.

## Why
What result or reasoning it comes from.

## Status
Decided / planned / why dropped or not pursued / where it was moved.

## Children in the tree
`

export const REFERENCE_TEMPLATE = (project: string) => `---
id: R__
type: reference
status: planned
date: YYYY-MM-DD
parent: "[[D__ title]]"
children: []
tags: [${project}, reference]
---

# R__ · Title

**Parent:** [[D__ title]]
**Status:** planned · **Date:** YYYY-MM-DD

## Source
Authors, title, venue, year; a link that can be checked (DOI, arXiv id or URL); PDF or BibTeX key.

## Summary
What the paper, method or review claims, in a few sentences.

## Method
How they get there: model, data, setup; for a review, how it organises the field.

## Key results
Findings and numbers as the source reports them, with where (table, figure, section).

## Relevance
My reading: what it means for this project, what to trust, what is missing.

## Directions found

## Children in the tree
`

export const THEORY_TEMPLATE = (project: string) => `---
id: T__
type: theory
status: idea
date: YYYY-MM-DD
parent: "[[E__ title]]"
children: []
tags: [${project}, theory]
---

# T__ · Title

**Parent:** [[E__ title]]
**Status:** idea · **Date:** YYYY-MM-DD

## Statement
The definition, method, taxonomy or claim, stated precisely.

## Builds on
The directions, experiments and references it rests on, linked, and what it takes from each.

## Explanation
Derivation, intuition, examples and counter-examples.

## Open questions
What is not settled yet.

## Status
Draft / settled / why dropped or refuted.

## Children in the tree
`

/** The template of each type, written to `templates/_<type>.md` when a vault is set up. */
export const TEMPLATES: Record<NodeType, (project: string) => string> = {
  experiment: EXPERIMENT_TEMPLATE,
  direction: DIRECTION_TEMPLATE,
  reference: REFERENCE_TEMPLATE,
  theory: THEORY_TEMPLATE,
}
