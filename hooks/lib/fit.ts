// Answers that stay within a limit. What a tool answers is sent again with every later request of
// the conversation, so no answer may grow with the vault: a list's long lines are clipped first,
// then the list is cut, and a cut answer ends with what was left out and how to ask for it.

/** The most characters a tool answers with. */
export const ANSWER_LIMIT = 8000

/** rft_artifact's: more, since it carries the text of the results a page is written from. */
export const ARTIFACT_LIMIT = 12000

/** The most characters `tool` answers with. */
export const limitOf = (tool: string): number => (tool === 'rft_artifact' ? ARTIFACT_LIMIT : ANSWER_LIMIT)

/** The narrowest a list's line is clipped to: its mark, id and title still show. */
const MIN_WIDTH = 60

/** `s` in at most `max` characters, ending in … when it was cut. */
export const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…` : s)

export type Fitted = {
  lines: string[]
  /** The width the long lines were clipped to; null when every line shown is whole. */
  width: number | null
  /** How many lines at the end were left out. */
  left: number
}

/**
 * The lines of a list in at most `budget` characters: whole while they fit; else each clipped to
 * the widest width that makes them all fit, never under `min`; else as many of them, clipped to
 * `min`, as fit. The caller says what `width` and `left` mean for its reader.
 */
export function fitList(lines: string[], budget: number, min = MIN_WIDTH): Fitted {
  const size = (w: number) => lines.reduce((sum, l) => sum + Math.min(l.length, w) + 1, 0)
  if (size(Infinity) <= budget) return { lines, width: null, left: 0 }
  if (size(min) <= budget) {
    let lo = min
    let hi = Math.max(...lines.map(l => l.length))
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (size(mid) <= budget) lo = mid
      else hi = mid - 1
    }
    return { lines: lines.map(l => clip(l, lo)), width: lo, left: 0 }
  }
  const out: string[] = []
  let used = 0
  for (const l of lines) {
    const c = clip(l, min)
    if (used + c.length + 1 > budget) break
    out.push(c)
    used += c.length + 1
  }
  return { lines: out, width: min, left: lines.length - out.length }
}

/** How to ask a tool for less, said under an answer of its that was cut. */
const NARROWER: Record<string, string> = {
  rft_map: 'rft_map with a concept gives one concept; rft_tree with root and depth, one branch; rft_search, one subject.',
  rft_tree: 'Give root and depth for one branch; rft_map is the shorter overview.',
  rft_next: 'Give a concept for its open work alone.',
  rft_search: 'Give a smaller limit, or narrow with type, status, concept or tag.',
  rft_graph: 'Ask for one of the notes named above.',
  rft_comments: 'Give a note id for its threads alone; the tree view shows a long thread whole.',
  rft_code: 'git log and git diff in the repo give the rest.',
  rft_jobs: 'Give a job id, and fewer lines of its log.',
  rft_validate: 'Fix what is listed, then call it again for the rest.',
  rft_artifact: 'Give notes (the ids of the results to read) or section (a heading of the page).',
}

/**
 * The net under every answer: one over `limit` stops at the last whole line that fits and says
 * how much was left out and how to ask for it. The tools whose answers grow with the vault fit
 * theirs first (fitList), so this cuts only what they did not foresee.
 */
export function ceiling(tool: string, text: string, limit = limitOf(tool)): string {
  if (text.length <= limit) return text
  const how = NARROWER[tool] ?? 'Ask for less: one concept, one note, or a smaller limit.'
  const room = Math.max(0, limit - how.length - 120)
  let at = text.lastIndexOf('\n', room)
  // one line longer than the room: cut inside it
  if (at < room / 2) at = room
  const rest = text.slice(at).trim()
  return `${text.slice(0, at).trimEnd()}\n… cut here, at this answer's limit of ${limit} characters: ${rest.split('\n').length} more line(s), ${rest.length} characters. ${how}`
}
