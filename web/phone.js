// The web view on a phone (app.css's phone rules, at most 700 px wide, or a touch screen): the
// phone's Back closes what was opened last (the ⋯ menu, the filters, the scratchpad, the queue, a
// notebook, a deck presented, the text or preview pane of the Manuscript or the Slides, a note) and,
// in a note reached by a link, shows the note the link was in; the ⋯ menu that holds the bar's
// secondary controls; the Manuscript's and the Slides' panes one at a time; and the room the
// keyboard leaves. On a wider screen with a mouse it changes nothing. app.js tells it the note the
// drawer shows (`rft:note`, null for a concept's artifact) and goes to the one it names (`rft:go`).
// It sets `globalThis.RftPhone` (the back stack's rules, for the plugin's tests) and, in a page,
// mounts itself.
(function () {
  'use strict'

  /**
   * What a Back to the history entry that had `keep` open (their keys) does to `stack`, the things
   * open, oldest first ({ key, kind: 'sheet' | 'drawer' | 'note', note }; a note is one reached
   * from the note below it, a drawer the first note shown). `close`: the sheets and the drawer to
   * close, newest first; `note`: the note to show again, when only notes above it went; `stale`:
   * the entry names only things closed by hand since, so Back goes on to the one before it.
   */
  function afterBack(stack, keep) {
    const kept = new Set(keep)
    const gone = stack.filter(i => !kept.has(i.key)).reverse()
    const rest = stack.filter(i => kept.has(i.key))
    let note = null
    if (gone.some(i => i.kind === 'note') && !gone.some(i => i.kind === 'drawer')) {
      const top = [...rest].reverse().find(i => i.kind === 'note' || i.kind === 'drawer')
      note = (top && top.note) || null
    }
    const stale = !gone.length && keep.some(k => !stack.some(i => i.key === k))
    return { close: gone.filter(i => i.kind !== 'note'), rest, note, stale }
  }

  /**
   * Things closed by hand (`keys`), not by Back: a drawer takes the notes above it along. `top`:
   * they were the newest, so the history goes back past their entries; else their entries stay,
   * and afterBack skips them.
   */
  function afterClose(stack, keys) {
    const gone = new Set(keys)
    for (const k of keys) {
      const i = stack.findIndex(x => x.key === k)
      if (i >= 0 && stack[i].kind === 'drawer') for (const x of stack.slice(i + 1)) if (x.kind === 'note') gone.add(x.key)
    }
    const first = stack.findIndex(x => gone.has(x.key))
    return {
      rest: stack.filter(x => !gone.has(x.key)),
      removed: stack.filter(x => gone.has(x.key)),
      top: first >= 0 && stack.slice(first).every(x => gone.has(x.key)),
    }
  }

  const PHONE = '(max-width: 700px)'
  const TOUCH = '(max-width: 700px), (pointer: coarse)'

  function mount(doc) {
    const $ = s => doc.querySelector(s)
    const touch = matchMedia(TOUCH)
    const phone = matchMedia(PHONE)
    const click = s => { const b = $(s); if (b) b.click() }

    // ------------------------------------------------------------ the ⋯ menu

    const more = $('#bar-more')
    const moreBtn = $('#bar-more-toggle')
    function setMenu(on) {
      if (!more || !moreBtn) return
      if (on) {
        $('#bar-more-title').textContent = ($('#title') || {}).textContent || ''
        $('#bar-more-counts').textContent = ($('#counts') || {}).textContent || ''
      }
      more.classList.toggle('open', on)
      moreBtn.setAttribute('aria-expanded', String(on))
    }
    if (more && moreBtn) {
      moreBtn.addEventListener('click', () => setMenu(!more.classList.contains('open')))
      // a choice closes it, as a menu's item does; the text size stays open, to press again
      more.addEventListener('click', ev => {
        const b = ev.target.closest('button')
        if (b && more.classList.contains('open') && !b.matches('#font-down, #font-up')) setMenu(false)
      })
      doc.addEventListener('pointerdown', ev => {
        if (more.classList.contains('open') && !more.contains(ev.target) && !moreBtn.contains(ev.target)) setMenu(false)
      }, true)
      doc.addEventListener('keydown', ev => { if (ev.key === 'Escape' && more.classList.contains('open')) setMenu(false) })
    }

    // ------------------------------------------------------------ the Manuscript's and the Slides' panes

    function setPane(body, pane) {
      if (!body || body.dataset.pane === pane) return
      body.dataset.pane = pane
      for (const b of doc.querySelectorAll(`.phone-panes[data-for="${body.id}"] button`)) b.setAttribute('aria-pressed', String(b.dataset.pane === pane))
    }
    doc.addEventListener('click', ev => {
      const b = ev.target.closest && ev.target.closest('.phone-panes button')
      if (b) { setPane(doc.getElementById(b.closest('.phone-panes').dataset.for), b.dataset.pane); return }
      // a snippet, a document or a deck picked from the list: its text, as a list's item opens on a phone
      if (!phone.matches) return
      const item = ev.target.closest && ev.target.closest('.ms-item:not(.missing), .sl-item')
      if (item) setTimeout(() => setPane(item.closest('.ms-body, .sl-body'), 'text'), 0)
    })

    // ------------------------------------------------------------ Back

    // what Back closes: each { name, kind, el (its open or shut shows on it), others (their changes too), open(), close() }
    const shown = s => { const e = $(s); return Boolean(e && !e.hidden) }
    const drawer = $('#drawer')
    const WATCH = [
      { name: 'drawer', kind: 'drawer', el: '#drawer', open: () => shown('#drawer'),
        close: () => click(drawer.classList.contains('artifact-mode') ? '#art-close' : '#drawer-close') },
      { name: 'notebook', el: '#nbpane', open: () => shown('#nbpane'), close: () => click('#nb-close') },
      { name: 'filters', el: '#filters', open: () => shown('#filters'), close: () => click('#filters-close') },
      { name: 'pad', el: '#pad', open: () => shown('#pad'), close: () => click('#pad-close') },
      { name: 'inbox', el: '#inbox', open: () => shown('#inbox'), close: () => click('#inbox-close') },
      { name: 'jobs', el: '#jobs', open: () => shown('#jobs'), close: () => click('#jobs-close') },
      { name: 'menu', el: '#bar-more', open: () => Boolean(more && more.classList.contains('open')), close: () => setMenu(false) },
      { name: 'show', el: '#sl-show', open: () => shown('#sl-show'), close: () => click('.sl-show-close') },
      { name: 'ms-pane', el: '#ms-body', others: ['#manuscript'], open: () => phone.matches && shown('#manuscript') && shown('#ms-body') && $('#ms-body').dataset.pane !== 'list',
        close: () => setPane($('#ms-body'), 'list') },
      { name: 'sl-pane', el: '#sl-body', others: ['#slides'], open: () => phone.matches && shown('#slides') && shown('#sl-body') && $('#sl-body').dataset.pane !== 'list',
        close: () => setPane($('#sl-body'), 'list') },
    ].filter(w => $(w.el))

    let stack = [] // what is open, oldest first; `entry`: its history entry is pushed
    let seq = 0
    let ignore = 0 // our own moves back, still to arrive
    let lastNote = null // the note the drawer shows, as app.js last said
    const keys = upTo => stack.slice(0, upTo).map(i => i.key)

    function push(item) {
      stack.push(item)
      item.entry = !ignore
      if (item.entry) history.pushState({ rft: 1, open: keys() }, '')
    }
    // entries held back while a move back was under way
    function flush() {
      stack.forEach((it, i) => {
        if (!it.entry) { history.pushState({ rft: 1, open: keys(i + 1) }, ''); it.entry = true }
      })
    }

    /** Brings the stack in line with the page: what opened is pushed, what was closed by hand is let go. */
    function sync() {
      const shut = stack.filter(i => i.watch && !i.watch.open()).map(i => i.key)
      if (shut.length) {
        const r = afterClose(stack, shut)
        stack = r.rest
        const back = r.top ? r.removed.filter(i => i.entry).length : 0
        if (back) { ignore++; history.go(-back) }
      }
      if (!touch.matches) return
      for (const w of WATCH) {
        if (!w.open() || stack.some(i => i.watch === w)) continue
        push({ key: `${w.name}:${++seq}`, kind: w.kind || 'sheet', watch: w, note: w.kind === 'drawer' ? lastNote : null })
      }
    }

    const observer = new MutationObserver(() => sync())
    for (const w of WATCH) {
      for (const s of [w.el, ...(w.others || [])]) {
        const e = $(s)
        if (e) observer.observe(e, { attributes: true, attributeFilter: ['hidden', 'class', 'data-pane'] })
      }
    }

    doc.addEventListener('rft:note', ev => {
      const id = ev.detail == null ? null : String(ev.detail)
      lastNote = id
      if (!touch.matches || id == null) return
      const top = [...stack].reverse().find(i => i.kind === 'note' || i.kind === 'drawer')
      if (!top || top.note === id) return
      if (top.note == null) { top.note = id; return } // the drawer's first note (after a concept's artifact)
      push({ key: `note:${++seq}`, kind: 'note', note: id })
    })

    addEventListener('popstate', ev => {
      if (ignore) { ignore--; if (!ignore) flush(); return }
      const keep = ev.state && ev.state.rft ? ev.state.open : []
      const r = afterBack(stack, keep)
      stack = r.rest
      for (const it of r.close) it.watch.close()
      if (r.note) doc.dispatchEvent(new CustomEvent('rft:go', { detail: r.note }))
      if (r.stale) history.back()
      // what would not close (a note with unsaved changes) is pushed again
      setTimeout(sync, 0)
    })
    // a reload: what was open is not any more
    if (history.state && history.state.rft) history.replaceState(null, '')

    // a note found from the search: the keyboard goes, so the note shows
    const search = $('#search')
    if (search) search.addEventListener('keydown', ev => { if (ev.key === 'Enter' && touch.matches) setTimeout(() => search.blur(), 0) })

    // ------------------------------------------------------------ the keyboard

    // with the keyboard up the page is shorter (interactive-widget=resizes-content): the page tabs make way
    let tall = innerHeight
    let wide = innerWidth
    addEventListener('resize', () => {
      if (innerWidth !== wide) { wide = innerWidth; tall = innerHeight } // turned: a new full height
      tall = Math.max(tall, innerHeight)
      doc.body.classList.toggle('kb-open', innerHeight < tall * 0.75)
    })
  }

  globalThis.RftPhone = { afterBack, afterClose }
  if (typeof document !== 'undefined' && document.getElementById && typeof matchMedia === 'function') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mount(document))
    else mount(document)
  }
})()
