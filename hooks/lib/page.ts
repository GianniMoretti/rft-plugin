// The standalone page: the web view's files (web/) with the stylesheet and scripts inlined
// and the tree, with every note's text, embedded as `window.RFT_DATA`. One visualization
// codebase serves both the live view and this export.

import type { Tree } from './vault'
import { bodyOf, conceptOrder, tagCounts } from './vault'

export type PageAssets = { html: string; css: string; js: string; d3: string; katex: string; katexCss: string; filters: string; kanban: string; layout: string; concepts: string; markdown: string; theme: string }

export const ASSET_PATHS = {
  html: 'web/index.html',
  css: 'web/app.css',
  js: 'web/app.js',
  filters: 'web/filters.js',
  kanban: 'web/kanban.js',
  layout: 'web/layout.js',
  concepts: 'web/concepts.js',
  markdown: 'web/markdown.js',
  theme: 'web/theme.js',
  d3: 'web/vendor/d3.v7.9.0.min.js',
  katex: 'web/vendor/katex.v0.16.22.min.js',
  katexCss: 'web/vendor/katex.v0.16.22.min.css',
} as const

/** The tree as the server's `api/tree` answers it. */
export const treeJson = (tree: Tree, project: string, version: string) => ({
  project, version, nodes: Object.values(tree.nodes), roots: tree.roots, tags: tagCounts(tree),
  concepts: conceptOrder(tree.concepts ?? {}),
})

const script = (code: string) => `<script>${code.replace(/<\/script/gi, '<\\/script')}</script>`

/** `comments`: each note's threads, placed in its body as the server's api/note places them, shown read-only. */
export function staticPage(a: PageAssets, tree: Tree, texts: Record<string, string>, project: string, version: string, comments: Record<string, unknown[]> = {}): string {
  const bodies: Record<string, string> = {}
  for (const id of Object.keys(tree.nodes)) bodies[id] = bodyOf(texts[id] ?? '')
  const data = JSON.stringify({ tree: treeJson(tree, project, version), bodies, comments }).replace(/</g, '\\u003c')
  // function replacements: the inlined code may hold `$&` and the like
  return a.html
    .replace(/<script src="theme\.js" data-rft-inline><\/script>/, () => script(a.theme))
    .replace(/<link rel="stylesheet" href="app\.css" data-rft-inline>/, () => `<style>${a.css}</style>`)
    .replace(/<link rel="stylesheet" href="vendor\/katex[^"]*" data-rft-inline>/, () => `<style>${a.katexCss}</style>`)
    .replace(/<script src="vendor\/d3[^"]*" data-rft-inline><\/script>/, () => script(a.d3))
    .replace(/<script src="vendor\/katex[^"]*" data-rft-inline><\/script>/, () => script(a.katex))
    .replace(/<script src="filters\.js" data-rft-inline><\/script>/, () => script(a.filters))
    .replace(/<script src="kanban\.js" data-rft-inline><\/script>/, () => script(a.kanban))
    .replace(/<script src="layout\.js" data-rft-inline><\/script>/, () => script(a.layout))
    .replace(/<script src="concepts\.js" data-rft-inline><\/script>/, () => script(a.concepts))
    .replace(/<script src="markdown\.js" data-rft-inline><\/script>/, () => script(a.markdown))
    .replace(/<script src="app\.js" data-rft-inline><\/script>/, () => script(`window.RFT_DATA = ${data};`) + script(a.js))
}
