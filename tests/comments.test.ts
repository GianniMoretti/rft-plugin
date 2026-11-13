// Comments, suggestions and locked notes (hooks/lib/comments.ts): threads found again after edits
// as the server finds them, Claude's rft_comments / rft_comment / rft_suggest, the prompt the tree
// view's Ask Claude becomes, and a locked note's text kept from Claude's edits, in a session too.

import { describe, expect, mock, test } from 'claude-code/testing'

import type { Comments, Thread } from '../hooks/lib/comments'
import { anchorFor, askText, comment, commentsPath, commentsReport, locate, readComments, suggest } from '../hooks/lib/comments'
import { loadActive, setCode, setStatus, setType } from '../hooks/lib/ops'
import { CWD, E01, E02, MemoryFs, demoFiles, world } from './fixture'

const E02_PATH = `vault/experiments/${E02}.md`
const NOW = '2026-11-07 10:02'

/** A thread as the tree view's server writes it, by the user. */
const thread = (over: Partial<Thread>): Thread => ({
  id: 'c1', kind: 'comment', state: 'open', quote: 'Text of E02.', prefix: '## Result\n', suffix: '\n\n## Children', replacement: null,
  asked: null, messages: [{ by: 'you', at: NOW, text: 'Is this right?' }], closed: null, ...over,
})

/** The demo project, E02 locked or not, with E02's threads on disk. */
async function project(opts: { locked?: boolean; threads?: Thread[] } = {}) {
  const files = demoFiles()
  if (opts.locked) files[E02_PATH] = files[E02_PATH]!.replace('\n---\n', '\nlocked: true\n---\n')
  if (opts.threads) files['vault/.comments/E02.json'] = JSON.stringify({ note: 'E02', next: opts.threads.length + 1, threads: opts.threads })
  const fs = new MemoryFs(files)
  const io = fs.io()
  return { fs, io, loaded: await loadActive(io) }
}

const saved = (fs: MemoryFs, id = 'E02') => JSON.parse(fs.read(`vault/.comments/${id}.json`)) as Comments

describe('anchors', () => {
  test('a quote is found by its context, as the server finds it (tests/test_server.py has the same cases)', () => {
    const body = 'A cat. The dog runs. A cat sleeps. The end.'
    expect(locate(body, 'A cat', 'dog runs. ', ' sleeps')).toEqual({ start: 21, end: 26, exact: true })
    expect(locate(body, 'A cat', '', '. The dog')).toEqual({ start: 0, end: 5, exact: true })
    const edited = 'A cat. The dog walks. A cat sleeps. The end.'
    expect(locate(edited, 'runs', 'A cat. The dog ', '. A cat sleeps')).toEqual({ start: 15, end: 20, exact: false })
    expect(locate('Something else entirely.', 'runs', 'The dog ', '. A cat')).toBeNull()
    expect(locate('', 'x', '', '')).toBeNull()
    const both = '## What\nMixup alpha 0.2 or 1.0, CutMix (alpha 1.0); 200 epochs[^2].'
    expect(locate(both, 'Mixup alpha 0.2 and 1.0', '## What\n', ', CutMix; 200 epochs; 5 seeds[')).toEqual({ start: 8, end: 31, exact: false })
    expect(locate('A brand new opening of the line, then the end.', 'old opening of the line', 'gone before ', ', then the end.')).toEqual({ start: 8, end: 31, exact: false })
    expect(locate('Nothing alike here at all.', 'Mixup alpha', '## What\n', ', CutMix')).toBeNull()
  })

  test('Claude\'s answer takes the open threads\' context anew from the note', async () => {
    const { fs, io, loaded } = await project({ threads: [thread({ prefix: 'stale context ', suffix: ' stale' }), thread({ id: 'c2', state: 'resolved', prefix: 'old' })] })
    await comment(io, loaded, { id: 'E02', thread: 'c1', text: 'ok' }, NOW)
    const [open, closed] = saved(fs).threads
    expect(open!.prefix).toBe('nning · **Date:** 2026-01-01\n\n## Result\n')
    expect(open!.suffix).toBe('\n\n## Children in the tree\n\n')
    expect(closed!.prefix).toBe('old')
  })

  test('a new thread needs a quote that occurs once', () => {
    expect(anchorFor('one two one', 'two')).toEqual({ quote: 'two', prefix: 'one ', suffix: ' one' })
    expect(() => anchorFor('one two one', 'one')).toThrow('occurs 2 times')
    expect(() => anchorFor('one two one', 'three')).toThrow('not in the note')
    expect(() => anchorFor('one', '  ')).toThrow('quote is empty')
  })
})

describe('Claude in the discussion', () => {
  test('a reply goes into the thread and clears the question; the note is not touched', async () => {
    const { fs, io, loaded } = await project({ threads: [thread({ asked: NOW })] })
    const before = fs.read(E02_PATH)
    expect(await comment(io, loaded, { id: 'E02', thread: 'c1', text: ' Yes: 5 seeds. ' }, NOW)).toContain('E02 c1: replied')
    const [t] = saved(fs).threads
    expect(t!.messages.at(-1)).toEqual({ by: 'claude', at: NOW, text: 'Yes: 5 seeds.' })
    expect(t!.asked).toBeNull()
    expect(t!.state).toBe('open')
    expect(fs.read(E02_PATH)).toBe(before)
    await expect(comment(io, loaded, { id: 'E02', thread: 'c1', text: '' })).rejects.toThrow('write the reply')
    await expect(comment(io, loaded, { id: 'E02', thread: 'c9', text: 'x' })).rejects.toThrow('has no thread c9 (it has c1)')
  })

  test('a comment of Claude\'s own starts a thread on its quote', async () => {
    const { fs, io, loaded } = await project()
    expect(await comment(io, loaded, { id: 'E02', quote: 'Text of E02.', text: 'Which seeds?' }, NOW)).toContain('E02 c1: comment added')
    expect(saved(fs)).toEqual({
      note: 'E02', next: 2,
      threads: [{ ...thread({ prefix: 'nning · **Date:** 2026-01-01\n\n## Result\n', suffix: '\n\n## Children in the tree\n\n', messages: [{ by: 'claude', at: NOW, text: 'Which seeds?' }] }) }],
    })
    await expect(comment(io, loaded, { id: 'E02', quote: 'E02', text: 'x' })).rejects.toThrow('occurs')
  })

  test('a suggestion Claude applied in an unlocked note closes as applied; a locked note refuses it', async () => {
    const sugg = thread({ kind: 'suggestion', messages: [{ by: 'you', at: NOW, text: 'Add the numbers.' }] })
    const open = await project({ threads: [sugg] })
    expect(await comment(open.io, open.loaded, { id: 'E02', thread: 'c1', applied: true, text: 'Added 0.3 ± 0.5.' }, NOW)).toContain('marked applied')
    expect(saved(open.fs).threads[0]).toMatchObject({ state: 'applied', closed: { by: 'claude', at: NOW } })
    await expect(comment(open.io, open.loaded, { id: 'E02', thread: 'c1', text: 'again' })).rejects.toThrow('c1 is applied')
    const locked = await project({ locked: true, threads: [sugg] })
    await expect(comment(locked.io, locked.loaded, { id: 'E02', thread: 'c1', applied: true })).rejects.toThrow('is locked')
    const onComment = await project({ threads: [thread({})] })
    await expect(comment(onComment.io, onComment.loaded, { id: 'E02', thread: 'c1', applied: true })).rejects.toThrow('is a comment')
  })

  test('an instruction gets its replacement from Claude, for the user to accept', async () => {
    const { fs, io, loaded } = await project({ locked: true, threads: [thread({ kind: 'suggestion', asked: NOW })] })
    const before = fs.read(E02_PATH)
    expect(await suggest(io, loaded, { id: 'E02', thread: 'c1', replacement: 'CutMix closes the gap.', text: 'From E05.' }, NOW)).toContain('replacement written')
    const [t] = saved(fs).threads
    expect(t).toMatchObject({ replacement: 'CutMix closes the gap.', asked: null, state: 'open' })
    expect(t!.messages.at(-1)).toEqual({ by: 'claude', at: NOW, text: 'From E05.' })
    expect(fs.read(E02_PATH)).toBe(before)
    await expect(suggest(io, loaded, { id: 'E02', thread: 'c1', replacement: 'Text of E02.' })).rejects.toThrow('the quoted text itself')
  })

  test('a suggestion on text that changed since is not answered with a replacement', async () => {
    const { io, loaded } = await project({ threads: [thread({ kind: 'suggestion', quote: 'Text of E02 as it was.' })] })
    await expect(suggest(io, loaded, { id: 'E02', thread: 'c1', replacement: 'x' })).rejects.toThrow('changed since')
    const onComment = await project({ threads: [thread({})] })
    await expect(suggest(onComment.io, onComment.loaded, { id: 'E02', thread: 'c1', replacement: 'x' })).rejects.toThrow('is a comment')
  })

  test('a new suggestion of Claude\'s replaces its quote, once accepted', async () => {
    const { fs, io, loaded } = await project({ threads: [thread({ state: 'resolved' })] })
    expect(await suggest(io, loaded, { id: 'E02', quote: 'Text of E02.', replacement: 'Better.' }, NOW)).toContain('E02 c2: suggestion added')
    expect(saved(fs).threads[1]).toMatchObject({ id: 'c2', kind: 'suggestion', quote: 'Text of E02.', replacement: 'Better.', messages: [] })
    await expect(suggest(io, loaded, { id: 'E02', quote: 'Text of E02.' })).rejects.toThrow('replacement is missing')
  })

  test('rft_comments shows a note\'s open threads in full, its history in short, or the notes with open threads', async () => {
    const { io, loaded } = await project({
      threads: [
        thread({ asked: NOW }),
        thread({ id: 'c2', kind: 'suggestion', quote: 'gone text', prefix: 'nowhere ', suffix: ' nothing', replacement: 'new', state: 'open' }),
        thread({ id: 'c4', kind: 'suggestion', quote: 'Text of E02 as it was.', replacement: 'new' }),
        thread({ id: 'c3', state: 'resolved', messages: [{ by: 'you', at: NOW, text: 'one' }, { by: 'claude', at: NOW, text: 'two' }] }),
      ],
    })
    const one = await commentsReport(io, loaded, 'E02')
    expect(one).toContain(`${E02}: 3 open, 1 closed.`)
    expect(one).toContain('c1 · comment · open · Claude asked at 2026-11-07 10:02\n> Text of E02.\nThe quoted text is in the note as quoted.\n- user · 2026-11-07 10:02: Is this right?')
    expect(one).toContain('c2 · suggestion · open\n> gone text\nReplacement:\n> new\nThe quoted text is no longer in the note.')
    // edited since: the text between its context
    expect(one).toContain('> Text of E02 as it was.\nReplacement:\n> new\nThe quoted text changed since; that part of the note now reads:\n> Text of E02.')
    expect(one).toContain('History:\nc3 · comment · resolved\n> Text of E02.\n  (1 earlier message(s))\n- claude · 2026-11-07 10:02: two')
    expect(await commentsReport(io, loaded)).toBe(`Notes with open threads (rft_comments with an id shows them):\n- ${E02}: c1 comment (asked), c2 suggestion, c4 suggestion`)
    expect(await commentsReport(io, loaded, 'E01')).toBe(`${E01}: no comments or suggestions.`)
  })
})

describe('Ask Claude', () => {
  const ask = async (opts: { locked?: boolean; t: Thread }) => {
    const { io, loaded } = await project({ locked: opts.locked, threads: [opts.t] })
    return askText(loaded, await readComments(io, 'vault', 'E02'), 'E02', 'c1', `vault/${loaded.tree.nodes.E02!.path}`)
  }

  test('a comment is answered in its thread, and the note is left as it is', async () => {
    const text = await ask({ t: thread({}) })
    expect(text).toContain(`answer thread c1 on ${E02} (vault/experiments/${E02}.md)`)
    expect(text).toContain('c1 · comment · open\n> Text of E02.\nThe quoted text is in the note as quoted.\n- user · 2026-11-07 10:02: Is this right?')
    expect(text).toContain('reply with rft_comment {id: "E02", thread: "c1", text}. Do not edit the note.')
  })

  test('a suggestion on a locked note is answered with a replacement for the user to accept', async () => {
    const text = await ask({ locked: true, t: thread({ kind: 'suggestion', messages: [{ by: 'you', at: NOW, text: 'Add the numbers.' }] }) })
    expect(text).toContain('c1 · suggestion, an instruction (no replacement text yet) · open')
    expect(text).toContain('E02 is locked: do not edit it. Write the new text for the quoted part with rft_suggest {id: "E02", thread: "c1", replacement, text: why}')
  })

  test('a suggestion on an unlocked note is made in the note, then closed as applied', async () => {
    const text = await ask({ t: thread({ kind: 'suggestion', replacement: 'Better.' }) })
    expect(text).toContain('Replacement:\n> Better.')
    expect(text).toContain('Make the change in the note yourself: edit the quoted part as the replacement has it')
    expect(text).toContain('rft_comment {id: "E02", thread: "c1", applied: true, text: what you changed}')
  })
})

describe('locked notes and the other tools', () => {
  test('a locked note takes a status without a note, and no Code section', async () => {
    const { fs, io, loaded } = await project({ locked: true })
    await expect(setStatus(io, loaded, 'E02', 'done', 'All seeds ran.')).rejects.toThrow(`${E02} is locked`)
    expect(await setStatus(io, loaded, 'E02', 'done')).toContain('running → done')
    expect(fs.read(E02_PATH)).toContain('locked: true')
    const env = { root: CWD, git: async () => ({ ok: false, out: '', err: '' }), date: '2026-11-07' }
    await expect(setCode(io, loaded, env, 'E02', 'text')).rejects.toThrow('propose the Code section')
  })

  test('a note\'s comments follow it to its new id, and its lock stays', async () => {
    const { fs, io, loaded } = await project({ locked: true, threads: [thread({})] })
    await setType(io, loaded, 'E02', 'direction')
    expect(fs.exists('vault/.comments/E02.json')).toBe(false)
    expect(saved(fs, 'D02')).toMatchObject({ note: 'D02', threads: [{ id: 'c1', quote: 'Text of E02.' }] })
    expect(fs.read('vault/directions/D02 Variant run.md')).toContain('locked: true')
    expect(commentsPath('vault', 'D02')).toBe('vault/.comments/D02.json')
  })
})

describe('in a session', () => {
  /** The demo project with E02 locked, and core's tools answered by the test: the calls that reach them. */
  async function session($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1]) {
    mock.clock(on)
    const files = demoFiles()
    files[E02_PATH] = files[E02_PATH]!.replace('\n---\n', '\nlocked: true\n---\n')
    const w = world(on, files)
    const ran: string[] = []
    on('tool.call', (_$, e) => { ran.push(String(e.tool)); return { result: 'ok', text: 'ok' } as never })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    return { w, ran }
  }

  test('Claude cannot edit a locked note, nor a comments file, and is told to suggest instead', async ($, on) => {
    const { w, ran } = await session($, on)
    const before = w.fs.read(E02_PATH)
    for (const call of [
      { tool: 'Edit', file_path: `${CWD}/${E02_PATH}`, old_string: 'Text of E02.', new_string: 'Changed.' },
      { tool: 'Write', file_path: `${CWD}/${E02_PATH}`, content: 'gone' },
      { tool: 'Bash', command: `sed -i 's/Text/Changed/' "vault/experiments/${E02}.md"` },
      { tool: 'Bash', command: 'perl -pi -e s/a/b/ vault/experiments/E02*' },
      { tool: 'Bash', command: 'echo x >> vault/experiments/E02\\ Variant\\ run.md' },
    ]) {
      const res = await $.tool.call(call as never)
      expect({ call, deny: (res as { deny?: string }).deny }).toEqual({ call, deny: expect.stringContaining(`${E02} is locked`) })
      expect((res as { deny?: string }).deny).toContain('rft_suggest {id: "E02"')
    }
    const json = await $.tool.call({ tool: 'Write', file_path: `${CWD}/vault/.comments/E02.json`, content: '{}' } as never)
    expect((json as { deny?: string }).deny).toContain('use rft_comment and rft_suggest')
    expect(ran).toEqual([])
    expect(w.fs.read(E02_PATH)).toBe(before)
  })

  test('the rest goes on as before: other notes, reading, and commands that only mention the note', async ($, on) => {
    const { ran } = await session($, on)
    for (const call of [
      { tool: 'Edit', file_path: `${CWD}/vault/experiments/${E01}.md`, old_string: 'Text of E01.', new_string: 'Changed.' },
      { tool: 'Read', file_path: `${CWD}/${E02_PATH}` },
      { tool: 'Bash', command: `cat "vault/experiments/${E02}.md"` },
      { tool: 'Bash', command: 'python train.py --run E02 > runs/E02.log' },
    ]) {
      const res = await $.tool.call(call as never)
      expect({ call, deny: (res as { deny?: string }).deny }).toEqual({ call, deny: undefined })
    }
    expect(ran).toEqual(['Edit', 'Read', 'Bash', 'Bash'])
  })

  test('Ask Claude in the tree view becomes a prompt with the thread, at the next tick', async ($, on) => {
    const clock = mock.clock(on)
    const files = demoFiles()
    files['vault/.comments/E02.json'] = JSON.stringify({ note: 'E02', next: 2, threads: [thread({ asked: NOW })] })
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
    lines.push(`RFT_ASK ${JSON.stringify({ id: 'E02', thread: 'c1' })}\n`, `RFT_ASK ${JSON.stringify({ id: 'E99', thread: 'c1' })}\n`)
    wake()
    for (let i = 0; i < 200 && !w.toasts.length; i++) await new Promise(resolve => setTimeout(resolve, 5))
    expect(w.toasts.join()).toContain('the tree view could not ask Claude')
    expect(w.toasts.join()).toContain('E99')
    await clock.advance(5000)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain(`answer thread c1 on ${E02} (vault/experiments/${E02}.md)`)
    expect(prompts[0]).toContain('- user · 2026-11-07 10:02: Is this right?')
  })
})
