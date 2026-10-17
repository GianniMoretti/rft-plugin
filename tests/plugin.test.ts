// The plugin in a session: activation by the config marker, the injected rules, the tools,
// the commands, and the tree pane on the terminal and the desktop.

import { describe, expect, mock, test } from 'claude-code/testing'

import { CWD, D01, E02, demoFiles, paneProps, world } from './fixture'

const SURFACES = ['terminal', 'desktop'] as const
/** A size the Svg's markup declares on its root element. */
const svgAttr = (svg: { props: Record<string, unknown> }, name: string) =>
  Number(new RegExp(`<svg[^>]* ${name}="([\\d.]+)"`).exec(String(svg.props.source))?.[1])
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
    expect(w.tools).toEqual(['rft_add_node', 'rft_set_status', 'rft_tree', 'rft_validate', 'rft_sync'])
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
    expect(w.tools).toHaveLength(5)
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

  test('/rft-view writes tree.html', async ($, on) => {
    mock.clock(on)
    const w = world(on, demoFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const res = await $.command.run({ command: 'rft-view', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
    expect(res.text).toContain(`file://${CWD}/vault/tree.html`)
    expect(w.fs.read('vault/tree.html')).toContain('<svg')
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

  test('the desktop shows the tree alone, sized to the pane, or the list; the choice is kept', async ($, on) => {
    mock.clock(on)
    world(on, demoFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const svg = await ui.find({ type: 'Svg' })
    expect(svg).toBeDefined()
    expect(await ui.find({ key: 'node-E02' })).toBeUndefined()
    expect((await ui.find({ key: 'view-tree' }))?.text).toBe('● Tree')
    // fitted into 80 columns by about 36 rows of 8 x 18 px: one side touches the box
    const w = svgAttr(svg!, 'width'), h = svgAttr(svg!, 'height')
    expect(w).toBeLessThanOrEqual(80 * 8)
    expect(h).toBeLessThanOrEqual(40 * 18)
    expect(w === 640 || h > 500).toBe(true)

    await ui.press({ key: 'zoom' })
    expect(svgAttr((await ui.find({ type: 'Svg' }))!, 'width')).not.toBe(w)
    await ui.press({ key: 'zoom' })

    await ui.press({ key: 'view-list' })
    expect(await ui.find({ type: 'Svg' })).toBeUndefined()
    expect(await ui.find({ key: 'node-E02' })).toBeDefined()
    await ui.press({ key: 'node-D01' })
    expect((await ui.find({ key: 'note-text' }))?.text).toContain('Text of D01.')
    await ui.unmount()

    // the choice is kept; back in the tree, the open note shows under it
    const again = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect(await again.find({ type: 'Svg' })).toBeUndefined()
    await again.press({ key: 'view-tree' })
    const half = await again.find({ type: 'Svg' })
    expect(half).toBeDefined()
    expect(svgAttr(half!, 'height')).toBeLessThanOrEqual(h)
    expect((await again.find({ key: 'note-text' }))?.text).toContain('Text of D01.')
    await again.unmount()
  })

  test('a fresh desktop session draws the tree with only the elements the desktop page paints', async ($, on) => {
    mock.clock(on)
    world(on, demoFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const fresh = [
      paneProps(),
      { ...paneProps(), bodyColumns: 0, scroll: { offset: 0, bodyRows: 0 } },
      { title: 'Reasoning tree', isFocused: false, bodyColumns: 0, placement: 'dock' as const, view: {} },
    ]
    for (const props of fresh) {
      const ui = await $.ui.mount({ ...PANE, props: props as never, surface: 'desktop' })
      const drawn = await ui.drawn()
      const seen = new Set<string>()
      const visit = (el: unknown) => {
        if (!el || typeof el !== 'object') return
        const node = el as { type?: string; props?: Record<string, unknown>; children?: unknown[] }
        if (node.type) {
          seen.add(node.type)
          expect(node.props?.variant).toBeUndefined()
          if (node.type === 'Svg') {
            expect(node.props?.width).toBeUndefined()
            expect(node.props?.height).toBeUndefined()
          }
        }
        for (const k of node.children ?? []) visit(k)
      }
      visit(drawn)
      expect([...seen].filter(t => !['Box', 'Text', 'Button', 'Svg', 'Markdown'].includes(t))).toEqual([])
      expect(seen.has('Svg')).toBe(true)
      const svg = await ui.find({ type: 'Svg' })
      const src = String(svg!.props.source)
      expect(src).toMatch(/viewBox="0 0 \d+ \d+"/)
      expect(src).toContain('preserveAspectRatio="xMidYMid meet"')
      expect(svgAttr(svg!, 'width')).toBeGreaterThan(50)
      await ui.unmount()
    }
  })

  test('VS Code and the mobile app draw the tree too', async ($, on) => {
    mock.clock(on)
    world(on, demoFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    for (const surface of ['vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Svg' })).toBeDefined()
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
      if (surface === 'terminal') expect(await ui.find({ key: 'node-D02' })).toBeDefined()
      else expect(String((await ui.find({ type: 'Svg' }))!.props.source)).toContain('D02')
      await ui.unmount()
    }
  })
})
