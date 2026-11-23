// The inbox: links the user saved to read later and has not decided about, kept in one markdown
// file at the vault's top (Inbox.md, read and added to through the server's api/inbox), outside
// the tree. The pure part (how an item is named, the button's count, the order of the list, what is
// said of a link not added) is tested on its own; `mount` wires the panel of the live page. Loaded before app.js; it sets `globalThis.RftInbox` and touches nothing
// else until mounted.
(function (root) {
  'use strict'

  /** How many items wait: every one, a link typed twice counted twice. */
  const count = items => (items || []).length

  /**
   * What an item is called in the list: its title, else `arXiv <id>`, `doi <doi>`, or the host
   * and path of its address.
   */
  function label(item) {
    if (item.title) return item.title
    const key = String(item.key || '')
    if (key.startsWith('arxiv:')) return `arXiv ${key.slice(6)}`
    if (key.startsWith('doi:')) return `doi ${String(item.url || '').replace(/^https?:\/\/doi\.org\//i, '') || key.slice(4)}`
    return String(item.url || key).replace(/^https?:\/\//i, '').replace(/[?#].*$/, '').replace(/\/$/, '')
  }

  /** Beside an item's why: the day it was added, and that its link is in the inbox twice. */
  const when = item => [item.added ? `added ${item.added}` : '', item.duplicate ? 'in the inbox twice' : ''].filter(Boolean).join(' · ')

  /** The reading priorities, the most pressing first, as the menu names them. */
  const PRIORITIES = ['urgent', 'high', 'medium', 'low']
  const PRIORITY_LABEL = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low' }
  const rank = p => { const i = PRIORITIES.indexOf(p); return i < 0 ? PRIORITIES.length : i }

  const ORDERS = ['priority', 'date']

  /**
   * The items in the order chosen, each with its place in the file (`at`) and which of the items
   * with its link it is there (`nth`: what a change names it by). `date`: the newest first, of one
   * day the one added later first, those with no day after them as the file has them. `priority`
   * (the default): urgent, high, medium, low, none, and that order within each. The file's order
   * is never changed.
   */
  function ordered(items, by) {
    const seen = new Map()
    const rows = (items || []).map((item, at) => {
      const nth = seen.get(item.key) || 0
      seen.set(item.key, nth + 1)
      return { item, at, nth }
    })
    const byDate = (a, b) => {
      const da = a.item.added || '', db = b.item.added || ''
      if (da !== db) return da < db ? 1 : -1
      return da ? b.at - a.at : a.at - b.at
    }
    return rows.sort(by === 'date' ? byDate : (a, b) => rank(a.item.priority) - rank(b.item.priority) || byDate(a, b))
  }

  const READ_ONLY = 'Read-only: open the address /rft printed (it ends in ?token=…) once to add here.'

  /**
   * What the page says of a write the server refused (`what`: "Not added", "Not changed", "Not
   * discarded"): the server's reason (not a link; where the link already is), or what to do about
   * a server that answered nothing of use.
   */
  function refusal(status, got, what = 'Not added') {
    if (got && typeof got.error === 'string' && got.error && status !== 404) return `${what}: ${got.error}.`
    if (status === 404) return `${what}: the server running is older than this page. /rft restart starts the new one.`
    return `${what}: the server answered ${status}.`
  }

  /**
   * The panel in the live page. The button beside the scratchpad's opens it and shows how many
   * items wait; what changes in the file (Obsidian, Claude) comes in while it is open or shut. The
   * field at its top saves a link; on each item, its reading priority as a menu, its why to edit,
   * and ✕ to discard it (two taps: a discarded link is not added again from here). `key()`: the
   * key for writes ('' : read-only); `store`: the page's storage for this project (whether the
   * panel is open, the order of the list).
   */
  function mount({ key = () => '', store, every = 2000 }) {
    const $ = id => document.getElementById(id)
    const btn = $('inbox-toggle'), badge = $('inbox-badge'), panel = $('inbox'), list = $('inbox-list')
    const total = $('inbox-count'), msg = $('inbox-msg')
    const link = $('inbox-link'), why = $('inbox-why'), save = $('inbox-save'), note = $('inbox-add-msg')
    let shown = null // what was last drawn: the order, whether the page may write, and the items as JSON
    let last = [] // the items as last read
    let order = ORDERS.includes(store.get('inboxOrder', 'priority')) ? store.get('inboxOrder', 'priority') : 'priority'
    let keep = 0 // until when the line at the foot stays, said of a write that failed
    let reads = 0 // counts what was asked of the server: an answer older than the last one drawn is dropped
    let sending = false
    let locked = false // the line under the field says the page is read-only

    const el = (tag, cls, text) => {
      const e = document.createElement(tag)
      if (cls) e.className = cls
      if (text) e.textContent = text
      return e
    }

    function setMsg(text, isError = false) {
      msg.textContent = text
      msg.classList.toggle('error', isError)
      keep = isError ? Date.now() + 8000 : 0
    }

    function setNote(text, isError = false) {
      note.textContent = text
      note.hidden = !text
      note.classList.toggle('error', isError)
    }

    /** The field takes a link when the page may write; with no key it says how to get one. */
    function writable() {
      const can = !!key()
      link.disabled = why.disabled = !can
      save.disabled = !can || sending
      if (!can) setNote(READ_ONLY)
      else if (locked) setNote('')
      locked = !can
    }

    /** The row of an item of the file, by its link and which of them it is. */
    const rowOf = (k, nth) => [...list.children].find(li => li.dataset.key === k && li.dataset.nth === String(nth))

    /**
     * One change to an item (its reading priority, its why, or the item discarded), written by the
     * server. `from`: the control that asked, which the redraw may replace. True when it was made.
     */
    async function change(r, action, value, from) {
      const body = { action, key: r.item.key, nth: r.nth }
      if (action !== 'discard') body[action] = value
      const what = action === 'discard' ? 'Not discarded' : 'Not changed'
      try {
        const res = await fetch('api/inbox', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RFT-Token': key() },
          body: JSON.stringify(body),
        })
        const got = await res.json().catch(() => ({}))
        reads++
        if (!res.ok || !Array.isArray(got.items)) {
          setMsg(refusal(res.status, got, what), true)
          return false
        }
        setMsg('')
        shown = null
        draw(got.items, from)
        return true
      } catch (e) {
        setMsg(`${what}: the server did not answer.`, true)
        return false
      }
    }

    /** An item's reading priority as a menu: only the user sets it, and nothing limits how many hold one. */
    function priorityMenu(r) {
      const { item } = r
      const sel = el('select', `prio${item.priority ? ` p-${item.priority}` : ''}`)
      sel.setAttribute('aria-label', `Reading priority of ${label(item)}`)
      sel.title = `${item.priority ? `Reading priority: ${item.priority}` : 'No reading priority'}. How soon you mean to read it; only you set it.`
      for (const v of ['', ...PRIORITIES]) {
        const o = el('option', '', v ? PRIORITY_LABEL[v] : 'No priority')
        o.value = v
        o.selected = (item.priority || '') === v
        sel.append(o)
      }
      sel.disabled = !key()
      sel.addEventListener('change', async () => {
        const focused = document.activeElement === sel
        sel.className = `prio${sel.value ? ` p-${sel.value}` : ''}`
        if (await change(r, 'priority', sel.value, sel)) {
          const now = rowOf(item.key, r.nth)
          if (focused && now && !list.contains(document.activeElement)) now.querySelector('select.prio').focus()
        } else {
          sel.value = item.priority || ''
          sel.className = `prio${item.priority ? ` p-${item.priority}` : ''}`
        }
      })
      return sel
    }

    /** The why of an item, which a tap turns into a field: Enter or leaving it saves, Esc gives up. */
    function whyOf(r) {
      const { item } = r
      if (!key()) return item.why ? el('span', 'inbox-why', item.why) : null
      const b = el('button', `inbox-why${item.why ? '' : ' empty'}`, item.why || '+ why')
      b.type = 'button'
      b.title = item.why ? 'Edit why it is saved' : 'Say why it is saved'
      b.setAttribute('aria-label', `${item.why ? `Why: ${item.why}. Edit` : 'Say why'} ${label(item)} is saved`)
      b.addEventListener('click', () => {
        const input = el('input', 'inbox-why-edit')
        input.type = 'text'
        input.maxLength = 500
        input.value = item.why
        input.placeholder = 'Why (optional)'
        input.enterKeyHint = 'done'
        input.setAttribute('aria-label', `Why ${label(item)} is saved`)
        let busy = false // its write is on its way
        let closed = false // given up or saved: a field taken out of the page is still told it lost the focus
        const back = focus => {
          if (closed) return
          closed = true
          input.replaceWith(b)
          if (focus) b.focus()
        }
        const done = async () => {
          if (busy || closed) return
          const focused = document.activeElement === input
          if (input.value.replace(/\s+/g, ' ').trim() === item.why) return back(focused)
          busy = true
          const made = await change(r, 'why', input.value, input)
          busy = false
          // a why the server did not take stays in its field, to be mended
          if (!made) return
          closed = true
          const now = rowOf(item.key, r.nth)
          if (focused && now && !list.contains(document.activeElement)) (now.querySelector('.inbox-why') || now.querySelector('.inbox-link')).focus()
        }
        input.addEventListener('keydown', ev => {
          if (ev.isComposing) return
          if (ev.key === 'Enter') {
            ev.preventDefault()
            done()
          } else if (ev.key === 'Escape') {
            // gives up the edit, not the panel
            ev.preventDefault()
            ev.stopPropagation()
            back(true)
          }
        })
        input.addEventListener('blur', done)
        b.replaceWith(input)
        input.focus()
      })
      return b
    }

    /** ✕ on an item: the first tap asks, the second discards it (its line goes under Processed). */
    function discardOf(r) {
      const { item } = r
      const x = el('button', 'inbox-x', '✕')
      x.type = 'button'
      let timer = 0
      const arm = on => {
        clearTimeout(timer)
        x.classList.toggle('armed', on)
        x.textContent = on ? 'Discard?' : '✕'
        x.title = on ? 'Tap again to discard it: it leaves the inbox and is kept under Processed as discarded' : 'Discard: take it out of the inbox'
        x.setAttribute('aria-label', on ? `Discard ${label(item)}: again to confirm` : `Discard ${label(item)}`)
        if (on) timer = setTimeout(() => { arm(false); draw(last) }, 5000)
      }
      arm(false)
      x.addEventListener('blur', () => arm(false))
      x.addEventListener('click', async () => {
        if (!x.classList.contains('armed')) return arm(true)
        clearTimeout(timer)
        const at = [...list.children].indexOf(x.closest('li'))
        const focused = document.activeElement === x || document.activeElement === document.body
        x.disabled = true
        x.classList.remove('armed')
        if (await change(r, 'discard', '', x)) {
          const next = list.children[Math.min(at, list.children.length - 1)]
          if (focused && !list.contains(document.activeElement)) (next ? next.querySelector('.inbox-link') : $('inbox-close')).focus()
        } else if (x.isConnected) {
          x.disabled = false
          arm(false)
        }
      })
      return x
    }

    function row(r) {
      const { item } = r
      const li = el('li', 'inbox-item')
      li.dataset.key = item.key
      li.dataset.nth = String(r.nth)
      const head = el('div', 'inbox-row')
      const a = el('a', 'inbox-link', label(item))
      a.href = item.url
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.title = item.url
      head.append(a, priorityMenu(r))
      if (key()) head.append(discardOf(r))
      li.append(head)
      const under = el('div', 'inbox-under')
      const why = whyOf(r), day = when(item)
      if (why) under.append(why)
      if (day) under.append(el('span', 'inbox-when muted', day))
      if (under.firstChild) li.append(under)
      return li
    }

    /**
     * Whether the user is at something of the list a redraw would take from under them: a reading
     * priority's menu, a why being typed, a ✕ asked once. `from`: a control whose own write is
     * being drawn.
     */
    function engaged(from) {
      const a = document.activeElement
      if (a && a !== from && list.contains(a) && a.matches('select.prio, input.inbox-why-edit')) return true
      return [...list.querySelectorAll('.inbox-x.armed')].some(x => x !== from)
    }

    function draw(items, from) {
      last = items
      const n = count(items)
      badge.textContent = n > 99 ? '99+' : String(n)
      badge.hidden = !n
      total.textContent = n ? `${n} ${n === 1 ? 'item' : 'items'}` : ''
      const name = `Inbox: links saved to read later${n ? ` (${n})` : ''}`
      btn.title = name
      btn.setAttribute('aria-label', name)
      panel.querySelectorAll('[data-inbox-order]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.inboxOrder === order)))
      const json = `${order}${key() ? ' w ' : ' r '}${JSON.stringify(items)}`
      // drawn once they leave it (the list's focusout), or at the next read
      if (json === shown || engaged(from)) return
      shown = json
      list.replaceChildren(...ordered(items, order).map(row))
      $('inbox-empty').hidden = n > 0
    }

    /** Reads the file; false when the server has no inbox (one started before it existed). */
    async function load() {
      const mine = ++reads
      try {
        const res = await fetch('api/inbox', { cache: 'no-store' })
        if (res.status === 404) return false
        const got = await res.json().catch(() => ({}))
        if (mine !== reads) return true
        if (!res.ok || !Array.isArray(got.items)) {
          setMsg(`Not read: ${got.error || `the server answered ${res.status}`}.`, true)
          return true
        }
        if (Date.now() > keep) setMsg('')
        draw(got.items)
      } catch (e) {
        // the page's own light says when the server is gone
      }
      return true
    }

    /** Saves the link in the field: the item joins the list, or the line under the field says why not. */
    async function add() {
      if (sending || !key()) return
      if (!/\S/.test(link.value)) { link.focus(); return }
      sending = true
      save.disabled = true
      try {
        const res = await fetch('api/inbox', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RFT-Token': key() },
          body: JSON.stringify({ link: link.value, why: why.value }),
        })
        const got = await res.json().catch(() => ({}))
        if (!res.ok || !Array.isArray(got.items) || !got.item) {
          setNote(refusal(res.status, got), true)
          return
        }
        reads++
        link.value = why.value = ''
        setNote('')
        setMsg('')
        draw(got.items)
        const rows = [...list.children].filter(li => li.dataset.key === got.item.key).sort((a, b) => Number(a.dataset.nth) - Number(b.dataset.nth))
        if (rows.length) rows[rows.length - 1].scrollIntoView({ block: 'nearest' })
        if (document.activeElement === why) link.focus()
      } catch (e) {
        setNote('Not added: the server did not answer.', true)
      } finally {
        sending = false
        writable()
      }
    }

    function setOpen(open, focus = true) {
      // one panel in the corner: the scratchpad gives its place
      if (open && $('pad') && !$('pad').hidden) $('pad-close').click()
      panel.hidden = !open
      btn.setAttribute('aria-expanded', String(open))
      store.set('inboxOpen', open)
      if (open) {
        writable()
        load()
        // with a mouse the field is ready for a paste; a finger's tap would raise the keyboard over the list
        if (focus) (key() && window.matchMedia('(pointer: fine)').matches ? link : $('inbox-close')).focus()
      } else if (panel.contains(document.activeElement)) btn.focus()
    }

    btn.addEventListener('click', () => setOpen(panel.hidden))
    $('inbox-close').addEventListener('click', () => setOpen(false))
    $('inbox-add').addEventListener('submit', ev => {
      ev.preventDefault()
      add()
    })
    link.addEventListener('input', () => { if (!locked) setNote('') })
    panel.querySelectorAll('[data-inbox-order]').forEach(b => b.addEventListener('click', () => {
      order = b.dataset.inboxOrder
      store.set('inboxOrder', order)
      draw(last, b)
      list.scrollTop = 0
    }))
    // what came in while the user was at a menu, a why or a ✕ is drawn once they leave it
    list.addEventListener('focusout', () => setTimeout(() => draw(last), 0))
    panel.addEventListener('keydown', ev => {
      if (ev.key !== 'Escape' || ev.isComposing) return
      ev.preventDefault()
      ev.stopPropagation()
      setOpen(false)
    })
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load() })

    // the button only once the server is known to keep an inbox
    load().then(found => {
      if (!found) return
      btn.hidden = false
      setInterval(() => { if (!document.hidden) load() }, every)
      if (store.get('inboxOpen', false)) setOpen(true, false)
    })
  }

  root.RftInbox = { count, label, when, refusal, ORDERS, PRIORITIES, ordered, mount }
})(typeof globalThis !== 'undefined' ? globalThis : window)
