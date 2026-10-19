// The tree view's concepts as pure functions over the tree JSON (`api/tree`): each note's path
// of concepts, which drawn notes and links make up a concept's region, the concept colours
// and the status totals of the concept tree. Loaded by the page before app.js, and by the
// plugin's tests; it sets `globalThis.RftConcepts` and touches nothing else.
(function (root) {
  'use strict'

  const ROOT = 'root'
  // kept apart from the status colours (green, orange, yellow, red, grey, blue) and from the
  // type rings (violet, teal): pinks, sands, cyans, periwinkles, browns, olives
  const PALETTE = ['#f783ac', '#e8a65d', '#3bc9db', '#91a7ff', '#c9879b', '#a9b04a', '#ff922b', '#da77f2']

  /** The concepts by id; a tree without concepts has just the project root. */
  function byId(tree) {
    const list = Array.isArray(tree.concepts) && tree.concepts.length
      ? tree.concepts
      : [{ id: ROOT, name: tree.project || 'project', summary: '', root: null, parent: null, children: [], depth: 0, count: tree.nodes.length, total: tree.nodes.length, statuses: {} }]
    return new Map(list.map(c => [c.id, c]))
  }

  /** The concept ids from the project root down to `id`. */
  function pathOf(concepts, id) {
    const out = []
    for (let c = concepts.get(id); c; c = c.parent ? concepts.get(c.parent) : null) out.unshift(c.id)
    return out
  }

  /** Gives every node `conceptPath`: the concepts it belongs to, outermost first. */
  function annotate(tree) {
    const concepts = byId(tree)
    const cache = new Map()
    for (const n of tree.nodes) {
      const id = concepts.has(n.concept) ? n.concept : ROOT
      if (!cache.has(id)) cache.set(id, pathOf(concepts, id))
      n.conceptPath = cache.get(id)
    }
    return concepts
  }

  /** The concepts in tree order, the root first. */
  function ordered(concepts) {
    const out = []
    const go = id => { const c = concepts.get(id); if (!c) return; out.push(c); c.children.forEach(go) }
    go(ROOT)
    return out
  }

  /** A concept's colour, stable with its place in the concept tree; none for the project root. */
  function colourOf(concepts, id) {
    if (id === ROOT || !concepts.has(id)) return null
    const i = ordered(concepts).filter(c => c.id !== ROOT).findIndex(c => c.id === id)
    return PALETTE[i % PALETTE.length]
  }

  /**
   * A concept's region among the notes drawn: the drawn notes in the concept or one of its
   * sub-concepts, and the drawn links between two of them. With folds and hidden notes left
   * out of `drawn`, the region follows what the reader sees.
   */
  function region(tree, id, drawn) {
    const nodes = tree.nodes.filter(n => drawn.has(n.id) && (n.conceptPath || [n.concept]).includes(id)).map(n => n.id)
    const inside = new Set(nodes)
    const links = []
    for (const n of tree.nodes) if (inside.has(n.id) && n.parent && inside.has(n.parent)) links.push([n.parent, n.id])
    return { nodes, links }
  }

  /** Status counts of a concept with its sub-concepts. */
  function totalStatuses(concepts, id) {
    const c = concepts.get(id)
    const out = { ...(c ? c.statuses : {}) }
    for (const k of c ? c.children : []) {
      const sub = totalStatuses(concepts, k)
      for (const s in sub) out[s] = (out[s] || 0) + sub[s]
    }
    return out
  }

  /** The ids of a note and every note below it. */
  function subtree(tree, id) {
    const kids = new Map(tree.nodes.map(n => [n.id, n.children || []]))
    const out = new Set()
    const go = x => { if (out.has(x) || !kids.has(x)) return; out.add(x); kids.get(x).forEach(go) }
    go(id)
    return out
  }

  root.RftConcepts = { ROOT, PALETTE, byId, pathOf, annotate, ordered, colourOf, region, totalStatuses, subtree }
})(typeof globalThis !== 'undefined' ? globalThis : window)
