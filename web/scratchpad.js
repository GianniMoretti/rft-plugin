// The scratchpad: quick notes and to-dos the user keeps beside the tree, in one markdown file at
// the vault's top (Scratchpad.md, read and written through the server's api/scratchpad), outside
// the tree. The pure part (the to-dos counted, a list continued on Enter, a to-do ticked) is
// tested on its own; `mount` wires the panel of the live page. Loaded before app.js; it sets
// `globalThis.RftScratchpad` and touches nothing else until mounted.
(function (root) {
  'use strict'

  // a list item: its indent, its mark (-, *, + or 1. / 1)), the space after it, and its box, if any
  const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(\[[ xX]\](?:[ \t]+|$))?/
  // a to-do: a list item with a box, open (`[ ]`) or done (`[x]`); m[0] ends with the box's `]`
  const TODO = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\](?=[ \t]|$)/
  const FENCE = /^[ \t]*(`{3,}|~{3,})/

  /** How many to-dos the text holds, open and done, outside code blocks. */
  function todos(text) {
    let open = 0, done = 0, fence = null
    for (const line of String(text || '').split('\n')) {
      const f = FENCE.exec(line)
      if (f) {
        if (!fence) fence = f[1][0]
        else if (f[1][0] === fence) fence = null
        continue
      }
      const m = fence ? null : TODO.exec(line)
      if (m && m[1] === ' ') open++
      else if (m) done++
    }
    return { open, done }
  }

  const lineStartOf = (text, at) => text.lastIndexOf('\n', at - 1) + 1
  const lineEndOf = (text, at) => { const i = text.indexOf('\n', at); return i < 0 ? text.length : i }

  /**
   * Enter on a list item, as an editor of notes does it: a new item below with the same mark (a
   * box unticked, a number one up), and the text after the caret moves into it; on an item with
   * nothing in it, the mark goes instead, which ends the list. An edit {from, to, insert, caret},
   * or null where Enter does what it always does (not in an item, a selection, the caret inside
   * the mark).
   */
  function continueList(text, start, end) {
    if (start !== end) return null
    const from = lineStartOf(text, start), to = lineEndOf(text, start)
    const line = text.slice(from, to)
    const m = ITEM.exec(line)
    if (!m || start < from + m[0].length) return null
    if (!line.slice(m[0].length).trim()) return { from, to, insert: '', caret: from }
    const [, indent, mark, space, box] = m
    const num = /^\d+/.exec(mark)
    const next = num ? String(Number(num[0]) + 1) + mark.slice(num[0].length) : mark
    const insert = '\n' + indent + next + space + (box ? '[ ] ' : '')
    return { from: start, to: start, insert, caret: start + insert.length }
  }

  /**
   * Ctrl/Cmd+Enter, as in Obsidian, on the caret's line or every line of the selection: lines that
   * are not to-dos become open ones (a plain line gets `- [ ] `, a list item a box) and the to-dos
   * among them stay; when every line is a to-do already, they are ticked, or, when all of them
   * are ticked, unticked. Blank lines stay blank. An edit {from, to, insert, start, end}: the
   * lines rewritten, and the selection kept on the same text.
   */
  function toggleTodo(text, start, end) {
    const from = lineStartOf(text, start)
    // a selection that ends at the start of a line leaves that line out
    const to = lineEndOf(text, end > start && text[end - 1] === '\n' ? end - 1 : end)
    const rows = text.slice(from, to).split('\n')
    const plain = rows.some(r => r.trim() && !TODO.exec(r))
    const tick = rows.some(r => { const m = TODO.exec(r); return m && m[1] === ' ' })
    const added = [] // [where, how many characters]: what moves the selection
    let at = from
    const out = rows.map(r => {
      const here = at
      at += r.length + 1
      if (!r.trim()) return r
      const m = TODO.exec(r)
      if (m) {
        if (plain) return r
        const i = m[0].length - 2 // the box's mark
        return r.slice(0, i) + (tick ? 'x' : ' ') + r.slice(i + 1)
      }
      const item = ITEM.exec(r)
      const pos = item ? item[0].length : /^[ \t]*/.exec(r)[0].length
      const add = item ? '[ ] ' : '- [ ] '
      added.push([here + pos, add.length])
      return r.slice(0, pos) + add + r.slice(pos)
    })
    // a caret moves past what was added at it; a selection keeps what was added at its start
    const shift = (p, past) => p + added.reduce((s, [q, n]) => s + (q < p || (past && q === p) ? n : 0), 0)
    return { from, to, insert: out.join('\n'), start: shift(start, start === end), end: shift(end, true) }
  }

  /**
   * The To-do button: an open to-do on the line below the caret's, indented as the caret's item
   * is, or on the caret's line when it is blank. An edit {from, to, insert, caret}.
   */
  function newTodo(text, at) {
    const from = lineStartOf(text, at), to = lineEndOf(text, at)
    const line = text.slice(from, to)
    if (!line.trim()) return { from, to, insert: '- [ ] ', caret: from + 6 }
    const item = ITEM.exec(line)
    const insert = '\n' + (item ? item[1] : '') + '- [ ] '
    return { from: to, to, insert, caret: to + insert.length }
  }

  /**
   * The panel in the live page. The button beside the legend's ? opens it and shows how many to-dos
   * are open; the text saves itself a moment after typing stops, and a change made elsewhere
   * (Obsidian, Claude) comes in while nothing typed waits to be saved; one that crosses an
   * unsaved change asks which to keep. `key()`: the key for writes ('' : read-only); `store`:
   * the page's storage for this project (whether the panel is open).
   */
  function mount({ key, store, every = 2000, wait = 600 }) {
    const $ = id => document.getElementById(id)
    const btn = $('pad-toggle'), badge = $('pad-badge'), panel = $('pad'), box = $('pad-text')
    const count = $('pad-count'), msg = $('pad-msg'), keep = $('pad-keep'), take = $('pad-take'), add = $('pad-add')
    let version = null // the file's version as last read or written (null: not made yet)
    let saved = null // its text then; null until it is first read
    let theirs = null // after a refused save: the file as it is now, { text, version }
    let saving = false, again = false, failed = false, timer = 0
    const dirty = () => saved !== null && box.value !== saved
    const readOnly = () => saved === null || !key()

    function setMsg(text, isError = false) {
      msg.textContent = text
      msg.classList.toggle('error', isError)
    }

    function showCount() {
      const { open, done } = todos(box.value)
      badge.textContent = open > 99 ? '99+' : String(open)
      badge.hidden = !open
      count.textContent = open || done ? `${open} open · ${done} done` : ''
      const label = `Scratchpad: quick notes and to-dos${open ? ` (${open} open)` : ''}`
      btn.title = label
      btn.setAttribute('aria-label', label)
    }

    function showConflict(on) {
      keep.hidden = take.hidden = !on
      if (on) setMsg('Changed elsewhere (Obsidian, Claude) since your last save:', true)
    }

    function syncReadOnly() {
      box.readOnly = readOnly()
      add.disabled = box.readOnly
      if (saved !== null && !key()) setMsg('Read-only: open the address /rft printed (it ends in ?token=…) once to write here.')
    }

    /** The text as the file has it, the caret kept where it was. */
    function setText(text) {
      const [s, e] = [box.selectionStart, box.selectionEnd]
      const first = saved === null
      box.value = text
      saved = text
      if (first) box.setSelectionRange(text.length, text.length) // a to-do added first goes at the end
      else box.setSelectionRange(Math.min(s, text.length), Math.min(e, text.length))
      showCount()
      syncReadOnly()
    }

    /** Reads the file; false when the server has no scratchpad (one started before it existed). */
    async function load() {
      try {
        const res = await fetch('api/scratchpad', { cache: 'no-store' })
        if (res.status === 404) return false
        const got = await res.json().catch(() => ({}))
        if (!res.ok || typeof got.text !== 'string') {
          if (saved === null) setMsg(`Not read: ${got.error || `the server answered ${res.status}`}.`, true)
          return true
        }
        if (theirs) theirs = { text: got.text, version: got.version }
        if (saving || theirs || dirty() || (saved !== null && got.version === version)) return true
        version = got.version
        setText(got.text)
      } catch (e) {
        // the page's own light says when the server is gone
      }
      return true
    }

    async function save(force = false) {
      clearTimeout(timer)
      if (readOnly() || (theirs && !force) || (!force && !dirty())) return
      if (saving) { again = true; return }
      saving = true
      const text = box.value
      setMsg('Saving…')
      try {
        const res = await fetch('api/scratchpad', {
          method: 'PUT',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'X-RFT-Token': key() },
          body: JSON.stringify(force ? { text, force: true } : { text, version }),
        })
        const got = await res.json().catch(() => ({}))
        failed = false
        if (res.ok) {
          version = got.version
          saved = text
          theirs = null
          showConflict(false)
          setMsg(dirty() ? 'Not saved yet' : 'Saved')
        } else if (res.status === 409) {
          theirs = { text: got.text, version: got.version }
          showConflict(true)
        } else setMsg(`Not saved: ${got.error || `the server answered ${res.status}`}.`, true)
      } catch (e) {
        failed = true
        setMsg('Not saved: the server is not answering. It saves again once it answers.', true)
      } finally {
        saving = false
      }
      if (again) { again = false; save() }
    }

    /** An edit from the helpers above, made through the editing commands so Ctrl+Z undoes it. */
    function apply(e) {
      if (!e || (e.from === e.to && !e.insert)) return
      box.focus()
      box.setSelectionRange(e.from, e.to)
      if (!document.execCommand(e.insert ? 'insertText' : 'delete', false, e.insert)) {
        box.setRangeText(e.insert, e.from, e.to, 'end')
        box.dispatchEvent(new Event('input'))
      }
      box.setSelectionRange(e.start ?? e.caret, e.end ?? e.caret)
    }

    function setOpen(open, focus = true) {
      panel.hidden = !open
      btn.setAttribute('aria-expanded', String(open))
      store.set('scratchpadOpen', open)
      if (open) {
        load()
        if (focus) box.focus()
      } else {
        save()
        if (panel.contains(document.activeElement)) btn.focus()
      }
    }

    box.addEventListener('input', () => {
      showCount()
      clearTimeout(timer)
      if (theirs || !dirty()) return
      setMsg('Not saved yet')
      timer = setTimeout(save, wait)
    })
    box.addEventListener('blur', () => save())
    box.addEventListener('keydown', ev => {
      if (ev.isComposing) return
      const mod = (ev.ctrlKey || ev.metaKey) && !ev.altKey
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); setOpen(false); return }
      if (mod && ev.key.toLowerCase() === 's') { ev.preventDefault(); ev.stopPropagation(); save(); return }
      if (ev.key !== 'Enter' || box.readOnly || ev.shiftKey || ev.altKey) return
      const edit = (mod ? toggleTodo : continueList)(box.value, box.selectionStart, box.selectionEnd)
      if (!edit) return
      ev.preventDefault()
      apply(edit)
    })
    btn.addEventListener('click', () => setOpen(panel.hidden))
    $('pad-close').addEventListener('click', () => setOpen(false))
    add.addEventListener('click', () => apply(newTodo(box.value, box.selectionEnd)))
    keep.addEventListener('click', () => save(true))
    take.addEventListener('click', () => {
      if (!theirs) return
      const t = theirs
      theirs = null
      version = t.version
      showConflict(false)
      setMsg('')
      setText(t.text)
    })
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load() })
    // leaving the page: what was typed in the last moment still goes
    window.addEventListener('pagehide', () => {
      if (!dirty() || readOnly() || theirs) return
      fetch('api/scratchpad', {
        method: 'PUT',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-RFT-Token': key() },
        body: JSON.stringify({ text: box.value, version }),
      }).catch(() => {})
    })

    // the button only once the server is known to keep a scratchpad
    load().then(found => {
      if (!found) return
      btn.hidden = false
      // a change elsewhere comes in; a save the server missed goes again
      setInterval(() => {
        if (document.hidden) return
        if (failed && dirty() && !saving) save()
        else load()
      }, every)
      if (store.get('scratchpadOpen', false)) setOpen(true, false)
    })
  }

  root.RftScratchpad = { todos, continueList, toggleTodo, newTodo, mount }
})(typeof globalThis !== 'undefined' ? globalThis : window)
