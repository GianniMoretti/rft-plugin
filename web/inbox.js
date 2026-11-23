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

  /** The reading priorities, the most pressing first. */
  const PRIORITIES = ['urgent', 'high', 'medium', 'low']
  /** What a tap on an item's reading priority steps through: none, each more pressing one, and none again after urgent. */
  const STEPS = ['', 'low', 'medium', 'high', 'urgent']
  const nextPriority = p => STEPS[(Math.max(0, STEPS.indexOf(p || '')) + 1) % STEPS.length]
  /** How long after the last tap on a reading priority it is written. */
  const STEP_MS = 700

  /**
   * A reading priority drawn: three rising bars, as many filled as it presses (low one, medium
   * two, high three, none all faint), and urgent a filled square with a "!".
   */
  function priorityIcon(p) {
    const filled = { low: 1, medium: 2, high: 3 }[p] || 0
    const bars = [[1.5, 10], [6.5, 6], [11.5, 2]]
      .map(([x, y], i) => `<rect x="${x}" y="${y}" width="3" height="${14.5 - y}" rx="1"${i < filled ? '' : ' class="off"'}/>`).join('')
    const urgent = '<rect x="1.5" y="1.5" width="13" height="13" rx="3"/><path class="cut" d="M8 4.6v4.2M8 11.4v.01"/>'
    return `<svg class="prio-ico" viewBox="0 0 16 16" aria-hidden="true">${p === 'urgent' ? urgent : bars}</svg>`
  }
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
   * field at its top saves a link; on each item, its reading priority as an icon a tap steps, its why to edit,
   * ✕ to discard it (two taps: a discarded link is not added again from here), and Process, which
   * asks Claude in the chat that ran /rft to read it and discuss what becomes of it; an item Claude
   * has briefed says so, and shows its brief at a tap. `key()`: the
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
    const open = new Set() // the items whose brief is shown, by link and which of them
    const asked = new Map() // the items asked of the chat a moment ago, and until when: their Process waits, against a second tap
    const ASKED_MS = 10000

    const el = (tag, cls, text) => {
      const e = document.createElement(tag)
      if (cls) e.className = cls
      if (text) e.textContent = text
      return e
    }

    function setMsg(text, isError = false, hold = isError ? 8000 : 0) {
      msg.textContent = text
      msg.classList.toggle('error', isError)
      keep = hold ? Date.now() + hold : 0
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

    /**
     * An item's reading priority as a button: its icon says it and a tap steps it (none, low,
     * medium, high, urgent, none again). Only the user sets it, and nothing limits how many hold
     * one. The taps of one go are written once, a moment after the last: the list, ordered by
     * reading priority, does not move the item from under the finger between two taps.
     */
    function priorityButton(r) {
      const { item } = r
      const b = el('button')
      b.type = 'button'
      let saved = item.priority || '', now = saved, timer = 0, writing = false
      const show = () => {
        b.className = `inbox-prio${now ? ` p-${now}` : ''}${now !== saved ? ' pending' : ''}`
        b.dataset.priority = now
        b.innerHTML = priorityIcon(now)
        const says = now ? `Reading priority: ${now}` : 'No reading priority'
        b.title = key() ? `${says}. A tap steps it: none, low, medium, high, urgent. How soon you mean to read it; only you set it.` : `${says}.`
        b.setAttribute('aria-label', `${says}, of ${label(item)}${key() ? `. Press for ${nextPriority(now) || 'none'}` : ''}`)
      }
      show()
      b.disabled = !key()
      b.addEventListener('click', () => {
        if (writing) return
        now = nextPriority(now)
        show()
        clearTimeout(timer)
        timer = setTimeout(async () => {
          // stepped all the way round: nothing to write, and what came in meanwhile is drawn
          if (now === saved) return draw(last)
          writing = true
          // written: this button says so, should the list not be drawn again yet (another item is being stepped)
          if (await change(r, 'priority', now, b)) saved = now
          else now = saved
          writing = false
          show()
        }, STEP_MS)
      })
      return b
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

    /** That an item has a brief, and the brief itself, which a tap on the mark shows under the item. */
    function briefOf(r) {
      const { item } = r
      if (!item.brief || !item.brief.lines.length) return null
      const id = `${r.nth} ${item.key}`
      const mark = el('button', 'inbox-briefed', `briefed${item.brief.date ? ` ${item.brief.date}` : ''}`)
      mark.type = 'button'
      const body = el('ul', 'inbox-brief')
      for (const l of item.brief.lines) body.append(el('li', '', l))
      const set = on => {
        body.hidden = !on
        mark.setAttribute('aria-expanded', String(on))
        mark.title = on ? 'Hide the brief' : 'Show the brief Claude saved when it read it'
        if (on) open.add(id)
        else open.delete(id)
      }
      set(open.has(id))
      mark.addEventListener('click', () => set(body.hidden))
      return { mark, body }
    }

    /**
     * Process: the item asked of Claude in the chat that ran /rft, where it reads it, gives its
     * brief and waits for the user to pick what becomes of it. Nothing changes here until Claude
     * saves the brief; with no chat, the line at the foot says so and nothing waits.
     */
    function processOf(r) {
      const { item } = r
      const id = `${r.nth} ${item.key}`
      const b = el('button', 'inbox-process', 'Process')
      b.type = 'button'
      b.title = item.brief ? 'Process: Claude starts from its brief in the chat, and you pick what becomes of it' : 'Process: Claude reads it in the chat, gives its brief, and you pick what becomes of it'
      b.setAttribute('aria-label', `Process ${label(item)} in the chat`)
      b.disabled = (asked.get(id) || 0) > Date.now()
      // the button as the list has it now: a redraw may have replaced this one
      const free = () => {
        asked.delete(id)
        const li = rowOf(item.key, r.nth), now = li && li.querySelector('.inbox-process')
        if (now) now.disabled = false
      }
      b.addEventListener('click', async () => {
        if ((asked.get(id) || 0) > Date.now()) return
        asked.set(id, Date.now() + ASKED_MS)
        b.disabled = true
        try {
          const res = await fetch('api/inbox', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RFT-Token': key() },
            body: JSON.stringify({ action: 'process', key: item.key, nth: r.nth }),
          })
          const got = await res.json().catch(() => ({}))
          if (!res.ok || !got.asked) {
            // a server from before Process knows no such action
            setMsg(refusal(res.status === 400 ? 404 : res.status, got, 'Not processed'), true)
            return free()
          }
          setMsg(`Asked in the chat: Claude ${item.brief ? 'starts from its brief' : 'reads it and gives its brief'} there.`, false, ASKED_MS)
          setTimeout(free, ASKED_MS)
        } catch (e) {
          setMsg('Not processed: the server did not answer.', true)
          free()
        }
      })
      return b
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
      head.append(a, priorityButton(r))
      if (key()) head.append(discardOf(r))
      li.append(head)
      const under = el('div', 'inbox-under')
      // what is said of it, which wraps, and Process at its right
      const about = el('div', 'inbox-about')
      const why = whyOf(r), day = when(item), brief = briefOf(r)
      if (why) about.append(why)
      if (day) about.append(el('span', 'inbox-when muted', day))
      if (brief) about.append(brief.mark)
      if (about.firstChild || key()) under.append(about)
      if (key()) under.append(processOf(r))
      if (under.firstChild) li.append(under)
      if (brief) li.append(brief.body)
      return li
    }

    /**
     * Whether the user is at something of the list a redraw would take from under them: a reading
     * priority being stepped, a why being typed, a ✕ asked once. `from`: a control whose own write is
     * being drawn.
     */
    function engaged(from) {
      const a = document.activeElement
      if (a && a !== from && list.contains(a) && a.matches('input.inbox-why-edit')) return true
      return [...list.querySelectorAll('.inbox-x.armed, .inbox-prio.pending')].some(x => x !== from)
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
      // a redraw under a reading priority, the brief's mark or Process leaves the focus on the one that replaces it
      const a = document.activeElement
      const cls = a && list.contains(a) && ['inbox-prio', 'inbox-briefed', 'inbox-process'].find(c => a.classList.contains(c))
      const at = cls ? { ...a.closest('li').dataset, cls } : null
      list.replaceChildren(...ordered(items, order).map(row))
      const now = at && rowOf(at.key, at.nth)
      if (now && now.querySelector(`.${at.cls}`)) now.querySelector(`.${at.cls}`).focus()
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
    // what came in while the user was at a why or a ✕ is drawn once they leave it
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

  root.RftInbox = { count, label, when, refusal, ORDERS, PRIORITIES, nextPriority, priorityIcon, ordered, mount }
})(typeof globalThis !== 'undefined' ? globalThis : window)
