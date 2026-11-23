// rft: the Reasoning Flow Tree plugin in a session. The commands (registerCommands and their
// `command.run` hooks; what each asks of Claude is in lib/prompts), the model's tools (runTool;
// their descriptions and schemas are in lib/specs, which ones sit in the prompt in lib/tools), the
// operating rules injected into the system prompt, the outline pane, and the web view: /rft
// starts a local server (server/rft_server.py) for the interactive tree page (web/), makes the
// notes that page adds, retypes or moves (fromView), and asks Claude to answer the threads the
// user asks it to (askFromView). Claude's own edits and shell commands pass the guards of
// lib/guards first (refused): what only the user or one of the tools may write is refused, with
// the tool to use instead.
// Everything is
// inert without `.rft/config.json` in the session's folder or a folder above it; that config
// may be a link (`{"tree": "../notes"}`) to a tree kept elsewhere.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RftSnapshot } from '../types'
import { COMMENTS_DIR, LockedChange, answerThread, askText, comment as addComment, commentsReport, readComments, subagentAskText, subjectOf, suggest as addSuggestion } from './lib/comments'
import type { AddInput, CodeEnv, Git } from './lib/ops'
import { QUEUE_RULE, addNodes, checkLine, codeReport, conceptsReport, exportHtml, initVault, loadActive, moveNode, rulesText, setCode, setConcept, setRefs, setRepos, setStatus, setTags, setType, tagsReport, today, treeReport } from './lib/ops'
import { ASSET_PATHS } from './lib/page'
import type { Config, Io, Loaded, NodeType, Tree, Validation } from './lib/vault'
import { OPEN_HOSTS, jobNote, planPapers, withEntryPdf } from './lib/papers'
import { searchReport, similarNotes } from './lib/search'
import { ceiling } from './lib/fit'
import { graphReport } from './lib/graph'
import { candidates, candidatesReport } from './lib/rebalance'
import { nextReport, supersede } from './lib/knowledge'
import { suggestPriority } from './lib/priority'
import { dismissVerified, keepVerified, toReview, verifyNote } from './lib/verify'
import { markReviewed, manuscriptReport, manuscriptWarnings, migrateManuscript, newDocument, readManuscript, reviewCopy, setDocument, setSnippet } from './lib/manuscript'
import { deckWarnings } from './lib/decks'
import { addDeadline, addMeeting, checkDeadline, checkMeeting, deadlineQuestion, deadlinesLine, meetingQuestion, suggestDates, suggestDeadline } from './lib/schedule'
import { RECALL_HINT, searchesVault } from './lib/recall'
import { FEATURE_TOOLS, REPORT_TOOLS, eagerTools, featuresInUse } from './lib/tools'
import { TOOLS } from './lib/specs'
import { isGuarded, refusal } from './lib/guards'
import { Answers, type ThreadJob } from './lib/answers'
import { applyUpdate, behindLine, gapsText, notebookGaps, planText, planUpdate } from './lib/update'
import type { Feature } from './lib/tools'
import { RULES_ACTIVE_WIDTH, SMALL_TREE, mapGaps, mapReport, mapWarnings, projectMap, readDigests, resolveConcept, setDigest, setSummaries } from './lib/map'
import { artifactMarks, artifactReport, artifactWarnings, artifactsToWrite, setArtifact } from './lib/artifacts'
import type { ApplyOutcome, NotebookEnv } from './lib/notebooks'
import { runNotebook, setNotebook } from './lib/notebooks'
import { MACHINE_FILE, machinePrompt, probeText, readMachine, statusText } from './lib/machine'
import { manualDir } from './lib/manual'
import { artifactPrompt, candidatesPrompt, literaturePrompt, manuscriptPrompt, notebooksPrompt, rebalancePrompt, suggestConceptsPrompt, summarizePrompt } from './lib/prompts'
import { addItem, commandInput, inboxLine, inboxReport, loadInbox } from './lib/inbox'
import { clearHandoff, handoffPrompt, handoffRules, hasHandoffs, leaveHandoff, showHandoff, sizeToast, toTell, uncommittedIn } from './lib/handoff'
import type { MachineStatus, Probe } from './lib/machine'
import { QUEUE_CLI, QUEUE_FILE, addedText, cancelledText, jobEvents, jobsNext, jobsReport, movedText, queueLine, readQueue, retriedText, toStart } from './lib/queue'
import type { Job, QueueView } from './lib/queue'
import { CONFIG_PATH, LEGEND, MARK, bodyOf, isLiterature, counts, countsLine, isAbsolute, join, locate, readConfig, repoAbs, resolveId, resolvePath, rooted, setField, signatureOf, sync, validate } from './lib/vault'

const PANE = 'rft-tree'
const TITLE = 'Reasoning tree'
const POLL_MS = 4000

const snapshot = atom({ plugin: 'rft', key: 'snapshot' } as const, null)
const collapsed = atom({ plugin: 'rft', key: 'collapsed' } as const, [])
const selected = atom({ plugin: 'rft', key: 'selected' } as const, null)
const note = atom({ plugin: 'rft', key: 'note' } as const, null)
const webUrl = atom({ plugin: 'rft', key: 'webUrl' } as const, null)

const ioOf = ($: EngineInterface): Io => ({
  read: path => $.fs.read(path),
  write: (path, text) => $.fs.write(path, text),
  list: path => $.fs.list(path),
  exists: path => $.fs.exists(path),
  remove: async path => {
    const argv = /^[A-Za-z]:/.test(path) ? ['cmd', '/c', 'del', '/f', '/q', path.replace(/\//g, '\\')] : ['rm', '-f', '--', path]
    const r = await $.process.run(argv)
    if (r.exitCode !== 0 || (await $.fs.exists(path))) throw new Error(r.stderr.trim() || `${argv[0]} left the file in place`)
  },
})

/** The tree a session works on: its files and folder, the link that led there, the session's folder. */
type Here = { io: Io; root: string; link: string | null; cwd: string }

/** This session's tree, from its folder up and through a link; why a link leads nowhere; or null. */
async function locateHere($: EngineInterface): Promise<Here | { problem: string } | null> {
  const cwd = resolvePath(await $.session.cwd(), '.')
  const found = await locate(ioOf($), cwd)
  if (!found) return null
  if (found.root === null) return { problem: found.problem }
  return { io: rooted(ioOf($), found.root), root: found.root, link: found.link, cwd }
}

/** This session's tree; throws, with the reason, when there is none to work on. */
async function mustHere($: EngineInterface): Promise<Here> {
  const h = await locateHere($)
  if (!h) throw new Error(NOT_ACTIVE)
  if ('problem' in h) throw new Error(h.problem)
  return h
}

const vaultOf = (h: Here, config: Config) => (isAbsolute(config.vault) ? config.vault : join(h.root, config.vault))

/** The vault as the session is told about it: as configured when the tree is in its own folder. */
const shownVault = (h: Here, config: Config) => (h.root === h.cwd ? config.vault : vaultOf(h, config))

const treeOf = (s: RftSnapshot): Tree => ({ nodes: s.nodes, roots: s.roots, concepts: s.concepts })

/** The queue's tools: registered only on a machine paired with the queue (rft_machine add). */
const QUEUE_TOOLS: ReadonlySet<string> = new Set(FEATURE_TOOLS.queue)

// Module state: reset on a reload, when `session.start` runs again and sets it anew.
// The rules for the system prompt are fixed at activation so the prompt cache holds.
let rules: string | null = null
// the vault's folder and the session's, for the recall hint; whether rft_search, rft_map or
// rft_graph was used yet this session (the hint stops then)
let recall: { vault: string; cwd: string; used: boolean } | null = null
let poller: { cancel: () => void } | null = null
// prompts for Claude to answer, from a command or the tree view, submitted by the poller
const pendingPrompts: string[] = []
// each registered tool and whether it waits behind ToolSearch, so a new placement registers it again
const registeredTools = new Map<string, boolean>()
// the largest session size (lib/handoff TELL_AT) the user was told of, once each per session
let toldAt = 0

const EMPTY: RftSnapshot = { isActive: false, vault: '', project: '', nodes: {}, roots: [], concepts: {}, signature: '', problems: [], error: null }

/** Re-reads the vault into the snapshot when its notes changed (or always, with `force`). */
async function refresh($: EngineInterface, force = false): Promise<RftSnapshot | null> {
  const h = await locateHere($)
  const prev = await read($, snapshot)
  const config = h && !('problem' in h) ? await readConfig(h.io) : null
  if (!h || 'problem' in h || !config) {
    const why = h && 'problem' in h ? h.problem : null
    if (prev?.isActive !== false || prev.error !== why) await update($, snapshot, () => ({ ...EMPTY, error: why }))
    return null
  }
  const io = h.io
  const vault = vaultOf(h, config)
  if (!force && prev?.isActive && !prev.error && prev.signature === (await signatureOf(io, config.vault))) return prev
  try {
    const loaded = await loadActive(io)
    // a verified note whose claim changed goes to review; one verified by hand is stamped
    try {
      for (const line of await keepVerified(io, loaded, today())) $.ui.toast(`rft: ${line}`)
    } catch { /* tried again at the next change */ }
    const next: RftSnapshot = {
      isActive: true, vault, project: config.project, nodes: loaded.tree.nodes,
      roots: loaded.tree.roots, concepts: loaded.tree.concepts ?? {}, signature: loaded.signature, problems: loaded.problems, error: null,
    }
    await update($, snapshot, () => next)
    const shown = await read($, note)
    if (shown && loaded.tree.nodes[shown.id]) {
      const text = loaded.texts[shown.id] ?? ''
      if (text !== shown.text) await update($, note, () => ({ id: shown.id, text }))
    }
    return next
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, snapshot, s => ({ ...(s ?? EMPTY), isActive: true, vault, project: config.project, error: message }))
    return null
  }
}

/** In a project with `.rft/config.json`: the snapshot, the rules, the tools, the poll, the pane. */
async function activate($: EngineInterface, shouldOpen: boolean): Promise<void> {
  const failed: string[] = []
  let s: RftSnapshot | null = null
  let config: Config | null = null
  let h: Here | null = null
  recall = null
  toldAt = 0
  try {
    s = await refresh($, true)
    h = await mustHere($)
    config = await readConfig(h.io)
  } catch (err) {
    failed.push(`reading the vault (${message(err)})`)
  }
  // the core tools and the tools of the features the vault uses sit in the prompt, and their rules in the rules; the rest wait behind ToolSearch
  let features = new Set<Feature>()
  let loaded: Loaded | null = null
  if (h && config) {
    try {
      loaded = await loadActive(h.io)
      const threads = (await h.io.list(join(config.vault, COMMENTS_DIR)).catch(() => [])).some(f => f.name.endsWith('.json'))
      // no queue until this machine is paired with it (.queue/machine.json): no queue tool, rule or runner
      const machine = await readMachine(h.io, config.vault)
      features = featuresInUse(loaded, threads, machine !== null, await hasHandoffs(h.io, config.vault))
      if (!machine && await h.io.exists(join(config.vault, QUEUE_FILE)).catch(() => false)) {
        $.ui.toast('rft: the experiment queue is off until this machine is paired with it: /rft-machine add (its jobs and history are kept)')
      }
    } catch { /* the core tools only */ }
    // a vault an older version made: one toast, nothing changed until /rft-update apply
    const line = behindLine(config)
    if (line) $.ui.toast(line)
  }
  if (s && config && h) {
    // a large tree starts from the project map; a small one from its list of notes
    let map: string | undefined
    if (loaded && Object.keys(s.nodes).length > SMALL_TREE) {
      try {
        map = projectMap(loaded, await readDigests(h.io, loaded), { artifacts: await artifactMarks(h.io, loaded), activeWidth: RULES_ACTIVE_WIDTH })
      } catch { /* the list of notes instead */ }
    }
    rules = rulesText(treeOf(s), config, shownVault(h, config), { cwd: h.cwd, root: h.root, home: await homeOf($), manual: manualDir($.plugin.root) }, map, features)
    // the deadlines close at hand that are at risk, so the session starts from them
    try {
      const line = loaded ? deadlinesLine(loaded, today()) : null
      if (line) rules += `\n\n${line}`
    } catch { /* the rules without it */ }
    // the queue: what runs, and the jobs that ended with their result not recorded yet; a
    // planned experiment whose job runs is set running; a queue with work gets its runner back
    // (the machine restarted, or it stopped)
    if (features.has('queue')) try {
      queueSeen = null
      const v = await watchQueue($, true)
      const line = v && loaded ? queueLine(v, await loadActive(h.io), await nowS($)) : null
      if (line) rules += `\n\n${line}`
      if (v?.jobs.some(j => j.state === 'running' || (j.state === 'pending' && !v.paused))) void queueCli($, h, config, ['ensure']).catch(() => undefined)
    } catch { /* the rules without it */ }
    // what the session before left for this folder: the work goes on from it and the tree
    try {
      const block = await handoffRules(h.io, config.vault, { folder: h.cwd, session: await sessionId($), now: await nowS($) })
      if (block) rules += `\n\n${block}`
    } catch { /* the rules without it */ }
    recall = { vault: resolvePath(h.root, vaultOf(h, config)), cwd: h.cwd, used: false }
  }
  await registerThreadAgent($)
  const eager = eagerTools(features)
  // each registration on its own, so one refusal leaves the rest working
  for (const [name, spec] of Object.entries(TOOLS)) {
    if (QUEUE_TOOLS.has(name) && !features.has('queue')) continue
    const isDeferred = !eager.has(name)
    if (registeredTools.get(name) === isDeferred) continue
    try {
      await $.tool.register({ name, description: spec.description, inputSchema: spec.inputSchema as Record<string, unknown>, isDeferred })
      registeredTools.set(name, isDeferred)
    } catch (err) {
      failed.push(`tool ${name} (${message(err)})`)
    }
  }
  try {
    poller?.cancel()
    poller = $.clock.every(POLL_MS, () => { void poll($) })
  } catch (err) {
    failed.push(`the refresh timer (${message(err)})`)
  }
  if (shouldOpen) void $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
  if (failed.length) reportFailures($, failed)
}

/** A session's start, past the commands: the tree when there is one, else why its link leads nowhere. */
async function start($: EngineInterface, shouldOpen: boolean): Promise<void> {
  let isActive = false
  try {
    const h = await locateHere($)
    if (h && 'problem' in h) {
      await update($, snapshot, () => ({ ...EMPTY, error: h.problem }))
      $.ui.toast(`rft: ${h.problem}`)
    } else if (h) isActive = (await readConfig(h.io)) !== null
  } catch { /* treated as inactive */ }
  if (isActive) await activate($, shouldOpen)
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

function reportFailures($: EngineInterface, failed: string[]): void {
  $.ui.toast(`rft: could not set up ${failed.join('; ')}`)
}

/**
 * Each command on its own, so one refusal leaves the others registered. Written out one by one,
 * not from a table: `claude plugin validate` reads each name here to tell that the `command.run`
 * hook of that name answers the plugin's own command.
 */
async function registerCommands($: EngineInterface): Promise<void> {
  const failed: string[] = []
  const attempt = async (name: string, run: () => Promise<unknown>) => {
    try { await run() } catch (err) { failed.push(`/${name} (${message(err)})`) }
  }
  await attempt('rft', () => $.command.register({ name: 'rft', description: 'Open the interactive tree view (/rft list: the outline pane, /rft text: print it, /rft stop: stop the server)', argumentHint: '[list|text|stop]' }))
  await attempt('rft-init', () => $.command.register({ name: 'rft-init', description: 'Activate the Reasoning Flow Tree in this project and create its vault', argumentHint: '[starting question]' }))
  await attempt('rft-concepts', () => $.command.register({ name: 'rft-concepts', description: 'Print the concept tree (/rft-concepts suggest: ask Claude to propose a concept split)', argumentHint: '[suggest]' }))
  await attempt('rft-literature', () => $.command.register({ name: 'rft-literature', description: 'Ask Claude for a literature search on a topic, a note or a concept, ending in reference notes', argumentHint: '<topic, note id or concept>' }))
  await attempt('rft-rebalance', () => $.command.register({ name: 'rft-rebalance', description: 'Ask Claude to propose moving branches under the line of research they belong to; nothing moves until you confirm', argumentHint: '[concept or note id] [--full]' }))
  await attempt('rft-next', () => $.command.register({ name: 'rft-next', description: 'What is still open, by concept: running and planned experiments, unexplored directions, open questions', argumentHint: '[concept]' }))
  await attempt('rft-machine', () => $.command.register({ name: 'rft-machine', description: 'Pair this machine with the experiment queue (add: checked at no model turn, then Claude asks you where outputs go and which GPUs to keep, and turns the queue on), or show how it stands', argumentHint: '[add|status]' }))
  await attempt('rft-jobs', () => $.command.register({ name: 'rft-jobs', description: 'The experiment queue: GPUs, jobs running and waiting, the ones that ended (no model turn)', argumentHint: '[job or experiment]' }))
  await attempt('rft-summarize', () => $.command.register({ name: 'rft-summarize', description: 'Ask Claude to write the missing one-line note summaries and concept digests (the project map)', argumentHint: '[concept]' }))
  await attempt('rft-manuscript', () => $.command.register({ name: 'rft-manuscript', description: 'Start snippets (LaTeX building blocks resting on verified notes) and documents (built from copies of them), add a document, or ask Claude what to write next and where to place it', argumentHint: '[document] | new <name> [article|report]' }))
  await attempt('rft-artifact', () => $.command.register({ name: 'rft-artifact', description: "Ask Claude to write a concept's artifact, the page of its experiments' results (no concept: every one missing or out of date)", argumentHint: '[concept]' }))
  await attempt('rft-update', () => $.command.register({ name: 'rft-update', description: 'Bring a vault made by an older version up to this one: shows what it adds; apply writes it. notebooks: run every notebook again in the queue and list what is still to write (--write: ask Claude to write it)', argumentHint: '[apply] [--sections] | notebooks [--write] [concept]' }))
  await attempt('rft-view', () => $.command.register({ name: 'rft-view', description: 'Write a standalone HTML view of the tree to <vault>/tree.html' }))
  await attempt('rft-inbox', () => $.command.register({ name: 'rft-inbox', description: 'Save a link to read later in the inbox (a URL, an arXiv id or a DOI), or with nothing after it print the inbox (no model turn)', argumentHint: '[<link> [urgent|high|medium|low] [why]]' }))
  await attempt('rft-handoff', () => $.command.register({ name: 'rft-handoff', description: 'Ask Claude to leave a handoff, so the work goes on in a new session (or after /clear) and not in a long one (show: print it; clear: remove it; no model turn)', argumentHint: '[show|clear|a note for the next session]' }))
  if (failed.length) reportFailures($, failed)
}

async function poll($: EngineInterface): Promise<void> {
  void submitPending($)
  try { await refresh($) } catch { /* tried again at the next tick */ }
  try { await watchQueue($) } catch { /* tried again at the next tick */ }
}

const strings = (v: unknown) => (Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : typeof v === 'string' ? v.split(',') : [])

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined)

const answer = (text: string, isError = false) =>
  isError ? { isError: true as const, result: text, text } : { result: text, text }

/** Git in a folder, through the host: no shell, the repo's hooks off. */
const gitOf = ($: EngineInterface): Git => async (dir, args) => {
  try {
    const r = await $.process.run(['git', '-C', dir, ...args], { timeoutMs: 20000 })
    return { ok: r.exitCode === 0, out: r.stdout, err: r.stderr }
  } catch (err) {
    return { ok: false, out: '', err: message(err) }
  }
}

async function homeOf($: EngineInterface): Promise<string | undefined> {
  try {
    return (await $.env.get('HOME')) || undefined
  } catch {
    return undefined
  }
}

/** The session's id, or '' where the host gives none. */
async function sessionId($: EngineInterface): Promise<string> {
  try {
    return (await $.session.id()) || ''
  } catch {
    return ''
  }
}

/** How the tools reach the code of the tree's concepts. */
const codeEnv = async ($: EngineInterface, h: Here): Promise<CodeEnv> => ({ root: h.root, git: gitOf($), home: await homeOf($), date: today() })

/**
 * `start` with the first Python on PATH that starts, `python3` then `python`: what it gave, and
 * which one. `what` names who asks, for the error when neither starts.
 */
async function withPython<T>(what: string, start: (python: string) => T | Promise<T>): Promise<{ python: string; got: T }> {
  const failures: string[] = []
  for (const python of ['python3', 'python']) {
    try {
      return { python, got: await start(python) }
    } catch (err) {
      failures.push(`${python}: ${message(err)}`)
    }
  }
  throw new Error(`${what} Python 3 on PATH (${failures.join('; ')})`)
}

/** server/rft_notebook.py with the first Python on PATH; its last line of output is its answer, as JSON. */
async function notebookHelper($: EngineInterface, args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
  const script = join($.plugin.root, 'server/rft_notebook.py')
  const { python, got: r } = await withPython('the notebooks need', python => $.process.run([python, script, ...args], { timeoutMs }))
  const last = r.stdout.trim().split('\n').pop() ?? ''
  try {
    const got: unknown = JSON.parse(last)
    if (got && typeof got === 'object') return got as Record<string, unknown>
  } catch { /* not its answer */ }
  return { ok: false, error: (r.stderr.trim() || r.stdout.trim() || `${python} exited with ${r.exitCode}`).split('\n').slice(-15).join('\n') }
}

/** How the notebook tools link and run notebooks: through server/rft_notebook.py. */
const notebookEnv = async ($: EngineInterface, h: Here): Promise<NotebookEnv> => ({
  root: h.root, home: await homeOf($), date: today(),
  queue: await queueOf(h),
  link: async (target, at) => {
    const r = await notebookHelper($, ['link', target, at], 20000)
    if (r.ok !== true) throw new Error(`the vault's link to the notebook was not made: ${String(r.error ?? 'no answer')}`)
  },
  apply: async (vault, exp, { timeoutS, record }) =>
    (await notebookHelper($, ['apply', '--vault', vault, '--exp', exp, '--timeout', String(timeoutS), '--date', today(), ...(record ? ['--record'] : [])], (timeoutS + 50) * 1000)) as ApplyOutcome,
})

const UNLOCK_ASK = {
  move: { doing: 'Moving it', yes: 'Move and unlock', anyway: 'Move it anyway?', kept: 'it was not moved' },
  supersede: { doing: 'Marking it as superseded', yes: 'Mark and unlock', anyway: 'Mark it anyway?', kept: 'it was not marked' },
  review: { doing: 'Setting it to review', yes: 'Review and unlock', anyway: 'Set it to review anyway?', kept: 'it stays verified' },
} as const

/**
 * A change that unlocks a locked note (a move, a supersede mark: each writes a History line into
 * its text). Tried locked first; a LockedChange asks the user in the session's own dialog, which
 * the model cannot answer, unless they agreed already in the tree view (`agreed`). A dismissed
 * dialog, or a run with no one to ask, keeps the note locked.
 */
async function unlocking($: EngineInterface, change: (unlock: boolean) => Promise<string>, agreed = false): Promise<string> {
  try {
    return await change(agreed)
  } catch (err) {
    if (!(err instanceof LockedChange)) throw err
    const say = UNLOCK_ASK[err.change]
    let answer = ''
    try {
      answer = await $.ui.ask(`${err.node.name} is locked. ${say.doing} unlocks it and adds a line to its History. ${say.anyway}`,
        { options: [say.yes, 'Keep it locked'], header: 'Locked note' })
    } catch { /* dismissed, or no one to ask */ }
    if (answer !== say.yes) throw new Error(`${err.node.name} is locked and the user kept it locked: ${say.kept}. Do not try again unless the user asks.`)
    return change(true)
  }
}

/**
 * Runs one of the rft tools; its text is the tool's result. `view`: what the tree view's request
 * carries beyond the tool's input (that the user agreed there to unlock the note); never the
 * model's.
 */
/** One note of an rft_add_node call, as addNode takes it. */
function addInput(i: Record<string, unknown>): AddInput {
  const sections: Record<string, string> = {}
  for (const [k, v] of Object.entries((i.sections as Record<string, unknown> | undefined) ?? {})) if (str(v)) sections[k] = String(v)
  if (str(i.what)) sections.What = String(i.what)
  if (str(i.why)) sections.Why = String(i.why)
  if (str(i.idea)) sections.Idea = String(i.idea)
  if (str(i.result)) sections.Result = String(i.result)
  return {
    type: i.type as NodeType, title: String(i.title ?? ''), parent: str(i.parent) ?? null,
    status: str(i.status), date: today(), sections, code: str(i.code), tags: strings(i.tags), refs: strings(i.refs), summary: str(i.summary),
    suggestedPriority: str(i.suggested_priority), priorityWhy: str(i.priority_why),
  }
}

/** What rft_validate reports: the vault's check with the map's, the artifacts', the manuscript's and the decks' warnings. */
async function vaultCheck($: EngineInterface, h: Here, loaded: Loaded): Promise<Validation> {
  const v = await validate(h.io, loaded, { root: h.root, home: await homeOf($) })
  v.warnings.push(...(await mapWarnings(h.io, loaded)), ...(await artifactWarnings(h.io, loaded)), ...(await manuscriptWarnings(h.io, loaded)), ...(await deckWarnings(h.io, loaded)))
  return v
}

async function runTool($: EngineInterface, name: string, i: Record<string, unknown>, view: { unlock?: boolean } = {}): Promise<string> {
  const h = await mustHere($)
  const io = h.io
  const loaded = await loadActive(io)
  switch (name) {
    case 'rft_add_node': {
      // one note, or a list whose notes take the fields given beside it unless they give their own
      const { notes, ...shared } = i
      const list = Array.isArray(notes)
        ? notes.map(n => (n && typeof n === 'object' ? { ...shared, ...(n as Record<string, unknown>) } : shared))
        : [i]
      const nodes = await addNodes(io, loaded, list.map(addInput), await codeEnv($, h))
      const ids = nodes.map(n => n.id)
      const vault = shownVault(h, loaded.config)
      return [
        ...nodes.map(node => {
          const similar = similarNotes(loaded, node.id, 3, ids)
          return `${node.report}\nId: ${node.id}\nNote: ${join(vault, node.path)}${similar ? `\n${similar}` : ''}`
        }),
        checkLine(await vaultCheck($, h, loaded), ids),
      ].join(nodes.length > 1 ? '\n\n' : '\n')
    }
    case 'rft_set_repos':
      return setRepos(io, loaded, await codeEnv($, h), String(i.id ?? ''), strings(i.repos))
    case 'rft_code':
      return codeReport(io, loaded, await codeEnv($, h), String(i.id ?? ''))
    case 'rft_set_code':
      return setCode(io, loaded, await codeEnv($, h), String(i.id ?? ''), typeof i.text === 'string' ? i.text : undefined, typeof i.reproduce === 'string' ? i.reproduce : undefined)
    case 'rft_set_notebook':
      return setNotebook(io, loaded, await notebookEnv($, h), String(i.id ?? ''), { cells: i.cells, file: i.file, replace: i.replace })
    case 'rft_run_notebook':
      return runNotebook(io, loaded, await notebookEnv($, h), String(i.id ?? ''), { timeout: i.timeout, record: i.record })
    case 'rft_move_node':
      return unlocking($, unlock => moveNode(io, loaded, String(i.id ?? ''), String(i.parent ?? ''), today(), str(i.why), unlock), view.unlock)
    case 'rft_set_refs':
      return setRefs(io, loaded, String(i.id ?? ''), strings(i.refs))
    case 'rft_search':
      return searchReport(loaded, str(i.query) ?? '', { type: str(i.type), status: str(i.status), concept: str(i.concept), tag: str(i.tag) },
        typeof i.limit === 'number' && i.limit > 0 ? Math.min(50, Math.floor(i.limit)) : 10, await readDigests(io, loaded))
    case 'rft_graph':
      return graphReport(loaded, String(i.id ?? ''), i.mode === 'path' ? 'path' : 'around')
    case 'rft_collect_papers':
      return collectPapers($, h, loaded, strings(i.ids))
    case 'rft_set_tags':
      return setTags(io, loaded, String(i.id ?? ''), strings(i.tags))
    case 'rft_set_type':
      return setType(io, loaded, String(i.id ?? ''), String(i.type ?? ''))
    case 'rft_set_concept':
      return setConcept(io, loaded, String(i.id ?? ''), typeof i.name === 'string' ? i.name : null, typeof i.summary === 'string' ? i.summary : undefined)
    case 'rft_concepts':
      return conceptsReport(loaded)
    case 'rft_tags':
      return tagsReport(loaded)
    case 'rft_inbox':
      // no reading priority here: it is the user's (/rft-inbox, the page, the file)
      return str(i.link)?.trim()
        ? addItem(io, loaded, { link: str(i.link)!, why: str(i.why), title: str(i.title), today: today() })
        : inboxReport(await loadInbox(io, loaded.config.vault))
    case 'rft_handoff': {
      const vault = loaded.config.vault
      if (i.clear === true) return clearHandoff(io, vault, h.cwd)
      const now = await nowS($)
      if (!str(i.done) && !str(i.next) && !str(i.unrecorded)) return showHandoff(io, vault, str(i.folder)?.trim() ?? h.cwd, now)
      // what the plugin checks itself: the session's folder, the tree's and the concepts' code
      const repos = Object.values(loaded.tree.concepts ?? {}).flatMap(c => c.repos ?? [])
      const uncommitted = async () => uncommittedIn(io, await codeEnv($, h), [h.cwd, h.root, ...repos])
      return leaveHandoff(io, vault, { done: str(i.done), next: str(i.next), unrecorded: str(i.unrecorded) }, { folder: h.cwd, session: await sessionId($), now, uncommitted })
    }
    case 'rft_set_status':
      return unlocking($, unlock => setStatus(io, loaded, String(i.id ?? ''), String(i.status ?? ''), str(i.note), str(i.summary), today(), unlock))
    case 'rft_manuscript_view': {
      // the Manuscript tab's + Snippet, Reviewed and + Document (never a tool of the model's: only FROM_VIEW reaches it)
      if (i.action === 'reviewed') return markReviewed(io, loaded, String(i.id ?? ''), today())
      if (i.action === 'document') return newDocument(io, loaded, String(i.name ?? ''), i.kind === 'report' ? 'report' : 'article', str(i.title))
      if (i.action === 'place' || i.action === 'move' || i.action === 'remove') {
        return setDocument(io, loaded, { name: String(i.name ?? ''), [i.action]: String(i.id ?? ''), after: str(i.after) })
      }
      if (i.action === 'take' || i.action === 'keep') return reviewCopy(io, loaded, String(i.name ?? ''), String(i.id ?? ''), i.action)
      return setSnippet(io, loaded, { kind: i.kind, title: i.title, basis: strings(i.basis) }, today(), { byUser: true })
    }
    case 'rft_verify': {
      // the tree view's Verify, Dismiss and Back to review (never a tool of the model's: only FROM_VIEW reaches it)
      const id = String(i.id ?? '')
      if (i.action === 'dismiss') return dismissVerified(io, loaded, id)
      if (i.action === 'review') return toReview(io, loaded, id, 'by the user', today(), true)
      return verifyNote(io, loaded, id, today())
    }
    case 'rft_suggest_dates':
      return suggestDates(io, loaded, String(i.id ?? ''), { start: i.start, est: i.est }, i.why)
    case 'rft_suggest_deadline':
      return suggestDeadline(io, loaded, { title: i.title, due: i.due, needs: i.needs, source: i.source, why: i.why })
    case 'rft_add_deadline': {
      const d = checkDeadline(loaded, { title: i.title, due: i.due, needs: i.needs })
      let answer = ''
      try {
        answer = await $.ui.ask(deadlineQuestion(d), { options: ['Add it', "Don't add"], header: 'Deadline' })
      } catch { /* dismissed, or no one to ask */ }
      if (answer !== 'Add it') return `The user did not add it: no deadline was written. Do not try again unless the user asks.`
      return addDeadline(io, loaded, d)
    }
    case 'rft_add_meeting': {
      const d = checkMeeting(loaded, { title: i.title, when: i.when, duration: i.duration, every: i.every, until: i.until, needs: i.needs })
      let answer = ''
      try {
        answer = await $.ui.ask(meetingQuestion(d), { options: ['Add it', "Don't add"], header: 'Meeting' })
      } catch { /* dismissed, or no one to ask */ }
      if (answer !== 'Add it') return `The user did not add it: no meeting was written. Do not try again unless the user asks.`
      return addMeeting(io, loaded, d)
    }
    case 'rft_suggest_priority':
      return suggestPriority(io, loaded, String(i.id ?? ''), i.priority, i.why)
    case 'rft_set_summary': {
      const given: Record<string, string> = {}
      for (const [k, v] of Object.entries((i.summaries as Record<string, unknown> | undefined) ?? {})) if (typeof v === 'string') given[k] = v
      if (!Object.keys(given).length) throw new Error('summaries is empty: give {"<id>": "<one line>"}')
      return setSummaries(io, loaded, given)
    }
    case 'rft_supersede':
      return unlocking($, unlock => supersede(io, loaded, String(i.id ?? ''), str(i.by) ?? null, str(i.why), today(), unlock))
    case 'rft_next':
      return withInbox(await withJobs(await nextReport(io, loaded, today(), str(i.concept)), io, loaded, await nowS($)), io, loaded, str(i.concept))
    case 'rft_queue': {
      const exp = resolveId(loaded.tree, String(i.exp ?? ''))
      const n = exp ? loaded.tree.nodes[exp] : undefined
      if (!n || n.type !== 'experiment') throw new Error(`"${String(i.exp ?? '')}" is not an experiment of the tree: a job runs an experiment (E..), whose note comes first (rft_add_node)`)
      // its outputs go under the paired machine's runs_dir (machine.json), which the runner gives a job naming none
      const spec = {
        exp: n.id, cmd: String(i.cmd ?? ''), cwd: resolvePath(h.cwd, str(i.cwd) ?? '.'),
        gpus: typeof i.gpus === 'number' ? i.gpus : n.gpus ?? 1, label: str(i.label) ?? '', by: 'claude',
      }
      const r = await queueCli($, h, loaded.config, ['add', '--job', JSON.stringify(spec), ...(i.top === true ? ['--top'] : [])])
      return addedText(r as { job: Job }, loaded, shownVault(h, loaded.config))
    }
    case 'rft_jobs': {
      const ref = str(i.id)?.trim()
      const v = await queueCli($, h, loaded.config, ['status', '--history', '10']) as unknown as QueueView
      const lines = typeof i.log === 'number' ? Math.min(200, Math.max(0, Math.floor(i.log))) : 0
      const log = ref && /^q\d+$/i.test(ref) && lines
        ? String((await queueCli($, h, loaded.config, ['log', '--id', ref.toLowerCase(), '--lines', String(lines)])).text ?? '')
        : undefined
      return jobsReport(v, loaded, await nowS($), { ref, log })
    }
    case 'rft_job': {
      const action = String(i.action ?? '')
      const id = String(i.id ?? '').trim().toLowerCase()
      if (action === 'pause' || action === 'resume') {
        await queueCli($, h, loaded.config, [action])
        return action === 'pause' ? 'Paused: no new job starts; the jobs running go on. rft_job resume starts them again.' : 'Resumed: the waiting jobs start as their GPUs free.'
      }
      if (!['move', 'cancel', 'retry'].includes(action)) throw new Error(`action is one of move, cancel, retry, pause, resume (not "${action}")`)
      if (!/^q\d+$/.test(id)) throw new Error(`${action} needs the id of a job, e.g. q7 (rft_jobs lists them)`)
      if (action === 'move') {
        const r = await queueCli($, h, loaded.config, ['move', '--id', id, '--before', str(i.before)?.trim().toLowerCase() || 'end'])
        return movedText(r as unknown as Parameters<typeof movedText>[0])
      }
      if (action === 'retry') {
        const r = await queueCli($, h, loaded.config, ['retry', '--id', id])
        return retriedText(r as { job: Job; outlook?: string })
      }
      const r = await queueCli($, h, loaded.config, ['cancel', '--id', id, '--why', str(i.why) ?? 'cancelled by Claude'])
      return cancelledText(r.job as Job, loaded, await nowS($))
    }
    case 'rft_machine': {
      const action = String(i.action ?? '')
      if (action === 'probe') {
        const p = await machineProbe($, h, loaded.config)
        return `${probeText(p)}${p.eligible ? '\n\nNext: ask the user where the runs\' outputs go and which GPUs to keep out of the queue, then rft_machine add.' : ''}`
      }
      if (action === 'status') return statusText(await machineStatus($, h, loaded.config))
      if (action !== 'add') throw new Error(`action is probe, add or status (not "${action}")`)
      const keep = Array.isArray(i.keep_out) ? i.keep_out.filter((x): x is number => Number.isInteger(x)) : []
      const runs = await runsRoot($, h, loaded.config, str(i.runs_dir))
      const r = await queueCli($, h, loaded.config, ['machine', 'add', ...(runs ? ['--runs', runs] : []), ...(keep.length ? ['--keep', keep.join(',')] : [])])
      const st = r.status as MachineStatus
      if (r.already) return statusText(st, { already: true })
      await queueOn($)
      return `${statusText(st)}\n\nThe experiment queue is on: the tree view shows its monitor, and from now on every run of an experiment goes through rft_queue (its tools load from your next turn). Its rule, for the rest of this session:\n${QUEUE_RULE}`
    }
    case 'rft_map':
      return mapReport(io, loaded, str(i.concept))
    case 'rft_set_digest':
      return setDigest(io, loaded, String(i.concept ?? ''), String(i.state ?? ''), String(i.text ?? ''), today())
    case 'rft_artifact':
      return artifactReport(io, loaded, String(i.concept ?? ''), { full: i.full === true, notes: strings(i.notes), section: str(i.section) })
    case 'rft_set_artifact':
      return setArtifact(io, loaded, String(i.concept ?? ''), { html: i.html, edits: i.edits }, today())
    case 'rft_manuscript':
      return manuscriptReport(io, loaded, str(i.ref))
    case 'rft_set_snippet':
      return setSnippet(io, loaded, {
        id: str(i.id), kind: i.kind, title: i.title, basis: i.basis === undefined ? undefined : strings(i.basis), outline: i.outline,
        text: i.text, edits: i.edits,
      }, today())
    case 'rft_set_document':
      return setDocument(io, loaded, { name: str(i.name), place: str(i.place), move: str(i.move), remove: str(i.remove), after: str(i.after) })
    case 'rft_tree':
      return treeReport(loaded, { root: str(i.root), depth: typeof i.depth === 'number' ? i.depth : undefined, vault: shownVault(h, loaded.config) })
    case 'rft_validate': {
      const v = await vaultCheck($, h, loaded)
      const lines = [v.errors.length
        ? `FAILED: ${v.errors.length} error(s), ${v.warnings.length} warning(s).`
        : `OK: no errors, ${v.warnings.length} warning(s).`]
      if (v.errors.length) lines.push('Errors:', ...v.errors.map(x => `- ${x}`))
      if (v.warnings.length) lines.push('Warnings:', ...v.warnings.map(x => `- ${x}`))
      return lines.join('\n')
    }
    case 'rft_comments':
      return commentsReport(io, loaded, str(i.id))
    case 'rft_comment':
      return addComment(io, loaded, { id: String(i.id ?? ''), thread: str(i.thread), quote: typeof i.quote === 'string' ? i.quote : undefined, text: i.text, applied: i.applied === true })
    case 'rft_suggest':
      return addSuggestion(io, loaded, { id: String(i.id ?? ''), thread: str(i.thread), quote: typeof i.quote === 'string' ? i.quote : undefined, replacement: i.replacement, text: i.text })
    case 'rft_sync': {
      const r = await sync(io, loaded, { relayout: i.relayout === true })
      // the check of the vault as the sync left it, so no rft_validate follows
      const check = checkLine(await vaultCheck($, h, await loadActive(io)), null)
      return `${r.changed.length
        ? `Updated ${r.changed.length} file(s):\n${r.changed.map(c => `- ${c}`).join('\n')}`
        : 'Everything was already in sync.'}\n${check}`
    }
    default:
      throw new Error(`unknown rft tool ${name}`)
  }
}

async function selectNode($: EngineInterface, id: string): Promise<void> {
  if ((await read($, selected)) === id) {
    await update($, selected, () => null)
    await update($, note, () => null)
    return
  }
  const s = await read($, snapshot)
  const n = s?.nodes[id]
  if (!s || !n) return
  let text: string
  try { text = await $.fs.read(join(s.vault, n.path)) } catch { text = '(the note could not be read)' }
  await update($, selected, () => id)
  await update($, note, () => ({ id, text }))
}

async function toggleFold($: EngineInterface, id: string): Promise<void> {
  await update($, collapsed, list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]))
}

async function foldAll($: EngineInterface, ids: string[]): Promise<void> {
  await update($, collapsed, () => ids)
}

// ---------------------------------------------------------------- the web view's server

// the running server, one per session and kept across a /clear; a reload of the module kills the
// child with it
let server: { url: string; stop: () => void } | null = null

/** Starts the web view's server, or answers the running one's URL. */
async function startServer($: EngineInterface): Promise<string> {
  if (server) return server.url
  const h = await mustHere($)
  const config = await readConfig(h.io)
  if (!config) throw new Error(NOT_ACTIVE)
  const vault = vaultOf(h, config)
  const root = $.plugin.root
  const args = [
    join(root, 'server/rft_server.py'), '--vault', vault, '--web', join(root, 'web'),
    '--project', config.project, '--port', String(config.webPort ?? 0),
    '--config', join(h.root, CONFIG_PATH),
  ]
  return (await withPython('the web view needs', python => spawnServer($, [python, ...args]))).got
}

/** Runs one server child for the session and resolves its URL once it listens. */
async function spawnServer($: EngineInterface, argv: string[]): Promise<string> {
  const child = $.process.spawn({ argv })
  let found: (url: string) => void = () => undefined
  let failed: (err: Error) => void = () => undefined
  const listening = new Promise<string>((resolve, reject) => { found = resolve; failed = reject })
  // the loop is the child's life: it runs on after this call returns, until the child exits,
  // `stop` ends it, or the module unloads
  void (async () => {
    let line = ''
    let err = ''
    try {
      for await (const chunk of child) {
        if (chunk.stream === 'stdout') {
          // whole lines: the address once, then a line for each note the tree view adds
          const lines = (line + chunk.text).split('\n')
          line = lines.pop()!
          for (const l of lines) {
            const m = /RFT_SERVER_URL (\S+)/.exec(l)
            if (m) found(m[1]!)
            else if (l.startsWith(ASK)) void askFromView($, l.slice(ASK.length))
            else {
              const asked = FROM_VIEW.find(a => l.startsWith(a.line))
              if (asked) void fromView($, asked, l.slice(asked.line.length))
            }
          }
        } else err += chunk.text
      }
      failed(new Error(err.trim().split('\n').pop() || 'the server exited'))
    } catch (e) {
      failed(e instanceof Error ? e : new Error(String(e)))
    }
    if (server?.stop === stop) {
      server = null
      try { await update($, webUrl, () => null) } catch { /* the session is gone */ }
    }
  })()
  const stop = () => { void child.return?.(undefined as never) }
  const late = $.clock.sleep(8000).then(() => { throw new Error('the server did not start within 8 s') })
  late.catch(() => undefined)
  try {
    const url = await Promise.race([listening, late])
    server = { url, stop }
    await update($, webUrl, () => url)
    return url
  } catch (err) {
    stop()
    throw err
  }
}

const FROM_VIEW = [
  { line: 'RFT_ADD_NODE ', tool: 'rft_add_node', fields: ['type', 'parent', 'title'], what: 'add a note' },
  { line: 'RFT_SET_TYPE ', tool: 'rft_set_type', fields: ['id', 'type'], what: "change a note's type" },
  { line: 'RFT_MOVE_NODE ', tool: 'rft_move_node', fields: ['id', 'parent'], what: 'move a note' },
  { line: 'RFT_VERIFY ', tool: 'rft_verify', fields: ['id', 'action'], what: 'verify a note' },
  { line: 'RFT_MANUSCRIPT ', tool: 'rft_manuscript_view', fields: ['action', 'id', 'kind', 'title', 'basis', 'name', 'after'], what: 'change the snippets or documents' },
] as const

/**
 * A change the tree view asks for (POST api/node, api/type or api/move, relayed by the server). A
 * move with `unlock: true` was agreed in the page, which warned that the note is locked.
 */
async function fromView($: EngineInterface, asked: (typeof FROM_VIEW)[number], request: string): Promise<void> {
  try {
    const r = JSON.parse(request) as Record<string, unknown>
    await runTool($, asked.tool, Object.fromEntries(asked.fields.map(f => [f, r[f]])), { unlock: r.unlock === true })
    await refresh($, true)
  } catch (err) {
    $.ui.toast(`rft: the tree view could not ${asked.what} (${message(err)})`)
  }
}

const ASK = 'RFT_ASK '

/**
 * A thread the user asks Claude to answer from the tree view (its Ask Claude, relayed by the
 * server): a prompt with the thread, submitted by the poller as a turn of its own.
 */
async function askFromView($: EngineInterface, request: string): Promise<void> {
  try {
    const r = JSON.parse(request) as Record<string, unknown>
    const h = await mustHere($)
    const loaded = await loadActive(h.io)
    const n = await subjectOf(h.io, loaded, String(r.id ?? ''))
    const id = n.id
    const c = await readComments(h.io, loaded.config.vault, id)
    const thread = String(r.thread ?? '')
    const path = join(shownVault(h, loaded.config), n.path)
    await answerInSubagent($, { id, thread, what: `thread ${thread} on ${id}` }, subagentAskText(n, c, thread, path), () => askText(n, c, thread, path))
  } catch (err) {
    $.ui.toast(`rft: the tree view could not ask Claude (${message(err)})`)
  }
}

// ---------------------------------------------------------------- answers in a subagent

/**
 * The agent type that answers a thread: it only reads, and its final message is the answer, which
 * the plugin writes into the thread when it ends. A subagent the plugin starts runs beneath the
 * plugin's own call, where the plugin's hooks (its tools, the guards of locked notes, priorities
 * and dates) do not answer it, so it is given neither the rft tools nor a tool that writes.
 */
const THREAD_AGENT = {
  name: 'thread',
  description: 'Answers a comment or suggestion thread of the rft tree view (started by the plugin only).',
  prompt: 'You answer one discussion thread on a note of a research project\'s reasoning tree (rft); the notes are markdown files in the vault. The task says which thread and what your final message holds: the plugin writes it into the thread as it is, so it is the answer itself, with nothing about what you did.',
  tools: ['Read', 'Grep', 'Glob'],
} as const
// `rft:thread` once registered; until then (or when refused) the general-purpose agent answers
let threadAgent: string | null = null
// the subagents answering threads
const answers = new Answers()

async function registerThreadAgent($: EngineInterface): Promise<void> {
  if (threadAgent) return
  try {
    threadAgent = (await $.agent.register({ ...THREAD_AGENT, tools: [...THREAD_AGENT.tools] })).agent
  } catch { /* the general-purpose agent instead */ }
}

/**
 * Answers a thread in a background subagent, so the main conversation does not grow with each
 * Ask Claude; when no subagent can start, as a turn of the session, as before.
 */
async function answerInSubagent($: EngineInterface, job: ThreadJob, prompt: string, inSession: () => string): Promise<void> {
  try {
    if (!threadAgent) throw new Error('no thread agent')
    const r = await $.agent.spawn({ prompt, description: `rft: answer ${job.what}`, subagentType: threadAgent })
    const deny = (r as { deny?: string }).deny
    if (deny || !r.agentId) throw new Error(deny ?? 'no subagent started')
    answers.watch(r.agentId, job)
    $.ui.toast(`rft: Claude is answering ${job.what} in the background`)
  } catch {
    pendingPrompts.push(inSession())
  }
}

// ---------------------------------------------------------------- papers

const PAPER = 'RFT_PAPER '
const PAPERS_DONE = 'RFT_PAPERS_DONE '

/** Starts the background download of reference papers (server/rft_papers.py); answers at once. */
async function collectPapers($: EngineInterface, h: Here, loaded: Loaded, ids: string[]): Promise<string> {
  const plan = planPapers(loaded, ids.map(id => resolveId(loaded.tree, id) ?? id))
  const lines: string[] = []
  const fetches = plan.jobs.filter(j => j.op === 'fetch').length
  const moves = plan.jobs.length - fetches
  if (plan.jobs.length) {
    const args = [join($.plugin.root, 'server/rft_papers.py'), '--vault', vaultOf(h, loaded.config), '--jobs', JSON.stringify(plan.jobs), '--hosts', OPEN_HOSTS.join(',')]
    await withPython('collecting papers needs', python => runPapers($, h, $.process.spawn({ argv: [python, ...args] })))
    lines.push(`Started in the background: ${fetches} paper(s) to download${moves ? `, ${moves} to move to their concept's folder` : ''}. Each note gets a pdf: link when its file is saved; a toast says when all are done.`)
  } else lines.push('Nothing to download or move.')
  if (plan.saved.length) lines.push(`Already saved: ${plan.saved.join(', ')}.`)
  if (plan.skipped.length) lines.push('Not downloaded:', ...plan.skipped.map(s => `- ${s.id}: ${s.why}`))
  return lines.join('\n')
}

/** Follows the downloader: links each saved file from its note, one note at a time, then reports. */
function runPapers($: EngineInterface, h: Here, child: ReturnType<EngineInterface['process']['spawn']>): void {
  let chain = Promise.resolve()
  const failed: string[] = []
  void (async () => {
    let line = ''
    try {
      for await (const chunk of child) {
        if (chunk.stream !== 'stdout') continue
        const lines = (line + chunk.text).split('\n')
        line = lines.pop()!
        for (const l of lines) {
          if (l.startsWith(PAPER)) {
            const r = JSON.parse(l.slice(PAPER.length)) as { id: string; ok: boolean; file?: string; error?: string }
            if (!r.ok) { failed.push(`${r.id} (${r.error})`); continue }
            chain = chain.then(() => linkPaper(h, r.id, r.file!)).catch(err => { failed.push(`${r.id} (${message(err)})`) })
          } else if (l.startsWith(PAPERS_DONE)) {
            const d = JSON.parse(l.slice(PAPERS_DONE.length)) as { ok: number; failed: number }
            await chain
            $.ui.toast(`rft: ${d.ok} paper(s) saved in the vault's papers/ folder${failed.length ? `; not saved: ${failed.join(', ')}` : ''}`)
            await refresh($, true)
          }
        }
      }
    } catch (err) {
      $.ui.toast(`rft: collecting papers stopped (${message(err)})`)
    }
  })()
}

/**
 * Writes `pdf: "[[<file>]]"` into the reference note, or for one paper of a literature note
 * (`R05#2`) a `PDF:` line in its entry (read afresh: the user may have edited it).
 */
async function linkPaper(h: Here, job: string, file: string): Promise<void> {
  const { id, entry } = jobNote(job)
  const loaded = await loadActive(h.io)
  const n = loaded.tree.nodes[id]
  if (!n) return
  const text = loaded.texts[id]!
  const next = entry ? withEntryPdf(text, entry, file) : setField(text, 'pdf', `"[[${file}]]"`, 'tags')
  if (next !== text) await h.io.write(join(loaded.config.vault, n.path), next)
}

// ---------------------------------------------------------------- the experiment queue

/** Seconds since the epoch, on the session's clock. */
const nowS = async ($: EngineInterface) => (await $.clock.now()) / 1000

/**
 * Runs the queue's command line (server/rft_queue.py) on the tree's vault: its JSON answer, or
 * its error as it says it. Each call is one short process; the jobs run in the queue's runner.
 */
async function queueCli($: EngineInterface, h: Here, config: Config, args: string[]): Promise<Record<string, unknown>> {
  const [verb, ...rest] = args
  const argv = [join($.plugin.root, QUEUE_CLI), verb!, '--vault', vaultOf(h, config), ...rest]
  const { got: r } = await withPython('the experiment queue needs', python => $.process.run([python, ...argv], { timeoutMs: 30000 }))
  let out: Record<string, unknown> | null = null
  try { out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '') as Record<string, unknown> } catch { /* no answer */ }
  if (out && typeof out.error === 'string') throw new Error(out.error)
  if (r.exitCode === 0 && out) return out
  throw new Error(`the experiment queue failed (${r.stderr.trim().split('\n').pop() || `exit ${r.exitCode}`})`)
}

/** rft_next with the queue's part after it. */
async function withJobs(report: string, io: Io, loaded: Loaded, now: number): Promise<string> {
  try {
    if (!(await readMachine(io, loaded.config.vault))) return report // no machine paired: no queue
    const part = jobsNext(await readQueue(io, loaded.config.vault), loaded, now)
    return part ? `${report}\n\n${part}` : report
  } catch {
    return report
  }
}

/** rft_next with a line on the inbox after it, when something waits there and no one concept was asked for. */
async function withInbox(report: string, io: Io, loaded: Loaded, concept?: string): Promise<string> {
  if (concept?.trim()) return report
  try {
    const line = inboxLine(await loadInbox(io, loaded.config.vault))
    return line ? `${report}\n\n${line}` : report
  } catch {
    return report
  }
}

/** What the plugin reads of this machine for the queue (rft_queue.py machine probe), with no model. */
async function machineProbe($: EngineInterface, h: Here, config: Config): Promise<Probe> {
  const hint = await runsRoot($, h, config)
  return await queueCli($, h, config, ['machine', 'probe', ...(hint ? ['--runs-hint', hint] : [])]) as unknown as Probe
}

/** The pairing, and on the paired machine its queue (rft_queue.py machine status). */
const machineStatus = async ($: EngineInterface, h: Here, config: Config) =>
  await queueCli($, h, config, ['machine', 'status']) as unknown as MachineStatus

/** The experiment queue, when a machine is paired with it, for the notebook tools: the root of its runs' outputs. */
async function queueOf(h: Here): Promise<NotebookEnv['queue']> {
  const config = await readConfig(h.io)
  const m = config ? await readMachine(h.io, config.vault) : null
  return m ? { runsDir: m.runs_dir } : undefined
}

/** The root of the runs' outputs as given (`~/…`, or from the tree's folder), else the config's runsDir, made absolute. */
async function runsRoot($: EngineInterface, h: Here, config: Config, given?: string): Promise<string | undefined> {
  const path = given?.trim() || str(config.runsDir)
  return path ? repoAbs(h.root, path, await homeOf($)) : undefined
}

/** The queue turned on in this session (rft_machine add): its tools in the prompt from the next turn, its files followed. */
async function queueOn($: EngineInterface): Promise<void> {
  for (const name of QUEUE_TOOLS) {
    if (registeredTools.get(name) === false) continue
    const spec = TOOLS[name as keyof typeof TOOLS]
    try {
      await $.tool.register({ name, description: spec.description, inputSchema: spec.inputSchema as Record<string, unknown>, isDeferred: false })
      registeredTools.set(name, false)
    } catch (err) {
      $.ui.toast(`rft: could not set up tool ${name} (${message(err)})`)
    }
  }
  queueSeen = null
  try { await watchQueue($, true) } catch { /* at the next tick */ }
}

// the queue as last read (its queue.json, and what it said), to tell what changed since
let queueSeen: { text: string; view: QueueView } | null = null

/**
 * Follows the queue's files at each tick of the poll, at no model turn: a planned experiment whose
 * job started is set running, and each job that started or ended is a toast. `first`: the read at
 * activation, which sets what later reads compare with (and toasts nothing).
 */
async function watchQueue($: EngineInterface, first = false): Promise<QueueView | null> {
  const h = await locateHere($)
  if (!h || 'problem' in h) return null
  const config = await readConfig(h.io)
  if (!config) return null
  if (!(await h.io.exists(join(config.vault, MACHINE_FILE)))) {
    queueSeen = null
    return null
  }
  let text: string
  try {
    text = await h.io.read(join(config.vault, QUEUE_FILE))
  } catch {
    queueSeen = null
    return null
  }
  // a job leaves queue.json when it ends, so the history changes only with it
  if (!first && queueSeen?.text === text) return queueSeen.view
  const view = await readQueue(h.io, config.vault, 200, text)
  if (!view) return null
  const prev = first ? null : queueSeen?.view ?? null
  queueSeen = { text, view }
  const started = new Set<string>()
  for (const id of toStart(view, await loadActive(h.io))) {
    try {
      await setStatus(h.io, await loadActive(h.io), id, 'running', undefined, undefined, today())
      started.add(id)
    } catch (err) {
      $.ui.toast(`rft: ${id}'s job started, but it could not be set running (${message(err)})`)
    }
  }
  const events = jobEvents(prev, view)
  for (const line of events) {
    const exp = /^q\d+ \((E\d+)\) started/.exec(line)?.[1]
    $.ui.toast(`rft: job ${line}${exp && started.delete(exp) ? `; ${exp} is now running` : ''}`)
  }
  for (const id of started) $.ui.toast(`rft: ${id} is now running: its job started in the queue`)
  if (events.length || started.size) await refresh($, true)
  return view
}

async function stopServer($: EngineInterface): Promise<boolean> {
  const was = server
  server = null
  was?.stop()
  await update($, webUrl, () => null)
  return was !== null
}

// ---------------------------------------------------------------- the desktop's browser pane

// the desktop app serves its built-in browser to the session as this MCP server
const BROWSER = 'Claude_Browser'

type BrowserOpen = { isOpened: true; isReused: boolean; isHidden: boolean } | { isOpened: false; why: string }

const textOf = (r: { content?: readonly { type: string; text?: string }[] }) =>
  (r.content ?? []).map(b => (b.type === 'text' ? b.text ?? '' : '')).join('\n')

/** The tabs `tabs_context` lists: its JSON, then a line saying whether the pane shows. */
function parseTabs(text: string): { tabs: { tabId: string; origin: string }[]; isHidden: boolean } {
  let tabs: { tabId: string; origin: string }[] = []
  try {
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { tabs?: { tabId: string; origin: string }[] }
    tabs = (json.tabs ?? []).filter(t => typeof t.tabId === 'string' && typeof t.origin === 'string')
  } catch { /* no tabs we can read: open a new one */ }
  return { tabs, isHidden: /hidden|not open/i.test(text.slice(text.lastIndexOf('}') + 1)) }
}

/**
 * Shows the tree view in the desktop's browser pane: the tab already on it when there is one,
 * else a new tab. Resolves why not when the session has no browser pane or a call fails.
 */
async function openInBrowser($: EngineInterface, url: string): Promise<BrowserOpen> {
  // the address carries the server's key (?token=); a tab is matched on scheme, host and port
  const origin = /^[a-z]+:\/\/[^/?#]+/i.exec(url)?.[0] ?? url
  try {
    let found: { tabId: string } | undefined
    let isHidden = false
    try {
      const ctx = await $.mcp.call(BROWSER, 'tabs_context', {})
      if (!ctx.isError) {
        const parsed = parseTabs(textOf(ctx))
        found = parsed.tabs.find(t => t.origin.replace(/\/+$/, '') === origin)
        isHidden = parsed.isHidden
      }
    } catch { /* tabs_context missing: preview_start still opens a tab */ }
    if (found) {
      const nav = await $.mcp.call(BROWSER, 'navigate', { url, tabId: found.tabId })
      if (nav.isError) throw new Error(textOf(nav) || 'navigate failed')
      const front = await $.mcp.call(BROWSER, 'tabs_select', { tabId: found.tabId })
      if (front.isError) throw new Error(textOf(front) || 'tabs_select failed')
      return { isOpened: true, isReused: true, isHidden }
    }
    const opened = await $.mcp.call(BROWSER, 'preview_start', { url })
    if (opened.isError) throw new Error(textOf(opened) || 'preview_start failed')
    return { isOpened: true, isReused: false, isHidden: false }
  } catch (err) {
    return { isOpened: false, why: message(err) }
  }
}

async function isOnDesktop($: EngineInterface): Promise<boolean> {
  try {
    return (await $.session.surfaces()).includes('desktop')
  } catch {
    return false
  }
}

const webHelp = (url: string) => {
  const port = /:(\d+)\//.exec(url)?.[1] ?? '<port>'
  return [
    `Tree view: ${url}`,
    'Open it in the desktop app\'s built-in browser (Ctrl+Shift+B, Cmd+Shift+B on macOS) and paste the URL in its address bar, or in any browser on this machine.',
    `On a remote machine, forward the port first: ssh -L ${port}:127.0.0.1:${port} <host>, then open ${url} locally.`,
    'The outline stays in the pane; /rft stop stops the server.',
  ].join('\n')
}

/** Submits the prompts a command or the tree view queued; called from the poller, outside any command's dispatch. */
async function submitPending($: EngineInterface): Promise<void> {
  while (pendingPrompts.length) {
    const text = pendingPrompts.shift()!
    try {
      await $.prompt.submit({ text })
    } catch (err) {
      $.ui.toast(`rft: could not ask Claude (${message(err)}); ask it yourself, e.g. "${text.split('\n')[0]!.slice(0, 80)}"`)
    }
  }
}

/** Why Claude may not make this tool call (an edit or a shell command the guards of lib/guards refuse), or null. */
async function refused($: EngineInterface, e: Record<string, unknown>): Promise<string | null> {
  const tool = String(e.tool)
  if (!isGuarded(tool)) return null
  const s = await read($, snapshot)
  if (!s?.isActive || !s.vault) return null
  return refusal(tool, e, { io: ioOf($), vault: s.vault, cwd: resolvePath(await $.session.cwd(), '.'), nodes: Object.values(s.nodes) })
}

/**
 * /rft-update notebooks [--write] [concept]: brings an older vault's notebooks up to what the plugin
 * does now. Without --write, at no model turn: every notebook runs again in the queue (one job,
 * no GPU, one notebook after another, in check mode), so each saves its numbers, figures and
 * tables, and the report lists, by concept with code, what is still to write. With --write, the
 * same report, and a prompt asking Claude to write it, concept by concept.
 */
async function updateNotebooks($: EngineInterface, words: string[]): Promise<string> {
  const write = words.includes('--write')
  const rest = words.filter(w => w !== '--write')
  const h = await mustHere($)
  const loaded = await loadActive(h.io)
  // experiment ids name the notebooks to write; anything else is a concept's name
  const ids = rest.map(w => resolveId(loaded.tree, w)).filter((id): id is string => !!id && loaded.tree.nodes[id]!.type === 'experiment')
  const name = ids.length ? '' : rest.join(' ').trim()
  const c = name ? resolveConcept(loaded.tree, name) : null
  if (name && !c) return `"${name}" is neither a concept nor an experiment id: /rft-concepts lists the concepts.`
  if (write && ids.length) {
    const has = ids.filter(id => loaded.tree.nodes[id]!.notebook)
    const todo = ids.filter(id => !loaded.tree.nodes[id]!.notebook)
    if (!todo.length) return `${has.join(', ')} already ${has.length === 1 ? 'has a notebook' : 'have notebooks'}.`
    pendingPrompts.push(notebooksPrompt(manualDir($.plugin.root), [], todo))
    return `Claude will write the notebook of ${todo.join(', ')} in a moment, from what each run saved, and check it against its note.${has.length ? ` (${has.join(', ')} already ${has.length === 1 ? 'has one' : 'have one'}.)` : ''}`
  }
  const gaps = await notebookGaps(h.io, loaded, c ?? undefined)
  if (write) {
    // a notebook is the user's choice: --write names what it is for
    if (!c) return 'A notebook is written only for what you choose: /rft-update notebooks --write <concept> (its experiments without one) or --write <experiment ids>.'
    if (!gaps.byConcept.length) return gapsText(gaps, null, c)
    pendingPrompts.push(notebooksPrompt(manualDir($.plugin.root), [c.name], []))
    return `${gapsText(gaps, null, c)}\n\nClaude will start in a moment on "${c.name}": it writes the missing notebooks from what the repo saved, checks each against its note, writes the concept notebook, and places their figures and tables on the artifact. It reads code and outputs, so this can take a while.`
  }
  let queued: string | null = null
  const all = gaps.experiments.length + gaps.concepts.length
  const off = !(await readMachine(h.io, loaded.config.vault))
  if (all && !off) {
    const vault = resolvePath(h.root, vaultOf(h, loaded.config))
    const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
    const root = loaded.tree.roots[0] ?? 'D00'
    const spec = {
      exp: c?.root ?? root, kind: 'notebook', gpus: 0, by: 'user', cwd: vault, label: `notebooks: run again (${all})`,
      cmd: `python3 ${sq(join($.plugin.root, 'server/rft_notebook.py'))} backfill --vault ${sq(vault)}${c ? ` --only ${sq(c.id)}` : ''}`,
    }
    const r = await queueCli($, h, loaded.config, ['add', '--job', JSON.stringify(spec)])
    queued = `Queued ${(r.job as Job).id}`
  }
  return gapsText(gaps, queued, c ?? undefined, off)
}

const NOT_ACTIVE = 'RFT is not active in this project. Run /rft-init [starting question] to set it up.'

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await registerCommands($)
    // a server of an earlier load of this module died with it
    if (!server) await update($, webUrl, () => null)
    // the desktop shows the tree view in its browser pane (/rft); the outline opens on asking
    await start($, options.autoOpen !== false && !(await isOnDesktop($)))

    return next(e)
  })

  // a /clear (or /resume) ends the session and goes on in a fresh one with no session.start: its
  // state starts empty and session.end stopped the poll, so the tree is taken up again here; the
  // commands, the tools, an open pane and, after a /clear, the tree view's server are still there
  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear' || e.source === 'resume') await start($, false)
    const url = server?.url
    if (e.source === 'clear' && url) await update($, webUrl, () => url)

    return next(e)
  })

  // a /clear goes on in the same folder, so the tree view's server, and a browser tab on it, live
  // on; any other end stops it (a resume may go on in another folder)
  on('session.end', async ($, e, next) => {
    poller?.cancel()
    poller = null
    if (e.reason !== 'clear') await stopServer($)

    return next(e)
  })

  // a thread's subagent finished: its final message goes into the thread, and its report is kept
  // from the main conversation
  on('turn.complete', async ($, e, next) => {
    const job = answers.ended(e.agentId)
    if (job) {
      try {
        if (e.isAborted || !e.answer?.trim()) throw new Error('stopped')
        const h = await mustHere($)
        await answerThread(h.io, await loadActive(h.io), job.id, job.thread, e.answer)
        $.ui.toast(`rft: ${job.what} answered in the tree view`)
        await refresh($, true)
      } catch (err) {
        $.ui.toast(`rft: ${job.what} was not answered (${message(err)})`)
      }
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (answers.isNotification(e.text, e.origin?.kind)) return { drop: 'rft: a thread answer, already in the tree view' }
    return next(e)
  })

  // every request carries the whole session: past 200k and 400k tokens the user is told, once
  // each, that a handoff and a new session cost less
  on('session.measure', async ($, e, next) => {
    const tell = rules ? toTell(e.context.tokens ?? 0, toldAt) : null
    if (tell) {
      toldAt = tell
      $.ui.toast(sizeToast(e.context.tokens ?? tell))
    }
    return next(e)
  })

  // the thread agent is the plugin's own: the model is not offered it
  on('agent.offer', { agent: 'rft:thread' }, () => ({ isOffered: false }))

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!rules) return composed

    return { ...composed, sections: [...composed.sections, { id: 'rft:rules', text: rules, scope: 'session' as const }] }
  })

  // ---------------------------------------------------------------- commands

  on('command.run', { command: 'rft' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'stop') return { text: (await stopServer($)) ? 'The tree view server is stopped.' : 'The tree view server was not running.' }
    const s = await refresh($, true)
    if (!s) {
      const was = await read($, snapshot)
      return { text: !was?.isActive && was?.error ? was.error : NOT_ACTIVE }
    }
    if (arg === 'text') {
      const h = await mustHere($)
      const loaded = await loadActive(h.io)
      return { text: treeReport(loaded, { vault: shownVault(h, loaded.config) }) }
    }
    const openList = () => { void $.ui.open({ id: PANE, title: TITLE, focus: true }).catch(() => undefined) }
    if (arg === 'list') {
      openList()
      return { text: 'Outline pane opened.' }
    }
    let url: string
    try {
      url = await startServer($)
    } catch (err) {
      openList()
      return { text: `The outline is in the pane, but the tree view could not start: ${message(err)}.\n/rft-view writes a standalone vault/tree.html instead.` }
    }
    // on the desktop the tree view opens in the app's own browser pane; elsewhere the outline
    // pane opens and the address is printed
    if (await isOnDesktop($)) {
      const shown = await openInBrowser($, url)
      if (shown.isOpened) {
        return {
          text: [
            `Tree view ${shown.isReused ? 'shown again' : 'opened'} in the browser pane: ${url}`,
            shown.isHidden ? 'The browser pane is hidden: press Ctrl+Shift+B (Cmd+Shift+B on macOS) to show it.' : '',
            '/rft list opens the outline pane; /rft stop stops the server.',
          ].filter(Boolean).join('\n'),
        }
      }
      $.ui.log(`rft: could not open the browser pane (${shown.why}); showing the address instead`, { to: 'debug' })
      openList()
      // the link leads the reply: a click opens it (the app asks where); why is in the debug log
      return { text: webHelp(url) }
    }
    openList()
    return { text: webHelp(url) }
  })

  on('command.run', { command: 'rft-init' }, async ($, e) => {
    const cwd = resolvePath(await $.session.cwd(), '.')
    // a folder that already works on a tree, its own, an enclosing one or a linked one, gets no second
    const h = await locateHere($)
    if (h && 'problem' in h) return { text: `${h.problem}. Fix or remove that link: /rft-init does not start a second tree under it.` }
    if (h && h.root !== cwd) {
      return { text: `RFT is already active here: this folder works on the reasoning tree in ${h.root}${h.link ? ` (linked by ${h.link})` : ''}. /rft-init does not start a second tree under it.` }
    }
    const project = cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'project'
    const question = e.args.trim()
    const res = await initVault(rooted(ioOf($), cwd), { project, question, date: today() })
    await activate($, true)
    const context = !res.isAdopted && !question
      ? ['The rft vault was created with a placeholder root note D00. Ask the user for the starting question of the project and write it into the Idea and Why sections of D00.']
      : undefined

    return { text: res.text, context }
  })

  on('command.run', { command: 'rft-concepts' }, async ($, e) => {
    try {
      const loaded = await loadActive((await mustHere($)).io)
      if (e.args.trim() !== 'suggest') return { text: conceptsReport(loaded) }
      // a prompt cannot be submitted from the command's own hook (the turn would wait on it), and a
      // timer started here ends with it: the session's poller submits it at its next tick
      pendingPrompts.push(suggestConceptsPrompt(manualDir($.plugin.root)))
      return { text: `${conceptsReport(loaded)}\n\nClaude will propose a concept split in a moment; nothing changes until you confirm it.` }
    } catch (err) {
      return { text: message(err) }
    }
  })

  on('command.run', { command: 'rft-literature' }, async ($, e) => {
    try {
      const loaded = await loadActive((await mustHere($)).io)
      const subject = e.args.trim()
      if (!subject) return { text: 'Usage: /rft-literature <topic, note id or concept>, e.g. /rft-literature D12 or /rft-literature "mixup on small data".' }
      // a note id, or a concept by name: its references go there
      const id = resolveId(loaded.tree, subject)
      const concept = Object.values(loaded.tree.concepts ?? {}).find(c => c.root && c.name.toLowerCase() === subject.toLowerCase())
      const where = id ? loaded.tree.nodes[id]!.name : concept ? `${loaded.tree.nodes[concept.root!]!.name} (the start of the concept "${concept.name}")` : null
      pendingPrompts.push(literaturePrompt(manualDir($.plugin.root), id ? `${loaded.tree.nodes[id]!.title}` : concept ? concept.name : subject, where))
      return { text: `Claude will search the literature on ${where ?? JSON.stringify(subject)} in a moment and write it as one literature note; notes for single papers, directions and experiments only after you choose.` }
    } catch (err) {
      return { text: message(err) }
    }
  })

  on('command.run', { command: 'rft-rebalance' }, async ($, e) => {
    try {
      const loaded = await loadActive((await mustHere($)).io)
      if (Object.keys(loaded.tree.nodes).length < 3) return { text: 'The tree has too few notes to rebalance.' }
      // --full: Claude reads the map of the whole tree; otherwise it judges the plugin's candidates
      const full = /(^|\s)--full(\s|$)/.test(e.args)
      const scope = e.args.replace(/(^|\s)--full(?=\s|$)/, ' ').trim()
      if (full) pendingPrompts.push(rebalancePrompt(manualDir($.plugin.root), scope))
      else {
        const list = candidates(loaded, { scope: scope || undefined })
        if (!list.length) return { text: `${conceptsReport(loaded)}\n\nNo note sits clearly closer to another concept than to its own${scope ? ` in ${scope}` : ''}: nothing to propose. /rft-rebalance --full asks Claude to look at the whole tree anyway.` }
        pendingPrompts.push(candidatesPrompt(manualDir($.plugin.root), scope, candidatesReport(loaded, list)))
      }
      // submitted by the poller, as for /rft-concepts suggest
      return { text: `${conceptsReport(loaded)}\n\nClaude will propose moves in a moment, as a table${full ? '' : ', from the candidates the plugin found'}; nothing moves until you confirm.` }
    } catch (err) {
      return { text: message(err) }
    }
  })

  // /rft-update: what an older vault lacks; `apply` writes it, then the derived files are synced
  on('command.run', { command: 'rft-update' }, async ($, e) => {
    try {
      const words = e.args.trim().split(/\s+/).filter(Boolean)
      if (words[0] === 'notebooks') return { text: await updateNotebooks($, words.slice(1)) }
      const unknown = words.filter(w => w !== 'apply' && w !== '--sections')
      if (unknown.length) return { text: `Usage: /rft-update [apply] [--sections] (not ${unknown.join(' ')}).` }
      const sections = words.includes('--sections')
      const io = (await mustHere($)).io
      const loaded = await loadActive(io)
      const plan = await planUpdate(io, loaded, { sections })
      if (!words.includes('apply') || !plan.changes.length || plan.from > plan.to) return { text: planText(plan, sections) }
      await applyUpdate(io, plan)
      const fresh = await loadActive(io)
      const synced = await sync(io, fresh)
      const check = await validate(io, await loadActive(io))
      await refresh($, true)
      return {
        text: `Updated the vault to format ${plan.to}: ${plan.changes.length} file(s) written${synced.changed.length ? `, ${synced.changed.length} derived file(s) refreshed` : ''}. ` +
          `Validation: ${check.errors.length} errors, ${check.warnings.length} warnings${check.errors.length + check.warnings.length ? ' (rft_validate lists them).' : '.'}`,
      }
    } catch (err) {
      return { text: message(err) }
    }
  })

  on('command.run', { command: 'rft-next' }, async ($, e) => {
    try {
      const io = (await mustHere($)).io
      const loaded = await loadActive(io)
      const concept = e.args.trim() || undefined
      return { text: await withInbox(await withJobs(await nextReport(io, loaded, today(), concept), io, loaded, await nowS($)), io, loaded, concept) }
    } catch (err) {
      return { text: message(err) }
    }
  })

  // /rft-machine [add|status]: the pairing of this machine with the queue. add on a paired machine
  // only says so, with its status; else the machine is checked (no model turn) and, when it can run
  // the queue, Claude asks the user two questions and pairs it (rft_machine add)
  on('command.run', { command: 'rft-machine' }, async ($, e) => {
    try {
      const h = await mustHere($)
      const loaded = await loadActive(h.io)
      const words = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
      const verb = words[0] ?? 'status'
      if (verb === 'status') return { text: statusText(await machineStatus($, h, loaded.config)) }
      if (verb !== 'add') return { text: 'Usage: /rft-machine [add|status]: add pairs this machine with the experiment queue, status says how it stands.' }
      if (words.length > 1) return { text: `Only this machine (the one this session runs on) can be paired with the queue for now: /rft-machine add, with nothing after it.` }
      const st = await machineStatus($, h, loaded.config)
      if (st.machine) return { text: statusText(st, { already: true }) }
      const p = await machineProbe($, h, loaded.config)
      if (!p.eligible) return { text: probeText(p) }
      pendingPrompts.push(machinePrompt(p, manualDir($.plugin.root)))
      return { text: `${probeText(p)}\n\nClaude will finish in a moment: it asks you where the runs' outputs go and which GPUs to keep for your own work, then turns the queue on.` }
    } catch (err) {
      return { text: message(err) }
    }
  })

  // /rft-jobs [job or experiment]: the queue as rft_jobs gives it, printed (no model turn)
  on('command.run', { command: 'rft-jobs' }, async ($, e) => {
    try {
      const h = await mustHere($)
      const loaded = await loadActive(h.io)
      if (!(await readMachine(h.io, loaded.config.vault))) return { text: statusText({ host: '', machine: null, paired: false }) }
      const ref = e.args.trim() || undefined
      const v = await queueCli($, h, loaded.config, ['status', '--history', '10']) as unknown as QueueView
      const log = ref && /^q\d+$/i.test(ref) ? String((await queueCli($, h, loaded.config, ['log', '--id', ref.toLowerCase(), '--lines', '30'])).text ?? '') : undefined
      const url = await read($, webUrl)
      return { text: `${jobsReport(v, loaded, await nowS($), { ref, log })}${url ? `\n\nThe monitor, to reorder, pause, cancel and retry: ${url}${url.includes('?') ? '&' : '?'}jobs` : '\n\n/rft opens the tree view, whose monitor (the icon at the top left) reorders, pauses, cancels and retries jobs.'}` }
    } catch (err) {
      return { text: message(err) }
    }
  })

  on('command.run', { command: 'rft-summarize' }, async ($, e) => {
    try {
      const io = (await mustHere($)).io
      const loaded = await loadActive(io)
      const scope = e.args.trim()
      const c = scope ? resolveConcept(loaded.tree, scope) : null
      if (scope && !c) return { text: `"${scope}" is not a concept: /rft-concepts lists them.` }
      const gaps = await mapGaps(io, loaded, c ?? undefined)
      if (!gaps.notes && !gaps.digests.length) return { text: `The map${c ? ` of "${c.name}"` : ''} is complete: every note has a summary and every concept a current digest.` }
      pendingPrompts.push(summarizePrompt(manualDir($.plugin.root), c ? c.name : ''))
      return {
        text: `To write${c ? ` in "${c.name}"` : ''}: ${gaps.notes} note summar${gaps.notes === 1 ? 'y' : 'ies'} and ${gaps.digests.length} digest(s)${gaps.digests.length ? ` (${gaps.digests.slice(0, 8).join(', ')}${gaps.digests.length > 8 ? ', …' : ''})` : ''}. ` +
          'Claude will start in a moment, concept by concept. It reads every note without a summary once, so on a large tree this is a long, one-off job; /rft-summarize <concept> does one line of research at a time.',
      }
    } catch (err) {
      return { text: message(err) }
    }
  })

  on('command.run', { command: 'rft-artifact' }, async ($, e) => {
    try {
      const io = (await mustHere($)).io
      const loaded = await loadActive(io)
      const scope = e.args.trim()
      if (scope) {
        const c = resolveConcept(loaded.tree, scope)
        if (!c) return { text: `"${scope}" is not a concept: /rft-concepts lists them.` }
        pendingPrompts.push(artifactPrompt([c.name]))
        return { text: `Asked Claude to write the artifact of "${c.name}": the tree view shows it when you click the concept.` }
      }
      const todo = await artifactsToWrite(io, loaded)
      if (!todo.length) return { text: 'Every concept with results has an artifact, and every artifact is up to date.' }
      pendingPrompts.push(artifactPrompt(todo.map(t => t.concept.name)))
      return { text: `Asked Claude to write ${todo.length} artifact(s): ${todo.map(t => `${t.concept.name} (${t.why})`).join(', ')}.` }
    } catch (err) {
      return { text: message(err) }
    }
  })

  on('command.run', { command: 'rft-manuscript' }, async ($, e) => {
    try {
      const io = (await mustHere($)).io
      const loaded = await loadActive(io)
      const args = e.args.trim().split(/\s+/).filter(Boolean)
      // a vault started before the two levels: brought to them first
      const migrated = await migrateManuscript(io, loaded)
      if (migrated) { await refresh($, true); return { text: migrated } }
      const ms = await readManuscript(io, loaded)
      if (args[0] === 'new' || !ms) {
        const [name = 'paper', kind = 'article'] = args[0] === 'new' ? args.slice(1) : args
        if (kind !== 'article' && kind !== 'report') return { text: 'A document is an article (a paper) or a report (a thesis chapter): /rft-manuscript new <name> [article|report].' }
        const made = await newDocument(io, loaded, name, kind)
        await refresh($, true)
        return { text: `${made} The tree view's Manuscript tab shows both levels; /rft-manuscript asks Claude what to write from the verified notes, and where to place it.` }
      }
      const doc = args[0]
      if (doc && !ms.documents.some(d => d.name === doc)) return { text: `"${doc}" is no document (${ms.documents.map(d => d.name).join(', ') || 'none yet'}); /rft-manuscript new ${doc} makes it.` }
      pendingPrompts.push(manuscriptPrompt(doc))
      return { text: `Asked Claude to propose snippets to write and where to place them${doc ? ` in ${doc}` : ''}: tables to choose from; nothing is written until you pick.` }
    } catch (err) {
      return { text: message(err) }
    }
  })

  // the inbox, with no model turn: printed, or one more link saved in it with the reading priority the user gave
  on('command.run', { command: 'rft-inbox' }, async ($, e) => {
    try {
      const io = (await mustHere($)).io
      const loaded = await loadActive(io)
      if (!e.args.trim()) return { text: inboxReport(await loadInbox(io, loaded.config.vault)) }
      const input = commandInput(e.args)
      if (!input) return { text: `"${e.args.trim()}" does not start with a link. /rft-inbox <link> [urgent|high|medium|low] [why]: the link is a URL, an arXiv id or a DOI.` }
      return { text: await addItem(io, loaded, { ...input, today: today() }) }
    } catch (err) {
      return { text: message(err) }
    }
  })

  on('command.run', { command: 'rft-handoff' }, async ($, e) => {
    try {
      const h = await mustHere($)
      const config = await readConfig(h.io)
      if (!config) return { text: NOT_ACTIVE }
      const arg = e.args.trim()
      if (arg === 'show') return { text: await showHandoff(h.io, config.vault, h.cwd, await nowS($)) }
      if (arg === 'clear') return { text: await clearHandoff(h.io, config.vault, h.cwd) }
      pendingPrompts.push(handoffPrompt(arg))
      return { text: 'Claude will write the handoff in a moment: the notes brought up to date first, then what was done, what to do first and what no note or commit holds. After it, /clear (or a new session in this folder) goes on from the handoff and the tree; /rft-handoff show prints it.' }
    } catch (err) {
      return { text: message(err) }
    }
  })

  on('command.run', { command: 'rft-view' }, async $ => {
    try {
      const h = await mustHere($)
      const io = h.io
      const loaded = await loadActive(io)
      const root = $.plugin.root
      const assets = {
        html: await $.fs.read(join(root, ASSET_PATHS.html)),
        css: await $.fs.read(join(root, ASSET_PATHS.css)),
        js: await $.fs.read(join(root, ASSET_PATHS.js)),
        d3: await $.fs.read(join(root, ASSET_PATHS.d3)),
        katex: await $.fs.read(join(root, ASSET_PATHS.katex)),
        katexCss: await $.fs.read(join(root, ASSET_PATHS.katexCss)),
        filters: await $.fs.read(join(root, ASSET_PATHS.filters)),
        kanban: await $.fs.read(join(root, ASSET_PATHS.kanban)),
        schedule: await $.fs.read(join(root, ASSET_PATHS.schedule)),
        layout: await $.fs.read(join(root, ASSET_PATHS.layout)),
        concepts: await $.fs.read(join(root, ASSET_PATHS.concepts)),
        markdown: await $.fs.read(join(root, ASSET_PATHS.markdown)),
        scratchpad: await $.fs.read(join(root, ASSET_PATHS.scratchpad)),
        theme: await $.fs.read(join(root, ASSET_PATHS.theme)),
        artifacts: await $.fs.read(join(root, ASSET_PATHS.artifacts)),
        phone: await $.fs.read(join(root, ASSET_PATHS.phone)),
        latex: await $.fs.read(join(root, ASSET_PATHS.latex)),
        frame: await $.fs.read(join(root, ASSET_PATHS.frame)),
        frameCss: await $.fs.read(join(root, ASSET_PATHS.frameCss)),
      }
      const path = await exportHtml(io, loaded, assets)

      return { text: `Wrote ${path} (${Object.keys(loaded.tree.nodes).length} notes): open file://${isAbsolute(path) ? path : join(h.root, path)} in a browser.` }
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---------------------------------------------------------------- tools

  // the rft tools are answered here; after any other tool that may have touched the vault the
  // snapshot is re-read when the notes changed, which redraws the pane
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (tool.startsWith('mcp__rft__')) {
      if (recall && /^mcp__rft__rft_(search|map|graph)$/.test(tool)) recall.used = true
      try {
        const name = tool.slice('mcp__rft__'.length)
        const out = await runTool($, name, e as unknown as Record<string, unknown>)
        // a tool that wrote: the vault is read again; one that only reports: only if a note changed meanwhile
        await refresh($, !REPORT_TOOLS.has(name))
        // no answer over its limit: it is sent again with every later request of the conversation
        return answer(ceiling(name, out))
      } catch (err) {
        return answer(err instanceof Error ? err.message : String(err), true)
      }
    }
    if (rules) {
      const why = await refused($, e as unknown as Record<string, unknown>)
      if (why) return { deny: why }
    }
    const ran = await next(e)
    if (rules && !READ_ONLY.test(tool)) await poll($)
    // a search of the notes before the tree's own search: point to it, until it is used
    if (recall && !recall.used && !ran.deny && !ran.isError && searchesVault(tool, e as unknown as Record<string, unknown>, recall.vault, recall.cwd)) {
      return { ...ran, context: [...(ran.context ?? []), RECALL_HINT] }
    }
    return ran
  }).catch(($, e, next) =>
    next.called ? next(e) : String(e.tool).startsWith('mcp__rft__') ? answer('rft: the tool failed', true) : next(e))

  // ---------------------------------------------------------------- the pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = ui
    const s = await read($, snapshot)
    if (!s || !s.isActive) {
      return (
        <Box flexDirection="column">
          <Text bold>Reasoning Flow Tree</Text>
          {s?.error ? <Text color="error">{s.error}</Text> : <Text dimColor>{NOT_ACTIVE}</Text>}
        </Box>
      )
    }
    const tree = treeOf(s)
    const folded = new Set(await read($, collapsed))
    const sel = await read($, selected)
    const view = await read($, note)
    const url = await read($, webUrl)
    const cols = Math.max(24, e.props.bodyColumns || e.viewport?.columns || 60)
    const c = counts(tree)

    const rows: JSX.Element[] = []
    const visit = (id: string, depth: number) => {
      const n = tree.nodes[id]
      if (!n) return
      const isFolded = folded.has(id)
      const indent = '  '.repeat(depth)
      const room = Math.max(6, cols - indent.length - n.id.length - 8)
      const title = n.title.length > room ? n.title.slice(0, room - 1) + '…' : n.title
      rows.push(
        <Box key={`row-${id}`} flexDirection="row">
          <Text>{indent}</Text>
          {n.children.length
            ? <Button key={`fold-${id}`} plain onPress={() => toggleFold($, id)}>{isFolded ? '▸' : '▾'}</Button>
            : <Text dimColor>·</Text>}
          <Text color={STATUS_COLOR[n.status] ?? 'inactive'}>{` ${MARK[n.status] ?? '-'} `}</Text>
          {isLiterature(n) ? <Text color="ide">{`${LITERATURE_MARK} `}</Text> : null}
          <Button key={`node-${id}`} label={`${n.id} ${title}${isFolded ? ` +${n.children.length}` : ''}`} plain onPress={() => selectNode($, id)} />
          {sel === id ? <Text color="claude">{' ◀'}</Text> : null}
        </Box>,
      )
      if (!isFolded) for (const k of n.children) visit(k, depth + 1)
    }
    for (const r of tree.roots) visit(r, 0)

    let detail: JSX.Element | null = null
    const shown = view ? tree.nodes[view.id] : undefined
    if (view && shown) {
      const parent = shown.parent ? tree.nodes[shown.parent] : undefined
      detail = (
        <Box key="detail" flexDirection="column" borderStyle="round" paddingX={1} marginTop={1}>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Text bold>{shown.name}</Text>
            <Text color={STATUS_COLOR[shown.status] ?? 'inactive'}>{`${MARK[shown.status] ?? ''} ${shown.status}`}</Text>
          </Box>
          <Box flexDirection="row" gap={1} flexWrap="wrap">
            <Button key="close-note" label="Close" onPress={() => selectNode($, shown.id)} />
            {parent ? <Button key={`up-${parent.id}`} label={`↑ ${parent.id}`} onPress={() => selectNode($, parent.id)} /> : null}
            {shown.children.map(k => <Button key={`down-${k}`} label={`↓ ${k}`} onPress={() => selectNode($, k)} />)}
          </Box>
          <Markdown key="note-text" text={paneMarkdown(bodyOf(view.text))} />
        </Box>
      )
    }

    // the pane is the outline; the interactive tree is the web view /rft serves
    const foldable = Object.values(tree.nodes).filter(n => n.children.length && n.parent).map(n => n.id)

    return (
      <Box flexDirection="column">
        <Text bold>{`${s.project}: ${countsLine(c)}`}</Text>
        {url
          ? <Text color="claude">{`Tree view: ${url}`}</Text>
          : <Text dimColor>Run /rft for the interactive tree view in a browser.</Text>}
        {s.error ? <Text color="error">{s.error}</Text> : null}
        {s.problems.length ? <Text color="warning">{`${s.problems.length} problem(s), e.g. ${s.problems[0]}`}</Text> : null}
        <Text dimColor>{`${LEGEND} · ${LITERATURE_MARK} literature search`}</Text>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          <Button key="fold-all" label="Fold all" onPress={() => foldAll($, foldable)} />
          <Button key="unfold-all" label="Unfold all" onPress={() => foldAll($, [])} />
        </Box>
        {detail}
        <Box key="outline" flexDirection="column" marginTop={1}>{rows}</Box>
      </Box>
    )
  })
}

const READ_ONLY = /^(Read|Grep|Glob|LS|WebFetch|WebSearch|ToolSearch|TodoWrite)$/

/** The pane's mark of a literature note (the web view and the canvas give it a colour of its own). */
const LITERATURE_MARK = '▤'

const STATUS_COLOR: Record<string, 'success' | 'warning' | 'suggestion' | 'error' | 'inactive' | 'ide'> = {
  done: 'success', running: 'warning', planned: 'suggestion', idea: 'suggestion',
  dropped: 'error', discussed: 'inactive', moved: 'ide',
}

/** Obsidian links as bold text, embeds as a mention: the pane's Markdown has no vault to link into. */
const paneMarkdown = (body: string) =>
  body
    .replace(/!\[\[([^\]]+)\]\]/g, '_(embedded: $1)_')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?\|([^\]]+)\]\]/g, '**$2**')
    .replace(/\[\[([^\]|#]+)(?:#[^\]]*)?\]\]/g, '**$1**')
