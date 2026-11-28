// The handoff a session leaves for the next one in its folder (hooks/lib/handoff.ts): what
// rft_handoff saves and refuses, what the plugin checks itself (the repositories with work in no
// commit), who gets it in full (the first later session, after a /clear too) and who gets a line,
// /rft-handoff, the tool's place in the prompt, and the word on a session grown large.
//
// The three cases it was built to: (1) the user stops for the night with runs queued, and the
// session of the morning knows which experiment, what was launched and what to check first; (2)
// the session holds what no note has (uncommitted code, a log half read): the handoff says so, and
// the plugin lists the repositories; (3) a third session, a week later, is not sent back to it.

import { describe, expect, mock, test } from 'claude-code/testing'

import { MAX_HANDOFF, POINTER_DAYS, TELL_AT, clearHandoff, handoffFile, handoffPrompt, handoffRules, hasHandoffs, leaveHandoff, readHandoffs, showHandoff, toTell, uncommittedIn } from '../hooks/lib/handoff'
import type { CodeEnv } from '../hooks/lib/ops'
import { FEATURE_TOOLS } from '../hooks/lib/tools'
import { reposLine } from '../hooks/lib/vault'
import type { FakeRepo } from './fixture'
import { CWD, E01, MemoryFs, demoAt, demoFiles, fakeGit, world } from './fixture'

const ROOT = '/work/demo'
const VAULT = `${ROOT}/vault`
const SFREE = '/work/code/sfree'
const UTILS = '/work/code/utils'
const NOW = Math.floor(Date.parse('2026-11-22T10:00:00Z') / 1000)
const HOUR = 3600
const DAY = 86400

const TEXT = {
  done: 'E02 ran with the free schedule: its note has the numbers. D01 stays open.',
  next: 'q31 is running (log in /data2/rft-runs/q31/log.txt): check its last epoch, then set E02.',
  unrecorded: 'The sweep script in sfree is not committed.',
}
const SIZE = TEXT.done.length + TEXT.next.length + TEXT.unrecorded.length

const fileOf = (folder: string) => `${VAULT}/.handoff/${handoffFile(folder)}`
const stored = (fs: MemoryFs, folder = ROOT) => JSON.parse(fs.read(fileOf(folder)))

/** A handoff as its file holds it. */
const handoff = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ folder: ROOT, session: 'sess-1', at: NOW, ...TEXT, uncommitted: [], ...over })

/** The demo tree in /work/demo, a repository, with the code of E01's concept in two more. */
function project(extra: Record<string, string> = {}) {
  const files = demoAt(ROOT, {
    [`${ROOT}/.git/HEAD`]: 'ref: refs/heads/main\n',
    [`${SFREE}/.git/HEAD`]: 'ref: refs/heads/main\n',
    [`${SFREE}/train.py`]: '',
    [`${UTILS}/.git/HEAD`]: 'ref: refs/heads/main\n',
    [`${UTILS}/lib.py`]: '',
    ...extra,
  })
  const note = `${VAULT}/experiments/${E01}.md`
  files[note] = files[note]!.replace(/^(tags: .*)$/m, `$1\nconcept: "Checks"\nconcept_repos: ${reposLine(['../code/utils', SFREE])}`)
  return files
}

const repos = (): Record<string, FakeRepo> => ({
  [ROOT]: { commit: 'a1b2c3d4e5f60718', dirty: 1, untracked: 2 },
  [SFREE]: { commit: '1111111111111111' },
  [UTILS]: { commit: '0f0e0d0c0b0a0908', branch: 'sweep', dirty: 3 },
})

type Engine = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]
const rulesOf = async ($: Engine) =>
  (await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })).sections.find(s => s.id === 'rft:rules')!.text
const command = ($: Engine, args = '') =>
  $.command.run({ command: 'rft-handoff', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } } as never)
const inPrompt = (w: { tools: string[]; deferred: string[] }) => w.tools.filter(t => !w.deferred.includes(t))

describe('handoff: the file', () => {
  test('one file per folder, named by the end of its path: two folders never share one', () => {
    expect(handoffFile(ROOT)).toMatch(/^work-demo-[0-9a-z]+\.json$/)
    expect(handoffFile('/work/a/demo').replace(/-[0-9a-z]+\.json$/, '')).toBe(handoffFile('/work/a-demo').replace(/-[0-9a-z]+\.json$/, ''))
    expect(handoffFile('/work/a/demo')).not.toBe(handoffFile('/work/a-demo'))
    expect(handoffFile(`/${'long/'.repeat(40)}demo`).length).toBeLessThanOrEqual(100)
  })

  test('saved with what the plugin found uncommitted, kept out of git, and the one before replaced', async () => {
    const fs = new MemoryFs({}, true)
    const io = fs.io()
    expect(await hasHandoffs(io, VAULT)).toBe(false)
    const line = `${UTILS}: sweep @ 0f0e0d0c0b, uncommitted changes in 3 file(s)`
    const said = await leaveHandoff(io, VAULT, { ...TEXT, unrecorded: `  ${TEXT.unrecorded}\n` }, { folder: ROOT, session: 'sess-1', now: NOW, uncommitted: async () => [line] })
    expect(said).toContain(`Handoff saved for ${ROOT} (${SIZE} characters). The next session in this folder starts from it: a new session, or this one after /clear.`)
    expect(said).toContain(`In no commit (the plugin's check, kept with the handoff):\n- ${line}`)
    expect(fs.read(`${VAULT}/.handoff/.gitignore`)).toBe('*\n')
    expect(stored(fs)).toEqual({ folder: ROOT, session: 'sess-1', at: NOW, ...TEXT, uncommitted: [line] })
    expect(await hasHandoffs(io, VAULT)).toBe(true)
    // the next one replaces it, and a session that took the first is forgotten with it
    fs.write(fileOf(ROOT), handoff({ takenBy: 'sess-2', takenAt: NOW + 60 }))
    const again = await leaveHandoff(io, VAULT, { done: 'd', next: 'n', unrecorded: 'nothing' }, { folder: ROOT, session: 'sess-2', now: NOW + HOUR, uncommitted: async () => [] })
    expect(again).toContain("The plugin's check found no repository with uncommitted changes.")
    expect(await readHandoffs(io, VAULT)).toEqual([{ folder: ROOT, session: 'sess-2', at: NOW + HOUR, done: 'd', next: 'n', unrecorded: 'nothing', uncommitted: [] }])
  })

  test('refused without its three parts, or over its ceiling: nothing is written', async () => {
    const fs = new MemoryFs({}, true)
    const io = fs.io()
    let checks = 0
    const by = { folder: ROOT, session: 'sess-1', now: NOW, uncommitted: async () => { checks++; return [] } }
    await expect(leaveHandoff(io, VAULT, { done: 'd', next: ' ' }, by)).rejects.toThrow('next and unrecorded are missing (unrecorded: "nothing" when the notes and the commits hold it all)')
    await expect(leaveHandoff(io, VAULT, { done: 'd', next: 'n' }, by)).rejects.toThrow('unrecorded is missing')
    const long = { done: 'd'.repeat(MAX_HANDOFF - 10), next: 'n'.repeat(10), unrecorded: 'u' }
    await expect(leaveHandoff(io, VAULT, long, by)).rejects.toThrow(`The handoff is ${MAX_HANDOFF + 1} characters, over its ${MAX_HANDOFF}. It points at notes and does not repeat them`)
    expect(await hasHandoffs(io, VAULT)).toBe(false)
    // a handoff refused costs no look at the repositories
    expect(checks).toBe(0)
    // at the ceiling it is taken
    await leaveHandoff(io, VAULT, { ...long, next: 'n'.repeat(9) }, by)
    expect(await hasHandoffs(io, VAULT)).toBe(true)
  })

  test('shown with its age and the other folders that have one; cleared for one folder only', async () => {
    const fs = new MemoryFs({ [fileOf(ROOT)]: handoff({ uncommitted: [`${ROOT}: main @ a1b2c3d4e5, 2 untracked file(s)`] }), [fileOf(SFREE)]: handoff({ folder: SFREE, at: NOW - 3 * DAY }), [`${VAULT}/.handoff/notes.json`]: '{"not":"one"}', [`${VAULT}/.handoff/bad.json`]: '{' }, true)
    const io = fs.io()
    const shown = await showHandoff(io, VAULT, ROOT, NOW + 9 * HOUR)
    expect(shown).toMatch(new RegExp(`^Handoff left for ${ROOT} on 2026-11-22 \\d\\d:\\d\\d \\(9 h ago\\):\nDone: `))
    expect(shown).toContain(`Next: ${TEXT.next}\nIn no note or commit: ${TEXT.unrecorded}\nUncommitted when it was saved (the plugin's check): ${ROOT}: main @ a1b2c3d4e5, 2 untracked file(s)`)
    expect(shown).toContain(`Other folders with a handoff: ${SFREE} (3 days ago).`)
    expect(await showHandoff(io, VAULT, UTILS, NOW)).toContain(`No handoff for ${UTILS}.\n\nOther folders with a handoff: ${ROOT} (1 min ago), ${SFREE} (3 days ago).`)
    expect(await clearHandoff(io, VAULT, ROOT)).toBe(`The handoff of ${ROOT} is removed.`)
    expect(await clearHandoff(io, VAULT, ROOT)).toBe(`No handoff for ${ROOT}.`)
    expect((await readHandoffs(io, VAULT)).map(h => h.folder)).toEqual([SFREE])
  })
})

describe('handoff: what the plugin checks', () => {
  test('the repositories with changed or untracked files, each once, whatever folder of theirs was named', async () => {
    const fs = new MemoryFs(project({ [`${ROOT}/src/run.py`]: '' }), true)
    const git = fakeGit(repos())
    const env: CodeEnv = { root: ROOT, git: async (d, a) => git(d, a), date: '2026-11-22' }
    // the session's folder (inside the tree's repository), the tree's, a concept's code twice, a folder outside git, one that is not there
    const found = await uncommittedIn(fs.io(), env, [`${ROOT}/src`, ROOT, '../code/utils', UTILS, SFREE, '/work/code', '/nowhere'])
    expect(found).toEqual([
      `${ROOT}: main @ a1b2c3d4e5, uncommitted changes in 1 file(s), 2 untracked file(s)`,
      `${UTILS}: sweep @ 0f0e0d0c0b, uncommitted changes in 3 file(s)`,
    ])
    expect(git.calls).toEqual([ROOT, UTILS, SFREE].map(dir => [dir, 'status', '--porcelain=v2', '--branch', '--untracked-files=normal']))
  })
})

describe('handoff: who starts from it', () => {
  const seeded = (over: Record<string, unknown> = {}) => new MemoryFs({ [fileOf(ROOT)]: handoff(over) }, true)

  test('the first later session gets it in full and marks it taken; so does that session again, with the same text', async () => {
    const fs = seeded({ uncommitted: [`${UTILS}: sweep @ 0f0e0d0c0b, uncommitted changes in 3 file(s)`] })
    const io = fs.io()
    const first = await handoffRules(io, VAULT, { folder: ROOT, session: 'sess-2', now: NOW + 9 * HOUR })
    expect(first).toMatch(/^Handoff left for this folder on 2026-11-22 \d\d:\d\d: the work goes on from it\. The notes are the record: where a note and the handoff differ, the note holds\.\nDone: /)
    expect(first).toContain(`Done: ${TEXT.done}\nNext: ${TEXT.next}\nIn no note or commit: ${TEXT.unrecorded}\nUncommitted when it was saved (the plugin's check): ${UTILS}: sweep @ 0f0e0d0c0b, uncommitted changes in 3 file(s)`)
    expect(stored(fs)).toMatchObject({ session: 'sess-1', takenBy: 'sess-2', takenAt: NOW + 9 * HOUR })
    // resumed two days later: the rules it was cached with
    expect(await handoffRules(io, VAULT, { folder: ROOT, session: 'sess-2', now: NOW + 2 * DAY })).toBe(first)
    expect(stored(fs).takenAt).toBe(NOW + 9 * HOUR)
  })

  test('the session that wrote it keeps it in full and does not take it', async () => {
    const fs = seeded()
    expect(await handoffRules(fs.io(), VAULT, { folder: ROOT, session: 'sess-1', now: NOW + HOUR })).toContain(`Next: ${TEXT.next}`)
    expect(stored(fs).takenBy).toBeUndefined()
  })

  test('a third session gets one line, for a week, then nothing', async () => {
    const fs = seeded({ takenBy: 'sess-2', takenAt: NOW + 9 * HOUR })
    const io = fs.io()
    const line = await handoffRules(io, VAULT, { folder: ROOT, session: 'sess-3', now: NOW + 2 * DAY })
    expect(line).toMatch(/^A handoff was left for this folder on 2026-11-22 \d\d:\d\d, and a session since started from it: rft_handoff shows it\.$/)
    expect(await handoffRules(io, VAULT, { folder: ROOT, session: 'sess-3', now: NOW + POINTER_DAYS * DAY + 1 })).toBeNull()
    expect(stored(fs).takenBy).toBe('sess-2')
  })

  test('where the host gives no session id it is shown in full and never marked taken', async () => {
    const fs = seeded()
    expect(await handoffRules(fs.io(), VAULT, { folder: ROOT, session: '', now: NOW + DAY })).toContain(`Next: ${TEXT.next}`)
    expect(stored(fs).takenBy).toBeUndefined()
    // an old one that nobody took is still the place to start from
    expect(await handoffRules(fs.io(), VAULT, { folder: ROOT, session: 'sess-9', now: NOW + 30 * DAY })).toContain(`Next: ${TEXT.next}`)
  })

  test('the handoffs of other folders that nobody took: one line, the latest three, a week', async () => {
    const others = ['/work/a', '/work/b', '/work/c', '/work/d']
    const fs = new MemoryFs({
      ...Object.fromEntries(others.map((folder, i) => [fileOf(folder), handoff({ folder, at: NOW - i * HOUR })])),
      [fileOf('/work/taken')]: handoff({ folder: '/work/taken', at: NOW + 60, takenBy: 'sess-5', takenAt: NOW + 120 }),
      [fileOf('/work/old')]: handoff({ folder: '/work/old', at: NOW - 8 * DAY }),
    }, true)
    const text = await handoffRules(fs.io(), VAULT, { folder: ROOT, session: 'sess-2', now: NOW + HOUR })
    expect(text).toMatch(/^Handoffs left in other folders, which no session took up yet: \/work\/a \(2026-11-22 \d\d:\d\d\), \/work\/b \(2026-11-22 \d\d:\d\d\), \/work\/c \(2026-11-2\d \d\d:\d\d\)\. rft_handoff \{folder\} shows one\.$/)
    // reading the others takes none of them
    expect(JSON.parse(fs.read(fileOf('/work/a'))).takenBy).toBeUndefined()
    expect(await handoffRules(new MemoryFs({}, true).io(), VAULT, { folder: ROOT, session: 'sess-2', now: NOW })).toBeNull()
  })
})

describe('handoff: a session grown large', () => {
  test('told once at each size, the largest passed', () => {
    expect([...TELL_AT]).toEqual([200_000, 400_000])
    expect(toTell(199_999, 0)).toBeNull()
    expect(toTell(200_000, 0)).toBe(200_000)
    expect(toTell(350_000, 200_000)).toBeNull()
    expect(toTell(410_000, 200_000)).toBe(400_000)
    expect(toTell(900_000, 400_000)).toBeNull()
    // a session resumed at 450k is told once, of the larger size
    expect(toTell(450_000, 0)).toBe(400_000)
  })
})

describe('handoff: in a session', () => {
  test('rft_handoff saves it with the repositories the plugin checked; after /clear the session starts from it, a later one gets a line', async ($, on) => {
    const clock = mock.clock(on, { now: NOW * 1000 })
    let session = 'sess-1'
    on('session.id', () => ({ value: session }))
    on('session.end', () => ({ sessionId: 'test' }) as never)
    on('classic.SessionStart', () => ({}) as never)
    on('prompt.compose', () => ({ sections: [] }))
    const git = fakeGit(repos())
    const w = world(on, project(), { cwd: ROOT, git })
    await $.session.start({ cwd: ROOT, source: 'startup' } as never)
    // no handoff in the vault yet: the tool waits behind ToolSearch and the rules say nothing of it
    expect(w.deferred).toContain('rft_handoff')
    expect(await rulesOf($)).not.toContain('andoff')

    const none = await $.tool.call({ tool: 'mcp__rft__rft_handoff' } as never)
    expect(none.text).toBe(`No handoff for ${ROOT}.`)
    const short = await $.tool.call({ tool: 'mcp__rft__rft_handoff', done: TEXT.done } as never)
    expect(short.isError).toBe(true)
    expect(short.text).toContain('next and unrecorded are missing')

    const saved = await $.tool.call({ tool: 'mcp__rft__rft_handoff', ...TEXT } as never)
    expect(saved.isError).toBeUndefined()
    expect(saved.text).toContain(`Handoff saved for ${ROOT} (${SIZE} characters).`)
    expect(saved.text).toContain(`- ${ROOT}: main @ a1b2c3d4e5, uncommitted changes in 1 file(s), 2 untracked file(s)\n- ${UTILS}: sweep @ 0f0e0d0c0b, uncommitted changes in 3 file(s)`)
    expect(saved.text).not.toContain(SFREE)
    // the session's folder and the tree's are one repository, asked once
    expect(git.calls.filter(c => c.includes('--untracked-files=normal')).map(c => c[0])).toEqual([ROOT, UTILS, SFREE])
    expect(stored(w.fs)).toMatchObject({ folder: ROOT, session: 'sess-1', at: NOW, done: TEXT.done })
    expect(w.fs.read(`${VAULT}/.handoff/.gitignore`)).toBe('*\n')
    const shown = await $.tool.call({ tool: 'mcp__rft__rft_handoff' } as never)
    expect(shown.text).toContain(`Next: ${TEXT.next}`)

    // /clear: a new session in the same folder
    await clock.advance(10 * 60 * 1000)
    await $.session.end({ reason: 'clear' } as never)
    session = 'sess-2'
    await $.classic.SessionStart({ source: 'clear' } as never)
    const rules = await rulesOf($)
    expect(rules).toMatch(/\n\nHandoff left for this folder on 2026-11-22 \d\d:\d\d: the work goes on from it\./)
    expect(rules).toContain(`Next: ${TEXT.next}\nIn no note or commit: ${TEXT.unrecorded}\nUncommitted when it was saved (the plugin's check): ${ROOT}: main @ a1b2c3d4e5`)
    expect(rules).toContain('- A handoff (rft_handoff) carries the work to the next session in this folder')
    expect(stored(w.fs)).toMatchObject({ takenBy: 'sess-2', takenAt: NOW + 600 })
    // the same session resumed: the same rules
    await $.classic.SessionStart({ source: 'resume' } as never)
    expect(await rulesOf($)).toBe(rules)

    // a session after that one: a line
    await $.session.end({ reason: 'clear' } as never)
    session = 'sess-3'
    await $.classic.SessionStart({ source: 'clear' } as never)
    const later = await rulesOf($)
    expect(later).toMatch(/\n\nA handoff was left for this folder on 2026-11-22 \d\d:\d\d, and a session since started from it: rft_handoff shows it\./)
    expect(later).not.toContain(TEXT.next)

    // removed
    const cleared = await $.tool.call({ tool: 'mcp__rft__rft_handoff', clear: true } as never)
    expect(cleared.text).toBe(`The handoff of ${ROOT} is removed.`)
    expect(w.fs.exists(fileOf(ROOT))).toBe(false)
  })

  test('a vault with a handoff: its tool and rule are in the prompt, and a new session starts from it', async ($, on) => {
    mock.clock(on, { now: (NOW + 9 * HOUR) * 1000 })
    on('session.id', () => ({ value: 'sess-2' }))
    on('prompt.compose', () => ({ sections: [] }))
    const w = world(on, { ...demoFiles(), [`vault/.handoff/${handoffFile(CWD)}`]: handoff({ folder: CWD }) })
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    for (const t of FEATURE_TOOLS.handoff) expect(inPrompt(w)).toContain(t)
    const rules = await rulesOf($)
    expect(rules).toContain('- A handoff (rft_handoff) carries the work')
    expect(rules).toContain(`Done: ${TEXT.done}\nNext: ${TEXT.next}`)
    expect(JSON.parse(w.fs.read(`vault/.handoff/${handoffFile(CWD)}`)).takenBy).toBe('sess-2')
    // the tree's own check is not troubled by the folder
    const check = await $.tool.call({ tool: 'mcp__rft__rft_validate' } as never)
    expect(check.text ?? '').not.toContain('.handoff')
  })

  test('a session in a code folder linked to the tree: the handoff is that folder\'s, and a session elsewhere gets a line', async ($, on) => {
    mock.clock(on, { now: NOW * 1000 })
    let session = 'sess-1'
    on('session.id', () => ({ value: session }))
    on('prompt.compose', () => ({ sections: [] }))
    // the fixture reads the session's folder from these options at each call
    const where = { cwd: SFREE, git: fakeGit({ ...repos(), [SFREE]: { commit: '1111111111111111', untracked: 1 } }) }
    const w = world(on, project({ [`${SFREE}/.rft/config.json`]: JSON.stringify({ tree: '../../demo' }) }), where)
    await $.session.start({ cwd: SFREE, source: 'startup' } as never)
    const saved = await $.tool.call({ tool: 'mcp__rft__rft_handoff', ...TEXT } as never)
    expect(saved.text).toContain(`Handoff saved for ${SFREE} `)
    expect(saved.text).toContain(`- ${SFREE}: main @ 1111111111, 1 untracked file(s)\n- ${ROOT}: main @ a1b2c3d4e5`)
    expect(stored(w.fs, SFREE)).toMatchObject({ folder: SFREE, session: 'sess-1' })
    // a session in the tree's own folder: one line, and the handoff stays for a session in the code folder
    session = 'sess-2'
    where.cwd = ROOT
    await $.session.start({ cwd: ROOT, source: 'startup' } as never)
    const rules = await rulesOf($)
    expect(rules).toMatch(new RegExp(`\n\nHandoffs left in other folders, which no session took up yet: ${SFREE} \\(2026-11-22 \\d\\d:\\d\\d\\)\\. rft_handoff \\{folder\\} shows one\\.`))
    expect(rules).not.toContain(TEXT.next)
    expect(stored(w.fs, SFREE).takenBy).toBeUndefined()
    const shown = await $.tool.call({ tool: 'mcp__rft__rft_handoff', folder: SFREE } as never)
    expect(shown.text).toContain(`Handoff left for ${SFREE} on `)
    expect(shown.text).toContain(`Next: ${TEXT.next}`)
  })

  test('a session with no id from the host still saves and shows', async ($, on) => {
    mock.clock(on, { now: NOW * 1000 })
    on('prompt.compose', () => ({ sections: [] }))
    const w = world(on, demoFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const saved = await $.tool.call({ tool: 'mcp__rft__rft_handoff', ...TEXT } as never)
    expect(saved.isError).toBeUndefined()
    expect(saved.text).toContain("The plugin's check found no repository with uncommitted changes.")
    expect(JSON.parse(w.fs.read(`vault/.handoff/${handoffFile(CWD)}`))).toMatchObject({ folder: CWD, session: '' })
  })

  test('/rft-handoff asks Claude for one, with what the user adds; show and clear take no model turn', async ($, on) => {
    const clock = mock.clock(on, { now: NOW * 1000 })
    on('session.id', () => ({ value: 'sess-1' }))
    const prompts: string[] = []
    on('prompt.submit', (_$, e) => { prompts.push(String(e.text)); return { text: e.text } as never })
    const w = world(on, demoFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    expect(w.commands).toContain('rft-handoff')

    expect(String((await command($, 'show')).text)).toBe(`No handoff for ${CWD}.`)
    await clock.advance(5000)
    expect(prompts).toHaveLength(0)

    expect(String((await command($)).text)).toContain('Claude will write the handoff in a moment')
    await clock.advance(5000)
    expect(prompts).toEqual([handoffPrompt('')])
    expect(prompts[0]).toContain('First bring the tree up to date')
    expect(prompts[0]).toContain('Then call rft_handoff once, 2,000 characters at most in all')
    expect(prompts[0]).not.toContain('The user adds')

    await command($, ' I stop for the night; q31 and q32 run until morning ')
    await clock.advance(5000)
    expect(prompts[1]).toMatch(/goes on from it\. The user adds: I stop for the night; q31 and q32 run until morning$/)

    await $.tool.call({ tool: 'mcp__rft__rft_handoff', ...TEXT } as never)
    expect(String((await command($, 'show')).text)).toContain(`Next: ${TEXT.next}`)
    expect(String((await command($, 'clear')).text)).toBe(`The handoff of ${CWD} is removed.`)
    expect(String((await command($, 'show')).text)).toBe(`No handoff for ${CWD}.`)
    await clock.advance(5000)
    expect(prompts).toHaveLength(2)
  })

  test('past 200k and 400k tokens the user is told once each, and again in the session after /clear', async ($, on) => {
    mock.clock(on, { now: NOW * 1000 })
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    on('session.end', () => ({ sessionId: 'test' }) as never)
    on('classic.SessionStart', () => ({}) as never)
    const w = world(on, demoFiles())
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const measure = (tokens?: number) => $.session.measure({ context: { ...(tokens === undefined ? {} : { tokens }), window: 1_000_000 }, rateLimits: [], changed: ['context'] } as never)
    const told = () => w.toasts.filter(t => t.includes('/rft-handoff'))
    await measure()
    await measure(150_000)
    expect(told()).toHaveLength(0)
    await measure(205_300)
    expect(told()).toHaveLength(1)
    expect(told()[0]).toContain('rft: this session is at 205k tokens, sent again with every request. /rft-handoff leaves what the next session needs; /clear then goes on from it and the tree.')
    await measure(260_000)
    await measure(399_000)
    expect(told()).toHaveLength(1)
    await measure(402_000)
    await measure(700_000)
    expect(told()).toHaveLength(2)
    expect(told()[1]).toContain('402k tokens')
    // the session after /clear is small again, and told again when it grows
    await $.session.end({ reason: 'clear' } as never)
    await $.classic.SessionStart({ source: 'clear' } as never)
    await measure(60_000)
    expect(told()).toHaveLength(2)
    await measure(210_000)
    expect(told()).toHaveLength(3)
  })

  test('a project without rft is told nothing', async ($, on) => {
    mock.clock(on, { now: NOW * 1000 })
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    const w = world(on, {})
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    await $.session.measure({ context: { tokens: 500_000, window: 1_000_000 }, rateLimits: [], changed: ['context'] } as never)
    expect(w.toasts.filter(t => t.includes('/rft-handoff'))).toHaveLength(0)
    expect(String((await command($, 'show')).text)).toContain('RFT is not active in this project')
  })
})
