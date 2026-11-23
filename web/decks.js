// The tree view's Slides tab (docs/design/presentations.md): the decks in vault/decks/, listed by
// what they are for (what comes next first, then those for nothing, then the past ones); + Deck
// (a title, and a meeting's occurrence, a deadline, or nothing); the open deck's text in an editor
// (CodeMirror 5, vendored, with a mode of its own), saved as it is typed with the version it was
// read at; beside it the slide the cursor is in, as it will be shown, its speaker notes, and every
// slide as a thumbnail; Present (full screen, the keys of a presentation) and PDF (the browser's
// print, one 16:9 page a slide). One renderer draws them all: web/slides.js's layout over
// web/markdown.js's HTML, in a 1920×1080 box scaled to fit. The decks are the user's to write: the
// padlock says whether Claude may write this one too. Loaded by the page before app.js, which
// mounts it (the standalone page leaves it out) and asks it for the Calendar's marks; its pure parts
// are tested from tests/decks-view.test.ts.
(function (root) {
  'use strict'

  const P = root.RftSlides
  const S = root.RftSchedule
  const SAVE_MS = 800 // a pause in the typing before the deck is saved
  const AHEAD_DAYS = 56 // the occurrences + Deck offers: the next eight weeks'
  const PER_MEETING = 4 // and at most this many of each meeting
  const THUMB_W = 128 // a thumbnail's width in the page's pixels

  const escH = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  /** A day in short: `Tue 24 Nov`. */
  const shortDay = day => new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)))
    .toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

  /** When an attachment is, in a few words: `G01 Supervisor meeting · Wed 25 Nov 10:00 (moved)`. */
  function whenText(a) {
    if (!a) return ''
    const at = a.at && a.at.time ? ` ${a.at.time}${a.at.zone ? ` ${a.at.zone}` : ''}` : ''
    return `${a.name} · ${shortDay(a.day)}${at}${a.moved ? ` (moved from ${shortDay(a.orig)})` : ''}`
  }

  const titleOf = x => x.title || String(x.name || '').replace(/^[A-Z]\d+\s*/, '')

  /**
   * What + Deck offers a new deck to be for: the meetings' occurrences of the next weeks (from
   * `today`, at most PER_MEETING each, soonest first; a once-only meeting by its id) and the open
   * deadlines ahead. Each `{value, label, title, subtitle}`: `value` the `for:` item, `title` the
   * deck's title it suggests, `subtitle` its title slide's second line.
   */
  function forChoices(meetings, milestones, today) {
    const out = []
    const end = S.addDays(today, AHEAD_DAYS)
    const occ = []
    for (const m of meetings || []) {
      for (const o of S.occurrences(m, today, end).slice(0, PER_MEETING)) occ.push({ m, o })
    }
    occ.sort((a, b) => a.o.day.localeCompare(b.o.day) || (a.o.at.time || '').localeCompare(b.o.at.time || ''))
    for (const { m, o } of occ) {
      const t = titleOf(m)
      out.push({
        value: P.forItem(m.id, m.every ? o.orig : ''),
        label: `${m.name} · ${shortDay(o.day)}${o.at.time ? ` ${o.at.time}` : ''}${o.moved ? ' (moved)' : ''}`,
        title: m.every ? `${t} ${o.day}` : t,
        subtitle: `${t} · ${shortDay(o.day)}`,
      })
    }
    for (const d of milestones || []) {
      const due = S.parseDue(d.due)
      if (!due || due.day < today || (d.status && d.status !== 'open')) continue
      out.push({ value: d.id, label: `${d.name} · ${shortDay(due.day)}`, title: titleOf(d), subtitle: shortDay(due.day) })
    }
    return out
  }

  /** The editor's mode for a deck: its frontmatter, separators, slide options, boxes' and lines' comments, headings, notes, code, links and math. */
  function defineMode(CM) {
    if (!CM || CM.modes['rft-deck']) return
    const SEP = /^---\s*$/
    CM.defineMode('rft-deck', () => ({
      startState: () => ({ started: false, front: false, fence: false, notes: false }),
      copyState: s => ({ ...s }),
      blankLine: s => { s.started = true },
      token(stream, s) {
        if (stream.sol()) {
          const text = stream.string
          const first = !s.started
          s.started = true
          const whole = style => { stream.skipToEnd(); return style }
          if (first && SEP.test(text)) { s.front = true; return whole('meta') }
          if (s.front) { if (SEP.test(text)) s.front = false; return whole('meta') }
          if (/^\s*(```|~~~)/.test(text)) { s.fence = !s.fence; return whole('string') }
          if (s.fence) return whole('string')
          if (SEP.test(text)) { s.notes = false; return whole('rft-sep') }
          if (/^\s*<!--\s*(slide|box|line)\b.*-->\s*$/i.test(text) || /^\s*<!--\s*\/box\s*-->\s*$/i.test(text)) return whole('rft-opt')
          if (/^::right::\s*$/.test(text)) return whole('rft-sep')
          if (/^note:/i.test(text)) s.notes = true
          if (!s.notes && /^#{1,6}\s/.test(text)) return whole('header')
        }
        if (s.notes || s.front || s.fence) { stream.skipToEnd(); return s.notes ? 'rft-note' : null }
        if (stream.match(/^!?\[\[[^\]]*\]\]/)) return 'link'
        if (stream.match(/^\$[^$\s][^$]*\$/)) return 'atom'
        if (stream.match(/^\*\*[^*]+\*\*/)) return 'strong'
        stream.next()
        while (!stream.eol() && !/[[$!*]/.test(stream.peek())) stream.next()
        return null
      },
    }))
  }

  function mount({ key, store, notify, open, nodes, visible, wanted, meetings, milestones, changed = () => {}, every = 4000 }) {
    const $ = id => document.getElementById(id)
    const section = $('slides')
    if (!section || !P || !S) return null
    const listEl = $('sl-list'), emptyEl = $('sl-empty'), body = $('sl-body'), statusEl = $('sl-status'), problemsEl = $('sl-problems')
    const previewEl = $('sl-preview'), notesEl = $('sl-notes'), thumbsEl = $('sl-thumbs'), nameEl = $('sl-name')
    const lockBtn = $('sl-lock'), presentBtn = $('sl-present'), pdfBtn = $('sl-pdf')
    const form = $('sl-new-form'), formTitle = $('sl-new-title'), formFor = $('sl-new-for')
    const show = $('sl-show'), printEl = $('sl-print')
    let decks = null // api/decks
    let did = store.get('slDeck', '') // the deck open
    let file = null // { id, version, text (as read or last saved) }
    let parsed = { slides: [] }
    let cur = 0 // the slide in view
    let dirty = false
    let saving = false
    let conflict = null // the deck as it is on disk, when it changed since it was read: { text, version }
    let saveTimer = 0
    let drawTimer = 0
    let loading = false
    let showing = null // while presenting: { k }
    let titleAuto = '' // the title + Deck filled in from its choice, until the user types one
    const canWrite = () => !!key()
    const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

    defineMode(root.CodeMirror)
    const cm = root.CodeMirror ? root.CodeMirror($('sl-cm'), {
      mode: 'rft-deck', lineNumbers: true, lineWrapping: true, tabSize: 2, indentUnit: 2,
      extraKeys: { 'Ctrl-S': () => save(), 'Cmd-S': () => save() },
    }) : null
    if (cm) {
      cm.on('change', () => {
        if (loading) return
        dirty = true
        parsed = P.split(cm.getValue())
        cur = Math.min(P.slideAt(parsed.slides, cm.getCursor().line), parsed.slides.length - 1)
        drawPreview()
        clearTimeout(drawTimer)
        drawTimer = setTimeout(() => { drawThumbs(); drawProblems() }, 250)
        clearTimeout(saveTimer)
        saveTimer = setTimeout(() => save(), SAVE_MS)
        renderStatus()
      })
      cm.on('cursorActivity', () => {
        const k = P.slideAt(parsed.slides, cm.getCursor().line)
        if (k !== cur) { cur = k; drawPreview(); markThumb() }
      })
    }

    // ---------------------------------------------------------------- the server

    async function api(path, opts = {}) {
      const headers = { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(key() ? { 'X-RFT-Token': key() } : {}) }
      const res = await fetch(path, { cache: 'no-store', ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
      const data = await res.json().catch(() => ({}))
      return { ok: res.ok, status: res.status, data }
    }
    const needKey = what => notify(`To ${what}, open the address /rft printed (it ends in ?token=…) once: this browser then remembers its key.`)

    async function refresh() {
      let r
      try { r = await api('api/decks') } catch { return }
      if (!r.ok) return
      const was = JSON.stringify(decks)
      decks = r.data.decks || []
      if (JSON.stringify(decks) !== was) {
        changed()
        if (visible()) renderList()
      }
      if (!visible()) return
      const here = decks.find(d => d.id === did)
      if (!here) {
        // none open (or it is gone): the first the list shows, the one for what comes next
        if (file) close()
        const g = P.groups(decks.map(d => ({ ...d, fields: deckFields(d) })), meetings(), milestones(), today(), S)
        const first = [...g.upcoming, ...g.none, ...g.past][0]
        if (first) await openDeck(first.deck.id, true)
        else renderAll()
        return
      }
      if (!file || file.id !== did) await openDeck(did, true)
      else if (here.version !== file.version && !dirty && !saving && !conflict) await openDeck(did, true)
    }

    // ---------------------------------------------------------------- the list

    const deckFields = d => ({ for: d.for })
    const theDeck = () => (decks || []).find(d => d.id === did) || null

    function renderAll() {
      const any = decks && decks.length
      emptyEl.hidden = !decks || !!any
      body.hidden = !any
      for (const b of section.querySelectorAll('.sl-needs')) b.hidden = !any || !file
      renderList()
      renderBar()
    }

    function lockIcon(locked) {
      const svg = lockBtn.querySelector(locked ? '.lock-closed' : '.lock-open').cloneNode(true)
      svg.classList.remove('on')
      return svg
    }

    function renderList() {
      if (!decks) return
      const g = P.groups(decks.map(d => ({ ...d, fields: deckFields(d) })), meetings(), milestones(), today(), S)
      const item = ({ deck: d, when }) => {
        const li = document.createElement('li')
        li.className = `sl-item${d.id === did ? ' open' : ''}`
        li.title = `${d.name}${when ? `\n${whenText(when)}` : ''}\n${d.slides} slide${d.slides === 1 ? '' : 's'}${d.locked ? ' · locked: yours to write' : ' · unlocked: Claude may write it too'}`
        li.innerHTML = `<span class="sl-id">${escH(d.id)}</span><span class="sl-title">${escH(d.title || d.name)}</span>`
        if (d.locked) li.append(lockIcon(true))
        if (when) {
          const w = document.createElement('span')
          w.className = 'sl-when muted'
          w.textContent = whenText(when)
          li.append(w)
        }
        li.addEventListener('click', () => openDeck(d.id))
        return li
      }
      const part = (label, entries) => {
        if (!entries.length) return []
        const head = document.createElement('div')
        head.className = 'sl-sub muted'
        head.textContent = label
        const ul = document.createElement('ul')
        ul.append(...entries.map(item))
        return [head, ul]
      }
      listEl.replaceChildren(...part('Next', g.upcoming), ...part('For nothing yet', g.none), ...part('Past', g.past))
    }

    function renderBar() {
      const d = theDeck()
      nameEl.textContent = d ? d.name : ''
      for (const b of section.querySelectorAll('.sl-needs')) b.hidden = !d || !file
      if (!d) return
      lockBtn.setAttribute('aria-pressed', String(d.locked))
      lockBtn.querySelector('.lock-open').classList.toggle('on', !d.locked)
      lockBtn.querySelector('.lock-closed').classList.toggle('on', d.locked)
      lockBtn.title = d.locked
        ? 'Locked: the deck is yours to write; Claude proposes an outline (click: let Claude write it too)'
        : 'Unlocked: Claude may write this deck too (click: lock it)'
      lockBtn.setAttribute('aria-label', lockBtn.title)
    }

    function renderStatus(text) {
      if (text != null) { statusEl.textContent = text; return }
      statusEl.replaceChildren()
      if (conflict) {
        statusEl.append('Changed on disk since you opened it: ')
        const theirs = document.createElement('button')
        theirs.type = 'button'
        theirs.className = 'linkish'
        theirs.textContent = 'take it'
        theirs.title = 'Load the deck as it is on disk: your changes since are lost'
        theirs.addEventListener('click', () => { const c = conflict; conflict = null; load(c.text, c.version) })
        const mine = document.createElement('button')
        mine.type = 'button'
        mine.className = 'linkish'
        mine.textContent = 'keep mine'
        mine.title = 'Write your text over it'
        mine.addEventListener('click', () => { conflict = null; save(true) })
        statusEl.append(theirs, ' or ', mine)
        return
      }
      statusEl.textContent = saving ? 'Saving…' : dirty ? 'Edited' : file ? 'Saved' : ''
    }

    // ---------------------------------------------------------------- opening, saving

    async function openDeck(id, quiet = false) {
      if (file && dirty && file.id !== id) await save()
      let r
      try { r = await api(`api/deck?id=${encodeURIComponent(id)}`) } catch { if (!quiet) notify('The server is not answering.'); return }
      if (!r.ok) { if (!quiet) notify(r.data.error || 'No such deck.'); return }
      if (!decks || !decks.some(d => d.id === r.data.id)) await refresh()
      did = r.data.id
      store.set('slDeck', did)
      const same = file && file.id === did
      file = { id: did, version: r.data.version, text: r.data.text }
      conflict = null
      load(r.data.text, r.data.version, same)
      renderAll()
    }

    function load(text, version, keepCursor = false) {
      file = { ...file, text, version }
      dirty = false
      if (cm) {
        const c = cm.getCursor(), top = cm.getScrollInfo().top
        loading = true
        cm.setValue(text)
        loading = false
        if (keepCursor) { cm.setCursor(c); cm.scrollTo(null, top) } else cm.clearHistory()
        cm.refresh()
      }
      parsed = P.split(text)
      cur = Math.min(cm ? P.slideAt(parsed.slides, cm.getCursor().line) : 0, parsed.slides.length - 1)
      drawPreview()
      drawThumbs()
      drawProblems()
      renderStatus()
    }

    function close() {
      file = null
      did = ''
      store.set('slDeck', '')
      if (cm) { loading = true; cm.setValue(''); loading = false }
      parsed = { slides: [] }
      previewEl.replaceChildren()
      thumbsEl.replaceChildren()
      notesEl.textContent = ''
      renderAll()
    }

    async function save(force = false) {
      clearTimeout(saveTimer)
      if (!file || !cm || (!dirty && !force) || saving || (conflict && !force)) return
      if (!canWrite()) { needKey('save the deck'); return }
      const text = cm.getValue()
      saving = true
      renderStatus()
      try {
        const r = await api('api/deck', { method: 'PUT', body: force ? { id: file.id, text, force: true } : { id: file.id, text, version: file.version } })
        if (r.status === 409) conflict = { text: r.data.text, version: r.data.version }
        else if (!r.ok) notify(`Deck not saved: ${r.data.error || r.status}`)
        else {
          file = { ...file, text, version: r.data.version }
          if (cm.getValue() === text) dirty = false
          const d = theDeck()
          if (d) Object.assign(d, { version: r.data.version, for: r.data.for, locked: r.data.locked, slides: r.data.slides })
        }
      } catch { notify('Deck not saved: the server is not answering.') }
      saving = false
      renderStatus()
      if (dirty && !conflict) { clearTimeout(saveTimer); saveTimer = setTimeout(() => save(), SAVE_MS) }
      renderList()
      changed()
    }

    // ---------------------------------------------------------------- drawing slides

    function tex(src, display) {
      try {
        if (root.katex) return root.katex.renderToString(src, { displayMode: display, throwOnError: false, strict: 'ignore' })
      } catch { /* below */ }
      return `<code class="math">${escH(display ? `$$${src}$$` : `$${src}$`)}</code>`
    }
    function image(src, alt, size) {
      const url = `api/image?deck=${encodeURIComponent(did)}&src=${encodeURIComponent(src)}${key() ? `&token=${encodeURIComponent(key())}` : ''}`
      const dims = size ? ` width="${size[1]}"` + (size[2] ? ` height="${size[2]}"` : '') : ''
      return `<img src="${escH(url)}" alt="${escH(alt || '')}" data-label="${escH(alt || src.split('/').pop())}"${dims}>`
    }
    function link(target) {
      const t = target.trim()
      const byId = nodes()
      for (const n of byId.values()) if (n.name === t) return n.id
      const id = t.split(' ')[0]
      return byId.has(id) ? id : null
    }
    const md = root.RftMarkdown.make({ tex, image, link, headings: 3, ordered: true })
    const html = slide => P.slideHtml(slide, src => md.render(src).html)

    /** A slide, scaled into `box` (or to `scale`), centred in it. */
    function place(box, slide, scale) {
      box.innerHTML = html(slide)
      const el = box.firstElementChild
      const fit = () => {
        const w = box.clientWidth, h = box.clientHeight
        const s = scale || Math.min(w / P.WIDTH, h / P.HEIGHT) || 0
        el.style.transform = `translate(${Math.max(0, (w - P.WIDTH * s) / 2)}px, ${Math.max(0, (h - P.HEIGHT * s) / 2)}px) scale(${s})`
      }
      fit()
      return fit
    }

    let fitPreview = () => {}
    function drawPreview() {
      const slide = parsed.slides[cur]
      if (!slide) { previewEl.replaceChildren(); notesEl.textContent = ''; return }
      fitPreview = place(previewEl, slide)
      notesEl.textContent = slide.notes ? slide.notes : ''
      notesEl.hidden = !slide.notes
      markThumb()
    }
    if (root.ResizeObserver) new root.ResizeObserver(() => fitPreview()).observe(previewEl)

    function drawThumbs() {
      thumbsEl.replaceChildren(...parsed.slides.map((s, k) => {
        const t = document.createElement('button')
        t.type = 'button'
        t.className = `sl-thumb${k === cur ? ' on' : ''}`
        t.title = `Slide ${s.n}${s.layout !== 'default' ? ` · ${s.layout}` : ''}`
        t.setAttribute('aria-label', t.title)
        const box = document.createElement('span')
        box.className = 'sl-thumb-box'
        t.append(box)
        const n = document.createElement('span')
        n.className = 'sl-thumb-n'
        n.textContent = String(s.n)
        t.append(n)
        box.innerHTML = html(s)
        box.firstElementChild.style.transform = `scale(${THUMB_W / P.WIDTH})`
        t.addEventListener('click', () => {
          if (!cm) return
          cm.setCursor({ line: s.bodyLine, ch: 0 })
          cm.scrollIntoView({ line: s.bodyLine, ch: 0 }, 80)
          cm.focus()
        })
        return t
      }))
    }

    function markThumb() {
      thumbsEl.querySelectorAll('.sl-thumb').forEach((t, k) => t.classList.toggle('on', k === cur))
    }

    function drawProblems() {
      const d = theDeck()
      const lines = d && cm ? P.problems({ id: d.id, text: cm.getValue() }, meetings(), milestones(), S) : []
      problemsEl.hidden = !lines.length
      problemsEl.replaceChildren(...lines.map(l => { const p = document.createElement('div'); p.textContent = l; return p }))
    }

    // a wikilink on a slide opens its note; in the presentation, a click goes on
    previewEl.addEventListener('click', ev => {
      const a = ev.target.closest('a[data-go]')
      if (a) { ev.preventDefault(); open(a.dataset.go) }
    })

    // ---------------------------------------------------------------- presenting

    let fitShow = () => {}
    function present() {
      if (!file || !parsed.slides.length) return
      showing = { k: Math.max(0, Math.min(cur, parsed.slides.length - 1)) }
      show.hidden = false
      drawShow()
      document.addEventListener('keydown', onKey, true)
      if (show.requestFullscreen) show.requestFullscreen().catch(() => {})
    }
    function drawShow() {
      const stage = show.querySelector('.sl-show-stage')
      fitShow = place(stage, parsed.slides[showing.k])
      show.querySelector('.sl-show-n').textContent = `${showing.k + 1} / ${parsed.slides.length}`
    }
    function go(k) {
      if (!showing) return
      const n = Math.max(0, Math.min(parsed.slides.length - 1, k))
      if (n !== showing.k) { showing.k = n; drawShow() }
    }
    function stopShowing() {
      if (!showing) return
      const k = showing.k
      showing = null
      show.hidden = true
      show.querySelector('.sl-show-stage').replaceChildren()
      document.removeEventListener('keydown', onKey, true)
      if (document.fullscreenElement === show && document.exitFullscreen) document.exitFullscreen().catch(() => {})
      // back in the editor at the slide it ended on
      if (cm && parsed.slides[k]) { cm.setCursor({ line: parsed.slides[k].bodyLine, ch: 0 }); cm.scrollIntoView(null, 80) }
    }
    function onKey(ev) {
      const next = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n']
      const back = ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p']
      let used = true
      if (next.includes(ev.key)) go(showing.k + 1)
      else if (back.includes(ev.key)) go(showing.k - 1)
      else if (ev.key === 'Home') go(0)
      else if (ev.key === 'End') go(parsed.slides.length - 1)
      else if (ev.key === 'Escape') stopShowing()
      else used = false
      if (used) { ev.preventDefault(); ev.stopPropagation() }
    }
    show.addEventListener('click', ev => {
      if (ev.target.closest('.sl-show-close')) return stopShowing()
      go(showing ? showing.k + (ev.shiftKey ? -1 : 1) : 0)
    })
    show.addEventListener('contextmenu', ev => { if (showing) { ev.preventDefault(); go(showing.k - 1) } })
    document.addEventListener('fullscreenchange', () => { if (showing && !document.fullscreenElement) stopShowing() })
    window.addEventListener('resize', () => { if (showing) fitShow() })

    // ---------------------------------------------------------------- the PDF

    async function printDeck() {
      if (!file || !parsed.slides.length) return
      await save()
      // each slide at its own size on a page of that size (a scaled slide prints its background and
      // images only in part, in Chromium): 20 × 11.25 in, 16:9
      printEl.replaceChildren(...parsed.slides.map(s => {
        const page = document.createElement('div')
        page.className = 'sl-page'
        page.innerHTML = html(s)
        return page
      }))
      // the page's size only while the deck is printed: printing the tree view stays as it was
      const style = document.createElement('style')
      style.textContent = `@page { size: ${P.WIDTH}px ${P.HEIGHT}px; margin: 0; }`
      document.head.append(style)
      document.body.classList.add('sl-printing')
      const title = document.title
      document.title = (theDeck() || {}).name || title // the PDF's file name, in most browsers
      await Promise.all([...printEl.querySelectorAll('img')].map(img => (img.complete ? null : new Promise(r => { img.onload = img.onerror = r }))))
      const done = () => {
        window.removeEventListener('afterprint', done)
        document.body.classList.remove('sl-printing')
        style.remove()
        printEl.replaceChildren()
        document.title = title
      }
      window.addEventListener('afterprint', done)
      window.print()
    }

    // ---------------------------------------------------------------- a new deck, the lock

    function openForm() {
      if (!canWrite()) return needKey('add a deck')
      const choices = forChoices(meetings(), milestones(), today())
      formFor.replaceChildren(new Option('For nothing yet', ''), ...choices.map(c => {
        const o = new Option(c.label, c.value)
        o.dataset.title = c.title
        o.dataset.subtitle = c.subtitle
        return o
      }))
      formTitle.value = ''
      titleAuto = ''
      form.hidden = false
      formTitle.focus()
    }
    formFor.addEventListener('change', () => {
      const o = formFor.selectedOptions[0]
      if (!formTitle.value.trim() || formTitle.value === titleAuto) {
        titleAuto = (o && o.dataset.title) || ''
        formTitle.value = titleAuto
      }
    })
    form.addEventListener('submit', async ev => {
      ev.preventDefault()
      const o = formFor.selectedOptions[0]
      const item = formFor.value
      if (await create(formTitle.value, item ? [item] : [], (o && o.dataset.subtitle) || '')) form.hidden = true
    })
    $('sl-new-cancel').addEventListener('click', () => { form.hidden = true })
    form.addEventListener('keydown', ev => { if (ev.key === 'Escape') form.hidden = true })
    $('sl-new').addEventListener('click', () => (form.hidden ? openForm() : (form.hidden = true)))
    $('sl-start').addEventListener('click', openForm)

    async function create(title, items, subtitle) {
      if (!canWrite()) { needKey('add a deck'); return false }
      if (!String(title || '').trim()) { notify('Give the deck a title.'); return false }
      let r
      try { r = await api('api/deck', { method: 'POST', body: { title, for: items, subtitle } }) } catch { notify('Deck not added: the server is not answering.'); return false }
      if (!r.ok) { notify(`Deck not added: ${r.data.error || r.status}`); return false }
      await refresh()
      await openDeck(r.data.id)
      if (cm) { cm.focus(); cm.setCursor({ line: cm.lineCount() - 1, ch: 0 }) }
      return true
    }

    lockBtn.addEventListener('click', async () => {
      const d = theDeck()
      if (!d) return
      if (!canWrite()) return needKey('change the lock')
      await save()
      const r = await api('api/deck/lock', { method: 'POST', body: { id: d.id, locked: !d.locked } }).catch(() => null)
      if (!r || !r.ok) return notify(`Lock not changed: ${(r && r.data.error) || 'the server is not answering'}`)
      await refresh()
      await openDeck(d.id, true)
    })
    presentBtn.addEventListener('click', present)
    pdfBtn.addEventListener('click', printDeck)

    // the project's figure tokens as the slides' colours and fonts (app.css reads --deck-*)
    const font = f => `"${String(f).replace(/["\\]/g, '')}", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Arial, sans-serif`
    api('api/style').then(r => {
      if (!r.ok || !r.data) return
      const t = r.data, css = document.documentElement.style
      const set = (k, v) => { if (typeof v === 'string' && v) css.setProperty(k, v) }
      set('--deck-fg', t.text); set('--deck-muted', t.muted); set('--deck-accent', t.accent)
      set('--deck-line', t.grid); set('--deck-fill', t.fill)
      // those a box or a line may name besides (web/slides.js's COLORS)
      set('--deck-contrast', t.contrast); set('--deck-baseline', t.baseline); set('--deck-neutral', t.neutral); set('--deck-axis', t.axis)
      const cats = Array.isArray(t.categorical) ? t.categorical : []
      for (let i = 0; cats.length && i < 6; i++) set(`--deck-c${i + 1}`, cats[i % cats.length])
      if (t.font) css.setProperty('--deck-font', font(t.font))
      if (t.headingFont) css.setProperty('--deck-head-font', font(t.headingFont))
    }).catch(() => {})

    setInterval(() => { if (wanted()) refresh() }, every)
    refresh()

    return {
      /** The tab is shown: the list, and the deck open, read again. */
      async show() {
        renderAll()
        await refresh()
        if (cm) setTimeout(() => { cm.refresh(); fitPreview() }, 0)
      },
      /** A deck opened in the tab. */
      openDeck: id => openDeck(id),
      /** A new deck for `item` (a `for:` item), with `title`, opened. */
      newFor: (item, title, subtitle) => create(title, item ? [item] : [], subtitle),
      /** The decks a meeting's occurrence (`orig`, its rule's day) or a deadline is shown with: `{id, name}`. */
      decksFor(id, orig) {
        if (!decks) return []
        const ids = P.decksFor(decks.map(d => ({ ...d, fields: deckFields(d) })), id, orig || '', meetings(), milestones(), S)
        return decks.filter(d => ids.includes(d.id)).map(d => ({ id: d.id, name: d.name }))
      },
    }
  }

  root.RftDecks = { mount, forChoices, whenText, defineMode }
})(typeof globalThis !== 'undefined' ? globalThis : window)
