// The plugin in a session: activation by the config marker, the injected rules, the tools,
// the commands, and the tree pane on the terminal and the desktop.

import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { CWD, D01, E02, WEB_FILES, demoFiles, paneProps, world } from './fixture'

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
    expect(w.commands).toEqual(['rft', 'rft-init', 'rft-view'])
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
    expect(w.tools).toEqual(['rft_add_node', 'rft_set_status', 'rft_set_tags', 'rft_tags', 'rft_tree', 'rft_validate', 'rft_sync'])
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
    expect(w.commands).toEqual(['rft-init', 'rft-view'])
    expect(w.tools).toHaveLength(7)
    expect(w.opened).toEqual(['rft-tree'])
    expect(w.toasts.join()).toContain('/rft')
    const res = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    expect(res.sections.map(s => s.id)).toEqual(['rft:rules'])
  })

  test('no command takes the name of the plugin skill', async () => {
    // a plugin skill named <x> is the command /rft:<x>; the engine refuses a command of the same name
    expect(['rft', 'rft-init', 'rft-view']).not.toContain(SKILL)
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
    const w = world(on, { ...demoFiles(), ...WEB_FILES })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const res = await $.command.run({ command: 'rft-view', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
    expect(res.text).toContain(`file://${CWD}/vault/tree.html`)
    const html = w.fs.read('vault/tree.html')
    expect(html).not.toContain('data-rft-inline')
    expect(html).toContain('<style>body { color: red }</style>')
    expect(html).toContain('"$&"')
    expect(html).toContain('"<\\/script>"')
    expect(html).toContain('window.RFT_DATA = {"tree":{"project":"demo"')
    expect(html).toContain('Text of D01.')
    expect(html.indexOf('window.RFT_DATA')).toBeLessThan(html.indexOf('console.log(window.RFT_DATA'))
  })
})

/** The server child: says where it listens, then runs until the plugin ends the loop. */
function fakeServer(on: On, opts: { fail?: string[] } = {}) {
  const seen: string[][] = []
  const state = { isRunning: false }
  on('process.spawn', async function* (_$: unknown, e: { argv: readonly string[] }, next: { signal: AbortSignal }) {
    seen.push([...e.argv])
    if (opts.fail?.includes(e.argv[0]!)) throw new Error(`ENOENT: ${e.argv[0]}`)
    state.isRunning = true
    try {
      yield { stream: 'stdout' as const, text: 'RFT_SERVER_URL http://127.0.0.1:5555/\n' }
      // runs until the plugin ends the loop, which aborts this dispatch
      await new Promise(resolve => next.signal.addEventListener('abort', resolve))
      return { value: { code: null, signal: 'SIGTERM' } }
    } finally {
      state.isRunning = false
    }
  })
  return { seen, state }
}

const RUN = (args: string) => ({ command: 'rft', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } }) as never

describe('web view', () => {
  test('/rft starts the read-only server once, prints how to open it, and the pane shows the URL', async ($, on) => {
    mock.clock(on)
    world(on, demoFiles())
    const srv = fakeServer(on)
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const first = await $.command.run(RUN(''))
    expect(first.text).toContain('Tree view: http://127.0.0.1:5555/')
    expect(first.text).toContain('Ctrl+Shift+B')
    expect(first.text).toContain('ssh -L 5555:127.0.0.1:5555')
    expect(srv.seen).toHaveLength(1)
    const argv = srv.seen[0]!
    expect(argv[0]).toBe('python3')
    expect(argv[1]).toMatch(/server\/rft_server\.py$/)
    expect(argv.slice(2)).toEqual(['--vault', `${CWD}/vault`, '--web', expect.stringMatching(/\/web$/), '--project', 'demo', '--port', '0'])
    const again = await $.command.run(RUN(''))
    expect(again.text).toContain('http://127.0.0.1:5555/')
    expect(srv.seen).toHaveLength(1)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect((await ui.find({ type: 'Text', text: /^Tree view: / }))?.text).toBe('Tree view: http://127.0.0.1:5555/')
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
    expect(res.text).toContain('Tree view opened in the browser pane: http://127.0.0.1:5555/')
    expect(calls.map(c => c.tool)).toEqual(['tabs_context', 'preview_start'])
    expect(calls[1]!.args).toEqual({ url: 'http://127.0.0.1:5555/' })
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
    expect(calls[1]!.args).toEqual({ url: 'http://127.0.0.1:5555/', tabId: 'tab-7' })
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
    expect(res.text!.split('\n')[0]).toBe('Tree view: http://127.0.0.1:5555/')
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
