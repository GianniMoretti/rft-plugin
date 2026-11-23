// A document's copies and tracked values read from its files and its tracking file
// (hooks/lib/copies.ts, docs/adr/0003-a-document-holds-no-trace.md), held to the fixture
// (tests/fixtures/local-overleaf): one document as a co-author would see it, with a copy in every
// state and a value in every state, and what readers must yield (expected.json). The server's side
// is held to the same file (tests/test_clean_source.py).

import { describe, expect, test } from 'claude-code/testing'

import { nextReport } from '../hooks/lib/knowledge'
import { bibOf, copyState, manuscriptReport, manuscriptWarnings, readManuscript, reviewCopy, setDocument, usedIn, valuesOf } from '../hooks/lib/manuscript'
import { locateCopies, locateValues, parseMarkers, readingOrder } from '../hooks/lib/copies'
import { load, readConfig } from '../hooks/lib/vault'
import { MemoryFs } from './fixture'
import { EXPECTED, FILES } from './fixtures/local-overleaf'

const DOC = 'vault/documents/paper'
const TRACKING = 'vault/documents/.rft/paper/tracking.json'

async function setup(extra: Record<string, string> = {}) {
  const fs = new MemoryFs({ ...FILES, ...extra })
  const io = fs.io()
  const l = await load(io, (await readConfig(io))!)
  const ms = async () => (await readManuscript(io, l))!
  return { fs, io, l, ms }
}

describe('the fixture\'s document', () => {
  test('its copies, in the order the document is read, each with its state and how it was found', async () => {
    const m = await (await setup()).ms()
    const d = m.documents[0]!
    const got = d.copies.map(c => ({ snippet: c.snippet, file: c.found ? c.file : null, state: copyState(c, m.snippets.find(s => s.id === c.snippet)).state, markers: c.found === 'markers', marker: c.marker }))
    expect(got).toEqual(EXPECTED.copies.map(c => ({ snippet: c.snippet, file: c.file, state: c.state, markers: c.markers, marker: c.marker })))
    // the order of the tracking file is the order the document is read in: main.tex, with sections/method.tex where it is taken in
    const order = readingOrder(d.files, d.main)
    const ranks = d.copies.filter(c => c.found).map(c => order.at(c.file, c.begin!))
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    expect([...order.included].sort()).toEqual(['main.tex', 'sections/method.tex'])
    expect(d.copies.filter(c => c.found).map(c => EXPECTED.copies.find(e => e.snippet === c.snippet && e.file === c.file)!.order)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  test('where each snippet is used: per file, how many copies', async () => {
    const m = await (await setup()).ms()
    const got = Object.fromEntries(m.snippets.map(s => [s.id, Object.fromEntries(usedIn(m, s.id).map(u => [u.file, u.count]))]).filter(([, files]) => Object.keys(files as object).length))
    expect(got).toEqual(EXPECTED.usedIn)
  })

  test('its tracked values, each with its state and the copy it stands in', async () => {
    const { io, l, ms } = await setup()
    const values = await valuesOf(io, l, (await ms()).documents[0]!)
    expect(values.map(v => ({ kind: v.kind, file: v.file, from: v.from, key: v.key, state: v.state, inCopyOf: v.inCopyOf })))
      .toEqual(EXPECTED.values.map(v => ({ kind: v.kind, file: v.file, from: v.from, key: v.key, state: v.state, inCopyOf: v.inCopyOf })))
    expect(values.map(v => [v.written, v.inDocument, v.kind === 'number' ? v.now : null, v.line === null ? null : v.line + 1])).toEqual([
      ['73.2', '73.2', '73.2', 20], ['73.2', '73.2', '73.2', 45], ['81.4', '81.4', '81.6', 45], ['3', '5', '3', 12], ['figures/loss.pdf', 'figures/loss.pdf', null, 17],
    ])
  })

  test('its .bib: which entries came from the tree, which are the user\'s own', async () => {
    const d = (await (await setup()).ms()).documents[0]!
    expect(Object.fromEntries(bibOf(d).map(b => [b.key, b.from]))).toEqual(EXPECTED.bib)
  })

  test('rft_manuscript: its outline across its files, its lost copy, its values to look at; rft_next and rft_validate say the same', async () => {
    const { io, l } = await setup()
    expect(await manuscriptReport(io, l, 'paper')).toBe([
      'paper (vault/documents/paper/, main file main.tex; also sections/method.tex): locked: its text is the user\'s. Its outline:',
      '§ Introduction',
      '  S05 motivation · Why low data: as the snippet; its markers are gone',
      '  S01#1 definition · CutMix: as the snippet',
      'sections/method.tex:',
      '§ Method',
      '  S01#2 definition · CutMix: adapted',
      '  S04 method · Training setup: snippet changed since: to review',
      '  S03 figure · Training loss: as the snippet',
      '  S07 Lemma: Mixing bound: no such snippet',
      'main.tex:',
      '§ Results',
      '  S02 result · CutMix at 1k images: as the snippet',
      '§ Discussion',
      'Lost (the plugin cannot find them in the document any more; the user points to them again in the page, or drops them): S06 Discussion: Limitations (was in main.tex).',
      'Values of the tree written in it: the tree changed since they were written: 81.4 in main.tex:45 (E05 acc.full), now 81.6. changed in the document, no longer the tree\'s: 3 in sections/method.tex:12 (E05 seeds), now 5 there.',
    ].join('\n'))
    expect(await manuscriptReport(io, l)).toContain('  paper: S05 (its markers are gone), S01#1, S01#2 (sections/method.tex; adapted), S04 (sections/method.tex; snippet changed since: to review), S03 (sections/method.tex), S07 (sections/method.tex; no such snippet), S02, S06 (lost: not found in main.tex any more)')
    expect(await manuscriptReport(io, l)).toContain('  S01 definition · CutMix · written · T02, R07 · used in paper (main.tex, sections/method.tex: adapted)')
    const next = await nextReport(io, l, '2026-11-24')
    expect(next).toContain('Copies in documents whose snippet changed since (the user takes the new text or keeps theirs): paper: S04 (sections/method.tex).')
    expect(next).toContain('Copies the plugin can no longer find in their document (the user points to them again in the page, or drops them): paper: S06 (was in main.tex).')
    expect(next).toContain('Values of the tree written in documents, for the user to look at (they take the tree\'s or keep theirs). paper: the tree changed since they were written: 81.4 in main.tex:45 (E05 acc.full), now 81.6. changed in the document')
    const warnings = (await manuscriptWarnings(io, l)).filter(w => w.startsWith('vault/documents/paper'))
    expect(warnings).toEqual([
      'vault/documents/paper: holds copies of snippets that do not exist: S07 (sections/method.tex)',
      'vault/documents/paper: copies the plugin can no longer find (the user points to them again in the page, or drops them): S06 (was in main.tex)',
      'vault/documents/paper: values of the tree, the tree changed since they were written: 81.4 in main.tex:45 (E05 acc.full), now 81.6',
      'vault/documents/paper: values of the tree, changed in the document, no longer the tree\'s: 3 in sections/method.tex:12 (E05 seeds), now 5 there',
    ])
  })

  test('the copy in review takes the snippet\'s text, in its file; the lost copy is dropped; a copy found by its text gets its markers back when moved', async () => {
    const { fs, io, l, ms } = await setup()
    expect(await reviewCopy(io, l, 'paper', 'S04', 'take')).toBe('The copy of S04 in paper now holds the snippet\'s text, written out as plain LaTeX.')
    expect(fs.read(`${DOC}/sections/method.tex`)).toContain('%%% Method: Training setup %%%\nWe train a ResNet-50 for 300 epochs with SGD')
    await expect(reviewCopy(io, l, 'paper', 'S06', 'keep')).rejects.toThrow('the copy of S06 in paper is lost: the plugin cannot find it in main.tex any more')
    await expect(setDocument(io, l, { name: 'paper', move: 'S06' })).rejects.toThrow('the copy of S06 in paper is lost')
    await expect(reviewCopy(io, l, 'paper', 'S07', 'take')).rejects.toThrow('S07 is no snippet any more')
    expect(await setDocument(io, l, { name: 'paper', remove: 'S06' })).toBe('Dropped the lost copy of S06 from paper: it is no longer tracked (the snippet itself stays).')
    expect(await setDocument(io, l, { name: 'paper', move: 'S05', after: 'Discussion' })).toBe('Moved the copy of S05 in paper after Discussion.')
    expect(fs.read(`${DOC}/main.tex`)).toContain('\\section{Discussion}\n\n%%% Motivation: Why low data %%%\nLabelled images are scarce in most applied settings, and augmentations tuned on the full ImageNet\nare rarely tested with a thousand images or fewer.\n%%% end %%%\n\nWe only looked at')
    const m = await ms()
    expect(m.documents[0]!.copies.map(c => [c.snippet, c.found, copyState(c, m.snippets.find(s => s.id === c.snippet)).state])).toEqual([
      ['S01', 'markers', 'placed'], ['S01', 'markers', 'adapted'], ['S04', 'markers', 'placed'], ['S03', 'markers', 'placed'], ['S07', 'markers', 'gone'], ['S02', 'markers', 'placed'], ['S05', 'markers', 'placed'],
    ])
    // the second copy of the definition takes the snippet's text: a label of its own, the entry it cites already there
    expect(await reviewCopy(io, l, 'paper', 'S01#2', 'take')).toContain('The copy of S01#2 in paper now holds')
    expect(fs.read(`${DOC}/sections/method.tex`)).toContain('%%% Definition: CutMix %%%\n\\begin{definition}[CutMix]\\label{def:cutmix-2}\nGiven two labelled images')
    expect(fs.read(`${DOC}/refs.bib`)).toBe(FILES[`${DOC}/refs.bib`])
    // removing the figure's copy takes its file out of the document; the document still scans clean
    await setDocument(io, l, { name: 'paper', remove: 'S03' })
    expect(fs.exists(`${DOC}/figures/loss.pdf`)).toBe(false)
    expect((await manuscriptWarnings(io, l)).filter(w => w.includes('trace'))).toEqual([])
    expect(JSON.parse(fs.read(TRACKING)).values.map((v: { key: string }) => v.key)).toEqual(['acc.1k', 'acc.1k', 'acc.full', 'seeds'])
  })
})

describe('markers and places', () => {
  test('a marker pair is two comment lines; a marker with no end is the user\'s own comment; spacing and case do not count', () => {
    const text = '%%% Section one %%%\nText.\n%%%Definition:  CutMix%%%\nA.\n  %%% END %%%\n%%% Lemma: X %%%\n%%% Lemma: Y %%%\nB.\n%%% end %%%\n%%% end %%%\n'
    expect(parseMarkers(text)).toEqual([{ words: 'Definition:  CutMix', begin: 2, end: 4, content: 'A.' }, { words: 'Lemma: Y', begin: 6, end: 8, content: 'B.' }])
    const copy = (marker: string, placed: string, file = 'a.tex') => ({ snippet: 'S01', marker, file, stamp: '', placed })
    const got = locateCopies({ 'a.tex': text }, { copies: [copy('definition: cutmix', 'A.'), copy('Lemma: X', 'Gone.'), copy('Lemma: Y', 'B.')] })
    expect(got.map(c => [c.found, c.begin, c.end, c.nth])).toEqual([['markers', 2, 4, 1], [null, null, null, 2], ['markers', 6, 8, 3]])
  })

  test('a copy moved to another file by hand is found there; one whose marker\'s words were changed is found by its text, markers and all', () => {
    const copy = (marker: string, placed: string, file: string) => ({ snippet: 'S01', marker, file, stamp: '', placed })
    const files = { 'a.tex': 'Intro.\n', 'b.tex': '%%% Result: One %%%\nOne  thing.\n%%% end %%%\n%%% Finding: two %%%\nTwo\nthings.\n%%% end %%%\nTwo things.\n' }
    const got = locateCopies(files, { copies: [copy('Result: One', 'One thing.', 'a.tex'), copy('Result: Two', 'Two things.', 'b.tex'), copy('Result: Two', 'Two things.', 'b.tex')] })
    expect(got.map(c => [c.found, c.file, c.begin, c.end])).toEqual([['markers', 'b.tex', 0, 2], ['markers', 'b.tex', 3, 6], ['text', 'b.tex', 7, 7]])
  })

  test('a value is found by the text around it, whatever the spacing; two values with the same surroundings are told apart by their order', () => {
    const v = (written: string, before: string, after: string) => ({ kind: 'number' as const, from: 'E05', key: 'k', written, file: 'a.tex', before, after })
    const files = { 'a.tex': 'It reaches\n  73.2\\% here, and 73.2\\% there; 81 (not ours) and 9 in all.\n' }
    const got = locateValues(files, { values: [v('73.2', 'reaches ', '\\% '), v('73.2', 'and ', '\\% there'), v('80', '; ', ' (not ours)'), v('7', 'nowhere ', ' at all'), v('9', '', '')] })
    expect(got.map(x => [x.found, x.inDocument, x.line])).toEqual([['written', '73.2', 1], ['written', '73.2', 1], ['changed', '81', 1], [null, null, null], ['written', '9', 1]])
  })
})
