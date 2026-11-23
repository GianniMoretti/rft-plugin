// The scan for traces (hooks/lib/scan.ts, docs/adr/0003-a-document-holds-no-trace.md): a document's
// files hold no trace of the tree, and the scan finds whatever still names it. Held to the fixture
// (tests/fixtures/local-overleaf) and to the cases the server's side reads the same way
// (tests/test_clean_source.py); then Claude's own edits of a document, in a session.

import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { citeIndex } from '../hooks/lib/manuscript'
import { scanDocument, scanFiles, traceWords } from '../hooks/lib/scan'
import type { Trace } from '../hooks/lib/scan'
import { listSnippets } from '../hooks/lib/snippets'
import { readTracking } from '../hooks/lib/tracking'
import { load, readConfig } from '../hooks/lib/vault'
import { CWD, MemoryFs, world } from './fixture'
import { FILES, TRACES } from './fixtures/local-overleaf'

const DOC = 'vault/documents/paper'

/** The fixture's project, loaded; `extra`: files added or replaced. */
async function setup(extra: Record<string, string> = {}) {
  const fs = new MemoryFs({ ...FILES, ...extra })
  const io = fs.io()
  const l = await load(io, (await readConfig(io))!)
  const ids = new Set([...Object.keys(l.tree.nodes), ...(await listSnippets(io, 'vault')).map(s => s.id)])
  return { fs, io, l, ids }
}

describe('the scan for traces', () => {
  const sorted = (ts: Pick<Trace, 'file' | 'line' | 'kind' | 'match'>[]) =>
    ts.map(t => ({ file: t.file, line: t.line, kind: t.kind, match: t.match })).sort((a, b) => JSON.stringify([a.file, a.line ?? 0, a.kind, a.match]) < JSON.stringify([b.file, b.line ?? 0, b.kind, b.match]) ? -1 : 1)

  for (const c of TRACES.cases as { why: string; files: Record<string, string | null>; allowed?: { file: string; match: string; text: string }[]; traces: Trace[]; allowedCount?: number }[]) {
    test(c.why, () => {
      const got = scanFiles({ files: Object.entries(c.files).map(([rel, text]) => ({ rel, text })), ids: new Set(TRACES.ids), treeKeys: new Set(TRACES.treeKeys), allowed: c.allowed })
      expect(sorted(got.traces)).toEqual(sorted(c.traces))
      expect(got.allowed).toBe(c.allowedCount ?? 0)
    })
  }

  test('the fixture\'s document scans clean, from its folder', async () => {
    const { io, l, ids } = await setup()
    const keys = new Set(Object.keys(citeIndex(l)))
    expect([...ids].sort()).toEqual(TRACES.ids.slice().sort())
    expect(await scanDocument(io, 'vault', 'paper', ids, keys)).toEqual({ traces: [], allowed: 0 })
  })

  test('a copy of it with each kind of trace added reports each one with its file and line', async () => {
    const main = FILES[`${DOC}/main.tex`]!
    const { io, l, ids } = await setup({
      [`${DOC}/main.tex`]: main.replace('\\usepackage{hyperref}', '\\usepackage{hyperref}\n\\usepackage{rft}').replace('%%% Result: CutMix at 1k images %%%', '% rft-begin S02 3f2a1c9d'),
      [`${DOC}/sections/method.tex`]: FILES[`${DOC}/sections/method.tex`]! + 'As E05 shows.\n',
      [`${DOC}/refs.bib`]: FILES[`${DOC}/refs.bib`]!.replace('zhang2018mixup', 'R07'),
      [`${DOC}/figures/E08_loss.pdf`]: '%PDF\n',
      [`${DOC}/.blocks.json`]: '{\n  "S01": "text"\n}\n',
    })
    const got = await scanDocument(io, 'vault', 'paper', ids, new Set(Object.keys(citeIndex(l))))
    expect(got.traces.map(traceWords)).toEqual([
      '.blocks.json:2: the id S01',
      'figures/E08_loss.pdf (its name): the id E08',
      'main.tex:8: the plugin\'s rft',
      'main.tex:44: a marker of the first design (rft-begin)',
      'main.tex:44: the id S02',
      'refs.bib:8: the id R07',
      'refs.bib:8: the entry R07, which the document does not cite',
      'sections/method.tex:27: the id E05',
    ])
    // the user allows one of them: remembered in the tracking file, not flagged again
    const t = await readTracking(io, 'vault', 'paper')
    const first = got.traces.find(x => x.file === 'sections/method.tex')!
    await io.write('vault/documents/.rft/paper/tracking.json', JSON.stringify({ ...t, allowed: [{ file: first.file, match: first.match, text: first.text }] }))
    const again = await scanDocument(io, 'vault', 'paper', ids, new Set(Object.keys(citeIndex(l))))
    expect([again.traces.length, again.allowed]).toEqual([7, 1])
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
  const METHOD = `${CWD}/${DOC}/sections/method.tex`

  test('Claude\'s edit of an unlocked document is refused when it would write a trace, with the reason; other edits go on', async ($, on) => {
    const { ran } = await session($, on, { ...FILES, 'vault/documents/documents.json': JSON.stringify({ locked: true, unlocked: ['paper'] }) })
    for (const [call, why] of [
      [{ tool: 'Edit', file_path: METHOD, old_string: 'over 5 seeds.', new_string: 'over \\rftnum{E05}{seeds} seeds.' }, 'this would write one (sections/method.tex:12: the plugin\'s \\rftnum; sections/method.tex:12: the id E05)'],
      [{ tool: 'Edit', file_path: METHOD, old_string: '\\section{Method}', new_string: '\\section{Method}\n% see E08' }, 'sections/method.tex:2: the id E08'],
      [{ tool: 'Write', file_path: `${CWD}/${DOC}/sections/S04_setup.tex`, content: 'Plain text.\n' }, 'sections/S04_setup.tex (its name): the id S04'],
      [{ tool: 'Write', file_path: `${CWD}/vault/documents/.rft/paper/tracking.json`, content: '{}' }, 'The plugin writes'],
    ] as const) {
      const res = await $.tool.call(call as never)
      expect({ call, deny: (res as { deny?: string }).deny }).toEqual({ call, deny: expect.stringContaining(why) })
    }
    expect(ran).toEqual([])
    for (const call of [
      { tool: 'Edit', file_path: METHOD, old_string: 'over 5 seeds.', new_string: 'over 5 seeds (Table S1, model E055).' },
      { tool: 'Write', file_path: `${CWD}/${DOC}/sections/related.tex`, content: '\\section{Related work}\nMixup~\\cite{zhang2018mixup}.\n' },
    ]) expect(((await $.tool.call(call as never)) as { deny?: string }).deny).toBeUndefined()
  })

  test('a trace the file already holds does not block an edit elsewhere in it, nor taking it out', async ($, on) => {
    const old = FILES[`${DOC}/sections/method.tex`]! + 'As E05 shows.\n'
    await session($, on, { ...FILES, [`${DOC}/sections/method.tex`]: old, 'vault/documents/documents.json': JSON.stringify({ locked: false, unlocked: [] }) })
    for (const call of [
      { tool: 'Edit', file_path: METHOD, old_string: 'over 5 seeds.', new_string: 'over five seeds.' },
      { tool: 'Edit', file_path: METHOD, old_string: 'As E05 shows.', new_string: 'As the first run shows.' },
    ]) expect(((await $.tool.call(call as never)) as { deny?: string }).deny).toBeUndefined()
    const res = await $.tool.call({ tool: 'Edit', file_path: METHOD, old_string: 'As E05 shows.', new_string: 'As E05 and E05 show.' } as never)
    expect((res as { deny?: string }).deny).toContain('the id E05')
  })
})
