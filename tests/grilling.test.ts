// Grilling: what /rft-grill-me works out from the tree before Claude is asked anything (the case
// of the note named, what already sits under it, the directions that could be grilled) and the
// prompts it queues.

import { describe, expect, test } from 'claude-code/testing'

import { SECTIONS, caseOf, grillConceptPrompt, grillNotePrompt, grillQuestionPrompt, grillUsage, grillable, sectionsIn, underNote } from '../hooks/lib/grilling'
import { addNode } from '../hooks/lib/ops'
import { load, readConfig } from '../hooks/lib/vault'
import { D01, D00, MemoryFs, demoFiles } from './fixture'

const M = '/opt/rft/skills/rft-manual'
const D01_PATH = `vault/directions/${D01}.md`
const D00_PATH = `vault/directions/${D00}.md`

async function setup(change: (files: Record<string, string>) => void = () => {}) {
  const files = demoFiles()
  change(files)
  const fs = new MemoryFs(files)
  const io = fs.io()
  const l = await load(io, (await readConfig(io))!)
  return { fs, io, l }
}

const withStatus = (text: string, status: string) => text.replace(/^status: .*$/m, `status: ${status}`)
const withFront = (text: string, line: string) => text.replace(/^(status: .*)$/m, `$1\n${line}`)
const withSection = (text: string, heading: string, body: string) => text.replace('## Children in the tree', `## ${heading}\n${body}\n\n## Children in the tree`)

describe('the case of the note a grilling is asked for', () => {
  test('a direction at idea, planned or running is grilled in place', async () => {
    for (const status of ['idea', 'planned', 'running']) {
      const { l } = await setup(f => { f[D01_PATH] = withStatus(f[D01_PATH]!, status) })
      expect(caseOf(l.tree.nodes.D01!, l.texts.D01!)).toBe('in place')
    }
  })

  test('a direction that already has a section of a grilling is resumed', async () => {
    const { l } = await setup(f => { f[D01_PATH] = withSection(f[D01_PATH]!, 'Hypothesis', 'The variant beats the baseline by two points.') })
    expect(caseOf(l.tree.nodes.D01!, l.texts.D01!)).toBe('resume')
    expect(sectionsIn(l.texts.D01!)).toEqual(['Hypothesis'])
    // a heading with nothing under it is not an answer
    const empty = await setup(f => { f[D01_PATH] = withSection(f[D01_PATH]!, 'Scope', '') })
    expect(sectionsIn(empty.l.texts.D01!)).toEqual([])
    expect(caseOf(empty.l.tree.nodes.D01!, empty.l.texts.D01!)).toBe('in place')
  })

  test('a direction that is done, dropped, discussed, moved, in review or superseded is answered', async () => {
    for (const status of ['done', 'dropped', 'discussed', 'moved', 'review']) {
      const { l } = await setup(f => { f[D01_PATH] = withStatus(f[D01_PATH]!, status) })
      expect(caseOf(l.tree.nodes.D01!, l.texts.D01!)).toBe('answered')
    }
    const { l } = await setup(f => { f[D01_PATH] = withFront(f[D01_PATH]!, `superseded_by: "[[${D00}]]"`) })
    expect(caseOf(l.tree.nodes.D01!, l.texts.D01!)).toBe('answered')
  })

  test('a verified or locked note is locked, whatever its type and whatever it holds', async () => {
    const verified = await setup(f => { f[D01_PATH] = withSection(withStatus(f[D01_PATH]!, 'verified'), 'Hypothesis', 'x') })
    expect(caseOf(verified.l.tree.nodes.D01!, verified.l.texts.D01!)).toBe('locked')
    const locked = await setup(f => { f[D01_PATH] = withFront(f[D01_PATH]!, 'locked: true') })
    expect(caseOf(locked.l.tree.nodes.D01!, locked.l.texts.D01!)).toBe('locked')
  })

  test('an experiment, a reference or a theory note is another type', async () => {
    const { l } = await setup()
    expect(caseOf(l.tree.nodes.E02!, l.texts.E02!)).toBe('another type')
  })
})

describe('what already sits under the note', () => {
  test('its experiments and literature notes, with their status, however deep; not its directions', async () => {
    const { io, l } = await setup()
    const lit = await addNode(io, l, { type: 'reference', title: 'Literature on variants', parent: 'D01', date: '2026-02-01', tags: ['literature'], status: 'planned' })
    await addNode(io, await load(io, l.config), { type: 'direction', title: 'A side idea', parent: 'D01', date: '2026-02-01' })
    const fresh = await load(io, l.config)
    expect(underNote(fresh.tree, 'D01').map(n => `${n.id} ${n.status}`)).toEqual(['E02 running', `${lit.id} planned`])
    // from the root: E01, and what sits under D01 below it
    expect(underNote(fresh.tree, 'D00').map(n => n.id)).toEqual(['E01', 'E02', lit.id])
  })
})

describe('the directions that could be grilled', () => {
  test('those at idea or planned, not locked; the ones with no experiment under them first', async () => {
    const { io, l } = await setup()
    const bare = await addNode(io, l, { type: 'direction', title: 'No run yet', parent: 'D00', date: '2026-02-01', status: 'planned' })
    await addNode(io, await load(io, l.config), { type: 'direction', title: 'Given up', parent: 'D00', date: '2026-02-01', status: 'dropped' })
    const fresh = await load(io, l.config)
    expect(grillable(fresh.tree).map(n => n.id)).toEqual([bare.id, 'D01'])
    const text = grillUsage(fresh.tree)
    expect(text).toContain('Usage: /rft-grill-me <question, note id or concept>')
    expect(text.indexOf(bare.id)).toBeLessThan(text.indexOf('D01 A better variant'))
    expect(text).toContain('D01 A better variant (idea; under it: E02 running)')
    expect(text).not.toContain('Given up')
  })

  test('with none, the usage says so', async () => {
    const { l } = await setup(f => { f[D01_PATH] = withStatus(f[D01_PATH]!, 'done') })
    expect(grillable(l.tree)).toEqual([])
    expect(grillUsage(l.tree)).toContain('No direction is at idea or planned')
  })
})

describe('what a grilling asks of Claude', () => {
  const common = (p: string) => {
    expect(p).toContain(`${M}/grilling.md`)
    expect(p).toContain('each with the answer you recommend')
    expect(p).toContain('write only the grilled direction')
    expect(p).toContain('only the rows I confirm')
    expect(p).toContain('Write no code and queue nothing')
  }

  test('in place: the note is the grilled direction, and what is under it is refined, never doubled', async () => {
    const { l } = await setup()
    const n = l.tree.nodes.D01!
    const p = grillNotePrompt(M, n, 'in place', underNote(l.tree, 'D01'), [])
    common(p)
    expect(p).toContain(`Grill me on ${D01}`)
    expect(p).toContain('The grilled direction is this note')
    expect(p).toContain('E02 (running)')
    expect(p).toContain('add no second note for the same run or search')
    for (const s of SECTIONS) expect(p).toContain(s)
  })

  test('resume: what the note answers is settled and is not asked again', async () => {
    const { l } = await setup()
    const p = grillNotePrompt(M, l.tree.nodes.D01!, 'resume', [], ['Hypothesis', 'Open questions'])
    common(p)
    expect(p).toContain('already has its Hypothesis and Open questions')
    expect(p).toContain('do not ask it again')
    expect(p).toContain('start from its Open questions')
    // with no Open questions left, what is left is found from the subjects
    expect(grillNotePrompt(M, l.tree.nodes.D01!, 'resume', [], ['Hypothesis'])).toContain('which of the seven subjects')
  })

  test('answered: the tree is quoted first and nothing is written until the user says reopen', async () => {
    const { l } = await setup(f => { f[D01_PATH] = withStatus(f[D01_PATH]!, 'dropped') })
    const p = grillNotePrompt(M, l.tree.nodes.D01!, 'answered', [], [])
    expect(p).toContain(`${D01} is dropped`)
    expect(p).toContain('stop here, or reopen')
    expect(p).toContain('Write nothing until I answer')
    expect(p).toContain(`${M}/grilling.md`)
  })

  test('locked: the note is not edited; the grilled direction is a new one under it', async () => {
    const { l } = await setup(f => { f[D01_PATH] = withStatus(f[D01_PATH]!, 'verified') })
    const p = grillNotePrompt(M, l.tree.nodes.D01!, 'locked', [], [])
    common(p)
    expect(p).toContain(`${D01} is verified: do not edit it`)
    expect(p).toContain('a new direction under it')
    expect(p).toContain('rft_suggest')
    expect(p).not.toContain('The grilled direction is this note')
  })

  test('another type: the grilled direction comes out of the note', async () => {
    const { l } = await setup()
    const p = grillNotePrompt(M, l.tree.nodes.E02!, 'another type', [], [])
    common(p)
    expect(p).toContain('is an experiment, not a direction')
    expect(p).toContain('a new direction under it')
  })

  test('a question: located first, its note created only once round one agreed where it goes', () => {
    const p = grillQuestionPrompt(M, 'does the variant "transfer" to video?')
    common(p)
    expect(p).toContain(JSON.stringify('does the variant "transfer" to video?'))
    expect(p).toContain('rft_search')
    expect(p).toContain('only then create the grilled direction')
  })

  test('a concept: its open questions and directions are listed, and the user picks', () => {
    const p = grillConceptPrompt(M, 'Better variants', D01)
    common(p)
    expect(p).toContain('"Better variants"')
    expect(p).toContain(D01)
    expect(p).toContain('ask me which one to grill')
  })
})
