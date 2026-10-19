// The vault model: reads the notes of a reasoning-tree vault, derives the tree from their
// `parent:` fields, and writes back everything derived from it (children / up / down
// frontmatter, the tree list of `00 Index.md`, the Obsidian canvas, the optional Mermaid
// diagram). The markdown notes are the source of truth; nothing here keeps state of its own.
//
// Every file access goes through `Io`, so the same code runs on the engine's `$.fs` and on
// an in-memory vault in tests.

export type NodeType = 'experiment' | 'direction'

export const STATUSES = ['planned', 'running', 'done', 'idea', 'dropped', 'discussed', 'moved'] as const
export type Status = (typeof STATUSES)[number]

export const MARK: Record<string, string> = {
  done: '✓', running: '…', planned: '→', idea: '?', dropped: '✗', discussed: '·', moved: '↗',
}

export const LEGEND =
  '✓ done · … running · → planned · ? idea · ✗ dropped · · discussed, not pursued · ↗ moved'

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
}

export type Tree = {
  nodes: Record<string, RftNode>
  roots: string[]
  /** The concepts by id: `root` (the project) and one per note that declares `concept:`. */
  concepts?: Record<string, Concept>
}

/** The id of the implicit concept every note belongs to without a concept ancestor. */
export const ROOT_CONCEPT = 'root'

/**
 * A line of research: the subtree of the note that declares it (`concept:` in its
 * frontmatter), less the subtrees of the sub-concepts declared below it.
 */
export type Concept = {
  /** The declaring note's id; `root` for the project. */
  id: string
  name: string
  summary: string
  /** The declaring note; null for the project root concept. */
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
}

export type Config = {
  version: number
  vault: string
  project: string
  canvas: boolean
  mermaid: boolean
  lastId: { E: number; D: number }
  /** The web view's port; 0 or absent: a free one. */
  webPort?: number
}

export type Io = {
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  list: (path: string) => Promise<{ name: string; kind: string; mtimeMs: number; size: number }[]>
  exists: (path: string) => Promise<boolean>
}

export const CONFIG_PATH = '.rft/config.json'
export const SUBDIR: Record<NodeType, string> = { experiment: 'experiments', direction: 'directions' }
export const PREFIX: Record<NodeType, 'E' | 'D'> = { experiment: 'E', direction: 'D' }
export const INDEX = '00 Index.md'
export const CANVAS = 'Reasoning tree.canvas'
export const MERMAID = 'Reasoning tree (diagram).md'

export const join = (...parts: string[]) =>
  parts.filter(p => p !== '' && p !== '.').join('/').replace(/\/+/g, '/')

// ---------------------------------------------------------------- config

export const defaultConfig = (project: string): Config => ({
  version: 1, vault: 'vault', project, canvas: true, mermaid: false, lastId: { E: 0, D: 0 },
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

/** The tags every note carries anyway: the project, its type and its status. */
export const isReservedTag = (tag: string, project: string) =>
  tag === project || tag === 'experiment' || tag === 'direction' || (STATUSES as readonly string[]).includes(tag)

export const topicalTags = (tags: string[], project: string) => [...new Set(tags.filter(t => !isReservedTag(t, project)))]

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
  return setField(text, 'tags', tagsLine(project, n.type, topicalTags(tags.map(sanitiseTag).filter(Boolean), project), n.status))
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

export const formatId = (prefix: 'E' | 'D', n: number) => `${prefix}${String(n).padStart(2, '0')}`

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
}

export async function signatureOf(io: Io, vault: string): Promise<string> {
  const parts: string[] = []
  for (const sub of Object.values(SUBDIR)) {
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
      const fmType = fm.type === 'experiment' || fm.type === 'direction' ? fm.type : type
      nodes[id] = {
        id, name, title: name.slice(idOf(name).length).trim(), type: fmType,
        status: fm.status ?? '', date: fm.date ?? '', parent: null, children: [], path,
        tags: topicalTags(parseTags(fm.tags), config.project),
        concept: ROOT_CONCEPT,
      }
      texts[id] = text
      parentRef[id] = linkTarget(fm.parent)
    }
  }
  const byName: Record<string, string> = {}
  for (const n of Object.values(nodes)) byName[n.name] = n.id
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
  return { config, tree, texts, problems, signature: await signatureOf(io, config.vault) }
}

// ---------------------------------------------------------------- concepts

/** A frontmatter value without the quotes YAML allows around it. */
export const unquote = (v: string | undefined) => (v ?? '').trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim()

/** The notes that declare a concept: `concept:` (and `concept_summary:`) in the frontmatter. */
export function conceptDeclarations(texts: Record<string, string>): Record<string, { name: string; summary: string }> {
  const out: Record<string, { name: string; summary: string }> = {}
  for (const [id, text] of Object.entries(texts)) {
    const fm = front(text)
    const name = unquote(fm.concept)
    if (name) out[id] = { name, summary: unquote(fm.concept_summary) }
  }
  return out
}

/**
 * Concept membership, inherited down the tree: every note belongs to its nearest ancestor (or
 * itself) declaring a concept, else to the project root concept. Sets `concept` on every node.
 */
export function computeConcepts(tree: Tree, project: string, decl: Record<string, { name: string; summary: string }>): Record<string, Concept> {
  const make = (id: string, name: string, summary: string, root: string | null, parent: string | null, depth: number): Concept =>
    ({ id, name, summary, root, parent, children: [], depth, count: 0, total: 0, statuses: {} })
  const concepts: Record<string, Concept> = { [ROOT_CONCEPT]: make(ROOT_CONCEPT, project, '', null, null, 0) }
  const visit = (id: string, current: string) => {
    const n = tree.nodes[id]
    if (!n) return
    const d = decl[id]
    if (d) {
      concepts[id] = make(id, d.name, d.summary, id, current, concepts[current]!.depth + 1)
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

/** The concept ids from the project root down to `id`. */
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
  const out: Record<string, number> = { experiment: 0, direction: 0 }
  for (const n of Object.values(tree.nodes)) {
    out[n.type] = (out[n.type] ?? 0) + 1
    out[n.status] = (out[n.status] ?? 0) + 1
  }
  return out
}

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
const TYPE_COLOR: Record<string, string> = { direction: '6', experiment: '5' }
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
    const color = STATUS_COLOR[n.status] ?? TYPE_COLOR[n.type] ?? '0'
    const text = `**${id}** · ${MARK[n.status] ?? ''} ${n.status}\n\n[[${n.name}|${n.title}]]`
    nodes.push({ id, type: 'text', text, x: Math.trunc(x), y: Math.trunc(y), width: w, height: h, color })
    if (n.parent) edges.push({ id: `${n.parent}-${id}`, fromNode: n.parent, fromSide: 'bottom', toNode: id, toSide: 'top' })
  }
  return JSON.stringify({ nodes, edges }, null, 1)
}

export function mermaidNote(tree: Tree): string {
  // children before their parent, the order the canvas layout visits them
  const ids: string[] = []
  const post = (id: string) => { for (const k of tree.nodes[id]!.children) post(k); ids.push(id) }
  for (const r of tree.roots) post(r)
  const cls = (n: RftNode) =>
    ({ running: 'run', planned: 'todo', idea: 'todo', dropped: 'drop', discussed: 'drop', moved: 'drop' } as Record<string, string>)[n.status] ??
    (n.type === 'direction' ? 'dir' : 'exp')
  const lines = ['flowchart TD']
  for (const id of ids) lines.push(`    ${id}["${tree.nodes[id]!.name.replace(/"/g, "'")}"]:::${cls(tree.nodes[id]!)}`)
  for (const id of ids) if (tree.nodes[id]!.parent) lines.push(`    ${tree.nodes[id]!.parent} --> ${id}`)
  if (ids.length) lines.push(`    class ${ids.join(',')} internal-link`)
  lines.push(
    '    classDef dir fill:#e9ddf7,stroke:#8e4ec6,color:#2b1a40',
    '    classDef exp fill:#d5f2ec,stroke:#12a594,color:#0f3a33',
    '    classDef run fill:#ffe1cc,stroke:#f76b15,color:#4a2104',
    '    classDef todo fill:#fff3c4,stroke:#c9a300,color:#3d3200',
    '    classDef drop fill:#f3f3f3,stroke:#999999,color:#555555',
  )
  return (
    '# Reasoning tree (diagram)\n\n' +
    'Generated by the rft plugin from the `parent:` fields: do not edit. Purple = direction, ' +
    'green = experiment, orange = running, yellow = idea / planned, grey = dropped, discussed ' +
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
  loaded.signature = await signatureOf(io, config.vault)
  return { changed }
}

// ---------------------------------------------------------------- validation

export type Validation = { errors: string[]; warnings: string[] }

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

export async function validate(io: Io, loaded: Loaded): Promise<Validation> {
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
    if (!/^[ED]\d+$/.test(n.id)) errors.push(`${n.path}: id ${n.id} is not E<number> or D<number>`)
    else if (n.id[0] !== PREFIX[n.type]) errors.push(`${n.path}: id ${n.id} does not match type ${n.type}`)
    if (fm.type !== 'experiment' && fm.type !== 'direction') errors.push(`${n.path}: type "${fm.type ?? ''}" is not experiment or direction`)
    if (!SUBDIR[n.type] || !n.path.startsWith(SUBDIR[n.type] + '/')) warnings.push(`${n.path}: a ${n.type} note outside ${SUBDIR[n.type]}/`)
    if (!(STATUSES as readonly string[]).includes(n.status)) errors.push(`${n.path}: status "${n.status}" is not one of ${STATUSES.join(', ')}`)
    if (FORBIDDEN.test(n.name)) errors.push(`${n.path}: the title contains a character that breaks links (^ # | [ ] \\ / : * " < > ?)`)
    if (!n.title) warnings.push(`${n.path}: no title after the id`)
    if (fm.concept !== undefined) {
      const cname = unquote(fm.concept)
      if (!cname) errors.push(`${n.id}: \`concept:\` is empty (give the concept a name, or remove the field)`)
      else if (/[\^#|[\]]/.test(cname)) errors.push(`${n.id}: concept name "${cname}" contains ^ # | [ or ]`)
    } else if (fm.concept_summary !== undefined) warnings.push(`${n.id}: concept_summary without concept`)
    const odd = n.tags.filter(t => !isKebab(t))
    if (odd.length) warnings.push(`${n.id}: tag(s) ${odd.join(', ')} not lowercase kebab-case (rft_set_tags fixes them)`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(n.date)) warnings.push(`${n.path}: date "${n.date}" is not YYYY-MM-DD`)
    const f = derivedFields(tree, n)
    if (!sameLinks(fm.children, f.children!) || (fm.up ?? '') !== f.up || (fm.down ?? '') !== f.down) {
      warnings.push(`${n.id}: children / up / down frontmatter out of date (rft_sync fixes it)`)
    }
    const section = /## Children in the tree\n([\s\S]*?)(\n## |$)/.exec(text)
    const listed = new Set(linksIn(section?.[1]))
    const missing = n.children.filter(k => !listed.has(tree.nodes[k]!.name))
    if (missing.length) warnings.push(`${n.id}: "Children in the tree" does not list ${missing.join(', ')} (rft_sync adds them)`)
  }
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
      if (!target) continue
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
}

export function nextId(loaded: Loaded, type: NodeType): string {
  const prefix = PREFIX[type]
  let max = loaded.config.lastId[prefix] ?? 0
  for (const id of Object.keys(loaded.tree.nodes)) {
    const m = /^([ED])(\d+)$/.exec(id)
    if (m && m[1] === prefix) max = Math.max(max, Number(m[2]))
  }
  // D00 is the root: an empty vault's first direction is D00, every other id starts at 01
  const isEmpty = type === 'direction' && !Object.keys(loaded.tree.nodes).some(id => id.startsWith('D'))
  return formatId(prefix, isEmpty && max === 0 ? 0 : max + 1)
}

export function noteText(id: string, n: NewNode, project: string, parentName: string | null): string {
  const status = n.status ?? (n.type === 'experiment' ? 'planned' : 'idea')
  const s = n.sections ?? {}
  const parentLink = parentName ? `[[${parentName}]]` : '(root)'
  const topical = topicalTags((n.tags ?? []).map(sanitiseTag).filter(Boolean), project)
  const head = [
    '---', `id: ${id}`, `type: ${n.type}`, `status: ${status}`, `date: ${n.date}`,
    `parent: ${parentName ? `"[[${parentName}]]"` : '""'}`, 'children: []', 'up: ""', 'down: []',
    `tags: ${tagsLine(project, n.type, topical, status)}`, '---', '',
    `# ${id} · ${n.title}`, '',
    `**Parent:** ${parentLink}  `,
    `**Status:** ${status} · **Date:** ${n.date}${n.type === 'experiment' ? '  ' : ''}`,
  ]
  if (n.type === 'experiment') head.push(`**Code / data:** ${s['Code / data'] ?? n.code ?? 'commit, script, results folder, machine'}`)
  const order = n.type === 'experiment'
    ? ['What', 'Why', 'Result', 'Directions found']
    : ['Idea', 'Why', 'Status']
  const extra = Object.keys(s).filter(k => !order.includes(k) && k !== 'Code / data' && k !== 'Children in the tree')
  const blocks = [...order, ...extra].map(k => `## ${k}\n${(s[k] ?? '').trim()}${s[k]?.trim() ? '\n' : ''}`)
  return head.join('\n') + '\n\n' + blocks.join('\n') + '\n## Children in the tree\n'
}

/** Adds `- [[child]]` to the parent's "Children in the tree" section, creating it when missing. */
export function withChildListed(text: string, childName: string): string {
  const line = `- [[${childName}]]`
  const t = normalise(text)
  const m = /## Children in the tree\n([\s\S]*?)(?=\n## |$)/.exec(t)
  if (!m) return t.replace(/\n*$/, '\n\n') + `## Children in the tree\n${line}\n`
  if (linksIn(m[1]).includes(childName)) return t
  const start = m.index + '## Children in the tree\n'.length
  const kept = m[1]!.split('\n').filter(l => l.trim() !== '')
  return t.slice(0, start) + [...kept, line].join('\n') + '\n' + t.slice(start + m[1]!.length)
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
    const heading = n.type === 'experiment' ? '## Result' : '## Status'
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

One note per experiment (E..) and per direction (D..); each links to its parent and lists its
children. Legend: ${LEGEND}.

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
