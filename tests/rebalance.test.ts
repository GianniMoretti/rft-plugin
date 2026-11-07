// Cheaper rebalancing: the notes that sit closer to another concept than to their own, found by
// the plugin, and the /rft-rebalance prompt built from them.

import { describe, expect, mock, test } from 'claude-code/testing'

import { addNode, setConcept, setRefs } from '../hooks/lib/ops'
import { candidates, candidatesReport } from '../hooks/lib/rebalance'
import type { Io, Loaded } from '../hooks/lib/vault'
import { load, readConfig } from '../hooks/lib/vault'
import { CWD, MemoryFs, demoFiles, world } from './fixture'

const add = async (io: Io, l: Loaded, type: 'experiment' | 'direction' | 'reference', title: string, parent: string, summary: string) =>
  (await addNode(io, l, { type, title, parent, date: '2026-02-01', summary })).id

/** Two lines of research, and one augmentation experiment hung under the smoothing line. */
async function twoLines() {
  const fs = new MemoryFs(demoFiles())
  const io = fs.io()
  const l = await load(io, (await readConfig(io))!)
  const smooth = await add(io, l, 'direction', 'Label smoothing for calibration', 'E02', 'Does label smoothing improve calibration')
  await add(io, l, 'experiment', 'Smoothing sweep calibration', smooth, 'Label smoothing 0.05 to 0.2, calibration error halves')
  await add(io, l, 'experiment', 'Smoothing with temperature calibration', smooth, 'Label smoothing plus temperature scaling, calibration flat')
  const stray = await add(io, l, 'experiment', 'Mixup and cutmix augmentation', smooth, 'Mixup and cutmix strong augmentation, accuracy +2')
  const aug = await add(io, l, 'direction', 'Strong augmentation', 'E02', 'Strong augmentation: mixup, cutmix, randaugment')
  await add(io, l, 'experiment', 'Mixup alpha sweep augmentation', aug, 'Mixup augmentation alpha 0.2 to 1, accuracy +1.5')
  await add(io, l, 'experiment', 'Cutmix versus randaugment', aug, 'Cutmix and randaugment augmentation compared, cutmix best')
  await setConcept(io, l, smooth, 'Label smoothing')
  await setConcept(io, l, aug, 'Strong augmentation')
  return { io, l, smooth, stray, aug }
}

describe('rebalance', () => {
  test('a note closer to another concept is a candidate, with the concept and the nearest note there', async () => {
    const { l, smooth, stray, aug } = await twoLines()
    const list = candidates(l)
    expect(list.map(c => c.id)).toEqual([stray])
    expect(list[0]!.from).toBe(smooth)
    expect(list[0]!.to).toBe(aug)
    expect(list[0]!.toFit).toBeGreaterThan(list[0]!.fit)
    expect(['D03', 'E06', 'E07']).toContain(list[0]!.near)
    const text = candidatesReport(l, list)
    expect(text).toContain('E05 Mixup and cutmix augmentation — Mixup and cutmix strong augmentation, accuracy +2')
    expect(text).toContain('concept Label smoothing (D02)')
    expect(text).toContain('closer to Strong augmentation (D03)')
    // a scope keeps the candidates in it or going to it
    expect(candidates(l, { scope: 'Strong augmentation' }).map(c => c.id)).toEqual([stray])
    expect(candidates(l, { scope: 'E01' }).map(c => c.id)).toEqual([stray])
    expect(() => candidates(l, { scope: 'Nope' })).toThrow('not a concept or a note')
  })

  test('shared references pull a note towards a concept; one concept alone has no candidate', async () => {
    const { io, l, stray } = await twoLines()
    const gain = (c: { fit: number; toFit: number } | undefined) => (c ? c.toFit - c.fit : 0)
    const before = gain(candidates(l)[0])
    // the stray cites the smoothing line's paper: it fits there better, and is no longer a candidate
    const paper = await add(io, l, 'reference', 'Muller 2019 When does label smoothing help', 'D02', 'Smoothing and calibration')
    await setRefs(io, l, 'E03', [paper])
    await setRefs(io, l, 'E04', [paper])
    await setRefs(io, l, stray, [paper])
    const after = candidates(l).find(c => c.id === stray)
    expect(before - gain(after)).toBeGreaterThan(0.25)
    const fs = new MemoryFs(demoFiles())
    const one = await load(fs.io(), (await readConfig(fs.io()))!)
    expect(candidates(one)).toEqual([])
  })

  test('/rft-rebalance asks Claude to judge the candidates only', async ($, on) => {
    const clock = mock.clock(on)
    const files = demoFiles()
    const w = world(on, files)
    const prompts: string[] = []
    on('prompt.submit', (_$, e) => { prompts.push(String(e.text)); return { text: e.text } as never })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const io = w.fs.io()
    const l = await load(io, (await readConfig(io))!)
    // build the two lines in the session's vault
    const smooth = await add(io, l, 'direction', 'Label smoothing for calibration', 'E02', 'Does label smoothing improve calibration')
    await add(io, l, 'experiment', 'Smoothing sweep calibration', smooth, 'Label smoothing 0.05 to 0.2, calibration error halves')
    await add(io, l, 'experiment', 'Smoothing with temperature calibration', smooth, 'Label smoothing plus temperature scaling, calibration flat')
    await add(io, l, 'experiment', 'Mixup and cutmix augmentation', smooth, 'Mixup and cutmix strong augmentation, accuracy +2')
    const aug = await add(io, l, 'direction', 'Strong augmentation', 'E02', 'Strong augmentation: mixup, cutmix, randaugment')
    await add(io, l, 'experiment', 'Mixup alpha sweep augmentation', aug, 'Mixup augmentation alpha 0.2 to 1, accuracy +1.5')
    await add(io, l, 'experiment', 'Cutmix versus randaugment', aug, 'Cutmix and randaugment augmentation compared, cutmix best')
    await setConcept(io, l, smooth, 'Label smoothing')
    await setConcept(io, l, aug, 'Strong augmentation')
    const res = await $.command.run({ command: 'rft-rebalance', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
    expect(res.text).toContain('from the candidates the plugin found')
    await clock.advance(5000)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('1 candidate(s)')
    expect(prompts[0]).toContain('E05 Mixup and cutmix augmentation')
    expect(prompts[0]).toContain('Judge only these')
    expect(prompts[0]).toContain('Do not call rft_move_node until I say yes')
  })
})
