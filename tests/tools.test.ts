// The tool list: only the core tools sit in the prompt from the start; a feature's tools join
// them when the vault uses that feature, and every other tool waits behind ToolSearch. Dates and
// priorities bring their rule alone: their tools are called too seldom to be carried all session.

import { describe, expect, mock, test } from 'claude-code/testing'

import { CORE_TOOLS, FEATURE_TOOLS, REPORT_TOOLS } from '../hooks/lib/tools'
import type { World } from './fixture'
import { CWD, D01, E02, demoFiles, paneProps, world } from './fixture'

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
    // no machine paired with the experiment queue: its tools are not there at all, rft_machine waits to pair one
    expect(w.tools).toHaveLength(41)
    expect(inPrompt(w)).toEqual([...CORE_TOOLS].sort())
    // rft_sync is there (a session in two syncs by hand); rft_validate is not, since rft_sync and rft_add_node answer with the check
    expect(inPrompt(w)).toEqual(['rft_add_node', 'rft_graph', 'rft_map', 'rft_move_node', 'rft_next', 'rft_search', 'rft_set_status', 'rft_set_summary', 'rft_sync'])
    expect(w.deferred).toContain('rft_validate')
    for (const t of Object.values(FEATURE_TOOLS).flat()) {
      if (FEATURE_TOOLS.queue.includes(t as never)) expect(w.tools).not.toContain(t)
      else expect(w.deferred).toContain(t)
    }
    expect(w.deferred).toContain('rft_machine')
  })

  const DATE_TOOLS = ['rft_suggest_dates', 'rft_add_deadline', 'rft_add_meeting', 'rft_suggest_deadline']

  test('a deadline leaves the date tools behind ToolSearch: its rule names them', async ($, on) => {
    mock.clock(on)
    const files = demoFiles()
    files['vault/milestones/M01 Workshop paper.md'] = '---\nid: M01\ntype: milestone\nstatus: open\ndue: 2026-12-01\n---\n\n# M01 · Workshop paper\n'
    const w = world(on, files)
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(inPrompt(w)).toEqual([...CORE_TOOLS].sort())
    for (const t of DATE_TOOLS) expect(w.deferred).toContain(t)
  })

  test('a note with start: and a priority: the date and priority tools stay deferred, and still answer', async ($, on) => {
    mock.clock(on)
    const w = world(on, withE02('start: 2026-12-01\npriority: high'))
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(inPrompt(w)).toEqual([...CORE_TOOLS].sort())
    for (const t of [...DATE_TOOLS, 'rft_suggest_priority']) expect(w.deferred).toContain(t)
    const r = await $.tool.call({ tool: 'mcp__rft__rft_suggest_priority', id: 'D01', priority: 'medium', why: 'It unblocks E02.' } as never)
    expect(r.isError).toBeUndefined()
    expect(w.fs.read(`vault/directions/D01 A better variant.md`)).toContain('suggested_priority: medium')
  })

  test('a locked note brings rft_suggest only', async ($, on) => {
    mock.clock(on)
    const w = world(on, withE02('locked: true'))
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(inPrompt(w)).toEqual([...CORE_TOOLS, ...FEATURE_TOOLS.locks].sort())
  })

  test('a comments file brings the comment tools', async ($, on) => {
    mock.clock(on)
    const files = demoFiles()
    files['vault/.comments/E02.json'] = JSON.stringify({ note: 'E02', next: 2, threads: [] })
    const w = world(on, files)
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(inPrompt(w)).toEqual([...CORE_TOOLS, ...FEATURE_TOOLS.comments].sort())
  })

  test('an artifact brings the artifact tools', async ($, on) => {
    mock.clock(on)
    const files = demoFiles()
    files['vault/artifacts/00 demo.html'] = '<!-- rft-artifact {"concept":"root","name":"demo","updated":"2026-03-01","basis":{}} -->\n<h1>demo</h1>\n'
    const w = world(on, files)
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(FEATURE_TOOLS.artifacts).toEqual(['rft_artifact', 'rft_set_artifact'])
    expect(inPrompt(w)).toEqual([...CORE_TOOLS, ...FEATURE_TOOLS.artifacts].sort())
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

describe('rules on demand', () => {
  const rulesOf = async ($: never, on: never, files: Record<string, string>) => {
    mock.clock(on)
    world(on, files)
    ;(on as any)('prompt.compose', () => ({ sections: [] }))
    await (($ as any).session.start({ cwd: CWD, source: 'startup' }))
    const res = await ($ as any).prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    return res.sections.find((x: { id: string }) => x.id === 'rft:rules').text as string
  }

  test('a vault with none of the features: one short line instead of the four rules', async ($, on) => {
    const rules = await rulesOf($ as never, on as never, demoFiles())
    expect(rules).toContain("These are the user's to set, never yours: priorities (`priority:`), dates (`due:`, `start:`, `est:`, deadlines in `vault/milestones/`, meetings in `vault/meetings/`), the text of a note with `locked: true`, verifying a note (`status: verified`: rft_set_status verified only suggests it).")
    expect(rules).not.toContain('A verified note (')
    expect(rules).not.toContain('rft_suggest_priority')
    expect(rules).not.toContain('rft_suggest_dates')
    expect(rules).not.toContain('rft_comments lists them')
    expect(rules).not.toContain('asks the user whether to unlock it')
  })

  test('each feature in use brings its full rule, and leaves the short line to the others', async ($, on) => {
    const rules = await rulesOf($ as never, on as never, withE02('priority: high\nlocked: true'))
    expect(rules).toContain("suggest one: rft_suggest_priority, or rft_add_node's suggested_priority")
    expect(rules).toContain('asks the user whether to unlock it')
    expect(rules).not.toContain('rft_suggest_dates')
    expect(rules).toContain("These are the user's to set, never yours: dates (")
    expect(rules).not.toContain('never yours: priorities')
  })

  test('with every feature in use there is no short line', async ($, on) => {
    const files = withE02('priority: high\nlocked: true\nstart: 2026-12-01\nsuggested_verified: "reproduced"')
    files['vault/.comments/E02.json'] = JSON.stringify({ note: 'E02', next: 1, threads: [] })
    const rules = await rulesOf($ as never, on as never, files)
    expect(rules).toContain('rft_comments lists them')
    expect(rules).toContain('A start or an estimate you can give a reason for: rft_suggest_dates.')
    for (const t of ['rft_add_deadline', 'rft_add_meeting', 'rft_suggest_deadline']) expect(rules).toContain(t)
    expect(rules).toContain('A verified note (`status: verified`, ✔) is a claim the user checked')
    expect(rules).not.toContain('never yours')
  })

  test('with no tag in use the rule on tags gives two examples, and names no tool to list them', async ($, on) => {
    const none = await rulesOf($ as never, on as never, demoFiles())
    expect(none).toContain('1-3 short topical tags (lowercase kebab-case, e.g. `ablation`, `optimisation`); rft_set_tags changes them.')
    expect(none).not.toContain('rft_tags')
  })

  test('with tags in use the rule lists them, most used first, so no rft_tags is called to reuse one', async ($, on) => {
    const files = withE02('priority: high')
    for (const [path, extra] of [[`vault/experiments/${E02}.md`, 'seeds, lr-sweep, '], ['vault/experiments/E01 First check.md', 'seeds, ']] as const) {
      files[path] = files[path]!.replace('tags: [demo, experiment, ', `tags: [demo, experiment, ${extra}`)
    }
    const rules = await rulesOf($ as never, on as never, files)
    expect(rules).toContain('1-3 short topical tags (lowercase kebab-case), reusing the ones in use before inventing new ones: seeds, lr-sweep; rft_set_tags changes them.')
  })

  test('after edits by hand one call is asked for: rft_sync, which answers with the check', async ($, on) => {
    const rules = await rulesOf($ as never, on as never, demoFiles())
    expect(rules).toContain("After editing notes by hand, run rft_sync (children / up / down, 00 Index.md, the canvas): it answers with the tree's check.")
    expect(rules).not.toContain('rft_validate')
  })
})

// A tool call loads the vault to answer. A tool that wrote loads it again for the snapshot the
// pane and the guards read; one that only reports does not, unless a note changed meanwhile.
describe('report tools', () => {
  const PANE = { plugin: 'rft', component: 'Pane', requestId: 'rft-tree', props: paneProps() } as const
  const NOTE = `vault/experiments/${E02}.md`

  /** How often a file is read from here on. */
  const readsOf = (w: World, path: string) => {
    let n = 0
    const read = w.fs.read.bind(w.fs)
    w.fs.read = p => {
      if (w.fs.norm(p) === path) n++
      return read(p)
    }
    return () => n
  }

  const INPUT: Record<string, Record<string, unknown>> = {
    rft_search: { query: 'variant' }, rft_graph: { id: 'E02' }, rft_code: { id: 'E02' }, rft_comments: { id: 'E02' },
  }
  // these need what the demo vault has not (a concept with an artifact, a paired machine): they answer with why
  const NEEDS_MORE = ['rft_artifact', 'rft_jobs']

  test('each answers, and leaves every file of the vault as it was', async ($, on) => {
    mock.clock(on)
    const w = world(on, demoFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const state = () => JSON.stringify([...w.fs.files].sort(([a], [b]) => a.localeCompare(b)))
    for (const tool of REPORT_TOOLS) {
      const before = state()
      const r = await $.tool.call({ tool: `mcp__rft__${tool}`, ...(INPUT[tool] ?? {}) } as never)
      if (!NEEDS_MORE.includes(tool)) expect(`${tool}: ${r.isError === true ? r.text : 'answered'}`).toBe(`${tool}: answered`)
      expect(`${tool}: ${state() === before ? 'no file changed' : 'a file changed'}`).toBe(`${tool}: no file changed`)
    }
  })

  test('one reads each note once; after a tool that writes the notes are read again', async ($, on) => {
    mock.clock(on)
    const w = world(on, demoFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const reads = readsOf(w, NOTE)
    // (rft_validate is left out: its check of the links reads every file itself)
    for (const [i, tool] of ['rft_search', 'rft_map', 'rft_tree', 'rft_next', 'rft_graph'].entries()) {
      await $.tool.call({ tool: `mcp__rft__${tool}`, ...(INPUT[tool] ?? {}) } as never)
      expect(`${tool}: ${reads()} read(s)`).toBe(`${tool}: ${i + 1} read(s)`)
    }
    const before = reads()
    await $.tool.call({ tool: 'mcp__rft__rft_set_tags', id: 'D01', tags: ['seeds'] } as never)
    expect(reads() - before).toBeGreaterThan(1)
  })

  test('a note written outside meanwhile is in the tree after one', async ($, on) => {
    mock.clock(on)
    const w = world(on, demoFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    w.fs.write('vault/directions/D02 New idea.md', demoFiles()[`vault/directions/${D01}.md`]!
      .replace('id: D01', 'id: D02').replace('"[[E01 First check]]"', `"[[${E02}]]"`))
    await $.tool.call({ tool: 'mcp__rft__rft_tree' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ text: /3 directions/ })).toBeDefined()
    expect(await ui.find({ key: 'node-D02' })).toBeDefined()
    await ui.unmount()
  })

  test('what a tool wrote is in the tree after it', async ($, on) => {
    mock.clock(on)
    const w = world(on, demoFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const r = await $.tool.call({ tool: 'mcp__rft__rft_add_node', type: 'direction', parent: 'E02', title: 'New idea', summary: 'One line.' } as never)
    expect(r.isError).toBeUndefined()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ text: /3 directions/ })).toBeDefined()
    await ui.unmount()
    expect(w.fs.exists('vault/directions/D02 New idea.md')).toBe(true)
  })
})
