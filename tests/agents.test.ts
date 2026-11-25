// What an agent's answer becomes (tests/fixtures/agents, read here through their copy,
// tests/fixtures/agents.ts, which tests/test_agents.py keeps equal to them): the cases the page's
// server is held to as well, when it writes the answer of an agent it launched itself.

import { describe, expect, test } from 'claude-code/testing'

import type { Thread } from '../hooks/lib/comments'
import { CommentError, answerThread } from '../hooks/lib/comments'
import { loadActive } from '../hooks/lib/ops'
import { IMPRESSION_CHARS, impressionLines } from '../hooks/lib/reading'
import { E02, MemoryFs, demoFiles } from './fixture'
import { CASES } from './fixtures/agents'

type ThreadCase = { name: string; thread: Thread; answer: string; want: Thread | null }
type ProcessCase = { name: string; answer: string; want: { error: string } | { impression: string[]; brief: string[] } }

const E02_PATH = `vault/experiments/${E02}.md`
const SAVED = 'vault/.comments/E02.json'

describe('an agent\'s answer to a thread', () => {
  test('the fixture\'s note is the demo\'s E02', () => {
    expect(CASES.note.text).toBe(demoFiles()[E02_PATH])
    expect(CASES.note.file).toBe(E02_PATH)
  })

  test('case by case: a reply, a new text to accept, or nothing', async () => {
    for (const c of CASES.threads as ThreadCase[]) {
      const files = demoFiles()
      const before = JSON.stringify({ note: 'E02', next: 2, threads: [c.thread] })
      files[SAVED] = before
      const fs = new MemoryFs(files)
      const io = fs.io()
      const answered = answerThread(io, await loadActive(io), 'E02', c.thread.id, c.answer, CASES.now)
      if (c.want === null) {
        await expect(answered, c.name).rejects.toBeInstanceOf(CommentError)
        expect(fs.read(SAVED), c.name).toBe(before)
      } else {
        await answered
        expect(JSON.parse(fs.read(SAVED)).threads, c.name).toEqual([c.want])
      }
      // the note is the user's to change, by accepting
      expect(fs.read(E02_PATH), c.name).toBe(CASES.note.text)
    }
    expect((CASES.threads as ThreadCase[]).length).toBeGreaterThan(10)
  })
})

describe('an agent\'s answer to Process', () => {
  test('what the server saves as an impression is one the plugin would write the same', () => {
    for (const c of CASES.process as ProcessCase[]) {
      if ('error' in c.want) continue
      expect(impressionLines(c.want.impression.join('\n')), c.name).toEqual(c.want.impression)
      expect(c.want.impression.join('\n').length, c.name).toBeLessThanOrEqual(IMPRESSION_CHARS)
      expect(c.want.brief.length, c.name).toBe(3)
    }
  })
})
