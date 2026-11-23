// The slide tools (docs/design/presentations.md, "The slide tools"): the slide beside a deck's text
// as an editing surface for its boxes and lines. A click selects, a drag moves, the handles resize
// (a line by its two ends), the arrow keys nudge, Delete removes, Ctrl+D duplicates, Ctrl+C/X/V
// copy as text, Ctrl+] and Ctrl+[ put in front and behind. Every action is an edit of the deck's
// text in the editor beside it (web/slide-edit.js makes the edit; CodeMirror's history is the one
// undo), and the slide is drawn again from the text: nothing is kept here but what is selected, as
// the lines of the text it starts at. On a desktop only: a phone keeps the slide as a view.
// Mounted by web/decks.js, which draws the slide and calls `redraw()` after it.
(function (root) {
  'use strict'

  const P = root.RftSlides
  const E = root.RftSlideEdit
  const NS = 'http://www.w3.org/2000/svg'
  const PHONE = '(max-width: 700px), (pointer: coarse)' // as web/phone.js
  const DRAG_PX = 3 // a press that moves less is a click
  const SNAP_PX = 6 // an edge this near a guide goes to it
  const HANDLE_PX = 9
  const HIT_PX = 14 // how wide a line, or a hollow shape's outline, is to the pointer
  const COPY_BY = 20 // a copy is this far right of and below what it copies

  const ICONS = {
    text: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M7 3v10M3.8 6h1.6M3.8 8.5h1.6"/>',
    forward: '<rect x="2" y="6" width="8" height="8" rx="1"/><rect x="6" y="2" width="8" height="8" rx="1" fill="currentColor"/>',
    back: '<rect x="6" y="2" width="8" height="8" rx="1"/><rect x="2" y="6" width="8" height="8" rx="1" fill="currentColor"/>',
    duplicate: '<rect x="2" y="2" width="8" height="8" rx="1"/><rect x="6" y="6" width="8" height="8" rx="1"/>',
    remove: '<path d="M3 4.5h10M6.2 4.5V2.8h3.6v1.7M4.4 4.5l.6 8.7h6l.6-8.7M6.8 7v3.8M9.2 7v3.8"/>',
  }
  const icon = name => `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`

  function mount({ cm, stage, bar, body, store, slide }) {
    if (!P || !E || !cm || !stage) return null
    const desktop = () => !(root.matchMedia && root.matchMedia(PHONE).matches)
    let sel = [] // what is selected: the handles of the lines of the text its boxes and lines start at
    let drag = null // a press on the slide, and what it moves
    let live = new Map() // while it moves: a box's or a line's place, by its index
    let guides = [] // and the guides it is snapped to: { x } or { y }
    let scale = 0
    let overlay = null
    let syncing = false
    let shown = 0 // the slide the overlay was last drawn over

    // ---------------------------------------------------------------- what is on the slide

    const items = () => (slide() ? slide().items : [])
    const slideEl = () => { const el = stage.firstElementChild; return el && el.classList.contains('slide') ? el : null }
    const elOf = k => { const el = slideEl(); return el ? el.querySelector(`:scope > [data-item="${k}"]`) : null }
    const lines = () => cm.getValue().split('\n')

    /** The boxes and lines selected, by their index on the slide, in the text's order. */
    function selected() {
      const its = items()
      const out = []
      for (const h of sel) {
        const line = cm.getLineNumber(h)
        const k = line == null ? -1 : its.findIndex(i => i.from === line)
        if (k >= 0 && !out.includes(k)) out.push(k)
      }
      return out.sort((a, b) => a - b)
    }

    /** Selects the boxes and lines `ks`; the editor's cursor goes to the first one's text. */
    function select(ks, cursor = true) {
      const its = items()
      sel = ks.filter(k => its[k]).map(k => cm.getLineHandle(its[k].from))
      if (cursor && ks.length && its[ks[0]] && cm.getCursor().line !== its[ks[0]].from) {
        syncing = true
        cm.setCursor({ line: its[ks[0]].from, ch: 0 })
        cm.scrollIntoView({ line: its[ks[0]].from, ch: 0 }, 60)
        syncing = false
      }
      draw()
    }

    /** Selects the boxes and lines that start at these lines of the text. */
    const selectLines = (at, cursor = true) => select(at.map(l => items().findIndex(i => i.from === l)).filter(k => k >= 0), cursor)

    /** Where a box or a line is, in the slide's units: as it is being dragged, else as its text has it (a box with no height, as high as it is drawn). */
    function geom(k) {
      if (live.has(k)) return live.get(k)
      const it = items()[k]
      if (!it) return null
      if (it.kind === 'line') return it.x1 == null || it.x2 == null ? null : { x1: it.x1, y1: it.y1, x2: it.x2, y2: it.y2 }
      const el = elOf(k)
      return { x: it.x, y: it.y, w: it.w, h: it.h || (el ? el.offsetHeight : 0) }
    }
    const boundsOf = g => ('x1' in g ? { x: Math.min(g.x1, g.x2), y: Math.min(g.y1, g.y2), w: Math.abs(g.x2 - g.x1), h: Math.abs(g.y2 - g.y1) } : g)
    const around = gs => {
      const bs = gs.map(boundsOf)
      const x = Math.min(...bs.map(b => b.x)), y = Math.min(...bs.map(b => b.y))
      return { x, y, w: Math.max(...bs.map(b => b.x + b.w)) - x, h: Math.max(...bs.map(b => b.y + b.h)) - y }
    }

    // ---------------------------------------------------------------- the text

    /** Edits of the text, made as one step of the editor's history. */
    function apply(edits, origin = 'slide') {
      const len = l => cm.getLine(l).length
      cm.operation(() => {
        for (const e of [...edits].sort((a, b) => b.from - a.from || b.to - a.to)) {
          const n = cm.lineCount(), text = e.lines.join('\n')
          if (e.to > e.from && e.lines.length) cm.replaceRange(text, { line: e.from, ch: 0 }, { line: e.to - 1, ch: len(e.to - 1) }, origin)
          else if (e.to > e.from) {
            if (e.to < n) cm.replaceRange('', { line: e.from, ch: 0 }, { line: e.to, ch: 0 }, origin)
            else if (e.from > 0) cm.replaceRange('', { line: e.from - 1, ch: len(e.from - 1) }, { line: n - 1, ch: len(n - 1) }, origin)
            else cm.replaceRange('', { line: 0, ch: 0 }, { line: n - 1, ch: len(n - 1) }, origin)
          } else if (e.lines.length) {
            if (e.from < n) cm.replaceRange(`${text}\n`, { line: e.from, ch: 0 }, undefined, origin)
            else cm.replaceRange(`\n${text}`, { line: n - 1, ch: len(n - 1) }, undefined, origin)
          }
        }
      })
    }

    /** Boxes and lines (each its lines) added to the slide, in front, and selected. */
    function add(blocks) {
      const s = slide()
      if (!s || !blocks.length) return
      const { edit, firsts } = E.inserted(lines(), s, blocks)
      apply([edit])
      selectLines(firsts)
    }

    /** The selection moved by `dx`, `dy`, kept on the slide. */
    function nudge(dx, dy) {
      const ks = selected(), its = items()
      const gs = ks.map(geom).filter(Boolean)
      if (!gs.length) return
      const b = around(gs), kept = E.keepOn({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h })
      const mx = kept.x - b.x, my = kept.y - b.y
      if (!mx && !my) return
      const ls = lines()
      apply(ks.map(k => E.set(ls, its[k], E.at(its[k], mx, my))), '+slide-nudge')
    }

    function remove() {
      const ks = selected(), its = items()
      if (!ks.length) return
      sel = []
      apply(E.removed(lines(), ks.map(k => its[k])))
    }

    const textOf = ks => { const ls = lines(), its = items(); return ks.map(k => E.block(ls, its[k]).join('\n')).join('\n\n') }

    function duplicate() {
      const ks = selected(), ls = lines(), its = items()
      add(ks.map(k => E.shifted(E.block(ls, its[k]), COPY_BY, COPY_BY)))
    }

    /** What a text copied from a deck holds, added to the slide: beside what is there when it would lie on it. */
    function paste(text) {
      let blocks = E.blocks(text)
      if (!blocks.length) return false
      const there = new Set(items().map(i => lines()[i.from]))
      for (let n = 0; n < 20 && blocks.some(b => there.has(b[0])); n++) blocks = blocks.map(b => E.shifted(b, COPY_BY, COPY_BY))
      add(blocks)
      return true
    }

    /** The one selected put a step in front (1) or behind (-1), or all the way (`far`). */
    function order(dir, far = false) {
      const ks = selected(), s = slide()
      if (ks.length !== 1 || !s) return
      const k = ks[0], to = far ? (dir > 0 ? s.items.length - 1 : 0) : k + dir
      const edits = E.reordered(lines(), s, k, to)
      if (!edits.length) return
      apply(edits)
      select([to])
    }

    // ---------------------------------------------------------------- the overlay: what the pointer takes hold of

    const svg = (tag, attrs) => {
      const el = document.createElementNS(NS, tag)
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
      return el
    }

    /** Draws the overlay: each box's and line's shape for the pointer, the frames and handles of those selected, the guides. */
    function draw() {
      if (!overlay) return
      const its = items(), ks = selected(), u = 1 / scale
      const out = []
      its.forEach((it, k) => {
        const g = geom(k)
        if (!g) return
        if (it.kind === 'line') {
          out.push(svg('line', { class: 'sl-hit hollow', 'data-k': k, x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, 'stroke-width': HIT_PX * u }))
          return
        }
        // a shape with nothing in it is taken by its outline, so what is under it can be
        const hollow = !it.fill && !it.content.trim()
        const cls = `sl-hit${hollow ? ' hollow' : ''}`
        out.push(it.shape === 'ellipse'
          ? svg('ellipse', { class: cls, 'data-k': k, cx: g.x + g.w / 2, cy: g.y + g.h / 2, rx: g.w / 2, ry: g.h / 2, 'stroke-width': HIT_PX * u })
          : svg('rect', { class: cls, 'data-k': k, x: g.x, y: g.y, width: g.w, height: g.h, 'stroke-width': HIT_PX * u }))
      })
      for (const k of ks) {
        const g = geom(k)
        if (!g) continue
        if (its[k].kind === 'line') {
          if (ks.length === 1) for (const [h, x, y] of [['a', g.x1, g.y1], ['b', g.x2, g.y2]]) out.push(svg('circle', { class: 'sl-handle', 'data-k': k, 'data-h': h, cx: x, cy: y, r: HANDLE_PX * u * 0.6 }))
          else out.push(svg('line', { class: 'sl-frame', x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2 }))
          continue
        }
        out.push(svg('rect', { class: 'sl-frame', x: g.x, y: g.y, width: g.w, height: g.h }))
        if (ks.length !== 1) continue
        const s = HANDLE_PX * u
        for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
          const x = h.includes('w') ? g.x : h.includes('e') ? g.x + g.w : g.x + g.w / 2
          const y = h.includes('n') ? g.y : h.includes('s') ? g.y + g.h : g.y + g.h / 2
          out.push(svg('rect', { class: `sl-handle sl-h-${h}`, 'data-k': k, 'data-h': h, x: x - s / 2, y: y - s / 2, width: s, height: s }))
        }
      }
      for (const g of guides) out.push('x' in g ? svg('line', { class: 'sl-guide', x1: g.x, y1: 0, x2: g.x, y2: P.HEIGHT }) : svg('line', { class: 'sl-guide', x1: 0, y1: g.y, x2: P.WIDTH, y2: g.y }))
      overlay.replaceChildren(...out)
      renderBar()
    }

    /** After the slide is drawn (web/decks.js): the overlay over it, at its size, with what is still selected. */
    function redraw() {
      const el = slideEl()
      if (overlay) overlay.remove()
      overlay = null
      scale = el && desktop() ? el.getBoundingClientRect().width / P.WIDTH : 0
      // the slide takes the keys and shows its handles over its edge only where it is edited
      stage.classList.toggle('sl-editing', scale > 0)
      if (scale) stage.tabIndex = 0
      else stage.removeAttribute('tabindex')
      if (!scale) { renderBar(); return }
      overlay = svg('svg', { class: 'sl-edit', viewBox: `0 0 ${P.WIDTH} ${P.HEIGHT}` })
      overlay.style.transform = el.style.transform
      stage.append(overlay)
      // what was selected and is gone from the text is no longer; another slide starts with nothing selected
      const n = slide() ? slide().n : 0
      sel = n === shown ? sel.filter(h => cm.getLineNumber(h) != null) : []
      shown = n
      showLive()
      draw()
    }

    /** A box or a line drawn where it is being dragged to: the slide's own element, moved. */
    function showLive() {
      for (const [k, g] of live) {
        const el = elOf(k), it = items()[k]
        if (!el || !it) continue
        if (it.kind === 'line') { el.outerHTML = P.itemHtml({ ...it, ...g }, k); continue }
        el.style.left = `${g.x}px`
        el.style.top = `${g.y}px`
        el.style.width = `${g.w}px`
        if (g.tall) el.style.height = `${g.h}px`
      }
    }

    // ---------------------------------------------------------------- the pointer

    const point = ev => { const r = slideEl().getBoundingClientRect(); return { x: (ev.clientX - r.left) / scale, y: (ev.clientY - r.top) / scale } }

    /** Where the others are, for one being dragged to fall in line with: the slide's edges and middle, the other boxes' edges and middles, the other lines' ends. */
    function targets(moving) {
      const xs = [0, P.WIDTH / 2, P.WIDTH], ys = [0, P.HEIGHT / 2, P.HEIGHT]
      items().forEach((it, k) => {
        if (moving.includes(k)) return
        const g = geom(k)
        if (!g) return
        if (it.kind === 'line') { xs.push(g.x1, g.x2); ys.push(g.y1, g.y2) } else { xs.push(g.x, g.x + g.w / 2, g.x + g.w); ys.push(g.y, g.y + g.h / 2, g.y + g.h) }
      })
      return { xs, ys }
    }

    stage.addEventListener('pointerdown', ev => {
      if (!overlay || ev.button !== 0) return
      const handle = ev.target.closest('.sl-handle'), hit = ev.target.closest('.sl-hit')
      if (!handle && !hit) {
        if (!ev.shiftKey && sel.length) select([])
        return
      }
      ev.preventDefault()
      stage.focus({ preventScroll: true })
      const k = Number((handle || hit).dataset.k)
      if (handle) drag = { type: items()[k].kind === 'line' ? 'end' : 'size', k, h: handle.dataset.h, ks: [k] }
      else {
        const ks = selected()
        if (ev.shiftKey) select(ks.includes(k) ? ks.filter(i => i !== k) : [...ks, k])
        else if (!ks.includes(k)) select([k])
        drag = { type: 'move', ks: selected() }
        if (!drag.ks.includes(k)) { drag = null; return }
      }
      Object.assign(drag, { id: ev.pointerId, px: ev.clientX, py: ev.clientY, at: point(ev), from: new Map(drag.ks.map(i => [i, geom(i)])), moved: false, ...targets(drag.ks) })
      stage.setPointerCapture(ev.pointerId)
    })

    stage.addEventListener('pointermove', ev => {
      if (!drag || ev.pointerId !== drag.id || !overlay) return
      if (!drag.moved && Math.hypot(ev.clientX - drag.px, ev.clientY - drag.py) < DRAG_PX) return
      drag.moved = true
      const p = point(ev), tol = ev.altKey ? -1 : SNAP_PX / scale
      let dx = p.x - drag.at.x, dy = p.y - drag.at.y
      guides = []
      const snapX = edges => { const s = E.snap(edges, drag.xs, tol); if (s.at != null) guides.push({ x: s.at }); return s.d }
      const snapY = edges => { const s = E.snap(edges, drag.ys, tol); if (s.at != null) guides.push({ y: s.at }); return s.d }
      live = new Map()
      if (drag.type === 'move') {
        const b = around([...drag.from.values()].filter(Boolean))
        dx += snapX([b.x + dx, b.x + dx + b.w / 2, b.x + dx + b.w])
        dy += snapY([b.y + dy, b.y + dy + b.h / 2, b.y + dy + b.h])
        const kept = E.keepOn({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h })
        dx = Math.round(kept.x - b.x)
        dy = Math.round(kept.y - b.y)
        for (const [k, g] of drag.from) {
          if (g) live.set(k, 'x1' in g ? { x1: g.x1 + dx, y1: g.y1 + dy, x2: g.x2 + dx, y2: g.y2 + dy } : { ...g, x: g.x + dx, y: g.y + dy })
        }
        drag.by = { dx, dy }
      } else if (drag.type === 'size') {
        const it = items()[drag.k], g = drag.from.get(drag.k), h = drag.h
        const keep = P.isFigure(it) || ev.shiftKey
        if (!keep) {
          if (h.includes('w')) dx += snapX([g.x + dx])
          if (h.includes('e')) dx += snapX([g.x + g.w + dx])
          if (h.includes('n')) dy += snapY([g.y + dy])
          if (h.includes('s')) dy += snapY([g.y + g.h + dy])
        }
        const r = E.resized(g, h, dx, dy, keep)
        // a box as high as its text takes a height once its top or bottom is dragged; one as high as its figure never does
        const tall = it.h != null || (!P.isFigure(it) && /[ns]/.test(h))
        live.set(drag.k, { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h), tall })
      } else {
        const g = drag.from.get(drag.k), a = drag.h === 'a'
        let x = (a ? g.x1 : g.x2) + dx, y = (a ? g.y1 : g.y2) + dy
        const ox = a ? g.x2 : g.x1, oy = a ? g.y2 : g.y1
        if (ev.shiftKey) {
          // straight, or at half a right angle, from its other end
          const len = Math.hypot(x - ox, y - oy), turn = Math.round(Math.atan2(y - oy, x - ox) / (Math.PI / 4)) * (Math.PI / 4)
          x = ox + len * Math.cos(turn)
          y = oy + len * Math.sin(turn)
        } else {
          x += snapX([x])
          y += snapY([y])
        }
        x = Math.round(x)
        y = Math.round(y)
        live.set(drag.k, a ? { x1: x, y1: y, x2: g.x2, y2: g.y2 } : { x1: g.x1, y1: g.y1, x2: x, y2: y })
      }
      showLive()
      draw()
    })

    function drop(ev, done) {
      if (!drag || ev.pointerId !== drag.id) return
      const d = drag, now = live
      drag = null
      live = new Map()
      guides = []
      if (stage.hasPointerCapture(ev.pointerId)) stage.releasePointerCapture(ev.pointerId)
      if (!d.moved || !done) { if (d.moved) redrawSlide(); else draw(); return }
      const its = items(), ls = lines(), edits = []
      if (d.type === 'move') {
        if (d.by && (d.by.dx || d.by.dy)) for (const k of d.ks) if (its[k] && d.from.get(k)) edits.push(E.set(ls, its[k], E.at(its[k], d.by.dx, d.by.dy)))
      } else if (d.type === 'size') {
        const it = its[d.k], g = now.get(d.k), changes = {}
        for (const key of ['x', 'y', 'w']) if (g[key] !== it[key]) changes[key] = g[key]
        if (g.tall && g.h !== it.h) changes.h = g.h
        if (Object.keys(changes).length) edits.push(E.set(ls, it, changes))
      } else {
        const it = its[d.k], g = now.get(d.k)
        const changes = d.h === 'a' ? { from: `${g.x1} ${g.y1}` } : { to: `${g.x2} ${g.y2}` }
        if (d.h === 'a' ? g.x1 !== it.x1 || g.y1 !== it.y1 : g.x2 !== it.x2 || g.y2 !== it.y2) edits.push(E.set(ls, it, changes))
      }
      if (edits.length) apply(edits)
      else redrawSlide()
    }
    stage.addEventListener('pointerup', ev => drop(ev, true))
    stage.addEventListener('pointercancel', ev => drop(ev, false))

    /** The slide drawn again from the text as it is: what a drag showed and did not write is gone. */
    let redrawSlide = () => {}

    // ---------------------------------------------------------------- the keys, the clipboard

    stage.addEventListener('keydown', ev => {
      if (!overlay || ev.target !== stage) return
      const mod = ev.ctrlKey || ev.metaKey, key = ev.key
      const used = () => { ev.preventDefault(); ev.stopPropagation() }
      if (mod && key.toLowerCase() === 'z') { used(); if (ev.shiftKey) cm.redo(); else cm.undo(); return }
      if (mod && key.toLowerCase() === 'y') { used(); cm.redo(); return }
      if (!selected().length) return
      const step = ev.shiftKey ? 10 : 1
      if (key === 'ArrowLeft') { used(); nudge(-step, 0) }
      else if (key === 'ArrowRight') { used(); nudge(step, 0) }
      else if (key === 'ArrowUp') { used(); nudge(0, -step) }
      else if (key === 'ArrowDown') { used(); nudge(0, step) }
      else if (key === 'Delete' || key === 'Backspace') { used(); remove() }
      else if (mod && key.toLowerCase() === 'd') { used(); duplicate() }
      else if (mod && key === ']') { used(); order(1, ev.shiftKey) }
      else if (mod && key === '[') { used(); order(-1, ev.shiftKey) }
      else if (key === 'Escape') { used(); select([]) }
    })

    // copied as text, so pasted on another slide, in another deck, or in any editor (the page's
    // events: a browser sends them to the body when no text is selected)
    const mine = ev => overlay && document.activeElement === stage && ev.clipboardData
    document.addEventListener('copy', ev => {
      const ks = selected()
      if (!mine(ev) || !ks.length) return
      ev.clipboardData.setData('text/plain', textOf(ks))
      ev.preventDefault()
    })
    document.addEventListener('cut', ev => {
      const ks = selected()
      if (!mine(ev) || !ks.length) return
      ev.clipboardData.setData('text/plain', textOf(ks))
      ev.preventDefault()
      remove()
    })
    document.addEventListener('paste', ev => {
      if (mine(ev) && paste(ev.clipboardData.getData('text/plain'))) ev.preventDefault()
    })

    // the cursor in a box's or a line's text selects it on the slide
    cm.on('cursorActivity', () => {
      if (syncing || !overlay || !cm.hasFocus()) return
      const line = cm.getCursor().line
      const k = items().findIndex(i => line >= i.from && line < i.to)
      const ks = selected()
      if (k >= 0 ? ks.length !== 1 || ks[0] !== k : ks.length) select(k >= 0 ? [k] : [], false)
    })

    // ---------------------------------------------------------------- the bar above the slide

    const buttons = {}
    function button(name, title, run, group) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'icon-btn'
      b.title = title
      b.setAttribute('aria-label', title)
      b.dataset.tool = name
      b.innerHTML = icon(name)
      b.addEventListener('click', () => { run(); if (name !== 'text') stage.focus({ preventScroll: true }) })
      group.append(b)
      buttons[name] = b
      return b
    }
    const group = label => {
      const g = document.createElement('span')
      g.className = 'sl-tool-group'
      g.setAttribute('role', 'group')
      g.setAttribute('aria-label', label)
      bar.append(g)
      return g
    }

    function showText(on) {
      body.classList.toggle('no-text', !on)
      buttons.text.setAttribute('aria-pressed', String(on))
      store.set('slText', on)
      cm.refresh()
    }

    if (bar) {
      const view = group('View')
      button('text', 'The deck\'s text beside the slide (click: hide it, or show it again)', () => showText(body.classList.contains('no-text')), view)
      const arrange = group('Arrange')
      button('forward', 'In front of the next one (Ctrl+]; with Shift, of all)', () => order(1), arrange)
      button('back', 'Behind the one before (Ctrl+[; with Shift, of all)', () => order(-1), arrange)
      button('duplicate', 'Duplicate (Ctrl+D)', duplicate, arrange)
      button('remove', 'Delete (Del)', remove, arrange)
      showText(store.get('slText', true) !== false)
    }

    function renderBar() {
      if (!bar) return
      bar.hidden = !slideEl() || !desktop()
      const n = overlay ? selected().length : 0
      buttons.forward.disabled = buttons.back.disabled = n !== 1
      buttons.duplicate.disabled = buttons.remove.disabled = !n
    }

    return {
      redraw,
      /** How the slide is drawn again from the text (web/decks.js's own drawing). */
      onRedraw(fn) { redrawSlide = fn },
      selected,
      select,
    }
  }

  root.RftSlideTools = { mount }
})(typeof globalThis !== 'undefined' ? globalThis : window)
