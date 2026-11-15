// Concept artifacts: one HTML page per concept in vault/artifacts/, summarising the results of its
// own experiments, written by Claude with rft_set_artifact (a whole page, or old → new edits) and
// stamped with what each experiment's result was when it was written, so the plugin can say which
// results changed since. The tools, the rules, the guard on hand edits, /rft-artifact, the map,
// rft_next and rft_validate, and the standalone page.

import { describe, expect, mock, test } from 'claude-code/testing'

import { ARTIFACTS_DIR, MAX_ARTIFACT_BYTES, artifactReport, artifactState, artifactWarnings, experimentKey, readArtifacts, resultOf, setArtifact } from '../hooks/lib/artifacts'
import { nextReport, supersede } from '../hooks/lib/knowledge'
import { mapReport } from '../hooks/lib/map'
import { addNode, moveNode, setConcept, setStatus } from '../hooks/lib/ops'
import type { RftNode } from '../hooks/lib/vault'
import { load, readConfig } from '../hooks/lib/vault'
import { CWD, E02, MemoryFs, WEB_FILES, demoFiles, world } from './fixture'

const FILE = 'vault/artifacts/D01 Better variants.html'
const PAGE = '<h1>Better variants</h1>\n<table><tr><td><a href="#E02">E02</a></td><td>+2 points</td></tr></table>\n'

/** The demo vault (E01 done, E02 running, each with a Result), D01 starting "Better variants" (D01, E02). */
const setup = async (files = demoFiles()) => {
  const fs = new MemoryFs(files)
  const io = fs.io()
  const l = await load(io, (await readConfig(io))!)
  await setConcept(io, l, 'D01', 'Better variants')
  return { fs, io, l }
}

/** Reloads the vault after a write by hand, as the tools do after theirs. */
const reload = async (io: ReturnType<MemoryFs['io']>, l: Awaited<ReturnType<typeof load>>) => Object.assign(l, await load(io, l.config))

const run = ($: any, command: string, args: string) =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)

describe('artifacts: results and their keys', () => {
  test('an experiment has a result once its Result section says something, or once it is done', async () => {
    const { io, l } = await setup()
    expect(l.tree.nodes.E02!.hasResult).toBe(true)
    expect(l.tree.nodes.D01!.hasResult).toBeUndefined()
    const sweep = await addNode(io, l, { type: 'experiment', title: 'Sweep', parent: 'D01', date: '2026-02-01', status: 'planned' })
    expect(resultOf(l.texts[sweep.id]!)).toBe('')
    expect(l.tree.nodes[sweep.id]!.hasResult).toBeUndefined()
    await setStatus(io, l, sweep.id, 'done')
    expect(l.tree.nodes[sweep.id]!.hasResult).toBe(true)
  })

  test("an experiment's key is FNV-1a over its id, status, title, summary, superseding note and Result, as the server computes it", () => {
    const text = '---\nid: E05\n---\n\n# E05 · Mixup and CutMix at 1k images\n\n## What\nMixup and CutMix.\n\n## Result\n\nCutMix closes the gap at 1k (0.3 ± 0.5 points); Mixup does not.\n\n## Directions found\n'
    const n = { id: 'E05', status: 'done', title: 'Mixup and CutMix at 1k images', summary: 'CutMix closes the gap at 1k, Mixup does not', supersededBy: 'E06' } as RftNode
    // the same vector is in tests/test_server.py
    expect(resultOf(text)).toBe('CutMix closes the gap at 1k (0.3 ± 0.5 points); Mixup does not.')
    expect(experimentKey(n, text)).toBe('33efe36b')
    // what the page is written from changes the key; the rest of the note does not
    expect(experimentKey({ ...n, status: 'running' }, text)).not.toBe('33efe36b')
    expect(experimentKey(n, text.replace('0.3 ± 0.5', '0.4 ± 0.5'))).not.toBe('33efe36b')
    expect(experimentKey({ ...n, supersededBy: undefined }, text)).not.toBe('33efe36b')
    expect(experimentKey(n, text.replace('Mixup and CutMix.', 'Mixup, CutMix and more.'))).toBe('33efe36b')
    // a "## Result" inside a fenced block is not the section
    expect(resultOf('# E09 · X\n\n```\n## Result\nfake\n```\n\n## Result\nreal\n')).toBe('real')
  })
})

describe('artifacts: rft_artifact and rft_set_artifact', () => {
  test('rft_artifact before there is one: where it goes, each result in full, the experiments without one, the sub-concepts the view links', async () => {
    const { io, l } = await setup()
    const sweep = await addNode(io, l, { type: 'experiment', title: 'Sweep', parent: 'D01', date: '2026-02-01', status: 'planned' })
    const sub = await addNode(io, l, { type: 'direction', title: 'Sub idea', parent: 'E02', date: '2026-02-01' })
    await setConcept(io, l, sub.id, 'Sub variant')
    const out = await artifactReport(io, l, 'Better variants')
    expect(out).toContain('No artifact yet: rft_set_artifact writes artifacts/D01 Better variants.html')
    expect(out).toContain('Experiments with a result (1):')
    expect(out).toContain('E02 Variant run')
    expect(out).toContain('Text of E02.')
    expect(out).toContain(`Without a result yet (1): → ${sweep.id} Sweep`)
    // a sub-concept's experiments are on its own artifact, which the view links beside this one
    expect(out).toContain(`Sub-concepts (the view links their artifacts; leave them off this page): Sub variant (${sub.id})`)
    expect(out).toContain('<a href="#E05">E05</a>')
    await expect(artifactReport(io, l, 'Nope')).rejects.toThrow('not a concept')
  })

  test('rft_set_artifact writes the page stamped with the results it was written from', async () => {
    const { fs, io, l } = await setup()
    const said = await setArtifact(io, l, 'Better variants', { html: PAGE }, '2026-03-01')
    expect(said).toContain('Artifact of "Better variants" written to artifacts/D01 Better variants.html (1 experiment with a result, all on the page)')
    const file = fs.read(FILE)
    expect(file.split('\n')[0]).toMatch(/^<!-- rft-artifact \{.*\} -->$/)
    expect(file).toContain(PAGE)
    const a = (await readArtifacts(io, l)).D01!
    expect(a).toMatchObject({ concept: 'D01', name: 'Better variants', updated: '2026-03-01', path: `${ARTIFACTS_DIR}/D01 Better variants.html`, html: PAGE })
    expect(a.basis).toEqual({ E02: experimentKey(l.tree.nodes.E02!, l.texts.E02!) })
    expect(artifactState(l, a)).toEqual({ stale: false, changed: [], added: [], removed: [] })
    // once written, rft_artifact gives the unchanged results one line each
    const out = await artifactReport(io, l, 'D01')
    expect(out).toContain('artifacts/D01 Better variants.html, updated 2026-03-01, up to date')
    expect(out).not.toContain('Text of E02.')
    expect(await artifactReport(io, l, 'D01', { full: true })).toContain('Text of E02.')
  })

  test('it goes out of date when a result of its own changes, appears or leaves, and only then', async () => {
    const { fs, io, l } = await setup()
    await setArtifact(io, l, 'D01', { html: PAGE }, '2026-03-01')
    const state = async () => artifactState(l, (await readArtifacts(io, l)).D01!)
    // another concept's experiment, and a planned experiment with no result yet: still up to date
    await setStatus(io, l, 'E01', 'dropped', 'Bug in the loader.')
    const sweep = await addNode(io, l, { type: 'experiment', title: 'Sweep', parent: 'D01', date: '2026-02-01', status: 'planned' })
    expect(await state()).toEqual({ stale: false, changed: [], added: [], removed: [] })
    // its Result edited by hand, and a new experiment with a result
    const path = `vault/experiments/${E02}.md`
    fs.write(path, fs.read(path).replace('Text of E02.', 'Now +3 points over 5 seeds.'))
    await setStatus(io, l, sweep.id, 'done', '+1 point.')
    await reload(io, l)
    expect(await state()).toEqual({ stale: true, changed: ['E02'], added: [sweep.id], removed: [] })
    expect(await artifactReport(io, l, 'D01')).toContain(`out of date: E02 changed, ${sweep.id} new`)
    // rft_artifact gives the results that changed in full
    expect(await artifactReport(io, l, 'D01')).toContain('Now +3 points over 5 seeds.')
    // written again: up to date; then an experiment moved to another concept leaves it
    await setArtifact(io, l, 'D01', { html: PAGE.replace('+2', '+3') + `<p><a href="#${sweep.id}">${sweep.id}</a></p>` }, '2026-03-02')
    expect((await state()).stale).toBe(false)
    await moveNode(io, l, sweep.id, 'E01', '2026-03-03')
    expect(await state()).toEqual({ stale: true, changed: [], added: [], removed: [sweep.id] })
  })

  test('edits change part of the page, all of them or none, each one found exactly once', async () => {
    const { fs, io, l } = await setup()
    await expect(setArtifact(io, l, 'D01', { edits: [{ old_str: '+2', new_str: '+3' }] }, '2026-03-01')).rejects.toThrow('no artifact yet')
    await setArtifact(io, l, 'D01', { html: PAGE + '<p>+2 again</p>\n' }, '2026-03-01')
    const before = fs.read(FILE)
    await expect(setArtifact(io, l, 'D01', { edits: [{ old_str: '<h1>', new_str: '<h2>' }, { old_str: 'nowhere', new_str: 'x' }] }, '2026-03-02'))
      .rejects.toThrow('edit 2: "nowhere" is not on the page')
    await expect(setArtifact(io, l, 'D01', { edits: [{ old_str: '+2', new_str: '+3' }] }, '2026-03-02'))
      .rejects.toThrow('edit 1: "+2" is on the page 2 times: give more of the text around it')
    expect(fs.read(FILE)).toBe(before)
    const said = await setArtifact(io, l, 'D01', { edits: [{ old_str: '<h1>Better variants</h1>', new_str: '<h1>Better variants: +3</h1>' }, { old_str: '<p>+2 again</p>\n', new_str: '' }] }, '2026-03-02')
    expect(said).toContain('2 edit(s)')
    const a = (await readArtifacts(io, l)).D01!
    expect(a.html).toBe(PAGE.replace('<h1>Better variants</h1>', '<h1>Better variants: +3</h1>'))
    expect(a.updated).toBe('2026-03-02')
  })

  test('the page is refused when it is empty, too large, or given both ways; a header it carries is not doubled', async () => {
    const { fs, io, l } = await setup()
    await expect(setArtifact(io, l, 'Nope', { html: PAGE }, '2026-03-01')).rejects.toThrow('not a concept')
    await expect(setArtifact(io, l, 'D01', { html: '  ' }, '2026-03-01')).rejects.toThrow('the page is empty')
    await expect(setArtifact(io, l, 'D01', {}, '2026-03-01')).rejects.toThrow('give html (the whole page) or edits')
    await expect(setArtifact(io, l, 'D01', { html: PAGE, edits: [{ old_str: 'a', new_str: 'b' }] }, '2026-03-01')).rejects.toThrow('give html (the whole page) or edits')
    await expect(setArtifact(io, l, 'D01', { html: 'x'.repeat(MAX_ARTIFACT_BYTES + 1) }, '2026-03-01')).rejects.toThrow('too large')
    // a page read back from the file, header and all, is written with one header
    await setArtifact(io, l, 'D01', { html: PAGE }, '2026-03-01')
    await setArtifact(io, l, 'D01', { html: fs.read(FILE) }, '2026-03-02')
    expect(fs.read(FILE).match(/rft-artifact/g)).toHaveLength(1)
    expect((await readArtifacts(io, l)).D01!.html).toBe(PAGE)
  })

  test('the page is checked against the tree: results missing from it, links to no note, superseded results, files from elsewhere', async () => {
    const { io, l } = await setup()
    let said = await setArtifact(io, l, 'D01', { html: '<h1>Nothing yet</h1>' }, '2026-03-01')
    expect(said).toContain('Not on the page: E02')
    said = await setArtifact(io, l, 'D01', { html: PAGE + '<a href="#E99">E99</a> <a data-note="D07">D07</a>' }, '2026-03-01')
    expect(said).toContain('Links to no note: E99, D07')
    expect(said).not.toContain('Not on the page')
    // a model or library name that looks like an id is no link, and no warning
    said = await setArtifact(io, l, 'D01', { html: PAGE + '<p>T5 and D3 as in the paper.</p>' }, '2026-03-01')
    expect(said).not.toContain('Links to no note')
    // notes of other concepts may be cited, for comparison: said, not warned
    said = await setArtifact(io, l, 'D01', { html: PAGE + '<p>Baseline <a href="#E01">E01</a>.</p>' }, '2026-03-01')
    expect(said).toContain('Cites notes of other concepts: E01 (demo)')
    // a superseded result: a warning until the page also cites the note that replaced it
    const redo = await addNode(io, l, { type: 'experiment', title: 'Redo', parent: 'D01', date: '2026-02-01', status: 'running' })
    await setStatus(io, l, redo.id, 'done', '+1 point, the bug fixed.')
    await supersede(io, l, 'E02', redo.id, 'bug in the run', '2026-03-01')
    said = await setArtifact(io, l, 'D01', { html: PAGE }, '2026-03-02')
    expect(said).toContain(`E02 is superseded by ${redo.id}: say so on the page (cite ${redo.id}), or drop its number`)
    said = await setArtifact(io, l, 'D01', { html: PAGE + `<p>Superseded by <a href="#${redo.id}">${redo.id}</a>.</p>` }, '2026-03-02')
    expect(said).not.toContain('is superseded by')
    // the view loads nothing from elsewhere: a script, stylesheet or image from the network is said to fail there
    said = await setArtifact(io, l, 'D01', { html: PAGE + '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1"></script><img src="http://x.org/a.png">' }, '2026-03-02')
    expect(said).toContain('loads from elsewhere, which the tree view blocks: https://cdn.jsdelivr.net/npm/chart.js@4.4.1, http://x.org/a.png. Inline it (SVG, a <script> of its own)')
    // a link to a paper is fine
    said = await setArtifact(io, l, 'D01', { html: PAGE + `<p><a href="#${redo.id}">${redo.id}</a> <a href="https://arxiv.org/abs/1905.04899">CutMix</a></p>` }, '2026-03-02')
    expect(said).not.toContain('elsewhere')
  })

  test('a renamed concept keeps one artifact file, found by the concept id it carries; any name survives the header', async () => {
    const { fs, io, l } = await setup()
    await setArtifact(io, l, 'D01', { html: PAGE }, '2026-03-01')
    await setConcept(io, l, 'D01', 'Gap --> zero')
    // until it is written again the old file is the concept's artifact
    expect((await readArtifacts(io, l)).D01!.path).toBe('artifacts/D01 Better variants.html')
    await setArtifact(io, l, 'D01', { html: PAGE }, '2026-03-02')
    expect(fs.exists(FILE)).toBe(false)
    const a = (await readArtifacts(io, l)).D01!
    expect(a.path).toBe('artifacts/D01 Gap -- zero.html')
    expect(a.name).toBe('Gap --> zero')
    // the header is one HTML comment, which a name with --> does not end early
    const head = fs.read(`vault/${a.path}`).split('\n')[0]!
    expect(head.indexOf('-->')).toBe(head.length - 3)
  })

  test('an html file in artifacts/ without the header is not an artifact, and stays as it is', async () => {
    const files = demoFiles()
    files['vault/artifacts/notes.html'] = '<p>by hand</p>'
    const { io, l } = await setup(files)
    expect(await readArtifacts(io, l)).toEqual({})
  })
})

describe('artifacts: the tree says when they go out of date', () => {
  test('rft_set_status says it put an artifact out of date, or that the concept has none yet, in a vault with artifacts', async () => {
    const { io, l } = await setup()
    // a vault with no artifact: not a word about them
    expect(await setStatus(io, l, 'E02', 'done', 'Final: +2.')).not.toContain('artifact')
    await setArtifact(io, l, 'D01', { html: PAGE }, '2026-03-01')
    const redo = await addNode(io, l, { type: 'experiment', title: 'Redo', parent: 'D01', date: '2026-02-01', status: 'running' })
    expect(await setStatus(io, l, redo.id, 'done', '+1 point.'))
      .toContain(`The artifact of "Better variants" is now out of date (${redo.id} new): update it at the end of this task (rft_artifact, then rft_set_artifact with edits).`)
    expect(await setStatus(io, l, 'E01', 'dropped', 'Bug in the loader.'))
      .toContain('"demo" has no artifact yet: write one at the end of this task (rft_artifact, then rft_set_artifact).')
    // a note without a result, or a direction: nothing to say
    expect(await setStatus(io, l, 'D01', 'done')).not.toContain('artifact')
  })

  test('rft_map, rft_next and rft_validate name the artifacts out of date and the left-over ones, in a vault with artifacts', async () => {
    const { fs, io, l } = await setup()
    expect(await mapReport(io, l)).not.toContain('artifact')
    expect(await artifactWarnings(io, l)).toEqual([])
    await setArtifact(io, l, 'D01', { html: PAGE }, '2026-03-01')
    expect(await mapReport(io, l)).not.toContain('[artifact')
    const path = `vault/experiments/${E02}.md`
    fs.write(path, fs.read(path).replace('Text of E02.', 'Now +3 points.'))
    await reload(io, l)
    expect(await mapReport(io, l)).toMatch(/- Better variants \(D01\) · .*\[artifact out of date\]/)
    expect(await mapReport(io, l, 'D01')).toContain('Artifact: artifacts/D01 Better variants.html, updated 2026-03-01, out of date: E02 changed')
    // a concept with results and no artifact, in a vault that has artifacts
    expect(await mapReport(io, l)).toMatch(/demo.*\[no artifact\]/)
    expect(await nextReport(io, l, '2026-03-05')).toContain('Artifacts out of date: Better variants (E02 changed). Without one: demo.')
    expect(await artifactWarnings(io, l)).toEqual([
      'artifacts/D01 Better variants.html: the artifact of "Better variants" is out of date (E02 changed since 2026-03-01) — rft_artifact, then rft_set_artifact',
    ])
    await setConcept(io, l, 'D01', null)
    expect(await artifactWarnings(io, l)).toContain('artifacts/D01 Better variants.html: the artifact of a concept that no longer exists (D01); remove the file')
  })
})

describe('artifacts: in a session', () => {
  const withArtifact = () => ({
    ...demoFiles(),
    [`vault/directions/D01 A better variant.md`]: demoFiles()['vault/directions/D01 A better variant.md']!.replace(/^(tags: .*)$/m, '$1\nconcept: "Better variants"'),
    [FILE]: `<!-- rft-artifact {"concept":"D01","name":"Better variants","updated":"2026-03-01","basis":{"E02":"00000000"}} -->\n${PAGE}`,
  })

  test('the artifact rule joins the session rules once the vault has an artifact', async ($, on) => {
    mock.clock(on)
    world(on, withArtifact())
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const res = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    const rules = res.sections.find(x => x.id === 'rft:rules')!.text
    expect(rules).toContain('Each concept has an artifact (`vault/artifacts/`)')
    expect(rules).toContain('At the end of a task that recorded results')
    expect(rules).toContain('rft_set_artifact')
  })

  test('a vault without one gets no artifact rule', async ($, on) => {
    mock.clock(on)
    world(on, demoFiles())
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const res = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    expect(res.sections.find(x => x.id === 'rft:rules')!.text).not.toContain('rft_set_artifact')
  })

  test("Claude's own Edit, Write and shell writes of an artifact are refused, pointing to rft_set_artifact; reading it is not", async ($, on) => {
    mock.clock(on)
    const w = world(on, withArtifact())
    const ran: string[] = []
    on('tool.call', (_$, e) => { ran.push(String(e.tool)); return { result: 'ok', text: 'ok' } as never })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    for (const call of [
      { tool: 'Edit', file_path: `${CWD}/${FILE}`, old_string: '+2 points', new_string: '+3 points' },
      { tool: 'Write', file_path: `${CWD}/vault/artifacts/D09 New.html`, content: PAGE },
      { tool: 'Bash', command: `sed -i 's/+2/+3/' "${FILE}"` },
      { tool: 'Bash', command: `cat page.html > "${FILE}"` },
    ]) {
      const res = await $.tool.call(call as never)
      expect({ call, deny: (res as { deny?: string }).deny }).toEqual({ call, deny: expect.stringContaining('rft_set_artifact') })
    }
    expect(ran).toEqual([])
    await $.tool.call({ tool: 'Read', file_path: `${CWD}/${FILE}` } as never)
    await $.tool.call({ tool: 'Bash', command: `cat "${FILE}"` } as never)
    expect(ran).toEqual(['Read', 'Bash'])
    expect(w.fs.read(FILE)).toContain('+2 points')
  })

  test('the tools answer through the session: rft_artifact, then rft_set_artifact with edits', async ($, on) => {
    mock.clock(on)
    const w = world(on, withArtifact())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const got = await $.tool.call({ tool: 'mcp__rft__rft_artifact', concept: 'Better variants' } as never)
    expect(got.text).toContain('out of date: E02 changed')
    const set = await $.tool.call({ tool: 'mcp__rft__rft_set_artifact', concept: 'D01', edits: [{ old_str: '+2 points', new_str: '+2 points (5 seeds)' }] } as never)
    expect(set.isError).toBeFalsy()
    expect(w.fs.read(FILE)).toContain('+2 points (5 seeds)')
    expect((await $.tool.call({ tool: 'mcp__rft__rft_artifact', concept: 'D01' } as never)).text).toContain('up to date')
    const bad = await $.tool.call({ tool: 'mcp__rft__rft_set_artifact', concept: 'D01', edits: [{ old_str: 'nowhere', new_str: 'x' }] } as never)
    expect(bad.isError).toBe(true)
  })

  test('/rft-artifact asks Claude for one concept, or for every artifact missing or out of date', async ($, on) => {
    const clock = mock.clock(on)
    world(on, withArtifact())
    const prompts: string[] = []
    on('prompt.submit', (_$, e) => { prompts.push(String(e.text)); return { text: e.text } as never })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect((await run($, 'rft-artifact', 'Nope')).text).toContain('is not a concept')
    expect((await run($, 'rft-artifact', 'Better variants')).text).toContain('Asked Claude to write the artifact of "Better variants"')
    await clock.advance(5000)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('rft_artifact "Better variants"')
    expect(prompts[0]).toContain('rft_set_artifact')
    expect(prompts[0]).toContain('never a number that is not in a note')
    // no concept named: every concept with results whose artifact is missing or out of date
    expect((await run($, 'rft-artifact', '')).text).toContain('Asked Claude to write 2 artifact(s): demo (none yet), Better variants (out of date)')
    await clock.advance(5000)
    expect(prompts).toHaveLength(2)
  })

  test('/rft-artifact is registered with the other commands', async ($, on) => {
    mock.clock(on)
    const w = world(on, demoFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(w.commands).toContain('rft-artifact')
  })

  test('/rft-view embeds each artifact for the page to show read-only, its images as placeholders', async ($, on) => {
    mock.clock(on)
    const files = { ...withArtifact(), ...WEB_FILES }
    files[FILE] = files[FILE]!.replace(PAGE, PAGE + '<img src="fig.png"><script>document.title = "</script>"</script>')
    const w = world(on, files)
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    await run($, 'rft-view', '')
    const html = w.fs.read('vault/tree.html')
    expect(html).toContain('<script>/* artifacts */</script>')
    const data = JSON.parse(/window\.RFT_DATA = (.*?);<\/script>/.exec(html)![1]!)
    expect(data.tree.artifacts).toEqual([expect.objectContaining({ concept: 'D01', name: 'Better variants', path: 'artifacts/D01 Better variants.html', updated: '2026-03-01', stale: true, changed: ['E02'] })])
    expect(data.artifacts.D01).toContain('+2 points')
    expect(data.artifacts.D01).not.toContain('<img')
    expect(data.artifacts.D01).toContain('[image: fig.png]')
    expect(data.frame).toEqual({ js: '/* frame */', css: '/* frame css */' })
  })
})
