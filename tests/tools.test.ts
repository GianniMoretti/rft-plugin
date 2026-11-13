// The tool list: only the core tools sit in the prompt from the start; a feature's tools join
// them when the vault uses that feature, and every other tool waits behind ToolSearch.

import { describe, expect, mock, test } from 'claude-code/testing'

import { CORE_TOOLS, FEATURE_TOOLS } from '../hooks/lib/tools'
import { CWD, E02, demoFiles, world } from './fixture'

const inPrompt = (w: { tools: string[]; deferred: string[] }) => w.tools.filter(t => !w.deferred.includes(t)).sort()

/** The demo vault with E02's frontmatter given one more line. */
const withE02 = (line: string) => {
  const files = demoFiles()
  const path = `vault/experiments/${E02}.md`
  files[path] = files[path]!.replace('---\n\n#', `${line}\n---\n\n#`)
  return files
}

describe('tool list', () => {
  test('a vault that uses none of the features: the core tools in the prompt, the rest deferred', async ($, on) => {
    mock.clock(on)
    const w = world(on, demoFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(w.tools).toHaveLength(30)
    expect(inPrompt(w)).toEqual([...CORE_TOOLS].sort())
    for (const t of Object.values(FEATURE_TOOLS).flat()) expect(w.deferred).toContain(t)
  })

  test('a deadline or a dated note brings the date tools into the prompt', async ($, on) => {
    mock.clock(on)
    const files = demoFiles()
    files['vault/milestones/M01 Workshop paper.md'] = '---\nid: M01\ntype: milestone\nstatus: open\ndue: 2026-12-01\n---\n\n# M01 · Workshop paper\n'
    const w = world(on, files)
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(inPrompt(w)).toEqual([...CORE_TOOLS, ...FEATURE_TOOLS.dates].sort())
  })

  test('a note with start: does too; a priority brings the priority tool', async ($, on) => {
    mock.clock(on)
    const w = world(on, withE02('start: 2026-12-01\npriority: high'))
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(inPrompt(w)).toEqual([...CORE_TOOLS, ...FEATURE_TOOLS.dates, ...FEATURE_TOOLS.priorities].sort())
  })

  test('a locked note or a comment thread brings the comment tools', async ($, on) => {
    mock.clock(on)
    const w = world(on, withE02('locked: true'))
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(inPrompt(w)).toEqual([...CORE_TOOLS, ...FEATURE_TOOLS.comments].sort())
  })

  test('a comments file alone is enough', async ($, on) => {
    mock.clock(on)
    const files = demoFiles()
    files['vault/.comments/E02.json'] = JSON.stringify({ note: 'E02', next: 2, threads: [] })
    const w = world(on, files)
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(inPrompt(w)).toEqual([...CORE_TOOLS, ...FEATURE_TOOLS.comments].sort())
  })

  test('a deferred tool still answers when called', async ($, on) => {
    mock.clock(on)
    const w = world(on, demoFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(w.deferred).toContain('rft_tags')
    const r = await $.tool.call({ tool: 'mcp__rft__rft_tags' } as never)
    expect(r.text ?? '').not.toContain('no hook')
  })
})
