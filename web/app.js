// The rft web view: the reasoning tree as a tidy tree on an infinite canvas (d3), with notes in
// a side drawer. It runs in two ways: served by server/rft_server.py, where it polls
// `api/tree`, reads notes from `api/note` and writes a note's edited text back to it, asks
// `api/node` for a new note under the one shown and `api/type` to change its type, and keeps a
// note's discussion (comments, suggestions) with `api/comment`, its lock with `api/lock` and its
// priority (the user's alone; also the answer to Claude's suggested one) with `api/priority`; or
// inlined into a standalone tree.html by /rft-view, where `window.RFT_DATA` holds the tree,
// every note's text and its threads, and nothing is edited.
(function () {
  'use strict'

  const STATUSES = ['done', 'running', 'planned', 'idea', 'dropped', 'discussed', 'moved']
  const MARK = { done: '✓', running: '…', planned: '→', idea: '?', dropped: '✗', discussed: '·', moved: '↗' }
  const LABEL = { done: 'done', running: 'running', planned: 'planned', idea: 'idea', dropped: 'dropped', discussed: 'discussed, not pursued', moved: 'moved' }
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
  let editing = null // while a note's text is edited: { id, version, lead, text (as opened), newer (on a conflict) }
  let saving = false
  let adding = false
  let moving = false
  let showOrigins = false
  let retyping = false
  const K = window.RftKanban
  const PAGES = ['tree', 'concepts', 'kanban', 'calendar']
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
      buildLegend()
      setLegendOpen(store.get('legendOpen', true))
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
    mark.append('path').attr('class', 'dot')
    mark.append('path').attr('class', 'core')
    nodeIn.append('text').attr('class', 'label')
    const fold = nodeIn.append('g').attr('class', 'fold')
      .on('click', (ev, n) => { ev.stopPropagation(); toggle(n.data.id) })
      .on('dblclick', ev => ev.stopPropagation())
    fold.append('circle').attr('r', 5.5)
    fold.append('text')

    const all = nodeIn.merge(node)
    all.attr('class', n => nodeClass(n.data))
    all.select('path.dot').attr('d', n => shapeOf(n.data.id))
    all.select('circle.sel').attr('r', n => (stars.has(n.data.id) ? STAR_R : R) + 4)
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
    all.select('g.fold circle').attr('r', n => (collapsed.has(n.data.id) ? 8 : 5.5))
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

  function foldOffset(id) {
    const r = sideOf(id)
    if (layoutKind === 'td') return `translate(${r + 8},${-r - 4})`
    if (layoutKind === 'lr') return `translate(${-r - 2},${-r - 8})`
    const p = positions.get(id)
    if (!p || !p.radius) return `translate(${r + 8},${-r - 4})`
    const len = Math.hypot(p.p[0], p.p[1]) || 1
    return `translate(${(-p.p[1] / len) * (r + 9)},${(p.p[0] / len) * (r + 9)})`
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
    if (id !== selected) { closeAdder(); closeMover(); closeRetyper() }
    selected = id
    showEditButton()
    gNodes.selectAll('g.node').attr('class', n => nodeClass(n.data))
    markCards()
    const n = byId.get(id)
    const drawer = document.getElementById('drawer')
    drawer.hidden = false
    renderConceptPath(document.getElementById('drawer-concept'), n.concept, 'Focus on this concept')
    renderOrigin(n)
    renderRefs(n)
    renderCode(document.getElementById('drawer-code'), n.concept)
    document.getElementById('drawer-meta').textContent = `${n.type} · ${MARK[n.status] || ''} ${n.status}${n.date ? ' · ' + n.date : ''}${n.tags && n.tags.length ? ' · #' + n.tags.join(' #') : ''}`
    renderDrawerPriority(n)
    renderDrawerDates(n)
    markRows()
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

  function go(id) {
    if (editing && editing.id !== id && !leaveEditor()) return
    if (view === 'kanban') { select(id); showCard(id); return }
    if (view === 'calendar') { select(id); showRow(id); return }
    reveal(id)
    select(id)
    centreOn(id)
  }

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

  /** A button that asks to be pressed again: its label says so for 5 seconds. */
  function pressedTwice(button, ask) {
    const key = `button ${button.closest('[data-thread]')?.dataset.thread ?? ''} ${button.dataset.act ?? ''}`
    if (armed(key)) return true
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
    if (drawerW == null) mainEl.style.removeProperty('--drawer-w')
    else mainEl.style.setProperty('--drawer-w', `${drawerW}px`)
    if (save) store.set('drawerWidth', drawerW)
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
    if (drag.moved) store.set('drawerWidth', drawerW)
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
      .attr('data-concept', c.id).on('click', ev => { ev.stopPropagation(); setFocus(c.id) })
    const text = pill.append('text').attr('text-anchor', left ? 'start' : 'middle').attr('x', left ? 8 : 0).attr('y', left ? -5 : 4)
      .attr('font-size', 11.5).text(c.name)
    const w = Math.max(40, text.node().getComputedTextLength() + 16)
    pill.insert('rect', 'text').attr('x', left ? 0 : -w / 2).attr('y', left ? -19 : -10).attr('width', w).attr('height', 19).attr('rx', 9.5)
      .attr('fill', C.colourOf(concepts, c.id))
    pill.append('title').text(`${c.name}${c.summary ? ' — ' + c.summary : ''} (click to focus)`)
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
  function renderConceptPath(box, id, title) {
    box.innerHTML = ''
    const path = C.pathOf(concepts, concepts.has(id) ? id : C.ROOT)
    path.forEach((cid, i) => {
      if (i) box.append(' › ')
      const a = document.createElement('a')
      a.textContent = concepts.get(cid).name
      a.title = cid === C.ROOT ? 'Show the whole tree' : title
      const colour = C.colourOf(concepts, cid)
      if (colour) a.style.color = colour
      a.addEventListener('click', ev => { ev.preventDefault(); setFocus(cid === C.ROOT ? null : cid) })
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

  const legend = document.getElementById('legend')
  function setLegendOpen(open) {
    legend.classList.toggle('closed', !open)
    document.getElementById('legend-toggle').setAttribute('aria-expanded', String(open))
  }
  document.getElementById('legend-toggle').addEventListener('click', () => {
    const open = legend.classList.contains('closed')
    store.set('legendOpen', open)
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
    syncConceptButtons()
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
      .on('click', (ev, n) => { ev.stopPropagation(); openConcept(n.data.id) })
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
    const focusBtn = node.filter(n => n.data.id !== C.ROOT).append('text').attr('class', 'cfocus')
      .attr('y', n => radius(n.data) + 76).attr('text-anchor', 'middle').text('focus ⤢')
      .on('click', (ev, n) => { ev.stopPropagation(); setFocus(n.data.id) })
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

  document.getElementById('cmode').addEventListener('click', () => setMode(following(CMODES, conceptMode)))
  document.querySelectorAll('[data-show]').forEach(t => t.addEventListener('click', () => setView(t.dataset.show)))

  // ---------------------------------------------------------------- the kanban (web/kanban.js)

  // one column per status, the notes that pass the filters as cards, ordered by priority or by
  // date; the priority is the user's alone, set here or in the drawer, and the answer to Claude's
  // suggested one
  const kbCols = document.getElementById('kb-cols')
  const COLUMN_LABEL = { ...LABEL, other: 'another status' }
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

  // the deadlines (milestones, and notes' own due dates) and the experiments' runs, as a timeline
  // (one row per experiment, the deadlines as lines across them, the GPUs below) or a month (the
  // deadlines on their days, the runs across them). The dates are the user's alone: set here (drag
  // a bar or its end, + Deadline, a deadline's edit) and in the note's drawer, which also answer
  // Claude's suggested ones. The filters and the concept focus choose the rows, as on the kanban.
  const S = window.RftSchedule
  const CAL_MODES = ['timeline', 'month']
  const CAL_ZOOM = [10, 16, 24, 34, 48] // a day's width on the timeline, in px at A 100 %
  const TL_LABEL = 230 // the timeline's column of titles, in px at A 100 %
  const calSection = document.getElementById('calendar')
  const calBody = document.getElementById('cal-body')
  const calDeadlines = document.getElementById('cal-deadlines')
  const calAdder = document.getElementById('cal-adder')
  let calMode = 'timeline'
  let calZoom = 2
  let calMonth = null // the month shown, YYYY-MM
  let calDrag = null // a bar being dragged: nothing is redrawn under it
  let calScroll = null // where the timeline was scrolled to, kept across redraws: { from, left }
  let calOpen = null // the deadline whose editor is open
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
    plans = S.plan(tree.nodes, tree.milestones || [], todayStr())
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

  // ---------------------------------------------------------------- the deadlines strip

  function drawDeadlines(d) {
    calDeadlines.replaceChildren()
    for (const p of plans.filter(p => p.daysLeft >= 0 || p.atRisk)) calDeadlines.appendChild(deadlineCard(p))
    for (const m of (tree.milestones || []).filter(m => m.status === 'suggested')) calDeadlines.appendChild(suggestedDeadline(m))
    if (!calDeadlines.childElementCount) {
      calDeadlines.innerHTML = `<span class="muted">No deadline ahead.${EMBED ? '' : ' <b>+ Deadline</b> adds one; Claude suggests paper submissions when you name a venue.'}</span>`
    }
  }

  const milestoneOf = id => (tree.milestones || []).find(m => m.id === id)

  /** A deadline: when, how much room is left or what puts it at risk, the notes it needs; a milestone's own editor. */
  function deadlineCard(p) {
    const el = document.createElement('article')
    el.className = `cal-dl${p.atRisk ? ' risk' : ''}${p.slack !== null && p.slack > 0 && p.slack <= 3 ? ' tight' : ''}`
    el.dataset.id = p.id
    const head = document.createElement('div')
    head.className = 'cal-dl-head'
    const name = document.createElement('a')
    name.className = 'cal-dl-name'
    name.textContent = p.name
    name.title = p.kind === 'note' ? 'Open the note' : 'Edit this deadline'
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
    if (p.kind === 'milestone' && calOpen === p.id && !EMBED) el.appendChild(milestoneEditor(milestoneOf(p.id)))
    return el
  }

  function toggleEditor(id) {
    calOpen = calOpen === id ? null : id
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

  // ---------------------------------------------------------------- the timeline

  function drawTimeline(d) {
    const dayW = Math.round(CAL_ZOOM[calZoom] * font)
    const labelW = Math.round(TL_LABEL * font)
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
      f.addEventListener('click', () => (p.kind === 'note' ? go(p.id) : toggleEditor(p.id)))
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

  function scrollToDay(scroll, day) {
    const from = scroll.dataset.from
    const dayW = Math.round(CAL_ZOOM[calZoom] * font)
    const labelW = Math.round(TL_LABEL * font)
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
    const deadlines = new Map() // day → what falls due on it
    const at = (day, item) => { if (!deadlines.has(day)) deadlines.set(day, []); deadlines.get(day).push(item) }
    for (const p of plans) at(p.due, { plan: p })
    for (const ms of tree.milestones || []) {
      const due = S.parseDue(ms.due)
      if (due && (ms.status === 'suggested' || ms.status === 'done')) at(due.day, { milestone: ms, due })
    }
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
          cell.title = `${shortDay(day)}: click to add a deadline on this day`
          cell.addEventListener('click', ev => { if (ev.target === cell || ev.target.classList.contains('mo-num') || ev.target === list) openDeadlineAdder(day) })
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

  /** A deadline on its day in the month: at risk in red, Claude's suggestion dashed, a done one faded. */
  function monthChip(it) {
    const el = document.createElement('button')
    el.type = 'button'
    if (it.plan) {
      const p = it.plan
      el.className = `mo-dl${p.atRisk ? ' risk' : ''}`
      el.textContent = `${p.at.time ? `${p.at.time}${p.at.zone ? ` ${p.at.zone}` : ''} ` : ''}${p.name}`
      el.title = `${S.deadlineLine(p)}${localOf(p.at) ? ` (${localOf(p.at)})` : ''}`
      el.addEventListener('click', ev => { ev.stopPropagation(); if (p.kind === 'note') go(p.id); else { calOpen = p.id; drawCalendar(); calDeadlines.querySelector(`[data-id="${p.id}"]`)?.scrollIntoView({ block: 'nearest' }) } })
    } else {
      const ms = it.milestone
      el.className = `mo-dl ${ms.status}`
      el.textContent = `${it.due.time ? `${it.due.time} ` : ''}${ms.name}`
      el.title = ms.status === 'suggested' ? `Claude suggests ${ms.name}${ms.why ? `: ${ms.why}` : ''} (accept or dismiss it above)` : `${ms.name}: done`
      el.addEventListener('click', ev => ev.stopPropagation())
    }
    return el
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
    const labelW = Math.round(TL_LABEL * font)
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
    const text = S.ics({ project: tree.project, nodes: tree.nodes, milestones: tree.milestones || [], stamp: new Date().toISOString() }).text
    const a = ev.currentTarget
    if (a.href) URL.revokeObjectURL(a.href)
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/calendar' }))
    a.download = `${tree.project}.ics`
  })

  // + Deadline: what, when (a day; a time and its zone, as a call for papers states it), and the
  // notes it needs; the server writes it in milestones/
  function openDeadlineAdder(day) {
    if (EMBED) return
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
  const sameNote = (a, b) => a && b && a.id === b.id && a.body === b.body && a.locked === b.locked && JSON.stringify(a.threads) === JSON.stringify(b.threads)

  /** The note in the drawer, drawn: its text, its open threads marked, its footnotes in the margin, its threads below. */
  function showNote() {
    const top = shownFor === (shown && shown.id) ? drawer.scrollTop : 0
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

  /** A card in the margin for an open thread: its kind, a suggestion's new text, its last message, cut short. */
  function sideCard(t) {
    const msgs = t.messages || []
    const last = msgs[msgs.length - 1]
    const replies = Math.max(0, msgs.length - 1)
    const kind = t.kind === 'comment' ? 'Comment' : t.replacement == null ? 'Suggestion · in words' : 'Suggestion'
    const el = document.createElement('div')
    el.className = `side side-t ${t.kind}`
    el.dataset.thread = t.id
    el.title = 'Open the thread'
    el.innerHTML = `<div class="s-head"><b>${kind}</b>${replies ? ` · ${replies} ${replies > 1 ? 'replies' : 'reply'}` : ''}${t.exact ? '' : ' · the text changed'}</div>` +
      (t.kind === 'suggestion' && t.replacement != null
        ? `<div class="s-repl">${t.replacement ? escH(clip(t.replacement, 240)) : '<em>(delete the text)</em>'}</div>` : '') +
      (last ? `<div class="s-msg"><span class="s-who">${who(last.by)}:</span> ${mdm.inline(clip(String(last.text || '').replace(/\s+/g, ' ').trim(), 320))}</div>` : '') +
      (t.asked ? '<div class="s-asked">Claude is answering…</div>' : '')
    return el
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
  document.addEventListener('selectionchange', () => {
    const s = window.getSelection()
    if (!s || s.isCollapsed) hideSelBar()
  })
  // a press on the bar keeps the selection
  selBar.addEventListener('mousedown', ev => ev.preventDefault())
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
      const accept = t.kind === 'suggestion'
        ? `<button type="button" data-act="accept" class="primary"${t.replacement == null || !t.exact ? ' disabled' : ''} title="${t.replacement == null ? 'There is no new text to write yet' : !t.exact ? 'The text changed since the suggestion' : 'Write the new text into the note'}">Accept</button><button type="button" data-act="reject">Reject</button>`
        : '<button type="button" data-act="resolve" title="Settled: it goes to the history">Resolve</button>'
      bar = `<textarea rows="2" placeholder="Reply" aria-label="Reply"></textarea>
        <div class="t-bar"><button type="button" data-act="reply" title="Ctrl+Enter">Reply</button><button type="button" data-act="ask" title="Ask Claude to answer this thread (with your reply, if you wrote one), in the background: the answer comes into the thread">${t.asked ? 'Ask again' : 'Ask Claude'}</button>${accept}</div>`
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
      if (shown && shown.id === id) renderThreads()
    }
    return r
  }

  threadsBox.addEventListener('click', async ev => {
    const link = ev.target.closest('a[data-go]')
    if (link) { ev.preventDefault(); go(link.dataset.go); return }
    const b = ev.target.closest('button[data-act]')
    if (!b || !shown) return
    const tid = b.closest('.thread').dataset.thread
    const what = b.dataset.act
    if (what === 'show') { showMark(tid); return }
    if (!editKey()) { noKey.hidden = false; return }
    const id = shown.id
    const box = b.closest('.thread').querySelector('textarea')
    const text = box ? box.value.trim() : ''
    if (what === 'reply' && !text) { box.focus(); return }
    // no native confirm (the desktop's browser pane refuses dialogs): a second press within a few seconds
    if (what === 'accept' && !pressedTwice(b, 'Write it?')) return
    b.disabled = true
    if ((what === 'reply' || what === 'ask') && text) {
      const r = await act(id, tid, 'reply', { text })
      if (!r.ok) return
      drafts.delete(`${id} ${tid}`)
      if (box) box.value = ''
    }
    if (what !== 'reply') await act(id, tid, what)
  })
  threadsBox.addEventListener('input', ev => {
    if (ev.target.tagName === 'TEXTAREA') drafts.set(draftKey(ev.target.closest('.thread').dataset.thread), ev.target.value)
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
  article.addEventListener('click', ev => {
    if (ev.target.closest('a[data-go]')) return
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
    render(false)
    hasView = true
    requestAnimationFrame(() => initialView())
    setView(view)
    if (selected && byId.has(selected)) select(selected)
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
