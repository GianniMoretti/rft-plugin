// The reading note of an inbox item: the user's part (quotes from the item and lines of their own)
// in one plain markdown box that saves itself as the scratchpad does, opened from the item's row in
// the inbox (web/inbox.js) and kept in one file per item (Reading notes/ in the vault, read and
// written through the server's api/reading, which writes the user's part and nothing else of the
// file). Claude's impression of the item, when it has one, is shown folded under the box and is
// never edited here. The pure part (a quote's lines, where a quote goes in the text) is tested on
// its own; `mount` wires the view of the live page. Loaded before inbox.js and app.js; it sets
// `globalThis.RftReading` and touches nothing else until mounted.
(function (root) {
  'use strict'

  /** A text as a quote: each of its lines after `> ` (a blank one as `>`), without the blank lines at its two ends. */
  function quote(text) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[ \t]+$/, ''))
    while (lines.length && !lines[0].trim()) lines.shift()
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
    return lines.map(l => (l ? `> ${l}` : '>')).join('\n')
  }

  /**
   * The edit that puts `text` as a quote where the caret is (in place of what is selected): the
   * quote stands as a paragraph of its own, a blank line before it and after it, and the caret
   * ends on the line after, ready for a line of the user's own. Null when there is nothing to quote.
   */
  function pasteQuote(value, start, end, text) {
    const q = quote(text)
    if (!q) return null
    const before = value.slice(0, start), after = value.slice(end)
    const lead = !before ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n'
    const trail = after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n'
    const insert = `${lead}${q}${trail}`
    return { from: start, to: end, insert, caret: start + insert.length + (after.startsWith('\n\n') ? 2 : after.startsWith('\n') ? 1 : 0) }
  }

  /**
   * The edit that marks the lines the selection touches as a quote: `> ` before each (a line that
   * is one already stays as it is). Null when the selection is empty.
   */
  function quoteLines(value, start, end) {
    if (start === end) return null
    const from = value.lastIndexOf('\n', start - 1) + 1
    const stop = value.indexOf('\n', end > start && value[end - 1] === '\n' ? end - 1 : end)
    const to = stop < 0 ? value.length : stop
    const insert = value.slice(from, to).split('\n').map(l => (/^[ \t]*>/.test(l) ? l : l.trim() ? `> ${l}` : '>')).join('\n')
    return { from, to, insert, start: from, end: from + insert.length }
  }

  /** How many quotes a text holds: its runs of lines that start with `>`. */
  function quotes(text) {
    let n = 0, inside = false
    for (const line of String(text || '').split('\n')) {
      const is = /^[ \t]*>/.test(line)
      if (is && !inside) n++
      inside = is
    }
    return n
  }

  /** What the view is headed: the item's title, else `arXiv <id>`, `doi <doi>`, or the host and path of its address. */
  function label(item) {
    if (item.title) return item.title
    const key = String(item.key || '')
    if (key.startsWith('arxiv:')) return `arXiv ${key.slice(6)}`
    if (key.startsWith('doi:')) return `doi ${key.slice(4)}`
    return String(item.url || key).replace(/^https?:\/\//i, '').replace(/[?#].*$/, '').replace(/\/$/, '')
  }

  /**
   * The view in the live page: the whole page on a phone, a wide pane in the corner at the desk,
   * in the inbox's place while it is open. `open(item)` shows the reading note of an inbox item;
   * closing it gives the place back to the inbox. The text saves itself a moment after typing
   * stops; a change made elsewhere (Obsidian) comes in while nothing typed waits to be saved, and
   * one that crosses an unsaved change asks which to keep. An impression Claude saves meanwhile is
   * no change to the user's part. `key()`: the key for writes ('' : read-only).
   */
  function mount({ key = () => '', every = 2000, wait = 600 }) {
    const $ = id => document.getElementById(id)
    const panel = $('reading'), box = $('reading-text'), title = $('reading-title'), count = $('reading-count')
    const msg = $('reading-msg'), keep = $('reading-keep'), take = $('reading-take'), paste = $('reading-quote')
    const imp = $('reading-imp'), impHead = $('reading-imp-head'), impText = $('reading-imp-text'), file = $('reading-file')
    if (!panel) return null
    let item = null // the item whose note is shown
    let version = null // the user's part as last read or written (null: the item has no note yet)
    let saved = null // its text then; null until it is first read
    let theirs = null // after a refused save: the part as it is now, { text, version }
    let saving = false, again = false, failed = false, timer = 0, armed = false, reads = 0
    const dirty = () => saved !== null && box.value !== saved
    const readOnly = () => saved === null || !key()
    const url = () => `api/reading?key=${encodeURIComponent(item.key)}`

    function setMsg(text, isError = false) {
      msg.textContent = text
      msg.classList.toggle('error', isError)
    }

    function showCount() {
      const n = quotes(box.value)
      count.textContent = n ? `${n} ${n === 1 ? 'quote' : 'quotes'}` : ''
    }

    function showConflict(on) {
      keep.hidden = take.hidden = !on
      if (on) setMsg('Changed elsewhere (Obsidian) since your last save:', true)
    }

    function arm(on) {
      armed = on
      paste.classList.toggle('armed', on)
      paste.setAttribute('aria-pressed', String(on))
      paste.textContent = on ? 'Paste now' : 'Paste as quote'
      if (on) setMsg('Paste into the text: it goes in as a quote.')
      else if (msg.textContent.startsWith('Paste into')) setMsg('')
    }

    function syncReadOnly() {
      box.readOnly = readOnly()
      paste.disabled = box.readOnly
      if (saved !== null && !key()) setMsg('Read-only: open the address /rft printed (it ends in ?token=…) once to write here.')
    }

    function setText(text) {
      const [s, e] = [box.selectionStart, box.selectionEnd]
      const first = saved === null
      box.value = text
      saved = text
      if (first) box.setSelectionRange(text.length, text.length)
      else box.setSelectionRange(Math.min(s, text.length), Math.min(e, text.length))
      showCount()
      syncReadOnly()
    }

    /** Claude's impression, folded under the box; shut again for each item. */
    function showImpression(got) {
      imp.hidden = !got
      if (!got) return
      impHead.textContent = `${got.by || 'Claude'}'s impression${got.date ? ` · ${got.date}` : ''}`
      impText.textContent = got.text
    }

    /** Reads the note of the item shown; an answer for an item the view has left is dropped. */
    async function load() {
      if (!item) return
      const mine = ++reads, of = item.key
      try {
        const res = await fetch(url(), { cache: 'no-store' })
        const got = await res.json().catch(() => ({}))
        if (mine !== reads || !item || item.key !== of) return
        if (!res.ok || typeof got.text !== 'string') {
          if (saved === null || res.status === 409) setMsg(res.status === 404 ? 'Not read: the server running is older than this page. /rft restart starts the new one.' : `Not read: ${got.error || `the server answered ${res.status}`}.`, true)
          return
        }
        file.textContent = got.name || ''
        showImpression(got.impression)
        if (theirs) theirs = { text: got.text, version: got.version }
        if (saving || theirs || dirty() || (saved !== null && got.version === version)) return
        version = got.version
        setText(got.text)
      } catch (e) {
        // the page's own light says when the server is gone
      }
    }

    async function save(force = false) {
      clearTimeout(timer)
      if (!item || readOnly() || (theirs && !force) || (!force && !dirty())) return
      if (saving) { again = true; return }
      saving = true
      const text = box.value, of = item.key
      setMsg('Saving…')
      try {
        const res = await fetch('api/reading', {
          method: 'PUT',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'X-RFT-Token': key() },
          body: JSON.stringify(force ? { key: of, text, force: true } : { key: of, text, version }),
        })
        const got = await res.json().catch(() => ({}))
        failed = false
        if (!item || item.key !== of) return
        if (res.ok) {
          version = got.version
          saved = text
          theirs = null
          showConflict(false)
          setMsg(dirty() ? 'Not saved yet' : 'Saved')
        } else if (res.status === 409 && typeof got.text === 'string') {
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
      if (!document.execCommand('insertText', false, e.insert)) {
        box.setRangeText(e.insert, e.from, e.to, 'end')
        box.dispatchEvent(new Event('input'))
      }
      box.setSelectionRange(e.start ?? e.caret, e.end ?? e.caret)
    }

    /** What is typed and not saved yet goes, without waiting for its answer (the view closes, the page leaves). */
    function flush() {
      if (!item || !dirty() || readOnly() || theirs) return
      fetch('api/reading', {
        method: 'PUT',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-RFT-Token': key() },
        body: JSON.stringify({ key: item.key, text: box.value, version }),
      }).catch(() => {})
    }

    function open(of, focus = true) {
      if (item && item.key !== of.key) flush()
      item = of
      version = saved = theirs = null
      box.value = ''
      box.readOnly = true
      imp.open = false
      showImpression(null)
      showConflict(false)
      setMsg('')
      arm(false)
      title.textContent = label(of)
      title.href = of.url
      title.title = of.url
      file.textContent = ''
      showCount()
      // one panel in the corner: the inbox gives its place, and takes it back when the view closes
      if ($('inbox')) $('inbox').hidden = true
      panel.hidden = false
      load().then(() => {
        // with a mouse the text is ready to type in; a finger's tap would raise the keyboard over the note
        if (focus && item === of) (key() && window.matchMedia('(pointer: fine)').matches ? box : $('reading-close')).focus()
      })
    }

    function close() {
      if (panel.hidden) return
      clearTimeout(timer)
      flush()
      const had = panel.contains(document.activeElement)
      panel.hidden = true
      item = null
      saved = null
      const inbox = $('inbox')
      if (inbox) {
        inbox.hidden = false
        if (had) (inbox.querySelector('.inbox-note:focus, .inbox-link') || $('inbox-close')).focus()
      }
      panel.dispatchEvent(new Event('rft:reading-closed'))
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
      if (ev.key === 'Escape') {
        ev.preventDefault()
        ev.stopPropagation()
        if (armed) arm(false)
        else close()
      } else if (mod && ev.key.toLowerCase() === 's') {
        ev.preventDefault()
        ev.stopPropagation()
        save()
      }
    })
    // the paste the button asked for goes in as a quote; any other paste is the browser's
    box.addEventListener('paste', ev => {
      if (!armed || box.readOnly) return
      const text = ev.clipboardData ? ev.clipboardData.getData('text/plain') : ''
      arm(false)
      const edit = pasteQuote(box.value, box.selectionStart, box.selectionEnd, text)
      if (!edit) return
      ev.preventDefault()
      apply(edit)
    })
    /**
     * Paste as quote: with lines selected in the text, they become a quote. Else the clipboard's
     * text goes in as one where the caret is: read at once where the browser lets the page (a
     * secure address, the user's yes), and else the button waits for the user's own paste.
     */
    paste.addEventListener('click', async () => {
      if (box.readOnly) return
      if (armed) return arm(false)
      const lines = quoteLines(box.value, box.selectionStart, box.selectionEnd)
      if (lines) return apply(lines)
      let text = null
      try {
        if (navigator.clipboard && navigator.clipboard.readText) text = await navigator.clipboard.readText()
      } catch (e) {
        text = null
      }
      const edit = text ? pasteQuote(box.value, box.selectionStart, box.selectionEnd, text) : null
      if (edit) return apply(edit)
      arm(true)
      box.focus()
    })
    $('reading-close').addEventListener('click', close)
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
    panel.addEventListener('keydown', ev => {
      if (ev.key !== 'Escape' || ev.isComposing) return
      ev.preventDefault()
      ev.stopPropagation()
      close()
    })
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load() })
    window.addEventListener('pagehide', flush)
    setInterval(() => {
      if (document.hidden || panel.hidden) return
      if (failed && dirty() && !saving) save()
      else load()
    }, every)

    return { open, close, isOpen: () => !panel.hidden, item: () => item }
  }

  root.RftReading = { quote, pasteQuote, quoteLines, quotes, label, mount }
})(typeof globalThis !== 'undefined' ? globalThis : window)
