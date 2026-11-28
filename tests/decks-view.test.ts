// The Slides tab's pure parts (web/decks.js) and the Markdown a slide is drawn with: what + Deck
// offers a new deck to be for, when an attachment is in words, and the slide-only options of
// web/markdown.js (### headings, numbered lists), which leave a note's rendering as it was.

import { describe, expect, test } from 'claude-code/testing'

import '../web/schedule.js'
import '../web/slides.js'
import '../web/markdown.js'
import '../web/decks.js'

type Choice = { value: string; label: string; title: string; subtitle: string }
type Api = {
  forChoices: (meetings: unknown[], milestones: unknown[], today: string) => Choice[]
  whenText: (a: unknown) => string
}
type Md = { make: (o: Record<string, unknown>) => { render: (src: string) => { html: string } } }

const D = (globalThis as unknown as { RftDecks: Api }).RftDecks
const M = (globalThis as unknown as { RftMarkdown: Md }).RftMarkdown

const G01 = { id: 'G01', name: 'G01 Supervisor meeting', title: 'Supervisor meeting', when: '2026-11-10 14:00', every: 'week', skip: ['2026-12-01'], moved: ['2026-11-24 → 2026-11-25 10:00'] }
const G04 = { id: 'G04', name: 'G04 Paper at the lab', title: 'Paper at the lab', when: '2026-11-27 16:00', skip: [], moved: [] }
const M04 = { id: 'M04', name: 'M04 Workshop talk', title: 'Workshop talk', due: '2026-12-09 09:30', status: 'open' }
const M01 = { id: 'M01', name: 'M01 Done one', title: 'Done one', due: '2026-12-02', status: 'done' }
const M02 = { id: 'M02', name: 'M02 Past', title: 'Past', due: '2026-11-02', status: 'open' }

describe('the Slides tab', () => {
  test('+ Deck offers the occurrences ahead (by the rule\'s day, a skipped one left out), the once-only meetings and the open deadlines', () => {
    const c = D.forChoices([G01, G04], [M04, M01, M02], '2026-11-21')
    expect(c.map(x => x.value)).toEqual(['G01 2026-11-24', 'G04', 'G01 2026-12-08', 'G01 2026-12-15', 'G01 2026-12-22', 'M04'])
    // the moved one is offered on the day it takes place, and named by its rule's day
    expect(c[0]).toMatchObject({ title: 'Supervisor meeting 2026-11-25' })
    expect(c[0]!.label).toContain('(moved)')
    expect(c[1]).toMatchObject({ title: 'Paper at the lab' })
    expect(c[5]).toMatchObject({ title: 'Workshop talk' })
  })

  test('an attachment in words', () => {
    expect(D.whenText({ name: 'G01 Supervisor meeting', day: '2026-11-25', orig: '2026-11-24', at: { day: '2026-11-25', time: '10:00' }, moved: true }))
      .toMatch(/^G01 Supervisor meeting · Wed,? 25 Nov 10:00 \(moved from Tue,? 24 Nov\)$/)
    expect(D.whenText(null)).toBe('')
  })
})

describe('Markdown on a slide', () => {
  const opts = { tex: (s: string) => s, image: () => '<img>', link: () => null }
  const strip = (html: string) => html.replace(/<span class="src"[^>]*>|<\/span>/g, '').replace(/\n/g, '')

  test('### headings and numbered lists, nested in a bullet list', () => {
    const md = M.make({ ...opts, headings: 3, ordered: true })
    expect(strip(md.render('### Three\n1. a\n2. b\n- c\n  1. d\n- e').html)).toBe('<h3>Three</h3><ol><li>a</li><li>b</li></ol><ul><li>c</li><ol><li>d</li></ol><li>e</li></ul>')
  })

  test('a note renders as before: ### as ##, a numbered line as text', () => {
    const md = M.make(opts)
    expect(strip(md.render('### Three\n1. a\n- c').html)).toBe('<h2>Three</h2><p>1. a</p><ul><li>c</li></ul>')
  })
})
