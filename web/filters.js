// The tree view's filters as pure functions over the tree JSON (`api/tree`): which notes match,
// and which stay drawn when the rest is hidden. Loaded by the page before app.js, and by the
// plugin's tests; it sets `globalThis.RftFilters` and touches nothing else.
(function (root) {
  'use strict'

  const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  const strings = v => (Array.isArray(v) ? [...new Set(v.filter(x => typeof x === 'string' && x))] : [])

  /** No filter: every note matches. */
  const empty = () => ({ mode: 'dim', tags: [], tagMode: 'any', hiddenTypes: [], hiddenStatuses: [], from: '', to: '', concepts: [] })

  /** A filter state read back from storage, every field checked. */
  function normalise(f) {
    const v = f && typeof f === 'object' ? f : {}
    return {
      mode: v.mode === 'hide' ? 'hide' : 'dim',
      tags: strings(v.tags),
      tagMode: v.tagMode === 'all' ? 'all' : 'any',
      hiddenTypes: strings(v.hiddenTypes).filter(t => t === 'experiment' || t === 'direction'),
      hiddenStatuses: strings(v.hiddenStatuses),
      from: isDate(v.from) ? v.from : '',
      to: isDate(v.to) ? v.to : '',
      concepts: strings(v.concepts),
    }
  }

  /** How many kinds of filter are set: tags, type, status, date range, concepts. */
  const activeCount = f =>
    (f.tags.length ? 1 : 0) + (f.hiddenTypes.length ? 1 : 0) + (f.hiddenStatuses.length ? 1 : 0) + (f.from || f.to ? 1 : 0) +
    (f.concepts && f.concepts.length ? 1 : 0)

  /** Whether one note passes every filter that is set. */
  function matches(node, f) {
    if (f.hiddenTypes.includes(node.type)) return false
    if (f.hiddenStatuses.includes(node.status)) return false
    if (f.tags.length) {
      const own = new Set(node.tags || [])
      const ok = f.tagMode === 'all' ? f.tags.every(t => own.has(t)) : f.tags.some(t => own.has(t))
      if (!ok) return false
    }
    if (f.concepts && f.concepts.length) {
      // a note is in a concept when the concept is on its path (its own or an enclosing one)
      const path = node.conceptPath || (node.concept ? [node.concept] : [])
      if (!f.concepts.some(c => path.includes(c))) return false
    }
    if (f.from || f.to) {
      if (!isDate(node.date)) return false
      if (f.from && node.date < f.from) return false
      if (f.to && node.date > f.to) return false
    }
    return true
  }

  /** The ids of the notes that match. */
  const matching = (tree, f) => new Set(tree.nodes.filter(n => matches(n, f)).map(n => n.id))

  /**
   * The ids drawn: every note when dimming; when hiding, the matching notes and every
   * ancestor of one, so the tree stays connected, and the roots, so it never goes blank.
   */
  function visible(tree, f) {
    if (f.mode !== 'hide') return new Set(tree.nodes.map(n => n.id))
    const byId = new Map(tree.nodes.map(n => [n.id, n]))
    const out = new Set(tree.roots)
    for (const id of matching(tree, f)) {
      let cur = id
      while (cur && !out.has(cur)) {
        out.add(cur)
        cur = byId.get(cur) ? byId.get(cur).parent : null
      }
      out.add(id)
    }
    return out
  }

  /** The topical tags with their counts: the server's list, or counted from the notes. */
  function tagList(tree) {
    if (Array.isArray(tree.tags)) return tree.tags
    const counts = new Map()
    for (const n of tree.nodes) for (const t of n.tags || []) counts.set(t, (counts.get(t) || 0) + 1)
    return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1))
  }

  root.RftFilters = { empty, normalise, activeCount, matches, matching, visible, tagList }
})(typeof globalThis !== 'undefined' ? globalThis : window)
