// The tree view's kanban (web/kanban.js): one column per status, three of them folded, one more
// for a status that is none of them; the order by priority or by date; the priority limits.

import { describe, expect, test } from 'claude-code/testing'

import '../web/kanban.js'

type Note = { id: string; status: string; date: string; priority?: string }
type Column = { status: string; folded: boolean; notes: Note[] }
type Api = {
  PRIORITIES: string[]
  order: (notes: Note[], by?: string) => Note[]
  columns: (notes: Note[], opts?: { order?: string; hiddenStatuses?: string[] }) => Column[]
  usage: (notes: Note[]) => Record<string, string[]>
  blockers: (notes: Note[], note: Note, p: string) => string[]
}

const K = (globalThis as unknown as { RftKanban: Api }).RftKanban
const note = (id: string, status: string, date: string, priority?: string): Note => ({ id, status, date, ...(priority ? { priority } : {}) })
const ids = (notes: Note[]) => notes.map(n => n.id)

describe('kanban', () => {
  test('a column by priority, the notes without one last; or newest first', () => {
    const planned = [note('E07', 'planned', '2026-04-02', 'high'), note('E08', 'planned', '2026-05-01'), note('D06', 'planned', '2026-03-01', 'low')]
    expect(ids(K.order(planned, 'priority'))).toEqual(['E07', 'D06', 'E08'])
    expect(ids(K.order(planned, 'date'))).toEqual(['E08', 'E07', 'D06'])
    expect(ids(K.order(planned))).toEqual(['E07', 'D06', 'E08'])
    expect(ids(planned)).toEqual(['E07', 'E08', 'D06']) // the list given stays as it was
  })

  test('ties: one priority newest first; one date, the later id first; an undated note last', () => {
    const notes = [
      note('E03', 'idea', '2026-01-01', 'high'), note('E10', 'idea', '2026-01-01', 'high'), note('D02', 'idea', '', 'high'),
      note('E04', 'idea', '2026-01-01', 'high'), note('E01', 'idea', '2025-12-01', 'urgent'), note('D05', 'idea', '2026-01-03'),
      note('D04', 'idea', '2026-01-02', 'medium'), note('D09', 'idea', '2026-01-02', 'nonsense'),
    ]
    expect(ids(K.order(notes, 'priority'))).toEqual(['E01', 'E10', 'E04', 'E03', 'D02', 'D04', 'D05', 'D09'])
    expect(ids(K.order(notes, 'date'))).toEqual(['D05', 'D09', 'D04', 'E10', 'E04', 'E03', 'E01', 'D02'])
  })

  test('the columns: the four of the flow, the three folded ones, one for a status none of them', () => {
    const notes = [
      note('D01', 'idea', '2026-01-01'), note('E01', 'planned', '2026-01-01'), note('E02', 'running', '2026-01-02'),
      note('E03', 'done', '2026-01-03'), note('E04', 'done', '2026-01-04', 'low'), note('D02', 'dropped', '2026-01-01'),
      note('D03', 'discussed', '2026-01-01'), note('D04', 'moved', '2026-01-01'),
    ]
    const shape = (cs: Column[]) => cs.map(c => [c.status, c.folded, ids(c.notes)])
    expect(shape(K.columns(notes))).toEqual([
      ['idea', false, ['D01']], ['planned', false, ['E01']], ['running', false, ['E02']], ['done', false, ['E04', 'E03']],
      ['dropped', true, ['D02']], ['discussed', true, ['D03']], ['moved', true, ['D04']],
    ])
    expect(shape(K.columns(notes, { order: 'date' }))[3]).toEqual(['done', false, ['E04', 'E03']])
    expect(shape(K.columns([note('E05', 'done', '2026-02-01'), ...notes], { order: 'date' }))[3]).toEqual(['done', false, ['E05', 'E04', 'E03']])
    // a status the filters hide has no column; an empty one stays
    expect(K.columns(notes, { hiddenStatuses: ['done', 'moved'] }).map(c => c.status)).toEqual(['idea', 'planned', 'running', 'dropped', 'discussed'])
    expect(shape(K.columns([note('E01', 'planned', '2026-01-01')]))[0]).toEqual(['idea', false, []])
    // a status of none of the columns: a column of its own, last
    const odd = K.columns([...notes, note('E09', 'paused', '2026-01-01'), note('E10', '', '2026-01-01')])
    expect(shape(odd).slice(-1)).toEqual([['other', false, ['E10', 'E09']]])
  })

  test('the limits: the open notes that hold each priority, and what keeps a note from taking one', () => {
    const notes = [
      note('E01', 'running', '2026-01-01', 'urgent'), note('E02', 'done', '2026-01-01', 'urgent'), note('D01', 'idea', '2026-01-01'),
      ...['D10', 'D11', 'D12', 'D13'].map(id => note(id, 'planned', '2026-01-01', 'high')), note('D20', 'dropped', '2026-01-01', 'high'),
    ]
    expect(K.usage(notes)).toEqual({ urgent: ['E01'], high: ['D10', 'D11', 'D12', 'D13'], medium: [], low: [] })
    const d01 = notes[2]!
    expect(K.blockers(notes, d01, 'urgent')).toEqual(['E01'])
    expect(K.blockers(notes, notes[0]!, 'urgent')).toEqual([]) // it holds it
    expect(K.blockers(notes, notes[1]!, 'urgent')).toEqual([]) // done: does not count
    expect(K.blockers(notes, d01, 'high')).toEqual([]) // 4 of 5
    const full = [...notes, note('D14', 'idea', '2026-01-01', 'high')]
    expect(K.blockers(full, d01, 'high')).toEqual(['D10', 'D11', 'D12', 'D13', 'D14'])
    expect(K.blockers(full, d01, 'low')).toEqual([])
    expect(K.blockers(full, d01, 'medium')).toEqual([])
  })
})
