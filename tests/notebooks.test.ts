// Experiment notebooks: a marimo notebook per experiment with a result, kept in its concept's
// repo (`<repo>/notebooks/E02_<title>.py`) and linked from the vault (`vault/notebooks/E02.py`, a
// symlink; the note's `notebook:`). Claude writes it as plain cells (rft_set_notebook writes
// marimo's format), runs it with rft_run_notebook (in the repo's uv environment, through
// server/rft_notebook.py) and gets back a few lines: whether it ran, and its RESULTS checked
// against the note's Result. The run is stamped on the note (`reproduced:`), the concept's
// artifact report and the tree view's link marks say it, and the tools join the prompt once the
// vault has a notebook.

import { describe, expect, mock, test } from 'claude-code/testing'

import '../web/artifacts.js'

import { artifactReport } from '../hooks/lib/artifacts'
import type { NotebookEnv, RunOutcome } from '../hooks/lib/notebooks'
import { MAX_TIMEOUT_S, checkResults, notebookFile, notebookSource, parseReproduced, relativePath, reproducedLine, runNotebook, setNotebook } from '../hooks/lib/notebooks'
import { rulesText } from '../hooks/lib/ops'
import { treeJson } from '../hooks/lib/page'
import { CORE_TOOLS, FEATURE_TOOLS } from '../hooks/lib/tools'
import { front, load, readConfig, reposLine, rooted } from '../hooks/lib/vault'
import { D01, E01, E02, MemoryFs, demoAt, world } from './fixture'

const ROOT = '/work/demo'
const SFREE = '/work/code/sfree'
const at = (path: string) => `${ROOT}/vault/${path}`
const PATH = { E01: at(`experiments/${E01}.md`), D01: at(`directions/${D01}.md`), E02: at(`experiments/${E02}.md`) }
const NOTEBOOK = `${SFREE}/notebooks/E02_variant_run.py`
const LINK = at('notebooks/E02.py')
const RESULT = 'Long training loses 4.1 ± 0.6 points at 1k images and 0.8 ± 0.3 at 10k.'

/** The demo tree, D01 starting "Variants" with the code in sfree (a uv project); E02 done with a Result. */
function project(opts: { e02?: string } = {}) {
  const files = demoAt(ROOT, { [`${SFREE}/pyproject.toml`]: '[project]\nname = "sfree"\n', [`${SFREE}/train.py`]: '' })
  files[PATH.D01] = files[PATH.D01]!.replace(/^(tags: .*)$/m, `$1\nconcept: "Variants"\nconcept_repos: ${reposLine([SFREE])}`)
  files[PATH.E02] = files[PATH.E02]!.replace('status: running', 'status: done').replace('Text of E02.', RESULT)
  if (opts.e02) files[PATH.E02] = files[PATH.E02]!.replace('---\n\n#', `${opts.e02}\n---\n\n#`)
  return files
}

const open = async (files: Record<string, string>) => {
  const fs = new MemoryFs(files, true)
  const io = rooted(fs.io(), ROOT)
  return { fs, io, loaded: await load(io, (await readConfig(io))!) }
}

/** A notebook env that records its links and runs, and answers each run with `outcome`. */
function envOf(outcome: RunOutcome = { ok: true, seconds: 6.1, results: { gap_1k: 4.1234, gap_10k: 0.8 }, commit: 'a1b2c3d4e5', dirty: false, file: NOTEBOOK }) {
  const links: [string, string][] = []
  const runs: [string, number][] = []
  const env: NotebookEnv = {
    root: ROOT, date: '2026-11-15',
    link: async (target, where) => { links.push([target, where]) },
    run: async (link, timeout) => { runs.push([link, timeout]); return outcome },
  }
  return { env, links, runs }
}

const CELLS = ['import json\nwith open("runs/e02/summary.json") as f:\n    runs = json.load(f)', 'RESULTS = {"gap_1k": runs["gap"][0], "gap_10k": runs["gap"][2]}']

describe('the notebook file', () => {
  test('plain cells become a marimo notebook: mo first, a title cell, each cell a function marimo analyses itself', () => {
    const src = notebookSource('E02 · Variant run', CELLS)
    expect(src.startsWith('import marimo\n')).toBe(true)
    expect(src).toContain('app = marimo.App(app_title="E02 · Variant run")')
    expect(src).toContain('@app.cell\ndef _():\n    import marimo as mo\n    return (mo,)\n')
    expect(src).toContain('mo.md(r"""\n    # E02 · Variant run')
    // indented as marimo indents a cell's body; a blank line stays blank
    expect(src).toContain('@app.cell\ndef _():\n    import json\n    with open("runs/e02/summary.json") as f:\n        runs = json.load(f)\n    return\n')
    expect(src).toContain('@app.cell\ndef _():\n    RESULTS = {"gap_1k": runs["gap"][0], "gap_10k": runs["gap"][2]}\n    return\n')
    expect(notebookSource('x', ['a = 1\n\nb = 2'])).toContain('    a = 1\n\n    b = 2\n')
    expect(src.trimEnd().endsWith('if __name__ == "__main__":\n    app.run()')).toBe(true)
  })

  test('the file is named from the id and the title, as a Python module may be', async () => {
    const { loaded } = await open(project())
    expect(notebookFile(loaded.tree.nodes.E02!)).toBe('E02_variant_run.py')
    expect(notebookFile({ ...loaded.tree.nodes.E02!, title: 'CutMix, 3 datasets — 1k/5k images!' })).toBe('E02_cutmix_3_datasets_1k_5k_images.py')
    expect(notebookFile({ ...loaded.tree.nodes.E02!, title: 'A very long title that goes on and on about the experiment and its arms' }).length).toBeLessThanOrEqual(48)
  })

  test('a relative path from one folder to a file', () => {
    expect(relativePath('/work/demo/vault/notebooks', NOTEBOOK)).toBe('../../../code/sfree/notebooks/E02_variant_run.py')
    expect(relativePath('/a/b', '/a/b/c.py')).toBe('c.py')
  })
})

describe('rft_set_notebook', () => {
  test("writes the notebook in the concept's first repo, links it from the vault and from the note", async () => {
    const { fs, io, loaded } = await open(project())
    const { env, links } = envOf()
    const out = await setNotebook(io, loaded, env, 'E02', { cells: CELLS })
    expect(fs.read(NOTEBOOK)).toBe(notebookSource('E02 · Variant run', CELLS))
    expect(links).toEqual([['../../../code/sfree/notebooks/E02_variant_run.py', LINK]])
    expect(front(fs.read(PATH.E02)).notebook).toBe('"notebooks/E02.py"')
    expect(loaded.tree.nodes.E02!.notebook).toBe('notebooks/E02.py')
    expect(out).toContain(NOTEBOOK)
    expect(out).toContain('vault/notebooks/E02.py')
    expect(out).toContain('rft_run_notebook')
    expect(out).not.toContain('RESULTS')
  })

  test('says so when no cell sets RESULTS', async () => {
    const { io, loaded } = await open(project())
    const out = await setNotebook(io, loaded, envOf().env, 'E02', { cells: [CELLS[0]!] })
    expect(out).toContain('RESULTS')
  })

  test('links a notebook that is already in the repo, by its path in the repo or absolute', async () => {
    const files = project()
    files[`${SFREE}/analysis/e02.py`] = 'import marimo\napp = marimo.App()\n'
    const { fs, io, loaded } = await open(files)
    const { env, links } = envOf()
    await setNotebook(io, loaded, env, 'E02', { file: 'analysis/e02.py' })
    expect(links).toEqual([['../../../code/sfree/analysis/e02.py', LINK]])
    expect(fs.read(`${SFREE}/analysis/e02.py`)).toBe('import marimo\napp = marimo.App()\n')
    expect(loaded.tree.nodes.E02!.notebook).toBe('notebooks/E02.py')
    await setNotebook(io, loaded, env, 'E02', { file: `${SFREE}/analysis/e02.py` })
    expect(links[1]).toEqual(['../../../code/sfree/analysis/e02.py', LINK])
    await expect(setNotebook(io, loaded, env, 'E02', { file: 'analysis/none.py' })).rejects.toThrow(/no file/)
  })

  test('refuses a note that is not an experiment, a concept with no code, an empty call, and a notebook it would overwrite', async () => {
    const { fs, io, loaded } = await open(project())
    const { env } = envOf()
    await expect(setNotebook(io, loaded, env, 'D01', { cells: CELLS })).rejects.toThrow(/experiment/)
    await expect(setNotebook(io, loaded, env, 'E01', { cells: CELLS })).rejects.toThrow(/rft_set_repos/)
    await expect(setNotebook(io, loaded, env, 'E02', {})).rejects.toThrow(/cells or file/)
    await expect(setNotebook(io, loaded, env, 'E02', { cells: [] })).rejects.toThrow(/cells or file/)
    fs.write(NOTEBOOK, 'mine')
    await expect(setNotebook(io, loaded, env, 'E02', { cells: CELLS })).rejects.toThrow(/Edit|replace/)
    expect(fs.read(NOTEBOOK)).toBe('mine')
    await setNotebook(io, loaded, env, 'E02', { cells: CELLS, replace: true })
    expect(fs.read(NOTEBOOK)).toContain('RESULTS')
  })

  test('refuses a locked note', async () => {
    const { io, loaded } = await open(project({ e02: 'locked: true' }))
    await expect(setNotebook(io, loaded, envOf().env, 'E02', { cells: CELLS })).rejects.toThrow(/locked/)
  })
})

describe('rft_run_notebook', () => {
  const linked = () => project({ e02: 'notebook: "notebooks/E02.py"' })

  test("ok: every number of RESULTS is in the note's Result; the run is stamped on the note", async () => {
    const { fs, io, loaded } = await open(linked())
    const { env, runs } = envOf()
    const out = await runNotebook(io, loaded, env, 'E02')
    expect(runs).toEqual([[LINK, MAX_TIMEOUT_S]])
    expect(out).toContain('ok')
    expect(out).toContain('gap_1k 4.1234 ✓')
    expect(out).toContain('gap_10k 0.8 ✓')
    expect(out).toContain('a1b2c3d4e5')
    expect(front(fs.read(PATH.E02)).reproduced).toBe('"2026-11-15 ok @a1b2c3d4e5 in 6.1 s"')
    expect(loaded.tree.nodes.E02!.reproduced).toEqual({ date: '2026-11-15', state: 'ok', commit: 'a1b2c3d4e5', seconds: 6.1 })
    expect(out.split('\n').length).toBeLessThanOrEqual(4)
  })

  test('differs: a number that is not in the Result is named, with what to do', async () => {
    const { fs, io, loaded } = await open(linked())
    const { env } = envOf({ ok: true, seconds: 3, results: { gap_1k: 4.6, gap_10k: 0.8 }, commit: 'a1b2c3d4e5', dirty: true })
    const out = await runNotebook(io, loaded, env, 'E02', { timeout: 60 })
    expect(out).toContain('differs')
    expect(out).toContain('gap_1k 4.6 ✗')
    expect(out).toContain('rft_set_status')
    expect(front(fs.read(PATH.E02)).reproduced).toBe('"2026-11-15 differs @a1b2c3d4e5+dirty in 3 s"')
  })

  test('failed: the end of the traceback, nothing more', async () => {
    const { fs, io, loaded } = await open(linked())
    const tb = ['Traceback (most recent call last):', '  File "x.py", line 1', 'FileNotFoundError: [Errno 2] No such file: runs/e02/summary.json'].join('\n')
    const { env } = envOf({ ok: false, seconds: 0.4, error: tb, commit: 'a1b2c3d4e5' })
    const out = await runNotebook(io, loaded, env, 'E02')
    expect(out).toContain('failed')
    expect(out).toContain('FileNotFoundError: [Errno 2] No such file: runs/e02/summary.json')
    expect(front(fs.read(PATH.E02)).reproduced).toBe('"2026-11-15 failed @a1b2c3d4e5 in 0.4 s"')
  })

  test('unchecked: no RESULTS, or no Result to check them against', async () => {
    const { io, loaded } = await open(linked())
    const out = await runNotebook(io, loaded, envOf({ ok: true, seconds: 1, commit: 'a1b2c3d4e5' }).env, 'E02')
    expect(out).toContain('no RESULTS')
    expect(loaded.tree.nodes.E02!.reproduced?.state).toBe('unchecked')
    const files = linked()
    files[PATH.E02] = files[PATH.E02]!.replace(RESULT, '')
    const b = await open(files)
    const out2 = await runNotebook(b.io, b.loaded, envOf().env, 'E02')
    expect(out2).toContain('no Result')
    expect(out2).toContain('gap_1k 4.1234')
    expect(b.loaded.tree.nodes.E02!.reproduced?.state).toBe('unchecked')
  })

  test('the timeout is kept between a second and the most a call can wait; a note with no notebook is refused', async () => {
    const { io, loaded } = await open(linked())
    const { env, runs } = envOf()
    await runNotebook(io, loaded, env, 'E02', { timeout: 100000 })
    await runNotebook(io, loaded, env, 'E02', { timeout: 0 })
    expect(runs.map(r => r[1])).toEqual([MAX_TIMEOUT_S, 1])
    const plain = await open(project())
    await expect(runNotebook(plain.io, plain.loaded, env, 'E02')).rejects.toThrow(/rft_set_notebook/)
  })
})

describe('RESULTS against the Result', () => {
  test('a number matches one in the text at the precision the text gives', () => {
    const r = checkResults({ a: 4.1234, b: 0.31, c: -2.5, d: 41.2, e: 5 }, 'Gap 4.1 ± 0.3; loss −2.5; 41.2% at 5 seeds.')
    expect(r.checks).toEqual([
      { key: 'a', value: 4.1234, found: true },
      { key: 'b', value: 0.31, found: true },
      { key: 'c', value: -2.5, found: true },
      { key: 'd', value: 41.2, found: true },
      { key: 'e', value: 5, found: true },
    ])
    expect(checkResults({ a: 4.16 }, 'Gap 4.1').checks[0]!.found).toBe(false)
  })

  test('nested values by their path, lists by index; what is not a number is listed apart', () => {
    const r = checkResults({ gap: { '1k': 4.1, sizes: [1000, 10000] }, model: 'resnet18', ok: true }, 'at 1000 and 10000 images: 4.1')
    expect(r.checks.map(c => [c.key, c.found])).toEqual([['gap.1k', true], ['gap.sizes[0]', true], ['gap.sizes[1]', true]])
    expect(r.skipped).toEqual(['model', 'ok'])
    expect(checkResults(3.5, 'is 3.5').checks).toEqual([{ key: 'RESULTS', value: 3.5, found: true }])
  })

  test('the run stamp, read back', () => {
    for (const line of ['2026-11-15 ok @a1b2c3d4e5 in 6.1 s', '2026-11-15 differs @a1b2c3d+dirty in 3 s', '2026-11-15 failed in 0.4 s', '2026-11-15 unchecked']) {
      expect(reproducedLine(parseReproduced(line)!)).toBe(line)
    }
    expect(parseReproduced('"2026-11-15 ok @a1b2c3d4e5 in 6.1 s"')).toEqual({ date: '2026-11-15', state: 'ok', commit: 'a1b2c3d4e5', seconds: 6.1 })
    expect(parseReproduced('yesterday, fine')).toBeNull()
    expect(parseReproduced(undefined)).toBeNull()
  })
})

describe('where the notebooks show', () => {
  test('the tree JSON carries the notebook and its last run', async () => {
    const { loaded } = await open(project({ e02: 'notebook: "notebooks/E02.py"\nreproduced: "2026-11-15 ok @a1b2c3d4e5 in 6.1 s"' }))
    const e02 = (treeJson(loaded.tree, 'demo', 'v1') as unknown as { nodes: Record<string, unknown>[] }).nodes.find(n => n.id === 'E02')!
    expect(e02.notebook).toBe('notebooks/E02.py')
    expect(e02.reproduced).toEqual({ date: '2026-11-15', state: 'ok', commit: 'a1b2c3d4e5', seconds: 6.1 })
  })

  test("a concept's artifact report says, in a concept with code, which results a notebook reproduced", async () => {
    const files = project({ e02: 'notebook: "notebooks/E02.py"\nreproduced: "2026-11-15 ok @a1b2c3d4e5 in 6.1 s"' })
    const { io, loaded } = await open(files)
    const out = await artifactReport(io, loaded, 'Variants')
    expect(out).toContain('reproduced ok 2026-11-15')
    const other = await open(project())
    expect(await artifactReport(other.io, other.loaded, 'Variants')).toContain('no notebook')
    // a concept with no code has nothing to say about notebooks
    expect(await artifactReport(other.io, other.loaded, 'demo')).not.toContain('notebook')
  })

  test("the view marks a link to an experiment with its notebook's last run", () => {
    const A = (globalThis as unknown as { RftArtifacts: { decoration: (byId: Map<string, unknown>, id: string) => { cls: string; title: string }; reproducedText: (r: unknown) => string } }).RftArtifacts
    const byId = new Map<string, unknown>([
      ['E02', { id: 'E02', name: 'E02 Variant run', status: 'done', reproduced: { date: '2026-11-15', state: 'ok', commit: 'a1b2c3d4e5', seconds: 6.1 } }],
      ['E03', { id: 'E03', name: 'E03 Other', status: 'done', reproduced: { date: '2026-11-14', state: 'failed' } }],
      ['E04', { id: 'E04', name: 'E04 Plain', status: 'done' }],
    ])
    expect(A.decoration(byId, 'E02').cls).toContain('r-ok')
    expect(A.decoration(byId, 'E02').title).toContain('reproduced 2026-11-15')
    expect(A.decoration(byId, 'E03').cls).toContain('r-failed')
    expect(A.decoration(byId, 'E04').cls).not.toContain('r-')
    expect(A.reproducedText({ date: '2026-11-15', state: 'ok', commit: 'a1b2c3d4e5', seconds: 6.1 })).toBe('Reproduced 2026-11-15 · ok · a1b2c3d4e5 · 6.1 s')
    expect(A.reproducedText({ date: '2026-11-14', state: 'failed' })).toBe('Last run 2026-11-14 · failed')
    expect(A.reproducedText(null)).toBe('Not run yet')
  })
})

describe('the notebook tools in a session', () => {
  const inPrompt = (w: { tools: string[]; deferred: string[] }) => w.tools.filter(t => !w.deferred.includes(t)).sort()

  test('a note with a notebook brings them into the prompt, and their rules into the session', async ($, on) => {
    mock.clock(on)
    const w = world(on, project({ e02: 'notebook: "notebooks/E02.py"' }), { cwd: ROOT })
    await $.session.start({ cwd: ROOT, source: 'startup' } as never)
    expect(FEATURE_TOOLS.notebooks).toEqual(['rft_set_notebook', 'rft_run_notebook'])
    expect(inPrompt(w)).toEqual([...CORE_TOOLS, ...FEATURE_TOOLS.notebooks].sort())
    const { loaded } = await open(project({ e02: 'notebook: "notebooks/E02.py"' }))
    expect(rulesText(loaded.tree, loaded.config, 'vault', {}, undefined, new Set(['notebooks']))).toContain('rft_run_notebook')
    expect(rulesText(loaded.tree, loaded.config, 'vault', {}, undefined, new Set())).not.toContain('rft_run_notebook')
  })

  test('rft_run_notebook runs the helper on the vault link and stamps the note', async ($, on) => {
    mock.clock(on)
    const calls: string[][] = []
    const w = world(on, project({ e02: 'notebook: "notebooks/E02.py"' }), {
      cwd: ROOT,
      process: argv => {
        if (!argv[1]?.endsWith('server/rft_notebook.py')) return undefined
        calls.push([...argv])
        return { exitCode: 0, stdout: 'marimo says hi\n' + JSON.stringify({ ok: true, seconds: 2, results: { gap_1k: 4.1 }, commit: 'a1b2c3d4e5', dirty: false, file: NOTEBOOK }) + '\n', stderr: '' }
      },
    })
    await $.session.start({ cwd: ROOT, source: 'startup' } as never)
    const r = await $.tool.call({ tool: 'mcp__rft__rft_run_notebook', id: 'E02', timeout: 30 } as never)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.slice(2)).toEqual(['run', LINK, '--timeout', '30'])
    expect(r.text).toContain('gap_1k 4.1 ✓')
    expect(front(w.fs.read(PATH.E02)).reproduced).toContain('ok @a1b2c3d4e5')
  })

  test("only rft_run_notebook writes reproduced:, so the stamp says what a run did; the rest of the note is Claude's to edit", async ($, on) => {
    mock.clock(on)
    const files = project({ e02: 'notebook: "notebooks/E02.py"\nreproduced: "2026-11-14 failed in 0.4 s"' })
    world(on, files, { cwd: ROOT })
    const ran: string[] = []
    on('tool.call', (_$, e) => { ran.push(String(e.tool)); return { result: 'ok', text: 'ok' } as never })
    await $.session.start({ cwd: ROOT, source: 'startup' } as never)
    for (const call of [
      { tool: 'Edit', file_path: PATH.E02, old_string: 'reproduced: "2026-11-14 failed in 0.4 s"', new_string: 'reproduced: "2026-11-15 ok in 6 s"' },
      { tool: 'Edit', file_path: PATH.E02, old_string: 'reproduced: "2026-11-14 failed in 0.4 s"\n', new_string: '' },
      { tool: 'Write', file_path: at('experiments/E09 By hand.md'), content: '---\nid: E09\ntype: experiment\nstatus: done\nreproduced: "2026-11-15 ok"\n---\n' },
      { tool: 'Bash', command: `sed -i 's/reproduced: .*/reproduced: "2026-11-15 ok"/' "${PATH.E02}"` },
    ]) {
      const res = await $.tool.call(call as never)
      expect({ call, deny: (res as { deny?: string }).deny }).toEqual({ call, deny: expect.stringContaining('Only rft_run_notebook writes reproduced:') })
    }
    expect(ran).toEqual([])
    await $.tool.call({ tool: 'Edit', file_path: PATH.E02, old_string: RESULT, new_string: 'Long training loses 4.2 ± 0.6 points.' } as never)
    expect(ran).toEqual(['Edit'])
  })

  test('rft_set_notebook writes the file and asks the helper for the link', async ($, on) => {
    mock.clock(on)
    const calls: string[][] = []
    const w = world(on, project(), {
      cwd: ROOT,
      process: argv => {
        if (!argv[1]?.endsWith('server/rft_notebook.py')) return undefined
        calls.push([...argv])
        return { exitCode: 0, stdout: '{"ok": true}\n', stderr: '' }
      },
    })
    await $.session.start({ cwd: ROOT, source: 'startup' } as never)
    const r = await $.tool.call({ tool: 'mcp__rft__rft_set_notebook', id: 'E02', cells: CELLS } as never)
    expect(r.text).toContain(NOTEBOOK)
    expect(w.fs.read(NOTEBOOK)).toContain('RESULTS')
    expect(calls.map(c => c.slice(2))).toEqual([['link', '../../../code/sfree/notebooks/E02_variant_run.py', LINK]])
  })
})
