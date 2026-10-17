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
  const SPACING = { td: [150, 104], lr: [34, 280], radial: [0, 140] } // [breadth, depth] in world units
  const LABEL_PX = 15 // label size on screen at A 100 %, whatever the zoom
  const FONT_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6, 1.8, 2]
  const POLL_MS = 2000
  const EMBED = window.RFT_DATA || null

  let tree = null
  let byId = new Map()
  let layoutKind = 'td'
  let collapsed = new Set()
  let hiddenStatuses = new Set()
  let selected = null
  let matchAt = -1
  let positions = new Map()
  let hasView = false
  let font = 1 // the A− / A+ scale of labels and the note drawer

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
    if (first) {
      layoutKind = store.get('layout', 'td')
      collapsed = new Set(store.get('collapsed', []))
      hiddenStatuses = new Set(store.get('hidden', []))
      setFont(store.get('font', 1), false)
      document.title = `${tree.project} · reasoning tree`
      document.getElementById('title').textContent = `${tree.project} — the reasoning tree`
      buildLegend()
      syncLayoutButtons()
    }
    for (const id of [...collapsed]) if (!byId.has(id)) collapsed.delete(id)
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
    const single = tree.roots.length === 1
    const top = single ? byId.get(tree.roots[0]) : { id: '__root', virtual: true, children: tree.roots }
    return d3.hierarchy(top, d => {
      if (d.virtual) return d.children.map(id => byId.get(id))
      if (collapsed.has(d.id)) return null
      return d.children.map(id => byId.get(id)).filter(Boolean)
    })
  }

  function compute() {
    const root = hierarchy()
    const offset = root.data.virtual ? 1 : 0
    const [b, d] = SPACING[layoutKind]
    if (layoutKind === 'radial') {
      const depth = Math.max(1, root.height)
      d3.tree().size([2 * Math.PI, depth * d]).separation((a, c) => (a.parent === c.parent ? 1 : 2) / Math.max(1, a.depth))(root)
    } else {
      d3.tree().nodeSize([b, d]).separation((a, c) => (a.parent === c.parent ? 1 : 1.3))(root)
    }
    const shift = layoutKind === 'radial' ? 0 : offset * d
    const point = n => {
      if (layoutKind === 'td') return [n.x, n.y - shift]
      if (layoutKind === 'lr') return [n.y - shift, n.x]
      const a = n.x - Math.PI / 2, r = n.y
      return [r * Math.cos(a), r * Math.sin(a)]
    }
    const nodes = root.descendants().filter(n => !n.data.virtual)
    const pos = new Map(nodes.map(n => [n.data.id, { p: point(n), angle: n.x, radius: n.y }]))
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
    const shorten = (p, by) => { const len = Math.hypot(p[0], p[1]) || 1; return [p[0] * (1 - by / len), p[1] * (1 - by / len)] }
    const a = shorten(t.p, R + 3)
    return `M${x1},${y1}L${a[0]},${a[1]}`
  }

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
    gLinks.selectAll('path.link').attr('class', l => `link${hiddenStatuses.has(l.target.data.status) ? ' dim' : ''}`)
    updateLabels()
  }

  function nodeClass(d) {
    let c = `node ${d.type}`
    if (d.id === selected) c += ' selected'
    if (hiddenStatuses.has(d.status)) c += ' dim'
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
    if (!p) return 'translate(0,0)'
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
        const deg = p ? (p.angle * 180) / Math.PI : 0
        const right = !p || p.angle < Math.PI
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
    document.getElementById('drawer-meta').textContent = `${n.type} · ${MARK[n.status] || ''} ${n.status}${n.date ? ' · ' + n.date : ''}`
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
    const hits = tree.nodes.filter(n => n.name.toLowerCase().includes(q))
    if (!hits.length) return
    matchAt = (matchAt + 1) % hits.length
    go(hits[matchAt].id)
  })

  function buildLegend() {
    const box = document.getElementById('statuses')
    box.innerHTML = ''
    for (const s of STATUSES) {
      const row = document.createElement('div')
      row.className = `row${hiddenStatuses.has(s) ? ' off' : ''}`
      row.innerHTML = `<span class="swatch" style="background: var(--${s})"></span>${MARK[s]} ${LABEL[s]}`
      row.title = 'Click to dim or show this status'
      row.addEventListener('click', () => {
        if (hiddenStatuses.has(s)) hiddenStatuses.delete(s)
        else hiddenStatuses.add(s)
        store.set('hidden', [...hiddenStatuses])
        row.classList.toggle('off', hiddenStatuses.has(s))
        render(false)
      })
      box.appendChild(row)
    }
  }

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
  document.getElementById('centre').addEventListener('click', () => tree && tree.roots[0] && centreOn(tree.roots[0]))
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
          else render(true)
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
