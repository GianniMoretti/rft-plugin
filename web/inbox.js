// The inbox: links the user saved to read later and has not decided about, kept in one markdown
// file at the vault's top (Inbox.md, read through the server's api/inbox), outside the tree. The
// pure part (how an item is named, the button's count) is tested on its own; `mount` wires the
// panel of the live page. Loaded before app.js; it sets `globalThis.RftInbox` and touches nothing
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

  /** The line under an item's name: why it was saved, then the day it was added. */
  const sub = item => [item.why, item.added ? `added ${item.added}` : ''].filter(Boolean).join(' · ')

  /**
   * The panel in the live page. The button beside the scratchpad's opens it and shows how many
   * items wait; what changes in the file (Obsidian, Claude) comes in while it is open or shut.
   * `store`: the page's storage for this project (whether the panel is open).
   */
  function mount({ store, every = 2000 }) {
    const $ = id => document.getElementById(id)
    const btn = $('inbox-toggle'), badge = $('inbox-badge'), panel = $('inbox'), list = $('inbox-list')
    const total = $('inbox-count'), msg = $('inbox-msg')
    let shown = null // the items as last drawn, as JSON

    const el = (tag, cls, text) => {
      const e = document.createElement(tag)
      if (cls) e.className = cls
      if (text) e.textContent = text
      return e
    }

    function setMsg(text, isError = false) {
      msg.textContent = text
      msg.classList.toggle('error', isError)
    }

    function row(item) {
      const li = el('li', 'inbox-item')
      const head = el('div', 'inbox-row')
      const a = el('a', 'inbox-link', label(item))
      a.href = item.url
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.title = item.url
      head.append(a)
      if (item.priority) head.append(el('span', `inbox-prio p-${item.priority}`, item.priority))
      li.append(head)
      const under = [item.duplicate ? 'same as above' : '', sub(item)].filter(Boolean).join(' · ')
      if (under) li.append(el('div', 'inbox-sub muted', under))
      return li
    }

    function draw(items) {
      const n = count(items)
      badge.textContent = n > 99 ? '99+' : String(n)
      badge.hidden = !n
      total.textContent = n ? `${n} ${n === 1 ? 'item' : 'items'}` : ''
      const name = `Inbox: links saved to read later${n ? ` (${n})` : ''}`
      btn.title = name
      btn.setAttribute('aria-label', name)
      const json = JSON.stringify(items)
      if (json === shown) return
      shown = json
      list.replaceChildren(...items.map(row))
      $('inbox-empty').hidden = n > 0
    }

    /** Reads the file; false when the server has no inbox (one started before it existed). */
    async function load() {
      try {
        const res = await fetch('api/inbox', { cache: 'no-store' })
        if (res.status === 404) return false
        const got = await res.json().catch(() => ({}))
        if (!res.ok || !Array.isArray(got.items)) {
          setMsg(`Not read: ${got.error || `the server answered ${res.status}`}.`, true)
          return true
        }
        setMsg('')
        draw(got.items)
      } catch (e) {
        // the page's own light says when the server is gone
      }
      return true
    }

    function setOpen(open, focus = true) {
      // one panel in the corner: the scratchpad gives its place
      if (open && $('pad') && !$('pad').hidden) $('pad-close').click()
      panel.hidden = !open
      btn.setAttribute('aria-expanded', String(open))
      store.set('inboxOpen', open)
      if (open) {
        load()
        if (focus) $('inbox-close').focus()
      } else if (panel.contains(document.activeElement)) btn.focus()
    }

    btn.addEventListener('click', () => setOpen(panel.hidden))
    $('inbox-close').addEventListener('click', () => setOpen(false))
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

  root.RftInbox = { count, label, sub, mount }
})(typeof globalThis !== 'undefined' ? globalThis : window)
