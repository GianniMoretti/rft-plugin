// The tree view's Manuscript tab (docs/design/manuscript.md): two levels, two views.
// Snippets: the building blocks, each resting on notes of the tree, written once and reused; the
// library by kind, one open in an editor (CodeMirror 5, vendored) with its notes and the documents
// using it, compiled alone beside it. Documents: what is built with them; a document's outline (its
// headings and its copies of snippets, each with its state), copies placed from the library, moved
// or removed, a copy whose snippet changed shown then and now (take the new text, or keep yours),
// the editor on the document and its PDF beside it. Both are discussed as a note is (comments and
// suggestions on a selection, Ask Claude). The locks are Claude's: the user writes whatever they
// say. Loaded by the page before app.js, which mounts it (the standalone page leaves it out); its
// pure parts are tested from tests/manuscript-view.test.ts.
(function (root) {
  'use strict'

  /** The characters kept on each side of a quote, to find it again (CONTEXT in hooks/lib/comments.ts). */
  const CONTEXT = 40
  const KINDS = ['definition', 'theorem', 'lemma', 'proposition', 'corollary', 'proof', 'method', 'result', 'related-work', 'motivation', 'discussion', 'figure', 'table']
  const HEAD_RE = /^%\s*rft-snippet\s+(S\d+)\s*·\s*([\w-]+)\s*·\s*(.*?)\s*$/
  const BASIS_RE = /^%\s*basis:\s*(.*?)\s*$/
  const BEGIN_RE = /^%\s*rft-begin\s+(S\d+)\s+([0-9a-f]{8})\s*$/
  const END_RE = /^%\s*rft-end\s+(S\d+)\s*$/
  const HEADING_RE = /^\s*\\(part|chapter|section|subsection|subsubsection)\*?\{(.*)\}\s*$/

  /** The quote of a selection and the text around it, as a thread is anchored. */
  function anchorOf(text, start, end) {
    return { quote: text.slice(start, end), prefix: text.slice(Math.max(0, start - CONTEXT), start), suffix: text.slice(end, end + CONTEXT) }
  }

  /** What a snippet gives a document: its text below its two header lines, blank lines at either end left out (contentOf in hooks/lib/snippets.ts). */
  function contentOf(snippetText) {
    const lines = snippetText.replace(/\r\n/g, '\n').split('\n')
    const skip = HEAD_RE.test(lines[0] || '') ? (BASIS_RE.test(lines[1] || '') ? 2 : 1) : 0
    return lines.slice(skip).join('\n').replace(/^(\s*\n)+/, '').replace(/\s+$/, '')
  }

  /** The library by kind, in the order of KINDS (a kind none of them names last). */
  function byKind(snippets) {
    const groups = new Map()
    for (const s of snippets || []) {
      const k = KINDS.includes(s.kind) ? s.kind : 'other'
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(s)
    }
    return [...KINDS, 'other'].filter(k => groups.has(k)).map(k => ({ kind: k, snippets: groups.get(k) }))
  }

  /** A snippet's state in a word, and why: review (a basis note changed), stub (nothing written yet), written. */
  function stateOf(s) {
    if (s.review && s.review.length) return { word: 'review', why: s.review.join(', ') }
    return { word: s.stub ? 'stub' : 'written', why: '' }
  }

  /** Where a snippet is used, in words: `paper, thesis (adapted)`. */
  function usedWords(s) {
    const u = (s && s.usedIn) || []
    return u.length ? u.map(x => `${x.doc}${x.state === 'sync' ? '' : x.state === 'review' ? ' (to review)' : ` (${x.state})`}`).join(', ') : ''
  }

  /**
   * A document's outline from its text: its headings and its copies (each with the state the
   * server gave it), in order, with their lines (0-based).
   */
  function outlineOf(text, copies) {
    const states = new Map((copies || []).map(c => [c.id, c]))
    const lines = (text || '').replace(/\r\n/g, '\n').split('\n')
    const out = []
    for (let i = 0; i < lines.length; i++) {
      const b = BEGIN_RE.exec(lines[i])
      if (b) {
        const end = lines.findIndex((l, j) => j > i && (END_RE.exec(l) || [])[1] === b[1])
        if (end < 0) continue
        const c = states.get(b[1]) || {}
        out.push({ type: 'copy', id: b[1], line: i, end, state: c.state || 'sync', snippetReview: !!c.snippetReview })
        i = end
        continue
      }
      const h = HEADING_RE.exec(lines[i])
      if (h) out.push({ type: 'heading', level: h[1], title: h[2], line: i })
    }
    return out
  }

  /** The snippets resting on a note. */
  function writtenIn(ms, id) {
    return ms && ms.snippets ? ms.snippets.filter(s => (s.basis || []).includes(id)).map(s => s.id) : []
  }

  /** A document's name made from its title: lowercase letters, digits and dashes, accents dropped, at most 40 characters. */
  function slugOf(title) {
    return String(title || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  }

  /** Why a name will not do for a new document (taken: the names there are), or '' when it will. */
  function docNameProblem(name, taken) {
    if (!name) return 'Give it a name: it is its folder, documents/<name>/'
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return 'Lowercase letters, digits and dashes only, starting with a letter or digit'
    if ((taken || []).includes(name)) return `There is already a document ${name}`
    return ''
  }

  /** An error of the compile in a line: where (a snippet's id or the file) and what. */
  function errorText(e) {
    return `${e.snippet || e.file}${e.line ? `:${e.line}` : ''}: ${e.message}${e.context ? ` (${e.context})` : ''}`
  }

  function mount({ key, store, open, nodes, notify, visible, changed = () => {}, every = 4000 }) {
    const $ = id => document.getElementById(id)
    const section = $('manuscript')
    if (!section) return null
    const listEl = $('ms-list'), headEl = $('ms-head'), threadsEl = $('ms-threads'), emptyEl = $('ms-empty'), body = $('ms-body')
    const pdfFrame = $('ms-pdf-frame'), pdfNote = $('ms-pdf-note'), errorsEl = $('ms-errors'), statusEl = $('ms-status')
    const docSel = $('ms-doc'), lockBtn = $('ms-lock'), compileBtn = $('ms-compile')
    let ms = null // api/manuscript
    let level = store.get('msLevel', 'snippets') === 'documents' ? 'documents' : 'snippets'
    let doc = store.get('msDoc', '')
    let sid = store.get('msSnippet', '') // the snippet open in the Snippets view
    let file = null // { path, version, text (as read), taken (a document's: each copy's snippet text when taken) }
    let note = null // the open snippet or document as api/note gives it: its threads
    let dirty = false
    let loading = false
    let pdfUrl = null
    let compiling = false
    let composing = null // { kind, anchor }
    let marks = []
    let copyLines = [] // the editor's line classes on the copies
    let focusCopy = null // the copy shown in the document's head
    const canWrite = () => !!key()

    const cm = root.CodeMirror ? root.CodeMirror($('ms-cm'), {
      mode: 'stex', lineNumbers: true, lineWrapping: true, styleActiveLine: true, matchBrackets: true, tabSize: 2, indentUnit: 2,
      extraKeys: { 'Ctrl-S': () => save(true), 'Cmd-S': () => save(true) },
    }) : null
    if (cm) {
      cm.on('change', () => { if (!loading) { dirty = true; renderStatus() } })
      cm.on('cursorActivity', () => {
        renderSelectionButtons()
        if (level === 'documents' && !dirty) {
          const line = cm.getCursor().line
          const c = outline().find(o => o.type === 'copy' && line >= o.line && line <= o.end)
          if ((c && c.id) !== (focusCopy && focusCopy.id)) { focusCopy = c || null; renderList(); renderHead() }
        }
      })
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
    const theDoc = () => (ms && ms.documents.find(d => d.name === doc)) || null
    const theSnippet = id => (ms && ms.snippets.find(s => s.id === (id || sid))) || null
    const subject = () => (level === 'snippets' ? (file && sid) : doc) || null
    const pathOf = () => (level === 'snippets' ? (sid ? `snippets/${sid}.tex` : '') : doc ? `documents/${doc}/main.tex` : '')
    const outline = () => (level === 'documents' && file ? outlineOf(cm ? cm.getValue() : file.text, (theDoc() || {}).copies) : [])

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
          else await loadThreads()
        } catch { /* the next tick */ }
      }
    }

    function render() {
      const exists = ms && ms.exists
      emptyEl.hidden = !!exists
      body.hidden = !exists
      for (const b of section.querySelectorAll('.ms-needs')) b.hidden = !exists
      for (const b of section.querySelectorAll('[data-ms-level]')) b.setAttribute('aria-pressed', String(b.dataset.msLevel === level))
      for (const b of section.querySelectorAll('.ms-docs-only')) b.hidden = !exists || level !== 'documents'
      for (const b of section.querySelectorAll('.ms-snippets-only')) b.hidden = !exists || level !== 'snippets'
      if (!exists) return
      const names = ms.documents.map(d => d.name)
      if (!names.includes(doc)) doc = names[0] || ''
      docSel.replaceChildren(...names.map(n => el('option', { value: n, text: n, selected: n === doc })))
      const locked = level === 'snippets' ? ms.locked : ms.docsLocked
      lockBtn.setAttribute('aria-pressed', String(locked))
      lockBtn.querySelector('.lock-open').classList.toggle('on', !locked)
      lockBtn.querySelector('.lock-closed').classList.toggle('on', locked)
      lockBtn.title = level === 'snippets'
        ? (locked ? 'Snippets locked: you write them; Claude proposes stubs, comments and suggests (click: let Claude write them too)' : 'Snippets unlocked: Claude may write their text too (click: lock them)')
        : (locked ? 'Documents locked: their text is yours; Claude places copies you agree to, comments and suggests (click: let Claude edit their text too)' : 'Documents unlocked: Claude may edit their text too (click: lock them)')
      compileBtn.disabled = !ms.latexmk || (level === 'snippets' ? !sid : !doc)
      compileBtn.textContent = level === 'snippets' ? 'Compile snippet' : 'Compile'
      compileBtn.title = !ms.latexmk ? 'latexmk is not on PATH: install a TeX distribution (TeX Live) to compile'
        : level === 'snippets' ? 'Compile this snippet alone, in a minimal article (Ctrl/Cmd+S saves and compiles)' : `Compile ${doc} with latexmk (Ctrl/Cmd+S saves and compiles)`
      renderList()
      renderHead()
    }

    function stateBadge(s) {
      const st = stateOf(s)
      return el('span', { class: `ms-state ms-${st.word}`, text: st.word, title: st.why || (st.word === 'stub' ? 'Nothing written yet: its outline says what to write' : 'Written') })
    }

    function copyBadge(c) {
      const word = c.state === 'sync' ? 'as snippet' : c.state === 'review' ? 'review' : c.state
      const title = c.state === 'review' ? 'Its snippet changed since this copy was taken: take the new text, or keep yours'
        : c.state === 'adapted' ? 'Adapted to this document: it differs from its snippet, which has not changed since'
          : c.state === 'gone' ? 'No such snippet any more' : 'As its snippet'
      return el('span', { class: `ms-state ms-copy-${c.state}`, text: word, title })
    }

    function renderList() {
      if (level === 'snippets') {
        const item = s => el('li', {
          class: `ms-item${s.id === sid && file ? ' open' : ''}`, title: `${s.id} ${s.kind}: ${s.title}${s.usedIn.length ? `\nUsed in ${usedWords(s)}` : '\nIn no document'}`,
          onclick: () => openSnippet(s.id),
        }, el('span', { class: 'ms-id', text: s.id }), el('span', { class: 'ms-title', text: s.title || '(no header)' }),
        stateBadge(s), s.unverified && s.unverified.length ? el('span', { class: 'ms-flag', text: '!', title: `Rests on notes not verified: ${s.unverified.join(', ')}` }) : null,
        s.usedIn.length ? el('span', { class: 'ms-used', text: `×${s.usedIn.length}`, title: `Used in ${usedWords(s)}` }) : null,
        s.threads ? el('span', { class: 'ms-threads-n', text: String(s.threads), title: `${s.threads} open thread(s)` }) : null)
        const groups = byKind(ms.snippets)
        listEl.replaceChildren(...(groups.length ? groups.flatMap(g => [el('div', { class: 'ms-sub muted', text: g.kind }), el('ul', {}, g.snippets.map(item))])
          : [el('p', { class: 'muted ms-pad', text: 'No snippets yet: + Snippet, or ask Claude with /rft-manuscript.' })]))
        return
      }
      const d = theDoc()
      if (!d) { listEl.replaceChildren(el('p', { class: 'muted ms-pad', text: 'No document yet: + Document.' })); return }
      const items = outline()
      const go = line => () => { if (cm) { cm.setCursor({ line, ch: 0 }); cm.scrollIntoView({ line, ch: 0 }, 80); cm.focus() } }
      listEl.replaceChildren(el('ul', {},
        el('li', { class: 'ms-item ms-doc-item', title: 'The document: its preamble, its text, its copies', onclick: go(0) },
          el('span', { class: 'ms-id', text: 'main.tex' }), el('span', { class: 'ms-title', text: d.name }),
          d.threads ? el('span', { class: 'ms-threads-n', text: String(d.threads), title: `${d.threads} open thread(s)` }) : null),
        items.map(o => o.type === 'heading'
          ? el('li', { class: `ms-item ms-heading ms-h-${o.level}`, onclick: go(o.line) }, el('span', { class: 'ms-title', text: `§ ${o.title}` }))
          : el('li', { class: `ms-item ms-copy${focusCopy && focusCopy.id === o.id ? ' open' : ''}`, title: `A copy of ${o.id}`, onclick: () => { focusCopy = o; go(o.line + 1)(); renderList(); renderHead() } },
            el('span', { class: 'ms-id', text: o.id }), el('span', { class: 'ms-title', text: (theSnippet(o.id) || {}).title || '' }), copyBadge(o),
            o.snippetReview ? el('span', { class: 'ms-flag', text: '!', title: 'Its snippet is in review: its notes changed' }) : null))))
      if (d.refsMissing && d.refsMissing.length) listEl.append(el('p', { class: 'ms-flag-text ms-pad', text: `Refers to ${d.refsMissing.join(', ')}, which it holds no copy of.` }))
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
        headEl.append(el('span', { class: 'muted', text: level === 'snippets' ? 'Open a snippet on the left.' : 'No document open.' }))
        return
      }
      const saveBtn = el('button', { type: 'button', class: 'primary', text: 'Save', title: 'Save (Ctrl/Cmd+S also compiles)', onclick: () => save(false) })
      if (level === 'snippets') {
        const s = theSnippet()
        if (!s) { headEl.append(el('strong', { text: file.path }), el('span', { class: 'ms-spacer' }), saveBtn); return }
        const st = stateOf(s)
        headEl.append(
          el('div', { class: 'ms-head-row' },
            el('strong', { text: `${s.id} · ${s.kind} · ${s.title}` }), stateBadge(s),
            st.word === 'review' ? el('span', { class: 'muted', text: st.why }) : null,
            st.word === 'review' ? el('button', { type: 'button', text: 'Reviewed', title: 'Its text still holds against its notes as they are now: take its stamp anew', onclick: () => ask({ action: 'reviewed', id: s.id }, 'mark it reviewed') }) : null,
            ms.locked ? el('button', {
              type: 'button', class: `icon-btn ms-lock-one${s.locked ? '' : ' open'}`, text: s.locked ? '🔒' : '🔓',
              title: s.locked ? 'Yours to write: Claude only suggests (click: let Claude write this snippet)' : 'Claude may write this snippet (click: yours again)',
              onclick: () => setLock('snippets', !s.locked, s.id),
            }) : null,
            el('span', { class: 'ms-spacer' }), selButton('comment'), selButton('suggestion'), saveBtn),
          el('div', { class: 'ms-head-row ms-basis' },
            el('span', { class: 'muted', text: 'Rests on' }),
            s.basis.length ? s.basis.map(chip) : el('span', { class: 'muted', text: 'no note: give it a % basis: line' }),
            s.unverified.length ? el('span', { class: 'ms-flag-text', text: `not verified: ${s.unverified.join(', ')}` }) : null,
            s.missing.length ? el('span', { class: 'ms-flag-text', text: `no such note: ${s.missing.join(', ')}` }) : null),
          el('div', { class: 'ms-head-row' },
            el('span', { class: 'muted', text: 'Used in' }),
            s.usedIn.length ? s.usedIn.map(u => el('button', {
              type: 'button', class: `ms-chip ms-copy-${u.state}`, text: `${u.doc}${u.state === 'sync' ? '' : u.state === 'review' ? ' (to review)' : ` (${u.state})`}`,
              title: `Go to its copy in ${u.doc}`, onclick: () => showCopy(u.doc, s.id),
            })) : el('span', { class: 'muted', text: 'no document yet' }),
            ms.documents.length ? placeForm(s.id) : null),
        )
      } else {
        const d = theDoc()
        headEl.append(el('div', { class: 'ms-head-row' },
          el('strong', { text: `${doc}` }), el('span', { class: 'muted', text: `${d ? d.copies.length : 0} cop${d && d.copies.length === 1 ? 'y' : 'ies'} of snippets` }),
          d ? el('button', {
            type: 'button', class: `icon-btn ms-lock-one${d.locked ? '' : ' open'}`, text: d.locked ? '🔒' : '🔓',
            title: d.locked ? 'Its text is yours: Claude places copies you agree to and suggests (click: let Claude edit it)' : 'Claude may edit its text (click: yours again)',
            onclick: () => setLock('documents', !d.locked, d.name),
          }) : null,
          el('span', { class: 'ms-spacer' }), selButton('comment'), selButton('suggestion'), saveBtn))
        const extra = focusCopy ? copyPanel(focusCopy) : placeRow()
        if (extra) headEl.append(extra)
      }
      renderSelectionButtons()
    }

    /** Place this snippet in a document: the document, Place (before its bibliography; move it after). */
    function placeForm(id) {
      const docs = ms.documents.filter(d => !d.copies.some(c => c.id === id))
      if (!docs.length) return null
      const sel = el('select', { 'aria-label': 'Document' }, docs.map(d => el('option', { value: d.name, text: d.name, selected: d.name === doc })))
      return el('span', { class: 'ms-place' }, el('span', { class: 'muted', text: '· Place in' }), sel,
        el('button', { type: 'button', text: 'Place', title: 'Copy it into that document, before its bibliography (move it there afterwards)', onclick: () => place(sel.value, id) }))
    }

    /** A document's row for placing a snippet from the library: which, after what. */
    function placeRow() {
      const d = theDoc()
      if (!d) return null
      const free = ms.snippets.filter(s => !d.copies.some(c => c.id === s.id))
      if (!free.length) return el('div', { class: 'ms-head-row muted', text: 'Every snippet has a copy here.' })
      const which = el('select', { 'aria-label': 'Snippet' }, free.map(s => el('option', { value: s.id, text: `${s.id} ${s.title}` })))
      const after = afterSelect()
      return el('div', { class: 'ms-head-row' }, el('span', { class: 'muted', text: 'Place' }), which, el('span', { class: 'muted', text: 'after' }), after,
        el('button', { type: 'button', text: 'Place', title: 'Copy the snippet\'s text here, referenced to it', onclick: () => place(doc, which.value, after.value) }))
    }

    /** Where in the document: the end, after a heading, or after a copy. */
    function afterSelect(skip) {
      return el('select', { 'aria-label': 'Where' }, el('option', { value: '', text: 'the end' }),
        outline().filter(o => !(o.type === 'copy' && o.id === skip)).map(o => el('option', { value: o.type === 'copy' ? o.id : o.title, text: o.type === 'copy' ? o.id : `§ ${o.title}` })))
    }

    /** The copy the cursor is in: its state, its snippet then and now when in review, take or keep, move, remove. */
    function copyPanel(c) {
      const s = theSnippet(c.id)
      const after = afterSelect(c.id)
      const box = el('div', { class: `ms-copy-panel ms-copy-${c.state}` },
        el('div', { class: 'ms-head-row' },
          el('strong', { text: `Copy of ${c.id}` }), s ? el('span', { class: 'muted', text: s.title }) : null, copyBadge(c),
          c.snippetReview ? el('span', { class: 'ms-flag-text', text: 'its snippet is in review: its notes changed' }) : null,
          s ? el('button', { type: 'button', text: 'Open the snippet', onclick: () => openSnippet(c.id) }) : null,
          el('span', { class: 'ms-spacer' }),
          el('span', { class: 'muted', text: 'Move after' }), after,
          el('button', { type: 'button', text: 'Move', onclick: () => ask({ action: 'move', name: doc, id: c.id, ...(after.value ? { after: after.value } : {}) }, 'move the copy') }),
          el('button', { type: 'button', text: 'Remove', title: 'Take the copy out of this document (the snippet stays)', onclick: () => { if (confirm(`Take the copy of ${c.id} out of ${doc}? The snippet stays.`)) void ask({ action: 'remove', name: doc, id: c.id }, 'remove the copy') } }),
          el('button', { type: 'button', class: 'icon-btn', text: '✕', title: 'Close', onclick: () => { focusCopy = null; renderList(); renderHead() } })))
      if (c.state === 'review' && s) {
        const then = (file.taken || {})[c.id]
        const now = el('pre', { class: 'ms-diff-text', text: '…' })
        api(`api/manuscript/file?path=${encodeURIComponent(`snippets/${c.id}.tex`)}`).then(r => { now.textContent = r.ok ? contentOf(r.data.text) : '(not read)' }).catch(() => {})
        box.append(
          el('div', { class: 'ms-diff' },
            el('div', {}, el('div', { class: 'muted', text: 'The snippet when taken' }), el('pre', { class: 'ms-diff-text', text: then != null ? then : '(not recorded)' })),
            el('div', {}, el('div', { class: 'muted', text: 'The snippet now' }), now)),
          el('div', { class: 'ms-head-row' },
            el('button', { type: 'button', class: 'primary', text: 'Take the new text', title: 'Replace this copy with the snippet\'s text now (what you adapted here is lost)', onclick: () => { if (confirm(`Replace the copy of ${c.id} in ${doc} with the snippet's text now? What you adapted here is lost.`)) void ask({ action: 'take', name: doc, id: c.id }, 'take the new text') } }),
            el('button', { type: 'button', text: 'Keep mine', title: 'Keep this copy as it is: it answers to the snippet as it is now', onclick: () => ask({ action: 'keep', name: doc, id: c.id }, 'keep the copy') })))
      }
      return box
    }

    /** The Comment or Suggest button: on the text selected in the editor. */
    function selButton(kind) {
      return el('button', {
        type: 'button', class: 'ms-sel-btn', 'data-kind': kind, text: kind === 'comment' ? 'Comment' : 'Suggest',
        title: kind === 'comment' ? 'A question or remark on the selected text' : 'New text for the selected text, or what should change in words',
        onclick: () => compose(kind),
      })
    }

    function renderSelectionButtons() {
      const on = !!(cm && file && cm.somethingSelected() && !dirty)
      for (const b of headEl.querySelectorAll('.ms-sel-btn')) {
        b.disabled = !on
        if (dirty) b.title = 'Save first: a thread is anchored on the text as saved'
      }
    }

    function renderStatus(text) {
      statusEl.textContent = text != null ? text : dirty ? 'Unsaved changes' : ''
    }

    function markCopies() {
      if (!cm) return
      for (const [h, cls] of copyLines) cm.removeLineClass(h, 'background', cls)
      copyLines = []
      if (level !== 'documents') return
      for (const o of outline()) {
        if (o.type !== 'copy') continue
        for (let i = o.line; i <= o.end; i++) {
          const cls = `ms-copy-line ms-copy-line-${o.state}${i === o.line ? ' ms-copy-first' : ''}${i === o.end ? ' ms-copy-last' : ''}`
          copyLines.push([cm.addLineClass(i, 'background', cls), cls])
        }
      }
    }

    async function openFile(path, keepPlace = false) {
      if (!cm || !path) return false
      if (dirty && !keepPlace && !confirm('Leave the unsaved changes?')) return false
      let r
      try { r = await api(`api/manuscript/file?path=${encodeURIComponent(path)}`) } catch { notify('The server is not answering.'); return false }
      if (!r.ok) { notify(r.data.error || `Not opened (${r.status})`); return false }
      const cursor = keepPlace ? cm.getCursor() : null
      const scroll = keepPlace ? cm.getScrollInfo() : null
      loading = true
      cm.setValue(r.data.text)
      cm.clearHistory()
      loading = false
      if (cursor) { cm.setCursor(cursor); cm.scrollTo(scroll.left, scroll.top) }
      file = { path, version: r.data.version, text: r.data.text, taken: r.data.taken || {} }
      dirty = false
      composing = null
      renderStatus()
      markCopies()
      if (ms) { renderList(); renderHead() }
      await loadThreads()
      setTimeout(() => cm.refresh(), 0)
      return true
    }

    async function openSnippet(id) {
      if (level !== 'snippets' && !(await setLevel('snippets'))) return
      if (dirty && !confirm('Leave the unsaved changes?')) return
      dirty = false
      sid = id
      store.set('msSnippet', sid)
      focusCopy = null
      await openFile(`snippets/${id}.tex`)
      await loadPdf()
    }

    async function showCopy(name, id) {
      if (dirty && !confirm('Leave the unsaved changes?')) return
      dirty = false
      doc = name
      store.set('msDoc', doc)
      await setLevel('documents', true)
      const c = outline().find(o => o.type === 'copy' && o.id === id)
      if (c && cm) { focusCopy = c; cm.setCursor({ line: c.line + 1, ch: 0 }); cm.scrollIntoView({ line: c.line, ch: 0 }, 80); renderList(); renderHead() }
    }

    /** Switches the view; false when the user keeps unsaved changes. */
    async function setLevel(next, force = false) {
      if (next === level && !force && file) return true
      if (dirty && !confirm('Leave the unsaved changes?')) return false
      dirty = false
      level = next
      store.set('msLevel', level)
      file = null
      focusCopy = null
      render()
      renderErrors({})
      const path = pathOf()
      if (path) await openFile(path)
      else if (cm) { loading = true; cm.setValue(''); loading = false; markCopies(); threadsEl.hidden = true }
      await loadPdf()
      return true
    }

    async function save(andCompile) {
      if (!file || !cm) return
      if (!canWrite()) { needKey('save'); return }
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
        markCopies()
        await refresh()
      }
      if (andCompile) await compile()
    }

    // ---------------------------------------------------------------- the PDF

    const what = () => (level === 'snippets' ? (sid ? { snippet: sid } : null) : doc ? { doc } : null)

    async function compile() {
      const w = what()
      if (!w || compiling) return
      if (!canWrite()) { needKey('compile'); return }
      compiling = true
      compileBtn.disabled = true
      renderStatus(`Compiling ${w.snippet || w.doc}…`)
      try {
        const r = await api('api/manuscript/compile', { method: 'POST', body: w })
        const c = r.data || {}
        renderErrors(c)
        renderStatus(c.ok ? `Compiled in ${c.seconds} s` : c.error ? 'Not compiled' : `Errors (${(c.errors || []).length}): the last good PDF stays`)
        // a failed compile leaves the last good PDF on screen
        if (c.ok || pdfFrame.hidden) await loadPdf()
      } catch {
        renderStatus('The server is not answering.')
      } finally {
        compiling = false
        compileBtn.disabled = !what() || !(ms && ms.latexmk)
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
            if (e.snippet && level === 'snippets' && e.snippet !== sid) await openSnippet(e.snippet)
            if (e.line && cm) { cm.setCursor({ line: e.line - 1, ch: 0 }); cm.focus() }
          },
        }))
      }
      for (const w of warns) errorsEl.append(el('div', { class: 'ms-warn', text: w }))
      errorsEl.hidden = !errs.length && !warns.length && !c.error
    }

    async function loadPdf() {
      const w = what()
      if (!w) { pdfFrame.hidden = true; pdfNote.hidden = false; pdfNote.textContent = level === 'snippets' ? 'Open a snippet: Compile snippet shows it alone.' : 'No document yet.'; return }
      if (!canWrite()) { pdfNote.textContent = 'The PDF is shown to the page carrying the key: open the address /rft printed once.'; pdfNote.hidden = false; return }
      try {
        const q = w.snippet ? `snippet=${encodeURIComponent(w.snippet)}` : `doc=${encodeURIComponent(w.doc)}`
        const res = await fetch(`api/manuscript/pdf?${q}`, { cache: 'no-store', headers: { 'X-RFT-Token': key() } })
        if (!res.ok) {
          pdfFrame.hidden = true
          pdfNote.textContent = `${w.snippet || w.doc} has not been compiled yet: ${w.snippet ? 'Compile snippet' : 'Compile'}.`
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
      const id = subject()
      if (!file || !id) { note = null; threadsEl.replaceChildren(); threadsEl.hidden = true; return }
      try {
        const r = await api(`api/note?id=${encodeURIComponent(id)}`)
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
      if (closed.length) threadsEl.append(el('details', { class: 'ms-history' }, el('summary', { text: `History (${closed.length})` }), closed.map(t => threadEl(t))))
      threadsEl.hidden = !threadsEl.childNodes.length
    }

    function threadEl(t) {
      const isOpen = t.state === 'open'
      const id = subject()
      const reply = el('textarea', { rows: 1, placeholder: 'Reply…', 'aria-label': 'Reply' })
      const act = (action, extra = {}) => async () => {
        if (!canWrite()) { needKey('discuss it'); return }
        const text = reply.value.trim()
        if (text && action !== 'reply') {
          const r = await api('api/comment', { method: 'POST', body: { id, action: 'reply', thread: t.id, text } })
          if (!r.ok) { notify(r.data.error || 'Not sent'); return }
        }
        if (action !== 'reply' || text) {
          const r = await api('api/comment', { method: 'POST', body: { id, action, thread: t.id, ...(action === 'reply' ? { text } : {}), ...extra } })
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
          t.kind === 'suggestion' ? el('button', { type: 'button', text: 'Accept', disabled: t.replacement == null || !t.exact, title: 'Write its replacement into the text', onclick: act('accept') }) : null,
          t.kind === 'suggestion' ? el('button', { type: 'button', text: 'Reject', onclick: act('reject') }) : null)
          : el('div', { class: 'ms-thread-act' }, el('button', { type: 'button', text: 'Reopen', onclick: act('reopen') })))
    }

    function compose(kind) {
      if (!cm || !file || !subject() || !cm.somethingSelected()) return
      const text = cm.getValue()
      const start = cm.indexFromPos(cm.getCursor('from')), end = cm.indexFromPos(cm.getCursor('to'))
      composing = { kind, anchor: anchorOf(text, start, end) }
      renderThreads()
      const box = threadsEl.querySelector('.ms-composer textarea')
      if (box) box.focus()
    }

    function composer() {
      const c = composing
      const id = subject()
      const msg = el('textarea', { rows: 2, placeholder: c.kind === 'comment' ? 'Your comment' : 'Why, or what should change (optional when you write the new text)' })
      const repl = c.kind === 'suggestion' ? el('textarea', { rows: 3, class: 'ms-repl-box', 'aria-label': 'New text' }) : null
      if (repl) repl.value = c.anchor.quote
      const post = askClaude => async () => {
        if (!canWrite()) { needKey('discuss it'); return }
        const r = await api('api/comment', { method: 'POST', body: { id, action: 'new', kind: c.kind, ...c.anchor, text: msg.value.trim(), ...(repl ? { replacement: repl.value } : {}) } })
        if (!r.ok) { notify(r.data.error || `Not posted (${r.status})`); return }
        composing = null
        note = r.data
        if (askClaude) {
          const t = note.threads[note.threads.length - 1]
          const a = await api('api/comment', { method: 'POST', body: { id, action: 'ask', thread: t.id } })
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

    async function ask(body, whatFor) {
      if (!canWrite()) { needKey(whatFor); return null }
      if (dirty && level === 'documents' && ['take', 'keep', 'place', 'move', 'remove'].includes(body.action)) {
        if (confirm('The document has unsaved changes: save them first? (Cancel: drop them)')) await save(false)
        else dirty = false
      }
      renderStatus(`${whatFor[0].toUpperCase()}${whatFor.slice(1)}…`)
      const r = await api('api/manuscript/ask', { method: 'POST', body })
      renderStatus('')
      if (!r.ok) { notify(r.data.error || `Could not ${whatFor} (${r.status})`); return null }
      ms = r.data
      if (level === 'documents' && file) await openFile(file.path, true)
      render()
      return r.data
    }

    async function place(name, id, after) {
      const got = await ask({ action: 'place', name, id, ...(after ? { after } : {}) }, 'place the copy')
      if (got) await showCopy(name, id)
    }

    async function setLock(which, locked, one) {
      if (!canWrite()) { needKey('change the lock'); return }
      const r = await api('api/manuscript/lock', { method: 'POST', body: { level: which, locked, ...(one ? { id: one } : {}) } })
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

    for (const b of section.querySelectorAll('[data-ms-level]')) b.addEventListener('click', () => void setLevel(b.dataset.msLevel))
    $('ms-new').addEventListener('click', newSnippetForm)
    $('ms-new-cancel').addEventListener('click', () => { $('ms-new-form').hidden = true })
    $('ms-new-form').addEventListener('submit', async ev => {
      ev.preventDefault()
      const basis = $('ms-new-basis').value.split(/[,\s]+/).map(x => x.trim().toUpperCase()).filter(Boolean)
      const got = await ask({ action: 'new', kind: $('ms-new-kind').value, title: $('ms-new-title').value.trim(), basis }, 'add the snippet')
      if (!got) return
      $('ms-new-form').hidden = true
      $('ms-new-title').value = ''
      $('ms-new-basis').value = ''
      await openSnippet(got.id)
    })
    // ---------------------------------------------------------------- a new document

    const docForm = $('ms-doc-form'), docTitle = $('ms-doc-title'), docName = $('ms-doc-name'), docHint = $('ms-doc-hint'), docOk = $('ms-doc-ok')
    let docKind = 'article'
    let nameTouched = false // once the user types a name, the title no longer makes it

    function renderDocForm() {
      for (const b of docForm.querySelectorAll('[data-doc-kind]')) b.setAttribute('aria-checked', String(b.dataset.docKind === docKind))
      const name = docName.value.trim()
      const problem = docNameProblem(name, ms && ms.exists ? ms.documents.map(d => d.name) : [])
      docName.setAttribute('aria-invalid', String(!!problem && (nameTouched || !!name)))
      docHint.textContent = problem && (nameTouched || name) ? problem
        : `documents/${name || '<name>'}/main.tex · ${docKind === 'report' ? 'a \\chapter' : '\\section headings'}, the project's template`
      docHint.classList.toggle('ms-flag-text', !!problem && (nameTouched || !!name))
      docOk.disabled = !!problem
    }

    function openDocForm(prefill) {
      docForm.hidden = false
      $('ms-new-form').hidden = true
      docKind = 'article'
      docTitle.value = ''
      docName.value = prefill || ''
      nameTouched = !!prefill
      renderDocForm()
      docTitle.focus()
    }

    const closeDocForm = () => { docForm.hidden = true }

    for (const b of docForm.querySelectorAll('[data-doc-kind]')) {
      b.addEventListener('click', () => {
        docKind = b.dataset.docKind
        // a thesis chapter's default name follows its kind, until the user names it
        if (!nameTouched && !docTitle.value.trim()) docName.value = docKind === 'report' ? 'thesis-ch1' : ''
        renderDocForm()
      })
    }
    docTitle.addEventListener('input', () => { if (!nameTouched) docName.value = slugOf(docTitle.value); renderDocForm() })
    docName.addEventListener('input', () => {
      nameTouched = docName.value.trim() !== ''
      // typed as it goes: lowercase, spaces as dashes
      const at = docName.selectionStart
      docName.value = docName.value.toLowerCase().replace(/[\s_]+/g, '-')
      docName.setSelectionRange(at, at)
      renderDocForm()
    })
    docForm.addEventListener('keydown', ev => { if (ev.key === 'Escape') { ev.preventDefault(); closeDocForm() } })
    $('ms-doc-cancel').addEventListener('click', closeDocForm)
    docForm.addEventListener('submit', async ev => {
      ev.preventDefault()
      const name = docName.value.trim()
      if (docNameProblem(name, ms && ms.exists ? ms.documents.map(d => d.name) : [])) { nameTouched = true; renderDocForm(); docName.focus(); return }
      docOk.disabled = true
      const title = docTitle.value.trim()
      const got = await ask({ action: 'document', name, kind: docKind, ...(title ? { title } : {}) }, ms && ms.exists ? 'create the document' : 'start')
      docOk.disabled = false
      if (!got) return
      closeDocForm()
      doc = name
      store.set('msDoc', doc)
      await setLevel('documents', true)
    })
    $('ms-new-doc').addEventListener('click', () => (docForm.hidden ? openDocForm() : closeDocForm()))
    $('ms-start').addEventListener('click', () => openDocForm('paper'))
    docSel.addEventListener('change', async () => {
      if (dirty && !confirm('Leave the unsaved changes?')) { docSel.value = doc; return }
      dirty = false
      doc = docSel.value
      store.set('msDoc', doc)
      await setLevel('documents', true)
    })
    lockBtn.addEventListener('click', () => ms && setLock(level, !(level === 'snippets' ? ms.locked : ms.docsLocked)))
    compileBtn.addEventListener('click', () => save(true))

    let timer = 0
    let shown = false
    async function show() {
      await refresh()
      if (!shown && ms && ms.exists) {
        shown = true
        // ?snippet=S04 or ?doc=paper in the address opens it; else what was open last
        const q = new URLSearchParams(location.search)
        const asked = (q.get('snippet') || '').toUpperCase()
        if (/^S\d+$/.test(asked) && ms.snippets.some(s => s.id === asked)) { sid = asked; level = 'snippets' }
        else if (q.get('doc') && ms.documents.some(d => d.name === q.get('doc'))) { doc = q.get('doc'); level = 'documents' }
        if (level === 'snippets' && !ms.snippets.some(s => s.id === sid)) sid = (ms.snippets[0] || {}).id || ''
        await setLevel(level, true)
      }
      if (cm) setTimeout(() => cm.refresh(), 0)
    }
    // the summary follows the vault on every page (the drawer's Written in reads it); the tab redraws only when shown
    timer = setInterval(() => { void refresh() }, every)
    void refresh()
    return { show, writtenIn: id => writtenIn(ms, id), openSnippet: id => { void show().then(() => openSnippet(id)) }, get summary() { return ms }, stop: () => clearInterval(timer) }
  }

  root.RftManuscript = { CONTEXT, KINDS, anchorOf, contentOf, byKind, stateOf, usedWords, outlineOf, writtenIn, slugOf, docNameProblem, errorText, mount }
})(typeof window !== 'undefined' ? window : globalThis)
