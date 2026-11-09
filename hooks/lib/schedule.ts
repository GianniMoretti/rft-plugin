// Deadlines and the schedule, as Claude's tools see them. Dates are the user's: `due:` on any
// note and on a milestone, `start:` and `est:` on an experiment; they set them in the tree view's
// Calendar or the note's drawer, and Claude's own writes that change them are refused
// (register.tsx). Claude suggests a start and an estimate (rft_suggest_dates), suggests a paper
// submission read from its official dates page (rft_suggest_deadline, a milestone with status
// `suggested`), and adds a deadline the user gives it once they confirm (rft_add_deadline). The
// planning itself is web/schedule.js, shared with the tree view.

import type { DeadlinePlan, GpuLoad, Milestone } from './dates'
import { S } from './dates'
import type { Io, Loaded, RftNode, Tree } from './vault'
import { MILESTONES, MILESTONE_RE, compareNames, front, join, load, readConfig, resolveId, sanitiseTitle, setField, unquote, writeConfig } from './vault'

export class ScheduleError extends Error {}

export const MAX_WHY = 240

export const parseDue = S.parseDue
export const parseEst = S.parseEst
export const utcOf = S.utcOf

/** Each deadline planned backwards from its due day, nearest first (web/schedule.js). */
export const plan = (tree: Tree, milestones: Milestone[], today: string): DeadlinePlan[] =>
  S.plan(Object.values(tree.nodes), milestones, today)

/** The days the planned and running experiments need more GPUs than `capacity`, and the runs with no end planned. */
export const gpuLoad = (tree: Tree, capacity: number | undefined, today: string): GpuLoad =>
  S.gpuLoad(Object.values(tree.nodes), capacity, today)

/** The vault's calendar file (`rft.ics`), made at `stamp` (ISO). */
export const icsCalendar = (l: Loaded, stamp: string): string =>
  S.ics({ project: l.config.project, nodes: Object.values(l.tree.nodes), milestones: l.milestones, stamp }).text

// ---------------------------------------------------------------- the user's dates

/** The fields that are the user's alone. */
export const DATE_FIELDS = ['due', 'start', 'est'] as const

/** Whether `after` gives a note or a milestone other dates than `before` does (a field added, changed or removed). */
export function changesDates(before: string, after: string): boolean {
  const a = front(before), b = front(after)
  return DATE_FIELDS.some(k => unquote(a[k]) !== unquote(b[k]))
}

/** Why Claude's edit of a date is refused, and what to do instead. */
export const datesText = (n: { id: string } | null) =>
  `Dates are the user's: they set due:, start: and est: in the tree view (the Calendar, or the note's drawer), and your edits that change them are refused. To propose dates, call rft_suggest_dates {${n ? `id: "${n.id}"` : 'id'}, start, est, why}; for a deadline the user gives you, rft_add_deadline (they confirm it); for a paper submission, rft_suggest_deadline with its official dates page.`

const oneLine = (why: unknown) => {
  const one = typeof why === 'string' ? why.trim().replace(/\s+/g, ' ') : ''
  if (!one) throw new ScheduleError('say why in one line (why): shown to the user next to the suggestion')
  if (one.length > MAX_WHY) throw new ScheduleError(`keep why to one line (${MAX_WHY} characters at most; this one has ${one.length})`)
  return one
}

const SUGGESTED = ['suggested_start', 'suggested_est', 'suggested_dates_why']

/** The note's text without Claude's suggested dates. */
function withoutSuggestedDates(text: string): string {
  return text.replace(/^---\n([\s\S]*?)\n---/, (all, head: string) =>
    `---\n${head.split('\n').filter(l => !SUGGESTED.some(k => l.startsWith(`${k}:`))).join('\n')}\n---`)
}

/**
 * Writes Claude's suggested start and/or estimate for an experiment, with why, after its status
 * (replacing an earlier suggestion). The user accepts or dismisses it in the tree view; the
 * plan keeps to the user's own dates until then.
 */
export async function suggestDates(io: Io, loaded: Loaded, ref: string, given: { start?: unknown; est?: unknown }, why: unknown): Promise<string> {
  const id = resolveId(loaded.tree, ref)
  if (!id) throw new ScheduleError(`"${ref}" is not a note of the tree`)
  const n = loaded.tree.nodes[id]!
  if (n.type !== 'experiment') throw new ScheduleError(`${n.name} is a ${n.type}: only experiments have a start and an estimate (any note can have a due date, which the user sets)`)
  const hasStart = given.start !== undefined && given.start !== null && given.start !== ''
  const hasEst = given.est !== undefined && given.est !== null && given.est !== ''
  if (!hasStart && !hasEst) throw new ScheduleError('suggest a start, an estimate or both (start: 2026-11-20, est: 4d)')
  const start = hasStart ? S.parseDay(String(given.start)) : null
  if (hasStart && !start) throw new ScheduleError(`start must be a date (2026-11-20), not ${JSON.stringify(given.start)}`)
  const est = hasEst ? S.parseEst(typeof given.est === 'number' ? given.est : String(given.est)) : null
  if (hasEst && !est) throw new ScheduleError(`est must be a number of days or weeks (3d, 2w), not ${JSON.stringify(given.est)}`)
  const one = oneLine(why)
  let text = withoutSuggestedDates(loaded.texts[id]!)
  let after = 'status'
  if (start) { text = setField(text, 'suggested_start', start, after); after = 'suggested_start' }
  if (est) { text = setField(text, 'suggested_est', `${est}d`, after); after = 'suggested_est' }
  text = setField(text, 'suggested_dates_why', JSON.stringify(one), after)
  await io.write(join(loaded.config.vault, n.path), text)
  Object.assign(loaded, await load(io, loaded.config))
  const now = [n.start ? `start ${n.start}` : 'no start', n.est ? `${n.est}d` : 'no estimate'].join(', ')
  const said = [start ? `start ${start}` : '', est ? `${est}d` : ''].filter(Boolean).join(', ')
  return `Suggested for ${n.name}: ${said} (now ${now}): ${one}. The user accepts or dismisses it in the tree view (the Calendar, or the note's drawer); never set start: or est: yourself.`
}

// ---------------------------------------------------------------- deadlines

export type DeadlineInput = { title: unknown; due: unknown; needs?: unknown }

/** A deadline's title, due date and needs, checked: the names of the notes it needs. */
export function checkDeadline(loaded: Loaded, input: DeadlineInput): { title: string; due: string; needs: RftNode[] } {
  const title = sanitiseTitle(typeof input.title === 'string' ? input.title : '')
  if (!title) throw new ScheduleError('give the deadline a title (title)')
  const due = typeof input.due === 'string' ? S.parseDue(input.due) : null
  if (!due) throw new ScheduleError(`due must be a date: ${S.DUE_EXAMPLES.replace(/, (?=[^,]*$)/, ' or ')} (AoE, UTC or ±HH:MM after the time)`)
  const refs = Array.isArray(input.needs) ? input.needs : input.needs === undefined || input.needs === null ? [] : [input.needs]
  const needs: RftNode[] = []
  for (const r of refs) {
    const id = resolveId(loaded.tree, String(r))
    if (!id) throw new ScheduleError(`needs: "${String(r)}" is not a note of the tree`)
    if (!needs.some(n => n.id === id)) needs.push(loaded.tree.nodes[id]!)
  }
  return { title, due: S.formatDue(due), needs }
}

/** The next free milestone id: after the config's last one and every milestone on disk. */
function nextMilestoneId(loaded: Loaded): string {
  let max = loaded.config.lastId.M ?? 0
  for (const m of loaded.milestones) {
    const x = MILESTONE_RE.exec(m.id)
    if (x) max = Math.max(max, Number(x[1]))
  }
  return `M${String(max + 1).padStart(2, '0')}`
}

/** A milestone's file. */
function milestoneText(id: string, d: { title: string; due: string; needs: RftNode[] }, status: string, extra: Record<string, string> = {}, body = ''): string {
  const fields = [`id: ${id}`, 'type: milestone', `status: ${status}`, `due: ${d.due}`]
  if (d.needs.length) fields.push(`needs: [${d.needs.map(n => `"[[${n.name}]]"`).join(', ')}]`)
  for (const [k, v] of Object.entries(extra)) fields.push(`${k}: ${v}`)
  return `---\n${fields.join('\n')}\n---\n\n# ${id} · ${d.title}\n${body ? `\n${body}\n` : ''}`
}

async function writeMilestone(io: Io, loaded: Loaded, d: { title: string; due: string; needs: RftNode[] }, status: string, extra: Record<string, string> = {}, body = ''): Promise<string> {
  const id = nextMilestoneId(loaded)
  const name = `${id} ${d.title}`
  await io.write(join(loaded.config.vault, MILESTONES, `${name}.md`), milestoneText(id, d, status, extra, body))
  const config = (await readConfig(io)) ?? loaded.config
  config.lastId = { ...config.lastId, M: Number(id.slice(1)) }
  await writeConfig(io, config)
  Object.assign(loaded, await load(io, config))
  return name
}

/** The question the user answers before a deadline Claude was given is added. */
export const deadlineQuestion = (d: { title: string; due: string; needs: RftNode[] }) =>
  `Add the deadline "${d.title}" on ${d.due}${d.needs.length ? `, needing ${S.andList(d.needs.map(n => n.id))}` : ''}?`

/** Adds a deadline the user gave, once they have confirmed it: a milestone, open. */
export async function addDeadline(io: Io, loaded: Loaded, d: { title: string; due: string; needs: RftNode[] }): Promise<string> {
  const name = await writeMilestone(io, loaded, d, 'open')
  return `Added ${name}, due ${d.due}${d.needs.length ? `, needing ${S.andList(d.needs.map(n => n.id))}` : ''}. The user changes it in the tree view's Calendar.`
}

/**
 * Suggests a paper submission (or another deadline read from an official page): a milestone with
 * status `suggested`, its `source:` and why. The user accepts or dismisses it in the Calendar.
 */
export async function suggestDeadline(io: Io, loaded: Loaded, input: DeadlineInput & { source?: unknown; why?: unknown }): Promise<string> {
  const source = typeof input.source === 'string' ? input.source.trim() : ''
  if (!source) throw new ScheduleError('give the official dates page (source), read now, not a date from memory: deadlines move every year')
  if (!/^https?:\/\/\S+$/.test(source)) throw new ScheduleError(`source must be a web address (https://…), not ${JSON.stringify(source)}`)
  const d = checkDeadline(loaded, input)
  const one = oneLine(input.why)
  const name = await writeMilestone(io, loaded, d, 'suggested', { source, why: JSON.stringify(one) }, `Suggested by Claude from ${source}.`)
  return `Suggested ${name}, due ${d.due}, from ${source}. The user accepts or dismisses it in the tree view's Calendar; until then it is not planned for.`
}

// ---------------------------------------------------------------- reports

/** The deadlines still ahead (or missed with work left), nearest first, one line each; GPU clashes after them. */
export function scheduleReport(loaded: Loaded, today: string): { head: string[]; tail: string[] } {
  const plans = plan(loaded.tree, loaded.milestones, today).filter(p => p.daysLeft >= 0 || p.atRisk)
  const head: string[] = []
  if (plans.length) head.push(`## Deadlines (${plans.length}, nearest first)`, ...plans.map(p => `  ${S.deadlineLine(p)}`))
  const cap = loaded.config.gpus
  const load = gpuLoad(loaded.tree, cap, today)
  const gpus = [
    ...load.clashes.map(c => `GPUs: ${S.clashLine(c, cap!)}`),
    ...load.noEnd.map(id => `GPUs: ${id} is running with no end planned (est:), so its GPUs count as taken through today`),
  ]
  if (gpus.length) head.push(...(plans.length ? [] : ['## GPUs']), ...gpus)
  if (head.length) head.push('')
  const tail: string[] = []
  const waiting = loaded.milestones.filter(m => m.status === 'suggested').map(m => m.name)
  if (waiting.length) tail.push(`Suggested deadlines waiting for the user (the tree view's Calendar): ${waiting.join(', ')}.`)
  const dated = Object.values(loaded.tree.nodes).filter(n => n.suggestedStart || n.suggestedEst).map(n => n.id).sort(compareNames)
  if (dated.length) tail.push(`Suggested dates waiting for the user (the tree view's Calendar, or the note's drawer): ${dated.join(', ')}.`)
  return { head, tail }
}

/** The line session start adds: the deadlines of the next 14 days that are at risk; '' when none. */
export function deadlinesLine(loaded: Loaded, today: string): string {
  const risky = plan(loaded.tree, loaded.milestones, today).filter(p => p.atRisk && p.daysLeft <= 14)
  return risky.length ? `Deadlines: ${risky.map(p => `${p.name} ${S.when(p.daysLeft)}, at risk`).join('; ')} (rft_next says why)` : ''
}
