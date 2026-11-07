// The project map: one-line summaries, concept digests and their fingerprints, the map reports,
// the warnings, and the session start that uses the map in a large tree.

import { describe, expect, mock, test } from 'claude-code/testing'

import { fingerprint, mapGaps, mapReport, mapWarnings, readDigests, resolveConcept, setDigest, setSummaries } from '../hooks/lib/map'
import { addNode, rulesText, setConcept, setStatus } from '../hooks/lib/ops'
import { front, load, readConfig, unquoteJson } from '../hooks/lib/vault'
import { CWD, D01, MemoryFs, demoFiles, world } from './fixture'

const setup = async () => {
  const fs = new MemoryFs(demoFiles())
  const io = fs.io()
  const l = await load(io, (await readConfig(io))!)
  await setConcept(io, l, 'D01', 'Better variants')
  return { fs, io, l }
}

describe('map', () => {
  test('a summary given at creation is kept in the frontmatter, quotes and all, and read back', async () => {
    const { fs, io, l } = await setup()
    const node = await addNode(io, l, { type: 'experiment', title: 'Sweep', parent: 'D01', date: '2026-02-01', summary: '  Sweep of "alpha"\n over 3 seeds ' })
    const text = fs.read(`vault/${node.path}`)
    expect(unquoteJson(front(text).summary)).toBe('Sweep of "alpha" over 3 seeds')
    expect(l.tree.nodes[node.id]!.summary).toBe('Sweep of "alpha" over 3 seeds')
    expect(node.report).not.toContain('no summary')
    const bare = await addNode(io, l, { type: 'direction', title: 'Other', parent: 'D01', date: '2026-02-01' })
    expect(bare.report).toContain('rft_set_summary')
  })

  test('summaries are set many at once, refused when too long, and a status change can update one', async () => {
    const { io, l } = await setup()
    const out = await setSummaries(io, l, { E01: 'First check: it works, 91%', D01: 'Try a better variant', X9: 'nope', E02: 'x'.repeat(300) })
    expect(out).toContain('Summary set on 2 note(s): E01, D01')
    expect(out).toContain('X9: not a note of the tree')
    expect(out).toContain('E02: keep a summary to one line')
    expect(l.tree.nodes.E01!.summary).toBe('First check: it works, 91%')
    const said = await setStatus(io, l, 'E02', 'done', 'Real result.', 'Variant run: +2 points')
    expect(said).toContain('summary updated')
    expect(l.tree.nodes.E02!.summary).toBe('Variant run: +2 points')
    expect(l.tree.nodes.E02!.status).toBe('done')
    expect(await setStatus(io, l, 'E01', 'dropped', 'Why.')).toContain('rft_set_summary')
  })

  test('a digest is written per concept, found by name or start note, and goes out of date when its notes change', async () => {
    const { fs, io, l } = await setup()
    expect(resolveConcept(l.tree, 'better variants')?.id).toBe('D01')
    expect(resolveConcept(l.tree, 'D01')?.id).toBe('D01')
    expect(resolveConcept(l.tree, 'root')?.id).toBe('root')
    await expect(setDigest(io, l, 'Nothing', 'x', '', '2026-03-01')).rejects.toThrow('not a concept')
    await expect(setDigest(io, l, 'D01', ' ', '', '2026-03-01')).rejects.toThrow('state is empty')
    const said = await setDigest(io, l, 'Better variants', 'The variant helps a little.', '## Key results\n- E02: +2', '2026-03-01')
    expect(said).toContain('map/D01 Better variants.md')
    expect(said).toContain('have no summary')
    const file = fs.read('vault/map/D01 Better variants.md')
    expect(file).toContain('type: digest')
    expect(file).toContain(`basis: ${fingerprint(l.tree, 'D01')}`)
    let d = (await readDigests(io, l)).D01!
    expect(d.state).toBe('The variant helps a little.')
    expect(d.body).toBe('## Key results\n- E02: +2')
    expect(await mapWarnings(io, l)).toEqual(['4 note(s) have no one-line summary (summary:): /rft-summarize writes them'])
    // a summary in the concept changes its fingerprint: the digest is out of date
    await setSummaries(io, l, { E02: 'Variant run' })
    expect((await mapWarnings(io, l)).some(w => w.includes('out of date'))).toBe(true)
    // a note outside the concept does not
    await setDigest(io, l, 'D01', 'Again.', '', '2026-03-02')
    await setSummaries(io, l, { E01: 'First check' })
    expect((await mapWarnings(io, l)).some(w => w.includes('out of date'))).toBe(false)
    // a renamed concept keeps one digest file
    await setConcept(io, l, 'D01', 'Variants')
    await setDigest(io, l, 'Variants', 'Renamed.', '', '2026-03-03')
    expect(await io.exists('vault/map/D01 Better variants.md')).toBe(false)
    d = (await readDigests(io, l)).D01!
    expect(d.path).toBe('map/D01 Variants.md')
  })

  test('the map: the project with each concept\'s state, a concept with its notes and their summaries', async () => {
    const { io, l } = await setup()
    await setSummaries(io, l, { D01: 'Try a better variant', E02: 'Variant run, 3 seeds' })
    await setStatus(io, l, 'E02', 'running')
    await setDigest(io, l, 'D01', 'The variant is being run.', '## Open questions\n- does it hold at 10k (E02)', '2026-03-01')
    const project = await mapReport(io, l)
    expect(project).toContain('  - Better variants (D01) · 2 note(s) …1 ?1: The variant is being run.')
    expect(project).toContain('In progress (1):')
    expect(project).toContain('E02 Variant run ← D01 — Variant run, 3 seeds')
    const concept = await mapReport(io, l, 'Better variants')
    expect(concept).toContain('State: The variant is being run.')
    expect(concept).toContain('## Open questions')
    expect(concept).toContain('D01 A better variant ← E01 — Try a better variant')
    expect(concept).not.toContain('E01 First check')
    await expect(mapReport(io, l, 'Nope')).rejects.toThrow('not a concept')
  })

  test('validation on a new vault warns per note; gaps count what /rft-summarize has to write', async () => {
    const { io, l } = await setup()
    l.config.requireSummaries = true
    const w = await mapWarnings(io, l)
    expect(w).toHaveLength(4)
    expect(w[0]).toContain('no one-line summary')
    for (let i = 0; i < 2; i++) await addNode(io, l, { type: 'experiment', title: `Run ${i}`, parent: 'D01', date: '2026-02-01', summary: 'a run' })
    const gaps = await mapGaps(io, l)
    expect(gaps.notes).toBe(4)
    expect(gaps.digests).toEqual(['Better variants'])
    expect((await mapGaps(io, l, resolveConcept(l.tree, 'D01')!)).notes).toBe(2)
  })

  test('the session rules carry the map when given, and the list of notes otherwise', async () => {
    const { io, l } = await setup()
    const small = rulesText(l.tree, l.config)
    expect(small).toContain('rft_map gives the project map')
    expect(small).toContain('by concept (← parent')
    const big = rulesText(l.tree, l.config, 'vault', {}, (await mapReport(io, l)).split('\n').slice(1, -2).join('\n'))
    expect(big).toContain('The project map at the start of this session')
    expect(big).not.toContain('by concept (← parent')
  })

  test('a large tree starts the session from the project map; /rft-summarize asks for what is missing', async ($, on) => {
    const clock = mock.clock(on)
    const files = demoFiles()
    files[`vault/directions/${D01}.md`] = files[`vault/directions/${D01}.md`]!.replace(/^(tags: .*)$/m, '$1\nconcept: "Variants"')
    const w = world(on, files)
    const io = w.fs.io()
    const l = await load(io, (await readConfig(io))!)
    for (let i = 0; i < 61; i++) await addNode(io, l, { type: 'experiment', title: `Run ${i}`, parent: 'D01', date: '2026-02-01' })
    on('prompt.compose', () => ({ sections: [] }))
    const prompts: string[] = []
    on('prompt.submit', (_$, e) => { prompts.push(String(e.text)); return { text: e.text } as never })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const res = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    const rules = res.sections.find(x => x.id === 'rft:rules')!.text
    expect(rules).toContain('The project map at the start of this session')
    expect(rules).toMatch(/  - Variants \(D01\) · 63 note\(s\) .*\[no digest\]/)
    expect(rules).not.toContain('E40 Run')
    const run = (args: string) => $.command.run({ command: 'rft-summarize', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
    expect((await run('Nope')).text).toContain('is not a concept')
    const said = await run('')
    expect(said.text).toContain('65 note summaries and 1 digest(s) (Variants)')
    await clock.advance(5000)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('rft_set_summary')
    expect(prompts[0]).toContain('rft_set_digest')
  })
})
