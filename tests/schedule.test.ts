// Deadlines and the schedule, written before the code as its specification.
//
// - Milestones (M..) are deadlines of any kind, in `vault/milestones/`, outside the reasoning
//   tree: `due:` (a day, a time, a zone: `2026-11-13 23:59 AoE`), `needs:` (the notes that must
//   be done first), `status:` open or suggested.
// - On experiments, the user's plan: `start:`, `est:` (3d, 2w), `after:` (notes it waits for);
//   on any note, `due:`. `gpus:` is a fact about the run, and Claude may write it. `started:` /
//   `finished:` are written by rft_set_status.
// - Dates are the user's: Claude's edits that change `due:`, `start:` or `est:` are refused.
//   Claude suggests dates (`suggested_start:`, `suggested_est:`, with why) and paper submissions
//   (a milestone with status `suggested` and the official dates page as `source:`); the user
//   accepts or dismisses them in the tree view. A deadline the user gives in the chat is added
//   once they confirm it in a dialog Claude cannot answer.
// - Planning is backwards from each due date, in whole days: a note must end by the due day,
//   so its latest start is the due day less its estimate, and less the estimates of the notes
//   that come after it. Its earliest start is the latest of today, its `start:` and the earliest
//   end of the notes it comes after; its slack is the days from earliest to latest start (for a
//   running note, from its expected end to its latest end). A deadline's slack is its smallest;
//   it is at risk at 0 days or less, or when one of its needs is dropped, superseded or missing.
// - GPUs: with `gpus:` in the config, the days on which the planned and running experiments
//   need more than that are reported. Nothing is moved.
// - `vault/rft.ics` holds the deadlines and the planned runs, for any calendar to import.

import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { nextReport } from '../hooks/lib/knowledge'
import { setStatus, today } from '../hooks/lib/ops'
import { gpuLoad, icsCalendar, parseDue, parseEst, plan, suggestDates, suggestDeadline, utcOf } from '../hooks/lib/schedule'
import { front, load, readConfig, sync, validate } from '../hooks/lib/vault'
import { S } from '../hooks/lib/dates'
import { CWD, D01, E02, MemoryFs, demoFiles, world } from './fixture'

const TODAY = '2026-11-09'

const E03 = 'E03 Ablate heads'
const E04 = 'E04 Combine methods'
const E05 = 'E05 Rerun on DINOv3'
const M01 = 'M01 Workshop paper'
const M02 = 'M02 Supervisor meeting'
const M03 = 'M03 Venue X paper'

const DIR: Record<string, string> = { E: 'experiments', D: 'directions', M: 'milestones' }
const path = (name: string) => `vault/${DIR[name[0]!]}/${name}.md`
const idOf = (name: string) => name.split(' ')[0]!
const titleOf = (name: string) => name.slice(idOf(name).length + 1)
const fm = (fields: Record<string, string>) => Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')
const link = (name: string) => `"[[${name}]]"`
const links = (...names: string[]) => `[${names.map(link).join(', ')}]`

/** The day `n` days after `day` (before, when negative). */
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** An experiment under D01, with more frontmatter. */
const experiment = (name: string, status: string, fields: Record<string, string> = {}) =>
  `---\n${fm({ id: idOf(name), type: 'experiment', status, date: '2026-11-01', parent: link(D01), ...fields })}\n---\n\n# ${idOf(name)} · ${titleOf(name)}\n\n## Result\nNot run yet.\n`

/** A milestone, open unless `fields` says otherwise. */
const milestone = (name: string, fields: Record<string, string> = {}) =>
  `---\n${fm({ id: idOf(name), type: 'milestone', status: 'open', ...fields })}\n---\n\n# ${idOf(name)} · ${titleOf(name)}\n`

type Opts = { e02?: Record<string, string>; gpus?: number }

/** The demo vault with the notes and milestones of `notes` (by name), E02's extra fields and the config's GPUs. */
function vaultFiles(notes: Record<string, string> = {}, opts: Opts = {}): Record<string, string> {
  const files = demoFiles()
  const config = JSON.parse(files['.rft/config.json']!)
  files['.rft/config.json'] = JSON.stringify({ ...config, lastId: { E: 5, D: 1, M: 2 }, ...(opts.gpus ? { gpus: opts.gpus } : {}) })
  if (opts.e02) files[path(E02)] = files[path(E02)]!.replace('status: running\n', `status: running\n${fm(opts.e02)}\n`)
  for (const [name, text] of Object.entries(notes)) files[path(name)] = text
  return files
}

async function setup(notes: Record<string, string> = {}, opts: Opts = {}) {
  const fs = new MemoryFs(vaultFiles(notes, opts))
  const io = fs.io()
  const l = await load(io, (await readConfig(io))!)
  return { fs, io, l }
}

/** Example 1: M01 on 12-05 needs E03 (3 days) and E04 (5 days, after E03). */
const example1 = () => ({
  [E03]: experiment(E03, 'planned', { est: '3d' }),
  [E04]: experiment(E04, 'planned', { est: '5d', after: links(E03) }),
  [M01]: milestone(M01, { due: '2026-12-05', needs: links(E03, E04) }),
})

/** Example 2: E02 has run since 11-02 on a 3-day estimate; M02 on 11-12 needs it and E05 (3 days, after E02). */
const example2 = () => ({
  notes: {
    [E05]: experiment(E05, 'planned', { est: '3d', after: links(E02) }),
    [M02]: milestone(M02, { due: '2026-11-12 14:00', needs: links(E02, E05) }),
  },
  e02: { started: '2026-11-02', est: '3d' },
})

describe('reading dates', () => {
  test('a due date is a day, with a time and a zone when given; AoE is UTC-12, no zone is local time', () => {
    expect(parseDue('2026-12-05')).toEqual({ day: '2026-12-05' })
    expect(parseDue('2026-11-12 14:00')).toEqual({ day: '2026-11-12', time: '14:00' })
    expect(parseDue('2026-11-13 23:59 AoE')).toEqual({ day: '2026-11-13', time: '23:59', zone: 'AoE' })
    expect(parseDue('2026-11-13 23:59 +01:00')).toEqual({ day: '2026-11-13', time: '23:59', zone: '+01:00' })
    expect(parseDue('next friday')).toBeNull()
    expect(parseDue('2026-02-30')).toBeNull()
    expect(utcOf({ day: '2026-11-13', time: '23:59', zone: 'AoE' })).toBe('2026-11-14T11:59:00Z')
    expect(utcOf({ day: '2026-11-13', time: '23:59', zone: '+01:00' })).toBe('2026-11-13T22:59:00Z')
    expect(utcOf({ day: '2026-11-12', time: '14:00' })).toBeNull()
  })

  test('an estimate is a whole number of days or weeks', () => {
    expect(parseEst('3d')).toBe(3)
    expect(parseEst('2w')).toBe(14)
    expect(parseEst('4')).toBe(4)
    for (const bad of ['1.5d', '0d', 'soon', '']) expect(parseEst(bad)).toBeNull()
  })

  test('the plan fields are read from the frontmatter; the validator names the bad ones', async () => {
    const { io, l } = await setup({
      [E03]: experiment(E03, 'planned', { start: '2026-11-27', est: '3d', gpus: '2' }),
      [E04]: experiment(E04, 'planned', { est: '1w', after: links(E03) }),
      [E05]: experiment(E05, 'planned', { est: 'soon', start: 'tomorrow' }),
    })
    expect(l.tree.nodes.E03).toMatchObject({ start: '2026-11-27', est: 3, gpus: 2 })
    expect(l.tree.nodes.E04).toMatchObject({ est: 7, after: ['E03'] })
    expect(l.tree.nodes.E05!.est).toBeUndefined()
    expect(l.tree.nodes.E05!.start).toBeUndefined()
    const warnings = (await validate(io, l, {})).warnings.join('\n')
    expect(warnings).toContain('E05: est "soon" is not a number of days or weeks (3d, 2w)')
    expect(warnings).toContain('E05: start "tomorrow" is not a date (2026-11-27)')
  })

  test('in a vault that uses no dates, rft_set_status writes no started: or finished:', async () => {
    const fs = new MemoryFs(demoFiles())
    const io = fs.io()
    const l = await load(io, (await readConfig(io))!)
    await setStatus(io, l, 'E02', 'done', undefined, undefined, '2026-11-14')
    const fm = front(fs.read(`vault/experiments/${E02}.md`))
    expect(fm.status).toBe('done')
    expect(fm.started).toBeUndefined()
    expect(fm.finished).toBeUndefined()
  })

  test('rft_set_status records the day a run started and the day it finished, once', async () => {
    const { fs, io, l } = await setup(example1())
    await setStatus(io, l, 'E03', 'running', undefined, undefined, '2026-11-10')
    expect(front(fs.read(path(E03)))).toMatchObject({ status: 'running', started: '2026-11-10' })
    await setStatus(io, l, 'E03', 'running', undefined, undefined, '2026-11-11')
    expect(front(fs.read(path(E03))).started).toBe('2026-11-10')
    await setStatus(io, l, 'E03', 'done', 'Heads 3 and 7 carry most of it', undefined, '2026-11-14')
    expect(front(fs.read(path(E03)))).toMatchObject({ started: '2026-11-10', finished: '2026-11-14' })
    expect(l.tree.nodes.E03).toMatchObject({ started: '2026-11-10', finished: '2026-11-14' })
    // done straight from planned: it finished, with no start known
    await setStatus(io, l, 'E04', 'done', undefined, undefined, '2026-11-15')
    expect(l.tree.nodes.E04).toMatchObject({ finished: '2026-11-15' })
    expect(l.tree.nodes.E04!.started).toBeUndefined()
  })
})

describe('milestones', () => {
  test('milestones live in vault/milestones, outside the reasoning tree', async () => {
    const { io, l } = await setup({
      ...example1(),
      [M03]: milestone(M03, { status: 'suggested', due: '2027-03-05 23:59 AoE', source: 'https://venue-x.org/dates', why: '"The positional-bias line has its main results"' }),
      'M04 Thesis chapter': milestone('M04 Thesis chapter', { due: 'next friday' }),
    })
    expect(l.milestones.map(m => [m.id, m.status])).toEqual([['M01', 'open'], ['M03', 'suggested'], ['M04', 'open']])
    expect(l.milestones[0]).toMatchObject({ name: M01, due: { day: '2026-12-05' }, needs: ['E03', 'E04'] })
    expect(l.milestones[1]).toMatchObject({ source: 'https://venue-x.org/dates', why: 'The positional-bias line has its main results' })
    expect(l.tree.nodes.M01).toBeUndefined()
    expect(l.tree.roots).toEqual(['D00'])
    const warnings = (await validate(io, l, {})).warnings.join('\n')
    expect(warnings).toContain('M04 Thesis chapter: due "next friday" is not a date (2026-11-13, 2026-11-13 23:59, 2026-11-13 23:59 AoE)')
  })

  test('example 1: the latest start of each needed note, backwards from the due day, following after:', async () => {
    const { l } = await setup(example1())
    const [m] = plan(l.tree, l.milestones, TODAY)
    expect(m).toMatchObject({ id: 'M01', due: '2026-12-05', daysLeft: 26, slack: 18, atRisk: false, problems: [] })
    // E04 takes 5 days to the due day; E03 takes 3 days before E04 starts, and E04 cannot start
    // before E03 could end (11-12)
    expect(m!.items).toMatchObject([{ id: 'E03', latestStart: '2026-11-27', slack: 18 }, { id: 'E04', latestStart: '2026-11-30', slack: 18 }])
  })

  test('a planned start counts from that day, not from today', async () => {
    const notes = example1()
    notes[E03] = experiment(E03, 'planned', { est: '3d', start: '2026-11-20' })
    const { l } = await setup(notes)
    const [m] = plan(l.tree, l.milestones, TODAY)
    expect(m!.items).toMatchObject([{ id: 'E03', latestStart: '2026-11-27', slack: 7 }, { id: 'E04', slack: 7 }])
    expect(m!.slack).toBe(7)
  })

  test('example 2: a run over its estimate uses up the slack, and the deadline is at risk at 0', async () => {
    const { notes, e02 } = example2()
    const { l } = await setup(notes, { e02 })
    const [m] = plan(l.tree, l.milestones, TODAY)
    expect(m).toMatchObject({ id: 'M02', due: '2026-11-12', daysLeft: 3, slack: 0, atRisk: true })
    // 7 days in on a 3-day estimate: 4 over, and it ends today at the earliest
    expect(m!.items).toMatchObject([
      { id: 'E02', latestStart: '2026-11-06', expectedEnd: '2026-11-09', overrun: 4, slack: 0 },
      { id: 'E05', latestStart: '2026-11-09', slack: 0 },
    ])
  })

  test('a run with no started: has no end the plan can know; the notes after it count from today', async () => {
    const { notes } = example2()
    const { l } = await setup(notes, { e02: { est: '3d' } })
    const [m] = plan(l.tree, l.milestones, TODAY)
    expect(m!.items).toMatchObject([
      { id: 'E02', noStart: true, slack: null },
      { id: 'E05', earliestStart: TODAY, latestStart: '2026-11-09', slack: 0 },
    ])
    expect(m!.items[0]).not.toHaveProperty('expectedEnd')
    expect(S.detail(m!)).toBe('at risk: E02 is running with no start date (started:); E05 must start today')
  })

  test('a run within its estimate can still be at risk, when the plan no longer fits', async () => {
    const { notes } = example2()
    const { l } = await setup(notes, { e02: { started: '2026-11-08', est: '3d' } })
    const [m] = plan(l.tree, l.milestones, TODAY)
    expect(m!.items[0]).toMatchObject({ id: 'E02', expectedEnd: '2026-11-11', slack: -2 })
    expect(m!.items[0]!.overrun).toBeUndefined()
    expect(m).toMatchObject({ slack: -2, atRisk: true })
  })

  test('example 3: a needed note dropped, superseded or missing is a problem, and one with no estimate is unknown', async () => {
    const { io, l } = await setup({
      [E03]: experiment(E03, 'dropped', { est: '3d' }),
      [E04]: experiment(E04, 'planned'),
      [E05]: experiment(E05, 'done', { superseded_by: link(E04) }),
      [M01]: milestone(M01, { due: '2026-12-05', needs: links(E03, E04, E05, 'E09 Gone') }),
    })
    const [m] = plan(l.tree, l.milestones, TODAY)
    expect(m).toMatchObject({ id: 'M01', slack: null, atRisk: true })
    expect(m!.items).toMatchObject([{ id: 'E04', noEstimate: true, slack: null }])
    expect(m!.problems).toEqual([`${E03} was dropped`, `${E05} was superseded by E04`, 'E09 Gone is not a note of the tree'])
    const warnings = (await validate(io, l, {})).warnings.join('\n')
    expect(warnings).toContain(`${M01} needs ${E03}, which was dropped: the user replaces it or takes it out of needs`)
    expect(warnings).toContain(`${M01} needs ${E05}, which was superseded by E04: the user replaces it or takes it out of needs`)
    expect(warnings).toContain(`${M01} needs [[E09 Gone]], which is not a note of the tree`)
  })

  test("a note's own due: is a deadline for that note alone; suggested milestones are not planned", async () => {
    const { l } = await setup({
      [E03]: experiment(E03, 'planned', { est: '3d', due: '2026-11-20' }),
      [M03]: milestone(M03, { status: 'suggested', due: '2027-03-05 23:59 AoE', source: 'https://venue-x.org/dates' }),
    })
    const plans = plan(l.tree, l.milestones, TODAY)
    expect(plans.map(p => p.id)).toEqual(['E03'])
    expect(plans[0]).toMatchObject({ due: '2026-11-20', daysLeft: 11, slack: 8, items: [{ id: 'E03', latestStart: '2026-11-17' }] })
  })
})

describe('GPUs', () => {
  test('the days on which the planned and running experiments need more GPUs than the machine has', async () => {
    const { l } = await setup({
      [E03]: experiment(E03, 'planned', { start: '2026-11-27', est: '3d', gpus: '2' }),
      [E04]: experiment(E04, 'planned', { start: '2026-11-28', est: '5d' }), // one GPU unless it says more
      [E05]: experiment(E05, 'planned', { start: '2026-12-10', est: '2d', gpus: '2' }),
    }, { gpus: 2, e02: { started: '2026-11-02', est: '3d' } })
    expect(gpuLoad(l.tree, l.config.gpus, TODAY)).toEqual({
      clashes: [{ from: '2026-11-28', to: '2026-11-29', need: 3, notes: [{ id: 'E03', gpus: 2 }, { id: 'E04', gpus: 1 }] }],
      noEnd: [],
    })
    // no gpus: in the config, no check
    expect(gpuLoad(l.tree, undefined, TODAY)).toEqual({ clashes: [], noEnd: [] })
  })

  test('a run with no end planned holds its GPUs through today, and is named', async () => {
    const { l } = await setup({
      [E03]: experiment(E03, 'planned', { start: TODAY, est: '2d', gpus: '1' }),
    }, { gpus: 2, e02: { started: '2026-11-05', gpus: '2' } })
    expect(gpuLoad(l.tree, l.config.gpus, TODAY)).toEqual({
      clashes: [{ from: TODAY, to: TODAY, need: 3, notes: [{ id: 'E02', gpus: 2 }, { id: 'E03', gpus: 1 }] }],
      noEnd: ['E02'],
    })
  })

  test('a running run with no started: is not on the calendar, nor counted for the GPUs', async () => {
    const { l } = await setup({
      [E03]: experiment(E03, 'planned', { start: TODAY, est: '2d' }),
    }, { gpus: 1, e02: { est: '3d' } })
    expect(S.windows(Object.values(l.tree.nodes), TODAY).map(w => w.id)).toEqual(['E03'])
    expect(gpuLoad(l.tree, l.config.gpus, TODAY)).toEqual({ clashes: [], noEnd: [] })
    expect(icsCalendar(l, '20261109T000000Z').text).not.toContain('UID:E02@')
  })
})

describe("Claude's suggestions", () => {
  test('Claude suggests a start and an estimate, with why; the plan keeps to the user\'s dates', async () => {
    const { fs, io, l } = await setup(example1())
    const said = await suggestDates(io, l, 'E03', { start: '2026-11-20', est: '4d' }, 'It must end before M01, with a day to spare')
    expect(said).toContain('The user accepts or dismisses it in the tree view')
    expect(fs.read(path(E03))).toContain('status: planned\nsuggested_start: 2026-11-20\nsuggested_est: 4d\nsuggested_dates_why: "It must end before M01, with a day to spare"\n')
    expect(l.tree.nodes.E03).toMatchObject({ suggestedStart: '2026-11-20', suggestedEst: 4, est: 3 })
    expect(l.tree.nodes.E03!.start).toBeUndefined()
    expect(plan(l.tree, l.milestones, TODAY)[0]).toMatchObject({ slack: 18 })
    await expect(suggestDates(io, l, 'E03', {}, 'why')).rejects.toThrow('suggest a start, an estimate or both')
    await expect(suggestDates(io, l, 'E03', { start: 'soon' }, 'why')).rejects.toThrow('start must be a date')
    await expect(suggestDates(io, l, 'E03', { est: '2d' }, ' ')).rejects.toThrow('say why in one line')
    await expect(suggestDates(io, l, 'D01', { est: '2d' }, 'why')).rejects.toThrow('only experiments have a start and an estimate')
    await expect(suggestDates(io, l, 'X9', { est: '2d' }, 'why')).rejects.toThrow('not a note of the tree')
  })

  test('a paper submission is only suggested, from its official dates page', async () => {
    const { fs, io, l } = await setup(example1())
    const said = await suggestDeadline(io, l, { title: 'Venue X paper', due: '2027-03-05 23:59 AoE', source: 'https://venue-x.org/dates', why: 'The positional-bias line has its main results', needs: ['E03'] })
    expect(said).toContain(`Suggested ${M03}`)
    expect(front(fs.read(path(M03)))).toMatchObject({ id: 'M03', type: 'milestone', status: 'suggested', due: '2027-03-05 23:59 AoE', source: 'https://venue-x.org/dates' })
    expect(l.milestones.map(m => [m.id, m.status])).toEqual([['M01', 'open'], ['M03', 'suggested']])
    const count = fs.files.size
    const suggest = (s: Record<string, unknown>) => suggestDeadline(io, l, { title: 'Venue Y paper', due: '2027-04-01', source: 'https://venue-y.org/dates', why: 'why', ...s } as never)
    await expect(suggest({ source: undefined })).rejects.toThrow('give the official dates page (source), read now, not a date from memory')
    await expect(suggest({ source: 'venue-y.org/dates' })).rejects.toThrow('source must be a web address')
    await expect(suggest({ due: 'April' })).rejects.toThrow('due must be a date')
    await expect(suggest({ why: '' })).rejects.toThrow('say why in one line')
    expect(fs.files.size).toBe(count)
  })
})

describe('the calendar file', () => {
  test('rft.ics holds the open deadlines and the planned runs, never the suggestions', async () => {
    const { notes, e02 } = example2()
    const { l } = await setup({
      ...example1(),
      ...notes,
      [E03]: experiment(E03, 'planned', { est: '3d', start: '2026-11-27', suggested_start: '2026-11-20' }),
      [M03]: milestone(M03, { status: 'suggested', due: '2027-03-05 23:59 AoE', source: 'https://venue-x.org/dates' }),
      'M04 Rebuttal, round one': milestone('M04 Rebuttal, round one', { due: '2026-11-13 23:59 AoE' }),
    }, { e02 })
    const ics = icsCalendar(l, '2026-11-09T08:00:00Z')
    expect(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//rft//demo//EN\r\n')).toBe(true)
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n')
    // a day; a local time, floating; a time in a zone, in UTC; a comma escaped
    expect(ics).toContain('UID:M01@demo.rft\r\nDTSTAMP:20261109T080000Z\r\nDTSTART;VALUE=DATE:20261205\r\nSUMMARY:M01 Workshop paper\r\n')
    expect(ics).toContain('UID:M02@demo.rft\r\nDTSTAMP:20261109T080000Z\r\nDTSTART:20261112T140000\r\nSUMMARY:M02 Supervisor meeting\r\n')
    expect(ics).toContain('DTSTART:20261114T115900Z\r\nSUMMARY:M04 Rebuttal\\, round one\r\n')
    // planned runs as whole days, the end the day after the last
    expect(ics).toContain('UID:E03@demo.rft\r\nDTSTAMP:20261109T080000Z\r\nDTSTART;VALUE=DATE:20261127\r\nDTEND;VALUE=DATE:20261130\r\nSUMMARY:E03 Ablate heads\r\n')
    expect(ics).toContain('UID:E02@demo.rft\r\nDTSTAMP:20261109T080000Z\r\nDTSTART;VALUE=DATE:20261102\r\nDTEND;VALUE=DATE:20261105\r\n')
    expect(ics).not.toContain('Venue X')
    expect(ics).not.toContain('20261120')
    // E04 and E05 have no start: they are not on the calendar
    expect(ics).not.toContain('UID:E04@')
    expect(ics).not.toContain('UID:E05@')
  })

  test('rft_sync writes vault/rft.ics when there is a date to show, and leaves it alone when nothing changed', async () => {
    const empty = await setup()
    await sync(empty.io, empty.l)
    expect(empty.fs.files.has('vault/rft.ics')).toBe(false)
    const { fs, io, l } = await setup(example1())
    expect((await sync(io, l)).changed).toContain('rft.ics')
    expect(fs.read('vault/rft.ics')).toContain('SUMMARY:M01 Workshop paper')
    expect((await sync(io, l)).changed).not.toContain('rft.ics')
  })
})

describe('rft_next', () => {
  test('the deadlines come first, nearest first, with what puts them at risk; GPU clashes and waiting suggestions after', async () => {
    const { notes, e02 } = example2()
    const { io, l } = await setup({
      ...example1(),
      ...notes,
      [M03]: milestone(M03, { status: 'suggested', due: '2027-03-05 23:59 AoE', source: 'https://venue-x.org/dates' }),
    }, { e02, gpus: 2 })
    const out = await nextReport(io, l, TODAY)
    expect(out).toContain('## Deadlines (2, nearest first)\n')
    expect(out.indexOf(M02)).toBeLessThan(out.indexOf(M01))
    expect(out).toContain(`${M02} · 2026-11-12 14:00 (in 3d) · at risk: E02 4d over its 3d estimate; E05 must start today`)
    expect(out).toContain(`${M01} · 2026-12-05 (in 26d) · 18d of slack: E03 by 2026-11-27, E04 by 2026-11-30`)
    expect(out).toContain(`Suggested deadlines waiting for the user (the tree view's Calendar): ${M03}.`)
  })

  test('the GPU clashes are listed with the deadlines', async () => {
    const { io, l } = await setup({
      [E03]: experiment(E03, 'planned', { start: '2026-11-27', est: '3d', gpus: '2' }),
      [E04]: experiment(E04, 'planned', { start: '2026-11-28', est: '5d' }),
    }, { gpus: 2 })
    expect(await nextReport(io, l, TODAY)).toContain('GPUs: 2026-11-28→2026-11-29, E03 (2 GPUs) and E04 (1 GPU) need 3 of 2')
  })
})

describe('in a session', () => {
  /** A session on the vault of `vaultFiles`, the user answering a dialog with `answer` (null: dismissed). */
  async function session($: Engine, on: On, notes: Record<string, string> = {}, opts: Opts = {}, answer: string | null = null) {
    mock.clock(on)
    const w = world(on, vaultFiles(notes, opts))
    const asked: string[] = []
    const ran: string[] = []
    on('tool.call', (_$, e) => {
      if (e.tool !== 'AskUserQuestion') { ran.push(String(e.tool)); return { result: 'ok', text: 'ok' } as never }
      const q = (e as unknown as { questions: { question: string; options: { label: string }[] }[] }).questions[0]!
      asked.push(`${q.question} [${q.options.map(o => o.label).join(' | ')}]`)
      if (answer === null) return { deny: 'The user dismissed the dialog' } as never
      return { result: { questions: [q], answers: { [q.question]: answer } }, text: `"${q.question}"="${answer}"` } as never
    })
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    return { w, asked, ran }
  }

  test("Claude cannot set or change a date, and is told to suggest one; gpus: and needs: are Claude's to write", async ($, on) => {
    const { ran } = await session($, on, {
      [E03]: experiment(E03, 'planned', { start: '2026-11-27', est: '3d' }),
      [M01]: milestone(M01, { due: '2026-12-05', needs: links(E03) }),
    })
    for (const call of [
      { tool: 'Edit', file_path: `${CWD}/${path(E03)}`, old_string: 'est: 3d', new_string: 'est: 2d' },
      { tool: 'Edit', file_path: `${CWD}/${path(E03)}`, old_string: 'start: 2026-11-27\n', new_string: '' },
      { tool: 'Edit', file_path: `${CWD}/${path(E02)}`, old_string: 'status: running\n', new_string: 'status: running\ndue: 2026-11-20\n' },
      { tool: 'Edit', file_path: `${CWD}/${path(M01)}`, old_string: 'due: 2026-12-05', new_string: 'due: 2026-12-12' },
      { tool: 'Write', file_path: `${CWD}/vault/milestones/M02 By hand.md`, content: milestone('M02 By hand', { due: '2026-12-01' }) },
      { tool: 'Bash', command: `sed -i 's/est: 3d/est: 2d/' "${path(E03)}"` },
    ]) {
      const res = await $.tool.call(call as never)
      expect({ call, deny: (res as { deny?: string }).deny }).toEqual({ call, deny: expect.stringContaining("Dates are the user's") })
    }
    const res = await $.tool.call({ tool: 'Edit', file_path: `${CWD}/${path(E03)}`, old_string: 'est: 3d', new_string: 'est: 2d' } as never)
    expect((res as { deny?: string }).deny).toBe(`Dates are the user's: they set due:, start: and est: in the tree view (the Calendar, or the note's drawer), and your edits that change them are refused. To propose dates, call rft_suggest_dates {id: "E03", start, est, why}; for a deadline the user gives you, rft_add_deadline (they confirm it); for a paper submission, rft_suggest_deadline with its official dates page.`)
    expect(ran).toEqual([])
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/${path(E03)}`, old_string: 'est: 3d\n', new_string: 'est: 3d\ngpus: 2\n' } as never)
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/${path(M01)}`, old_string: links(E03), new_string: links(E03, E02) } as never)
    expect(ran).toEqual(['Edit', 'Edit'])
  })

  test('a deadline the user gives in the chat is added once they confirm it', async ($, on) => {
    const due = `${addDays(today(), 3)} 14:00`
    const { w, asked } = await session($, on, {}, {}, 'Add it')
    const res = await $.tool.call({ tool: 'mcp__rft__rft_add_deadline', title: 'Supervisor meeting', due, needs: ['E02'] } as never)
    expect(asked).toEqual([`Add the deadline "Supervisor meeting" on ${due}, needing E02? [Add it | Don't add]`])
    // ids are never reused: the config's last milestone id is M02
    expect(res.text).toContain('Added M03 Supervisor meeting')
    expect(front(w.fs.read('vault/milestones/M03 Supervisor meeting.md'))).toMatchObject({ id: 'M03', type: 'milestone', status: 'open', due, needs: `[${link(E02)}]` })
    expect(JSON.parse(w.fs.read('.rft/config.json')).lastId.M).toBe(3)
  })

  for (const [how, answer] of [['declines', "Don't add"], ['dismisses', null]] as const) {
    test(`a deadline the user ${how} is not added`, async ($, on) => {
      const { w } = await session($, on, {}, {}, answer)
      const res = await $.tool.call({ tool: 'mcp__rft__rft_add_deadline', title: 'Supervisor meeting', due: addDays(today(), 3) } as never)
      expect(res.text).toContain('The user did not add it')
      expect(w.fs.exists('vault/milestones')).toBe(false)
    })
  }

  test('session start names the deadlines of the next 14 days that are at risk', async ($, on) => {
    const t = today()
    await session($, on, {
      [E05]: experiment(E05, 'planned', { est: '3d', after: links(E02) }),
      [M02]: milestone(M02, { due: addDays(t, 3), needs: links(E02, E05) }),
      [M01]: milestone(M01, { due: addDays(t, 40) }),
    }, { e02: { started: addDays(t, -7), est: '3d' } })
    const res = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    const rules = res.sections.find(s => s.id === 'rft:rules')!.text
    expect(rules).toContain(`Deadlines: ${M02} in 3d, at risk (rft_next says why)`)
    expect(rules).not.toContain(M01)
  })
})
