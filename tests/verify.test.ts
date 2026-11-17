// Verified notes: only the user verifies (the tree view), which locks and stamps the note; Claude
// suggests it through rft_set_status. A verified note whose claim changes, is superseded or no
// longer reproduces goes to review, unlocked.

import { describe, expect, mock, test } from 'claude-code/testing'

import { LockedChange, isLocked } from '../hooks/lib/comments'
import { nextReport, supersede } from '../hooks/lib/knowledge'
import { addNode, setStatus } from '../hooks/lib/ops'
import { changesVerified, dismissVerified, keepVerified, substanceFingerprint, substanceOf, toReview, verifyBlockers, verifyNote } from '../hooks/lib/verify'
import { contentFingerprint } from '../hooks/lib/snippets'
import { front, load, readConfig, validate } from '../hooks/lib/vault'
import { CWD, E01, E02, MemoryFs, demoFiles, world } from './fixture'

const E01_PATH = `vault/experiments/${E01}.md`
const E02_PATH = `vault/experiments/${E02}.md`
const DATE = '2026-11-17'

async function setup(edit: (files: Record<string, string>) => void = () => {}) {
  const files = demoFiles()
  edit(files)
  const fs = new MemoryFs(files)
  const io = fs.io()
  const l = await load(io, (await readConfig(io))!)
  return { fs, io, l }
}

describe('the substance of a note', () => {
  test('the sections that hold its claim, comments left out and whitespace collapsed', async () => {
    const { fs } = await setup()
    const text = fs.read(E01_PATH)
    expect(substanceOf('experiment', text)).toBe('Result: Text of E01.')
    const fp = substanceFingerprint('experiment', text)
    expect(fp).toMatch(/^[0-9a-f]{8}$/)
    // reflowed, a comment added, another section changed: the same claim
    expect(substanceFingerprint('experiment', text.replace('Text of E01.', 'Text   of\nE01. <!-- rft-results from E01.py @abc -->'))).toBe(fp)
    expect(substanceFingerprint('experiment', text.replace('## Children in the tree', '## Code\nNew code.\n\n## Children in the tree'))).toBe(fp)
    expect(substanceFingerprint('experiment', text.replace('Text of E01.', 'Text of E01, 71.3 %.'))).not.toBe(fp)
    // each type has its own sections
    expect(substanceOf('theory', '---\nid: T01\n---\n## Statement\nA.\n\n## Builds on\nX.\n\n## Explanation\nB.\n')).toBe('Statement: A.\nExplanation: B.')
    expect(substanceOf('reference', '---\nid: R01\n---\n## Source\narXiv:1.2\n\n## Key results\n3 %\n\n## Relevance\nMine.\n')).toBe('Source: arXiv:1.2\nKey results: 3 %')
  })
})

describe('the same fingerprint as the server', () => {
  test('server/rft_manuscript.py computes these too (tests/test_server.py)', () => {
    const e = '---\nid: E05\n---\n# E05 · X\n\n## Result\nCutMix  closes the gap: 0.3 ± 0.5 points.\n<!-- rft-results a -->\n| acc | 71.3 |\n\n## Code\nx\n'
    expect(substanceOf('experiment', e)).toBe('Result: CutMix closes the gap: 0.3 ± 0.5 points. | acc | 71.3 |')
    expect(substanceFingerprint('experiment', e)).toBe('58942782')
    const t = '---\nid: T01\n---\n## Statement\nA gap $g = a - b$.\n\n## Builds on\nE05.\n\n## Explanation\n“Proof” — by ε.\n'
    expect(substanceFingerprint('theory', t)).toBe('1a85e809')
    // and a snippet's content, as a copy in a document is stamped with it (server/rft_manuscript.py content_fingerprint)
    expect(contentFingerprint('\\paragraph{One}\nText one.')).toBe('a25f30cc')
    expect(contentFingerprint('\\paragraph{One}  % a comment\nText   one.\n')).toBe('a25f30cc')
  })
})

describe('verification', () => {
  test('Claude only suggests it, with its reason; a note that is not ready is refused with what is missing', async () => {
    const { fs, io, l } = await setup()
    const out = await setStatus(io, l, 'E01', 'verified', 'Reran the three seeds by hand', undefined, DATE)
    expect(out).toContain(`Suggested verifying ${E01}: Reran the three seeds by hand. Only the user verifies a note`)
    const fm = front(fs.read(E01_PATH))
    expect(fm.status).toBe('done')
    expect(fm.suggested_verified).toBe('"Reran the three seeds by hand"')
    expect(l.tree.nodes.E01!.suggestedVerified).toBe('Reran the three seeds by hand')
    await expect(setStatus(io, l, 'E01', 'verified', undefined, undefined, DATE)).rejects.toThrow('say why in one line')
    await expect(setStatus(io, l, 'E02', 'verified', 'It runs', undefined, DATE)).rejects.toThrow(`${E02} cannot be verified yet: it is running: only a done note, or one in review, is verified.`)
    // a direction needs a verified note under it
    await expect(setStatus(io, l, 'D00', 'verified', 'It works', undefined, DATE)).rejects.toThrow('no verified note under it confirms it')
    // a new note is never verified
    await expect(addNode(io, l, { type: 'experiment', title: 'Seeds', parent: 'D01', date: DATE, status: 'verified' })).rejects.toThrow('a new note is never verified')
  })

  test('an experiment with a notebook is verified once its run reproduced it', async () => {
    const { l } = await setup(f => { f[E01_PATH] = f[E01_PATH]!.replace('status: done\n', 'status: done\nnotebook: notebooks/E01.py\nreproduced: "2026-11-16 differs @abc1234 in 3 s"\n') })
    expect(verifyBlockers(l.tree, l.tree.nodes.E01!, l.texts.E01!)).toEqual(["its notebook's last run differs (2026-11-16): it must reproduce the Result (ok) first"])
    const ok = await setup(f => { f[E01_PATH] = f[E01_PATH]!.replace('status: done\n', 'status: done\nnotebook: notebooks/E01.py\nreproduced: "2026-11-16 ok @abc1234 in 3 s"\n') })
    expect(verifyBlockers(ok.l.tree, ok.l.tree.nodes.E01!, ok.l.texts.E01!)).toEqual([])
  })

  test('the user verifies it: verified, locked, stamped, the suggestion answered, a History line, the index marked', async () => {
    const { fs, io, l } = await setup()
    await setStatus(io, l, 'E01', 'verified', 'Reran it', undefined, DATE)
    expect(await verifyNote(io, l, 'E01', DATE)).toBe(`${E01} is verified and locked.`)
    const text = fs.read(E01_PATH)
    const fm = front(text)
    expect(fm.status).toBe('verified')
    expect(fm.suggested_verified).toBeUndefined()
    expect(isLocked(text)).toBe(true)
    expect(fm.verified).toBe(`"${DATE} ${substanceFingerprint('experiment', text)}"`)
    expect(text).toContain('**Status:** verified')
    expect(text).toContain(`## History\n- ${DATE}: verified\n`)
    expect(l.tree.nodes.E01).toMatchObject({ status: 'verified', locked: true, verified: { date: DATE } })
    expect(fs.read('vault/00 Index.md')).toContain(`✔ [[${E01}]]`)
    await expect(verifyNote(io, l, 'E01', DATE)).rejects.toThrow('is verified already')
    // a direction above it can be verified now
    expect(verifyBlockers(l.tree, l.tree.nodes.D00!, l.texts.D00!)).toEqual([])
    expect((await validate(io, l)).warnings.join('\n')).not.toContain('verified with no stamp')
  })

  test('the user dismisses the suggestion', async () => {
    const { fs, io, l } = await setup()
    await setStatus(io, l, 'E01', 'verified', 'Reran it', undefined, DATE)
    expect(await dismissVerified(io, l, 'E01')).toBe(`The suggestion to verify ${E01} is dismissed.`)
    expect(front(fs.read(E01_PATH)).suggested_verified).toBeUndefined()
    expect(front(fs.read(E01_PATH)).status).toBe('done')
  })

  test('Claude cannot change a verified note\'s status, only send it to review once the user agrees to unlock it', async () => {
    const { fs, io, l } = await setup()
    await verifyNote(io, l, 'E01', DATE)
    await expect(setStatus(io, l, 'E01', 'dropped', undefined, undefined, DATE)).rejects.toThrow(`${E01} is verified: only the user changes that`)
    await expect(setStatus(io, l, 'E01', 'review', 'A bug in the loader', undefined, DATE)).rejects.toBeInstanceOf(LockedChange)
    expect(front(fs.read(E01_PATH)).status).toBe('verified')
    const out = await setStatus(io, l, 'E01', 'review', 'A bug in the loader', undefined, DATE, true)
    expect(out).toBe(`${E01}: verified → review (A bug in the loader), and unlocked. The user verifies it again, or gives it another status.`)
    const text = fs.read(E01_PATH)
    expect(front(text).status).toBe('review')
    expect(isLocked(text)).toBe(false)
    expect(text).toContain(`- ${DATE}: to review, A bug in the loader\n`)
    expect(front(text).verified).toContain(DATE) // when it was last verified stays
    expect(fs.read('vault/00 Index.md')).toContain(`↺ [[${E01}]]`)
    await expect(toReview(io, l, 'E02', 'x', DATE, true)).rejects.toThrow('review is for a verified note')
    // in review, it can be verified again
    expect(verifyBlockers(l.tree, l.tree.nodes.E01!, l.texts.E01!)).toEqual([])
  })

  test('a change to its claim sends it to review, unlocked; a change elsewhere does not', async () => {
    const { fs, io, l } = await setup()
    await verifyNote(io, l, 'E01', DATE)
    // its Code section and summary: still verified
    fs.write(E01_PATH, fs.read(E01_PATH).replace('## Children in the tree', '## Code\nEntry point train.py.\n\n## Children in the tree').replace('status: verified\n', 'status: verified\nsummary: "One run"\n'))
    Object.assign(l, await load(io, l.config))
    expect(await keepVerified(io, l, '2026-11-18')).toEqual([])
    // its Result (an accepted suggestion, an edit in Obsidian): review
    fs.write(E01_PATH, fs.read(E01_PATH).replace('Text of E01.', 'Text of E01, now 68.2 %.'))
    Object.assign(l, await load(io, l.config))
    expect(await keepVerified(io, l, '2026-11-18')).toEqual([`E01 to review: its Result changed since it was verified on ${DATE}`])
    const text = fs.read(E01_PATH)
    expect(front(text).status).toBe('review')
    expect(isLocked(text)).toBe(false)
    expect(text).toContain(`- 2026-11-18: to review, its Result changed since it was verified on ${DATE}\n`)
    expect(await keepVerified(io, l, '2026-11-18')).toEqual([])
  })

  test('a note set verified by hand is stamped and locked; validate says so until then', async () => {
    const { fs, io, l } = await setup(f => { f[E01_PATH] = f[E01_PATH]!.replace('status: done', 'status: verified') })
    expect((await validate(io, l)).warnings.join('\n')).toContain('E01: verified with no stamp')
    expect(await keepVerified(io, l, DATE)).toEqual(['E01 verified by hand: stamped and locked'])
    const text = fs.read(E01_PATH)
    expect(isLocked(text)).toBe(true)
    expect(front(text).verified).toBe(`"${DATE} ${substanceFingerprint('experiment', text)}"`)
    expect(await keepVerified(io, l, DATE)).toEqual([])
  })

  test('superseded, a verified note goes to review', async () => {
    const { fs, io, l } = await setup(f => { f[E02_PATH] = f[E02_PATH]!.replace('status: running', 'status: done') })
    await verifyNote(io, l, 'E01', DATE)
    const out = await supersede(io, l, 'E01', 'E02', 'a better-controlled rerun', DATE, true)
    expect(out).toContain('It was verified: it is in review now')
    expect(front(fs.read(E01_PATH)).status).toBe('review')
    expect(isLocked(fs.read(E01_PATH))).toBe(false)
  })

  test('rft_next lists the notes in review and the suggestions waiting for the user', async () => {
    const { io, l } = await setup(f => { f[E02_PATH] = f[E02_PATH]!.replace('status: running', 'status: done') })
    await verifyNote(io, l, 'E01', DATE)
    await toReview(io, l, 'E01', 'asked', DATE, true)
    await setStatus(io, l, 'E02', 'verified', 'Its numbers checked', undefined, DATE)
    const next = await nextReport(io, l, DATE)
    expect(next).toContain("In review, for the user to check again and verify (the note's drawer): E01.")
    expect(next).toContain('Verifications you suggested, waiting for the user: E02.')
  })

  test('what counts as a change of verification', () => {
    const a = '---\nid: E01\nstatus: done\n---\nx'
    expect(changesVerified(a, a.replace('status: done', 'status: verified'))).toBe(true)
    expect(changesVerified(a, a.replace('status: done', 'status: dropped'))).toBe(false)
    const v = '---\nid: E01\nstatus: verified\nverified: "2026-11-17 a1b2c3d4"\n---\nx'
    expect(changesVerified(v, v.replace('a1b2c3d4', 'ffffffff'))).toBe(true)
    expect(changesVerified(v, v.replace('x', 'y'))).toBe(false)
  })
})

describe('in a session', () => {
  test('Claude cannot verify a note by hand, and is told to suggest it instead', async ($, on) => {
    mock.clock(on)
    const w = world(on, demoFiles())
    const ran: string[] = []
    on('tool.call', (_$, e) => { ran.push(String(e.tool)); return { result: 'ok', text: 'ok' } as never })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const e01 = w.fs.read(E01_PATH)
    for (const call of [
      { tool: 'Edit', file_path: `${CWD}/${E01_PATH}`, old_string: 'status: done\n', new_string: 'status: verified\n' },
      { tool: 'Write', file_path: `${CWD}/${E01_PATH}`, content: e01.replace('status: done\n', 'status: verified\nverified: "2026-11-17 a1b2c3d4"\n') },
      { tool: 'Bash', command: `sed -i 's/status: done/status: verified/' "${E01_PATH}"` },
    ]) {
      const res = await $.tool.call(call as never)
      expect({ call, deny: (res as { deny?: string }).deny }).toEqual({ call, deny: expect.stringContaining("is the user's alone") })
    }
    expect(ran).toEqual([])
    const ok = await $.tool.call({ tool: 'Edit', file_path: `${CWD}/${E01_PATH}`, old_string: 'Text of E01.', new_string: 'Changed.' } as never)
    expect((ok as { deny?: string }).deny).toBeUndefined()
    const s = await $.tool.call({ tool: 'mcp__rft__rft_set_status', id: 'E01', status: 'verified', note: 'Reran it' } as never)
    expect(s.text).toContain(`Suggested verifying ${E01}`)
  })
})
