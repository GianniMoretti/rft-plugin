// Priorities: a note's `priority:` (urgent, high, medium or low), the user's alone, set in the tree
// view (its kanban and the note drawer); among the open notes (idea, planned, running) at most 1
// is urgent, 5 high and 10 medium. A new note has none. Claude only suggests one
// (`suggested_priority:` with `suggested_priority_why:`), which the user accepts or dismisses
// there; its own writes that change `priority:` are refused (register.tsx).

import type { Io, Loaded, Priority, RftNode, Tree } from './vault'
import { OPEN_STATUSES, PRIORITIES, PRIORITY_LIMITS, compareNames, front, isPriority, join, load, orList, resolveId, setField, unquote } from './vault'

export class PriorityError extends Error {}

export const MAX_WHY = 240

/** The `priority:` a note's text gives, lowercase, or '' when it has none. */
export const priorityIn = (text: string) => unquote(front(text).priority).toLowerCase()

/** Whether `after` gives the note another `priority:` than `before` does (a field added, changed or removed). */
export const changesPriority = (before: string, after: string) => priorityIn(before) !== priorityIn(after)

/** The open notes that hold `p`, `except` left out. */
export const holders = (tree: Tree, p: Priority, except?: string) =>
  Object.values(tree.nodes).filter(n => n.id !== except && n.priority === p && OPEN_STATUSES.includes(n.status)).map(n => n.id).sort(compareNames)

/**
 * The open notes that keep `n` from taking `p`: those holding it, once it is at its limit. None
 * when `p` has no limit, when `n` holds it already, or when `n` is not open (it does not count).
 */
export function blockers(tree: Tree, n: RftNode, p: Priority): string[] {
  const limit = PRIORITY_LIMITS[p]
  if (limit === null || n.priority === p || !OPEN_STATUSES.includes(n.status)) return []
  const held = holders(tree, p, n.id)
  return held.length >= limit ? held : []
}

/** How the open notes use each priority: `urgent 1/1 (E07) · high 2/5 (E03, D05) · medium 0/10 · low 3`. */
export function limitsLine(tree: Tree): string {
  return PRIORITIES.map(p => {
    const held = holders(tree, p)
    const limit = PRIORITY_LIMITS[p]
    return `${p} ${held.length}${limit === null ? '' : `/${limit}`}${held.length && p !== 'low' ? ` (${held.join(', ')})` : ''}`
  }).join(' · ')
}

/** A suggestion checked: one of the priorities, with a reason of one line. */
export function checkSuggestion(priority: unknown, why: unknown): { priority: Priority; why: string } {
  const p = typeof priority === 'string' ? priority.trim().toLowerCase() : priority
  if (!isPriority(p)) throw new PriorityError(`priority must be ${orList(PRIORITIES.map(x => `"${x}"`))}`)
  const one = typeof why === 'string' ? why.trim().replace(/\s+/g, ' ') : ''
  if (!one) throw new PriorityError('say why in one line (why): what makes this note more or less pressing than the others')
  if (one.length > MAX_WHY) throw new PriorityError(`keep why to one line (${MAX_WHY} characters at most; this one has ${one.length})`)
  return { priority: p, why: one }
}

/** The note's text with Claude's suggestion in its frontmatter, after its status. */
export const withSuggestion = (text: string, p: Priority, why: string) =>
  setField(setField(text, 'suggested_priority', p, 'status'), 'suggested_priority_why', JSON.stringify(why), 'suggested_priority')

/** What a full priority means for a suggestion: accepting it needs one of its notes lowered first. */
export function fullText(tree: Tree, n: RftNode, p: Priority): string {
  const held = blockers(tree, n, p)
  return held.length ? ` ${p} is at its limit (${PRIORITY_LIMITS[p]}, held by ${held.join(', ')}): to accept it the user first lowers one of them.` : ''
}

/** Writes Claude's suggested priority for a note; the user accepts or dismisses it in the tree view. */
export async function suggestPriority(io: Io, loaded: Loaded, ref: string, priority: unknown, why: unknown): Promise<string> {
  const id = resolveId(loaded.tree, ref)
  if (!id) throw new PriorityError(`"${ref}" is not a note of the tree`)
  const n = loaded.tree.nodes[id]!
  const s = checkSuggestion(priority, why)
  if (n.priority === s.priority) throw new PriorityError(`${n.name} is already ${s.priority}: nothing to suggest`)
  await io.write(join(loaded.config.vault, n.path), withSuggestion(loaded.texts[id]!, s.priority, s.why))
  const full = fullText(loaded.tree, n, s.priority)
  Object.assign(loaded, await load(io, loaded.config))
  return `Suggested ${s.priority} for ${n.name} (${n.priority ? `now ${n.priority}` : 'no priority yet'}): ${s.why}. ` +
    `The user accepts or dismisses it in the tree view (the kanban, or the note's drawer); never set priority: yourself.${full}`
}

/** Why Claude may not change a note's `priority:`, and what it does instead. */
export const priorityText = (n: { id: string; name: string } | null) =>
  `${n ? `${n.name}'s priority` : 'A note\'s priority'} is the user's alone: they set it in the tree view (the kanban, or the note's drawer), and your edits that change \`priority:\` are refused. To propose one, call rft_suggest_priority {id${n ? `: "${n.id}"` : ''}, priority, why}; the user accepts or dismisses it.`
