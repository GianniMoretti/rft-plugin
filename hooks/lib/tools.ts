// Which tools sit in the prompt from the start. A tool's schema in the prompt is sent with every
// request of the session, so only the tools a session uses most are there; the rest wait behind
// ToolSearch (the model sees their names and loads a schema when it needs one, which costs one
// request). A tool earns its place when that request, times how often a session needs the tool,
// costs more than carrying its schema all session: about one session in four for a schema of 1,000
// characters in a long session. A group of feature tools joins the prompt when the vault uses that
// feature: rft_suggest when a note is locked, the comment tools when a note has a thread, the
// artifact tools once the vault has a concept artifact, the notebook tools once an experiment has
// a notebook, the queue tools once this machine is paired with the experiment queue
// (`.queue/machine.json`; never registered before), the manuscript tools once it has snippets
// (`snippets/snippets.json`), rft_handoff once a session left a handoff (`.handoff/`). Dates,
// priorities and verification bring their rule alone: the rule names their tools, which a session
// calls too seldom to carry (no call or one session in 14).
// The rules for all these features enter the session's rules on the same condition (ops.ts rulesText).

import type { Loaded } from './vault'

/** The tools in the prompt in every session. */
export const CORE_TOOLS = [
  'rft_add_node', 'rft_set_status', 'rft_set_summary', 'rft_search', 'rft_map', 'rft_graph', 'rft_next', 'rft_move_node',
  'rft_sync',
] as const

/** The feature groups, each with the tools it brings into the prompt when the vault uses it (some bring their rule alone). */
export const FEATURE_TOOLS = {
  dates: [],
  priorities: [],
  verify: [],
  locks: ['rft_suggest'],
  comments: ['rft_comments', 'rft_comment', 'rft_suggest'],
  artifacts: ['rft_artifact', 'rft_set_artifact'],
  notebooks: ['rft_set_notebook', 'rft_run_notebook'],
  queue: ['rft_queue', 'rft_jobs', 'rft_job'],
  manuscript: ['rft_manuscript', 'rft_set_snippet', 'rft_set_document'],
  handoff: ['rft_handoff'],
} as const

export type Feature = keyof typeof FEATURE_TOOLS

/** The features this vault uses; `threads`: whether any note has a comment thread; `queue`: whether it has an experiment queue; `handoff`: whether a session left a handoff. */
export function featuresInUse(loaded: Loaded, threads: boolean, queue = false, handoff = false): Set<Feature> {
  const nodes = Object.values(loaded.tree.nodes)
  const out = new Set<Feature>()
  if ((loaded.milestones ?? []).length || (loaded.meetings ?? []).length || nodes.some(n => n.due || n.start)) out.add('dates')
  if (nodes.some(n => n.priority || n.suggestedPriority)) out.add('priorities')
  if (nodes.some(n => n.locked)) out.add('locks')
  if (nodes.some(n => n.status === 'verified' || n.status === 'review' || n.suggestedVerified)) out.add('verify')
  if (threads) out.add('comments')
  if (loaded.hasArtifacts) out.add('artifacts')
  if (nodes.some(n => n.notebook)) out.add('notebooks')
  if (queue) out.add('queue')
  if (loaded.hasManuscript) out.add('manuscript')
  if (handoff) out.add('handoff')
  return out
}

/** The tools to keep in the prompt for these features; every other tool is deferred. */
export function eagerTools(features: Set<Feature>): Set<string> {
  const out = new Set<string>(CORE_TOOLS)
  for (const f of features) for (const t of FEATURE_TOOLS[f]) out.add(t)
  return out
}

/**
 * The tools that only report: none writes a file of the vault, so after one the snapshot of the
 * tree is read again only if a note changed meanwhile (the `tool.call` hook of register.tsx). A
 * tool that writes, even in one of its uses, is not one of them.
 */
export const REPORT_TOOLS: ReadonlySet<string> = new Set([
  'rft_search', 'rft_map', 'rft_graph', 'rft_next', 'rft_tree', 'rft_validate', 'rft_concepts', 'rft_tags',
  'rft_code', 'rft_artifact', 'rft_manuscript', 'rft_comments', 'rft_jobs',
])
