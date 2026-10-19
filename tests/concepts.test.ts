// Concepts: inherited membership and nesting in the vault model, the concept tree the API and
// the static page expose, rft_set_concept, validation, the session context grouped by concept,
// and the web view's concept logic (web/concepts.js), regions included under hide-mode filters.

import { describe, expect, test } from 'claude-code/testing'

import '../web/concepts.js'
import '../web/filters.js'

import { conceptsReport, groupedTree, setConcept } from '../hooks/lib/ops'
import { treeJson } from '../hooks/lib/page'
import { ROOT_CONCEPT, front, load, readConfig, validate } from '../hooks/lib/vault'
import { D00, D01, E01, E02, MemoryFs, demoFiles } from './fixture'

/** Adds `concept:` (and a summary) to a note of the fixture, after its tags. */
function withConcept(files: Record<string, string>, path: string, name: string, summary?: string) {
  const extra = `concept: "${name}"${summary ? `\nconcept_summary: "${summary}"` : ''}`
  files[path] = files[path]!.replace(/^(tags: .*)$/m, `$1\n${extra}`)
  return files
}

//   D00 ─ E01 (concept "Checks") ─ D01 (concept "Variants", nested) ─ E02
const nested = () => {
  const files = demoFiles()
  withConcept(files, `vault/experiments/${E01}.md`, 'Checks', 'The first checks')
  withConcept(files, `vault/directions/${D01}.md`, 'Variants')
  return files
}

const loadFrom = async (files: Record<string, string>) => {
  const fs = new MemoryFs(files)
  const io = fs.io()
  return { fs, io, loaded: await load(io, (await readConfig(io))!) }
}

describe('concepts in the vault', () => {
  test('membership is inherited down the tree, the nearest declaration wins, and concepts nest', async () => {
    const { loaded } = await loadFrom(nested())
    const n = loaded.tree.nodes
    expect([n.D00!.concept, n.E01!.concept, n.D01!.concept, n.E02!.concept]).toEqual([ROOT_CONCEPT, 'E01', 'D01', 'D01'])
    const c = loaded.tree.concepts!
    expect(c.root!.name).toBe('demo')
    expect(c.root!.children).toEqual(['E01'])
    expect(c.E01).toMatchObject({ name: 'Checks', summary: 'The first checks', root: 'E01', parent: 'root', depth: 1, count: 1, total: 3 })
    expect(c.D01).toMatchObject({ name: 'Variants', parent: 'E01', depth: 2, count: 2, total: 2, statuses: { idea: 1, running: 1 } })
    expect(c.root).toMatchObject({ count: 1, total: 4, statuses: { done: 1 } })
  })

  test('without any declaration every note is in the project root concept', async () => {
    const { loaded } = await loadFrom(demoFiles())
    expect(Object.keys(loaded.tree.concepts!)).toEqual(['root'])
    expect(Object.values(loaded.tree.nodes).every(n => n.concept === 'root')).toBe(true)
    expect(groupedTree(loaded.tree)).toContain(`  ✓ ${E01}`) // the plain indented tree
  })

  test('the API concept tree: depth first from the root, with names, roots, parents, counts and statuses', async () => {
    const { loaded } = await loadFrom(nested())
    const json = treeJson(loaded.tree, 'demo', 'v1')
    expect(json.concepts.map(c => [c.id, c.name, c.root, c.parent, c.count, c.total])).toEqual([
      ['root', 'demo', null, null, 1, 4],
      ['E01', 'Checks', 'E01', 'root', 1, 3],
      ['D01', 'Variants', 'D01', 'E01', 2, 2],
    ])
    expect(json.nodes.find(x => x.id === 'E02')!.concept).toBe('D01')
  })

  test('rft_set_concept sets, renames, summarises and removes a concept', async () => {
    const { fs, io, loaded } = await loadFrom(demoFiles())
    const path = `vault/directions/${D01}.md`
    expect(await setConcept(io, loaded, 'D01', 'Better variants', 'Whether a variant beats the check')).toContain('now starts the concept "Better variants"')
    expect(front(fs.read(path)).concept).toBe('"Better variants"')
    expect(front(fs.read(path)).concept_summary).toBe('"Whether a variant beats the check"')
    expect(loaded.tree.nodes.E02!.concept).toBe('D01')
    expect(await setConcept(io, loaded, 'D01', 'Variants')).toContain('renamed to "Variants"')
    expect(front(fs.read(path)).concept_summary).toBe('"Whether a variant beats the check"')
    expect(conceptsReport(loaded)).toContain('- Variants [@D01] 2 note(s)')
    expect(await setConcept(io, loaded, 'D01', null)).toContain('no longer starts the concept "Variants"')
    expect(front(fs.read(path)).concept).toBeUndefined()
    expect(front(fs.read(path)).concept_summary).toBeUndefined()
    expect(loaded.tree.nodes.E02!.concept).toBe('root')
    await expect(setConcept(io, loaded, 'D01', 'Bad #name')).rejects.toThrow(/cannot contain/)
    await expect(setConcept(io, loaded, 'D01', '   ')).resolves.toContain('nothing to remove')
    await expect(setConcept(io, loaded, 'X9', 'Name')).rejects.toThrow(/not a note/)
  })

  test('validation: an empty name and forbidden characters are errors, a duplicate name a warning', async () => {
    const files = demoFiles()
    files[`vault/experiments/${E01}.md`] = files[`vault/experiments/${E01}.md`]!.replace(/^(tags: .*)$/m, '$1\nconcept: ""')
    withConcept(files, `vault/directions/${D01}.md`, 'Odd [name]')
    withConcept(files, `vault/experiments/${E02}.md`, 'Demo')
    const { io, loaded } = await loadFrom(files)
    const v = await validate(io, loaded)
    expect(v.errors.some(e => e.includes('E01: `concept:` is empty'))).toBe(true)
    expect(v.errors.some(e => e.includes('concept name "Odd [name]"'))).toBe(true)
    expect(v.warnings.some(w => w.includes('concept name "Demo" is used twice'))).toBe(true)
  })

  test('the session context is grouped by concept, saying a parent when it is not the line above', async () => {
    const { loaded } = await loadFrom(nested())
    expect(groupedTree(loaded.tree)).toBe([
      '## demo',
      `✓ ${D00}`,
      '## demo › Checks (from E01) — The first checks',
      `✓ ${E01} ← D00`,
      '## demo › Checks › Variants (from D01)',
      `? ${D01} ← E01`,
      `… ${E02}`,
    ].join('\n'))
  })
})

type Node = { id: string; parent: string | null; children: string[]; concept: string; status: string; type: string; date: string; tags: string[]; conceptPath?: string[] }
type Tree = { project: string; nodes: Node[]; roots: string[]; concepts: unknown[] }
const CW = (globalThis as unknown as { RftConcepts: {
  ROOT: string; PALETTE: string[]
  annotate: (t: Tree) => Map<string, { id: string; children: string[] }>
  pathOf: (c: Map<string, unknown>, id: string) => string[]
  colourOf: (c: Map<string, unknown>, id: string) => string | null
  region: (t: Tree, id: string, drawn: Set<string>) => { nodes: string[]; links: [string, string][] }
  totalStatuses: (c: Map<string, unknown>, id: string) => Record<string, number>
  subtree: (t: Tree, id: string) => Set<string>
} }).RftConcepts
const FW = (globalThis as unknown as { RftFilters: {
  normalise: (f: unknown) => unknown
  visible: (t: Tree, f: unknown) => Set<string>
  matching: (t: Tree, f: unknown) => Set<string>
} }).RftFilters

/** The fixture's tree as the API answers it, with two more notes under D01. */
async function apiTree(): Promise<Tree> {
  const files = nested()
  const { loaded } = await loadFrom(files)
  const json = treeJson(loaded.tree, 'demo', 'v1') as unknown as Tree
  // D01 ─ E02 (tag x) and D01 ─ D02 (tag y): a sibling to hide
  json.nodes.find(n => n.id === 'E02')!.tags = ['x']
  json.nodes.find(n => n.id === 'D01')!.children.push('D02')
  json.nodes.push({ id: 'D02', parent: 'D01', children: [], concept: 'D01', status: 'idea', type: 'direction', date: '2026-01-09', tags: ['y'] })
  return json
}

describe('concepts in the web view', () => {
  test('every note gets its path of concepts; colours are distinct and none for the root', async () => {
    const tree = await apiTree()
    const concepts = CW.annotate(tree)
    expect(tree.nodes.find(n => n.id === 'E02')!.conceptPath).toEqual(['root', 'E01', 'D01'])
    expect(tree.nodes.find(n => n.id === 'D00')!.conceptPath).toEqual(['root'])
    expect(CW.colourOf(concepts, 'root')).toBeNull()
    expect(CW.colourOf(concepts, 'E01')).not.toBe(CW.colourOf(concepts, 'D01'))
    // the status colours of the page (app.css), dark and light, never used for concepts
    for (const status of ['#40c057', '#fd7e14', '#fab005', '#ffe066', '#fa5252', '#868e96', '#4dabf7', '#2f9e44', '#e8590c', '#e03131', '#1c7ed6']) {
      expect(CW.PALETTE).not.toContain(status)
    }
    // the counts come from the API (D02 was added by hand above, so it is not in them)
    expect(CW.totalStatuses(concepts, 'E01')).toEqual({ done: 1, idea: 1, running: 1 })
  })

  test('a region covers the drawn notes of the concept and its sub-concepts, and their links', async () => {
    const tree = await apiTree()
    CW.annotate(tree)
    const all = new Set(tree.nodes.map(n => n.id))
    expect(CW.region(tree, 'E01', all)).toEqual({ nodes: ['E01', 'E02', 'D01', 'D02'], links: [['D01', 'E02'], ['E01', 'D01'], ['D01', 'D02']] })
    expect(CW.region(tree, 'D01', all).nodes).toEqual(['E02', 'D01', 'D02'])
    // a folded branch: its notes are not drawn, so not in the region
    expect(CW.region(tree, 'D01', new Set(['D00', 'E01', 'D01'])).nodes).toEqual(['D01'])
  })

  test('with hide-mode filters a region keeps to the notes still drawn, ancestors of matches included', async () => {
    const tree = await apiTree()
    CW.annotate(tree)
    const hide = FW.normalise({ tags: ['x'], mode: 'hide' })
    const drawn = FW.visible(tree, hide)
    expect([...drawn].sort()).toEqual(['D00', 'D01', 'E01', 'E02'])
    expect(CW.region(tree, 'D01', drawn)).toEqual({ nodes: ['E02', 'D01'], links: [['D01', 'E02']] })
    expect(CW.region(tree, 'E01', drawn).links).toEqual([['D01', 'E02'], ['E01', 'D01']])
    // filtering by concept: the concept or one of its sub-concepts on the note's path
    expect([...FW.matching(tree, FW.normalise({ concepts: ['E01'] }))].sort()).toEqual(['D01', 'D02', 'E01', 'E02'])
    expect([...FW.matching(tree, FW.normalise({ concepts: ['D01'] }))].sort()).toEqual(['D01', 'D02', 'E02'])
  })

  test('a focus shows the subtree of the concept root', async () => {
    const tree = await apiTree()
    expect([...CW.subtree(tree, 'D01')].sort()).toEqual(['D01', 'D02', 'E02'])
    expect(CW.pathOf(CW.annotate(tree) as Map<string, unknown>, 'D01')).toEqual(['root', 'E01', 'D01'])
  })
})
