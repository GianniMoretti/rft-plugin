// Grilling: a session in the chat in which Claude questions the user about one direction until
// its plan is agreed (/rft-grill-me; the method is the manual's grilling.md). Here is what the
// command works out from the tree at no model turn, so that the prompt states it as a fact and
// Claude does not have to find it: the case of the note named (grilled in place, resumed, already
// answered, locked, or of another type), what already sits under it, and the directions that could
// be grilled. And the prompts themselves.

import { cite } from './manual'
import { bodyOf, compareNames, isLiterature } from './vault'
import type { RftNode, Tree } from './vault'

/** The sections a grilling writes on the grilled direction, each only once it has something in it. */
export const SECTIONS = ['Hypothesis', 'Scope', 'Plan', 'Referee', 'Open questions'] as const

export type Section = (typeof SECTIONS)[number]

/**
 * How a grilling treats the note it was asked for. `in place`: the note is the grilled direction.
 * `resume`: so is it, and an earlier grilling already wrote on it. `answered`: the tree holds an
 * answer; the user says whether to reopen. `locked`: the user's to change; the grilled direction
 * is a new one under it. `another type`: not a direction; the grilled direction comes out of it.
 */
export type Case = 'in place' | 'resume' | 'answered' | 'locked' | 'another type'

const OPEN = ['idea', 'planned', 'running']

/** The grilling sections the note has with something under them, in their order. */
export function sectionsIn(text: string): Section[] {
  const body = bodyOf(text)
  return SECTIONS.filter(s => {
    const at = new RegExp(`^## ${s}[ \\t]*\\n`, 'm').exec(body)
    if (!at) return false
    const rest = body.slice(at.index + at[0].length)
    const next = /^## /m.exec(rest)
    return (next ? rest.slice(0, next.index) : rest).trim() !== ''
  })
}

export function caseOf(n: RftNode, text: string): Case {
  if (n.locked || n.status === 'verified') return 'locked'
  if (n.type !== 'direction') return 'another type'
  if (!OPEN.includes(n.status) || n.supersededBy) return 'answered'
  return sectionsIn(text).length ? 'resume' : 'in place'
}

/** The experiments and literature notes below `id`, however deep, in the tree's order. */
export function underNote(tree: Tree, id: string): RftNode[] {
  const out: RftNode[] = []
  const go = (k: string) => {
    for (const c of tree.nodes[k]?.children ?? []) {
      const n = tree.nodes[c]
      if (!n) continue
      if (n.type === 'experiment' || isLiterature(n)) out.push(n)
      go(c)
    }
  }
  go(id)
  return out
}

/** The directions a grilling could start from: at idea or planned, not locked; those with nothing run or planned under them first. */
export function grillable(tree: Tree): RftNode[] {
  const open = Object.values(tree.nodes).filter(n => n.type === 'direction' && !n.locked && (n.status === 'idea' || n.status === 'planned'))
  const bare = (n: RftNode) => (underNote(tree, n.id).length ? 1 : 0)
  return open.sort((a, b) => bare(a) - bare(b) || compareNames(a.name, b.name))
}

const USAGE = 'Usage: /rft-grill-me <question, note id or concept>, e.g. /rft-grill-me D12, /rft-grill-me "does mixup help below 1k images?" or /rft-grill-me Mixup.'

/** /rft-grill-me with nothing after it: how it is used and what could be grilled, by concept. */
export function grillUsage(tree: Tree): string {
  const list = grillable(tree)
  if (!list.length) return `${USAGE}\n\nNo direction is at idea or planned: give a question, or the note it comes from.`
  const lines = [USAGE, '', 'A grilling questions you about one direction, in rounds, until its plan is agreed. Directions at idea or planned:']
  const concepts = [...new Set(list.map(n => n.concept))]
  for (const c of concepts) {
    if (concepts.length > 1) lines.push(`  ${tree.concepts?.[c]?.name ?? c}`)
    for (const n of list.filter(x => x.concept === c)) {
      const under = underNote(tree, n.id)
      const shown = under.slice(0, 4).map(u => `${u.id} ${u.status}`).join(', ') + (under.length > 4 ? `, and ${under.length - 4} more` : '')
      lines.push(`${concepts.length > 1 ? '    ' : '  '}${n.name} (${n.status}${under.length ? `; under it: ${shown}` : ''})`)
    }
  }
  return lines.join('\n')
}

const A = (type: string) => `${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}`

const list = (items: readonly string[]) => items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

/** What every grilling is held to, whatever it started from. */
const method = (m: string) =>
  `Read ${cite(m, 'grilling')} first: the rounds, the seven subjects, what is written when, the proposal and how a grilling ends. ` +
  'Ask in rounds: every question that can be asked now, numbered, each with the answer you recommend and worded so that yes accepts it; then wait for my answers. Find facts yourself (the tree, the code, a paper); ask me only for decisions. ' +
  `While the grilling runs, write only the grilled direction: its sections ${list(SECTIONS)}, each once it has something in it. Everything else (sub-directions, the alternatives I reject, definitions, searches, experiments, priorities, dates, a milestone) waits for the proposal at the end, and you write only the rows I confirm. ` +
  'Write no code and queue nothing: the grilling ends at the plan.'

const lookup = 'Before round one, look up what the tree already holds on it (rft_search, rft_map of its concept, rft_code when the concept links code) and open round one with what you found.'

/**
 * The grilling of a note. `under`: the experiments and literature notes already below it;
 * `sections`: the grilling sections it already has (a resumed grilling).
 */
export function grillNotePrompt(m: string, n: RftNode, kase: Case, under: readonly RftNode[], sections: readonly Section[]): string {
  if (kase === 'answered') {
    return `I asked for a grilling on ${n.name}, but the tree already holds an answer: ${n.name} is ${n.status}${n.supersededBy ? `, superseded by ${n.supersededBy}` : ''}. Do not edit it. ` +
      `Read it and the notes under it, tell me in a few lines what the tree holds on the question and why it stands as it does, and ask me one thing: stop here, or reopen the question as a new direction under it that says what changed. Write nothing until I answer. ` +
      `If I reopen it, that new direction is the grilled direction (rft_add_node, type direction, status idea, once I gave what changed), and the grilling goes on from there. ${method(m)}`
  }
  const what =
    kase === 'locked' ? `${n.name} is ${n.status === 'verified' ? 'verified' : 'locked'}: do not edit it. The grilled direction is a new direction under it, created (rft_add_node, type direction, status idea) once round one has agreed the question it asks; a change the grilling asks of ${n.id} itself goes through rft_suggest.`
    : kase === 'another type' ? `${n.name} is ${A(n.type)}, not a direction: the grilled direction is a new direction under it, created (rft_add_node, type direction, status idea) once round one has agreed the question it raises.`
    : kase === 'resume' ? `The grilled direction is this note (${n.status}). A grilling of it was started before: it already has its ${list(sections)}. Read them, take what they answer as settled and do not ask it again; ${sections.includes('Open questions') ? 'start from its Open questions' : 'work out which of the seven subjects they leave open and start there'}.`
    : `The grilled direction is this note (${n.status}).`
  const below = under.length
    ? ` Already under it: ${under.slice(0, 15).map(u => `${u.id} (${u.status})`).join(', ')}${under.length > 15 ? `, and ${under.length - 15} more (rft_tree)` : ''}. Read them: the grilling refines these, each a row of the proposal, and you add no second note for the same run or search.`
    : ''
  return `Grill me on ${n.name}. ${what}${below} ${lookup} ${method(m)}`
}

/** The grilling of a question that is not in the tree yet. */
export const grillQuestionPrompt = (m: string, question: string) =>
  `Grill me on a question that is not a note of the tree yet: ${JSON.stringify(question)}. First locate it: rft_search and rft_map for what the tree already holds on it and the note it comes from. If the tree already answers it, say so in round one and ask me whether to stop or to go on with what changed. ` +
  'Round one opens with what you found and agrees the question\'s wording, its parent and its concept (an existing one, or a new one: rft_set_concept only after I agree); only then create the grilled direction with rft_add_node (type direction, status idea), and from then on write its sections as they settle. ' +
  method(m)

/** The grilling of a concept: which of its open questions, the user picks. */
export const grillConceptPrompt = (m: string, concept: string, start: string) =>
  `I want a grilling on the concept ${JSON.stringify(concept)}, which starts at ${start}. A grilling is about one direction, so first help me pick: call rft_map ${JSON.stringify(concept)} and list, numbered and in a line each, the open questions of its digest and its directions at idea or planned, with what is already run or planned under each. Then ask me which one to grill, or whether I bring a new question, and write nothing. ` +
  `Once I picked: a direction of the tree is grilled as it is (if it is verified or locked, or already done, dropped or discussed, say so and ask me before going on); a new question gets its note only once round one has agreed its wording and its parent. ${lookup} ${method(m)}`
