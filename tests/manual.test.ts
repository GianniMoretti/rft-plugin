// The manual in parts: how the rules and the commands' prompts cite a part, so that one Read
// brings it and no session carries the whole manual. The files themselves (the core's index, the
// parts, their sizes, every tool named in one of them) are held by tests/test_manual.py, which
// can read them.

import { expect, test } from 'claude-code/testing'

import { PARTS, cite, manualDir } from '../hooks/lib/manual'
import { rulesText } from '../hooks/lib/ops'
import { load, readConfig } from '../hooks/lib/vault'
import { MemoryFs, demoFiles } from './fixture'

test('a part is cited by its file, in the manual\'s folder when the text knows it', () => {
  expect(manualDir('/opt/plugins/rft/')).toBe('/opt/plugins/rft/skills/rft-manual')
  expect(cite('/opt/plugins/rft/skills/rft-manual', 'literature')).toBe('the manual\'s /opt/plugins/rft/skills/rft-manual/literature.md')
  expect(cite('/m', 'map', 'Restructuring the tree')).toBe('the manual\'s "Restructuring the tree" (/m/map.md)')
  expect(cite(undefined, 'queue')).toBe('the manual\'s queue.md')
})

test('the session rules name the manual\'s folder and its parts, and ask for one part at a time', async () => {
  const io = new MemoryFs(demoFiles()).io()
  const l = await load(io, (await readConfig(io))!)
  const line = (rules: string) => rules.split('\n').find(x => x.startsWith('- The manual is in parts'))
  const here = line(rulesText(l.tree, l.config, 'vault', { manual: '/opt/plugins/rft/skills/rft-manual' }, ''))!
  expect(here).toContain('in /opt/plugins/rft/skills/rft-manual/: SKILL.md (the rft-manual skill) is its core')
  for (const part of PARTS) expect(here).toContain(part)
  expect(here).toContain('Read only the part the work needs')
  // with no folder known the parts are still named
  expect(line(rulesText(l.tree, l.config, 'vault', {}, ''))).toContain('- The manual is in parts: SKILL.md')
})
