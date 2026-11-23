// The rft web view: the reasoning tree as a tidy tree on an infinite canvas (d3), with notes in
// a side drawer. It runs in two ways: served by server/rft_server.py, where it polls
// `api/tree`, reads notes from `api/note` and writes a note's edited text back to it, asks
// `api/node` for a new note under the one shown and `api/type` to change its type, and keeps a
// note's discussion (comments, suggestions) with `api/comment`, its lock with `api/lock` and its
// priority (the user's alone; also the answer to Claude's suggested one) with `api/priority`, and
// mounts the scratchpad (web/scratchpad.js, `api/scratchpad`), and shows a concept's artifact in the
// drawer when the concept is clicked (web/artifacts.js; `api/artifact`, in a sandboxed frame); or
// inlined into a standalone tree.html by /rft-view, where `window.RFT_DATA` holds the tree,
// every note's text and its threads, and nothing is edited.
(function () {
  'use strict'

  const STATUSES = ['verified', 'review', 'done', 'running', 'planned', 'idea', 'dropped', 'discussed', 'moved']
  const MARK = { verified: '✔', review: '↺', done: '✓', running: '…', planned: '→', idea: '?', dropped: '✗', discussed: '·', moved: '↗' }
  const LABEL = { verified: 'verified', review: 'review: verified, changed since', done: 'done', running: 'running', planned: 'planned', idea: 'idea', dropped: 'dropped', discussed: 'discussed, not pursued', moved: 'moved' }
  const R = 7 // node radius
  const TYPES = ['direction', 'experiment', 'reference', 'theory']
  // the note that starts a concept is a star: its points this far out, its notches this share of that
  const STAR_R = 12.5
  const STAR_IN = 0.48
  const STAR_SIDE = Math.cos(Math.PI / 5) // the lower points (in the star's own frame), as a share of STAR_R
  const STAR_CORE = 0.52 // the small star inside, in the concept's colour, as a share of STAR_R
  // an open note's priority as a glow in the priority's colour: how far it reaches beyond the
  // shape (its strength is in app.css)
  const HALO = { urgent: 13, high: 10, medium: 8, low: 6 }
  const SPACING = { td: [150, 104], lr: [34, 280], radial: [90, 140] } // [breadth, depth] in world units
  const CSPACING = { td: [240, 230], lr: [170, 300], radial: [250, 280] } // the same, for the concept tree
  const LABEL_PX = 15 // label size on screen at A 100 %, whatever the zoom
  const FONT_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2]
  const POLL_MS = 2000
  const EMBED = window.RFT_DATA || null
  const TOKEN = EMBED ? '' : new URLSearchParams(location.search).get('token') || '' // the key for writes, when the address carries it

  let tree = null
  let byId = new Map()
  let layoutKind = 'td'
  let collapsed = new Set()
  const F = window.RftFilters
  const L = window.RftLayout
  let filters = F.empty() // the one source of truth for every filter, the legend's included
  let matchSet = new Set() // the notes that pass the filters
  let shownSet = new Set() // the notes drawn: all of them, or with "hide" the matches and their ancestors
  let selected = null
  const lastChild = new Map() // a note → its child shown last, where ↓ goes back to
  let matchAt = -1
  let positions = new Map()
  let hasView = false
  let font = 1 // the A− / A+ scale of labels and the note drawer
  const C = window.RftConcepts
  let concepts = new Map() // the concepts by id, `root` the project
  let stars = new Map() // the notes that start a concept, drawn as stars: note id → concept id
  let conceptMode = 'off' // off | regions | arrows
  let view = 'tree' // tree: the reasoning tree; concepts: the concept tree
  let focus = null // the concept whose subtree alone is drawn, or null
  let shown = null // the note in the drawer as last read: { id, body, version }
  let artifactShown = null // the concept whose artifact the drawer shows instead of a note, or null
  let pendingArtifact = null // ?artifact=<concept id>: the artifact to open once the tree is drawn
  const A = window.RftArtifacts
  let editing = null // while a note's text is edited: { id, version, lead, text (as opened), newer (on a conflict) }
  let saving = false
  let adding = false
  let moving = false
  let showOrigins = false
  let retyping = false
  const K = window.RftKanban
  const PAGES = ['tree', 'concepts', 'kanban', 'calendar', 'manuscript', 'slides']
  let manuscriptView = null // web/manuscript.js, mounted on the live page only
  let slidesView = null // web/decks.js, the same
  let boardSet = new Set() // the notes on the kanban: those that match, in the focused concept when there is one
  let kanbanOrder = 'priority' // priority | date
  let kanbanOpen = new Set() // the folded columns opened
  let prioUse = null // the open notes that hold each priority (K.usage), for the whole tree
  let needsInitialView = false // the tree's first view waits until its canvas shows

  // ---------------------------------------------------------------- persistence

  const keyOf = k => `rft:${tree ? tree.project : 'tree'}:${k}`
  const store = {
    get(k, d) { try { const v = localStorage.getItem(keyOf(k)); return v == null ? d : JSON.parse(v) } catch (e) { return d } },
    set(k, v) { try { localStorage.setItem(keyOf(k), JSON.stringify(v)) } catch (e) { /* private window */ } },
  }

  // ---------------------------------------------------------------- canvas

  const svg = d3.select('#canvas')
  const viewport = d3.select('#viewport')
  const gLinks = d3.select('#links')
  const gNodes = d3.select('#nodes')
  const tooltip = document.getElementById('tooltip')
  let k = 1
  let saveTimer = 0
  const zoom = d3.zoom().scaleExtent([0.03, 6]).on('zoom', ev => {
    viewport.attr('transform', ev.transform)
    k = ev.transform.k
    if (ev.sourceEvent) setViewNext('fit')
    scheduleLabels()
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => store.set('view', { x: ev.transform.x, y: ev.transform.y, k: ev.transform.k }), 250)
  })
  svg.call(zoom).on('dblclick.zoom', null)

  // ---------------------------------------------------------------- data

  function setTree(next) {
    const first = tree === null
    tree = next
    byId = new Map(tree.nodes.map(n => [n.id, n]))
    prioUse = K.usage(tree.nodes)
    planAll()
    concepts = C.annotate(tree)
    stars = new Map([...concepts.values()].filter(c => c.root && byId.has(c.root)).map(c => [c.root, c.id]))
    if (first) {
      conceptMode = ['off', 'regions', 'arrows'].includes(store.get('conceptMode', 'off')) ? store.get('conceptMode', 'off') : 'off'
      view = PAGES.includes(store.get('pageView', 'tree')) ? store.get('pageView', 'tree') : 'tree'
      kanbanOrder = K.ORDERS.includes(store.get('kanbanOrder', 'priority')) ? store.get('kanbanOrder', 'priority') : 'priority'
      kanbanOpen = new Set(store.get('kanbanOpen', []))
      calMode = CAL_MODES.includes(store.get('calMode', 'timeline')) ? store.get('calMode', 'timeline') : 'timeline'
      calZoom = Math.max(0, Math.min(CAL_ZOOM.length - 1, Number(store.get('calZoom', 2)) || 0))
      focus = store.get('focus', null)
      // a link can say how to open: ?layout=lr&concepts=regions&view=concepts&focus=D02&filter=hide, ?view=kanban&order=date
      const q = new URLSearchParams(location.search)
      if (['td', 'lr', 'radial'].includes(q.get('layout'))) store.set('layout', q.get('layout'))
      if (['off', 'regions', 'arrows'].includes(q.get('concepts'))) conceptMode = q.get('concepts')
      if (PAGES.includes(q.get('view'))) view = q.get('view')
      if (K.ORDERS.includes(q.get('order'))) kanbanOrder = q.get('order')
      if (CAL_MODES.includes(q.get('cal'))) calMode = q.get('cal')
      if (q.has('focus')) focus = q.get('focus') || null
      if (q.has('note')) selected = q.get('note')
      if (q.has('artifact')) pendingArtifact = q.get('artifact')
      buildArrowMarkers()
      buildHalos()
      layoutKind = store.get('layout', 'td')
      collapsed = new Set(store.get('collapsed', []))
      // earlier versions kept only the legend's statuses, under `hidden`
      filters = F.normalise(store.get('filters', null) || { hiddenStatuses: store.get('hidden', []) })
      const fq = new URLSearchParams(location.search)
      if (fq.has('tags')) filters = F.normalise({ ...filters, tags: fq.get('tags').split(',').filter(Boolean) })
      if (fq.has('hide')) filters = F.normalise({ ...filters, mode: 'hide' })
      setFont(new URLSearchParams(location.search).get('font') || store.get('font', 1), false)
      setDrawerWidth(store.get('drawerWidth', null), false)
      const aw = Number(store.get('artifactWidth', null))
      if (aw > 0) mainEl.style.setProperty('--artifact-w', `${aw}px`)
      buildLegend()
      setLegendOpen(store.get('legendShown', false))
      showOrigins = Boolean(store.get('origins', false)) || q.get('origins') === 'on'
      syncOriginsButton()
      syncLayoutButtons()
      togglePanel(new URLSearchParams(location.search).get('panel') === 'filters' || Boolean(store.get('filtersOpen', false)))
    }
    for (const id of [...collapsed]) if (!byId.has(id)) collapsed.delete(id)
    if (focus && (!concepts.has(focus) || !byId.has(concepts.get(focus).root))) focus = null
    computeFilters()
    buildFilterPanel()
    buildConceptLegend()
    buildCrumbs()
    syncConceptButtons()
    syncOriginsButton()
    syncTitle()
    const c = { direction: 0, experiment: 0, reference: 0, theory: 0 }
    for (const n of tree.nodes) c[n.type] = (c[n.type] || 0) + 1
    document.getElementById('counts').textContent =
      `${c.direction} directions · ${c.experiment} experiments · ${c.reference} references · ${c.theory} theory notes`
  }

  /** The page's title: the root note's concept when it declares one, else the project. */
  function syncTitle() {
    const top = concepts.get(C.ROOT)
    const project = `${tree.project} — the reasoning tree`
    const h1 = document.getElementById('title')
    h1.textContent = top && top.root ? top.name : project
    h1.title = top && top.root ? `${project}${top.summary ? ': ' + top.summary : ''}` : ''
    document.title = top && top.root ? top.name : `${tree.project} · reasoning tree`
  }

  function ancestors(id) {
    const out = []
    let p = byId.get(id) && byId.get(id).parent
    while (p && byId.has(p)) { out.push(p); p = byId.get(p).parent }
    return out
  }

  // ---------------------------------------------------------------- layout

  function hierarchy() {
    const single = tree.roots.length === 1 || focus
    const top = focus ? byId.get(concepts.get(focus).root) : single ? byId.get(tree.roots[0]) : { id: '__root', virtual: true, children: tree.roots }
    return d3.hierarchy(top, d => {
      if (d.virtual) return d.children.filter(id => shownSet.has(id)).map(id => byId.get(id))
      if (collapsed.has(d.id)) return null
      return d.children.filter(id => shownSet.has(id)).map(id => byId.get(id)).filter(Boolean)
    })
  }

  function compute() {
    const root = hierarchy()
    const offset = root.data.virtual ? 1 : 0
    const [b, d] = SPACING[layoutKind]
    if (layoutKind === 'radial') {
      L.radial(d3, root, b, d)
    } else {
      d3.tree().nodeSize([b, d]).separation((a, c) => (a.parent === c.parent ? 1 : 1.3))(root)
    }
    const shift = layoutKind === 'radial' ? 0 : offset * d
    const point = n => {
      if (layoutKind === 'td') return [n.x, n.y - shift]
      if (layoutKind === 'lr') return [n.y - shift, n.x]
      const a = n.angle - Math.PI / 2
      return [n.radius * Math.cos(a), n.radius * Math.sin(a)]
    }
    const nodes = root.descendants().filter(n => !n.data.virtual)
    const pos = new Map(nodes.map(n => [n.data.id, { p: point(n), angle: n.angle, radius: n.radius, star: stars.has(n.data.id) }]))
    const links = root.links().filter(l => !l.source.data.virtual)
    return { nodes, links, pos }
  }

  // a link leaves a star from the notch opposite its point, and arrives at the point (starShape
  // turns that point towards the parent)
  function linkPath(s, t) {
    const [x1, y1] = s.p, [x2, y2] = t.p
    const out = s.star ? STAR_R * STAR_IN : R, into = (t.star ? STAR_R : R) + 3
    if (layoutKind === 'td') {
      const ye = y2 - into, my = (y1 + ye) / 2
      return `M${x1},${y1 + out}C${x1},${my} ${x2},${my} ${x2},${ye}`
    }
    if (layoutKind === 'lr') {
      const xe = x2 - into, mx = (x1 + xe) / 2
      return `M${x1 + out},${y1}C${mx},${y1} ${mx},${y2} ${xe},${y2}`
    }
    return radialLink({ source: [s.angle, s.radius ? s.radius + out : 0], target: [t.angle, Math.max(0, t.radius - into)] })
  }
  const radialLink = d3.linkRadial().angle(e => e[0]).radius(e => e[1])

  // ---------------------------------------------------------------- shapes

  const circleShape = r => `M${r},0A${r},${r} 0 1,1 ${-r},0A${r},${r} 0 1,1 ${r},0Z`

  /** A five-pointed star around (0, 0), its points `size` out, the first at angle `turn` (0: up, clockwise). */
  function starShape(turn, size = STAR_R) {
    let d = ''
    for (let i = 0; i < 10; i++) {
      const a = turn + (i * Math.PI) / 5, r = i % 2 ? size * STAR_IN : size
      d += `${i ? 'L' : 'M'}${(r * Math.sin(a)).toFixed(2)},${(-r * Math.cos(a)).toFixed(2)}`
    }
    return `${d}Z`
  }

  /** A star's point faces where its link comes in: up, left, or towards the centre of the radial tree. */
  function starTurn(id) {
    if (layoutKind === 'td') return 0
    if (layoutKind === 'lr') return -Math.PI / 2
    const p = positions.get(id)
    return p && p.radius ? Math.atan2(-p.p[0], p.p[1]) : 0
  }

  const shapeOf = id => (stars.has(id) ? starShape(starTurn(id)) : circleShape(R))
  /** The colour of the concept a star starts (none for the project's own concept), for the small star inside it. */
  const coreColourOf = id => (stars.has(id) ? C.colourOf(concepts, stars.get(id)) : null)
  /** How far the shape reaches sideways and away from the parent: where the label and the fold badge go. */
  const sideOf = id => (stars.has(id) ? STAR_R * STAR_SIDE : R)
  /** The priority a note glows with: only an open note's (as only they count towards the limits). */
  const glowOf = d => (K.isOpen(d) && HALO[d.priority] ? d.priority : null)
  // a literature search (a reference note tagged literature) has a colour of its own
  const toneOf = d => `tone ${d.type === 'reference' && (d.tags || []).includes('literature') ? 'literature' : TYPES.includes(d.type) ? d.type : 'other'} s-${STATUSES.includes(d.status) ? d.status : 'other'}`

  // ---------------------------------------------------------------- drawing

  function render(animate) {
    if (!tree) return
    const { nodes, links, pos } = compute()
    const prev = positions
    positions = pos
    const dur = animate ? 400 : 0
    const from = id => {
      // a new node grows out of its nearest drawn ancestor
      for (const a of [id, ...ancestors(id)]) if (prev.has(a)) return prev.get(a)
      return pos.get(id)
    }

    const link = gLinks.selectAll('path.link').data(links, l => l.target.data.id)
    link.exit().remove()
    const linkIn = link.enter().append('path').attr('class', 'link').attr('marker-end', 'url(#arrow)')
      .attr('d', l => { const f = from(l.target.data.id); return linkPath(f, f) })
    linkIn.merge(link).transition().duration(dur)
      .attr('d', l => linkPath(pos.get(l.source.data.id), pos.get(l.target.data.id)))

    const node = gNodes.selectAll('g.node').data(nodes, n => n.data.id)
    node.exit().remove()
    const nodeIn = node.enter().append('g')
      .attr('transform', n => `translate(${from(n.data.id).p})`)
      .on('click', (ev, n) => { ev.stopPropagation(); select(n.data.id) })
      .on('dblclick', (ev, n) => { ev.stopPropagation(); toggle(n.data.id) })
      .on('mouseenter', (ev, n) => hover(n.data.id, ev))
      .on('mousemove', ev => moveTooltip(ev))
      .on('mouseleave', () => hover(null))
    // the mark: the priority's glow under the shape, the ring that marks it selected or found
    const mark = nodeIn.append('g').attr('class', 'mark')
    mark.append('circle').attr('class', 'halo')
    mark.append('circle').attr('class', 'sel')
    mark.append('circle').attr('class', 'vring')
    mark.append('path').attr('class', 'dot')
    mark.append('path').attr('class', 'core')
    nodeIn.append('text').attr('class', 'label')
    const fold = nodeIn.append('g').attr('class', 'fold')
      .on('click', (ev, n) => { ev.stopPropagation(); toggle(n.data.id) })
      .on('dblclick', ev => ev.stopPropagation())
    fold.append('circle').attr('class', 'hit').attr('r', 12)
    fold.append('circle').attr('r', 5.5)
    fold.append('text')

    const all = nodeIn.merge(node)
    all.attr('class', n => nodeClass(n.data))
    all.select('path.dot').attr('d', n => shapeOf(n.data.id))
    all.select('circle.sel').attr('r', n => (stars.has(n.data.id) ? STAR_R : R) + 4)
    // a verified note's ring, dashed while it is in review
    all.select('circle.vring').attr('r', n => (stars.has(n.data.id) ? STAR_R : R) + 2.2)
    all.select('circle.halo')
      .attr('display', n => (glowOf(n.data) ? null : 'none'))
      .attr('r', n => (glowOf(n.data) ? (stars.has(n.data.id) ? STAR_R * 0.8 : R) + HALO[glowOf(n.data)] : 0))
      .attr('fill', n => (glowOf(n.data) ? `url(#halo-${glowOf(n.data)})` : null))
    // a star holds a small star in the colour of the concept it starts
    all.select('path.core')
      .attr('display', n => (coreColourOf(n.data.id) ? null : 'none'))
      .attr('d', n => (coreColourOf(n.data.id) ? starShape(starTurn(n.data.id), STAR_R * STAR_CORE) : null))
      .style('fill', n => coreColourOf(n.data.id))
    all.select('g.fold')
      .attr('display', n => (n.data.children.length ? null : 'none'))
      .attr('transform', n => foldOffset(n.data.id))
    all.select('g.fold text').text(n => (collapsed.has(n.data.id) ? `+${countBelow(n.data.id)}` : '−'))
    all.select('g.fold circle:not(.hit)').attr('r', n => (collapsed.has(n.data.id) ? 8 : 5.5))
    all.transition().duration(dur).attr('transform', n => `translate(${pos.get(n.data.id).p})`)
    // a link fades with the note it leads to
    gLinks.selectAll('path.link').attr('class', l => `link ${toneOf(l.target.data)}${matchSet.has(l.target.data.id) ? '' : ' dim'}`)
    drawConcepts(pos, dur)
    drawOrigins(pos, dur)
    updateLabels()
    syncFoldButton()
  }

  /**
   * The dashed "came from" links: from the parent a moved note last had to the note, while both
   * are drawn. Faint, behind the tree's own links, and only when the toggle is on.
   */
  function drawOrigins(pos, dur = 0) {
    const data = showOrigins
      ? tree.nodes.filter(n => n.origin && n.origin.length && pos.has(n.id))
        .map(n => ({ id: n.id, from: n.origin[n.origin.length - 1] }))
        .filter(o => pos.has(o.from) && o.from !== byId.get(o.id).parent)
      : []
    const bent = o => {
      // a gentle arc, so it does not lie on a tree link it crosses
      const [x1, y1] = pos.get(o.from).p, [x2, y2] = pos.get(o.id).p
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, dx = x2 - x1, dy = y2 - y1
      return `M${x1},${y1}Q${mx - dy * 0.18},${my + dx * 0.18} ${x2},${y2}`
    }
    const sel = d3.select('#origins').selectAll('path.origin').data(data, o => o.id)
    sel.exit().remove()
    sel.enter().append('path').attr('opacity', 0).merge(sel)
      .attr('class', o => `origin${matchSet.has(o.id) || matchSet.has(o.from) ? '' : ' dim'}`)
      .attr('d', bent)
      .transition().delay(dur).duration(200).attr('opacity', null)
  }

  function nodeClass(d) {
    let c = `node ${toneOf(d)}`
    if (glowOf(d)) c += ` p-${glowOf(d)}`
    if (d.id === selected) c += ' selected'
    if (!matchSet.has(d.id)) c += ' dim'
    const q = searchText()
    if (q && d.name.toLowerCase().includes(q)) c += ' match'
    return c
  }

  function countBelow(id) {
    const n = byId.get(id)
    return n ? n.children.reduce((s, c) => s + 1 + countBelow(c), 0) : 0
  }

  function foldAt(id) {
    const r = sideOf(id)
    if (layoutKind === 'td') return [r + 8, -r - 4]
    if (layoutKind === 'lr') return [-r - 2, -r - 8]
    const p = positions.get(id)
    if (!p || !p.radius) return [r + 8, -r - 4]
    const len = Math.hypot(p.p[0], p.p[1]) || 1
    return [(-p.p[1] / len) * (r + 9), (p.p[0] / len) * (r + 9)]
  }
  const foldOffset = id => `translate(${foldAt(id)})`
  // a touch screen (app.css's phone and touch rules): a fold handle keeps its size on screen, as the
  // labels do, with a target 24 px across (its .hit circle) whose edge stays clear of the note's shape
  const touchScreen = matchMedia('(max-width: 700px), (pointer: coarse)')
  function touchFold(id, grow) {
    const [x, y] = foldAt(id)
    const len = Math.hypot(x, y) || 1
    const reach = (sideOf(id) * grow * k + 16) / k
    return `translate(${(x / len) * reach},${(y / len) * reach}) scale(${1 / k})`
  }

  // labels keep a constant size on screen and show as much of the title as the room at this
  // zoom allows: nothing when very far, the id, then more and more of the title
  let labelFrame = 0
  function scheduleLabels() {
    if (!labelFrame) labelFrame = requestAnimationFrame(() => { labelFrame = 0; updateLabels() })
  }

  const cutTo = (t, n) => (t.length <= n ? t : t.slice(0, Math.max(1, n - 1)) + '…')
  function wrap(t, n, max) {
    const words = t.split(' ')
    const out = []
    let line = ''
    for (const w of words) {
      if (!line) line = w
      else if ((line + ' ' + w).length <= n) line += ' ' + w
      else { out.push(line); line = w }
    }
    if (line) out.push(line)
    if (out.length > max) { out.length = max; out[max - 1] = cutTo(out[max - 1] + ' …', n) }
    return out.map(l => cutTo(l, n))
  }

  function updateLabels() {
    // concept names keep their size on screen, like the labels
    d3.selectAll('#badges .badge').attr('transform', function () {
      return `translate(${this.dataset.x},${this.dataset.y}) scale(${font / k})`
    })
    const px = LABEL_PX * font
    const size = px / k
    const room = layoutKind === 'td' ? SPACING.td[0] * 1.15 : layoutKind === 'lr' ? SPACING.lr[1] - 30 : SPACING.radial[1] - 20
    const chars = Math.floor((room * k) / (px * 0.56))
    gNodes.selectAll('g.node').each(function (n) {
      const d = n.data
      const text = d3.select(this).select('text.label')
      const full = `${d.id} ${d.title}`
      // top-down has room below each node for a second line
      const lines = layoutKind === 'td' ? wrap(full, chars, 2) : [cutTo(full, chars)]
      if (chars < d.id.length) lines.length = 0
      else if (chars < d.id.length + 4) lines.splice(0, lines.length, d.id)
      const spans = text.attr('font-size', size).selectAll('tspan').data(lines)
      spans.exit().remove()
      spans.enter().append('tspan').merge(spans).text(t => t)
        .attr('x', layoutKind === 'td' ? 0 : null).attr('dy', (t, i) => (i ? '1.15em' : null))
      // nodes stay visible when far: a circle at least 3.5 px across on screen, the rest in proportion
      const grow = Math.max(1, 3.5 / (k * R))
      d3.select(this).select('g.mark').attr('transform', grow > 1 ? `scale(${grow})` : null)
      if (touchScreen.matches && d.children.length) d3.select(this).select('g.fold').attr('transform', touchFold(d.id, grow))
      const side = sideOf(d.id) * grow
      if (layoutKind === 'td') {
        text.attr('x', 0).attr('y', side + 4 + size).attr('text-anchor', 'middle').attr('transform', null)
      } else if (layoutKind === 'lr') {
        text.attr('x', side + 6).attr('y', size * 0.35).attr('text-anchor', 'start').attr('transform', null)
      } else {
        const p = positions.get(d.id)
        // the centre's label lies flat, the others point outward and read left to right
        const angle = p && p.radius ? L.normalAngle(p.angle) : Math.PI / 2
        const deg = (angle * 180) / Math.PI
        const right = angle < Math.PI
        text.attr('text-anchor', right ? 'start' : 'end').attr('x', right ? side + 6 : -side - 6).attr('y', size * 0.35)
          .attr('transform', `rotate(${right ? deg - 90 : deg + 90})`)
      }
    })
  }

  // ---------------------------------------------------------------- interaction

  function hover(id, ev) {
    const path = new Set(id ? [id, ...ancestors(id)] : [])
    gNodes.selectAll('g.node').classed('hl', n => path.has(n.data.id))
    gLinks.selectAll('path.link').classed('hl', l => path.has(l.target.data.id) && path.has(l.source.data.id))
    if (!id) { tooltip.hidden = true; return }
    const n = byId.get(id)
    const starts = stars.has(id) && concepts.get(stars.get(id))
    tooltip.textContent = `${n.name} · ${MARK[n.status] || ''} ${n.status}${n.priority ? ` · ${n.priority} priority` : ''}${n.date ? ' · ' + n.date : ''}${starts ? ` · starts “${starts.name}”` : ''}`
    tooltip.hidden = false
    moveTooltip(ev)
  }

  function moveTooltip(ev) {
    if (!ev || tooltip.hidden) return
    tooltip.style.left = `${ev.clientX + 14}px`
    tooltip.style.top = `${ev.clientY + 12}px`
  }

  function toggle(id) {
    if (collapsed.has(id)) collapsed.delete(id)
    else collapsed.add(id)
    store.set('collapsed', [...collapsed])
    render(true)
  }

  function reveal(id) {
    let changed = false
    for (const a of ancestors(id)) if (collapsed.delete(a)) changed = true
    if (changed) { store.set('collapsed', [...collapsed]); render(true) }
  }

  function centreOn(id, animate = true) {
    const p = positions.get(id)
    if (!p) return
    const t = animate ? svg.transition().duration(450) : svg
    t.call(zoom.translateTo, p.p[0], p.p[1])
    setViewNext('fit')
  }

  function fit(animate = true) {
    const box = gNodes.node().getBBox()
    const w = svg.node().clientWidth, h = svg.node().clientHeight
    if (!box.width || !w || !h) return
    const s = Math.max(0.03, Math.min(2, 0.9 * Math.min(w / (box.width + 80), h / (box.height + 80))))
    const t = d3.zoomIdentity.translate(w / 2, h / 2).scale(s).translate(-(box.x + box.width / 2), -(box.y + box.height / 2))
    ;(animate ? svg.transition().duration(450) : svg).call(zoom.transform, t)
    setViewNext('centre')
  }

  async function select(id) {
    // the note being edited stays as it is; another one only once its changes are saved or dropped
    if (editing && (editing.id === id || !leaveEditor())) return
    if (artifactShown) leaveArtifact()
    if (id !== selected) { closeAdder(); closeMover(); closeRetyper() }
    selected = id
    showEditButton()
    gNodes.selectAll('g.node').attr('class', n => nodeClass(n.data))
    markCards()
    const n = byId.get(id)
    if (n.parent) lastChild.set(n.parent, id)
    const drawer = document.getElementById('drawer')
    drawer.hidden = false
    document.dispatchEvent(new CustomEvent('rft:note', { detail: id })) // web/phone.js: Back comes back to it
    renderConceptPath(document.getElementById('drawer-concept'), n.concept, "Open this concept's artifact", openArtifact)
    renderOrigin(n)
    renderRefs(n)
    renderWritten(n)
    renderCode(document.getElementById('drawer-code'), n.concept)
    document.getElementById('drawer-meta').textContent = `${n.type} · ${MARK[n.status] || ''} ${n.status}${n.date ? ' · ' + n.date : ''}${n.tags && n.tags.length ? ' · #' + n.tags.join(' #') : ''}`
    renderDrawerPriority(n)
    renderDrawerVerify(n)
    renderDrawerDates(n)
    markRows()
    syncNotebook(n)
    const summary = document.getElementById('drawer-summary')
    summary.textContent = n.summary || ''
    summary.hidden = !n.summary
    const over = document.getElementById('drawer-superseded')
    over.replaceChildren()
    const newer = n.supersededBy && byId.get(n.supersededBy)
    over.hidden = !newer
    if (newer) {
      const a = document.createElement('a')
      a.textContent = newer.name
      a.title = 'Go to this note'
      a.addEventListener('click', ev => { ev.preventDefault(); go(newer.id) })
      over.append('Superseded by ', a, ': its result no longer holds.')
    }
    const article = document.getElementById('note')
    // the note shown again (it, or another, changed): drawn anew only once read, and only when it differs
    const isSame = shown != null && shown.id === id
    if (!isSame) {
      article.innerHTML = '<p class="missing">Loading…</p>'
      threadsBox.hidden = true
      closeComposer()
      hideSelBar()
    }
    let got = null
    try {
      if (EMBED) {
        const body = EMBED.bodies ? EMBED.bodies[id] : null
        if (body != null) got = noteOf({ id, body, locked: n.locked, threads: (EMBED.comments && EMBED.comments[id]) || [] })
      } else {
        const res = await fetch(`api/note?id=${encodeURIComponent(id)}`, { cache: 'no-store' })
        if (res.ok) got = noteOf(await res.json())
      }
    } catch (e) { got = null }
    if (selected !== id || editing) return
    if (isSame && sameNote(got, shown)) return
    shown = got
    showEditButton()
    showNote()
  }

  // a note web/phone.js goes back to (Back, from a note reached by a link)
  document.addEventListener('rft:go', ev => { if (tree && byId.has(ev.detail)) go(ev.detail) })

  function go(id) {
    if (editing && editing.id !== id && !leaveEditor()) return
    if (view === 'kanban') { select(id); showCard(id); return }
    if (view === 'calendar') { select(id); showRow(id); return }
    reveal(id)
    select(id)
    centreOn(id)
  }

  // ---------------------------------------------------------------- the arrow keys

  // In the tree, the arrow keys walk from the note shown: ↑ to its parent, ↓ to a child (the one
  // shown last, else the first; a folded note unfolds), ← → round its siblings. With no note
  // shown they start at the top. They leave a field, the open drawer and the other pages alone.
  let keysInDrawer = false // the last click was in the drawer: there the arrows scroll the note

  /** The notes at the top of the drawn tree. */
  const drawnTops = () => (focus ? [concepts.get(focus).root] : tree.roots.length === 1 ? tree.roots : tree.roots.filter(id => shownSet.has(id)))

  /** Whether a note is in the drawn tree, folded away or not. */
  function walkable(id) {
    if (!byId.has(id)) return false
    const tops = drawnTops()
    return tops.includes(id) || (shownSet.has(id) && ancestors(id).some(a => tops.includes(a)))
  }

  /** Pans to a note only when it is off the visible canvas (beside the drawer) or near its edge. */
  function keepInView(id) {
    const p = positions.get(id)
    if (!p) return
    const el = svg.node()
    const w = el.clientWidth - (drawer.hidden ? 0 : drawer.offsetWidth), h = el.clientHeight, m = 60
    const [x, y] = d3.zoomTransform(el).apply(p.p)
    if (x > m && y > m && x < w - m && y < h - m) return
    svg.transition().duration(300).call(zoom.translateTo, p.p[0], p.p[1], [Math.max(0, w) / 2, h / 2])
    setViewNext('fit')
  }

  document.addEventListener('pointerdown', ev => { keysInDrawer = Boolean(ev.target.closest && ev.target.closest('#drawer')) }, true)
  document.addEventListener('keydown', ev => {
    const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[ev.key]
    if (!dir || !tree || view !== 'tree' || editing || ev.defaultPrevented || ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return
    if ((keysInDrawer && !drawer.hidden) || (ev.target.closest && ev.target.closest('input, textarea, select, [contenteditable], #drawer, #drawer-resize'))) return
    const tops = drawnTops()
    const to = walkable(selected)
      ? L.step(dir, selected, {
          roots: tops,
          kids: id => byId.get(id).children.filter(walkable),
          parentOf: id => (tops.includes(id) ? null : byId.get(id).parent),
          last: lastChild,
        })
      : tops[0]
    ev.preventDefault()
    if (!to || to === selected) return
    reveal(to)
    select(to)
    keepInView(to)
  })

  // ---------------------------------------------------------------- editing a note's text

  const drawer = document.getElementById('drawer')
  const article = document.getElementById('note')
  const editBtn = document.getElementById('drawer-edit')
  const editor = document.getElementById('editor')
  const textBox = document.getElementById('note-text')
  const editorMsg = document.getElementById('editor-msg')
  const noKey = document.getElementById('edit-nokey')
  const isDirty = () => editing != null && textBox.value !== editing.text
  // the key from the address, else the one this browser kept from an earlier visit with it
  const editKey = () => TOKEN || store.get('key', '')

  function showEditButton() {
    editBtn.hidden = Boolean(EMBED) || editing != null || !shown || shown.id !== selected
    if (editBtn.hidden) noKey.hidden = true
    hlBtn.hidden = editBtn.hidden
    hlHint.hidden = !highlighting || hlBtn.hidden
    addBtn.hidden = Boolean(EMBED) || editing != null || !byId.has(selected)
    moveBtn.hidden = addBtn.hidden || !byId.get(selected).parent
    // the root stays a direction
    typeBtn.hidden = Boolean(EMBED) || editing != null || !byId.has(selected) || !byId.get(selected).parent
    showLock()
  }

  function setEditorMsg(text, isError = false, isConflict = false) {
    editorMsg.textContent = text
    editorMsg.classList.toggle('error', isError)
    document.getElementById('note-overwrite').hidden = !isConflict
    document.getElementById('note-reload').hidden = !isConflict
  }

  function openEditor(note) {
    if (!note || note.id !== selected) return
    const lead = /^\n*/.exec(note.body)[0] // the blank line under the frontmatter is kept, not shown
    editing = { id: note.id, version: note.version, lead, text: note.body.slice(lead.length), newer: null }
    setHighlighting(false)
    closeAdder()
    closeRetyper()
    closeComposer()
    hideSelBar()
    fnPop.hidden = true
    threadsBox.hidden = true
    closeMover()
    textBox.value = editing.text
    textBox.readOnly = false
    noKey.hidden = true
    setEditorMsg('')
    article.hidden = true
    editor.hidden = false
    drawer.classList.add('editing')
    showEditButton()
    textBox.focus()
    textBox.setSelectionRange(0, 0)
    textBox.scrollTop = 0
  }

  function closeEditor() {
    editing = null
    editor.hidden = true
    article.hidden = false
    drawer.classList.remove('editing')
    threadsBox.hidden = !(shown && shown.threads.length)
    showEditButton()
    layoutSidenotes()
  }

  // ---- confirmations and notices in the page: the desktop's browser pane refuses alert() and confirm()

  let armedKey = null, armedUntil = 0
  /** True when the same action was asked for within the last 5 seconds; else arms it and returns false. */
  function armed(key) {
    const now = Date.now()
    if (armedKey === key && now < armedUntil) { armedKey = null; return true }
    armedKey = key; armedUntil = now + 5000
    return false
  }

  /**
   * A button that asks to be pressed again: its label says so for 5 seconds. An icon button keeps
   * its icon (there is no room for words): it lights up and the notice at the bottom asks instead.
   */
  function pressedTwice(button, ask) {
    const key = `button ${button.closest('[data-thread]')?.dataset.thread ?? ''} ${button.dataset.act ?? ''}`
    if (armed(key)) return true
    if (button.querySelector('svg')) {
      button.classList.add('armed')
      notify(`${ask} Press it again within a few seconds.`)
      setTimeout(() => button.classList.remove('armed'), 5000)
      return false
    }
    const label = button.textContent
    button.textContent = ask
    setTimeout(() => { if (button.textContent === ask) button.textContent = label }, 5000)
    return false
  }

  /** A short message at the bottom of the page, gone after a while or on a click. */
  function notify(text) {
    let box = document.getElementById('notice')
    if (!box) {
      box = document.createElement('div')
      box.id = 'notice'
      box.setAttribute('role', 'status')
      box.addEventListener('click', () => { box.hidden = true })
      document.body.appendChild(box)
    }
    box.textContent = text
    box.hidden = false
    clearTimeout(notify.timer)
    notify.timer = setTimeout(() => { box.hidden = true }, 7000)
  }

  /** Closes the editor, asking first when it holds changes; false when the user keeps them. */
  function leaveEditor() {
    if (!editing) return true
    if (isDirty() && !armed(`drop ${editing.id}`)) {
      notify(`Unsaved changes to ${editing.id}: do it again within a few seconds to drop them, or save first.`)
      return false
    }
    closeEditor()
    return true
  }

  /** Writes the text to the note; refused when the file changed since it was read, unless `force`. */
  async function save(force = false) {
    if (!editing || saving) return
    const { id } = editing
    const body = editing.lead + textBox.value
    saving = true
    textBox.readOnly = true
    setEditorMsg('Saving…')
    try {
      const res = await fetch(`api/note?id=${encodeURIComponent(id)}`, {
        method: 'PUT',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-RFT-Token': editKey() },
        body: JSON.stringify(force ? { body, force: true } : { body, version: editing.version }),
      })
      const reply = await res.json().catch(() => ({}))
      if (!editing || editing.id !== id) return
      if (res.ok) {
        closeEditor()
        select(id)
      } else if (res.status === 409) {
        editing.newer = { id, body: reply.body, version: reply.version }
        setEditorMsg('Not saved: the note changed since you opened it (Claude or another editor).', true, true)
      } else setEditorMsg(`Not saved: ${reply.error || `the server answered ${res.status}`}.`, true)
    } catch (e) {
      if (editing) setEditorMsg('Not saved: the server is not answering.', true)
    } finally {
      saving = false
      textBox.readOnly = false
    }
  }

  editBtn.addEventListener('click', () => {
    if (editKey()) openEditor(shown)
    else noKey.hidden = false
  })
  document.getElementById('note-save').addEventListener('click', () => save())
  document.getElementById('note-cancel').addEventListener('click', () => leaveEditor())
  document.getElementById('note-overwrite').addEventListener('click', () => save(true))
  document.getElementById('note-reload').addEventListener('click', () => {
    if (!editing || !editing.newer) return
    // the threads are read again with the note once it is saved or left
    shown = { ...editing.newer, locked: Boolean(shown && shown.locked), threads: [] }
    showNote()
    openEditor(shown)
  })
  textBox.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); leaveEditor() }
  })
  document.addEventListener('keydown', ev => {
    if (editing && (ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key.toLowerCase() === 's') { ev.preventDefault(); save() }
  })
  window.addEventListener('beforeunload', ev => {
    if (isDirty()) { ev.preventDefault(); ev.returnValue = '' }
  })

  // ---------------------------------------------------------------- adding a note under the one shown

  const addBtn = document.getElementById('drawer-add')
  const adder = document.getElementById('adder')
  const addType = document.getElementById('add-type')
  const addTitle = document.getElementById('add-title')
  const addMsg = document.getElementById('add-msg')

  function setAddMsg(text, isError = false) {
    addMsg.textContent = text
    addMsg.classList.toggle('error', isError)
  }

  function openAdder() {
    if (!editKey()) { noKey.hidden = false; return }
    closeRetyper()
    closeMover()
    // an experiment tests a direction; a direction comes out of an experiment, a reference or a theory note
    addType.value = byId.get(selected).type === 'direction' ? 'experiment' : 'direction'
    addTitle.value = ''
    setAddMsg('')
    adder.hidden = false
    addTitle.focus()
  }

  function closeAdder() {
    adder.hidden = true
  }

  /** Asks the server for a note under the one shown (the session makes it), then opens it in the editor. */
  async function addChild() {
    const parent = selected
    const title = addTitle.value.trim()
    if (!parent || adding) return
    if (!title) { setAddMsg('Give the note a title.', true); return }
    adding = true
    addTitle.readOnly = true
    setAddMsg('Adding…')
    try {
      const res = await fetch('api/node', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-RFT-Token': editKey() },
        body: JSON.stringify({ parent, type: addType.value, title }),
      })
      const reply = await res.json().catch(() => ({}))
      if (!res.ok) { setAddMsg(`Not added: ${reply.error || `the server answered ${res.status}`}.`, true); return }
      closeAdder()
      await poll()
      // the user may have moved on meanwhile
      if (selected !== parent || editing || !byId.has(reply.id)) return
      reveal(reply.id)
      centreOn(reply.id)
      await select(reply.id)
      openEditor(shown)
    } catch (e) {
      setAddMsg('Not added: the server is not answering.', true)
    } finally {
      adding = false
      addTitle.readOnly = false
    }
  }

  addBtn.addEventListener('click', () => (adder.hidden ? openAdder() : closeAdder()))
  adder.addEventListener('submit', ev => { ev.preventDefault(); addChild() })
  document.getElementById('add-cancel').addEventListener('click', () => closeAdder())
  adder.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); closeAdder() }
  })

  // ---------------------------------------------------------------- moving the note shown

  const moveBtn = document.getElementById('drawer-move')
  const mover = document.getElementById('mover')
  const moveTo = document.getElementById('move-to')
  const moveMsg = document.getElementById('move-msg')
  const moveOk = document.getElementById('move-ok')
  let warnedLocked = false // whether the mover open now warned that the note is locked

  function setMoveMsg(text, isError = false, isWarning = false) {
    moveMsg.textContent = text
    moveMsg.classList.toggle('error', isError)
    moveMsg.classList.toggle('warn', isWarning)
  }

  const shownLocked = () => Boolean(shown && shown.id === selected && shown.locked)

  /** A locked note's History gains a line when it moves, so the move unlocks it: said before the user confirms. */
  function warnIfLocked() {
    warnedLocked = shownLocked()
    moveOk.textContent = warnedLocked ? 'Move and unlock' : 'Move'
    setMoveMsg(warnedLocked ? 'This note is locked: moving it unlocks it and adds a line to its History.' : '', false, warnedLocked)
  }

  /** The notes the one shown may move under: not itself, nothing below it, not its parent now. */
  function moveTargets(id) {
    const below = new Set()
    const go = k => { below.add(k); (byId.get(k)?.children || []).forEach(go) }
    go(id)
    return tree.nodes.filter(n => !below.has(n.id) && n.id !== byId.get(id).parent)
  }

  function openMover() {
    if (!editKey()) { noKey.hidden = false; return }
    closeAdder()
    closeRetyper()
    const list = document.getElementById('move-targets')
    list.innerHTML = ''
    for (const n of moveTargets(selected)) {
      const o = document.createElement('option')
      o.value = n.name
      list.appendChild(o)
    }
    moveTo.value = ''
    warnIfLocked()
    mover.hidden = false
    moveTo.focus()
  }

  function closeMover() {
    mover.hidden = true
    setMoveMsg('')
  }

  /** The note a typed target names: its full name, or the id it starts with. */
  function targetOf(text) {
    const t = text.trim()
    const exact = tree.nodes.find(n => n.name === t)
    if (exact) return exact.id
    const id = t.split(/\s+/)[0].toUpperCase()
    return byId.has(id) ? id : null
  }

  /** Asks the server to move the note shown (the session does it), then shows it in its new place. */
  async function moveShown() {
    const id = selected
    if (!id || moving) return
    const parent = targetOf(moveTo.value)
    if (!parent) { setMoveMsg('Pick a note from the list (or type its id).', true); return }
    if (!moveTargets(id).some(n => n.id === parent)) { setMoveMsg('Not there: the note itself, a note below it, or where it already is.', true); return }
    // locked or unlocked since the mover opened: say so, and wait for a second confirm
    const unlock = shownLocked()
    if (unlock !== warnedLocked) { warnIfLocked(); if (!unlock) setMoveMsg('Unlocked meanwhile: Move again to move it.'); return }
    moving = true
    moveTo.readOnly = true
    setMoveMsg('Moving…')
    try {
      const res = await fetch('api/move', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-RFT-Token': editKey() },
        body: JSON.stringify(unlock ? { id, parent, unlock } : { id, parent }),
      })
      const reply = await res.json().catch(() => ({}))
      if (!res.ok) { setMoveMsg(`Not moved: ${reply.error || `the server answered ${res.status}`}.`, true); return }
      closeMover()
      await poll()
      if (selected !== id || editing) return
      reveal(id)
      centreOn(id)
      await select(id)
    } catch (e) {
      setMoveMsg('Not moved: the server is not answering.', true)
    } finally {
      moving = false
      moveTo.readOnly = false
    }
  }

  moveBtn.addEventListener('click', () => (mover.hidden ? openMover() : closeMover()))
  mover.addEventListener('submit', ev => { ev.preventDefault(); moveShown() })
  document.getElementById('move-cancel').addEventListener('click', () => closeMover())
  mover.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); closeMover() }
  })

  /** "Came from" in the drawer: the past parents of a moved note, oldest first, as links. */
  function renderOrigin(n) {
    const box = document.getElementById('drawer-origin')
    const past = (n.origin || []).filter(id => byId.has(id))
    box.hidden = !past.length
    box.innerHTML = ''
    if (!past.length) return
    box.append('Came from ')
    past.forEach((id, i) => {
      if (i) box.append(' → ')
      const a = document.createElement('a')
      a.textContent = byId.get(id).name
      a.title = 'Go to this note'
      a.addEventListener('click', ev => { ev.preventDefault(); go(id) })
      box.appendChild(a)
    })
    box.append(' → here')
  }

  /** The notes it builds on (`refs:`), and for a reference the notes that cite it, as links. */
  /** The manuscript's snippets that rest on the note: each opens in the Manuscript tab. */
  function renderWritten(n) {
    const box = document.getElementById('drawer-written')
    box.replaceChildren()
    const ids = manuscriptView ? manuscriptView.writtenIn(n.id) : []
    box.hidden = !ids.length
    if (!ids.length) return
    box.append('Written in ')
    ids.forEach((id, i) => {
      if (i) box.append(', ')
      const a = document.createElement('a')
      a.textContent = id
      a.title = 'Open this snippet in the Manuscript tab'
      a.addEventListener('click', ev => { ev.preventDefault(); setView('manuscript'); manuscriptView.openSnippet(id) })
      box.appendChild(a)
    })
  }

  function renderRefs(n) {
    const box = document.getElementById('drawer-refs')
    box.innerHTML = ''
    const line = (label, ids) => {
      if (!ids.length) return
      const row = document.createElement('div')
      row.append(label)
      ids.forEach((id, i) => {
        if (i) row.append(', ')
        const a = document.createElement('a')
        a.textContent = byId.get(id).name
        a.title = 'Go to this note'
        a.addEventListener('click', ev => { ev.preventDefault(); go(id) })
        row.appendChild(a)
      })
      box.appendChild(row)
    }
    if (n.pdf && !EMBED) {
      const row = document.createElement('div')
      const a = document.createElement('a')
      a.textContent = `Open the paper (${n.pdf.split('/').pop()})`
      a.href = `api/paper?id=${encodeURIComponent(n.id)}`
      a.target = '_blank'
      a.rel = 'noopener'
      row.appendChild(a)
      box.appendChild(row)
    }
    line('Builds on ', (n.refs || []).filter(id => byId.has(id)))
    line('Cited by ', tree.nodes.filter(m => (m.refs || []).includes(n.id)).map(m => m.id))
    box.hidden = !box.childElementCount
  }

  function syncOriginsButton() {
    const b = document.getElementById('origins-toggle')
    b.setAttribute('aria-pressed', String(showOrigins))
    const moved = tree ? tree.nodes.filter(n => n.origin && n.origin.length).length : 0
    b.title = moved
      ? `Dashed links from where each moved note came from (${moved} moved)`
      : 'Dashed links from where each moved note came from (no note has moved yet)'
  }

  document.getElementById('origins-toggle').addEventListener('click', () => {
    showOrigins = !showOrigins
    store.set('origins', showOrigins)
    syncOriginsButton()
    drawOrigins(positions)
  })

  // ---------------------------------------------------------------- changing the type of the note shown

  const typeBtn = document.getElementById('drawer-type')
  const retyper = document.getElementById('retyper')
  const retypeType = document.getElementById('retype-type')
  const retypeHint = document.getElementById('retype-hint')
  const retypeMsg = document.getElementById('retype-msg')
  const PREFIX = { experiment: 'E', direction: 'D', reference: 'R', theory: 'T' }

  function setRetypeMsg(text, isError = false) {
    retypeMsg.textContent = text
    retypeMsg.classList.toggle('error', isError)
  }

  function showRetypeHint() {
    retypeHint.textContent = `${selected} gets the next ${PREFIX[retypeType.value]} id; its text stays, and links to it follow.`
  }

  function openRetyper() {
    if (!editKey()) { noKey.hidden = false; return }
    closeAdder()
    closeMover()
    const type = byId.get(selected).type
    for (const o of retypeType.options) o.disabled = o.value === type
    // the commonest mistake: a direction made as an experiment, or the other way round
    retypeType.value = type === 'direction' ? 'experiment' : 'direction'
    showRetypeHint()
    setRetypeMsg('')
    retyper.hidden = false
    retypeType.focus()
  }

  function closeRetyper() {
    retyper.hidden = true
  }

  /** Asks the server to change the type of the note shown (the session does it), then shows it under its new id. */
  async function retype() {
    const id = selected
    if (!id || retyping) return
    const wasFolded = collapsed.has(id)
    retyping = true
    retypeType.disabled = true
    setRetypeMsg('Changing…')
    try {
      const res = await fetch('api/type', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-RFT-Token': editKey() },
        body: JSON.stringify({ id, type: retypeType.value }),
      })
      const reply = await res.json().catch(() => ({}))
      if (!res.ok) { setRetypeMsg(`Not changed: ${reply.error || `the server answered ${res.status}`}.`, true); return }
      closeRetyper()
      // a folded branch stays folded under its new id (a poll meanwhile may have redrawn it unfolded)
      if (wasFolded) { collapsed.delete(id); collapsed.add(reply.id); store.set('collapsed', [...collapsed]) }
      const version = tree.version
      await poll()
      if (wasFolded && tree.version === version) render(true)
      // the user may have moved on meanwhile
      if (selected !== id || editing || !byId.has(reply.id)) return
      reveal(reply.id)
      centreOn(reply.id)
      await select(reply.id)
    } catch (e) {
      setRetypeMsg('Not changed: the server is not answering.', true)
    } finally {
      retyping = false
      retypeType.disabled = false
    }
  }

  typeBtn.addEventListener('click', () => (retyper.hidden ? openRetyper() : closeRetyper()))
  retypeType.addEventListener('change', showRetypeHint)
  retyper.addEventListener('submit', ev => { ev.preventDefault(); retype() })
  document.getElementById('retype-cancel').addEventListener('click', () => closeRetyper())
  retyper.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); closeRetyper() }
  })

  // ---------------------------------------------------------------- search, filter, legend

  const searchBox = document.getElementById('search')
  const searchText = () => searchBox.value.trim().toLowerCase()
  searchBox.addEventListener('input', () => {
    matchAt = -1
    gNodes.selectAll('g.node').attr('class', n => nodeClass(n.data))
    markCards()
  })
  searchBox.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter') return
    const q = searchText()
    if (!q) return
    // search works with the filters: a hidden note is not a hit
    const pool = view === 'kanban' || view === 'calendar' ? boardSet : shownSet
    const hits = tree.nodes.filter(n => pool.has(n.id) && n.name.toLowerCase().includes(q))
    if (!hits.length) return
    matchAt = (matchAt + 1) % hits.length
    go(hits[matchAt].id)
  })

  // ---------------------------------------------------------------- filters

  function computeFilters() {
    matchSet = F.matching(tree, filters)
    shownSet = F.visible(tree, filters)
    boardSet = matchSet
    if (focus) {
      // focus on a concept: its subtree alone, its root always drawn
      const top = concepts.get(focus).root
      const sub = C.subtree(tree, top)
      shownSet = new Set([...shownSet].filter(id => sub.has(id)))
      shownSet.add(top)
      // the kanban has no shape to keep: only the matches inside the concept
      boardSet = new Set([...matchSet].filter(id => sub.has(id)))
    }
  }

  /** Every change of a filter goes through here: store it, recompute, redraw. */
  function applyFilters(change) {
    filters = F.normalise({ ...filters, ...change })
    store.set('filters', filters)
    computeFilters()
    buildLegend()
    buildFilterPanel()
    render(true)
    drawKanban()
    drawCalendar()
  }

  const toggled = (list, v) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v])

  function buildLegend() {
    const box = document.getElementById('statuses')
    box.innerHTML = ''
    for (const s of STATUSES) {
      const row = document.createElement('div')
      row.className = `row${filters.hiddenStatuses.includes(s) ? ' off' : ''}`
      row.innerHTML = `<span class="tdot tone s-${s}"></span>${MARK[s]} ${LABEL[s]}`
      row.title = 'Click to filter this status out or back in'
      row.addEventListener('click', () => applyFilters({ hiddenStatuses: toggled(filters.hiddenStatuses, s) }))
      box.appendChild(row)
    }
  }

  function buildFilterPanel() {
    const n = F.activeCount(filters)
    const status = document.getElementById('filter-status')
    status.hidden = n === 0
    document.getElementById('filter-count').textContent = `${n} filter${n === 1 ? '' : 's'} active · ${matchSet.size} of ${tree.nodes.length} notes`
    document.getElementById('filters-toggle').textContent = n ? `Filters (${n})` : 'Filters'
    document.querySelectorAll('input[name="fmode"]').forEach(r => { r.checked = r.value === filters.mode })
    document.querySelectorAll('input[data-ftype]').forEach(c => { c.checked = !filters.hiddenTypes.includes(c.dataset.ftype) })
    document.querySelectorAll('[data-tagmode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tagmode === filters.tagMode)))
    document.getElementById('fdate-from').value = filters.from
    document.getElementById('fdate-to').value = filters.to
    const sbox = document.getElementById('fstatuses')
    sbox.innerHTML = ''
    for (const s of STATUSES) {
      const label = document.createElement('label')
      label.innerHTML = `<input type="checkbox"${filters.hiddenStatuses.includes(s) ? '' : ' checked'}> <span class="tdot tone s-${s}"></span> ${LABEL[s]}`
      label.querySelector('input').addEventListener('change', () => applyFilters({ hiddenStatuses: toggled(filters.hiddenStatuses, s) }))
      sbox.appendChild(label)
    }
    const cbox = document.getElementById('fconcepts')
    cbox.innerHTML = ''
    const listed = C.ordered(concepts).filter(c => c.id !== C.ROOT)
    document.getElementById('fconcepts-section').hidden = !listed.length
    for (const c of listed) {
      const label = document.createElement('label')
      label.style.paddingLeft = `${(c.depth - 1) * 14}px`
      label.innerHTML = `<input type="checkbox"${filters.concepts.includes(c.id) ? ' checked' : ''}> <span class="swatch" style="background: ${C.colourOf(concepts, c.id)}"></span> ${escH(c.name)} <span class="muted">${c.total}</span>`
      label.querySelector('input').addEventListener('change', () => applyFilters({ concepts: toggled(filters.concepts, c.id) }))
      cbox.appendChild(label)
    }
    const tbox = document.getElementById('ftags')
    tbox.innerHTML = ''
    const tags = F.tagList(tree)
    // a selected tag no note carries any more still shows, so it can be cleared
    for (const t of filters.tags) if (!tags.some(x => x.tag === t)) tags.push({ tag: t, count: 0 })
    if (!tags.length) tbox.innerHTML = '<p class="muted">No topical tags in the notes yet.</p>'
    for (const { tag, count } of tags) {
      const label = document.createElement('label')
      label.innerHTML = `<input type="checkbox"${filters.tags.includes(tag) ? ' checked' : ''}> ${escH(tag)} <span class="muted">${count}</span>`
      label.querySelector('input').addEventListener('change', () => applyFilters({ tags: toggled(filters.tags, tag) }))
      tbox.appendChild(label)
    }
  }

  document.querySelectorAll('input[name="fmode"]').forEach(r => r.addEventListener('change', () => applyFilters({ mode: r.value })))
  document.querySelectorAll('input[data-ftype]').forEach(c => c.addEventListener('change', () => applyFilters({ hiddenTypes: toggled(filters.hiddenTypes, c.dataset.ftype) })))
  document.querySelectorAll('[data-tagmode]').forEach(b => b.addEventListener('click', () => applyFilters({ tagMode: b.dataset.tagmode })))
  document.getElementById('fdate-from').addEventListener('change', ev => applyFilters({ from: ev.target.value }))
  document.getElementById('fdate-to').addEventListener('change', ev => applyFilters({ to: ev.target.value }))
  document.getElementById('filters-clear').addEventListener('click', () => applyFilters({ ...F.empty(), mode: filters.mode }))
  const panel = document.getElementById('filters')
  const togglePanel = open => {
    panel.hidden = !open
    document.getElementById('legend').hidden = open
    document.getElementById('filters-toggle').setAttribute('aria-expanded', String(open))
    store.set('filtersOpen', open)
  }
  document.getElementById('filters-toggle').addEventListener('click', () => togglePanel(panel.hidden))
  document.getElementById('filters-close').addEventListener('click', () => togglePanel(false))

  // the toolbar's toggles show the current state (or the action a click does) and name the
  // next one in their tooltip
  const LAYOUTS = ['td', 'lr', 'radial']
  const LAYOUT_NAME = { td: 'Top-down', lr: 'Left-right', radial: 'Radial' }
  const following = (list, v) => list[(list.indexOf(v) + 1) % list.length]
  /** Shows the symbol of `v` on a toggle, and says in words what it is. */
  function showValue(b, v, words) {
    b.querySelectorAll('[data-v]').forEach(s => s.classList.toggle('on', s.dataset.v === v))
    b.title = words
    b.setAttribute('aria-label', words)
  }
  function syncLayoutButtons() {
    const b = document.getElementById('layout')
    showValue(b, layoutKind, `Layout: ${LAYOUT_NAME[layoutKind]} (click: ${LAYOUT_NAME[following(LAYOUTS, layoutKind)]})`)
  }

  document.getElementById('layout').addEventListener('click', () => {
    layoutKind = following(LAYOUTS, layoutKind)
    store.set('layout', layoutKind)
    syncLayoutButtons()
    render(true)
    if (view === 'concepts') drawConceptTree()
    setTimeout(() => fit(true), 420)
  })
  function setFont(value, save = true) {
    const v = Number(value)
    font = FONT_STEPS.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), 1)
    document.documentElement.style.setProperty('--font-scale', String(font))
    document.getElementById('font-size').textContent = `${Math.round(font * 100)} %`
    if (save) store.set('font', font)
    scheduleLabels()
    if (tree) drawCalendar()
  }
  const stepFont = d => setFont(FONT_STEPS[Math.max(0, Math.min(FONT_STEPS.length - 1, FONT_STEPS.indexOf(font) + d))])
  document.getElementById('font-down').addEventListener('click', () => stepFont(-1))
  document.getElementById('font-up').addEventListener('click', () => stepFont(1))
  // Fit, then Centre on root, then Fit again; a pan or zoom by hand brings it back to Fit
  let viewNext = 'fit'
  function setViewNext(v) {
    if (v === viewNext) return
    viewNext = v
    const b = document.getElementById('fit')
    showValue(b, v, v === 'fit' ? 'Fit: show the whole tree' : 'Centre on the root')
  }
  const topId = () => (focus ? concepts.get(focus).root : tree.roots[0])
  document.getElementById('fit').addEventListener('click', () => {
    if (viewNext === 'fit') fit(true)
    else if (tree && topId()) centreOn(topId())
  })
  // Expand all while a drawn branch is folded, else Collapse all
  const foldedDrawn = () => [...collapsed].some(id => positions.has(id) && byId.has(id) && byId.get(id).children.length)
  function syncFoldButton() {
    const b = document.getElementById('fold-all')
    const expand = foldedDrawn()
    showValue(b, expand ? 'expand' : 'collapse', expand ? 'Expand every branch' : 'Collapse every branch below the root')
    b.disabled = !expand && !tree.nodes.some(n => n.parent && n.children.length)
  }
  document.getElementById('fold-all').addEventListener('click', () => {
    if (!tree) return
    collapsed = foldedDrawn() ? new Set() : new Set(tree.nodes.filter(n => n.parent && n.children.length).map(n => n.id))
    store.set('collapsed', [...collapsed])
    render(true)
  })
  document.getElementById('drawer-close').addEventListener('click', () => {
    if (!leaveEditor()) return
    setHighlighting(false)
    closeAdder()
    closeRetyper()
    closeComposer()
    hideSelBar()
    fnPop.hidden = true
    document.getElementById('drawer').hidden = true
    hideNotebook()
    selected = null
    gNodes.selectAll('g.node').attr('class', n => nodeClass(n.data))
    markCards()
  })

  // the drawer's width: its left edge drags (arrow keys once focused), a double-click restores the default
  const mainEl = document.querySelector('main')
  const resizer = document.getElementById('drawer-resize')
  const DRAWER_MIN = 280
  let drawerW = null // the width dragged to, in px; null: the default, which grows with the text size
  function setDrawerWidth(w, save = true) {
    const v = Number(w)
    drawerW = w == null || !Number.isFinite(v) ? null
      : Math.round(Math.min(Math.max(DRAWER_MIN, window.innerWidth * 0.92), Math.max(DRAWER_MIN, v)))
    const prop = artifactShown ? '--artifact-w' : '--drawer-w'
    if (drawerW == null) mainEl.style.removeProperty(prop)
    else mainEl.style.setProperty(prop, `${drawerW}px`)
    if (save) store.set(artifactShown ? 'artifactWidth' : 'drawerWidth', drawerW)
  }
  let drag = null // while the edge is dragged: where the press started, and the width then
  resizer.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return
    ev.preventDefault()
    resizer.setPointerCapture(ev.pointerId)
    drag = { x: ev.clientX, w: drawer.offsetWidth, moved: false }
    document.body.classList.add('resizing')
    hideSelBar()
    fnPop.hidden = true
  })
  resizer.addEventListener('pointermove', ev => {
    if (!drag || ev.clientX === drag.x) return
    drag.moved = true
    setDrawerWidth(drag.w + drag.x - ev.clientX, false)
  })
  const endDrag = () => {
    if (!drag) return
    if (drag.moved) store.set(artifactShown ? 'artifactWidth' : 'drawerWidth', drawerW)
    drag = null
    document.body.classList.remove('resizing')
  }
  resizer.addEventListener('pointerup', endDrag)
  resizer.addEventListener('lostpointercapture', endDrag)
  resizer.addEventListener('dblclick', () => setDrawerWidth(null))
  resizer.addEventListener('keydown', ev => {
    const d = { ArrowLeft: 1, ArrowRight: -1 }[ev.key]
    if (!d) return
    ev.preventDefault()
    setDrawerWidth(drawer.offsetWidth + d * (ev.shiftKey ? 120 : 30))
  })
  document.getElementById('note').addEventListener('click', ev => {
    const a = ev.target.closest('a[data-go]')
    if (a) { ev.preventDefault(); go(a.dataset.go) }
  })
  // an image that does not come says why in its place: the server answers 404 when there is
  // none, 403 to a page without the key when it is not in the vault (it may be elsewhere)
  document.getElementById('note').addEventListener('error', async ev => {
    const img = ev.target
    if (!(img instanceof HTMLImageElement) || !img.dataset.label) return
    let status = 0
    try { status = (await fetch(img.src, { method: 'HEAD', cache: 'no-store' })).status } catch (e) { /* the server is gone */ }
    const label = img.dataset.label
    const span = document.createElement('span')
    span.className = 'missing'
    span.textContent = status === 404 ? `(missing image: ${label})`
      : status === 403 ? `(${label}: not in the vault; open the address /rft printed to show images from elsewhere)`
        : `(${label} could not be shown)`
    ;(img.closest('a.image') || img).replaceWith(span)
  }, true)
  window.addEventListener('resize', () => scheduleLabels())

  // ---------------------------------------------------------------- concepts

  function buildArrowMarkers() {
    const defs = svg.select('defs')
    C.PALETTE.forEach((colour, i) => {
      if (!defs.select(`#arrow-c${i}`).empty()) return
      defs.append('marker').attr('id', `arrow-c${i}`).attr('viewBox', '0 -4 8 8').attr('refX', 8).attr('refY', 0)
        .attr('markerWidth', 7).attr('markerHeight', 7).attr('orient', 'auto')
        .append('path').attr('d', 'M0,-4L8,0L0,4Z').attr('fill', colour)
    })
  }

  /**
   * A glow per priority, in the priority's colour (as on the kanban): full at the centre, under
   * the shape, fading out beyond it.
   */
  function buildHalos() {
    const defs = svg.select('defs')
    for (const p of K.PRIORITIES) {
      if (!defs.select(`#halo-${p}`).empty()) continue
      const g = defs.append('radialGradient').attr('id', `halo-${p}`)
      for (const [at, a] of [[0, 1], [0.45, 0.85], [0.72, 0.32], [1, 0]]) {
        g.append('stop').attr('offset', at).style('stop-color', `var(--p-${p})`).style('stop-opacity', a)
      }
    }
  }

  // the room a node takes in a region, in world units (its circle and its label), grown by `g`
  function nodeShape(sel, p, g = 0) {
    const [x, y] = p.p
    if (layoutKind === 'td') {
      const w = SPACING.td[0] * 0.92
      return sel.append('rect').attr('x', x - w / 2 - g).attr('y', y - 24 - g).attr('width', w + 2 * g).attr('height', 82 + 2 * g).attr('rx', 22 + g)
    }
    if (layoutKind === 'lr') {
      return sel.append('rect').attr('x', x - 22 - g).attr('y', y - 17 - g).attr('width', SPACING.lr[1] - 16 + 2 * g).attr('height', 34 + 2 * g).attr('rx', 17 + g)
    }
    return sel.append('circle').attr('cx', x).attr('cy', y).attr('r', 34 + g)
  }

  /**
   * One concept's region: its drawn notes and links as one soft shape with its name on top. Three
   * layers, each a group of opaque shapes faded as a whole so overlaps never darken: a border in
   * the concept's colour, the background over its inside, then a light tint. Drawn outer
   * concepts first, a sub-concept shows as a lighter region with its own border inside its parent.
   */
  function drawRegion(c, pos, className) {
    const drawn = new Set(pos.keys())
    const { nodes, links } = C.region(tree, c.id, drawn)
    if (!nodes.length) return
    const colour = C.colourOf(concepts, c.id)
    const band = layoutKind === 'lr' ? 34 : layoutKind === 'td' ? 60 : 56
    const BORDER = 2.5
    const holder = d3.select('#regions').append('g').attr('class', className).attr('data-concept', c.id)
    const layer = (fill, opacity, grow) => {
      const g = holder.append('g').attr('fill', fill).attr('stroke', fill).attr('opacity', opacity)
      for (const [a, b] of links) {
        g.append('path').attr('d', linkPath(pos.get(a), pos.get(b))).attr('fill', 'none').attr('stroke-width', band + 2 * grow)
          .attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round')
      }
      for (const id of nodes) nodeShape(g, pos.get(id), grow).attr('stroke', 'none')
    }
    layer(colour, 0.7, BORDER)
    layer('var(--bg)', 1, 0)
    layer(colour, Math.max(0.08, 0.17 - 0.03 * (c.depth - 1)), 0)
    namePill(c, pos.get(drawn.has(c.root) ? c.root : nodes[0]), `${className}-label`, true)
  }

  /**
   * A concept's name as a pill in its colour, above everything, its size constant on screen:
   * at the top-left corner of the region (`atEdge`), or centred above the concept's root note.
   */
  function namePill(c, p, className, atEdge) {
    if (!p) return
    const [x, y] = p.p
    let at
    if (!atEdge) at = layoutKind === 'lr' ? [x - 12, y - 26] : [x, y - 30]
    else if (layoutKind === 'td') at = [x - SPACING.td[0] * 0.46, y - 26]
    else if (layoutKind === 'lr') at = [x - 22, y - 19]
    else at = [x, y - 36]
    const left = atEdge && layoutKind !== 'radial'
    const pill = d3.select('#badges').append('g').attr('class', `badge ${className}`).attr('data-x', at[0]).attr('data-y', at[1])
      .attr('data-concept', c.id).on('click', ev => { ev.stopPropagation(); openArtifact(c.id) })
    const text = pill.append('text').attr('text-anchor', left ? 'start' : 'middle').attr('x', left ? 8 : 0).attr('y', left ? -5 : 4)
      .attr('font-size', 11.5).text(c.name)
    const w = Math.max(40, text.node().getComputedTextLength() + 16)
    pill.insert('rect', 'text').attr('x', left ? 0 : -w / 2).attr('y', left ? -19 : -10).attr('width', w).attr('height', 19).attr('rx', 9.5)
      .attr('fill', C.colourOf(concepts, c.id))
    pill.append('title').text(`${c.name}${c.summary ? ' — ' + c.summary : ''} (click: its artifact)`)
  }

  function drawConcepts(pos) {
    d3.select('#regions').selectAll('*').remove()
    d3.select('#badges').selectAll('*').remove()
    const list = C.ordered(concepts).filter(c => c.id !== C.ROOT)
    // in focus, the concepts enclosing the focused one would cover all of it: left out
    const drawnConcepts = focus ? list.filter(c => C.pathOf(concepts, c.id).includes(focus)) : list
    if (conceptMode === 'regions') for (const c of drawnConcepts) drawRegion(c, pos, 'region')
    const colourIndex = new Map(list.map((c, i) => [c.id, i % C.PALETTE.length]))
    gLinks.selectAll('path.link')
      .style('stroke', l => (conceptMode === 'arrows' && colourIndex.has(l.target.data.concept) ? C.PALETTE[colourIndex.get(l.target.data.concept)] : null))
      .attr('marker-end', l => (conceptMode === 'arrows' && colourIndex.has(l.target.data.concept) ? `url(#arrow-c${colourIndex.get(l.target.data.concept)})` : 'url(#arrow)'))
    if (conceptMode === 'arrows') for (const c of drawnConcepts) namePill(c, pos.get(c.root), 'name', false)
  }

  /** A short highlight of a concept's region, whatever the concept mode. */
  function flashConcept(id) {
    const c = concepts.get(id)
    if (!c || id === C.ROOT) return
    d3.selectAll('#regions .flash, #badges .flash-label').remove()
    drawRegion(c, positions, 'flash')
    updateLabels()
    setTimeout(() => d3.selectAll('#regions .flash, #badges .flash-label').remove(), 1900)
  }

  function setMode(mode) {
    conceptMode = mode
    store.set('conceptMode', mode)
    syncConceptButtons()
    buildConceptLegend()
    drawConcepts(positions)
    updateLabels()
  }

  function setFocus(id) {
    focus = id && id !== C.ROOT && concepts.has(id) ? id : null
    store.set('focus', focus)
    if (view === 'concepts') setView('tree')
    computeFilters()
    buildCrumbs()
    render(true)
    drawKanban()
    if (view === 'tree') setTimeout(() => fit(true), 420)
  }

  const CMODES = ['off', 'regions', 'arrows']
  const CMODE_NAME = { off: 'off', regions: 'regions', arrows: 'arrows' }
  const CMODE_HINT = { off: 'no overlay', regions: 'a soft region behind each concept', arrows: 'links coloured by concept' }
  function syncConceptButtons() {
    const b = document.getElementById('cmode')
    const next = following(CMODES, conceptMode)
    showValue(b, conceptMode, `Concept overlay: ${CMODE_NAME[conceptMode]}, ${CMODE_HINT[conceptMode]} (click: ${CMODE_NAME[next]})`)
    document.querySelectorAll('[data-show]').forEach(t => t.setAttribute('aria-pressed', String(t.dataset.show === view)))
  }

  /** The concept path of `id` as links that focus on each concept. */
  /** The concept path of `id`, each concept a link: to `pick` it (a note's header, an artifact's: its artifact), else to focus on it. */
  function renderConceptPath(box, id, title, pick) {
    box.innerHTML = ''
    const path = C.pathOf(concepts, concepts.has(id) ? id : C.ROOT)
    path.forEach((cid, i) => {
      if (i) box.append(' › ')
      const a = document.createElement('a')
      a.textContent = concepts.get(cid).name
      a.title = cid === C.ROOT && !pick ? 'Show the whole tree' : title
      const colour = C.colourOf(concepts, cid)
      if (colour) a.style.color = colour
      a.addEventListener('click', ev => { ev.preventDefault(); if (pick) pick(cid); else setFocus(cid === C.ROOT ? null : cid) })
      box.appendChild(a)
    })
  }

  /** The code repos of a note's concept, its own first, then inherited; nothing when it links none. */
  function renderCode(box, id) {
    const cid = concepts.has(id) ? id : C.ROOT
    const repos = C.reposOf(concepts, cid)
    box.innerHTML = ''
    box.hidden = !repos.length
    if (!repos.length) return
    box.append(repos.length === 1 ? 'Code: ' : 'Code, by priority: ')
    repos.forEach((r, i) => {
      if (i) box.append(', ')
      const code = document.createElement('code')
      code.textContent = r.path
      box.appendChild(code)
      if (r.concept !== cid) {
        const from = document.createElement('span')
        from.className = 'muted'
        from.textContent = ` (from ${concepts.get(r.concept).name})`
        box.appendChild(from)
      }
    })
  }

  function buildCrumbs() {
    const nav = document.getElementById('crumbs')
    nav.hidden = !focus
    if (!focus) return
    nav.innerHTML = '<span class="muted">Focus:</span> '
    const path = document.createElement('span')
    renderConceptPath(path, focus, 'Focus on this concept')
    nav.appendChild(path)
    const all = document.createElement('button')
    all.className = 'linkish'
    all.textContent = 'Show the whole tree'
    all.addEventListener('click', () => setFocus(null))
    nav.append(' · ', all)
  }

  /**
   * The concepts in the legend: the top-level ones, each with an arrow that unfolds its
   * sub-concepts (kept per project); the path to the focused concept is always open.
   */
  function buildConceptLegend() {
    const list = C.ordered(concepts).filter(c => c.id !== C.ROOT)
    const box = document.getElementById('concept-legend')
    box.hidden = conceptMode === 'off' || !list.length
    const rows = document.getElementById('concepts-list')
    rows.innerHTML = ''
    const open = new Set(store.get('legendConcepts', []))
    if (focus) C.pathOf(concepts, focus).forEach(id => open.add(id))
    const visible = c => C.pathOf(concepts, c.id).slice(0, -1).every(id => id === C.ROOT || open.has(id))
    for (const c of list) {
      if (!visible(c)) continue
      const row = document.createElement('div')
      row.className = `row${focus === c.id ? ' on' : ''}`
      row.style.paddingLeft = `${(c.depth - 1) * 12}px`
      const fold = document.createElement('span')
      fold.className = 'fold'
      if (c.children.length) {
        fold.textContent = open.has(c.id) ? '▾' : '▸'
        fold.title = open.has(c.id) ? 'Hide the sub-concepts' : `Show the ${c.children.length} sub-concept${c.children.length === 1 ? '' : 's'}`
        fold.addEventListener('click', ev => {
          ev.stopPropagation()
          store.set('legendConcepts', toggled(store.get('legendConcepts', []), c.id))
          buildConceptLegend()
        })
      }
      row.appendChild(fold)
      row.insertAdjacentHTML('beforeend', `<span class="swatch" style="background: ${C.colourOf(concepts, c.id)}"></span>${escH(c.name)} <span class="muted">${c.total}</span>`)
      row.title = `${c.summary || c.name} — click to focus`
      row.addEventListener('click', () => setFocus(focus === c.id ? null : c.id))
      rows.appendChild(row)
    }
  }

  // the legend opens from the faint ? beside the scratchpad's button; it starts closed
  const legend = document.getElementById('legend')
  function setLegendOpen(open) {
    legend.classList.toggle('closed', !open)
    document.getElementById('legend-toggle').setAttribute('aria-expanded', String(open))
  }
  document.getElementById('legend-toggle').addEventListener('click', () => {
    const pad = document.getElementById('pad')
    // the open scratchpad or inbox stands in the legend's place: the ? closes it and shows the legend
    const inbox = document.getElementById('inbox')
    const open = (pad && !pad.hidden) || (inbox && !inbox.hidden) || legend.classList.contains('closed')
    if (pad && !pad.hidden) document.getElementById('pad-close').click()
    if (inbox && !inbox.hidden) document.getElementById('inbox-close').click()
    store.set('legendShown', open)
    setLegendOpen(open)
  })

  // ---------------------------------------------------------------- the concept tree

  const csvg = d3.select('#concept-canvas')
  const cviewport = d3.select('#cviewport')
  const czoom = d3.zoom().scaleExtent([0.1, 4]).on('zoom', ev => cviewport.attr('transform', ev.transform))
  csvg.call(czoom).on('dblclick.zoom', null)

  function setView(v) {
    view = v
    store.set('pageView', v)
    document.body.dataset.page = v // the tree's own buttons and legend hide on the kanban (app.css)
    // SVG elements have no `hidden` property: the attribute itself
    document.getElementById('canvas').toggleAttribute('hidden', v !== 'tree')
    document.getElementById('concept-canvas').toggleAttribute('hidden', v !== 'concepts')
    document.getElementById('kanban').hidden = v !== 'kanban'
    calSection.hidden = v !== 'calendar'
    document.getElementById('manuscript').hidden = v !== 'manuscript'
    document.getElementById('slides').hidden = v !== 'slides'
    syncConceptButtons()
    if (v === 'manuscript' && manuscriptView) void manuscriptView.show()
    if (v === 'slides' && slidesView) void slidesView.show()
    if (v === 'concepts') drawConceptTree()
    if (v === 'kanban') drawKanban()
    if (v === 'calendar') drawCalendar()
    if (v === 'tree' && needsInitialView) requestAnimationFrame(() => initialView())
  }

  function drawConceptTree() {
    cviewport.selectAll('*').remove()
    const top = d3.hierarchy(concepts.get(C.ROOT), c => c.children.map(id => concepts.get(id)).filter(Boolean))
    const radius = c => 12 + 4.5 * Math.sqrt(c.total)
    // every concept is a circle with its name, count, bar and focus line below it: the block is
    // about 240 wide and 84 tall under the circle, which sets the spacing of each layout
    const BLOCK = 84
    const [b, d] = CSPACING[layoutKind]
    if (layoutKind === 'radial') L.radial(d3, top, b, d)
    else d3.tree().nodeSize([b, d])(top)
    const at = n => {
      if (layoutKind === 'td') return [n.x, n.y]
      if (layoutKind === 'lr') return [n.y, n.x]
      const a = n.angle - Math.PI / 2
      return [n.radius * Math.cos(a), n.radius * Math.sin(a)]
    }
    top.each(n => { n.p = at(n) })
    const clink = l => {
      const [x1, y1] = l.source.p, [x2, y2] = l.target.p
      const rs = radius(l.source.data), rt = radius(l.target.data)
      // top-down: from below the parent's block into the top of the child's circle
      if (layoutKind === 'td') return d3.linkVertical()({ source: [x1, y1 + rs + BLOCK], target: [x2, y2 - rt - 4] })
      // left-right: from the parent's circle to the child's, beside the blocks
      if (layoutKind === 'lr') return d3.linkHorizontal()({ source: [x1 + rs + 4, y1], target: [x2 - rt - 4, y2] })
      // radial: along the spoke, from circle edge to circle edge
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1
      return `M${x1 + (dx / len) * (rs + 4)},${y1 + (dy / len) * (rs + 4)}L${x2 - (dx / len) * (rt + 4)},${y2 - (dy / len) * (rt + 4)}`
    }
    cviewport.append('g').selectAll('path').data(top.links()).join('path').attr('class', 'clink').attr('d', clink)
    const node = cviewport.append('g').selectAll('g').data(top.descendants()).join('g')
      .attr('class', 'cnode').attr('transform', n => `translate(${n.p[0]},${n.p[1]})`)
      .on('click', (ev, n) => { ev.stopPropagation(); openArtifact(n.data.id) })
    const repos = c => c.repos || []
    const baseName = p => p.replace(/\/+$/, '').split('/').pop() || p
    node.append('title').text(n => `${n.data.name}${n.data.summary ? ' — ' + n.data.summary : ''}${repos(n.data).length ? '\nCode: ' + repos(n.data).join(', ') : ''}`)
    node.append('circle').attr('r', n => radius(n.data))
      .attr('fill', n => C.colourOf(concepts, n.data.id) || 'var(--panel)')
      .attr('stroke', n => (n.data.id === C.ROOT ? 'var(--muted)' : 'none'))
    node.append('text').attr('class', 'cname').attr('y', n => radius(n.data) + 20).attr('text-anchor', 'middle').text(n => n.data.name)
    node.append('text').attr('class', 'ccount muted').attr('y', n => radius(n.data) + 38).attr('text-anchor', 'middle')
      .text(n => `${n.data.total} note${n.data.total === 1 ? '' : 's'}${n.data.total > n.data.count ? ` (${n.data.count} own)` : ''}${repos(n.data).length ? ` · code: ${repos(n.data).map(baseName).join(', ')}` : ''}`)
    // the stacked bar of statuses, the concept with its sub-concepts
    const BAR = 130
    node.each(function (n) {
      const counts = C.totalStatuses(concepts, n.data.id)
      const total = STATUSES.reduce((a, st) => a + (counts[st] || 0), 0) || 1
      const g = d3.select(this).append('g').attr('transform', `translate(${-BAR / 2},${radius(n.data) + 48})`)
      // each status in the concept's colour at that status's strength, as the notes in the tree
      const hue = C.colourOf(concepts, n.data.id) || 'var(--fg)'
      let x = 0
      for (const st of STATUSES) {
        const w = ((counts[st] || 0) / total) * BAR
        if (!w) continue
        g.append('rect').attr('class', `cbar tone s-${st}`).style('--hue', hue).attr('x', x).attr('width', w).attr('height', 9)
          .append('title').text(`${counts[st]} ${LABEL[st]}`)
        x += w
      }
      g.append('rect').attr('width', BAR).attr('height', 9).attr('rx', 2).attr('class', 'cbar-frame')
    })
    const focusBtn = node.filter(n => n.data.id !== C.ROOT).append('g').attr('class', 'cfocus')
      .on('click', (ev, n) => { ev.stopPropagation(); setFocus(n.data.id) })
    // on a touch screen, a target wider and taller than the word (app.css)
    focusBtn.append('rect').attr('class', 'hit').attr('x', -60).attr('y', n => radius(n.data) + 50).attr('width', 120).attr('height', 40)
    focusBtn.append('text').attr('y', n => radius(n.data) + 76).attr('text-anchor', 'middle').text('focus ⤢')
    focusBtn.append('title').text('Show only this concept in the reasoning tree')
    requestAnimationFrame(() => {
      const box = cviewport.node().getBBox()
      const w = csvg.node().clientWidth, h = csvg.node().clientHeight
      if (!box.width || !w || !h) return
      const s = Math.max(0.2, Math.min(1.4, 0.88 * Math.min(w / box.width, h / box.height)))
      csvg.call(czoom.transform, d3.zoomIdentity.translate(w / 2, h / 2).scale(s).translate(-(box.x + box.width / 2), -(box.y + box.height / 2)))
    })
  }

  /** From the concept tree to the reasoning tree, centred on the concept's root note. */
  function openConcept(id) {
    const c = concepts.get(id)
    setView('tree')
    if (focus && id !== focus && !C.pathOf(concepts, id).includes(focus)) setFocus(null)
    const target = c && c.root ? c.root : tree.roots[0]
    reveal(target)
    centreOn(target)
    setTimeout(() => flashConcept(id), 450)
  }

  // ---------------------------------------------------------------- pages in a frame

  const themeNow = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
  // a page of its own in a frame inside `box`: made once, loaded again only when `version` changes
  // (a page the frame was not made for: made anew), its messages taken only from that frame
  const frames = new Map() // box → { frame, version, sandbox, onMessage }
  function openFrame(box, src, opts = {}) {
    let f = frames.get(box)
    if (!f || f.sandbox !== (opts.sandbox ?? null)) {
      box.replaceChildren()
      const frame = document.createElement('iframe')
      if (opts.sandbox != null) frame.setAttribute('sandbox', opts.sandbox)
      if (opts.allow) frame.setAttribute('allow', opts.allow)
      frame.setAttribute('referrerpolicy', 'no-referrer')
      if (opts.title) frame.title = opts.title
      box.appendChild(frame)
      f = { frame, version: null, sandbox: opts.sandbox ?? null, onMessage: null }
      frames.set(box, f)
    }
    f.onMessage = opts.onMessage || null
    const version = String(opts.version ?? src)
    if (f.version !== version) {
      f.version = version
      if (opts.srcdoc != null) { f.frame.removeAttribute('src'); f.frame.srcdoc = opts.srcdoc } else { f.frame.removeAttribute('srcdoc'); f.frame.src = src }
    }
    return f.frame
  }
  function closeFrame(box) {
    frames.delete(box)
    box.replaceChildren()
  }
  window.addEventListener('message', ev => {
    for (const f of frames.values()) {
      if (ev.source === f.frame.contentWindow) { if (f.onMessage) f.onMessage(ev.data || {}); return }
    }
  })

  // ---------------------------------------------------------------- an experiment's notebook (server/rft_notebook.py)

  // the marimo notebook that rebuilds an experiment's Result, on the left while its note is open on
  // the right: the server starts the editor of the experiment's repo (POST api/notebook, with the
  // key: the editor runs code) and the page frames it, one frame for every notebook. Closed by
  // hand, it stays closed for the notes opened after, until the drawer's notebook button opens it.
  const nbPane = document.getElementById('nbpane')
  const nbFrame = document.getElementById('nb-frame')
  const nbMsg = document.getElementById('nb-msg')
  const nbRun = document.getElementById('nb-run')
  const nbTab = document.getElementById('nb-tab')
  const nbBtn = document.getElementById('drawer-notebook')
  const nbUrls = new Map() // note id → its editor's address, once the server gave it
  let nbShown = null // the note whose notebook the pane shows
  let nbClosed = Boolean(store.get('notebookClosed', false))

  /** Shows or hides the notebook pane for the note just opened. */
  function syncNotebook(n) {
    const has = Boolean(n && n.notebook) && !EMBED
    nbBtn.hidden = !has
    if (!has || nbClosed) { hideNotebook(); return }
    openNotebook(n)
  }

  async function openNotebook(n) {
    nbShown = n.id
    nbPane.hidden = false
    nbBtn.setAttribute('aria-pressed', 'true')
    document.getElementById('nb-title').textContent = `${n.id} · notebook`
    nbRun.textContent = A.reproducedText(n.reproduced)
    nbRun.className = `nb-run${n.reproduced && n.reproduced.state ? ` r-${n.reproduced.state}` : ''}`
    nbRun.title = n.reproduced ? 'The last run by rft_run_notebook, which checks RESULTS against the note\'s Result' : 'Claude runs it with rft_run_notebook'
    // the address asked every time, the one known shown meanwhile: the server answers it at once
    // while the editor runs, and starts a new one, at a new address, once it stopped (hours unused)
    const known = nbUrls.get(n.id)
    if (!editKey()) {
      if (known) showNbFrame(n, known)
      else showNbMsg('Open the address /rft printed: the notebook runs code, so it needs the key.')
      return
    }
    if (known) showNbFrame(n, known)
    else showNbMsg('Starting the notebook in its repo\'s environment… (the first time can take a minute)')
    let url
    try {
      const res = await fetch('api/notebook', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-RFT-Token': editKey() },
        body: JSON.stringify({ id: n.id }),
      })
      const reply = await res.json().catch(() => ({}))
      if (!res.ok || typeof reply.url !== 'string') throw new Error(reply.error || `the server answered ${res.status}`)
      url = reply.url
      nbUrls.set(n.id, url)
    } catch (e) {
      if (nbShown === n.id) showNbMsg(`The notebook did not open: ${e.message}`)
      return
    }
    if (nbShown === n.id) showNbFrame(n, url)
  }

  /** The notebook framed: its editor, through this page's own server (notebook/<name>/), the one address a tunnel to it reaches. */
  function showNbFrame(n, url) {
    const src = A.notebookSrc(url, themeNow())
    nbMsg.hidden = true
    nbFrame.hidden = false
    nbTab.href = src
    const shown = frames.get(nbFrame)?.version
    const frame = openFrame(nbFrame, src, { title: `The notebook of ${n.id}`, allow: 'clipboard-read; clipboard-write' })
    if (shown === src) return // the page it already shows
    if (!frame.dataset.themed) {
      frame.dataset.themed = '1'
      frame.addEventListener('load', () => themeNotebook(frame))
    }
    // the page on its way: styled once its document is there, before its scripts run (each widget
    // of marimo's copies the page's stylesheets when it is made, so a later one would miss them)
    let before = null
    try { before = frame.contentDocument } catch (e) { /* not this page's */ }
    clearInterval(nbStyling)
    const until = Date.now() + 30000
    nbStyling = setInterval(() => {
      let doc = null
      try { doc = frame.contentDocument } catch (e) { /* not this page's */ }
      if ((doc && doc !== before && themeNotebook(frame)) || Date.now() > until || !frame.isConnected) clearInterval(nbStyling)
    }, 20)
  }
  let nbStyling = 0

  /** The editor in the page's colours and fonts (A.notebookStyle): a stylesheet in its document,
      which the page's own server serves, so the page may. Under the name of marimo's own custom
      stylesheets, since those are what it carries into its widgets, and the first of them, since
      of several under one name it carries the first: so a notebook's own (`css_file`) comes after
      it and has the last word, and is copied into it for the widgets. True once it is there. */
  function themeNotebook(frame) {
    let doc = null
    try { doc = frame.contentDocument } catch (e) { /* not this page's to style */ }
    if (!doc || !doc.head || !doc.body) return false
    if (doc.querySelector('style[data-rft]')) return true
    const page = getComputedStyle(document.documentElement)
    const tokens = {}
    for (const k of ['bg', 'panel', 'fg', 'muted', 'line', 'accent']) tokens[k] = page.getPropertyValue(`--${k}`)
    const style = doc.createElement('style')
    style.dataset.rft = 'theme'
    style.title = 'marimo-custom'
    style.textContent = A.notebookStyle(tokens)
    const theirs = () => [...doc.querySelectorAll('style[title="marimo-custom"]:not([data-rft])')]
    const first = theirs()[0]
    if (first) first.before(style)
    else doc.head.appendChild(style)
    const fold = () => {
      for (const s of theirs()) {
        if (s.dataset.rftFolded) continue
        s.dataset.rftFolded = '1'
        style.textContent += `\n${s.textContent}`
      }
    }
    fold()
    // the rest of the page still on its way: once it is read, before its scripts run
    if (doc.readyState === 'loading') doc.addEventListener('readystatechange', fold)
    return true
  }
  // the theme's button: the notebook shown follows it (its frame loads again, the kernel as it was);
  // one that is closed takes the page's theme when it is opened next
  new MutationObserver(() => {
    const n = nbShown && byId.get(nbShown)
    if (n && !nbFrame.hidden && nbUrls.has(n.id)) showNbFrame(n, nbUrls.get(n.id))
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

  function showNbMsg(text) {
    nbMsg.textContent = text
    nbMsg.hidden = false
    nbFrame.hidden = true
  }

  /** The pane hidden; its frame kept, so the same notebook comes back as it was. */
  function hideNotebook() {
    nbShown = null
    nbPane.hidden = true
    nbBtn.setAttribute('aria-pressed', 'false')
  }

  nbBtn.addEventListener('click', () => {
    nbClosed = !nbPane.hidden
    store.set('notebookClosed', nbClosed)
    const n = selected && byId.get(selected)
    if (nbClosed || !n) hideNotebook()
    else openNotebook(n)
  })
  document.getElementById('nb-close').addEventListener('click', () => {
    nbClosed = true
    store.set('notebookClosed', true)
    hideNotebook()
  })

  // its right edge drags (arrow keys once focused), a double-click restores the default
  const nbResizer = document.getElementById('nbpane-resize')
  const NB_MIN = 320
  function setNotebookWidth(w, save = true) {
    const v = Number(w)
    const width = w == null || !Number.isFinite(v) ? null : Math.round(Math.min(window.innerWidth * 0.92, Math.max(NB_MIN, v)))
    if (width == null) mainEl.style.removeProperty('--nb-w')
    else mainEl.style.setProperty('--nb-w', `${width}px`)
    if (save) store.set('notebookWidth', width)
  }
  setNotebookWidth(store.get('notebookWidth', null), false)
  let nbDrag = null
  nbResizer.addEventListener('pointerdown', ev => {
    if (ev.button !== 0) return
    ev.preventDefault()
    nbResizer.setPointerCapture(ev.pointerId)
    nbDrag = { x: ev.clientX, w: nbPane.offsetWidth }
    document.body.classList.add('resizing')
  })
  nbResizer.addEventListener('pointermove', ev => { if (nbDrag) setNotebookWidth(nbDrag.w + ev.clientX - nbDrag.x, false) })
  const nbEnd = () => {
    if (!nbDrag) return
    nbDrag = null
    document.body.classList.remove('resizing')
    store.set('notebookWidth', nbPane.offsetWidth)
  }
  nbResizer.addEventListener('pointerup', nbEnd)
  nbResizer.addEventListener('lostpointercapture', nbEnd)
  nbResizer.addEventListener('dblclick', () => setNotebookWidth(null))
  nbResizer.addEventListener('keydown', ev => {
    const d = { ArrowLeft: -1, ArrowRight: 1 }[ev.key]
    if (!d) return
    ev.preventDefault()
    setNotebookWidth(nbPane.offsetWidth + d * (ev.shiftKey ? 120 : 30))
  })

  // ---------------------------------------------------------------- a concept's artifact (web/artifacts.js)

  // the page of a concept's results Claude writes (vault/artifacts/), shown in the drawer in a note's
  // place when the concept is clicked: its name on a region or badge, its node in the concept view,
  // the concept path in a note's header. A note link in it opens the note; the note's concept path
  // brings the artifact back, where it was scrolled to.
  const artView = document.getElementById('artifact-view')
  const artFrame = document.getElementById('art-frame')
  const artScroll = new Map() // concept → where its artifact was scrolled to
  let imageKey = '' // the key the frame gets for its images, which writes nothing (image_key in server/rft_server.py)
  async function deriveImageKey() {
    const key = editKey()
    if (!key || !window.crypto || !crypto.subtle) return
    try {
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${key}:images`))
      imageKey = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
    } catch (e) { imageKey = '' }
  }

  async function openArtifact(cid) {
    if (!tree || !concepts.has(cid)) return
    if (editing && !leaveEditor()) return
    closeAdder(); closeMover(); closeRetyper(); closeComposer(); hideSelBar(); setHighlighting(false)
    fnPop.hidden = true
    selected = null
    hideNotebook()
    gNodes.selectAll('g.node').attr('class', n => nodeClass(n.data))
    markCards()
    artifactShown = cid
    drawer.hidden = false
    document.dispatchEvent(new CustomEvent('rft:note', { detail: null })) // web/phone.js: a concept's artifact, no note
    drawer.classList.add('artifact-mode')
    mainEl.classList.add('artifact-open')
    artView.hidden = false
    if (view === 'concepts') drawConceptTree() // fitted again beside the drawer
    if (!EMBED && !imageKey) await deriveImageKey()
    if (artifactShown !== cid) return
    renderArtifact()
    if (view === 'tree') flashConcept(cid)
  }

  function leaveArtifact() {
    const was = artifactShown
    artifactShown = null
    drawer.classList.remove('artifact-mode')
    mainEl.classList.remove('artifact-open')
    artView.hidden = true
    if (was && view === 'concepts') drawConceptTree()
  }

  function closeArtifact() {
    leaveArtifact()
    drawer.hidden = true
  }

  /** How each note link in the artifact is marked: from the tree as it is now. */
  function noteMarks() {
    const out = {}
    for (const n of tree.nodes) out[n.id] = A.decoration(byId, n.id)
    return out
  }

  function tellFrame(extra = {}) {
    const f = frames.get(artFrame)
    // caps: what this page offers the frame's buttons (a PDF needs the libraries the server serves)
    if (f && f.frame.contentWindow) f.frame.contentWindow.postMessage({ rft: 'tree', theme: themeNow(), notes: noteMarks(), caps: { pdf: !EMBED }, ...extra }, '*')
  }

  function answerFrame(msg) {
    const f = frames.get(artFrame)
    if (f && f.frame.contentWindow) f.frame.contentWindow.postMessage({ rft: 'tree', ...msg }, '*')
  }

  /** Copies text, for the frame's Copy LaTeX when the frame itself may not. */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (e) {
      const area = document.createElement('textarea')
      area.value = text
      area.style.cssText = 'position:fixed;left:-10000px;top:0'
      document.body.appendChild(area)
      area.select()
      let ok = false
      try { ok = document.execCommand('copy') } catch (e2) { ok = false }
      area.remove()
      return ok
    }
  }

  // an SVG figure as a vector PDF: jsPDF and svg2pdf.js (web/vendor, MIT), loaded the first time
  const PDF_LIBS = ['vendor/jspdf.v4.2.1.umd.min.js', 'vendor/svg2pdf.v2.9.0.umd.min.js']
  let pdfLibs = null
  function loadPdfLibs() {
    if (!pdfLibs) {
      pdfLibs = PDF_LIBS.reduce((done, src) => done.then(() => new Promise((ok, fail) => {
        const s = document.createElement('script')
        s.src = src
        s.onload = ok
        s.onerror = () => fail(new Error(`could not load ${src}`))
        document.head.appendChild(s)
      })), Promise.resolve()).catch(err => { pdfLibs = null; throw err })
    }
    return pdfLibs
  }

  /** A length of an SVG's width or height in points (px, pt, in, cm, mm; a bare number is px), or null. */
  function points(value) {
    const m = /^\s*([\d.]+)\s*(px|pt|in|cm|mm)?\s*$/i.exec(value || '')
    if (!m) return null
    const k = { px: 0.75, pt: 1, in: 72, cm: 72 / 2.54, mm: 72 / 25.4 }[(m[2] || 'px').toLowerCase()]
    return Number(m[1]) * k || null
  }

  /** Downloads an SVG (its source from the artifact's frame) as a PDF of its own size, named `name`.pdf. */
  async function svgToPdf(text, name) {
    await loadPdfLibs()
    const parsed = new DOMParser().parseFromString(text, 'image/svg+xml')
    const svg = parsed.documentElement
    if (!svg || svg.nodeName.toLowerCase() !== 'svg' || parsed.querySelector('parsererror')) throw new Error('not an SVG')
    // nothing of it runs here: no scripts, no foreign content, no handlers
    for (const el of svg.querySelectorAll('script, foreignObject')) el.remove()
    for (const el of [svg, ...svg.querySelectorAll('*')]) for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name)
    const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number)
    const w = points(svg.getAttribute('width')) || (vb.length === 4 && vb[2] * 0.75) || 400
    const h = points(svg.getAttribute('height')) || (vb.length === 4 && vb[3] * 0.75) || 300
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden'
    const node = document.importNode(svg, true)
    host.appendChild(node)
    document.body.appendChild(host)
    try {
      const pdf = new window.jspdf.jsPDF({ unit: 'pt', format: [w, h], orientation: w > h ? 'landscape' : 'portrait' })
      if (typeof pdf.svg === 'function') await pdf.svg(node, { x: 0, y: 0, width: w, height: h })
      else await window.svg2pdf.svg2pdf(node, pdf, { x: 0, y: 0, width: w, height: h })
      pdf.save(`${String(name || 'figure').replace(/[^\w.-]+/g, '-') || 'figure'}.pdf`)
    } finally {
      host.remove()
    }
  }

  function renderArtifact() {
    const cid = artifactShown
    const e = cid ? A.entry(tree, cid) : null
    if (!e) { closeArtifact(); return }
    const c = concepts.get(cid)
    renderConceptPath(document.getElementById('art-path'), cid, "Open this concept's artifact", openArtifact)
    document.getElementById('art-title').textContent = c.name
    const summary = document.getElementById('art-summary')
    summary.textContent = c.summary || ''
    summary.hidden = !c.summary
    const state = document.getElementById('art-state')
    state.textContent = A.stateText(e, tree)
    state.className = `art-state ${e.state}`
    const subs = document.getElementById('art-subs')
    const list = A.subConcepts(tree, cid)
    subs.replaceChildren()
    subs.hidden = !list.length
    if (list.length) subs.append('Sub-concepts: ')
    list.forEach((s, i) => {
      if (i) subs.append(' · ')
      const a = document.createElement('a')
      a.className = `art-sub ${s.state}`
      a.textContent = s.name
      a.title = `${s.name}: ${A.stateText(A.entry(tree, s.id), tree)}`
      const colour = C.colourOf(concepts, s.id)
      if (colour) a.style.color = colour
      a.addEventListener('click', ev => { ev.preventDefault(); openArtifact(s.id) })
      subs.appendChild(a)
    })
    document.getElementById('art-focus').title = cid === C.ROOT ? 'Show the whole tree' : "Focus: show only this concept's subtree"
    const html = EMBED ? EMBED.artifacts && EMBED.artifacts[cid] : null
    if (!e.artifact || (EMBED && html == null)) { closeFrame(artFrame); artFrame.hidden = true; return }
    artFrame.hidden = false
    const version = `${cid}:${e.artifact.version}`
    const kept = frames.get(artFrame)
    const same = kept && kept.version === version
    const title = `The artifact of ${c.name}`
    if (EMBED) openFrame(artFrame, null, { srcdoc: A.wrap(html, EMBED.frame || {}, themeNow()), sandbox: 'allow-scripts allow-popups', allow: 'clipboard-write', version, onMessage: onArtifactMessage, title })
    else openFrame(artFrame, A.frameSrc(cid, { theme: themeNow(), token: imageKey, y: artScroll.get(cid) || 0 }), { sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox', allow: 'clipboard-write', version, onMessage: onArtifactMessage, title })
    // the frame kept: its note links marked again, from the tree as it is now, and scrolled back to
    // where it was (hidden while a note was shown, it lost its place)
    if (same) tellFrame({ y: artScroll.get(cid) || 0 })
  }

  function onArtifactMessage(d) {
    if (d.rft !== 'artifact' || !artifactShown) return
    if (d.type === 'ready') tellFrame(EMBED ? { y: artScroll.get(artifactShown) || 0 } : {})
    else if (d.type === 'scroll' && typeof d.y === 'number') artScroll.set(artifactShown, d.y)
    else if (d.type === 'go' && typeof d.id === 'string' && byId.has(d.id)) { if (view === 'concepts') select(d.id); else go(d.id) }
    else if (d.type === 'copy' && typeof d.text === 'string') copyText(d.text).then(ok => answerFrame({ ticket: d.ticket, ok }))
    else if (d.type === 'pdf' && typeof d.svg === 'string' && !EMBED) {
      svgToPdf(d.svg, d.name).then(() => answerFrame({ ticket: d.ticket, ok: true }), err => { console.warn('rft: PDF', err); answerFrame({ ticket: d.ticket, ok: false }) })
    }
  }

  // the theme switched: the artifact follows, without loading again
  new MutationObserver(() => { if (artifactShown) tellFrame() }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  document.getElementById('art-close').addEventListener('click', closeArtifact)
  document.getElementById('art-tree').addEventListener('click', () => { if (artifactShown) openConcept(artifactShown) })
  document.getElementById('art-focus').addEventListener('click', () => { if (artifactShown) setFocus(artifactShown === C.ROOT ? null : artifactShown) })

  document.getElementById('cmode').addEventListener('click', () => setMode(following(CMODES, conceptMode)))
  document.querySelectorAll('[data-show]').forEach(t => t.addEventListener('click', () => setView(t.dataset.show)))

  // ---------------------------------------------------------------- the kanban (web/kanban.js)

  // one column per status, the notes that pass the filters as cards, ordered by priority or by
  // date; the priority is the user's alone, set here or in the drawer, and the answer to Claude's
  // suggested one
  const kbCols = document.getElementById('kb-cols')
  const COLUMN_LABEL = { ...LABEL, review: 'review', other: 'another status' }
  const PRIORITY_LABEL = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' }

  /** A priority menu in `box` the user is in (focused, not waiting for its write), or null. */
  function menuIn(box) {
    const a = document.activeElement
    return a && a.matches && a.matches('select.prio') && !a.disabled && box.contains(a) ? a : null
  }

  /**
   * Whether `box` may be redrawn now: not while the user is in one of its priority menus (the
   * notes change under them as Claude works), which `draw` then redraws once they leave it.
   */
  function mayRedraw(box, draw) {
    const menu = menuIn(box)
    if (!menu) return true
    if (!menu.dataset.redraw) {
      menu.dataset.redraw = 'after'
      menu.addEventListener('blur', () => draw(), { once: true })
    }
    return false
  }

  function drawKanban() {
    if (!tree || view !== 'kanban' || !mayRedraw(kbCols, drawKanban)) return
    // a redraw keeps where the board and each column were scrolled to
    const kept = new Map([...kbCols.querySelectorAll('.kb-list')].map(l => [l.parentElement.dataset.status, l.scrollTop]))
    const left = kbCols.scrollLeft
    const notes = tree.nodes.filter(n => boardSet.has(n.id))
    kbCols.replaceChildren(...K.columns(notes, { order: kanbanOrder, hiddenStatuses: filters.hiddenStatuses }).map(kanbanColumn))
    kbCols.scrollLeft = left
    kbCols.querySelectorAll('.kb-list').forEach(l => { if (kept.has(l.parentElement.dataset.status)) l.scrollTop = kept.get(l.parentElement.dataset.status) })
    syncKanbanBar(notes.length)
  }

  function kanbanColumn(c) {
    const col = document.createElement('section')
    const open = !c.folded || kanbanOpen.has(c.status)
    col.className = `kb-col${open ? '' : ' folded'}`
    col.dataset.status = c.status
    const head = document.createElement('div')
    head.className = 'kb-head'
    head.innerHTML = `<span class="tdot tone s-${escH(c.status)}"></span><span class="kb-name">${escH(MARK[c.status] ? `${MARK[c.status]} ` : '')}${escH(COLUMN_LABEL[c.status] || c.status)}</span><span class="kb-n muted">${c.notes.length}</span>`
    col.appendChild(head)
    if (c.folded) {
      // a folded column is a narrow strip: a click opens it, its head folds it again
      const flip = () => {
        kanbanOpen = new Set(toggled([...kanbanOpen], c.status))
        store.set('kanbanOpen', [...kanbanOpen])
        drawKanban()
      }
      ;(open ? head : col).addEventListener('click', flip)
      ;(open ? head : col).title = open ? 'Fold this column' : `${c.notes.length} ${COLUMN_LABEL[c.status]}: click to open the column`
      head.classList.add('kb-fold')
    }
    if (!open) return col
    const list = document.createElement('div')
    list.className = 'kb-list'
    if (!c.notes.length) list.innerHTML = '<p class="kb-empty muted">No notes</p>'
    for (const n of c.notes) list.appendChild(kanbanCard(n))
    col.appendChild(list)
    return col
  }

  const isHit = n => { const q = searchText(); return Boolean(q) && n.name.toLowerCase().includes(q) }
  const cardClass = n => `kb-card${n.priority ? ` p-${n.priority}` : ''}${n.id === selected ? ' selected' : ''}${isHit(n) ? ' match' : ''}${n.supersededBy ? ' superseded' : ''}`

  function kanbanCard(n) {
    const el = document.createElement('article')
    el.className = cardClass(n)
    el.dataset.id = n.id
    el.tabIndex = 0
    el.innerHTML = `<div class="kb-top"><span class="tdot ${escH(toneOf(n))}" title="${escH(`${n.type} · ${n.status}`)}"></span><span class="kb-id">${escH(n.id)}</span><span class="kb-title">${escH(n.title || n.name)}</span></div>`
    if (n.summary) {
      const s = document.createElement('div')
      s.className = 'kb-summary'
      s.textContent = n.summary
      s.title = n.summary
      el.appendChild(s)
    }
    const meta = document.createElement('div')
    meta.className = 'kb-meta'
    meta.appendChild(priorityControl(n))
    const c = n.concept && n.concept !== C.ROOT && concepts.get(n.concept)
    if (c) meta.insertAdjacentHTML('beforeend', `<span class="kb-concept" title="${escH(c.summary || c.name)}"><span class="swatch" style="background: ${C.colourOf(concepts, c.id)}"></span>${escH(c.name)}</span>`)
    const dl = dueChip(n)
    if (dl) meta.appendChild(dl)
    if (n.date) meta.insertAdjacentHTML('beforeend', `<span class="kb-date muted">${escH(n.date)}</span>`)
    if (n.supersededBy) meta.insertAdjacentHTML('beforeend', `<span class="kb-flag" title="Superseded by ${escH(n.supersededBy)}: its result no longer holds">superseded</span>`)
    el.appendChild(meta)
    if (n.suggestedPriority) el.appendChild(suggestionBox(n))
    el.addEventListener('click', () => select(n.id))
    el.addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.target === el) select(n.id) })
    return el
  }

  /** The cards' marks after a selection or a search, without a redraw. */
  function markCards() {
    if (view !== 'kanban') return
    kbCols.querySelectorAll('.kb-card').forEach(el => { const n = byId.get(el.dataset.id); if (n) el.className = cardClass(n) })
  }

  /** The card of a note in view, its folded column opened if need be, briefly lit. */
  function showCard(id) {
    const n = byId.get(id)
    if (n && K.FOLDED.includes(n.status) && !kanbanOpen.has(n.status) && boardSet.has(id)) {
      kanbanOpen.add(n.status)
      store.set('kanbanOpen', [...kanbanOpen])
      drawKanban()
    }
    const el = [...kbCols.querySelectorAll('.kb-card')].find(x => x.dataset.id === id)
    if (!el) return
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
    el.classList.add('flash')
    setTimeout(() => el.classList.remove('flash'), 1400)
  }

  /** The order buttons, and how the open notes use each priority (the limits are the project's, whatever the filters). */
  function syncKanbanBar(count) {
    document.querySelectorAll('[data-kb-order]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.kbOrder === kanbanOrder)))
    const use = prioUse
    const box = document.getElementById('kb-limits')
    box.replaceChildren('Open priorities: ')
    K.PRIORITIES.forEach((p, i) => {
      const limit = K.LIMITS[p], held = use[p]
      const s = document.createElement('span')
      s.className = `p-${p}${limit != null && held.length > limit ? ' over' : limit != null && held.length === limit ? ' full' : ''}`
      s.textContent = `${p} ${held.length}${limit == null ? '' : `/${limit}`}`
      s.title = held.length ? `${held.join(', ')}${limit != null && held.length > limit ? `: more than the ${limit} allowed, lower some` : ''}` : `No open note is ${p}`
      box.append(i ? ' · ' : '', s)
    })
    const filtered = F.activeCount(filters) > 0 || focus
    document.getElementById('kb-count').textContent = `${count}${filtered ? ` of ${tree.nodes.length}` : ''} note${count === 1 ? '' : 's'}`
  }

  document.querySelectorAll('[data-kb-order]').forEach(b => b.addEventListener('click', () => {
    kanbanOrder = b.dataset.kbOrder
    store.set('kanbanOrder', kanbanOrder)
    drawKanban()
  }))

  /**
   * A note's priority as a menu: only the user changes it. A priority the open notes already fill
   * is offered greyed out, naming them; the standalone page shows it read-only.
   */
  function priorityControl(n) {
    const sel = document.createElement('select')
    sel.className = `prio${n.priority ? ` p-${n.priority}` : ''}`
    sel.setAttribute('aria-label', `Priority of ${n.id}`)
    for (const v of ['', ...K.PRIORITIES]) {
      const o = document.createElement('option')
      const held = v ? K.blockers(tree.nodes, n, v, prioUse) : []
      o.value = v
      o.textContent = v ? `${PRIORITY_LABEL[v]}${held.length ? ` (full: ${held.join(', ')})` : ''}` : 'No priority'
      o.disabled = held.length > 0
      o.selected = (n.priority || '') === v
      sel.appendChild(o)
    }
    sel.title = `${n.priority ? `Priority: ${n.priority}` : 'No priority'}. Only you set it; Claude can suggest one.`
    sel.disabled = Boolean(EMBED)
    sel.addEventListener('click', ev => ev.stopPropagation())
    sel.addEventListener('keydown', ev => ev.stopPropagation())
    sel.addEventListener('change', () => setPriority(n.id, sel.value || null, sel))
    return sel
  }

  /** Claude's suggested priority and why, for the user to accept or dismiss. */
  function suggestionBox(n) {
    const p = n.suggestedPriority
    const box = document.createElement('div')
    box.className = 'suggest'
    box.innerHTML = `<span>Claude suggests <b class="p-${escH(p)}">${escH(PRIORITY_LABEL[p] || p)}</b>${n.suggestedWhy ? `: <span class="suggest-why">${escH(n.suggestedWhy)}</span>` : ''}</span>`
    if (n.suggestedWhy) box.title = n.suggestedWhy
    box.addEventListener('click', ev => ev.stopPropagation())
    if (EMBED) return box
    const held = K.blockers(tree.nodes, n, p, prioUse)
    const accept = document.createElement('button')
    accept.type = 'button'
    accept.textContent = 'Accept'
    accept.disabled = held.length > 0
    accept.title = held.length ? `${p} is full: ${held.join(', ')} ${held.length === 1 ? 'holds' : 'hold'} it. Lower one of them first.` : `Make ${n.id} ${p}`
    accept.addEventListener('click', () => setPriority(n.id, p, accept))
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.textContent = 'Dismiss'
    dismiss.title = `Drop the suggestion; ${n.id} keeps ${n.priority ? `its priority (${n.priority})` : 'no priority'}`
    dismiss.addEventListener('click', () => setPriority(n.id, null, dismiss, true))
    const bar = document.createElement('span')
    bar.className = 'suggest-bar'
    bar.append(accept, dismiss)
    box.appendChild(bar)
    return box
  }

  /** The drawer's priority row: the menu, and Claude's suggestion when there is one. */
  function renderDrawerPriority(n) {
    const box = document.getElementById('drawer-priority')
    if (!mayRedraw(box, () => renderDrawerPriority(byId.get(selected)))) return
    box.replaceChildren()
    box.hidden = !n
    if (!n) return
    const label = document.createElement('span')
    label.className = 'muted'
    label.textContent = 'Priority'
    box.append(label, priorityControl(n))
    if (n.suggestedPriority) box.appendChild(suggestionBox(n))
  }

  /**
   * Sets a note's priority (null: none), or with `dismiss` drops Claude's suggestion; the page
   * follows once the note is written. Changes made in a row each go through (the server writes
   * them one at a time).
   */
  // ---------------------------------------------------------------- verification

  /**
   * Why a note should not be verified yet, as hooks/lib/verify.ts verifyBlockers says it (the
   * user may verify it anyway, after a warning); none when it can be.
   */
  function verifyWarnings(n) {
    const out = []
    if (n.supersededBy) out.push(`it is superseded by ${n.supersededBy}`)
    if (n.type === 'experiment' && n.notebook && (!n.reproduced || n.reproduced.state !== 'ok')) {
      out.push(n.reproduced ? `its notebook's last run ${n.reproduced.state === 'unchecked' ? 'checked nothing' : n.reproduced.state} (${n.reproduced.date})` : 'its notebook has not run')
    }
    if (n.type === 'direction') {
      const under = id => (byId.get(id)?.children || []).some(k => byId.get(k)?.status === 'verified' || under(k))
      if (!under(n.id)) out.push('no verified note under it confirms it')
    }
    return out
  }

  /**
   * The drawer's verification row: a verified note's stamp and Back to review; Verify on a note that
   * is done or in review; Claude's suggestion to verify, with Accept and Dismiss. Only the user
   * verifies, and verifying locks the note.
   */
  function renderDrawerVerify(n) {
    const box = document.getElementById('drawer-verify')
    box.replaceChildren()
    const can = n && ['done', 'review', 'verified'].includes(n.status)
    box.hidden = !can && !(n && n.suggestedVerified)
    if (box.hidden) return
    const button = (text, title, action) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = text
      b.title = title
      b.disabled = Boolean(EMBED)
      b.addEventListener('click', () => verify(n, action, b))
      return b
    }
    const state = document.createElement('span')
    state.className = `verify-state s-${n.status}`
    if (n.status === 'verified') {
      state.textContent = `✔ Verified${n.verified ? ` on ${n.verified.date}` : ''}`
      state.title = 'You checked what this note claims; it is locked, so Claude only suggests changes to it. A change to its claim sends it back to review.'
      box.append(state, button('Back to review', 'Its claim may no longer hold: review it again (this unlocks it)', 'review'))
    } else if (n.status === 'review') {
      state.textContent = `↺ In review${n.verified ? `, verified on ${n.verified.date}` : ''}`
      state.title = 'It was verified, and its claim changed since or was overturned: check it again, then verify it, or give it another status'
      box.append(state)
      if (!n.suggestedVerified) box.append(button('Verify', 'You checked its claim again: verify it, which locks it', 'verify'))
    } else if (can && !n.suggestedVerified) {
      box.append(button('Verify', 'You checked what this note claims: verify it, which locks it. Only verified notes go into the manuscript.', 'verify'))
    }
    if (n.suggestedVerified && n.status !== 'verified') {
      const s = document.createElement('div')
      s.className = 'suggest'
      s.innerHTML = `<span>Claude suggests <b>verifying it</b>: <span class="suggest-why">${escH(n.suggestedVerified)}</span></span>`
      s.title = n.suggestedVerified
      if (!EMBED) {
        const bar = document.createElement('span')
        bar.className = 'suggest-bar'
        if (can) bar.append(button('Accept', 'Verify it, which locks it', 'verify'))
        bar.append(button('Dismiss', 'Drop the suggestion', 'dismiss'))
        s.appendChild(bar)
      }
      box.appendChild(s)
    }
  }

  /** Verifies a note, dismisses Claude's suggestion to, or sends it back to review: done by the session that ran /rft. */
  async function verify(n, action, control) {
    if (EMBED) return
    if (!editKey()) {
      notify('To verify notes, open the address /rft printed (it ends in ?token=…) once: this browser then remembers its key.')
      return
    }
    if (action === 'verify') {
      const warn = verifyWarnings(n)
      if (warn.length && !confirm(`${n.id} may not be ready to verify: ${warn.join('; ')}.\n\nVerify it anyway?`)) return
    }
    if (control) control.disabled = true
    try {
      const res = await fetch('api/verify', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-RFT-Token': editKey() },
        body: JSON.stringify({ id: n.id, action }),
      })
      const reply = await res.json().catch(() => ({}))
      if (!res.ok) notify(`${action === 'dismiss' ? 'Not dismissed' : action === 'review' ? 'Not sent to review' : 'Not verified'}: ${reply.error || `the server answered ${res.status}`}`)
    } catch (e) {
      notify('The server is not answering.')
    } finally {
      await poll()
      if (selected && byId.has(selected)) renderDrawerVerify(byId.get(selected))
      if (control) control.disabled = false
    }
  }

  async function setPriority(id, priority, control, dismiss = false) {
    if (EMBED) return
    const redraw = () => { drawKanban(); if (selected && byId.has(selected)) renderDrawerPriority(byId.get(selected)) }
    if (!editKey()) {
      notify('To set priorities, open the address /rft printed (it ends in ?token=…) once: this browser then remembers its key.')
      redraw()
      return
    }
    if (control) control.disabled = true
    try {
      const res = await fetch('api/priority', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-RFT-Token': editKey() },
        body: JSON.stringify(dismiss ? { id, dismiss: true } : { id, priority }),
      })
      const reply = await res.json().catch(() => ({}))
      if (!res.ok) notify(`${dismiss ? 'Not dismissed' : 'Priority not set'}: ${reply.error || `the server answered ${res.status}`}`)
    } catch (e) {
      notify('The server is not answering.')
    } finally {
      await poll()
      redraw() // also puts a menu back when the change was refused
    }
  }

  // ---------------------------------------------------------------- the calendar (web/schedule.js)

  // the deadlines (milestones, and notes' own due dates), the meetings and the experiments' runs, as
  // a timeline (a row per meeting and per experiment, the deadlines as lines across them, the GPUs
  // below) or a month (the deadlines and the meetings on their days, the runs across them). The
  // dates are the user's alone: set here (drag a bar or its end, + Deadline, + Meeting, a deadline's
  // or a meeting's edit, an occurrence skipped or moved) and in the note's drawer, which also answer
  // Claude's suggested ones. The filters and the concept focus choose the rows, as on the kanban.
  const S = window.RftSchedule
  const CAL_MODES = ['timeline', 'month']
  const CAL_ZOOM = [10, 16, 24, 34, 48] // a day's width on the timeline, in px at A 100 %
  const TL_LABEL = 230 // the timeline's column of titles, in px at A 100 %
  // that column's width: at most 38 % of a narrow screen (a phone), so the days keep the rest
  const tlLabelW = () => Math.round(Math.min(TL_LABEL, Math.max(120, window.innerWidth * 0.38)) * font)
  const calSection = document.getElementById('calendar')
  const calBody = document.getElementById('cal-body')
  const calDeadlines = document.getElementById('cal-deadlines')
  const calAdder = document.getElementById('cal-adder')
  let calMode = 'timeline'
  let calZoom = 2
  let calMonth = null // the month shown, YYYY-MM
  let calDrag = null // a bar being dragged: nothing is redrawn under it
  let calScroll = null // where the timeline was scrolled to, kept across redraws: { from, left }
  let calOpen = null // the deadline or the meeting whose editor is open
  let calOcc = null // with a meeting open, the occurrence chosen (the day its rule gives it), or null for the meeting itself
  let plans = [] // every deadline planned (S.plan), for the whole tree
  let planOf = new Map() // a note → the nearest deadline that needs it, and its plan for the note

  /** Today, here: YYYY-MM-DD. */
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
  const monthOf = day => day.slice(0, 7)
  // in English, as the rest of the page
  const monthName = ym => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const shortDay = day => new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10))).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  /** A due date with a zone (AoE, UTC, ±HH:MM) as the time here: `Mon 30 Nov, 12:59 here`; '' for a day or a local time. */
  function localOf(due) {
    const utc = S.utcOf(due)
    return utc ? `${new Date(utc).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} here` : ''
  }

  /** The deadlines planned again: after every read of the tree. */
  function planAll() {
    plans = S.plan(tree.nodes, tree.milestones || [], todayStr(), tree.meetings || [])
    planOf = new Map()
    for (const p of plans) for (const i of p.items) if (!planOf.has(i.id)) planOf.set(i.id, { plan: p, item: i })
  }

  function drawCalendar() {
    if (!tree || view !== 'calendar' || calDrag || calBusyIn(calSection)) return
    const today = todayStr()
    if (!calMonth) calMonth = monthOf(today)
    const d = { today, wins: S.windows(tree.nodes, today), gpu: S.gpuDays(tree.nodes, today), clashes: S.gpuLoad(tree.nodes, tree.gpus, today) }
    document.querySelectorAll('[data-cal-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.calMode === calMode)))
    calSection.dataset.mode = calMode
    drawDeadlines(d)
    if (calMode === 'month') drawMonth(d)
    else drawTimeline(d)
    const g = document.getElementById('cal-gpus')
    if (tree.gpus) {
      const n = d.clashes.clashes.length
      g.textContent = `${tree.gpus} GPU${tree.gpus === 1 ? '' : 's'}: ${n ? `${n} clash${n === 1 ? '' : 'es'} ahead` : 'no clash ahead'}${d.clashes.noEnd.length ? ` · ${d.clashes.noEnd.join(', ')} running with no end planned` : ''}`
      g.title = d.clashes.clashes.map(c => S.clashLine(c, tree.gpus)).join('\n') || 'The planned and running experiments fit on the GPUs'
      g.classList.toggle('over', n > 0)
    } else {
      g.textContent = ''
      g.title = ''
    }
    syncDatalist()
  }

  /** Whether the user is typing in a form inside `box`: it is redrawn once they leave it. */
  function calBusyIn(box) {
    const a = document.activeElement
    if (!a || !box.contains(a) || !a.matches('input, select, textarea')) return false
    if (!a.dataset.redraw) {
      a.dataset.redraw = 'after'
      a.addEventListener('blur', () => { delete a.dataset.redraw; setTimeout(drawCalendar, 0) }, { once: true })
    }
    return true
  }

  /** The note ids the deadline forms offer. */
  function syncDatalist() {
    const list = document.getElementById('cal-ids')
    if (list.childElementCount === tree.nodes.length) return
    list.replaceChildren(...tree.nodes.filter(n => n.type === 'experiment' || n.type === 'direction').map(n => {
      const o = document.createElement('option')
      o.value = n.id
      o.label = n.name
      return o
    }))
  }

  /** A write of the user's dates or deadlines; the page follows once it is on disk. */
  async function calWrite(route, body, what) {
    if (EMBED) return null
    if (!editKey()) {
      notify('To change dates, open the address /rft printed (it ends in ?token=…) once: this browser then remembers its key.')
      return null
    }
    try {
      const res = await fetch(route, {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-RFT-Token': editKey() },
        body: JSON.stringify(body),
      })
      const reply = await res.json().catch(() => ({}))
      if (!res.ok) { notify(`${what}: ${reply.error || `the server answered ${res.status}`}`); return null }
      return reply
    } catch (e) {
      notify('The server is not answering.')
      return null
    } finally {
      await poll()
      drawCalendar()
      if (selected && byId.has(selected)) renderDrawerDates(byId.get(selected))
    }
  }
  const setDates = (id, dates, what = 'Dates not set') => calWrite('api/dates', { id, ...dates }, what)
  const writeMilestone = (body, what = 'Deadline not changed') => calWrite('api/milestone', body, what)
  const writeMeeting = (body, what = 'Meeting not changed') => calWrite('api/meeting', body, what)

  // ---------------------------------------------------------------- the deadlines strip

  function drawDeadlines(d) {
    calDeadlines.replaceChildren()
    for (const p of plans.filter(p => p.daysLeft >= 0 || p.atRisk)) calDeadlines.appendChild(deadlineCard(p))
    for (const m of (tree.milestones || []).filter(m => m.status === 'suggested')) calDeadlines.appendChild(suggestedDeadline(m))
    // the meetings of the next 7 days, once each (one that needs notes is above, as a deadline),
    // and the one whose editor is open, wherever it falls
    const shown = new Set(plans.filter(p => p.kind === 'meeting').map(p => p.id))
    for (const { meeting: m } of S.upcoming(tree.meetings || [], d.today, S.addDays(d.today, 7))) {
      if (shown.has(m.id)) continue
      shown.add(m.id)
      calDeadlines.appendChild(meetingCard(m, d.today))
    }
    const open = meetingOf(calOpen)
    if (open && !shown.has(open.id)) calDeadlines.appendChild(meetingCard(open, d.today))
    if (!calDeadlines.childElementCount) {
      calDeadlines.innerHTML = `<span class="muted">No deadline or meeting ahead.${EMBED ? '' : ' <b>+ Deadline</b> and <b>+ Meeting</b> add one (or click a day of the Month); Claude suggests paper submissions when you name a venue.'}</span>`
    }
  }

  const milestoneOf = id => (tree.milestones || []).find(m => m.id === id)

  /** A deadline: when, how much room is left or what puts it at risk, the notes it needs; a milestone's or a meeting's own editor. */
  function deadlineCard(p) {
    const el = document.createElement('article')
    const open = p.kind !== 'note' && calOpen === p.id && !EMBED
    el.className = `cal-dl${p.kind === 'meeting' ? ' cal-mt' : ''}${p.atRisk ? ' risk' : ''}${p.slack !== null && p.slack > 0 && p.slack <= 3 ? ' tight' : ''}${open && p.kind === 'meeting' ? ' open' : ''}`
    el.dataset.id = p.id
    const head = document.createElement('div')
    head.className = 'cal-dl-head'
    const name = document.createElement('a')
    name.className = 'cal-dl-name'
    name.textContent = p.name
    name.title = p.kind === 'note' ? 'Open the note' : p.kind === 'meeting' ? 'Edit this meeting (it needs these notes by its next occurrence)' : 'Edit this deadline'
    name.addEventListener('click', () => (p.kind === 'note' ? go(p.id) : toggleEditor(p.id)))
    head.append(name)
    const here = localOf(p.at)
    head.insertAdjacentHTML('beforeend', `<span class="cal-dl-when"${here ? ` title="${escH(here)}"` : ''}>${escH(p.dueText)}${here ? ` (${escH(here)})` : ''} · <b>${escH(S.when(p.daysLeft))}</b></span>`)
    el.appendChild(head)
    const detail = S.detail(p)
    if (detail) {
      const t = document.createElement('div')
      t.className = 'cal-dl-detail'
      t.textContent = detail
      t.title = detail
      el.appendChild(t)
    }
    if (p.kind === 'milestone' && open) {
      const m = milestoneOf(p.id)
      el.appendChild(milestoneEditor(m))
      const due = S.parseDue(m.due)
      el.appendChild(deckRow(m.id, '', m.title || m.name.replace(/^M\d+\s*/, ''), due ? shortDay(due.day) : ''))
    }
    if (p.kind === 'meeting' && open && meetingOf(p.id)) el.appendChild(meetingEditor(meetingOf(p.id)))
    return el
  }

  /** A deadline's or a meeting's editor opened in its card, or closed. */
  function toggleEditor(id) {
    calOpen = calOpen === id ? null : id
    calOcc = null
    drawCalendar()
  }

  /** A milestone's editor: its due date and the notes it needs; Done; Cancel. */
  function milestoneEditor(m) {
    const f = document.createElement('form')
    f.className = 'cal-dl-edit'
    f.innerHTML = `<label>Due <input name="due" type="text" value="${escH(m.due || '')}" placeholder="2026-11-13 23:59 AoE" required></label>
      <label>Needs <input name="needs" type="text" value="${escH((m.needs || []).join(', '))}" placeholder="E03, E04" list="cal-ids"></label>
      <span class="cal-dl-buttons"><button type="submit" class="primary">Save</button><button type="button" data-act="done" title="Mark it done: it leaves the plan">Done</button><button type="button" data-act="cancel">Cancel</button></span>`
    f.addEventListener('submit', async ev => {
      ev.preventDefault()
      const needs = f.needs.value.split(/[\s,]+/).filter(Boolean)
      if (await writeMilestone({ id: m.id, due: f.due.value.trim(), needs })) calOpen = null
      drawCalendar()
    })
    f.querySelector('[data-act="done"]').addEventListener('click', async () => {
      if (await writeMilestone({ id: m.id, status: 'done' })) calOpen = null
      drawCalendar()
    })
    f.querySelector('[data-act="cancel"]').addEventListener('click', () => { calOpen = null; f.remove(); drawCalendar() })
    f.addEventListener('keydown', ev => { if (ev.key === 'Escape') { calOpen = null; f.remove(); drawCalendar() } })
    return f
  }

  /** Claude's suggested deadline, with where it was read and why, for the user to accept or dismiss. */
  function suggestedDeadline(m) {
    const el = document.createElement('article')
    el.className = 'cal-dl suggested'
    const due = S.parseDue(m.due)
    const here = localOf(due)
    el.innerHTML = `<div class="cal-dl-head"><span class="cal-dl-name">Claude suggests ${escH(m.name)}</span><span class="cal-dl-when">${escH(S.formatDue(due) || m.due || '')}${here ? ` (${escH(here)})` : ''}${due ? ` · <b>${escH(S.when(S.between(todayStr(), due.day)))}</b>` : ''}</span></div>`
    const why = document.createElement('div')
    why.className = 'cal-dl-detail'
    why.textContent = m.why || ''
    if (m.source && /^https?:\/\//.test(m.source)) {
      const a = document.createElement('a')
      a.href = m.source
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.textContent = 'official dates'
      a.title = m.source
      why.append(m.why ? ' · ' : '', a)
    }
    el.appendChild(why)
    if (EMBED) return el
    const bar = document.createElement('span')
    bar.className = 'suggest-bar'
    const accept = document.createElement('button')
    accept.type = 'button'
    accept.textContent = 'Accept'
    accept.title = 'Make it a deadline: it is planned for from now on'
    accept.addEventListener('click', () => writeMilestone({ id: m.id, accept: true }, 'Not accepted'))
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.textContent = 'Dismiss'
    dismiss.title = 'Drop it: it stays in the vault as dismissed, so it is not suggested again'
    dismiss.addEventListener('click', () => writeMilestone({ id: m.id, dismiss: true }, 'Not dismissed'))
    bar.append(accept, dismiss)
    el.querySelector('.cal-dl-head').appendChild(bar)
    return el
  }

  // ---------------------------------------------------------------- the meetings

  const meetingOf = id => (id && /^G\d+$/.test(id) ? (tree.meetings || []).find(m => m.id === id) : null) || null
  const ZONES = ['', 'UTC', 'AoE']
  const zoneOptions = zone => [...ZONES, ...(zone && !ZONES.includes(zone) ? [zone] : [])]
    .map(z => `<option value="${escH(z)}"${(zone || '') === z ? ' selected' : ''}>${z ? escH(z) : 'local time'}</option>`).join('')
  /** `1st`, `2nd`, `23rd`. */
  const ordinal = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`
  /** The time a meeting of `minutes` that starts at `time` ends: `15:30`. */
  const endOf = (time, minutes) => { const t = (60 * +time.slice(0, 2) + +time.slice(3, 5) + minutes) % 1440; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}` }
  /** An occurrence's day and hours: `Tue 1 Dec, 14:00–15:00`, `Fri 13 Nov, all day`. */
  const occWhen = (at, minutes) => `${shortDay(at.day)}, ${at.time ? `${at.time}${minutes ? `–${endOf(at.time, minutes)}` : ''}${at.zone ? ` ${at.zone}` : ''}` : 'all day'}`
  /** A meeting's `when:` from a day, a time and a zone (a zone only with a time). */
  const whenOf = (day, time, zone) => [day, time, time && zone ? zone : ''].filter(Boolean).join(' ')
  const idsIn = text => text.split(/[\s,]+/).filter(Boolean)

  /** A meeting's editor opened in the strip, on one of its occurrences (`orig`, the day its rule gives it) or on itself. */
  function openMeeting(id, orig) {
    calOpen = id
    calOcc = orig || null
    drawCalendar()
    calDeadlines.querySelector(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  /** A meeting in the strip: its next occurrence, how it comes back, and its editor when open. */
  function meetingCard(m, today) {
    const next = S.nextOccurrence(m, today)
    const minutes = S.parseDuration(m.duration)
    const open = calOpen === m.id && !EMBED
    const el = document.createElement('article')
    el.className = `cal-dl cal-mt${open ? ' open' : ''}`
    el.dataset.id = m.id
    const head = document.createElement('div')
    head.className = 'cal-dl-head'
    const name = document.createElement('a')
    name.className = 'cal-dl-name'
    name.textContent = m.name
    name.title = EMBED ? m.name : 'Edit this meeting'
    name.addEventListener('click', () => toggleEditor(m.id))
    head.append(name)
    const here = next ? localOf(next.at) : ''
    head.insertAdjacentHTML('beforeend', `<span class="cal-dl-when"${here ? ` title="${escH(here)}"` : ''}>${next ? `${escH(occWhen(next.at, minutes))} · <b>${escH(S.when(S.between(today, next.day)))}</b>` : 'none ahead'}</span>`)
    el.appendChild(head)
    const detail = document.createElement('div')
    detail.className = 'cal-dl-detail'
    detail.textContent = [S.repeatText(m), next && next.moved ? `this one moved from ${shortDay(next.orig)}` : ''].filter(Boolean).join(' · ')
    el.appendChild(detail)
    if (open) el.appendChild(meetingEditor(m))
    return el
  }

  /**
   * The slide decks of a meeting's occurrence (`orig`, its rule's day; '' for a once-only meeting)
   * or of a deadline, each opened in the Slides tab, and + Slides, a new deck for it (`title`,
   * `subtitle` its title slide's second line). Nothing when there is no Slides tab.
   */
  function deckRow(id, orig, title, subtitle) {
    const row = document.createElement('div')
    row.className = 'cal-decks'
    if (!slidesView) return row
    const label = document.createElement('span')
    label.className = 'muted'
    label.textContent = 'Slides'
    row.append(label)
    for (const d of slidesView.decksFor(id, orig)) {
      const a = document.createElement('button')
      a.type = 'button'
      a.className = 'linkish'
      a.textContent = d.name
      a.title = 'Open this deck in the Slides tab'
      a.addEventListener('click', () => { setView('slides'); void slidesView.openDeck(d.id) })
      row.append(a)
    }
    const add = document.createElement('button')
    add.type = 'button'
    add.textContent = '+ Slides'
    add.title = `A new deck for ${orig ? `this occurrence (${shortDay(orig)})` : 'it'}, opened in the Slides tab`
    add.addEventListener('click', async () => {
      setView('slides')
      await slidesView.newFor(window.RftSlides.forItem(id, orig), title, subtitle)
    })
    row.append(add)
    return row
  }

  /** A meeting's editor: the occurrence chosen (moved, skipped, the last one), then the meeting or its series. */
  function meetingEditor(m) {
    const box = document.createElement('div')
    box.className = 'cal-mt-edit'
    if (m.every && calOcc) box.appendChild(occurrenceForm(m, calOcc))
    // the decks of this occurrence (a once-only meeting's: its own), and a new one for it
    const start = S.parseDue(m.when)
    const orig = m.every ? calOcc : start && start.day
    if (orig && !(m.skip || []).includes(orig)) {
      const t = m.title || m.name
      // the day it takes place on, which a move may have changed
      const occ = S.occurrences(m, S.addDays(orig, -366), S.addDays(orig, 366)).find(x => x.orig === orig)
      box.appendChild(deckRow(m.id, m.every ? orig : '', m.every ? `${t} ${orig}` : t, `${t} · ${shortDay(occ ? occ.day : orig)}`))
    }
    box.appendChild(seriesForm(m))
    box.addEventListener('keydown', ev => { if (ev.key === 'Escape') { calOpen = null; calOcc = null; drawCalendar() } })
    return box
  }

  /** What to do with one occurrence of a meeting that comes back: move it, skip it, bring it back, end the series with it. */
  function occurrenceForm(m, orig) {
    const start = S.parseDue(m.when) || { day: orig }
    const skip = m.skip || [], moved = m.moved || []
    const skipped = skip.includes(orig)
    const away = moved.map(x => S.parseMoved(x, start)).find(x => x && x.from === orig)
    const at = away ? away.to : { ...start, day: orig }
    const others = moved.filter(x => { const mv = S.parseMoved(x, start); return !mv || mv.from !== orig })
    const f = document.createElement('form')
    f.className = 'cal-dl-edit cal-occ'
    const what = `${skipped ? 'Skipped' : 'This one'}, ${escH(occWhen({ ...start, day: orig }, 0))}${away ? ` (moved to ${escH(occWhen(at, 0))})` : ''}`
    if (skipped) {
      f.innerHTML = `<span><b>${what}</b></span><span class="cal-dl-buttons"><button type="submit" class="primary" title="It takes place again, as the rule gives it">Bring it back</button></span>`
      f.addEventListener('submit', ev => { ev.preventDefault(); writeMeeting({ id: m.id, skip: skip.filter(d => d !== orig) }, 'Not brought back') })
      return f
    }
    f.innerHTML = `<span><b>${what}</b></span>
      <label>Move to <input name="day" type="date" value="${escH(at.day)}" required></label><input name="time" type="time" value="${escH(at.time || '')}" aria-label="The time">
      <span class="cal-dl-buttons"><button type="submit" class="primary">Move</button>${away ? `<button type="button" data-act="back" title="Back to its own day and time">Back</button>` : ''}<button type="button" data-act="skip" title="It does not take place this time">Skip</button><button type="button" data-act="last" title="End the series with this one">Last one</button></span>`
    f.addEventListener('submit', async ev => {
      ev.preventDefault()
      const day = f.day.value, time = f.time.value
      if (!S.isDay(day)) return notify('Give the day it moves to.')
      const to = S.parseDue(whenOf(day, time, start.zone))
      const home = day === orig && (time || '') === (start.time || '')
      await writeMeeting({ id: m.id, moved: home ? others : [...others, S.formatMoved(orig, to)] }, 'Not moved')
    })
    f.querySelector('[data-act="back"]')?.addEventListener('click', () => writeMeeting({ id: m.id, moved: others }, 'Not moved back'))
    f.querySelector('[data-act="skip"]').addEventListener('click', () => writeMeeting({ id: m.id, skip: [...skip, orig], moved: others }, 'Not skipped'))
    f.querySelector('[data-act="last"]').addEventListener('click', () => writeMeeting({
      id: m.id, until: orig, skip: skip.filter(d => d <= orig),
      moved: moved.filter(x => { const mv = S.parseMoved(x, start); return mv && mv.from <= orig }),
    }, 'Not ended'))
    return f
  }

  /**
   * How often a meeting comes back, as a menu worked out from its day (every week on Tuesday, every
   * month on the fourth Tuesday, on the last Tuesday) and Custom…, which takes any rule as written
   * (3 weeks, 2 months on the first Friday). `onChange(repeats)` when it changes.
   */
  function repeatPicker(day, every, onChange = () => {}) {
    const el = document.createElement('span')
    el.className = 'cal-repeat'
    const sel = document.createElement('select')
    sel.setAttribute('aria-label', 'How often it comes back')
    const custom = document.createElement('input')
    custom.type = 'text'
    custom.size = 18
    custom.placeholder = '3 weeks, 2 months on the last Friday'
    custom.setAttribute('aria-label', 'How often it comes back, as written')
    custom.hidden = true
    el.append(sel, custom)
    const optionsFor = d => {
      const out = [{ kind: 'once', value: '', label: 'Does not repeat' }]
      if (S.isDay(d)) {
        const wd = S.WEEKDAY_NAMES[S.weekday(d)]
        const { nth, last } = S.nthOf(d)
        out.push({ kind: 'day', value: 'day', label: 'Every day' }, { kind: 'week', value: 'week', label: `Every week on ${wd}` },
          { kind: '2 weeks', value: '2 weeks', label: `Every 2 weeks on ${wd}` }, { kind: 'date', value: 'month', label: `Every month on the ${ordinal(+d.slice(8))}` },
          { kind: 'nth', value: `month on the ${S.ORDINALS[nth - 1]} ${wd}`, label: `Every month on the ${S.ORDINALS[nth - 1]} ${wd}` })
        if (last) out.push({ kind: 'last', value: `month on the last ${wd}`, label: `Every month on the last ${wd}` })
      }
      out.push({ kind: 'custom', value: null, label: 'Custom…' })
      return out
    }
    let options = []
    const fill = (d, kind) => {
      options = optionsFor(d)
      sel.replaceChildren(...options.map(o => { const x = document.createElement('option'); x.value = o.kind; x.textContent = o.label; return x }))
      sel.value = options.some(o => o.kind === kind) ? kind : kind === 'last' ? 'nth' : 'once'
      custom.hidden = sel.value !== 'custom'
    }
    // the rule as written, among the day's choices, or as Custom…
    const canon = every ? S.formatEvery(S.parseEvery(every)) || every : ''
    const found = optionsFor(day).find(o => o.value === canon)
    fill(day, found ? found.kind : canon ? 'custom' : 'once')
    if (!found && canon) custom.value = every
    sel.addEventListener('change', () => { custom.hidden = sel.value !== 'custom'; if (!custom.hidden) custom.focus(); onChange(sel.value !== 'once') })
    return {
      el,
      /** The rule to write: '' for none. */
      value: () => (sel.value === 'custom' ? custom.value.trim() : (options.find(o => o.kind === sel.value) || {}).value || ''),
      /** The day changed: the same kind of choice for it. */
      setDay: d => fill(d, sel.value),
      repeats: () => sel.value !== 'once',
    }
  }

  /** A meeting's own fields: its (first) day and time, how long, how often and until when, what it needs; Save, Delete. */
  function seriesForm(m) {
    const start = S.parseDue(m.when) || {}
    const f = document.createElement('form')
    f.className = 'cal-dl-edit'
    f.innerHTML = `<span><b>${m.every ? 'The series' : 'The meeting'}</b></span>
      <label>${m.every ? 'From' : 'On'} <input name="day" type="date" value="${escH(start.day || '')}" required></label>
      <input name="time" type="time" value="${escH(start.time || '')}" aria-label="The time (none: all day)" title="The time (none: all day)">
      <select name="zone" aria-label="The time zone">${zoneOptions(start.zone)}</select>
      <label>for <input name="duration" type="text" size="6" value="${escH(m.duration || '')}" placeholder="1h" title="How long: 1h, 45m, 1h30m"></label>
      <span data-slot="repeat"></span>
      <label data-slot="until">until <input name="until" type="date" value="${escH(m.until || '')}" title="The last day it may fall on (none: no end)"></label>
      <label>Needs <input name="needs" type="text" value="${escH((m.needs || []).join(', '))}" placeholder="E03" list="cal-ids" title="The notes it needs done by its next occurrence"></label>
      <span class="cal-dl-buttons"><button type="submit" class="primary">Save</button><button type="button" data-act="delete">Delete</button><button type="button" data-act="cancel">Cancel</button></span>`
    const untilBox = f.querySelector('[data-slot="until"]')
    const picker = repeatPicker(start.day, m.every || '', repeats => { untilBox.hidden = !repeats })
    f.querySelector('[data-slot="repeat"]').replaceWith(picker.el)
    untilBox.hidden = !picker.repeats()
    f.day.addEventListener('change', () => picker.setDay(f.day.value))
    f.addEventListener('submit', async ev => {
      ev.preventDefault()
      const when = whenOf(f.day.value, f.time.value, f.zone.value)
      const every = picker.value()
      const until = every ? f.until.value : ''
      const body = { id: m.id, when, duration: f.duration.value.trim() || null, every: every || null, until: until || null, needs: idsIn(f.needs.value) }
      // the occurrences skipped or moved that the new rule no longer gives go
      const draft = { ...m, when, every, until }
      const begin = S.parseDue(when)
      const skip = every ? (m.skip || []).filter(d => S.isOccurrence(draft, d)) : []
      const moved = every ? (m.moved || []).filter(x => { const mv = S.parseMoved(x, begin); return mv && S.isOccurrence(draft, mv.from) }) : []
      if (skip.length !== (m.skip || []).length) body.skip = skip
      if (moved.length !== (m.moved || []).length) body.moved = moved
      if (await writeMeeting(body)) { calOpen = null; calOcc = null }
      drawCalendar()
    })
    f.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      if (!window.confirm(`Delete ${m.name}${m.every ? ' and all its occurrences' : ''}?`)) return
      if (await writeMeeting({ id: m.id, delete: true }, 'Not deleted')) { calOpen = null; calOcc = null }
      drawCalendar()
    })
    f.querySelector('[data-act="cancel"]').addEventListener('click', () => { calOpen = null; calOcc = null; drawCalendar() })
    return f
  }

  /** The meetings that fall from `from` up to `to` (excluded), their skipped occurrences too in the page that edits: each with the deadline it is, when it needs notes. */
  function meetingsIn(from, to) {
    const planFor = new Map(plans.filter(p => p.kind === 'meeting').map(p => [p.id, p]))
    return (tree.meetings || []).map(m => ({
      meeting: m,
      occ: S.occurrences(m, from, to, { skipped: !EMBED }).map(o => {
        const p = planFor.get(m.id)
        return { ...o, plan: p && p.orig === o.orig && !o.skipped ? p : null }
      }),
    })).filter(x => x.occ.length)
  }

  /** An occurrence's tooltip: the meeting, when, how it comes back, moved or skipped, and the deadline it is. */
  const occTitle = (m, o) => [`${m.name}: ${occWhen(o.at, S.parseDuration(m.duration))}${localOf(o.at) ? ` (${localOf(o.at)})` : ''}`, S.repeatText(m),
    o.moved ? `moved from ${shortDay(o.orig)}` : '', o.skipped ? 'skipped (click to bring it back)' : '', o.plan ? S.deadlineLine(o.plan) : ''].filter(Boolean).join(' · ')

  // ---------------------------------------------------------------- the timeline

  function drawTimeline(d) {
    const dayW = Math.round(CAL_ZOOM[calZoom] * font)
    const labelW = tlLabelW()
    const winOf = new Map(d.wins.map(w => [w.id, w]))
    const shown = n => boardSet.has(n.id)
    const rows = tree.nodes.filter(n => shown(n) && n.type === 'experiment' && !n.supersededBy &&
      (winOf.has(n.id) || (planOf.has(n.id) && n.status !== 'running') || n.suggestedStart || n.suggestedEst || n.due))
    // the days shown: from two weeks back to eight ahead, widened to the bars and the deadlines
    // (a year back at most), from a Monday
    let from = S.addDays(d.today, -14)
    let to = S.addDays(d.today, 56)
    const span = (a, b) => { if (a && a < from) from = a; if (b && b > to) to = b }
    for (const n of rows) {
      const w = winOf.get(n.id)
      if (w) span(w.from, w.to)
      const p = planOf.get(n.id)
      if (p && p.item.latestStart) span(p.item.latestStart, p.item.latestEnd)
      if (n.suggestedStart) span(n.suggestedStart, S.addDays(n.suggestedStart, n.suggestedEst || n.est || 1))
    }
    for (const p of plans) span(null, S.addDays(p.due, 7))
    if (S.between(from, d.today) > 365) from = S.addDays(d.today, -365)
    from = S.addDays(from, -S.weekday(from))
    to = S.addDays(to, 6 - S.weekday(to))
    const days = S.between(from, to) + 1
    const x = day => S.between(from, day) * dayW
    const width = labelW + days * dayW

    const kept = calBody.querySelector('.tl-scroll')
    const keep = kept ? { from: kept.dataset.from, left: kept.scrollLeft, top: kept.scrollTop } : null
    const scroll = document.createElement('div')
    scroll.className = 'tl-scroll'
    scroll.dataset.from = from
    const grid = document.createElement('div')
    grid.className = 'tl-grid'
    grid.style.width = `${width}px`
    grid.style.setProperty('--day', `${dayW}px`)
    grid.style.setProperty('--label', `${labelW}px`)
    scroll.appendChild(grid)

    // the head: months, then days (weekends shaded); the deadlines' flags under them
    const head = document.createElement('div')
    head.className = 'tl-head'
    const months = document.createElement('div')
    months.className = 'tl-row tl-months'
    const daysRow = document.createElement('div')
    daysRow.className = 'tl-row tl-days'
    const flags = document.createElement('div')
    flags.className = 'tl-row tl-flags'
    for (const r of [months, daysRow, flags]) {
      const corner = document.createElement('div')
      corner.className = 'tl-label tl-corner'
      r.appendChild(corner)
      const track = document.createElement('div')
      track.className = 'tl-track'
      track.style.width = `${days * dayW}px`
      r.appendChild(track)
    }
    months.firstChild.textContent = ''
    daysRow.firstChild.textContent = ''
    flags.firstChild.textContent = 'Deadlines'
    for (let i = 0; i < days; i++) {
      const day = S.addDays(from, i)
      if (i === 0 || day.slice(8) === '01') {
        const m = document.createElement('span')
        m.className = 'tl-month'
        m.style.left = `${i * dayW}px`
        m.textContent = monthName(monthOf(day))
        months.lastChild.appendChild(m)
      }
      const c = document.createElement('span')
      c.className = `tl-day${S.weekday(day) >= 5 ? ' weekend' : ''}${day === d.today ? ' today' : ''}`
      c.style.left = `${i * dayW}px`
      c.style.width = `${dayW}px`
      c.textContent = dayW >= 16 || S.weekday(day) === 0 ? String(+day.slice(8)) : ''
      c.title = shortDay(day)
      daysRow.lastChild.appendChild(c)
    }
    let lane = 0
    for (const p of plans) {
      if (p.due < from || p.due > to) continue
      const f = document.createElement('span')
      f.className = `tl-flag${p.atRisk ? ' risk' : ''}`
      f.style.left = `${x(p.due)}px`
      f.style.top = `${2 + 18 * (lane++ % 2)}px`
      f.textContent = p.name
      f.title = S.deadlineLine(p)
      f.addEventListener('click', () => (p.kind === 'note' ? go(p.id) : p.kind === 'meeting' ? openMeeting(p.id, p.orig) : toggleEditor(p.id)))
      flags.lastChild.appendChild(f)
    }
    head.append(months, daysRow, flags)
    grid.appendChild(head)

    // the lines across every row: the weeks, today, each deadline (at the start of its day: what it
    // needs ends before it)
    const lines = document.createElement('div')
    lines.className = 'tl-lines'
    lines.style.left = `${labelW}px`
    lines.style.width = `${days * dayW}px`
    for (let i = 5; i < days; i += 7) lines.insertAdjacentHTML('beforeend', `<span class="tl-wk" style="left:${i * dayW}px;width:${2 * dayW}px"></span>`)
    lines.insertAdjacentHTML('beforeend', `<span class="tl-now" style="left:${x(d.today)}px;width:${dayW}px" title="Today"></span>`)
    for (const p of plans) {
      if (p.due < from || p.due > to) continue
      lines.insertAdjacentHTML('beforeend', `<span class="tl-dline${p.atRisk ? ' risk' : ''}" style="left:${x(p.due)}px"></span>`)
    }
    grid.appendChild(lines)

    // the meetings, a row each, above the experiments
    const mrows = meetingRows({ from, to, dayW, days, x })
    for (const r of mrows) grid.appendChild(r)

    // the rows, by concept
    const byConcept = new Map()
    for (const n of rows) {
      if (!byConcept.has(n.concept)) byConcept.set(n.concept, [])
      byConcept.get(n.concept).push(n)
    }
    const startOf = n => (winOf.get(n.id) || {}).from || n.start || n.suggestedStart || (planOf.get(n.id) && planOf.get(n.id).item.latestStart) || '9999'
    const order = [...concepts.keys()].filter(c => byConcept.has(c))
    for (const cid of order) {
      const c = concepts.get(cid)
      if (order.length > 1 || cid !== C.ROOT) {
        const g = document.createElement('div')
        g.className = 'tl-row tl-group'
        g.innerHTML = `<div class="tl-label"><span class="swatch" style="background:${C.colourOf(concepts, cid)}"></span>${escH(c ? c.name : cid)}</div><div class="tl-track" style="width:${days * dayW}px"></div>`
        grid.appendChild(g)
      }
      const list = byConcept.get(cid).sort((a, b) => startOf(a).localeCompare(startOf(b)) || a.id.localeCompare(b.id, 'en', { numeric: true }))
      for (const n of list) grid.appendChild(timelineRow(n, winOf.get(n.id), d, { from, to, dayW, days, x }))
    }
    if (!rows.length) {
      const empty = document.createElement('p')
      empty.className = 'tl-empty muted'
      empty.style.left = `${labelW}px`
      if (mrows.length) empty.style.top = `${Math.round((90 + 26 * mrows.length) * font)}px`
      empty.textContent = 'No experiment has dates yet: give one a start and an estimate in its drawer, or a deadline the notes it needs (+ Deadline).'
      grid.appendChild(empty)
    }
    if (tree.gpus) grid.appendChild(gpuRow(d, { from, to, dayW, days, x }))

    calBody.replaceChildren(scroll)
    document.getElementById('cal-range').textContent = `${monthName(monthOf(from))} – ${monthName(monthOf(to))}`
    // the same days in view as before; the first time, today a little in from the left
    if (keep && keep.from === from) { scroll.scrollLeft = keep.left; scroll.scrollTop = keep.top }
    else if (keep) { scroll.scrollLeft = keep.left + S.between(from, keep.from) * dayW; scroll.scrollTop = keep.top }
    else scrollToDay(scroll, d.today)
  }

  /** The meetings on the timeline: a row each (its title, how it comes back), a mark on each day it falls on; under a Meetings heading. */
  function meetingRows(g) {
    const list = meetingsIn(g.from, S.addDays(g.to, 1))
    if (!list.length) return []
    const head = document.createElement('div')
    head.className = 'tl-row tl-group'
    head.innerHTML = `<div class="tl-label">Meetings</div><div class="tl-track" style="width:${g.days * g.dayW}px"></div>`
    const out = [head]
    for (const { meeting: m, occ } of list) {
      const row = document.createElement('div')
      row.className = 'tl-row tl-mtrow'
      row.dataset.meeting = m.id
      const label = document.createElement('div')
      label.className = 'tl-label'
      label.title = `${m.name} · ${S.repeatText(m)}${EMBED ? '' : ' (click to edit)'}`
      label.innerHTML = `<span class="tl-title">${escH(m.title || m.name)}</span><span class="muted tl-mt-rep">${escH(S.repeatText(m))}</span>`
      label.addEventListener('click', () => openMeeting(m.id, null))
      const track = document.createElement('div')
      track.className = 'tl-track'
      track.style.width = `${g.days * g.dayW}px`
      for (const o of occ) {
        const t = document.createElement('span')
        t.className = `tl-mt${o.moved ? ' moved' : ''}${o.skipped ? ' skipped' : ''}${o.plan && o.plan.atRisk ? ' risk' : ''}${calOpen === m.id && calOcc === o.orig ? ' open' : ''}`
        t.style.left = `${g.x(o.day) + 1}px`
        t.style.width = `${Math.max(6, g.dayW - 2)}px`
        t.title = occTitle(m, o)
        t.addEventListener('click', () => openMeeting(m.id, m.every ? o.orig : null))
        track.appendChild(t)
      }
      row.append(label, track)
      out.push(row)
    }
    return out
  }

  function scrollToDay(scroll, day) {
    const from = scroll.dataset.from
    const dayW = Math.round(CAL_ZOOM[calZoom] * font)
    const labelW = tlLabelW()
    scroll.scrollLeft = Math.max(0, S.between(from, day) * dayW - (scroll.clientWidth - labelW) / 4)
  }

  /** One experiment's row: its title, its run, Claude's suggested dates, how late it may start for a deadline, its own due date. */
  function timelineRow(n, w, d, g) {
    const row = document.createElement('div')
    row.className = `tl-row tl-note${n.id === selected ? ' selected' : ''}`
    row.dataset.id = n.id
    const label = document.createElement('div')
    label.className = 'tl-label'
    label.innerHTML = `<span class="tdot ${escH(toneOf(n))}"></span><span class="kb-id">${escH(n.id)}</span><span class="tl-title">${escH(n.title || n.name)}</span>`
    label.title = `${n.name} · ${n.status}${n.gpus > 1 ? ` · ${n.gpus} GPUs` : ''}`
    label.addEventListener('click', () => select(n.id))
    const track = document.createElement('div')
    track.className = 'tl-track'
    track.style.width = `${g.days * g.dayW}px`
    row.append(label, track)
    const place = (el, a, b) => {
      const s = a < g.from ? g.from : a
      const e = b > S.addDays(g.to, 1) ? S.addDays(g.to, 1) : b
      el.style.left = `${g.x(s)}px`
      el.style.width = `${Math.max(g.dayW * S.between(s, e), 4)}px`
    }
    const p = planOf.get(n.id)
    // how late it may run for the nearest deadline that needs it: a dotted frame, when no run is planned
    if (p && p.item.latestStart && !w && n.status !== 'running') {
      const ghost = document.createElement('div')
      ghost.className = 'tl-latest'
      place(ghost, p.item.latestStart, p.item.latestEnd)
      ghost.title = `For ${p.plan.name}: start by ${p.item.latestStart} (${p.item.est}d)${EMBED ? '' : '. Drag it to plan the run.'}`
      ghost.textContent = 'latest'
      if (!EMBED) ghost.addEventListener('pointerdown', ev => startDrag(ev, ghost, n, 'place', p.item.latestStart, p.item.est, g))
      track.appendChild(ghost)
    }
    // Claude's suggestion, dashed
    if (n.suggestedStart || n.suggestedEst) {
      const start = n.suggestedStart || n.start || (p && p.item.latestStart) || d.today
      const s = document.createElement('div')
      s.className = 'tl-suggested'
      place(s, start, S.addDays(start, n.suggestedEst || n.est || 1))
      s.title = `Claude suggests ${[n.suggestedStart ? `starting ${n.suggestedStart}` : '', n.suggestedEst ? `${n.suggestedEst}d` : ''].filter(Boolean).join(', ')}${n.suggestedDatesWhy ? `: ${n.suggestedDatesWhy}` : ''}. Accept or dismiss it in the drawer.`
      s.addEventListener('click', () => select(n.id))
      track.appendChild(s)
    }
    if (w) {
      const bar = document.createElement('div')
      bar.className = `tl-bar tone experiment s-${w.kind === 'planned' ? 'planned' : w.kind}${w.noEnd ? ' noend' : ''}${n.priority ? ` p-${n.priority}` : ''}`
      const end = w.kind === 'running' && w.plannedTo ? w.plannedTo : w.to
      place(bar, w.from, end)
      bar.innerHTML = `<span class="tl-bar-text">${escH(n.id)}</span>`
      const est = w.kind === 'planned' ? n.est : null
      bar.title = `${n.name}: ${w.kind}${w.kind === 'planned' ? `, ${w.from} for ${n.est}d` : ''}${n.started ? `, started ${n.started}` : ''}${n.finished ? `, finished ${n.finished}` : ''}${w.noEnd ? ', no end planned (est:)' : ''}${w.kind === 'planned' && !EMBED ? '. Drag to move it, its right end to change the estimate.' : ''}`
      if (w.kind === 'planned' && !EMBED) {
        bar.classList.add('movable')
        const grip = document.createElement('span')
        grip.className = 'tl-grip'
        grip.title = 'Drag to change the estimate'
        bar.appendChild(grip)
        grip.addEventListener('pointerdown', ev => { ev.stopPropagation(); startDrag(ev, bar, n, 'resize', w.from, est, g) })
        bar.addEventListener('pointerdown', ev => startDrag(ev, bar, n, 'move', w.from, est, g))
      } else bar.addEventListener('click', () => select(n.id))
      track.appendChild(bar)
      // a run over its estimate: the days past it, hatched
      if (w.kind === 'running' && w.over) {
        const over = document.createElement('div')
        over.className = 'tl-over'
        place(over, w.plannedTo, w.to)
        over.title = `${S.between(w.plannedTo, d.today) + 1}d over its ${n.est}d estimate`
        over.addEventListener('click', () => select(n.id))
        track.appendChild(over)
      }
    }
    if (n.due) {
      const due = S.parseDue(n.due)
      if (due && due.day >= g.from && due.day <= g.to) {
        const m = document.createElement('span')
        m.className = 'tl-due'
        m.style.left = `${g.x(due.day)}px`
        m.title = `Due ${S.formatDue(due)}`
        track.appendChild(m)
      }
    }
    return row
  }

  /** The GPUs taken each day from today, against how many there are: a day over is marked. */
  function gpuRow(d, g) {
    const row = document.createElement('div')
    row.className = 'tl-row tl-gpus'
    row.innerHTML = `<div class="tl-label" title="The GPUs the planned and running experiments take each day (an experiment takes one unless its gpus: says more)">GPUs (${tree.gpus})</div>`
    const track = document.createElement('div')
    track.className = 'tl-track'
    track.style.width = `${g.days * g.dayW}px`
    for (const { day, need, notes } of d.gpu.days) {
      if (day > g.to) break
      const b = document.createElement('span')
      b.className = `tl-load${need > tree.gpus ? ' over' : ''}`
      b.style.left = `${g.x(day)}px`
      b.style.width = `${g.dayW}px`
      b.style.height = `${Math.round(100 * Math.min(need, 2 * tree.gpus) / (2 * tree.gpus))}%`
      b.title = `${shortDay(day)}: ${need} of ${tree.gpus} (${notes.map(x => `${x.id} ${x.gpus}`).join(', ')})`
      track.appendChild(b)
    }
    const cap = document.createElement('span')
    cap.className = 'tl-cap'
    track.appendChild(cap)
    row.appendChild(track)
    return row
  }

  /**
   * Dragging a run on the timeline, by whole days: `move` it (a new start), `resize` its end (a new
   * estimate), or `place` the dotted frame of a run not planned yet (its start, with its estimate).
   * A press without a move opens the note.
   */
  function startDrag(ev, el, n, kind, start, est, g) {
    if (ev.button !== 0) return
    ev.preventDefault()
    el.setPointerCapture(ev.pointerId)
    const x0 = ev.clientX
    const left = parseFloat(el.style.left), width = parseFloat(el.style.width)
    calDrag = { id: n.id, moved: false }
    const tip = document.createElement('span')
    tip.className = 'tl-tip'
    let dd = 0
    const onMove = e => {
      const dx = e.clientX - x0
      if (!calDrag.moved && Math.abs(dx) < 4) return
      calDrag.moved = true
      el.classList.add('dragging')
      dd = Math.round(dx / g.dayW)
      if (kind === 'resize') {
        const days = Math.max(1, (est || 1) + dd)
        el.style.width = `${days * g.dayW}px`
        tip.textContent = `${days}d`
      } else {
        el.style.left = `${left + dd * g.dayW}px`
        tip.textContent = shortDay(S.addDays(start, dd))
      }
      if (!tip.parentNode) el.appendChild(tip)
    }
    const onUp = async () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onCancel)
      const moved = calDrag.moved
      calDrag = null
      if (!moved) { select(n.id); drawCalendar(); return }
      if (kind === 'resize') {
        const days = Math.max(1, (est || 1) + dd)
        if (days !== est) await setDates(n.id, { est: `${days}d` }, 'Estimate not set')
      } else if (dd !== 0 || kind === 'place') {
        await setDates(n.id, kind === 'place' && !n.est ? { start: S.addDays(start, dd), est: `${est}d` } : { start: S.addDays(start, dd) }, 'Start not set')
      }
      drawCalendar()
    }
    const onCancel = () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onCancel)
      calDrag = null
      el.style.left = `${left}px`
      el.style.width = `${width}px`
      drawCalendar()
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onCancel)
  }

  // ---------------------------------------------------------------- the month

  function drawMonth(d) {
    const y = +calMonth.slice(0, 4), m = +calMonth.slice(5, 7)
    const weeks = S.monthWeeks(y, m)
    const notes = new Map(tree.nodes.map(n => [n.id, n]))
    const wins = d.wins.filter(w => boardSet.has(w.id))
    const deadlines = new Map() // day → what falls due on it, then the meetings on it
    const at = (day, item) => { if (!deadlines.has(day)) deadlines.set(day, []); deadlines.get(day).push(item) }
    // a meeting that needs notes is drawn as the meeting, red when at risk
    for (const p of plans) if (p.kind !== 'meeting') at(p.due, { plan: p })
    for (const ms of tree.milestones || []) {
      const due = S.parseDue(ms.due)
      if (due && (ms.status === 'suggested' || ms.status === 'done')) at(due.day, { milestone: ms, due })
    }
    const meetings = meetingsIn(weeks[0][0], S.addDays(weeks[weeks.length - 1][6], 1)).flatMap(x => x.occ.map(o => ({ meeting: x.meeting, occ: o })))
    meetings.sort((a, b) => (a.occ.at.time || '').localeCompare(b.occ.at.time || '') || a.meeting.id.localeCompare(b.meeting.id, 'en', { numeric: true }))
    for (const it of meetings) at(it.occ.day, it)
    const box = document.createElement('div')
    box.className = 'mo'
    const headRow = document.createElement('div')
    headRow.className = 'mo-head'
    headRow.innerHTML = WEEKDAYS.map(w => `<span>${w}</span>`).join('')
    box.appendChild(headRow)
    for (const week of weeks) {
      const bars = S.weekBars(week, wins)
      const lanes = bars.reduce((k, b) => Math.max(k, b.lane + 1), 0)
      const row = document.createElement('div')
      row.className = 'mo-week'
      row.style.setProperty('--lanes', lanes)
      for (const day of week) {
        const cell = document.createElement('div')
        cell.className = `mo-day${monthOf(day) !== calMonth ? ' out' : ''}${day === d.today ? ' today' : ''}${S.weekday(day) >= 5 ? ' weekend' : ''}`
        cell.dataset.day = day
        cell.innerHTML = `<span class="mo-num">${+day.slice(8)}</span>`
        const list = document.createElement('div')
        list.className = 'mo-items'
        for (const it of deadlines.get(day) || []) list.appendChild(monthChip(it))
        cell.appendChild(list)
        if (!EMBED) {
          cell.title = `${shortDay(day)}: click to add a deadline or a meeting on this day`
          cell.addEventListener('click', ev => { if (ev.target === cell || ev.target.classList.contains('mo-num') || ev.target === list) dayMenu(cell, day) })
        }
        row.appendChild(cell)
      }
      for (const b of bars) {
        const n = notes.get(b.id)
        const el = document.createElement('div')
        el.className = `mo-bar tone experiment s-${b.kind}${b.cutStart ? ' cut-start' : ''}${b.cutEnd ? ' cut-end' : ''}${b.over ? ' over' : ''}${b.noEnd ? ' noend' : ''}`
        el.style.left = `calc(${b.col} * 100% / 7 + 2px)`
        el.style.width = `calc(${b.span} * 100% / 7 - 4px)`
        el.style.top = `calc(22px * var(--font-scale) + ${b.lane} * 18px * var(--font-scale))`
        el.textContent = n ? `${n.id} ${n.title}` : b.id
        el.title = n ? `${n.name}: ${b.kind}${n.est ? `, ${n.est}d` : ''}${b.over ? ', over its estimate' : ''}${b.noEnd ? ', no end planned' : ''}` : b.id
        el.addEventListener('click', ev => { ev.stopPropagation(); select(b.id) })
        row.appendChild(el)
      }
      box.appendChild(row)
    }
    calBody.replaceChildren(box)
    document.getElementById('cal-range').textContent = monthName(calMonth)
  }

  /** A month's chip: its time (a phone leaves it out, for the name; app.css), then its name. */
  function timedChip(el, time, name) {
    el.textContent = ''
    if (time) {
      const t = document.createElement('span')
      t.className = 'mo-t'
      t.textContent = `${time} `
      el.append(t)
    }
    el.append(name)
  }

  /** A deadline on its day in the month: at risk in red, Claude's suggestion dashed, a done one faded; a meeting, moved ones in italics, skipped ones struck through. */
  function monthChip(it) {
    const el = document.createElement('button')
    el.type = 'button'
    if (it.occ) {
      const { meeting: m, occ: o } = it
      el.className = `mo-dl mo-mt${o.moved ? ' moved' : ''}${o.skipped ? ' skipped' : ''}${o.plan && o.plan.atRisk ? ' risk' : ''}${calOpen === m.id && calOcc === o.orig ? ' open' : ''}`
      timedChip(el, o.at.time ? `${o.at.time}${o.at.zone ? ` ${o.at.zone}` : ''}` : '', m.title || m.name)
      el.title = occTitle(m, o)
      const decks = slidesView && !o.skipped ? slidesView.decksFor(m.id, m.every ? o.orig : '') : []
      if (decks.length) {
        el.insertAdjacentHTML('afterbegin', '<svg class="mo-deck" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="2" width="13" height="9" rx="1.5"/><path d="M8 11v2.5M5 15l3-1.5 3 1.5"/></svg>')
        el.title += ` · slides: ${decks.map(d => d.name).join(', ')}`
      }
      el.addEventListener('click', ev => { ev.stopPropagation(); openMeeting(m.id, m.every ? o.orig : null) })
      return el
    }
    if (it.plan) {
      const p = it.plan
      el.className = `mo-dl${p.atRisk ? ' risk' : ''}`
      timedChip(el, p.at.time ? `${p.at.time}${p.at.zone ? ` ${p.at.zone}` : ''}` : '', p.name)
      el.title = `${S.deadlineLine(p)}${localOf(p.at) ? ` (${localOf(p.at)})` : ''}`
      el.addEventListener('click', ev => { ev.stopPropagation(); if (p.kind === 'note') go(p.id); else { calOpen = p.id; drawCalendar(); calDeadlines.querySelector(`[data-id="${p.id}"]`)?.scrollIntoView({ block: 'nearest' }) } })
    } else {
      const ms = it.milestone
      el.className = `mo-dl ${ms.status}`
      timedChip(el, it.due.time || '', ms.name)
      el.title = ms.status === 'suggested' ? `Claude suggests ${ms.name}${ms.why ? `: ${ms.why}` : ''} (accept or dismiss it above)` : `${ms.name}: done`
      el.addEventListener('click', ev => ev.stopPropagation())
    }
    return el
  }

  /** What to add on a day of the month: a deadline or a meeting. */
  function dayMenu(cell, day) {
    calBody.querySelectorAll('.mo-add').forEach(x => x.remove())
    const menu = document.createElement('span')
    menu.className = 'mo-add'
    const close = () => { menu.remove(); document.removeEventListener('pointerdown', away, true) }
    const away = ev => { if (!menu.contains(ev.target)) close() }
    for (const [label, open] of [['+ Deadline', openDeadlineAdder], ['+ Meeting', openMeetingAdder]]) {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = label
      b.addEventListener('click', ev => { ev.stopPropagation(); close(); open(day) })
      menu.appendChild(b)
    }
    menu.addEventListener('keydown', ev => { if (ev.key === 'Escape') close() })
    cell.appendChild(menu)
    menu.firstChild.focus()
    document.addEventListener('pointerdown', away, true)
  }

  // ---------------------------------------------------------------- the calendar's controls

  document.querySelectorAll('[data-cal-mode]').forEach(b => b.addEventListener('click', () => {
    calMode = b.dataset.calMode
    store.set('calMode', calMode)
    drawCalendar()
  }))
  document.getElementById('cal-prev').addEventListener('click', () => calStep(-1))
  document.getElementById('cal-next').addEventListener('click', () => calStep(1))
  document.getElementById('cal-today').addEventListener('click', () => {
    calMonth = monthOf(todayStr())
    if (calMode === 'month') return drawCalendar()
    const scroll = calBody.querySelector('.tl-scroll')
    if (scroll) scrollToDay(scroll, todayStr())
  })
  function calStep(dir) {
    if (calMode === 'month') {
      const y = +calMonth.slice(0, 4), m = +calMonth.slice(5, 7) + dir
      calMonth = `${m < 1 ? y - 1 : m > 12 ? y + 1 : y}-${String(((m + 11) % 12) + 1).padStart(2, '0')}`
      return drawCalendar()
    }
    const scroll = calBody.querySelector('.tl-scroll')
    if (scroll) scroll.scrollBy({ left: dir * 7 * Math.round(CAL_ZOOM[calZoom] * font), behavior: 'smooth' })
  }
  const zoomBy = step => {
    const scroll = calBody.querySelector('.tl-scroll')
    const labelW = tlLabelW()
    // the day in the middle stays in the middle
    const before = Math.round(CAL_ZOOM[calZoom] * font)
    const mid = scroll ? (scroll.scrollLeft + (scroll.clientWidth - labelW) / 2) / before : 0
    calZoom = Math.max(0, Math.min(CAL_ZOOM.length - 1, calZoom + step))
    store.set('calZoom', calZoom)
    drawCalendar()
    const after = calBody.querySelector('.tl-scroll')
    if (after && scroll) after.scrollLeft = mid * Math.round(CAL_ZOOM[calZoom] * font) - (after.clientWidth - labelW) / 2
  }
  document.getElementById('cal-zoom-in').addEventListener('click', () => zoomBy(1))
  document.getElementById('cal-zoom-out').addEventListener('click', () => zoomBy(-1))
  document.getElementById('cal-ics').addEventListener('click', ev => {
    const text = S.ics({ project: tree.project, nodes: tree.nodes, milestones: tree.milestones || [], meetings: tree.meetings || [], stamp: new Date().toISOString() }).text
    const a = ev.currentTarget
    if (a.href) URL.revokeObjectURL(a.href)
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/calendar' }))
    a.download = `${tree.project}.ics`
  })

  // + Deadline: what, when (a day; a time and its zone, as a call for papers states it), and the
  // notes it needs; the server writes it in milestones/
  function openDeadlineAdder(day) {
    if (EMBED) return
    closeMeetingAdder()
    calAdder.hidden = false
    if (day) document.getElementById('cal-add-day').value = day
    document.getElementById('cal-add-title').focus()
  }
  function closeDeadlineAdder() {
    calAdder.hidden = true
    calAdder.reset()
  }
  document.getElementById('cal-add').addEventListener('click', () => (calAdder.hidden ? openDeadlineAdder(null) : closeDeadlineAdder()))
  document.getElementById('cal-add-cancel').addEventListener('click', closeDeadlineAdder)
  calAdder.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeDeadlineAdder() })
  calAdder.addEventListener('submit', async ev => {
    ev.preventDefault()
    const time = document.getElementById('cal-add-time').value
    const zone = document.getElementById('cal-add-zone').value
    const due = [document.getElementById('cal-add-day').value, time, time || zone ? zone : ''].filter(Boolean).join(' ')
    const needs = document.getElementById('cal-add-needs').value.split(/[\s,]+/).filter(Boolean)
    const ok = await writeMilestone({ title: document.getElementById('cal-add-title').value, due, needs }, 'Deadline not added')
    if (ok) closeDeadlineAdder()
  })
  if (EMBED) document.getElementById('cal-add').hidden = true

  // + Meeting: what, its (first) day and time, how long, how often (a menu worked out from the day)
  // and until when, the notes it needs by its next one; the server writes it in meetings/
  const mtAdder = document.getElementById('cal-mt-adder')
  const mtDay = document.getElementById('cal-mt-day')
  const mtUntil = document.getElementById('cal-mt-until-label')
  let mtPicker = null
  function openMeetingAdder(day) {
    if (EMBED) return
    closeDeadlineAdder()
    mtAdder.hidden = false
    if (day) mtDay.value = day
    mtPicker = repeatPicker(mtDay.value, '', repeats => { mtUntil.hidden = !repeats })
    document.getElementById('cal-mt-repeat').replaceChildren(mtPicker.el)
    mtUntil.hidden = true
    document.getElementById('cal-mt-title').focus()
  }
  function closeMeetingAdder() {
    mtAdder.hidden = true
    mtAdder.reset()
  }
  mtDay.addEventListener('change', () => mtPicker && mtPicker.setDay(mtDay.value))
  document.getElementById('cal-mt-add').addEventListener('click', () => (mtAdder.hidden ? openMeetingAdder(null) : closeMeetingAdder()))
  document.getElementById('cal-mt-cancel').addEventListener('click', closeMeetingAdder)
  mtAdder.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeMeetingAdder() })
  mtAdder.addEventListener('submit', async ev => {
    ev.preventDefault()
    const val = id => document.getElementById(id).value.trim()
    const body = { title: val('cal-mt-title'), when: whenOf(mtDay.value, val('cal-mt-time'), val('cal-mt-zone')) }
    if (val('cal-mt-duration')) body.duration = val('cal-mt-duration')
    const every = mtPicker ? mtPicker.value() : ''
    if (every) body.every = every
    if (every && val('cal-mt-until')) body.until = val('cal-mt-until')
    const needs = idsIn(val('cal-mt-needs'))
    if (needs.length) body.needs = needs
    if (await writeMeeting(body, 'Meeting not added')) closeMeetingAdder()
  })
  if (EMBED) document.getElementById('cal-mt-add').hidden = true

  // ---------------------------------------------------------------- a note's dates, in the drawer

  /**
   * The drawer's dates row: the note's own due date and, for an experiment, its start and estimate,
   * with what was recorded of its run; Claude's suggested dates to accept or dismiss; the deadlines
   * that need it.
   */
  function renderDrawerDates(n) {
    const box = document.getElementById('drawer-dates')
    if (!n) { box.hidden = true; return }
    if (calBusyIn(box)) return
    box.replaceChildren()
    box.hidden = false
    const isExp = n.type === 'experiment'
    const facts = [n.started ? `started ${n.started}` : '', n.finished ? `finished ${n.finished}` : '', n.gpus > 1 ? `${n.gpus} GPUs` : '',
      n.after && n.after.length ? `after ${n.after.join(', ')}` : ''].filter(Boolean)
    if (EMBED) {
      const parts = [n.due ? `due ${n.due}` : '', n.start ? `start ${n.start}` : '', n.est ? `${n.est}d` : '', ...facts].filter(Boolean)
      box.hidden = !parts.length && !n.suggestedStart && !n.suggestedEst
      box.innerHTML = parts.length ? `<span class="muted">Dates</span> ${escH(parts.join(' · '))}` : ''
      if (n.suggestedStart || n.suggestedEst) box.appendChild(datesSuggestion(n))
      return
    }
    const f = document.createElement('form')
    f.className = 'dates-form'
    f.innerHTML = `<span class="muted">Dates</span>
      ${isExp ? `<label title="The day the run starts">Start <input name="start" type="date" value="${escH(n.start || '')}"></label>
      <label title="How long the run takes: 3d, 2w">Est. <input name="est" type="text" size="4" value="${escH(n.est ? `${n.est}d` : '')}" placeholder="3d"></label>` : ''}
      <label title="The note's own deadline: a day, a time, a zone (2026-11-13 23:59 AoE)">Due <input name="due" type="text" size="16" value="${escH(n.due || '')}" placeholder="2026-11-13"></label>
      <button type="submit" hidden>Save</button>`
    const save = f.querySelector('button')
    const changed = () => {
      const out = {}
      const was = { start: n.start || '', est: n.est ? `${n.est}d` : '', due: n.due || '' }
      for (const k of isExp ? ['start', 'est', 'due'] : ['due']) {
        const v = f[k].value.trim()
        if (v !== was[k]) out[k] = v || null
      }
      return out
    }
    f.addEventListener('input', () => { save.hidden = !Object.keys(changed()).length })
    f.addEventListener('submit', async ev => {
      ev.preventDefault()
      const c = changed()
      if (Object.keys(c).length) { document.activeElement && document.activeElement.blur(); await setDates(n.id, c) }
    })
    f.addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.stopPropagation(); document.activeElement.blur(); renderDrawerDates(byId.get(n.id)) } })
    box.appendChild(f)
    if (facts.length) box.insertAdjacentHTML('beforeend', `<span class="dates-facts muted">${escH(facts.join(' · '))}</span>`)
    if (n.suggestedStart || n.suggestedEst) box.appendChild(datesSuggestion(n))
    const p = planOf.get(n.id)
    if (p) {
      const line = document.createElement('div')
      line.className = `dates-needed${p.plan.atRisk ? ' risk' : ''}`
      const i = p.item
      line.textContent = `Needed by ${p.plan.name} (${p.plan.dueText}, ${S.when(p.plan.daysLeft)}): ${i.noEstimate ? 'no estimate yet' : i.noStart ? 'running, no start date' : i.expectedEnd ? `ends by ${i.latestEnd}` : `start by ${i.latestStart}`}${i.slack !== null ? `, ${i.slack}d of slack` : ''}`
      box.appendChild(line)
    }
  }

  /** Claude's suggested start and estimate, and why, for the user to accept or dismiss. */
  function datesSuggestion(n) {
    const box = document.createElement('div')
    box.className = 'suggest'
    const what = [n.suggestedStart ? `start ${n.suggestedStart}` : '', n.suggestedEst ? `${n.suggestedEst}d` : ''].filter(Boolean).join(', ')
    box.innerHTML = `<span>Claude suggests <b>${escH(what)}</b>${n.suggestedDatesWhy ? `: <span class="suggest-why">${escH(n.suggestedDatesWhy)}</span>` : ''}</span>`
    if (EMBED) return box
    const accept = document.createElement('button')
    accept.type = 'button'
    accept.textContent = 'Accept'
    accept.title = `Make it ${n.id}'s ${what}`
    accept.addEventListener('click', () => setDates(n.id, { ...(n.suggestedStart ? { start: n.suggestedStart } : {}), ...(n.suggestedEst ? { est: `${n.suggestedEst}d` } : {}) }, 'Not accepted'))
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.textContent = 'Dismiss'
    dismiss.title = `Drop the suggestion; ${n.id} keeps its dates`
    dismiss.addEventListener('click', () => setDates(n.id, { dismiss: true }, 'Not dismissed'))
    const bar = document.createElement('span')
    bar.className = 'suggest-bar'
    bar.append(accept, dismiss)
    box.appendChild(bar)
    return box
  }

  /** A card's chip for the deadline nearest the note: its own due date, or one that needs it; red when at risk. */
  function dueChip(n) {
    const own = n.due && plans.find(p => p.kind === 'note' && p.id === n.id)
    const p = own || (planOf.get(n.id) && planOf.get(n.id).plan)
    if (!p || !(p.daysLeft >= 0 || p.atRisk)) return null
    const el = document.createElement('span')
    el.className = `kb-due${p.atRisk ? ' risk' : ''}`
    el.textContent = own ? `due ${S.when(p.daysLeft)}` : `${p.id} ${S.when(p.daysLeft)}`
    el.title = S.deadlineLine(p)
    return el
  }

  /** The selected note's row on the timeline. */
  function markRows() {
    if (view !== 'calendar') return
    calBody.querySelectorAll('.tl-note').forEach(r => r.classList.toggle('selected', r.dataset.id === selected))
  }

  /** A note's row on the timeline, scrolled into view and briefly lit. */
  function showRow(id) {
    const r = calBody.querySelector(`.tl-note[data-id="${CSS.escape(id)}"]`)
    if (!r) return
    r.scrollIntoView({ block: 'nearest' })
    r.classList.add('flash')
    setTimeout(() => r.classList.remove('flash'), 1400)
  }

  // ---------------------------------------------------------------- markdown (web/markdown.js)

  const M = window.RftMarkdown
  const escH = M.escH
  function idForLink(target) {
    const t = target.trim()
    for (const n of tree.nodes) if (n.name === t) return n.id
    const id = t.split(' ')[0]
    return byId.has(id) ? id : null
  }
  /** TeX as HTML, by KaTeX; the source as code when KaTeX is missing or gives up. */
  function tex(src, display) {
    try {
      if (window.katex) return window.katex.renderToString(src, { displayMode: display, throwOnError: false, strict: 'ignore' })
    } catch (e) { /* below */ }
    return `<code class="math">${escH(display ? `$$${src}$$` : `$${src}$`)}</code>`
  }
  let mdNote = null // the note markdown() renders: its images are found from its folder
  /** An image of the note shown, as the server serves it; a mention in the standalone page. */
  function image(src, alt, size) {
    const label = alt || src.split('/').pop()
    if (EMBED || !mdNote) return `<em class="missing">(image: ${escH(label)})</em>`
    const key = editKey()
    const url = `api/image?note=${encodeURIComponent(mdNote)}&src=${encodeURIComponent(src)}` +
      (key ? `&token=${encodeURIComponent(key)}` : '')
    const dims = size ? ` width="${size[1]}"` + (size[2] ? ` height="${size[2]}"` : '') : ''
    return `<a class="image" href="${escH(url)}" target="_blank" rel="noopener noreferrer" title="Open at full size">` +
      `<img src="${escH(url)}" alt="${escH(alt)}" data-label="${escH(label)}" loading="lazy"${dims}></a>`
  }
  const md = M.make({ tex, image, link: idForLink })
  let footnotes = [] // the footnotes of the note markdown() rendered last: { label, n, html }
  function markdown(src, noteId) {
    mdNote = noteId || null
    const r = md.render(src)
    footnotes = r.notes
    return r.html
  }

  // ---------------------------------------------------------------- the note's discussion: footnotes, comments, suggestions, lock

  // A selection in the note becomes a range of its text (web/markdown.js maps one to the other),
  // and the bar under it starts a comment, a suggestion or a footnote there. Threads are kept by
  // the server beside the note (api/comment); the open ones are marked in the text, every one is
  // listed under it, the closed ones as history. A footnote is written into the note itself.

  const threadsBox = document.getElementById('threads')
  const selBar = document.getElementById('sel-bar')
  const selMsg = document.getElementById('sel-msg')
  const composer = document.getElementById('composer')
  const composerKind = document.getElementById('composer-kind')
  const composerQuote = document.getElementById('composer-quote')
  const composerRepl = document.getElementById('composer-repl')
  const composerReplLabel = document.getElementById('composer-repl-label')
  const composerText = document.getElementById('composer-text')
  const composerPost = document.getElementById('composer-post')
  const composerAsk = document.getElementById('composer-ask')
  const composerMsg = document.getElementById('composer-msg')
  const fnPop = document.getElementById('fn-pop')
  const lockBtn = document.getElementById('drawer-lock')
  const CONTEXT = 40 // characters kept on each side of a quote, as the server keeps them
  const drafts = new Map() // replies being written, by `${note} ${thread}`, kept across redraws
  const threadErrors = new Map() // what a thread's last action ran into, by `${note} ${thread}`
  const composerDrafts = {} // what was typed in the composer, by kind, until it is posted
  let anchor = null // the selection the bar and the composer act on: { id, start, end, quote, prefix, suffix, version, rect }
  let composing = null // comment | suggestion | footnote, while the composer is open
  let posting = false
  let historyOpen = false
  let shownFor = null // the note the drawer drew last, to keep its scroll position on a redraw
  const mdm = M.make({ tex, image: (src, alt) => `<em class="missing">(image: ${escH(alt || src)})</em>`, link: idForLink })
  const noteOf = r => ({ id: r.id, body: r.body, version: r.version || null, locked: Boolean(r.locked), threads: Array.isArray(r.threads) ? r.threads : [] })
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
  const who = by => (by === 'claude' ? 'Claude' : 'You')
  const STATE = { resolved: 'Resolved', accepted: 'Accepted', rejected: 'Rejected', applied: 'Applied by Claude' }
  const TIP = {
    ask: 'Ask Claude to answer this thread (with your reply, if you wrote one), in the background: the answer comes into the thread',
    accept: 'Write the new text into the note',
    reject: 'Reject the suggestion: it goes to the history',
    resolve: 'Settled: it goes to the history',
  }
  /** Why a suggestion's new text cannot be written into the note, or '' when it can. */
  const cantAccept = t => (t.replacement == null ? 'There is no new text to write yet' : !t.exact ? 'The text changed since the suggestion' : '')
  // the margin cards' buttons, drawn as the drawer's other icons are (.ico)
  const ICON = {
    reply: '<path d="M9.5 14.5L4.5 9.5l5-5"/><path d="M4.5 9.5H14a5.5 5.5 0 0 1 5.5 5.5v4"/>',
    ask: '<path d="M10.5 3c.6 4.4 2.5 6.3 6.9 6.9-4.4.6-6.3 2.5-6.9 6.9-.6-4.4-2.5-6.3-6.9-6.9 4.4-.6 6.3-2.5 6.9-6.9z"/><path d="M18.5 15v5.5M15.75 17.75h5.5"/>',
    accept: '<path d="M4.5 12.5l4.8 4.8L19.5 7"/>',
    reject: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
    resolve: '<circle cx="12" cy="12" r="8.5"/><path d="M8.2 12.4l2.7 2.7 5-5.6"/>',
  }
  const iconBtn = (act, label, tip, cls, off = false) =>
    `<button type="button" class="s-btn ${cls}" data-act="${act}" aria-label="${label}" title="${escH(tip)}"${off ? ' disabled' : ''}><svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICON[act]}</svg></button>`
  /** An open thread's buttons, as icons, on its card in the margin and under the note: reply, ask Claude, then accept and reject a suggestion, or resolve a comment. */
  function threadButtons(t, replyTip) {
    const no = cantAccept(t)
    return iconBtn('reply', 'Reply', replyTip, 'neutral') +
      iconBtn('ask', t.asked ? 'Ask Claude again' : 'Ask Claude', t.asked ? `Again: ${TIP.ask}` : TIP.ask, 'ask') +
      (t.kind === 'suggestion'
        ? iconBtn('accept', 'Accept', no || TIP.accept, 'ok', Boolean(no)) + iconBtn('reject', 'Reject', TIP.reject, 'no')
        : iconBtn('resolve', 'Resolve', TIP.resolve, 'ok'))
  }
  const sameNote = (a, b) => a && b && a.id === b.id && a.body === b.body && a.locked === b.locked && JSON.stringify(a.threads) === JSON.stringify(b.threads)

  /** The note in the drawer, drawn: its text, its open threads marked, its footnotes in the margin, its threads below. */
  function showNote() {
    const top = shownFor === (shown && shown.id) ? drawer.scrollTop : 0
    const typing = shownFor === (shown && shown.id) ? marginFocus() : null
    hideSelBar()
    fnPop.hidden = true
    if (!shown) {
      article.innerHTML = '<p class="missing">The note could not be read.</p>'
      threadsBox.hidden = true
      shownFor = null
      return
    }
    article.innerHTML = markdown(shown.body, shown.id)
    markThreads()
    const layer = document.createElement('div')
    layer.className = 'sidenotes'
    article.append(layer)
    layoutSidenotes()
    renderThreads()
    showLock()
    shownFor = shown.id
    drawer.scrollTop = top
    refocusMargin(typing)
  }

  // ------------------------------------------------ where the page is in the note's text

  const runKind = span => (span.hasAttribute('data-raw') ? 'raw' : span.hasAttribute('data-whole') ? 'whole' : 'text')
  const runCellsOf = span => M.runCells(shown.body.slice(+span.dataset.s, +span.dataset.e), runKind(span))
  const cellsText = cs => cs.map(c => (c.atom ? '\u0000' : c.ch)).join('')
  /** A run's visible pieces in the page, in order: its text nodes, and its atoms as one each. */
  function unitsOf(span) {
    if (span.hasAttribute('data-whole')) return [{ node: span, atom: true, start: 0, len: 1 }]
    const out = []
    let n = 0
    const walk = el => {
      for (const c of el.childNodes) {
        if (c.nodeType === 3) { out.push({ node: c, atom: false, start: n, len: c.length }); n += c.length }
        else if (c.nodeType === 1 && !c.hasAttribute('data-skip')) {
          if (c.hasAttribute('data-atom')) { out.push({ node: c, atom: true, start: n, len: 1 }); n += 1 }
          else walk(c)
        }
      }
    }
    walk(span)
    return out
  }
  const unitsText = us => us.map(u => (u.atom ? '\u0000' : u.node.data)).join('')
  /** How many visible pieces of a run come before the boundary (node, offset) inside it. */
  function visBefore(us, node, offset, isEnd) {
    for (const u of us) {
      if (u.atom && (u.node === node || u.node.contains(node))) return u.start + (isEnd ? 1 : 0)
      if (!u.atom && u.node === node) return u.start + offset
    }
    const p = document.createRange()
    p.setStart(node, offset)
    for (const u of us) {
      const r = document.createRange()
      r.selectNode(u.node)
      if (p.compareBoundaryPoints(Range.START_TO_START, r) <= 0) return u.start
    }
    return us.reduce((n, u) => n + u.len, 0)
  }

  /** The selection in the note as a range of its text, trimmed of space; { error } when the page cannot say. */
  function selectionAnchor() {
    const sel = window.getSelection()
    if (!shown || !sel || sel.isCollapsed || !sel.rangeCount) return null
    return rangeAnchor(sel.getRangeAt(0))
  }
  /** A range of the page as a range of the note's text, as selectionAnchor(). */
  function rangeAnchor(range) {
    if (!shown || !article.contains(range.commonAncestorContainer)) return null
    const spans = [...article.querySelectorAll('.src')].filter(s => range.intersectsNode(s))
    if (!spans.length) return null
    const point = (span, node, offset, isEnd) => {
      const cs = runCellsOf(span), us = unitsOf(span)
      if (unitsText(us) !== cellsText(cs)) return null
      const base = +span.dataset.s
      const vis = span.contains(node) ? visBefore(us, node, offset, isEnd) : isEnd ? cs.length : 0
      return base + M.sourceAt(cs, vis, isEnd, +span.dataset.e - base)
    }
    let start = point(spans[0], range.startContainer, range.startOffset, false)
    let end = point(spans[spans.length - 1], range.endContainer, range.endOffset, true)
    if (start == null || end == null) return { error: 'This part could not be matched to the note\'s text; select the plain text around it.' }
    const body = shown.body
    while (start < end && /\s/.test(body[start])) start++
    while (end > start && /\s/.test(body[end - 1])) end--
    if (end <= start) return null
    const rects = range.getClientRects()
    return {
      id: shown.id, start, end, version: shown.version, quote: body.slice(start, end),
      prefix: body.slice(Math.max(0, start - CONTEXT), start), suffix: body.slice(end, end + CONTEXT),
      rect: rects.length ? rects[rects.length - 1] : range.getBoundingClientRect(),
    }
  }

  /** Wraps each piece of the page the note's text [s, e) stands for in what `make()` makes; the first and last wrap. */
  function markRange(s, e, make) {
    let first = null, last = null
    for (const span of article.querySelectorAll('.src')) {
      const base = +span.dataset.s
      if (+span.dataset.e <= s || base >= e) continue
      const cs = runCellsOf(span), us = unitsOf(span)
      if (unitsText(us) !== cellsText(cs)) continue // no mark rather than a wrong one
      const got = M.cellsIn(cs, s - base, e - base)
      if (!got) continue
      if (span.hasAttribute('data-whole')) {
        const m = make()
        span.classList.add(...m.classList)
        span.dataset.thread = m.dataset.thread
        first = first || span
        last = span
        continue
      }
      for (const u of us) {
        const a = Math.max(got[0], u.start), b = Math.min(got[1], u.start + u.len)
        if (a >= b) continue
        let node = u.node
        if (!u.atom) {
          if (b - u.start < node.length) node.splitText(b - u.start)
          if (a > u.start) node = node.splitText(a - u.start)
        }
        const m = make()
        node.replaceWith(m)
        m.append(node)
        first = first || m
        last = m
      }
    }
    return { first, last }
  }

  function markThreads() {
    for (const t of shown.threads) {
      if (t.state !== 'open' || !t.at) continue
      const cls = `c-mark ${t.kind}${t.exact ? '' : ' moved'}`
      const { last } = markRange(t.at[0], t.at[1], () => {
        const m = document.createElement('mark')
        m.className = cls
        m.dataset.thread = t.id
        m.title = t.kind === 'comment' ? 'A comment: click to read it' : 'A suggestion: click to read it'
        return m
      })
      if (last && t.kind === 'suggestion' && t.exact && t.replacement) {
        const ins = document.createElement('ins')
        ins.className = 'c-ins'
        ins.setAttribute('data-skip', '')
        ins.dataset.thread = t.id
        ins.textContent = t.replacement
        last.after(ins)
      }
    }
  }

  // ------------------------------------------------ the margin: footnotes, and the open threads when there is room

  const TEXT_MIN = 440 // the narrowest text, in px at the A− / A+ scale 1, that leaves room for the margin column
  const MARGIN_GAP = 18
  let wideMargin = false // whether the margin column shows the footnotes' texts and the threads' cards

  /**
   * A card in the margin for an open thread: its kind, a suggestion's new text, its last message,
   * cut short; and, where the note can be written, a box for a short reply and the thread's
   * buttons as icons (reply, ask Claude, then accept and reject a suggestion, or resolve a comment).
   */
  function sideCard(t) {
    const msgs = t.messages || []
    const last = msgs[msgs.length - 1]
    const replies = Math.max(0, msgs.length - 1)
    const kind = t.kind === 'comment' ? 'Comment' : t.replacement == null ? 'Suggestion · in words' : 'Suggestion'
    const err = threadErrors.get(draftKey(t.id))
    const el = document.createElement('div')
    el.className = `side side-t ${t.kind}`
    el.dataset.thread = t.id
    el.title = 'Open the thread'
    let acts = ''
    if (!EMBED) {
      acts = `<div class="s-act" title=""><input type="text" class="s-reply" placeholder="Reply" aria-label="A short reply" title="A short reply: Enter posts it, Esc leaves it">` +
        threadButtons(t, 'Reply (Enter)') + '</div>'
    }
    el.innerHTML = `<div class="s-head"><b>${kind}</b>${replies ? ` · ${replies} ${replies > 1 ? 'replies' : 'reply'}` : ''}${t.exact ? '' : ' · the text changed'}</div>` +
      (t.kind === 'suggestion' && t.replacement != null
        ? `<div class="s-repl">${t.replacement ? escH(clip(t.replacement, 240)) : '<em>(delete the text)</em>'}</div>` : '') +
      (last ? `<div class="s-msg"><span class="s-who">${who(last.by)}:</span> ${mdm.inline(clip(String(last.text || '').replace(/\s+/g, ' ').trim(), 320))}</div>` : '') +
      (t.asked ? '<div class="s-asked">Claude is answering…</div>' : '') +
      (err ? `<div class="s-error">${escH(err)}</div>` : '') + acts
    const box = el.querySelector('.s-reply')
    if (box) box.value = drafts.get(draftKey(t.id)) || ''
    return el
  }

  /** The margin's reply box being typed in, to give it back its focus once the margin is drawn again. */
  function marginFocus() {
    const f = document.activeElement
    if (!f || !f.classList || !f.classList.contains('s-reply') || !article.contains(f)) return null
    return { tid: f.closest('.side-t').dataset.thread, start: f.selectionStart, end: f.selectionEnd }
  }
  function refocusMargin(keep) {
    const box = keep && article.querySelector(`.side-t[data-thread="${CSS.escape(keep.tid)}"] .s-reply`)
    if (!box || document.activeElement === box) return
    box.focus({ preventScroll: true })
    box.setSelectionRange(keep.start, keep.end)
  }

  /**
   * The column right of the note's text. When the drawer leaves the text room enough beside it:
   * each footnote's text, and a card for each open comment or suggestion, level with where it is in
   * the text and below the one above. Else, as on a narrow drawer: each footnote's number, which
   * shows its text on hover, and the threads only under the note.
   */
  function layoutSidenotes() {
    const layer = article.querySelector(':scope > .sidenotes')
    if (!layer || article.hidden) return
    const typing = marginFocus()
    layer.textContent = ''
    const sups = [...article.querySelectorAll('.src sup.fn-ref')]
    const open = shown ? shown.threads.filter(t => t.state === 'open' && t.at) : []
    const width = article.offsetWidth
    const mw = Math.round(Math.min(280 * font, Math.max(190 * font, width * 0.3)))
    wideMargin = width - mw - MARGIN_GAP >= TEXT_MIN * font && (sups.length > 0 || open.length > 0)
    article.classList.toggle('wide', wideMargin)
    article.style.setProperty('--margin-w', `${mw}px`)
    article.style.minHeight = ''
    const box = article.getBoundingClientRect()
    const items = [] // { top, left, el }, in the text's order
    const seen = new Set()
    for (const sup of sups) {
      const r = sup.getBoundingClientRect()
      if (!r.height) continue
      const f = wideMargin && !seen.has(sup.dataset.fn) ? footnotes.find(x => x.label === sup.dataset.fn) : null
      seen.add(sup.dataset.fn)
      let el
      if (f) {
        el = document.createElement('div')
        el.className = 'side side-fn'
        // its continued lines run on, as one paragraph in a column this narrow
        el.innerHTML = `<span class="fn-n">${f.n}</span>${f.html.replace(/<br>/g, ' ')}`
      } else {
        // a footnote's number: on a narrow drawer, and where a note marks one footnote again
        el = document.createElement('button')
        el.type = 'button'
        el.className = 'sidenote'
        el.textContent = sup.textContent
        el.setAttribute('aria-label', `Footnote ${sup.textContent}`)
      }
      el.dataset.fn = sup.dataset.fn
      items.push({ top: r.top - box.top - 2, left: r.left, el })
    }
    if (wideMargin) {
      for (const t of open) {
        const m = article.querySelector(`[data-thread="${CSS.escape(t.id)}"]`)
        const r = m && m.getClientRects()[0]
        if (r) items.push({ top: r.top - box.top - 3, left: r.left, el: sideCard(t) })
      }
    }
    items.sort((a, b) => (Math.abs(a.top - b.top) > 4 ? a.top - b.top : a.left - b.left))
    let below = -Infinity
    for (const it of items) {
      layer.append(it.el)
      const top = Math.max(it.top, below)
      it.el.style.top = `${top}px`
      if (it.el.classList.contains('side-fn')) it.el.classList.toggle('clipped', it.el.scrollHeight > it.el.clientHeight + 1)
      below = top + it.el.offsetHeight + (wideMargin ? 8 : 3)
    }
    // the column may run on below the text: the threads under it stay clear of it
    if (wideMargin && below > 0) article.style.minHeight = `${Math.ceil(below)}px`
    refocusMargin(typing)
  }
  let layoutQueued = false
  new ResizeObserver(() => {
    if (layoutQueued) return
    layoutQueued = true
    requestAnimationFrame(() => { layoutQueued = false; layoutSidenotes() })
  }).observe(article)

  let popTimer = 0
  let popFor = null
  function showFootnote(el) {
    const f = footnotes.find(x => x.label === el.dataset.fn)
    if (!f) return
    clearTimeout(popTimer)
    popFor = el
    fnPop.innerHTML = `<span class="fn-n">${f.n}</span>${f.html}`
    fnPop.hidden = false
    const r = el.getBoundingClientRect(), d = drawer.getBoundingClientRect()
    fnPop.style.top = `${r.bottom - d.top + drawer.scrollTop + 4}px`
    const w = fnPop.offsetWidth
    fnPop.style.left = `${Math.min(Math.max(8, r.right - d.left - w), drawer.clientWidth - w - 8)}px`
  }
  const hideFootnote = (wait = 200) => {
    clearTimeout(popTimer)
    popTimer = setTimeout(() => { fnPop.hidden = true; popFor = null }, wait)
  }
  const FN = '.sidenote, .side-fn, #note sup.fn-ref'
  /** A footnote pointed at: its mark and its text in the margin lit together; its text in a pop-up when the margin does not show it whole. */
  function pointFootnote(el) {
    const label = el.dataset.fn
    const side = wideMargin ? article.querySelector(`.side-fn[data-fn="${CSS.escape(label)}"]`) : null
    if (side) {
      for (const x of article.querySelectorAll('[data-fn]')) x.classList.toggle('active', x.dataset.fn === label)
      if (!side.classList.contains('clipped')) return
    }
    showFootnote(el)
  }
  drawer.addEventListener('mouseover', ev => { const el = ev.target.closest(FN); if (el) pointFootnote(el) })
  drawer.addEventListener('mouseout', ev => {
    const el = ev.target.closest(FN)
    if (!el || (ev.relatedTarget && el.contains(ev.relatedTarget))) return
    for (const x of article.querySelectorAll('[data-fn].active')) x.classList.remove('active')
    hideFootnote()
  })
  fnPop.addEventListener('mouseenter', () => clearTimeout(popTimer))
  fnPop.addEventListener('mouseleave', () => hideFootnote())
  fnPop.addEventListener('click', ev => {
    const a = ev.target.closest('a[data-go]')
    if (a) { ev.preventDefault(); fnPop.hidden = true; go(a.dataset.go) }
  })

  // ------------------------------------------------ the bar under a selection, and the composer

  function place(el, rect) {
    const d = drawer.getBoundingClientRect()
    el.style.top = `${rect.bottom - d.top + drawer.scrollTop + 6}px`
    const w = el.offsetWidth
    el.style.left = `${Math.min(Math.max(8, rect.left - d.left), Math.max(8, drawer.clientWidth - w - 8))}px`
  }

  function hideSelBar() {
    selBar.hidden = true
  }

  function onSelectionEnd() {
    if (EMBED || editing || composing || drawer.hidden) return
    const a = selectionAnchor()
    if (!a) { hideSelBar(); return }
    if (highlighting) {
      if (a.error) showSelMsg(a.error)
      else applyHighlight(a)
      return
    }
    selMsg.textContent = a.error || ''
    for (const b of selBar.querySelectorAll('button')) b.hidden = Boolean(a.error)
    if (!a.error) anchor = a
    selBar.hidden = false
    const sel = window.getSelection()
    const rects = sel.rangeCount ? sel.getRangeAt(0).getClientRects() : []
    place(selBar, a.rect || rects[rects.length - 1])
  }
  article.addEventListener('mouseup', () => setTimeout(onSelectionEnd, 0))
  // a selection made with the keyboard: in the highlighter, once Shift is let go
  article.addEventListener('keyup', ev => { if (highlighting ? ev.key === 'Shift' : ev.shiftKey) onSelectionEnd() })
  let pressingBar = false
  let selTimer = 0
  document.addEventListener('selectionchange', () => {
    const s = window.getSelection()
    if (!s || s.isCollapsed) { if (!pressingBar) hideSelBar(); return }
    // a touch screen: a long press selects, its handles adjust it, and no mouseup ends it
    if (touchScreen.matches && article.contains(s.anchorNode)) {
      clearTimeout(selTimer)
      selTimer = setTimeout(onSelectionEnd, 450)
    }
  })
  // a press on the bar keeps the selection (a mouse), or the bar (a finger, whose tap clears the selection first)
  selBar.addEventListener('mousedown', ev => ev.preventDefault())
  selBar.addEventListener('pointerdown', () => { pressingBar = true; setTimeout(() => { pressingBar = false }, 800) }, true)
  selBar.addEventListener('click', ev => {
    const b = ev.target.closest('button[data-compose]')
    if (b) openComposer(b.dataset.compose)
  })

  /** Writes the note's text, its frontmatter kept as it is; refused when the note changed since `version`. */
  async function putBody(id, body, version) {
    try {
      const res = await fetch(`api/note?id=${encodeURIComponent(id)}`, {
        method: 'PUT',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-RFT-Token': editKey() },
        body: JSON.stringify({ body, version }),
      })
      const reply = await res.json().catch(() => ({}))
      return res.ok ? { ok: true } : { ok: false, status: res.status, error: reply.error || `the server answered ${res.status}` }
    } catch (e) {
      return { ok: false, status: 0, error: 'the server is not answering' }
    }
  }

  // ------------------------------------------------ the highlighter: ==text== in the note itself

  // A mode of the drawer, like a pen (the marker left of Add child): while it is on, a selection in
  // the note is highlighted as soon as it is made, or, when it holds a highlight already, that is
  // taken out, and so is a highlight clicked. Comment, Suggest and Footnote wait until it is off.
  const hlBtn = document.getElementById('drawer-hl')
  const hlHint = document.getElementById('hl-hint')
  let highlighting = false
  let hlBusy = false
  const pageRuns = () => [...article.querySelectorAll('.src')].map(span => ({ s: +span.dataset.s, e: +span.dataset.e, kind: runKind(span) }))

  function setHighlighting(on) {
    highlighting = on
    hlBtn.setAttribute('aria-pressed', String(on))
    drawer.classList.toggle('highlighting', on)
    hlHint.hidden = !on || hlBtn.hidden
    if (on) { closeComposer(); hideSelBar() }
  }
  hlBtn.addEventListener('click', () => {
    if (!highlighting && !editKey()) { noKey.hidden = false; return }
    setHighlighting(!highlighting)
  })
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Escape' || !highlighting || editing || composing) return
    if (ev.target.closest && ev.target.closest('input, textarea, select')) return
    setHighlighting(false)
  })

  /** The bar under the selection with a message only. */
  function showSelMsg(text, rect) {
    selMsg.textContent = text
    for (const b of selBar.querySelectorAll('button')) b.hidden = true
    const sel = window.getSelection()
    const rects = sel && sel.rangeCount ? sel.getRangeAt(0).getClientRects() : []
    const at = rect || rects[rects.length - 1]
    if (!at) return
    selBar.hidden = false
    place(selBar, at)
  }

  /** Highlights the note's text `a` (as rangeAnchor gives it), or takes out the highlights it holds or cuts into. */
  async function applyHighlight(a) {
    if (hlBusy || !shown || shown.id !== a.id) return
    const hl = M.highlightEdit(shown.body, pageRuns(), a.start, a.end)
    if (!hl) { showSelMsg('This takes no highlight: code, a formula block, or text that starts or ends with =.', a.rect); return }
    hlBusy = true
    const r = await putBody(a.id, hl.text, a.version)
    hlBusy = false
    if (!r.ok) {
      showSelMsg(r.status === 409 ? 'Not changed: the note changed meanwhile (Claude or another editor); select the text again.' : `Not changed: ${r.error}.`, a.rect)
      return
    }
    hideSelBar()
    const sel = window.getSelection()
    if (sel) sel.removeAllRanges()
    await select(a.id)
  }

  function setComposerMsg(text, isError = false) {
    composerMsg.textContent = text
    composerMsg.classList.toggle('error', isError)
  }

  function openComposer(kind) {
    if (!anchor) return
    if (!editKey()) { noKey.hidden = false; hideSelBar(); return }
    composing = kind
    composer.dataset.kind = kind
    composerKind.textContent = kind === 'comment' ? 'Comment' : kind === 'suggestion' ? 'Suggestion' : 'Footnote'
    composerQuote.textContent = clip(anchor.quote, 400)
    composerRepl.hidden = composerReplLabel.hidden = kind !== 'suggestion'
    composerRepl.value = kind === 'suggestion' ? anchor.quote : ''
    composerText.value = composerDrafts[kind] || ''
    composerText.placeholder = kind === 'comment' ? 'Your comment'
      : kind === 'suggestion' ? 'Why; or, with the text above left as it is, what should change (Claude writes it when you ask)'
        : 'The footnote, shown in the margin'
    composerAsk.hidden = kind === 'footnote'
    composerAsk.textContent = kind === 'suggestion' ? 'Post and suggest' : 'Post and ask Claude'
    composerAsk.title = kind === 'suggestion'
      ? 'Post it and ask Claude to write the new text, in the background, for you to accept'
      : 'Post it and ask Claude to answer it, in the background: the answer comes into the thread'
    composerPost.textContent = kind === 'footnote' ? 'Add footnote' : 'Post'
    setComposerMsg('')
    hideSelBar()
    composer.hidden = false
    place(composer, anchor.rect)
    composer.style.left = ''
    ;(kind === 'suggestion' ? composerRepl : composerText).focus()
  }

  function closeComposer() {
    composer.hidden = true
    composing = null
    anchor = null
  }

  /** Sends one change of the discussion; the answer, refused or not, is the note as it now is, drawn. */
  async function send(payload) {
    try {
      const res = await fetch('api/comment', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-RFT-Token': editKey() },
        body: JSON.stringify(payload),
      })
      const reply = await res.json().catch(() => ({}))
      if (reply && typeof reply.body === 'string' && selected === payload.id && !editing) {
        shown = noteOf(reply)
        showNote()
      }
      return res.ok ? { ok: true, note: reply } : { ok: false, error: reply.error || `the server answered ${res.status}` }
    } catch (e) {
      return { ok: false, error: 'the server is not answering' }
    }
  }

  async function post(andAsk) {
    if (!composing || !anchor || posting) return
    const kind = composing, a = anchor
    const text = composerText.value.trim()
    posting = true
    try {
      if (kind === 'footnote') {
        if (!text) { setComposerMsg('Write the footnote.', true); return }
        if (!shown || shown.id !== a.id || shown.version !== a.version) { composerDrafts[kind] = text; setComposerMsg('The note changed meanwhile: select the text again.', true); return }
        setComposerMsg('Adding…')
        const r = await putBody(a.id, M.withFootnote(shown.body, a.end, text).text, a.version)
        if (!r.ok) {
          composerDrafts[kind] = text
          setComposerMsg(r.status === 409 ? 'Not added: the note changed meanwhile (Claude or another editor); select the text again.' : `Not added: ${r.error}.`, true)
          return
        }
        delete composerDrafts[kind]
        closeComposer()
        await select(a.id)
        return
      }
      const payload = { id: a.id, action: 'new', kind, quote: a.quote, prefix: a.prefix, suffix: a.suffix, text }
      if (kind === 'suggestion') payload.replacement = composerRepl.value
      if (kind === 'comment' && !text) { setComposerMsg('Write the comment.', true); return }
      if (kind === 'suggestion' && composerRepl.value === a.quote && !text) { setComposerMsg('Change the text, or say what should change.', true); return }
      setComposerMsg('Posting…')
      const r = await send(payload)
      if (!r.ok) { composerDrafts[kind] = text; setComposerMsg(`Not posted: ${r.error}.`, true); return }
      delete composerDrafts[kind]
      closeComposer()
      const made = r.note.threads[r.note.threads.length - 1]
      if (made && andAsk) await act(a.id, made.id, 'ask')
      if (made) focusThread(made.id)
    } catch (e) {
      setComposerMsg('Not posted: the server is not answering.', true)
    } finally {
      posting = false
    }
  }

  composer.addEventListener('submit', ev => { ev.preventDefault(); post(false) })
  composerAsk.addEventListener('click', () => post(true))
  document.getElementById('composer-cancel').addEventListener('click', () => {
    if (composing) composerDrafts[composing] = composerText.value.trim()
    closeComposer()
  })
  composer.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') { ev.preventDefault(); if (composing) composerDrafts[composing] = composerText.value.trim(); closeComposer() }
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); post(false) }
  })

  // ------------------------------------------------ the threads under the note

  const draftKey = tid => `${shown ? shown.id : ''} ${tid}`

  function card(t) {
    const isOpen = t.state === 'open'
    const can = !EMBED
    const kind = t.kind === 'comment' ? 'Comment' : t.replacement == null ? 'Suggestion · in words' : 'Suggestion'
    const state = isOpen ? (t.at ? (t.exact ? '' : 'the text changed') : 'the text is gone')
      : `${STATE[t.state] || t.state}${t.closed && t.state !== 'applied' ? ` · ${escH(t.closed.at)}` : t.closed ? ` · ${escH(t.closed.at)}` : ''}`
    const change = t.kind !== 'suggestion' ? ''
      : t.replacement == null
        ? `<div class="t-note muted">No new text yet${isOpen ? ': Ask Claude to write it, or reply' : ''}.</div>`
        : `<div class="t-change"><div class="muted">Replace with</div><div class="t-repl">${t.replacement ? escH(clip(t.replacement, 1200)) : '<em class="muted">(nothing: delete the text)</em>'}</div></div>`
    const where = !isOpen ? ''
      : !t.at ? `<div class="t-warn">The text this ${t.kind} is on is no longer in the note.</div>`
        : !t.exact ? `<div class="t-warn">The text changed since; that part now reads: <q>${escH(clip(shown.body.slice(t.at[0], t.at[1]), 240))}</q></div>` : ''
    const msgs = (t.messages || []).map(m =>
      `<li class="by-${m.by === 'claude' ? 'claude' : 'you'}"><div class="t-who">${who(m.by)} <time>${escH(m.at || '')}</time></div><div class="t-text">${mdm.render(m.text || '').html}</div></li>`).join('')
    const asked = isOpen && t.asked ? `<div class="t-asked">Claude is answering… <span class="muted">(asked ${escH(String(t.asked).slice(11) || t.asked)})</span></div>` : ''
    const err = threadErrors.get(draftKey(t.id))
    let bar = ''
    if (can && isOpen) {
      bar = `<textarea rows="2" placeholder="Reply" aria-label="Reply"></textarea>
        <div class="t-bar">${threadButtons(t, 'Reply (Ctrl+Enter)')}</div>`
    } else if (can) bar = '<div class="t-bar"><button type="button" data-act="reopen">Reopen</button></div>'
    return `<div class="thread ${t.kind} ${escH(t.state)}" data-thread="${escH(t.id)}">
      <div class="t-head"><span><span class="t-kind">${kind}</span> <span class="muted">${state}</span></span>${isOpen && t.at ? '<button type="button" class="linkish" data-act="show" title="Show it in the text">show</button>' : ''}</div>
      <blockquote class="t-quote">${escH(clip(t.quote || '', 300))}</blockquote>${change}${where}
      ${msgs ? `<ol class="t-msgs">${msgs}</ol>` : ''}${asked}${err ? `<div class="t-error">${escH(err)}</div>` : ''}${bar}
    </div>`
  }

  function renderThreads() {
    const ts = shown ? shown.threads : []
    threadsBox.hidden = !ts.length || editing != null
    if (!ts.length) { threadsBox.innerHTML = ''; return }
    const focused = document.activeElement && threadsBox.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA'
      ? { tid: document.activeElement.closest('.thread').dataset.thread, at: document.activeElement.selectionStart } : null
    const open = ts.filter(t => t.state === 'open').sort((a, b) => (a.at ? a.at[0] : Infinity) - (b.at ? b.at[0] : Infinity))
    const closed = ts.filter(t => t.state !== 'open').reverse()
    threadsBox.innerHTML = `<div class="threads-head"><b>Discussion</b> <span class="muted">${open.length} open${closed.length ? `, ${closed.length} closed` : ''}</span></div>` +
      open.map(card).join('') +
      (closed.length ? `<details class="history"${historyOpen ? ' open' : ''}><summary>History (${closed.length})</summary>${closed.map(card).join('')}</details>` : '')
    for (const box of threadsBox.querySelectorAll('.thread textarea')) {
      box.value = drafts.get(draftKey(box.closest('.thread').dataset.thread)) || ''
    }
    if (focused) {
      const box = threadsBox.querySelector(`.thread[data-thread="${CSS.escape(focused.tid)}"] textarea`)
      if (box) { box.focus(); box.setSelectionRange(focused.at, focused.at) }
    }
  }

  function focusThread(tid) {
    const el = threadsBox.querySelector(`.thread[data-thread="${CSS.escape(tid)}"]`)
    if (!el) return
    const d = el.closest('details')
    if (d) { d.open = true; historyOpen = true }
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    el.classList.remove('flash')
    void el.offsetWidth
    el.classList.add('flash')
  }

  function showMark(tid) {
    const m = article.querySelector(`[data-thread="${CSS.escape(tid)}"]`)
    if (!m) return
    m.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setActive(tid)
    setTimeout(() => setActive(null), 1500)
  }

  function setActive(tid) {
    for (const m of article.querySelectorAll('[data-thread]')) m.classList.toggle('active', m.dataset.thread === tid)
  }

  async function act(id, tid, action, extra = {}) {
    threadErrors.delete(`${id} ${tid}`)
    const r = await send({ id, thread: tid, action, ...extra })
    if (!r.ok) {
      threadErrors.set(`${id} ${tid}`, `Not done: ${r.error}.`)
      if (shown && shown.id === id) { renderThreads(); layoutSidenotes() }
    }
    return r
  }

  /**
   * A thread's button, under the note or on its card in the margin: Reply and Ask post the reply
   * written in `box` first, when there is one. The draft goes before the request, so the redraw
   * that follows a posted reply does not write it back, and returns when the reply is refused.
   */
  async function threadAction(tid, what, box, b) {
    if (what === 'show') { showMark(tid); return }
    if (!editKey()) { noKey.hidden = false; return }
    const id = shown.id
    const text = box ? box.value.trim() : ''
    if (what === 'reply' && !text) { if (box) box.focus(); return }
    // no native confirm (the desktop's browser pane refuses dialogs): a second press within a few seconds
    if (what === 'accept' && !pressedTwice(b, 'Write it?')) return
    b.disabled = true
    if ((what === 'reply' || what === 'ask') && text) {
      const key = `${id} ${tid}`
      const draft = drafts.get(key)
      drafts.delete(key)
      const r = await act(id, tid, 'reply', { text })
      if (!r.ok) {
        if (draft != null) { drafts.set(key, draft); if (shown && shown.id === id) { renderThreads(); layoutSidenotes() } }
        return
      }
    }
    if (what !== 'reply') await act(id, tid, what)
  }

  /** A reply being written, in the box under the note or on the card in the margin: the other box shows it too. */
  function setDraft(tid, value, from) {
    drafts.set(draftKey(tid), value)
    const q = CSS.escape(tid)
    for (const box of [threadsBox.querySelector(`.thread[data-thread="${q}"] textarea`), article.querySelector(`.side-t[data-thread="${q}"] .s-reply`)]) {
      if (box && box !== from) box.value = value
    }
  }

  threadsBox.addEventListener('click', ev => {
    const link = ev.target.closest('a[data-go]')
    if (link) { ev.preventDefault(); go(link.dataset.go); return }
    const b = ev.target.closest('button[data-act]')
    if (!b || !shown) return
    const t = b.closest('.thread')
    threadAction(t.dataset.thread, b.dataset.act, t.querySelector('textarea'), b)
  })
  threadsBox.addEventListener('input', ev => {
    if (ev.target.tagName === 'TEXTAREA') setDraft(ev.target.closest('.thread').dataset.thread, ev.target.value, ev.target)
  })
  threadsBox.addEventListener('keydown', ev => {
    if (ev.target.tagName !== 'TEXTAREA' || ev.key !== 'Enter' || !(ev.ctrlKey || ev.metaKey)) return
    ev.preventDefault()
    ev.target.closest('.thread').querySelector('button[data-act="reply"]').click()
  })
  threadsBox.addEventListener('toggle', ev => { if (ev.target.matches('details.history')) historyOpen = ev.target.open }, true)
  threadsBox.addEventListener('mouseover', ev => { const c = ev.target.closest('.thread'); setActive(c ? c.dataset.thread : null) })
  threadsBox.addEventListener('mouseleave', () => setActive(null))
  // a thread's mark in the text and its card in the margin light up together
  let hovered = null
  article.addEventListener('mouseover', ev => {
    const m = ev.target.closest('[data-thread]')
    const tid = m ? m.dataset.thread : null
    if (tid !== hovered) { hovered = tid; setActive(tid) }
  })
  article.addEventListener('mouseleave', () => { if (hovered) { hovered = null; setActive(null) } })
  // the short reply on a card in the margin: Enter posts it, Esc leaves the box with the draft kept
  const isMarginReply = el => Boolean(el.classList && el.classList.contains('s-reply'))
  article.addEventListener('input', ev => {
    if (isMarginReply(ev.target)) setDraft(ev.target.closest('.side-t').dataset.thread, ev.target.value, ev.target)
  })
  article.addEventListener('keydown', ev => {
    if (!isMarginReply(ev.target)) return
    if (ev.key === 'Enter' && !ev.isComposing) { ev.preventDefault(); ev.target.closest('.side-t').querySelector('button[data-act="reply"]').click() }
    else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); ev.target.blur() }
  })
  article.addEventListener('click', ev => {
    if (ev.target.closest('a[data-go]')) return
    // a card's buttons in the margin act on its thread; a click in its reply box only types there
    const sb = ev.target.closest('.side-t button[data-act]')
    if (sb) {
      const c = sb.closest('.side-t')
      if (shown) threadAction(c.dataset.thread, sb.dataset.act, c.querySelector('.s-reply'), sb)
      return
    }
    if (ev.target.closest('.side-t .s-act')) return
    const hlMark = highlighting && ev.target.closest('.src mark.hl')
    if (hlMark) {
      const sel = window.getSelection()
      if (sel && !sel.isCollapsed) return // a selection: it is highlighted, or not, once made
      const range = document.createRange()
      range.selectNodeContents(hlMark)
      const a = rangeAnchor(range)
      if (a && !a.error) applyHighlight(a)
      return
    }
    const fn = ev.target.closest('.sidenote, sup.fn-ref')
    // a touch has no hover: a tap on a footnote's mark shows it
    if (fn) { if (popFor === fn && !fnPop.hidden) hideFootnote(0); else showFootnote(fn); return }
    const m = ev.target.closest('[data-thread]')
    const sel = window.getSelection()
    if (m && (!sel || sel.isCollapsed)) focusThread(m.dataset.thread)
  })

  // ------------------------------------------------ the lock

  function showLock() {
    lockBtn.hidden = Boolean(EMBED) || editing != null || !shown || shown.id !== selected
    const on = Boolean(shown && shown.locked)
    lockBtn.setAttribute('aria-pressed', String(on))
    lockBtn.querySelector('.lock-open').classList.toggle('on', !on)
    lockBtn.querySelector('.lock-closed').classList.toggle('on', on)
    const label = on ? 'Locked: Claude only suggests changes to this note, and you accept them. Click to unlock.'
      : 'Lock the note: Claude then only suggests changes to it, and you accept them'
    lockBtn.title = label
    lockBtn.setAttribute('aria-label', on ? 'Unlock' : 'Lock')
  }

  lockBtn.addEventListener('click', async () => {
    if (!shown) return
    if (!editKey()) { noKey.hidden = false; return }
    const id = shown.id, locked = !shown.locked
    lockBtn.disabled = true
    try {
      const res = await fetch('api/lock', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-RFT-Token': editKey() },
        body: JSON.stringify({ id, locked }),
      })
      const reply = await res.json().catch(() => ({}))
      if (res.ok && selected === id && !editing) { shown = noteOf(reply); showNote() }
      else if (!res.ok) notify(`Not ${locked ? 'locked' : 'unlocked'}: ${reply.error || `the server answered ${res.status}`}.`)
    } catch (e) {
      notify('The server is not answering.')
    } finally {
      lockBtn.disabled = false
    }
  })

  // ---------------------------------------------------------------- start

  // the first view: the one kept from last time, else the whole tree when it is still readable,
  // else the root at the top at a readable scale (Fit shows everything)
  function initialView(tries = 0) {
    const w = svg.node().clientWidth, h = svg.node().clientHeight
    const box = gNodes.node().getBBox()
    if ((!w || !h || !box.width) && tries < 20) { requestAnimationFrame(() => initialView(tries + 1)); return }
    // another page shows first: the tree gets its first view once it shows
    needsInitialView = !w || !h
    if (needsInitialView) return
    if (new URLSearchParams(location.search).has('fit')) { fit(false); return }
    const v = store.get('view', null)
    if (v && Number.isFinite(v.k) && Number.isFinite(v.x) && Number.isFinite(v.y)) {
      svg.call(zoom.transform, d3.zoomIdentity.translate(v.x, v.y).scale(v.k))
      return
    }
    const s = 0.9 * Math.min(w / (box.width + 80), h / (box.height + 80))
    if (s >= 0.6) { fit(false); return }
    const root = positions.get(tree.roots[0])
    const k0 = 0.8
    const [rx, ry] = root ? root.p : [0, 0]
    const t = layoutKind === 'lr'
      ? d3.zoomIdentity.translate(60 - rx * k0, h / 2 - ry * k0).scale(k0)
      : layoutKind === 'radial'
        ? d3.zoomIdentity.translate(w / 2 - rx * k0, h / 2 - ry * k0).scale(k0)
        : d3.zoomIdentity.translate(w / 2 - rx * k0, 50 - ry * k0).scale(k0)
    svg.call(zoom.transform, t)
  }

  function first() {
    if (TOKEN) store.set('key', TOKEN)
    // the scratchpad lives on the server: the standalone page has none, and a server started
    // before it existed serves neither its script nor api/scratchpad
    if (!EMBED && window.RftScratchpad) window.RftScratchpad.mount({ key: editKey, store, every: POLL_MS })
    // the inbox too (the standalone page leaves its script out)
    if (!EMBED && window.RftInbox) window.RftInbox.mount({ key: editKey, store, every: POLL_MS })
    // the experiment queue's monitor: only on the server too (the standalone page leaves its script out)
    if (!EMBED && window.RftQueue) {
      window.RftQueue.mount({
        key: editKey, store,
        open: id => { if (byId.has(id)) select(id) },
        title: id => (byId.get(id) || {}).title || '',
      })
    }
    // the manuscript's tab: only on the server (the standalone page leaves its script out)
    if (!EMBED && window.RftManuscript) {
      manuscriptView = window.RftManuscript.mount({
        key: editKey, store, notify,
        open: id => { if (byId.has(id)) select(id) },
        nodes: () => byId,
        visible: () => view === 'manuscript',
        changed: () => { if (selected && byId.has(selected)) renderWritten(byId.get(selected)) },
      })
    } else {
      document.getElementById('show-manuscript').hidden = true
      if (view === 'manuscript') view = 'tree'
    }
    // the slide decks' tab: only on the server too; the Calendar asks it which decks an occurrence has
    if (!EMBED && window.RftDecks) {
      slidesView = window.RftDecks.mount({
        key: editKey, store, notify,
        open: id => { if (byId.has(id)) select(id) },
        nodes: () => byId,
        visible: () => view === 'slides',
        wanted: () => view === 'slides' || view === 'calendar',
        meetings: () => tree.meetings || [],
        milestones: () => tree.milestones || [],
        changed: () => { if (view === 'calendar' && !calSection.contains(document.activeElement)) drawCalendar() },
      })
    } else {
      document.getElementById('show-slides').hidden = true
      if (view === 'slides') view = 'tree'
    }
    render(false)
    hasView = true
    requestAnimationFrame(() => initialView())
    setView(view)
    if (selected && byId.has(selected)) select(selected)
    if (pendingArtifact && concepts.has(pendingArtifact)) openArtifact(pendingArtifact)
    pendingArtifact = null
  }

  const live = document.getElementById('live')

  /** Reads the tree from the server, and redraws when it changed. */
  async function poll() {
    try {
      const res = await fetch('api/tree', { cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      const next = await res.json()
      live.className = 'live on'
      live.title = 'Live: follows the vault'
      if (!tree || next.version !== tree.version) {
        setTree(next)
        if (!hasView) first()
        else { render(true); if (view === 'concepts') drawConceptTree(); drawKanban(); drawCalendar() }
        if (selected && byId.has(selected)) select(selected)
        if (artifactShown) renderArtifact()
      }
    } catch (e) {
      live.className = 'live off'
      live.title = 'The server is not answering (session ended or /rft stop?)'
    }
  }

  if (EMBED) {
    live.hidden = true
    setTree(EMBED.tree)
    first()
  } else {
    poll()
    setInterval(poll, POLL_MS)
  }
})()
