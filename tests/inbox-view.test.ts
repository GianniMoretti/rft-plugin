// The tree view's inbox (web/inbox.js): what its button counts, what an item is called and shown
// with in the list, and the order of the list (the plugin's own, for /rft-inbox, held against it). The items are as the server gives them (tests/fixtures/inbox).

import { describe, expect, test } from 'claude-code/testing'

import { byPriority } from '../hooks/lib/inbox.ts'
import { EXPECTED } from './fixtures/inbox.ts'
import '../web/inbox.js'

type Item = { key: string; url: string; title: string; why: string; priority: string; added: string; duplicate: boolean; brief: null | { date: string; lines: string[] } }
type Row = { item: Item; at: number; nth: number }
type Api = {
  count: (items: Item[] | null) => number
  label: (item: Item) => string
  when: (item: Item) => string
  refusal: (status: number, got: { error?: unknown } | null, what?: string) => string
  ORDERS: string[]
  PRIORITIES: string[]
  nextPriority: (p: string) => string
  priorityIcon: (p: string) => string
  ordered: (items: Item[] | null, by: string) => Row[]
}

const I = (globalThis as unknown as { RftInbox: Api }).RftInbox

const item = (over: Partial<Item>): Item => ({ key: '', url: '', title: '', why: '', priority: '', added: '', duplicate: false, brief: null, ...over })

describe('the inbox in the tree view', () => {
  test('the button counts every item, one typed twice counted twice', () => {
    expect(I.count(null)).toBe(0)
    expect(I.count([])).toBe(0)
    expect(I.count([item({ key: 'arxiv:2406.01234' }), item({ key: 'arxiv:2406.01234', duplicate: true }), item({ key: 'https://e.org/x', brief: { date: '2026-11-20', lines: ['x'] } })])).toBe(3)
  })

  test('an item is called by its title, else by what its link says', () => {
    expect(I.label(item({ key: 'arxiv:2406.01234', url: 'https://arxiv.org/abs/2406.01234', title: 'Mixup at scale' }))).toBe('Mixup at scale')
    expect(I.label(item({ key: 'arxiv:2311.09876', url: 'https://arxiv.org/abs/2311.09876' }))).toBe('arXiv 2311.09876')
    expect(I.label(item({ key: 'arxiv:hep-th/9901001', url: 'https://arxiv.org/abs/hep-th/9901001' }))).toBe('arXiv hep-th/9901001')
    // a DOI as it was typed, not lowered as its identity is
    expect(I.label(item({ key: 'doi:10.1109/cvpr.2022.01553', url: 'https://doi.org/10.1109/CVPR.2022.01553' }))).toBe('doi 10.1109/CVPR.2022.01553')
    expect(I.label(item({ key: 'https://lilianweng.github.io/posts/2021-05-31-contrastive', url: 'https://lilianweng.github.io/posts/2021-05-31-contrastive/' }))).toBe('lilianweng.github.io/posts/2021-05-31-contrastive')
    expect(I.label(item({ key: 'https://openreview.net/forum?id=abc123', url: 'https://openreview.net/forum?id=abc123#discussion' }))).toBe('openreview.net/forum')
    expect(I.label(item({ key: 'https://example.org', url: 'https://example.org/' }))).toBe('example.org')
  })

  test('beside its why, the day it was added and that its link is there twice', () => {
    expect(I.when(item({ why: 'maybe relevant to D04', added: '2026-11-16' }))).toBe('added 2026-11-16')
    expect(I.when(item({ added: '2026-11-02', duplicate: true }))).toBe('added 2026-11-02 · in the inbox twice')
    expect(I.when(item({ duplicate: true }))).toBe('in the inbox twice')
    expect(I.when(item({ why: 'IJCV survey, low' }))).toBe('')
  })

  const some = (key: string, priority: string, added: string) => item({ key, url: key, priority, added })
  const hand = [some('a', '', '2026-11-20'), some('b', 'low', ''), some('c', 'urgent', '2026-11-01'), some('d', 'high', '2026-11-02'), some('e', 'high', '2026-11-09'), some('f', '', ''), some('g', '', '2026-11-21'), some('h', 'high', '2026-11-09')]
  const keys = (rows: Row[]) => rows.map(r => r.item.key).join('')

  test('a tap steps a reading priority: none, low, medium, high, urgent, and none again', () => {
    const steps = ['']
    for (let i = 0; i < 5; i++) steps.push(I.nextPriority(steps[i]))
    expect(steps).toEqual(['', 'low', 'medium', 'high', 'urgent', ''])
    // every one the list orders by is stepped through, and a word that is none of them counts as none
    expect([...steps.slice(1, 5)].sort()).toEqual([...I.PRIORITIES].sort())
    expect(I.nextPriority('someday')).toBe('low')
  })

  test('a reading priority is drawn, not written: as many bars filled as it presses, urgent a shape of its own', () => {
    const faint = (p: string) => (I.priorityIcon(p).match(/class="off"/g) || []).length
    const bars = (p: string) => (I.priorityIcon(p).match(/<rect /g) || []).length
    expect(['', 'low', 'medium', 'high'].map(p => [bars(p), faint(p)])).toEqual([[3, 3], [3, 2], [3, 1], [3, 0]])
    expect(I.priorityIcon('urgent')).toContain('class="cut"')
    expect(bars('urgent')).toBe(1)
    // five different pictures, none with a word in it
    const all = ['', 'low', 'medium', 'high', 'urgent'].map(I.priorityIcon)
    expect(new Set(all).size).toBe(5)
    for (const svg of all) expect(svg.replace(/<[^>]*>/g, '')).toBe('')
  })

  test('by reading priority: the most pressing first, the newest first within one, those with no day after them', () => {
    expect(I.ORDERS).toEqual(['priority', 'date'])
    expect(I.PRIORITIES).toEqual(['urgent', 'high', 'medium', 'low'])
    expect(keys(I.ordered(hand, 'priority'))).toBe('chedbgaf')
    // any order the page does not know is this one
    expect(keys(I.ordered(hand, 'size'))).toBe('chedbgaf')
    expect(keys(I.ordered(hand.slice().reverse(), 'priority'))).toBe('cehdbgaf')
    // the file's order is left as it is
    expect(hand.map(i => i.key).join('')).toBe('abcdefgh')
    expect(I.ordered(null, 'priority')).toEqual([])
  })

  test('by date: the newest first, of one day the one added later first, those with no day last as the file has them', () => {
    expect(keys(I.ordered(hand, 'date'))).toBe('gahedcbf')
    const undated = [some('x', 'low', ''), some('y', '', ''), some('z', 'urgent', ''), some('w', '', '2026-01-01')]
    expect(keys(I.ordered(undated, 'date'))).toBe('wxyz')
    expect(keys(I.ordered(undated, 'priority'))).toBe('zxwy')
  })

  test('the page and /rft-inbox list the items in one order', () => {
    for (const items of [hand, hand.slice().reverse(), EXPECTED.items as Item[]]) {
      expect(I.ordered(items, 'priority').map(r => r.item)).toEqual(byPriority(items))
    }
    expect(EXPECTED.items.length).toBeGreaterThan(5)
  })

  test('each item is named by its link and which of the items with that link it is in the file', () => {
    const items = [some('a', '', '2026-11-01'), some('b', 'high', ''), some('a', 'urgent', '2026-11-03'), some('a', '', '')]
    const rows = I.ordered(items, 'priority')
    expect(rows.map(r => [r.item.key, r.at, r.nth])).toEqual([['a', 2, 1], ['b', 1, 0], ['a', 0, 0], ['a', 3, 2]])
    expect(I.ordered(items, 'date').map(r => [r.item.key, r.at, r.nth])).toEqual([['a', 2, 1], ['a', 0, 0], ['b', 1, 0], ['a', 3, 2]])
    // the fixture has one link twice: its second line is the second of them
    const twice = I.ordered(EXPECTED.items as Item[], 'date').filter(r => r.item.key === 'arxiv:2406.01234')
    expect(twice.map(r => r.nth).sort()).toEqual([0, 1])
    expect(twice.find(r => r.nth === 1)!.item.duplicate).toBe(true)
  })

  test('of a link not added, the reason the server gave; of a server that gave none, what it answered', () => {
    expect(I.refusal(409, { error: 'already in the inbox, added 2026-11-16' })).toBe('Not added: already in the inbox, added 2026-11-16.')
    expect(I.refusal(409, { error: 'already in the tree: R03 is a reference of it' })).toBe('Not added: already in the tree: R03 is a reference of it.')
    expect(I.refusal(400, { error: 'not a link: paste a URL, an arXiv id or a DOI' })).toBe('Not added: not a link: paste a URL, an arXiv id or a DOI.')
    expect(I.refusal(500, {})).toBe('Not added: the server answered 500.')
    expect(I.refusal(502, null)).toBe('Not added: the server answered 502.')
    expect(I.refusal(400, { error: 3 })).toBe('Not added: the server answered 400.')
    // a server started before the page could add: it knows no such route
    expect(I.refusal(404, { error: 'not found' })).toBe('Not added: the server running is older than this page. /rft restart starts the new one.')
    // a change the server did not make, said the same way
    expect(I.refusal(409, { error: 'that item is no longer in the inbox' }, 'Not discarded')).toBe('Not discarded: that item is no longer in the inbox.')
    expect(I.refusal(400, { error: 'a reading priority is urgent, high, medium or low' }, 'Not changed')).toBe('Not changed: a reading priority is urgent, high, medium or low.')
    expect(I.refusal(500, null, 'Not changed')).toBe('Not changed: the server answered 500.')
  })
})
