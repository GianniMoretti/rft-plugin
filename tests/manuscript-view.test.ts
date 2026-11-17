// The tree view's Manuscript tab (web/manuscript.js), two views: a selection's anchor, the library
// by kind, a snippet's state and where it is used, the content a copy takes, a document's outline,
// the snippets resting on a note, an error of the compile in a line.

import { describe, expect, test } from 'claude-code/testing'

import '../web/manuscript.js'

type Snippet = { id: string; kind?: string; title?: string; basis?: string[]; review?: string[]; stub?: boolean; usedIn?: { doc: string; state: string }[] }
type Ms = { snippets: Snippet[] }
type Api = {
  CONTEXT: number
  anchorOf: (text: string, start: number, end: number) => { quote: string; prefix: string; suffix: string }
  contentOf: (snippetText: string) => string
  byKind: (snippets: Snippet[]) => { kind: string; snippets: Snippet[] }[]
  stateOf: (s: Snippet) => { word: string; why: string }
  usedWords: (s: Snippet) => string
  outlineOf: (text: string, copies: { id: string; state: string; snippetReview?: boolean }[]) => Record<string, unknown>[]
  writtenIn: (ms: Ms | null, id: string) => string[]
  slugOf: (title: string) => string
  docNameProblem: (name: string, taken: string[]) => string
  errorText: (e: { file: string; snippet?: string; line: number | null; message: string; context?: string }) => string
}
const M = (globalThis as unknown as { RftManuscript: Api }).RftManuscript

const ms: Ms = {
  snippets: [
    { id: 'S01', kind: 'result', basis: ['E05', 'R01'], stub: false, review: [], usedIn: [{ doc: 'paper', state: 'sync' }, { doc: 'thesis', state: 'adapted' }] },
    { id: 'S02', kind: 'definition', basis: ['E06'], stub: true, review: [], usedIn: [] },
    { id: 'S03', kind: 'result', basis: ['E05'], stub: false, review: ['E05 superseded by E09'], usedIn: [{ doc: 'paper', state: 'review' }] },
    { id: 'S04', kind: 'essay', basis: [], stub: true, review: [] },
  ],
}

describe('the manuscript tab', () => {
  test('a selection is anchored by its quote and the text around it, as the comments are', () => {
    const text = 'x'.repeat(50) + 'QUOTE' + 'y'.repeat(50)
    expect(M.anchorOf(text, 50, 55)).toEqual({ quote: 'QUOTE', prefix: 'x'.repeat(M.CONTEXT), suffix: 'y'.repeat(M.CONTEXT) })
    expect(M.anchorOf('ab QUOTE cd', 3, 8)).toEqual({ quote: 'QUOTE', prefix: 'ab ', suffix: ' cd' })
  })

  test('the library by kind, in the kinds\' order, an unknown kind last', () => {
    expect(M.byKind(ms.snippets).map(g => [g.kind, g.snippets.map(s => s.id)])).toEqual([['definition', ['S02']], ['result', ['S01', 'S03']], ['other', ['S04']]])
  })

  test('a snippet\'s state, and where it is used', () => {
    expect(M.stateOf(ms.snippets[2]!)).toEqual({ word: 'review', why: 'E05 superseded by E09' })
    expect(M.stateOf(ms.snippets[1]!)).toEqual({ word: 'stub', why: '' })
    expect(M.stateOf(ms.snippets[0]!)).toEqual({ word: 'written', why: '' })
    expect(M.usedWords(ms.snippets[0]!)).toBe('paper, thesis (adapted)')
    expect(M.usedWords(ms.snippets[2]!)).toBe('paper (to review)')
    expect(M.usedWords(ms.snippets[1]!)).toBe('')
  })

  test('what a copy takes from a snippet: its text below the header, as the plugin takes it', () => {
    expect(M.contentOf('% rft-snippet S01 · result · X\n% basis: E05\n\n\\paragraph{X}\nText.\n\n')).toBe('\\paragraph{X}\nText.')
    expect(M.contentOf('No header.\n')).toBe('No header.')
  })

  test('a document\'s outline: its headings and its copies with their state and lines', () => {
    const doc = [
      '\\begin{document}', '\\section{Results}', '% rft-begin S01 a1b2c3d4', 'Text.', '% rft-end S01',
      '\\subsection{More}', '% rft-begin S03 00000000', 'Old.', '% rft-end S03', '% rft-begin S09 11111111', 'no end', '\\end{document}',
    ].join('\n')
    expect(M.outlineOf(doc, [{ id: 'S01', state: 'adapted' }, { id: 'S03', state: 'review', snippetReview: true }])).toEqual([
      { type: 'heading', level: 'section', title: 'Results', line: 1 },
      { type: 'copy', id: 'S01', line: 2, end: 4, state: 'adapted', snippetReview: false },
      { type: 'heading', level: 'subsection', title: 'More', line: 5 },
      { type: 'copy', id: 'S03', line: 6, end: 8, state: 'review', snippetReview: true },
    ])
  })

  test('the snippets resting on a note, for its drawer', () => {
    expect(M.writtenIn(ms, 'E05')).toEqual(['S01', 'S03'])
    expect(M.writtenIn(ms, 'D01')).toEqual([])
    expect(M.writtenIn(null, 'E05')).toEqual([])
  })

  test('a new document: its name made from its title, and checked', () => {
    expect(M.slugOf('Strong augmentation on small data')).toBe('strong-augmentation-on-small-data')
    expect(M.slugOf('  Données: l\'écart à 1k images! ')).toBe('donnees-l-ecart-a-1k-images')
    expect(M.slugOf('Chapter 3 — Mixup & CutMix, revisited for small datasets in vision')).toBe('chapter-3-mixup-cutmix-revisited-for-sma')
    expect(M.slugOf('???')).toBe('')
    expect(M.docNameProblem('', [])).toBe('Give it a name: it is its folder, documents/<name>/')
    expect(M.docNameProblem('My Paper', [])).toBe('Lowercase letters, digits and dashes only, starting with a letter or digit')
    expect(M.docNameProblem('-paper', [])).toBe('Lowercase letters, digits and dashes only, starting with a letter or digit')
    expect(M.docNameProblem('paper', ['paper', 'thesis'])).toBe('There is already a document paper')
    expect(M.docNameProblem('thesis-ch3', ['paper'])).toBe('')
  })

  test('an error of the compile in a line', () => {
    expect(M.errorText({ file: 'snippets/S02.tex', snippet: 'S02', line: 4, message: 'Undefined control sequence.', context: 'l.4 \\rftnu' }))
      .toBe('S02:4: Undefined control sequence. (l.4 \\rftnu)')
    expect(M.errorText({ file: 'documents/paper/main.tex', line: null, message: 'Emergency stop.' })).toBe('documents/paper/main.tex: Emergency stop.')
  })
})
