// A document of the first design converted to clean source (hooks/lib/convert.ts,
// docs/adr/0003-a-document-holds-no-trace.md), held to the fixture (tests/fixtures/local-overleaf/
// first-design): the document as the first design had it (before), and as its conversion must leave
// it (after), which tests/test_clean_source.py compiles from its folder alone and scans.

import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { convertDocuments, isFirstDesign } from '../hooks/lib/convert'
import { copyState, manuscriptWarnings, readManuscript, tracesOf, valuesOf } from '../hooks/lib/manuscript'
import { load, readConfig } from '../hooks/lib/vault'
import { CWD, MemoryFs, world } from './fixture'
import { FILES, FIRST_DESIGN } from './fixtures/local-overleaf'

const DOC = 'vault/documents/paper'
const KEPT = 'vault/documents/.rft/paper/first-design'

/** The fixture's vault with its document as the first design had it. */
async function setup(extra: Record<string, string> = {}) {
  const files = Object.fromEntries(Object.entries(FILES).filter(([k]) => !k.startsWith(`${DOC}/`) && !k.startsWith('vault/documents/.rft/')))
  for (const [rel, text] of Object.entries(FIRST_DESIGN.before)) files[`${DOC}/${rel}`] = text
  const fs = new MemoryFs({ ...files, ...extra })
  const io = fs.io()
  const l = await load(io, (await readConfig(io))!)
  return { fs, io, l }
}

const folder = (fs: MemoryFs) => Object.fromEntries([...fs.files].filter(([k]) => k.startsWith(`${DOC}/`)).map(([k, v]) => [k.slice(DOC.length + 1), v.text]))

describe('a document of the first design', () => {
  test('is converted to the plain LaTeX the fixture holds, its tracking file made from its old stamps', async () => {
    const { fs, io, l } = await setup()
    const [line, ...more] = await convertDocuments(io, l)
    expect(more).toEqual([])
    expect(line).toBe('paper: converted to plain LaTeX, which compiles from its folder alone and names nothing of the tree (5 copies, 3 values of the tree written out, figures/loss.pdf copied in, 1 entry in refs.bib). ' +
      'Its 1 file as it was: vault/documents/.rft/paper/first-design/. Written as ?? (no notebook saved it), as it printed before: \\rftnum{E05}{runs}.')
    const { 'tracking.json': tracking, ...after } = FIRST_DESIGN.after
    expect(folder(fs)).toEqual(after)
    expect(JSON.parse(fs.read('vault/documents/.rft/paper/tracking.json'))).toEqual(JSON.parse(tracking!))
  })

  test('each copy keeps its state: one in review stays in review, an adapted one stays adapted', async () => {
    const { io, l } = await setup()
    await convertDocuments(io, l)
    const ms = (await readManuscript(io, l))!
    const d = ms.documents[0]!
    expect(d.copies.map(c => ({ snippet: c.snippet, state: copyState(c, ms.snippets.find(s => s.id === c.snippet)).state }))).toEqual(FIRST_DESIGN.expected.copies)
    expect(d.copies.map(c => [c.marker, c.found])).toEqual([['Definition: CutMix', 'markers'], ['Method: Training setup', 'markers'], ['Figure: Training loss', 'markers'], ['Result: CutMix at 1k images', 'markers'], ['Lemma: Mixing bound', 'markers']])
    expect((await valuesOf(io, l, d)).map(v => [v.kind, v.from, v.key, v.written, v.state, v.inCopyOf])).toEqual([
      ['number', 'E05', 'acc.1k', '73.2', 'current', null], ['figure', 'E08', 'loss', 'figures/loss.pdf', 'current', 'S03'], ['number', 'E05', 'acc.1k', '73.2', 'current', 'S02'],
    ])
    // a reference to a copy that comes later in the text follows its label too
    expect(d.text).toContain('Definition~\\ref{def:cutmix}, Lemma~\\ref{lem:mixing-bound} and Figure~\\ref{fig:training-loss}.')
  })

  test('scans clean, and nothing is said of it but its copy of a snippet that is gone', async () => {
    const { io, l } = await setup()
    await convertDocuments(io, l)
    const ms = (await readManuscript(io, l))!
    expect(await tracesOf(io, l, ms, ms.documents[0]!)).toEqual({ traces: [], allowed: 0 })
    expect((await manuscriptWarnings(io, l)).filter(w => w.includes('documents/paper'))).toEqual(['vault/documents/paper: holds copies of snippets that do not exist: S07 (main.tex)'])
  })

  test('converting twice changes nothing; the files as they were are kept once and never overwritten', async () => {
    const { fs, io, l } = await setup()
    expect(isFirstDesign(FIRST_DESIGN.before['main.tex']!)).toBe(true)
    await convertDocuments(io, l)
    expect(fs.read(`${KEPT}/main.tex`)).toBe(FIRST_DESIGN.before['main.tex'])
    expect(fs.read(`${KEPT}/blocks.json`)).toBe(FIRST_DESIGN.before['.blocks.json'])
    expect(fs.exists(`${DOC}/.blocks.json`)).toBe(false)
    const once = JSON.stringify([...fs.files].map(([k, v]) => [k, v.text]))
    expect(isFirstDesign(fs.read(`${DOC}/main.tex`))).toBe(false)
    expect(await convertDocuments(io, l)).toEqual([])
    expect(JSON.stringify([...fs.files].map(([k, v]) => [k, v.text]))).toBe(once)
    // a macro typed into it later is of the first design again: converted, the first original still the one kept
    fs.write(`${DOC}/main.tex`, fs.read(`${DOC}/main.tex`).replace('\\section{Method}', '\\section{Method}\nOver \\rftnum{E05}{seeds} seeds.'))
    expect((await convertDocuments(io, l))[0]).toContain('paper: converted to plain LaTeX')
    expect(fs.read(`${DOC}/main.tex`)).toContain('\\section{Method}\nOver 3 seeds.')
    expect(fs.read(`${KEPT}/main.tex`)).toBe(FIRST_DESIGN.before['main.tex'])
    expect((await readManuscript(io, l))!.documents[0]!.copies.length).toBe(5)
  })

  test('a document that is already clean is left as it is', async () => {
    const fs = new MemoryFs({ ...FILES })
    const io = fs.io()
    const l = await load(io, (await readConfig(io))!)
    const before = JSON.stringify([...fs.files])
    expect(await convertDocuments(io, l)).toEqual([])
    expect(JSON.stringify([...fs.files])).toBe(before)
    await expect(convertDocuments(io, l, 'book')).rejects.toThrow('"book" is no document')
  })
})

describe('in a session', () => {
  test('the first time Claude reads the documents, one of the first design is converted and said to be; a placement in it converts it first', async ($: Engine, on: On) => {
    const { fs } = await setup()
    mock.clock(on)
    const w = world(on, Object.fromEntries([...fs.files].map(([k, v]) => [k, v.text])))
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const placed = await $.tool.call({ tool: 'mcp__rft__rft_set_document', name: 'paper', place: 'S05', after: 'Introduction' } as never)
    expect(placed.text).toContain('Placed a copy of S05 in paper after Introduction, written out as plain LaTeX.')
    const doc = w.fs.read(`${DOC}/main.tex`)
    expect(doc).toContain('\\section{Introduction}\n\n%%% Motivation: Why low data %%%\nLabelled images are scarce')
    expect(doc).not.toMatch(/rft|S0\d|E0\d/)
    expect(w.fs.read(`${KEPT}/main.tex`)).toBe(FIRST_DESIGN.before['main.tex'])
    const report = await $.tool.call({ tool: 'mcp__rft__rft_manuscript', ref: 'paper' } as never)
    expect(report.text).not.toContain('converted')
    expect(report.text).toContain('  S05 motivation · Why low data: as the snippet\n  S01 definition · CutMix: as the snippet')
  })

  test('rft_manuscript says what it converted, once', async ($: Engine, on: On) => {
    const { fs } = await setup()
    mock.clock(on)
    world(on, Object.fromEntries([...fs.files].map(([k, v]) => [k, v.text])))
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const first = await $.tool.call({ tool: 'mcp__rft__rft_manuscript' } as never)
    expect(first.text).toContain('paper: converted to plain LaTeX, which compiles from its folder alone and names nothing of the tree (5 copies')
    expect(first.text).toContain('  paper: S01, S04 (snippet changed since: to review), S03, S02 (adapted), S07 (no such snippet)')
    expect((await $.tool.call({ tool: 'mcp__rft__rft_manuscript' } as never)).text).not.toContain('converted')
  })
})
