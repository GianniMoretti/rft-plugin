// Experiment notebooks: a marimo notebook per experiment, which makes the numbers of its Result
// (from the run's saved raw outputs after an expensive run, from scratch for a short one). It
// lives in the concept's repo (`<repo>/notebooks/E02_<title>.py`) and runs in that repo's uv
// environment; the vault links it (`vault/notebooks/E02.py`, a symlink) and so does the note
// (`notebook:`). Claude writes it as plain cells, best when the experiment is planned, which this
// file turns into marimo's format (marimo works out each cell's inputs and outputs itself, so the
// functions take none), with a first cell that reads RUNS, the queue's runs of the experiment.
// It runs through server/rft_notebook.py, whose run is taken to the vault by server/rft_results.py
// (the queue's runner does the same when an experiment's jobs end, at no model turn): RESULTS
// checked against the note's Result, or written into it as a table; FIGURES and TABLES saved for
// the artifacts; the note stamped (`reproduced:`). The answer here is a few lines, never the
// cells' outputs; the concept's artifact report and the tree view's link marks say the stamp.

import { isLocked } from './comments'
import type { Io, Loaded, RftNode, ReproState } from './vault'
import { codeRepos, front, join, load, removeField, repoAbs, resolveId, resolvePath, setField, unquote } from './vault'

export { parseReproduced, reproducedLine } from './vault'

/** The vault's folder of links to the notebooks. */
export const NOTEBOOKS_DIR = 'notebooks'

/** The longest a run may take, in seconds: a host call waits ten minutes at most, and the helper needs a little more than the run. */
export const MAX_TIMEOUT_S = 540

/** How a run went, as server/rft_notebook.py answers it. */
export type RunOutcome = {
  ok: boolean
  seconds?: number
  /** The notebook's RESULTS, as JSON. */
  results?: unknown
  /** The end of the traceback, or why it did not run. */
  error?: string
  /** The repo's commit (short), and whether it had uncommitted changes; null outside git. */
  commit?: string | null
  dirty?: boolean | null
  /** The notebook's own file, the link followed. */
  file?: string
}

/** A run taken to the vault, as server/rft_results.py's apply answers it. */
export type ApplyOutcome = RunOutcome & {
  state?: ReproState
  /** RESULTS written into the Result's table. */
  recorded?: boolean
  locked?: boolean
  /** Why a run is unchecked: "no RESULTS", "no number in RESULTS", "locked". */
  why?: string
  checks?: Check[]
  skipped?: string[]
  /** What was kept in the vault, when the numbers are recorded or check ok. */
  saved?: { results?: string; figures?: string[]; tables?: string[]; artifacts?: string[] }
  /** What was not kept, and why (a figure that is not an SVG, …). */
  notes?: string[]
  /** The stamp written on the note. */
  reproduced?: string
}

/** What the notebook tools need from the host: where the tree is, the link the helper makes, the run. */
export type NotebookEnv = {
  root: string
  home?: string
  date: string
  /** Makes `at` a symbolic link to `target` (relative to the link's folder), replacing a link there. */
  link: (target: string, at: string) => Promise<void>
  /** Runs experiment `exp`'s notebook, for `timeoutS` seconds at most, and takes the run to the vault (server/rft_results.py). */
  apply: (vault: string, exp: string, opts: { timeoutS: number; record: boolean }) => Promise<ApplyOutcome>
}

class NotebookError extends Error {}

// ---------------------------------------------------------------- the file

/** A cell's code as marimo writes it inside its function: four spaces in, a blank line kept blank. */
const indented = (code: string) =>
  code.replace(/\s+$/, '').split('\n').map(l => l.replace(/^\t+/, t => '    '.repeat(t.length))).map(l => (l.trim() ? `    ${l}` : '')).join('\n')

const cellBlock = (code: string, head = '@app.cell') => `${head}\ndef _():\n${indented(code)}\n    return`

/**
 * The cell that reads RUNS: the queue's runs of experiment `exp` that ended well, oldest first,
 * each its record (rft-run.json in its output folder: `out`, `label`, `commit`…), from `runsRoot`
 * (the repo's `runs`, or <runsDir>/<repo's folder name>, as the queue's runner keeps them). Its own names are private (a leading _), so the
 * notebook's cells may import json and pathlib themselves.
 */
export const runsCell = (exp: string, runsRoot: string) =>
  `# ${exp}'s runs in the queue that ended well, oldest first: each its record (rft-run.json), with \`out\`, its output folder\n` +
  'import json as _json\nimport pathlib as _pathlib\n' +
  `RUNS = sorted((_r for _r in (_json.loads(_p.read_text()) for _p in _pathlib.Path(${JSON.stringify(runsRoot)}).glob(${JSON.stringify(`${exp}/*/rft-run.json`)})) if _r.get("state") == "done"), key=lambda _r: _r.get("started") or 0)`

/**
 * The marimo notebook made of `cells` (plain Python, one string per cell): `mo` first, a title
 * cell, the RUNS cell when `runs` is given, then each cell as a function with no arguments, which
 * marimo reads its inputs and outputs from itself; it runs as a script too.
 */
export function notebookSource(title: string, cells: string[], runs?: { exp: string; root: string }): string {
  const intro = `mo.md(r"""\n# ${title}\n\nMakes the numbers of the note's Result: \`RESULTS\` holds them, \`FIGURES\` and \`TABLES\` the figures and tables of its concept's artifact. Its run writes them in the Result, or checks them against it.\n""")`
  return [
    `import marimo\n\napp = marimo.App(app_title=${JSON.stringify(title)})`,
    '@app.cell\ndef _():\n    import marimo as mo\n    return (mo,)',
    cellBlock(intro, '@app.cell(hide_code=True)'),
    ...(runs ? [cellBlock(runsCell(runs.exp, runs.root), '@app.cell(hide_code=True)')] : []),
    ...cells.map(c => cellBlock(c)),
    'if __name__ == "__main__":\n    app.run()',
  ].join('\n\n\n') + '\n'
}

/** The notebook's file name in the repo: the id and the title, as a Python module may be named. */
export function notebookFile(n: Pick<RftNode, 'id' | 'title'>): string {
  const slug = n.title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  let base = slug ? `${n.id}_${slug}` : n.id
  if (base.length > 45) {
    const cut = base.slice(0, 45)
    base = base[45] === '_' || cut.lastIndexOf('_') <= n.id.length ? cut : cut.slice(0, cut.lastIndexOf('_'))
  }
  return `${base.replace(/_+$/, '')}.py`
}

/** `to` as a path relative to the folder `fromDir` (both absolute). */
export function relativePath(fromDir: string, to: string): string {
  const a = resolvePath('/', fromDir).split('/').filter(Boolean)
  const b = resolvePath('/', to).split('/').filter(Boolean)
  let i = 0
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/')
}

// ---------------------------------------------------------------- RESULTS against the Result

/** One number of RESULTS, and whether the Result writes it (server/rft_results.py checks). */
export type Check = { key: string; value: number; found: boolean }

const SHOWN = 30

const listed = (checks: Check[], mark: boolean) =>
  checks.slice(0, SHOWN).map(c => `${c.key} ${c.value}${mark ? (c.found ? ' ✓' : ' ✗') : ''}`).join(', ') +
  (checks.length > SHOWN ? `, … ${checks.length - SHOWN} more` : '')

// ---------------------------------------------------------------- rft_set_notebook

const vaultAbs = (env: NotebookEnv, loaded: Loaded) => repoAbs(env.root, loaded.config.vault, env.home)

const setsResults = (code: string) => /^\s*RESULTS\s*(?::[^=]*)?=/m.test(code)

/**
 * Gives an experiment its notebook: written from `cells` in the concept's first repo
 * (`notebooks/<id>_<title>.py`), or a notebook already in the repo (`file`, from the repo or
 * absolute); linked from the vault's notebooks/ and from the note. A notebook it would overwrite
 * is refused unless `replace`.
 */
export async function setNotebook(io: Io, loaded: Loaded, env: NotebookEnv, ref: string, input: { cells?: unknown; file?: unknown; replace?: unknown }): Promise<string> {
  const { tree, config } = loaded
  const id = resolveId(tree, ref)
  if (!id) throw new NotebookError(`"${ref}" is not a note of the tree`)
  const n = tree.nodes[id]!
  if (n.type !== 'experiment') throw new NotebookError(`${n.name} is a ${n.type}: only an experiment has a notebook, which rebuilds its Result`)
  if (isLocked(loaded.texts[id] ?? '')) throw new NotebookError(`${n.name} is locked: the user changes it, so ask them to unlock it before it gets a notebook`)
  const repos = codeRepos(tree.concepts, n.concept)
  if (!repos.length) throw new NotebookError(`${n.name}'s concept links no code, and a notebook lives in the concept's repo: link the repo first with rft_set_repos, once the user gives its path`)
  const repo = repoAbs(env.root, repos[0]!.path, env.home)
  const cells = (Array.isArray(input.cells) ? input.cells : []).filter((c): c is string => typeof c === 'string' && c.trim() !== '')
  const file = typeof input.file === 'string' ? input.file.trim() : ''
  if (!cells.length && !file) throw new NotebookError('give cells or file: cells, the notebook\'s code (one string per cell); file, a notebook already in the repo')
  let target: string
  let code: string
  if (file) {
    target = repoAbs(repo, file, env.home)
    if (!(await io.exists(target))) throw new NotebookError(`no file ${target} (a path in ${repo}, or absolute)`)
    code = await io.read(target)
  } else {
    target = join(repo, NOTEBOOKS_DIR, notebookFile(n))
    if ((await io.exists(target)) && input.replace !== true) throw new NotebookError(`${target} exists: change it with Edit (it is plain Python), or pass replace: true to write it anew from cells`)
    // where the queue's runner keeps the runs of this repo (server/rft_queue.py): <runsDir>/<repo>, else the repo's own runs/
    const root = config.runsDir ? join(repoAbs(env.root, config.runsDir, env.home), repo.split('/').filter(Boolean).pop() ?? '') : 'runs'
    code = notebookSource(`${n.id} · ${n.title}`, cells, { exp: n.id, root })
    await io.write(target, code)
  }
  const rel = `${NOTEBOOKS_DIR}/${n.id}.py`
  const linkAt = join(vaultAbs(env, loaded), rel)
  await env.link(relativePath(join(vaultAbs(env, loaded), NOTEBOOKS_DIR), target), linkAt)
  // a notebook written or linked anew: the last run, of the one before, says nothing of it
  const text = removeField(setField(loaded.texts[id]!, 'notebook', JSON.stringify(rel)), 'reproduced')
  await io.write(join(config.vault, n.path), text)
  Object.assign(loaded, await load(io, config))
  const how = file ? `linked: ${target}` : `written to ${target} (${cells.length} cell${cells.length === 1 ? '' : 's'})`
  let out = `${n.name}: notebook ${how}, linked from the vault as ${config.vault}/${rel} and from the note (notebook:). ` +
    `${n.status === 'planned' || n.status === 'running' ? `The queue's runner runs it when ${n.id}'s jobs end and writes RESULTS in its Result; rft_run_notebook ${n.id} runs it now` : `Run it with rft_run_notebook ${n.id}`}; change it with Edit (plain Python).`
  if (!setsResults(code)) out += ' No cell sets RESULTS: put the numbers the note reports in a dict RESULTS, so the run can write them in its Result.'
  return out
}

// ---------------------------------------------------------------- rft_run_notebook

const timeoutOf = (v: unknown) => {
  const t = Number(v)
  return v == null || v === '' || !Number.isFinite(t) ? MAX_TIMEOUT_S : Math.min(MAX_TIMEOUT_S, Math.max(1, Math.round(t)))
}

const tail = (text: string, lines = 15) => text.replace(/\s+$/, '').split('\n').slice(-lines).join('\n')

const savedText = (saved: ApplyOutcome['saved']) => {
  if (!saved) return ''
  const parts = [saved.results ?? '']
  for (const f of saved.figures ?? []) parts.push(`${f} (in an artifact: <img src="../${f}">)`)
  for (const t of saved.tables ?? []) parts.push(`table ${t} (in an artifact: <rft-table src="${t}"></rft-table>)`)
  const filled = saved.artifacts?.length ? ` Tables filled again in ${saved.artifacts.join(', ')}.` : ''
  return `Saved: ${parts.filter(Boolean).join('; ')}.${filled}`
}

/**
 * Runs an experiment's notebook in its repo's uv environment and takes the run to the vault
 * (server/rft_results.py): RESULTS checked against the note's Result (ok, differs), or written in
 * it as a table (`record`, or a Result that has no table and no number yet); failed; unchecked.
 * The numbers, figures and tables saved when they are the note's; the note stamped. A few lines.
 */
export async function runNotebook(io: Io, loaded: Loaded, env: NotebookEnv, ref: string, opts: { timeout?: unknown; record?: unknown } = {}): Promise<string> {
  const { tree, config } = loaded
  const id = resolveId(tree, ref)
  if (!id) throw new NotebookError(`"${ref}" is not a note of the tree`)
  const n = tree.nodes[id]!
  if (!n.notebook) throw new NotebookError(`${n.name} has no notebook: write one with rft_set_notebook`)
  const r = await env.apply(vaultAbs(env, loaded), n.id, { timeoutS: timeoutOf(opts.timeout), record: opts.record === true })
  Object.assign(loaded, await load(io, config))
  const seconds = typeof r.seconds === 'number' && Number.isFinite(r.seconds) ? Number(r.seconds.toFixed(1)) : undefined
  const at = r.commit ? ` at ${r.commit}${r.dirty ? ' (with uncommitted changes)' : ''}` : ''
  const took = seconds != null ? ` in ${seconds} s` : ''
  const checks = r.checks ?? []
  const other = r.skipped?.length ? ` Not numbers, so not checked: ${r.skipped.slice(0, SHOWN).join(', ')}.` : ''
  const lines: string[] = []
  if (r.state === 'failed' || !r.state) {
    lines.push(`${n.name}: failed${seconds != null ? ` after ${seconds} s` : ''}${at}.`, tail(r.error || 'no error given'),
      'Fix the notebook (plain Python: Edit it) or what it reads, then run it again.')
  } else if (r.state === 'unchecked') {
    if (r.why === 'locked') lines.push(`${n.name}: ran${took}${at}; it is locked, so its Result was not written. RESULTS: ${listed(checks, false)}.${other}`, 'Ask the user to unlock it, or to write them.')
    else if (r.why === 'no number in RESULTS') lines.push(`${n.name}: ran${took}${at}, but RESULTS holds no number to check.${other}`)
    else lines.push(`${n.name}: ran${took}${at}, but defines no RESULTS, so nothing was checked. Put the numbers the note reports in a dict RESULTS (Edit the notebook), then run it again.`)
  } else if (r.recorded) {
    lines.push(`${n.name}: recorded, ran${took}${at} (${r.file || n.notebook}).`,
      `RESULTS written in its Result's table: ${listed(checks, false)}.${other} Write what they mean around the table (rft_set_status), not the numbers again.`)
  } else {
    const missing = checks.filter(c => !c.found)
    lines.push(`${n.name}: ${missing.length ? `differs, ran${took}` : `ok, reproduced${took}`}${at} (${r.file || n.notebook}).`,
      `RESULTS against its Result: ${listed(checks, true)}.${other}`)
    if (missing.length) lines.push(`Not in the Result: ${listed(missing, false)}. ` + (r.why === 'locked'
      ? 'It is locked, so a run does not write its Result: fix the notebook, or ask the user to correct the Result or unlock it.'
      : 'Fix the notebook, or, if its numbers are right, run it again with record: true, which writes them in the Result\'s table.'))
  }
  const saved = savedText(r.saved)
  if (saved) lines.push(saved)
  if (r.notes?.length) lines.push(`Not kept: ${r.notes.join('; ')}.`)
  return lines.join('\n')
}

// ---------------------------------------------------------------- elsewhere

/** What a concept's artifact report says of an experiment's notebook. */
export function notebookMark(n: Pick<RftNode, 'notebook' | 'reproduced'>): string {
  if (!n.notebook) return 'no notebook'
  const r = n.reproduced
  if (!r) return 'notebook not run'
  return r.state === 'ok' ? `reproduced ok ${r.date}` : `notebook ${r.state} ${r.date}`
}

/** A `reproduced:` line. */
export const REPRODUCED_LINE = /(^|[^\w])reproduced\s*:/m

/** Whether an edit adds, changes or removes a note's `reproduced:`. */
export const changesReproduced = (before: string, after: string) => unquote(front(before).reproduced) !== unquote(front(after).reproduced)

/** A Result's table of RESULTS, as server/rft_results.py writes it between its two comment lines; '' when there is none. */
const RESULTS_BLOCK = /^<!-- rft-results\b[^\n]*-->[ \t]*\n[\s\S]*?^<!-- \/rft-results -->[ \t]*$/m
export const resultsBlockOf = (text: string) => RESULTS_BLOCK.exec(text)?.[0] ?? ''

/** Whether an edit adds, changes or removes a Result's table of RESULTS. */
export const changesResultsBlock = (before: string, after: string) => resultsBlockOf(before) !== resultsBlockOf(after)

/** Why Claude's own edit of a Result's table of RESULTS is refused, and what it does instead. */
export const resultsBlockEditText = (n: { id: string; name: string } | null) =>
  `Only a run of ${n ? `${n.name}'s` : 'an experiment\'s'} notebook writes the table of RESULTS in its Result (between its rft-results lines), so the note's numbers are the notebook's, and your edits that change it are refused. Write what the numbers mean around the table. To change them, fix the notebook and run it: rft_run_notebook {id: "${n ? n.id : '<id>'}", record: true}.`

/** Why Claude's own edit of `reproduced:` is refused, and what it does instead. */
export const reproducedEditText = (n: { id: string; name: string } | null) =>
  `Only rft_run_notebook writes reproduced: (the stamp of a notebook's last run), so it says what the notebook really did, and your edits that change it are refused. To stamp ${n ? n.name : 'an experiment'}, run its notebook: rft_run_notebook {id: "${n ? n.id : '<id>'}"}.`
