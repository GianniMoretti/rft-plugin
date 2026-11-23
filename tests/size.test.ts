// What every request of a session carries of the plugin: the session's rules and the schemas of
// the tools in the prompt. Each has a ceiling here, a little over its size when it was last set,
// so that it grows by a decision taken in this file and not by drift. In characters (about 3.5 to
// a token): in a session of 300 requests, 1,000 characters more cost what 85,000 tokens read
// from the cache do. A text that outgrows its ceiling first loses what a tool's schema or answer
// already says; the ceiling is raised only for what nothing else says.

import { expect, mock, test } from 'claude-code/testing'

import { rulesText } from '../hooks/lib/ops'
import { CORE_TOOLS, FEATURE_TOOLS, eagerTools } from '../hooks/lib/tools'
import type { Feature } from '../hooks/lib/tools'
import { load, readConfig } from '../hooks/lib/vault'
import { CWD, MemoryFs, demoFiles, world } from './fixture'

const FEATURES = Object.keys(FEATURE_TOOLS) as Feature[]

/** The most characters of the rules without any feature, the map or the tree. */
const RULES_CORE = 8400
/** The most each feature's rule adds. */
const RULE: Record<Feature, number> = {
  dates: 700, priorities: 450, verify: 550, locks: 600, comments: 330, artifacts: 680, notebooks: 1100, queue: 1250, manuscript: 980, handoff: 300,
}
/** The most characters of the core tools' schemas, and of those each feature brings. */
const EAGER_CORE = 9400
const EAGER: Record<Feature, number> = {
  dates: 0, priorities: 0, verify: 0, locks: 1050, comments: 2600, artifacts: 2550, notebooks: 3950, queue: 3100, manuscript: 2950, handoff: 1100,
}
/** The most characters of one tool, name, description and schema. */
const ONE_TOOL = 3700

/** What is over its ceiling, as lines a failure shows. */
const over = (sizes: [string, number, number][]) => sizes.filter(([, size, max]) => size > max).map(([what, size, max]) => `${what}: ${size} characters, over its ceiling of ${max}`)

test('the session rules stay under their ceilings, with and without each feature', async () => {
  const io = new MemoryFs(demoFiles()).io()
  const l = await load(io, (await readConfig(io))!)
  const size = (f: Feature[]) => rulesText(l.tree, l.config, 'vault', {}, '', new Set(f)).length
  const none = size([])
  const sizes: [string, number, number][] = [['the rules without any feature', none, RULES_CORE]]
  for (const f of FEATURES) sizes.push([`the rule on ${f}`, size([f]) - none, RULE[f]])
  expect(over(sizes)).toEqual([])
  // with every feature the short line on what is the user's is gone, so the sum is a ceiling of the whole
  expect(size(FEATURES)).toBeLessThanOrEqual(RULES_CORE + FEATURES.reduce((sum, f) => sum + RULE[f], 0))
})

test('the schemas of the tools in the prompt stay under their ceilings', async ($, on) => {
  mock.clock(on)
  // a machine paired with the queue, so its tools are registered too
  const w = world(on, { ...demoFiles(), 'vault/.queue/machine.json': JSON.stringify({ version: 1, host: 'lab-pc' }) })
  await $.session.start({ cwd: CWD, source: 'startup' } as never)
  const one = (name: string) => {
    const spec = w.specs[name]
    if (!spec) throw new Error(`${name} was not registered`)
    return JSON.stringify({ name, description: spec.description, input_schema: spec.inputSchema }).length
  }
  const sum = (names: readonly string[]) => names.reduce((total, name) => total + one(name), 0)
  const sizes: [string, number, number][] = [['the core tools', sum(CORE_TOOLS), EAGER_CORE]]
  for (const f of FEATURES) sizes.push([`the tools ${f} brings`, sum(FEATURE_TOOLS[f]), EAGER[f]])
  for (const name of Object.keys(w.specs)) sizes.push([name, one(name), ONE_TOOL])
  expect(over(sizes)).toEqual([])
  // every feature at once: rft_suggest is brought by two of them and counted once
  const all = sum([...eagerTools(new Set(FEATURES))])
  expect(all).toBeLessThanOrEqual(EAGER_CORE + FEATURES.reduce((total, f) => total + EAGER[f], 0) - one('rft_suggest'))
  expect(Object.keys(w.specs)).toHaveLength(44)
})
