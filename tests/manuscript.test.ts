// Snippets and documents, two levels. Snippets: LaTeX building blocks resting on verified notes,
// reused. Documents: built from copies of snippets, each written out as plain LaTeX between two
// marker lines, referenced to its snippet in the document's tracking file and in review when the
// snippet changes, never rewritten by itself. Locked by default: Claude proposes stubs and
// placements, comments and suggests; the user writes and accepts. (The fixture's document, with
// every state a copy and a value can be in: tests/copies.test.ts.)

import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { comment, commentsReport, suggest } from '../hooks/lib/comments'
import { nextReport, supersede } from '../hooks/lib/knowledge'
import {
  basisOf, citeIndex, copyState, isStub, macroProblems, manuscriptReport, manuscriptWarnings, markReviewed, migrateManuscript, newDocument,
  readManuscript, reviewCopy, setDocument, setSnippet, stateOf, usedIn, usesIn,
} from '../hooks/lib/manuscript'
import { contentFingerprint, contentOf, readDocsRegistry, readRegistry, writeDocsRegistry, writeRegistry } from '../hooks/lib/snippets'
import { eagerTools, featuresInUse } from '../hooks/lib/tools'
import { verifyNote } from '../hooks/lib/verify'
import { load, readConfig } from '../hooks/lib/vault'
import { CWD, D00, E01, E02, MemoryFs, demoFiles, note, world } from './fixture'
import { BUILT_IN } from './fixtures/local-overleaf'

const DATE = '2026-11-17'
const E01_PATH = `vault/experiments/${E01}.md`
const E02_PATH = `vault/experiments/${E02}.md`
const R01_PATH = 'vault/references/R01 Mixup paper.md'
const S01_PATH = 'vault/snippets/S01.tex'
const PAPER = 'vault/documents/paper/main.tex'
const THESIS = 'vault/documents/thesis/main.tex'
const TRACKING = 'vault/documents/.rft/paper/tracking.json'

/** The demo, a reference with a BibTeX block, E01's saved run; E01 and R01 verified; the two levels started with a paper. */
async function setup(opts: { started?: boolean } = {}) {
  const files = demoFiles()
  files[R01_PATH] = note('R01', 'reference', 'done', D00, 'Mixup paper')
    .replace('## Idea\nText of R01.', '## Source\nZhang et al. 2018, arXiv:1710.09412\n```bibtex\n@inproceedings{zhang2018mixup,\n  title={mixup},\n  year={2018}\n}\n```\n\n## Key results\nMixup helps.')
  files['vault/results/E01.json'] = JSON.stringify({ exp: 'E01', results: { acc: { '1k': 71.3, '10k': 88.2 }, seeds: 3 }, figures: ['figures/E01_loss.svg'], tables: ['tables/E01_by_seed.html'] })
  const fs = new MemoryFs(files)
  const io = fs.io()
  const l = await load(io, (await readConfig(io))!)
  await verifyNote(io, l, 'E01', DATE)
  await verifyNote(io, l, 'R01', DATE)
  if (opts.started !== false) await newDocument(io, l, 'paper', 'article', 'Small data')
  return { fs, io, l }
}

const stub = { kind: 'result', title: 'Training length at 1k images', basis: ['E01'], outline: ['the claim: long training loses \\rftnum{E01}{acc.1k} at 1k', 'the spread over 3 seeds'] }

/** S01, proposed by Claude, then written by the user. */
async function written(fs: MemoryFs, io: ReturnType<MemoryFs['io']>, l: Awaited<ReturnType<typeof setup>>['l'], text = 'Long training loses \\rftnum{E01}{acc.1k} points at 1k images.') {
  await setSnippet(io, l, stub, DATE)
  fs.write(S01_PATH, '% rft-snippet S01 · result · Training length at 1k images\n% basis: E01\n\\paragraph{Training length at 1k images}\n' + text + '\n')
}

describe('starting', () => {
  test('nothing until the user starts it: the tools say so and are not in the prompt', async () => {
    const { io, l } = await setup({ started: false })
    expect(await manuscriptReport(io, l)).toContain('This vault has no snippets or documents yet. The user starts them with /rft-manuscript')
    await expect(setSnippet(io, l, stub, DATE)).rejects.toThrow('This vault has no snippets or documents yet')
    expect(eagerTools(featuresInUse(l, false)).has('rft_manuscript')).toBe(false)
  })

  test('a first document starts both levels, locked; then the three tools join the prompt', async () => {
    const { fs, io, l } = await setup({ started: false })
    expect(await newDocument(io, l, 'paper', 'article', 'Small data')).toContain('Started snippets (vault/snippets/) and documents (vault/documents/), both locked')
    expect(JSON.parse(fs.read('vault/snippets/snippets.json'))).toEqual({ locked: true, next: 1, snippets: {}, unlocked: [] })
    expect(JSON.parse(fs.read('vault/documents/documents.json'))).toEqual({ locked: true, unlocked: [] })
    const doc = fs.read(PAPER)
    expect(doc).toContain('\\documentclass[11pt]{article}')
    // plain LaTeX: nothing of the plugin's, its theorem environments its own, an empty .bib for what it will cite
    expect(doc).not.toMatch(/rft/)
    expect(doc).toContain('\\newtheorem{definition}{Definition}')
    expect(fs.read('vault/documents/paper/refs.bib')).toBe('')
    expect(doc).not.toContain('\\rftsnippet')
    expect(await newDocument(io, l, 'thesis-ch3', 'report')).toBe('Added the document thesis-ch3 (vault/documents/thesis-ch3/, from the template report: 2 files, main file main.tex).')
    expect(fs.read('vault/documents/thesis-ch3/main.tex')).toContain('\\chapter{demo}')
    // a title typed in the tree view: plain text, its LaTeX special characters escaped
    await newDocument(io, l, 'mix', 'report', '  Mixup & CutMix: 100% of_the {gap}  ')
    expect(fs.read('vault/documents/mix/main.tex')).toContain('\\title{Mixup \\& CutMix: 100\\% of\\_the \\{gap\\}}')
    expect(fs.read('vault/documents/mix/main.tex')).toContain('\\chapter{Mixup \\& CutMix: 100\\% of\\_the \\{gap\\}}')
    await expect(newDocument(io, l, 'paper')).rejects.toThrow('there is already a document paper')
    await expect(newDocument(io, l, 'My Paper')).rejects.toThrow('lowercase letters, digits and dashes')
    const fresh = await load(io, l.config)
    expect(fresh.hasManuscript).toBe(true)
    const eager = eagerTools(featuresInUse(fresh, false))
    expect(['rft_manuscript', 'rft_set_snippet', 'rft_set_document'].every(t => eager.has(t))).toBe(true)
  })
})

describe('snippets, the building blocks', () => {
  test('locked: Claude proposes a stub from verified notes, in no document; the text is the user\'s', async () => {
    const { fs, io, l } = await setup()
    const out = await setSnippet(io, l, stub, DATE)
    expect(out).toContain('S01 proposed as a stub for the user to write: vault/snippets/S01.tex (result, basis E01), in no document yet.')
    expect(out).toContain('place it with rft_set_document once the user agrees')
    expect(fs.read(S01_PATH)).toBe([
      '% rft-snippet S01 · result · Training length at 1k images',
      '% basis: E01',
      '%',
      `% Proposed by Claude on ${DATE}, for you to write: Claude comments and suggests, and writes it only once you unlock it.`,
      '% What to say:',
      '%   - the claim: long training loses \\rftnum{E01}{acc.1k} at 1k',
      '%   - the spread over 3 seeds',
      '\\paragraph{Training length at 1k images}',
      '% your text',
      '',
    ].join('\n'))
    expect(isStub(fs.read(S01_PATH))).toBe(true)
    expect(fs.read(PAPER)).not.toContain('S01') // a snippet enters a document only when placed
    const reg = await readRegistry(io, 'vault')
    expect(reg.next).toBe(2)
    expect(reg.snippets.S01).toEqual({ stamp: { E01: expect.stringMatching(/^[0-9a-f]{8}$/) }, proposed: DATE })
    await expect(setSnippet(io, l, { ...stub, text: 'Long training loses.' }, DATE)).rejects.toThrow('the snippets are locked: the user writes the text')
    await expect(setSnippet(io, l, { ...stub, basis: ['E01', 'D01'] }, DATE)).rejects.toThrow('only verified notes are candidates for a snippet: D01 is idea')
    await expect(setSnippet(io, l, { ...stub, kind: 'essay' }, DATE)).rejects.toThrow('kind must be one of definition')
    await expect(setSnippet(io, l, { ...stub, basis: ['E42'] }, DATE)).rejects.toThrow('"E42" is not a note of the tree')
    await expect(setSnippet(io, l, { id: 'S01', text: 'Mine.' }, DATE)).rejects.toThrow('S01 is the user\'s to write (the snippets are locked): comment on it with rft_comment {id: "S01", quote, text}')
  })

  test('a theorem-like kind gets its environment and a label', async () => {
    const { fs, io, l } = await setup()
    await setSnippet(io, l, { kind: 'definition', title: 'Augmentation {gap}', basis: ['R01'] }, DATE)
    expect(fs.read(S01_PATH)).toContain('\\begin{definition}[Augmentation gap]\\label{S01}\n% your text\n\\end{definition}\n')
  })

  test('unlocked: Claude writes the text, its macros checked against what the notebooks saved, stamped; its copies go to review', async () => {
    const { fs, io, l } = await setup()
    await setSnippet(io, l, stub, DATE)
    await writeRegistry(io, 'vault', { ...(await readRegistry(io, 'vault')), unlocked: ['S01'] })
    await expect(setSnippet(io, l, { id: 'S01', text: 'It loses \\rftnum{E01}{acc.2k} points.' }, DATE))
      .rejects.toThrow('\\rftnum{E01}{acc.2k}: no such number; E01\'s are acc.1k, acc.10k, seeds')
    await expect(setSnippet(io, l, { id: 'S01', text: 'See \\rftfig{E01}{accuracy}.' }, DATE)).rejects.toThrow('E01 saved no figure of that name; its are loss')
    expect(await setSnippet(io, l, { id: 'S01', text: 'Long training loses \\rftnum{E01}{acc.1k} points \\citep{zhang2018mixup}.' }, '2026-11-18'))
      .toBe('S01 written (vault/snippets/S01.tex), stamped with its basis as it is now.')
    expect(fs.read(S01_PATH)).toBe('% rft-snippet S01 · result · Training length at 1k images\n% basis: E01\n\\paragraph{Training length at 1k images}\nLong training loses \\rftnum{E01}{acc.1k} points \\citep{zhang2018mixup}.\n')
    expect((await readRegistry(io, 'vault')).snippets.S01).toMatchObject({ written: '2026-11-18', stamp: { E01: expect.any(String), R01: expect.any(String) } })
    await setDocument(io, l, { name: 'paper', place: 'S01' })
    expect(await setSnippet(io, l, { id: 'S01', edits: [{ old_str: 'points', new_str: 'percentage points' }] }, DATE))
      .toContain('Its copies in paper go to review: the user takes the new text there, or keeps theirs.')
    await expect(setSnippet(io, l, { id: 'S01', edits: [{ old_str: 'nowhere', new_str: 'x' }] }, DATE)).rejects.toThrow('exactly once (it is 0 times)')
  })

  test('the user starts a snippet on any note (flagged until verified) and marks one reviewed', async () => {
    const { fs, io, l } = await setup()
    await setSnippet(io, l, { kind: 'discussion', title: 'Open question', basis: ['D01'] }, DATE, { byUser: true })
    expect(fs.read(S01_PATH)).toBe('% rft-snippet S01 · discussion · Open question\n% basis: D01\n\\paragraph{Open question}\n% your text\n')
    const ms = (await readManuscript(io, l))!
    expect(stateOf(ms.snippets[0]!, l, ms.registry).unverified).toEqual(['D01'])
    await setSnippet(io, l, stub, DATE)
    fs.write(E01_PATH, fs.read(E01_PATH).replace('Text of E01.', 'Text of E01, rerun.'))
    Object.assign(l, await load(io, l.config))
    const s2 = async () => { const m = (await readManuscript(io, l))!; return stateOf(m.snippets[1]!, l, m.registry).review }
    expect(await s2()).toEqual(['E01 changed'])
    expect(await markReviewed(io, l, 'S02', '2026-11-18')).toBe('S02 reviewed: stamped with its basis as it is now.')
    expect(await s2()).toEqual([])
  })
})

describe('documents, built from copies of snippets', () => {
  const PLACED = '\\paragraph{Training length at 1k images}\nLong training loses 71.3 points at 1k images.'
  const order = async (io: Awaited<ReturnType<typeof setup>>['io'], l: Awaited<ReturnType<typeof setup>>['l'], name = 'paper') =>
    (await readManuscript(io, l))!.documents.find(d => d.name === name)!.copies.map(c => `${c.snippet}${c.found ? '' : ' lost'}`)

  test('a placement writes the snippet out as plain LaTeX between two marker lines, where the user agreed, and records it outside the document', async () => {
    const { fs, io, l } = await setup()
    await written(fs, io, l)
    await setSnippet(io, l, { kind: 'definition', title: 'Gap', basis: ['E01'] }, DATE)
    expect(await setDocument(io, l, { name: 'paper', place: 'S01' })).toBe('Placed a copy of S01 in paper, written out as plain LaTeX. It is the document\'s now: the user may adapt it; when S01 changes, the copy goes to review.')
    let doc = fs.read(PAPER)
    expect(doc).toContain(`\n\n%%% Result: Training length at 1k images %%%\n${PLACED}\n%%% end %%%\n\n\\bibliographystyle{plainnat}`)
    expect(doc).not.toMatch(/rft|S01|E01/)
    const at = PLACED.indexOf('71.3')
    expect(JSON.parse(fs.read(TRACKING))).toEqual({
      version: 1, main: 'main.tex', template: 'article',
      copies: [{ snippet: 'S01', marker: 'Result: Training length at 1k images', file: 'main.tex', stamp: contentFingerprint(contentOf(fs.read(S01_PATH))), placed: PLACED }],
      values: [{ kind: 'number', from: 'E01', key: 'acc.1k', written: '71.3', file: 'main.tex', before: PLACED.slice(at - 28, at), after: ' points at 1k images.' }],
      bib: {}, allowed: [],
    })
    expect(fs.exists('vault/documents/paper/.blocks.json')).toBe(false)
    // after a copy, after a heading
    await setDocument(io, l, { name: 'paper', place: 'S02', after: 'S01' })
    expect(await order(io, l)).toEqual(['S01', 'S02'])
    expect(fs.read(PAPER)).toContain('%%% end %%%\n\n%%% Definition: Gap %%%\n\\begin{definition}[Gap]\\label{def:gap}\n\\end{definition}\n%%% end %%%')
    fs.write(PAPER, fs.read(PAPER).replace('\\maketitle', '\\maketitle\n\\section{Definitions}'))
    expect(await setDocument(io, l, { name: 'paper', move: 'S02', after: 'Definitions' })).toBe('Moved the copy of S02 in paper after Definitions.')
    doc = fs.read(PAPER)
    expect(await order(io, l)).toEqual(['S02', 'S01'])
    expect(doc).toContain('\\section{Definitions}\n\n%%% Definition: Gap %%%')
    expect(JSON.parse(fs.read(TRACKING)).copies.map((c: { snippet: string }) => c.snippet)).toEqual(['S02', 'S01'])
    await expect(setDocument(io, l, { name: 'paper', move: 'S01', after: 'S01' })).rejects.toThrow('a copy cannot go after itself')
    await expect(setDocument(io, l, { name: 'paper', move: 'S01', after: 'Nowhere' })).rejects.toThrow('"Nowhere" is neither a copy in paper nor one of its headings')
    await expect(setDocument(io, l, { name: 'book', place: 'S01' })).rejects.toThrow('"book" is no document')
    await expect(setDocument(io, l, { name: 'paper', place: 'S09' })).rejects.toThrow('S09 is no snippet')
    await expect(setDocument(io, l, { name: 'paper', remove: 'S09' })).rejects.toThrow('paper holds no copy of S09')
    expect(await setDocument(io, l, { name: 'paper', remove: 'S02' })).toBe('Removed the copy of S02 from paper (the snippet itself stays).')
    expect(await order(io, l)).toEqual(['S01'])
    expect(fs.read(PAPER)).not.toContain('Definition: Gap')
    expect(fs.exists('vault/snippets/S02.tex')).toBe(true)
  })

  test('a snippet may have several copies in a document, each named by its number; a copy goes in any .tex file of the document', async () => {
    const { fs, io, l } = await setup()
    await written(fs, io, l)
    await setSnippet(io, l, { kind: 'definition', title: 'Gap', basis: ['E01'] }, DATE)
    fs.write(PAPER, fs.read(PAPER).replace('\\maketitle', '\\maketitle\n\\input{sections/method}'))
    fs.write('vault/documents/paper/sections/method.tex', '\\section{Method}\nWe train longer.\n')
    await setDocument(io, l, { name: 'paper', place: 'S02' })
    expect(await setDocument(io, l, { name: 'paper', place: 'S02', file: 'sections/method.tex' }))
      .toBe('Placed a copy of S02 in paper (sections/method.tex), written out as plain LaTeX. It is the document\'s now: the user may adapt it; when S02 changes, the copy goes to review. paper now holds 2 copies of S02: S02#1 to S02#2.')
    // the second copy has a label of its own, at the end of its file; the document's order puts it first
    expect(fs.read('vault/documents/paper/sections/method.tex')).toBe('\\section{Method}\nWe train longer.\n\n%%% Definition: Gap %%%\n\\begin{definition}[Gap]\\label{def:gap-2}\n\\end{definition}\n%%% end %%%\n')
    const ms = (await readManuscript(io, l))!
    expect(ms.documents[0]!.copies.map(c => [c.snippet, c.nth, c.file])).toEqual([['S02', 1, 'sections/method.tex'], ['S02', 2, 'main.tex']])
    expect(usedIn(ms, 'S02')).toEqual([{ doc: 'paper', file: 'sections/method.tex', count: 1, states: ['placed'] }, { doc: 'paper', file: 'main.tex', count: 1, states: ['placed'] }])
    expect(await manuscriptReport(io, l)).toContain('  paper (article, main.tex, pdfLaTeX): S02#1 (sections/method.tex), S02#2')
    await expect(setDocument(io, l, { name: 'paper', move: 'S02', after: 'Method' })).rejects.toThrow('paper holds 2 copies of S02: name one, S02#1 (sections/method.tex), S02#2 (main.tex)')
    await expect(setDocument(io, l, { name: 'paper', place: 'S01', file: 'sections/nope.tex' })).rejects.toThrow('paper has no file sections/nope.tex to place a copy in (its .tex files: main.tex, sections/method.tex)')
    await expect(setDocument(io, l, { name: 'paper', place: 'S01', file: 'main.tex', after: 'S02#1' })).rejects.toThrow('the copy S02#1 is in sections/method.tex, not in main.tex')
    // after a copy in another file: it goes in that file; moved across files, its values follow
    await setDocument(io, l, { name: 'paper', place: 'S01', after: 'S02#1' })
    expect(fs.read('vault/documents/paper/sections/method.tex')).toContain('%%% end %%%\n\n%%% Result: Training length at 1k images %%%')
    expect(JSON.parse(fs.read(TRACKING)).values.map((v: { file: string }) => v.file)).toEqual(['sections/method.tex'])
    expect(await setDocument(io, l, { name: 'paper', move: 'S01', after: 'S02#2' })).toBe('Moved the copy of S01 in paper after S02#2.')
    expect(JSON.parse(fs.read(TRACKING)).values.map((v: { file: string }) => v.file)).toEqual(['main.tex'])
    expect((await readManuscript(io, l))!.documents[0]!.copies.map(c => [c.snippet, c.file])).toEqual([['S02', 'sections/method.tex'], ['S02', 'main.tex'], ['S01', 'main.tex']])
    expect(await setDocument(io, l, { name: 'paper', remove: 'S02#1' })).toBe('Removed the copy of S02#1 from paper (the snippet itself stays).')
    expect(fs.read('vault/documents/paper/sections/method.tex')).toBe('\\section{Method}\nWe train longer.\n')
    expect(await manuscriptReport(io, l)).toContain('  paper (article, main.tex, pdfLaTeX): S02, S01')
  })

  test('placing copies a figure in under its own name and adds what it cites to the document\'s .bib; removing takes out what nothing else uses', async () => {
    const { fs, io, l } = await setup()
    fs.write('vault/figures/E01_loss.pdf', '%PDF of the loss\n')
    await writeRegistry(io, 'vault', { ...(await readRegistry(io, 'vault')), locked: false })
    await setSnippet(io, l, { kind: 'figure', title: 'Loss', basis: ['E01'], text: '\\rftfig[width=\\linewidth]{E01}{loss}' }, DATE)
    await setSnippet(io, l, { kind: 'related-work', title: 'Mixup', basis: ['R01'], text: 'Mixup~\\cite{R01} mixes pairs; see Figure~\\ref{S01}.' }, DATE)
    fs.write('vault/documents/paper/refs.bib', '@misc{mine2020,\n  title = {Mine}\n}\n')
    expect(await setDocument(io, l, { name: 'paper', place: 'S01' })).toContain('written out as plain LaTeX (figures/loss.pdf copied in).')
    expect(await setDocument(io, l, { name: 'paper', place: 'S02' })).toContain('written out as plain LaTeX (zhang2018mixup in its .bib).')
    await setDocument(io, l, { name: 'paper', place: 'S02', after: 'S01' })
    expect(fs.read('vault/documents/paper/figures/loss.pdf')).toBe('%PDF of the loss\n')
    const doc = fs.read(PAPER)
    expect(doc).toContain('\\includegraphics[width=\\linewidth]{figures/loss.pdf}\n  \\caption{Loss}\\label{fig:loss}')
    expect(doc).toContain('Mixup~\\cite{zhang2018mixup} mixes pairs; see Figure~\\ref{fig:loss}.')
    expect(fs.read('vault/documents/paper/refs.bib')).toBe('@misc{mine2020,\n  title = {Mine}\n}\n\n@inproceedings{zhang2018mixup,\n  title={mixup},\n  year={2018}\n}\n')
    expect(JSON.parse(fs.read(TRACKING)).bib).toEqual({ zhang2018mixup: { from: 'R01', file: 'refs.bib' } })
    // one of the two copies that cite it goes: the entry stays; the other goes too: it leaves, the user's own stays
    await setDocument(io, l, { name: 'paper', remove: 'S02#1' })
    expect(fs.read('vault/documents/paper/refs.bib')).toContain('zhang2018mixup')
    await setDocument(io, l, { name: 'paper', remove: 'S02' })
    expect(fs.read('vault/documents/paper/refs.bib')).toBe('@misc{mine2020,\n  title = {Mine}\n}\n')
    expect(JSON.parse(fs.read(TRACKING)).bib).toEqual({})
    await setDocument(io, l, { name: 'paper', remove: 'S01' })
    expect(fs.exists('vault/documents/paper/figures/loss.pdf')).toBe(false)
    expect(JSON.parse(fs.read(TRACKING))).toMatchObject({ copies: [], values: [] })
  })

  test('a copy adapted to the narrative says so; a snippet that changes sends its copies to review, never rewritten; take or keep', async () => {
    const { fs, io, l } = await setup()
    await written(fs, io, l)
    await newDocument(io, l, 'thesis', 'report')
    await setDocument(io, l, { name: 'paper', place: 'S01' })
    await setDocument(io, l, { name: 'thesis', place: 'S01' })
    const copies = async () => {
      const ms = (await readManuscript(io, l))!
      return Object.fromEntries(ms.documents.map(d => [d.name, copyState(d.copies[0]!, ms.snippets[0]).state]))
    }
    expect(await copies()).toEqual({ paper: 'placed', thesis: 'placed' })
    // the thesis adapts its copy
    fs.write(THESIS, fs.read(THESIS).replace('points at 1k images.', 'points at 1k images, as Chapter 2 announced.'))
    expect(await copies()).toEqual({ paper: 'placed', thesis: 'adapted' })
    expect(usedIn((await readManuscript(io, l))!, 'S01')).toEqual([{ doc: 'paper', file: 'main.tex', count: 1, states: ['placed'] }, { doc: 'thesis', file: 'main.tex', count: 1, states: ['adapted'] }])
    // the snippet changes: both copies to review, their text as it was
    const paperBefore = fs.read(PAPER)
    fs.write(S01_PATH, fs.read(S01_PATH).replace('loses', 'costs'))
    expect(await copies()).toEqual({ paper: 'review', thesis: 'review' })
    expect(fs.read(PAPER)).toBe(paperBefore)
    // an outline comment in the snippet changes nothing
    fs.write(S01_PATH, fs.read(S01_PATH).replace('% basis: E01', '% basis: E01\n% a note to self'))
    expect(contentFingerprint(contentOf(fs.read(S01_PATH)))).toBe(contentFingerprint('\\paragraph{Training length at 1k images}\nLong training costs \\rftnum{E01}{acc.1k} points at 1k images.'))
    // the paper takes the new text; the thesis keeps its own
    expect(await reviewCopy(io, l, 'paper', 'S01', 'take')).toBe('The copy of S01 in paper now holds the snippet\'s text, written out as plain LaTeX.')
    expect(await reviewCopy(io, l, 'thesis', 'S01', 'keep')).toBe('The copy of S01 in thesis is kept as it is, now answering to the snippet as it is.')
    expect(await copies()).toEqual({ paper: 'placed', thesis: 'adapted' })
    expect(fs.read(PAPER)).toContain('%%% Result: Training length at 1k images %%%\n\\paragraph{Training length at 1k images}\nLong training costs 71.3 points at 1k images.\n%%% end %%%')
    expect(fs.read(PAPER)).not.toContain('a note to self')
    expect(fs.read(THESIS)).toContain('Long training loses 71.3 points at 1k images, as Chapter 2 announced.')
    const kept = JSON.parse(fs.read('vault/documents/.rft/thesis/tracking.json'))
    expect([kept.copies[0].placed, kept.copies[0].seen]).toEqual([PLACED.replace('loses', 'costs'), PLACED.replace('images.', 'images, as Chapter 2 announced.')])
    expect([JSON.parse(fs.read(TRACKING)).values.length, kept.values.length]).toEqual([1, 1])
    const report = await manuscriptReport(io, l)
    expect(report).toContain('S01 result · Training length at 1k images · written · E01 · used in paper (main.tex); thesis (main.tex: adapted)')
    expect(report).toContain('  paper (article, main.tex, pdfLaTeX): S01\n  thesis (report, main.tex, pdfLaTeX): S01 (adapted)')
    // a kept copy whose markers a co-author then deletes is still found, by the text it had
    fs.write(THESIS, fs.read(THESIS).replace('%%% Result: Training length at 1k images %%%\n', '').replace('%%% end %%%\n', ''))
    const found = (await readManuscript(io, l))!.documents.find(d => d.name === 'thesis')!.copies[0]!
    expect([found.found, copyState(found, (await readManuscript(io, l))!.snippets[0]).state]).toEqual(['text', 'adapted'])
    // moved, it gets its markers back
    fs.write(THESIS, fs.read(THESIS).replace('\\maketitle', '\\maketitle\n\\section{Results}'))
    await setDocument(io, l, { name: 'thesis', move: 'S01', after: 'Results' })
    expect(fs.read(THESIS)).toContain('\\section{Results}\n\n%%% Result: Training length at 1k images %%%\n\\paragraph{Training length at 1k images}\nLong training loses 71.3 points at 1k images, as Chapter 2 announced.\n%%% end %%%')
  })

  test('a document\'s outline: its headings and copies with their state, and the traces of the tree in its files', async () => {
    const { fs, io, l } = await setup()
    await written(fs, io, l)
    fs.write(PAPER, fs.read(PAPER).replace('\\maketitle', '\\maketitle\n\\section{Results}\nAs Definition~\\ref{S07} and \\cref{S01} say.'))
    await setDocument(io, l, { name: 'paper', place: 'S01', after: 'Results' })
    const line = fs.read(PAPER).split('\n').findIndex(x => x.includes('\\cref{S01}')) + 1
    expect(await manuscriptReport(io, l, 'paper')).toBe([
      'paper (vault/documents/paper/, template article, main file main.tex, pdfLaTeX): locked: its text is the user\'s.',
      'Its files: main.tex, refs.bib.',
      'Its outline:',
      '§ Results',
      '  S01 result · Training length at 1k images: as the snippet',
      `Traces of the tree in its files, which are shared as they are (1): main.tex:${line}: the id S01.`,
    ].join('\n'))
  })
})

describe('what a snippet rests on', () => {
  test('its basis line, the notes its macros name and the reference notes its citations stand for', async () => {
    const { l } = await setup()
    expect(usesIn('\\rftnum{E01}{acc} % \\rftnum{E02}{x}\n\\rftfig[width=.5\\linewidth]{E05}{loss} \\rfttable{E06}{t} \\citep[p.~3]{a, b} \\cite{R01}'))
      .toEqual({ nums: [['E01', 'acc']], figs: [['E05', 'loss']], tables: [['E06', 't']], cites: ['a', 'b', 'R01'] })
    expect(citeIndex(l)).toEqual({ R01: 'R01', zhang2018mixup: 'R01' })
    const s = { basis: ['D01'], text: '% rft-snippet S09 · result · X\n% basis: D01\nAs \\rftnum{E01}{seeds} and \\rftnum{E09}{x} \\cite{zhang2018mixup, nobody}.' }
    expect(basisOf(s, l)).toEqual({ ids: ['D01', 'E01', 'R01'], missing: ['E09'] })
  })

  test('review when a basis note changed or was superseded; its copies show that their snippet is in review', async () => {
    const { fs, io, l } = await setup()
    await written(fs, io, l)
    await setDocument(io, l, { name: 'paper', place: 'S01' })
    const st = async () => { const ms = (await readManuscript(io, l))!; return stateOf(ms.snippets[0]!, l, ms.registry).review }
    expect(await st()).toEqual([])
    fs.write(E01_PATH, fs.read(E01_PATH).replace('Text of E01.', 'Text of E01, rerun.'))
    Object.assign(l, await load(io, l.config))
    expect(await st()).toEqual(['E01 changed'])
    fs.write(E02_PATH, fs.read(E02_PATH).replace('status: running', 'status: done'))
    Object.assign(l, await load(io, l.config))
    await supersede(io, l, 'E01', 'E02', 'rerun', DATE, true)
    expect(await st()).toEqual(['E01 superseded by E02'])
    expect(await manuscriptReport(io, l, 'paper')).toContain('  S01 result · Training length at 1k images: as the snippet; its snippet is in review')
  })

  test('rft_manuscript: the library with where each snippet is used, the documents, what is still to write; one snippet in full', async () => {
    const { fs, io, l } = await setup()
    expect(await manuscriptReport(io, l)).toContain('Still to write (verified notes no snippet rests on), by concept:\n  demo: E01 experiment (First check); R01 reference (Mixup paper)')
    await written(fs, io, l)
    const all = await manuscriptReport(io, l)
    expect(all).toContain('Snippets (vault/snippets/), the building blocks, locked: the user writes them')
    expect(all).toContain('  S01 result · Training length at 1k images · written · E01 · in no document')
    expect(all).toContain('Documents (vault/documents/; each with its template, main file and engine), built from copies of snippets, locked: their text is the user\'s')
    expect(all).toContain('  paper (article, main.tex, pdfLaTeX): no copies yet')
    const one = await manuscriptReport(io, l, 'S01')
    expect(one).toContain('S01 result · Training length at 1k images (vault/snippets/S01.tex): written; in no document; locked: the user writes it.')
    expect(one).toContain('    numbers: \\rftnum{E01}{acc.1k} = 71.3, \\rftnum{E01}{acc.10k} = 88.2, \\rftnum{E01}{seeds} = 3')
    await expect(manuscriptReport(io, l, 'book')).rejects.toThrow('"book" is no document')
  })

  test('rft_next and rft_validate', async () => {
    const { fs, io, l } = await setup()
    await setSnippet(io, l, stub, DATE)
    await setDocument(io, l, { name: 'paper', place: 'S01' })
    fs.write(S01_PATH, fs.read(S01_PATH).replace('% your text', 'Now written.'))
    const next = await nextReport(io, l, DATE)
    expect(next).toContain('Copies in documents whose snippet changed since (the user takes the new text or keeps theirs): paper: S01 (main.tex).')
    expect(next).toContain('Verified notes no snippet rests on yet (rft_manuscript): R01.')
    fs.write('vault/snippets/S02.tex', '% rft-snippet S02 · essay · Hand made\n% basis: E09\nAs \\rftnum{E01}{nope} \\cite{nobody, R01}.\n')
    fs.write(PAPER, fs.read(PAPER).replace('\\bibliographystyle', '% rft-begin S07 0badf00d\nOld.\n% rft-end S07\nSee \\ref{S05} and \\ref{S01}.\n\\bibliographystyle'))
    expect(await manuscriptWarnings(io, l)).toEqual([
      'S02: kind "essay" is not one of definition, theorem, lemma, proposition, corollary, proof, method, result, related-work, motivation, discussion, figure, table',
      'S02: its basis names no note of the tree: E09',
      "S02: \\rftnum{E01}{nope}: no such number; E01's are acc.1k, acc.10k, seeds",
      'S02: cites what no reference note holds: nobody',
      expect.stringMatching(/^vault\/documents\/paper: its files are shared as they are and hold 3 traces of the tree: main\.tex:\d+: a marker of the first design \(rft-begin\); main\.tex:\d+: a marker of the first design \(rft-end\); main\.tex:\d+: the id S01$/),
    ])
    expect(await macroProblems(io, l, '\\rftnum{E02}{x}')).toEqual(['\\rftnum{E02}{x}: E02 has no saved RESULTS (its notebook has not run, or did not reproduce it)'])
  })
})

describe('comments on a snippet and on a document', () => {
  test('the same tools as on a note; nothing applied by Claude while locked', async () => {
    const { fs, io, l } = await setup()
    await written(fs, io, l, 'Long training hurts at 1k images.')
    await setDocument(io, l, { name: 'paper', place: 'S01' })
    expect(await comment(io, l, { id: 'S01', quote: 'hurts', text: 'By how much?' }, DATE)).toBe('S01 c1: comment added; the user sees it in the tree view.')
    expect(await suggest(io, l, { id: 's01', quote: 'hurts', replacement: 'costs \\rftnum{E01}{acc.1k} points' }, DATE)).toBe('S01 c2: suggestion added; the user accepts or rejects it in the tree view.')
    expect(await comment(io, l, { id: 'paper', quote: 'Long training hurts', text: 'This paragraph needs a transition.' }, DATE)).toBe('paper c1: comment added; the user sees it in the tree view.')
    const all = await commentsReport(io, l)
    expect(all).toContain('- S01 (snippet): c1 comment, c2 suggestion')
    expect(all).toContain('- paper (document): c1 comment')
    expect(await commentsReport(io, l, 'paper')).toContain('the document paper (locked: suggest changes, never edit it): 1 open, 0 closed.')
    await expect(comment(io, l, { id: 'S01', thread: 'c2', applied: true, text: 'done' }, DATE)).rejects.toThrow('is locked: you cannot apply a change to it')
    await expect(comment(io, l, { id: 'S09', quote: 'x', text: 'y' }, DATE)).rejects.toThrow('"S09" is no snippet')
    await expect(comment(io, l, { id: 'book', quote: 'x', text: 'y' }, DATE)).rejects.toThrow('"book" is no note, snippet or document')
  })
})

describe('the first layout', () => {
  test('vault/manuscript/ with \\rftsnippet lines is brought to two levels, each line a copy', async () => {
    const { fs, io, l } = await setup({ started: false })
    const s1 = '% rft-snippet S01 · result · One\n% basis: E01\n\\paragraph{One}\nText one.\n'
    fs.write('vault/manuscript/manuscript.json', JSON.stringify({ locked: true, next: 2, snippets: { S01: { stamp: { E01: 'aaaaaaaa' } } }, unlocked: [] }))
    fs.write('vault/manuscript/snippets/S01.tex', s1)
    fs.write('vault/manuscript/documents/paper/main.tex', '\\begin{document}\n\\rftsnippet{S01}\n\\end{document}\n')
    fs.write('vault/manuscript/rft.sty', 'x')
    expect(await migrateManuscript(io, l)).toBe('Brought the manuscript to two levels: snippets S01 in vault/snippets/, documents paper in vault/documents/, each \\rftsnippet line now a copy of its snippet.')
    expect(fs.read(S01_PATH)).toBe(s1)
    expect(JSON.parse(fs.read('vault/snippets/snippets.json'))).toEqual({ locked: true, next: 2, snippets: { S01: { stamp: { E01: 'aaaaaaaa' } } }, unlocked: [] })
    expect(fs.read(PAPER)).toBe(`\\begin{document}\n% rft-begin S01 ${contentFingerprint('\\paragraph{One}\nText one.')}\n\\paragraph{One}\nText one.\n% rft-end S01\n\\end{document}\n`)
    expect(fs.exists('vault/manuscript/manuscript.json') || fs.exists('vault/manuscript/rft.sty') || fs.exists('vault/manuscript/snippets/S01.tex')).toBe(false)
    expect(await migrateManuscript(io, l)).toBeNull()
  })
})

describe('in a session', () => {
  async function session($: Engine, on: On, files: Record<string, string>) {
    mock.clock(on)
    const w = world(on, files)
    const ran: string[] = []
    on('tool.call', (_$, e) => { ran.push(String(e.tool)); return { result: 'ok', text: 'ok' } as never })
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    return { w, ran }
  }
  const filesOf = (fs: MemoryFs) => Object.fromEntries([...fs.files].map(([k, v]) => [k, v.text]))

  test('Claude\'s own writes to locked snippets and documents are refused; to what the user unlocked, they go on', async ($, on) => {
    const { fs, io, l } = await setup()
    await setSnippet(io, l, stub, DATE)
    await setSnippet(io, l, { ...stub, title: 'Two' }, DATE)
    await writeRegistry(io, 'vault', { ...(await readRegistry(io, 'vault')), unlocked: ['S02'] })
    await newDocument(io, l, 'thesis', 'report')
    await writeDocsRegistry(io, 'vault', { ...(await readDocsRegistry(io, 'vault')), unlocked: ['thesis'] })
    await setDocument(io, l, { name: 'paper', place: 'S01' })
    const { w, ran } = await session($, on, filesOf(fs))
    for (const [call, why] of [
      [{ tool: 'Edit', file_path: `${CWD}/${S01_PATH}`, old_string: '% your text', new_string: 'Mine.' }, 'S01 is the user\'s to write'],
      [{ tool: 'Write', file_path: `${CWD}/${PAPER}`, content: 'x' }, 'The document paper is locked'],
      [{ tool: 'Write', file_path: `${CWD}/vault/documents/rft.sty`, content: 'x' }, 'The plugin writes'],
      [{ tool: 'Write', file_path: `${CWD}/vault/documents/paper/.blocks.json`, content: '{}' }, 'The plugin writes'],
      [{ tool: 'Edit', file_path: `${CWD}/vault/snippets/snippets.json`, old_string: '"locked": true', new_string: '"locked": false' }, 'The plugin writes'],
      [{ tool: 'Write', file_path: `${CWD}/vault/snippets/S09.tex`, content: 'x' }, 'A new snippet is made with rft_set_snippet'],
      [{ tool: 'Bash', command: `sed -i 's/your text/Mine/' ${S01_PATH}` }, 'S01 is the user\'s to write'],
    ] as const) {
      const res = await $.tool.call(call as never)
      expect({ call, deny: (res as { deny?: string }).deny }).toEqual({ call, deny: expect.stringContaining(why) })
    }
    expect(ran).toEqual([])
    for (const call of [
      { tool: 'Edit', file_path: `${CWD}/vault/snippets/S02.tex`, old_string: '% your text', new_string: 'Mine.' },
      { tool: 'Edit', file_path: `${CWD}/${THESIS}`, old_string: '\\maketitle', new_string: '\\maketitle\nIntro.' },
    ]) expect(((await $.tool.call(call as never)) as { deny?: string }).deny).toBeUndefined()
    expect(w.tools).toContain('rft_set_document')
    const r = await $.tool.call({ tool: 'mcp__rft__rft_set_document', name: 'paper', place: 'S02', after: 'S01' } as never)
    expect(r.text).toContain('Placed a copy of S02 in paper after S01, written out as plain LaTeX.')
  })

  test('/rft-manuscript brings the first layout over, starts both levels, adds a document, or asks Claude for proposals', async ($, on) => {
    const { fs } = await setup({ started: false })
    fs.write('vault/manuscript/manuscript.json', JSON.stringify({ locked: true, next: 1, snippets: {} }))
    const { w } = await session($, on, filesOf(fs))
    const run = (args: string) => $.command.run({ command: 'rft-manuscript', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
    expect((await run('')).text).toContain('Brought the manuscript to two levels')
    w.fs.remove('vault/snippets/snippets.json')
    w.fs.remove('vault/documents/documents.json')
    expect((await run('')).text).toContain('Started snippets (vault/snippets/) and documents (vault/documents/), both locked')
    expect(w.fs.read(PAPER)).toContain('\\documentclass[11pt]{article}')
    expect((await run('new thesis-ch3 report')).text).toContain('Added the document thesis-ch3')
    expect((await run('new x book')).text).toBe('"book" is no template: a document is made from article and report (built in)')
    expect((await run('book')).text).toContain('"book" is no document (paper, thesis-ch3)')
    expect((await run('paper')).text).toBe('Asked Claude to propose snippets to write and where to place them in paper: tables to choose from; nothing is written until you pick.')
  })
})

describe('a document is made from a template', () => {
  // a kit as a folder of the vault's templates/: its class and style files, its sample text, a figure, and what it says of its documents
  const KIT: Record<string, string> = {
    'vault/templates/icml2027/example_paper.tex': '\\documentclass{article}\n\\usepackage{icml2027}\n\\begin{document}\nSample text.\n\\bibliography{example_paper}\n\\end{document}\n',
    'vault/templates/icml2027/example_paper.bib': '@article{sample,\n  title={Sample}\n}\n',
    'vault/templates/icml2027/icml2027.sty': '% the style\n',
    'vault/templates/icml2027/icml2027.bst': '% the bibliography style\n',
    'vault/templates/icml2027/figures/icml_numpapers.pdf': '%PDF stand-in\n',
    'vault/templates/icml2027/.DS_Store': 'junk',
    'vault/templates/thesis-xe/template.json': '{"engine": "xelatex", "main": "thesis.tex"}\n',
    'vault/templates/thesis-xe/thesis.tex': '\\documentclass{book}\n\\begin{document}\n\\include{chapters/one}\n\\end{document}\n',
    'vault/templates/thesis-xe/standalone.tex': '\\documentclass{article}\n\\begin{document}\nOne chapter alone.\n\\end{document}\n',
    'vault/templates/thesis-xe/chapters/one.tex': '\\chapter{One}\n',
    'vault/templates/two-mains/a.tex': '\\begin{document}\nA\n\\end{document}\n',
    'vault/templates/two-mains/b.tex': '\\begin{document}\nB\n\\end{document}\n',
    // the notes' own templates are files of the same folder: not a document's template
    'vault/templates/_experiment.md': '# a note\'s template\n',
  }
  const kit = async () => {
    const s = await setup()
    for (const [path, text] of Object.entries(KIT)) s.fs.write(path, text)
    return s
  }
  const under = (fs: MemoryFs, folder: string) => Object.fromEntries([...fs.files].filter(([k]) => k.startsWith(folder)).map(([k, v]) => [k.slice(folder.length), v.text]))

  test('the built-in templates: an article and a report, as the fixture has them; a document from before templates reads as made from its class', async () => {
    const { fs, io, l } = await setup({ started: false })
    await newDocument(io, l, 'paper', 'article', 'Small data & more')
    await newDocument(io, l, 'chapter', 'report', 'Small data & more')
    expect(under(fs, 'vault/documents/paper/')).toEqual(BUILT_IN.article!)
    expect(under(fs, 'vault/documents/chapter/')).toEqual(BUILT_IN.report!)
    expect(JSON.parse(fs.read('vault/documents/.rft/chapter/tracking.json'))).toEqual({ version: 1, main: 'main.tex', template: 'report', copies: [], values: [], bib: {}, allowed: [] })
    // made before templates: no tracking file, or one that names none
    fs.remove('vault/documents/.rft/chapter/tracking.json')
    fs.write('vault/documents/.rft/paper/tracking.json', JSON.stringify({ version: 1, main: 'main.tex', copies: [], values: [], bib: {}, allowed: [] }))
    const ms = (await readManuscript(io, l))!
    expect(ms.documents.map(d => [d.name, d.template, d.main, d.engine])).toEqual([['chapter', 'report', 'main.tex', 'pdflatex'], ['paper', 'article', 'main.tex', 'pdflatex']])
  })

  test('a template of the vault: every file copied as it is, its engine and main file recorded, its settings file left behind', async () => {
    const { fs, io, l } = await kit()
    expect(await newDocument(io, l, 'icml', 'icml2027')).toBe('Added the document icml (vault/documents/icml/, from the template icml2027: 5 files, main file example_paper.tex).')
    const want = under(fs, 'vault/templates/icml2027/')
    delete want['.DS_Store']
    expect(under(fs, 'vault/documents/icml/')).toEqual(want)
    expect(JSON.parse(fs.read('vault/documents/.rft/icml/tracking.json'))).toEqual({ version: 1, main: 'example_paper.tex', template: 'icml2027', copies: [], values: [], bib: {}, allowed: [] })
    // a template that names its engine and its main file
    await newDocument(io, l, 'thesis', 'thesis-xe')
    expect(Object.keys(under(fs, 'vault/documents/thesis/')).sort()).toEqual(['chapters/one.tex', 'standalone.tex', 'thesis.tex'])
    expect(JSON.parse(fs.read('vault/documents/.rft/thesis/tracking.json'))).toMatchObject({ main: 'thesis.tex', engine: 'xelatex', template: 'thesis-xe' })
    const ms = (await readManuscript(io, l))!
    const d = ms.documents.find(x => x.name === 'thesis')!
    expect([d.main, d.mainAsked, d.engine, d.template, [...d.included].sort()]).toEqual(['thesis.tex', [], 'xelatex', 'thesis-xe', ['chapters/one.tex', 'thesis.tex']])
    // several files with \begin{document} and no word from the template: the user is asked in the page
    expect(await newDocument(io, l, 'two', 'two-mains')).toContain('its main file still to choose in the page')
    expect((await readManuscript(io, l))!.documents.find(x => x.name === 'two')!.mainAsked).toEqual(['a.tex', 'b.tex'])
    const report = await manuscriptReport(io, l)
    expect(report).toContain('  icml (icml2027, example_paper.tex, pdfLaTeX): no copies yet')
    expect(report).toContain('  thesis (thesis-xe, thesis.tex, XeLaTeX): no copies yet')
    expect(report).toContain('  two (two-mains, a.tex?, pdfLaTeX): no copies yet')
    expect(report).toContain('Templates a document is made from (rft_set_document {name, template}, when the user asks for a document): article and report (built in); icml2027, thesis-xe, two-mains (vault/templates/).')
  })

  test('the document keeps no tie to its template: changing the template afterwards changes no document', async () => {
    const { fs, io, l } = await kit()
    await newDocument(io, l, 'icml', 'icml2027')
    const before = under(fs, 'vault/documents/icml/')
    fs.write('vault/templates/icml2027/icml2027.sty', '% the style, next year\n')
    fs.write('vault/templates/icml2027/new.tex', 'New.\n')
    fs.remove('vault/templates/icml2027/example_paper.bib')
    expect(under(fs, 'vault/documents/icml/')).toEqual(before)
    expect((await readManuscript(io, l))!.documents.find(x => x.name === 'icml')!.template).toBe('icml2027')
  })

  test('rft_set_document makes a document from a template; a name that is taken, a template that is none and a name that is no name are refused', async () => {
    const { fs, io, l } = await kit()
    expect(await setDocument(io, l, { name: 'camera-ready', template: 'icml2027' })).toContain('Added the document camera-ready (vault/documents/camera-ready/, from the template icml2027')
    expect(fs.read('vault/documents/camera-ready/icml2027.sty')).toBe('% the style\n')
    await expect(setDocument(io, l, { name: 'paper', template: 'icml2027' })).rejects.toThrow('there is already a document paper')
    await expect(setDocument(io, l, { name: 'x', template: 'neurips' })).rejects.toThrow('"neurips" is no template: a document is made from article and report (built in); icml2027, thesis-xe, two-mains (vault/templates/)')
    await expect(setDocument(io, l, { name: 'x', template: '../icml2027' })).rejects.toThrow('is no template')
    await expect(setDocument(io, l, { name: 'x', template: '_experiment.md' })).rejects.toThrow('is no template')
    await expect(setDocument(io, l, { name: 'My Paper', template: 'article' })).rejects.toThrow('lowercase letters, digits and dashes')
    await expect(setDocument(io, l, { name: 'y', template: 'article', place: 'S01' })).rejects.toThrow('make the document first')
    await expect(setDocument(io, l, { name: 'nope', place: 'S01' })).rejects.toThrow('with a template (article and report (built in); icml2027, thesis-xe, two-mains (vault/templates/)) rft_set_document makes it')
    expect(fs.exists('vault/documents/x')).toBe(false)
  })
})
