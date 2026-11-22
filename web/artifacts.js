// A concept's artifact in the tree view, as pure functions over the tree JSON (`api/tree`): the
// state of one concept's artifact, what the drawer says about it, its sub-concepts, where a link
// inside the artifact leads and how it is marked from the tree, the frame's address, and the
// frame of the standalone page (`wrap`, as wrap_artifact in server/rft_server.py builds it).
// Loaded by the page before app.js, and by the plugin's tests; it sets `globalThis.RftArtifacts`
// and touches nothing else.
(function (root) {
  'use strict'

  const NOTE = /^#([EDRT]\d+)$/
  /** The order the experiments with no result are counted in. */
  const STATUSES = ['running', 'planned', 'idea', 'done', 'review', 'verified', 'dropped', 'discussed', 'moved']

  const conceptsOf = tree => (Array.isArray(tree.concepts) ? tree.concepts : Object.values(tree.concepts || {}))

  /** One concept and its artifact: fresh (up to date), stale, none (results but no artifact), empty (no results). */
  function entry(tree, id) {
    const c = conceptsOf(tree).find(x => x.id === id)
    if (!c) return null
    const artifact = (tree.artifacts || []).find(a => a.concept === id) || null
    const results = (tree.nodes || []).filter(n => n.concept === id && n.type === 'experiment' && n.hasResult).map(n => n.id)
    const state = artifact ? (artifact.stale ? 'stale' : 'fresh') : results.length ? 'none' : 'empty'
    return { id, name: c.name, state, results, artifact }
  }

  /** "E06 changed, E10 new, E03 no longer here", as describeState in hooks/lib/artifacts.ts says it. */
  function describe(a) {
    return [
      a.changed && a.changed.length ? `${a.changed.join(', ')} changed` : '',
      a.added && a.added.length ? `${a.added.join(', ')} new` : '',
      a.removed && a.removed.length ? `${a.removed.join(', ')} no longer here` : '',
    ].filter(Boolean).join(', ')
  }

  /** The line the drawer shows above the artifact, or in its place. */
  function stateText(e, tree) {
    const a = e.artifact
    if (e.state === 'fresh') return `Up to date · updated ${a.updated || '?'}`
    if (e.state === 'stale') return `Out of date: ${describe(a)} · updated ${a.updated || '?'}`
    if (e.state === 'none') {
      const k = e.results.length
      return `No artifact yet: ${k} experiment${k === 1 ? '' : 's'} with a result (${e.results.join(', ')}). /rft-artifact ${e.name} asks Claude to write it.`
    }
    const runs = (tree.nodes || []).filter(n => n.concept === e.id && n.type === 'experiment')
    if (!runs.length) return 'No results yet: no experiments.'
    const parts = STATUSES.map(s => runs.filter(n => n.status === s)).filter(ns => ns.length)
      .map(ns => `${ns.length} ${ns[0].status} (${ns.map(n => n.id).join(', ')})`)
    const other = runs.filter(n => !STATUSES.includes(n.status))
    if (other.length) parts.push(`${other.length} other (${other.map(n => n.id).join(', ')})`)
    return `No results yet: ${parts.join(', ')}.`
  }

  /** A concept's sub-concepts, with the state of their artifacts. */
  function subConcepts(tree, id) {
    const c = conceptsOf(tree).find(x => x.id === id)
    return c ? (c.children || []).map(k => entry(tree, k)).filter(Boolean).map(e => ({ id: e.id, name: e.name, state: e.state })) : []
  }

  /** The note a link inside an artifact leads to (`#E05`), or null. */
  function linkTarget(href) {
    const m = typeof href === 'string' ? NOTE.exec(href) : null
    return m ? m[1] : null
  }

  /** An experiment notebook's last run (`reproduced:`, as the tree JSON gives it), in words. */
  function reproducedText(r) {
    if (!r || !r.date) return 'Not run yet'
    const parts = [r.date, r.state, r.commit, r.seconds != null ? `${r.seconds} s` : ''].filter(Boolean)
    return `${r.state === 'ok' ? 'Reproduced' : 'Last run'} ${parts.join(' · ')}`
  }

  /** The notebook editor's address in the page's theme: marimo reads its light or dark from `theme`. */
  function notebookSrc(url, theme) {
    return `${url}${url.includes('?') ? '&' : '?'}theme=${theme === 'dark' ? 'dark' : 'light'}`
  }

  /** marimo's own variables, which its editor is drawn from, as the page's (`--rft-<token>`, a token of app.css). */
  const NOTEBOOK_VARS = {
    '--background': 'var(--rft-bg)', '--foreground': 'var(--rft-fg)',
    '--card': 'var(--rft-panel)', '--card-foreground': 'var(--rft-fg)',
    '--popover': 'var(--rft-panel)', '--popover-foreground': 'var(--rft-fg)',
    '--muted': 'color-mix(in srgb, var(--rft-line) 45%, var(--rft-bg))', '--muted-foreground': 'var(--rft-muted)',
    '--secondary': 'color-mix(in srgb, var(--rft-line) 45%, var(--rft-bg))', '--secondary-foreground': 'var(--rft-fg)',
    '--border': 'var(--rft-line)', '--input': 'var(--rft-line)',
    '--primary': 'var(--rft-accent)', '--primary-foreground': 'var(--rft-panel)',
    '--accent': 'color-mix(in srgb, var(--rft-accent) 14%, var(--rft-bg))', '--accent-foreground': 'var(--rft-accent)',
    '--ring': 'var(--rft-accent)', '--link': 'var(--rft-accent)',
    '--cm-background': 'var(--rft-panel)',
    '--color-blue-500': 'var(--rft-accent)', // a slider's track, a progress bar
    '--radius': '6px',
  }
  /** The fonts marimo takes when they are set: the page's own. */
  const NOTEBOOK_FONTS = {
    '--marimo-text-font': 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    '--marimo-heading-font': 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    '--marimo-monospace-font': 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  }
  const NOTEBOOK_TOKENS = ['bg', 'panel', 'fg', 'muted', 'line', 'accent']

  /**
   * The stylesheet the page puts in the notebook's frame, so marimo's editor is drawn in the page's
   * colours and fonts: `tokens` are the page's (bg, panel, fg, muted, line, accent, each as app.css
   * has it, a light-dark() pair), which marimo's own light or dark then picks a side of. Its
   * selectors are the ones marimo sets these variables on, so this one, later in the page, wins.
   */
  function notebookStyle(tokens) {
    const clean = v => String(v || '').replace(/[;{}<>]/g, '').trim()
    const own = NOTEBOOK_TOKENS.filter(k => clean(tokens[k])).map(k => `--rft-${k}: ${clean(tokens[k])};`).join(' ')
    const vars = Object.entries({ ...NOTEBOOK_VARS, ...NOTEBOOK_FONTS }).map(([k, v]) => `${k}: ${v};`).join(' ')
    return `:root { ${own} }\n:root, body, .marimo, .marimo:is(.dark *) { ${vars} }\n`
      // a figure drawn for a light page with no background of its own: on a light card in the dark theme, as in a note
      + '.output img { background: light-dark(transparent, #ffffff); border-radius: 6px; }\n'
  }

  /** How a link to a note is marked, from the tree as it is now: its status, superseded, or missing; an experiment's notebook run. */
  function decoration(byId, id) {
    const n = byId.get(id)
    if (!n) return { cls: 'rft-note missing', title: `No note ${id} in the tree` }
    const r = n.reproduced && n.reproduced.state ? n.reproduced : null
    return {
      cls: `rft-note s-${n.status}${n.supersededBy ? ' superseded' : ''}${r ? ` r-${r.state}` : ''}`,
      title: `${n.name} · ${n.status}${n.supersededBy ? ` · superseded by ${n.supersededBy}` : ''}${r ? ` · ${r.state === 'ok' ? 'reproduced' : `notebook ${r.state}`} ${r.date}` : ''}`,
    }
  }

  /** The frame's address: the concept, the theme, where it was scrolled to, and the key when the page has it. */
  function frameSrc(concept, opts) {
    const o = opts || {}
    const y = Math.round(Number(o.y) || 0)
    return `api/artifact?concept=${encodeURIComponent(concept)}&theme=${o.theme === 'dark' ? 'dark' : 'light'}` +
      (y > 0 ? `&y=${y}` : '') + (o.token ? `&token=${encodeURIComponent(o.token)}` : '')
  }

  /**
   * The artifact as a document, for the standalone page's frame: its theme, the base style and the
   * runtime first in its head. With no server to send the frame's policy, it comes as a meta tag:
   * nothing from elsewhere, as api/artifact's own policy has it (images only inline: the standalone
   * page shows the others as placeholders).
   */
  function wrap(html, frame, theme) {
    const js = String(frame.js || '').replace(/<\/(script)/gi, '<\\/$1')
    const css = String(frame.css || '').replace(/<\/(style)/gi, '<\\/$1')
    const pre = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; ' +
      'img-src data:; media-src data:; font-src data:; form-action \'none\'; base-uri \'none\'">' +
      `<meta charset="utf-8"><script>document.documentElement.dataset.theme = "${theme === 'dark' ? 'dark' : 'light'}"</script>` +
      `<style>${css}</style><script>${js}</script>`
    let m = /<head\b[^>]*>/i.exec(html)
    if (m) return html.slice(0, m.index + m[0].length) + pre + html.slice(m.index + m[0].length)
    m = /<html\b[^>]*>/i.exec(html)
    if (m) return html.slice(0, m.index + m[0].length) + `<head>${pre}</head>` + html.slice(m.index + m[0].length)
    return `<!doctype html><html><head>${pre}</head><body>${html}</body></html>`
  }

  root.RftArtifacts = { entry, describe, stateText, subConcepts, linkTarget, decoration, reproducedText, frameSrc, wrap, notebookSrc, notebookStyle, NOTEBOOK_VARS }
})(typeof globalThis !== 'undefined' ? globalThis : window)
