// A document's copies and tracked values read from its files and its tracking file
// (hooks/lib/copies.ts, docs/adr/0003-a-document-holds-no-trace.md), held to the fixture
// (tests/fixtures/local-overleaf): one document as a co-author would see it, with a copy in every
// state and a value in every state, and what readers must yield (expected.json). The server's side
// is held to the same file (tests/test_clean_source.py).

import { describe, expect, test } from 'claude-code/testing'

import { nextReport } from '../hooks/lib/knowledge'
import {
  allowTrace, bibOf, copyState, declareEnvironment, documentMain, insertFromTree, manuscriptReport, manuscriptWarnings, pointCopy, readManuscript, restoreMarkers, reviewCopy, reviewValue,
  ownCited, setDocument, tracesOf, usedIn, valuesOf,
} from '../hooks/lib/manuscript'
import { bibFor, locateCopies, locateValues, mainOf, parseMarkers, readingOrder, takenInBy } from '../hooks/lib/copies'
import { load, readConfig, rooted } from '../hooks/lib/vault'
import { MemoryFs } from './fixture'
import { BIB, EXPECTED, FILES } from './fixtures/local-overleaf'

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
      'paper (vault/documents/paper/, template article, main file main.tex, pdfLaTeX): locked: its text is the user\'s.',
      'Its files: main.tex, figures/loss.pdf, refs.bib, sections/method.tex.',
      'Its outline:',
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
      'Cited from the user\'s own .bib entries, which rest on no reference note of the tree: zhang2018mixup (main.tex:26).',
    ].join('\n'))
    expect(await manuscriptReport(io, l)).toContain('  paper (article, main.tex, pdfLaTeX): S05 (its markers are gone), S01#1, S01#2 (sections/method.tex; adapted), S04 (sections/method.tex; snippet changed since: to review), S03 (sections/method.tex), S07 (sections/method.tex; no such snippet), S02, S06 (lost: not found in main.tex any more)')
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

describe('what the user answers in the page', () => {
  const states = async (s: Awaited<ReturnType<typeof setup>>) => (await valuesOf(s.io, s.l, (await s.ms()).documents[0]!)).map(v => v.state)

  test('a number the tree changed: take the tree\'s (the copy it stands in stays as placed), or keep theirs until the tree changes again', async () => {
    const s = await setup()
    const { fs, io, l } = s
    expect(await states(s)).toEqual(['current', 'current', 'review', 'changed', 'current'])
    expect(await reviewValue(io, l, 'paper', 2, 'take')).toBe('the number E05 acc.full in paper (main.tex) now reads 81.6.')
    expect(fs.read(`${DOC}/main.tex`)).toContain('CutMix reaches 73.2\\% top-1 accuracy, against 81.6\\% when trained on the')
    expect(await states(s)).toEqual(['current', 'current', 'current', 'changed', 'current'])
    const m = await s.ms()
    expect(copyState(m.documents[0]!.copies.find(c => c.snippet === 'S02')!, m.snippets.find(x => x.id === 'S02')).state).toBe('placed')
    // the tree changes again; this time the user keeps what the document says
    fs.write('vault/results/E05.json', FILES['vault/results/E05.json']!.replace('81.6', '82.0'))
    expect(await states(s)).toEqual(['current', 'current', 'review', 'changed', 'current'])
    expect(await reviewValue(io, l, 'paper', 2, 'keep')).toBe('the number E05 acc.full in paper (main.tex) is kept as it is; it is flagged again when the tree says something else.')
    expect(fs.read(`${DOC}/main.tex`)).toContain('against 81.6\\%')
    expect(await states(s)).toEqual(['current', 'current', 'current', 'changed', 'current'])
    fs.write('vault/results/E05.json', FILES['vault/results/E05.json']!.replace('81.6', '82.5'))
    expect((await states(s))[2]).toBe('review')
  })

  test('a number changed in the document: keep it (it is the document\'s until the tree changes), or take the tree\'s back', async () => {
    const s = await setup()
    const { fs, io, l } = s
    await reviewValue(io, l, 'paper', 3, 'keep')
    expect(JSON.parse(fs.read(TRACKING)).values[3]).toMatchObject({ written: '5', kept: '3' })
    expect((await states(s))[3]).toBe('current')
    fs.write('vault/results/E05.json', FILES['vault/results/E05.json']!.replace('"seeds": 3', '"seeds": 4'))
    expect((await states(s))[3]).toBe('review')
    expect(await reviewValue(io, l, 'paper', 3, 'take')).toBe('the number E05 seeds in paper (sections/method.tex) now reads 4.')
    expect(fs.read(`${DOC}/sections/method.tex`)).toContain('All numbers are averaged over 4 seeds.')
    expect(JSON.parse(fs.read(TRACKING)).values[3]).toEqual({ kind: 'number', from: 'E05', key: 'seeds', written: '4', file: 'sections/method.tex', before: 'numbers are averaged over ', after: ' seeds.' })
    await expect(reviewValue(io, l, 'paper', 9, 'take')).rejects.toThrow('paper tracks no such value')
  })

  test('a figure saved again: its file is copied in anew, or the document keeps the one it has; a number no longer saved is kept as the document\'s own', async () => {
    const s = await setup()
    const { fs, io, l } = s
    fs.write('vault/figures/E08_loss.pdf', '%PDF a new run\n')
    expect((await states(s))[4]).toBe('review')
    expect(await reviewValue(io, l, 'paper', 4, 'keep')).toBe('the figure loss of E08 in paper (sections/method.tex) is kept as it is; it is flagged again when the tree says something else.')
    expect([(await states(s))[4], fs.read(`${DOC}/figures/loss.pdf`)]).toEqual(['current', FILES[`${DOC}/figures/loss.pdf`]])
    fs.write('vault/figures/E08_loss.pdf', '%PDF yet another run\n')
    expect((await states(s))[4]).toBe('review')
    expect(await reviewValue(io, l, 'paper', 4, 'take')).toBe('the figure loss of E08 in paper (sections/method.tex) is the tree\'s again: its file was copied in anew.')
    expect([(await states(s))[4], fs.read(`${DOC}/figures/loss.pdf`)]).toEqual(['current', '%PDF yet another run\n'])
    fs.write('vault/results/E05.json', '{"exp": "E05", "results": {"acc": {"1k": 73.2}}}')
    expect(await states(s)).toEqual(['current', 'current', 'review', 'changed', 'current'])
    await expect(reviewValue(io, l, 'paper', 2, 'take')).rejects.toThrow('E05 no longer saves acc.full: keep what the document has')
    expect(await reviewValue(io, l, 'paper', 2, 'keep')).toBe('the number E05 acc.full in paper (main.tex) is no longer tracked: what stands there is the document\'s own.')
    expect(JSON.parse(fs.read(TRACKING)).values.map((v: { key: string }) => v.key)).toEqual(['acc.1k', 'acc.1k', 'seeds', 'loss'])
  })

  test('a lost copy is pointed to again; a passage a co-author wrote becomes a copy; a copy found by its text gets its markers back', async () => {
    const s = await setup()
    const { fs, io, l } = s
    const main = () => fs.read(`${DOC}/main.tex`).split('\n')
    const at = main().findIndex(x => x.startsWith('We only looked at ResNet-50')) + 1
    expect(await pointCopy(io, l, 'paper', 'S06', { file: 'main.tex', from: at, to: at + 1 })).toBe(`The copy of S06 in paper is found again: lines ${at} to ${at + 1} of main.tex, between its marker lines.`)
    expect(main().slice(at - 1, at + 3)).toEqual(['%%% Discussion: Limitations %%%', 'We only looked at ResNet-50 on ImageNet subsets, so these findings may not transfer to other', 'backbones; a co-author rewrote this paragraph in Overleaf.', '%%% end %%%'])
    let m = await s.ms()
    expect(m.documents[0]!.copies.map(c => [c.snippet, c.found, copyState(c, m.snippets.find(x => x.id === c.snippet)).state]).slice(-2)).toEqual([['S02', 'markers', 'placed'], ['S06', 'markers', 'adapted']])
    // the sentence on mixing augmentations, written by hand, is tied to the motivation snippet
    const intro = main().findIndex(x => x.startsWith('Mixing augmentations such as')) + 1
    await expect(pointCopy(io, l, 'paper', 'S05', { file: 'main.tex', from: intro, to: intro + 3 })).rejects.toThrow('those lines are already in the copy of S05')
    expect(await pointCopy(io, l, 'paper', 'S04', { file: 'main.tex', from: intro, to: intro + 1 })).toContain('are now a copy of S04, between two marker lines')
    m = await s.ms()
    expect(m.documents[0]!.copies.map(c => `${c.snippet}#${c.nth} ${c.file} ${copyState(c, m.snippets.find(x => x.id === c.snippet)).state}`).slice(0, 3)).toEqual(['S04#1 main.tex adapted', 'S05#1 main.tex placed', 'S01#1 main.tex placed'])
    expect(await restoreMarkers(io, l, 'paper', 'S05')).toBe('The copy of S05 in paper (main.tex) has its two marker lines again.')
    expect(fs.read(`${DOC}/main.tex`)).toContain('%%% end %%%\n%%% Motivation: Why low data %%%\nLabelled images are scarce in most applied settings, and augmentations tuned on the full ImageNet\nare rarely tested with a thousand images or fewer.\n%%% end %%%\n')
    expect((await s.ms()).documents[0]!.copies.every(c => c.found === 'markers')).toBe(true)
    await expect(pointCopy(io, l, 'paper', 'S09', { file: 'main.tex', from: 1, to: 1 })).rejects.toThrow('S09 is no snippet')
    await expect(pointCopy(io, l, 'paper', 'S02', { file: 'main.tex', from: 900, to: 901 })).rejects.toThrow('lines 900 to 901 are not in main.tex')
    expect((await tracesOf(io, l, await s.ms(), (await s.ms()).documents[0]!)).traces).toEqual([])
  })

  test('a number, a figure, a table or a citation of the tree inserted at the cursor is plain LaTeX there, and tracked outside any copy', async () => {
    const tabular = '\\begin{tabular}{lr}\n\\toprule\nseed & acc \\\\\n\\bottomrule\n\\end{tabular}'
    const s = await setup({ 'vault/tables/E05_by_seed.tex': tabular + '\n', [`${DOC}/refs.bib`]: FILES[`${DOC}/refs.bib`]!.split('\n\n')[1]! })
    const { fs, io, l } = s
    const main = () => fs.read(`${DOC}/main.tex`).split('\n')
    const line = main().findIndex(x => x.startsWith('accuracy, most of the way')) + 1
    expect(await insertFromTree(io, l, 'paper', { file: 'main.tex', line, ch: 9 }, { kind: 'number', from: 'E05', key: 'acc.full' }))
      .toBe(`Wrote the number acc.full of E05 in paper (main.tex:${line}): 81.6; it is watched: when the tree changes it, it goes to review.`)
    expect(main()[line - 1]).toBe('accuracy,81.6 most of the way to training on the full set.')
    let values = await valuesOf(io, l, (await s.ms()).documents[0]!)
    expect(values.map(v => [v.key, v.written, v.state, v.inCopyOf]).at(-1)).toEqual(['acc.full', '81.6', 'current', null])
    // the result changes: the inserted number goes to review, with the others of that name
    fs.write('vault/results/E05.json', FILES['vault/results/E05.json']!.replace('81.6', '82.1'))
    values = await valuesOf(io, l, (await s.ms()).documents[0]!)
    expect(values.filter(v => v.state === 'review').map(v => [v.written, v.now, v.line])).toEqual([['81.4', '82.1', 44], ['81.6', '82.1', line - 1]])
    // a citation: the reference's own key, its entry added to the document's .bib
    expect(fs.read(`${DOC}/refs.bib`)).not.toContain('yun2019cutmix')
    const cited = await insertFromTree(io, l, 'paper', { file: 'sections/method.tex', line: 1, ch: 16 }, { kind: 'citation', from: 'R07' })
    expect(cited).toBe('Cited R07 in paper (sections/method.tex:1) as \\cite{yun2019cutmix} (yun2019cutmix in its .bib).')
    expect(fs.read(`${DOC}/sections/method.tex`).split('\n')[0]).toBe('\\section{Method}\\cite{yun2019cutmix}')
    expect(fs.read(`${DOC}/refs.bib`)).toContain('@inproceedings{zhang2018mixup,')
    expect(fs.read(`${DOC}/refs.bib`)).toContain('\n\n@inproceedings{yun2019cutmix,')
    // a figure the document already has is not copied again; a table is its tabular
    expect(await insertFromTree(io, l, 'paper', { file: 'main.tex', line: 17, ch: 0 }, { kind: 'figure', from: 'E08', key: 'loss' })).toContain('Wrote the figure loss of E08 in paper (main.tex:17); it is watched')
    expect(main()[16]).toBe('\\includegraphics[width=\\linewidth]{figures/loss.pdf}\\maketitle')
    await insertFromTree(io, l, 'paper', { file: 'main.tex', line: 18, ch: 0 }, { kind: 'table', from: 'E05', key: 'by_seed' })
    expect(main().slice(17, 22).join('\n')).toBe(tabular)
    expect((await tracesOf(io, l, await s.ms(), (await s.ms()).documents[0]!)).traces).toEqual([])
    await expect(insertFromTree(io, l, 'paper', { file: 'main.tex', line: 2, ch: 0 }, { kind: 'number', from: 'E05', key: 'acc.5k' })).rejects.toThrow('\\rftnum{E05}{acc.5k} is not a number or a text')
    await expect(insertFromTree(io, l, 'paper', { file: 'main.tex', line: 2, ch: 0 }, { kind: 'citation', from: 'E05' })).rejects.toThrow('E05 is not a reference note')
    await expect(insertFromTree(io, l, 'paper', { file: 'refs.bib', line: 1, ch: 0 }, { kind: 'number', from: 'E05', key: 'seeds' })).rejects.toThrow('paper has no .tex file refs.bib')
    await expect(insertFromTree(io, l, 'paper', { file: 'main.tex', line: 999, ch: 0 }, { kind: 'number', from: 'E05', key: 'seeds' })).rejects.toThrow('line 999 is not in main.tex')
  })

  test('a trace that is a false alarm is allowed once and remembered; an environment the document lacks is declared in one line', async () => {
    const s = await setup({ [`${DOC}/sections/method.tex`]: FILES[`${DOC}/sections/method.tex`]! + 'See Table S01 of the supplement.\n' })
    const { fs, io, l } = s
    const scan = async () => tracesOf(io, l, await s.ms(), (await s.ms()).documents[0]!)
    const [t] = (await scan()).traces
    expect(t).toMatchObject({ file: 'sections/method.tex', kind: 'id', match: 'S01', text: 'See Table S01 of the supplement.' })
    expect(await allowTrace(io, l, 'paper', t!)).toBe('Allowed S01 in paper (sections/method.tex): that occurrence is not flagged again.')
    expect(await scan()).toEqual({ traces: [], allowed: 1 })
    await expect(allowTrace(io, l, 'paper', t!)).rejects.toThrow('paper has no such trace to allow')
    expect(await declareEnvironment(io, l, 'paper', 'definition')).toBe('paper already declares the definition environment.')
    expect(await declareEnvironment(io, l, 'paper', 'corollary')).toBe('Added \\newtheorem{corollary}{Corollary} to the preamble of paper (main.tex).')
    expect(fs.read(`${DOC}/main.tex`)).toContain('\\date{}\n\\newtheorem{corollary}{Corollary}\n\n\\begin{document}')
    await expect(declareEnvironment(io, l, 'paper', 'figure')).rejects.toThrow('"figure" is not an environment of a snippet\'s kind')
  })
})

describe('a file copied as it is', () => {
  test('the session\'s files, rooted at the project, still copy a file bytes and all', async () => {
    const calls: string[] = []
    const io = rooted({ ...new MemoryFs({}).io(), copy: async (from, to) => { calls.push(`${from} -> ${to}`) } }, '/work/demo')
    await io.copy!('vault/figures/E08_loss.pdf', 'vault/documents/paper/figures/loss.pdf')
    expect(calls).toEqual(['/work/demo/vault/figures/E08_loss.pdf -> /work/demo/vault/documents/paper/figures/loss.pdf'])
    const { copy: _, ...plain } = new MemoryFs({}).io()
    expect(rooted(plain, '/work/demo').copy).toBeUndefined()
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

  test('a number changed where it stands is not mistaken for the same number standing elsewhere', () => {
    // a co-author rounds the abstract's 73.2 up; the results still say 73.2, between words that end alike
    const v = (before: string, after: string) => ({ kind: 'number' as const, from: 'E05', key: 'acc.1k', written: '73.2', file: 'a.tex', before, after })
    const files = { 'a.tex': 'are available. It reaches 74.0\\% top-1\naccuracy.\n\nWith 1k labelled images, CutMix reaches 73.2\\% top-1 accuracy.\n' }
    const got = locateValues(files, { values: [v('images are available. It reaches ', '\\% top-1\naccuracy.'), v('labelled images, CutMix reaches ', '\\% top-1 accuracy.')] })
    expect(got.map(x => [x.found, x.inDocument, x.line])).toEqual([['changed', '74.0', 0], ['written', '73.2', 3]])
  })

  test('a word changed near a value does not lose it: less of the text around it is asked to match', () => {
    const v = (written: string, before: string, after: string) => ({ kind: 'number' as const, from: 'E05', key: 'k', written, file: 'a.tex', before, after })
    const files = { 'a.tex': 'In our words, the gap closes by 0.3 points overall; the rest, 12 of them, stays.\n' }
    const got = locateValues(files, { values: [v('0.3', 'The gap closes by ', ' points in all.'), v('14', 'points; the rest, ', ' of them, stays.'), v('5', 'something else entirely ', ' was here before')] })
    expect(got.map(x => [x.found, x.inDocument])).toEqual([['written', '0.3'], ['changed', '12'], [null, null]])
  })
})

describe('the main file, and what it takes in', () => {
  const body = (text: string) => `\\documentclass{article}\n\\begin{document}\n${text}\n\\end{document}\n`

  test('the main file is the one with \\begin{document}, whatever its name; with several the user is asked; a recorded one stands', () => {
    // as main_of in server/rft_manuscript.py reads them (tests/test_documents.py)
    expect(mainOf({ 'example_paper.tex': body('Hello.'), 'notes.tex': '% \\begin{document} in a comment\n', 'refs.bib': '' }, '')).toEqual({ main: 'example_paper.tex', asked: [] })
    expect(mainOf({ 'setup/preamble.tex': '\\documentclass{book}\n', 'master.tex': '\\input{setup/preamble}\n\\begin{document}\n\\end{document}\n' }, '')).toEqual({ main: 'master.tex', asked: [] })
    expect(mainOf({ 'paper.tex': body('P'), 'supplement.tex': body('S') }, '')).toEqual({ main: 'paper.tex', asked: ['paper.tex', 'supplement.tex'] })
    expect(mainOf({ 'paper.tex': body('P'), 'main.tex': body('M') }, '')).toEqual({ main: 'main.tex', asked: ['main.tex', 'paper.tex'] })
    expect(mainOf({ 'paper.tex': body('P'), 'supplement.tex': body('S') }, 'supplement.tex')).toEqual({ main: 'supplement.tex', asked: [] })
    // a recorded file the document no longer has is forgotten; a document with no \begin{document} reads through its main.tex, or its first file
    expect(mainOf({ 'paper.tex': body('P') }, 'gone.tex')).toEqual({ main: 'paper.tex', asked: [] })
    expect(mainOf({ 'b.tex': 'B', 'a.tex': 'A' }, '')).toEqual({ main: 'a.tex', asked: [] })
    expect(mainOf({ 'refs.bib': '' }, '')).toEqual({ main: '', asked: [] })
  })

  test('a file is taken in by \\input, \\include, \\subfile or a template\'s own command, named from the main file\'s folder', () => {
    const files = {
      'master.tex': '\\input{setup/preamble.tex}\n\\begin{document}\n\\include{introduction/introduction}\n\\includepaper{papers/paperA/paperA}\n\\includegraphics{figures/logo}\n\\includeonly{old}\n\\end{document}\n',
      'setup/preamble.tex': '\\documentclass{book}\n', 'introduction/introduction.tex': '\\input{introduction/sec1}\n', 'introduction/sec1.tex': 'One.\n',
      'papers/paperA/paperA.tex': 'A.\n', 'old.tex': 'Old.\n', 'figures/logo.tex': 'not taken in by \\includegraphics\n',
    }
    expect([...readingOrder(files, 'master.tex').included].sort()).toEqual(['introduction/introduction.tex', 'introduction/sec1.tex', 'master.tex', 'papers/paperA/paperA.tex', 'setup/preamble.tex'])
    const nested = { 'src/paper.tex': '\\begin{document}\n\\input{parts/one}\n\\end{document}\n', 'src/parts/one.tex': 'One.\n', 'parts/one.tex': 'Another.\n' }
    expect([...readingOrder(nested, 'src/paper.tex').included].sort()).toEqual(['src/paper.tex', 'src/parts/one.tex'])
  })

  test('a copy in a file nothing takes in is not in the document: not in Used in, and said in rft_manuscript', async () => {
    const main = FILES[`${DOC}/main.tex`]!
    expect(main).toContain('\\input{sections/method}')
    const { io, l, ms } = await setup({ [`${DOC}/main.tex`]: main.replace('\\input{sections/method}', '% \\input{sections/method}') })
    const m = await ms()
    const d = m.documents[0]!
    expect([...d.included]).toEqual(['main.tex'])
    const got = Object.fromEntries(m.snippets.map(s => [s.id, Object.fromEntries(usedIn(m, s.id).map(u => [u.file, u.count]))]).filter(([, files]) => Object.keys(files as object).length))
    expect(got).toEqual({ S01: { 'main.tex': 1 }, S02: { 'main.tex': 1 }, S05: { 'main.tex': 1 } })
    const report = await manuscriptReport(io, l, 'paper')
    expect(report).toContain('sections/method.tex (the main file does not take it in):')
    expect(report).toContain('  S03 figure · Training loss: as the snippet; not in the document')
    expect(await manuscriptReport(io, l)).toContain('S03 (sections/method.tex; not in the document: the main file does not take its file in)')
  })

  test('a document whose main file has another name is read, placed in and discussed through it', async () => {
    const files = Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k === `${DOC}/main.tex` ? `${DOC}/paper.tex` : k, v]))
    const fs = new MemoryFs(files)
    const io = fs.io()
    const l = await load(io, (await readConfig(io))!)
    // the tracking file still says main.tex, which the document no longer has: the one file with \begin{document} is read
    const d = (await readManuscript(io, l))!.documents[0]!
    expect([d.main, d.path, d.mainAsked, d.engine, d.template]).toEqual(['paper.tex', 'documents/paper/paper.tex', [], 'pdflatex', 'article'])
    expect(d.copies.filter(c => c.found).length).toBe(7)
    expect(await documentMain(io, 'vault', 'paper')).toBe('documents/paper/paper.tex')
    expect(await manuscriptReport(io, l, 'paper')).toContain('template article, main file paper.tex, pdfLaTeX')
    expect(await setDocument(io, l, { name: 'paper', remove: 'S02' })).toContain('Removed the copy of S02')
    // and recorded with the first thing written
    expect(JSON.parse(fs.read(TRACKING)).main).toBe('paper.tex')
  })
})

describe('the .bib of a document with several', () => {
  test('which .bib a file uses: the cases both sides are held to', () => {
    for (const c of BIB.cases) expect([c.why, bibFor(c.files, c.main, c.file, c.chosen)]).toEqual([c.why, c.want])
    expect(takenInBy({ 'main.tex': '\\input{a}\n\\input{b}', 'a.tex': '\\input{b}', 'b.tex': '', 'c.tex': '' }, 'main.tex')).toEqual({ 'a.tex': 'main.tex', 'b.tex': 'a.tex' })
  })

  // a thesis by papers, as the AAU kit lays one out: a bibliography per paper, paper A with a .bib of its own, paper B through the kit's macro
  const THESIS: Record<string, string> = {
    'vault/documents/thesis/master.tex': '\\input{setup/macros.tex}\n\\begin{document}\n\\includepaper{papers/paperA/paperA}\n\\includepaper{papers/paperB/paperB}\n\\end{document}\n',
    'vault/documents/thesis/setup/macros.tex': '\\newcommand{\\papersbib}{\\bibliographystyle{IEEEtran}\\bibliography{bib/mybib}}\n',
    'vault/documents/thesis/papers/paperA/paperA.tex': '\\chapter{Paper A}\n\\input{papers/paperA/sections/introduction.tex}\n\\bibliographystyle{IEEEtran}\n\\bibliography{papers/paperA/refs}\n',
    'vault/documents/thesis/papers/paperA/sections/introduction.tex': '\\section{Introduction}\nText of paper A.\n',
    'vault/documents/thesis/papers/paperA/refs.bib': '@article{own2020,\n  title={Mine}\n}\n',
    'vault/documents/thesis/papers/paperB/paperB.tex': '\\chapter{Paper B}\n\\input{papers/paperB/sections/introduction.tex}\n\\papersbib\n',
    'vault/documents/thesis/papers/paperB/sections/introduction.tex': '\\section{Introduction}\nText of paper B, after \\cite{own2020}.\n',
    'vault/documents/thesis/bib/mybib.bib': '',
    'vault/documents/.rft/thesis/tracking.json': JSON.stringify({ version: 1, main: 'master.tex', template: 'aau', copies: [], values: [], bib: {}, allowed: [] }),
  }
  const A = 'vault/documents/thesis/papers/paperA/refs.bib', SHARED = 'vault/documents/thesis/bib/mybib.bib'
  const tracking = (fs: MemoryFs) => JSON.parse(fs.read('vault/documents/.rft/thesis/tracking.json'))
  const ms_ = async (io: ReturnType<MemoryFs['io']>, l: Awaited<ReturnType<typeof load>>) => (await readManuscript(io, l))!

  test('a snippet citing a reference note, placed in paper A\'s file, adds the entry to paper A\'s .bib only; placed twice, once', async () => {
    const { fs, io, l } = await setup(THESIS)
    // S01 (Definition: CutMix) cites R07, whose entry is yun2019cutmix
    expect(await setDocument(io, l, { name: 'thesis', place: 'S01', file: 'papers/paperA/sections/introduction.tex' })).toContain('yun2019cutmix in its .bib')
    expect(fs.read(A)).toContain('@inproceedings{yun2019cutmix,')
    expect(fs.read(A)).toContain('@article{own2020,')
    expect(fs.read(SHARED)).toBe('')
    expect(tracking(fs).bib).toEqual({ yun2019cutmix: { from: 'R07', file: 'papers/paperA/refs.bib' } })
    await setDocument(io, l, { name: 'thesis', place: 'S01', file: 'papers/paperA/paperA.tex', after: 'Paper A' })
    expect(fs.read(A).split('@inproceedings{yun2019cutmix,').length - 1).toBe(1)
    expect(fs.read(SHARED)).toBe('')
    expect(fs.read('vault/documents/thesis/papers/paperA/sections/introduction.tex')).toContain('%%% Definition: CutMix %%%')
  })

  test('what a placement writes into a kit\'s chapter file is what the server\'s tests compile there (tests/test_documents.py, the kits with a snippet placed)', async () => {
    // the fixture's own tracking file holds S01 as it was written out, and its refs.bib the entry R07 gives: a placement
    // in another document's chapter file writes exactly those, at the end of the file, and declares the environment the kit lacks
    const { fs, io, l } = await setup(THESIS)
    const fixture = JSON.parse(FILES[TRACKING]!) as { copies: { snippet: string; file: string; placed: string; marker: string }[] }
    const s01 = fixture.copies.find(c => c.snippet === 'S01' && c.file === 'main.tex')!
    const chapter = 'vault/documents/thesis/papers/paperA/sections/introduction.tex'
    await setDocument(io, l, { name: 'thesis', place: 'S01', file: 'papers/paperA/sections/introduction.tex' })
    expect(fs.read(chapter)).toBe(`\\section{Introduction}\nText of paper A.\n\n%%% ${s01.marker} %%%\n${s01.placed}\n%%% end %%%\n`)
    expect(tracking(fs).copies).toEqual([{ snippet: 'S01', marker: s01.marker, file: 'papers/paperA/sections/introduction.tex', stamp: tracking(fs).copies[0].stamp, placed: s01.placed }])
    const entry = FILES[`${DOC}/refs.bib`]!.split('\n\n')[0]!
    expect(entry).toContain('@inproceedings{yun2019cutmix,')
    expect(fs.read(A)).toBe(`@article{own2020,\n  title={Mine}\n}\n\n${entry}\n`)
    // the kit declares no definition environment: one line, at the end of the main file's preamble
    expect(await declareEnvironment(io, l, 'thesis', 'definition')).toBe('Added \\newtheorem{definition}{Definition} to the preamble of thesis (master.tex).')
    expect(fs.read('vault/documents/thesis/master.tex')).toBe('\\input{setup/macros.tex}\n\\newtheorem{definition}{Definition}\n\n\\begin{document}\n\\includepaper{papers/paperA/paperA}\n\\includepaper{papers/paperB/paperB}\n\\end{document}\n')
    expect((await tracesOf(io, l, await ms_(io, l), (await ms_(io, l)).documents.find(x => x.name === 'thesis')!)).traces).toEqual([])
  })

  test('where nothing says which .bib a chapter uses, the session refuses with the choices; the page\'s pick is used and remembered', async () => {
    const { fs, io, l } = await setup(THESIS)
    const place = { name: 'thesis', place: 'S01', file: 'papers/paperB/sections/introduction.tex' }
    await expect(setDocument(io, l, place)).rejects.toThrow('thesis has several .bib files (bib/mybib.bib, papers/paperA/refs.bib) and nothing in papers/paperB/sections/introduction.tex, nor in the files that take it in, says which one it uses')
    // nothing was written: not the copy, not an entry
    expect(fs.read('vault/documents/thesis/papers/paperB/sections/introduction.tex')).not.toContain('%%%')
    expect([fs.read(SHARED), tracking(fs).copies]).toEqual(['', []])
    await expect(setDocument(io, l, { ...place, bib: 'refs.bib' })).rejects.toThrow('"refs.bib" is not one of them')
    await setDocument(io, l, { ...place, bib: 'bib/mybib.bib' })
    expect(fs.read(SHARED)).toContain('@inproceedings{yun2019cutmix,')
    expect(fs.read(A)).not.toContain('yun2019cutmix')
    expect(tracking(fs).bibOf).toEqual({ 'papers/paperB/sections/introduction.tex': 'bib/mybib.bib' })
    // asked once: the next placement in that file needs no pick
    await setDocument(io, l, { name: 'thesis', place: 'S02', file: 'papers/paperB/sections/introduction.tex' })
    expect(tracking(fs).copies.map((c: { snippet: string }) => c.snippet)).toEqual(['S01', 'S02'])
    // the same entry in a second .bib of the document: added there too, and both are tracked
    await setDocument(io, l, { name: 'thesis', place: 'S01', file: 'papers/paperA/sections/introduction.tex' })
    expect(fs.read(A)).toContain('@inproceedings{yun2019cutmix,')
    expect(tracking(fs).bib.yun2019cutmix).toEqual({ from: 'R07', file: 'bib/mybib.bib', also: ['papers/paperA/refs.bib'] })
    // once no file cites it any more, it leaves both
    await setDocument(io, l, { name: 'thesis', remove: 'S01#1' })
    await setDocument(io, l, { name: 'thesis', remove: 'S01' })
    expect([fs.read(SHARED).includes('yun2019cutmix'), fs.read(A).includes('yun2019cutmix'), fs.read(A).includes('own2020')]).toEqual([false, false, true])
    expect(tracking(fs).bib).toEqual({})
  })

  test('in a document that came from a repository, a passage declared a copy gets its marker lines as in any other; lost to a co-author, it is found again by marker lines written by hand', async () => {
    const { fs, io, l, ms } = await setup(THESIS)
    // as a clone leaves it: nothing tied to the tree, and the template it records
    fs.write('vault/documents/.rft/thesis/tracking.json', JSON.stringify({ version: 1, template: 'repository', copies: [], values: [], bib: {}, allowed: [] }))
    const chapter = 'vault/documents/thesis/papers/paperA/sections/introduction.tex'
    const rel = 'papers/paperA/sections/introduction.tex'
    fs.write(chapter, '\\section{Introduction}\nCutMix cuts a box from one image and pastes it on another, mixing the labels by area.\nMore text.\n')
    const copy = async () => {
      const m = await ms()
      const c = m.documents.find(x => x.name === 'thesis')!.copies[0]!
      return [c.snippet, c.found, c.file, c.begin, c.end, copyState(c, m.snippets.find(x => x.id === 'S01')).state]
    }
    expect(await pointCopy(io, l, 'thesis', 'S01', { file: rel, from: 2, to: 2 })).toBe(`Lines 2 to 2 of ${rel} in thesis are now a copy of S01, between two marker lines: its text is kept as it is, and it goes to review when S01 changes.`)
    expect(fs.read(chapter)).toBe('\\section{Introduction}\n%%% Definition: CutMix %%%\nCutMix cuts a box from one image and pastes it on another, mixing the labels by area.\n%%% end %%%\nMore text.\n')
    expect(await copy()).toEqual(['S01', 'markers', rel, 1, 3, 'adapted'])
    expect(usedIn(await ms(), 'S01').filter(u => u.doc === 'thesis')).toEqual([{ doc: 'thesis', file: rel, count: 1, states: ['adapted'] }])
    // a co-author rewords it between its marker lines: it is followed
    fs.write(chapter, '\\section{Introduction}\n%%% Definition: CutMix %%%\nCutMix pastes a box of one image onto another and mixes the two labels by area.\n%%% end %%%\nMore text.\n')
    expect(await copy()).toEqual(['S01', 'markers', rel, 1, 3, 'adapted'])
    // a co-author deletes the two marker lines and rewords it again: lost, shown and not dropped
    fs.write(chapter, '\\section{Introduction}\nCutMix: a box of one image over another, labels mixed by area.\nMore text.\n')
    expect(await copy()).toEqual(['S01', null, rel, null, null, 'lost'])
    // the user writes the two lines back by hand, around the passage as it now reads: found again
    fs.write(chapter, '\\section{Introduction}\n%%%  definition: cutmix  %%%\nCutMix: a box of one image over another, labels mixed by area.\n%%% end %%%\nMore text.\n')
    expect(await copy()).toEqual(['S01', 'markers', rel, 1, 3, 'adapted'])
  })

  test('a citation of the user\'s own entry is said to rest on no reference note; the document\'s files are unchanged', async () => {
    const { fs, io, l, ms } = await setup(THESIS)
    const before = JSON.stringify([...fs.files].filter(([k]) => k.startsWith('vault/documents/thesis/')))
    const d = (await ms()).documents.find(x => x.name === 'thesis')!
    expect(ownCited(d)).toEqual([{ key: 'own2020', file: 'papers/paperB/sections/introduction.tex', line: 2 }])
    expect(await manuscriptReport(io, l, 'thesis')).toContain('Cited from the user\'s own .bib entries, which rest on no reference note of the tree: own2020 (papers/paperB/sections/introduction.tex:2).')
    expect(JSON.stringify([...fs.files].filter(([k]) => k.startsWith('vault/documents/thesis/')))).toBe(before)
    // the fixture's paper: zhang2018mixup was added by hand; yun2019cutmix came from R07
    expect(ownCited((await ms()).documents.find(x => x.name === 'paper')!)).toEqual([{ key: 'zhang2018mixup', file: 'main.tex', line: 26 }])
  })
})
