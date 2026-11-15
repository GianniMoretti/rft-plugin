// rft artifact frame: the runtime inside a concept's artifact, which the tree view shows in a
// sandboxed frame (served by api/artifact, or as the standalone page's srcdoc). A click on a note
// link (`#E05`, or an element with data-note="E05") asks the page that frames it to open the note;
// a web link opens in a new tab. It says where it is scrolled to, so the page can bring it back
// there, and takes from the page its theme and how each note link is marked (its status,
// superseded, or missing). It reaches nothing else: the frame has no network and no storage.
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
    if (!el) return
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
      el.classList.forEach(c => { if (c === 'rft-note' || c === 'missing' || c === 'superseded' || c.startsWith('s-')) el.classList.remove(c) })
      if (!m) continue
      for (const c of m.cls.split(' ')) if (c) el.classList.add(c)
      el.title = m.title
    }
  }

  window.addEventListener('message', ev => {
    if (ev.source !== parent) return
    const d = ev.data || {}
    if (d.rft !== 'tree') return
    if (d.theme === 'dark' || d.theme === 'light') document.documentElement.dataset.theme = d.theme
    if (d.notes && typeof d.notes === 'object') { marks = d.notes; decorate() }
    if (typeof d.y === 'number' && d.y > 0) window.scrollTo(0, d.y)
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
