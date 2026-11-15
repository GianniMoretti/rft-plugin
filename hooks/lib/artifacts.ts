// Concept artifacts: one HTML page per concept (`artifacts/<id> <name>.html` in the vault) that
// summarises the results of its own experiments, for the tree view to show in the note drawer when
// the concept is clicked. Claude writes it with rft_set_artifact, whole or as old → new edits; the
// plugin stamps it with a key per experiment with a result (`basis`), so it can say which results
// changed, appeared or left since the page was written. The page's first line is that header, an
// HTML comment holding JSON: `<!-- rft-artifact {"concept","name","updated","basis"} -->`.

import type { Concept, Io, Loaded, RftNode, Tree } from './vault'
import { ARTIFACTS_DIR, ARTIFACT_HEAD, ID_RE, MARK, ROOT_CONCEPT, conceptOrder, conceptPath, isAbsolute, join, load, ownNotes, resolveConcept, resolvePath, resultOf } from './vault'

export { ARTIFACTS_DIR, resultOf } from './vault'

/** Where an artifact's figures are kept, in the vault: the page names them `../figures/<file>`. */
export const FIGURES_DIR = 'figures'

/** The largest page the plugin writes, and the server serves. */
export const MAX_ARTIFACT_BYTES = 1_000_000

export type Artifact = { concept: string; name: string; updated: string; basis: Record<string, string>; path: string; html: string }
export type ArtifactEdit = { old_str: string; new_str: string }
export type ArtifactState = { stale: boolean; changed: string[]; added: string[]; removed: string[] }

class ArtifactError extends Error {}

// ---------------------------------------------------------------- keys

/** FNV-1a over the UTF-16 code units of `text`, as 8 hex digits (as fnv in server/rft_server.py). */
function fnv(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** What an artifact is written from, for one experiment: its id, status, title, summary, superseding note and Result. */
export const experimentKey = (n: RftNode, text: string) =>
  fnv(`${n.id}|${n.status}|${n.title}|${n.summary ?? ''}|${n.supersededBy ?? ''}|${resultOf(text)}`)

/** The concept's own experiments with a result, in tree order. */
const withResults = (tree: Tree, conceptId: string) => ownNotes(tree, conceptId).filter(n => n.type === 'experiment' && n.hasResult)

/** The key of each of the concept's own experiments with a result. */
export function basisOf(loaded: Loaded, conceptId: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const n of withResults(loaded.tree, conceptId)) out[n.id] = experimentKey(n, loaded.texts[n.id] ?? '')
  return out
}

/** Which of the concept's results changed, are new, or left it since the artifact was written. */
export function artifactState(loaded: Loaded, a: Artifact): ArtifactState {
  const now = basisOf(loaded, a.concept)
  const changed = Object.keys(now).filter(id => id in a.basis && a.basis[id] !== now[id])
  const added = Object.keys(now).filter(id => !(id in a.basis))
  const removed = Object.keys(a.basis).filter(id => !(id in now))
  return { stale: changed.length + added.length + removed.length > 0, changed, added, removed }
}

/** "E06 changed, E10 new, E03 no longer here", as web/artifacts.js says it. */
export function describeState(s: ArtifactState): string {
  return [
    s.changed.length ? `${s.changed.join(', ')} changed` : '',
    s.added.length ? `${s.added.join(', ')} new` : '',
    s.removed.length ? `${s.removed.join(', ')} no longer here` : '',
  ].filter(Boolean).join(', ')
}

// ---------------------------------------------------------------- files

/** The header and the page of an artifact file; null when it does not start with the header. */
export function splitArtifact(text: string): { meta: Record<string, unknown>; html: string } | null {
  const m = ARTIFACT_HEAD.exec(text)
  if (!m) return null
  try {
    const meta = JSON.parse(m[1]!) as unknown
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
    return { meta: meta as Record<string, unknown>, html: text.slice(m[0].length) }
  } catch {
    return null
  }
}

/** The header line: JSON with no `--` and no `>`, so a name holding `-->` cannot end the comment early. */
const headLine = (meta: object) =>
  `<!-- rft-artifact ${JSON.stringify(meta).replace(/--/g, '-\\u002d').replace(/>/g, '\\u003e')} -->`

const fileName = (c: Concept) => `${c.id === ROOT_CONCEPT ? '00' : c.id} ${c.name.replace(/[\\/:*"<>?|^#[\]]/g, '').replace(/\s+/g, ' ').trim()}.html`

/** The artifacts in the vault, by concept id: every `artifacts/*.html` that starts with the header. */
export async function readArtifacts(io: Io, loaded: Loaded): Promise<Record<string, Artifact>> {
  const dir = join(loaded.config.vault, ARTIFACTS_DIR)
  const out: Record<string, Artifact> = {}
  if (!(await io.exists(dir))) return out
  const files = (await io.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.html')).sort((a, b) => a.name.localeCompare(b.name))
  for (const f of files) {
    let got: ReturnType<typeof splitArtifact>
    try { got = splitArtifact(await io.read(join(dir, f.name))) } catch { continue }
    const concept = typeof got?.meta.concept === 'string' ? got.meta.concept : ''
    if (!got || !concept || out[concept]) continue
    const basis: Record<string, string> = {}
    const b = got.meta.basis
    if (b && typeof b === 'object') for (const [k, v] of Object.entries(b)) if (typeof v === 'string') basis[k] = v
    out[concept] = {
      concept, name: typeof got.meta.name === 'string' ? got.meta.name : concept,
      updated: typeof got.meta.updated === 'string' ? got.meta.updated : '', basis,
      path: `${ARTIFACTS_DIR}/${f.name}`, html: got.html,
    }
  }
  return out
}

// ---------------------------------------------------------------- the page checked against the tree

const LINK_RE = /(?:\bhref\s*=\s*["']#|\bdata-note\s*=\s*["'])([A-Za-z]\d+)["']/g
const MENTION_RE = /\b([A-Z]\d+)\b/g
const REMOTE_RES = [
  /\b(?:src|srcset|poster)\s*=\s*["']\s*((?:https?:)?\/\/[^"'\s]+)/gi,
  /<link\b[^>]*?\bhref\s*=\s*["']\s*((?:https?:)?\/\/[^"'\s]+)/gi,
  /\burl\(\s*["']?\s*((?:https?:)?\/\/[^"')\s]+)/gi,
  /@import\s+["']\s*((?:https?:)?\/\/[^"'\s]+)/gi,
]

const unique = (xs: string[]) => [...new Set(xs)]

/** What the page says against the tree: results left off it, links to no note, superseded results, files from elsewhere. */
function checks(tree: Tree, c: Concept, html: string): { warnings: string[]; info: string[]; missing: number } {
  const links = unique([...html.matchAll(LINK_RE)].map(m => m[1]!))
  const mentioned = new Set([...html.matchAll(MENTION_RE)].map(m => m[1]!).filter(id => tree.nodes[id]))
  for (const id of links) if (tree.nodes[id]) mentioned.add(id)
  const warnings: string[] = []
  const info: string[] = []
  const missing = withResults(tree, c.id).filter(n => !mentioned.has(n.id)).map(n => n.id)
  if (missing.length) warnings.push(`Not on the page: ${missing.join(', ')} (results of this concept): add them, or say why they are left out.`)
  const none = links.filter(id => !ID_RE.test(id) || !tree.nodes[id])
  if (none.length) warnings.push(`Links to no note: ${none.join(', ')}.`)
  for (const id of mentioned) {
    const by = tree.nodes[id]!.supersededBy
    if (by && !mentioned.has(by)) warnings.push(`${id} is superseded by ${by}: say so on the page (cite ${by}), or drop its number.`)
  }
  const remote = unique(REMOTE_RES.flatMap(re => [...html.matchAll(re)].map(m => ({ at: m.index ?? 0, url: m[1]! }))).sort((a, b) => a.at - b.at).map(r => r.url))
  if (remote.length) warnings.push(`The page loads from elsewhere, which the tree view blocks: ${remote.join(', ')}. Inline it (SVG, a <script> of its own), or leave it out.`)
  const own = new Set([c.id, ...descendants(tree, c.id)])
  const others = [...mentioned].filter(id => !own.has(tree.nodes[id]!.concept))
  if (others.length) info.push(`Cites notes of other concepts: ${others.map(id => `${id} (${tree.concepts?.[tree.nodes[id]!.concept]?.name ?? tree.nodes[id]!.concept})`).join(', ')}.`)
  return { warnings, info, missing: missing.length }
}

/** The sub-concepts of a concept, all the way down. */
function descendants(tree: Tree, id: string): string[] {
  const out: string[] = []
  for (const k of tree.concepts?.[id]?.children ?? []) out.push(k, ...descendants(tree, k))
  return out
}

const IMG_RE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']*)["']/gi
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" }
const unescapeHtml = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e: string) => ENTITIES[e]!)
const normal = (p: string) => (isAbsolute(p) ? resolvePath('/', p) : resolvePath('/', p).slice(1))

/** The images the page names that are not in artifacts/, figures/ or the vault's top (nor at their path on disk). */
async function missingImages(io: Io, vault: string, html: string): Promise<string[]> {
  const out: string[] = []
  for (const m of html.matchAll(IMG_RE)) {
    const src = unescapeHtml(m[1]!).trim()
    if (!src || /^(data:|https?:|\/\/)/i.test(src) || out.includes(src)) continue
    const path = src.replace(/^file:\/\//i, '')
    const inner = path.replace(/^\/+/, '')
    const tries = [...(isAbsolute(path) ? [path] : []), join(vault, ARTIFACTS_DIR, inner), join(vault, FIGURES_DIR, inner), join(vault, inner)]
    let found = false
    for (const t of tries) {
      try { if (await io.exists(normal(t))) { found = true; break } } catch { /* not readable: not found */ }
    }
    if (!found) out.push(src)
  }
  return out
}

// ---------------------------------------------------------------- rft_set_artifact

const quoteShort = (s: string) => JSON.stringify(s.length > 60 ? `${s.slice(0, 57)}…` : s)

const countOf = (text: string, part: string) => {
  let n = 0
  for (let at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + part.length)) n++
  return n
}

const bytes = (s: string) => new TextEncoder().encode(s).length

function checkedPage(html: string): string {
  if (!html.trim()) throw new ArtifactError('the page is empty: give the HTML of the whole page')
  const size = bytes(html)
  if (size > MAX_ARTIFACT_BYTES) throw new ArtifactError(`the page is too large (${size} bytes; ${MAX_ARTIFACT_BYTES} at most): keep the data a page needs, as tables and SVG, and leave the raw outputs where the experiments keep them`)
  return html
}

/** The page once `edits` are made on it, all of them or none; each old_str must be on it exactly once. */
function edited(html: string, edits: ArtifactEdit[]): string {
  let out = html
  edits.forEach((e, i) => {
    const from = typeof e?.old_str === 'string' ? e.old_str : ''
    const to = typeof e?.new_str === 'string' ? e.new_str : null
    if (!from) throw new ArtifactError(`edit ${i + 1}: old_str is empty`)
    if (to === null) throw new ArtifactError(`edit ${i + 1}: new_str is missing (an empty one deletes old_str)`)
    const n = countOf(out, from)
    if (!n) throw new ArtifactError(`edit ${i + 1}: ${quoteShort(from)} is not on the page (rft_artifact gives its path: Read it for the exact text)`)
    if (n > 1) throw new ArtifactError(`edit ${i + 1}: ${quoteShort(from)} is on the page ${n} times: give more of the text around it`)
    out = out.replace(from, () => to)
  })
  return out
}

/** Writes a concept's artifact, whole (`html`) or with `edits`, stamped with the results it was written from. */
export async function setArtifact(io: Io, loaded: Loaded, ref: string, input: { html?: unknown; edits?: unknown }, date: string): Promise<string> {
  const { tree, config } = loaded
  const c = resolveConcept(tree, ref)
  if (!c) throw new ArtifactError(`"${ref}" is not a concept (give its name or the id of the note that starts it; rft_concepts lists them)`)
  const hasHtml = typeof input.html === 'string'
  const edits = Array.isArray(input.edits) ? (input.edits as ArtifactEdit[]) : null
  if (hasHtml === !!edits?.length) throw new ArtifactError('give html (the whole page) or edits (old_str → new_str pairs), one of the two')
  const before = (await readArtifacts(io, loaded))[c.id]
  let html: string
  if (hasHtml) {
    const given = input.html as string
    html = checkedPage(splitArtifact(given)?.html ?? given)
  } else {
    if (!before) throw new ArtifactError(`"${c.name}" has no artifact yet: write the whole page with html`)
    html = checkedPage(edited(before.html, edits!))
  }
  const file = join(ARTIFACTS_DIR, fileName(c))
  const head = headLine({ concept: c.id, name: c.name, updated: date, basis: basisOf(loaded, c.id) })
  await io.write(join(config.vault, file), `${head}\n${html}`)
  if (before && before.path !== file) await io.remove(join(config.vault, before.path))
  Object.assign(loaded, await load(io, config))
  const k = withResults(tree, c.id).length
  const { warnings, info, missing } = checks(loaded.tree, c, html)
  const lost = await missingImages(io, config.vault, html)
  if (lost.length) warnings.push(`Images not found in ${FIGURES_DIR}/, ${ARTIFACTS_DIR}/ or the vault's top: ${lost.join(', ')}. Keep an artifact's figures in the vault's ${FIGURES_DIR}/ and name them ../${FIGURES_DIR}/<file> (the view finds one by name elsewhere in the vault too).`)
  const how = hasHtml ? 'written to' : `updated with ${edits!.length} edit(s) in`
  const coverage = k ? `, ${missing ? `${missing} not on the page` : 'all on the page'}` : ''
  return [
    `Artifact of "${c.name}" ${how} ${file} (${k} experiment${k === 1 ? '' : 's'} with a result${coverage}).`,
    ...warnings.map(w => `- ${w}`),
    ...info,
  ].join('\n')
}

// ---------------------------------------------------------------- rft_artifact

/** How to write the page: in rft_artifact's answer, where it is read before each write. */
export const PAGE_RULES = 'The page: HTML (a fragment or a whole document) with its own <style> and inline <script>; charts as inline SVG. ' +
  'Nothing from elsewhere (no CDN, no fetch): the tree view blocks it. Figures go in the vault\'s figures/ folder, named from the page as <img src="../figures/<file>.svg" alt="…">; save them as SVG (the view offers each SVG figure as a PDF download, and each table as a LaTeX table float to copy: give a table a <caption>). ' +
  'Link every note id, e.g. <a href="#E05">E05</a>: the tree view opens the note and marks the link with its status. ' +
  'Its base style follows the view\'s light and dark themes: use var(--fg), var(--muted), var(--bg), var(--panel), var(--line), var(--accent), var(--good), var(--bad), and var(--c1) … var(--c6) for series. ' +
  'Only numbers that are in the notes, with their spread; say which results are superseded. The view links the sub-concepts\' artifacts itself. ' +
  'To change part of it, rft_set_artifact with edits (old_str exactly as on the page, once); the whole page with html.'

/** The line that says where an artifact is and whether it is up to date. */
export function artifactLine(loaded: Loaded, a: Artifact): string {
  const s = artifactState(loaded, a)
  return `${a.path}, updated ${a.updated || '?'}, ${s.stale ? `out of date: ${describeState(s)}` : 'up to date'}`
}

/** What a concept's artifact is written from: each result (in full when new, changed, or asked for), the experiments without one, the sub-concepts. */
export async function artifactReport(io: Io, loaded: Loaded, ref: string, opts: { full?: boolean } = {}): Promise<string> {
  const { tree } = loaded
  const c = resolveConcept(tree, ref)
  if (!c) throw new ArtifactError(`"${ref}" is not a concept (rft_concepts lists them)`)
  const a = (await readArtifacts(io, loaded))[c.id]
  const state = a ? artifactState(loaded, a) : null
  const out = [`# ${conceptPath(tree.concepts ?? {}, c.id).map(id => tree.concepts![id]!.name).join(' › ')}${c.root ? ` (from ${c.root})` : ''} · ${a ? `artifact: ${artifactLine(loaded, a)}` : `No artifact yet: rft_set_artifact writes ${join(ARTIFACTS_DIR, fileName(c))}`}`]
  if (c.summary) out.push(c.summary)
  const results = withResults(tree, c.id)
  const fresh = new Set([...(state?.changed ?? []), ...(state?.added ?? [])])
  out.push('', `Experiments with a result (${results.length}):`)
  for (const n of results) {
    const head = `${MARK[n.status] ?? '-'} ${n.name}${n.supersededBy ? ` [superseded by ${n.supersededBy}]` : ''}${n.summary ? ` — ${n.summary}` : ''}`
    const mark = state?.changed.includes(n.id) ? ' [changed]' : state?.added.includes(n.id) ? ' [new]' : ''
    if (!a || opts.full || fresh.has(n.id)) out.push(`## ${head}${mark}`, resultOf(loaded.texts[n.id] ?? '') || '(no Result written: it is done)', '')
    else out.push(`- ${head}`)
  }
  if (!results.length) out.push('(none yet: nothing to put on the page)')
  if (state?.removed.length) out.push('', `No longer here (moved or deleted): ${state.removed.join(', ')}: take them off the page.`)
  const without = ownNotes(tree, c.id).filter(n => n.type === 'experiment' && !n.hasResult)
  if (without.length) out.push('', `Without a result yet (${without.length}): ${without.map(n => `${MARK[n.status] ?? '-'} ${n.name}`).join(', ')}`)
  if (c.children.length) out.push('', `Sub-concepts (the view links their artifacts; leave them off this page): ${c.children.map(k => `${tree.concepts![k]!.name} (${k})`).join(', ')}`)
  if (a && !opts.full && results.length > fresh.size) out.push('', 'The unchanged results are one line each: rft_artifact with full: true gives them in full.')
  out.push('', PAGE_RULES)
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

// ---------------------------------------------------------------- the tree says when they go out of date

/** After a status change: whether it put the note's concept's artifact out of date, or the concept has none yet. */
export async function artifactNotice(io: Io, loaded: Loaded, id: string): Promise<string> {
  const n = loaded.tree.nodes[id]
  if (!loaded.hasArtifacts || !n || n.type !== 'experiment' || !n.hasResult) return ''
  const c = loaded.tree.concepts?.[n.concept]
  if (!c) return ''
  const a = (await readArtifacts(io, loaded))[c.id]
  if (!a) return ` "${c.name}" has no artifact yet: write one at the end of this task (rft_artifact, then rft_set_artifact).`
  const s = artifactState(loaded, a)
  return s.stale ? ` The artifact of "${c.name}" is now out of date (${describeState(s)}): update it at the end of this task (rft_artifact, then rft_set_artifact with edits).` : ''
}

/** For rft_map and rft_next, in a vault with artifacts: each concept's artifact mark. */
export async function artifactMarks(io: Io, loaded: Loaded): Promise<Record<string, { stale?: ArtifactState; none?: true; artifact?: Artifact }>> {
  if (!loaded.hasArtifacts) return {}
  const all = await readArtifacts(io, loaded)
  const out: Record<string, { stale?: ArtifactState; none?: true; artifact?: Artifact }> = {}
  for (const c of conceptOrder(loaded.tree.concepts ?? {})) {
    const a = all[c.id]
    if (a) {
      const s = artifactState(loaded, a)
      out[c.id] = s.stale ? { stale: s, artifact: a } : { artifact: a }
    } else if (withResults(loaded.tree, c.id).length) out[c.id] = { none: true }
  }
  return out
}

/** rft_validate: artifacts out of date, and those of a concept that no longer exists. */
export async function artifactWarnings(io: Io, loaded: Loaded): Promise<string[]> {
  const out: string[] = []
  for (const a of Object.values(await readArtifacts(io, loaded))) {
    const c = loaded.tree.concepts?.[a.concept]
    if (!c) { out.push(`${a.path}: the artifact of a concept that no longer exists (${a.concept}); remove the file`); continue }
    const s = artifactState(loaded, a)
    if (s.stale) out.push(`${a.path}: the artifact of "${c.name}" is out of date (${describeState(s)} since ${a.updated || '?'}) — rft_artifact, then rft_set_artifact`)
  }
  return out
}

/** For /rft-artifact with no concept: the concepts with results whose artifact is missing or out of date, in concept order. */
export async function artifactsToWrite(io: Io, loaded: Loaded): Promise<{ concept: Concept; why: 'none yet' | 'out of date' }[]> {
  const all = await readArtifacts(io, loaded)
  const out: { concept: Concept; why: 'none yet' | 'out of date' }[] = []
  for (const c of conceptOrder(loaded.tree.concepts ?? {})) {
    const a = all[c.id]
    if (a) { if (artifactState(loaded, a).stale) out.push({ concept: c, why: 'out of date' }) }
    else if (withResults(loaded.tree, c.id).length) out.push({ concept: c, why: 'none yet' })
  }
  return out
}

// ---------------------------------------------------------------- the standalone page

/** The artifacts as /rft-view embeds them: their state for the tree, and each page with its images as placeholders (data: images kept). */
export async function embeddedArtifacts(io: Io, loaded: Loaded): Promise<{ list: Record<string, unknown>[]; pages: Record<string, string> }> {
  const list: Record<string, unknown>[] = []
  const pages: Record<string, string> = {}
  for (const a of Object.values(await readArtifacts(io, loaded))) {
    list.push({ concept: a.concept, name: a.name, path: a.path, updated: a.updated, version: fnv(a.html), ...artifactState(loaded, a) })
    pages[a.concept] = a.html.replace(/<img\b[^>]*>/gi, tag => {
      const src = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? ''
      if (/^data:/i.test(src)) return tag
      return `<span class="rft-image-missing">[image: ${src.replace(/[<>&"]/g, ch => `&#${ch.charCodeAt(0)};`)}]</span>`
    })
  }
  return { list, pages }
}
