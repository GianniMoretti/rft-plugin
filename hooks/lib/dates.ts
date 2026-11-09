// The schedule's pure logic (web/schedule.js) as the plugin sees it, typed: one copy of it for
// the tree view's Calendar and for Claude's tools.

import '../../web/schedule.js'

/** A due date: a day, with a time (HH:MM) and a zone (AoE, UTC or ±HH:MM) when given. */
export type Due = { day: string; time?: string; zone?: string }

/** A deadline of any kind, in the vault's `milestones/` folder, outside the reasoning tree. */
export type Milestone = {
  id: string
  /** The file name without `.md`: `<id> <title>`. */
  name: string
  title: string
  /** Relative to the vault folder, e.g. `milestones/M01 Workshop paper.md`. */
  path: string
  /** open, done, suggested (by Claude, until the user answers) or dismissed. */
  status: string
  /** Null when `due:` is missing or no date. */
  due: Due | null
  /** `due:` as written. */
  dueText: string
  /** The notes that must be done first, by id. */
  needs: string[]
  /** The names in `needs:` that are no note of the tree. */
  missing: string[]
  /** The official page a suggested deadline was read from. */
  source?: string
  /** Why Claude suggests it. */
  why?: string
}

/** A note still to do for a deadline, planned backwards from it. */
export type PlanItem = {
  id: string
  latestEnd: string
  latestStart?: string
  earliestStart?: string
  start?: string
  expectedEnd?: string
  est?: number
  overrun?: number
  noEstimate?: true
  waits?: true
  slack: number | null
}

export type DeadlinePlan = {
  id: string
  name: string
  kind: 'milestone' | 'note'
  due: string
  dueText: string
  at: Due
  daysLeft: number
  slack: number | null
  atRisk: boolean
  items: PlanItem[]
  problems: string[]
}

export type Clash = { from: string; to: string; need: number; notes: { id: string; gpus: number }[] }
export type GpuLoad = { clashes: Clash[]; noEnd: string[] }

/** The fields of a note the schedule reads. */
export type Dated = {
  id: string
  name: string
  type: string
  status: string
  supersededBy?: string
  due?: string
  start?: string
  est?: number
  after?: string[]
  started?: string
  finished?: string
  gpus?: number
}

type Api = {
  MILESTONE_STATUSES: string[]
  DUE_EXAMPLES: string
  isDay: (v: unknown) => boolean
  parseDay: (v: unknown) => string | null
  addDays: (day: string, n: number) => string
  between: (a: string, b: string) => number
  parseDue: (v: unknown) => Due | null
  formatDue: (due: Due | null) => string
  utcOf: (due: Due | null) => string | null
  parseEst: (v: unknown) => number | null
  gpuLoad: (nodes: Dated[], capacity: number | undefined, today: string) => GpuLoad
  plan: (nodes: Dated[], milestones: Milestone[], today: string) => DeadlinePlan[]
  when: (daysLeft: number) => string
  deadlineLine: (p: DeadlinePlan) => string
  clashLine: (c: Clash, capacity: number) => string
  andList: (items: string[]) => string
  ics: (o: { project: string; nodes: Dated[]; milestones: Milestone[]; stamp: string }) => { text: string; events: number }
}

export const S = (globalThis as unknown as { RftSchedule: Api }).RftSchedule
