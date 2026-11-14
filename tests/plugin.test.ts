// The plugin in a session: activation by the config marker, the injected rules, the tools,
// the commands, and the tree pane on the terminal and the desktop.

import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { isLocked } from '../hooks/lib/comments'
import { addNode, loadActive, setType, today } from '../hooks/lib/ops'
import { CWD, D00, D01, E01, E02, MemoryFs, WEB_FILES, demoAt, demoFiles, paneProps, world } from './fixture'

const SURFACES = ['terminal', 'desktop'] as const
// the `name` of skills/rft-manual/SKILL.md
const SKILL = 'rft-manual'
const PANE = { plugin: 'rft', component: 'Pane', requestId: 'rft-tree', props: paneProps() } as const

describe('activation', () => {
  test('without .rft/config.json nothing is injected, no tool registered, no pane opened', async ($, on) => {
    mock.clock(on)
    const w = world(on, {})
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(w.commands).toEqual(['rft', 'rft-init', 'rft-concepts', 'rft-literature', 'rft-rebalance', 'rft-next', 'rft-summarize', 'rft-view'])
    expect(w.tools).toEqual([])
    expect(w.opened).toEqual([])
    const res = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    expect(res.sections.map(s => s.id)).toEqual(['intro'])
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ text: /not active/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('with the marker the rules and the tree are injected and the tools registered', async ($, on) => {
    mock.clock(on)
    const w = world(on, demoFiles())
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' as const }] }))
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(w.tools).toEqual(['rft_add_node', 'rft_set_repos', 'rft_code', 'rft_set_code', 'rft_set_status', 'rft_suggest_priority', 'rft_suggest_dates', 'rft_add_deadline', 'rft_suggest_deadline', 'rft_set_summary', 'rft_map', 'rft_supersede', 'rft_next', 'rft_set_digest', 'rft_move_node', 'rft_set_refs', 'rft_search', 'rft_graph', 'rft_collect_papers', 'rft_set_tags', 'rft_set_type', 'rft_set_concept', 'rft_concepts', 'rft_tags', 'rft_tree', 'rft_validate', 'rft_sync', 'rft_comments', 'rft_comment', 'rft_suggest'])
    expect(w.opened).toEqual(['rft-tree'])
    const res = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    const rules = res.sections.find(s => s.id === 'rft:rules')
    expect(rules?.scope).toBe('session')
    expect(rules?.text).toContain('create its node first')
    expect(rules?.text).toContain(`      … ${E02}`)
  })

  test('a refused command leaves the other commands, the tools, the rules and the pane working', async ($, on) => {
    mock.clock(on)
    const w = world(on, demoFiles(), { refuse: ['rft'] })
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(w.commands).toEqual(['rft-init', 'rft-concepts', 'rft-literature', 'rft-rebalance', 'rft-next', 'rft-summarize', 'rft-view'])
    expect(w.tools).toHaveLength(30)
    expect(w.opened).toEqual(['rft-tree'])
    expect(w.toasts.join()).toContain('/rft')
    const res = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    expect(res.sections.map(s => s.id)).toEqual(['rft:rules'])
  })

  test('no command takes the name of the plugin skill', async () => {
    // a plugin skill named <x> is the command /rft:<x>; the engine refuses a command of the same name
    expect(['rft', 'rft-init', 'rft-concepts', 'rft-literature', 'rft-rebalance', 'rft-next', 'rft-summarize', 'rft-view']).not.toContain(SKILL)
  })

  test('autoOpen off keeps the pane closed', { options: { autoOpen: false } }, async ($, on) => {
    mock.clock(on)
    const w = world(on, demoFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(w.opened).toEqual([])
  })
})

describe('tools', () => {
  test('add, status, tree and validate through tool calls', async ($, on) => {
    mock.clock(on)
    const w = world(on, demoFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const added = await $.tool.call({ tool: 'mcp__rft__rft_add_node', type: 'experiment', title: 'Seed sweep', parent: 'D01', what: 'Five seeds.' } as never)
    expect(added.isError).toBeUndefined()
    expect(added.text).toContain('Id: E03')
    expect(w.fs.exists('vault/experiments/E03 Seed sweep.md')).toBe(true)
    const status = await $.tool.call({ tool: 'mcp__rft__rft_set_status', id: 'E03', status: 'running' } as never)
    expect(status.text).toContain('planned → running')
    const tree = await $.tool.call({ tool: 'mcp__rft__rft_tree', root: 'D01' } as never)
    expect(tree.text).toContain(`? ${D01}`)
    expect(tree.text).toContain('  … E03 Seed sweep')
    const tagged = await $.tool.call({ tool: 'mcp__rft__rft_set_tags', id: 'E03', tags: ['Seeds', 'sweep'] } as never)
    expect(tagged.text).toContain('tags seeds, sweep')
    const vocab = await $.tool.call({ tool: 'mcp__rft__rft_tags' } as never)
    expect(vocab.text).toContain('- seeds (1)')
    const withTags = await $.tool.call({ tool: 'mcp__rft__rft_add_node', type: 'direction', title: 'Fewer seeds', parent: 'E03', tags: ['seeds'] } as never)
    expect(withTags.isError).toBeUndefined()
    expect(w.fs.read('vault/directions/D02 Fewer seeds.md')).toContain('tags: [demo, direction, seeds, idea]')
    const check = await $.tool.call({ tool: 'mcp__rft__rft_validate' } as never)
    expect(check.text).toMatch(/^OK: no errors/)
    const bad = await $.tool.call({ tool: 'mcp__rft__rft_add_node', type: 'direction', title: 'Orphan', parent: 'X9' } as never)
    expect(bad.isError).toBe(true)
  })
})

describe('concepts', () => {
  test('rft_set_concept and rft_concepts through tool calls', async ($, on) => {
    mock.clock(on)
    const w = world(on, demoFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const set = await $.tool.call({ tool: 'mcp__rft__rft_set_concept', id: 'D01', name: 'Variants', summary: 'Better variants of the check' } as never)
    expect(set.isError).toBeUndefined()
    expect(set.text).toContain('now starts the concept "Variants"')
    expect(w.fs.read(`vault/directions/${D01}.md`)).toContain('concept: "Variants"\nconcept_summary: "Better variants of the check"')
    const tree = await $.tool.call({ tool: 'mcp__rft__rft_concepts' } as never)
    expect(tree.text).toContain('- Variants [@D01] 2 note(s)')
    const bad = await $.tool.call({ tool: 'mcp__rft__rft_set_concept', id: 'D01', name: 'A | B' } as never)
    expect(bad.isError).toBe(true)
    const off = await $.tool.call({ tool: 'mcp__rft__rft_set_concept', id: 'D01', name: null } as never)
    expect(off.text).toContain('no longer starts')
    expect(w.fs.read(`vault/directions/${D01}.md`)).not.toContain('concept:')
  })

  test('/rft-concepts prints the concept tree; suggest asks Claude for a proposal and applies nothing', async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, demoFiles())
    const prompts: string[] = []
    on('prompt.submit', (_$, e) => { prompts.push(String(e.text)); return { text: e.text } as never })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const run = (args: string) => $.command.run({ command: 'rft-concepts', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
    const plain = await run('')
    expect(plain.text).toContain('No concepts yet')
    const before = w.fs.read(`vault/directions/${D01}.md`)
    const suggest = await run('suggest')
    expect(suggest.text).toContain('nothing changes until you confirm it')
    expect(prompts).toEqual([])
    // the prompt is submitted by the session's poller, outside the command's dispatch
    await clock.advance(5000)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Do not call rft_set_concept until I say yes')
    expect(w.fs.read(`vault/directions/${D01}.md`)).toBe(before)
  })

  test('/rft-literature places the search under a note or a concept, or asks where for a bare topic', async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, demoFiles())
    const prompts: string[] = []
    on('prompt.submit', (_$, e) => { prompts.push(String(e.text)); return { text: e.text } as never })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const run = (args: string) => $.command.run({ command: 'rft-literature', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
    expect((await run('')).text).toContain('Usage')
    expect((await run('D01')).text).toContain(D01)
    await clock.advance(5000)
    expect(prompts[0]).toContain(`Place it under ${D01}.`)
    expect(prompts[0]).toContain('ONE literature note, not a note per paper')
    expect(prompts[0]).toContain('tags ["literature"]')
    expect(prompts[0]).toContain('never invent a citation')
    await run('label smoothing')
    await clock.advance(5000)
    expect(prompts[1]).toContain('"label smoothing"')
    expect(prompts[1]).toContain('ask me where to put it')
    expect(w.fs.read(`vault/directions/${D01}.md`)).toBe(demoFiles()[`vault/directions/${D01}.md`])
  })

  test('/rft-rebalance asks Claude for moves to confirm, optionally in one part of the tree, and moves nothing', async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, demoFiles())
    const prompts: string[] = []
    on('prompt.submit', (_$, e) => { prompts.push(String(e.text)); return { text: e.text } as never })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const run = (args: string) => $.command.run({ command: 'rft-rebalance', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
    const before = w.fs.read(`vault/directions/${D01}.md`)
    // one concept: no candidate, nothing asked
    expect((await run('')).text).toContain('nothing to propose')
    const res = await run('--full')
    expect(res.text).toContain('nothing moves until you confirm')
    expect(prompts).toEqual([])
    await clock.advance(5000)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Do not call rft_move_node until I say yes')
    expect(prompts[0]).not.toContain('limited to')
    await run('D01 --full')
    await clock.advance(5000)
    expect(prompts[1]).toContain('limited to "D01"')
    expect(w.fs.read(`vault/directions/${D01}.md`)).toBe(before)
  })

  test('the session rules ask Claude to propose concepts, and group the tree by concept', async ($, on) => {
    mock.clock(on)
    const files = demoFiles()
    files[`vault/directions/${D01}.md`] = files[`vault/directions/${D01}.md`]!.replace(/^(tags: .*)$/m, '$1\nconcept: "Variants"')
    world(on, files)
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const res = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    const rules = res.sections.find(x => x.id === 'rft:rules')!.text
    expect(rules).toContain('PROPOSE a short concept name')
    expect(rules).toContain('## demo › Variants (from D01)')
  })
})

describe('commands', () => {
  test('/rft-init creates the vault and activates the plugin', async ($, on) => {
    mock.clock(on)
    const w = world(on, {})
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const res = await $.command.run({ command: 'rft-init', args: 'Is there a better optimiser', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
    expect(res.text).toContain('RFT is now active')
    expect(w.fs.exists('vault/directions/D00 Is there a better optimiser.md')).toBe(true)
    expect(w.tools).toContain('rft_add_node')
  })

  test('/rft-view writes one standalone page: the web view with the tree and the notes inlined', async ($, on) => {
    mock.clock(on)
    const thread = { id: 'c1', kind: 'comment', state: 'open', quote: 'Text of E02.', prefix: '', suffix: '', replacement: null, asked: null, messages: [], closed: null }
    const w = world(on, { ...demoFiles(), ...WEB_FILES, 'vault/.comments/E02.json': JSON.stringify({ note: 'E02', next: 2, threads: [thread] }) })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const res = await $.command.run({ command: 'rft-view', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
    expect(res.text).toContain(`file://${CWD}/vault/tree.html`)
    const html = w.fs.read('vault/tree.html')
    expect(html).not.toContain('data-rft-inline')
    expect(html).toContain('<style>body { color: red }</style>')
    expect(html).toContain('<script>/* theme */</script>')
    expect(html).toContain('"$&"')
    expect(html).toContain('"<\\/script>"')
    expect(html).toContain('window.RFT_DATA = {"tree":{"project":"demo"')
    expect(html).toContain('Text of D01.')
    expect(html.indexOf('window.RFT_DATA')).toBeLessThan(html.indexOf('console.log(window.RFT_DATA'))
    // each note's threads, placed in its text, for the page to show read-only
    const data = JSON.parse(/window\.RFT_DATA = (.*?);<\/script>/.exec(html)![1]!)
    const body = data.bodies.E02 as string
    expect(data.comments.E02).toHaveLength(1)
    expect(body.slice(...(data.comments.E02[0].at as [number, number]))).toBe('Text of E02.')
    expect(data.comments.E02[0].exact).toBe(true)
  })
})

/** The address the server child prints: with the key for writes, as the real one does. */
const ADDRESS = 'http://127.0.0.1:5555/?token=k3y'

/** The server child: says where it listens, prints what the test hands `print`, and runs until the plugin ends the loop. */
function fakeServer(on: On, opts: { fail?: string[] } = {}) {
  const seen: string[][] = []
  const state = { isRunning: false }
  const queued: string[] = []
  let wake = () => undefined as void
  on('process.spawn', async function* (_$: unknown, e: { argv: readonly string[] }, next: { signal: AbortSignal }) {
    seen.push([...e.argv])
    if (opts.fail?.includes(e.argv[0]!)) throw new Error(`ENOENT: ${e.argv[0]}`)
    state.isRunning = true
    try {
      yield { stream: 'stdout' as const, text: `RFT_SERVER_URL ${ADDRESS}\n` }
      // runs until the plugin ends the loop, which aborts this dispatch
      const aborted = new Promise<boolean>(resolve => next.signal.addEventListener('abort', () => resolve(true)))
      for (;;) {
        while (queued.length) yield { stream: 'stdout' as const, text: queued.shift()! }
        if (await Promise.race([aborted, new Promise<boolean>(resolve => { wake = () => resolve(false) })])) break
      }
      return { value: { code: null, signal: 'SIGTERM' } }
    } finally {
      state.isRunning = false
    }
  })
  const print = (text: string) => { queued.push(text); wake() }
  return { seen, state, print }
}

/** Waits, a few milliseconds at a time, until `cond` holds: the plugin reads the server's output on its own. */
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise(resolve => setTimeout(resolve, 5))
}

const texts = (fs: MemoryFs) => Object.fromEntries([...fs.files].map(([k, f]) => [k, f.text]))

const RUN = (args: string) => ({ command: 'rft', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } }) as never

describe('web view', () => {
  test('/rft starts the server once, prints how to open it, and the pane shows the URL', async ($, on) => {
    mock.clock(on)
    world(on, demoFiles())
    const srv = fakeServer(on)
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const first = await $.command.run(RUN(''))
    expect(first.text).toContain(`Tree view: ${ADDRESS}`)
    expect(first.text).toContain('Ctrl+Shift+B')
    expect(first.text).toContain('ssh -L 5555:127.0.0.1:5555')
    expect(srv.seen).toHaveLength(1)
    const argv = srv.seen[0]!
    expect(argv[0]).toBe('python3')
    expect(argv[1]).toMatch(/server\/rft_server\.py$/)
    expect(argv.slice(2)).toEqual(['--vault', `${CWD}/vault`, '--web', expect.stringMatching(/\/web$/), '--project', 'demo', '--port', '0', '--config', `${CWD}/.rft/config.json`])
    const again = await $.command.run(RUN(''))
    expect(again.text).toContain('http://127.0.0.1:5555/')
    expect(srv.seen).toHaveLength(1)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ type: 'Text', text: /^Tree view: / }))?.text).toBe(`Tree view: ${ADDRESS}`)
      await ui.unmount()
    }
    expect(srv.state.isRunning).toBe(true)
    const stopped = await $.command.run(RUN('stop'))
    expect(stopped.text).toContain('stopped')
    expect(srv.state.isRunning).toBe(false)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await ui.find({ type: 'Text', text: /^Tree view: / })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Run \/rft for the interactive tree/ })).toBeDefined()
    await ui.unmount()
  })

  test('the server stops when the session ends', async ($, on) => {
    mock.clock(on)
    world(on, demoFiles())
    const srv = fakeServer(on)
    on('session.end', () => ({ sessionId: 'test' }) as never)
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    await $.command.run(RUN(''))
    expect(srv.state.isRunning).toBe(true)
    await $.session.end({ reason: 'other' } as never)
    expect(srv.state.isRunning).toBe(false)
  })

  test('a /clear keeps the server, and the fresh session shows and reuses it', async ($, on) => {
    mock.clock(on)
    world(on, demoFiles())
    const srv = fakeServer(on)
    on('session.end', () => ({ sessionId: 'test' }) as never)
    on('classic.SessionStart', () => ({}) as never)
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    await $.command.run(RUN(''))
    await $.session.end({ reason: 'clear' } as never)
    await $.classic.SessionStart({ source: 'clear' } as never)
    expect(srv.state.isRunning).toBe(true)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /^Tree view: / }))?.text).toBe(`Tree view: ${ADDRESS}`)
    await ui.unmount()
    const again = await $.command.run(RUN(''))
    expect(again.text).toContain(`Tree view: ${ADDRESS}`)
    expect(srv.seen).toHaveLength(1)
    await $.session.end({ reason: 'prompt_input_exit' } as never)
    expect(srv.state.isRunning).toBe(false)
  })

  test('on the desktop /rft opens the tree view in the browser pane, not the outline pane', async ($, on) => {
    mock.clock(on)
    const w = world(on, demoFiles(), { surfaces: ['desktop'] })
    fakeServer(on)
    const calls: { tool: string; args: Record<string, unknown> }[] = []
    on('mcp.call', (_$, e) => {
      calls.push({ tool: e.tool, args: e.args })
      expect(e.server).toBe('Claude_Browser')
      const text = e.tool === 'tabs_context'
        ? JSON.stringify({ browserOpen: true, tabs: [{ tabId: 'tab-1', origin: 'https://example.org', isActive: true }] }) + '\nThe Browser pane is currently displayed.'
        : 'ok'
      return { value: { content: [{ type: 'text', text }], isError: false } }
    })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(w.opened).toEqual([])
    const res = await $.command.run(RUN(''))
    expect(res.text).toContain(`Tree view opened in the browser pane: ${ADDRESS}`)
    expect(calls.map(c => c.tool)).toEqual(['tabs_context', 'preview_start'])
    expect(calls[1]!.args).toEqual({ url: ADDRESS })
    expect(w.opened).toEqual([])
    const list = await $.command.run(RUN('list'))
    expect(list.text).toContain('Outline pane opened')
    expect(w.opened).toEqual(['rft-tree'])
  })

  test('on the desktop a tab already on the tree view is reused, and a hidden pane is pointed out', async ($, on) => {
    mock.clock(on)
    world(on, demoFiles(), { surfaces: ['desktop'] })
    fakeServer(on)
    const calls: { tool: string; args: Record<string, unknown> }[] = []
    on('mcp.call', (_$, e) => {
      calls.push({ tool: e.tool, args: e.args })
      const text = e.tool === 'tabs_context'
        ? JSON.stringify({ browserOpen: true, tabs: [{ tabId: 'tab-7', origin: 'http://127.0.0.1:5555', isActive: false }] }, null, 2) + '\nThe Browser pane is currently hidden.'
        : 'ok'
      return { value: { content: [{ type: 'text', text }], isError: false } }
    })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const res = await $.command.run(RUN(''))
    expect(calls.map(c => c.tool)).toEqual(['tabs_context', 'navigate', 'tabs_select'])
    expect(calls[1]!.args).toEqual({ url: ADDRESS, tabId: 'tab-7' })
    expect(res.text).toContain('shown again')
    expect(res.text).toContain('Ctrl+Shift+B')
  })

  test('on the desktop without a browser pane it falls back to the address and the outline pane', async ($, on) => {
    mock.clock(on)
    const w = world(on, demoFiles(), { surfaces: ['desktop'] })
    fakeServer(on)
    on('mcp.call', () => { throw new Error('no MCP server named Claude_Browser') })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const res = await $.command.run(RUN(''))
    expect(res.text).toContain('Tree view: http://127.0.0.1:5555/')
    expect(res.text!.split('\n')[0]).toBe(`Tree view: ${ADDRESS}`)
    expect(w.opened).toEqual(['rft-tree'])
  })

  test('in the terminal /rft prints the address and opens the outline pane, without the browser', async ($, on) => {
    mock.clock(on)
    const w = world(on, demoFiles(), { surfaces: ['terminal'] })
    fakeServer(on)
    const calls: string[] = []
    on('mcp.call', (_$, e) => { calls.push(e.tool); return { value: { content: [], isError: false } } })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(w.opened).toEqual(['rft-tree'])
    const res = await $.command.run(RUN(''))
    expect(res.text).toContain('Tree view: http://127.0.0.1:5555/')
    expect(calls).toEqual([])
  })

  test('without python3 it tries python, and without either it says what is needed', async ($, on) => {
    mock.clock(on)
    world(on, demoFiles())
    const srv = fakeServer(on, { fail: ['python3', 'python'] })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const res = await $.command.run(RUN(''))
    expect(srv.seen.map(a => a[0])).toEqual(['python3', 'python'])
    expect(res.text).toContain('needs Python 3 on PATH')
    expect(res.text).toContain('/rft-view')
  })

  test('a note the tree view adds is the one rft_add_node makes, byte for byte, with no model turn', async ($, on) => {
    mock.clock(on)
    const w = world(on, demoFiles())
    const srv = fakeServer(on)
    const prompts: string[] = []
    on('prompt.submit', (_$, e) => { prompts.push(String(e.text)); return { text: e.text } as never })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    await $.command.run(RUN(''))
    const title = 'Seeds: 3 | 5 [fast]'
    // the reference: rft_add_node's own code on a copy of the project
    const ref = new MemoryFs(demoFiles())
    await addNode(ref.io(), await loadActive(ref.io()), { type: 'experiment', title, parent: 'D01', date: today() })
    // the server's line, cut in two as a pipe may deliver it
    const line = `RFT_ADD_NODE ${JSON.stringify({ parent: 'D01', type: 'experiment', title })}\n`
    srv.print(line.slice(0, 30))
    srv.print(line.slice(30))
    const path = 'vault/experiments/E03 Seeds, 3, 5 (fast).md'
    await until(() => w.fs.exists(path))
    expect(w.fs.read(path)).toContain('status: planned')
    expect(texts(w.fs)).toEqual(texts(ref))
    expect(prompts).toEqual([])
    expect(w.toasts).toEqual([])
  })

  test('a note the tree view cannot add is reported in the session, and nothing is written', async ($, on) => {
    mock.clock(on)
    const w = world(on, demoFiles())
    const srv = fakeServer(on)
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    await $.command.run(RUN(''))
    const before = texts(w.fs)
    srv.print(`RFT_ADD_NODE ${JSON.stringify({ parent: 'D42', type: 'direction', title: 'Orphan' })}\n`)
    await until(() => w.toasts.length > 0)
    expect(w.toasts.join()).toContain('the tree view could not add a note')
    expect(w.toasts.join()).toContain('D42')
    expect(texts(w.fs)).toEqual(before)
  })

  test('a type change from the tree view is the one rft_set_type makes, with no model turn', async ($, on) => {
    mock.clock(on)
    const w = world(on, demoFiles())
    const srv = fakeServer(on)
    const prompts: string[] = []
    on('prompt.submit', (_$, e) => { prompts.push(String(e.text)); return { text: e.text } as never })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    await $.command.run(RUN(''))
    const ref = new MemoryFs(demoFiles())
    await setType(ref.io(), await loadActive(ref.io()), 'E02', 'direction')
    srv.print(`RFT_SET_TYPE ${JSON.stringify({ id: 'E02', type: 'direction' })}\n`)
    await until(() => w.fs.exists('vault/directions/D02 Variant run.md') && !w.fs.exists(`vault/experiments/${E02}.md`))
    expect(texts(w.fs)).toEqual(texts(ref))
    expect(prompts).toEqual([])
    expect(w.toasts).toEqual([])
  })

  test('a type change the tree view cannot make is reported in the session, and nothing is written', async ($, on) => {
    mock.clock(on)
    const w = world(on, demoFiles())
    const srv = fakeServer(on)
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    await $.command.run(RUN(''))
    const before = texts(w.fs)
    srv.print(`RFT_SET_TYPE ${JSON.stringify({ id: 'D00', type: 'experiment' })}\n`)
    await until(() => w.toasts.length > 0)
    expect(w.toasts.join()).toContain("the tree view could not change a note's type")
    expect(w.toasts.join()).toContain('the root of the tree stays a direction')
    expect(texts(w.fs)).toEqual(before)
  })

  test('a locked note the tree view moves is moved unlocked once agreed there, and otherwise asked about', async ($, on) => {
    mock.clock(on)
    const files = demoFiles()
    const path = `vault/experiments/${E02}.md`
    files[path] = files[path]!.replace('\n---\n', '\nlocked: true\n---\n')
    const w = world(on, files)
    const srv = fakeServer(on)
    const asked: string[] = []
    on('tool.call', (_$, e) => {
      if (e.tool !== 'AskUserQuestion') return { result: 'ok', text: 'ok' } as never
      asked.push(String(e.tool))
      return { deny: 'The user dismissed the dialog' } as never
    })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    await $.command.run(RUN(''))
    // not agreed in the page (an older page, say): the session asks, and a dismissed dialog keeps it
    srv.print(`RFT_MOVE_NODE ${JSON.stringify({ id: 'E02', parent: 'E01' })}\n`)
    await until(() => w.toasts.length > 0)
    expect(asked).toEqual(['AskUserQuestion'])
    expect(w.toasts.join()).toContain(`the tree view could not move a note (${E02} is locked and the user kept it locked`)
    expect(isLocked(w.fs.read(path))).toBe(true)
    // agreed in the page: moved and unlocked, with no dialog
    srv.print(`RFT_MOVE_NODE ${JSON.stringify({ id: 'E02', parent: 'E01', unlock: true })}\n`)
    await until(() => w.fs.read(path).includes('## History'))
    expect(w.fs.read(path)).toContain(`moved from [[${D01}]] to [[${E01}]]`)
    expect(isLocked(w.fs.read(path))).toBe(false)
    expect(asked).toHaveLength(1)
  })

  test('/rft outside an RFT project starts nothing', async ($, on) => {
    mock.clock(on)
    world(on, {})
    const srv = fakeServer(on)
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect((await $.command.run(RUN(''))).text).toContain('not active')
    expect(srv.seen).toHaveLength(0)
  })
})

describe('pane', () => {
  test('the terminal shows the list: select a note, fold a branch, no tree toggle', async ($, on) => {
    mock.clock(on)
    world(on, demoFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ text: /demo: 2 directions, 2 experiments/ })).toBeDefined()
    expect(await ui.find({ key: 'view-tree' })).toBeUndefined()
    expect(await ui.find({ key: 'node-E02' })).toBeDefined()
    await ui.press({ key: 'node-D01' })
    expect((await ui.find({ key: 'note-text' }))?.text).toContain('Text of D01.')
    await ui.press({ key: 'down-E02' })
    expect((await ui.find({ key: 'note-text' }))?.text).toContain('Text of E02.')
    await ui.press({ key: 'close-note' })
    expect(await ui.find({ key: 'note-text' })).toBeUndefined()
    await ui.press({ key: 'fold-D01' })
    expect(await ui.find({ key: 'node-E02' })).toBeUndefined()
    expect(await ui.find({ text: /\+1/ })).toBeDefined()
    await ui.press({ key: 'unfold-all' })
    expect(await ui.find({ key: 'node-E02' })).toBeDefined()
    await ui.unmount()
  })

  test('the desktop pane is the outline too, with no picture', async ($, on) => {
    mock.clock(on)
    world(on, demoFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Svg' })).toBeUndefined()
      expect(await ui.find({ key: 'node-E02' })).toBeDefined()
      expect(await ui.find({ key: 'view-tree' })).toBeUndefined()
      await ui.press({ key: 'node-D01' })
      expect((await ui.find({ key: 'note-text' }))?.text).toContain('Text of D01.')
      await ui.press({ key: 'close-note' })
      await ui.unmount()
    }
  })

  test('the pane follows vault changes on both surfaces', async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, demoFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    // a note written by another tool (or by hand) shows up at the next poll
    const files = demoFiles()
    w.fs.write('vault/directions/D02 New idea.md', files[`vault/directions/${D01}.md`]!
      .replace('id: D01', 'id: D02').replace('"[[E01 First check]]"', `"[[${E02}]]"`))
    await clock.advance(5000)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ text: /3 directions/ })).toBeDefined()
      expect(await ui.find({ key: 'node-D02' })).toBeDefined()
      await ui.unmount()
    }
  })
})

// a tree kept apart from the code: the notes in /phd/flow-notes, the repos below /phd/code linked to it
const TREE = '/phd/flow-notes'
const REPO = '/phd/code/disentanglement/dedino'
const LINK = '/phd/code/.rft/config.json'
const linked = (extra: Record<string, string> = {}) => demoAt(TREE, { [LINK]: JSON.stringify({ tree: '../flow-notes' }), ...extra })
const INIT = (args: string) => ({ command: 'rft-init', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } }) as never

describe('linked trees', () => {
  test('a session in a repo below a link works on the tree it links to, and writes nothing beside the code', async ($, on) => {
    mock.clock(on)
    const w = world(on, linked(), { cwd: REPO })
    const srv = fakeServer(on)
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start({ cwd: REPO, source: 'startup' } as never)
    expect(w.tools).toHaveLength(30)
    const res = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    expect(res.sections.find(s => s.id === 'rft:rules')?.text).toContain(`notes in \`${TREE}/vault/\``)
    expect((await $.tool.call({ tool: 'mcp__rft__rft_tree' } as never)).text).toContain(`theory notes in ${TREE}/vault/.`)
    const added = await $.tool.call({ tool: 'mcp__rft__rft_add_node', type: 'experiment', title: 'Seed sweep', parent: 'D01' } as never)
    expect(added.text).toContain('Id: E03')
    expect(added.text).toContain(`Note: ${TREE}/vault/experiments/E03 Seed sweep.md`)
    expect(w.fs.exists(`${TREE}/vault/experiments/E03 Seed sweep.md`)).toBe(true)
    expect(JSON.parse(w.fs.read(`${TREE}/.rft/config.json`)).lastId).toEqual({ E: 3, D: 1, R: 0, T: 0 })
    expect([...w.fs.files.keys()].filter(k => k.startsWith('/phd/code/'))).toEqual([LINK])
    expect(JSON.parse(w.fs.read(LINK))).toEqual({ tree: '../flow-notes' })
    await $.command.run(RUN(''))
    expect(srv.seen[0]!.slice(2, 4)).toEqual(['--vault', `${TREE}/vault`])
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'node-D01' })
    expect((await ui.find({ key: 'note-text' }))?.text).toContain('Text of D01.')
    await ui.unmount()
  })

  test('a session in the tree\'s own folder is told the vault as configured, as before', async ($, on) => {
    mock.clock(on)
    const w = world(on, linked(), { cwd: TREE })
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start({ cwd: TREE, source: 'startup' } as never)
    const res = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    expect(res.sections.find(s => s.id === 'rft:rules')?.text).toContain('notes in `vault/`')
    const added = await $.tool.call({ tool: 'mcp__rft__rft_add_node', type: 'direction', title: 'Next', parent: 'E02' } as never)
    expect(added.text).toContain('Note: vault/directions/D02 Next.md')
    expect(w.fs.exists(`${TREE}/vault/directions/D02 Next.md`)).toBe(true)
  })

  test('a session in a folder below a tree works on that tree', async ($, on) => {
    mock.clock(on)
    const w = world(on, linked(), { cwd: `${TREE}/analysis` })
    await $.session.start({ cwd: `${TREE}/analysis`, source: 'startup' } as never)
    expect(w.tools).toHaveLength(30)
    const tree = await $.tool.call({ tool: 'mcp__rft__rft_tree' } as never)
    expect(tree.text).toMatch(/^demo: 2 directions, 2 experiments/)
  })

  test('the nearest tree wins: a repo with its own tree below a link keeps its own', async ($, on) => {
    mock.clock(on)
    const own = Object.fromEntries(Object.entries(demoAt(REPO)).map(([k, v]) => [k, v.replace('"project":"demo"', '"project":"own"')]))
    const w = world(on, linked(own), { cwd: REPO })
    await $.session.start({ cwd: REPO, source: 'startup' } as never)
    const tree = await $.tool.call({ tool: 'mcp__rft__rft_tree' } as never)
    expect(tree.text).toMatch(/^own: /)
    await $.tool.call({ tool: 'mcp__rft__rft_add_node', type: 'experiment', title: 'Local run', parent: 'D01' } as never)
    expect(w.fs.exists(`${REPO}/vault/experiments/E03 Local run.md`)).toBe(true)
    expect(w.fs.exists(`${TREE}/vault/experiments/E03 Local run.md`)).toBe(false)
  })

  test('a link to a folder with no tree leaves RFT off, says why, and /rft-init starts nothing', async ($, on) => {
    mock.clock(on)
    const w = world(on, { [LINK]: JSON.stringify({ tree: '../flow-note' }) }, { cwd: REPO })
    const srv = fakeServer(on)
    await $.session.start({ cwd: REPO, source: 'startup' } as never)
    expect(w.tools).toEqual([])
    expect(w.toasts.join()).toContain(`${LINK} links to /phd/flow-note, which holds no reasoning tree`)
    expect((await $.command.run(RUN(''))).text).toContain('which holds no reasoning tree')
    expect(srv.seen).toHaveLength(0)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ text: /which holds no reasoning tree/ })).toBeDefined()
    await ui.unmount()
    expect((await $.command.run(INIT('Q'))).text).toContain('does not start a second tree')
    expect([...w.fs.files.keys()]).toEqual([LINK])
  })

  test('after a /clear the pane still shows the linked tree and follows it', async ($, on) => {
    const clock = mock.clock(on)
    const w = world(on, linked(), { cwd: REPO })
    on('session.end', () => ({ sessionId: 'test' }) as never)
    on('classic.SessionStart', () => ({}) as never)
    await $.session.start({ cwd: REPO, source: 'startup' } as never)
    // a /clear ends the session and goes on in a fresh one, with no session.start
    await $.session.end({ reason: 'clear' } as never)
    await $.classic.SessionStart({ source: 'clear' } as never)
    w.fs.write(`${TREE}/vault/directions/D02 New idea.md`, demoFiles()[`vault/directions/${D01}.md`]!
      .replace('id: D01', 'id: D02').replace('"[[E01 First check]]"', `"[[${E02}]]"`))
    await clock.advance(5000)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ text: /not active/ })).toBeUndefined()
    expect(await ui.find({ text: /3 directions/ })).toBeDefined()
    await ui.unmount()
  })

  test('/rft-init in a linked folder starts no second tree and says which tree the folder uses', async ($, on) => {
    mock.clock(on)
    const w = world(on, linked(), { cwd: REPO })
    await $.session.start({ cwd: REPO, source: 'startup' } as never)
    const res = await $.command.run(INIT('Another question'))
    expect(res.text).toContain(`works on the reasoning tree in ${TREE} (linked by ${LINK})`)
    expect([...w.fs.files.keys()].filter(k => k.startsWith('/phd/code/'))).toEqual([LINK])
  })
})

describe('locked notes', () => {
  const E02_PATH = `vault/experiments/${E02}.md`

  /** The demo project with `locked` notes, and the session's dialog answered by `answer.value` (null: dismissed): the questions it asked. */
  async function lockedSession($: Engine, on: On, locked: string[], first: string | null) {
    mock.clock(on)
    const files = demoFiles()
    for (const p of locked) files[p] = files[p]!.replace('\n---\n', '\nlocked: true\n---\n')
    const w = world(on, files)
    const asked: string[] = []
    const answer = { value: first }
    on('tool.call', (_$, e) => {
      if (e.tool !== 'AskUserQuestion') return { result: 'ok', text: 'ok' } as never
      const q = (e as unknown as { questions: { question: string; options: { label: string }[] }[] }).questions[0]!
      asked.push(`${q.question} [${q.options.map(o => o.label).join(' | ')}]`)
      if (answer.value === null) return { deny: 'The user dismissed the dialog' } as never
      return { result: { questions: [q], answers: { [q.question]: answer.value } }, text: `"${q.question}"="${answer.value}"` } as never
    })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    return { w, asked, answer }
  }

  test('moving a locked note asks the user, in the session; it moves, unlocked, when they agree', async ($, on) => {
    const { w, asked } = await lockedSession($, on, [E02_PATH], 'Move and unlock')
    const res = await $.tool.call({ tool: 'mcp__rft__rft_move_node', id: 'E02', parent: 'E01' } as never)
    expect(asked).toEqual([`${E02} is locked. Moving it unlocks it and adds a line to its History. Move it anyway? [Move and unlock | Keep it locked]`])
    expect(res.text).toContain(`Moved ${E02} from ${D01} to ${E01}.`)
    expect(res.text).toContain(`${E02} is unlocked now: the user agreed.`)
    expect(isLocked(w.fs.read(E02_PATH))).toBe(false)
    expect(w.fs.read(E02_PATH)).toContain(`## History\n- ${today()}: moved from [[${D01}]] to [[${E01}]]`)
  })

  test('a locked note the user keeps locked does not move, whatever Claude passes', async ($, on) => {
    const { w, asked, answer } = await lockedSession($, on, [E02_PATH], null)
    const before = texts(w.fs)
    // a move refused for another reason asks nothing
    const there = await $.tool.call({ tool: 'mcp__rft__rft_move_node', id: 'E02', parent: 'D01' } as never)
    expect(there.text).toContain('is already under')
    expect(asked).toEqual([])
    // dismissed, kept, or another answer typed under Other; Claude's own unlock: true is not the user's yes
    for (const reply of [null, 'Keep it locked', 'Move and unlock, please']) {
      answer.value = reply
      const res = await $.tool.call({ tool: 'mcp__rft__rft_move_node', id: 'E02', parent: 'E01', unlock: true } as never)
      expect({ reply, error: res.isError, text: res.text }).toEqual({ reply, error: true, text: `${E02} is locked and the user kept it locked: it was not moved. Do not try again unless the user asks.` })
    }
    expect(asked).toHaveLength(3)
    expect(texts(w.fs)).toEqual(before)
  })

  test('locked parents and children of a moved note ask nothing and stay locked; a supersede mark asks', async ($, on) => {
    const near = [`vault/experiments/${E01}.md`, `vault/directions/${D00}.md`, E02_PATH]
    const { w, asked } = await lockedSession($, on, near, 'Mark and unlock')
    const moved = await $.tool.call({ tool: 'mcp__rft__rft_move_node', id: 'D01', parent: 'D00' } as never)
    expect(moved.text).toContain(`Moved ${D01} and the 1 note(s) below it from ${E01} to ${D00}.`)
    expect(asked).toEqual([])
    for (const p of near) expect({ p, locked: isLocked(w.fs.read(p)) }).toEqual({ p, locked: true })
    const marked = await $.tool.call({ tool: 'mcp__rft__rft_supersede', id: 'E02', by: 'E01', why: 'a cleaner rerun' } as never)
    expect(asked).toEqual([`${E02} is locked. Marking it as superseded unlocks it and adds a line to its History. Mark it anyway? [Mark and unlock | Keep it locked]`])
    expect(marked.text).toContain(`${E02} is marked as superseded by ${E01}`)
    expect(marked.text).toContain(`${E02} is unlocked now: the user agreed.`)
    expect(isLocked(w.fs.read(E02_PATH))).toBe(false)
    expect(w.fs.read(E02_PATH)).toContain(`superseded by [[${E01}]] (a cleaner rerun)`)
  })
})
