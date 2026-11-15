// Experiment notebooks: a marimo notebook per experiment with a result, which rebuilds the numbers
// of its Result (from the run's saved raw outputs after an expensive run, from scratch for a short
// one). It lives in the concept's repo (`<repo>/notebooks/E02_<title>.py`) and runs in that repo's
// uv environment; the vault links it (`vault/notebooks/E02.py`, a symlink) and so does the note
// (`notebook:`). Claude writes it as plain cells, which this file turns into marimo's format
// (marimo works out each cell's inputs and outputs itself, so the functions take none), and runs
// it through server/rft_notebook.py: the answer is a few lines, the notebook's RESULTS checked
// against the note's Result, never the cells' outputs. The run is stamped on the note
// (`reproduced:`), and the concept's artifact report and the tree view's link marks say it.

import { isLocked } from './comments'
import type { Io, Loaded, RftNode, ReproState, Reproduced } from './vault'
import { codeRepos, front, join, load, removeField, repoAbs, reproducedLine, resolveId, resolvePath, resultOf, setField, unquote } from './vault'

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

/** What the notebook tools need from the host: where the tree is, the link the helper makes, the run. */
export type NotebookEnv = {
  root: string
  home?: string
  date: string
  /** Makes `at` a symbolic link to `target` (relative to the link's folder), replacing a link there. */
  link: (target: string, at: string) => Promise<void>
  /** Runs the notebook the link `link` leads to, for `timeoutS` seconds at most. */
  run: (link: string, timeoutS: number) => Promise<RunOutcome>
}

class NotebookError extends Error {}

// ---------------------------------------------------------------- the file

/** A cell's code as marimo writes it inside its function: four spaces in, a blank line kept blank. */
const indented = (code: string) =>
  code.replace(/\s+$/, '').split('\n').map(l => l.replace(/^\t+/, t => '    '.repeat(t.length))).map(l => (l.trim() ? `    ${l}` : '')).join('\n')

const cellBlock = (code: string, head = '@app.cell') => `${head}\ndef _():\n${indented(code)}\n    return`

/**
 * The marimo notebook made of `cells` (plain Python, one string per cell): `mo` first, a title
 * cell, then each cell as a function with no arguments, which marimo reads its inputs and outputs
 * from itself; it runs as a script too.
 */
export function notebookSource(title: string, cells: string[]): string {
  const intro = `mo.md(r"""\n# ${title}\n\nRebuilds the numbers of the note's Result. \`RESULTS\` holds them: rft_run_notebook checks them against the Result.\n""")`
  return [
    `import marimo\n\napp = marimo.App(app_title=${JSON.stringify(title)})`,
    '@app.cell\ndef _():\n    import marimo as mo\n    return (mo,)',
    cellBlock(intro, '@app.cell(hide_code=True)'),
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

export type Check = { key: string; value: number; found: boolean }

/** A number in prose: a sign only where it is not a hyphen inside a word, thousands with commas, a fraction, an exponent. */
const NUMBER = /(?<![\w.])([-−]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:[eE]([-+]?\d+))?(?![\w.]*\d)/g

/** The numbers of a text, each with how close a value must be to read as it (half its last digit). */
function numbersIn(text: string): { x: number; tol: number }[] {
  const out: { x: number; tol: number }[] = []
  for (const m of text.matchAll(NUMBER)) {
    const frac = m[3] ?? ''
    const exp = Number(m[4] ?? 0)
    const x = Number(`${m[1] ? '-' : ''}${m[2]!.replace(/,/g, '')}${frac ? `.${frac}` : ''}e${exp}`)
    if (Number.isFinite(x)) out.push({ x, tol: 0.5 * 10 ** (exp - frac.length) * (1 + 1e-9) })
  }
  return out
}

/** The numbers of RESULTS by their path (`a.b`, `a[0]`), and the paths of what is not a number. */
function leaves(x: unknown, key: string, out: { key: string; value: number }[], skipped: string[]) {
  if (typeof x === 'number' && Number.isFinite(x)) out.push({ key: key || 'RESULTS', value: x })
  else if (Array.isArray(x)) x.forEach((v, i) => leaves(v, `${key}[${i}]`, out, skipped))
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) leaves(v, key ? `${key}.${k}` : k, out, skipped)
  else skipped.push(key || 'RESULTS')
}

/** Each number of RESULTS, and whether the text writes it (at the precision the text gives); what is not a number, apart. */
export function checkResults(results: unknown, text: string): { checks: Check[]; skipped: string[] } {
  const found: { key: string; value: number }[] = []
  const skipped: string[] = []
  leaves(results, '', found, skipped)
  const nums = numbersIn(text)
  return { checks: found.map(f => ({ ...f, found: nums.some(n => Math.abs(f.value - n.x) <= n.tol) })), skipped }
}

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
    code = notebookSource(`${n.id} · ${n.title}`, cells)
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
  let out = `${n.name}: notebook ${how}, linked from the vault as ${config.vault}/${rel} and from the note (notebook:). Run it with rft_run_notebook ${n.id}; change it with Edit (plain Python).`
  if (!setsResults(code)) out += ' No cell sets RESULTS: put the numbers the note reports in a dict RESULTS, so the run can check them against its Result.'
  return out
}

// ---------------------------------------------------------------- rft_run_notebook

const timeoutOf = (v: unknown) => {
  const t = Number(v)
  return v == null || v === '' || !Number.isFinite(t) ? MAX_TIMEOUT_S : Math.min(MAX_TIMEOUT_S, Math.max(1, Math.round(t)))
}

const tail = (text: string, lines = 15) => text.replace(/\s+$/, '').split('\n').slice(-lines).join('\n')

/**
 * Runs an experiment's notebook in its repo's uv environment and checks its RESULTS against the
 * note's Result: ok (every number written there), differs, failed, or unchecked (nothing to check
 * with, or against). Stamps the note with the run (`reproduced:`) and answers in a few lines.
 */
export async function runNotebook(io: Io, loaded: Loaded, env: NotebookEnv, ref: string, opts: { timeout?: unknown } = {}): Promise<string> {
  const { tree, config } = loaded
  const id = resolveId(tree, ref)
  if (!id) throw new NotebookError(`"${ref}" is not a note of the tree`)
  const n = tree.nodes[id]!
  if (!n.notebook) throw new NotebookError(`${n.name} has no notebook: write one with rft_set_notebook`)
  const link = resolvePath(vaultAbs(env, loaded), n.notebook)
  const r = await env.run(link, timeoutOf(opts.timeout))
  const seconds = typeof r.seconds === 'number' && Number.isFinite(r.seconds) ? Number(r.seconds.toFixed(1)) : undefined
  const commit = r.commit ? `${r.commit}${r.dirty ? '+dirty' : ''}` : undefined
  const at = r.commit ? ` at ${r.commit}${r.dirty ? ' (with uncommitted changes)' : ''}` : ''
  const took = seconds != null ? ` in ${seconds} s` : ''
  const lines: string[] = []
  let state: ReproState
  if (!r.ok) {
    state = 'failed'
    lines.push(`${n.name}: failed${seconds != null ? ` after ${seconds} s` : ''}${at}.`, tail(r.error || 'no error given'),
      'Fix the notebook (plain Python: Edit it) or what it reads, then run it again.')
  } else if (r.results == null) {
    state = 'unchecked'
    lines.push(`${n.name}: ran${took}${at}, but defines no RESULTS, so nothing was checked. Put the numbers the note reports in a dict RESULTS (Edit the notebook), then run it again.`)
  } else {
    const result = resultOf(loaded.texts[id] ?? '')
    const { checks, skipped } = checkResults(r.results, result)
    const other = skipped.length ? ` Not numbers, so not checked: ${skipped.slice(0, SHOWN).join(', ')}.` : ''
    if (!checks.length) {
      state = 'unchecked'
      lines.push(`${n.name}: ran${took}${at}, but RESULTS holds no number to check.${other}`)
    } else if (!result) {
      state = 'unchecked'
      lines.push(`${n.name}: ran${took}${at}. RESULTS: ${listed(checks, false)}.${other}`,
        'The note has no Result yet to check them against: write them in it (rft_set_status with results).')
    } else {
      const missing = checks.filter(c => !c.found)
      state = missing.length ? 'differs' : 'ok'
      lines.push(`${n.name}: ${missing.length ? `differs, ran${took}` : `ok, reproduced${took}`}${at} (${r.file || link}).`,
        `RESULTS against its Result: ${listed(checks, true)}.${other}`)
      if (missing.length) lines.push(`Not in the Result: ${listed(missing, false)}. Fix the notebook, or, if its numbers are right, write them in the Result and the summary (rft_set_status with results).`)
    }
  }
  const stamp: Reproduced = { date: env.date, state, ...(commit ? { commit } : {}), ...(seconds != null ? { seconds } : {}) }
  await io.write(join(config.vault, n.path), setField(loaded.texts[id]!, 'reproduced', JSON.stringify(reproducedLine(stamp)), 'notebook'))
  Object.assign(loaded, await load(io, config))
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

/** Why Claude's own edit of `reproduced:` is refused, and what it does instead. */
export const reproducedEditText = (n: { id: string; name: string } | null) =>
  `Only rft_run_notebook writes reproduced: (the stamp of a notebook's last run), so it says what the notebook really did, and your edits that change it are refused. To stamp ${n ? n.name : 'an experiment'}, run its notebook: rft_run_notebook {id: "${n ? n.id : '<id>'}"}.`
