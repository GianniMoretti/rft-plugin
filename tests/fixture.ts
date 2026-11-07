// An in-memory project for the tests: a small vault and the `$.fs` / `$.session` / `$.ui`
// answers a session would give beneath the plugin.

import type { On } from 'claude-code'

import type { Io } from '../hooks/lib/vault'

export const CWD = '/work/demo'

const note = (id: string, type: string, status: string, parent: string, title: string, children: string[] = []) =>
  `---
id: ${id}
type: ${type}
status: ${status}
date: 2026-01-0${id.slice(-1) === '0' ? 1 : id.slice(-1)}
parent: ${parent ? `"[[${parent}]]"` : '""'}
children: [${children.map(c => `"[[${c}]]"`).join(', ')}]
tags: [demo, ${type}, ${status}]
---

# ${id} · ${title}

**Parent:** ${parent ? `[[${parent}]]` : '(root)'}
**Status:** ${status} · **Date:** 2026-01-01

## ${type === 'experiment' ? 'Result' : 'Idea'}
Text of ${id}.

## Children in the tree
${children.map(c => `- [[${c}]]`).join('\n')}
`

export const D00 = 'D00 Does the thing work'
export const E01 = 'E01 First check'
export const D01 = 'D01 A better variant'
export const E02 = 'E02 Variant run'

/** Stand-ins for the web view's files, with the markers the static export inlines. */
export const WEB_FILES: Record<string, string> = {
  'web/index.html': '<!doctype html><html><head><script src="theme.js" data-rft-inline></script><link rel="stylesheet" href="app.css" data-rft-inline><link rel="stylesheet" href="vendor/katex.v0.16.22.min.css" data-rft-inline></head><body>' +
    '<script src="vendor/d3.v7.9.0.min.js" data-rft-inline></script><script src="vendor/katex.v0.16.22.min.js" data-rft-inline></script><script src="filters.js" data-rft-inline></script>' +
    '<script src="layout.js" data-rft-inline></script><script src="concepts.js" data-rft-inline></script><script src="markdown.js" data-rft-inline></script>' +
    '<script src="app.js" data-rft-inline></script></body></html>',
  'web/app.css': 'body { color: red }',
  'web/app.js': 'console.log(window.RFT_DATA.tree.nodes.length, "$&")',
  'web/vendor/d3.v7.9.0.min.js': '/* d3 */ var d3 = {}; "</script>"',
  'web/vendor/katex.v0.16.22.min.js': '/* katex */',
  'web/vendor/katex.v0.16.22.min.css': '/* katex css */',
  'web/filters.js': '/* filters */',
  'web/layout.js': '/* layout */',
  'web/concepts.js': '/* concepts */',
  'web/markdown.js': '/* markdown */',
  'web/theme.js': '/* theme */',
}

export function demoFiles(): Record<string, string> {
  return {
    '.rft/config.json': JSON.stringify({ version: 1, vault: 'vault', project: 'demo', canvas: true, mermaid: false, lastId: { E: 2, D: 1 } }),
    [`vault/directions/${D00}.md`]: note('D00', 'direction', 'done', '', 'Does the thing work', [E01]),
    [`vault/experiments/${E01}.md`]: note('E01', 'experiment', 'done', D00, 'First check', [D01]),
    [`vault/directions/${D01}.md`]: note('D01', 'direction', 'idea', E01, 'A better variant', [E02]),
    [`vault/experiments/${E02}.md`]: note('E02', 'experiment', 'running', D01, 'Variant run'),
    'vault/00 Index.md': '---\ntype: index\n---\n\n# demo\n\n## The tree\n\n## Elsewhere\nNothing.\n',
  }
}

/** The demo project kept in the folder `at`, keyed by absolute path, with `extra` files beside it. */
export const demoAt = (at: string, extra: Record<string, string> = {}): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(demoFiles()).map(([k, v]) => [`${at}/${k}`, v])),
  ...extra,
})

/** A file map with directory listing, as `$.fs` would see a folder tree. */
export class MemoryFs {
  files: Map<string, { text: string; mtimeMs: number }>
  private clock = 1
  /** `byPath`: the files are keyed by absolute path, as the plugin asks for them once it has located the tree. */
  constructor(files: Record<string, string>, private byPath = false) {
    this.files = new Map(Object.entries(files).map(([k, v]) => [k, { text: v, mtimeMs: 1 }]))
  }
  norm(p: string) {
    if (this.byPath) return p
    // the engine resolves relative paths against the test session's folder
    return p.replace(/^\/.*?\/(?=(\.rft|vault|web|server)(\/|$))/, '').replace(/^\.\//, '')
  }
  read(p: string) {
    const f = this.files.get(this.norm(p))
    if (!f) throw new Error(`ENOENT: ${p}`)
    return f.text
  }
  write(p: string, text: string) {
    this.files.set(this.norm(p), { text, mtimeMs: ++this.clock })
  }
  remove(p: string) {
    this.files.delete(this.norm(p))
  }
  isDir(p: string) {
    const d = this.norm(p).replace(/\/$/, '') + '/'
    return [...this.files.keys()].some(k => k.startsWith(d))
  }
  exists(p: string) {
    return this.files.has(this.norm(p)) || this.isDir(p)
  }
  list(p: string) {
    const d = this.norm(p).replace(/\/$/, '')
    const prefix = d ? d + '/' : ''
    const out = new Map<string, { name: string; kind: 'file' | 'dir'; size: number; mtimeMs: number; isLink: boolean }>()
    for (const [k, f] of this.files) {
      if (!k.startsWith(prefix)) continue
      const rest = k.slice(prefix.length)
      const [head, ...more] = rest.split('/')
      if (more.length) out.set(head!, { name: head!, kind: 'dir', size: 0, mtimeMs: 0, isLink: false })
      else out.set(head!, { name: head!, kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false })
    }
    if (!out.size) throw new Error(`ENOENT: ${p}`)
    return [...out.values()]
  }
  io(): Io {
    return {
      read: async p => this.read(p),
      write: async (p, t) => this.write(p, t),
      remove: async p => this.remove(p),
      list: async p => this.list(p),
      exists: async p => this.exists(p),
    }
  }
}

export type World = { fs: MemoryFs; tools: string[]; opened: string[]; commands: string[]; seen: string[]; toasts: string[] }

/** Answers everything the plugin asks of the session from memory. */
/** `refuse` names commands the engine refuses to register, as it refuses a skill's name. */
/** `cwd`: the session's folder, in a world keyed by absolute path (see `MemoryFs`). */
/** `git`: answers `git -C <dir> <args>` (see `fakeGit`). */
export function world(on: On, files: Record<string, string>, opts: { refuse?: string[]; surfaces?: string[]; cwd?: string; git?: GitAnswer } = {}): World {
  const w: World = { fs: new MemoryFs(files, opts.cwd !== undefined), tools: [], opened: [], commands: [], seen: [], toasts: [] }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: opts.cwd ?? CWD }))
  on('fs.read', (_$, e) => ({ value: w.fs.read(e.path) }))
  on('fs.write', (_$, e) => { w.fs.write(e.path, e.text); return { value: undefined } })
  on('fs.list', (_$, e) => ({ value: w.fs.list(e.path) }))
  on('fs.exists', (_$, e) => { w.seen.push(e.path); return { value: w.fs.exists(e.path) } })
  // the plugin deletes a file with `rm` through $.process.run, and reads repos with `git -C <dir>`
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'rm') w.fs.remove(e.argv[e.argv.length - 1]!)
    if (e.argv[0] === 'git' && e.argv[1] === '-C' && opts.git) {
      const r = opts.git(e.argv[2]!, e.argv.slice(3))
      return { value: { exitCode: r.ok ? 0 : 128, stdout: r.out, stderr: r.err } } as never
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('command.register', (_$, e) => {
    if (opts.refuse?.includes(e.name)) return { deny: `"/${e.name}" refused: it is the plugin's /rft:${e.name}` }
    w.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.toast', (_$, e) => { w.toasts.push(JSON.stringify(e)); return { value: undefined } })
  on('session.surfaces', () => ({ value: (opts.surfaces ?? ['terminal']) as never }))
  on('ui.log', () => ({ value: undefined }))
  on('tool.register', (_$, e) => { w.tools.push(e.name); return { value: { tool: `mcp__rft__${e.name}` } } })
  on('ui.open', (_$, e) => { w.opened.push(e.id); return { value: { isPlaced: true as const } } })
  return w
}

/** What `git -C <dir> <args>` answers. */
export type GitAnswer = (dir: string, args: string[]) => { ok: boolean; out: string; err: string }

/** A repo as the fake git sees it: its commit and branch now, dirty files, and its history. */
export type FakeRepo = { commit: string; branch?: string; dirty?: number; log?: string[]; stat?: string[]; known?: string[] }

/**
 * A git that knows the repos by folder: `status` gives the commit, branch and dirty files,
 * `cat-file -e` knows the current commit and `known` ones, `log` and `diff` answer `log` and
 * `stat`. Any other folder is not a git repository. The repos can be changed between calls.
 */
export function fakeGit(repos: Record<string, FakeRepo>): GitAnswer & { calls: string[][] } {
  const calls: string[][] = []
  const git = (dir: string, args: string[]) => {
    calls.push([dir, ...args])
    const r = repos[dir]
    if (!r) return { ok: false, out: '', err: 'fatal: not a git repository (or any of the parent directories): .git' }
    switch (args[0]) {
      case 'status':
        return {
          ok: true, err: '',
          out: [`# branch.oid ${r.commit}`, `# branch.head ${r.branch ?? 'main'}`, ...Array.from({ length: r.dirty ?? 0 }, (_, i) => `1 .M N... 100644 100644 100644 aaa bbb f${i}.py`)].join('\n') + '\n',
        }
      case 'cat-file': {
        const c = args[2]!.replace('^{commit}', '')
        return { ok: [r.commit, ...(r.known ?? [])].some(k => k.startsWith(c)), out: '', err: '' }
      }
      case 'log': return { ok: true, out: (r.log ?? []).join('\n'), err: '' }
      case 'diff': return { ok: true, out: (r.stat ?? []).join('\n'), err: '' }
      default: return { ok: false, out: '', err: `unknown git command ${args[0]}` }
    }
  }
  return Object.assign(git, { calls })
}

export const paneProps = (bodyColumns = 80) => ({
  title: 'Reasoning tree', isFocused: false, bodyColumns, placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 }, view: {},
})
