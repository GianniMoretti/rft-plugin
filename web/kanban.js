// The tree view's kanban as pure functions over the tree JSON (`api/tree`): the notes in one
// column per status, ordered by priority or by date, and how the open notes use each priority.
// Loaded by the page before app.js, and by the plugin's tests; it sets `globalThis.RftKanban`
// and touches nothing else.
(function (root) {
  'use strict'

  /** The priorities, highest first: `priority:` in a note's frontmatter, the user's alone. */
  const PRIORITIES = ['urgent', 'high', 'medium', 'low']
  /** How many open notes may hold each priority at once; low has no limit. */
  const LIMITS = { urgent: 1, high: 5, medium: 10, low: null }
  /** The statuses of work still to do: only their notes count towards the limits. */
  const OPEN = ['idea', 'planned', 'running']
  /** The columns: the flow of the work, then the ones that start folded. */
  const MAIN = ['idea', 'planned', 'running', 'done']
  const FOLDED = ['dropped', 'discussed', 'moved']
  /** The column of a status that is none of these (a typo, a status by hand): shown only when some note has one. */
  const OTHER = 'other'
  const ORDERS = ['priority', 'date']

  /** A priority as a rank, highest first; none after every priority. */
  const rank = p => (PRIORITIES.includes(p) ? PRIORITIES.indexOf(p) : PRIORITIES.length)
  const isOpen = n => OPEN.includes(n.status)

  const number = id => { const m = /(\d+)$/.exec(id || ''); return m ? Number(m[1]) : -1 }
  /** Newest first: by `date:` (when the note was made), then by id, the later one first; an undated note last. */
  function byDate(a, b) {
    const da = a.date || '', db = b.date || ''
    if (da !== db) return da < db ? 1 : -1
    return number(b.id) - number(a.id) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  }
  /** The highest priority first, the notes without one last; within one priority, newest first. */
  const byPriority = (a, b) => rank(a.priority) - rank(b.priority) || byDate(a, b)

  /** The notes in the order chosen: `priority` (the default) or `date`. */
  const order = (notes, by) => [...notes].sort(by === 'date' ? byDate : byPriority)

  /**
   * The columns of these notes, each with its notes in order: every column of MAIN and FOLDED
   * whose status the filters do not hide (`hiddenStatuses`), and OTHER when a note needs it.
   */
  function columns(notes, opts) {
    const o = opts || {}
    const hidden = o.hiddenStatuses || []
    const known = [...MAIN, ...FOLDED]
    const by = new Map([...known, OTHER].map(s => [s, []]))
    for (const n of notes) by.get(known.includes(n.status) ? n.status : OTHER).push(n)
    const out = known.filter(s => !hidden.includes(s)).map(s => ({ status: s, folded: FOLDED.includes(s), notes: order(by.get(s), o.order) }))
    if (by.get(OTHER).length) out.push({ status: OTHER, folded: false, notes: order(by.get(OTHER), o.order) })
    return out
  }

  /** The open notes that hold each priority, among `notes` (the whole tree: the limits are the project's). */
  function usage(notes) {
    const out = {}
    for (const p of PRIORITIES) out[p] = []
    for (const n of notes) if (isOpen(n) && out[n.priority]) out[n.priority].push(n.id)
    return out
  }

  /**
   * The open notes that keep `note` from taking `p`: those holding it, once it is at its limit.
   * None when `p` has no limit, when the note holds it already, or when it is not open (it does
   * not count). `use`: `usage(notes)`, when it is at hand.
   */
  function blockers(notes, note, p, use) {
    const limit = LIMITS[p]
    if (limit == null || note.priority === p || !isOpen(note)) return []
    const held = (use || usage(notes))[p].filter(id => id !== note.id)
    return held.length >= limit ? held : []
  }

  root.RftKanban = { PRIORITIES, LIMITS, OPEN, MAIN, FOLDED, OTHER, ORDERS, rank, isOpen, order, columns, usage, blockers }
})(typeof globalThis !== 'undefined' ? globalThis : window)
