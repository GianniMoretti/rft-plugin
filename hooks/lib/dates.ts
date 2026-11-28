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

/**
 * A meeting, in the vault's `meetings/` folder, outside the reasoning tree: once at `when:`, or
 * coming back `every:` day, week or month up to `until:`, but on the days it `skip:`s and with
 * the occurrences `moved:` elsewhere. The fields as written; web/schedule.js reads them.
 */
export type Meeting = {
  id: string
  /** The file name without `.md`: `<id> <title>`. */
  name: string
  title: string
  /** Relative to the vault folder, e.g. `meetings/G01 Supervisor meeting.md`. */
  path: string
  /** The first occurrence: a day, a time, a zone (`2026-11-24 14:00`). */
  when: string
  /** How long: `1h`, `45m`, `1h30m`. */
  duration?: string
  /** How often it comes back: `week`, `2 weeks`, `month`, `month on the first Tuesday`. */
  every?: string
  /** The last day it may fall on. */
  until?: string
  /** The days of the occurrences skipped. */
  skip: string[]
  /** Each occurrence moved: `2026-12-01 → 2026-12-02 10:00`. */
  moved: string[]
  /** The notes that must be done by its next occurrence, by id: then it is a deadline too. */
  needs: string[]
  /** The names in `needs:` that are no note of the tree. */
  missing: string[]
}

/** How often a meeting comes back: every `n` days, weeks or months; on the `nth` weekday `wd` (Monday 0) of the month. */
export type Rule = { unit: 'day' | 'week' | 'month'; n: number; nth?: number; wd?: number }

/** One occurrence of a meeting: its day, its time and zone, the day its rule gives; moved elsewhere, or skipped. */
export type Occurrence = { day: string; at: Due; orig: string; moved?: true; skipped?: true }

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
  /** Running with no `started:`: when it ends is unknown. */
  noStart?: true
  waits?: true
  slack: number | null
}

export type DeadlinePlan = {
  id: string
  name: string
  kind: 'milestone' | 'note' | 'meeting'
  due: string
  dueText: string
  at: Due
  daysLeft: number
  slack: number | null
  atRisk: boolean
  items: PlanItem[]
  problems: string[]
  /** A meeting's: the day its rule gives the occurrence planned for (another when it was moved). */
  orig?: string
}

/** The days an experiment holds on a calendar, `from` up to `to` (the day after its last). */
export type Window = {
  id: string
  from: string
  to: string
  kind: 'planned' | 'running' | 'done'
  plannedTo?: string
  over?: boolean
  noEnd?: true
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
  windows: (nodes: Dated[], today: string) => Window[]
  gpuLoad: (nodes: Dated[], capacity: number | undefined, today: string) => GpuLoad
  plan: (nodes: Dated[], milestones: Milestone[], today: string, meetings?: Meeting[]) => DeadlinePlan[]
  when: (daysLeft: number) => string
  detail: (p: DeadlinePlan) => string
  deadlineLine: (p: DeadlinePlan) => string
  clashLine: (c: Clash, capacity: number) => string
  andList: (items: string[]) => string
  ics: (o: { project: string; nodes: Dated[]; milestones: Milestone[]; meetings?: Meeting[]; stamp: string }) => { text: string; events: number }
  parseDuration: (v: unknown) => number | null
  formatDuration: (minutes: number) => string
  parseEvery: (v: unknown) => Rule | null
  formatEvery: (r: Rule | null) => string
  listItems: (v: unknown) => string[]
  parseMoved: (v: unknown, start?: Due | null) => { from: string; to: Due } | null
  formatMoved: (from: string, to: Due) => string
  isOccurrence: (m: Meeting, day: string) => boolean
  occurrences: (m: Meeting, from: string, to: string, opts?: { skipped?: boolean }) => Occurrence[]
  nextOccurrence: (m: Meeting, today: string) => Occurrence | null
  upcoming: (meetings: Meeting[], from: string, to: string) => { meeting: Meeting; occ: Occurrence }[]
  repeatText: (m: Meeting) => string
  meetingLine: (m: Meeting, occ: Occurrence, today: string) => string
}

export const S = (globalThis as unknown as { RftSchedule: Api }).RftSchedule
