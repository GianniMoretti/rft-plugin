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

import { INBOX, InboxError, addTo, byPriority, commandInput, findIn, inboxLine, inboxReport, inboxText, linksIn, readInbox, shown, sourceOf, strip } from '../hooks/lib/inbox'
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
      if (got) expect('item' in got ? got.item : got.processed).toMatchObject(fields ?? {})
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
    expect(item).toEqual({ key: 'arxiv:2511.00042', url: 'https://arxiv.org/abs/2511.00042', title: '', why: 'from the talk', priority: 'high', added: '2026-11-23', duplicate: false, brief: null })
    const at = before.indexOf('- see also the list in Scratchpad') + 1
    expect(inboxText(box).split('\n')).toEqual([...before.slice(0, at), '- https://arxiv.org/abs/2511.00042 — from the talk · high · added 2026-11-23', ...before.slice(at)])
    expect(shown(box)).toEqual([...EXPECTED.items, item])
    expect(box.processed).toEqual(EXPECTED.processed)
  })

  test('the most pressing first, the newest first among equals (of one day, the one added later), those with no day last', () => {
    const item = (key: string, priority: string, added: string) => ({ key, url: key, title: '', why: '', priority, added, duplicate: false, brief: null })
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
    expect(Object.keys((w.specs.rft_inbox!.inputSchema as { properties: object }).properties)).toEqual(['link', 'why', 'title'])
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
