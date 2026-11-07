// State of knowledge: superseded results, what is still open by concept, concepts too large for
// one digest.

import { describe, expect, mock, test } from 'claude-code/testing'

import { graphReport } from '../hooks/lib/graph'
import { current, nextReport, openQuestions, supersede } from '../hooks/lib/knowledge'
import { DIGEST_MAX, fingerprint, mapReport, mapWarnings, setDigest } from '../hooks/lib/map'
import { addNode, setConcept, setStatus } from '../hooks/lib/ops'
import { searchReport } from '../hooks/lib/search'
import { front, load, readConfig, validate } from '../hooks/lib/vault'
import { CWD, MemoryFs, demoFiles, world } from './fixture'

const setup = async () => {
  const fs = new MemoryFs(demoFiles())
  const io = fs.io()
  const l = await load(io, (await readConfig(io))!)
  await setConcept(io, l, 'D01', 'Better variants')
  return { fs, io, l }
}

describe('knowledge', () => {
  test('a superseded result is marked in the note, the map, search and graph, and can be cleared', async () => {
    const { fs, io, l } = await setup()
    const rerun = await addNode(io, l, { type: 'experiment', title: 'Variant rerun with fixed seeds', parent: 'D01', date: '2026-02-05', status: 'done', summary: 'Variant gain is +0.4, not +2: the first run leaked' })
    const before = fingerprint(l.tree, 'D01')
    const said = await supersede(io, l, 'E02', rerun.id, 'the first run leaked the test split', '2026-02-06')
    expect(said).toContain('marked as superseded by E03 Variant rerun with fixed seeds')
    expect(said).toContain('rft_set_digest')
    const text = fs.read('vault/experiments/E02 Variant run.md')
    expect(front(text).superseded_by).toBe('"[[E03 Variant rerun with fixed seeds]]"')
    expect(text).toContain('- 2026-02-06: superseded by [[E03 Variant rerun with fixed seeds]] (the first run leaked the test split)')
    expect(l.tree.nodes.E02!.supersededBy).toBe('E03')
    expect(current(l, 'E02')).toBe('E03')
    // the digest goes out of date
    expect(fingerprint(l.tree, 'D01')).not.toBe(before)
    expect(await mapReport(io, l, 'D01')).toContain('E02 Variant run [superseded by E03]')
    const found = searchReport(l, 'variant')
    expect(found).toContain('E02 Variant run (running, ← D01, Better variants) [superseded by E03]')
    expect(found.indexOf('E03 Variant rerun')).toBeLessThan(found.indexOf('E02 Variant run'))
    expect(graphReport(l, 'E02')).toContain('Superseded by (its result holds instead):\n  ✓ E03 Variant rerun')
    expect(graphReport(l, 'E03')).toContain('Supersedes (1):\n  … E02 Variant run')
    expect((await validate(io, l, {})).warnings.join('\n')).not.toContain('superseded_by')
    // no loop, no self
    await expect(supersede(io, l, 'E03', 'E02', '', '2026-02-07')).rejects.toThrow('already superseded')
    await expect(supersede(io, l, 'E03', 'E03', '', '2026-02-07')).rejects.toThrow('cannot supersede itself')
    await expect(supersede(io, l, 'X9', 'E03', '', '2026-02-07')).rejects.toThrow('not a note')
    // cleared
    expect(await supersede(io, l, 'E02', null, 'it was fine after all', '2026-02-08')).toContain('no longer marked')
    expect(l.tree.nodes.E02!.supersededBy).toBeUndefined()
    expect(fs.read('vault/experiments/E02 Variant run.md')).toContain('- 2026-02-08: no longer superseded by [[E03 Variant rerun with fixed seeds]] (it was fine after all)')
  })

  test('a superseded_by that names no note is a warning', async () => {
    const files = demoFiles()
    files['vault/experiments/E02 Variant run.md'] = files['vault/experiments/E02 Variant run.md']!.replace(/^(status: .*)$/m, '$1\nsuperseded_by: "[[E99 Nothing]]"')
    const fs = new MemoryFs(files)
    const io = fs.io()
    const l = await load(io, (await readConfig(io))!)
    expect((await validate(io, l, {})).warnings.join('\n')).toContain('E02: superseded_by names no note')
  })

  test('what is next: running, planned, unexplored directions and open questions, by concept', async () => {
    const { io, l } = await setup()
    await addNode(io, l, { type: 'experiment', title: 'Seed sweep', parent: 'D01', date: '2026-01-10', status: 'planned', summary: 'Five seeds of the variant' })
    await addNode(io, l, { type: 'direction', title: 'A wider variant', parent: 'E02', date: '2026-01-20' })
    const explored = await addNode(io, l, { type: 'direction', title: 'A deeper variant', parent: 'E02', date: '2026-01-21' })
    await addNode(io, l, { type: 'experiment', title: 'Deeper run', parent: explored.id, date: '2026-01-22', status: 'done' })
    await setDigest(io, l, 'D01', 'The variant helps.', '## Key results\n- E02: +2\n\n## Open questions\n- does it hold at 10k (E02)\n- why does it help', '2026-03-01')
    const out = await nextReport(io, l, '2026-02-09')
    expect(out).toContain('## Better variants (D01)')
    expect(out).toContain('Running (1):\n  … E02 Variant run')
    expect(out).toContain('Planned, never run (1, oldest first):\n  → E03 Seed sweep (30d) — Five seeds of the variant')
    // D01 has E02 under it, D03 has a run: only D02 is unexplored
    expect(out).toContain('Directions not explored yet (1, oldest first):\n  ? D02 A wider variant (20d)')
    expect(out).not.toContain('D03 A deeper variant')
    expect(out).toContain('Open questions (from the digest of 2026-03-01):\n  - does it hold at 10k (E02)\n  - why does it help')
    expect(openQuestions(undefined)).toEqual([])
    await expect(nextReport(io, l, '2026-02-09', 'Nope')).rejects.toThrow('not a concept')
    // a superseded plan is not open
    await supersede(io, l, 'E03', 'E02', '', '2026-02-09')
    expect(await nextReport(io, l, '2026-02-09', 'D01')).not.toContain('E03 Seed sweep')
  })

  test('a concept with more notes than one digest can stand for is flagged for a split', async () => {
    const { io, l } = await setup()
    for (let i = 0; i <= DIGEST_MAX; i++) await addNode(io, l, { type: 'experiment', title: `Run ${i}`, parent: 'D01', date: '2026-02-01', summary: 'a run' })
    const w = await mapWarnings(io, l)
    expect(w.some(x => x.includes('concept "Better variants" has 43 notes of its own') && x.includes('/rft-concepts suggest'))).toBe(true)
  })

  test('/rft-next and the tools through the session', async ($, on) => {
    mock.clock(on)
    world(on, demoFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const run = await $.command.run({ command: 'rft-next', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
    expect(run.text).toContain('Running (1):')
    const s = await $.tool.call({ tool: 'mcp__rft__rft_supersede', id: 'E01', by: 'E02', why: 'redone' } as never)
    expect(s.text).toContain('superseded by E02 Variant run')
    const n = await $.tool.call({ tool: 'mcp__rft__rft_next' } as never)
    expect(n.text).toContain('open item(s)')
    expect((await $.tool.call({ tool: 'mcp__rft__rft_supersede', id: 'E01', by: 'E01' } as never)).isError).toBe(true)
  })
})
