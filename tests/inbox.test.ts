// The inbox as the plugin reads and writes it (hooks/lib/inbox.ts), held to the fixture and the
// cases the server's side is held to as well (tests/fixtures/inbox, read here through their copy,
// tests/fixtures/inbox.ts, which tests/test_inbox.py keeps equal to them); then the inbox in a
// session: rft_inbox, /rft-inbox, rft_next's line.
//
// The three cases it was built to: (A) the user pastes an arXiv link from their phone and finds it
// in the list later, whatever form the link had; (B) the same paper given twice, or already read
// (a processed item, a reference), is said to be there and not added; (C) the file is the user's:
// what they typed in Obsidian (their own headings, remarks, a link typed twice) is still there,
// byte for byte, after the plugin adds a line.

import { describe, expect, mock, test } from 'claude-code/testing'

import { INBOX, InboxError, addTo, briefOn, byPriority, closeIn, commandInput, discardIn, discussPrompt, findIn, inboxLine, inboxReport, inboxText, kept, linksIn, processPrompt, readInbox, restoreIn, shown, sourceOf, strip } from '../hooks/lib/inbox'
import { CASES, EXPECTED, INBOX_MD } from './fixtures/inbox'
import { CWD, D00, demoFiles, note, world } from './fixture'

type AddCase = { name: string; text: string; link: string; why?: string; priority?: string; title?: string; today?: string; want?: string; error?: boolean }

describe('inbox: the file', () => {
  test('the fixture yields its items and its processed items', () => {
    const box = readInbox(INBOX_MD)
    expect(shown(box)).toEqual(EXPECTED.items)
    expect(box.processed).toEqual(EXPECTED.processed)
  })

  test('read and written back, the file is unchanged', () => {
    const crlf = INBOX_MD.replace(/\n/g, '\r\n')
    for (const text of [INBOX_MD, crlf, '', '\n', 'no newline at the end', '- https://a.org/x\n\n\n', '\r\n- https://a.org/x\r\n']) {
      expect(inboxText(readInbox(text))).toBe(text)
    }
    expect(shown(readInbox(crlf))).toEqual(EXPECTED.items)
  })

  test('identity, case by case', () => {
    for (const [text, key] of CASES.identity as [string, string | null][]) {
      expect({ text, key: readInbox(`- ${text}`).items[0]?.key ?? null }).toEqual({ text, key })
    }
  })

  test('white space is the set spelled out, as on the server\'s side', () => {
    const spaces: number[] = []
    for (let c = 0; c < 0x10000; c++) if (strip(String.fromCharCode(c)) === '') spaces.push(c)
    const run = Array.from({ length: 11 }, (_, n) => 0x2000 + n)
    expect(spaces).toEqual([9, 10, 11, 12, 13, 32, 0xa0, 0x1680, ...run, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000])
    expect(strip('\u00a0\t x \u3000\n')).toBe('x')
    expect(strip('\ufeffx\x85')).toBe('\ufeffx\x85')
  })

  test('what already holds a link: an item, else a processed item', () => {
    const box = readInbox(INBOX_MD)
    for (const [key, kind, fields] of CASES.finds as [string, string | null, Record<string, unknown> | null][]) {
      const got = findIn(box, key)
      expect({ key, kind: got ? Object.keys(got)[0] : null }).toEqual({ key, kind })
      if (got) expect('item' in got ? got.item : 'processed' in got ? got.processed : got.discarded).toMatchObject(fields ?? {})
    }
  })

  test('the links a reference names, in its Source alone', () => {
    for (const [text, keys] of CASES.sources as [string, string[]][]) expect({ text, keys: linksIn(text) }).toEqual({ text, keys })
    for (const [text, keys] of CASES.notes as [string, string[]][]) expect({ text, keys: linksIn(sourceOf(text)) }).toEqual({ text, keys })
  })

  test('add, case by case: one new line, or a refusal that changes nothing', () => {
    for (const c of CASES.adds as AddCase[]) {
      const box = readInbox(c.text)
      if (c.error) {
        expect(() => addTo(box, c)).toThrow(InboxError)
        expect(inboxText(box)).toBe(c.text)
        continue
      }
      const added = addTo(box, c)
      expect({ name: c.name, text: inboxText(added.box) }).toEqual({ name: c.name, text: c.want })
      expect(shown(added.box)).toContainEqual(added.item)
      expect(shown(readInbox(c.want!))).toEqual(shown(added.box))
    }
  })

  test('an add changes one line of the fixture and nothing else', () => {
    const before = INBOX_MD.split('\n')
    const { box, item } = addTo(readInbox(INBOX_MD), { link: 'arXiv:2511.00042v2', why: 'from the talk', priority: 'high', today: '2026-11-23' })
    expect(item).toEqual({ key: 'arxiv:2511.00042', url: 'https://arxiv.org/abs/2511.00042', title: '', why: 'from the talk', priority: 'high', added: '2026-11-23', read: '', duplicate: false, brief: null })
    const at = before.indexOf('- see also the list in Scratchpad') + 1
    expect(inboxText(box).split('\n')).toEqual([...before.slice(0, at), '- https://arxiv.org/abs/2511.00042 — from the talk · high · added 2026-11-23', ...before.slice(at)])
    expect(shown(box)).toEqual([...EXPECTED.items, item])
    expect(box.processed).toEqual(EXPECTED.processed)
  })

  test('the read mark, case by case: `read <day>` is the user\'s mark only as a part of its own after the link', () => {
    for (const [text, fields] of CASES.reads as [string, Record<string, string>][]) {
      const items = shown(readInbox(`- ${text}`))
      expect({ text, n: items.length }).toEqual({ text, n: 1 })
      expect({ text, item: items[0] }).toEqual({ text, item: expect.objectContaining(fields) })
    }
    // the plugin never sets it: a why that would read as the mark is refused, as one that reads as a reading priority is
    for (const c of CASES.unmarked as AddCase[]) expect(() => addTo(readInbox(c.text), c)).toThrow(InboxError)
    // the items the server changes read the same here, the mark among them
    for (const c of (CASES.changes as { text: string; want?: string; read?: string; key: string; error?: boolean }[]).filter(c => c.read !== undefined && c.want)) {
      expect({ name: c.want, read: shown(readInbox(c.want!)).find(i => i.key === c.key)!.read }).toEqual({ name: c.want, read: c.read })
    }
  })

  test('close, case by case, as the server closes: the item and its brief go, one line under Processed', () => {
    type CloseCase = { name: string; text: string; key: string; nth?: number; outcome?: string; today: string; want?: string; none?: boolean; processed?: object }
    for (const c of CASES.closes as CloseCase[]) {
      const box = readInbox(c.text)
      const done = closeIn(box, c.key, c.nth ?? 0, c.outcome ?? 'discarded', c.today)
      expect({ name: c.name, none: done === null }).toEqual({ name: c.name, none: !!c.none })
      expect(inboxText(box)).toBe(c.text)
      if (!done) continue
      expect({ name: c.name, text: inboxText(done.box) }).toEqual({ name: c.name, text: c.want })
      expect(done.box.processed[done.box.processed.length - 1]).toEqual(done.processed)
      if (c.processed) expect(done.processed).toEqual(c.processed)
      const again = readInbox(c.want!)
      expect([shown(again), again.processed]).toEqual([shown(done.box), done.box.processed])
    }
    expect((CASES.closes as CloseCase[]).length).toBeGreaterThan(15)
  })

  test('the discarded ones, case by case: an item under `## Discarded` is kept whole, and its last indented line says when and why', () => {
    type KeptCase = { name: string; text: string; items: string[]; discarded: object[]; open?: object[]; holds?: [string, string][] }
    for (const c of CASES.kept as KeptCase[]) {
      const box = readInbox(c.text)
      expect({ name: c.name, items: shown(box).map(i => i.key), discarded: kept(box) }).toEqual({ name: c.name, items: c.items, discarded: c.discarded })
      if (c.open) expect(shown(box)).toEqual(c.open)
      for (const [key, kind] of c.holds ?? []) expect({ name: c.name, key, kind: Object.keys(findIn(box, key) ?? {})[0] }).toEqual({ name: c.name, key, kind })
      expect(inboxText(box)).toBe(c.text)
    }
    expect((CASES.kept as KeptCase[]).length).toBeGreaterThan(6)
  })

  test('discard, case by case, as the server discards: the item\'s lines move under Discarded as they are, with one line more', () => {
    type DiscardCase = { name: string; text: string; key: string; nth?: number; reason?: string; today: string; want?: string; is?: object; none?: boolean; error?: boolean }
    for (const c of CASES.discards as DiscardCase[]) {
      const box = readInbox(c.text)
      if (c.error) {
        expect(() => discardIn(box, c.key, c.nth ?? 0, c.reason ?? '', c.today)).toThrow(InboxError)
        expect(inboxText(box)).toBe(c.text)
        continue
      }
      const done = discardIn(box, c.key, c.nth ?? 0, c.reason ?? '', c.today)
      expect({ name: c.name, none: done === null }).toEqual({ name: c.name, none: !!c.none })
      expect(inboxText(box)).toBe(c.text)
      if (!done) continue
      expect({ name: c.name, text: inboxText(done.box) }).toEqual({ name: c.name, text: c.want })
      expect({ name: c.name, is: done.discarded }).toEqual({ name: c.name, is: c.is })
      expect(kept(done.box)[kept(done.box).length - 1]).toEqual(done.discarded)
      expect(shown(done.box).length).toBe(shown(box).length - 1)
      const again = readInbox(c.want!)
      expect([shown(again), again.processed, kept(again)]).toEqual([shown(done.box), done.box.processed, kept(done.box)])
    }
    expect((CASES.discards as DiscardCase[]).length).toBeGreaterThan(10)
  })

  test('a return, case by case: the discarded item is back at the end of the open list, as it was', () => {
    type ReturnCase = { name: string; text: string; key: string; want?: string; item?: object; none?: boolean }
    for (const c of CASES.returns as ReturnCase[]) {
      const box = readInbox(c.text)
      const back = restoreIn(box, c.key)
      expect({ name: c.name, none: back === null }).toEqual({ name: c.name, none: !!c.none })
      expect(inboxText(box)).toBe(c.text)
      if (!back) continue
      expect({ name: c.name, text: inboxText(back.box) }).toEqual({ name: c.name, text: c.want })
      expect({ name: c.name, item: back.item }).toEqual({ name: c.name, item: c.item })
      expect(shown(back.box)[shown(back.box).length - 1]).toEqual(back.item)
      expect(kept(back.box).length).toBe(kept(box).length - 1)
    }
  })

  test('the fixture\'s first item discarded and brought back: its own lines are what they were, and the old discards stay processed lines', () => {
    const box = readInbox(INBOX_MD)
    const before = INBOX_MD.split('\n')
    const done = discardIn(box, 'arxiv:2406.01234', 0, 'superseded by R07', '2026-11-27')!
    expect(inboxText(done.box).split('\n')).toEqual([...before.slice(0, 4), ...before.slice(8, -1), '', '## Discarded', '', ...before.slice(4, 8), '  - discarded 2026-11-27: superseded by R07', ''])
    expect(done.discarded).toMatchObject({ title: 'Mixup at scale', brief: EXPECTED.items[0]!.brief, discarded: '2026-11-27', reason: 'superseded by R07' })
    expect(done.box.processed).toEqual(EXPECTED.processed)
    expect(Object.keys(findIn(done.box, 'https://example.org/blog/old-post')!)).toEqual(['processed'])
    const back = restoreIn(done.box, 'arxiv:2406.01234')!
    const at = before.indexOf('- see also the list in Scratchpad') + 1
    expect(inboxText(back.box).split('\n')).toEqual([...before.slice(0, 4), ...before.slice(8, at), ...before.slice(4, 8), ...before.slice(at, -1), '', '## Discarded', ''])
    expect({ ...back.item, duplicate: false }).toEqual(EXPECTED.items[0])
  })

  test('a brief, case by case: at most three lines under the item, in place of the one it had', () => {
    type BriefCase = { name: string; text: string; key: string; nth?: number; brief: string; today: string; want?: string; is?: object; none?: boolean; error?: boolean }
    for (const c of CASES.briefs as BriefCase[]) {
      const box = readInbox(c.text)
      if (c.error) {
        expect(() => briefOn(box, c.key, c.nth ?? 0, c.brief, c.today)).toThrow(InboxError)
        expect(inboxText(box)).toBe(c.text)
        continue
      }
      const done = briefOn(box, c.key, c.nth ?? 0, c.brief, c.today)
      expect({ name: c.name, none: done === null }).toEqual({ name: c.name, none: !!c.none })
      if (!done) continue
      expect({ name: c.name, text: inboxText(done.box) }).toEqual({ name: c.name, text: c.want })
      expect({ name: c.name, brief: done.item.brief }).toEqual({ name: c.name, brief: c.is })
      // the item is what it was but for its brief, and so is every other
      const strip1 = (items: ReturnType<typeof shown>) => items.map(i => ({ ...i, brief: null }))
      expect(strip1(shown(done.box))).toEqual(strip1(shown(box)))
    }
  })

  test('a brief and a close in the fixture: the brief changes its own lines, the close moves one item', () => {
    const before = INBOX_MD.split('\n')
    const at = before.indexOf('- 2311.09876')
    const briefed = briefOn(readInbox(INBOX_MD), 'arxiv:2311.09876', 0, 'claims y\ntouches D04\nrecommends: discard', '2026-11-23')!
    expect(inboxText(briefed.box).split('\n')).toEqual([...before.slice(0, at + 1), '  - briefed 2026-11-23: claims y', '  - touches D04', '  - recommends: discard', ...before.slice(at + 1)])
    expect(briefed.box.processed).toEqual(EXPECTED.processed)
    // the item briefed in the fixture, replaced: its three lines and no other
    const mixup = before.findIndex(l => l.startsWith('- [Mixup at scale]'))
    const again = briefOn(readInbox(INBOX_MD), 'arxiv:2406.01234', 0, 'one line now', '2026-11-23')!
    expect(inboxText(again.box).split('\n')).toEqual([...before.slice(0, mixup + 1), '  - briefed 2026-11-23: one line now', ...before.slice(mixup + 4)])
    const closed = closeIn(briefed.box, 'arxiv:2311.09876', 0, '→ R15', '2026-11-23')!
    expect(inboxText(closed.box).split('\n')).toEqual([...before.slice(0, at), ...before.slice(at + 1, -1), '- 2026-11-23 https://arxiv.org/abs/2311.09876 → R15', ''])
    expect(shown(closed.box)).toEqual(EXPECTED.items.filter(i => i.key !== 'arxiv:2311.09876'))
    expect(closed.box.processed).toEqual([...EXPECTED.processed, { date: '2026-11-23', key: 'arxiv:2311.09876', title: '', outcome: 'R15' }])
  })

  test('the Process prompt names the item and its manual file, asks for Claude\'s own reading (the impression, then the brief) and stops there', () => {
    const item = EXPECTED.items.find(i => i.key === 'arxiv:2501.00001')!
    const p = processPrompt('/plugin/skills/rft-manual', item)
    expect(p.split('\n')[0]).toBe('Process this inbox item (read the manual\'s "Processing an item" (/plugin/skills/rft-manual/inbox.md) first): https://arxiv.org/abs/2501.00001 (saved because: Thomas mentioned it; added 2026-11-22).')
    expect(p).toContain('This is your own reading, written before you see mine. Read the item itself')
    // from the item alone, whatever the tree holds of it, and never through the reading note's file
    expect(p).toContain('Read it from the item alone, also when it is already an entry of a literature note, and do not open its reading note\'s file: my part of it is closed to you until I mark the item as read.')
    // the impression first, with its five parts, then the brief; and no outcome
    const imp = p.indexOf('save your impression with rft_inbox {link: "https://arxiv.org/abs/2501.00001", impression}')
    const brief = p.indexOf('save its brief with rft_inbox {link: "https://arxiv.org/abs/2501.00001", brief}')
    expect(imp).toBeGreaterThan(0)
    expect(brief).toBeGreaterThan(imp)
    for (const part of ['### Claims', '### How', '### Key results', '### Bearing on', '### Left open']) expect(p).toContain(part)
    expect(p).toContain('the one outcome you recommend')
    expect(p).toContain('Give me the brief in the chat and stop there: no outcome is picked now and nothing is written to the tree.')
    expect(p).not.toMatch(/until I pick|close the item|outcome, \.\.\.}/)
    // the item that cannot be read (scenario C of the inbox)
    expect(p).toContain('If you cannot read it (a paywall, a dead link, a page that needs a login), say so and save no impression and no brief: never write one from the title')
    expect(p).toContain('Offer me to discard it, to leave it for later, or to give you the path of its PDF in the vault.')
    expect(p).not.toMatch(/urgent|high|medium|reading priority/)
    // a briefed item is read again: its brief is not what this reading starts from
    const briefed = EXPECTED.items.find(i => i.brief)!
    const again = processPrompt('/m', briefed)
    expect(again).toContain(`Read it from the item alone, and again: its brief of ${briefed.brief!.date} is replaced by this reading's, also when it is already an entry`)
    expect(again).not.toContain(briefed.brief!.lines[0])
    // its reading priority is the user's and says nothing to Claude
    expect(briefed.priority).toBe('high')
    expect(again).not.toMatch(/\bhigh\b/)
  })

  test('the Discuss prompt asks for the reading note first, an impression before the user\'s part, the differences, and nothing written until the user picks', () => {
    const item = { ...EXPECTED.items.find(i => i.key === 'arxiv:2501.00001')!, read: '2026-11-24' }
    const p = discussPrompt('/plugin/skills/rft-manual', item)
    expect(p.split('\n')[0]).toBe('Discuss this inbox item with me (read the manual\'s "Discussing an item" (/plugin/skills/rft-manual/inbox.md) first): https://arxiv.org/abs/2501.00001 (saved because: Thomas mentioned it; added 2026-11-22). I have read it and marked it as read (2026-11-24).')
    expect(p).toContain('First call rft_inbox {link: "https://arxiv.org/abs/2501.00001", reading: true}')
    expect(p).toContain('If it answers that there is no impression yet, read the item itself, from the item alone, save your impression')
    expect(p).toContain('your reading is written before you see mine')
    expect(p).toContain('tell me where the two readings differ')
    expect(p).toContain('write nothing to the tree until I pick')
    expect(p).toContain('my quotes go into the tree word for word, as quote lines (>), never paraphrased; my own lines you may rephrase, but propose the wording here first and write it only once I accept. Never edit my part of the reading note.')
    expect(p).not.toMatch(/urgent|high|medium|reading priority/)
  })

  test('the most pressing first, the newest first among equals (of one day, the one added later), those with no day last', () => {
    const item = (key: string, priority: string, added: string) => ({ key, url: key, title: '', why: '', priority, added, read: '', duplicate: false, brief: null })
    const items = [item('a', '', '2026-11-20'), item('b', 'low', ''), item('c', 'urgent', '2026-11-01'), item('d', 'high', '2026-11-02'), item('e', 'high', '2026-11-09'), item('f', '', ''), item('g', '', '2026-11-21'), item('h', 'high', '2026-11-09')]
    expect(byPriority(items).map(i => i.key).join('')).toBe('chedbgaf')
    expect(items.map(i => i.key).join('')).toBe('abcdefgh')
  })

  test('/rft-inbox <link> [reading priority] [why]: a first word that is a priority is one, any other is the why\'s', () => {
    expect(commandInput('2406.01234 high for D04, from the talk')).toEqual({ link: '2406.01234', priority: 'high', why: 'for D04, from the talk' })
    expect(commandInput('  https://example.org/a/b?x=1   URGENT  ')).toEqual({ link: 'https://example.org/a/b?x=1', priority: 'urgent', why: '' })
    expect(commandInput('doi:10.1109/CVPR.2022.01553 highly cited, low risk')).toEqual({ link: 'doi:10.1109/CVPR.2022.01553', priority: '', why: 'highly cited, low risk' })
    expect(commandInput('[Mixup at scale](https://arxiv.org/abs/2406.01234) — medium — maybe for D04')).toEqual({ link: '[Mixup at scale](https://arxiv.org/abs/2406.01234)', priority: 'medium', why: 'maybe for D04' })
    expect(commandInput('https://example.org/a. read this')).toEqual({ link: 'https://example.org/a.', priority: '', why: 'read this' })
    expect(commandInput('read this https://example.org/a')).toBeNull()
    expect(commandInput('high 2406.01234')).toBeNull()
  })

  test('in words: the count, then the items, the most pressing first; one line for rft_next', () => {
    const box = readInbox(INBOX_MD)
    const urgent = EXPECTED.items.filter(i => i.priority === 'urgent').length, briefed = EXPECTED.items.filter(i => i.brief).length
    const counts = [`Inbox: ${EXPECTED.items.length} items`, urgent ? `${urgent} urgent` : '', briefed ? `${briefed} briefed` : ''].filter(Boolean).join(', ')
    const report = inboxReport(box).split('\n')
    expect(report[0]).toBe(`${counts}, saved to read later and not decided about (Inbox.md in the vault).`)
    expect(report.length).toBe(1 + EXPECTED.items.length)
    const first = byPriority(EXPECTED.items)[0]!
    expect(report[1]).toContain(`1. ${first.priority ? `${first.priority} · ` : ''}${first.title || first.url}`)
    expect(inboxLine(box)).toBe(`${counts} (rft_inbox lists them; one is processed when the user asks).`)
    expect(inboxLine(readInbox('# Inbox\n\nnothing yet\n'))).toBe('')
    expect(inboxReport(readInbox(''))).toContain('The inbox is empty')
    expect(inboxLine(readInbox('- https://a.org/x\n'))).toBe('Inbox: 1 item (rft_inbox lists them; one is processed when the user asks).')
  })
})

describe('inbox: in a session', () => {
  type Engine = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]
  type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]
  const FILE = `vault/${INBOX}`
  const R01_PATH = 'vault/references/R01 Mixup paper.md'

  async function session($: Engine, on: On, inbox?: string) {
    mock.clock(on)
    on('prompt.compose', () => ({ sections: [] }))
    const files = demoFiles()
    files[R01_PATH] = note('R01', 'reference', 'done', D00, 'Mixup paper').replace('## Idea\nText of R01.', '## Source\nZhang et al. 2018, mixup. arXiv:1710.09412v2\n\n## Relevance\nSee also https://example.org/elsewhere')
    if (inbox !== undefined) files[FILE] = inbox
    const w = world(on, files)
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    return w
  }
  const tool = async ($: Engine, input: Record<string, unknown> = {}) => String((await $.tool.call({ tool: 'mcp__rft__rft_inbox', ...input } as never)).text)
  const command = async ($: Engine, args = '') =>
    String((await $.command.run({ command: 'rft-inbox', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never) as { text?: string }).text)
  const next = async ($: Engine, input: Record<string, unknown> = {}) => String((await $.tool.call({ tool: 'mcp__rft__rft_next', ...input } as never)).text)
  const rulesOf = async ($: Engine) =>
    (await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })).sections.find(s => s.id === 'rft:rules')!.text

  test('rft_inbox lists the inbox and saves a link; a link already there, processed or a reference\'s is reported and not added', async ($, on) => {
    const w = await session($, on, INBOX_MD)
    // behind ToolSearch, and with no way to give a reading priority
    expect(w.deferred).toContain('rft_inbox')
    expect(Object.keys((w.specs.rft_inbox!.inputSchema as { properties: object }).properties)).toEqual(['link', 'why', 'title', 'impression', 'brief', 'reading', 'outcome', 'note', 'cites', 'reason', 'restore'])
    expect(await tool($)).toBe(inboxReport(readInbox(INBOX_MD)))
    expect(w.fs.read(FILE)).toBe(INBOX_MD)

    const saved = await tool($, { link: 'https://arxiv.org/pdf/2511.00042v2', why: 'bears on D01', title: 'A [new] paper' })
    expect(saved).toMatch(new RegExp(`^Saved to the inbox: A \\(new\\) paper \\(https://arxiv\\.org/abs/2511\\.00042\\) \\(why: bears on D01\\)\\. Inbox: ${EXPECTED.items.length + 1} items`))
    const after = w.fs.read(FILE)
    const line = after.split('\n').find(l => l.includes('2511.00042'))!
    expect(line).toMatch(/^- \[A \(new\) paper\]\(https:\/\/arxiv\.org\/abs\/2511\.00042\) — bears on D01 · added \d{4}-\d{2}-\d{2}$/)
    expect(after.split('\n').filter(l => l !== line)).toEqual(INBOX_MD.split('\n'))

    // the same paper in another form, a processed one, a reference's: said, and the file left as it is
    expect(await tool($, { link: 'arXiv:2511.00042' })).toMatch(/^Already in the inbox \(added \d{4}-\d{2}-\d{2}\): A \(new\) paper \(https:\/\/arxiv\.org\/abs\/2511\.00042\)\. Nothing added\.$/)
    expect(await tool($, { link: 'https://arxiv.org/abs/2111.06377v3' })).toMatch(/^Already processed on 2026-11-10 \(R03\): .*Nothing added\.$/)
    expect(await tool($, { link: '1710.09412' })).toBe('Already in the tree: R01 is a reference of it (https://arxiv.org/abs/1710.09412). Nothing added.')
    expect(await command($, 'https://arxiv.org/abs/1710.09412v1 high')).toContain('Already in the tree: R01')
    expect(w.fs.read(FILE)).toBe(after)
    // a link the reference only mentions outside its Source is not what it is a note of
    expect(await tool($, { link: 'https://example.org/elsewhere' })).toContain('Saved to the inbox: https://example.org/elsewhere')
  })

  test('rft_inbox cannot set, change or clear a reading priority', async ($, on) => {
    const w = await session($, on, INBOX_MD)
    const prioritised = EXPECTED.items.find(i => i.priority)!
    for (const input of [
      { link: 'https://example.org/new', why: 'urgent' },
      { link: 'https://example.org/new', why: 'for D01 · high' },
      { link: 'https://example.org/new', why: 'High' },
      { link: 'https://example.org/new urgent' },
      { link: 'https://example.org/new — for D01 · urgent' },
    ]) {
      expect({ input, text: await tool($, input) }).toEqual({ input, text: expect.stringMatching(/^(Not added: the why would read as a reading priority or a date|"https:\/\/example\.org\/new .*" is not a link)/) })
    }
    // a field it does not have changes nothing; an item it is given again keeps what the user gave it
    expect(await tool($, { link: 'https://example.org/new', priority: 'urgent' })).toContain('Saved to the inbox: https://example.org/new. Inbox:')
    expect(await tool($, { link: prioritised.url, priority: 'low', why: 'low' })).toContain(`reading priority ${prioritised.priority}`)
    const box = readInbox(w.fs.read(FILE))
    expect(shown(box).slice(0, EXPECTED.items.length)).toEqual(EXPECTED.items)
    expect(shown(box).slice(EXPECTED.items.length).map(i => [i.key, i.priority])).toEqual([['https://example.org/new', '']])
  })

  const add = async ($: Engine, input: Record<string, unknown>) => String((await $.tool.call({ tool: 'mcp__rft__rft_add_node', ...input } as never)).text)
  const ITEM = '- [Mixup at scale](https://arxiv.org/abs/2406.01234) — maybe relevant to D01 · urgent · added 2026-11-16'
  const OTHER = '- https://example.org/blog/post — from Bea · low'

  test('scenario A: an item, its brief, a reference added, the item closed and pointing at it', async ($, on) => {
    const start = `# Inbox\n\nmy own line\n\n${ITEM}\n${OTHER}\n`
    const w = await session($, on, start)
    // the brief: three lines under the item, and no other line changes
    expect(await tool($, { link: 'arXiv:2406.01234v2', brief: 'claims mixup still helps at ViT-H scale\ntouches D01, E02\nrecommends: reference under D01' }))
      .toBe('Brief saved on Mixup at scale (https://arxiv.org/abs/2406.01234) (3 lines): it stays in the inbox until the user picks an outcome.')
    const day = /briefed (\d{4}-\d{2}-\d{2}):/.exec(w.fs.read(FILE))![1]!
    const briefed = `# Inbox\n\nmy own line\n\n${ITEM}\n  - briefed ${day}: claims mixup still helps at ViT-H scale\n  - touches D01, E02\n  - recommends: reference under D01\n${OTHER}\n`
    expect(w.fs.read(FILE)).toBe(briefed)
    // a link given again answers with where it is and its brief: what a later chat starts from
    expect(await tool($, { link: '2406.01234' })).toBe(`Already in the inbox (added 2026-11-16, reading priority urgent): Mixup at scale (https://arxiv.org/abs/2406.01234). Nothing added.\nIts brief, saved ${day}:\n- claims mixup still helps at ViT-H scale\n- touches D01, E02\n- recommends: reference under D01`)
    expect(w.fs.read(FILE)).toBe(briefed)
    // the outcome needs its note: refused while there is none, and the file is as it was
    expect(await tool($, { link: '2406.01234', outcome: 'reference', note: 'R02' })).toBe('Not closed: there is no note R02. Make the reference note of the item first (rft_add_node), then close the item with its id.')
    expect(await tool($, { link: '2406.01234', outcome: 'reference' })).toContain('Not closed: the outcome reference names the reference note of the item (note).')
    expect(w.fs.read(FILE)).toBe(briefed)
    // the user picks reference: the note, then the close
    expect(await add($, { type: 'reference', title: 'Mixup at scale', parent: 'D01', summary: 'Mixup still helps at ViT-H scale.', sections: { Source: 'Doe et al. 2024. https://arxiv.org/abs/2406.01234' } })).toContain('R02')
    const closed = await tool($, { link: 'https://arxiv.org/abs/2406.01234', outcome: 'reference', note: 'R02' })
    expect(closed).toBe(`Closed: Mixup at scale (https://arxiv.org/abs/2406.01234) → R02. It is under Processed in Inbox.md, dated ${day}. Inbox: 1 item.`)
    expect(w.fs.read(FILE)).toBe(`# Inbox\n\nmy own line\n\n${OTHER}\n\n## Processed\n\n- ${day} [Mixup at scale](https://arxiv.org/abs/2406.01234) → R02\n`)
    // the note has no priority, nor one suggested: the item's reading priority ended with it
    const ref = [...w.fs.files.keys()].find(p => p.includes('references/R02 '))!
    expect(w.fs.read(ref)).not.toMatch(/priority|urgent/)
    // the link is known from now on: in the tree, and closed
    expect(await tool($, { link: 'arXiv:2406.01234' })).toBe(`Already processed on ${day} (R02): Mixup at scale (https://arxiv.org/abs/2406.01234). Nothing added.`)
    expect(await tool($, { link: '2406.01234', outcome: 'later' })).toBe(`Not in the inbox any more: Mixup at scale (https://arxiv.org/abs/2406.01234) was processed on ${day} (R02).`)
    expect(await tool($)).toMatch(/^Inbox: 1 item, saved to read later/)
  })

  test('an outcome names a note of its kind; a discard its reason; later closes nothing', async ($, on) => {
    const start = `${ITEM}\n  - briefed 2026-11-20: claims x\n${OTHER}\n- 2406.01234 — typed again\n`
    const w = await session($, on, start)
    const lit = 'vault/references/R02 Literature on mixup.md'
    w.fs.write(lit, note('R02', 'reference', 'done', D00, 'Literature on mixup').replace('tags: [demo, reference, done]', 'tags: [demo, reference, literature, done]').replace('## Idea\nText of R02.', '## Papers\n### 2024 Doe — Mixup at scale\nhttps://arxiv.org/abs/2406.01234'))
    const link = '2406.01234'
    for (const [input, said] of [
      [{ outcome: 'reference', note: 'D01' }, 'Not closed: D01 is a direction, not a reference.'],
      [{ outcome: 'reference', note: 'E02' }, 'Not closed: E02 is an experiment, not a reference.'],
      [{ outcome: 'reference', note: 'R02' }, 'Not closed: R02 is a literature note. An item added to it as one of its papers has the outcome "literature entry"; the outcome reference names a reference note of the item alone.'],
      [{ outcome: 'literature entry', note: 'R01' }, 'Not closed: R01 is a reference of one source, not a literature note (a reference tagged literature, with its papers in a Papers section).'],
      [{ outcome: 'literature entry', note: 'D01' }, 'Not closed: D01 is a direction, not a literature note (a reference tagged literature, with its papers in a Papers section).'],
      [{ outcome: 'literature entry' }, 'Not closed: the outcome literature entry names the literature note the item was added to (note). Make it first (rft_add_node), then close the item with its id.'],
      [{ outcome: 'direction', note: 'R01' }, 'Not closed: R01 is a reference, not a direction.'],
      [{ outcome: 'direction', note: 'D01' }, 'Not closed: the outcome direction names the reference note of the item, which the direction cites (cites). Make it first (rft_add_node), then close the item with its id.'],
      [{ outcome: 'direction', note: 'D01', cites: 'E01' }, 'Not closed: E01 is an experiment, not a reference. A direction from an item cites the reference note of the item (cites).'],
      [{ outcome: 'direction', note: 'D09', cites: 'R01' }, 'Not closed: there is no note D09. Make the direction the item sparked first (rft_add_node), then close the item with its id.'],
      [{ outcome: 'discard' }, 'Not closed: a discard gives its reason in one line (reason): the user reads it later to know why they passed on the item.'],
      [{ outcome: 'archive' }, 'Not closed: an outcome is reference, literature entry, direction, discard or later, and "archive" is none of them.'],
    ] as const) {
      expect({ input, text: await tool($, { link, ...input }) }).toEqual({ input, text: said })
    }
    expect(await tool($, { link: 'https://example.org/none', outcome: 'discard', reason: 'x' })).toBe('No item of the inbox has this link (https://example.org/none). rft_inbox with no field lists them.')
    expect(await tool($, { outcome: 'discard', reason: 'x' })).toBe('Name the item by its link (link), as rft_inbox with no field lists it.')
    expect(await tool($, { link: 'read it later', brief: 'x' })).toContain('is not a link: name the item by its link')
    expect(await tool($, { link, brief: 'a\nb\nc\nd' })).toBe('Brief not saved: a brief is at most 3 lines and this has 4: what the item claims, which notes of the tree it touches, the outcome you recommend.')
    // later: the item stays, with its brief
    expect(await tool($, { link, outcome: 'later' })).toBe('Left in the inbox for later: Mixup at scale (https://arxiv.org/abs/2406.01234), with its brief (2026-11-20). Nothing closed.')
    expect(await tool($, { link: 'https://example.org/blog/post', outcome: 'later' })).toBe('Left in the inbox for later: https://example.org/blog/post, with no brief. Nothing closed.')
    expect(w.fs.read(FILE)).toBe(start)

    // a discard, with its reason: the item is kept whole under Discarded, its line as it was (docs/adr/0007)
    const discarded = await tool($, { link: 'https://example.org/blog/post/', outcome: 'discard', reason: ' superseded\nby R01 ' })
    expect(discarded).toMatch(/^Discarded: https:\/\/example\.org\/blog\/post — superseded by R01\. It is kept whole under Discarded in Inbox\.md, dated \d{4}-\d{2}-\d{2}: only the user brings it back\. Inbox: 2 items, 1 urgent, 1 briefed\.$/)
    const day = /dated (\d{4}-\d{2}-\d{2})/.exec(discarded)![1]!
    const keptLines = `## Discarded\n\n${OTHER}\n  - discarded ${day}: superseded by R01\n`
    expect(w.fs.read(FILE)).toBe(`${ITEM}\n  - briefed 2026-11-20: claims x\n- 2406.01234 — typed again\n\n${keptLines}`)
    // a literature entry; the link typed twice is two items, and both are closed; the processed ones come before the discarded ones
    const entry = await tool($, { link, outcome: 'literature entry', note: 'R02' })
    expect(entry).toBe(`Closed: Mixup at scale (https://arxiv.org/abs/2406.01234) → R02 (literature entry). It is under Processed in Inbox.md, dated ${day} (it was in the inbox 2 times: all are closed). The inbox is empty.`)
    expect(w.fs.read(FILE)).toBe(`## Processed\n\n- ${day} [Mixup at scale](https://arxiv.org/abs/2406.01234) → R02 (literature entry)\n- ${day} https://arxiv.org/abs/2406.01234 → R02 (literature entry)\n\n${keptLines}`)
  })

  test('a discarded item is kept whole and only the user brings it back: a link met again is said to be discarded, restore and /rft-inbox return it as it was', async ($, on) => {
    const lines = `${ITEM} · read 2026-11-21\n  - briefed 2026-11-20: claims x\n  - touches R01\n`
    const w = await session($, on, `${lines}${OTHER}\n- 2406.01234 — typed again\n`)
    const link = 'https://arxiv.org/abs/2406.01234'
    const done = await tool($, { link, outcome: 'discard', reason: 'not for us', confirmed: true })
    const day = /dated (\d{4}-\d{2}-\d{2})/.exec(done)![1]!
    // a link typed twice is two items: both are discarded, each with its own lines, and `confirmed`, which this tool had, changes nothing
    expect(done).toBe(`Discarded: Mixup at scale (${link}) — not for us. It is kept whole under Discarded in Inbox.md, dated ${day} (it was in the inbox 2 times: all are discarded): only the user brings it back. Inbox: 1 item.`)
    const kept = `${OTHER}\n\n## Discarded\n\n${lines}  - discarded ${day}: not for us\n- 2406.01234 — typed again\n  - discarded ${day}: not for us\n`
    expect(w.fs.read(FILE)).toBe(kept)
    // what waits is what the list and rft_next count
    expect(await tool($)).toMatch(/^Inbox: 1 item, saved to read later/)
    // met again (a later search), in any form: said to be discarded, and nothing is added
    const again = `Discarded on ${day} (not for us): https://arxiv.org/abs/2406.01234. Nothing added. It is kept whole under Discarded in Inbox.md, and only the user brings it back: when they ask for it, rft_inbox {link, restore: true}.`
    expect(await tool($, { link: 'arXiv:2406.01234v3', why: 'from the literature search on mixup, not read' })).toBe(again)
    // nothing of it is Claude's to read or write while it is there
    for (const input of [{ reading: true }, { brief: 'claims y' }, { impression: 'x' }, { outcome: 'reference', note: 'R01' }]) {
      expect(await tool($, { link, ...input })).toBe(`Not in the inbox any more: https://arxiv.org/abs/2406.01234 was discarded on ${day} (not for us). It is kept, with its reading note, which stays closed; only the user brings it back (rft_inbox {link, restore: true} when they ask).`)
    }
    expect(w.fs.read(FILE)).toBe(kept)
    // the user asked: the latest of the link comes back, as it was, at the end of the list
    expect(await tool($, { link, restore: true })).toBe(`Brought back into the inbox: https://arxiv.org/abs/2406.01234, as it was when it was discarded on ${day}. Inbox: 2 items.`)
    expect(w.fs.read(FILE)).toBe(`${OTHER}\n- 2406.01234 — typed again\n\n## Discarded\n\n${lines}  - discarded ${day}: not for us\n`)
    expect(await tool($, { link, restore: true })).toBe('Already in the inbox: https://arxiv.org/abs/2406.01234. Nothing to bring back.')
    expect(await tool($, { link: 'https://example.org/none', restore: true })).toBe('Not brought back: no discarded item has this link (https://example.org/none). rft_inbox with the link alone saves it as a new item.')
    // the user's own /rft-inbox <link> is their act too. The twin gone from the file (deleted by hand), the kept one returns with what it had:
    // its line as it was, whatever priority and why the command gives
    w.fs.write(FILE, w.fs.read(FILE).replace('- 2406.01234 — typed again\n', ''))
    expect(await command($, '2406.01234 urgent and a why')).toBe(`Brought back into the inbox: Mixup at scale (https://arxiv.org/abs/2406.01234), as it was when it was discarded on ${day}, with its brief, its read mark (2026-11-21). Inbox: 2 items, 1 urgent, 1 briefed.`)
    expect(w.fs.read(FILE)).toBe(`${OTHER}\n${lines}\n## Discarded\n`)
    expect(await command($, 'arxiv:2406.01234')).toMatch(/^Already in the inbox \(added /)
  })

  test('a direction closes an item with the reference it cites; a note that does not name the link is said', async ($, on) => {
    const w = await session($, on, `${ITEM}\n${OTHER}\n`)
    // R01 is a reference of another paper: closed, and the answer says its Source does not name the link
    expect(await tool($, { link: 'https://example.org/blog/post', outcome: 'reference', note: 'R01' }))
      .toMatch(/^Closed: https:\/\/example\.org\/blog\/post → R01\. .* Inbox: 1 item, 1 urgent\. R01's Source does not name this link \(https:\/\/example\.org\/blog\/post\): add it there, so that the link is known as R01's when it is saved again\.$/)
    expect(await add($, { type: 'direction', title: 'Mixup at scale for us', parent: 'D01', idea: 'Try it.', summary: 'Try mixup at scale.', refs: ['R01'] })).toContain('D02')
    const closed = await tool($, { link: '2406.01234', outcome: 'direction', note: 'D02', cites: 'R01' })
    expect(closed).toMatch(/^Closed: Mixup at scale \(https:\/\/arxiv\.org\/abs\/2406\.01234\) → D02, citing R01\. It is under Processed in Inbox\.md, dated \d{4}-\d{2}-\d{2}\. The inbox is empty\.$/)
    expect(w.fs.read(FILE)).toMatch(/^## Processed\n\n- \S+ https:\/\/example\.org\/blog\/post → R01\n- \S+ \[Mixup at scale\]\(https:\/\/arxiv\.org\/abs\/2406\.01234\) → D02, citing R01\n$/)
    const dir = [...w.fs.files.keys()].find(p => p.includes('directions/D02 '))!
    expect(w.fs.read(dir)).not.toMatch(/priority|urgent/)
  })

  test('Process and Discuss in the tree view become turns of the chat, at the next tick; an item that is gone, or not marked as read, is said', async ($, on) => {
    const clock = mock.clock(on)
    on('prompt.compose', () => ({ sections: [] }))
    const files = demoFiles()
    // one item the user marked as read
    const marked = INBOX_MD.replace('- 2311.09876\n', '- 2311.09876 · read 2026-11-24\n')
    expect(marked).not.toBe(INBOX_MD)
    files[FILE] = marked
    const w = world(on, files)
    const prompts: string[] = []
    on('prompt.submit', (_$, e) => { prompts.push(String(e.text)); return { text: e.text } as never })
    const lines: string[] = []
    let wake = () => undefined as void
    on('process.spawn', async function* (_$: unknown, _e: unknown, next: { signal: AbortSignal }) {
      yield { stream: 'stdout' as const, text: 'RFT_SERVER_URL http://127.0.0.1:5555/?token=k\n' }
      const aborted = new Promise<boolean>(resolve => next.signal.addEventListener('abort', () => resolve(true)))
      for (;;) {
        while (lines.length) yield { stream: 'stdout' as const, text: lines.shift()! }
        if (await Promise.race([aborted, new Promise<boolean>(resolve => { wake = () => resolve(false) })])) break
      }
      return { value: { code: null, signal: 'SIGTERM' } }
    } as never)
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    await $.command.run({ command: 'rft', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
    // the second of the two items with one link, then one that is no longer there
    lines.push(`RFT_PROCESS ${JSON.stringify({ key: 'arxiv:2406.01234', nth: 1 })}\n`, `RFT_PROCESS ${JSON.stringify({ key: 'https://example.org/gone', nth: 0 })}\n`)
    // the read mark, or Discuss, on the item marked as read; Discuss on one that is not; Process on the read one, which is discussed
    lines.push(`RFT_DISCUSS ${JSON.stringify({ key: 'arxiv:2311.09876', nth: 0 })}\n`, `RFT_DISCUSS ${JSON.stringify({ key: 'arxiv:2501.00001', nth: 0 })}\n`, `RFT_PROCESS ${JSON.stringify({ key: 'arxiv:2311.09876', nth: 0 })}\n`)
    wake()
    for (let i = 0; i < 200 && w.toasts.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(w.toasts.join()).toContain('the tree view could not process the inbox item (that item is no longer in the inbox)')
    expect(w.toasts.join()).toContain('the tree view could not discuss the inbox item (that item is not marked as read)')
    await clock.advance(5000)
    expect(prompts).toHaveLength(3)
    for (const p of prompts.slice(1)) {
      expect(p.split('\n')[0]).toMatch(/^Discuss this inbox item with me \(read the manual's "Discussing an item" \(.*skills\/rft-manual\/inbox\.md\) first\): https:\/\/arxiv\.org\/abs\/2311\.09876\. I have read it and marked it as read \(2026-11-24\)\.$/)
      expect(p).toContain('First call rft_inbox {link: "https://arxiv.org/abs/2311.09876", reading: true}')
    }
    expect(prompts[0]!.split('\n')[0]).toMatch(/^Process this inbox item \(read the manual's "Processing an item" \(.*skills\/rft-manual\/inbox\.md\) first\): https:\/\/arxiv\.org\/abs\/2406\.01234 \(saved because: same one from Gianni\?\)\.$/)
    expect(prompts[0]).toContain('save your impression with rft_inbox {link: "https://arxiv.org/abs/2406.01234", impression}')
    expect(prompts[0]).toContain('save its brief with rft_inbox {link: "https://arxiv.org/abs/2406.01234", brief}')
    // nothing was written by asking
    expect(w.fs.read(FILE)).toBe(marked)
  })

  test('/rft-inbox prints the inbox, and with a link saves it with the reading priority the user gave', async ($, on) => {
    const w = await session($, on)
    expect(await command($)).toContain('The inbox is empty')
    expect(w.fs.exists(FILE)).toBe(false)
    expect(await command($, '2511.00042 high for D01, from the talk')).toBe('Saved to the inbox: https://arxiv.org/abs/2511.00042 (reading priority high; why: for D01, from the talk). Inbox: 1 item.')
    expect(w.fs.read(FILE)).toMatch(/^# Inbox\n\n- https:\/\/arxiv\.org\/abs\/2511\.00042 — for D01, from the talk · high · added \d{4}-\d{2}-\d{2}\n$/)
    expect(await command($, 'https://example.org/post highly relevant')).toBe('Saved to the inbox: https://example.org/post (why: highly relevant). Inbox: 2 items.')
    expect(await command($, 'https://example.org/post/#top urgent')).toMatch(/^Already in the inbox \(added \d{4}-\d{2}-\d{2}\): https:\/\/example\.org\/post\. Nothing added\.$/)
    expect(await command($, 'a paper on mixup')).toBe('"a paper on mixup" does not start with a link. /rft-inbox <link> [urgent|high|medium|low] [why]: the link is a URL, an arXiv id or a DOI.')
    expect(await command($, 'https://example.org/other low · urgent')).toContain('Not added: the why would read as a reading priority or a date')
    const printed = (await command($)).split('\n')
    expect(printed[0]).toBe('Inbox: 2 items, saved to read later and not decided about (Inbox.md in the vault).')
    expect(printed[1]).toMatch(/^1\. high · https:\/\/arxiv\.org\/abs\/2511\.00042 · for D01, from the talk · added /)
    expect(printed[2]).toMatch(/^2\. https:\/\/example\.org\/post · highly relevant · added /)
    expect(printed.length).toBe(3)
  })

  test('rft_next has one line on the inbox when something waits, none when it is empty or one concept is asked for; the rules say nothing of it', async ($, on) => {
    const w = await session($, on, INBOX_MD)
    const line = inboxLine(readInbox(INBOX_MD))
    const report = await next($)
    expect(report.endsWith(`\n\n${line}`)).toBe(true)
    expect(report.split('\n').filter(l => /inbox/i.test(l))).toEqual([line])
    expect(await next($, { concept: 'C00' })).not.toMatch(/inbox/i)
    // the rules name the manual's part on the inbox and say nothing else of it
    expect((await rulesOf($)).split('\n').filter(l => /inbox/i.test(l) && !l.startsWith('- The manual is in parts'))).toEqual([])
    w.fs.write(FILE, '# Inbox\n\n## Processed\n\n- 2026-11-10 https://example.org/a — discarded\n')
    expect(await next($)).not.toMatch(/inbox/i)
    w.fs.remove(FILE)
    expect(await next($)).not.toMatch(/inbox/i)
  })
})
