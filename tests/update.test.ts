// /rft-update: a vault an older version made gets what it lacks (folders, templates, the config's
// format, optionally the sections its notes' types have gained), and nothing else changes.

import { describe, expect, mock, test } from 'claude-code/testing'

import { applyUpdate, behindLine, planText, planUpdate, withSections } from '../hooks/lib/update'
import { FORMAT, TEMPLATES, load, readConfig } from '../hooks/lib/vault'
import { CWD, E02, MemoryFs, demoFiles, world } from './fixture'

/** The demo vault as the first format had it. */
const oldFiles = () => {
  const files = demoFiles()
  files['.rft/config.json'] = JSON.stringify({ ...JSON.parse(files['.rft/config.json']!), version: 1 })
  return files
}

const open = async (files: Record<string, string>) => {
  const fs = new MemoryFs(files)
  const io = fs.io()
  return { fs, io, loaded: await load(io, (await readConfig(io))!) }
}

describe('update', () => {
  test('an old vault: the missing folders and templates, an outdated template, the format; the notes untouched', async () => {
    const files = oldFiles()
    files['vault/templates/_experiment.md'] = TEMPLATES.experiment('demo')
    files['vault/templates/_direction.md'] = 'an old template\n'
    const { fs, io, loaded } = await open(files)
    expect(loaded.config.version).toBe(1)
    const plan = await planUpdate(io, loaded)
    expect(plan.changes.map(c => c.what)).toEqual([
      'folder references/ for references',
      'folder theory/ for theory notes',
      'template of directions, to the current one',
      'template of references',
      'template of theory notes',
      `config: format 1 → ${FORMAT}`,
    ])
    expect(planText(plan, false)).toContain('/rft-update apply will write:')
    expect(behindLine(loaded.config)).toContain('older version (format 1, now')
    const before = Object.fromEntries(Object.keys(files).filter(k => k.endsWith('.md') && !k.includes('templates/')).map(k => [k, fs.read(k)]))
    await applyUpdate(io, plan)
    for (const [k, v] of Object.entries(before)) expect(fs.read(k)).toBe(v)
    expect(fs.read('vault/templates/_direction.md')).toBe(TEMPLATES.direction('demo'))
    expect(fs.read('vault/theory/.gitkeep')).toBe('')
    const config = JSON.parse(fs.read('.rft/config.json'))
    expect(config).toMatchObject({ version: FORMAT, project: 'demo', lastId: { E: 2, D: 1 } })
    // a second run has nothing to do
    const fresh = await load(io, (await readConfig(io))!)
    expect((await planUpdate(io, fresh)).changes).toEqual([])
    expect(planText(await planUpdate(io, fresh), false)).toContain(`up to date (format ${FORMAT})`)
    expect(behindLine(fresh.config)).toBeNull()
  })

  test('--sections adds each note\'s missing sections as empty headings, before its children, never in a locked note', async () => {
    const files = demoFiles()
    const path = `vault/experiments/${E02}.md`
    files[path] = files[path]!.replace('---\n\n#', 'locked: true\n---\n\n#')
    const { io, loaded } = await open(files)
    const plan = await planUpdate(io, loaded, { sections: true })
    expect(plan.locked).toEqual(['E02'])
    const notes = plan.changes.filter(c => / section/.test(c.what))
    expect(notes.length).toBeGreaterThan(0)
    for (const c of notes) {
      const heads = [...c.text.matchAll(/^## (.+)$/gm)].map(m => m[1])
      expect(heads.at(-1)).toBe('Children in the tree')
    }
    expect(planText(plan, true)).toContain('Locked, left as they are: E02.')
    const t = '# x\n\n## What\nRan it.\n\n## Children in the tree\n- [[a]]\n'
    const r = withSections(t, ['What', 'Why', 'Result'])
    expect(r.added).toEqual(['Why', 'Result'])
    expect(r.text).toBe('# x\n\n## What\nRan it.\n\n## Why\n\n## Result\n\n## Children in the tree\n- [[a]]\n')
    expect(withSections(r.text, ['What', 'Why', 'Result']).added).toEqual([])
  })

  test('a vault from a newer plugin is left alone', async () => {
    const files = demoFiles()
    files['.rft/config.json'] = JSON.stringify({ ...JSON.parse(files['.rft/config.json']!), version: FORMAT + 1 })
    const { io, loaded } = await open(files)
    const plan = await planUpdate(io, loaded)
    expect(planText(plan, false)).toContain('newer than this plugin')
    expect(behindLine(loaded.config)).toContain('update the plugin')
  })

  test('/rft-update shows the plan; apply writes it and syncs; a new vault has nothing to do', async ($, on) => {
    mock.clock(on)
    const w = world(on, oldFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(w.toasts.some(t => t.includes('/rft-update shows what it adds'))).toBe(true)
    const run = (args: string) => $.command.run({ command: 'rft-update', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
    expect((await run('now')).text).toContain('Usage')
    const shown = (await run('')).text
    expect(shown).toContain('template of theory notes')
    expect(w.fs.exists('vault/theory/.gitkeep')).toBe(false)
    const done = (await run('apply')).text
    expect(done).toContain(`Updated the vault to format ${FORMAT}`)
    expect(w.fs.read('vault/theory/.gitkeep')).toBe('')
    expect((await run('')).text).toContain('up to date')
  })
})
