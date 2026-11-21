// Slide decks (web/slides.js; docs/design/presentations.md), written before the tab as its
// specification, with the three cases the user confirmed on 2026-11-21:
//
// (a) the weekly wrap-up: a deck for one occurrence of a weekly meeting, which follows it when it
//     is moved and is presented nowhere when it is skipped;
// (b) a paper presented to the lab: a deck for a once-only meeting, named by its id alone;
// (c) a practice talk and the real one: one deck for a meeting's occurrence and a deadline.

import { describe, expect, test } from 'claude-code/testing'

import '../web/schedule.js'
import '../web/slides.js'

type Slide = { n: number; from: number; to: number; layout: string; cls: string; badLayout: string; body: string; bodyLine: number; notes: string }
type Attachment = { raw: string; kind: string; id: string; name: string; day: string; orig: string; at: { day: string; time?: string } | null; moved: boolean; skipped: boolean; problem: string }
type Deck = { id: string; text: string; fields?: Record<string, unknown> }
type Api = {
  LAYOUTS: string[]
  frontOf: (text: string) => { fields: Record<string, unknown>; body: number }
  isLocked: (fields: Record<string, unknown>) => boolean
  split: (text: string) => { fields: Record<string, unknown>; body: number; slides: Slide[] }
  slideAt: (slides: Slide[], line: number) => number
  attach: (fields: Record<string, unknown>, meetings: unknown[], milestones: unknown[], S: unknown) => Attachment[]
  problems: (deck: Deck, meetings: unknown[], milestones: unknown[], S: unknown) => string[]
  decksFor: (decks: Deck[], id: string, orig: string, meetings: unknown[], milestones: unknown[], S: unknown) => string[]
  groups: (decks: Deck[], meetings: unknown[], milestones: unknown[], today: string, S: unknown) => Record<'upcoming' | 'none' | 'past', { deck: Deck; when: Attachment | null }[]>
  slideHtml: (slide: Slide, md: (src: string) => string) => string
  forItem: (id: string, orig?: string) => string
}

const P = (globalThis as unknown as { RftSlides: Api }).RftSlides
const S = (globalThis as unknown as { RftSchedule: unknown }).RftSchedule

// a weekly supervisor meeting on Tuesdays at 14:00, one skipped and one moved
const G01 = { id: 'G01', name: 'G01 Supervisor meeting', title: 'Supervisor meeting', when: '2026-11-10 14:00', every: 'week', skip: ['2026-12-22'], moved: ['2026-11-24 → 2026-11-25 10:00'] }
// a lab meeting once only, and a reading group every two weeks
const G03 = { id: 'G03', name: 'G03 Lab meeting', title: 'Lab meeting', when: '2026-12-01 11:00', every: '', skip: [], moved: [] }
const G04 = { id: 'G04', name: 'G04 Paper at the lab', title: 'Paper at the lab', when: '2026-11-27 16:00', skip: [], moved: [] }
const M04 = { id: 'M04', name: 'M04 Workshop talk', due: '2026-12-09 09:30' }
const MEETINGS = [G01, G03, G04]
const MILESTONES = [M04]

const deck = (id: string, front: string, body = '# Title') => ({ id, text: `---\nid: ${id}\ntype: deck\n${front}\n---\n\n${body}\n` })

describe('a deck: its frontmatter and slides', () => {
  test('slides split at a line ---, the frontmatter left out, a --- in a code block kept', () => {
    const text = [
      '---', 'id: P01', 'title: Weekly wrap-up', 'for: [G01 2026-11-17]', 'locked: true', '---', '',
      '# CutMix at 1k', 'Since 10 Nov', '',
      '---', '<!-- slide layout="two-cols" class="dense" -->', '', '## Results', '- one', '::right::', '- two', '',
      'note: say why 1k', 'and not 10k',
      '---', '```yaml', '---', 'a: 1', '```', '',
      '---',
    ].join('\n')
    const { fields, body, slides } = P.split(text)
    expect(fields.title).toBe('Weekly wrap-up')
    expect(fields.for).toBe('[G01 2026-11-17]')
    expect(body).toBe(6)
    expect(slides.map(s => s.n)).toEqual([1, 2, 3, 4])
    expect(slides[0]).toMatchObject({ from: 6, to: 10, layout: 'title', body: '# CutMix at 1k\nSince 10 Nov', bodyLine: 7, notes: '' })
    expect(slides[1]).toMatchObject({ from: 11, layout: 'two-cols', cls: 'dense', body: '## Results\n- one\n::right::\n- two', bodyLine: 13, notes: 'say why 1k\nand not 10k' })
    expect(slides[2]).toMatchObject({ layout: 'default', body: '```yaml\n---\na: 1\n```' })
    expect(slides[3]).toMatchObject({ body: '', notes: '' }) // a --- at the end starts an empty slide
    expect(P.slideAt(slides, 0)).toBe(0) // the frontmatter is the first slide's
    expect(P.slideAt(slides, 10)).toBe(0) // a separator is the slide's above it
    expect(P.slideAt(slides, 11)).toBe(1)
    expect(P.slideAt(slides, 22)).toBe(2)
  })

  test('a deck with no frontmatter; a note: inside a code block is code; an unknown layout said', () => {
    const { fields, slides } = P.split('# One\n---\n<!-- slide layout="grid" -->\n```\nnote: kept\n```\nNOTE: the notes')
    expect(fields).toEqual({})
    expect(slides).toHaveLength(2)
    expect(slides[1]).toMatchObject({ layout: 'default', badLayout: 'grid', body: '```\nnote: kept\n```', notes: 'the notes' })
    expect(P.problems({ id: 'P09', text: '# One\n---\n<!-- slide layout="grid" -->\nx' }, MEETINGS, MILESTONES, S)).toEqual([`slide 2: no layout grid (${P.LAYOUTS.join(', ')})`])
  })

  test('block lists in the frontmatter; a deck is locked unless it says locked: false', () => {
    const { fields } = P.frontOf('---\ntitle: Talk\nfor:\n  - G03\n  - "M04"\nlocked: false\n---\n# x')
    expect(fields.for).toEqual(['G03', 'M04'])
    expect(P.isLocked(fields)).toBe(false)
    expect(P.isLocked({})).toBe(true)
    expect(P.isLocked({ locked: 'true' })).toBe(true)
    expect(P.isLocked({ locked: '"false"' })).toBe(false)
  })
})

describe('what a deck is for', () => {
  test('(a) a weekly meeting\'s occurrence, by the day its rule gives', () => {
    const [a] = P.attach({ for: '[G01 2026-11-17]' }, MEETINGS, MILESTONES, S)
    expect(a).toMatchObject({ kind: 'meeting', id: 'G01', name: 'G01 Supervisor meeting', day: '2026-11-17', orig: '2026-11-17', moved: false, problem: '' })
    expect(a!.at).toMatchObject({ day: '2026-11-17', time: '14:00' })
  })

  test('(a) moved, the deck follows the occurrence to its new day and time', () => {
    const [a] = P.attach({ for: 'G01 2026-11-24' }, MEETINGS, MILESTONES, S)
    expect(a).toMatchObject({ day: '2026-11-25', orig: '2026-11-24', moved: true, problem: '' })
    expect(a!.at).toMatchObject({ day: '2026-11-25', time: '10:00' })
    // the Calendar asks by the rule's day, which is how the occurrence is known wherever it went
    const decks = [deck('P03', 'for: [G01 2026-11-24]')]
    expect(P.decksFor(decks, 'G01', '2026-11-24', MEETINGS, MILESTONES, S)).toEqual(['P03'])
    expect(P.decksFor(decks, 'G01', '2026-11-17', MEETINGS, MILESTONES, S)).toEqual([])
  })

  test('(a) skipped, the deck is presented nowhere, and that is said', () => {
    const d = deck('P04', 'for: [G01 2026-12-22]')
    const [a] = P.attach(P.split(d.text).fields, MEETINGS, MILESTONES, S)
    expect(a).toMatchObject({ skipped: true, day: '2026-12-22' })
    expect(P.problems(d, MEETINGS, MILESTONES, S)).toEqual(['G01 2026-12-22: that occurrence of G01 Supervisor meeting is skipped, so the deck is presented nowhere'])
    expect(P.decksFor([d], 'G01', '2026-12-22', MEETINGS, MILESTONES, S)).toEqual([])
  })

  test('(b) a once-only meeting by its id alone', () => {
    const [a] = P.attach({ for: '[G04]' }, MEETINGS, MILESTONES, S)
    expect(a).toMatchObject({ kind: 'meeting', day: '2026-11-27', orig: '2026-11-27', problem: '' })
    expect(P.decksFor([deck('P05', 'for: [G04]')], 'G04', '2026-11-27', MEETINGS, MILESTONES, S)).toEqual(['P05'])
  })

  test('(c) one deck for a practice talk and the real one: listed for both', () => {
    const d = deck('P06', 'for: [G03 2026-12-01, M04]')
    const as = P.attach(P.split(d.text).fields, MEETINGS, MILESTONES, S)
    expect(as.map(a => [a.kind, a.id, a.day, a.problem])).toEqual([['meeting', 'G03', '2026-12-01', ''], ['deadline', 'M04', '2026-12-09', '']])
    expect(P.decksFor([d], 'G03', '2026-12-01', MEETINGS, MILESTONES, S)).toEqual(['P06'])
    expect(P.decksFor([d], 'M04', '', MEETINGS, MILESTONES, S)).toEqual(['P06'])
    // listed once, by the first one ahead; then by the next once the practice is past
    expect(P.groups([d], MEETINGS, MILESTONES, '2026-11-21', S).upcoming.map(g => g.when!.id)).toEqual(['G03'])
    expect(P.groups([d], MEETINGS, MILESTONES, '2026-12-02', S).upcoming.map(g => g.when!.id)).toEqual(['M04'])
    expect(P.groups([d], MEETINGS, MILESTONES, '2026-12-10', S).past.map(g => g.when!.id)).toEqual(['M04'])
  })

  test('what is wrong: no such meeting or deadline, no occurrence that day, which occurrence, not a day', () => {
    const wrong = P.attach({ for: '[G09 2026-11-17, M09, G01 2026-11-18, G01, G01 17-11-2026, M04 2026-12-09, E05]' }, MEETINGS, MILESTONES, S).map(a => a.problem)
    expect(wrong).toEqual([
      'G09 2026-11-17: there is no meeting G09',
      'M09: there is no deadline M09',
      'G01 2026-11-18: G01 Supervisor meeting does not fall on 2026-11-18',
      'G01: G01 Supervisor meeting comes back every week: name the occurrence, as G01 2026-11-10',
      'G01 17-11-2026: 17-11-2026 is no day (YYYY-MM-DD)',
      'M04 2026-12-09: a deadline is named by its id alone (M04)',
      'E05: a deck is for a meeting (G01 2026-11-24, or G04 for a once-only one) or a deadline (M04)',
    ])
    expect(P.forItem('G01', '2026-11-24')).toBe('G01 2026-11-24')
    expect(P.forItem('M04')).toBe('M04')
  })

  test('the list: what comes next soonest first, then for nothing, then the past latest first', () => {
    const decks = [
      deck('P01', 'for: [G01 2026-11-17]'), deck('P02', 'for: [G01 2026-12-01]'), deck('P03', 'for: [G01 2026-11-24]'),
      deck('P04', 'title: A talk'), deck('P05', 'for: [G01 2026-12-22]'), deck('P06', 'for: [G01 2026-11-10]'),
    ]
    const g = P.groups(decks, MEETINGS, MILESTONES, '2026-11-21', S)
    expect(g.upcoming.map(x => x.deck.id)).toEqual(['P03', 'P02']) // the 24th, moved to the 25th, before 1 Dec
    expect(g.none.map(x => x.deck.id)).toEqual(['P05', 'P04']) // a skipped occurrence is for nothing; newest first
    expect(g.past.map(x => x.deck.id)).toEqual(['P01', 'P06'])
  })
})

describe('a slide drawn in its layout', () => {
  const md = (src: string) => `<md>${src}</md>`
  const slide = (text: string, k = 0) => P.split(text).slides[k]!

  test('the layouts, the head spanning two columns and a figure\'s caption', () => {
    expect(P.slideHtml(slide('# Title\nsub'), md)).toBe('<div class="slide layout-title" data-slide="1"><div class="slide-content"><md># Title\nsub</md></div></div>')
    expect(P.slideHtml(slide('x\n---\n<!-- slide layout="two-cols" class="dense" -->\n## Head\nleft\n::right::\nright', 1), md)).toBe(
      '<div class="slide layout-two-cols dense" data-slide="2"><div class="slide-head"><md>## Head</md></div>' +
      '<div class="slide-cols"><div class="slide-col"><md>left</md></div><div class="slide-col"><md>right</md></div></div></div>')
    expect(P.slideHtml(slide('x\n---\n<!-- slide layout="figure" -->\n## Loss\n![[E08_loss.svg]]\nThree seeds', 1), md)).toBe(
      '<div class="slide layout-figure" data-slide="2"><div class="slide-head"><md>## Loss</md></div>' +
      '<div class="slide-figure"><md>![[E08_loss.svg]]</md></div><div class="slide-caption"><md>Three seeds</md></div></div>')
    // two columns with no ::right:: yet: all on the left
    expect(P.slideHtml(slide('x\n---\n<!-- slide layout="two-cols" -->\nleft', 1), md)).toBe(
      '<div class="slide layout-two-cols" data-slide="2"><div class="slide-cols"><div class="slide-col"><md>left</md></div><div class="slide-col"></div></div></div>')
  })

  test('a class that is no class name is left out', () => {
    expect(slide('<!-- slide class="ok x\\" onload=y" -->\nz').cls).toBe('ok')
  })
})
