// The project map: the tree read in layers, so Claude reads summaries before note files. Every
// note carries a one-line `summary:` Claude writes; every concept can have a digest Claude writes
// (`map/<id> <name>.md` in the vault: its state, key results, dead ends, open questions), kept
// with a fingerprint of the concept's notes so the plugin can say when it is out of date.

import type { Concept, Io, Loaded, RftNode, Tree } from './vault'
import { LEGEND, MARK, ROOT_CONCEPT, bodyOf, conceptOrder, conceptPath, counts, countsLine, front, join, load, resolveId, setField, statusSummary, unquote, unquoteJson } from './vault'

export const MAP_DIR = 'map'
/** Above this many notes the session starts from the project map instead of the list of titles. */
export const SMALL_TREE = 60
export const MAX_SUMMARY = 240
/** More notes of its own than one digest can stand for: the concept should be split. */
export const DIGEST_MAX = 40

class MapError extends Error {}

// ---------------------------------------------------------------- summaries

export const summaryOf = (text: string) => unquoteJson(front(text).summary)

/** A summary as it is stored: one line, quoted; refused when it is not one line's worth. */
export function cleanSummary(summary: string): string {
  const one = summary.trim().replace(/\s+/g, ' ')
  if (one.length > MAX_SUMMARY) throw new MapError(`keep a summary to one line (${MAX_SUMMARY} characters at most; this one has ${one.length})`)
  return one
}

export const withSummary = (text: string, summary: string) => setField(text, 'summary', JSON.stringify(cleanSummary(summary)), 'date')

/** Sets the summaries of many notes at once (`id or name → summary`). */
export async function setSummaries(io: Io, loaded: Loaded, given: Record<string, string>): Promise<string> {
  const done: string[] = []
  const failed: string[] = []
  for (const [ref, summary] of Object.entries(given)) {
    const id = resolveId(loaded.tree, ref)
    if (!id) { failed.push(`${ref}: not a note of the tree`); continue }
    if (!summary.trim()) { failed.push(`${id}: empty summary`); continue }
    try {
      const n = loaded.tree.nodes[id]!
      await io.write(join(loaded.config.vault, n.path), withSummary(loaded.texts[id]!, summary))
      done.push(id)
    } catch (err) {
      failed.push(`${id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (done.length) Object.assign(loaded, await load(io, loaded.config))
  const left = Object.values(loaded.tree.nodes).filter(n => !n.summary).length
  return [
    done.length ? `Summary set on ${done.length} note(s): ${done.join(', ')}.` : 'No summary set.',
    ...(failed.length ? ['Not set:', ...failed.map(f => `- ${f}`)] : []),
    left ? `${left} note(s) still have no summary.` : 'Every note has a summary.',
  ].join('\n')
}

// ---------------------------------------------------------------- concepts and fingerprints

/** A concept by its id (`root`), its start note's id or name, or its name. */
export function resolveConcept(tree: Tree, ref: string): Concept | null {
  const concepts = tree.concepts ?? {}
  const r = ref.trim()
  if (concepts[r]) return concepts[r]!
  const id = resolveId(tree, r)
  if (id) {
    const c = Object.values(concepts).find(x => x.root === id)
    if (c) return c
  }
  const low = r.toLowerCase()
  return Object.values(concepts).find(c => c.name.toLowerCase() === low) ?? null
}

/** The concept's own notes (not its sub-concepts'), in tree order. */
export function ownNotes(tree: Tree, conceptId: string): RftNode[] {
  const out: RftNode[] = []
  const visit = (id: string) => {
    const n = tree.nodes[id]
    if (!n) return
    if (n.concept === conceptId) out.push(n)
    n.children.forEach(visit)
  }
  tree.roots.forEach(visit)
  return out
}

/** FNV-1a over what a digest is written from: each own note's id, status, title and summary. */
export function fingerprint(tree: Tree, conceptId: string): string {
  const text = ownNotes(tree, conceptId).map(n => `${n.id}|${n.status}|${n.title}|${n.summary ?? ''}${n.supersededBy ? `|>${n.supersededBy}` : ''}`).sort().join('\n')
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------- digests

export type Digest = { concept: string; basis: string; updated: string; state: string; body: string; path: string }

/** The digests in the vault's map folder, by concept id. */
export async function readDigests(io: Io, loaded: Loaded): Promise<Record<string, Digest>> {
  const dir = join(loaded.config.vault, MAP_DIR)
  const out: Record<string, Digest> = {}
  if (!(await io.exists(dir))) return out
  for (const f of await io.list(dir)) {
    if (f.kind !== 'file' || !f.name.endsWith('.md')) continue
    const text = await io.read(join(dir, f.name))
    const fm = front(text)
    if (fm.type !== 'digest' || !fm.concept) continue
    const concept = unquote(fm.concept)
    const body = bodyOf(text).replace(/^\s*# .*\n+/, '')
    const state = /\*\*State:\*\*\s*(.*)/.exec(body)?.[1]?.trim() ?? ''
    out[concept] = {
      concept, basis: unquote(fm.basis), updated: unquote(fm.updated), state,
      body: body.replace(/\*\*State:\*\*.*\n*/, '').trim(), path: `${MAP_DIR}/${f.name}`,
    }
  }
  return out
}

const fileName = (c: Concept) => `${c.id === ROOT_CONCEPT ? '00' : c.id} ${c.name.replace(/[\\/:*"<>?|^#[\]]/g, '')}.md`

export const isStale = (tree: Tree, d: Digest | undefined) => !!d && d.basis !== fingerprint(tree, d.concept)

/** Writes a concept's digest, stamped with the fingerprint of its notes now. */
export async function setDigest(io: Io, loaded: Loaded, ref: string, state: string, text: string, date: string): Promise<string> {
  const { tree, config } = loaded
  const c = resolveConcept(tree, ref)
  if (!c) throw new MapError(`"${ref}" is not a concept (give its name or the id of the note that starts it; rft_concepts lists them)`)
  const st = state.trim().replace(/\s+/g, ' ')
  if (!st) throw new MapError('state is empty: say in one or two sentences where this line of research stands')
  const missing = ownNotes(tree, c.id).filter(n => !n.summary).map(n => n.id)
  const head = [
    '---', 'type: digest', `concept: ${c.id}`, `concept_name: ${JSON.stringify(c.name)}`,
    `basis: ${fingerprint(tree, c.id)}`, `updated: ${date}`, '---', '',
    `# ${c.name} — digest`, '', `**State:** ${st}`, '',
  ]
  const file = join(MAP_DIR, fileName(c))
  const before = await readDigests(io, loaded)
  await io.write(join(config.vault, file), head.join('\n') + text.trim() + '\n')
  const old = before[c.id]
  if (old && old.path !== file && io.remove) await io.remove(join(config.vault, old.path))
  return `Digest of "${c.name}" written to ${file} (${ownNotes(tree, c.id).length} note(s)).` +
    (missing.length ? ` ${missing.length} of its notes have no summary yet (${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ', …' : ''}): set them with rft_set_summary, then the digest counts as out of date until rewritten.` : '')
}

// ---------------------------------------------------------------- reports

const noteLine = (n: RftNode, prev: string | null) =>
  `${MARK[n.status] ?? '-'} ${n.name}${n.parent && n.parent !== prev ? ` ← ${n.parent}` : ''}${n.supersededBy ? ` [superseded by ${n.supersededBy}]` : ''}${n.summary ? ` — ${n.summary}` : ''}`

const pathName = (tree: Tree, c: Concept) => conceptPath(tree.concepts ?? {}, c.id).map(id => tree.concepts![id]!.name).join(' › ')

function digestMark(tree: Tree, c: Concept, d: Digest | undefined): string {
  if (!d) return c.count >= 3 ? ' [no digest]' : ''
  return isStale(tree, d) ? ` [digest out of date, ${d.updated}]` : ''
}

/** The project map: each concept with its state, nested as the concepts are, then what is in progress. */
export function projectMap(loaded: Loaded, digests: Record<string, Digest>, opts: { maxActive?: number } = {}): string {
  const { tree } = loaded
  const concepts = tree.concepts ?? {}
  const out: string[] = []
  for (const c of conceptOrder(concepts)) {
    if (!c.count && c.id === ROOT_CONCEPT && c.children.length) continue
    const d = digests[c.id]
    const stats = statusSummary(c.statuses)
    // one line per concept, indented under its parent concept
    const said = d?.state || c.summary
    out.push(`${'  '.repeat(c.depth)}- ${c.name}${c.root ? ` (${c.root})` : ''} · ${c.count} note(s)${stats ? ` ${stats}` : ''}${digestMark(tree, c, d)}${said ? `: ${said}` : ''}`)
  }
  const active = Object.values(tree.nodes).filter(n => n.status === 'running' || (n.status === 'planned' && n.type === 'experiment'))
    .sort((a, b) => b.date.localeCompare(a.date))
  const max = opts.maxActive ?? 15
  if (active.length) {
    out.push('', `In progress (${active.length}):`)
    for (const n of active.slice(0, max)) out.push(noteLine(n, null))
    if (active.length > max) out.push(`… ${active.length - max} more (rft_search status running / planned)`)
  }
  return out.join('\n')
}

/** One concept: its digest, its sub-concepts, its notes with their summaries. */
export function conceptMap(loaded: Loaded, digests: Record<string, Digest>, c: Concept): string {
  const { tree } = loaded
  const d = digests[c.id]
  const notes = ownNotes(tree, c.id)
  const out = [`# ${pathName(tree, c)}${c.root ? ` (from ${c.root})` : ''} · ${c.count} note(s)${c.total > c.count ? `, ${c.total} with sub-concepts` : ''}${digestMark(tree, c, d)}`]
  if (c.summary) out.push(c.summary)
  if (d) out.push('', `State: ${d.state}`, ...(d.body ? [d.body] : []))
  if (c.children.length) {
    out.push('', 'Sub-concepts:')
    for (const k of c.children) {
      const sub = tree.concepts![k]!
      out.push(`- ${sub.name} (from ${sub.root}) · ${sub.total} note(s)${digests[k]?.state ? ` — ${digests[k]!.state}` : sub.summary ? ` — ${sub.summary}` : ''}`)
    }
  }
  out.push('', `Notes (${LEGEND}):`)
  let prev: string | null = null
  for (const n of notes) { out.push(noteLine(n, prev)); prev = n.id }
  const missing = notes.filter(n => !n.summary).length
  if (missing) out.push('', `${missing} note(s) here have no summary: rft_set_summary.`)
  if (!d && notes.length >= 3) out.push('No digest yet: once you have read these notes, write one with rft_set_digest.')
  else if (isStale(tree, d)) out.push('The digest is out of date (its notes changed): rewrite it with rft_set_digest once you have read what changed.')
  return out.join('\n')
}

export async function mapReport(io: Io, loaded: Loaded, ref?: string): Promise<string> {
  const digests = await readDigests(io, loaded)
  if (ref?.trim()) {
    const c = resolveConcept(loaded.tree, ref)
    if (!c) throw new MapError(`"${ref}" is not a concept (rft_concepts lists them)`)
    return conceptMap(loaded, digests, c)
  }
  return `${loaded.config.project}: ${countsLine(counts(loaded.tree))}. Marks: ${LEGEND}.\n${projectMap(loaded, digests)}\n\nrft_map <concept> gives a concept's digest and its notes with their summaries; open a note's file only for its detail.`
}

// ---------------------------------------------------------------- checks

/** Warnings about missing summaries and digests that no longer match their notes. */
export async function mapWarnings(io: Io, loaded: Loaded): Promise<string[]> {
  const { tree, config } = loaded
  const out: string[] = []
  const missing = Object.values(tree.nodes).filter(n => !n.summary)
  if (config.requireSummaries) for (const n of missing) out.push(`${n.id}: no one-line summary (summary:) — rft_set_summary`)
  else if (missing.length) out.push(`${missing.length} note(s) have no one-line summary (summary:): /rft-summarize writes them`)
  for (const c of Object.values(tree.concepts ?? {})) {
    if (c.count > DIGEST_MAX) out.push(`concept "${c.name}" has ${c.count} notes of its own, more than one digest can stand for (${DIGEST_MAX}): split it into sub-concepts at the notes that open its sub-lines (/rft-concepts suggest, then rft_set_concept)`)
  }
  const digests = await readDigests(io, loaded)
  for (const d of Object.values(digests)) {
    const c = tree.concepts?.[d.concept]
    if (!c) out.push(`${d.path}: digest of a concept that no longer exists (${d.concept}); remove the file`)
    else if (isStale(tree, d)) out.push(`${d.path}: the digest of "${c.name}" is out of date (its notes changed since ${d.updated}) — rft_set_digest`)
  }
  return out
}

/** How much is missing, for /rft-summarize: notes without a summary and concepts without a current digest. */
export async function mapGaps(io: Io, loaded: Loaded, scope?: Concept): Promise<{ notes: number; digests: string[] }> {
  const { tree } = loaded
  const concepts = conceptOrder(tree.concepts ?? {}).filter(c => !scope || conceptPath(tree.concepts!, c.id).includes(scope.id))
  const ids = new Set(concepts.map(c => c.id))
  const notes = Object.values(tree.nodes).filter(n => ids.has(n.concept) && !n.summary).length
  const digests = await readDigests(io, loaded)
  return { notes, digests: concepts.filter(c => c.count >= 3 && (!digests[c.id] || isStale(tree, digests[c.id]))).map(c => c.name) }
}
