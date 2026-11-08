// Priorities: `priority:` is the user's alone (urgent, high, medium, low; at most 1, 5 and 10 open
// notes for the first three); Claude only suggests one, and its own writes of `priority:` are
// refused.

import { describe, expect, mock, test } from 'claude-code/testing'

import { nextReport } from '../hooks/lib/knowledge'
import { addNode } from '../hooks/lib/ops'
import { blockers, changesPriority, limitsLine, suggestPriority } from '../hooks/lib/priority'
import { front, load, readConfig, validate } from '../hooks/lib/vault'
import { CWD, D01, E01, E02, MemoryFs, demoFiles, world } from './fixture'

const E01_PATH = `vault/experiments/${E01}.md`
const E02_PATH = `vault/experiments/${E02}.md`
const D01_PATH = `vault/directions/${D01}.md`

/** The demo files, `priority:` given to some notes (by path) as the user would give it. */
function withPriorities(given: Record<string, string>): Record<string, string> {
  const files = demoFiles()
  for (const [path, p] of Object.entries(given)) files[path] = files[path]!.replace(/^(status: .*)$/m, `$1\npriority: ${p}`)
  return files
}

async function setup(given: Record<string, string> = {}) {
  const fs = new MemoryFs(withPriorities(given))
  const io = fs.io()
  const l = await load(io, (await readConfig(io))!)
  return { fs, io, l }
}

describe('priorities', () => {
  test('read from the frontmatter, whatever the case; a new note has none', async () => {
    const { fs, io, l } = await setup({ [E02_PATH]: 'High', [D01_PATH]: 'top' })
    expect(l.tree.nodes.E02!.priority).toBe('high')
    expect(l.tree.nodes.D01!.priority).toBeUndefined()
    const n = await addNode(io, l, { type: 'experiment', title: 'Seed sweep', parent: 'D01', date: '2026-02-01', summary: 'Five seeds' })
    expect(n.priority).toBeUndefined()
    expect(n.report).not.toContain('priority')
    expect(front(fs.read(`vault/${n.path}`)).priority).toBeUndefined()
    expect(changesPriority(fs.read(E02_PATH), fs.read(E02_PATH).replace('priority: High', 'priority: high'))).toBe(false)
    expect(changesPriority(fs.read(E02_PATH), fs.read(E02_PATH).replace('priority: High', 'priority: low'))).toBe(true)
  })

  test('rft_add_node may carry a suggestion, never a priority; a bad one writes nothing', async () => {
    const { fs, io, l } = await setup({ [D01_PATH]: 'urgent' })
    const n = await addNode(io, l, { type: 'experiment', title: 'Seed sweep', parent: 'D01', date: '2026-02-01', summary: 'Five seeds', suggestedPriority: 'urgent', priorityWhy: '  It decides\nwhether D01 holds ' })
    const text = fs.read(`vault/${n.path}`)
    expect(text).toContain('status: planned\nsuggested_priority: urgent\nsuggested_priority_why: "It decides whether D01 holds"\ndate: 2026-02-01\n')
    expect(front(text).priority).toBeUndefined()
    expect(l.tree.nodes[n.id]).toMatchObject({ suggestedPriority: 'urgent', suggestedWhy: 'It decides whether D01 holds' })
    expect(l.tree.nodes[n.id]!.priority).toBeUndefined()
    expect(n.report).toContain('It has no priority: your suggestion (urgent) waits for the user to accept or dismiss it in the tree view. urgent is at its limit (1, held by D01): to accept it the user first lowers one of them.')
    const count = fs.files.size
    const add = (s: Record<string, string>) => addNode(io, l, { type: 'direction', title: 'Another', parent: 'D01', date: '2026-02-01', ...s })
    await expect(add({ suggestedPriority: 'high' })).rejects.toThrow('say why in one line')
    await expect(add({ suggestedPriority: 'top', priorityWhy: 'because' })).rejects.toThrow('priority must be "urgent", "high", "medium" or "low"')
    await expect(add({ suggestedPriority: 'low', priorityWhy: 'x'.repeat(241) })).rejects.toThrow('keep why to one line')
    expect(fs.files.size).toBe(count)
  })

  test('rft_suggest_priority writes a suggestion after the status, and replaces an earlier one', async () => {
    // E01 is done: its urgent does not count
    const { fs, io, l } = await setup({ [E01_PATH]: 'urgent', [D01_PATH]: 'medium' })
    const said = await suggestPriority(io, l, 'E02', 'urgent', 'The last run before the deadline')
    expect(said).toBe(`Suggested urgent for ${E02} (no priority yet): The last run before the deadline. The user accepts or dismisses it in the tree view (the kanban, or the note's drawer); never set priority: yourself.`)
    expect(fs.read(E02_PATH)).toContain('status: running\nsuggested_priority: urgent\nsuggested_priority_why: "The last run before the deadline"\n')
    expect(l.tree.nodes.E02).toMatchObject({ suggestedPriority: 'urgent', suggestedWhy: 'The last run before the deadline' })
    expect(await suggestPriority(io, l, 'E02', 'low', 'Less pressing now')).toContain('Suggested low for')
    expect(fs.read(E02_PATH).match(/suggested_priority:/g)).toHaveLength(1)
    expect(l.tree.nodes.E02!.suggestedPriority).toBe('low')
    expect(l.tree.nodes.E02!.priority).toBeUndefined()
    // a change of the user's priority may be suggested, not the same one
    expect(await suggestPriority(io, l, 'D01', 'high', 'E02 depends on it')).toContain(`Suggested high for ${D01} (now medium)`)
    await expect(suggestPriority(io, l, 'D01', 'medium', 'why not')).rejects.toThrow(`${D01} is already medium: nothing to suggest`)
    await expect(suggestPriority(io, l, 'E02', 'asap', 'now')).rejects.toThrow('priority must be')
    await expect(suggestPriority(io, l, 'E02', 'high', ' ')).rejects.toThrow('say why in one line')
    await expect(suggestPriority(io, l, 'X9', 'high', 'now')).rejects.toThrow('not a note of the tree')
  })

  test('the limits count the open notes only (idea, planned, running)', async () => {
    const { io, l } = await setup({ [D01_PATH]: 'urgent', [E01_PATH]: 'urgent' })
    expect(limitsLine(l.tree)).toBe('urgent 1/1 (D01) · high 0/5 · medium 0/10 · low 0')
    const t = l.tree, nodes = l.tree.nodes
    expect(blockers(t, nodes.E02!, 'urgent')).toEqual(['D01'])
    expect(blockers(t, nodes.D01!, 'urgent')).toEqual([]) // holds it
    expect(blockers(t, nodes.D00!, 'urgent')).toEqual([]) // done: does not count
    expect(blockers(t, nodes.E02!, 'high')).toEqual([])
    expect(blockers(t, nodes.E02!, 'low')).toEqual([])
    expect(await suggestPriority(io, l, 'E02', 'urgent', 'It blocks the paper')).toContain(' urgent is at its limit (1, held by D01): to accept it the user first lowers one of them.')
  })

  test('the validator warns about a priority that is none of them, and a limit exceeded by hand', async () => {
    const { io, l } = await setup({ [D01_PATH]: 'urgent', [E02_PATH]: 'urgent', [E01_PATH]: 'top' })
    const warnings = (await validate(io, l, {})).warnings.join('\n')
    expect(warnings).toContain('2 open notes are urgent (D01, E02), more than the 1 allowed: the user lowers some in the tree view')
    expect(warnings).toContain('E01: priority "top" is not urgent, high, medium or low (the user sets it in the tree view)')
    const { io: io2, l: l2 } = await setup({ [D01_PATH]: 'urgent', [E01_PATH]: 'urgent' })
    expect((await validate(io2, l2, {})).warnings.join('\n')).not.toContain('priority')
  })

  test('rft_next lists the user\'s priorities first, and the higher priorities first in each list', async () => {
    const { fs, io, l } = await setup({ [E02_PATH]: 'high' })
    await addNode(io, l, { type: 'experiment', title: 'Seed sweep', parent: 'D01', date: '2026-01-10', summary: 'Five seeds' })
    const later = await addNode(io, l, { type: 'experiment', title: 'Later run', parent: 'D01', date: '2026-01-20', suggestedPriority: 'low', priorityWhy: 'Nice to have' })
    await addNode(io, l, { type: 'experiment', title: 'Low run', parent: 'D01', date: '2026-01-05' })
    const path = `vault/${later.path}`
    fs.write(path, fs.read(path).replace(/^suggested_priority.*\n/gm, '').replace('status: planned', 'status: planned\npriority: medium'))
    fs.write('vault/experiments/E05 Low run.md', fs.read('vault/experiments/E05 Low run.md').replace('status: planned', 'status: planned\npriority: low'))
    await addNode(io, l, { type: 'direction', title: 'A wider variant', parent: 'E02', date: '2026-01-21', suggestedPriority: 'high', priorityWhy: 'Cheap and decisive' })
    Object.assign(l, await load(io, l.config))
    const out = await nextReport(io, l, '2026-02-09')
    // low is a priority, not one to focus on
    expect(out).toContain(`## Your priorities (2; the user sets them in the tree view)\n  … ${E02} [high] (38d)\n  → E04 Later run [medium] (20d)\n`)
    expect(out).toContain('Planned, never run (3, by priority, then oldest first):\n  → E04 Later run [medium] (20d)\n  → E05 Low run [low] (35d)\n  → E03 Seed sweep (30d) — Five seeds')
    expect(out).toContain('Directions not explored yet (1, oldest first):\n  ? D02 A wider variant (19d)')
    expect(out.endsWith('\n\nSuggested priorities waiting for the user (the tree view\'s kanban or note drawer): D02 high.')).toBe(true)
  })
})

describe('in a session', () => {
  /** The demo project with some priorities, and core's tools answered by the test: the calls that reach them. */
  async function session($: Parameters<Parameters<typeof test>[1]>[0], on: Parameters<Parameters<typeof test>[1]>[1], given: Record<string, string> = {}) {
    mock.clock(on)
    const w = world(on, withPriorities(given))
    const ran: string[] = []
    on('tool.call', (_$, e) => { ran.push(String(e.tool)); return { result: 'ok', text: 'ok' } as never })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    return { w, ran }
  }

  test('Claude cannot give, change or take away a priority, and is told to suggest one instead', async ($, on) => {
    const { w, ran } = await session($, on, { [D01_PATH]: 'high' })
    const e02 = w.fs.read(E02_PATH), d01 = w.fs.read(D01_PATH)
    for (const call of [
      { tool: 'Edit', file_path: `${CWD}/${E02_PATH}`, old_string: 'status: running\n', new_string: 'status: running\npriority: urgent\n' },
      { tool: 'Edit', file_path: `${CWD}/${D01_PATH}`, old_string: 'priority: high', new_string: 'priority: low' },
      { tool: 'Edit', file_path: `vault/directions/${D01}.md`, old_string: 'priority: high\n', new_string: '' },
      { tool: 'MultiEdit', file_path: `${CWD}/${E02_PATH}`, edits: [{ old_string: 'Text of E02.', new_string: 'Changed.' }, { old_string: 'status: running', new_string: 'status: running\npriority: low' }] },
      { tool: 'Write', file_path: `${CWD}/${E02_PATH}`, content: e02.replace('status: running\n', 'status: running\npriority: high\n') },
      { tool: 'Write', file_path: `${CWD}/${D01_PATH}`, content: d01.replace('priority: high\n', '') },
      { tool: 'Write', file_path: `${CWD}/vault/experiments/E09 By hand.md`, content: '---\nid: E09\nstatus: planned\npriority: high\n---\n' },
      { tool: 'Bash', command: `sed -i 's/priority: high/priority: urgent/' "vault/directions/${D01}.md"` },
      { tool: 'Bash', command: "printf 'priority: high\\n' >> vault/experiments/E02*" },
    ]) {
      const res = await $.tool.call(call as never)
      expect({ call, deny: (res as { deny?: string }).deny }).toEqual({ call, deny: expect.stringContaining("priority is the user's alone") })
    }
    const res = await $.tool.call({ tool: 'Edit', file_path: `${CWD}/${E02_PATH}`, old_string: 'status: running\n', new_string: 'status: running\npriority: urgent\n' } as never)
    expect((res as { deny?: string }).deny).toBe(`${E02}'s priority is the user's alone: they set it in the tree view (the kanban, or the note's drawer), and your edits that change \`priority:\` are refused. To propose one, call rft_suggest_priority {id: "E02", priority, why}; the user accepts or dismisses it.`)
    expect(ran).toEqual([])
    expect(w.fs.read(E02_PATH)).toBe(e02)
    expect(w.fs.read(D01_PATH)).toBe(d01)
  })

  test('every other write goes on, a note\'s priority kept; suggestions go through the tools', async ($, on) => {
    const { w, ran } = await session($, on, { [D01_PATH]: 'high' })
    const d01 = w.fs.read(D01_PATH)
    for (const call of [
      { tool: 'Edit', file_path: `${CWD}/${D01_PATH}`, old_string: 'Text of D01.', new_string: 'Changed.' },
      { tool: 'Write', file_path: `${CWD}/${D01_PATH}`, content: d01.replace('Text of D01.', 'Rewritten.') },
      { tool: 'Edit', file_path: `${CWD}/${E02_PATH}`, old_string: 'Text of E02.', new_string: 'Not the priority: field of the note.' },
      { tool: 'Edit', file_path: `${CWD}/notes/todo.md`, old_string: 'a', new_string: 'priority: high' },
      { tool: 'Bash', command: 'python train.py --priority 3 > runs/E02.log' },
      { tool: 'Bash', command: 'echo "priority: high" > todo.txt' },
    ]) {
      const res = await $.tool.call(call as never)
      expect({ call, deny: (res as { deny?: string }).deny }).toEqual({ call, deny: undefined })
    }
    expect(ran).toEqual(['Edit', 'Write', 'Edit', 'Edit', 'Bash', 'Bash'])
    const s = await $.tool.call({ tool: 'mcp__rft__rft_suggest_priority', id: 'E02', priority: 'high', why: 'It decides D01' } as never)
    expect(s.text).toContain(`Suggested high for ${E02} (no priority yet): It decides D01.`)
    expect(front(w.fs.read(E02_PATH)).suggested_priority).toBe('high')
    const added = await $.tool.call({ tool: 'mcp__rft__rft_add_node', type: 'experiment', title: 'Seed sweep', parent: 'D01', summary: 'Five seeds', suggested_priority: 'medium', priority_why: 'Cheap' } as never)
    expect(added.text).toContain('your suggestion (medium) waits for the user')
    expect(front(w.fs.read('vault/experiments/E03 Seed sweep.md')).suggested_priority).toBe('medium')
    expect(front(w.fs.read('vault/experiments/E03 Seed sweep.md')).priority).toBeUndefined()
    const bad = await $.tool.call({ tool: 'mcp__rft__rft_suggest_priority', id: 'E02', priority: 'high' } as never)
    expect(bad.isError).toBe(true)
    expect(bad.text).toContain('say why in one line')
  })
})
