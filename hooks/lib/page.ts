// The standalone page: the web view's files (web/) with the stylesheet and scripts inlined
// and the tree, with every note's text, embedded as `window.RFT_DATA`. One visualization
// codebase serves both the live view and this export.

import type { Tree } from './vault'
import { bodyOf } from './vault'

export type PageAssets = { html: string; css: string; js: string; d3: string }

export const ASSET_PATHS = {
  html: 'web/index.html',
  css: 'web/app.css',
  js: 'web/app.js',
  d3: 'web/vendor/d3.v7.9.0.min.js',
} as const

/** The tree as the server's `api/tree` answers it. */
export const treeJson = (tree: Tree, project: string, version: string) => ({
  project, version, nodes: Object.values(tree.nodes), roots: tree.roots,
})

const script = (code: string) => `<script>${code.replace(/<\/script/gi, '<\\/script')}</script>`

export function staticPage(a: PageAssets, tree: Tree, texts: Record<string, string>, project: string, version: string): string {
  const bodies: Record<string, string> = {}
  for (const id of Object.keys(tree.nodes)) bodies[id] = bodyOf(texts[id] ?? '')
  const data = JSON.stringify({ tree: treeJson(tree, project, version), bodies }).replace(/</g, '\\u003c')
  // function replacements: the inlined code may hold `$&` and the like
  return a.html
    .replace(/<link rel="stylesheet" href="app\.css" data-rft-inline>/, () => `<style>${a.css}</style>`)
    .replace(/<script src="vendor\/d3[^"]*" data-rft-inline><\/script>/, () => script(a.d3))
    .replace(/<script src="app\.js" data-rft-inline><\/script>/, () => script(`window.RFT_DATA = ${data};`) + script(a.js))
}
