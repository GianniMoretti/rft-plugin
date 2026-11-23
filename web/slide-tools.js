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
  const DOUBLE_MS = 450 // two presses within this are a double click

  const ICONS = {
    text: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M7 3v10M3.8 6h1.6M3.8 8.5h1.6"/>',
    forward: '<rect x="2" y="6" width="8" height="8" rx="1"/><rect x="6" y="2" width="8" height="8" rx="1" fill="currentColor"/>',
    back: '<rect x="6" y="2" width="8" height="8" rx="1"/><rect x="2" y="6" width="8" height="8" rx="1" fill="currentColor"/>',
    duplicate: '<rect x="2" y="2" width="8" height="8" rx="1"/><rect x="6" y="6" width="8" height="8" rx="1"/>',
    remove: '<path d="M3 4.5h10M6.2 4.5V2.8h3.6v1.7M4.4 4.5l.6 8.7h6l.6-8.7M6.8 7v3.8M9.2 7v3.8"/>',
    addText: '<path d="M3 4.5V3h10v1.5M8 3v10M6 13h4"/>',
    rect: '<rect x="2.5" y="4" width="11" height="8" rx="1"/>',
    ellipse: '<ellipse cx="8" cy="8" rx="5.5" ry="4"/>',
    line: '<path d="M3 13L13 3"/>',
    arrow: '<path d="M3 13L13 3M7.5 3H13v5.5"/>',
    left: '<path d="M2.5 4h11M2.5 8h7M2.5 12h9"/>',
    center: '<path d="M2.5 4h11M4.5 8h7M3.5 12h9"/>',
    right: '<path d="M2.5 4h11M6.5 8h7M4.5 12h9"/>',
    top: '<path d="M2.5 3h11"/><rect x="5.5" y="5.5" width="5" height="6" rx="1"/>',
    middle: '<path d="M2 8h2M12 8h2"/><rect x="5.5" y="5" width="5" height="6" rx="1"/>',
    bottom: '<path d="M2.5 13h11"/><rect x="5.5" y="4.5" width="5" height="6" rx="1"/>',
    fit: '<path d="M3 2.5h10M3 13.5h10M8 5v6M6.2 6.8L8 5l1.8 1.8M6.2 9.2L8 11l1.8-1.8"/>',
    fill: '<rect class="sl-ink" x="3" y="3" width="10" height="10" rx="1.5" stroke="none"/><rect x="3" y="3" width="10" height="10" rx="1.5" stroke-width="1"/>',
    outline: '<rect class="sl-ink-line" x="3.5" y="3.5" width="9" height="9" rx="1" stroke-width="2.5"/>',
    color: '<path d="M4.5 10.5L8 2.5l3.5 8M5.8 8h4.4" stroke-width="1.6"/><path class="sl-ink-line" d="M3 13.5h10" stroke-width="2.5"/>',
  }
  const icon = name => (ICONS[name] ? `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>` : '')
  /** What each tool that adds puts on the slide when the slide is only clicked: its size, in the slide's units. */
  const NEW = { addText: { w: 480 }, rect: { w: 320, h: 200 }, ellipse: { w: 320, h: 200 }, line: { w: 300 }, arrow: { w: 300 } }
  const NEW_TEXT = 'Text'
  const HEX_RE = /^#[0-9a-f]{6}$/i

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
    let armed = '' // the tool that adds, waiting for where: the next press on the slide is its
    let editing = null // a box's Markdown open over it: { handle (its line in the text), ta, layer }
    let menu = null // the colours open under their button
    let lastPress = null // the last press on a box or a line: { k, t, x, y }

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

    /**
     * Options changed on those selected of `kinds` (a box's fill, a line's arrow): each one's own
     * line. An outline's weight on a box with no outline gives it one, in the text's colour.
     */
    function style(changes, kinds = ['box', 'line']) {
      const its = items(), ls = lines()
      const edits = selected().filter(k => kinds.includes(its[k].kind)).map(k => {
        const it = its[k]
        return E.set(ls, it, changes.weight && it.kind === 'box' && !it.outline ? { outline: 'text', ...changes } : changes)
      })
      if (edits.length) apply(edits)
    }

    // ---------------------------------------------------------------- a box's Markdown, edited over it

    const grow = () => { const ta = editing.ta; ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px` }

    /** The editor laid over its box, at the slide's size; the box's own text hidden under it. */
    function layEditor() {
      const el = slideEl(), line = cm.getLineNumber(editing.handle)
      const k = items().findIndex(i => i.from === line)
      const box = k < 0 ? null : elOf(k)
      if (!el || !box) { const e = editing; editing = null; e.layer.remove(); return }
      const g = geom(k), cs = getComputedStyle(box), ta = editing.ta
      Object.assign(ta.style, { left: `${g.x}px`, top: `${g.y}px`, width: `${g.w}px`, minHeight: `${Math.max(g.h, 64)}px`, fontSize: cs.fontSize, fontFamily: cs.fontFamily, lineHeight: cs.lineHeight, textAlign: cs.textAlign })
      editing.layer.style.transform = el.style.transform
      if (editing.layer.parentNode !== stage) stage.append(editing.layer)
      const text = box.querySelector('.slide-box-text')
      if (text) text.style.visibility = 'hidden'
      if (editing.kept) { ta.focus({ preventScroll: true }); ta.setSelectionRange(...editing.kept); editing.kept = null }
    }

    /** Opens the Markdown of box `k` over it (`all`: selected, to be typed over). Esc, or a click outside, draws it again. */
    function edit(k, all = false) {
      const it = items()[k]
      if (!it || it.kind !== 'box' || !elOf(k)) return
      commit()
      select([k])
      const layer = document.createElement('div')
      layer.className = 'sl-layer'
      const ta = document.createElement('textarea')
      ta.className = 'sl-source'
      ta.spellcheck = false
      ta.value = it.content
      ta.setAttribute('aria-label', 'The box\'s Markdown')
      layer.append(ta)
      editing = { handle: cm.getLineHandle(it.from), ta, layer }
      ta.addEventListener('input', grow)
      ta.addEventListener('blur', () => commit())
      ta.addEventListener('keydown', ev => {
        const mod = ev.ctrlKey || ev.metaKey
        ev.stopPropagation()
        if (ev.key === 'Escape' || (mod && ev.key === 'Enter')) { ev.preventDefault(); commit(); stage.focus({ preventScroll: true }) }
        else if (mod && ev.key.toLowerCase() === 'b') { ev.preventDefault(); wrap('**') }
        else if (mod && ev.key.toLowerCase() === 'i') { ev.preventDefault(); wrap('*') }
      })
      layEditor()
      if (!editing) return
      ta.focus({ preventScroll: true })
      if (all) ta.select()
      grow()
      renderBar()
    }

    /** The editor closed and its text written as the box's: a box of text left empty is removed; a shape's first label sits in its middle. */
    function commit() {
      if (!editing) return
      const e = editing
      editing = null
      e.layer.remove()
      const line = cm.getLineNumber(e.handle)
      const it = items().find(i => i.from === line), ls = lines()
      const value = e.ta.value.replace(/\s+$/, '')
      if (!it || value === it.content) { redrawSlide(); return }
      if (!value && !it.fill && !it.outline) { sel = []; apply(E.removed(ls, [it])); return }
      const edits = [E.content(ls, it, value)]
      if (!it.content && it.h && (it.fill || it.outline) && !it.align && !it.valign) edits.push(E.set(ls, it, { align: 'center', valign: 'middle' }))
      apply(edits)
    }

    /** The source selected in the editor put between `mark`s (`**`, `*`), or taken out of them. */
    function wrap(mark) {
      if (!editing) return
      const ta = editing.ta, a = ta.selectionStart, b = ta.selectionEnd, v = ta.value, n = mark.length
      // the stars it is between already: two or three are bold, one or three italic
      const stars = Math.min(/\**$/.exec(v.slice(0, a))[0].length, /^\**/.exec(v.slice(b))[0].length)
      if (n === 2 ? stars >= 2 : stars % 2 === 1) {
        ta.value = v.slice(0, a - n) + v.slice(a, b) + v.slice(b + n)
        ta.setSelectionRange(a - n, b - n)
      } else {
        ta.value = v.slice(0, a) + mark + v.slice(a, b) + mark + v.slice(b)
        ta.setSelectionRange(a + n, b + n)
      }
      grow()
    }

    // ---------------------------------------------------------------- a tool that adds

    function arm(tool) {
      armed = armed === tool ? '' : tool
      stage.classList.toggle('sl-armed', !!armed)
      renderBar()
    }

    /** What the armed tool makes of a press at `a` let go at `b` (the slide only clicked: its usual size there). */
    function made(tool, a, b, dragged) {
      const n = NEW[tool]
      if (tool === 'line' || tool === 'arrow') {
        const to = dragged ? b : { x: a.x + n.w, y: a.y }
        return E.newLine({ from: `${a.x} ${a.y}`, to: `${to.x} ${to.y}`, arrow: tool === 'arrow' ? 'end' : null })
      }
      const x = dragged ? Math.min(a.x, b.x) : tool === 'addText' ? a.x : Math.round(a.x - n.w / 2)
      const y = dragged ? Math.min(a.y, b.y) : tool === 'addText' ? a.y : Math.round(a.y - n.h / 2)
      const w = dragged ? Math.max(E.SMALLEST, Math.abs(b.x - a.x)) : n.w, h = dragged ? Math.max(E.SMALLEST, Math.abs(b.y - a.y)) : n.h
      // a box of text has a width only: its height is its text's
      if (tool === 'addText') return E.newBox({ x, y, w }, NEW_TEXT)
      return E.newBox({ shape: tool === 'ellipse' ? 'ellipse' : null, x, y, w, h, outline: 'text' })
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
      // text longer than its box stays in view, and is marked here only: not in the presentation, nor in the PDF
      its.forEach((it, k) => {
        const el = it.kind === 'box' && it.h && !live.has(k) ? elOf(k) : null
        const text = el ? el.querySelector('.slide-box-text') : null
        if (!text || P.isFigure(it) || text.offsetHeight <= el.clientHeight + 1) return
        const g = geom(k), s = 16 * u
        const mark = svg('g', { class: 'sl-warn', transform: `translate(${g.x + g.w - s * 1.2} ${g.y + g.h - s * 1.2})` })
        const title = svg('title', {})
        title.textContent = 'The text is longer than its box (it is never shrunk to fit): drag the box\'s bottom, or let its height follow its text'
        mark.append(title, svg('path', { d: `M${s / 2} 0L${s} ${s}H0Z` }), svg('path', { class: 'sl-warn-mark', d: `M${s / 2} ${s * 0.38}V${s * 0.66}M${s / 2} ${s * 0.8}V${s * 0.84}`, 'stroke-width': 1.6 * u }))
        out.push(mark)
      })
      for (const g of guides) out.push('x' in g ? svg('line', { class: 'sl-guide', x1: g.x, y1: 0, x2: g.x, y2: P.HEIGHT }) : svg('line', { class: 'sl-guide', x1: 0, y1: g.y, x2: P.WIDTH, y2: g.y }))
      // what a tool that adds is being dragged out to
      if (drag && drag.type === 'draw' && drag.to) {
        const a = drag.at, b = drag.to
        if (drag.tool === 'line' || drag.tool === 'arrow') out.push(svg('line', { class: 'sl-frame', x1: a.x, y1: a.y, x2: b.x, y2: b.y }))
        else if (drag.tool === 'ellipse') out.push(svg('ellipse', { class: 'sl-frame', cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, rx: Math.abs(b.x - a.x) / 2, ry: Math.abs(b.y - a.y) / 2 }))
        else out.push(svg('rect', { class: 'sl-frame', x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: drag.tool === 'addText' ? 60 : Math.abs(b.y - a.y) }))
      }
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
      if (editing) layEditor()
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
      // a press outside the editor closes it, and does no more
      if (editing) { if (!editing.layer.contains(ev.target)) { ev.preventDefault(); commit(); stage.focus({ preventScroll: true }) } return }
      if (armed) {
        ev.preventDefault()
        stage.focus({ preventScroll: true })
        const p = point(ev)
        drag = { type: 'draw', tool: armed, ks: [], id: ev.pointerId, px: ev.clientX, py: ev.clientY, at: { x: Math.round(p.x), y: Math.round(p.y) }, from: new Map(), moved: false, ...targets([]) }
        stage.setPointerCapture(ev.pointerId)
        return
      }
      const handle = ev.target.closest('.sl-handle'), hit = ev.target.closest('.sl-hit')
      if (!handle && !hit) {
        if (!ev.shiftKey && sel.length) select([])
        return
      }
      ev.preventDefault()
      stage.focus({ preventScroll: true })
      const k = Number((handle || hit).dataset.k)
      // a second press on a box soon after the first opens its Markdown over it (the browser's own
      // double click goes to the slide, which holds the pointer, not to the box)
      const twice = hit && lastPress && lastPress.k === k && ev.timeStamp - lastPress.t < DOUBLE_MS && Math.hypot(ev.clientX - lastPress.x, ev.clientY - lastPress.y) < 5
      lastPress = hit ? { k, t: ev.timeStamp, x: ev.clientX, y: ev.clientY } : null
      if (twice) lastPress = null
      if (handle) drag = { type: items()[k].kind === 'line' ? 'end' : 'size', k, h: handle.dataset.h, ks: [k] }
      else {
        const ks = selected()
        if (ev.shiftKey) select(ks.includes(k) ? ks.filter(i => i !== k) : [...ks, k])
        else if (!ks.includes(k)) select([k])
        drag = { type: 'move', ks: selected() }
        if (!drag.ks.includes(k)) { drag = null; return }
      }
      Object.assign(drag, { id: ev.pointerId, px: ev.clientX, py: ev.clientY, at: point(ev), from: new Map(drag.ks.map(i => [i, geom(i)])), moved: false, twice: twice && !ev.shiftKey ? k : -1, ...targets(drag.ks) })
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
      if (drag.type === 'draw') {
        let x = p.x, y = p.y
        const a = drag.at, straight = drag.tool === 'line' || drag.tool === 'arrow'
        if (ev.shiftKey && straight) {
          const len = Math.hypot(x - a.x, y - a.y), turn = Math.round(Math.atan2(y - a.y, x - a.x) / (Math.PI / 4)) * (Math.PI / 4)
          x = a.x + len * Math.cos(turn)
          y = a.y + len * Math.sin(turn)
        } else if (ev.shiftKey) {
          // a square, a circle
          const side = Math.max(Math.abs(x - a.x), Math.abs(y - a.y))
          x = a.x + Math.sign(x - a.x) * side
          y = a.y + Math.sign(y - a.y) * side
        } else {
          x += snapX([x])
          y += snapY([y])
        }
        drag.to = { x: Math.round(x), y: Math.round(y) }
      } else if (drag.type === 'move') {
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
      if (d.type === 'draw') {
        if (!done) { draw(); return }
        const tool = d.tool
        arm('')
        add([made(tool, d.at, d.to, d.moved && !!d.to)])
        if (tool === 'addText') edit(selected()[0], true)
        return
      }
      if (!d.moved || !done) {
        if (d.moved) redrawSlide()
        else if (done && d.twice >= 0 && items()[d.twice] && items()[d.twice].kind === 'box') edit(d.twice) // pressed twice and let go: a double click
        else draw()
        return
      }
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
      if (key === 'Escape' && armed) { used(); arm(''); return }
      if (!selected().length) return
      if (key === 'Enter' && selected().length === 1 && items()[selected()[0]].kind === 'box') { used(); edit(selected()[0]); return }
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
      // the slide keeps the keys after a tool is used, unless the tool opened something of its own (a box's Markdown, the colours)
      b.addEventListener('click', () => { run(); if (name !== 'text' && !editing && !menu) stage.focus({ preventScroll: true }) })
      group.append(b)
      buttons[name] = b
      return b
    }
    /** A tool with a letter for its icon (bold, italic). */
    const lettered = (name, letter, title, run, g) => { const b = button(name, title, run, g); b.textContent = letter; b.classList.add(`sl-letter-${name}`); return b }

    /** The first selected of `kinds`, which the bar shows the style of. */
    const shownItem = kinds => { const its = items(); const k = selected().find(i => kinds.includes(its[i].kind)); return k == null ? null : its[k] }

    /** The colours (none, the project's tokens, one of your own) under button `name`; `pick(colour)` takes one, '' for none. */
    function colours(name, pick) {
      const open = menu && menu.dataset.for === name
      closeMenu()
      if (open) return
      const b = buttons[name]
      menu = document.createElement('div')
      menu.className = 'sl-menu'
      menu.dataset.for = name
      menu.setAttribute('role', 'menu')
      const swatch = (c, title) => {
        const s = document.createElement('button')
        s.type = 'button'
        s.className = `sl-swatch${c ? '' : ' none'}`
        s.title = title
        s.setAttribute('aria-label', title)
        s.dataset.color = c
        if (c) s.style.background = `var(--slide-c-${c})`
        s.addEventListener('click', () => { closeMenu(); pick(c); stage.focus({ preventScroll: true }) })
        return s
      }
      const hex = document.createElement('input')
      hex.type = 'text'
      hex.className = 'sl-hex'
      hex.placeholder = '#rrggbb'
      hex.maxLength = 7
      hex.setAttribute('aria-label', 'A colour of your own, as #rrggbb')
      hex.title = 'A colour of your own, as #rrggbb (Enter)'
      hex.addEventListener('keydown', ev => {
        ev.stopPropagation()
        if (ev.key === 'Escape') { closeMenu(); stage.focus({ preventScroll: true }) }
        if (ev.key !== 'Enter') return
        if (!HEX_RE.test(hex.value.trim())) { hex.classList.add('bad'); return }
        const c = hex.value.trim()
        closeMenu()
        pick(c)
        stage.focus({ preventScroll: true })
      })
      menu.append(swatch('', 'None'), ...P.COLORS.map(c => swatch(c, c)), hex)
      menu.style.left = `${b.offsetLeft}px`
      menu.style.top = `${b.offsetTop + b.offsetHeight + 4}px`
      bar.append(menu)
    }
    function closeMenu() {
      if (menu) menu.remove()
      menu = null
    }
    document.addEventListener('pointerdown', ev => {
      const tool = ev.target.closest && ev.target.closest('[data-tool]')
      if (menu && !menu.contains(ev.target) && !(tool && tool.dataset.tool === menu.dataset.for)) closeMenu()
    }, true)
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
      const adds = group('Add')
      const where = 'then drag on the slide, or click it'
      button('addText', `Text: ${where}`, () => arm('addText'), adds)
      button('rect', `Rectangle: ${where} (Shift: a square)`, () => arm('rect'), adds)
      button('ellipse', `Ellipse: ${where} (Shift: a circle)`, () => arm('ellipse'), adds)
      button('line', `Line: ${where} (Shift: straight, or at 45°)`, () => arm('line'), adds)
      button('arrow', `Arrow: ${where}`, () => arm('arrow'), adds)
      const paint = group('Colours')
      button('fill', 'Fill', () => colours('fill', c => style({ fill: c || null }, ['box'])), paint)
      button('outline', 'Outline, or a line\'s colour', () => colours('outline', c => style({ outline: c || null })), paint)
      const weight = document.createElement('select')
      weight.dataset.tool = 'weight'
      weight.title = 'The outline\'s, or the line\'s, weight'
      weight.setAttribute('aria-label', weight.title)
      weight.append(new Option('Thin', 'thin'), new Option('Medium', 'medium'), new Option('Thick', 'thick'))
      weight.addEventListener('change', () => { style({ weight: weight.value }); stage.focus({ preventScroll: true }) })
      const ends = document.createElement('select')
      ends.dataset.tool = 'ends'
      ends.title = 'The line\'s arrow'
      ends.setAttribute('aria-label', ends.title)
      ends.append(new Option('No arrow', ''), new Option('Arrow at its end', 'end'), new Option('Arrow at its start', 'start'), new Option('Arrows at both', 'both'))
      ends.addEventListener('change', () => { style({ arrow: ends.value || null }, ['line']); stage.focus({ preventScroll: true }) })
      paint.append(weight, ends)
      Object.assign(buttons, { weight, ends })
      const type = group('Text')
      button('color', 'The text\'s colour', () => colours('color', c => style({ color: c || null }, ['box'])), type)
      const size = document.createElement('input')
      size.type = 'number'
      size.min = '8'
      size.max = '400'
      size.dataset.tool = 'size'
      size.className = 'sl-size'
      size.placeholder = 'size'
      size.title = 'The text\'s size, in the slide\'s units (the layout\'s body is 40); empty: the layout\'s'
      size.setAttribute('aria-label', 'The text\'s size')
      const setSize = () => { const v = Math.round(Number(size.value)); style({ size: size.value.trim() && v >= 8 && v <= 400 ? v : null }, ['box']) }
      size.addEventListener('change', setSize)
      size.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); size.blur(); stage.focus({ preventScroll: true }) } })
      type.append(size)
      buttons.size = size
      lettered('bold', 'B', 'Bold: ** around what is selected of the box\'s Markdown (Ctrl+B), while it is open', () => wrap('**'), type)
      lettered('italic', 'I', 'Italic: * around what is selected of the box\'s Markdown (Ctrl+I), while it is open', () => wrap('*'), type)
      const toggled = (key, value) => () => { const it = shownItem(['box']); style({ [key]: it && it[key] === value ? null : value }, ['box']) }
      for (const a of ['left', 'center', 'right']) button(a, `The text to the ${a === 'center' ? 'middle' : a} of its box`, toggled('align', a), type)
      for (const a of ['top', 'middle', 'bottom']) button(a, `The text at the ${a} of its box (a box with a height)`, toggled('valign', a), type)
      button('fit', 'The box as high as its text: its height is no longer fixed', () => style({ h: null }, ['box']), type)
      // a tool used while a box's Markdown is open leaves it open
      bar.addEventListener('mousedown', ev => { if (editing && ev.target.closest('button')) ev.preventDefault() })
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
      for (const t of Object.keys(NEW)) buttons[t].setAttribute('aria-pressed', String(armed === t))
      // the style of the first box selected, and of the first line
      const box = n ? shownItem(['box']) : null, line = n ? shownItem(['line']) : null, any = box || line
      const ink = (name, c) => {
        const b = buttons[name]
        b.style.setProperty('--ink', !c ? 'transparent' : P.COLORS.includes(c) ? `var(--slide-c-${c})` : c)
        b.classList.toggle('no-ink', !c)
      }
      ink('fill', box ? box.fill : '')
      ink('outline', any ? any.outline || (line && !box ? 'text' : '') : '')
      ink('color', box ? box.color || 'text' : '')
      buttons.fill.disabled = buttons.color.disabled = buttons.size.disabled = !box
      buttons.outline.disabled = buttons.weight.disabled = !any
      buttons.weight.value = (any && any.weight) || 'medium'
      buttons.ends.disabled = !line
      buttons.ends.value = line ? line.arrow : ''
      if (document.activeElement !== buttons.size) buttons.size.value = box && box.size ? String(box.size) : ''
      for (const a of ['left', 'center', 'right']) { buttons[a].disabled = !box; buttons[a].setAttribute('aria-pressed', String(!!box && box.align === a)) }
      for (const a of ['top', 'middle', 'bottom']) { buttons[a].disabled = !box || !box.h; buttons[a].setAttribute('aria-pressed', String(!!box && box.valign === a)) }
      buttons.fit.disabled = !box || !box.h || !box.content.trim()
      buttons.bold.disabled = buttons.italic.disabled = !editing
    }

    return {
      redraw,
      /** Before the slide is drawn again: a box's Markdown open over it is set aside, to be laid over it again. */
      beforeDraw() {
        if (!editing || !editing.layer.isConnected) return
        const ta = editing.ta
        editing.kept = document.activeElement === ta ? [ta.selectionStart, ta.selectionEnd] : null
        const e = editing
        editing = null // its blur, should the browser send one, is not the user's
        e.layer.remove()
        editing = e
      },
      /** How the slide is drawn again from the text (web/decks.js's own drawing). */
      onRedraw(fn) { redrawSlide = fn },
      selected,
      select,
    }
  }

  root.RftSlideTools = { mount }
})(typeof globalThis !== 'undefined' ? globalThis : window)
