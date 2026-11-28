// The web view on a phone (web/phone.js): what the phone's Back closes, and what a close by hand
// does to the history. The page itself, at a phone's size, is tests/test_phone.py's.

import { describe, expect, test } from 'claude-code/testing'

import '../web/phone.js'

type Item = { key: string; kind: 'sheet' | 'drawer' | 'note'; note?: string | null }
type Api = {
  afterBack: (stack: Item[], keep: string[]) => { close: Item[]; rest: Item[]; note: string | null; stale: boolean }
  afterClose: (stack: Item[], keys: string[]) => { rest: Item[]; removed: Item[]; top: boolean }
}

const P = (globalThis as unknown as { RftPhone: Api }).RftPhone
const keys = (items: Item[]) => items.map(i => i.key)

const drawer: Item = { key: 'drawer:1', kind: 'drawer', note: 'D00' }
const e01: Item = { key: 'note:2', kind: 'note', note: 'E01' }
const e02: Item = { key: 'note:3', kind: 'note', note: 'E02' }
const filters: Item = { key: 'filters:4', kind: 'sheet' }
const menu: Item = { key: 'menu:5', kind: 'sheet' }

describe('Back on a phone', () => {
  test('example 1: D00 open, a link to E01: Back shows D00 again, Back again closes the note', () => {
    const one = P.afterBack([drawer, e01], ['drawer:1'])
    expect(one.close).toEqual([])
    expect(one.note).toBe('D00')
    expect(keys(one.rest)).toEqual(['drawer:1'])
    const two = P.afterBack(one.rest, [])
    expect(keys(two.close)).toEqual(['drawer:1'])
    expect(two.note).toBeNull()
    expect(two.rest).toEqual([])
  })

  test('example 2: D00 → E01 → E02, Back twice: E01, then D00', () => {
    const one = P.afterBack([drawer, e01, e02], ['drawer:1', 'note:2'])
    expect(one.note).toBe('E01')
    expect(P.afterBack(one.rest, ['drawer:1']).note).toBe('D00')
  })

  test('the filters over a note: Back closes the filters and leaves the note as it is', () => {
    const r = P.afterBack([drawer, e01, filters], ['drawer:1', 'note:2'])
    expect(keys(r.close)).toEqual(['filters:4'])
    expect(r.note).toBeNull()
  })

  test('a Back past several entries (a long press on Back) closes the newest first', () => {
    const r = P.afterBack([filters, drawer, e01, menu], ['filters:4'])
    expect(keys(r.close)).toEqual(['menu:5', 'drawer:1'])
    expect(r.note).toBeNull() // the drawer goes with its notes: no note to show
  })

  test('edge: an entry whose things were all closed by hand since is stale, and Back goes on past it', () => {
    expect(P.afterBack([], ['filters:4']).stale).toBe(true)
    expect(P.afterBack([drawer], ['drawer:1', 'filters:4']).stale).toBe(true)
    // the first entry of the page names nothing: never stale, Back then leaves the page
    expect(P.afterBack([], []).stale).toBe(false)
  })
})

describe('a close by hand', () => {
  test('the newest thing closed (✕ on the filters): the history goes back past its entry', () => {
    const r = P.afterClose([drawer, filters], ['filters:4'])
    expect(r.top).toBe(true)
    expect(keys(r.removed)).toEqual(['filters:4'])
    expect(keys(r.rest)).toEqual(['drawer:1'])
  })

  test('✕ on a note reached by links: the drawer takes its notes along, all on top', () => {
    const r = P.afterClose([drawer, e01, e02], ['drawer:1'])
    expect(r.top).toBe(true)
    expect(keys(r.removed)).toEqual(['drawer:1', 'note:2', 'note:3'])
    expect(r.rest).toEqual([])
  })

  test('edge: closed under something still open: not on top, its entry stays (afterBack skips it later)', () => {
    const r = P.afterClose([drawer, filters], ['drawer:1'])
    expect(r.top).toBe(false)
    expect(keys(r.rest)).toEqual(['filters:4'])
  })

  test('the ⋯ menu closed as Filters opens: both in one change', () => {
    const r = P.afterClose([menu], ['menu:5'])
    expect(r.top).toBe(true)
    expect(r.rest).toEqual([])
  })
})
