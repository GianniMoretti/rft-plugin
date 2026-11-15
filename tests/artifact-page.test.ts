// A concept's artifact in the tree view (web/artifacts.js). It opens in the note drawer when a
// concept is clicked: its name on a region or badge in the tree, its node in the concept view, or
// the concept path in a note's header (and `?artifact=<id>` in the address). The drawer shows the
// state of the concept's artifact, the links to its sub-concepts, and the artifact itself in a
// sandboxed frame, whose note links open the note in the same drawer. Tested here: the state of
// one concept, what the drawer says about it, its sub-concepts, the note links inside an artifact
// (where they lead, how they are marked from the tree), the frame's address, and the frame of the
// standalone page.

import { describe, expect, test } from 'claude-code/testing'

import '../web/artifacts.js'

type Entry = { id: string; name: string; state: 'fresh' | 'stale' | 'none' | 'empty'; results: string[]; artifact: Record<string, unknown> | null }
type Api = {
  entry: (tree: unknown, id: string) => Entry | null
  stateText: (entry: Entry, tree: unknown) => string
  subConcepts: (tree: unknown, id: string) => { id: string; name: string; state: Entry['state'] }[]
  linkTarget: (href: string | null) => string | null
  decoration: (byId: Map<string, unknown>, id: string) => { cls: string; title: string }
  frameSrc: (concept: string, opts: { theme: string; token?: string; y?: number }) => string
  wrap: (html: string, frame: { js: string; css: string }, theme: string) => string
}

const A = (globalThis as unknown as { RftArtifacts: Api }).RftArtifacts

const node = (id: string, concept: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ id, name: `${id} Title of ${id}`, title: `Title of ${id}`, type: id[0] === 'E' ? 'experiment' : 'direction', status, concept, ...extra })

/** The demo's concepts: the project, Strong augmentation (D02) with Mix-based (D04) and Why it fails (D03) below it; an artifact of Baselines (D01), a concept no longer there. */
const TREE = {
  concepts: [
    { id: 'root', name: 'demo', root: null, parent: null, depth: 0, children: ['D02'] },
    { id: 'D02', name: 'Strong augmentation', root: 'D02', parent: 'root', depth: 1, children: ['D04', 'D03'] },
    { id: 'D04', name: 'Mix-based augmentation', root: 'D04', parent: 'D02', depth: 2, children: [] },
    { id: 'D03', name: 'Why it fails at 1k', root: 'D03', parent: 'D02', depth: 2, children: [] },
  ],
  nodes: [
    node('D00', 'root', 'done'), node('E01', 'root', 'done', { hasResult: true }),
    node('D02', 'D02', 'done'), node('E07', 'D02', 'done', { hasResult: true }),
    node('D04', 'D04', 'done'), node('E05', 'D04', 'done', { hasResult: true, supersededBy: 'E06' }),
    node('E06', 'D04', 'done', { hasResult: true }), node('E08', 'D04', 'planned'),
    node('D03', 'D03', 'running'), node('E04', 'D03', 'running'), node('E09', 'D03', 'planned'),
  ],
  artifacts: [
    { concept: 'D02', name: 'Strong augmentation', path: 'artifacts/D02 Strong augmentation.html', updated: '2026-03-01', version: 'v1', stale: false, changed: [], added: [], removed: [] },
    { concept: 'D04', name: 'Mix-based augmentation', path: 'artifacts/D04 Mix-based augmentation.html', updated: '2026-03-02', version: 'v2', stale: true, changed: ['E06'], added: ['E10'], removed: ['E03'] },
    { concept: 'D01', name: 'Baselines', path: 'artifacts/D01 Baselines.html', updated: '2026-02-01', version: 'v3', stale: true, changed: [], added: [], removed: ['E02'] },
  ],
}

describe('artifacts page', () => {
  test("one concept's artifact and its state: up to date, out of date, none yet, or no results to show", () => {
    const state = (id: string) => { const e = A.entry(TREE, id)!; return [e.id, e.name, e.state, e.results] }
    expect(state('root')).toEqual(['root', 'demo', 'none', ['E01']])
    expect(state('D02')).toEqual(['D02', 'Strong augmentation', 'fresh', ['E07']])
    expect(state('D04')).toEqual(['D04', 'Mix-based augmentation', 'stale', ['E05', 'E06']])
    expect(state('D03')).toEqual(['D03', 'Why it fails at 1k', 'empty', []])
    expect(A.entry(TREE, 'D04')!.artifact).toMatchObject({ version: 'v2' })
    expect(A.entry(TREE, 'D02')!.artifact).toMatchObject({ path: 'artifacts/D02 Strong augmentation.html' })
    expect(A.entry(TREE, 'D03')!.artifact).toBe(null)
    // an artifact whose concept is gone opens from nowhere (rft_validate reports it), and an unknown id is none
    expect(A.entry(TREE, 'D01')).toBe(null)
    expect(A.entry(TREE, 'E05')).toBe(null)
  })

  test('what the drawer says about each state', () => {
    const say = (tree: typeof TREE, id: string) => A.stateText(A.entry(tree, id)!, tree)
    expect(say(TREE, 'D02')).toBe('Up to date · updated 2026-03-01')
    expect(say(TREE, 'D04')).toBe('Out of date: E06 changed, E10 new, E03 no longer here · updated 2026-03-02')
    expect(say(TREE, 'root')).toBe('No artifact yet: 1 experiment with a result (E01). /rft-artifact demo asks Claude to write it.')
    expect(say(TREE, 'D03')).toBe('No results yet: 1 running (E04), 1 planned (E09).')
    const bare = { ...TREE, nodes: TREE.nodes.filter(n => n.concept !== 'D03' || n.type !== 'experiment') }
    expect(say(bare, 'D03')).toBe('No results yet: no experiments.')
  })

  test("a concept's sub-concepts, with the state of their artifacts, for the links beside it", () => {
    expect(A.subConcepts(TREE, 'D02')).toEqual([
      { id: 'D04', name: 'Mix-based augmentation', state: 'stale' },
      { id: 'D03', name: 'Why it fails at 1k', state: 'empty' },
    ])
    expect(A.subConcepts(TREE, 'D04')).toEqual([])
  })

  test('a link to a note is #<id>; anything else is no note', () => {
    expect(A.linkTarget('#E05')).toBe('E05')
    expect(A.linkTarget('#D00')).toBe('D00')
    expect(A.linkTarget('#R12')).toBe('R12')
    expect(A.linkTarget('#e05')).toBe(null)
    expect(A.linkTarget('#results')).toBe(null)
    expect(A.linkTarget('https://arxiv.org/abs/1905.04899#E05')).toBe(null)
    expect(A.linkTarget(null)).toBe(null)
  })

  test('a note link is marked as the tree has the note now: its status, superseded, or missing', () => {
    const byId = new Map(TREE.nodes.map(n => [n.id, n]))
    expect(A.decoration(byId, 'E06')).toEqual({ cls: 'rft-note s-done', title: 'E06 Title of E06 · done' })
    expect(A.decoration(byId, 'E05')).toEqual({ cls: 'rft-note s-done superseded', title: 'E05 Title of E05 · done · superseded by E06' })
    expect(A.decoration(byId, 'E04')).toEqual({ cls: 'rft-note s-running', title: 'E04 Title of E04 · running' })
    expect(A.decoration(byId, 'E99')).toEqual({ cls: 'rft-note missing', title: 'No note E99 in the tree' })
  })

  test("the frame's address: the concept, the theme, where it was scrolled to, and the key when the page has it", () => {
    expect(A.frameSrc('D04', { theme: 'dark' })).toBe('api/artifact?concept=D04&theme=dark')
    expect(A.frameSrc('root', { theme: 'light', y: 0, token: '' })).toBe('api/artifact?concept=root&theme=light')
    expect(A.frameSrc('D04', { theme: 'light', y: 420.6, token: 'k3y' })).toBe('api/artifact?concept=D04&theme=light&y=421&token=k3y')
  })

  test('the standalone frame: the base style, the theme and the runtime before the page, a full document keeping its own head', () => {
    const frame = { js: '/* frame */', css: '/* frame css */' }
    const part = A.wrap('<h1>Mix</h1>', frame, 'dark')
    expect(part.startsWith('<!doctype html>')).toBe(true)
    expect(part).toContain('<style>/* frame css */</style>')
    expect(part).toContain('document.documentElement.dataset.theme = "dark"')
    expect(part).toContain('<script>/* frame */</script>')
    expect(part.indexOf('/* frame */')).toBeLessThan(part.indexOf('<h1>Mix</h1>'))
    const whole = A.wrap('<!DOCTYPE html>\n<html lang="en"><head><title>Mix</title><style>h1{}</style></head><body><h1>Mix</h1></body></html>', frame, 'light')
    expect(whole.match(/<head>/gi)).toHaveLength(1)
    expect(whole.indexOf('/* frame css */')).toBeLessThan(whole.indexOf('<title>Mix</title>'))
    expect(whole.indexOf('<title>Mix</title>')).toBeLessThan(whole.indexOf('h1{}'))
    expect(whole).toContain('<html lang="en">')
    // a page that writes </script> in its own text cannot end the runtime early
    expect(A.wrap('<p>x</p>', { js: 'a("</script>")', css: '' }, 'light')).not.toContain('a("</script>")')
  })
})
