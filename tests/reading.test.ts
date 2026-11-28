// A reading note's file as the plugin reads and writes it (hooks/lib/reading.ts), held to the cases
// the server's side is held to as well (tests/fixtures/reading-note, read here through their copy,
// tests/fixtures/reading-note.ts, which tests/test_reading.py keeps equal to them).

import { describe, expect, mock, test } from 'claude-code/testing'

import { IMPRESSION_CHARS, IMPRESSION_PARTS, ReadingError, fileName, findNote, impressionLines, linesOf, nameOf, newNote, noteText, quotesMissing, quotesOf, readNote, withImpression } from '../hooks/lib/reading'
import type { Io } from '../hooks/lib/vault'
import { today } from '../hooks/lib/ops'
import { CASES, SCENARIOS } from './fixtures/reading-note'
import { CWD, D01, demoFiles, note, world } from './fixture'

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

// In a session: rft_inbox's side of a reading note (docs/adr/0004). The refusals are what the
// design rests on: the user's part before the read mark, a second impression after it, the user's
// part of a read item before any impression, and a close that would lose or paraphrase what the
// user wrote.
describe('reading note: in a session', () => {
  type Engine = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]
  type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]
  const INBOX = 'vault/Inbox.md'
  const NOTE = 'vault/Reading notes/arxiv-2406.01234.md'
  const LINE = '- [Mixup at scale](https://arxiv.org/abs/2406.01234) — maybe relevant to D01 · high · added 2026-11-16'
  const OTHER = '- https://example.org/blog/post — from Bea'
  const QUOTE = '> The gain vanishes below 1k images (Sec. 4.2)'
  const MINE = `${QUOTE}\n\nSame subset sizes as E02?`
  const HEAD = '# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n'
  const imp = (claim: string) => IMPRESSION_PARTS.map((p, n) => `### ${p}\n\n${n === 0 ? claim : `${p} of it.`}`).join('\n\n')
  const link = '2406.01234'

  async function session($: Engine, on: On, files: Record<string, string>) {
    mock.clock(on)
    on('prompt.compose', () => ({ sections: [] }))
    const w = world(on, { ...demoFiles(), ...files })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    return w
  }
  const tool = async ($: Engine, input: Record<string, unknown> = {}) => String((await $.tool.call({ tool: 'mcp__rft__rft_inbox', ...input } as never)).text)
  const reference = (quotes: string) => note('R02', 'reference', 'done', D01, 'Mixup at scale').replace('## Idea\nText of R02.', `## Source\nDoe et al. 2024. https://arxiv.org/abs/2406.01234\n\n## Quotes\n\n${quotes}`)
  const R02 = 'vault/references/R02 Mixup at scale.md'

  test('before the read mark the user\'s part is never given; an impression is saved beside it and a second one replaces it', async ($, on) => {
    const w = await session($, on, { [INBOX]: `# Inbox\n\n${LINE}\n`, [NOTE]: `${HEAD}\n## My reading\n\n${MINE}\n` })
    const closed = await tool($, { link, reading: true })
    expect(closed).toMatch(/^No impression of Mixup at scale \(https:\/\/arxiv\.org\/abs\/2406\.01234\) is saved yet\.\n\nThe user's part of its reading note is closed to you: the user has not marked the item as read\./)
    expect(closed).not.toMatch(/gain vanishes|subset sizes/)
    // the impression: its own lines, and not a byte of the user's part
    const saved = await tool($, { link, impression: imp('First reading.') })
    expect(saved).toBe("Impression saved on Mixup at scale (https://arxiv.org/abs/2406.01234), in its reading note (Reading notes/arxiv-2406.01234.md). The user's part of the reading note stays closed until they mark the item as read.")
    const day = /impression \((\d{4}-\d{2}-\d{2})\)/.exec(w.fs.read(NOTE))![1]!
    expect(w.fs.read(NOTE)).toBe(`${HEAD}\n## My reading\n\n${MINE}\n\n## Claude's impression (${day})\n\n${imp('First reading.')}\n`)
    const again = await tool($, { link, reading: true })
    expect(again).toContain(`Your impression of Mixup at scale (https://arxiv.org/abs/2406.01234), saved ${day}:\n\n### Claims\n\nFirst reading.`)
    expect(again).toContain("The user's part of its reading note is closed to you")
    expect(again).not.toMatch(/gain vanishes|subset sizes/)
    // a second Process rewrites it
    expect(await tool($, { link, impression: imp('Second reading.') })).toContain(`in place of the one of ${day}. The user's part of the reading note stays closed`)
    expect(w.fs.read(NOTE)).toBe(`${HEAD}\n## My reading\n\n${MINE}\n\n## Claude's impression (${day})\n\n${imp('Second reading.')}\n`)
    // one that is not an impression changes nothing
    const kept = w.fs.read(NOTE)
    expect(await tool($, { link, impression: 'A good paper on mixup.' })).toMatch(/^Impression not saved: the impression starts with text under no heading\. An impression has five parts/)
    expect(await tool($, { impression: imp('x') })).toBe('Name the item by its link (link), as rft_inbox with no field lists it.')
    expect(w.fs.read(NOTE)).toBe(kept)
    // the list says nothing of what the note holds, and the inbox's file was never written
    expect(await tool($)).not.toMatch(/gain vanishes|subset sizes/)
    expect(w.fs.read(INBOX)).toBe(`# Inbox\n\n${LINE}\n`)
  })

  test('Process with no reading note makes one: the head, the user\'s part empty, the impression', async ($, on) => {
    const w = await session($, on, { [INBOX]: `${LINE}\n${OTHER}\n` })
    expect(w.fs.exists(NOTE)).toBe(false)
    expect(await tool($, { link, reading: true })).toContain('No impression of Mixup at scale')
    expect(w.fs.exists(NOTE)).toBe(false)
    // the impression and the brief in one call, in that order
    const said = await tool($, { link, impression: imp('First reading.'), brief: 'claims x\ntouches D01\nrecommends: reference under D01' })
    expect(said.split('\n').map(l => l.slice(0, 16))).toEqual(['Impression saved', 'Brief saved on M'])
    const day = /impression \((\d{4}-\d{2}-\d{2})\)/.exec(w.fs.read(NOTE))![1]!
    expect(w.fs.read(NOTE)).toBe(`${HEAD}\n## My reading\n\n## Claude's impression (${day})\n\n${imp('First reading.')}\n`)
    // an item with no title is headed by what the list calls it
    await tool($, { link: 'https://example.org/blog/post', impression: imp('A post.') })
    expect(w.fs.read('vault/Reading notes/example.org-blog-post.md').split('\n').slice(0, 2)).toEqual(['# example.org/blog/post', '<https://example.org/blog/post>'])
    // later: the item, its brief and its reading note stay
    expect(await tool($, { link, outcome: 'later' })).toMatch(/^Left in the inbox for later: Mixup at scale .*with its brief/)
    expect(w.fs.exists(NOTE)).toBe(true)
  })

  test('after the read mark: the user\'s part only once an impression is saved, and the impression frozen from then on', async ($, on) => {
    const w = await session($, on, { [INBOX]: `${LINE} · read 2026-11-24\n`, [NOTE]: `${HEAD}\n## My reading\n\n${MINE}\n` })
    // the user read first: no impression yet, so their part stays closed
    const refused = await tool($, { link, reading: true })
    expect(refused).toBe("The user's part stays closed until your impression is saved: the user marked Mixup at scale (https://arxiv.org/abs/2406.01234) as read (2026-11-24) and it has no impression yet. Read the item itself, from the item alone, save the impression (rft_inbox {link, impression}), then ask again.")
    expect(await tool($, { link, impression: imp('First reading.') })).toContain('The user has marked the item as read: rft_inbox {link, reading: true} gives their part now.')
    const frozen = w.fs.read(NOTE)
    const day = /impression \((\d{4}-\d{2}-\d{2})\)/.exec(frozen)![1]!
    // now both, the user's part as they wrote it
    const both = await tool($, { link, reading: true })
    expect(both).toBe(`Your impression of Mixup at scale (https://arxiv.org/abs/2406.01234), saved ${day}:\n\n${imp('First reading.')}\n\nThe user's part, marked as read 2026-11-24 (theirs: never edit it; a line that starts with > is a quote from the item, any other is their own):\n\n${MINE}`)
    // no impression after the user's part was given
    expect(await tool($, { link, impression: imp('Second reading.') })).toBe(`Impression not saved: the user marked Mixup at scale (https://arxiv.org/abs/2406.01234) as read on 2026-11-24, and its impression of ${day} is frozen from then on. It was written before you saw the user's part, and it is what their reading is compared with.`)
    expect(w.fs.read(NOTE)).toBe(frozen)
    // the mark itself is the user's: nothing the tool takes sets or clears it
    await tool($, { link, read: false, brief: 'claims x' })
    expect(w.fs.read(INBOX)).toContain(' · read 2026-11-24\n')
  })

  test('a read item with an empty part: said so; the tool lists the mark', async ($, on) => {
    await session($, on, { [INBOX]: `${LINE} · read 2026-11-24\n`, [NOTE]: `${HEAD}\n## My reading\n\n## Claude's impression (2026-11-20)\n\n${imp('First reading.')}\n` })
    expect(await tool($, { link, reading: true })).toMatch(/\n\nThe user marked the item as read \(2026-11-24\) and wrote nothing in their part\.$/)
    expect(await tool($)).toContain('marked as read by the user 2026-11-24')
  })

  test('closing: an outcome that writes to the tree waits for the read mark and for the quotes word for word; the reading note goes with the item', async ($, on) => {
    const w = await session($, on, { [INBOX]: `${LINE}\n${OTHER}\n`, [NOTE]: `${HEAD}\n## My reading\n\n${MINE}\n`, [R02]: reference('> the gain vanishes under 1k images') })
    const before = w.fs.read(INBOX)
    // not marked as read: Claude has not seen what the part holds
    expect(await tool($, { link, outcome: 'reference', note: 'R02' })).toBe("Not closed: the user's part of the reading note of Mixup at scale (https://arxiv.org/abs/2406.01234) holds something you have not seen, and the outcome reference carries their quotes into the tree. Ask the user to mark the item as read (on its row in the tree view): the discussion starts from there.")
    expect(w.fs.read(INBOX)).toBe(before)
    // marked as read (by the user: the file is theirs), and the note paraphrases the quote
    w.fs.write(INBOX, `${LINE} · read 2026-11-24\n${OTHER}\n`)
    expect(await tool($, { link, outcome: 'reference', note: 'R02' })).toBe(`Not closed: 1 of the user's 1 quote is not in R02 word for word, as quote lines (>). The first missing:\n${QUOTE}\nPut it in R02 as the user wrote it, then close the item.`)
    expect(w.fs.exists(NOTE)).toBe(true)
    // a missing note is still said first, as before
    expect(await tool($, { link, outcome: 'reference', note: 'R09' })).toContain('Not closed: there is no note R09.')
    // word for word: closed, and the reading note is removed
    w.fs.write(R02, reference(QUOTE))
    const closed = await tool($, { link, outcome: 'reference', note: 'R02' })
    expect(closed).toMatch(/^Closed: Mixup at scale \(https:\/\/arxiv\.org\/abs\/2406\.01234\) → R02\. It is under Processed in Inbox\.md, dated \S+\. Inbox: 1 item\. Its reading note \(Reading notes\/arxiv-2406\.01234\.md\) is removed: the user's quotes are in R02\.$/)
    expect(w.fs.exists(NOTE)).toBe(false)
    expect(w.fs.read(R02)).toBe(reference(QUOTE))
  })

  test('a direction is checked against the reference it cites, a literature entry against the literature note', async ($, on) => {
    const lit = 'vault/references/R03 Literature on mixup.md'
    const literature = (quotes: string) => note('R03', 'reference', 'done', D01, 'Literature on mixup').replace('tags: [demo, reference, done]', 'tags: [demo, reference, literature, done]')
      .replace('## Idea\nText of R03.', `## Papers\n### 2024 Doe — Mixup at scale\nhttps://arxiv.org/abs/2406.01234\n\n${quotes}`)
    const w = await session($, on, { [INBOX]: `${LINE} · read 2026-11-24\n`, [NOTE]: `${HEAD}\n## My reading\n\n${MINE}\n`, [R02]: reference('none'), [lit]: literature('') })
    expect(await tool($, { link, outcome: 'direction', note: 'D01', cites: 'R02' })).toContain("Not closed: 1 of the user's 1 quote is not in R02 word for word")
    expect(await tool($, { link, outcome: 'literature entry', note: 'R03' })).toContain("Not closed: 1 of the user's 1 quote is not in R03 word for word")
    w.fs.write(lit, literature(`  ${QUOTE}`))
    expect(await tool($, { link, outcome: 'literature entry', note: 'R03' })).toMatch(/→ R03 \(literature entry\)\..*Its reading note \(Reading notes\/arxiv-2406\.01234\.md\) is removed: the user's quotes are in R03\.$/)
    expect(w.fs.exists(NOTE)).toBe(false)
  })

  test('a discard keeps the reading note whatever it holds, asks nothing, and the note comes back with the item; an empty part needs no mark for another outcome', async ($, on) => {
    const blog = 'vault/Reading notes/example.org-blog-post.md'
    const w = await session($, on, {
      [INBOX]: `${LINE}\n${OTHER}\n`, [NOTE]: `${HEAD}\n## My reading\n\n${MINE}\n`,
      [blog]: `# example.org/blog/post\n<https://example.org/blog/post>\n\n## My reading\n\n## Claude's impression (2026-11-20)\n\n${imp('A post.')}\n`,
      [R02]: reference('none'),
    })
    const before = w.fs.read(INBOX), mine = w.fs.read(NOTE)
    const KEPT = 'vault/Reading notes/Discarded/arxiv-2406.01234.md'
    // later closes nothing and removes nothing
    expect(await tool($, { link, outcome: 'later' })).toContain('Left in the inbox for later')
    expect([w.fs.read(INBOX), w.fs.exists(NOTE)]).toEqual([before, true])
    // a discard: not marked as read, the user's part unseen, and nothing is asked, since nothing is lost (docs/adr/0007)
    const said = await tool($, { link, outcome: 'discard', reason: 'not for us' })
    expect(said).toMatch(/^Discarded: Mixup at scale \(https:\/\/arxiv\.org\/abs\/2406\.01234\) — not for us\. .*Its reading note is kept with it \(Reading notes\/Discarded\/arxiv-2406\.01234\.md\), with what the user wrote in it\.$/)
    expect(said).not.toContain('gain vanishes')
    expect([w.fs.exists(NOTE), w.fs.read(KEPT)]).toEqual([false, mine])
    // no tool gives what the kept note holds
    expect(await tool($, { link, reading: true })).toMatch(/^Not in the inbox any more: .* was discarded/)
    // the user asks for it back: the note returns beside the others, byte for byte, and is as closed to Claude as it was
    const back = await tool($, { link, restore: true })
    expect(back).toMatch(/^Brought back into the inbox: Mixup at scale \(https:\/\/arxiv\.org\/abs\/2406\.01234\), as it was when it was discarded on \d{4}-\d{2}-\d{2}, with its reading note \(Reading notes\/arxiv-2406\.01234\.md\)\. Inbox: 2 items/)
    expect([w.fs.read(NOTE), w.fs.exists(KEPT)]).toEqual([mine, false])
    expect(await tool($, { link, reading: true })).toContain("The user's part of its reading note is closed to you")
    // discarded again while a kept note has its name: the next name, and none is written over
    w.fs.write(KEPT, `${HEAD}\n## My reading\n\nan older one\n`)
    expect(await tool($, { link, outcome: 'discard', reason: 'again' })).toContain('(Reading notes/Discarded/arxiv-2406.01234-2.md)')
    expect([w.fs.read('vault/Reading notes/Discarded/arxiv-2406.01234-2.md'), w.fs.read(KEPT)]).toEqual([mine, `${HEAD}\n## My reading\n\nan older one\n`])
    expect(w.fs.exists(NOTE)).toBe(false)
    // a note with Claude's impression alone: the inbox's short path still closes, unread and unasked
    expect(await tool($, { link: 'https://example.org/blog/post', outcome: 'reference', note: 'R02' })).toMatch(/^Closed: https:\/\/example\.org\/blog\/post → R02\..* Its reading note \(Reading notes\/example\.org-blog-post\.md\) is removed\.$/)
    expect(w.fs.exists(blog)).toBe(false)
  })

  test('a read item discarded and brought back is still read: its note is as it was and its impression stays frozen', async ($, on) => {
    const kept = `${HEAD}\n## My reading\n\n${MINE}\n\n## Claude's impression (2026-11-20)\n\n${imp('First.')}\n`
    const w = await session($, on, { [INBOX]: `${LINE} · read 2026-11-24\n`, [NOTE]: kept })
    expect(await tool($, { link, outcome: 'discard', reason: 'not now' })).toContain('Its reading note is kept with it')
    expect(await tool($, { link, restore: true })).toContain('its read mark (2026-11-24), its reading note (Reading notes/arxiv-2406.01234.md)')
    expect(w.fs.read(NOTE)).toBe(kept)
    expect(await tool($, { link, impression: imp('Second.') })).toContain('is frozen from then on')
    expect(await tool($, { link, reading: true })).toContain("The user's part, marked as read 2026-11-24")
    expect(w.fs.read(NOTE)).toBe(kept)
  })
})

// Cases A, B and C of tests/fixtures/reading-note (scenarios.json; SCENARIOS.md says them in
// words): every step of Claude's, run against the files the step before it left, answers what the
// fixture says and leaves the files it says, and no other. The user's steps are run by
// tests/test_server.py against the same file.
describe('reading note: the three cases, step by step (Claude\'s side)', () => {
  type Step = { who: string; does: string; after?: number; tool?: Record<string, unknown>; says?: string[]; never?: string[]; files?: Record<string, string | null> }
  const scenarios = SCENARIOS as unknown as Record<string, { title: string; steps: Step[] }>

  test('the fixture has the three cases, each with steps of both', () => {
    expect(Object.keys(scenarios)).toEqual(['A', 'B', 'C'])
    for (const s of Object.values(scenarios)) expect(new Set(s.steps.map(x => x.who))).toEqual(new Set(['given', 'user', 'claude']))
  })

  for (const [name, scenario] of Object.entries(scenarios)) {
    test(scenario.title, async ($, on) => {
      mock.clock(on)
      on('prompt.compose', () => ({ sections: [] }))
      const w = world(on, demoFiles())
      await $.session.start({ cwd: CWD, source: 'startup' } as never)
      const day = today()
      const dated = (text: string) => text.split('{today}').join(day)
      const known = [...new Set(scenario.steps.flatMap(s => Object.keys(s.files ?? {})))]
      const states: Record<string, string>[] = [] // the files after each step
      let ran = 0
      for (const [n, step] of scenario.steps.entries()) {
        const before = step.after !== undefined ? states[step.after]! : states[states.length - 1] ?? {}
        const after = { ...before }
        for (const [path, text] of Object.entries(step.files ?? {})) {
          if (text === null) delete after[path]
          else after[path] = dated(text)
        }
        states.push(after)
        if (!step.tool) continue
        // the vault as the step before left it
        for (const path of known) {
          if (!(path in before)) {
            if (w.fs.exists(`vault/${path}`)) w.fs.remove(`vault/${path}`)
          } else if (!w.fs.exists(`vault/${path}`) || w.fs.read(`vault/${path}`) !== before[path]) w.fs.write(`vault/${path}`, before[path]!)
        }
        const said = String((await $.tool.call({ tool: 'mcp__rft__rft_inbox', ...step.tool } as never)).text)
        const at = `${name}${n}`
        for (const s of step.says ?? []) expect({ at, said }).toEqual({ at, said: expect.stringContaining(dated(s)) })
        for (const s of step.never ?? []) expect({ at, never: s, found: said.includes(s) }).toEqual({ at, never: s, found: false })
        const now = Object.fromEntries(known.filter(path => w.fs.exists(`vault/${path}`)).map(path => [path, w.fs.read(`vault/${path}`)]))
        expect({ at, files: now }).toEqual({ at, files: after })
        ran++
      }
      expect(ran).toBe(scenario.steps.filter(s => s.tool).length)
      expect(ran).toBeGreaterThanOrEqual(2)
    })
  }
})
