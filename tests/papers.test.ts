// Papers behind reference notes: the source a PDF can come from, the concept folder, and the
// plan the background downloader runs.

import { describe, expect, test } from 'claude-code/testing'

import { addNode, setConcept } from '../hooks/lib/ops'
import { folderName, paperSource, planPapers } from '../hooks/lib/papers'
import { load, readConfig, setField } from '../hooks/lib/vault'
import { MemoryFs, demoFiles } from './fixture'

const loadDemo = async () => {
  const fs = new MemoryFs(demoFiles())
  const io = fs.io()
  return { fs, io, loaded: await load(io, (await readConfig(io))!) }
}

describe('papers', () => {
  test('an arXiv id or link, or a PDF on an open-access host; nothing from elsewhere', () => {
    expect(paperSource('## Source\nhttps://arxiv.org/abs/2101.00001v2\n')).toEqual({ arxiv: '2101.00001v2' })
    expect(paperSource('## Source\narXiv: 1710.09412, ICLR 2018\n')).toEqual({ arxiv: '1710.09412' })
    expect(paperSource('## Source\nhttps://arxiv.org/pdf/hep-th/9901001.pdf\n')).toEqual({ arxiv: 'hep-th/9901001' })
    expect(paperSource('## Source\n[PDF](https://proceedings.mlr.press/v97/a19a/a19a.pdf).\n')).toEqual({ url: 'https://proceedings.mlr.press/v97/a19a/a19a.pdf' })
    expect(paperSource('## Source\nhttps://openreview.net/pdf?id=abc\n')).toEqual({ url: 'https://openreview.net/pdf?id=abc' })
    expect(paperSource('## Source\nhttps://doi.org/10.1000/xyz and https://publisher.example/paper.pdf\n')).toBeNull()
    // only the Source section counts when there is one
    expect(paperSource('## Source\nA book.\n\n## Summary\nSee arXiv:2101.00001\n')).toBeNull()
  })

  test('the plan: fetch into the concept folder, move when the concept changed, say why the rest stays', async () => {
    const { fs, io, loaded } = await loadDemo()
    const a = await addNode(io, loaded, { type: 'reference', title: 'Mixup', parent: 'D01', date: '2026-02-01', sections: { Source: 'arXiv:1710.09412' } })
    const b = await addNode(io, loaded, { type: 'reference', title: 'A book', parent: 'D01', date: '2026-02-01', sections: { Source: 'A printed book.' } })
    await setConcept(io, loaded, 'D01', 'Better variants')
    let plan = planPapers(loaded)
    expect(plan.jobs).toEqual([{ op: 'fetch', id: a.id, arxiv: '1710.09412', dir: 'papers/Better variants', title: 'Mixup', year: '' }])
    expect(plan.skipped).toEqual([{ id: b.id, why: 'no arXiv id or open-access PDF link under Source' }])
    // saved: nothing to do; then the concept is renamed, and the file follows it
    const path = `vault/${a.path}`
    fs.write(path, setField(fs.read(path), 'pdf', '"[[papers/Better variants/2017 Zhang mixup.pdf]]"', 'tags'))
    const fresh = await load(io, loaded.config)
    expect(planPapers(fresh).saved).toEqual([a.id])
    await setConcept(io, fresh, 'D01', 'Variants: v2')
    plan = planPapers(fresh, [a.id, 'E01'])
    expect(plan.jobs).toEqual([{ op: 'move', id: a.id, from: 'papers/Better variants/2017 Zhang mixup.pdf', dir: 'papers/Variants v2' }])
    expect(plan.skipped).toEqual([{ id: 'E01', why: 'not a reference note' }])
    expect(folderName('  a/b: c?  ')).toBe('a b c')
  })
})
