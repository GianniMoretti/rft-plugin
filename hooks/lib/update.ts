// /rft-update: what an existing vault lacks next to what this plugin makes, and the change that
// adds it. A vault made by an older plugin keeps working, but misses the folders and templates of
// the types and features added since, and its config the current format. Only what is missing is
// added: no note's text, status or result is changed (the optional sections excepted, which are
// empty headings, and never in a locked note). The derived files (index, canvas, diagram, the
// children lists) are rft_sync's, which runs after.

import { isLocked } from './comments'
import type { Config, Io, Loaded, NodeType } from './vault'
import { CONFIG_PATH, FORMAT, LITERATURE, NODE_TYPES, SUBDIR, TEMPLATES, TYPES, childrenAt, isLiterature, join } from './vault'

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
