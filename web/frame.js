// rft artifact frame: the runtime inside a concept's artifact, which the tree view shows in a
// sandboxed frame (served by api/artifact, or as the standalone page's srcdoc). A click on a note
// link (`#E05`, or an element with data-note="E05") asks the page that frames it to open the note;
// a web link opens in a new tab. It says where it is scrolled to, so the page can bring it back
// there, and takes from the page its theme and how each note link is marked (its status,
// superseded, or missing). Each SVG figure gets a button that downloads it as a PDF (the page
// makes it), each table one that copies it as a LaTeX table float (web/latex.js, loaded before
// this). It reaches nothing else: the frame has no network and no storage.
(function () {
  'use strict'

  const NOTE = /^#([EDRT]\d+)$/
  const send = msg => { try { parent.postMessage(Object.assign({ rft: 'artifact' }, msg), '*') } catch (e) { /* no page around it */ } }
  const noteOf = el => {
    const id = el.getAttribute('data-note')
    if (id && /^[EDRT]\d+$/.test(id)) return id
    const m = NOTE.exec(el.getAttribute('href') || '')
    return m ? m[1] : null
  }
  const links = () => [...document.querySelectorAll('a[href], [data-note]')].filter(noteOf)

  document.addEventListener('click', ev => {
    const el = ev.target && ev.target.closest ? ev.target.closest('a[href], [data-note]') : null
    if (!el || el.closest('.rft-tools')) return
    const id = noteOf(el)
    if (id) {
      ev.preventDefault()
      send({ type: 'go', id })
      return
    }
    const href = el.getAttribute('href') || ''
    if (/^(https?:|mailto:)/i.test(href)) {
      ev.preventDefault()
      window.open(href, '_blank', 'noopener')
    }
  })

  let marks = null // id → { cls, title }, once the page sent them; a link to no note in it is marked missing
  function decorate() {
    if (!marks) return
    for (const el of links()) {
      const id = noteOf(el)
      const m = marks[id] || { cls: 'rft-note missing', title: `No note ${id} in the tree` }
      el.classList.forEach(c => { if (c === 'rft-note' || c === 'missing' || c === 'superseded' || c.startsWith('s-') || c.startsWith('r-')) el.classList.remove(c) })
      for (const c of m.cls.split(' ')) if (c) el.classList.add(c)
      el.title = m.title
    }
  }

  // ---------------------------------------------------------------- a figure as PDF, a table as LaTeX

  let caps = null // what the page around offers ({ pdf }), once it said
  const layer = document.createElement('div')
  layer.className = 'rft-tools-layer'
  let tools = [] // [what it serves, its bar of buttons]
  let tickets = 0
  const waiting = new Map() // ticket → the button that waits for the page's answer

  function flash(button, text) {
    const was = button.dataset.label
    button.textContent = text
    setTimeout(() => { button.textContent = was }, 1600)
  }

  /** What a cell or caption says, as runs of text with their bold, italic, super- and subscripts. */
  function runsOf(node, flags = {}, out = []) {
    for (const ch of node.childNodes) {
      if (ch.nodeType === 3) { out.push({ text: ch.nodeValue, ...flags }); continue }
      if (ch.nodeType !== 1) continue
      const tag = ch.tagName.toLowerCase()
      if (tag === 'br') { out.push({ text: ' ', ...flags }); continue }
      if (tag === 'script' || tag === 'style') continue
      const f = { ...flags }
      if (tag === 'b' || tag === 'strong') f.b = true
      if (tag === 'i' || tag === 'em') f.i = true
      if (tag === 'sup') f.sup = true
      if (tag === 'sub') f.sub = true
      runsOf(ch, f, out)
    }
    return out
  }

  /** The caption of a table: its <caption>, its figure's <figcaption>, else the nearest heading above it. */
  function captionOf(table) {
    if (table.caption && table.caption.textContent.trim()) return table.caption.textContent
    const fig = table.closest('figure')
    const fc = fig && fig.querySelector('figcaption')
    if (fc && fc.textContent.trim()) return fc.textContent
    for (let el = table; el && el !== document.body; el = el.parentElement) {
      for (let s = el.previousElementSibling; s; s = s.previousElementSibling) {
        if (/^H[1-6]$/.test(s.tagName)) return s.textContent
        const h = s.querySelectorAll && [...s.querySelectorAll('h1, h2, h3, h4, h5, h6')].pop()
        if (h) return h.textContent
      }
    }
    return ''
  }

  function tableData(table) {
    return {
      caption: captionOf(table),
      rows: [...table.rows].map(tr => ({
        header: tr.parentElement.tagName === 'THEAD' || [...tr.cells].every(c => c.tagName === 'TH'),
        cells: [...tr.cells].map(c => ({ runs: runsOf(c), span: c.colSpan || 1, align: /right|end/.test(getComputedStyle(c).textAlign) ? 'r' : '' })),
      })),
    }
  }

  const slug = text => (String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z0-9]+/g) || []).slice(0, 8).join('-')

  /** An SVG figure's file name for its PDF: its own file's, else its caption's, label's or id's words. */
  function nameOf(el, n) {
    const src = el.getAttribute('data-rft-src')
    if (src) return src.split(/[\\/]/).pop().replace(/\.svg$/i, '') || `figure-${n}`
    const fig = el.closest('figure')
    const fc = fig && fig.querySelector('figcaption')
    return slug(fc && fc.textContent) || slug(el.getAttribute('aria-label')) || slug(el.id) || `figure-${n}`
  }

  // the properties an inline chart takes from the page's style sheet, written onto it so its PDF has them
  const STYLE = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap',
    'stroke-linejoin', 'opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline', 'visibility', 'display']

  /** The SVG source of a figure: an image's (inside the page as a data: image), or an inline chart's with its style written on it. */
  function svgSourceOf(el) {
    if (el.tagName === 'IMG') {
      const m = /^data:image\/svg\+xml(;charset=[^;,]*)?(;base64)?,(.*)$/is.exec(el.getAttribute('src') || '')
      if (!m) return null
      if (!m[2]) return decodeURIComponent(m[3])
      const bytes = Uint8Array.from(atob(m[3]), c => c.charCodeAt(0))
      return new TextDecoder('utf-8').decode(bytes)
    }
    const copy = el.cloneNode(true)
    const from = [el, ...el.querySelectorAll('*')]
    const to = [copy, ...copy.querySelectorAll('*')]
    from.forEach((o, k) => {
      const cs = getComputedStyle(o)
      to[k].setAttribute('style', STYLE.map(p => `${p}:${cs.getPropertyValue(p)}`).join(';'))
    })
    const box = el.getBoundingClientRect()
    if (!copy.getAttribute('width')) copy.setAttribute('width', `${Math.round(box.width)}`)
    if (!copy.getAttribute('height')) copy.setAttribute('height', `${Math.round(box.height)}`)
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    return new XMLSerializer().serializeToString(copy)
  }

  /** The figures that get a PDF button: SVG images, and inline charts that are not icons. */
  function figures() {
    const imgs = [...document.images].filter(i => /^data:image\/svg\+xml/i.test(i.getAttribute('src') || ''))
    const charts = [...document.querySelectorAll('svg')].filter(s => {
      if (s.parentElement && s.parentElement.closest('svg, a, button, .rft-tools')) return false
      const b = s.getBoundingClientRect()
      return b.width >= 80 && b.height >= 40
    })
    return [...imgs, ...charts]
  }

  function button(label, title, run) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = label
    b.dataset.label = label
    b.title = title
    b.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); run(b) })
    return b
  }

  function ask(b, msg) {
    const ticket = ++tickets
    waiting.set(ticket, b)
    b.disabled = true
    send({ ...msg, ticket })
  }

  async function copyLatex(table, b) {
    // a table whose notebook typeset it (data-latex) is copied as that, the others as read from their cells
    const own = table.getAttribute('data-latex')
    const text = own && own.trim() ? window.RftLatex.floatAround(captionOf(table), own) : window.RftLatex.tableFloat(tableData(table))
    try {
      await navigator.clipboard.writeText(text)
      flash(b, 'Copied')
    } catch (e) {
      ask(b, { type: 'copy', text }) // the page around the frame copies it
    }
  }

  function savePdf(el, n, b) {
    const svg = svgSourceOf(el)
    if (!svg) { flash(b, 'No SVG'); return }
    ask(b, { type: 'pdf', svg, name: nameOf(el, n) })
  }

  /** The buttons, made anew: once the page said what it offers, and when the figures change. */
  function build() {
    if (!caps) return
    layer.replaceChildren()
    tools = []
    const add = (target, buttons) => {
      const bar = document.createElement('div')
      bar.className = 'rft-tools'
      bar.append(...buttons)
      layer.appendChild(bar)
      tools.push([target, bar])
    }
    if (caps.pdf) figures().forEach((el, k) => add(el, [button('PDF', 'Download this figure as a PDF', b => savePdf(el, k + 1, b))]))
    for (const t of document.querySelectorAll('table')) {
      if (t.parentElement && t.parentElement.closest('table')) continue
      add(t, [button('LaTeX', 'Copy this table as a LaTeX table float (booktabs)', b => copyLatex(t, b))])
    }
    if (!layer.isConnected) document.body.appendChild(layer)
    place()
  }

  /** Each bar at the top-right corner of what it serves (a table's: of its rows, its box may be wider). */
  function place() {
    for (const [target, bar] of tools) {
      const r = target.getBoundingClientRect()
      let right = r.right
      if (target.tagName === 'TABLE' && target.rows.length) {
        right = Math.min(r.right, Math.max(...[...target.rows].slice(0, 20).map(tr => tr.getBoundingClientRect().right)))
      }
      bar.hidden = !r.width
      bar.style.top = `${r.top + window.scrollY + 4}px`
      bar.style.left = `${right + window.scrollX - bar.offsetWidth - 4}px`
    }
  }
  window.addEventListener('resize', place)
  window.addEventListener('load', () => { build() })
  if (window.ResizeObserver) new ResizeObserver(place).observe(document.documentElement)

  window.addEventListener('message', ev => {
    if (ev.source !== parent) return
    const d = ev.data || {}
    if (d.rft !== 'tree') return
    if (d.theme === 'dark' || d.theme === 'light') document.documentElement.dataset.theme = d.theme
    if (d.notes && typeof d.notes === 'object') { marks = d.notes; decorate() }
    if (typeof d.y === 'number' && d.y > 0) window.scrollTo(0, d.y)
    if (d.caps && typeof d.caps === 'object' && !caps) { caps = { pdf: d.caps.pdf === true }; build() }
    if (d.ticket && waiting.has(d.ticket)) {
      const b = waiting.get(d.ticket)
      waiting.delete(d.ticket)
      b.disabled = false
      flash(b, d.ok ? (b.dataset.label === 'PDF' ? 'Saved' : 'Copied') : 'Failed')
    }
  })

  let timer = 0
  window.addEventListener('scroll', () => {
    clearTimeout(timer)
    timer = setTimeout(() => send({ type: 'scroll', y: Math.round(window.scrollY) }), 120)
  }, { passive: true })

  function ready() {
    const y = Number(new URLSearchParams(location.search).get('y')) || 0
    if (y > 0) window.scrollTo(0, y)
    decorate()
    send({ type: 'ready' })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready)
  else ready()
})()
