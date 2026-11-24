// A reading note's file as the plugin reads and writes it (hooks/lib/reading.ts), held to the cases
// the server's side is held to as well (tests/fixtures/reading-note, read here through their copy,
// tests/fixtures/reading-note.ts, which tests/test_reading.py keeps equal to them).

import { describe, expect, test } from 'claude-code/testing'

import { IMPRESSION_CHARS, IMPRESSION_PARTS, ReadingError, fileName, findNote, impressionLines, linesOf, nameOf, newNote, noteText, quotesMissing, quotesOf, readNote, withImpression } from '../hooks/lib/reading'
import type { Io } from '../hooks/lib/vault'
import { CASES } from './fixtures/reading-note'

type Item = { key: string; url: string; title: string }
const noteOf = (c: { text: string | null; item: Item }) => (c.text === null ? newNote(c.item.key, c.item.url, c.item.title) : readNote(c.text))

describe('reading note: the file', () => {
  test('a file name and a heading from a key, as on the server\'s side', () => {
    for (const [key, title, name, second, head] of CASES.names as string[][]) {
      expect({ key, got: [fileName(key!), fileName(key!, 1), nameOf(key!, title)] }).toEqual({ key, got: [name, second, head] })
    }
  })

  test('read, case by case, and written back unchanged', () => {
    for (const c of CASES.reads as { name: string; text: string; key: string | null; mine: string; impression: object | null }[]) {
      const note = readNote(c.text)
      expect({ name: c.name, key: note.key, mine: note.mine, impression: note.impression }).toEqual({ name: c.name, key: c.key, mine: c.mine, impression: c.impression })
      expect(noteText(note)).toBe(c.text)
    }
  })

  test('the impression, case by case: its own lines change, the user\'s part and the head never', () => {
    type Case = { name: string; text: string | null; item: Item; impression: string; today: string; want?: string; error?: boolean }
    for (const c of CASES.impressions as Case[]) {
      const note = noteOf(c)
      if (c.error) {
        expect(() => impressionLines(c.impression)).toThrow(ReadingError)
        continue
      }
      const done = withImpression(note, impressionLines(c.impression), c.today)
      expect({ name: c.name, text: noteText(done) }).toEqual({ name: c.name, text: c.want })
      expect({ name: c.name, key: done.key, mine: done.mine }).toEqual({ name: c.name, key: c.item.key, mine: note.mine })
      expect(done.impression).toEqual({ date: c.today, text: impressionLines(c.impression).join('\n') })
      // what was before the impression is there byte for byte
      if (c.text !== null && note.at[1] === null) expect(c.want!.startsWith(c.text.replace(/[ \t\r\n]+$/, ''))).toBe(true)
      // saved a second time, the file is the same
      expect(noteText(withImpression(done, impressionLines(c.impression), c.today))).toBe(c.want!)
    }
    expect((CASES.impressions as Case[]).filter(c => c.error).length).toBeGreaterThan(6)
  })

  test('an impression has its five parts, in their order, within a screen', () => {
    const parts = IMPRESSION_PARTS.map(p => `### ${p}\n\nx`)
    expect(impressionLines(parts.join('\n\n')).join('\n')).toBe(parts.join('\n\n'))
    expect(() => impressionLines(parts.slice(0, 4).join('\n\n'))).toThrow('the impression has no part "Left open"')
    expect(() => impressionLines([parts[1], parts[0], ...parts.slice(2)].join('\n\n'))).toThrow('the part "How" is before "Claims"')
    expect(() => impressionLines(`${parts.join('\n\n')}\n\n### Verdict\n\ngood`)).toThrow('"Verdict" is not a part of an impression')
    expect(() => impressionLines(`${parts.join('\n\n')}${'y'.repeat(IMPRESSION_CHARS)}`)).toThrow(`at most ${IMPRESSION_CHARS} characters`)
    // a refusal names the five parts and what each holds
    expect(() => impressionLines('a summary')).toThrow(/starts with text under no heading\. An impression has five parts.*### Claims, ### How, ### Key results, ### Bearing on, ### Left open/)
  })

  test('what the server writes reads the same here', () => {
    for (const c of (CASES.mine as { name: string; text: string | null; item: Item; mine: string; want?: string }[]).filter(c => c.want !== undefined)) {
      const note = readNote(c.want!)
      expect({ name: c.name, mine: note.mine }).toEqual({ name: c.name, mine: linesOf(c.mine).join('\n') })
      if (c.text !== null) expect({ name: c.name, impression: note.impression }).toEqual({ name: c.name, impression: readNote(c.text).impression })
    }
  })

  test('the quotes of the user\'s part, and those a note does not hold word for word', () => {
    for (const c of CASES.quotes as { name: string; mine: string; quotes: string[][] }[]) expect({ name: c.name, quotes: quotesOf(c.mine) }).toEqual({ name: c.name, quotes: c.quotes })
    for (const c of CASES.held as { name: string; mine: string; note: string; missing: string[][] }[]) {
      expect({ name: c.name, missing: quotesMissing(c.mine, c.note) }).toEqual({ name: c.name, missing: c.missing })
    }
  })

  test('the file of an item by its key: two links of one file name have a note each', async () => {
    const files = new Map<string, string>()
    const io = { exists: async (p: string) => files.has(p), read: async (p: string) => files.get(p)! } as unknown as Io
    const key = 'https://a.org/x-y', other = 'https://a.org/x/y'
    expect(await findNote(io, 'vault', key)).toEqual({ path: 'vault/Reading notes/a.org-x-y.md', note: null })
    files.set('vault/Reading notes/a.org-x-y.md', noteText(newNote(key, key)))
    expect((await findNote(io, 'vault', key)).note!.key).toBe(key)
    expect(await findNote(io, 'vault', other)).toEqual({ path: 'vault/Reading notes/a.org-x-y-2.md', note: null })
    // a file that names no item is the item's by its name
    files.set('vault/Reading notes/a.org-z.md', '## My reading\n\nheadless\n')
    expect((await findNote(io, 'vault', 'https://a.org/z')).note!.mine).toBe('headless')
  })
})
