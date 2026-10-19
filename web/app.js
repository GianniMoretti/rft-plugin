// The rft web view: the reasoning tree as a tidy tree on an infinite canvas (d3), with notes in
// a side drawer. It runs in two ways: served by server/rft_server.py, where it polls
// `api/tree` and reads notes from `api/note`; or inlined into a standalone tree.html by
// /rft-view, where `window.RFT_DATA` holds the tree and every note's text.
(function () {
  'use strict'

  const STATUSES = ['done', 'running', 'planned', 'idea', 'dropped', 'discussed', 'moved']
  const MARK = { done: '✓', running: '…', planned: '→', idea: '?', dropped: '✗', discussed: '·', moved: '↗' }
  const LABEL = { done: 'done', running: 'running', planned: 'planned', idea: 'idea', dropped: 'dropped', discussed: 'discussed, not pursued', moved: 'moved' }
  const R = 7 // node radius
  const SPACING = { td: [150, 104], lr: [34, 280], radial: [90, 140] } // [breadth, depth] in world units
  const LABEL_PX = 15 // label size on screen at A 100 %, whatever the zoom
  const FONT_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2]
  const POLL_MS = 2000
  const EMBED = window.RFT_DATA || null

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
  let conceptMode = 'off' // off | regions | arrows
  let view = 'tree' // tree: the reasoning tree; concepts: the concept tree
  let focus = null // the concept whose subtree alone is drawn, or null

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
    concepts = C.annotate(tree)
    if (first) {
      conceptMode = ['off', 'regions', 'arrows'].includes(store.get('conceptMode', 'off')) ? store.get('conceptMode', 'off') : 'off'
      view = store.get('pageView', 'tree') === 'concepts' ? 'concepts' : 'tree'
      focus = store.get('focus', null)
      // a link can say how to open: ?layout=lr&concepts=regions&view=concepts&focus=D02&filter=hide
      const q = new URLSearchParams(location.search)
      if (['td', 'lr', 'radial'].includes(q.get('layout'))) store.set('layout', q.get('layout'))
      if (['off', 'regions', 'arrows'].includes(q.get('concepts'))) conceptMode = q.get('concepts')
      if (['tree', 'concepts'].includes(q.get('view'))) view = q.get('view')
      if (q.has('focus')) focus = q.get('focus') || null
      if (q.has('note')) selected = q.get('note')
      buildArrowMarkers()
      layoutKind = store.get('layout', 'td')
      collapsed = new Set(store.get('collapsed', []))
      // earlier versions kept only the legend's statuses, under `hidden`
      filters = F.normalise(store.get('filters', null) || { hiddenStatuses: store.get('hidden', []) })
      const fq = new URLSearchParams(location.search)
      if (fq.has('tags')) filters = F.normalise({ ...filters, tags: fq.get('tags').split(',').filter(Boolean) })
      if (fq.has('hide')) filters = F.normalise({ ...filters, mode: 'hide' })
      setFont(new URLSearchParams(location.search).get('font') || store.get('font', 1), false)
      document.title = `${tree.project} · reasoning tree`
      document.getElementById('title').textContent = `${tree.project} — the reasoning tree`
      buildLegend()
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
    const c = { direction: 0, experiment: 0 }
    for (const n of tree.nodes) c[n.type] = (c[n.type] || 0) + 1
    document.getElementById('counts').textContent = `${c.direction} directions · ${c.experiment} experiments`
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
    const pos = new Map(nodes.map(n => [n.data.id, { p: point(n), angle: n.angle, radius: n.radius }]))
    const links = root.links().filter(l => !l.source.data.virtual)
    return { nodes, links, pos }
  }

  function linkPath(s, t) {
    const [x1, y1] = s.p, [x2, y2] = t.p
    if (layoutKind === 'td') {
      const ye = y2 - R - 3, my = (y1 + ye) / 2
      return `M${x1},${y1 + R}C${x1},${my} ${x2},${my} ${x2},${ye}`
    }
    if (layoutKind === 'lr') {
      const xe = x2 - R - 3, mx = (x1 + xe) / 2
      return `M${x1 + R},${y1}C${mx},${y1} ${mx},${y2} ${xe},${y2}`
    }
    return radialLink({ source: [s.angle, s.radius ? s.radius + R : 0], target: [t.angle, Math.max(0, t.radius - R - 3)] })
  }
  const radialLink = d3.linkRadial().angle(e => e[0]).radius(e => e[1])

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
    nodeIn.append('circle').attr('class', 'dot').attr('r', R)
    nodeIn.append('text').attr('class', 'label')
    const fold = nodeIn.append('g').attr('class', 'fold')
      .on('click', (ev, n) => { ev.stopPropagation(); toggle(n.data.id) })
      .on('dblclick', ev => ev.stopPropagation())
    fold.append('circle').attr('r', 5.5)
    fold.append('text')

    const all = nodeIn.merge(node)
    all.attr('class', n => nodeClass(n.data))
    all.select('circle.dot').attr('fill', n => `var(--${STATUSES.includes(n.data.status) ? n.data.status : 'discussed'})`)
    all.select('g.fold')
      .attr('display', n => (n.data.children.length ? null : 'none'))
      .attr('transform', n => foldOffset(n.data.id))
    all.select('g.fold text').text(n => (collapsed.has(n.data.id) ? `+${countBelow(n.data.id)}` : '−'))
    all.select('g.fold circle').attr('r', n => (collapsed.has(n.data.id) ? 8 : 5.5))
    all.transition().duration(dur).attr('transform', n => `translate(${pos.get(n.data.id).p})`)
    gLinks.selectAll('path.link').attr('class', l => `link${matchSet.has(l.target.data.id) ? '' : ' dim'}`)
    drawConcepts(pos, dur)
    updateLabels()
  }

  function nodeClass(d) {
    let c = `node ${d.type}`
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
    if (layoutKind === 'td') return `translate(${R + 8},${-R - 4})`
    if (layoutKind === 'lr') return `translate(${-R - 2},${-R - 8})`
    const p = positions.get(id)
    if (!p || !p.radius) return `translate(${R + 8},${-R - 4})`
    const len = Math.hypot(p.p[0], p.p[1]) || 1
    return `translate(${(-p.p[1] / len) * (R + 9)},${(p.p[0] / len) * (R + 9)})`
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
      // nodes stay visible when far: at least 3.5 px on screen
      d3.select(this).select('circle.dot').attr('r', Math.max(R, 3.5 / k))
      if (layoutKind === 'td') {
        text.attr('x', 0).attr('y', R + 4 + size).attr('text-anchor', 'middle').attr('transform', null)
      } else if (layoutKind === 'lr') {
        text.attr('x', R + 6).attr('y', size * 0.35).attr('text-anchor', 'start').attr('transform', null)
      } else {
        const p = positions.get(d.id)
        // the centre's label lies flat, the others point outward and read left to right
        const angle = p && p.radius ? L.normalAngle(p.angle) : Math.PI / 2
        const deg = (angle * 180) / Math.PI
        const right = angle < Math.PI
        text.attr('text-anchor', right ? 'start' : 'end').attr('x', right ? R + 6 : -R - 6).attr('y', size * 0.35)
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
    tooltip.textContent = `${n.name} · ${MARK[n.status] || ''} ${n.status}${n.date ? ' · ' + n.date : ''}`
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
  }

  function fit(animate = true) {
    const box = gNodes.node().getBBox()
    const w = svg.node().clientWidth, h = svg.node().clientHeight
    if (!box.width || !w || !h) return
    const s = Math.max(0.03, Math.min(2, 0.9 * Math.min(w / (box.width + 80), h / (box.height + 80))))
    const t = d3.zoomIdentity.translate(w / 2, h / 2).scale(s).translate(-(box.x + box.width / 2), -(box.y + box.height / 2))
    ;(animate ? svg.transition().duration(450) : svg).call(zoom.transform, t)
  }

  async function select(id) {
    selected = id
    gNodes.selectAll('g.node').attr('class', n => nodeClass(n.data))
    const n = byId.get(id)
    const drawer = document.getElementById('drawer')
    drawer.hidden = false
    renderConceptPath(document.getElementById('drawer-concept'), n.concept, 'Focus on this concept')
    document.getElementById('drawer-meta').textContent = `${n.type} · ${MARK[n.status] || ''} ${n.status}${n.date ? ' · ' + n.date : ''}${n.tags && n.tags.length ? ' · #' + n.tags.join(' #') : ''}`
    const article = document.getElementById('note')
    article.innerHTML = '<p class="missing">Loading…</p>'
    let body = null
    try {
      if (EMBED) body = EMBED.bodies ? EMBED.bodies[id] : null
      else {
        const res = await fetch(`api/note?id=${encodeURIComponent(id)}`, { cache: 'no-store' })
        if (res.ok) body = (await res.json()).body
      }
    } catch (e) { body = null }
    if (selected !== id) return
    article.innerHTML = body == null ? '<p class="missing">The note could not be read.</p>' : markdown(body)
  }

  function go(id) {
    reveal(id)
    select(id)
    centreOn(id)
  }

  // ---------------------------------------------------------------- search, filter, legend

  const searchBox = document.getElementById('search')
  const searchText = () => searchBox.value.trim().toLowerCase()
  searchBox.addEventListener('input', () => {
    matchAt = -1
    gNodes.selectAll('g.node').attr('class', n => nodeClass(n.data))
  })
  searchBox.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter') return
    const q = searchText()
    if (!q) return
    // search works with the filters: a hidden note is not a hit
    const hits = tree.nodes.filter(n => shownSet.has(n.id) && n.name.toLowerCase().includes(q))
    if (!hits.length) return
    matchAt = (matchAt + 1) % hits.length
    go(hits[matchAt].id)
  })

  // ---------------------------------------------------------------- filters

  function computeFilters() {
    matchSet = F.matching(tree, filters)
    shownSet = F.visible(tree, filters)
    if (focus) {
      // focus on a concept: its subtree alone, its root always drawn
      const top = concepts.get(focus).root
      const sub = C.subtree(tree, top)
      shownSet = new Set([...shownSet].filter(id => sub.has(id)))
      shownSet.add(top)
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
  }

  const toggled = (list, v) => (list.includes(v) ? list.filter(x => x !== v) : [...list, v])

  function buildLegend() {
    const box = document.getElementById('statuses')
    box.innerHTML = ''
    for (const s of STATUSES) {
      const row = document.createElement('div')
      row.className = `row${filters.hiddenStatuses.includes(s) ? ' off' : ''}`
      row.innerHTML = `<span class="swatch" style="background: var(--${s})"></span>${MARK[s]} ${LABEL[s]}`
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
      label.innerHTML = `<input type="checkbox"${filters.hiddenStatuses.includes(s) ? '' : ' checked'}> <span class="swatch" style="background: var(--${s})"></span> ${LABEL[s]}`
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

  function syncLayoutButtons() {
    document.querySelectorAll('[data-layout]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.layout === layoutKind)))
  }

  document.querySelectorAll('[data-layout]').forEach(b => b.addEventListener('click', () => {
    layoutKind = b.dataset.layout
    store.set('layout', layoutKind)
    syncLayoutButtons()
    render(true)
    setTimeout(() => fit(true), 420)
  }))
  function setFont(value, save = true) {
    const v = Number(value)
    font = FONT_STEPS.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a), 1)
    document.documentElement.style.setProperty('--font-scale', String(font))
    document.getElementById('font-size').textContent = `${Math.round(font * 100)} %`
    if (save) store.set('font', font)
    scheduleLabels()
  }
  const stepFont = d => setFont(FONT_STEPS[Math.max(0, Math.min(FONT_STEPS.length - 1, FONT_STEPS.indexOf(font) + d))])
  document.getElementById('font-down').addEventListener('click', () => stepFont(-1))
  document.getElementById('font-up').addEventListener('click', () => stepFont(1))
  document.getElementById('fit').addEventListener('click', () => fit(true))
  const topId = () => (focus ? concepts.get(focus).root : tree.roots[0])
  document.getElementById('centre').addEventListener('click', () => tree && topId() && centreOn(topId()))
  document.getElementById('expand').addEventListener('click', () => { collapsed.clear(); store.set('collapsed', []); render(true) })
  document.getElementById('collapse').addEventListener('click', () => {
    collapsed = new Set(tree.nodes.filter(n => n.parent && n.children.length).map(n => n.id))
    store.set('collapsed', [...collapsed])
    render(true)
  })
  document.getElementById('drawer-close').addEventListener('click', () => {
    document.getElementById('drawer').hidden = true
    selected = null
    gNodes.selectAll('g.node').attr('class', n => nodeClass(n.data))
  })
  document.getElementById('note').addEventListener('click', ev => {
    const a = ev.target.closest('a[data-go]')
    if (a) { ev.preventDefault(); go(a.dataset.go) }
  })
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
    if (view !== 'tree') setView('tree')
    computeFilters()
    buildCrumbs()
    render(true)
    setTimeout(() => fit(true), 420)
  }

  function syncConceptButtons() {
    document.querySelectorAll('[data-cmode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.cmode === conceptMode)))
    const t = document.getElementById('view-toggle')
    t.setAttribute('aria-pressed', String(view === 'concepts'))
    t.textContent = view === 'concepts' ? 'Reasoning tree' : 'Concept tree'
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

  function buildConceptLegend() {
    const list = C.ordered(concepts).filter(c => c.id !== C.ROOT)
    const box = document.getElementById('concept-legend')
    box.hidden = conceptMode === 'off' || !list.length
    const rows = document.getElementById('concepts-list')
    rows.innerHTML = ''
    for (const c of list) {
      const row = document.createElement('div')
      row.className = `row${focus === c.id ? ' on' : ''}`
      row.style.paddingLeft = `${(c.depth - 1) * 12}px`
      row.innerHTML = `<span class="swatch" style="background: ${C.colourOf(concepts, c.id)}"></span>${escH(c.name)} <span class="muted">${c.total}</span>`
      row.title = `${c.summary || c.name} — click to focus`
      row.addEventListener('click', () => setFocus(focus === c.id ? null : c.id))
      rows.appendChild(row)
    }
  }

  // ---------------------------------------------------------------- the concept tree

  const csvg = d3.select('#concept-canvas')
  const cviewport = d3.select('#cviewport')
  const czoom = d3.zoom().scaleExtent([0.1, 4]).on('zoom', ev => cviewport.attr('transform', ev.transform))
  csvg.call(czoom).on('dblclick.zoom', null)

  function setView(v) {
    view = v
    store.set('pageView', v)
    // SVG elements have no `hidden` property: the attribute itself
    document.getElementById('canvas').toggleAttribute('hidden', v !== 'tree')
    document.getElementById('concept-canvas').toggleAttribute('hidden', v !== 'concepts')
    syncConceptButtons()
    if (v === 'concepts') drawConceptTree()
  }

  function drawConceptTree() {
    cviewport.selectAll('*').remove()
    const top = d3.hierarchy(concepts.get(C.ROOT), c => c.children.map(id => concepts.get(id)).filter(Boolean))
    d3.tree().nodeSize([240, 230])(top)
    const radius = c => 12 + 4.5 * Math.sqrt(c.total)
    // a link leaves below the parent's name, count, bar and focus line, and enters the child's circle
    const BLOCK = 84
    cviewport.append('g').selectAll('path').data(top.links()).join('path').attr('class', 'clink')
      .attr('d', l => d3.linkVertical()({ source: [l.source.x, l.source.y + radius(l.source.data) + BLOCK], target: [l.target.x, l.target.y - radius(l.target.data) - 4] }))
    const node = cviewport.append('g').selectAll('g').data(top.descendants()).join('g')
      .attr('class', 'cnode').attr('transform', n => `translate(${n.x},${n.y})`)
      .on('click', (ev, n) => { ev.stopPropagation(); openConcept(n.data.id) })
    node.append('title').text(n => `${n.data.name}${n.data.summary ? ' — ' + n.data.summary : ''}`)
    node.append('circle').attr('r', n => radius(n.data))
      .attr('fill', n => C.colourOf(concepts, n.data.id) || 'var(--panel)')
      .attr('stroke', n => (n.data.id === C.ROOT ? 'var(--muted)' : 'none'))
    node.append('text').attr('class', 'cname').attr('y', n => radius(n.data) + 20).attr('text-anchor', 'middle').text(n => n.data.name)
    node.append('text').attr('class', 'ccount muted').attr('y', n => radius(n.data) + 38).attr('text-anchor', 'middle')
      .text(n => `${n.data.total} note${n.data.total === 1 ? '' : 's'}${n.data.total > n.data.count ? ` (${n.data.count} own)` : ''}`)
    // the stacked bar of statuses, the concept with its sub-concepts
    const BAR = 130
    node.each(function (n) {
      const counts = C.totalStatuses(concepts, n.data.id)
      const total = STATUSES.reduce((a, st) => a + (counts[st] || 0), 0) || 1
      const g = d3.select(this).append('g').attr('transform', `translate(${-BAR / 2},${radius(n.data) + 48})`)
      let x = 0
      for (const st of STATUSES) {
        const w = ((counts[st] || 0) / total) * BAR
        if (!w) continue
        g.append('rect').attr('x', x).attr('width', w).attr('height', 9).attr('fill', `var(--${st})`)
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

  document.querySelectorAll('[data-cmode]').forEach(b => b.addEventListener('click', () => setMode(b.dataset.cmode)))
  document.getElementById('view-toggle').addEventListener('click', () => setView(view === 'concepts' ? 'tree' : 'concepts'))

  // ---------------------------------------------------------------- markdown (the subset notes use)

  const escH = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  function idForLink(target) {
    const t = target.trim()
    for (const n of tree.nodes) if (n.name === t) return n.id
    const id = t.split(' ')[0]
    return byId.has(id) ? id : null
  }
  function inline(t) {
    return escH(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/!\[\[([^\]]+)\]\]/g, '<em>(embedded: $1)</em>')
      .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (m, target, alias) => {
        const id = idForLink(target.replace(/&amp;/g, '&'))
        const label = alias || target
        return id ? `<a data-go="${id}">${label}</a>` : `<span class="missing">${label}</span>`
      })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  }
  function markdown(src) {
    const out = []
    let list = 0, inCode = false, table = false, para = []
    // a line ending in two spaces breaks the line, as in Obsidian
    const flush = () => {
      if (para.length) out.push(`<p>${para.map((l, i) => inline(l.replace(/\s+$/, '')) + (i < para.length - 1 ? (/ {2}$/.test(l) ? '<br>' : ' ') : '')).join('')}</p>`)
      para = []
    }
    const close = () => { flush(); while (list > 0) { out.push('</ul>'); list-- } if (table) { out.push('</table>'); table = false } }
    for (const raw of src.split('\n')) {
      if (raw.startsWith('```')) { close(); out.push(inCode ? '</pre>' : '<pre>'); inCode = !inCode; continue }
      if (inCode) { out.push(escH(raw)); continue }
      const h = /^(#{1,6})\s+(.*)$/.exec(raw)
      const li = /^(\s*)[-*]\s+(.*)$/.exec(raw)
      if (h) { close(); const l = Math.min(h[1].length, 2); out.push(`<h${l}>${inline(h[2])}</h${l}>`) }
      else if (li) {
        flush()
        if (table) { out.push('</table>'); table = false }
        const depth = Math.floor(li[1].replace(/\t/g, '    ').length / 2) + 1
        while (list < depth) { out.push('<ul>'); list++ }
        while (list > depth) { out.push('</ul>'); list-- }
        out.push(`<li>${inline(li[2])}</li>`)
      } else if (/^\|.*\|\s*$/.test(raw)) {
        if (/^\|[\s:|-]+\|\s*$/.test(raw)) continue
        if (!table) { close(); out.push('<table>'); table = true }
        out.push('<tr>' + raw.trim().slice(1, -1).split('|').map(c => `<td>${inline(c.trim())}</td>`).join('') + '</tr>')
      } else if (raw.trim() === '') close()
      else if (list && /^\s+\S/.test(raw) && out[out.length - 1].endsWith('</li>')) {
        // an indented line continues the list item above
        out[out.length - 1] = out[out.length - 1].slice(0, -5) + ' ' + inline(raw.trim()) + '</li>'
      } else { if (list || table) close(); para.push(raw) }
    }
    close()
    if (inCode) out.push('</pre>')
    return out.join('\n')
  }

  // ---------------------------------------------------------------- start

  // the first view: the one kept from last time, else the whole tree when it is still readable,
  // else the root at the top at a readable scale (Fit shows everything)
  function initialView(tries = 0) {
    const w = svg.node().clientWidth, h = svg.node().clientHeight
    const box = gNodes.node().getBBox()
    if ((!w || !h || !box.width) && tries < 20) { requestAnimationFrame(() => initialView(tries + 1)); return }
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
    render(false)
    hasView = true
    requestAnimationFrame(() => initialView())
    if (view === 'concepts') setView('concepts')
    if (selected && byId.has(selected)) select(selected)
  }

  const live = document.getElementById('live')
  if (EMBED) {
    live.hidden = true
    setTree(EMBED.tree)
    first()
  } else {
    const poll = async () => {
      try {
        const res = await fetch('api/tree', { cache: 'no-store' })
        if (!res.ok) throw new Error(String(res.status))
        const next = await res.json()
        live.className = 'live on'
        live.title = 'Live: follows the vault'
        if (!tree || next.version !== tree.version) {
          setTree(next)
          if (!hasView) first()
          else { render(true); if (view === 'concepts') drawConceptTree() }
          if (selected && byId.has(selected)) select(selected)
        }
      } catch (e) {
        live.className = 'live off'
        live.title = 'The server is not answering (session ended or /rft stop?)'
      }
    }
    poll()
    setInterval(poll, POLL_MS)
  }
})()
