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

import { artifactReport, compactResult } from '../hooks/lib/artifacts'
import { nextReport } from '../hooks/lib/knowledge'
import type { ApplyOutcome, NotebookEnv } from '../hooks/lib/notebooks'
import { MAX_TIMEOUT_S, notebookFile, notebookSource, parseReproduced, relativePath, reproducedLine, runNotebook, runsCell, setNotebook } from '../hooks/lib/notebooks'
import { rulesText } from '../hooks/lib/ops'
import { treeJson } from '../hooks/lib/page'
import { CORE_TOOLS, FEATURE_TOOLS } from '../hooks/lib/tools'
import { front, load, readConfig, reposLine, rooted, validate } from '../hooks/lib/vault'
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

const OK: ApplyOutcome = {
  ok: true, seconds: 6.1, results: { gap_1k: 4.1234, gap_10k: 0.8 }, commit: 'a1b2c3d4e5', dirty: false, file: NOTEBOOK, state: 'ok', recorded: false,
  checks: [{ key: 'gap_1k', value: 4.1234, found: true }, { key: 'gap_10k', value: 0.8, found: true }], skipped: [],
  saved: { results: 'results/E02.json', figures: ['figures/E02_gap.svg'], tables: ['E02_gap_by_size'], artifacts: [] },
}

/** A notebook env that records its links and runs, and answers each run with `outcome` (server/rft_results.py's answer, tested in test_notebook.py). */
function envOf(outcome: ApplyOutcome = OK) {
  const links: [string, string][] = []
  const runs: [string, string, { timeoutS: number; record: boolean }][] = []
  const env: NotebookEnv = {
    root: ROOT, date: '2026-11-15',
    link: async (target, where) => { links.push([target, where]) },
    apply: async (vault, exp, opts) => { runs.push([vault, exp, opts]); return outcome },
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
    expect(src).not.toContain('RUNS')
    // the project's figure style, before the cells, its helpers as rs
    expect(src).toContain('@app.cell(hide_code=True)\ndef _():\n    # the project\'s figure style')
    expect(src).toContain('    import rft_style as rs\n\n    rs.use()\n    return (rs,)\n')
    expect(src.indexOf('import rft_style as rs')).toBeLessThan(src.indexOf('import json\n'))
  })

  test("a new notebook reads RUNS, the experiment's runs in the queue, with names of its own so the cells may import json too", () => {
    const src = notebookSource('E02 · Variant run', CELLS, { exp: 'E02', root: 'runs' })
    expect(src).toContain(`@app.cell(hide_code=True)\ndef _():\n    # E02's runs`)
    expect(src).toContain('    import json as _json\n    import pathlib as _pathlib\n')
    expect(src).toContain('_pathlib.Path("runs").glob("E02/*/rft-run.json")')
    expect(src).toContain('if _r.get("state") == "done"')
    expect(src.indexOf('RUNS = ')).toBeLessThan(src.indexOf('RESULTS = '))
    expect(runsCell('E07', '/data/rft-runs')).toContain('_pathlib.Path("/data/rft-runs").glob("E07/*/rft-run.json")')
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
    expect(fs.read(NOTEBOOK)).toBe(notebookSource('E02 · Variant run', CELLS, { exp: 'E02', root: 'runs' }))
    expect(links).toEqual([['../../../code/sfree/notebooks/E02_variant_run.py', LINK]])
    expect(front(fs.read(PATH.E02)).notebook).toBe('"notebooks/E02.py"')
    expect(loaded.tree.nodes.E02!.notebook).toBe('notebooks/E02.py')
    expect(out).toContain(NOTEBOOK)
    expect(out).toContain('vault/notebooks/E02.py')
    expect(out).toContain('rft_run_notebook')
    expect(out).not.toContain('RESULTS')
  })

  test("with the config's runsDir, RUNS reads the runs where the runner keeps this repo's: <runsDir>/<repo>", async () => {
    const files = project()
    const cfg = `${ROOT}/.rft/config.json`
    files[cfg] = JSON.stringify({ ...JSON.parse(files[cfg]!), runsDir: '/data/rft-runs' })
    const { fs, io, loaded } = await open(files)
    await setNotebook(io, loaded, envOf().env, 'E02', { cells: CELLS })
    expect(fs.read(NOTEBOOK)).toContain('_pathlib.Path("/data/rft-runs/sfree").glob("E02/*/rft-run.json")')
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

  test('refuses a note that is no experiment and starts no concept, a concept with no code, an empty call, and a notebook it would overwrite', async () => {
    const { fs, io, loaded } = await open(project())
    const { env } = envOf()
    await expect(setNotebook(io, loaded, env, 'D00', { cells: CELLS })).rejects.toThrow(/starts no concept/)
    await expect(setNotebook(io, loaded, env, 'E01', { cells: CELLS })).rejects.toThrow(/rft_set_repos/)
    await expect(setNotebook(io, loaded, env, 'E02', {})).rejects.toThrow(/cells or file/)
    await expect(setNotebook(io, loaded, env, 'E02', { cells: [] })).rejects.toThrow(/cells or file/)
    fs.write(NOTEBOOK, 'mine')
    await expect(setNotebook(io, loaded, env, 'E02', { cells: CELLS })).rejects.toThrow(/Edit|replace/)
    expect(fs.read(NOTEBOOK)).toBe('mine')
    await setNotebook(io, loaded, env, 'E02', { cells: CELLS, replace: true })
    expect(fs.read(NOTEBOOK)).toContain('RESULTS')
  })

  test("a concept's notebook, on its start note: EXPERIMENTS, read from the vault's results/, to compare its experiments", async () => {
    const { fs, io, loaded } = await open(project())
    const { env, links } = envOf()
    const out = await setNotebook(io, loaded, env, 'D01', { cells: ['TABLES = {"Gap by experiment": [{"experiment": e, **r} for e, r in EXPERIMENTS.items()]}'] })
    const file = `${SFREE}/notebooks/D01_variants.py`
    const src = fs.read(file)
    expect(src).toContain('EXPERIMENTS = {_r["exp"]: _r["results"]')
    expect(src).toContain('_pathlib.Path("../../demo/vault/results").glob("E*.json")')
    expect(src).toContain('if "D01" in (_r.get("concepts") or [])')
    expect(src).not.toContain('RUNS')
    expect(links).toEqual([['../../../code/sfree/notebooks/D01_variants.py', at('notebooks/D01.py')]])
    expect(front(fs.read(PATH.D01)).notebook).toBe('"notebooks/D01.py"')
    expect(out).toContain('the notebook of the concept "Variants"')
    expect(out).toContain('runs again whenever one of its experiments')
  })

  test("a concept's run, and the concept runs after an experiment's, in a line each", async () => {
    const { io, loaded } = await open(project({ e02: 'notebook: "notebooks/E02.py"' }))
    const concept = await runNotebook(io, loaded, envOf({ ok: true, seconds: 2, commit: 'a1b2c3d4e5', state: 'ok', kind: 'concept', saved: { results: 'results/D01.json', figures: ['figures/D01_gap.svg'], tables: [] } }).env, 'E02')
    expect(concept).toContain("the concept's comparisons")
    expect(concept).toContain('figures/D01_gap.svg (in an artifact: <img src="../figures/D01_gap.svg">)')
    const chained = await runNotebook(io, loaded, envOf({ ...OK, concepts: [{ id: 'D01', state: 'ok', saved: { results: 'results/D01.json', tables: ['D01_gap_by_experiment'] } }] }).env, 'E02')
    expect(chained).toContain('Then the notebook of its concept D01: ok. Saved: results/D01.json; table D01_gap_by_experiment')
  })

  test('refuses a locked note', async () => {
    const { io, loaded } = await open(project({ e02: 'locked: true' }))
    await expect(setNotebook(io, loaded, envOf().env, 'E02', { cells: CELLS })).rejects.toThrow(/locked/)
  })
})

describe('rft_run_notebook', () => {
  const linked = () => project({ e02: 'notebook: "notebooks/E02.py"' })
  const VAULT = `${ROOT}/vault`

  test('ok: every number of RESULTS is in the Result, and where its figures and tables were saved, in a few lines', async () => {
    const { io, loaded } = await open(linked())
    const { env, runs } = envOf()
    const out = await runNotebook(io, loaded, env, 'E02')
    expect(runs).toEqual([[VAULT, 'E02', { timeoutS: MAX_TIMEOUT_S, record: false }]])
    expect(out).toContain('E02 Variant run: ok, reproduced in 6.1 s at a1b2c3d4e5')
    expect(out).toContain('gap_1k 4.1234 ✓')
    expect(out).toContain('gap_10k 0.8 ✓')
    expect(out).toContain('results/E02.json; figures/E02_gap.svg (in an artifact: <img src="../figures/E02_gap.svg">); table E02_gap_by_size (in an artifact: <rft-table src="E02_gap_by_size"></rft-table>)')
    expect(out.split('\n').length).toBeLessThanOrEqual(4)
  })

  test('recorded: RESULTS written in the Result, so Claude writes what they mean, not the numbers', async () => {
    const { io, loaded } = await open(linked())
    const { env, runs } = envOf({ ...OK, recorded: true, saved: { results: 'results/E02.json', artifacts: ['artifacts/D01 Variants.html'] } })
    const out = await runNotebook(io, loaded, env, 'E02', { record: true })
    expect(runs[0]![2].record).toBe(true)
    expect(out).toContain('E02 Variant run: recorded')
    expect(out).toContain("RESULTS written in its Result's table: gap_1k 4.1234, gap_10k 0.8.")
    expect(out).toContain('not the numbers again')
    expect(out).toContain('Tables filled again in artifacts/D01 Variants.html')
  })

  test('differs: a number that is not in the Result is named, with what to do', async () => {
    const { io, loaded } = await open(linked())
    const { env } = envOf({ ok: true, seconds: 3, commit: 'a1b2c3d4e5', dirty: true, state: 'differs', checks: [{ key: 'gap_1k', value: 4.6, found: false }, { key: 'gap_10k', value: 0.8, found: true }], skipped: [] })
    const out = await runNotebook(io, loaded, env, 'E02', { timeout: 60 })
    expect(out).toContain('differs, ran in 3 s at a1b2c3d4e5 (with uncommitted changes)')
    expect(out).toContain('gap_1k 4.6 ✗')
    expect(out).toContain('record: true')
    expect(out).not.toContain('Saved')
  })

  test('failed: the end of the traceback, nothing more', async () => {
    const { io, loaded } = await open(linked())
    const tb = ['Traceback (most recent call last):', '  File "x.py", line 1', 'FileNotFoundError: [Errno 2] No such file: runs/e02/summary.json'].join('\n')
    const out = await runNotebook(io, loaded, envOf({ ok: false, seconds: 0.4, error: tb, commit: 'a1b2c3d4e5', state: 'failed' }).env, 'E02')
    expect(out).toContain('failed after 0.4 s at a1b2c3d4e5')
    expect(out).toContain('FileNotFoundError: [Errno 2] No such file: runs/e02/summary.json')
  })

  test('unchecked: no RESULTS, or a locked note whose Result is not written', async () => {
    const { io, loaded } = await open(linked())
    expect(await runNotebook(io, loaded, envOf({ ok: true, seconds: 1, state: 'unchecked', why: 'no RESULTS' }).env, 'E02')).toContain('defines no RESULTS')
    const locked = await runNotebook(io, loaded, envOf({ ...OK, state: 'unchecked', why: 'locked', saved: undefined }).env, 'E02')
    expect(locked).toContain('it is locked, so its Result was not written')
    expect(locked).toContain('gap_1k 4.1234')
  })

  test('the timeout is kept between a second and the most a call can wait; a note with no notebook is refused', async () => {
    const { io, loaded } = await open(linked())
    const { env, runs } = envOf()
    await runNotebook(io, loaded, env, 'E02', { timeout: 100000 })
    await runNotebook(io, loaded, env, 'E02', { timeout: 0 })
    expect(runs.map(r => r[2].timeoutS)).toEqual([MAX_TIMEOUT_S, 1])
    const plain = await open(project())
    await expect(runNotebook(plain.io, plain.loaded, env, 'E02')).rejects.toThrow(/rft_set_notebook/)
  })
})

describe('the run stamp', () => {
  test('read back', () => {
    for (const line of ['2026-11-15 ok @a1b2c3d4e5 in 6.1 s', '2026-11-15 differs @a1b2c3d+dirty in 3 s', '2026-11-15 failed in 0.4 s', '2026-11-15 unchecked']) {
      expect(reproducedLine(parseReproduced(line)!)).toBe(line)
    }
    expect(parseReproduced('"2026-11-15 ok @a1b2c3d4e5 in 6.1 s"')).toEqual({ date: '2026-11-15', state: 'ok', commit: 'a1b2c3d4e5', seconds: 6.1 })
    expect(parseReproduced('yesterday, fine')).toBeNull()
    expect(parseReproduced(undefined)).toBeNull()
  })
})

describe('every experiment of a concept with code gets a notebook', () => {
  test('rft_validate names those without one, and rft_next those in work', async () => {
    const files = project()
    files[PATH.E02] = files[PATH.E02]!.replace('status: done', 'status: running')
    const { io, loaded } = await open(files)
    const v = await validate(io, loaded, { root: ROOT })
    expect(v.warnings.find(w => w.startsWith('Experiments in a concept with code and no notebook'))).toContain('(1): E02')
    expect(await nextReport(io, loaded, '2026-11-16')).toContain('No notebook yet (rft_set_notebook): E02 (running)')
    // with its notebook, or outside a concept with code, nothing is said
    const linked = await open(project({ e02: 'notebook: "notebooks/E02.py"' }))
    expect((await validate(linked.io, linked.loaded, { root: ROOT })).warnings.join('\n')).not.toContain('no notebook')
    expect(v.warnings.find(w => w.startsWith('Experiments in a concept with code and no notebook'))).not.toContain('E01') // its concept links no code
  })

  test("rft_artifact gives a Result's table of RESULTS in one line", () => {
    const text = '---\nid: E08\n---\n\n## Result\n<!-- rft-results: the notebook\'s RESULTS, written by its run; rft_run_notebook rewrites it -->\n| RESULTS | value |\n|---|---|\n| acc_mean | 0.8833 |\n| seeds | 3 |\n\n*From `notebooks/E08.py` at a1b2c3d4e5, 2026-11-16; runs q1, q2.*\n<!-- /rft-results -->\n\nIt settles.\n\n## Directions found\n'
    expect(compactResult(text)).toBe('RESULTS, written by its notebook: acc_mean 0.8833 · seeds 3 (From `notebooks/E08.py` at a1b2c3d4e5, 2026-11-16; runs q1, q2)\n\nIt settles.')
    expect(compactResult('---\nid: E01\n---\n\n## Result\nGap 4.1.\n')).toBe('Gap 4.1.')
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

  test('rft_run_notebook asks the helper to run and apply the notebook of the experiment, in its vault', async ($, on) => {
    mock.clock(on)
    const calls: string[][] = []
    world(on, project({ e02: 'notebook: "notebooks/E02.py"' }), {
      cwd: ROOT,
      process: argv => {
        if (!argv[1]?.endsWith('server/rft_notebook.py')) return undefined
        calls.push([...argv])
        return { exitCode: 0, stdout: 'marimo says hi\n' + JSON.stringify({ ...OK, checks: [{ key: 'gap_1k', value: 4.1, found: true }] }) + '\n', stderr: '' }
      },
    })
    await $.session.start({ cwd: ROOT, source: 'startup' } as never)
    const r = await $.tool.call({ tool: 'mcp__rft__rft_run_notebook', id: 'E02', timeout: 30, record: true } as never)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.slice(2, 9)).toEqual(['apply', '--vault', `${ROOT}/vault`, '--exp', 'E02', '--timeout', '30'])
    expect(calls[0]!.slice(9, 10)).toEqual(['--date'])
    expect(calls[0]!.at(-1)).toBe('--record')
    expect(r.text).toContain('gap_1k 4.1 ✓')
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

  test("only a notebook's run writes the table of RESULTS in a Result: Claude writes around it", async ($, on) => {
    mock.clock(on)
    const block = '<!-- rft-results: the notebook\'s RESULTS, written by its run; rft_run_notebook rewrites it -->\n| RESULTS | value |\n|---|---|\n| gap_1k | 4.1 |\n\n*From `nb.py`.*\n<!-- /rft-results -->'
    const files = project({ e02: 'notebook: "notebooks/E02.py"' })
    files[PATH.E02] = files[PATH.E02]!.replace(RESULT, `${block}\n\n${RESULT}`)
    world(on, files, { cwd: ROOT })
    const ran: string[] = []
    on('tool.call', (_$, e) => { ran.push(String(e.tool)); return { result: 'ok', text: 'ok' } as never })
    await $.session.start({ cwd: ROOT, source: 'startup' } as never)
    for (const call of [
      { tool: 'Edit', file_path: PATH.E02, old_string: '| gap_1k | 4.1 |', new_string: '| gap_1k | 4.2 |' },
      { tool: 'Edit', file_path: PATH.E02, old_string: `${block}\n\n`, new_string: '' },
      { tool: 'Bash', command: `sed -i 's/rft-results/x/' "${PATH.E02}"` },
    ]) {
      const res = await $.tool.call(call as never)
      expect({ call, deny: (res as { deny?: string }).deny }).toEqual({ call, deny: expect.stringContaining('writes the table of RESULTS') })
    }
    expect(ran).toEqual([])
    await $.tool.call({ tool: 'Edit', file_path: PATH.E02, old_string: RESULT, new_string: 'The gap closes at 10k.' } as never)
    expect(ran).toEqual(['Edit'])
  })

  test("rft_add_node asks for an experiment's notebook when its concept links code", async ($, on) => {
    mock.clock(on)
    world(on, project(), { cwd: ROOT })
    await $.session.start({ cwd: ROOT, source: 'startup' } as never)
    const r = await $.tool.call({ tool: 'mcp__rft__rft_add_node', type: 'experiment', title: 'Seed sweep', parent: 'D01', status: 'planned', what: 'Three seeds.', summary: 'Seeds' } as never)
    expect(String(r.text)).toContain('write its notebook now (rft_set_notebook E03)')
    const d = await $.tool.call({ tool: 'mcp__rft__rft_add_node', type: 'direction', title: 'Another idea', parent: 'D01', status: 'idea', idea: 'x', summary: 'x' } as never)
    expect(String(d.text)).not.toContain('notebook')
  })

  test('/rft-update notebooks runs every notebook again in the queue, and lists by concept what is still to write', async ($, on) => {
    const clock = mock.clock(on)
    const files = project({ e02: 'notebook: "notebooks/E02.py"' })
    files[at('.queue/machine.json')] = JSON.stringify({ version: 1, host: 'lab-pc' })
    // a second result in the concept, with no notebook; its artifact draws a chart and types a table
    files[at('experiments/E03 Seed sweep.md')] = files[PATH.E02]!.replace(/E02/g, 'E03').replace('Variant run', 'Seed sweep').replace(/notebook: .*\n/, '')
    files[PATH.D01] = files[PATH.D01]!.replace('children: [', 'children: ["[[E03 Seed sweep]]", ').replace('## Children in the tree\n', '## Children in the tree\n- [[E03 Seed sweep]]\n')
    files[at('artifacts/D01 Variants.html')] = '<!-- rft-artifact {"concept": "D01", "name": "Variants", "updated": "x", "basis": {}} -->\n<svg viewBox="0 0 1 1"></svg>\n<table><tr><td>4.1</td></tr></table>\n<rft-table src="E02_gap"><table><tr><td>4.1</td></tr></table></rft-table>\n'
    const calls: string[][] = []
    world(on, files, {
      cwd: ROOT,
      process: argv => {
        if (!argv[1]?.endsWith('server/rft_queue.py')) return undefined
        calls.push([...argv])
        if (argv[2] === 'add') return { exitCode: 0, stderr: '', stdout: JSON.stringify({ job: { id: 'q31', exp: 'D00', state: 'pending' }, outlook: 'starts in a few seconds (no GPU)' }) }
        return { exitCode: 0, stderr: '', stdout: '{}' }
      },
    })
    const prompts: string[] = []
    on('prompt.submit', (_$, e) => { prompts.push(String(e.text)); return { text: e.text } as never })
    await $.session.start({ cwd: ROOT, source: 'startup' } as never)
    const run = (args: string) => $.command.run({ command: 'rft-update', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
    const text = String((await run('notebooks')).text)
    const add = calls.find(c => c[2] === 'add')!
    const spec = JSON.parse(add[add.indexOf('--job') + 1]!)
    expect(spec).toMatchObject({ exp: 'D00', kind: 'notebook', gpus: 0, by: 'user', cwd: `${ROOT}/vault`, label: 'notebooks: run again (1)' })
    expect(spec.cmd).toMatch(/^python3 '.*server\/rft_notebook\.py' backfill --vault '\/work\/demo\/vault'$/)
    expect(text).toContain('Notebooks: 1 experiment notebook, 0 concept notebooks; 1 not run since a run saves its figures, tables and numbers for the artifacts (E02).')
    expect(text).toContain('Queued q31: all 1 run again, one after another')
    expect(text).toContain('- Variants (D01): 1 experiment with a result and no notebook (E03); no concept notebook to compare its 2 results; its artifact draws 1 chart and types 1 table by hand.')
    await clock.advance(5000)
    expect(prompts).toHaveLength(0) // no model turn
    // --write: the same report, and Claude asked to write it
    expect(String((await run('notebooks --write Variants')).text)).toContain('Claude will start in a moment, concept by concept')
    expect(calls.filter(c => c[2] === 'add')).toHaveLength(1) // nothing queued
    await clock.advance(5000)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('concept by concept: "Variants"')
    expect(prompts[0]).toContain('never record over the note\'s numbers')
    expect(String((await run('notebooks --write Nope')).text)).toContain('is not a concept')
  })

  test('/rft-update notebooks with no machine paired with the queue queues nothing and says how to run them', async ($, on) => {
    mock.clock(on)
    const calls: string[][] = []
    world(on, project({ e02: 'notebook: "notebooks/E02.py"' }), {
      cwd: ROOT,
      process: argv => {
        if (argv[1]?.endsWith('server/rft_queue.py')) calls.push([...argv])
        return undefined
      },
    })
    await $.session.start({ cwd: ROOT, source: 'startup' } as never)
    const text = String((await $.command.run({ command: 'rft-update', args: 'notebooks', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)).text)
    expect(calls).toEqual([])
    expect(text).toContain('Not run again: that goes through the experiment queue, which is off until this machine is paired with it (/rft-machine add)')
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
