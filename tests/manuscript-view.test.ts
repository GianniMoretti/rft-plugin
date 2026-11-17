// The tree view's Manuscript tab (web/manuscript.js): a selection's anchor, a document's snippets
// in order, a snippet's state, the snippets resting on a note, an error of the compile in a line.

import { describe, expect, test } from 'claude-code/testing'

import '../web/manuscript.js'

type Snippet = { id: string; kind?: string; title?: string; basis?: string[]; review?: string[]; stub?: boolean; missing?: string[]; absent?: boolean }
type Ms = { snippets: Snippet[]; documents: { name: string; order: string[] }[] }
type Api = {
  CONTEXT: number
  anchorOf: (text: string, start: number, end: number) => { quote: string; prefix: string; suffix: string }
  listOf: (ms: Ms | null, doc: string) => { placed: Snippet[]; loose: Snippet[] }
  stateOf: (s: Snippet) => { word: string; why: string }
  writtenIn: (ms: Ms | null, id: string) => string[]
  errorText: (e: { file: string; snippet?: string; line: number | null; message: string; context?: string }) => string
}
const M = (globalThis as unknown as { RftManuscript: Api }).RftManuscript

const ms: Ms = {
  snippets: [
    { id: 'S01', basis: ['E05', 'R01'], stub: false, review: [], missing: [] },
    { id: 'S02', basis: ['E06'], stub: true, review: [] },
    { id: 'S03', basis: ['E05'], stub: false, review: ['E05 superseded by E09'] },
  ],
  documents: [{ name: 'paper', order: ['S03', 'S01', 'S07'] }, { name: 'thesis', order: ['S01'] }],
}

describe('the manuscript tab', () => {
  test('a selection is anchored by its quote and the text around it, as the comments are', () => {
    const text = 'x'.repeat(50) + 'QUOTE' + 'y'.repeat(50)
    expect(M.anchorOf(text, 50, 55)).toEqual({ quote: 'QUOTE', prefix: 'x'.repeat(M.CONTEXT), suffix: 'y'.repeat(M.CONTEXT) })
    expect(M.anchorOf('ab QUOTE cd', 3, 8)).toEqual({ quote: 'QUOTE', prefix: 'ab ', suffix: ' cd' })
  })

  test('a document\'s snippets in its order, a line naming none kept as absent, then those in no document', () => {
    const { placed, loose } = M.listOf(ms, 'paper')
    expect(placed.map(s => [s.id, !!s.absent])).toEqual([['S03', false], ['S01', false], ['S07', true]])
    expect(loose.map(s => s.id)).toEqual(['S02'])
    expect(M.listOf(ms, 'book')).toEqual({ placed: [], loose: [ms.snippets[1]] })
    expect(M.listOf(null, 'paper')).toEqual({ placed: [], loose: [] })
  })

  test('a snippet\'s state: review first, then stub or written', () => {
    expect(M.stateOf(ms.snippets[2]!)).toEqual({ word: 'review', why: 'E05 superseded by E09' })
    expect(M.stateOf(ms.snippets[1]!)).toEqual({ word: 'stub', why: '' })
    expect(M.stateOf(ms.snippets[0]!)).toEqual({ word: 'written', why: '' })
  })

  test('the snippets resting on a note, for its drawer', () => {
    expect(M.writtenIn(ms, 'E05')).toEqual(['S01', 'S03'])
    expect(M.writtenIn(ms, 'D01')).toEqual([])
    expect(M.writtenIn(null, 'E05')).toEqual([])
  })

  test('an error of the compile in a line', () => {
    expect(M.errorText({ file: 'snippets/S02.tex', snippet: 'S02', line: 4, message: 'Undefined control sequence.', context: 'l.4 \\rftnu' }))
      .toBe('S02:4: Undefined control sequence. (l.4 \\rftnu)')
    expect(M.errorText({ file: 'documents/paper/main.tex', line: null, message: 'Emergency stop.' })).toBe('documents/paper/main.tex: Emergency stop.')
  })
})
