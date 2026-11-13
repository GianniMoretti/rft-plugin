// Which tools sit in the prompt from the start. Every tool's schema in the prompt costs tokens in
// every turn, so only the tools a session uses most are there; the rest wait behind ToolSearch
// (the model sees their names and loads a schema when it needs one). A group of feature tools
// joins the prompt when the vault uses that feature: dates when there are deadlines or dated
// notes, priorities when a note has one, rft_suggest when a note is locked, comments when a note has a thread.
// The rules for these features enter the session's rules on the same condition (ops.ts rulesText).

import type { Loaded } from './vault'

/** The tools in the prompt in every session. */
export const CORE_TOOLS = [
  'rft_add_node', 'rft_set_status', 'rft_set_summary', 'rft_search', 'rft_map', 'rft_graph', 'rft_next', 'rft_move_node',
] as const

/** The feature groups, each with the tools it brings into the prompt when the vault uses it. */
export const FEATURE_TOOLS = {
  dates: ['rft_suggest_dates', 'rft_add_deadline', 'rft_suggest_deadline'],
  priorities: ['rft_suggest_priority'],
  locks: ['rft_suggest'],
  comments: ['rft_comments', 'rft_comment', 'rft_suggest'],
} as const

export type Feature = keyof typeof FEATURE_TOOLS

/** The features this vault uses; `threads`: whether any note has a comment thread. */
export function featuresInUse(loaded: Loaded, threads: boolean): Set<Feature> {
  const nodes = Object.values(loaded.tree.nodes)
  const out = new Set<Feature>()
  if ((loaded.milestones ?? []).length || nodes.some(n => n.due || n.start)) out.add('dates')
  if (nodes.some(n => n.priority || n.suggestedPriority)) out.add('priorities')
  if (nodes.some(n => n.locked)) out.add('locks')
  if (threads) out.add('comments')
  return out
}

/** The tools to keep in the prompt for these features; every other tool is deferred. */
export function eagerTools(features: Set<Feature>): Set<string> {
  const out = new Set<string>(CORE_TOOLS)
  for (const f of features) for (const t of FEATURE_TOOLS[f]) out.add(t)
  return out
}
