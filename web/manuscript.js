// The tree view's Manuscript tab (docs/design/manuscript.md): the documents and their LaTeX
// snippets, each resting on notes of the tree; one open in an editor (CodeMirror 5, vendored), the
// document's PDF beside it, compiled by the server (latexmk), with its errors. A snippet's basis
// opens its notes in the drawer, its state says when one changed (review), and its text is
// discussed as a note's is: comments and suggestions on a selection, answered by Claude when asked.
// The lock is Claude's: while the manuscript is locked Claude only proposes stubs and suggests; the
// user writes whatever the lock. Loaded by the page before app.js, which mounts it (the standalone
// page leaves it out); its pure parts are tested from tests/manuscript-view.test.ts.
(function (root) {
  'use strict'

  /** The characters kept on each side of a quote, to find it again (CONTEXT in hooks/lib/comments.ts). */
  const CONTEXT = 40
  const KINDS = ['definition', 'theorem', 'lemma', 'proposition', 'corollary', 'proof', 'method', 'result', 'related-work', 'motivation', 'discussion', 'figure', 'table']

  /** The quote of a selection and the text around it, as a thread is anchored. */
  function anchorOf(text, start, end) {
    return { quote: text.slice(start, end), prefix: text.slice(Math.max(0, start - CONTEXT), start), suffix: text.slice(end, end + CONTEXT) }
  }

  /** A document's snippets in its order (a line naming no snippet kept, marked absent), then the snippets in no document. */
  function listOf(ms, doc) {
    const snippets = (ms && ms.snippets) || []
    const docs = (ms && ms.documents) || []
    const byId = new Map(snippets.map(s => [s.id, s]))
    const d = docs.find(x => x.name === doc)
    const placed = d ? d.order.map(id => byId.get(id) || { id, absent: true }) : []
    const anywhere = new Set(docs.flatMap(x => x.order))
    return { placed, loose: snippets.filter(s => !anywhere.has(s.id)) }
  }

  /** A snippet's state in a word, and why: review (a basis note changed), stub (nothing written yet), written. */
  function stateOf(s) {
    if (s.review && s.review.length) return { word: 'review', why: s.review.join(', ') }
    return { word: s.stub ? 'stub' : 'written', why: '' }
  }

  /** The snippets resting on a note. */
  function writtenIn(ms, id) {
    return ms && ms.snippets ? ms.snippets.filter(s => (s.basis || []).includes(id)).map(s => s.id) : []
  }

  /** An error of the compile in a line: where (a snippet's id or the file) and what. */
  function errorText(e) {
    return `${e.snippet || e.file}${e.line ? `:${e.line}` : ''}: ${e.message}${e.context ? ` (${e.context})` : ''}`
  }

  function mount({ key, store, open, nodes, notify, visible, changed = () => {}, every = 4000 }) {
    const $ = id => document.getElementById(id)
    const section = $('manuscript')
    if (!section) return null
    const docSel = $('ms-doc'), listEl = $('ms-list'), headEl = $('ms-head'), threadsEl = $('ms-threads'), emptyEl = $('ms-empty')
    const pdfFrame = $('ms-pdf-frame'), pdfNote = $('ms-pdf-note'), errorsEl = $('ms-errors'), statusEl = $('ms-status')
    const lockBtn = $('ms-lock'), compileBtn = $('ms-compile'), body = $('ms-body')
    let ms = null // api/manuscript
    let doc = store.get('msDoc', '')
    let file = null // { path, sid, version, text (as read) }
    let note = null // the open snippet as api/note gives it: its threads
    let dirty = false
    let loading = false
    let pdfUrl = null
    let compiling = false
    let composing = null // { kind, anchor }
    let marks = []
    const canWrite = () => !!key()

    const cm = root.CodeMirror ? root.CodeMirror($('ms-cm'), {
      mode: 'stex', lineNumbers: true, lineWrapping: true, styleActiveLine: true, matchBrackets: true, tabSize: 2, indentUnit: 2,
      extraKeys: { 'Ctrl-S': () => save(true), 'Cmd-S': () => save(true) },
    }) : null
    if (cm) {
      cm.on('change', () => { if (!loading) { dirty = true; renderStatus() } })
      cm.on('cursorActivity', () => renderSelectionButtons())
    }

    function el(tag, props, ...kids) {
      const e = document.createElement(tag)
      for (const [k, v] of Object.entries(props || {})) {
        if (v == null || v === false) continue
        if (k === 'class') e.className = v
        else if (k === 'text') e.textContent = v
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
        else e.setAttribute(k, v === true ? '' : String(v))
      }
      for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid)
      return e
    }

    async function api(path, opts = {}) {
      const headers = { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(key() ? { 'X-RFT-Token': key() } : {}) }
      const res = await fetch(path, { cache: 'no-store', ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined })
      const data = await res.json().catch(() => ({}))
      return { ok: res.ok, status: res.status, data }
    }

    const needKey = what => { notify(`To ${what}, open the address /rft printed (it ends in ?token=…) once: this browser then remembers its key.`) }

    // ---------------------------------------------------------------- reading

    async function refresh() {
      let r
      try { r = await api('api/manuscript') } catch { return }
      if (!r.ok) return
      const was = JSON.stringify(ms)
      ms = r.data
      if (JSON.stringify(ms) !== was) changed() // the drawer's Written in follows
      if (!visible()) return
      render()
      if (file && !dirty) {
        try {
          const f = await api(`api/manuscript/file?path=${encodeURIComponent(file.path)}`)
          if (f.ok && f.data.version !== file.version) await openFile(file.path, true)
          else if (file.sid) await loadThreads()
        } catch { /* the next tick */ }
      }
    }

    function render() {
      const exists = ms && ms.exists
      emptyEl.hidden = !!exists
      body.hidden = !exists
      for (const b of section.querySelectorAll('.ms-needs')) b.hidden = !exists
      if (!exists) return
      const names = ms.documents.map(d => d.name)
      if (!names.includes(doc)) doc = names[0] || ''
      docSel.replaceChildren(...names.map(n => el('option', { value: n, text: n, selected: n === doc })))
      lockBtn.setAttribute('aria-pressed', String(ms.locked))
      lockBtn.querySelector('.lock-open').classList.toggle('on', !ms.locked)
      lockBtn.querySelector('.lock-closed').classList.toggle('on', ms.locked)
      lockBtn.title = ms.locked
        ? 'Locked: you write the manuscript; Claude proposes stubs, comments and suggests (click: let Claude write it too)'
        : 'Unlocked: Claude may write the snippets\' text too (click: lock it, yours to write)'
      compileBtn.disabled = !doc || !ms.latexmk
      compileBtn.title = ms.latexmk ? `Compile ${doc} with latexmk (Ctrl/Cmd+S saves and compiles)` : 'latexmk is not on PATH: install a TeX distribution (TeX Live) to compile'
      renderList()
      renderHead()
    }

    function stateBadge(s) {
      const st = stateOf(s)
      return el('span', { class: `ms-state ms-${st.word}`, text: st.word, title: st.why || (st.word === 'stub' ? 'Nothing written yet: its outline says what to write' : 'Written') })
    }

    function renderList() {
      const { placed, loose } = listOf(ms, doc)
      const item = s => s.absent
        ? el('li', { class: 'ms-item missing', title: 'Its \\rftsnippet line names no snippet' }, el('span', { class: 'ms-id', text: s.id }), ' no such snippet')
        : el('li', {
          class: `ms-item${file && file.sid === s.id ? ' open' : ''}`, title: `${s.id} ${s.kind}: ${s.title}`,
          onclick: () => openFile(`snippets/${s.id}.tex`),
        }, el('span', { class: 'ms-id', text: s.id }), el('span', { class: 'ms-title', text: s.title || '(no header)' }),
        stateBadge(s), s.unverified && s.unverified.length ? el('span', { class: 'ms-flag', text: '!', title: `Rests on notes not verified: ${s.unverified.join(', ')}` }) : null,
        s.threads ? el('span', { class: 'ms-threads-n', text: String(s.threads), title: `${s.threads} open thread(s)` }) : null)
      const docItem = doc ? el('li', {
        class: `ms-item ms-doc-item${file && file.path === `documents/${doc}/main.tex` ? ' open' : ''}`, title: 'The document: its preamble and the order of its snippets',
        onclick: () => openFile(`documents/${doc}/main.tex`),
      }, el('span', { class: 'ms-id', text: 'main.tex' }), el('span', { class: 'ms-title', text: doc })) : null
      listEl.replaceChildren(el('ul', {}, docItem, placed.map(item)))
      if (loose.length) listEl.append(el('div', { class: 'ms-sub muted', text: 'In no document' }), el('ul', {}, loose.map(item)))
    }

    function chip(id) {
      const n = nodes().get(id)
      if (!n) return el('span', { class: 'ms-chip missing', text: id, title: 'No such note in the tree' })
      return el('button', {
        type: 'button', class: 'ms-chip', title: `${n.name}: ${n.status}${n.summary ? ` · ${n.summary}` : ''} (click: read it)`,
        onclick: () => open(id),
      }, el('span', { class: `tdot tone ${n.type} s-${n.status}` }), ` ${id}`, n.status === 'verified' ? ' ✔' : n.status === 'review' ? ' ↺' : '')
    }

    function renderHead() {
      headEl.replaceChildren()
      if (!file) {
        headEl.append(el('span', { class: 'muted', text: 'Open a snippet or the document on the left.' }))
        return
      }
      const s = file.sid && ms && ms.snippets.find(x => x.id === file.sid)
      const saveBtn = el('button', { type: 'button', class: 'primary', text: 'Save', title: 'Save (Ctrl/Cmd+S also compiles)', onclick: () => save(false) })
      if (!s) {
        headEl.append(el('strong', { text: file.path }), el('span', { class: 'ms-spacer' }), saveBtn)
        return
      }
      const st = stateOf(s)
      const row1 = el('div', { class: 'ms-head-row' },
        el('strong', { text: `${s.id} · ${s.kind} · ${s.title}` }), stateBadge(s),
        st.word === 'review' ? el('span', { class: 'muted', text: st.why }) : null,
        st.word === 'review' ? el('button', { type: 'button', text: 'Reviewed', title: 'Its text still holds against its notes as they are now: take its stamp anew', onclick: () => reviewed(s.id) }) : null,
        ms.locked ? el('button', {
          type: 'button', class: `icon-btn ms-lock-one${s.locked ? '' : ' open'}`, text: s.locked ? '🔒' : '🔓',
          title: s.locked ? 'Yours to write: Claude only suggests (click: let Claude write this snippet)' : 'Claude may write this snippet (click: yours again)',
          onclick: () => setLock(!s.locked, s.id),
        }) : null,
        el('span', { class: 'ms-spacer' }), $c('comment'), $c('suggestion'), saveBtn)
      const row2 = el('div', { class: 'ms-head-row ms-basis' },
        el('span', { class: 'muted', text: 'Rests on' }),
        s.basis.length ? s.basis.map(chip) : el('span', { class: 'muted', text: 'no note: give it a % basis: line' }),
        s.unverified.length ? el('span', { class: 'ms-flag-text', text: `not verified: ${s.unverified.join(', ')}` }) : null,
        s.missing.length ? el('span', { class: 'ms-flag-text', text: `no such note: ${s.missing.join(', ')}` }) : null)
      headEl.append(row1, row2)
      renderSelectionButtons()
    }

    /** The Comment or Suggest button: on the text selected in the editor. */
    function $c(kind) {
      return el('button', {
        type: 'button', class: 'ms-sel-btn', 'data-kind': kind, text: kind === 'comment' ? 'Comment' : 'Suggest',
        title: kind === 'comment' ? 'A question or remark on the selected text' : 'New text for the selected text, or what should change in words',
        onclick: () => compose(kind),
      })
    }

    function renderSelectionButtons() {
      const on = !!(cm && file && file.sid && cm.somethingSelected() && !dirty)
      for (const b of headEl.querySelectorAll('.ms-sel-btn')) {
        b.disabled = !on
        if (dirty && file && file.sid) b.title = 'Save first: a thread is anchored on the text as saved'
      }
    }

    function renderStatus(text) {
      statusEl.textContent = text != null ? text : dirty ? 'Unsaved changes' : ''
    }

    async function openFile(path, keepPlace = false) {
      if (!cm) return
      if (dirty && !keepPlace && !confirm('Leave the unsaved changes?')) return
      let r
      try { r = await api(`api/manuscript/file?path=${encodeURIComponent(path)}`) } catch { notify('The server is not answering.'); return }
      if (!r.ok) { notify(r.data.error || `Not opened (${r.status})`); return }
      const sid = (/^snippets\/(S\d+)\.tex$/.exec(path) || [])[1] || null
      const cursor = keepPlace ? cm.getCursor() : null
      const scroll = keepPlace ? cm.getScrollInfo() : null
      loading = true
      cm.setValue(r.data.text)
      cm.clearHistory()
      loading = false
      if (cursor) { cm.setCursor(cursor); cm.scrollTo(scroll.left, scroll.top) }
      file = { path, sid, version: r.data.version, text: r.data.text }
      store.set('msFile', path)
      dirty = false
      composing = null
      renderStatus()
      if (ms) { renderList(); renderHead() }
      await loadThreads()
      setTimeout(() => cm.refresh(), 0)
    }

    async function save(andCompile) {
      if (!file || !cm) return
      if (!canWrite()) { needKey('save the manuscript'); return }
      if (dirty) {
        let r = await api('api/manuscript/file', { method: 'PUT', body: { path: file.path, text: cm.getValue(), version: file.version } })
        if (r.status === 409) {
          if (!confirm(`${file.path} changed on disk since you opened it (Claude, Obsidian, another tab). Overwrite it with yours? (Cancel: reload it, and lose yours)`)) {
            dirty = false
            await openFile(file.path, true)
            return
          }
          r = await api('api/manuscript/file', { method: 'PUT', body: { path: file.path, text: cm.getValue(), force: true } })
        }
        if (!r.ok) { notify(r.data.error || `Not saved (${r.status})`); return }
        file.version = r.data.version
        file.text = r.data.text
        dirty = false
        renderStatus('Saved')
        await refresh()
      }
      if (andCompile) await compile()
    }

    // ---------------------------------------------------------------- the PDF

    async function compile() {
      if (!doc || compiling) return
      if (!canWrite()) { needKey('compile the manuscript'); return }
      compiling = true
      compileBtn.disabled = true
      renderStatus(`Compiling ${doc}…`)
      try {
        const r = await api('api/manuscript/compile', { method: 'POST', body: { doc } })
        const c = r.data || {}
        renderErrors(c)
        renderStatus(c.ok ? `Compiled in ${c.seconds} s` : c.error ? 'Not compiled' : `Errors (${(c.errors || []).length}): the last good PDF stays`)
        // a failed compile leaves the last good PDF on screen
        if (c.ok || pdfFrame.hidden) await loadPdf()
      } catch {
        renderStatus('The server is not answering.')
      } finally {
        compiling = false
        compileBtn.disabled = !doc || !(ms && ms.latexmk)
        await refresh()
      }
    }

    function renderErrors(c) {
      errorsEl.replaceChildren()
      const errs = c.errors || []
      const warns = c.warnings || []
      if (c.error) errorsEl.append(el('div', { class: 'ms-err', text: c.error }))
      for (const e of errs) {
        errorsEl.append(el('button', {
          type: 'button', class: 'ms-err', text: errorText(e), title: 'Go to it',
          onclick: async () => {
            const path = e.snippet ? `snippets/${e.snippet}.tex` : e.file
            if (!file || file.path !== path) await openFile(path)
            if (e.line && cm) { cm.setCursor({ line: e.line - 1, ch: 0 }); cm.focus() }
          },
        }))
      }
      for (const w of warns) errorsEl.append(el('div', { class: 'ms-warn', text: w }))
      errorsEl.hidden = !errs.length && !warns.length && !c.error
    }

    async function loadPdf() {
      if (!doc) return
      const d = ms && ms.documents.find(x => x.name === doc)
      if (!canWrite()) { pdfNote.textContent = 'The PDF is shown to the page carrying the key: open the address /rft printed once.'; pdfNote.hidden = false; return }
      try {
        const res = await fetch(`api/manuscript/pdf?doc=${encodeURIComponent(doc)}`, { cache: 'no-store', headers: { 'X-RFT-Token': key() } })
        if (!res.ok) {
          pdfFrame.hidden = true
          pdfNote.textContent = d && !d.built ? `${doc} has not been compiled yet: Compile.` : 'No PDF yet.'
          pdfNote.hidden = false
          return
        }
        const blob = await res.blob()
        if (pdfUrl) URL.revokeObjectURL(pdfUrl)
        pdfUrl = URL.createObjectURL(blob)
        pdfFrame.src = pdfUrl
        pdfFrame.hidden = false
        pdfNote.hidden = true
      } catch { /* the next compile */ }
    }

    // ---------------------------------------------------------------- the discussion

    async function loadThreads() {
      clearMarks()
      if (!file || !file.sid) { note = null; threadsEl.replaceChildren(); threadsEl.hidden = true; return }
      try {
        const r = await api(`api/note?id=${encodeURIComponent(file.sid)}`)
        note = r.ok ? r.data : null
      } catch { note = null }
      renderThreads()
    }

    function clearMarks() {
      for (const m of marks) m.clear()
      marks = []
    }

    function renderThreads() {
      clearMarks()
      threadsEl.replaceChildren()
      const threads = (note && note.threads) || []
      const open = threads.filter(t => t.state === 'open')
      if (cm && !dirty) {
        for (const t of open) {
          if (!t.at) continue
          marks.push(cm.markText(cm.posFromIndex(t.at[0]), cm.posFromIndex(t.at[1]), { className: `ms-mark ms-mark-${t.kind}`, title: `${t.id}: ${t.kind}` }))
        }
      }
      if (composing) threadsEl.append(composer())
      for (const t of open) threadsEl.append(threadEl(t))
      const closed = threads.filter(t => t.state !== 'open')
      if (closed.length) {
        threadsEl.append(el('details', { class: 'ms-history' }, el('summary', { text: `History (${closed.length})` }), closed.map(t => threadEl(t))))
      }
      threadsEl.hidden = !threadsEl.childNodes.length
    }

    function threadEl(t) {
      const isOpen = t.state === 'open'
      const reply = el('textarea', { rows: 1, placeholder: 'Reply…', 'aria-label': 'Reply' })
      const act = (action, extra = {}) => async () => {
        if (!canWrite()) { needKey('discuss the manuscript'); return }
        const text = reply.value.trim()
        if (text && action !== 'reply') {
          const r = await api('api/comment', { method: 'POST', body: { id: file.sid, action: 'reply', thread: t.id, text } })
          if (!r.ok) { notify(r.data.error || 'Not sent'); return }
        }
        if (action !== 'reply' || text) {
          const r = await api('api/comment', { method: 'POST', body: { id: file.sid, action, thread: t.id, ...(action === 'reply' ? { text } : {}), ...extra } })
          if (!r.ok) notify(r.data.error || `Not done (${r.status})`)
          else note = r.data
        }
        if (action === 'accept') await openFile(file.path, true)
        else renderThreads()
        await refresh()
      }
      const quoteEl = el('blockquote', { class: 'ms-quote', text: t.quote, title: isOpen ? 'Show it in the text' : '' })
      if (isOpen && t.at && cm) quoteEl.addEventListener('click', () => { cm.setSelection(cm.posFromIndex(t.at[0]), cm.posFromIndex(t.at[1])); cm.focus() })
      return el('div', { class: `ms-thread ${t.kind}${isOpen ? '' : ' closed'}` },
        el('div', { class: 'ms-thread-head' }, el('strong', { text: `${t.id} · ${t.kind}` }), el('span', { class: 'muted', text: isOpen ? (t.asked ? ' · Claude asked' : '') : ` · ${t.state}` }),
          isOpen && !t.at ? el('span', { class: 'ms-flag-text', text: ' the quoted text is no longer there' }) : null,
          isOpen && t.at && !t.exact ? el('span', { class: 'ms-flag-text', text: ' the quoted text changed since' }) : null),
        quoteEl,
        t.kind === 'suggestion' && t.replacement != null ? el('div', { class: 'ms-repl' }, el('span', { class: 'muted', text: 'Replacement: ' }), el('code', { text: t.replacement })) : null,
        (t.messages || []).map(m => el('div', { class: `ms-msg ${m.by}` }, el('span', { class: 'muted', text: `${m.by === 'you' ? 'You' : 'Claude'} · ${m.at}: ` }), m.text)),
        isOpen ? el('div', { class: 'ms-thread-act' }, reply,
          el('button', { type: 'button', text: 'Reply', onclick: act('reply') }),
          el('button', { type: 'button', text: 'Ask Claude', title: 'Claude answers in the thread (a comment: a reply; a suggestion: its new text, for you to accept)', onclick: act('ask') }),
          t.kind === 'comment' ? el('button', { type: 'button', text: 'Resolve', onclick: act('resolve') }) : null,
          t.kind === 'suggestion' ? el('button', { type: 'button', text: 'Accept', disabled: t.replacement == null || !t.exact, title: 'Write its replacement into the snippet', onclick: act('accept') }) : null,
          t.kind === 'suggestion' ? el('button', { type: 'button', text: 'Reject', onclick: act('reject') }) : null)
          : el('div', { class: 'ms-thread-act' }, el('button', { type: 'button', text: 'Reopen', onclick: act('reopen') })))
    }

    function compose(kind) {
      if (!cm || !file || !file.sid || !cm.somethingSelected()) return
      const text = cm.getValue()
      const start = cm.indexFromPos(cm.getCursor('from')), end = cm.indexFromPos(cm.getCursor('to'))
      composing = { kind, anchor: anchorOf(text, start, end) }
      renderThreads()
      const box = threadsEl.querySelector('.ms-composer textarea')
      if (box) box.focus()
    }

    function composer() {
      const c = composing
      const msg = el('textarea', { rows: 2, placeholder: c.kind === 'comment' ? 'Your comment' : 'Why, or what should change (optional when you write the new text)' })
      const repl = c.kind === 'suggestion' ? el('textarea', { rows: 3, class: 'ms-repl-box', 'aria-label': 'New text' }) : null
      if (repl) repl.value = c.anchor.quote
      const post = ask => async () => {
        if (!canWrite()) { needKey('discuss the manuscript'); return }
        const body = { id: file.sid, action: 'new', kind: c.kind, ...c.anchor, text: msg.value.trim(), ...(repl ? { replacement: repl.value } : {}) }
        const r = await api('api/comment', { method: 'POST', body })
        if (!r.ok) { notify(r.data.error || `Not posted (${r.status})`); return }
        composing = null
        note = r.data
        if (ask) {
          const t = note.threads[note.threads.length - 1]
          const a = await api('api/comment', { method: 'POST', body: { id: file.sid, action: 'ask', thread: t.id } })
          if (a.ok) note = a.data
        }
        renderThreads()
        await refresh()
      }
      return el('div', { class: 'ms-composer' },
        el('blockquote', { class: 'ms-quote', text: c.anchor.quote }), repl, msg,
        el('div', { class: 'ms-thread-act' },
          el('button', { type: 'button', class: 'primary', text: 'Post', onclick: post(false) }),
          el('button', { type: 'button', text: c.kind === 'comment' ? 'Post and ask Claude' : 'Post and suggest', onclick: post(true) }),
          el('button', { type: 'button', text: 'Cancel', onclick: () => { composing = null; renderThreads() } })))
    }

    // ---------------------------------------------------------------- what the session makes

    async function ask(body, what) {
      if (!canWrite()) { needKey(what); return null }
      renderStatus(`${what[0].toUpperCase()}${what.slice(1)}…`)
      const r = await api('api/manuscript/ask', { method: 'POST', body })
      renderStatus('')
      if (!r.ok) { notify(r.data.error || `Could not ${what} (${r.status})`); return null }
      ms = r.data
      render()
      return r.data
    }

    async function reviewed(id) {
      if (await ask({ action: 'reviewed', id }, 'mark it reviewed')) renderHead()
    }

    async function setLock(locked, id) {
      if (!canWrite()) { needKey('change the lock'); return }
      const r = await api('api/manuscript/lock', { method: 'POST', body: id ? { locked, id } : { locked } })
      if (!r.ok) { notify(r.data.error || 'Not changed'); return }
      ms = r.data
      render()
    }

    function newSnippetForm() {
      const form = $('ms-new-form')
      const kindSel = $('ms-new-kind')
      if (!kindSel.options.length) for (const k of KINDS) kindSel.append(el('option', { value: k, text: k }))
      const list = $('ms-notes')
      const all = [...nodes().values()].sort((a, b) => (b.status === 'verified') - (a.status === 'verified') || a.id.localeCompare(b.id, undefined, { numeric: true }))
      list.replaceChildren(...all.map(n => el('option', { value: n.id, text: `${n.id} ${n.title} (${n.status})` })))
      form.hidden = !form.hidden
      if (!form.hidden) $('ms-new-title').focus()
    }

    $('ms-new').addEventListener('click', newSnippetForm)
    $('ms-new-cancel').addEventListener('click', () => { $('ms-new-form').hidden = true })
    $('ms-new-form').addEventListener('submit', async ev => {
      ev.preventDefault()
      const basis = $('ms-new-basis').value.split(/[,\s]+/).map(x => x.trim().toUpperCase()).filter(Boolean)
      const got = await ask({ action: 'new', kind: $('ms-new-kind').value, title: $('ms-new-title').value.trim(), basis, document: doc || undefined }, 'add the snippet')
      if (!got) return
      $('ms-new-form').hidden = true
      $('ms-new-title').value = ''
      $('ms-new-basis').value = ''
      await openFile(`snippets/${got.id}.tex`)
    })
    $('ms-new-doc').addEventListener('click', async () => {
      const name = (prompt('The new document\'s name (lowercase letters, digits and dashes), then a space and "report" for a thesis chapter:', '') || '').trim()
      if (!name) return
      const [n, kind] = name.split(/\s+/)
      const got = await ask({ action: 'document', name: n, kind: kind === 'report' ? 'report' : 'article' }, 'add the document')
      if (got) { doc = n; store.set('msDoc', doc); render(); await openFile(`documents/${doc}/main.tex`) }
    })
    $('ms-start').addEventListener('click', async () => {
      const got = await ask({ action: 'document', name: 'paper', kind: 'article' }, 'start the manuscript')
      if (got) { doc = 'paper'; render(); await openFile('documents/paper/main.tex') }
    })
    docSel.addEventListener('change', async () => {
      doc = docSel.value
      store.set('msDoc', doc)
      renderList()
      renderErrors({})
      await loadPdf()
    })
    lockBtn.addEventListener('click', () => ms && setLock(!ms.locked))
    compileBtn.addEventListener('click', () => save(true))

    let timer = 0
    async function show() {
      await refresh()
      if (!file && ms && ms.exists) {
        // ?snippet=S04 in the address opens it; else the file open last
        const asked = new URLSearchParams(location.search).get('snippet')
        const last = asked && /^S\d+$/i.test(asked) ? `snippets/${asked.toUpperCase()}.tex` : store.get('msFile', '')
        const path = last && (last.startsWith('documents/') || ms.snippets.some(s => `snippets/${s.id}.tex` === last)) ? last : doc ? `documents/${doc}/main.tex` : ''
        if (path) await openFile(path, true)
      }
      if (cm) setTimeout(() => cm.refresh(), 0)
      await loadPdf()
    }
    clearInterval(timer)
    // the summary follows the vault on every page (the drawer's Written in reads it); the tab redraws only when shown
    timer = setInterval(() => { void refresh() }, every)
    void refresh()
    return { show, writtenIn: id => writtenIn(ms, id), openSnippet: id => openFile(`snippets/${id}.tex`), get summary() { return ms } }
  }

  root.RftManuscript = { CONTEXT, KINDS, anchorOf, listOf, stateOf, writtenIn, errorText, mount }
})(typeof window !== 'undefined' ? window : globalThis)
