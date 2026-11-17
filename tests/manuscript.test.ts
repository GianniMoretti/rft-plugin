// The manuscript: LaTeX snippets resting on verified notes, assembled by documents. Locked by
// default: Claude proposes stubs and comments, the user writes; unlocked, Claude writes too.

import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { comment, commentsReport, suggest } from '../hooks/lib/comments'
import { nextReport, supersede } from '../hooks/lib/knowledge'
import { basisOf, citeIndex, isStub, macroProblems, manuscriptReport, markReviewed, manuscriptWarnings, newDocument, placed, readManuscript, setSnippet, stateOf, usesIn } from '../hooks/lib/manuscript'
import { readRegistry, writeRegistry } from '../hooks/lib/snippets'
import { eagerTools, featuresInUse } from '../hooks/lib/tools'
import { verifyNote } from '../hooks/lib/verify'
import { load, readConfig } from '../hooks/lib/vault'
import { CWD, D00, E01, E02, MemoryFs, demoFiles, note, world } from './fixture'

const DATE = '2026-11-17'
const E01_PATH = `vault/experiments/${E01}.md`
const E02_PATH = `vault/experiments/${E02}.md`
const R01 = 'R01 Mixup paper'
const R01_PATH = `vault/references/${R01}.md`
const S01_PATH = 'vault/manuscript/snippets/S01.tex'
const PAPER = 'vault/manuscript/documents/paper/main.tex'

/** The demo, a reference with a BibTeX block, E01's saved run; E01 and R01 verified, a manuscript with a document. */
async function setup(opts: { manuscript?: boolean } = {}) {
  const files = demoFiles()
  files[R01_PATH] = note('R01', 'reference', 'done', D00, 'Mixup paper')
    .replace('## Idea\nText of R01.', '## Source\nZhang et al. 2018, arXiv:1710.09412\n```bibtex\n@inproceedings{zhang2018mixup,\n  title={mixup},\n  year={2018}\n}\n```\n\n## Key results\nMixup helps.')
  files['vault/results/E01.json'] = JSON.stringify({ exp: 'E01', results: { acc: { '1k': 71.3, '10k': 88.2 }, seeds: 3 }, figures: ['figures/E01_loss.svg'], tables: ['tables/E01_by_seed.html'] })
  const fs = new MemoryFs(files)
  const io = fs.io()
  const l = await load(io, (await readConfig(io))!)
  await verifyNote(io, l, 'E01', DATE)
  await verifyNote(io, l, 'R01', DATE)
  if (opts.manuscript !== false) await newDocument(io, l, 'paper', 'article', 'Small data')
  return { fs, io, l }
}

const stub = { kind: 'result', title: 'Training length at 1k images', basis: ['E01'], outline: ['the claim: long training loses \\rftnum{E01}{acc.1k} at 1k', 'the spread over 3 seeds'], document: 'paper' }

describe('starting a manuscript', () => {
  test('none until the user starts one: the tools say so and are not in the prompt', async () => {
    const { io, l } = await setup({ manuscript: false })
    expect(await manuscriptReport(io, l)).toContain('This vault has no manuscript yet. The user starts one with /rft-manuscript')
    await expect(setSnippet(io, l, stub, DATE)).rejects.toThrow('This vault has no manuscript')
    expect(eagerTools(featuresInUse(l, false)).has('rft_manuscript')).toBe(false)
  })

  test('a first document starts it, locked; then the tools join the prompt', async () => {
    const { fs, io, l } = await setup({ manuscript: false })
    expect(await newDocument(io, l, 'paper', 'article', 'Small data')).toContain('Started the manuscript in vault/manuscript/, locked')
    expect(JSON.parse(fs.read('vault/manuscript/manuscript.json'))).toEqual({ locked: true, next: 1, snippets: {}, unlocked: [] })
    const doc = fs.read(PAPER)
    expect(doc).toContain('\\documentclass[11pt]{article}')
    expect(doc).toContain('\\usepackage{rft}')
    expect(doc).toContain('\\title{Small data}')
    expect(doc).toContain('\\bibliography{refs}')
    expect(await newDocument(io, l, 'thesis-ch3', 'report')).toBe('Added the document thesis-ch3 (vault/manuscript/documents/thesis-ch3/main.tex).')
    expect(fs.read('vault/manuscript/documents/thesis-ch3/main.tex')).toContain('\\chapter{demo}')
    await expect(newDocument(io, l, 'paper')).rejects.toThrow('already has a document paper')
    await expect(newDocument(io, l, 'My Paper')).rejects.toThrow('lowercase letters, digits and dashes')
    const fresh = await load(io, l.config)
    expect(fresh.hasManuscript).toBe(true)
    const eager = eagerTools(featuresInUse(fresh, false))
    expect(eager.has('rft_manuscript') && eager.has('rft_set_snippet')).toBe(true)
  })
})

describe('snippets', () => {
  test('locked: Claude proposes a stub from verified notes, placed in a document; the text is the user\'s', async () => {
    const { fs, io, l } = await setup()
    const out = await setSnippet(io, l, stub, DATE)
    expect(out).toBe('S01 proposed as a stub for the user to write: vault/manuscript/snippets/S01.tex (result, basis E01), placed in paper. Tell the user it is there and what it asks for; then comment and suggest on their text when they ask, never write it.')
    const text = fs.read(S01_PATH)
    expect(text).toBe([
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
    expect(isStub(text)).toBe(true)
    const doc = fs.read(PAPER)
    expect(doc.indexOf('\\rftsnippet{S01}')).toBeLessThan(doc.indexOf('\\bibliographystyle'))
    const reg = await readRegistry(io, 'vault')
    expect(reg.next).toBe(2)
    expect(reg.snippets.S01).toEqual({ stamp: { E01: expect.stringMatching(/^[0-9a-f]{8}$/) }, proposed: DATE })
    // a second one goes after it, or after the one named
    await setSnippet(io, l, { ...stub, title: 'Second' }, DATE)
    await setSnippet(io, l, { ...stub, title: 'Between', after: 'S01' }, DATE)
    const order = (await readManuscript(io, l))!.documents[0]!.order
    expect(order).toEqual(['S01', 'S03', 'S02'])
    // text while locked, an unverified basis, a bad kind: refused, nothing written
    await expect(setSnippet(io, l, { ...stub, text: 'Long training loses.' }, DATE)).rejects.toThrow('the manuscript is locked: the user writes the text')
    await expect(setSnippet(io, l, { ...stub, basis: ['E01', 'D01'] }, DATE)).rejects.toThrow('only verified notes are candidates for the manuscript: D01 is idea')
    await expect(setSnippet(io, l, { ...stub, kind: 'essay' }, DATE)).rejects.toThrow('kind must be one of definition')
    await expect(setSnippet(io, l, { ...stub, basis: ['E42'] }, DATE)).rejects.toThrow('"E42" is not a note of the tree')
    await expect(setSnippet(io, l, { ...stub, document: 'book' }, DATE)).rejects.toThrow('"book" is no document')
    // and its text, later, only through suggestions
    await expect(setSnippet(io, l, { id: 'S01', text: 'Mine.' }, DATE)).rejects.toThrow('S01 is the user\'s to write (the manuscript is locked): comment on it with rft_comment {id: "S01", quote, text}')
    expect((await readRegistry(io, 'vault')).next).toBe(4)
  })

  test('a theorem-like kind gets its environment and a label', async () => {
    const { fs, io, l } = await setup()
    await setSnippet(io, l, { kind: 'definition', title: 'Augmentation {gap}', basis: ['R01'], document: 'paper' }, DATE)
    expect(fs.read(S01_PATH)).toContain('\\begin{definition}[Augmentation gap]\\label{S01}\n% your text\n\\end{definition}\n')
  })

  test('unlocked: Claude writes the text, its macros checked against what the notebooks saved, and it is stamped', async () => {
    const { fs, io, l } = await setup()
    await setSnippet(io, l, stub, DATE)
    const reg = await readRegistry(io, 'vault')
    await writeRegistry(io, 'vault', { ...reg, unlocked: ['S01'] })
    await expect(setSnippet(io, l, { id: 'S01', text: 'It loses \\rftnum{E01}{acc.2k} points.' }, DATE))
      .rejects.toThrow('\\rftnum{E01}{acc.2k}: no such number; E01\'s are acc.1k, acc.10k, seeds')
    await expect(setSnippet(io, l, { id: 'S01', text: 'See \\rftfig{E01}{accuracy}.' }, DATE)).rejects.toThrow('E01 saved no figure of that name; its are loss')
    const out = await setSnippet(io, l, { id: 'S01', text: 'Long training loses \\rftnum{E01}{acc.1k} points at 1k images over \\rftnum{E01}{seeds} seeds \\citep{zhang2018mixup}.' }, '2026-11-18')
    expect(out).toBe('S01 written (vault/manuscript/snippets/S01.tex), stamped with its basis as it is now.')
    const text = fs.read(S01_PATH)
    expect(text).toBe('% rft-snippet S01 · result · Training length at 1k images\n% basis: E01\n\\paragraph{Training length at 1k images}\nLong training loses \\rftnum{E01}{acc.1k} points at 1k images over \\rftnum{E01}{seeds} seeds \\citep{zhang2018mixup}.\n')
    expect(isStub(text)).toBe(false)
    // the citation joins its basis, and the stamp
    expect((await readRegistry(io, 'vault')).snippets.S01).toMatchObject({ written: '2026-11-18', stamp: { E01: expect.any(String), R01: expect.any(String) } })
    await setSnippet(io, l, { id: 'S01', edits: [{ old_str: 'points', new_str: 'percentage points' }] }, DATE)
    expect(fs.read(S01_PATH)).toContain('loses \\rftnum{E01}{acc.1k} percentage points')
    await expect(setSnippet(io, l, { id: 'S01', edits: [{ old_str: 'nowhere', new_str: 'x' }] }, DATE)).rejects.toThrow('exactly once (it is 0 times)')
    // a new one with its text, once the whole manuscript is unlocked
    await writeRegistry(io, 'vault', { ...(await readRegistry(io, 'vault')), locked: false })
    expect(await setSnippet(io, l, { ...stub, title: 'Written', text: 'Text \\rftnum{E01}{seeds}.' }, DATE)).toContain('S02 written')
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

  test('review when a basis note changed, went to review, was superseded or dropped; unverified flagged', async () => {
    const { fs, io, l } = await setup()
    await setSnippet(io, l, stub, DATE)
    const s = () => readManuscript(io, l).then(ms => ms!.snippets[0]!)
    const reg = () => readRegistry(io, 'vault')
    expect(stateOf(await s(), l, await reg())).toEqual({ stub: true, review: [], unverified: [], missing: [], basis: ['E01'] })
    // its Result changed (before the session's watch sends it to review)
    fs.write(E01_PATH, fs.read(E01_PATH).replace('Text of E01.', 'Text of E01, rerun.'))
    Object.assign(l, await load(io, l.config))
    expect(stateOf(await s(), l, await reg()).review).toEqual(['E01 changed'])
    // superseded
    fs.write(E02_PATH, fs.read(E02_PATH).replace('status: running', 'status: done'))
    Object.assign(l, await load(io, l.config))
    await supersede(io, l, 'E01', 'E02', 'rerun', DATE, true)
    expect(stateOf(await s(), l, await reg()).review).toEqual(['E01 superseded by E02'])
    // a basis note the user linked by hand that is not verified: flagged, not refused
    fs.write(S01_PATH, fs.read(S01_PATH).replace('% basis: E01', '% basis: E01, D01'))
    expect(stateOf(await s(), l, await reg()).unverified).toEqual(['D01'])
  })

  test('rft_manuscript: the documents, their snippets with state and basis, and the verified notes still to write; one snippet in full', async () => {
    const { io, l } = await setup()
    expect(await manuscriptReport(io, l)).toContain('Still to write (verified notes no snippet rests on), by concept:\n  demo: E01 experiment (First check); R01 reference (Mixup paper)')
    await setSnippet(io, l, stub, DATE)
    const all = await manuscriptReport(io, l)
    expect(all).toContain('Manuscript (vault/manuscript/), locked: the user writes it')
    expect(all).toContain('paper (vault/manuscript/documents/paper/main.tex): 1 snippet(s)\n  S01 result · Training length at 1k images · stub · E01')
    expect(all).toContain('  demo: R01 reference (Mixup paper)')
    expect(all).not.toContain('E01 experiment (First check)')
    const one = await manuscriptReport(io, l, 'S01')
    expect(one).toContain('S01 result · Training length at 1k images (vault/manuscript/snippets/S01.tex): stub; in paper; locked: the user writes it.')
    expect(one).toContain('    numbers: \\rftnum{E01}{acc.1k} = 71.3, \\rftnum{E01}{acc.10k} = 88.2, \\rftnum{E01}{seeds} = 3')
    expect(one).toContain('    figures: \\rftfig{E01}{loss}')
    expect(one).toContain('    tables: \\rfttable{E01}{by_seed}')
    await expect(manuscriptReport(io, l, 'book')).rejects.toThrow('"book" is no document')
  })

  test('rft_next and rft_validate', async () => {
    const { fs, io, l } = await setup()
    await setSnippet(io, l, stub, DATE)
    expect(await nextReport(io, l, DATE)).toContain('Stubs waiting for the user to write: S01. Verified notes no snippet rests on yet (rft_manuscript): R01.')
    fs.write('vault/manuscript/snippets/S02.tex', '% rft-snippet S02 · essay · Hand made\n% basis: E09\nAs \\rftnum{E01}{nope} \\cite{nobody, R01}.\n')
    fs.write(PAPER, placed(fs.read(PAPER), 'S07'))
    const w = await manuscriptWarnings(io, l)
    expect(w).toEqual([
      'S02: kind "essay" is not one of definition, theorem, lemma, proposition, corollary, proof, method, result, related-work, motivation, discussion, figure, table',
      'S02: its basis names no note of the tree: E09',
      "S02: \\rftnum{E01}{nope}: no such number; E01's are acc.1k, acc.10k, seeds",
      'S02: cites what no reference note holds: nobody',
      'vault/manuscript/documents/paper/main.tex: places snippets that do not exist: S07',
    ])
    expect(await macroProblems(io, l, '\\rftnum{E02}{x}')).toEqual(['\\rftnum{E02}{x}: E02 has no saved RESULTS (its notebook has not run, or did not reproduce it)'])
  })
})

describe('from the tree view', () => {
  test('the user starts a snippet on any note (flagged until verified) and marks one reviewed', async () => {
    const { fs, io, l } = await setup()
    expect(await setSnippet(io, l, { kind: 'discussion', title: 'Open question', basis: ['D01'], document: 'paper' }, DATE, { byUser: true })).toContain('S01 proposed')
    const text = fs.read(S01_PATH)
    expect(text).toBe('% rft-snippet S01 · discussion · Open question\n% basis: D01\n\\paragraph{Open question}\n% your text\n')
    const ms = (await readManuscript(io, l))!
    expect(stateOf(ms.snippets[0]!, l, ms.registry).unverified).toEqual(['D01'])
    // reviewed: the stamp taken anew, so a change seen before is no longer one
    await setSnippet(io, l, stub, DATE)
    fs.write(E01_PATH, fs.read(E01_PATH).replace('Text of E01.', 'Text of E01, rerun.'))
    Object.assign(l, await load(io, l.config))
    const s2 = async () => { const m = (await readManuscript(io, l))!; return stateOf(m.snippets[1]!, l, m.registry).review }
    expect(await s2()).toEqual(['E01 changed'])
    expect(await markReviewed(io, l, 'S02', '2026-11-18')).toBe('S02 reviewed: stamped with its basis as it is now.')
    expect(await s2()).toEqual([])
    expect((await readRegistry(io, 'vault')).snippets.S02!.reviewed).toBe('2026-11-18')
  })
})

describe('comments on a snippet', () => {
  test('the same tools as on a note: a comment, a suggestion; nothing applied by Claude while it is locked', async () => {
    const { fs, io, l } = await setup()
    await setSnippet(io, l, stub, DATE)
    fs.write(S01_PATH, fs.read(S01_PATH).replace('% your text', 'Long training hurts at 1k images.'))
    expect(await comment(io, l, { id: 'S01', quote: 'hurts', text: 'By how much? \\rftnum{E01}{acc.1k} gives it.' }, DATE)).toBe('S01 c1: comment added; the user sees it in the tree view.')
    expect(await suggest(io, l, { id: 's01', quote: 'hurts', replacement: 'costs \\rftnum{E01}{acc.1k} points' }, DATE)).toBe('S01 c2: suggestion added; the user accepts or rejects it in the tree view.')
    expect(JSON.parse(fs.read('vault/.comments/S01.json')).threads.map((t: { kind: string }) => t.kind)).toEqual(['comment', 'suggestion'])
    expect(await commentsReport(io, l)).toContain('- S01 (manuscript snippet): c1 comment, c2 suggestion')
    expect(await commentsReport(io, l, 'S01')).toContain('S01 Training length at 1k images (locked: suggest changes, never edit it): 2 open, 0 closed.')
    await expect(comment(io, l, { id: 'S01', thread: 'c2', applied: true, text: 'done' }, DATE)).rejects.toThrow('is locked: you cannot apply a change to it')
    await expect(comment(io, l, { id: 'S09', quote: 'x', text: 'y' }, DATE)).rejects.toThrow('"S09" is no snippet of the manuscript')
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

  test('Claude\'s own writes to a locked manuscript are refused; to a snippet the user unlocked, they go on', async ($, on) => {
    const { fs, io, l } = await setup()
    await setSnippet(io, l, stub, DATE)
    await setSnippet(io, l, { ...stub, title: 'Two' }, DATE)
    await writeRegistry(io, 'vault', { ...(await readRegistry(io, 'vault')), unlocked: ['S02'] })
    const { w, ran } = await session($, on, filesOf(fs))
    for (const [call, why] of [
      [{ tool: 'Edit', file_path: `${CWD}/${S01_PATH}`, old_string: '% your text', new_string: 'Mine.' }, 'S01 is the user\'s to write'],
      [{ tool: 'Write', file_path: `${CWD}/${PAPER}`, content: 'x' }, 'its snippets and documents are the user\'s to write'],
      [{ tool: 'Write', file_path: `${CWD}/vault/manuscript/rft.sty`, content: 'x' }, 'The plugin writes the manuscript\'s'],
      [{ tool: 'Edit', file_path: `${CWD}/vault/manuscript/manuscript.json`, old_string: '"locked": true', new_string: '"locked": false' }, 'The plugin writes the manuscript\'s'],
      [{ tool: 'Write', file_path: `${CWD}/vault/manuscript/snippets/S09.tex`, content: 'x' }, 'A new snippet is made with rft_set_snippet'],
      [{ tool: 'Bash', command: `sed -i 's/your text/Mine/' ${S01_PATH}` }, 'S01 is the user\'s to write'],
    ] as const) {
      const res = await $.tool.call(call as never)
      expect({ call, deny: (res as { deny?: string }).deny }).toEqual({ call, deny: expect.stringContaining(why) })
    }
    expect(ran).toEqual([])
    const ok = await $.tool.call({ tool: 'Edit', file_path: `${CWD}/vault/manuscript/snippets/S02.tex`, old_string: '% your text', new_string: 'Mine.' } as never)
    expect((ok as { deny?: string }).deny).toBeUndefined()
    expect(w.tools).toContain('rft_manuscript')
    const r = await $.tool.call({ tool: 'mcp__rft__rft_manuscript', ref: 'S01' } as never)
    expect(r.text).toContain('S01 result · Training length at 1k images')
  })

  test('/rft-manuscript starts it, adds a document, or asks Claude for proposals', async ($, on) => {
    const { fs } = await setup({ manuscript: false })
    const { w } = await session($, on, filesOf(fs))
    const run = (args: string) => $.command.run({ command: 'rft-manuscript', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
    expect((await run('')).text).toContain('Started the manuscript in vault/manuscript/, locked')
    expect(w.fs.read(PAPER)).toContain('\\documentclass[11pt]{article}')
    expect((await run('new thesis-ch3 report')).text).toContain('Added the document thesis-ch3')
    expect((await run('new x book')).text).toContain('A document is an article (a paper) or a report')
    expect((await run('book')).text).toContain('"book" is no document of the manuscript (paper, thesis-ch3)')
    expect((await run('paper')).text).toBe('Asked Claude to propose what to write in paper: a table to choose from; nothing is written until you pick.')
  })
})
