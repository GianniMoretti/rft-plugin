// Meetings on the calendar, written before the code as its specification (the examples the user
// confirmed on 2026-11-20).
//
// - A meeting (G..) is one note in `vault/meetings/`, outside the reasoning tree: `when:` (its
//   first day, a time, a zone), `duration:` (1h, 45m, 1h30m) and, for one that comes back,
//   `every:` (day, week, 2 weeks, month on the same date, month on the first Tuesday, … the last
//   Friday) up to `until:` (a day, included).
// - A single occurrence is skipped (`skip: [2026-12-22]`) or moved (`moved: ["2026-12-01 →
//   2026-12-02 10:00"]`; a day alone keeps the meeting's time); the user does both in the
//   Calendar, as they set everything else of a meeting: Claude's edits of its times are refused.
// - A meeting with `needs:` is a deadline too, at its next occurrence.
// - Claude adds a meeting the user gives in the chat with rft_add_meeting, once they confirm it.
// - rft_next lists the meetings of the next 7 days; `vault/rft.ics` holds each as one event, or a
//   series (RRULE, EXDATE, RECURRENCE-ID for a moved one).

import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { nextReport } from '../hooks/lib/knowledge'
import { today } from '../hooks/lib/ops'
import { icsCalendar, plan } from '../hooks/lib/schedule'
import { featuresInUse } from '../hooks/lib/tools'
import { front, load, readConfig, validate } from '../hooks/lib/vault'
import { S } from '../hooks/lib/dates'
import type { Meeting } from '../hooks/lib/dates'
import { CWD, D01, E02, MemoryFs, demoFiles, world } from './fixture'

const TODAY = '2026-11-09' // a Monday

const E03 = 'E03 Ablate heads'
const G01 = 'G01 Supervisor meeting'
const G02 = 'G02 Lab meeting'
const G03 = 'G03 Reading group'

const DIR: Record<string, string> = { E: 'experiments', D: 'directions', G: 'meetings' }
const path = (name: string) => `vault/${DIR[name[0]!]}/${name}.md`
const idOf = (name: string) => name.split(' ')[0]!
const titleOf = (name: string) => name.slice(idOf(name).length + 1)
const fm = (fields: Record<string, string>) => Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')
const link = (name: string) => `"[[${name}]]"`
const links = (...names: string[]) => `[${names.map(link).join(', ')}]`

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const experiment = (name: string, status: string, fields: Record<string, string> = {}) =>
  `---\n${fm({ id: idOf(name), type: 'experiment', status, date: '2026-11-01', parent: link(D01), ...fields })}\n---\n\n# ${idOf(name)} · ${titleOf(name)}\n\n## Result\nNot run yet.\n`

const meetingFile = (name: string, fields: Record<string, string>) =>
  `---\n${fm({ id: idOf(name), type: 'meeting', ...fields })}\n---\n\n# ${idOf(name)} · ${titleOf(name)}\n`

/** Example 1: every Tuesday at 14:00 for an hour, until the end of June; Christmas skipped, 1 Dec moved to Wednesday morning. */
const supervisor = (extra: Record<string, string> = {}) => meetingFile(G01, {
  when: '2026-11-10 14:00', duration: '1h', every: 'week', until: '2027-06-29',
  skip: '[2026-12-22, 2026-12-29]', moved: '["2026-12-01 → 2026-12-02 10:00"]', ...extra,
})

/** Example 2: once, on 3 Dec at 10:30, for 90 minutes. */
const reading = (extra: Record<string, string> = {}) => meetingFile(G03, { when: '2026-12-03 10:30', duration: '1h30m', ...extra })

/** A meeting as the loader gives it, from its fields. */
const meeting = (fields: Partial<Meeting> & { when: string }): Meeting =>
  ({ id: 'G09', name: 'G09 Test', title: 'Test', path: 'meetings/G09 Test.md', skip: [], moved: [], needs: [], missing: [], ...fields })

const days = (m: Meeting, from: string, to: string) => S.occurrences(m, from, to).map(o => o.day)

function vaultFiles(notes: Record<string, string> = {}, lastG?: number): Record<string, string> {
  const files = demoFiles()
  const config = JSON.parse(files['.rft/config.json']!)
  files['.rft/config.json'] = JSON.stringify({ ...config, lastId: { E: 5, D: 1, ...(lastG ? { G: lastG } : {}) } })
  for (const [name, text] of Object.entries(notes)) files[path(name)] = text
  return files
}

async function setup(notes: Record<string, string> = {}) {
  const fs = new MemoryFs(vaultFiles(notes))
  const io = fs.io()
  const l = await load(io, (await readConfig(io))!)
  return { fs, io, l }
}

describe('reading a meeting', () => {
  test('how often it comes back: a day, a week or a month, n of them, or a weekday of the month', () => {
    expect(S.parseEvery('week')).toEqual({ unit: 'week', n: 1 })
    expect(S.parseEvery('2 weeks')).toEqual({ unit: 'week', n: 2 })
    expect(S.parseEvery('every 2 weeks')).toEqual({ unit: 'week', n: 2 })
    expect(S.parseEvery('1w')).toEqual({ unit: 'week', n: 1 })
    expect(S.parseEvery('weekly')).toEqual({ unit: 'week', n: 1 })
    expect(S.parseEvery('day')).toEqual({ unit: 'day', n: 1 })
    expect(S.parseEvery('month')).toEqual({ unit: 'month', n: 1 })
    expect(S.parseEvery('month on the first Tuesday')).toEqual({ unit: 'month', n: 1, nth: 1, wd: 1 })
    expect(S.parseEvery('2 months on the third wed')).toEqual({ unit: 'month', n: 2, nth: 3, wd: 2 })
    expect(S.parseEvery('monthly on the last Friday')).toEqual({ unit: 'month', n: 1, nth: -1, wd: 4 })
    for (const bad of ['fortnightly', '2 weekly', '0 weeks', 'week on the first Tuesday', 'month on the first monkey', 'soon', ''])
      expect({ bad, rule: S.parseEvery(bad) }).toEqual({ bad, rule: null })
    // written back the one way
    expect(['1w', 'every 2 weeks', 'monthly on the last fri'].map(v => S.formatEvery(S.parseEvery(v)))).toEqual(['week', '2 weeks', 'month on the last Friday'])
  })

  test('how long: hours and minutes', () => {
    expect(['1h', '45m', '1h30m', '1h 30m', '90 min'].map(S.parseDuration)).toEqual([60, 45, 90, 90, 90])
    for (const bad of ['', 'h', '1.5h', '0m', 'long']) expect(S.parseDuration(bad)).toBeNull()
    expect([60, 45, 90].map(S.formatDuration)).toEqual(['1h', '45m', '1h30m'])
  })

  test('meetings live in vault/meetings, outside the reasoning tree; the validator names what is wrong', async () => {
    const { io, l } = await setup({
      [G01]: supervisor({ needs: links(E02, 'E09 Gone') }),
      [G02]: meetingFile(G02, { when: '2026-11-11 10:00', every: 'fortnightly', skip: '[2026-11-12, soon]' }),
      [G03]: reading({ duration: 'long', moved: '["2026-12-03 → 2026-12-04"]' }),
      'G04 Retreat': meetingFile('G04 Retreat', { when: 'spring', every: 'week' }),
    })
    expect(l.meetings.map(m => m.id)).toEqual(['G01', 'G02', 'G03', 'G04'])
    expect(l.meetings[0]).toEqual({
      id: 'G01', name: G01, title: 'Supervisor meeting', path: `meetings/${G01}.md`, when: '2026-11-10 14:00', duration: '1h', every: 'week',
      until: '2027-06-29', skip: ['2026-12-22', '2026-12-29'], moved: ['2026-12-01 → 2026-12-02 10:00'], needs: ['E02'], missing: ['E09 Gone'],
    })
    expect(l.tree.nodes.G01).toBeUndefined()
    expect(featuresInUse(l, false).has('dates')).toBe(true)
    const warnings = (await validate(io, l, {})).warnings.join('\n')
    expect(warnings).toContain(`${G01} needs [[E09 Gone]], which is not a note of the tree`)
    expect(warnings).toContain(`${G02}: every "fortnightly" is not how often it comes back (week, 2 weeks, month, month on the first Tuesday): it is shown once`)
    expect(warnings).toContain(`${G02}: skip "soon" is not a date`)
    expect(warnings).toContain(`${G03}: duration "long" is not a length (1h, 45m, 1h30m)`)
    expect(warnings).toContain(`${G03}: skip and moved are for a meeting that comes back (every:); move a single meeting by its when:`)
    expect(warnings).toContain('G04 Retreat: when "spring" is not a date (2026-11-13, 2026-11-13 23:59, 2026-11-13 23:59 AoE)')
    expect(warnings).not.toContain(`${G01}: skip`)
    expect(warnings).not.toContain(`${G01}: moved`)
  })

  test('a skipped or moved day that the meeting does not fall on is named', async () => {
    const { io, l } = await setup({ [G01]: supervisor({ skip: '[2026-12-23]', moved: '["2026-12-02 → 2026-12-03"]' }) })
    const warnings = (await validate(io, l, {})).warnings.join('\n')
    expect(warnings).toContain(`${G01}: skip 2026-12-23 is not a day it falls on`)
    expect(warnings).toContain(`${G01}: moved 2026-12-02 is not a day it falls on`)
  })
})

describe('occurrences', () => {
  test('example 1: every Tuesday from its first, but the skipped ones, a moved one on its new day and time, none after until', async () => {
    const { l } = await setup({ [G01]: supervisor() })
    const m = l.meetings[0]!
    expect(S.occurrences(m, '2026-11-01', '2027-01-15').map(o => `${S.formatDue(o.at)}${o.moved ? ` (moved from ${o.orig})` : ''}`)).toEqual([
      '2026-11-10 14:00', '2026-11-17 14:00', '2026-11-24 14:00', '2026-12-02 10:00 (moved from 2026-12-01)', '2026-12-08 14:00',
      '2026-12-15 14:00', '2027-01-05 14:00', '2027-01-12 14:00',
    ])
    // the skipped ones, when asked for (the Calendar shows them, to bring one back)
    expect(S.occurrences(m, '2026-12-20', '2027-01-01', { skipped: true })).toEqual([
      { day: '2026-12-22', at: { day: '2026-12-22', time: '14:00' }, orig: '2026-12-22', skipped: true },
      { day: '2026-12-29', at: { day: '2026-12-29', time: '14:00' }, orig: '2026-12-29', skipped: true },
    ])
    // until is the last day it may fall on
    expect(days(m, '2027-06-15', '2027-08-01')).toEqual(['2027-06-15', '2027-06-22', '2027-06-29'])
    expect(S.nextOccurrence(m, '2026-11-25')).toMatchObject({ day: '2026-12-02', orig: '2026-12-01', moved: true })
    expect(S.nextOccurrence(m, '2027-06-30')).toBeNull()
    expect(S.repeatText(m)).toBe('every week until 2027-06-29')
    expect(S.meetingLine(m, S.nextOccurrence(m, TODAY)!, TODAY)).toBe(`${G01} · 2026-11-10 14:00 (in 1d) · 1h, every week until 2027-06-29`)
  })

  test('example 2: a single meeting, once', async () => {
    const { l } = await setup({ [G03]: reading() })
    const m = l.meetings[0]!
    expect(days(m, '2026-11-01', '2027-12-31')).toEqual(['2026-12-03'])
    expect(S.repeatText(m)).toBe('once')
    expect(S.nextOccurrence(m, '2026-12-04')).toBeNull()
  })

  test('every 2 weeks, every day, every 3 days', () => {
    expect(days(meeting({ when: '2026-11-11 10:00', every: '2 weeks' }), '2026-11-20', '2026-12-31')).toEqual(['2026-11-25', '2026-12-09', '2026-12-23'])
    expect(days(meeting({ when: '2026-11-11 09:00', every: 'day', until: '2026-11-13' }), '2026-11-01', '2026-12-01')).toEqual(['2026-11-11', '2026-11-12', '2026-11-13'])
    expect(days(meeting({ when: '2026-11-11', every: '3 days' }), '2026-11-12', '2026-11-21')).toEqual(['2026-11-14', '2026-11-17', '2026-11-20'])
  })

  test('every month on the same date: a 31st skips the months without one', () => {
    expect(days(meeting({ when: '2027-01-31 10:00', every: 'month' }), '2027-01-01', '2027-08-01')).toEqual(['2027-01-31', '2027-03-31', '2027-05-31', '2027-07-31'])
    expect(days(meeting({ when: '2026-11-15', every: '2 months' }), '2026-11-01', '2027-06-01')).toEqual(['2026-11-15', '2027-01-15', '2027-03-15', '2027-05-15'])
  })

  test('the first Tuesday of the month, the last Friday every 2 months, a fifth Monday where there is one', () => {
    // from a day that is no first Tuesday: the first one after it
    expect(days(meeting({ when: '2026-11-24 10:00', every: 'month on the first Tuesday' }), '2026-11-01', '2027-04-01')).toEqual(['2026-12-01', '2027-01-05', '2027-02-02', '2027-03-02'])
    expect(days(meeting({ when: '2026-11-01 16:00', every: '2 months on the last Friday' }), '2026-11-01', '2027-08-01')).toEqual(['2026-11-27', '2027-01-29', '2027-03-26', '2027-05-28', '2027-07-30'])
    expect(days(meeting({ when: '2026-11-01 09:00', every: 'month on the fifth Monday' }), '2026-11-01', '2027-12-31')).toEqual(['2026-11-30', '2027-03-29', '2027-05-31', '2027-08-30', '2027-11-29'])
    expect(S.nthOf('2026-11-24')).toEqual({ wd: 1, nth: 4, last: true })
    expect(S.nthOf('2026-11-17')).toEqual({ wd: 1, nth: 3, last: false })
  })

  test('a moved one keeps the time and zone it does not give; one moved away from the range still leaves it', () => {
    const m = meeting({ when: '2026-11-10 16:00 UTC', every: 'week', moved: ['2026-11-17 → 2026-11-19', '2026-11-24 → 2026-12-30 09:00'] })
    expect(S.occurrences(m, '2026-11-15', '2026-11-29').map(o => S.formatDue(o.at))).toEqual(['2026-11-19 16:00 UTC'])
    expect(S.occurrences(m, '2026-12-28', '2026-12-31').map(o => [o.day, o.orig])).toEqual([['2026-12-29', '2026-12-29'], ['2026-12-30', '2026-11-24']])
    expect(S.formatMoved('2026-12-01', { day: '2026-12-02', time: '10:00' })).toBe('2026-12-01 → 2026-12-02 10:00')
  })

  test('a rule that is none shows the meeting once, at its when', () => {
    expect(days(meeting({ when: '2026-11-11 10:00', every: 'fortnightly' }), '2026-11-01', '2027-01-01')).toEqual(['2026-11-11'])
  })
})

describe('a meeting with needs', () => {
  test('is a deadline at its next occurrence, planned backwards as the others are', async () => {
    const { l } = await setup({
      [E03]: experiment(E03, 'planned', { est: '3d' }),
      [G01]: supervisor({ needs: links(E03) }),
      [G03]: reading(),
    })
    const plans = plan(l.tree, l.milestones, TODAY, l.meetings)
    expect(plans.map(p => [p.id, p.kind, p.dueText])).toEqual([['G01', 'meeting', '2026-11-10 14:00']])
    expect(plans[0]).toMatchObject({ daysLeft: 1, slack: -2, atRisk: true, orig: '2026-11-10', items: [{ id: 'E03', latestStart: '2026-11-07' }] })
    // a week later, the next one
    expect(plan(l.tree, l.milestones, '2026-11-11', l.meetings)[0]).toMatchObject({ dueText: '2026-11-17 14:00', daysLeft: 6, slack: 3 })
    // moved: planned for its new day
    expect(plan(l.tree, l.milestones, '2026-11-25', l.meetings)[0]).toMatchObject({ dueText: '2026-12-02 10:00', orig: '2026-12-01' })
  })

  test('a single one that is over is no longer planned for', async () => {
    const { l } = await setup({ [E03]: experiment(E03, 'planned', { est: '3d' }), [G03]: reading({ needs: links(E03) }) })
    expect(plan(l.tree, l.milestones, '2026-11-20', l.meetings).map(p => p.id)).toEqual(['G03'])
    expect(plan(l.tree, l.milestones, '2026-12-04', l.meetings)).toEqual([])
  })
})

describe('the calendar file', () => {
  test('a series: its rule, its skipped days, a moved one as an event of its own; a single one in UTC', async () => {
    const { l } = await setup({
      [G01]: supervisor(),
      [G02]: meetingFile(G02, { when: '2026-11-26 16:00 +01:00', duration: '45m', every: 'month on the last Thursday', until: '2027-03-01', skip: '[2026-12-31]' }),
      [G03]: reading({ when: '2026-12-03 10:30 AoE' }),
      'G04 Lab day': meetingFile('G04 Lab day', { when: '2026-11-13', every: '2 weeks' }),
    })
    const ics = icsCalendar(l, '2026-11-09T08:00:00Z')
    expect(ics).toContain('UID:G01@demo.rft\r\nDTSTAMP:20261109T080000Z\r\nDTSTART:20261110T140000\r\nRRULE:FREQ=WEEKLY;UNTIL=20270629T235959\r\n'
      + 'EXDATE:20261222T140000,20261229T140000\r\nDURATION:PT1H\r\nSUMMARY:G01 Supervisor meeting\r\n')
    expect(ics).toContain('UID:G01@demo.rft\r\nDTSTAMP:20261109T080000Z\r\nRECURRENCE-ID:20261201T140000\r\nDTSTART:20261202T100000\r\nDURATION:PT1H\r\n')
    // a zone of whole hours, by its IANA name, so the rule counts weekdays there; until in UTC
    expect(ics).toContain('BEGIN:VTIMEZONE\r\nTZID:Etc/GMT-1\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0100\r\n')
    expect(ics).toContain('DTSTART;TZID=Etc/GMT-1:20261126T160000\r\nRRULE:FREQ=MONTHLY;BYDAY=-1TH;UNTIL=20270301T225959Z\r\nEXDATE;TZID=Etc/GMT-1:20261231T160000\r\nDURATION:PT45M\r\n')
    expect(ics).toContain('UID:G03@demo.rft\r\nDTSTAMP:20261109T080000Z\r\nDTSTART:20261203T223000Z\r\nDURATION:PT1H30M\r\nSUMMARY:G03 Reading group\r\n')
    expect(ics).toContain('DTSTART;VALUE=DATE:20261113\r\nRRULE:FREQ=WEEKLY;INTERVAL=2\r\nSUMMARY:G04 Lab day\r\n')
    expect(ics.indexOf('BEGIN:VTIMEZONE')).toBeLessThan(ics.indexOf('BEGIN:VEVENT'))
    // a series starts on the first day its rule gives
    expect(S.ics({ project: 'demo', nodes: [], milestones: [], meetings: [meeting({ when: '2026-11-24 10:00', every: 'month on the first Tuesday' })], stamp: TODAY }).text)
      .toContain('DTSTART:20261201T100000\r\nRRULE:FREQ=MONTHLY;BYDAY=1TU\r\n')
  })
})

describe('rft_next', () => {
  test('lists the meetings of the next 7 days, and one with needs with the deadlines', async () => {
    const { io, l } = await setup({
      [E03]: experiment(E03, 'planned', { est: '1d' }),
      [G01]: supervisor(),
      [G02]: meetingFile(G02, { when: '2026-11-12 10:00', needs: links(E03) }),
      [G03]: reading(),
    })
    const out = await nextReport(io, l, TODAY)
    expect(out).toContain(`## Meetings (the next 7 days)\n  ${G01} · 2026-11-10 14:00 (in 1d) · 1h, every week until 2027-06-29\n  ${G02} · 2026-11-12 10:00 (in 3d) · once\n`)
    expect(out).not.toContain(G03)
    expect(out).toContain(`${G02} · 2026-11-12 10:00 (in 3d) · 2d of slack: E03 by 2026-11-11`)
  })
})

describe('in a session', () => {
  async function session($: Engine, on: On, notes: Record<string, string> = {}, answer: string | null = null, lastG?: number) {
    mock.clock(on)
    const w = world(on, vaultFiles(notes, lastG))
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

  test('a meeting the user gives in the chat is added once they confirm it', async ($, on) => {
    const when = `${addDays(today(), 3)} 14:00`
    const { w, asked } = await session($, on, {}, 'Add it', 4)
    const res = await $.tool.call({ tool: 'mcp__rft__rft_add_meeting', title: 'Supervisor meeting', when, duration: '60 min', every: 'weekly', until: '2027-06-29', needs: ['E02'] } as never)
    expect(asked).toEqual([`Add the meeting "Supervisor meeting": ${when}, 1h, every week until 2027-06-29, needing E02 by the next one? [Add it | Don't add]`])
    // ids are never reused: the config's last meeting id is G04
    expect(res.text).toContain('Added G05 Supervisor meeting')
    expect(w.fs.read('vault/meetings/G05 Supervisor meeting.md')).toBe(
      `---\nid: G05\ntype: meeting\nwhen: ${when}\nduration: 1h\nevery: week\nuntil: 2027-06-29\nneeds: [${link(E02)}]\n---\n\n# G05 · Supervisor meeting\n`)
    expect(JSON.parse(w.fs.read('.rft/config.json')).lastId.G).toBe(5)
  })

  test('a single one, with the first Tuesday of the month written back one way', async ($, on) => {
    const { w } = await session($, on, {}, 'Add it')
    await $.tool.call({ tool: 'mcp__rft__rft_add_meeting', title: 'Lab meeting', when: '2026-12-01 10:00', every: 'monthly on the first tue' } as never)
    expect(front(w.fs.read('vault/meetings/G01 Lab meeting.md'))).toMatchObject({ id: 'G01', every: 'month on the first Tuesday' })
    await $.tool.call({ tool: 'mcp__rft__rft_add_meeting', title: 'Talk', when: '2026-12-03 10:30 AoE' } as never)
    expect(front(w.fs.read('vault/meetings/G02 Talk.md'))).toEqual({ id: 'G02', type: 'meeting', when: '2026-12-03 10:30 AoE' })
  })

  test('a meeting that is none is refused before the user is asked', async ($, on) => {
    const { w, asked } = await session($, on, {}, 'Add it')
    for (const [input, says] of [
      [{ title: 'Talk', when: 'next friday' }, 'when must be its (first) day and time'],
      [{ title: 'Talk', when: '2026-12-03 10:30', every: 'fortnightly' }, 'every must say how often it comes back'],
      [{ title: 'Talk', when: '2026-12-03 10:30', until: '2027-01-01' }, 'until is the last day of a meeting that comes back'],
      [{ title: 'Talk', when: '2026-12-03 10:30', every: 'week', until: '2026-12-01' }, 'until (2026-12-01) is before its first day (2026-12-03)'],
      [{ title: 'Talk', when: '2026-12-03 10:30', duration: 'long' }, 'duration must be a length'],
      [{ title: 'Talk', when: '2026-12-03 10:30', needs: ['E99'] }, 'needs: "E99" is not a note of the tree'],
    ] as const) {
      const res = await $.tool.call({ tool: 'mcp__rft__rft_add_meeting', ...input } as never)
      expect({ input, text: res.text }).toEqual({ input, text: expect.stringContaining(says) })
    }
    expect(asked).toEqual([])
    expect(w.fs.exists('vault/meetings')).toBe(false)
  })

  for (const [how, answer] of [['declines', "Don't add"], ['dismisses', null]] as const) {
    test(`a meeting the user ${how} is not added`, async ($, on) => {
      const { w } = await session($, on, {}, answer)
      const res = await $.tool.call({ tool: 'mcp__rft__rft_add_meeting', title: 'Supervisor meeting', when: `${addDays(today(), 3)} 14:00` } as never)
      expect(res.text).toContain('The user did not add it')
      expect(w.fs.exists('vault/meetings')).toBe(false)
    })
  }

  test("Claude cannot change a meeting's times, nor write one by hand; its needs are Claude's to write", async ($, on) => {
    const { ran } = await session($, on, { [G01]: supervisor() })
    for (const call of [
      { tool: 'Edit', file_path: `${CWD}/${path(G01)}`, old_string: 'when: 2026-11-10 14:00', new_string: 'when: 2026-11-10 15:00' },
      { tool: 'Edit', file_path: `${CWD}/${path(G01)}`, old_string: 'skip: [2026-12-22, 2026-12-29]', new_string: 'skip: [2026-12-22]' },
      { tool: 'Edit', file_path: `${CWD}/${path(G01)}`, old_string: 'every: week\n', new_string: 'every: 2 weeks\n' },
      { tool: 'Edit', file_path: `${CWD}/${path(G01)}`, old_string: 'duration: 1h\n', new_string: '' },
      { tool: 'Write', file_path: `${CWD}/vault/meetings/G02 By hand.md`, content: meetingFile('G02 By hand', { when: '2026-12-01 10:00' }) },
      { tool: 'Bash', command: `sed -i 's/until: 2027-06-29/until: 2027-07-31/' "${path(G01)}"` },
    ]) {
      const res = await $.tool.call(call as never)
      expect({ call, deny: (res as { deny?: string }).deny }).toEqual({ call, deny: expect.stringContaining("Dates are the user's") })
    }
    expect(ran).toEqual([])
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}/${path(G01)}`, old_string: 'moved:', new_string: `needs: ${links(E02)}\nmoved:` } as never)
    expect(ran).toEqual(['Edit'])
  })
})
