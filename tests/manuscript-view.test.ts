// The tree view's Manuscript tab (web/manuscript.js), two views: a selection's anchor, the library
// by kind, a snippet's state and where it is used, the content a copy takes, a file's outline from
// its marker lines and the copies the server found (the fixture's document among them), a value and
// a trace in a line, the snippets resting on a note, an error of the compile in a line.

import { describe, expect, test } from 'claude-code/testing'

import '../web/manuscript.js'
import { EXPECTED, FILES } from './fixtures/local-overleaf'

type Use = { doc: string; file: string; count: number; states: string[] }
type Copy = { id: string; name?: string; file?: string; state: string; marker?: string; markers?: boolean; line?: number | null; end?: number | null; snippetReview?: boolean }
type Snippet = { id: string; kind?: string; title?: string; basis?: string[]; review?: string[]; stub?: boolean; usedIn?: Use[] }
type Ms = { snippets: Snippet[] }
type Api = {
  CONTEXT: number
  anchorOf: (text: string, start: number, end: number) => { quote: string; prefix: string; suffix: string }
  contentOf: (snippetText: string) => string
  byKind: (snippets: Snippet[]) => { kind: string; snippets: Snippet[] }[]
  stateOf: (s: Snippet) => { word: string; why: string }
  usedWords: (s: Snippet) => string
  usedCount: (s: Snippet) => number
  parseMarkers: (text: string) => { words: string; begin: number; end: number }[]
  outlineOf: (text: string, copies: Copy[], file?: string) => Record<string, unknown>[]
  valueWords: (v: Record<string, unknown>) => string
  traceWords: (t: Record<string, unknown>) => string
  fileOrder: (d: { main: string; files: string[]; copies: Copy[] }) => string[]
  writtenIn: (ms: Ms | null, id: string) => string[]
  slugOf: (title: string) => string
  docNameProblem: (name: string, taken: string[]) => string
  errorText: (e: { file: string; in?: string; snippet?: string; line: number | null; message: string; context?: string }) => string
  MAX_UPLOAD: number
  treeRows: (d: { tree?: Record<string, unknown>[]; files?: string[] } | null) => { path: string; kind: string; name: string; depth: number; folder: string; edit?: boolean }[]
  editable: (d: { tree?: Record<string, unknown>[]; files?: string[] } | null) => string[]
  typedPath: (typed: string | null, folder: string) => { path: string; problem: string }
  uploadProblem: (name: string, size: number) => string
  crc32: (bytes: Uint8Array) => number
  zipOf: (files: { path: string; bytes: Uint8Array }[]) => Uint8Array[]
  templateName: (raw: string) => string
  templateWords: (t: { name: string; builtIn: boolean; files?: number; engine?: string }) => string
  remoteWords: (url: string) => string
  gitWords: (st: Record<string, unknown> | null) => string
  bringInLines: (r: Record<string, unknown>) => { text: string; file?: string; line?: number }[]
  addTemplateLines: (r: Record<string, unknown>) => { text: string }[]
}
const M = (globalThis as unknown as { RftManuscript: Api }).RftManuscript

const ms: Ms = {
  snippets: [
    { id: 'S01', kind: 'result', basis: ['E05', 'R01'], stub: false, review: [], usedIn: [{ doc: 'paper', file: 'main.tex', count: 2, states: ['placed', 'placed'] }, { doc: 'paper', file: 'sections/method.tex', count: 1, states: ['adapted'] }, { doc: 'thesis', file: 'main.tex', count: 1, states: ['placed'] }] },
    { id: 'S02', kind: 'definition', basis: ['E06'], stub: true, review: [], usedIn: [] },
    { id: 'S03', kind: 'result', basis: ['E05'], stub: false, review: ['E05 superseded by E09'], usedIn: [{ doc: 'paper', file: 'main.tex', count: 1, states: ['review'] }] },
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
    expect(M.usedWords(ms.snippets[0]!)).toBe('paper (main.tex ×2, sections/method.tex: adapted); thesis (main.tex)')
    expect(M.usedWords(ms.snippets[2]!)).toBe('paper (main.tex: to review)')
    expect(M.usedWords(ms.snippets[1]!)).toBe('')
    expect([M.usedCount(ms.snippets[0]!), M.usedCount(ms.snippets[1]!), M.usedCount(ms.snippets[3]!)]).toEqual([4, 0, 0])
  })

  test('what a copy takes from a snippet: its text below the header, as the plugin takes it', () => {
    expect(M.contentOf('% rft-snippet S01 · result · X\n% basis: E05\n\n\\paragraph{X}\nText.\n\n')).toBe('\\paragraph{X}\nText.')
    expect(M.contentOf('No header.\n')).toBe('No header.')
  })

  test('a file\'s outline: its headings and the copies between its marker lines, with the state the server gave each', () => {
    const doc = [
      '\\begin{document}', '\\section{Results}', '%%% Result: One %%%', 'Text.', '%%% end %%%',
      '\\subsection{More}', '%%%result:  one%%%', '\\section{Inside a copy}', 'Old.', '%%% end %%%', '%%% A comment of my own %%%', 'Found by its text.', '\\end{document}',
    ].join('\n')
    expect(M.parseMarkers(doc)).toEqual([{ words: 'Result: One', begin: 2, end: 4 }, { words: 'result:  one', begin: 6, end: 9 }])
    const copies: Copy[] = [
      { id: 'S01', name: 'S01#1', file: 'main.tex', state: 'adapted', marker: 'Result: One', markers: true, line: 3, end: 5 },
      { id: 'S01', name: 'S01#2', file: 'main.tex', state: 'review', marker: 'Result: One', markers: true, line: 7, end: 10, snippetReview: true },
      { id: 'S05', name: 'S05', file: 'main.tex', state: 'placed', marker: 'Motivation: Why', markers: false, line: 12, end: 12 },
      { id: 'S04', name: 'S04', file: 'sections/method.tex', state: 'placed', marker: 'Method: Setup', markers: true, line: 2, end: 4 },
      { id: 'S06', name: 'S06', file: 'main.tex', state: 'lost', marker: 'Discussion: Limits', markers: false, line: null, end: null },
    ]
    expect(M.outlineOf(doc, copies, 'main.tex')).toEqual([
      { type: 'heading', level: 'section', title: 'Results', line: 1 },
      { type: 'copy', id: 'S01', name: 'S01#1', marker: 'Result: One', line: 2, end: 4, state: 'adapted', markers: true, snippetReview: false },
      { type: 'heading', level: 'subsection', title: 'More', line: 5 },
      { type: 'copy', id: 'S01', name: 'S01#2', marker: 'Result: One', line: 6, end: 9, state: 'review', markers: true, snippetReview: true },
      { type: 'copy', id: 'S05', name: 'S05', marker: 'Motivation: Why', line: 11, end: 11, state: 'placed', markers: false, snippetReview: false },
    ])
    // typing above a copy does not move its highlight off it: it is where its marker lines are now
    expect(M.outlineOf(`A new line.\nAnother.\n${doc}`, copies.slice(0, 2), 'main.tex').filter(o => o.type === 'copy').map(o => [o.name, o.line, o.end])).toEqual([['S01#1', 4, 6], ['S01#2', 8, 11]])
    expect(M.outlineOf('%%% Method: Setup %%%\nWe train.\n%%% end %%%\n', copies, 'sections/method.tex').map(o => o.name)).toEqual(['S04'])
  })

  test('the fixture\'s document: each file\'s outline holds its copies, in the order and the states expected', () => {
    // the copies as the server gives them (tests/test_clean_source.py holds its reader to the same file)
    const lines: Record<string, [number, number]> = { 'S05 main.tex': [28, 29], 'S01 main.tex': [31, 37], 'S01 sections/method.tex': [3, 6], 'S04 sections/method.tex': [8, 11], 'S03 sections/method.tex': [14, 20], 'S07 sections/method.tex': [22, 26], 'S02 main.tex': [43, 47] }
    const copies: Copy[] = EXPECTED.copies.map(c => ({ id: c.snippet, name: c.snippet, file: c.file ?? 'main.tex', state: c.state, marker: c.marker, markers: c.markers, line: lines[`${c.snippet} ${c.file}`]?.[0] ?? null, end: lines[`${c.snippet} ${c.file}`]?.[1] ?? null }))
    const got = ['main.tex', 'sections/method.tex'].flatMap(f => M.outlineOf(FILES[`vault/documents/paper/${f}`]!, copies, f).filter(o => o.type === 'copy').map(o => [o.id, f, o.state, (o.line as number) + 1, (o.end as number) + 1]))
    expect(got).toEqual(EXPECTED.copies.filter(c => c.file).sort((a, b) => (a.file! < b.file! ? -1 : a.file! > b.file! ? 1 : a.order! - b.order!)).map(c => [c.snippet, c.file, c.state, ...lines[`${c.snippet} ${c.file}`]!]))
    expect(M.fileOrder({ main: 'main.tex', files: ['main.tex', 'refs.bib', 'sections/method.tex'], copies })).toEqual(['main.tex', 'sections/method.tex', 'refs.bib'])
  })

  test('a value to look at and a trace, each in a line', () => {
    const v = { kind: 'number', from: 'E05', key: 'acc.full', written: '81.4', file: 'main.tex', line: 45 }
    expect(M.valueWords({ ...v, state: 'review', now: '81.6', inDocument: '81.4' })).toBe('81.4 (E05 acc.full) · main.tex:45 · the tree now says 81.6')
    expect(M.valueWords({ ...v, state: 'review', now: null, inDocument: '81.4' })).toBe('81.4 (E05 acc.full) · main.tex:45 · no longer saved')
    expect(M.valueWords({ ...v, state: 'changed', now: '81.4', inDocument: '82' })).toBe('81.4 (E05 acc.full) · main.tex:45 · now 82 here: no longer the tree\'s')
    expect(M.valueWords({ kind: 'figure', from: 'E08', key: 'loss', written: 'figures/loss.pdf', file: 'sections/method.tex', line: 17, state: 'review', now: '12@3' })).toBe('figure loss (E08 loss) · sections/method.tex:17 · saved again')
    expect(M.valueWords({ ...v, state: 'lost', line: null })).toBe('81.4 (E05 acc.full) · main.tex · not found any more')
    expect(M.traceWords({ file: 'main.tex', line: 8, kind: 'plugin', match: '\\rftnum' })).toBe('main.tex:8: the plugin\'s \\rftnum')
    expect(M.traceWords({ file: 'figures/E08_loss.pdf', line: null, kind: 'id', match: 'E08' })).toBe('figures/E08_loss.pdf (its name): the id E08')
    expect(M.traceWords({ file: 'refs.bib', line: 8, kind: 'reference', match: 'yun2019cutmix' })).toBe('refs.bib:8: the entry yun2019cutmix, not cited')
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
    expect(M.errorText({ file: 'documents/paper/sections/method.tex', in: 'sections/method.tex', line: 12, message: 'Undefined control sequence.' })).toBe('sections/method.tex:12: Undefined control sequence.')
  })

  test('a document\'s file list: every file and folder with its depth; the files the editor opens', () => {
    const d = { tree: [
      { path: 'figures', kind: 'folder' }, { path: 'figures/logo.png', kind: 'file', size: 90, edit: false, show: 'image' },
      { path: 'papers', kind: 'folder' }, { path: 'papers/paperA', kind: 'folder' }, { path: 'papers/paperA/paperA.tex', kind: 'file', size: 10, edit: true, show: null },
      { path: 'icml2027.sty', kind: 'file', size: 10, edit: true, show: null }, { path: 'main.tex', kind: 'file', size: 10, edit: true, show: null },
    ] }
    expect(M.treeRows(d).map(e => [e.name, e.depth, e.folder, e.kind])).toEqual([
      ['figures', 0, '', 'folder'], ['logo.png', 1, 'figures', 'file'], ['papers', 0, '', 'folder'], ['paperA', 1, 'papers', 'folder'],
      ['paperA.tex', 2, 'papers/paperA', 'file'], ['icml2027.sty', 0, '', 'file'], ['main.tex', 0, '', 'file'],
    ])
    expect(M.editable(d)).toEqual(['papers/paperA/paperA.tex', 'icml2027.sty', 'main.tex'])
    // a summary from before the tree was listed: its text files
    expect(M.treeRows({ files: ['main.tex', 'refs.bib'] }).map(e => e.path)).toEqual(['main.tex', 'refs.bib'])
    expect(M.treeRows(null)).toEqual([])
  })

  test('a path typed for a file or a folder, and a file too large to upload, said before anything is sent', () => {
    expect(M.typedPath(' /chapters/intro.tex/ ', '')).toEqual({ path: 'chapters/intro.tex', problem: '' })
    expect(M.typedPath('logo.png', 'figures')).toEqual({ path: 'figures/logo.png', problem: '' })
    expect(M.typedPath('other/logo.png', 'figures').path).toBe('other/logo.png')
    for (const bad of ['', '  ', '../x.tex', 'a/../b.tex', '.hidden', 'a//b.tex', 'a\\b.tex', 'what?.tex']) expect(M.typedPath(bad, '').problem).not.toBe('')
    expect(M.typedPath(null, '').problem).toBe('Give it a name')
    expect(M.uploadProblem('big.pdf', 21_000_000)).toBe('big.pdf is 21.0 MB: a file of a document is at most 20.0 MB')
    expect(M.uploadProblem('ok.pdf', M.MAX_UPLOAD)).toBe('')
  })

  test('a template in the New document menu, its name made from a zip\'s or a folder\'s, and a folder sent as a zip', () => {
    expect(M.templateWords({ name: 'article', builtIn: true })).toBe('Paper (article)')
    expect(M.templateWords({ name: 'report', builtIn: true })).toBe('Thesis chapter (report)')
    expect(M.templateWords({ name: 'icml2027', builtIn: false, files: 9 })).toBe('icml2027 · 9 files')
    expect(M.templateWords({ name: 'thesis-xe', builtIn: false, files: 1, engine: 'xelatex' })).toBe('thesis-xe · 1 file · XeLaTeX')
    // as template_name in server/rft_documents.py makes them (tests/test_documents.py)
    expect(M.templateName('C:\\kits\\ICML 2027 (final).zip')).toBe('ICML-2027-final')
    expect(M.templateName('aauPhdCollectionThesis/')).toBe('aauPhdCollectionThesis')
    expect(M.templateName('..')).toBe('')
    // the zip the page makes of a picked folder: stored, each file with its CRC-32 (the server's tests read one)
    const enc = new TextEncoder()
    expect(M.crc32(enc.encode('123456789')).toString(16)).toBe('cbf43926')
    const parts = M.zipOf([{ path: 'kit/main.tex', bytes: enc.encode('Hello.') }, { path: 'kit/figures/a.png', bytes: new Uint8Array([1, 2, 3]) }])
    const zip = new Uint8Array(parts.reduce((n, x) => n + x.length, 0))
    parts.reduce((at, x) => (zip.set(x, at), at + x.length), 0)
    const view = new DataView(zip.buffer)
    expect(view.getUint32(0, true)).toBe(0x04034b50)
    expect(view.getUint32(zip.length - 22, true)).toBe(0x06054b50)
    expect(view.getUint16(zip.length - 22 + 10, true)).toBe(2)
    expect(view.getUint32(14, true)).toBe(M.crc32(enc.encode('Hello.')))
  })

  test('a document\'s repository in the head: its remote in short, and how far behind and ahead it is', () => {
    expect(M.remoteWords('git@github.com:you/paper.git')).toBe('github.com:you/paper')
    expect(M.remoteWords('https://github.com/you/paper.git/')).toBe('github.com/you/paper')
    expect(M.remoteWords('/srv/git/paper.git')).toBe('/srv/git/paper')
    expect(M.gitWords({ repository: true, remote: 'x', behind: 1, ahead: 0, changed: 3 })).toBe('1 commit behind · 0 ahead · 3 files changed since the last push or pull')
    expect(M.gitWords({ repository: true, remote: 'x', behind: 0, ahead: 2, changed: 0 })).toBe('0 behind · 2 commits ahead · nothing changed')
    expect(M.gitWords({ repository: true, remote: null })).toBe('')
    expect(M.gitWords(null)).toBe('')
  })

  test('what bringing a document in, or adding a template\'s files, did and left to do', () => {
    const lines = M.bringInLines({
      doc: 'thesis', from: 'icml', into: 'papers/paperA', files: 10, copies: 1, main: 'papers/paperA/example_paper.tex',
      paths: [{ file: 'papers/paperA/example_paper.tex', line: 634, command: 'input', path: 'sections/method', to: 'papers/paperA/sections/method' }],
      labels: [{ label: 'def:cutmix', here: ['thesis.tex:7'], brought: ['papers/paperA/main.tex:32'] }], keys: [{ key: 'yun2019cutmix', here: 'thesis.bib', brought: 'papers/paperA/refs.bib' }],
    })
    expect(lines.map(x => x.text)).toEqual([
      'Brought icml into papers/paperA/ of thesis: 10 files, 1 copy of snippets tracked under their new paths. icml itself is unchanged, and the two are not tied.',
      'Its main file, papers/paperA/example_paper.tex, is left as it is and thesis does not take it in. What remains is yours: take its body in from a file of thesis (\\input{…}), without its preamble, \\begin{document} and \\end{document}.',
      'papers/paperA/example_paper.tex:634: \\input{sections/method} is read from the top of thesis now: it needs papers/paperA/sections/method',
      'The label def:cutmix is in both: thesis.tex:7 and papers/paperA/main.tex:32. Rename one of them.',
      'The .bib key yun2019cutmix is in both: thesis.bib and papers/paperA/refs.bib. Keep one entry if both files are read together.',
    ])
    expect(lines.map(x => [x.file, x.line])).toEqual([[undefined, undefined], ['papers/paperA/example_paper.tex', 1], ['papers/paperA/example_paper.tex', 634], [undefined, undefined], [undefined, undefined]])
    expect(M.addTemplateLines({ doc: 'paper', template: 'venue', added: ['venue.cls'], skipped: ['main.tex', 'refs.bib'] }).map(x => x.text)).toEqual([
      'Added 1 file of venue to paper: venue.cls.',
      'Skipped, because paper already has a file of that path (nothing is overwritten): main.tex, refs.bib.',
      'Nothing in paper was changed: its preamble is yours to rewrite for the template\'s class or style.',
    ])
    expect(M.addTemplateLines({ doc: 'paper', template: 'venue', added: [], skipped: [] })[0]!.text).toBe('Nothing of venue was added to paper.')
  })
})
