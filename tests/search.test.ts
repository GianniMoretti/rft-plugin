// Full-text search over the notes: ranking, prefixes, filters, snippets.

import { describe, expect, test } from 'claude-code/testing'

import { addNode, setConcept } from '../hooks/lib/ops'
import { search, searchReport, words } from '../hooks/lib/search'
import { load, readConfig, withoutChildren } from '../hooks/lib/vault'
import { MemoryFs, demoFiles } from './fixture'

const loaded = async () => {
  const fs = new MemoryFs(demoFiles())
  const io = fs.io()
  const l = await load(io, (await readConfig(io))!)
  await addNode(io, l, { type: 'experiment', title: 'Label smoothing sweep', parent: 'D01', date: '2026-02-03', tags: ['regularisation'],
    sections: { What: 'Smoothing 0.05 to 0.2 on the small split.', Result: 'Calibration error drops by half; accuracy unchanged.' } })
  await addNode(io, l, { type: 'direction', title: 'Augmentation alone', parent: 'E01', date: '2026-02-02',
    sections: { Idea: 'Strong augmentations might be enough without smoothing.' } })
  await setConcept(io, l, 'D01', 'Better variants')
  return l
}

describe('search', () => {
  test('a footnote after the children list is searched; the children links are not', async () => {
    const files = demoFiles()
    const path = Object.keys(files).find(k => k.includes('/E01 '))!
    files[path] = `${files[path]!.trimEnd()}\n\n[^1]: Checked against the zebrafish protocol.\n`
    const io = new MemoryFs(files).io()
    const l = await load(io, (await readConfig(io))!)
    expect(search(l, 'zebrafish')[0]?.id).toBe('E01')
    // D01 is only a child link of E01: not a match for E01
    expect(search(l, 'better variant').map(h => h.id)).not.toContain('E01')
    expect(withoutChildren('a\n## Children in the tree\n- [[x]]\n\n[^1]: note\n')).toBe('a\n[^1]: note\n')
  })

  test('words: lowercase, accents and stop words out', () => {
    expect(words('The Café of Régularisation, v2!')).toEqual(['cafe', 'regularisation', 'v2'])
  })

  test('titles weigh most; every word found ranks first; the matching line is the snippet', async () => {
    const l = await loaded()
    const hits = search(l, 'smoothing calibration error')
    expect(hits[0]!.id).toBe('E03')
    expect(hits[0]!.heading).toBe('Result')
    expect(hits[0]!.snippet).toContain('Calibration error drops by half')
    expect(hits.map(h => h.id)).toContain('D02')
  })

  test('a word matches the longer words it starts', async () => {
    const l = await loaded()
    expect(search(l, 'augment').map(h => h.id)).toEqual(['D02'])
  })

  test('filters: type, status, concept by name or id, tag; filters alone list the newest', async () => {
    const l = await loaded()
    expect(search(l, 'smoothing', { type: 'direction' }).map(h => h.id)).toEqual(['D02'])
    expect(search(l, '', { concept: 'better variants' }).map(h => h.id)).toEqual(['E03', 'E02', 'D01'])
    expect(search(l, '', { concept: 'D01', status: 'running' }).map(h => h.id)).toEqual(['E02'])
    expect(search(l, '', { tag: 'regularisation' }).map(h => h.id)).toEqual(['E03'])
    expect(searchReport(l, 'nothing like this')).toBe('No note matches "nothing like this".')
    expect(searchReport(l, 'smoothing', {}, 1)).toContain('(planned, ← D01, Better variants)')
  })
})
