// Recall: search that answers from the summaries and digests, the "have we tried this?" check on
// a new note, graph questions, and the hint when Claude greps the vault instead.

import { describe, expect, mock, test } from 'claude-code/testing'

import { graphReport, pathTo } from '../hooks/lib/graph'
import { setDigest, setSummaries } from '../hooks/lib/map'
import { addNode, moveNode, setConcept, setRefs } from '../hooks/lib/ops'
import { searchesVault } from '../hooks/lib/recall'
import { search, searchReport, similarNotes } from '../hooks/lib/search'
import { load, readConfig } from '../hooks/lib/vault'
import { CWD, MemoryFs, demoFiles, world } from './fixture'

const setup = async () => {
  const fs = new MemoryFs(demoFiles())
  const io = fs.io()
  const l = await load(io, (await readConfig(io))!)
  await addNode(io, l, { type: 'experiment', title: 'Label smoothing sweep', parent: 'D01', date: '2026-02-03', status: 'done',
    sections: { What: 'Smoothing 0.05 to 0.2 on the small split, three seeds each, cosine schedule.', Result: 'Calibration error drops by half; accuracy unchanged.' },
    summary: 'Label smoothing 0.05-0.2: calibration error halves, accuracy flat' })
  await addNode(io, l, { type: 'reference', title: 'Szegedy 2016 Inception v3', parent: 'D01', date: '2026-02-01', status: 'done' })
  await setConcept(io, l, 'D01', 'Better variants')
  return { io, l }
}

describe('recall', () => {
  test('a summary is searched like a title, and the answer carries it instead of the matched line', async () => {
    const { io, l } = await setup()
    // "halves" is only in the summary
    expect(search(l, 'calibration halves')[0]!.id).toBe('E03')
    const out = searchReport(l, 'label smoothing')
    expect(out).toContain('- ✓ E03 Label smoothing sweep (done, ← D01, Better variants) — Label smoothing 0.05-0.2: calibration error halves, accuracy flat')
    // the matched line says nothing the summary does not: left out
    expect(out).not.toContain('What: Smoothing')
    // a line that adds to the summary is kept
    expect(searchReport(l, 'cosine schedule seeds')).toContain('What: Smoothing 0.05 to 0.2 on the small split')
    expect(out).toContain('rft_graph <id>')
    // a concept whose digest matches comes first, with its state
    await setDigest(io, l, 'D01', 'Smoothing helps calibration only.', '## Key results\n- E03: calibration halves', '2026-03-01')
    const withConcept = searchReport(l, 'calibration', {}, 10, { D01: { concept: 'D01', basis: '', updated: '', state: 'Smoothing helps calibration only.', body: '', path: '' } })
    expect(withConcept.split('\n').slice(0, 2)).toEqual(['Concepts:', '- Better variants (D01): Smoothing helps calibration only.'])
    expect(withConcept).toContain('rft_map <concept>')
  })

  test('a new experiment is told the close notes already in the tree; an unrelated one is not', async () => {
    const { io, l } = await setup()
    const again = await addNode(io, l, { type: 'experiment', title: 'Smoothing sweep on calibration', parent: 'E02', date: '2026-03-02' })
    const said = similarNotes(l, again.id)
    expect(said).toContain('have we tried this?')
    expect(said).toContain('E03 Label smoothing sweep')
    expect(said).not.toContain('R01')
    const other = await addNode(io, l, { type: 'experiment', title: 'Quantised inference latency', parent: 'E02', date: '2026-03-02' })
    expect(similarNotes(l, other.id)).toBe('')
  })

  test('graph: neighbours, what cites a reference, where it was, and the path from the top', async () => {
    const { io, l } = await setup()
    await setRefs(io, l, 'E03', ['R01'])
    await setSummaries(io, l, { D01: 'Try a better variant' })
    const around = graphReport(l, 'E03')
    expect(around).toContain('E03 Label smoothing sweep (experiment, done)')
    expect(around).toContain('concept Better variants')
    expect(around).toContain('Parent:\n  ? D01 A better variant (direction, idea) — Try a better variant')
    expect(around).toContain('Builds on (1):\n  ✓ R01 Szegedy 2016 Inception v3')
    expect(around).toMatch(/Beside it under D01 \(\d\):/)
    expect(graphReport(l, 'R01')).toContain('Cited by (1):\n  ✓ E03 Label smoothing sweep')
    expect(pathTo(l.tree, 'E03')).toEqual(['D00', 'E01', 'D01', 'E03'])
    await moveNode(io, l, 'E03', 'E02', '2026-03-03')
    const path = graphReport(l, 'E03', 'path')
    expect(path).toContain('How E03 was reached (4 step(s) from the top):')
    expect(path).toContain('Moved here; it was under D01.')
    expect(() => graphReport(l, 'X9')).toThrow('not a note')
  })

  test('a search of the vault is told apart from a search of the code and from reading one note', () => {
    const v = '/work/demo/vault', cwd = '/work/demo'
    expect(searchesVault('Grep', { pattern: 'mixup', path: 'vault' }, v, cwd)).toBe(true)
    expect(searchesVault('Grep', { pattern: 'mixup', path: '/work/demo/vault/experiments' }, v, cwd)).toBe(true)
    expect(searchesVault('Grep', { pattern: 'mixup', path: 'src' }, v, cwd)).toBe(false)
    expect(searchesVault('Grep', { pattern: 'mixup' }, v, cwd)).toBe(false)
    expect(searchesVault('Grep', { pattern: 'mixup' }, v, v)).toBe(true)
    expect(searchesVault('Glob', { pattern: 'vault/**/*.md' }, v, cwd)).toBe(true)
    expect(searchesVault('Glob', { pattern: '**/*.py' }, v, cwd)).toBe(false)
    expect(searchesVault('Bash', { command: 'grep -ril mixup vault/experiments' }, v, cwd)).toBe(true)
    expect(searchesVault('Bash', { command: 'cd vault && rg mixup' }, v, cwd)).toBe(true)
    expect(searchesVault('Bash', { command: `rg -l "mixup" ${v}` }, v, cwd)).toBe(true)
    expect(searchesVault('Bash', { command: 'grep -r mixup src' }, v, cwd)).toBe(false)
    expect(searchesVault('Bash', { command: 'cat vault/experiments/E01.md' }, v, cwd)).toBe(false)
    expect(searchesVault('Bash', { command: 'grep -r mixup vaults' }, v, cwd)).toBe(false)
    expect(searchesVault('Read', { file_path: '/work/demo/vault/experiments/E01 First check.md' }, v, cwd)).toBe(false)
  })

  test('a grep of the vault gets the hint until rft_search is used; a grep elsewhere never does', async ($, on) => {
    mock.clock(on)
    world(on, demoFiles())
    on('tool.call', { tool: 'Grep' }, () => ({ result: 'vault/experiments/E01 First check.md' }) as never)
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const grep = (path: string) => $.tool.call({ tool: 'Grep', pattern: 'check', path } as never)
    expect((await grep('vault')).context?.join('\n')).toContain('rft_search answers from them directly')
    expect((await grep('src')).context ?? []).toEqual([])
    await $.tool.call({ tool: 'mcp__rft__rft_search', query: 'check' } as never)
    expect((await grep('vault')).context ?? []).toEqual([])
  })

  test('rft_graph and the similar notes through tool calls', async ($, on) => {
    mock.clock(on)
    world(on, demoFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const g = await $.tool.call({ tool: 'mcp__rft__rft_graph', id: 'E02', mode: 'path' } as never)
    expect(g.text).toContain('How E02 was reached')
    const added = await $.tool.call({ tool: 'mcp__rft__rft_add_node', type: 'experiment', title: 'Variant run again', parent: 'E01' } as never)
    expect(added.text).toContain('have we tried this?')
    expect(added.text).toContain('E02 Variant run')
  })
})
