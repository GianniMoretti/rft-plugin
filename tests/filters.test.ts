// The tree view's filters (web/filters.js): tags with any / all, type, status, the date range,
// and hiding that keeps every ancestor of a match so the tree stays connected.

import { describe, expect, test } from 'claude-code/testing'

import '../web/filters.js'

type Node = { id: string; type: string; status: string; date: string; parent: string | null; tags: string[] }
type Filters = { mode: string; tags: string[]; tagMode: string; hiddenTypes: string[]; hiddenStatuses: string[]; from: string; to: string }
type Api = {
  empty: () => Filters
  normalise: (f: unknown) => Filters
  activeCount: (f: Filters) => number
  matches: (n: Node, f: Filters) => boolean
  matching: (t: Tree, f: Filters) => Set<string>
  visible: (t: Tree, f: Filters) => Set<string>
  tagList: (t: Tree) => { tag: string; count: number }[]
}
type Tree = { nodes: Node[]; roots: string[]; tags?: { tag: string; count: number }[] }

const F = (globalThis as unknown as { RftFilters: Api }).RftFilters

//   D00 ─ E01 ─ D01 ─ E02 (cluster, resnet)
//             └ D02 (theory) ─ E03 (theory, cluster)
const node = (id: string, parent: string | null, date: string, tags: string[], status = 'done'): Node =>
  ({ id, type: id[0] === 'E' ? 'experiment' : 'direction', status, date, parent, tags })
const TREE: Tree = {
  roots: ['D00'],
  nodes: [
    node('D00', null, '2026-01-01', []),
    node('E01', 'D00', '2026-01-05', []),
    node('D01', 'E01', '2026-02-01', [], 'idea'),
    node('E02', 'D01', '2026-02-10', ['cluster', 'resnet'], 'running'),
    node('D02', 'E01', '2026-03-01', ['theory']),
    node('E03', 'D02', '2026-03-15', ['theory', 'cluster']),
  ],
}
const f = (over: Partial<Filters>) => F.normalise({ ...F.empty(), ...over })
const ids = (s: Set<string>) => [...s].sort()

describe('filters', () => {
  test('no filter matches everything and counts nothing', () => {
    expect(F.activeCount(F.empty())).toBe(0)
    expect(F.matching(TREE, F.empty()).size).toBe(6)
  })

  test('tags: any of the selected, or all of them', () => {
    expect(ids(F.matching(TREE, f({ tags: ['cluster', 'theory'] })))).toEqual(['D02', 'E02', 'E03'])
    expect(ids(F.matching(TREE, f({ tags: ['cluster', 'theory'], tagMode: 'all' })))).toEqual(['E03'])
    expect(ids(F.matching(TREE, f({ tags: ['resnet'], tagMode: 'all' })))).toEqual(['E02'])
  })

  test('type and status', () => {
    expect(ids(F.matching(TREE, f({ hiddenTypes: ['direction'] })))).toEqual(['E01', 'E02', 'E03'])
    expect(ids(F.matching(TREE, f({ hiddenStatuses: ['done'] })))).toEqual(['D01', 'E02'])
  })

  test('the date range is inclusive, and a note without a date is out once a range is set', () => {
    expect(ids(F.matching(TREE, f({ from: '2026-02-01', to: '2026-03-01' })))).toEqual(['D01', 'D02', 'E02'])
    expect(ids(F.matching(TREE, f({ from: '2026-03-02' })))).toEqual(['E03'])
    expect(ids(F.matching(TREE, f({ to: '2026-01-05' })))).toEqual(['D00', 'E01'])
    const undated = { ...TREE, nodes: [...TREE.nodes, node('E04', 'D00', '', [])] }
    expect(F.matching(undated, f({ from: '2026-01-01' })).has('E04')).toBe(false)
    expect(F.matching(undated, F.empty()).has('E04')).toBe(true)
  })

  test('hide keeps every ancestor of a match, and the root; dim draws everything', () => {
    const tagged = f({ tags: ['resnet'], mode: 'hide' })
    expect(ids(F.visible(TREE, tagged))).toEqual(['D00', 'D01', 'E01', 'E02'])
    expect(ids(F.visible(TREE, f({ tags: ['theory'], tagMode: 'all', mode: 'hide' })))).toEqual(['D00', 'D02', 'E01', 'E03'])
    expect(ids(F.visible(TREE, f({ tags: ['nothing'], mode: 'hide' })))).toEqual(['D00'])
    expect(F.visible(TREE, f({ tags: ['resnet'] })).size).toBe(6)
  })

  test('several kinds count once each; normalise drops what is not a filter', () => {
    expect(F.activeCount(f({ tags: ['a', 'b'], hiddenTypes: ['direction'], from: '2026-01-01', to: '2026-02-01' }))).toBe(3)
    const back = F.normalise({ mode: 'weird', tags: ['a', 3, 'a'], tagMode: 'x', hiddenTypes: ['person'], from: 'yesterday' })
    expect(back).toEqual({ mode: 'dim', tags: ['a'], tagMode: 'any', hiddenTypes: [], hiddenStatuses: [], from: '', to: '' })
  })

  test('the tag list counts the notes, most used first, or takes the server one', () => {
    expect(F.tagList(TREE)).toEqual([{ tag: 'cluster', count: 2 }, { tag: 'theory', count: 2 }, { tag: 'resnet', count: 1 }])
    expect(F.tagList({ ...TREE, tags: [{ tag: 'x', count: 9 }] })).toEqual([{ tag: 'x', count: 9 }])
  })
})
