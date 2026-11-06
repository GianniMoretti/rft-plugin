// Code repos linked to concepts: `concept_repos:` read and inherited (a sub-concept's own repos
// first), the `## Code` section of a note, rft_set_repos, rft_code and rft_set_code on a fake git,
// validation, the session rules, the tree view's concepts.js, and the tools in a session.

import { describe, expect, mock, test } from 'claude-code/testing'

import '../web/concepts.js'

import type { CodeEnv } from '../hooks/lib/ops'
import { addNode, codeReport, conceptsReport, rulesText, setCode, setConcept, setRepos, today } from '../hooks/lib/ops'
import { treeJson } from '../hooks/lib/page'
import { ROOT_CONCEPT, codeRepos, codeSection, load, noteText, parseRepos, readConfig, reposLine, rooted, validate, withCodeSection } from '../hooks/lib/vault'
import type { FakeRepo, GitAnswer } from './fixture'
import { D00, D01, E01, E02, MemoryFs, demoAt, fakeGit, world } from './fixture'

type Concepts = { byId: (tree: unknown) => Map<string, unknown>; reposOf: (c: Map<string, unknown>, id: string) => { path: string; concept: string }[] }
const C = (globalThis as unknown as { RftConcepts: Concepts }).RftConcepts

const ROOT = '/work/demo'
const SFREE = '/work/code/sfree'
const UTILS = '/work/code/utils'
const at = (path: string) => `${ROOT}/vault/${path}`
const PATH = {
  D00: at(`directions/${D00}.md`), E01: at(`experiments/${E01}.md`), D01: at(`directions/${D01}.md`), E02: at(`experiments/${E02}.md`),
}

/** Adds `concept:` (and `concept_repos:`) to a note, after its tags; a null name adds the repos alone. */
function declare(files: Record<string, string>, path: string, name: string | null, repos: string[] = []) {
  const lines = [...(name ? [`concept: "${name}"`] : []), ...(repos.length ? [`concept_repos: ${reposLine(repos)}`] : [])]
  files[path] = files[path]!.replace(/^(tags: .*)$/m, `$1\n${lines.join('\n')}`)
  return files
}

/**
 * The demo tree in /work/demo with two repos beside it, sfree and utils:
 *   D00 ─ E01 (concept "Checks", code ../code/utils) ─ D01 (concept "Variants", code sfree) ─ E02
 */
function project(opts: { sfree?: boolean } = {}) {
  const files = demoAt(ROOT, {
    [`${SFREE}/.git/HEAD`]: 'ref: refs/heads/main\n',
    [`${SFREE}/train.py`]: 'print("train")\n',
    [`${UTILS}/.git/HEAD`]: 'ref: refs/heads/main\n',
    [`${UTILS}/lib.py`]: '',
  })
  declare(files, PATH.E01, 'Checks', ['../code/utils'])
  declare(files, PATH.D01, 'Variants', opts.sfree === false ? [] : [SFREE])
  return files
}

const open = async (files: Record<string, string>) => {
  const fs = new MemoryFs(files, true)
  const io = rooted(fs.io(), ROOT)
  return { fs, io, loaded: await load(io, (await readConfig(io))!) }
}

const repos = (): Record<string, FakeRepo> => ({ [SFREE]: { commit: 'a1b2c3d4e5f60718' }, [UTILS]: { commit: '0f0e0d0c0b0a0908' } })

/** The ops' git on the fake one. */
const envOf = (git: GitAnswer, extra: Partial<CodeEnv> = {}): CodeEnv => ({ root: ROOT, git: async (d, a) => git(d, a), date: '2026-11-06', ...extra })

describe('code repos of concepts', () => {
  test("a concept's own repos come first, then those of the concepts above it, nearest first", async () => {
    const files = project()
    // a repo linked at both levels counts once, at the sub-concept's place
    files[PATH.D01] = files[PATH.D01]!.replace(`concept_repos: ["${SFREE}"]`, `concept_repos: ["${SFREE}", "../code/utils"]`)
    const { loaded } = await open(files)
    const concepts = loaded.tree.concepts!
    expect(concepts.E01!.repos).toEqual(['../code/utils'])
    expect(loaded.tree.nodes.E02!.concept).toBe('D01')
    expect(codeRepos(concepts, 'D01')).toEqual([{ path: SFREE, concept: 'D01' }, { path: '../code/utils', concept: 'D01' }])
    expect(codeRepos(concepts, 'E01')).toEqual([{ path: '../code/utils', concept: 'E01' }])
    expect(codeRepos(concepts, ROOT_CONCEPT)).toEqual([])
    const { loaded: plain } = await open(project())
    expect(codeRepos(plain.tree.concepts, 'D01')).toEqual([{ path: SFREE, concept: 'D01' }, { path: '../code/utils', concept: 'E01' }])
    // the API, the static page and the tree view read the same
    const json = treeJson(plain.tree, 'demo', 'v')
    expect(json.concepts.find(c => c.id === 'D01')!.repos).toEqual([SFREE])
    expect(C.reposOf(C.byId(json), 'D01')).toEqual([{ path: SFREE, concept: 'D01' }, { path: '../code/utils', concept: 'E01' }])
    expect(C.reposOf(C.byId(json), ROOT_CONCEPT)).toEqual([])
  })

  test("concept_repos is a one-line list, JSON or YAML; the only root note's repos are the project's", async () => {
    expect(parseRepos('["/a b/c", "../d"]')).toEqual(['/a b/c', '../d'])
    expect(parseRepos("['/a', ../b]")).toEqual(['/a', '../b'])
    expect(parseRepos('/one/path')).toEqual(['/one/path'])
    expect(parseRepos('["/x", "/x"]')).toEqual(['/x'])
    expect(parseRepos('')).toEqual([])
    expect(parseRepos(reposLine(['/x', 'y, z']))).toEqual(['/x', 'y, z'])
    const files = declare(demoAt(ROOT, { [`${SFREE}/.git/HEAD`]: '' }), PATH.D00, null, [SFREE])
    const { loaded } = await open(files)
    expect(Object.keys(loaded.tree.concepts!)).toEqual([ROOT_CONCEPT])
    expect(loaded.tree.concepts!.root!.repos).toEqual([SFREE])
    expect(codeRepos(loaded.tree.concepts, loaded.tree.nodes.E02!.concept)).toEqual([{ path: SFREE, concept: ROOT_CONCEPT }])
  })

  test('the Code section goes before Result or Status, reads back, and keeps its description and Reproduce unless given', () => {
    const line = (c: string) => `- \`/r\` @ ${c} (main) · checked 2026-11-06`
    const exp = noteText('E09', { type: 'experiment', title: 'Sweep', parent: 'D01 A', date: '2026-11-06', sections: { What: 'w', Why: 'y' } }, 'demo', 'D01 A')
    expect(codeSection(exp)).toBeNull()
    let t = withCodeSection(exp, 'experiment', { repos: [line('abcdef1234')], description: 'Uses `train.py`.' })
    expect(t.indexOf('## Why')).toBeLessThan(t.indexOf('## Code'))
    expect(t.indexOf('## Code')).toBeLessThan(t.indexOf('## Result'))
    expect(t).toContain(`## Code\n${line('abcdef1234')}\n\nUses \`train.py\`.\n\n## Result`)
    expect(codeSection(t)).toEqual({ repos: [{ path: '/r', commit: 'abcdef1234', line: line('abcdef1234') }], description: 'Uses `train.py`.', reproduce: '' })
    t = withCodeSection(t, 'experiment', { repos: [line('1111111111')], reproduce: 'at 1111111111: `python train.py`' })
    expect(codeSection(t)).toEqual({ repos: [{ path: '/r', commit: '1111111111', line: line('1111111111') }], description: 'Uses `train.py`.', reproduce: 'at 1111111111: `python train.py`' })
    t = withCodeSection(t, 'experiment', { repos: [line('2222222222')], description: 'Now `run.py`.' })
    expect(codeSection(t)!.reproduce).toBe('at 1111111111: `python train.py`')
    expect(codeSection(t)!.description).toBe('Now `run.py`.')
    expect(t.match(/^## Code$/gm)).toHaveLength(1)
    // the frontmatter and the other sections are untouched
    expect(t.slice(0, t.indexOf('## Code'))).toBe(exp.slice(0, exp.indexOf('## Result')))
    // a direction's goes before Status; a heading inside a fenced block is the description's
    const dir = noteText('D09', { type: 'direction', title: 'Idea', parent: 'E01 A', date: '2026-11-06', sections: { Idea: 'i' } }, 'demo', 'E01 A')
    const d = withCodeSection(dir, 'direction', { repos: [line('abcdef1234')], description: '```\n## not a heading\n```\nLands in `train.py`.' })
    expect(d.indexOf('## Idea')).toBeLessThan(d.indexOf('## Code'))
    expect(d.indexOf('## Code')).toBeLessThan(d.indexOf('## Status'))
    expect(codeSection(d)!.description).toBe('```\n## not a heading\n```\nLands in `train.py`.')
    // a Code section given at creation goes to the same place
    const made = noteText('E10', { type: 'experiment', title: 'Run', parent: 'D01 A', date: '2026-11-06', sections: { Code: line('abcdef1234') } }, 'demo', 'D01 A')
    expect(made.indexOf('## Why')).toBeLessThan(made.indexOf('## Code'))
    expect(made.indexOf('## Code')).toBeLessThan(made.indexOf('## Result'))
  })

  test("an experiment or direction added in a concept with code gets a Code section with each repo's commit now", async () => {
    const { fs, io, loaded } = await open(project())
    const git = fakeGit(repos())
    const env = envOf(git)
    const e = await addNode(io, loaded, { type: 'experiment', title: 'Free schedule', parent: 'D01', date: '2026-11-06', sections: { What: 'w', Code: 'Entry point `train.py`.' } }, env)
    const text = fs.read(at('experiments/E03 Free schedule.md'))
    expect(codeSection(text)).toEqual({
      repos: [
        { path: SFREE, commit: 'a1b2c3d4e5', line: `- \`${SFREE}\` @ a1b2c3d4e5 (main) · checked 2026-11-06` },
        { path: '../code/utils', commit: '0f0e0d0c0b', line: '- `../code/utils` @ 0f0e0d0c0b (main) · checked 2026-11-06 · inherited from Checks' },
      ],
      description: 'Entry point `train.py`.',
      reproduce: '',
    })
    expect(text.indexOf('## Code')).toBeLessThan(text.indexOf('## Result'))
    expect(e.report).toContain(`Its concept links code: ${SFREE}: main @ a1b2c3d4e5, clean; ../code/utils (inherited from Checks): main @ 0f0e0d0c0b, clean.`)
    expect(e.report).toContain('holds your description')
    const d = await addNode(io, loaded, { type: 'direction', title: 'Warmup', parent: 'E03', date: '2026-11-06' }, env)
    expect(d.report).toContain('write how this note relates to it with rft_set_code')
    expect(codeSection(fs.read(at(`directions/${d.name}.md`)))!.description).toBe('')
    // an idea not pursued, a reference, a note in a concept without code, and a call without env get none
    const none = [
      await addNode(io, loaded, { type: 'direction', title: 'Not this', parent: 'D01', status: 'discussed', date: '2026-11-06' }, env),
      await addNode(io, loaded, { type: 'reference', title: 'A paper', parent: 'D01', date: '2026-11-06' }, env),
      await addNode(io, loaded, { type: 'direction', title: 'Elsewhere', parent: 'D00', date: '2026-11-06' }, env),
      await addNode(io, loaded, { type: 'experiment', title: 'No env', parent: 'D01', date: '2026-11-06' }),
    ]
    for (const n of none) {
      expect(fs.read(at(n.path))).not.toContain('## Code')
      expect(n.report).not.toContain('links code')
    }
  })

  test('rft_set_repos links code to a concept, and refuses a note that starts none or a path that does not exist', async () => {
    const { fs, io, loaded } = await open(project({ sfree: false }))
    const env = envOf(fakeGit(repos()))
    await expect(setRepos(io, loaded, env, 'E02', [SFREE])).rejects.toThrow('starts no concept')
    await expect(setRepos(io, loaded, env, 'D01', ['/work/code/nowhere'])).rejects.toThrow('not found: /work/code/nowhere. Ask the user for the path')
    await expect(setRepos(io, loaded, env, 'D01', ['../code/nowhere'])).rejects.toThrow("a relative path starts from the tree's folder, /work/demo")
    expect(fs.read(PATH.D01)).not.toContain('concept_repos')
    const said = await setRepos(io, loaded, env, 'D01', ['../code/sfree/'])
    expect(fs.read(PATH.D01)).toContain('concept: "Variants"\nconcept_repos: ["../code/sfree"]\n')
    expect(said).toContain('concept "Variants" (from D01) now links, by priority:')
    expect(said).toContain(`- ../code/sfree (${SFREE}): main @ a1b2c3d4e5, clean. Sessions started there find no tree: a .rft/config.json there holding {"tree": "/work/demo"} would link them to this one. Ask the user before writing it into the repo.`)
    expect(said).toContain('Inherited from the concepts above, after these: ../code/utils (Checks).')
    expect(said).toContain('give each of these notes a ## Code section with rft_set_code (how it relates to the code; for an experiment with results, how to reproduce them): D01, E02.')
    expect(loaded.tree.concepts!.D01!.repos).toEqual(['../code/sfree'])
    // a link in the repo makes its sessions work on this tree
    fs.write(`${SFREE}/.rft/config.json`, JSON.stringify({ tree: '../../demo' }))
    expect(await setRepos(io, loaded, env, 'D01', ['../code/sfree'])).toContain('Sessions started there work on this tree.')
    // ~ is the home folder
    await setRepos(io, loaded, envOf(fakeGit(repos()), { home: '/work' }), 'D01', ['~/code/sfree'])
    expect(fs.read(PATH.D01)).toContain(`concept_repos: ["${SFREE}"]`)
    // an empty list removes the link
    expect(await setRepos(io, loaded, env, 'D01', [])).toContain(`links no code any more (was ${SFREE})`)
    expect(fs.read(PATH.D01)).not.toContain('concept_repos')
    expect(await setRepos(io, loaded, env, 'D01', [])).toContain('linked no code: nothing to remove')
    // the root note links the whole project's code, with or without a concept of its own
    const top = await setRepos(io, loaded, env, 'D00', [SFREE])
    expect(top).toContain('the project now links')
    expect(top).toContain('D00, E01, D01, E02.')
    expect(fs.read(PATH.D00)).toMatch(/^tags: .*\nconcept_repos: \["\/work\/code\/sfree"\]$/m)
    expect(loaded.tree.concepts!.root!.repos).toEqual([SFREE])
  })

  test('rft_code lists what changed since the commit a note was checked against; rft_set_code records the commit now', async () => {
    const { fs, io, loaded } = await open(project())
    const state = repos()
    const git = fakeGit(state)
    const env = envOf(git)
    expect(await codeReport(io, loaded, env, 'D00')).toContain('which links no code, nor does any concept above it')
    await expect(setCode(io, loaded, env, 'D00', 'x')).rejects.toThrow('links no code: link a repo first with rft_set_repos')
    expect(await codeReport(io, loaded, env, 'E02')).toContain('The note has no ## Code section: read the code as it is now and write one with rft_set_code.')
    expect(await setCode(io, loaded, env, 'E02', 'Runs `train.py --free`.')).toBe(
      `${E02}: ## Code written, checked against ${SFREE}: main @ a1b2c3d4e5, clean; ../code/utils (inherited from Checks): main @ 0f0e0d0c0b, clean.`,
    )
    expect(await codeReport(io, loaded, env, 'E02')).toContain('   Checked at a1b2c3d4e5: nothing changed since.')
    // the code moves on: two commits, and a change not committed yet
    state[SFREE] = {
      commit: 'ffffeeee00001111', dirty: 1, known: ['a1b2c3d4e5f60718'], log: ['ffffeee Add the flag', 'bbbbccc Fix the seed'],
      stat: [' train.py | 4 +++-', ' 1 file changed, 3 insertions(+), 1 deletion(-)'],
    }
    const r = await codeReport(io, loaded, env, 'E02')
    expect(r).toContain(`${E02}, in concept "Variants" (from D01). Its code, by priority:`)
    expect(r).toContain(`1. ${SFREE}, its concept's own: now main @ ffffeeee00, uncommitted changes in 1 file(s).\n   Checked at a1b2c3d4e5.\n   Commits since (newest first):\n     ffffeee Add the flag\n     bbbbccc Fix the seed`)
    expect(r).toContain('   Files changed since, uncommitted changes included (1 file changed, 3 insertions(+), 1 deletion(-)):\n     train.py | 4 +++-')
    expect(r).toContain(`2. ../code/utils (${UTILS}), inherited from Checks: now main @ 0f0e0d0c0b, clean.\n   Checked at 0f0e0d0c0b: nothing changed since.`)
    expect(git.calls).toContainEqual([SFREE, 'diff', '--stat=120', 'a1b2c3d4e5'])
    // the references checked again: the commits now are recorded, the description kept
    const said = await setCode(io, loaded, env, 'E02', undefined, 'at ffffeeee00: `python train.py --free --seed 0 1 2`; raw outputs in `runs/E02/`, aggregated with `tools/summary.py`.')
    expect(said).toContain('## Code updated')
    const cs = codeSection(fs.read(PATH.E02))!
    expect(cs.repos.map(x => x.commit)).toEqual(['ffffeeee00', '0f0e0d0c0b'])
    expect(cs.repos[0]!.line).toBe(`- \`${SFREE}\` @ ffffeeee00 (main, uncommitted changes in 1 file(s)) · checked 2026-11-06`)
    expect(cs.description).toBe('Runs `train.py --free`.')
    expect(cs.reproduce).toContain('runs/E02/')
    // a commit the repo no longer has
    state[SFREE] = { commit: '9999999999999999' }
    expect(await codeReport(io, loaded, env, 'E02')).toContain('The commit ffffeeee00 is not in this repository (rebased, or another clone?)')
    // a done experiment (E01) is asked how to reproduce its results, a running one (E02) not yet
    expect(said).not.toContain('reproduce')
    expect(await setCode(io, loaded, env, 'E01', 'Checks `lib.py`.')).toContain('A done experiment says how to reproduce its results: pass reproduce.')
    // a repo not under git is said so, with no commit recorded
    delete state[UTILS]
    fs.remove(`${UTILS}/.git/HEAD`)
    const plain = await setCode(io, loaded, env, 'E01')
    expect(plain).toContain('../code/utils: not under git (no commit can be recorded)')
    expect(codeSection(fs.read(PATH.E01))!.repos).toEqual([{ path: '../code/utils', commit: null, line: '- `../code/utils` (not under git) · checked 2026-11-06' }])
    // a repo git fails on says why, in whatever language git speaks
    delete state[SFREE]
    expect(await codeReport(io, loaded, env, 'E02')).toContain(`1. ${SFREE}, its concept's own: now git failed (fatal: not a git repository (or any of the parent directories): .git).`)
  })

  test('validation: repos missing or not under git, concept_repos on a note without a concept, Code sections missing or stale', async () => {
    const files = project()
    files[`/work/code/plain/a.py`] = ''
    files[`${SFREE}/pkg/a.py`] = ''
    files[PATH.D01] = files[PATH.D01]!.replace(`concept_repos: ["${SFREE}"]`, `concept_repos: ["${SFREE}", "/work/code/gone", "../code/plain", "${SFREE}/pkg"]`)
    declare(files, PATH.E02, null, [SFREE])
    const { io, loaded } = await open(files)
    const v = await validate(io, loaded, { root: ROOT })
    expect(v.warnings).toContain('D01: repo /work/code/gone not found')
    expect(v.warnings).toContain('D01: repo ../code/plain is not in a git repository, so the commits its notes were checked against cannot be recorded')
    // a folder inside a git repository is under git
    expect(v.warnings.filter(w => w.startsWith(`D01: repo ${SFREE}/pkg`))).toEqual([])
    expect(v.warnings).toContain('E02: concept_repos without concept, ignored (repos belong to a concept, or to the root note for the whole project)')
    expect(v.warnings).toContain('E01: its concept links code (../code/utils) but the note has no ## Code section (rft_set_code writes it)')
    expect(v.warnings.filter(w => w.startsWith('D00: its concept'))).toEqual([])
    // once written, the warning goes; a repo the concept no longer links is named
    const { fs, io: io2, loaded: l2 } = await open(project())
    const env = envOf(fakeGit(repos()))
    for (const id of ['E01', 'D01', 'E02']) await setCode(io2, l2, env, id, 'x')
    expect((await validate(io2, l2, { root: ROOT })).warnings.filter(w => /Code|repo/.test(w))).toEqual([])
    await setRepos(io2, l2, env, 'D01', [UTILS])
    const after = (await validate(io2, l2, { root: ROOT })).warnings
    expect(after).toContain(`E02: ## Code names ${SFREE}, which its concept no longer links (rft_set_code updates it)`)
    expect(after).toContain(`E02: ## Code does not cover ${UTILS} (rft_set_code adds it)`)
    expect(fs.read(PATH.E02)).toContain('## Code')
  })

  test("the session rules name each concept's code, the project's, and the concept whose code the session runs in", async () => {
    const { loaded } = await open(project())
    const rules = rulesText(loaded.tree, loaded.config, 'vault', { cwd: `${SFREE}/src`, root: ROOT })
    expect(rules).toContain('## demo › Checks (from E01) · code: ../code/utils')
    expect(rules).toContain(`## demo › Checks › Variants (from D01) · code: ${SFREE}`)
    expect(rules).toContain('This session runs in the code of concept "Variants" (from D01): new experiments and directions from here usually belong under it')
    expect(rules).toContain('call rft_code')
    expect(rules).toContain('ask the user whether code for it already exists and where')
    expect(rulesText(loaded.tree, loaded.config, 'vault', { cwd: '/work/code/sfreeish', root: ROOT })).not.toContain('This session runs in the code')
    expect(conceptsReport(loaded)).toMatch(/- Variants \[@D01\] 2 note\(s\).* · code: \/work\/code\/sfree$/m)
    // no concepts, the project's code on the root note
    const { loaded: top } = await open(declare(demoAt(ROOT, { [`${SFREE}/.git/HEAD`]: '' }), PATH.D00, null, [SFREE]))
    const said = rulesText(top.tree, top.config, 'vault', { cwd: SFREE, root: ROOT })
    expect(said).toContain(`The project's code (every note works with it): ${SFREE}.`)
    expect(said).toContain('This session runs in the code of the whole project')
  })

  test('a new concept asks for its code and says what it inherits; removing a concept removes its code links', async () => {
    const { fs, io, loaded } = await open(project())
    const said = await setConcept(io, loaded, 'E02', 'Runs')
    expect(said).toContain(`It inherits code from the concepts above: ${SFREE} (Variants), ../code/utils (Checks).`)
    expect(said).toContain('Ask the user whether code for this line of research already exists on this machine, and where')
    expect(await setConcept(io, loaded, 'E02', 'Long runs')).not.toContain('Ask the user')
    const off = await setConcept(io, loaded, 'D01', null)
    expect(off).toContain(`Its code links (${SFREE}) went with it.`)
    expect(fs.read(PATH.D01)).not.toContain('concept_repos')
  })
})

describe('code tools in a session', () => {
  test('rft_add_node, rft_code, rft_set_code and rft_set_repos through tool calls', async ($, on) => {
    mock.clock(on)
    const git = fakeGit(repos())
    const w = world(on, project(), { cwd: ROOT, git })
    await $.session.start({ cwd: ROOT, source: 'startup' } as never)
    const added = await $.tool.call({ tool: 'mcp__rft__rft_add_node', type: 'experiment', title: 'Free schedule', parent: 'D01', what: 'w', sections: { Code: 'Uses `train.py`.' } } as never)
    expect(added.isError).toBeUndefined()
    expect(added.text).toContain('Its concept links code')
    expect(w.fs.read(at('experiments/E03 Free schedule.md'))).toContain(`## Code\n- \`${SFREE}\` @ a1b2c3d4e5 (main) · checked ${today()}\n`)
    expect(git.calls[0]).toEqual([SFREE, 'status', '--porcelain=v2', '--branch', '--untracked-files=no'])
    const code = await $.tool.call({ tool: 'mcp__rft__rft_code', id: 'E03' } as never)
    expect(code.text).toContain('Checked at a1b2c3d4e5: nothing changed since.')
    const set = await $.tool.call({ tool: 'mcp__rft__rft_set_code', id: 'E03', reproduce: 'at a1b2c3d4e5: `python train.py`' } as never)
    expect(set.isError).toBeUndefined()
    expect(codeSection(w.fs.read(at('experiments/E03 Free schedule.md')))!.description).toBe('Uses `train.py`.')
    const bad = await $.tool.call({ tool: 'mcp__rft__rft_set_repos', id: 'E02', repos: [SFREE] } as never)
    expect(bad.isError).toBe(true)
    const off = await $.tool.call({ tool: 'mcp__rft__rft_set_repos', id: 'E01', repos: [] } as never)
    expect(off.text).toContain('links no code any more')
    const check = await $.tool.call({ tool: 'mcp__rft__rft_validate' } as never)
    expect(check.text).toContain('D01: its concept links code')
  })

  test('a session started in a concept\'s repo, linked to the tree, is told whose code it runs in', async ($, on) => {
    mock.clock(on)
    const files = { ...project(), [`${SFREE}/.rft/config.json`]: JSON.stringify({ tree: '../../demo' }) }
    world(on, files, { cwd: SFREE, git: fakeGit(repos()) })
    on('prompt.compose', () => ({ sections: [] }))
    await $.session.start({ cwd: SFREE, source: 'startup' } as never)
    const res = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
    const rules = res.sections.find(s => s.id === 'rft:rules')!.text
    expect(rules).toContain('This session runs in the code of concept "Variants" (from D01)')
    expect(rules).toContain(`## demo › Checks › Variants (from D01) · code: ${SFREE}`)
  })
})
