// The reading note's view in the tree view (web/reading.js): what a quote is in the text, where a
// pasted one goes, and what selected lines become; and what an inbox item's row says of its
// reading (web/inbox.js): the sign, the mark, the wait, the button.

import { describe, expect, test } from 'claude-code/testing'

import { quotesOf } from '../hooks/lib/reading.ts'
import '../web/reading.js'
import '../web/inbox.js'

type Edit = { from: number; to: number; insert: string; caret?: number; start?: number; end?: number }
type Api = {
  quote: (text: string) => string
  pasteQuote: (value: string, start: number, end: number, text: string) => Edit | null
  quoteLines: (value: string, start: number, end: number) => Edit | null
  quotes: (text: string) => number
  label: (item: { key: string; url?: string; title?: string }) => string
}
type Row = { mine: boolean; impression: boolean; read: string; waiting: boolean; action: string }
const R = (globalThis as unknown as { RftReading: Api }).RftReading
const I = (globalThis as unknown as { RftInbox: { reading: (item: { key: string; read?: string }, notes?: object | null, waiting?: string[] | null) => Row } }).RftInbox

const done = (value: string, e: Edit) => value.slice(0, e.from) + e.insert + value.slice(e.to)

describe('the reading note in the tree view', () => {
  test('a quote: each line after "> ", a blank one as ">", the blank lines at its ends dropped', () => {
    expect(R.quote('one line')).toBe('> one line')
    expect(R.quote('\n\n  first  \r\nsecond\r\n\r\nthird\n\n')).toBe('>   first\n> second\n>\n> third')
    expect(R.quote('')).toBe('')
    expect(R.quote(' \n\t\n')).toBe('')
    // what the plugin reads back as one quote, with the same lines
    expect(quotesOf(R.quote('a\n\nb'))).toEqual([['a', '', 'b']])
  })

  test('a pasted quote stands as a paragraph of its own, and the caret ends on the line after it', () => {
    const paste = (value: string, at: number, text: string, end = at) => {
      const e = R.pasteQuote(value, at, end, text)!
      return [done(value, e), e.caret]
    }
    expect(paste('', 0, 'q')).toEqual(['> q\n\n', 5])
    expect(paste('mine', 4, 'q')).toEqual(['mine\n\n> q\n\n', 11])
    expect(paste('mine\n', 5, 'q')).toEqual(['mine\n\n> q\n\n', 11])
    expect(paste('mine\n\n', 6, 'q')).toEqual(['mine\n\n> q\n\n', 11])
    // in the middle: a blank line on each side, none added where one is
    expect(paste('above\n\nbelow', 7, 'q')).toEqual(['above\n\n> q\n\nbelow', 12])
    expect(paste('above\n\n\n\nbelow', 7, 'q')).toEqual(['above\n\n> q\n\nbelow', 12])
    expect(paste('above\nbelow', 5, 'q1\nq2')).toEqual(['above\n\n> q1\n> q2\n\nbelow', 18])
    // in place of what is selected
    expect(paste('keep DROP keep', 5, 'q', 9)).toEqual(['keep \n\n> q\n\n keep', 12])
    expect(R.pasteQuote('mine', 4, 4, '  \n')).toBeNull()
  })

  test('selected lines become a quote, whole lines, those that are one already left as they are', () => {
    const mark = (value: string, start: number, end: number) => {
      const e = R.quoteLines(value, start, end)!
      return [done(value, e), value.slice(0, e.start).length, e.end]
    }
    expect(mark('one\ntwo\nthree', 5, 6)).toEqual(['one\n> two\nthree', 4, 9])
    expect(mark('one\ntwo\nthree', 1, 9)).toEqual(['> one\n> two\n> three', 0, 19])
    expect(mark('one\n\n> two', 0, 10)).toEqual(['> one\n>\n> two', 0, 13])
    // a selection that ends at a line's start does not take the next line
    expect(mark('one\ntwo', 0, 4)).toEqual(['> one\ntwo', 0, 5])
    expect(R.quoteLines('one', 2, 2)).toBeNull()
  })

  test('the count of quotes, and what the view is headed', () => {
    expect(R.quotes('')).toBe(0)
    expect(R.quotes('> a\n> b\n\nmine\n  > c\n')).toBe(2)
    expect(R.label({ key: 'arxiv:2406.01234', title: 'Mixup at scale' })).toBe('Mixup at scale')
    expect(R.label({ key: 'arxiv:2406.01234' })).toBe('arXiv 2406.01234')
    expect(R.label({ key: 'https://example.org/blog/post', url: 'https://example.org/blog/post/#top' })).toBe('example.org/blog/post')
  })

  test('an item\'s row: the sign says what its note holds, the button reads Process before the read mark and Discuss after', () => {
    const item = { key: 'arxiv:2406.01234', read: '' }
    expect(I.reading(item, {}, [])).toEqual({ mine: false, impression: false, read: '', waiting: false, action: 'process' })
    expect(I.reading(item, null, null)).toEqual({ mine: false, impression: false, read: '', waiting: false, action: 'process' })
    expect(I.reading(item, { 'arxiv:2406.01234': { mine: true, impression: false } }, [])).toMatchObject({ mine: true, impression: false, action: 'process' })
    expect(I.reading(item, { 'arxiv:9999.99999': { mine: true, impression: true } }, [])).toMatchObject({ mine: false, impression: false })
    const read = { ...item, read: '2026-11-24' }
    expect(I.reading(read, { 'arxiv:2406.01234': { mine: true, impression: true } }, [])).toEqual({ mine: true, impression: true, read: '2026-11-24', waiting: false, action: 'discuss' })
    // the discussion found no chat: the row says it waits; an item that is not read never waits
    expect(I.reading(read, {}, ['arxiv:2406.01234'])).toMatchObject({ waiting: true, action: 'discuss' })
    expect(I.reading(item, {}, ['arxiv:2406.01234'])).toMatchObject({ waiting: false, action: 'process' })
    // an item from a server of before the read mark
    expect(I.reading({ key: 'k' }, {}, [])).toMatchObject({ read: '', action: 'process' })
  })
})
