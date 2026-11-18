// /rft-update: what an existing vault lacks next to what this plugin makes, and the change that
// adds it. A vault made by an older plugin keeps working, but misses the folders and templates of
// the types and features added since, and its config the current format. Only what is missing is
// added: no note's text, status or result is changed (the optional sections excepted, which are
// empty headings, and never in a locked note). The derived files (index, canvas, diagram, the
// children lists) are rft_sync's, which runs after.

import { isLocked } from './comments'
import { readArtifacts } from './artifacts'
import type { Concept, Config, Io, Loaded, NodeType } from './vault'
import { CONFIG_PATH, FORMAT, LITERATURE, NODE_TYPES, SUBDIR, TEMPLATES, TYPES, childrenAt, codeRepos, conceptOrder, conceptPath, isLiterature, join, ownNotes } from './vault'

/** One file the update writes: its path from the project root, its new text, and why. */
export type Change = { path: string; text: string; what: string }

export type UpdatePlan = {
  from: number
  to: number
  changes: Change[]
  /** Notes that would get sections but are locked, left as they are. */
  locked: string[]
}

/**
 * A step between two formats: what it changes in the vault, beyond the folders, templates and
 * config every update checks. Add one when a format change has to rewrite what is there.
 */
type Migration = { to: number; changes: (loaded: Loaded) => Change[] }
const MIGRATIONS: Migration[] = []

/** The sections a note of this type and tags has. */
const sectionsOf = (type: NodeType, tags: string[]): readonly string[] =>
  isLiterature({ type, tags }) ? LITERATURE.sections : TYPES[type].sections

/** The note with the missing sections added as empty headings before its children list. */
export function withSections(text: string, sections: readonly string[]): { text: string; added: string[] } {
  const have = new Set([...text.matchAll(/^## (.+)$/gm)].map(m => m[1]!.trim()))
  const added = sections.filter(s => !have.has(s))
  if (!added.length) return { text, added }
  const block = added.map(s => `## ${s}\n`).join('\n') + '\n'
  const at = childrenAt(text)
  if (!at) return { text: `${text.replace(/\s*$/, '\n\n')}${block}`, added }
  const head = at.start - '## Children in the tree\n'.length
  return { text: text.slice(0, head) + block + text.slice(head), added }
}

/** What `/rft-update` would change; `sections` also adds each note's missing sections. */
export async function planUpdate(io: Io, loaded: Loaded, opts: { sections?: boolean } = {}): Promise<UpdatePlan> {
  const { config, tree, texts } = loaded
  const v = config.vault
  const changes: Change[] = []
  const locked: string[] = []
  for (const t of NODE_TYPES) {
    const dir = join(v, SUBDIR[t])
    if (!(await io.exists(dir))) changes.push({ path: join(dir, '.gitkeep'), text: '', what: `folder ${SUBDIR[t]}/ for ${TYPES[t].plural}` })
  }
  for (const t of NODE_TYPES) {
    const path = join(v, `templates/_${t}.md`)
    const text = TEMPLATES[t](config.project)
    if (!(await io.exists(path))) changes.push({ path, text, what: `template of ${TYPES[t].plural}` })
    else if ((await io.read(path)) !== text) changes.push({ path, text, what: `template of ${TYPES[t].plural}, to the current one` })
  }
  for (const m of MIGRATIONS) if (m.to > config.version && m.to <= FORMAT) changes.push(...m.changes(loaded))
  if (opts.sections) {
    for (const n of Object.values(tree.nodes)) {
      const text = texts[n.id] ?? ''
      const next = withSections(text, sectionsOf(n.type, n.tags))
      if (!next.added.length) continue
      if (isLocked(text)) { locked.push(n.id); continue }
      changes.push({ path: join(v, n.path), text: next.text, what: `${n.id}: section(s) ${next.added.join(', ')}` })
    }
  }
  if (config.version < FORMAT) {
    const next: Config = { ...config, version: FORMAT }
    changes.push({ path: CONFIG_PATH, text: JSON.stringify(next, null, 2) + '\n', what: `config: format ${config.version} → ${FORMAT}` })
  }
  return { from: config.version, to: FORMAT, changes, locked }
}

/** The plan in words: what will be added, and how to apply it. */
export function planText(plan: UpdatePlan, sections: boolean): string {
  if (plan.from > plan.to) return `This vault has format ${plan.from}, newer than this plugin's (${plan.to}): update the plugin. Nothing to change here.`
  const lines: string[] = []
  if (!plan.changes.length) lines.push(`The vault is up to date (format ${plan.to}).`)
  else {
    lines.push(`To bring the vault from format ${plan.from} to ${plan.to}, /rft-update apply${sections ? ' --sections' : ''} will write:`)
    const notes = plan.changes.filter(c => /^[A-Z]\d+: section/.test(c.what))
    for (const c of plan.changes) if (!notes.includes(c)) lines.push(`- ${c.what}`)
    if (notes.length) lines.push(`- empty sections in ${notes.length} note(s): ${notes.slice(0, 6).map(c => c.what).join('; ')}${notes.length > 6 ? '; …' : ''}`)
    lines.push('Then rft_sync refreshes the index, canvas and children lists. No note\'s text, status or result changes.')
  }
  if (plan.locked.length) lines.push(`Locked, left as they are: ${plan.locked.join(', ')}.`)
  if (!sections) lines.push('The notes themselves are left alone; /rft-update --sections also lists the sections their type has gained, to add as empty headings.')
  return lines.join('\n')
}

/** Writes the plan's changes. */
export async function applyUpdate(io: Io, plan: UpdatePlan): Promise<void> {
  if (plan.from > plan.to) return
  for (const c of plan.changes) await io.write(c.path, c.text)
}

/** The toast a session starts with when the vault's format is not this plugin's (null when it is): read from the config alone. */
export function behindLine(config: Config): string | null {
  if (config.version > FORMAT) return `rft: this vault has format ${config.version}, newer than this plugin's (${FORMAT}): update the plugin`
  if (config.version < FORMAT) return `rft: this vault is from an older version (format ${config.version}, now ${FORMAT}): /rft-update shows what it adds`
  return null
}

// ---------------------------------------------------------------- /rft-update notebooks

/** What one concept with code still lacks for its artifact to come from notebooks. */
export type ConceptGaps = {
  concept: Concept
  /** Its own experiments with a result and no notebook. */
  bare: string[]
  /** Its own experiments with a result. */
  results: number
  /** Two results or more, and no notebook on its start note to compare them. */
  needsConceptNotebook: boolean
  /** On its artifact: charts drawn as inline SVG, and tables typed rather than placed. */
  svg: number
  tables: number
}

export type NotebookGaps = {
  /** The notebooks there are: experiments', and concepts' (on their start notes). */
  experiments: string[]
  concepts: string[]
  /** Notebooks whose last run predates what a run saves now (no saved numbers, figures and tables). */
  stale: string[]
  byConcept: ConceptGaps[]
}

const inlineCharts = (html: string) => (html.match(/<svg\b/gi) ?? []).length
const typedTables = (html: string) => (html.replace(/<rft-table\b[\s\S]*?<\/rft-table>/gi, '').match(/<table\b/gi) ?? []).length

/**
 * What /rft-update notebooks reports, at no model turn: the notebooks to run again (all of them,
 * so each saves what a run saves now), and, by concept with code, the experiments with a result
 * and no notebook, a missing concept notebook, and an artifact's hand-made charts and tables.
 * `scope`: one concept and its sub-concepts.
 */
export async function notebookGaps(io: Io, loaded: Loaded, scope?: Concept): Promise<NotebookGaps> {
  const { tree, config } = loaded
  const concepts = tree.concepts ?? {}
  const inScope = (cid: string) => !scope || conceptPath(concepts, cid).includes(scope.id)
  const nodes = Object.values(tree.nodes)
  const experiments = nodes.filter(n => n.type === 'experiment' && n.notebook && inScope(n.concept)).map(n => n.id)
  const starts = conceptOrder(concepts).filter(c => c.root && inScope(c.id))
  const conceptNbs = starts.filter(c => tree.nodes[c.root!]?.notebook).map(c => c.root!)
  const stale: string[] = []
  for (const id of [...experiments, ...conceptNbs]) {
    let saved: { contents?: unknown; concepts?: unknown } | null = null
    try { saved = JSON.parse(await io.read(join(config.vault, 'results', `${id}.json`))) as { contents?: unknown; concepts?: unknown } } catch { /* none */ }
    if (!saved || saved.contents === undefined || (tree.nodes[id]?.type === 'experiment' && saved.concepts === undefined)) stale.push(id)
  }
  const artifacts = await readArtifacts(io, loaded)
  const byConcept: ConceptGaps[] = []
  for (const c of starts) {
    if (!codeRepos(concepts, c.id).length) continue
    const own = ownNotes(tree, c.id).filter(n => n.type === 'experiment' && n.hasResult && !n.supersededBy)
    const html = artifacts[c.id]?.html ?? ''
    const g: ConceptGaps = {
      concept: c, bare: own.filter(n => !n.notebook).map(n => n.id), results: own.length,
      needsConceptNotebook: own.length > 1 && !tree.nodes[c.root!]?.notebook, svg: inlineCharts(html), tables: typedTables(html),
    }
    if (g.bare.length || g.needsConceptNotebook || g.svg || g.tables) byConcept.push(g)
  }
  return { experiments, concepts: conceptNbs, stale, byConcept }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The report of /rft-update notebooks: what runs again, and what is still to write, by concept. */
export function gapsText(g: NotebookGaps, queued: string | null, scope?: Concept, queueOff = false): string {
  const out: string[] = []
  const where = scope ? ` in "${scope.name}"` : ''
  const all = g.experiments.length + g.concepts.length
  out.push(`Notebooks${where}: ${plural(g.experiments.length, 'experiment notebook')}, ${plural(g.concepts.length, 'concept notebook')}${g.stale.length ? `; ${g.stale.length} not run since a run saves its figures, tables and numbers for the artifacts (${g.stale.slice(0, 10).join(', ')}${g.stale.length > 10 ? ', …' : ''})` : ''}.`)
  if (queued) {
    out.push(`${queued}: all ${all} run again, one after another, the experiments' then the concepts', in check mode (a Result's numbers are checked, never written over), each saving its numbers, figures and tables and filling the artifacts' tables. The queue's monitor shows how far it is; its end names the ones that differ or failed.`)
  } else if (!all) out.push('Nothing to run again: no experiment or concept has a notebook yet.')
  else if (queueOff) out.push(`Not run again: that goes through the experiment queue, which is off until this machine is paired with it (/rft-machine add); meanwhile Claude runs one at a time with rft_run_notebook.`)
  if (g.byConcept.length) {
    out.push('', 'Still to write, by concept (/rft-update notebooks --write [concept] asks Claude, concept by concept):')
    for (const c of g.byConcept) {
      const parts = [
        c.bare.length ? `${plural(c.bare.length, 'experiment')} with a result and no notebook (${c.bare.slice(0, 8).join(', ')}${c.bare.length > 8 ? ', …' : ''})` : '',
        c.needsConceptNotebook ? `no concept notebook to compare its ${c.results} results` : '',
        c.svg || c.tables ? `its artifact ${[c.svg ? `draws ${plural(c.svg, 'chart')}` : '', c.tables ? `types ${plural(c.tables, 'table')}` : ''].filter(Boolean).join(' and ')} by hand` : '',
      ].filter(Boolean)
      out.push(`- ${c.concept.name} (${c.concept.root ?? c.concept.id}): ${parts.join('; ')}.`)
    }
  } else out.push('', `Nothing left to write${where}: every experiment with a result in a concept with code has a notebook, each concept with several results has its own, and no artifact draws or types its results by hand.`)
  return out.join('\n')
}
