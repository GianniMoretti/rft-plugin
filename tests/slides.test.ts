// Slide decks (web/slides.js; docs/design/presentations.md), written before the tab as its
// specification, with the three cases the user confirmed on 2026-11-21:
//
// (a) the weekly wrap-up: a deck for one occurrence of a weekly meeting, which follows it when it
//     is moved and is presented nowhere when it is skipped;
// (b) a paper presented to the lab: a deck for a once-only meeting, named by its id alone;
// (c) a practice talk and the real one: one deck for a meeting's occurrence and a deadline.

import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import '../web/schedule.js'
import '../web/slides.js'
import { deckWarnings, readDecks } from '../hooks/lib/decks'
import { load, readConfig } from '../hooks/lib/vault'
import { CWD, MemoryFs, demoFiles, world } from './fixture'

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

describe('in the vault and in a session', () => {
  const G01_FILE = 'vault/meetings/G01 Supervisor meeting.md'
  const P01 = 'vault/decks/P01 Weekly wrap-up.md'
  const P02 = 'vault/decks/P02 Practice talk.md'
  const files = () => ({
    ...demoFiles(),
    [G01_FILE]: '---\nid: G01\ntype: meeting\nwhen: 2026-11-10 14:00\nevery: week\nskip: [2026-12-22]\n---\n\n# G01 · Supervisor meeting\n',
    [P01]: '---\nid: P01\ntype: deck\nfor: [G01 2026-11-24]\nlocked: true\n---\n\n# Weekly wrap-up\n',
    [P02]: '---\nid: P02\ntype: deck\nfor: [G01 2026-12-22, M09]\nlocked: false\n---\n\n# Practice talk\n',
    'vault/decks/notes on decks.md': 'not a deck',
  })

  test('the decks read from disk, and rft_validate\'s warnings: a skipped occurrence, a deadline that is none', async () => {
    const fs = new MemoryFs(files())
    const io = fs.io()
    const l = await load(io, (await readConfig(io))!)
    expect((await readDecks(io, 'vault')).map(d => [d.id, d.locked])).toEqual([['P01', true], ['P02', false]])
    expect(await deckWarnings(io, l)).toEqual([
      'vault/decks/P02 Practice talk.md: G01 2026-12-22: that occurrence of G01 Supervisor meeting is skipped, so the deck is presented nowhere',
      'vault/decks/P02 Practice talk.md: M09: there is no deadline M09',
    ])
  })

  test('Claude\'s own writes of a locked deck, or of a new deck, are refused; of an unlocked one, they go on', async ($: Engine, on: On) => {
    mock.clock(on)
    const w = world(on, files())
    const ran: string[] = []
    on('tool.call', (_$, e) => { ran.push(String(e.tool)); return { result: 'ok', text: 'ok' } as never })
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    for (const [call, why] of [
      [{ tool: 'Edit', file_path: `${CWD}/${P01}`, old_string: '# Weekly wrap-up', new_string: '# Mine' }, 'P01 is locked: the deck is the user\'s to write'],
      [{ tool: 'Write', file_path: `${CWD}/${P01}`, content: 'x' }, 'P01 is locked'],
      [{ tool: 'Write', file_path: `${CWD}/vault/decks/P03 New talk.md`, content: '# x' }, 'A new deck is made in the tree view\'s Slides tab'],
      [{ tool: 'Bash', command: `sed -i 's/locked: true/locked: false/' '${P01}'` }, 'P01 is locked'],
      [{ tool: 'Bash', command: `python3 -c "open('vault/decks/P01 Weekly wrap-up.md','w').write('x')"` }, 'P01 is locked'],
    ] as const) {
      const res = await $.tool.call(call as never)
      expect({ call, deny: (res as { deny?: string }).deny }).toEqual({ call, deny: expect.stringContaining(why) })
    }
    expect(ran).toEqual([])
    for (const call of [
      { tool: 'Edit', file_path: `${CWD}/${P02}`, old_string: '# Practice talk', new_string: '# Practice talk\nSub' },
      { tool: 'Write', file_path: `${CWD}/vault/decks/assets/plot.svg`, content: '<svg/>' },
      { tool: 'Read', file_path: `${CWD}/${P01}` },
    ]) expect(((await $.tool.call(call as never)) as { deny?: string }).deny).toBeUndefined()
    const check = await $.tool.call({ tool: 'mcp__rft__rft_validate' } as never)
    expect(check.text).toContain('vault/decks/P02 Practice talk.md: M09: there is no deadline M09')
    expect(w.fs.read(P01)).toContain('# Weekly wrap-up')
  })
})

// Boxes and lines (docs/design/presentations.md, "Boxes and lines"): what the user places on a slide
// at a position and size of their choosing, written as comment lines in the slide's text.

type Box = {
  kind: 'box'; from: number; to: number; closed: boolean; x: number; y: number; w: number; h: number | null
  shape: string; fill: string; outline: string; color: string; weight: string; size: number | null; align: string; valign: string; content: string
}
type Line = { kind: 'line'; from: number; to: number; x1: number | null; y1: number | null; x2: number | null; y2: number | null; arrow: string; outline: string; weight: string }
type Placed = Slide & { items: (Box | Line)[]; problems: { line: number; text: string }[] }
const COLORS = (P as unknown as { COLORS: string[] }).COLORS

// the format's own example: a two-column slide, a text box, an ellipse, an arrow, a speaker note
const EXAMPLE = [
  '# Title', '', '---', '',
  '<!-- slide layout="two-cols" -->', '',
  '## Accuracy holds at 1k images', '',
  '![[E08_loss.svg]]', '',
  '::right::', '',
  '- 3 seeds so far', '',
  '<!-- box x="1180" y="620" w="520" color="accent" size="40" -->',
  'gap closes here',
  '<!-- /box -->', '',
  '<!-- box shape="ellipse" x="980" y="410" w="160" h="120" outline="contrast" weight="medium" -->',
  '<!-- /box -->', '',
  '<!-- line from="1180 660" to="1130 500" arrow="end" outline="contrast" -->', '',
  'note: say why 1k and not 10k',
].join('\n')
const placed = (text: string, k = 0) => P.split(text).slides[k] as Placed
const said = (text: string) => P.problems({ id: 'P09', text }, MEETINGS, MILESTONES, S)

describe('boxes and lines in a slide\'s text', () => {
  test('the format\'s example: its boxes and its line in the order written, left out of the slots\' content', () => {
    const s = placed(EXAMPLE, 1)
    expect(s.body).toBe('## Accuracy holds at 1k images\n\n![[E08_loss.svg]]\n\n::right::\n\n- 3 seeds so far')
    expect(s.notes).toBe('say why 1k and not 10k')
    expect(s.problems).toEqual([])
    expect(s.items).toEqual([
      { kind: 'box', from: 14, to: 17, closed: true, x: 1180, y: 620, w: 520, h: null, shape: 'rect', fill: '', outline: '', color: 'accent', weight: '', size: 40, align: '', valign: '', content: 'gap closes here' },
      { kind: 'box', from: 18, to: 20, closed: true, x: 980, y: 410, w: 160, h: 120, shape: 'ellipse', fill: '', outline: 'contrast', color: '', weight: 'medium', size: null, align: '', valign: '', content: '' },
      { kind: 'line', from: 21, to: 22, x1: 1180, y1: 660, x2: 1130, y2: 500, arrow: 'end', outline: 'contrast', weight: '' },
    ])
    expect(said(EXAMPLE)).toEqual([])
  })

  test('a box belongs to its slide wherever its lines are: before the slots\' content, between its paragraphs, before a ---', () => {
    const s = placed('<!-- box x="10" y="20" w="300" h="80" fill="#E4E3F5" align="center" valign="middle" -->\nA **label**\n\non two paragraphs\n<!-- /box -->\n## Head\none\n<!-- line from="0 0" to="-40 1080" -->\ntwo\n---\n# Next')
    expect(s.body).toBe('## Head\none\n\ntwo') // the line's place is a break between paragraphs, as its comment is in a note
    expect(s.items.map(i => i.kind)).toEqual(['box', 'line'])
    expect(s.items[0]).toMatchObject({ from: 0, to: 5, h: 80, fill: '#E4E3F5', align: 'center', valign: 'middle', content: 'A **label**\n\non two paragraphs' })
    expect(s.items[1]).toMatchObject({ from: 7, to: 8, x1: 0, y1: 0, x2: -40, y2: 1080, arrow: '' }) // a point may be off the slide
    expect(placed('<!-- box x="10" y="20" w="300" -->\nmine\n<!-- /box -->\n---\n# Next', 1).items).toEqual([])
  })

  test('inside a code block they are code; inside a box, a note: line and a line\'s comment are the box\'s text', () => {
    const fenced = placed('```html\n<!-- box x="1" y="2" w="3" -->\n<!-- /box -->\n<!-- line from="0 0" to="1 1" -->\n```')
    expect(fenced.items).toEqual([])
    expect(fenced.body).toContain('<!-- box x="1" y="2" w="3" -->')
    const s = placed('<!-- box x="1" y="2" w="300" -->\nnote: on the slide\n```\n<!-- /box -->\n```\n<!-- line from="0 0" to="1 1" -->\n<!-- /box -->\nnote: the speaker\'s')
    expect(s.items).toHaveLength(1)
    expect(s.items[0]).toMatchObject({ to: 7, closed: true, content: 'note: on the slide\n```\n<!-- /box -->\n```\n<!-- line from="0 0" to="1 1" -->' })
    expect(s.notes).toBe('the speaker\'s')
  })

  test('a colour is a token\'s name or #rrggbb', () => {
    expect(COLORS).toEqual(['text', 'muted', 'accent', 'contrast', 'baseline', 'neutral', 'axis', 'grid', 'fill', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'])
    const s = placed('<!-- box x="1" y="2" w="300" fill="c3" outline="#df6752" color="Text" -->\n<!-- /box -->')
    expect(s.items[0]).toMatchObject({ fill: 'c3', outline: '#df6752', color: 'text' })
    expect(s.problems).toEqual([])
  })
})

describe('a box or a line written wrong: said, and the slide still drawn', () => {
  test('a box left open runs to the end of its slide, the speaker\'s notes kept out of it', () => {
    const text = '# One\n---\n## Two\n<!-- box x="100" y="200" w="300" -->\nleft open\n\nand on\nnote: not on the slide\n---\n# Three'
    const s = placed(text, 1)
    expect(s.items[0]).toMatchObject({ from: 3, to: 7, closed: false, content: 'left open\n\nand on' })
    expect(s.body).toBe('## Two')
    expect(s.notes).toBe('not on the slide')
    expect(placed(text, 2).items).toEqual([])
    expect(said(text)).toEqual(['slide 2, line 4: this box is not closed: add <!-- /box --> after its text'])
  })

  test('a box opened in an open box ends it; a <!-- /box --> that closes none', () => {
    const text = '<!-- box x="1" y="2" w="300" -->\nfirst\n<!-- box x="5" y="6" w="700" -->\nsecond\n<!-- /box -->\n<!-- /box -->\nafter'
    const s = placed(text)
    expect(s.items.map(i => [i.from, i.to, (i as Box).closed, (i as Box).content])).toEqual([[0, 2, false, 'first'], [2, 5, true, 'second']])
    expect(s.body).toBe('after')
    expect(said(text)).toEqual([
      'slide 1, line 1: this box is not closed: add <!-- /box --> after its text',
      'slide 1, line 6: this <!-- /box --> closes no box',
    ])
  })

  test('a position that is no whole number, one missing, an option there is none of, a value it cannot take', () => {
    const text = [
      '<!-- box x="12.5" y="2" w="300" -->', 'a', '<!-- /box -->',
      '<!-- box x="1" y="2" -->', 'b', '<!-- /box -->',
      '<!-- box x="1" y="2" w="0" h="tall" size="big" colour="accent" shape="star" weight="4" align="middle" valign="center" -->', 'c', '<!-- /box -->',
      '<!-- box x=1 y="2" w="300" -->', 'd', '<!-- /box -->',
      '<!-- line from="10" to="1 2 3" arrow="yes" weight="fat" color="accent" -->',
      '<!-- line to="1 2" -->',
    ].join('\n')
    expect(said(text)).toEqual([
      'slide 1, line 1: x="12.5" is no whole number',
      'slide 1, line 4: a box needs x, y and w: no w',
      'slide 1, line 7: a box has no option "colour" (x, y, w, h, shape, fill, outline, weight, color, size, align, valign)',
      'slide 1, line 7: w="0" is no whole number above 0',
      'slide 1, line 7: h="tall" is no whole number above 0',
      'slide 1, line 7: shape="star" is none of rect, ellipse',
      'slide 1, line 7: weight="4" is none of thin, medium, thick',
      'slide 1, line 7: size="big" is no whole number above 0',
      'slide 1, line 7: align="middle" is none of left, center, right',
      'slide 1, line 7: valign="center" is none of top, middle, bottom',
      'slide 1, line 10: "x=1" is not read: an option is written name="value"',
      'slide 1, line 10: a box needs x, y and w: no x',
      'slide 1, line 13: a line has no option "color" (from, to, arrow, outline, weight)',
      'slide 1, line 13: from="10" is no point: two whole numbers, as "1180 660"',
      'slide 1, line 13: to="1 2 3" is no point: two whole numbers, as "1180 660"',
      'slide 1, line 13: arrow="yes" is none of start, end, both',
      'slide 1, line 13: weight="fat" is none of thin, medium, thick',
      'slide 1, line 14: a line needs from and to: no from',
    ])
    // still drawn: at the slide's corner, 480 wide, as high as its text, in the layout's style
    const s = placed(text)
    expect(s.items[0]).toMatchObject({ x: 0, y: 2, w: 300, content: 'a' })
    expect(s.items[1]).toMatchObject({ x: 1, y: 2, w: 480, content: 'b' })
    expect(s.items[2]).toMatchObject({ w: 480, h: null, size: null, shape: 'rect', weight: '', align: '', valign: '', content: 'c' })
    expect(s.items[4]).toMatchObject({ kind: 'line', x1: null, y1: null, x2: null, y2: null, arrow: '', weight: '' })
  })

  test('a colour there is none of is said, and drawn in the text\'s colour', () => {
    const text = '# One\n---\n<!-- box x="1" y="2" w="300" fill="coral" outline="#fff" color="red" -->\nx\n<!-- /box -->\n<!-- line from="0 0" to="9 9" outline="blue" -->'
    const names = 'a token\'s name (text, muted, accent, contrast, baseline, neutral, axis, grid, fill, c1 to c6) or #rrggbb'
    expect(said(text)).toEqual([
      `slide 2, line 3: no colour "coral": ${names}`,
      `slide 2, line 3: no colour "#fff": ${names}`,
      `slide 2, line 3: no colour "red": ${names}`,
      `slide 2, line 6: no colour "blue": ${names}`,
    ])
    const s = placed(text, 1)
    expect(s.items[0]).toMatchObject({ fill: 'currentColor', outline: 'currentColor', color: 'currentColor' })
    expect(s.items[1]).toMatchObject({ outline: 'currentColor' })
  })
})

describe('boxes and lines drawn on the slide, over its layout, the later in the text in front', () => {
  const md = (src: string) => `<md>${src}</md>`
  const draw = (text: string, k = 0) => P.slideHtml(placed(text, k), md)

  test('the format\'s example', () => {
    const html = draw(EXAMPLE, 1)
    expect(html.startsWith('<div class="slide layout-two-cols" data-slide="2"><div class="slide-head"><md>## Accuracy holds at 1k images</md></div>' +
      '<div class="slide-cols"><div class="slide-col"><md>\n![[E08_loss.svg]]\n</md></div><div class="slide-col"><md>\n- 3 seeds so far</md></div></div>')).toBe(true)
    expect(html).toContain('<div class="slide-box" data-item="0" style="left:1180px;top:620px;width:520px;color:var(--slide-c-accent);font-size:40px"><div class="slide-box-text"><md>gap closes here</md></div></div>' +
      '<div class="slide-box ellipse fixed" data-item="1" style="left:980px;top:410px;width:160px;height:120px;border:4px solid var(--slide-c-contrast)"></div>' +
      '<svg class="slide-line" data-item="2" viewBox="0 0 1920 1080" style="color:var(--slide-c-contrast)">')
    expect(html.endsWith('</svg></div>')).toBe(true)
    expect(html).not.toContain('say why')
  })

  test('a box\'s fill, outline, text and place in its height; a figure alone in a box fills it', () => {
    expect(draw('<!-- box x="-20" y="30" w="400" h="200" fill="fill" outline="#211A52" weight="thick" color="c2" align="center" valign="middle" -->\nA\n<!-- /box -->')).toContain(
      '<div class="slide-box fixed valign-middle" data-item="0" style="left:-20px;top:30px;width:400px;height:200px;background:var(--slide-c-fill);border:8px solid #211A52;color:var(--slide-c-c2);text-align:center"><div class="slide-box-text"><md>A</md></div></div>')
    expect(draw('<!-- box x="1" y="2" w="300" outline="text" weight="thin" valign="bottom" -->\n\n![[E08_loss.svg|400]]\n\n<!-- /box -->')).toContain(
      '<div class="slide-box figure valign-bottom" data-item="0" style="left:1px;top:2px;width:300px;border:2px solid var(--slide-c-text)"><div class="slide-box-text"><md>![[E08_loss.svg|400]]</md></div></div>')
    // an outline's weight alone draws none; a colour there is none of is the text's
    expect(draw('<!-- box x="1" y="2" w="300" weight="thick" fill="nope" -->\n<!-- /box -->')).toContain('<div class="slide-box" data-item="0" style="left:1px;top:2px;width:300px;background:currentColor"></div>')
  })

  // a line's drawing: its stroke and the heads of its arrow, as numbers
  const lineOf = (html: string) => {
    const svg = /<svg class="slide-line"[^>]*>(.*?)<\/svg>/.exec(html)
    if (!svg) return null
    const l = /<line x1="([-\d.]+)" y1="([-\d.]+)" x2="([-\d.]+)" y2="([-\d.]+)" stroke="currentColor" stroke-width="(\d+)" stroke-linecap="round"\/>/.exec(svg[1]!)!
    const heads = [...svg[1]!.matchAll(/<polygon points="([^"]+)" fill="currentColor"\/>/g)].map(m => m[1]!.split(' ').map(p => p.split(',').map(Number)))
    return { from: [+l[1]!, +l[2]!], to: [+l[3]!, +l[4]!], width: +l[5]!, heads }
  }

  test('a line from point to point, in the text\'s colour and of medium weight unless it says', () => {
    const html = draw('<!-- line from="100 200" to="500 200" -->')
    expect(html).toContain('<svg class="slide-line" data-item="0" viewBox="0 0 1920 1080"><line x1="100" y1="200" x2="500" y2="200" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>')
    expect(lineOf(draw('<!-- line from="100 200" to="500 200" weight="thin" -->'))!.width).toBe(2)
    expect(lineOf(draw('<!-- line from="100 200" to="500 200" weight="thick" -->'))!.width).toBe(8)
  })

  test('an arrow\'s head has its tip on the line\'s end, and the stroke stops inside it', () => {
    const end = lineOf(draw('<!-- line from="100 200" to="500 200" arrow="end" -->'))!
    expect(end.from).toEqual([100, 200])
    expect(end.heads).toHaveLength(1)
    const [tip, a, b] = end.heads[0]!
    expect(tip).toEqual([500, 200])
    expect(a![0]).toBe(b![0]) // its base across the line
    expect(Math.abs(a![1]! + b![1]! - 400)).toBeLessThan(0.01) // and its middle on it
    expect(end.to[1]).toBe(200)
    expect(end.to[0]).toBeGreaterThan(a![0]!)
    expect(end.to[0]).toBeLessThan(500)
    const both = lineOf(draw('<!-- line from="300 100" to="300 900" arrow="both" weight="thick" -->'))!
    expect(both.heads.map(h => h[0])).toEqual([[300, 100], [300, 900]])
    expect(both.from[1]).toBeGreaterThan(100)
    expect(both.to[1]).toBeLessThan(900)
    const start = lineOf(draw('<!-- line from="300 100" to="700 400" arrow="start" -->'))!
    expect(start.heads.map(h => h[0])).toEqual([[300, 100]])
    expect(start.to).toEqual([700, 400])
  })

  test('a line with no place is not drawn, the rest of the slide is; the order in the text is the order drawn', () => {
    const html = draw('one\n<!-- line from="x" to="1 2" -->\n<!-- box x="1" y="2" w="3" -->\n<!-- /box -->\n<!-- line from="0 0" to="5 5" -->\n<!-- box x="4" y="5" w="6" -->\n<!-- /box -->')
    expect([...html.matchAll(/data-item="(\d)"/g)].map(m => m[1])).toEqual(['1', '2', '3'])
    expect(html).toContain('<div class="slide-content"><md>one</md></div><div class="slide-box" data-item="1"')
  })
})

describe('boxes and lines in the vault', () => {
  test('rft_validate says what the Slides tab says', async () => {
    const text = '---\nid: P01\ntype: deck\nlocked: false\n---\n\n# One\n\n<!-- box x="1" y="2" w="300" fill="coral" -->\nopen\n'
    const fs = new MemoryFs({ ...demoFiles(), 'vault/decks/P01 Weekly wrap-up.md': text })
    const io = fs.io()
    const l = await load(io, (await readConfig(io))!)
    const lines = P.problems({ id: 'P01', text }, [], [], S)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe('slide 1, line 9: this box is not closed: add <!-- /box --> after its text')
    expect(await deckWarnings(io, l)).toEqual(lines.map(p => `vault/decks/P01 Weekly wrap-up.md: ${p}`))
  })
})
