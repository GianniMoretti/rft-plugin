// A snippet written out as plain LaTeX (hooks/lib/writeout.ts, docs/adr/0003-a-document-holds-no-trace.md):
// what a document holds of a snippet names nothing of the tree. Held to the fixture
// (tests/fixtures/local-overleaf: a small vault with one document as a co-author would see it).

import { describe, expect, test } from 'claude-code/testing'

import { scanFiles } from '../hooks/lib/scan'
import { listSnippets } from '../hooks/lib/snippets'
import { readTracking } from '../hooks/lib/tracking'
import { bibEntries, labelOf, markerWords, parseKeepingNumbers, savedNumbers, slug, withoutComments, writeOut } from '../hooks/lib/writeout'
import { load, readConfig } from '../hooks/lib/vault'
import { MemoryFs } from './fixture'
import { FILES } from './fixtures/local-overleaf'

const DOC = 'vault/documents/paper'

/** The fixture's project, loaded; `extra`: files added or replaced. */
async function setup(extra: Record<string, string> = {}) {
  const fs = new MemoryFs({ ...FILES, ...extra })
  const io = fs.io()
  const l = await load(io, (await readConfig(io))!)
  const snippets = await listSnippets(io, 'vault')
  const ids = new Set([...Object.keys(l.tree.nodes), ...snippets.map(s => s.id)])
  const out = (id: string, held = {}) => writeOut(io, l, snippets.find(s => s.id === id)!, snippets, ids, held)
  return { fs, io, l, snippets, ids, out }
}

const snippet = (id: string, kind: string, title: string, basis: string, body: string) => `% rft-snippet ${id} · ${kind} · ${title}\n% basis: ${basis}\n${body}\n`

describe('a snippet written out as plain LaTeX', () => {
  test('the fixture\'s snippets give the text the fixture\'s document holds', async () => {
    const { io, out } = await setup()
    const placed = (await readTracking(io, 'vault', 'paper')).copies
    const then = (id: string) => placed.find(c => c.snippet === id)!.placed
    for (const id of ['S01', 'S03', 'S05']) expect((await out(id)).text).toBe(then(id))
    // the tree moved on since these two were placed: 300 epochs, 81.6
    expect((await out('S04')).text).toBe(then('S04').replace('200 epochs', '300 epochs'))
    expect((await out('S02')).text).toBe(then('S02').replace('81.4', '81.6'))
    expect((await out('S01')).marker).toBe('Definition: CutMix')
  })

  test('each number it wrote, with where it came from and where it sits in the text', async () => {
    const { out } = await setup()
    const w = await out('S02')
    expect(w.values.map(v => [v.kind, v.from, v.key, v.written])).toEqual([['number', 'E05', 'acc.1k', '73.2'], ['number', 'E05', 'acc.full', '81.6']])
    for (const v of w.values) expect(w.text.slice(v.at, v.at + v.written.length)).toBe(v.written)
    expect(w.text.slice(w.values[1]!.at - 8, w.values[1]!.at)).toBe('against ')
    expect([w.files, w.bib, w.labels]).toEqual([[], [], []])
  })

  test('a number is written as the notebook rounded it', async () => {
    expect(parseKeepingNumbers('{"a": [1.0, -2e-05, "x", null, true], "b": {"c": 73.20}}')).toMatchObject({ a: [{ text: '1.0' }, { text: '-2e-05' }, 'x', null, true], b: { c: { text: '73.20' } } })
    expect(() => parseKeepingNumbers('{"a": 1,}')).toThrow()
    const { io } = await setup({ 'vault/results/E05.json': '{"exp": "E05", "results": {"acc": {"1k": 73.0}, "gap": "8.4 ± 0.3", "cost_$": "5%", "ok": true, "none": null, "per": [1, 2.50]}}' })
    expect(await savedNumbers(io, 'vault', 'E05')).toEqual({ 'acc.1k': '73.0', gap: '8.4 $\\pm$ 0.3', 'cost_$': '5\\%', 'per[0]': '1', 'per[1]': '2.50' })
    expect(await savedNumbers(io, 'vault', 'E99')).toBeNull()
  })

  test('a figure is a file to copy in under its own name; a table is its tabular', async () => {
    const { out } = await setup()
    const fig = await out('S03')
    expect(fig.files).toEqual([{ from: 'figures/E08_loss.pdf', to: 'figures/loss.pdf' }])
    expect(fig.values.map(v => [v.kind, v.from, v.key, v.written])).toEqual([['figure', 'E08', 'loss', 'figures/loss.pdf']])
    expect(fig.text).toContain('\\includegraphics[width=.8\\linewidth]{figures/loss.pdf}')
    expect(fig.text.slice(fig.values[0]!.at, fig.values[0]!.at + 16)).toBe('figures/loss.pdf')
    expect(fig.labels).toEqual(['fig:training-loss'])
    // the document already holds this figure: nothing to copy again
    expect((await out('S03', { files: { 'figures/loss.pdf': 'E08 loss' } })).files).toEqual([])
    // a file of that name that is not this figure is never overwritten
    const other = await out('S03', { files: { 'figures/loss.pdf': '' } })
    expect([other.files, other.values[0]!.written]).toEqual([[{ from: 'figures/E08_loss.pdf', to: 'figures/loss-2.pdf' }], 'figures/loss-2.pdf'])

    const tabular = '\\begin{tabular}{lr}\n\\toprule\nseed & acc \\\\\n\\midrule\n0 & 73.1 \\\\\n\\bottomrule\n\\end{tabular}'
    const t = await setup({
      'vault/results/E05.json': JSON.stringify({ exp: 'E05', results: { acc: { '1k': 73.2 } }, figures: [], tables: ['tables/E05_by_seed.html'] }),
      'vault/tables/E05_by_seed.tex': tabular + '\n',
      'vault/snippets/S09.tex': snippet('S09', 'table', 'Accuracy by seed', 'E05', '\\begin{table}[t]\n  \\centering\n  \\caption{Accuracy by seed}\\label{S09}\n  \\rfttable{E05}{by_seed}\n\\end{table}'),
    })
    const tab = await t.out('S09')
    expect(tab.text).toBe(`\\begin{table}[t]\n  \\centering\n  \\caption{Accuracy by seed}\\label{tab:accuracy-by-seed}\n  ${tabular}\n\\end{table}`)
    expect(tab.values).toEqual([{ kind: 'table', from: 'E05', key: 'by_seed', written: tabular, at: tab.text.indexOf('\\begin{tabular}') }])
  })

  test('two figures of the same name from different notes do not overwrite each other, and neither name carries an id', async () => {
    const { out } = await setup({
      'vault/results/E05.json': JSON.stringify({ exp: 'E05', results: {}, figures: ['figures/E05_loss.svg'], tables: [] }),
      'vault/figures/E05_loss.pdf': '%PDF\n',
      'vault/snippets/S09.tex': snippet('S09', 'figure', 'Two losses', 'E05, E08', '\\begin{figure}[t]\n  \\rftfig{E08}{loss}\\rftfig[width=3cm]{E05}{loss}\\rftfig{E08}{loss}\n  \\caption{Two losses}\\label{S09}\n\\end{figure}'),
    })
    const w = await out('S09')
    expect(w.files).toEqual([{ from: 'figures/E08_loss.pdf', to: 'figures/loss.pdf' }, { from: 'figures/E05_loss.pdf', to: 'figures/loss-2.pdf' }])
    expect(w.text).toContain('\\includegraphics{figures/loss.pdf}\\includegraphics[width=3cm]{figures/loss-2.pdf}\\includegraphics{figures/loss.pdf}')
    expect(w.files.map(f => f.to).join(' ')).not.toMatch(/E0\d/)
  })

  test('a citation by a note\'s id becomes the key of its entry, with the entry to add', async () => {
    const { out, fs, l } = await setup()
    const w = await out('S01')
    expect(w.text).toContain('CutMix~\\cite{yun2019cutmix} forms')
    expect(w.bib).toEqual([{ key: 'yun2019cutmix', from: 'R07', entry: fs.read(`${DOC}/refs.bib`).split('\n\n')[0]! }])
    expect(bibEntries(l.texts.R07!).map(e => e.key)).toEqual(['yun2019cutmix'])
  })

  test('several keys, a key of the tree\'s, the user\'s own key, and a reference with no BibTeX', async () => {
    const r08 = FILES['vault/references/R07 CutMix.md']!.replace(/R07/g, 'R08').replace(/Yun et al[\s\S]*?```bibtex[\s\S]*?```/, 'DeVries and Taylor 2017, https://example.org/cutout.')
    const { out } = await setup({
      'vault/references/R08 Cutout & friends.md': r08,
      'vault/snippets/S09.tex': snippet('S09', 'related-work', 'Mixing', 'R07', 'Mixing~\\citep[see][]{R07, mine2020,yun2019cutmix} and \\citet*{R08}.'),
    })
    const w = await out('S09')
    expect(w.text).toBe('Mixing~\\citep[see][]{yun2019cutmix,mine2020,yun2019cutmix} and \\citet*{cutoutfriends}.')
    expect(w.bib.map(b => [b.key, b.from])).toEqual([['yun2019cutmix', 'R07'], ['cutoutfriends', 'R08']])
    expect(w.bib[1]!.entry).toBe('@misc{cutoutfriends,\n  title = {{Cutout \\& friends}},\n  howpublished = {\\url{https://example.org/cutout}}\n}')
    expect(w.marker).toBe('Related work: Mixing')
  })

  test('a literature note is cited by a paper\'s key, never by its id', async () => {
    const lit = FILES['vault/references/R07 CutMix.md']!.replace(/R07/g, 'R08').replace('tags: [cutmix, reference, verified]', 'tags: [cutmix, reference, literature, verified]').replace('yun2019cutmix', 'devries2017cutout')
    const { out } = await setup({
      'vault/references/R08 Augmentations.md': lit,
      'vault/snippets/S09.tex': snippet('S09', 'related-work', 'Cutout', 'R08', 'Cutout~\\cite{devries2017cutout}.'),
      'vault/snippets/S10.tex': snippet('S10', 'related-work', 'Cutout again', 'R08', 'Cutout~\\cite{R08}.'),
    })
    expect((await out('S09')).bib.map(b => [b.key, b.from])).toEqual([['devries2017cutout', 'R08']])
    await expect(out('S10')).rejects.toThrow('R08 is a literature note, which holds many papers: cite one by its own key (devries2017cutout)')
  })

  test('labels come from the kind and the title; a second copy gets a label of its own; a reference to another snippet follows', async () => {
    expect([labelOf('definition', 'CutMix'), labelOf('lemma', 'Mixing bound'), labelOf('result', 'Über 100% of_the {gap}!'), slug('  ')]).toEqual(['def:cutmix', 'lem:mixing-bound', 'res:uber-100-of-the-gap', 'untitled'])
    expect(markerWords('related-work', 'Mixing 100% ')).toBe('Related work: Mixing 100')
    const { out } = await setup({
      'vault/snippets/S09.tex': snippet('S09', 'result', 'By definition', 'E05', 'By Definition~\\ref{S01} and Figure~\\cref{S03,eq:mix}, with\n\\begin{equation}\\label{eq:mix} a = b \\end{equation}\nsee~\\eqref{eq:mix} and \\ref{S99}.'),
    })
    expect((await out('S01')).labels).toEqual(['def:cutmix'])
    const second = await out('S01', { labels: ['def:cutmix', 'eq:other'] })
    expect([second.labels, second.text.split('\n')[0]]).toEqual([['def:cutmix-2'], '\\begin{definition}[CutMix]\\label{def:cutmix-2}'])
    const w = await out('S09', { labels: ['eq:mix'] })
    expect(w.text).toBe('By Definition~\\ref{def:cutmix} and Figure~\\cref{fig:training-loss,eq:mix-2}, with\n\\begin{equation}\\label{eq:mix-2} a = b \\end{equation}\nsee~\\eqref{eq:mix-2} and \\ref{S99}.')
    expect(w.labels).toEqual(['eq:mix-2'])
  })

  test('a snippet\'s comments stay in the vault', async () => {
    expect(withoutComments('% all of it\nText % why\n  % indented\n50\\% of it%\nmore')).toBe('Text %\n50\\% of it%\nmore')
    const { out } = await setup({
      'vault/snippets/S09.tex': snippet('S09', 'result', 'Seeds', 'E05', '%\n% Proposed by Claude on 2026-11-24, for you to write.\n% What to say:\n%   - what E05 found with \\rftnum{E05}{nothing}\n\n\\paragraph{Seeds}\nOver \\rftnum{E05}{seeds} seeds. % as E05 says'),
    })
    const w = await out('S09')
    expect(w.text).toBe('\\paragraph{Seeds}\nOver 3 seeds. %')
    expect(w.values).toEqual([{ kind: 'number', from: 'E05', key: 'seeds', written: '3', at: 23 }])
  })

  test('a macro that names nothing saved refuses the snippet with what is there instead; ?? is never written', async () => {
    const extra = {
      'vault/snippets/S09.tex': snippet('S09', 'result', 'Missing', 'E05', 'It reaches \\rftnum{E05}{acc.5k} and \\rftfig{E05}{loss}.'),
      'vault/snippets/S10.tex': snippet('S10', 'figure', 'No PDF', 'E08', '\\rftfig{E08}{loss}'),
      'vault/snippets/S11.tex': snippet('S11', 'result', 'Half a macro', 'E05', 'It reaches \\rftnum{E05} points.'),
    }
    await expect((await setup(extra)).out('S09')).rejects.toThrow('S09 cannot be placed: its macros name what no notebook saved:\n\\rftnum{E05}{acc.5k}: no such number; E05\'s are acc.1k, acc.full, seeds\n\\rftfig{E05}{loss}: E05 saved no figure of that name; its are none')
    const { out, fs } = await setup(extra)
    await expect(out('S11')).rejects.toThrow('S11 cannot be placed: written out, it would still carry a trace of the tree')
    // a figure saved as SVG only (not a matplotlib one) has nothing LaTeX can include
    fs.remove('vault/figures/E08_loss.pdf')
    await expect(out('S10')).rejects.toThrow('E08\'s figure loss has no PDF (vault/figures/E08_loss.pdf)')
  })

  test('what is written out carries no trace; a snippet whose words or title name a note is refused', async () => {
    const { out, ids, snippets } = await setup({
      'vault/snippets/S09.tex': snippet('S09', 'result', 'Seeds', 'E05', 'As E05 shows, over \\rftnum{E05}{seeds} seeds.'),
      'vault/snippets/S10.tex': snippet('S10', 'result', 'What E05 found', 'E05', 'Over \\rftnum{E05}{seeds} seeds.'),
    })
    for (const s of snippets.filter(x => Number(x.id.slice(1)) < 9)) {
      const w = await out(s.id)
      const files = [{ rel: 'main.tex', text: `%%% ${w.marker} %%%\n${w.text}\n%%% end %%%\n` }, ...w.files.map(f => ({ rel: f.to, text: null })), { rel: 'refs.bib', text: w.bib.map(b => b.entry).join('\n\n') }]
      expect(scanFiles({ files, ids, treeKeys: new Set() }).traces).toEqual([])
    }
    await expect(out('S09')).rejects.toThrow('S09 cannot be placed: written out, it would still carry a trace of the tree, which a document\'s files must not (E05 in "As E05 shows, over 3 seeds.")')
    await expect(out('S10')).rejects.toThrow('E05 in "Result: What E05 found"')
  })
})
