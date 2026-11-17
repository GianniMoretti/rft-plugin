// Snippets and documents, two levels. Snippets: LaTeX building blocks resting on verified notes,
// reused. Documents: built from copies of snippets, each copy referenced to its snippet and in
// review when the snippet changes, never rewritten by itself. Locked by default: Claude proposes
// stubs and placements, comments and suggests; the user writes and accepts.

import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { comment, commentsReport, suggest } from '../hooks/lib/comments'
import { nextReport, supersede } from '../hooks/lib/knowledge'
import {
  basisOf, citeIndex, copyState, isStub, macroProblems, manuscriptReport, manuscriptWarnings, markReviewed, migrateManuscript, newDocument,
  readManuscript, refsMissing, reviewCopy, setDocument, setSnippet, stateOf, usedIn, usesIn,
} from '../hooks/lib/manuscript'
import { contentFingerprint, contentOf, parseBlocks, readDocsRegistry, readRegistry, writeDocsRegistry, writeRegistry } from '../hooks/lib/snippets'
import { eagerTools, featuresInUse } from '../hooks/lib/tools'
import { verifyNote } from '../hooks/lib/verify'
import { load, readConfig } from '../hooks/lib/vault'
import { CWD, D00, E01, E02, MemoryFs, demoFiles, note, world } from './fixture'

const DATE = '2026-11-17'
const E01_PATH = `vault/experiments/${E01}.md`
const E02_PATH = `vault/experiments/${E02}.md`
const R01_PATH = 'vault/references/R01 Mixup paper.md'
const S01_PATH = 'vault/snippets/S01.tex'
const PAPER = 'vault/documents/paper/main.tex'
const THESIS = 'vault/documents/thesis/main.tex'

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
    expect(doc).toContain('\\usepackage{rft}')
    expect(doc).not.toContain('\\rftsnippet')
    expect(await newDocument(io, l, 'thesis-ch3', 'report')).toBe('Added the document thesis-ch3 (vault/documents/thesis-ch3/main.tex).')
    expect(fs.read('vault/documents/thesis-ch3/main.tex')).toContain('\\chapter{demo}')
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
  test('a placement copies the snippet\'s text between markers, stamped, where the user agreed', async () => {
    const { fs, io, l } = await setup()
    await written(fs, io, l)
    await setSnippet(io, l, { kind: 'definition', title: 'Gap', basis: ['E01'] }, DATE)
    expect(await setDocument(io, l, { name: 'paper', place: 'S01' })).toBe('Placed a copy of S01 in paper. It is the document\'s now: the user may adapt it; when S01 changes, the copy goes to review.')
    const content = contentOf(fs.read(S01_PATH))
    expect(content).toBe('\\paragraph{Training length at 1k images}\nLong training loses \\rftnum{E01}{acc.1k} points at 1k images.')
    let doc = fs.read(PAPER)
    expect(doc).toContain(`\n\n% rft-begin S01 ${contentFingerprint(content)}\n${content}\n% rft-end S01\n\n\\bibliographystyle{plainnat}`)
    expect(JSON.parse(fs.read('vault/documents/paper/.blocks.json'))).toEqual({ S01: content })
    // after a copy, after a heading
    await setDocument(io, l, { name: 'paper', place: 'S02', after: 'S01' })
    doc = fs.read(PAPER)
    expect(parseBlocks(doc).map(b => b.id)).toEqual(['S01', 'S02'])
    fs.write(PAPER, doc.replace('\\maketitle', '\\maketitle\n\\section{Definitions}'))
    await setDocument(io, l, { name: 'paper', move: 'S02', after: 'Definitions' })
    doc = fs.read(PAPER)
    expect(parseBlocks(doc).map(b => b.id)).toEqual(['S02', 'S01'])
    expect(doc).toContain('\\section{Definitions}\n\n% rft-begin S02 ')
    await expect(setDocument(io, l, { name: 'paper', place: 'S01' })).rejects.toThrow('paper already holds a copy of S01: move it instead')
    await expect(setDocument(io, l, { name: 'paper', move: 'S01', after: 'Nowhere' })).rejects.toThrow('"Nowhere" is neither a copy in this document nor one of its headings')
    await expect(setDocument(io, l, { name: 'book', place: 'S01' })).rejects.toThrow('"book" is no document')
    await expect(setDocument(io, l, { name: 'paper', place: 'S09' })).rejects.toThrow('S09 is no snippet')
    expect(await setDocument(io, l, { name: 'paper', remove: 'S02' })).toBe('Removed the copy of S02 from paper (the snippet itself stays).')
    expect(parseBlocks(fs.read(PAPER)).map(b => b.id)).toEqual(['S01'])
    expect(fs.exists('vault/snippets/S02.tex')).toBe(true)
  })

  test('a copy adapted to the narrative says so; a snippet that changes sends its copies to review, never rewritten; take or keep', async () => {
    const { fs, io, l } = await setup()
    await written(fs, io, l)
    await newDocument(io, l, 'thesis', 'report')
    await setDocument(io, l, { name: 'paper', place: 'S01' })
    await setDocument(io, l, { name: 'thesis', place: 'S01' })
    const copies = async () => {
      const ms = (await readManuscript(io, l))!
      return Object.fromEntries(ms.documents.map(d => [d.name, copyState(d.blocks[0]!, ms.snippets[0]).state]))
    }
    expect(await copies()).toEqual({ paper: 'sync', thesis: 'sync' })
    // the thesis adapts its copy
    fs.write(THESIS, fs.read(THESIS).replace('points at 1k images.', 'points at 1k images, as Chapter 2 announced.'))
    expect(await copies()).toEqual({ paper: 'sync', thesis: 'adapted' })
    expect(usedIn((await readManuscript(io, l))!, 'S01')).toEqual([{ doc: 'paper', state: 'sync' }, { doc: 'thesis', state: 'adapted' }])
    // the snippet changes: both copies to review, their text as it was
    const paperBefore = fs.read(PAPER)
    fs.write(S01_PATH, fs.read(S01_PATH).replace('loses', 'costs'))
    expect(await copies()).toEqual({ paper: 'review', thesis: 'review' })
    expect(fs.read(PAPER)).toBe(paperBefore)
    // an outline comment in the snippet changes nothing
    fs.write(S01_PATH, fs.read(S01_PATH).replace('% basis: E01', '% basis: E01\n% a note to self'))
    expect(contentFingerprint(contentOf(fs.read(S01_PATH)))).toBe(contentFingerprint('\\paragraph{Training length at 1k images}\nLong training costs \\rftnum{E01}{acc.1k} points at 1k images.'))
    // the paper takes the new text; the thesis keeps its own
    expect(await reviewCopy(io, l, 'paper', 'S01', 'take')).toBe('The copy of S01 in paper now holds the snippet\'s text.')
    expect(await reviewCopy(io, l, 'thesis', 'S01', 'keep')).toBe('The copy of S01 in thesis is kept as it is, now answering to the snippet as it is.')
    expect(await copies()).toEqual({ paper: 'sync', thesis: 'adapted' })
    expect(fs.read(PAPER)).toContain('Long training costs')
    expect(fs.read(THESIS)).toContain('Long training loses \\rftnum{E01}{acc.1k} points at 1k images, as Chapter 2 announced.')
    expect(JSON.parse(fs.read('vault/documents/thesis/.blocks.json')).S01).toContain('costs')
    const report = await manuscriptReport(io, l)
    expect(report).toContain('S01 result · Training length at 1k images · written · E01 · used in paper, thesis (adapted)')
    expect(report).toContain('  paper: S01\n  thesis: S01 (adapted)')
  })

  test('a document\'s outline: its headings and copies with their state; what it refers to and does not hold', async () => {
    const { fs, io, l } = await setup()
    await written(fs, io, l)
    fs.write(PAPER, fs.read(PAPER).replace('\\maketitle', '\\maketitle\n\\section{Results}\nAs Definition~\\ref{S07} and \\cref{S01} say.'))
    await setDocument(io, l, { name: 'paper', place: 'S01', after: 'Results' })
    expect(await manuscriptReport(io, l, 'paper')).toBe([
      'paper (vault/documents/paper/main.tex): locked: its text is the user\'s. Its outline:',
      '§ Results',
      '  S01 result · Training length at 1k images: as the snippet',
      'It refers to snippets it holds no copy of: S07.',
    ].join('\n'))
    expect(refsMissing((await readManuscript(io, l))!.documents[0]!)).toEqual(['S07'])
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
    expect(all).toContain('Documents (vault/documents/), built from copies of snippets, locked: their text is the user\'s')
    expect(all).toContain('  paper: no copies yet')
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
    expect(next).toContain('Copies in documents whose snippet changed since (the user takes the new text or keeps theirs): paper: S01.')
    expect(next).toContain('Verified notes no snippet rests on yet (rft_manuscript): R01.')
    fs.write('vault/snippets/S02.tex', '% rft-snippet S02 · essay · Hand made\n% basis: E09\nAs \\rftnum{E01}{nope} \\cite{nobody, R01}.\n')
    fs.write(PAPER, fs.read(PAPER).replace('\\bibliographystyle', '% rft-begin S07 0badf00d\nOld.\n% rft-end S07\nSee \\ref{S05}.\n\\bibliographystyle'))
    expect(await manuscriptWarnings(io, l)).toEqual([
      'S02: kind "essay" is not one of definition, theorem, lemma, proposition, corollary, proof, method, result, related-work, motivation, discussion, figure, table',
      'S02: its basis names no note of the tree: E09',
      "S02: \\rftnum{E01}{nope}: no such number; E01's are acc.1k, acc.10k, seeds",
      'S02: cites what no reference note holds: nobody',
      'vault/documents/paper/main.tex: holds copies of snippets that do not exist: S07',
      'vault/documents/paper/main.tex: refers to snippets it holds no copy of: S05',
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
    expect(r.text).toContain('Placed a copy of S02 in paper after S01.')
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
    expect((await run('new x book')).text).toContain('A document is an article (a paper) or a report')
    expect((await run('book')).text).toContain('"book" is no document (paper, thesis-ch3)')
    expect((await run('paper')).text).toBe('Asked Claude to propose snippets to write and where to place them in paper: tables to choose from; nothing is written until you pick.')
  })
})
