// The inbox: links the user saved to read later and has not decided about, kept in one markdown
// file at the vault's top (Inbox.md, read and added to through the server's api/inbox), outside
// the tree. The pure part (how an item is named, the button's count, the order of the list, what is
// said of a link not added) is tested on its own; `mount` wires the panel of the live page. Loaded before app.js; it sets `globalThis.RftInbox` and touches nothing
// else until mounted.
(function (root) {
  'use strict'

  // the agents the user set up (agents.js): who processes an item; with none, the connected chat alone
  const AG = (typeof window !== 'undefined' && window.RftAgents) || { CHAT: 'chat', extra: () => ({}), name: () => 'Claude', chosen: () => 'chat', picker: () => null, onChange: () => {} }

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

  /**
   * What an item's row says of its reading: whether its reading note holds the user's part or
   * Claude's impression (`notes`, by key, as the server gives them), the user's read mark, whether
   * its discussion still waits for a chat (`waiting`: the keys of those that do), and what its one
   * button asks of the chat: Process before the mark, Discuss after it.
   */
  function reading(item, notes, waiting) {
    const note = (notes && notes[item.key]) || {}
    const read = item.read || ''
    return { mine: !!note.mine, impression: !!note.impression, read, waiting: !!read && (waiting || []).includes(item.key), action: read ? 'discuss' : 'process' }
  }

  const NOTE_ICON = '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M9 10.5v3.5M9 10.5h1.5M13 10.5v3.5M13 10.5h1.5"/></svg>'

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
   * has briefed says so, and shows its brief at a tap. An item's reading note opens from its row
   * (`reading`: the view, web/reading.js); its read mark is the user's to set and take off, and
   * its button reads Process before the mark and Discuss after it. `key()`: the
   * key for writes ('' : read-only); `store`: the page's storage for this project (whether the
   * panel is open, the order of the list).
   */
  function mount({ key = () => '', store, every = 2000, reading: view = null }) {
    const $ = id => document.getElementById(id)
    const btn = $('inbox-toggle'), badge = $('inbox-badge'), panel = $('inbox'), list = $('inbox-list')
    const total = $('inbox-count'), msg = $('inbox-msg')
    const link = $('inbox-link'), why = $('inbox-why'), save = $('inbox-save'), note = $('inbox-add-msg')
    let shown = null // what was last drawn: the order, whether the page may write, and the items as JSON
    let last = [] // the items as last read
    let notes = {} // what the reading notes of the items hold, by key
    let waiting = [] // the read items whose discussion found no chat, by key
    let order = ORDERS.includes(store.get('inboxOrder', 'priority')) ? store.get('inboxOrder', 'priority') : 'priority'
    let keep = 0 // until when the line at the foot stays, said of a write that failed
    let reads = 0 // counts what was asked of the server: an answer older than the last one drawn is dropped
    let sending = false
    let locked = false // the line under the field says the page is read-only
    const open = new Set() // the items whose brief is shown, by link and which of them
    const asked = new Map() // the items asked of the chat a moment ago, and until when: their Process waits, against a second tap
    const ASKED_MS = 10000
    // the agents came in, or changed: the picker and the buttons are drawn again
    AG.onChange(() => { shown = null; if (!panel.hidden) draw(last) })

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
     * One change to an item (its reading priority, its why, its read mark, or the item discarded),
     * written by the server. `from`: the control that asked, which the redraw may replace; `more`:
     * what else the request carries; `refused(status, got)`: true when the caller says itself what
     * a refusal means. The server's answer when it was made, else null.
     */
    async function change(r, action, value, from, more = {}, refused = null) {
      const body = { action, key: r.item.key, nth: r.nth, ...more }
      if (action !== 'discard') body[action] = value
      const what = action === 'discard' ? 'Not discarded' : action === 'read' ? 'Not marked' : 'Not changed'
      try {
        const res = await fetch('api/inbox', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RFT-Token': key() },
          body: JSON.stringify(body),
        })
        const got = await res.json().catch(() => ({}))
        reads++
        if (!res.ok || !Array.isArray(got.items)) {
          // a server from before the read mark knows no such action
          if (!(refused && refused(res.status, got))) setMsg(refusal(action === 'read' && res.status === 400 ? 404 : res.status, got, what), true)
          return null
        }
        setMsg('')
        shown = null
        take(got)
        draw(got.items, from)
        return got
      } catch (e) {
        setMsg(`${what}: the server did not answer.`, true)
        return null
      }
    }

    /** What an answer of the server says of the reading notes. */
    function take(got) {
      notes = got.notes && typeof got.notes === 'object' ? got.notes : {}
      waiting = Array.isArray(got.waiting) ? got.waiting : []
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

    /**
     * ✕ on an item: the first tap asks, the second discards it (its line goes under Processed).
     * When its reading note holds what the user wrote, the question says so, and the note goes
     * with the item; the server asks the same of a page that did not know.
     */
    function discardOf(r) {
      const { item } = r
      const x = el('button', 'inbox-x', '✕')
      x.type = 'button'
      let timer = 0, holds = false
      const arm = on => {
        clearTimeout(timer)
        if (on) holds = holds || reading(item, notes, waiting).mine
        else holds = false
        x.classList.toggle('armed', on)
        x.textContent = on ? (holds ? 'Discard, notes too?' : 'Discard?') : '✕'
        x.title = !on ? 'Discard: take it out of the inbox'
          : holds ? 'Its reading note holds what you wrote. Tap again to discard the item and remove the note with it'
            : 'Tap again to discard it: it leaves the inbox and is kept under Processed as discarded'
        x.setAttribute('aria-label', !on ? `Discard ${label(item)}` : holds ? `Discard ${label(item)} and the reading note that holds what you wrote: again to confirm` : `Discard ${label(item)}: again to confirm`)
        if (on) timer = setTimeout(() => { arm(false); draw(last) }, holds ? 8000 : 5000)
      }
      arm(false)
      x.addEventListener('blur', () => arm(false))
      x.addEventListener('click', async () => {
        if (!x.classList.contains('armed')) return arm(true)
        clearTimeout(timer)
        const at = [...list.children].indexOf(x.closest('li'))
        const focused = document.activeElement === x || document.activeElement === document.body
        const confirm = holds
        x.disabled = true
        x.classList.remove('armed')
        // the server found a reading note this page did not know of: asked again, saying so
        let asked = false
        const again = (status, got) => {
          if (status !== 409 || !got || !got.holds || confirm) return false
          asked = true
          return true
        }
        if (await change(r, 'discard', '', x, confirm ? { confirm: true } : {}, again)) {
          const next = list.children[Math.min(at, list.children.length - 1)]
          if (focused && !list.contains(document.activeElement)) (next ? next.querySelector('.inbox-link') : $('inbox-close')).focus()
        } else if (x.isConnected) {
          x.disabled = false
          holds = asked
          arm(asked)
          if (asked && focused) x.focus()
        }
      })
      return x
    }

    /** The sign of an item's reading note, which opens it: lit when it holds the user's part, plain with Claude's impression alone, faint with none. */
    function noteOf(r) {
      const { item } = r
      const s = reading(item, notes, waiting)
      const b = el('button', `inbox-note${s.mine ? ' mine' : ''}${s.impression ? ' imp' : ''}`)
      b.type = 'button'
      b.innerHTML = NOTE_ICON
      const holds = [s.mine ? 'your quotes and lines' : '', s.impression ? "Claude's impression" : ''].filter(Boolean).join(' and ')
      b.title = `Reading note: ${holds ? `it holds ${holds}` : 'quotes from it and lines of your own, as you read it'}`
      b.setAttribute('aria-label', `Reading note of ${label(item)}${holds ? `, with ${holds}` : ''}`)
      b.addEventListener('click', () => view.open(item))
      return b
    }

    /**
     * The user's mark that they have read an item, theirs alone to set and to take off. Setting it
     * opens their part of the reading note to Claude and starts the discussion in the chat, which
     * cannot be taken back: the first tap asks, the second sets it. With no chat the mark is saved
     * all the same and the row says the discussion waits.
     */
    function readOf(r) {
      const { item } = r
      if (!key()) return item.read ? el('span', 'inbox-read', '✓ read') : null
      const b = el('button', 'inbox-read')
      b.type = 'button'
      let timer = 0
      const show = armed => {
        clearTimeout(timer)
        b.classList.toggle('armed', armed)
        b.setAttribute('aria-pressed', String(!!item.read))
        b.textContent = armed ? 'Mark as read?' : item.read ? '✓ read' : 'mark read'
        b.title = armed ? 'Tap again: your part of its reading note opens to Claude, and the discussion starts in the chat'
          : item.read ? `Marked as read ${item.read}. Tap to take the mark off: your part of its reading note is closed to Claude again`
            : 'Mark as read once you have read it and written what you meant to: Claude then opens your part of its reading note and discusses the item with you in the chat'
        b.setAttribute('aria-label', armed ? `Mark ${label(item)} as read: again to confirm` : item.read ? `${label(item)} is marked as read. Take the mark off` : `Mark ${label(item)} as read`)
        if (armed) timer = setTimeout(() => { show(false); draw(last) }, 5000)
      }
      show(false)
      b.addEventListener('blur', () => show(false))
      b.addEventListener('click', async () => {
        if (!item.read && !b.classList.contains('armed')) return show(true)
        clearTimeout(timer)
        const set = !item.read
        b.disabled = true
        b.classList.remove('armed')
        const got = await change(r, 'read', set, b)
        if (!got) {
          if (b.isConnected) { b.disabled = false; show(false) }
          return
        }
        if (set) setMsg(got.asked ? 'Marked as read. Asked in the chat: Claude opens your part of the reading note there.' : 'Marked as read. No chat is connected: Discuss starts the discussion once one is.', false, ASKED_MS)
      })
      return b
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
     * The item's one button. Process, before the read mark: the item asked of Claude in the chat
     * that ran /rft, where it reads it on its own and saves its impression and its brief. Discuss,
     * after it: Claude opens the user's part of the reading note there, says where the two readings
     * differ, and the user picks what becomes of the item. Nothing changes here until Claude writes;
     * with no chat, the line at the foot says so and nothing waits.
     */
    function processOf(r) {
      const { item } = r
      const id = `${r.nth} ${item.key}`
      const discuss = reading(item, notes, waiting).action === 'discuss'
      const b = el('button', 'inbox-process', discuss ? 'Discuss' : 'Process')
      b.type = 'button'
      b.dataset.action = discuss ? 'discuss' : 'process'
      b.title = discuss ? 'Discuss: Claude opens your part of its reading note in the chat, says where its reading and yours differ, and you pick what becomes of it'
        : item.brief ? 'Process again: Claude reads it again on its own in the chat and rewrites its impression and its brief'
          : 'Process: Claude reads it on its own in the chat and saves its impression and its brief. You read it yourself and mark it as read to discuss it'
      b.setAttribute('aria-label', `${discuss ? 'Discuss' : 'Process'} ${label(item)} in the chat`)
      b.disabled = (asked.get(id) || 0) > Date.now()
      // an agent of the user's that the server launched: named on the button's tip, and stopped from here while it reads
      const mine = !discuss && AG.chosen('process') !== AG.CHAT ? AG.chosen('process') : ''
      const running = item.task && item.task.state === 'running'
      if (running) {
        b.textContent = 'Cancel'
        b.dataset.action = 'cancel'
        b.disabled = false
        b.title = `Stop ${item.task.agent}: nothing is saved`
        b.setAttribute('aria-label', `Stop ${item.task.agent} processing ${label(item)}`)
        b.addEventListener('click', async () => { b.disabled = true; await change(r, 'cancel', true, b) })
        return b
      }
      if (mine) {
        b.title = `Process: ${mine} reads it on its own and saves its impression and its brief. You read it yourself and mark it as read to discuss it`
        b.setAttribute('aria-label', `Process ${label(item)} with ${mine}`)
      }
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
        const what = discuss ? 'Not discussed' : 'Not processed'
        try {
          const res = await fetch('api/inbox', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-RFT-Token': key() },
            body: JSON.stringify({ action: discuss ? 'discuss' : 'process', key: item.key, nth: r.nth, ...(discuss ? {} : AG.extra('process')) }),
          })
          const got = await res.json().catch(() => ({}))
          if (!res.ok || !got.asked) {
            // a server from before Process, or before Discuss, knows no such action
            setMsg(refusal(res.status === 400 ? 404 : res.status, got, what), true)
            return free()
          }
          setMsg(discuss ? 'Asked in the chat: Claude opens your part of the reading note there.'
            : got.agent ? `Asked of ${got.agent}: it reads the item on its own and saves its impression and its brief.`
              : 'Asked in the chat: Claude reads it on its own and gives its brief there.', false, ASKED_MS)
          setTimeout(free, ASKED_MS)
          if (discuss || got.agent) { asked.delete(id); load() }
        } catch (e) {
          setMsg(`${what}: the server did not answer.`, true)
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
      head.append(a)
      if (view) head.append(noteOf(r))
      head.append(priorityButton(r))
      if (key()) head.append(discardOf(r))
      li.append(head)
      const under = el('div', 'inbox-under')
      // what is said of it, which wraps, and Process at its right
      const about = el('div', 'inbox-about')
      const why = whyOf(r), day = when(item), brief = briefOf(r), mark = readOf(r)
      if (why) about.append(why)
      if (day) about.append(el('span', 'inbox-when muted', day))
      if (brief) about.append(brief.mark)
      if (mark) about.append(mark)
      if (reading(item, notes, waiting).waiting) about.append(el('span', 'inbox-waiting', 'waiting for chat connection'))
      if (item.task && item.task.state === 'running') about.append(el('span', 'inbox-running', `${item.task.agent} is reading it…`))
      if (item.task && item.task.state === 'failed') about.append(el('span', 'inbox-failed', `Not processed: ${item.task.error}`))
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
      return [...list.querySelectorAll('.inbox-x.armed, .inbox-prio.pending, .inbox-read.armed')].some(x => x !== from)
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
      const json = `${order}${key() ? ' w ' : ' r '}${AG.chosen('process')} ${JSON.stringify([items, notes, waiting])}`
      // drawn once they leave it (the list's focusout), or at the next read
      if (json === shown || engaged(from)) return
      shown = json
      // a redraw under a reading priority, the brief's mark or Process leaves the focus on the one that replaces it
      const a = document.activeElement
      const cls = a && list.contains(a) && ['inbox-prio', 'inbox-briefed', 'inbox-process', 'inbox-note', 'inbox-read'].find(c => a.classList.contains(c))
      const at = cls ? { ...a.closest('li').dataset, cls } : null
      list.replaceChildren(...ordered(items, order).map(row))
      // who processes an item, when the user set agents up: picked above the list
      const had = panel.querySelector('.agent-pick')
      const pick = key() && n ? AG.picker('process', () => { shown = null; draw(last) }) : null
      if (had) had.remove()
      if (pick) list.before(pick)
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
        take(got)
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
        take(got)
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

    btn.addEventListener('click', () => {
      // an item's reading note stands in the panel's place: the button closes it, and the panel is back
      if (view && view.isOpen()) return view.close()
      setOpen(panel.hidden)
    })
    // back from a reading note: its sign on the row says what it holds now
    if ($('reading')) $('reading').addEventListener('rft:reading-closed', () => load())
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

  root.RftInbox = { count, label, when, refusal, ORDERS, PRIORITIES, nextPriority, priorityIcon, ordered, reading, mount }
})(typeof globalThis !== 'undefined' ? globalThis : window)
