// Answers within their limit: what a tool answers is sent again with every later request of the
// conversation, so on a vault of hundreds of notes no answer may grow with it. A cut answer says
// what was left out and how to ask for it.

import { describe, expect, test } from 'claude-code/testing'

import { artifactReport, setArtifact } from '../hooks/lib/artifacts'
import { ANSWER_LIMIT, ARTIFACT_LIMIT, ceiling, fitList } from '../hooks/lib/fit'
import { nextReport } from '../hooks/lib/knowledge'
import { mapReport } from '../hooks/lib/map'
import { addNode, setConcept } from '../hooks/lib/ops'
import { searchReport } from '../hooks/lib/search'
import { load, readConfig } from '../hooks/lib/vault'
import { MemoryFs, demoFiles } from './fixture'

const words = (word: string, chars: number) => `${word} `.repeat(Math.ceil(chars / (word.length + 1))).slice(0, chars).trim()

/** The demo vault with a concept of 60 experiments under D01: summaries of 200 characters, Results of 1,500. */
const big = async () => {
  const fs = new MemoryFs(demoFiles())
  const io = fs.io()
  const l = await load(io, (await readConfig(io))!)
  await setConcept(io, l, 'D01', 'Better variants')
  const ids: string[] = []
  for (let k = 0; k < 60; k++) {
    const n = await addNode(io, l, { type: 'experiment', title: `Variant run number ${k}`, parent: 'D01', date: '2026-02-01', status: k % 3 ? 'running' : 'planned', summary: words(`variant${k}`, 200), sections: { Result: words(`gap${k}`, 1500) } })
    ids.push(n.id)
  }
  return { fs, io, l, ids }
}

describe('fit: a list and an answer within a limit', () => {
  test('a list is whole while it fits, then its lines are cut short, then the list', () => {
    const lines = Array.from({ length: 10 }, (_, k) => `${k} ${'x'.repeat(98)}`)
    expect(fitList(lines, 2000)).toEqual({ lines, width: null, left: 0 })
    const narrow = fitList(lines, 810)
    expect(narrow.left).toBe(0)
    expect(narrow.width).toBe(80)
    expect(narrow.lines.every(l => l.length === 80 && l.endsWith('…'))).toBe(true)
    const short = fitList(lines, 200)
    expect(short.lines.length).toBe(3)
    expect(short.left).toBe(7)
  })

  test('an answer over its limit stops at a whole line and says what was left out and how to ask for it', () => {
    const text = Array.from({ length: 400 }, (_, k) => `line ${k} ${'y'.repeat(40)}`).join('\n')
    expect(ceiling('rft_tree', 'short')).toBe('short')
    const cut = ceiling('rft_tree', text)
    expect(cut.length).toBeLessThanOrEqual(ANSWER_LIMIT)
    expect(cut).toMatch(/… cut here, at this answer's limit of 8000 characters: \d+ more line\(s\), \d+ characters\. Give root and depth for one branch/)
    expect(text.startsWith(cut.split('\n… cut here')[0]!)).toBe(true)
  })
})

describe('fit: the answers that grew with the vault', () => {
  test('rft_map, rft_next and rft_search stay under the limit on a concept of 60 notes', async () => {
    const { io, l } = await big()
    const concept = await mapReport(io, l, 'Better variants')
    expect(concept.length).toBeLessThanOrEqual(ANSWER_LIMIT)
    expect(concept).toContain('Variant run number 59')
    expect(concept).toMatch(/The lines above are cut at \d+ characters to keep this answer under its limit: rft_search gives a note's summary whole\./)
    expect(concept).toContain('more than a digest stands for (40)')
    expect((await mapReport(io, l)).length).toBeLessThanOrEqual(ANSWER_LIMIT)
    expect((await nextReport(io, l, '2026-03-01')).length).toBeLessThanOrEqual(ANSWER_LIMIT)
    const found = searchReport(l, 'variant run', {}, 50)
    expect(found.length).toBeLessThanOrEqual(ANSWER_LIMIT)
    expect(found).toContain('to keep this answer under its limit')
    // a small answer is as it was
    expect(searchReport(l, 'variant run', {}, 3)).not.toContain('under its limit')
  })

  test('rft_artifact gives the results that fit, names the rest, and gives those with notes', async () => {
    const { io, l, ids } = await big()
    const first = await artifactReport(io, l, 'D01')
    expect(first.length).toBeLessThanOrEqual(ARTIFACT_LIMIT)
    const held = /Not given here, over this answer's limit of 12000 characters \((\d+)\): /.exec(first)
    expect(Number(held![1])).toBeGreaterThan(30)
    expect(first).toContain('rft_artifact with notes: [')
    // the rules for writing the page are still there, after the results
    expect(first).toContain('PDF download')
    const last = ids[ids.length - 1]!
    expect(first).not.toContain('gap59 gap59')
    const asked = await artifactReport(io, l, 'D01', { notes: [last] })
    expect(asked).toContain('gap59 gap59')
    expect(asked).not.toContain('PDF download')
    await expect(artifactReport(io, l, 'D01', { notes: ['E01'] })).rejects.toThrow('not an experiment with a result')
  })

  test('once the page is written: its outline, the unchanged results by id, one part on request', async () => {
    const { io, l, ids } = await big()
    const body = words('prose', 9000)
    const html = `<h1>Better variants</h1>\n<p>Lead.</p>\n<h2>Gap by size</h2>\n<p>${ids.map(id => `<a href="#${id}">${id}</a>`).join(' ')} <a href="#E02">E02</a></p>\n<h2>Long &amp; detailed</h2>\n<p>${body}</p>\n<h3>Seeds</h3>\n<p>Five.</p>\n`
    await setArtifact(io, l, 'D01', { html }, '2026-03-01')
    Object.assign(l, await load(io, l.config))
    const got = await artifactReport(io, l, 'D01')
    expect(got.length).toBeLessThan(5000)
    expect(got).toContain('up to date')
    expect(got).toMatch(/On the page now \(\d+\.\dk characters\), its parts by heading, each with its size:\n1\. Better variants \(.*\)\n  2\. Gap by size \(.*\)\n  3\. Long & detailed \(9\.\dk\)\n    4\. Seeds \(\d+\)/)
    // the 40 that run have a result, the 20 planned have none
    expect(got).toContain(`Unchanged since the page was written (41), on it already: E02, ${ids[1]}, ${ids[2]}, ${ids[4]}`)
    expect(got).toContain('Without a result yet (20): ')
    expect(got).not.toContain('gap0 gap0')
    // a part as it is written, by number or by heading
    const part = await artifactReport(io, l, 'D01', { section: 'gap by size' })
    expect(part).toContain(`<h2>Gap by size</h2>\n<p><a href="#${ids[0]}">${ids[0]}</a>`)
    expect(part).not.toContain('<h2>Long')
    expect(await artifactReport(io, l, 'D01', { section: '4' })).toContain('<h3>Seeds</h3>\n<p>Five.</p>')
    // a part over the limit is cut, and says where the file goes on (the page's line 6; the file's first line is its header)
    const long = await artifactReport(io, l, 'D01', { section: '3', limit: 4000 })
    expect(long.length).toBeLessThanOrEqual(4000)
    expect(long).toMatch(/… cut here, at this answer's limit of 4000 characters: \d+ more of this part\. .* from line 7\./)
    await expect(artifactReport(io, l, 'D01', { section: 'nowhere' })).rejects.toThrow('no part of the page is headed "nowhere". Its headings: 1. Better variants; 2. Gap by size')
  })

  test('a page up to a third of the limit is given whole, as it is written, in place of its outline', async () => {
    const { io, l, ids } = await big()
    const page = (chars: number) => { const open = '<h1>Better variants</h1>\n<p>Lead.</p>\n\n\n<h2>Gap by size</h2>\n<p>'; return `${open}${'x'.repeat(chars - open.length - 4)}</p>` }
    const report = async (html: string) => {
      await setArtifact(io, l, 'D01', { html: `${html}\n` }, '2026-03-01')
      Object.assign(l, await load(io, l.config))
      return artifactReport(io, l, 'D01')
    }
    const third = Math.floor(ARTIFACT_LIMIT / 3)
    const short = page(third)
    const got = await report(short)
    // its blank lines too: an edit's old_str is taken from it
    expect(got).toContain(`On the page now (4.0k characters), whole and as it is written, for an edit's old_str: no need to read the file.\n${short}\n\nExperiments with a result (41):`)
    expect(got).not.toContain('its parts by heading')
    expect(got.length).toBeLessThanOrEqual(ARTIFACT_LIMIT)
    expect(got).toContain('PDF download')
    // results asked for by id come without the page, and a part of it can still be asked for
    expect(await artifactReport(io, l, 'D01', { notes: [ids[1]!] })).not.toContain('On the page now')
    expect(await artifactReport(io, l, 'D01', { section: '2' })).toContain('<h2>Gap by size</h2>\n<p>xxx')
    // one character more: its outline
    const long = await report(page(third + 1))
    expect(long).toContain('On the page now (4.0k characters), its parts by heading, each with its size:\n1. Better variants (4.0k)\n  2. Gap by size (4.0k)')
    expect(long).not.toContain('xxx')
  })
})
