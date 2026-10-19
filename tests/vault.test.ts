// The vault model on an in-memory vault: loading, ids, titles, adding nodes, statuses,
// the derived files, validation and the HTML export.

import { describe, expect, test } from 'claude-code/testing'

import { addNode, initVault, setStatus, setTags, tagsReport } from '../hooks/lib/ops'
import { staticPage } from '../hooks/lib/page'
import { canvasJson, compactTree, front, load, parseTags, readConfig, sanitiseTag, sanitiseTitle, sync, topicalTags, validate } from '../hooks/lib/vault'
import { D00, D01, E01, E02, MemoryFs, WEB_FILES, demoFiles } from './fixture'

const loadDemo = async (fs = new MemoryFs(demoFiles())) => {
  const io = fs.io()
  return { fs, io, loaded: await load(io, (await readConfig(io))!) }
}

describe('vault', () => {
  test('reads the tree from the parent fields', async () => {
    const { loaded } = await loadDemo()
    expect(loaded.tree.roots).toEqual(['D00'])
    expect(loaded.tree.nodes.D00!.children).toEqual(['E01'])
    expect(loaded.tree.nodes.E02!.parent).toBe('D01')
    expect(compactTree(loaded.tree)).toBe(`✓ ${D00}\n  ✓ ${E01}\n    ? ${D01}\n      … ${E02}`)
  })

  test('titles lose the characters that break links', async () => {
    expect(sanitiseTitle('Loss ~ t^p [scaled] #3 | a/b: c?')).toBe('Loss ~ t to the power p (scaled) no. 3, a-b, c')
  })

  test('sync writes up, down, the index tree and the canvas, and is then stable', async () => {
    const { fs, io, loaded } = await loadDemo()
    const first = await sync(io, loaded)
    expect(first.changed).toContain('00 Index.md')
    expect(first.changed).toContain('Reasoning tree.canvas')
    const e01 = front(fs.read(`vault/experiments/${E01}.md`))
    expect(e01.up).toBe(`"[[${D00}]]"`)
    expect(e01.down).toBe(`["[[${D01}]]"]`)
    expect(fs.read('vault/00 Index.md')).toContain(`- ✓ [[${D00}]]\n    - ✓ [[${E01}]]\n        - ? [[${D01}]]`)
    const canvas = JSON.parse(fs.read('vault/Reasoning tree.canvas'))
    expect(canvas.nodes).toHaveLength(4)
    expect(canvas.edges).toHaveLength(3)
    const again = await sync(io, await load(io, loaded.config))
    expect(again.changed).toEqual([])
    expect((await validate(io, await load(io, loaded.config))).errors).toEqual([])
  })

  test('the canvas keeps cards moved by hand', async () => {
    const { loaded } = await loadDemo()
    const first = JSON.parse(canvasJson(loaded.tree))
    first.nodes[0].x = 9999
    const next = JSON.parse(canvasJson(loaded.tree, JSON.stringify(first)))
    expect(next.nodes[0].x).toBe(9999)
    expect(JSON.parse(canvasJson(loaded.tree, JSON.stringify(first), true)).nodes[0].x).not.toBe(9999)
  })

  test('adding a node assigns the next id and links it under its parent', async () => {
    const { fs, io, loaded } = await loadDemo()
    const node = await addNode(io, loaded, {
      type: 'experiment', title: 'Grid over p^2 [seeds]', parent: 'D01', date: '2026-02-01',
      sections: { What: 'A grid.', Why: 'To test D01.' },
    })
    expect(node.id).toBe('E03')
    expect(node.name).toBe('E03 Grid over p to the power 2 (seeds)')
    const text = fs.read(`vault/experiments/${node.name}.md`)
    expect(front(text).parent).toBe(`"[[${D01}]]"`)
    expect(front(text).status).toBe('planned')
    expect(text).toContain('## What\nA grid.')
    const parent = fs.read(`vault/directions/${D01}.md`)
    expect(front(parent).children).toBe(`["[[${E02}]]", "[[${node.name}]]"]`)
    expect(parent).toContain(`- [[${E02}]]\n- [[${node.name}]]`)
    expect(fs.read('vault/00 Index.md')).toContain(`- → [[${node.name}]]`)
    expect(JSON.parse(fs.read('.rft/config.json')).lastId.E).toBe(3)
    expect((await validate(io, await load(io, loaded.config))).errors).toEqual([])
  })

  test('ids are never reused, even after a note is deleted', async () => {
    const { fs, io, loaded } = await loadDemo()
    const a = await addNode(io, loaded, { type: 'direction', title: 'Idea one', parent: 'E02', date: '2026-02-01' })
    fs.files.delete(`vault/${a.path}`)
    const b = await addNode(io, await load(io, loaded.config), { type: 'direction', title: 'Idea two', parent: 'E02', date: '2026-02-01' })
    expect([a.id, b.id]).toEqual(['D02', 'D03'])
  })

  test('adding refuses unknown parents and a second root', async () => {
    const { io, loaded } = await loadDemo()
    await expect(addNode(io, loaded, { type: 'direction', title: 'x', parent: 'D42', date: '2026-02-01' })).rejects.toThrow(/not a note/)
    await expect(addNode(io, loaded, { type: 'direction', title: 'x', parent: null, date: '2026-02-01' })).rejects.toThrow(/parent is required/)
  })

  test('a status change updates the frontmatter, the tag, the status line and the note', async () => {
    const { fs, io, loaded } = await loadDemo()
    await setStatus(io, loaded, 'E02', 'done', 'Accuracy 91.2 ± 0.4 over 3 seeds.')
    const text = fs.read(`vault/experiments/${E02}.md`)
    expect(front(text).status).toBe('done')
    expect(front(text).tags).toBe('[demo, experiment, done]')
    expect(text).toContain('**Status:** done')
    expect(text).toContain('Text of E02.\nAccuracy 91.2 ± 0.4 over 3 seeds.')
    expect(fs.read('vault/00 Index.md')).toContain(`- ✓ [[${E02}]]`)
  })

  test('validation reports broken links, bad statuses and forbidden titles', async () => {
    const files = demoFiles()
    files[`vault/experiments/${E02}.md`] = files[`vault/experiments/${E02}.md`]!.replace('status: running', 'status: maybe') + '\nSee [[Nowhere]].\n'
    files['vault/directions/D02 Bad #title.md'] = `---\nid: D02\ntype: direction\nstatus: idea\ndate: 2026-01-01\nparent: "[[${E02}]]"\n---\n`
    const { io, loaded } = await loadDemo(new MemoryFs(files))
    const v = await validate(io, loaded)
    expect(v.errors.some(x => x.includes('status "maybe"'))).toBe(true)
    expect(v.errors.some(x => x.includes('broken link [[Nowhere]]'))).toBe(true)
    expect(v.errors.some(x => x.includes('breaks links'))).toBe(true)
  })

  test('init creates the skeleton and the root, or adopts an existing vault', async () => {
    const fresh = new MemoryFs({})
    const res = await initVault(fresh.io(), { project: 'demo', question: 'Can we fly?', date: '2026-02-01' })
    expect(res.isAdopted).toBe(false)
    expect(fresh.exists('vault/directions/D00 Can we fly.md')).toBe(true)
    expect(fresh.exists('vault/templates/_experiment.md')).toBe(true)
    expect(fresh.read('vault/00 Index.md')).toContain('- ? [[D00 Can we fly]]')
    expect(fresh.exists('.rft/config.json')).toBe(true)

    const files = demoFiles()
    delete files['.rft/config.json']
    const old = new MemoryFs(files)
    const adopted = await initVault(old.io(), { project: 'demo', question: '', date: '2026-02-01' })
    expect(adopted.isAdopted).toBe(true)
    expect(JSON.parse(old.read('.rft/config.json')).lastId).toEqual({ E: 2, D: 1 })
    expect(old.read(`vault/experiments/${E01}.md`)).toBe(files[`vault/experiments/${E01}.md`])
  })

  test('topical tags: read from the frontmatter less the project, type and status tags', async () => {
    expect(parseTags('[demo, experiment, theory, "Radial rule", done]')).toEqual(['demo', 'experiment', 'theory', 'Radial', 'rule', 'done'])
    expect(parseTags('#theory #cluster')).toEqual(['theory', 'cluster'])
    expect(parseTags(undefined)).toEqual([])
    expect(topicalTags(['demo', 'experiment', 'theory', 'done', 'theory', 'running'], 'demo')).toEqual(['theory'])
    expect(sanitiseTag(' Radial Rule! ')).toBe('radial-rule')
    expect(sanitiseTag('#ResNet_18')).toBe('resnet-18')
    const files = demoFiles()
    files[`vault/experiments/${E02}.md`] = files[`vault/experiments/${E02}.md`]!.replace('tags: [demo, experiment, running]', 'tags: [demo, experiment, cluster, running]')
    const { loaded } = await loadDemo(new MemoryFs(files))
    expect(loaded.tree.nodes.E02!.tags).toEqual(['cluster'])
    expect(loaded.tree.nodes.E01!.tags).toEqual([])
  })

  test('a new note carries its topical tags between type and status; set_tags replaces only those', async () => {
    const { fs, io, loaded } = await loadDemo()
    const n = await addNode(io, loaded, { type: 'experiment', title: 'Seed sweep', parent: 'D01', date: '2026-02-01', tags: ['Ablation', 'seeds', 'ablation'] })
    expect(front(fs.read(`vault/${n.path}`)).tags).toBe('[demo, experiment, ablation, seeds, planned]')
    expect(n.tags).toEqual(['ablation', 'seeds'])
    const out = await setTags(io, await load(io, loaded.config), 'E03', ['cluster run'])
    expect(out).toContain('tags cluster-run')
    expect(front(fs.read(`vault/${n.path}`)).tags).toBe('[demo, experiment, cluster-run, planned]')
    await setStatus(io, await load(io, loaded.config), 'E03', 'done')
    expect(front(fs.read(`vault/${n.path}`)).tags).toBe('[demo, experiment, cluster-run, done]')
    expect(tagsReport(await load(io, loaded.config))).toContain('- cluster-run (1)')
    expect((await validate(io, await load(io, loaded.config))).warnings).toEqual([])
  })

  test('the validator warns about a tag that is not lowercase kebab-case', async () => {
    const files = demoFiles()
    files[`vault/experiments/${E02}.md`] = files[`vault/experiments/${E02}.md`]!.replace('tags: [demo, experiment, running]', 'tags: [demo, experiment, Big_Tag, running]')
    const { io, loaded } = await loadDemo(new MemoryFs(files))
    expect((await validate(io, loaded)).warnings.some(w => w.includes('Big_Tag not lowercase kebab-case'))).toBe(true)
  })

  test('the static page inlines the web view and embeds the tree with every note', async () => {
    const { tree, texts } = (await loadDemo()).loaded
    const html = staticPage({ html: WEB_FILES['web/index.html']!, css: 'a{}', js: 'go()', d3: 'd3()', filters: 'filt()', layout: 'lay()', concepts: 'con()' }, tree, texts, 'demo', 'v1')
    const data = JSON.parse(/window\.RFT_DATA = (.*?);<\/script>/.exec(html)![1]!)
    expect(data.tree.project).toBe('demo')
    expect(data.tree.roots).toEqual(['D00'])
    expect(data.tree.nodes).toHaveLength(4)
    expect(data.bodies.E02).toContain('Text of E02.')
    expect(data.bodies.E02).not.toContain('status: running')
    expect(html).toContain('<style>a{}</style>')
    expect(html).toContain('<script>filt()</script>')
    expect(html).toContain('<script>lay()</script>')
    expect(data.tree.tags).toEqual([])
    expect(html).not.toMatch(/src=|href="app\.css"/)
  })

})
