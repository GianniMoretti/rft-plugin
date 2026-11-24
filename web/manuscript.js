// The tree view's Manuscript tab (docs/design/manuscript.md): two levels, two views.
// Snippets: the building blocks, each resting on notes of the tree, written once and reused; the
// library by kind, one open in an editor (CodeMirror 5, vendored) with its notes and the documents
// using it, compiled alone beside it. Documents: what is built with them, each a folder of plain
// LaTeX that names nothing of the tree (docs/adr/0003-a-document-holds-no-trace.md); a document's
// files and outline (its headings and its copies of snippets, each between two marker lines and
// with its state), copies placed from the library in any of its files, moved or removed, a copy
// whose snippet changed shown then and now (take the new text, or keep yours), a copy the plugin
// lost pointed to again, the tree's numbers and figures that changed since they were written, the
// traces of the tree in its files, the editor on a file and the PDF beside it. Both are discussed as a note is (comments and
// suggestions on a selection, Ask Claude). The locks are Claude's: the user writes whatever they
// say. Loaded by the page before app.js, which mounts it (the standalone page leaves it out); its
// pure parts are tested from tests/manuscript-view.test.ts.
(function (root) {
  'use strict'

  // the head's buttons' symbols (24 px boxes, stroked as .ico draws them); the toolbar's are in index.html
  const ICONS = {
    comment: '<path d="M4 5h16v11H10l-6 4.5z"/>',
    suggestion: '<path d="M15 4.5l4.5 4.5L9 19.5H4.5V15z"/><path d="M12.5 7l4.5 4.5"/>',
    save: '<path d="M12 4v10"/><path d="M8 10l4 4 4-4"/><path d="M4.5 15v4.5h15V15"/>',
  }

  /** The characters kept on each side of a quote, to find it again (CONTEXT in hooks/lib/comments.ts). */
  const CONTEXT = 40
  const KINDS = ['definition', 'theorem', 'lemma', 'proposition', 'corollary', 'proof', 'method', 'result', 'related-work', 'motivation', 'discussion', 'figure', 'table']
  const HEAD_RE = /^%\s*rft-snippet\s+(S\d+)\s*·\s*([\w-]+)\s*·\s*(.*?)\s*$/
  const BASIS_RE = /^%\s*basis:\s*(.*?)\s*$/
  const MARK_END_RE = /^\s*%%%\s*end\s*%%%\s*$/i
  const MARK_RE = /^\s*%%%\s*(\S.*?)\s*%%%\s*$/
  const THEOREM_NAMES = { theorem: 'Theorem', lemma: 'Lemma', proposition: 'Proposition', corollary: 'Corollary', definition: 'Definition' }
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

  /** A copy's state in a word of its own: placed is said as nothing, review as what to do. */
  const stateNote = st => (st === 'placed' ? '' : st === 'review' ? 'to review' : st)

  /** One use of a snippet (a document's file, how many copies there, their states) in words: `main.tex ×2: adapted`. */
  function useWords(u) {
    const notes = [...new Set((u.states || []).map(stateNote).filter(Boolean))]
    return `${u.file}${u.count > 1 ? ` ×${u.count}` : ''}${notes.length ? `: ${notes.join(', ')}` : ''}`
  }

  /** Where a snippet is used, in words: `paper (main.tex, sections/method.tex: adapted); thesis (main.tex)`. */
  function usedWords(s) {
    const u = (s && s.usedIn) || []
    return [...new Set(u.map(x => x.doc))].map(doc => `${doc} (${u.filter(x => x.doc === doc).map(useWords).join(', ')})`).join('; ')
  }

  /** How many copies a snippet has, over every document. */
  const usedCount = s => ((s && s.usedIn) || []).reduce((n, u) => n + (u.count || 0), 0)

  /** The marker pairs of a text, in order (parseMarkers in hooks/lib/copies.ts): a marker with no `%%% end %%%` before the next one is a comment of the user's own. */
  function parseMarkers(text) {
    const lines = (text || '').replace(/\r\n/g, '\n').split('\n')
    const out = []
    let open = null
    lines.forEach((l, i) => {
      if (MARK_END_RE.test(l)) {
        if (open) out.push({ words: open.words, begin: open.begin, end: i })
        open = null
      } else {
        const m = MARK_RE.exec(l)
        if (m) open = { words: m[1], begin: i }
      }
    })
    return out
  }

  /**
   * A file's outline from its text: its headings and the document's copies that are in it (each
   * as the server gave it: its name, its state), in order, with their lines (0-based). A copy is
   * where its marker lines are in the text as it is now, so it follows what is typed; one whose
   * markers are gone is where the server found its text when the file was last read.
   */
  function outlineOf(text, copies, file) {
    const lines = (text || '').replace(/\r\n/g, '\n').split('\n')
    const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase()
    const markers = parseMarkers(text).map(m => ({ ...m, taken: false }))
    const out = []
    for (const c of copies || []) {
      if (c.state === 'lost' || (file != null && c.file !== file)) continue
      let line = null, end = null
      if (c.markers !== false) {
        const m = markers.find(x => !x.taken && norm(x.words) === norm(c.marker)) || markers.find(x => !x.taken && c.line != null && x.begin === c.line - 1)
        if (m) { m.taken = true; line = m.begin; end = m.end }
      } else if (c.line != null && c.end != null && c.end <= lines.length) { line = c.line - 1; end = c.end - 1 }
      if (line == null) continue
      out.push({ type: 'copy', id: c.id, name: c.name || c.id, marker: c.marker || '', line, end, state: c.state || 'placed', markers: c.markers !== false, snippetReview: !!c.snippetReview })
    }
    lines.forEach((l, i) => {
      const h = HEADING_RE.exec(l)
      if (h && !out.some(o => o.type === 'copy' && i >= o.line && i <= o.end)) out.push({ type: 'heading', level: h[1], title: h[2], line: i })
    })
    return out.sort((a, b) => a.line - b.line)
  }

  /** A tracked value the user is to look at, in a line: what stands in the document, and what the tree says now. */
  function valueWords(v) {
    const what = v.kind === 'number' ? v.written : `${v.kind} ${v.key}`
    const where = `${v.file}${v.line ? `:${v.line}` : ''}`
    if (v.state === 'review') return `${what} (${v.from} ${v.key}) · ${where} · ${v.now == null ? 'no longer saved' : v.kind === 'number' ? `the tree now says ${v.now}` : 'saved again'}`
    if (v.state === 'changed') return `${what} (${v.from} ${v.key}) · ${where} · now ${v.inDocument} here: no longer the tree's`
    return `${what} (${v.from} ${v.key}) · ${v.file} · not found any more`
  }

  /** A trace of the tree in a document's files, in a line. */
  function traceWords(t) {
    const what = t.kind === 'plugin' ? `the plugin's ${t.match}` : t.kind === 'marker' ? `a marker of the first design (${t.match})` : t.kind === 'id' ? `the id ${t.match}` : `the entry ${t.match}, not cited`
    return `${t.file}${t.line == null ? ' (its name)' : `:${t.line}`}: ${what}`
  }

  /** A document's files in the order its outline lists them: its main file, the files holding copies as the document is read, then the rest. */
  function fileOrder(d) {
    const out = [d.main]
    for (const c of d.copies || []) if (c.state !== 'lost' && !out.includes(c.file)) out.push(c.file)
    for (const f of d.files || []) if (!out.includes(f)) out.push(f)
    return out.filter(f => (d.files || [d.main]).includes(f))
  }

  /** The most a file of a document may weigh (MAX_UPLOAD in server/rft_documents.py). */
  const MAX_UPLOAD = 20000000
  const ENGINES = [['pdflatex', 'pdfLaTeX'], ['xelatex', 'XeLaTeX'], ['lualatex', 'LuaLaTeX']]
  const megabytes = n => `${(n / 1e6).toFixed(1)} MB`

  /** The rows of a document's file list: every file and folder of its tree, as the server lists them (a folder, then what it holds), each with its name, its depth and the folder it is in. */
  function treeRows(d) {
    const tree = (d && d.tree) || ((d && d.files) || []).map(f => ({ path: f, kind: 'file', edit: true, show: null }))
    return tree.map(e => {
      const parts = e.path.split('/')
      return { ...e, name: parts[parts.length - 1], depth: parts.length - 1, folder: parts.slice(0, -1).join('/') }
    })
  }

  /** The files of a document the editor opens, by their path inside it. */
  function editable(d) {
    return treeRows(d).filter(e => e.kind === 'file' && e.edit).map(e => e.path)
  }

  /** A path typed for a file or a folder of a document, tidied (spaces and slashes at its ends dropped, `folder` before a bare name); and why it will not do, or ''. */
  function typedPath(typed, folder) {
    const t = String(typed || '').trim().replace(/^\/+|\/+$/g, '')
    const path = t && folder && !t.includes('/') ? `${folder}/${t}` : t
    const parts = path.split('/')
    const problem = !path ? 'Give it a name'
      : /[\\<>:"|?*\u0000-\u001f]/.test(path) ? 'A name holds no \\ < > : " | ? *'
        : parts.some(x => !x || x === '.' || x === '..' || x.startsWith('.') || x !== x.trim()) ? 'No part of the path may be empty, start with a dot or be ..' : ''
    return { path, problem }
  }

  /** Why a file will not be uploaded, said before it is sent; '' when it may be. */
  function uploadProblem(name, size) {
    return size > MAX_UPLOAD ? `${name} is ${megabytes(size)}: a file of a document is at most ${megabytes(MAX_UPLOAD)}` : ''
  }

  let crcTable = null
  /** The CRC-32 of bytes, as a zip records it. */
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256)
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0 }
    }
    let c = 0xffffffff
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }

  /** Files as a zip, stored as they are (no compression): how a folder picked in the page reaches the server, which takes a template as a zip. `files`: [{ path, bytes: Uint8Array }]; the zip's parts, for a Blob. */
  function zipOf(files) {
    const enc = new TextEncoder()
    const parts = [], central = []
    let offset = 0
    for (const f of files) {
      const name = enc.encode(f.path), crc = crc32(f.bytes), size = f.bytes.length
      const local = new DataView(new ArrayBuffer(30))
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true)
      local.setUint32(14, crc, true); local.setUint32(18, size, true); local.setUint32(22, size, true); local.setUint16(26, name.length, true)
      const dir = new DataView(new ArrayBuffer(46))
      dir.setUint32(0, 0x02014b50, true); dir.setUint16(4, 20, true); dir.setUint16(6, 20, true); dir.setUint16(8, 0x0800, true)
      dir.setUint32(16, crc, true); dir.setUint32(20, size, true); dir.setUint32(24, size, true); dir.setUint16(28, name.length, true); dir.setUint32(42, offset, true)
      parts.push(new Uint8Array(local.buffer), name, f.bytes)
      central.push(new Uint8Array(dir.buffer), name)
      offset += 30 + name.length + size
    }
    const end = new DataView(new ArrayBuffer(22))
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true)
    end.setUint32(12, central.reduce((n, x) => n + x.length, 0), true); end.setUint32(16, offset, true)
    return [...parts, ...central, new Uint8Array(end.buffer)]
  }

  /** A template's name made from a zip's or a folder's: its extension dropped, what a folder's name may not hold made a dash (template_name in server/rft_documents.py). */
  function templateName(raw) {
    const name = String(raw || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop().replace(/\.zip$/i, '')
    return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60)
  }

  /** A template as the New document menu says it. */
  function templateWords(t) {
    return t.builtIn ? (t.name === 'report' ? 'Thesis chapter (report)' : 'Paper (article)') : `${t.name}${t.files != null ? ` · ${t.files} file${t.files === 1 ? '' : 's'}` : ''}${t.engine ? ` · ${(ENGINES.find(x => x[0] === t.engine) || [])[1] || t.engine}` : ''}`
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

  /** An error of the compile in a line: where (a snippet's id, or the file: a document's by its path inside it) and what. */
  function errorText(e) {
    return `${e.snippet || e.in || e.file}${e.line ? `:${e.line}` : ''}: ${e.message}${e.context ? ` (${e.context})` : ''}`
  }

  function mount({ key, store, open, nodes, notify, visible, changed = () => {}, every = 4000 }) {
    const $ = id => document.getElementById(id)
    const section = $('manuscript')
    if (!section) return null
    const listEl = $('ms-list'), headEl = $('ms-head'), threadsEl = $('ms-threads'), emptyEl = $('ms-empty'), body = $('ms-body')
    const pdfFrame = $('ms-pdf-frame'), pdfNote = $('ms-pdf-note'), errorsEl = $('ms-errors'), statusEl = $('ms-status')
    const docSel = $('ms-doc'), lockBtn = $('ms-lock'), compileBtn = $('ms-compile')
    const viewEl = $('ms-view'), cmEl = $('ms-cm'), uploadInput = $('ms-upload')
    let viewing = null // an image or a PDF of the document shown where the editor is: { rel, kind, url }
    let uploadTo = '' // the folder the picker's files go in
    let ms = null // api/manuscript
    let level = store.get('msLevel', 'snippets') === 'documents' ? 'documents' : 'snippets'
    let doc = store.get('msDoc', '')
    let docFile = '' // the document's file open in the editor, by its path inside the document ('': its main file)
    let sid = store.get('msSnippet', '') // the snippet open in the Snippets view
    let file = null // { path, version, text (as read) }
    let note = null // the open snippet or document as api/note gives it: its threads
    let dirty = false
    let loading = false
    let pdfUrl = null
    // a browser with no PDF viewer of its own (Chrome on Android: a framed PDF is a broken page) or a
    // touch screen (a framed PDF there neither scrolls nor zooms with the page): its pages drawn by pdf.js
    const drawn = navigator.pdfViewerEnabled === false || !!(root.matchMedia && root.matchMedia('(pointer: coarse)').matches)
    const pdfPages = $('ms-pdf-pages'), pdfView = drawn ? pdfPages : pdfFrame
    const PDFJS = 'vendor/pdf.v4.10.38.min.mjs', PDFJS_WORKER = 'vendor/pdf.worker.v4.10.38.min.mjs'
    let pdfjs = null // the module, loaded the first time a PDF is drawn
    let pdfDoc = null
    let pdfGen = 0
    const pdfSeen = drawn ? new IntersectionObserver(seen => { for (const e of seen) e.isIntersecting ? void drawPage(e.target) : letGo(e.target) },
      { root: pdfPages, rootMargin: '150% 0px' }) : null
    let pdfWidth = 0
    if (drawn) new ResizeObserver(() => {
      if (Math.abs(pdfPages.clientWidth - pdfWidth) < 1) return
      pdfWidth = pdfPages.clientWidth
      for (const c of pdfPages.children) if (c.dataset.drawn) void drawPage(c)
    }).observe(pdfPages)
    let compiling = false
    let composing = null // { kind, anchor, msg?, repl?: what is typed so far }
    const replies = new Map() // a thread's reply being typed, by its id
    let threadsShown = '' // what the discussion was drawn from: drawn again only when it changes
    let marks = []
    let copyLines = [] // the editor's line classes on the copies
    let focusCopy = null // the copy shown in the document's head
    const inserting = { note: '', saved: null, pick: '' } // the document head's Insert: the note typed, what it gives, what is picked
    const canWrite = () => !!key()

    const cm = root.CodeMirror ? root.CodeMirror($('ms-cm'), {
      mode: 'stex', lineNumbers: true, lineWrapping: true, styleActiveLine: true, matchBrackets: true, tabSize: 2, indentUnit: 2,
      extraKeys: { 'Ctrl-S': () => save(true), 'Cmd-S': () => save(true) },
    }) : null
    if (cm) {
      // measured again whenever its box changes: text set while its pane was hidden (a phone shows one pane
      // at a time) is otherwise left undrawn, or under the line numbers, until something else redraws it
      if (root.ResizeObserver) {
        let size = ''
        new ResizeObserver(() => {
          const w = cm.getWrapperElement(), now = `${w.clientWidth}x${w.clientHeight}`
          if (now !== size) { size = now; if (w.clientWidth) cm.refresh() }
        }).observe(cm.getWrapperElement())
      }
      cm.on('change', () => { if (!loading) { dirty = true; renderStatus() } })
      cm.on('cursorActivity', () => {
        renderSelectionButtons()
        if (level === 'documents' && !dirty) {
          const line = cm.getCursor().line
          const c = outline().find(o => o.type === 'copy' && line >= o.line && line <= o.end)
          if ((c && c.name) !== (focusCopy && focusCopy.name)) { focusCopy = c || null; renderList(); renderHead() }
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

    // the toolbar lock's own drawing, so a snippet's or document's lock looks like it
    function lockIcon(locked) {
      const svg = lockBtn.querySelector(locked ? '.lock-closed' : '.lock-open').cloneNode(true)
      svg.classList.remove('on')
      return svg
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
    // what is discussed: the open snippet, or the open document through its main file (its threads are anchored on that file's text)
    const subject = () => (level === 'snippets' ? (file && sid) : (theDoc() && openRel() === theDoc().main ? doc : '')) || null
    /** The open document's file in the editor: the one last chosen, while the document still has it; else its main file. */
    const openRel = () => { const d = theDoc(); const all = editable(d); return all.includes(docFile) ? docFile : (d && d.main) || all[0] || 'main.tex' }
    const pathOf = () => (level === 'snippets' ? (sid ? `snippets/${sid}.tex` : '') : doc ? `documents/${doc}/${openRel()}` : '')
    const outline = () => (level === 'documents' && file ? outlineOf(cm ? cm.getValue() : file.text, (theDoc() || {}).copies, openRel()) : [])

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
      const compileWord = level === 'snippets' ? 'Compile snippet' : 'Compile'
      compileBtn.querySelector('.lbl').textContent = compileWord
      compileBtn.setAttribute('aria-label', compileWord)
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
      const word = c.state === 'placed' ? 'as snippet' : c.state === 'review' ? 'review' : c.state
      const title = c.state === 'review' ? 'Its snippet changed since this copy was taken: take the new text, or keep yours'
        : c.state === 'adapted' ? 'Adapted to this document: it differs from its snippet, which has not changed since'
          : c.state === 'gone' ? 'No such snippet any more'
            : c.state === 'lost' ? 'Not found in the document any more: its marker lines and its text were changed elsewhere. Point to it again, or drop it' : 'As its snippet'
      return el('span', { class: `ms-state ms-copy-${c.state}`, text: word, title })
    }

    function renderList() {
      if (level === 'snippets') {
        const item = s => el('li', {
          class: `ms-item${s.id === sid && file ? ' open' : ''}`, title: `${s.id} ${s.kind}: ${s.title}${s.usedIn.length ? `\nUsed in ${usedWords(s)}` : '\nIn no document'}`,
          onclick: () => openSnippet(s.id),
        }, el('span', { class: 'ms-id', text: s.id }), el('span', { class: 'ms-title', text: s.title || '(no header)' }),
        stateBadge(s), s.unverified && s.unverified.length ? el('span', { class: 'ms-flag', text: '!', title: `Rests on notes not verified: ${s.unverified.join(', ')}` }) : null,
        s.usedIn.length ? el('span', { class: 'ms-used', text: `×${usedCount(s)}`, title: `Used in ${usedWords(s)}` }) : null,
        s.threads ? el('span', { class: 'ms-threads-n', text: String(s.threads), title: `${s.threads} open thread(s)` }) : null)
        const groups = byKind(ms.snippets)
        listEl.replaceChildren(...(groups.length ? groups.flatMap(g => [el('div', { class: 'ms-sub muted', text: g.kind }), el('ul', {}, g.snippets.map(item))])
          : [el('p', { class: 'muted ms-pad', text: 'No snippets yet: + Snippet, or ask Claude with /rft-manuscript.' })]))
        return
      }
      const d = theDoc()
      if (!d) { listEl.replaceChildren(el('p', { class: 'muted ms-pad', text: 'No document yet: + Document.' })); return }
      const here = openRel()
      const items = outline()
      const go = line => () => { if (cm) { cm.setCursor({ line, ch: 0 }); cm.scrollIntoView({ line, ch: 0 }, 80); cm.focus() } }
      const titleOf = id => (theSnippet(id) || {}).title || ''
      const copyRow = (o, onclick, depth = 0) => el('li', { class: `ms-item ms-copy${focusCopy && focusCopy.name === o.name ? ' open' : ''}`, style: `padding-left:${24 + 14 * depth}px`, title: `A copy of ${o.id}${o.markers === false ? ' (its marker lines are gone)' : ''}`, onclick },
        el('span', { class: 'ms-id', text: o.name }), el('span', { class: 'ms-title', text: titleOf(o.id) || o.marker || '' }), copyBadge(o),
        o.markers === false && o.state !== 'lost' ? el('span', { class: 'ms-flag', text: '%', title: 'Its marker lines are gone: found by its text. Open it to put them back' }) : null,
        o.included === false && o.state !== 'lost' ? el('span', { class: 'ms-flag', text: '∅', title: 'Not in the document: the main file does not take its file in' }) : null,
        o.snippetReview ? el('span', { class: 'ms-flag', text: '!', title: 'Its snippet is in review: its notes changed' }) : null)
      const own = (d.bib || []).filter(b => !b.from)
      const out = (d.notIncluded || [])
      const shownRel = viewing ? viewing.rel : here
      const act = (word, label, title, onclick) => el('button', { type: 'button', class: 'ms-row-act', 'aria-label': label, title, text: word, onclick: ev => { ev.stopPropagation(); onclick() } })
      // every file and folder of the document; under the open file its outline, under the others the copies they hold
      const rows = treeRows(d).flatMap(e => {
        const pad = `padding-left:${10 + 14 * e.depth}px`
        if (e.kind === 'folder') {
          return [el('li', { class: 'ms-item ms-file ms-folder', style: pad, 'data-folder': e.path, title: `The folder ${e.path} (drop files here to upload them into it)` },
            el('span', { class: 'ms-title', text: `${e.name}/` }),
            el('span', { class: 'ms-row-acts' },
              act('+', `New file in ${e.path}`, 'A new file in this folder', () => void newEntry('file', e.path)),
              act('↑', `Upload into ${e.path}`, 'Upload files into this folder', () => pickFiles(e.path)),
              act('✎', `Rename ${e.path}`, 'Rename or move this folder, with what it holds', () => void renameEntry(e)),
              act('×', `Delete ${e.path}`, 'Delete this folder and all it holds', () => void deleteEntry(e))))]
        }
        const f = e.path
        const tex = (d.files || []).includes(f)
        return [
          el('li', {
            class: `ms-item ms-file${f === shownRel ? ' open' : ''}${e.edit || e.show ? '' : ' ms-file-other'}`, style: pad, 'data-folder': e.folder,
            title: `${f === d.main ? 'The main file' : e.edit ? 'A file of the document' : e.show ? `${e.show === 'pdf' ? 'A PDF' : 'An image'} of the document` : 'A file of the document, which the page neither opens nor shows'}${out.includes(f) ? ': the main file does not take it in, so its copies are not in the document' : ''}${e.edit || e.show ? ' (click: open it)' : ''}`,
            onclick: () => (e.edit ? (f === here && !viewing ? go(0)() : void openDocFile(f)) : e.show ? void showFile(e) : notify(`${f} is neither text nor an image: it is part of the document, and compiled with it.`)),
          }, el('span', { class: 'ms-title', text: e.name }),
          f === d.main ? el('span', { class: 'ms-main', text: 'main', title: `The main file: the one with \\begin{document}, which is compiled (${d.name})` }) : null,
          out.includes(f) ? el('span', { class: 'ms-flag', text: '∅', title: 'The main file does not take this file in' }) : null,
          f === d.main && d.threads ? el('span', { class: 'ms-threads-n', text: String(d.threads), title: `${d.threads} open thread(s)` }) : null,
          el('span', { class: 'ms-row-acts' },
            act('✎', `Rename ${f}`, 'Rename or move this file (its copies and values stay its own)', () => void renameEntry(e)),
            act('×', `Delete ${f}`, 'Delete this file', () => void deleteEntry(e)))),
          ...(!tex ? [] : f === here && !viewing
            ? items.map(o => o.type === 'heading'
              ? el('li', { class: `ms-item ms-heading ms-h-${o.level}`, style: `padding-left:${24 + 14 * e.depth}px`, onclick: go(o.line) }, el('span', { class: 'ms-title', text: `§ ${o.title}` }))
              : copyRow(o, () => { focusCopy = o; go(o.line + 1)(); renderList(); renderHead() }, e.depth))
            : (d.copies || []).filter(c => c.file === f && c.state !== 'lost').map(c => copyRow(c, () => void showCopy(d.name, c.name, f), e.depth))),
          ...(/\.bib$/i.test(f) && own.some(x => x.file === f) ? [el('li', { class: 'ms-item ms-note muted', title: 'Entries you added yourself: no reference note of the tree stands behind them' },
            el('span', { class: 'ms-title', text: `Your own: ${own.filter(x => x.file === f).map(x => x.key).join(', ')}` }))] : []),
        ]
      })
      const bar = el('div', { class: 'ms-files-bar' },
        el('button', { type: 'button', text: '+ File', title: 'A new file of this document (a path makes its folders: chapters/intro.tex)', onclick: () => void newEntry('file', '') }),
        el('button', { type: 'button', text: '+ Folder', title: 'A new folder of this document', onclick: () => void newEntry('folder', '') }),
        el('button', { type: 'button', text: 'Upload', title: 'Upload images, PDFs or any other file into this document (20 MB a file at most); or drop them on the list', onclick: () => pickFiles('') }))
      // several files have \begin{document} and none was chosen: the page asks
      const asked = (d.mainAsked || []).length ? el('div', { class: 'ms-pad ms-ask' },
        el('p', { class: 'ms-flag-text', text: 'Several files of this document have \\begin{document}. Which one is its main file, the one that is compiled?' }),
        d.mainAsked.map(f => el('button', { type: 'button', text: f, title: `Make ${f} the main file (you can change it later, in the document's head)`, onclick: () => void setting({ main: f }, 'choose the main file') }))) : null
      const lost = (d.copies || []).filter(c => c.state === 'lost')
      const values = (d.values || []).filter(v => v.state !== 'current')
      const group = (word, title, lis) => (lis.length ? [el('div', { class: 'ms-sub ms-flag-text', text: word, title }), el('ul', {}, lis)] : [])
      // a document from before documents were plain LaTeX: one action brings it over
      const old = d.firstDesign ? el('div', { class: 'ms-pad ms-old' },
        el('p', { class: 'ms-flag-text', text: 'This document was written before documents became plain LaTeX: it holds markers and macros of the plugin, so it cannot be shared and its copies are not shown.' }),
        el('button', { type: 'button', class: 'primary', text: 'Convert it', title: 'Its copies get marker lines that say only their kind and title, its numbers, figures and citations are written out, and the file as it is now is kept beside its tracking file', onclick: () => void ask({ action: 'convert', name: d.name }, 'convert the document') })) : null
      listEl.replaceChildren(...(old ? [old] : []), bar, ...(asked ? [asked] : []), el('ul', { class: 'ms-tree' }, rows),
        ...group('Lost copies', 'Copies the plugin cannot find in the document any more: their marker lines and their text were changed elsewhere', lost.map(c => el('li', { class: 'ms-item ms-copy ms-wrap' },
          el('span', { class: 'ms-id', text: c.name }), el('span', { class: 'ms-title', text: `${c.marker} (was in ${c.file})` }),
          el('button', { type: 'button', text: 'It is the selection', title: 'Select the passage in the editor first: it becomes this copy again, between its marker lines', onclick: () => void pointAt(c.name) }),
          el('button', { type: 'button', text: 'Drop', title: 'Stop tracking it (the snippet stays, and so does the document\'s text)', onclick: () => { if (confirm(`Stop tracking the lost copy of ${c.name} in ${d.name}?`)) void ask({ action: 'remove', name: d.name, id: c.name }, 'drop the copy') } })))),
        ...group('Values to look at', 'Numbers, figures and tables of the tree written in this document that the tree no longer says, or that were changed here', values.map(v => el('li', { class: 'ms-item ms-wrap', title: 'Show it in the text', onclick: () => void goTo(v.file, v.line) },
          el('span', { class: 'ms-title', text: valueWords(v) }),
          v.state !== 'lost' && v.now != null ? el('button', { type: 'button', text: v.kind === 'figure' ? 'Copy it again' : `Take ${v.kind === 'number' ? v.now : 'it'}`, title: 'Write the tree\'s value in its place', onclick: ev => { ev.stopPropagation(); void ask({ action: 'take-value', name: d.name, index: v.index }, 'take the value') } }) : null,
          el('button', { type: 'button', text: v.state === 'lost' || v.now == null ? 'Forget' : 'Keep mine', title: v.state === 'lost' || v.now == null ? 'Stop tracking it: what stands there is the document\'s own' : 'Keep what the document says: it is flagged again only when the tree changes', onclick: ev => { ev.stopPropagation(); void ask({ action: 'keep-value', name: d.name, index: v.index }, 'keep the value') } })))),
        ...group(`Traces of the tree (${(d.traces || []).length})`, 'This document\'s files are shared with co-authors as they are: nothing in them should name the tree', (d.firstDesign ? [] : d.traces || []).slice(0, 40).map(x => el('li', { class: 'ms-item ms-wrap', title: x.text || x.file, onclick: () => void goTo(x.file, x.line) },
          el('span', { class: 'ms-title', text: traceWords(x) }),
          el('button', { type: 'button', text: 'Allow', title: 'A false alarm (a "Table S01" of a supplement): this occurrence is not flagged again', onclick: ev => { ev.stopPropagation(); void ask({ action: 'allow', name: d.name, file: x.file, match: x.match, text: x.text || '' }, 'allow it') } })))))
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
      const saveBtn = iconBtn('save', 'Save', { class: 'primary', title: 'Save (Ctrl/Cmd+S also compiles)', onclick: () => save(false) })
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
              type: 'button', class: 'icon-btn', 'aria-pressed': String(s.locked), 'aria-label': 'Lock this snippet',
              title: s.locked ? 'Yours to write: Claude only suggests (click: let Claude write this snippet)' : 'Claude may write this snippet (click: yours again)',
              onclick: () => setLock('snippets', !s.locked, s.id),
            }, lockIcon(s.locked)) : null,
            el('span', { class: 'ms-spacer' }), el('span', { class: 'ms-acts' }, selButton('comment'), selButton('suggestion'), saveBtn)),
          el('div', { class: 'ms-head-row ms-basis' },
            el('span', { class: 'muted', text: 'Rests on' }),
            s.basis.length ? s.basis.map(chip) : el('span', { class: 'muted', text: 'no note: give it a % basis: line' }),
            s.unverified.length ? el('span', { class: 'ms-flag-text', text: `not verified: ${s.unverified.join(', ')}` }) : null,
            s.missing.length ? el('span', { class: 'ms-flag-text', text: `no such note: ${s.missing.join(', ')}` }) : null),
          el('div', { class: 'ms-head-row' },
            el('span', { class: 'muted', text: 'Used in' }),
            s.usedIn.length ? s.usedIn.map(u => el('button', {
              type: 'button', class: `ms-chip ms-copy-${(u.states || []).includes('review') ? 'review' : (u.states || []).includes('adapted') ? 'adapted' : 'placed'}`, text: `${u.doc} · ${useWords(u)}`,
              title: `Go to its ${u.count > 1 ? `${u.count} copies` : 'copy'} in ${u.doc}, ${u.file}`, onclick: () => showCopy(u.doc, s.id, u.file),
            })) : el('span', { class: 'muted', text: 'no document yet' }),
            ms.documents.length ? placeForm(s.id) : null),
        )
      } else {
        const d = theDoc()
        headEl.append(el('div', { class: 'ms-head-row' },
          el('strong', { text: `${doc}` }), el('span', { class: 'ms-file', text: openRel() }), el('span', { class: 'muted', text: `${d ? d.copies.length : 0} cop${d && d.copies.length === 1 ? 'y' : 'ies'} of snippets` }),
          d ? el('button', {
            type: 'button', class: 'icon-btn', 'aria-pressed': String(d.locked), 'aria-label': 'Lock this document',
            title: d.locked ? 'Its text is yours: Claude places copies you agree to and suggests (click: let Claude edit it)' : 'Claude may edit its text (click: yours again)',
            onclick: () => setLock('documents', !d.locked, d.name),
          }, lockIcon(d.locked)) : null,
          d ? el('label', { class: 'ms-set', title: 'What compiles this document. latexmk picks bibtex or biber itself' }, 'Engine ',
            el('select', { 'aria-label': 'Engine', onchange: ev => void setting({ engine: ev.target.value }, 'change the engine') }, ENGINES.map(([v, word]) => el('option', { value: v, text: word, selected: v === (d.engine || 'pdflatex') })))) : null,
          d && ((d.mainCandidates || []).length > 1 || (d.mainAsked || []).length) ? el('label', { class: 'ms-set', title: 'The file that is compiled: one with \\begin{document}' }, 'Main file ',
            el('select', { 'aria-label': 'Main file', onchange: ev => void setting({ main: ev.target.value }, 'change the main file') },
              (d.mainAsked || []).length ? el('option', { value: '', text: 'choose…', selected: true, disabled: true }) : null,
              (d.mainCandidates || []).map(f => el('option', { value: f, text: f, selected: !(d.mainAsked || []).length && f === d.main })))) : null,
          el('span', { class: 'ms-spacer' }), el('span', { class: 'ms-acts' }, selButton('comment'), selButton('suggestion'), saveBtn)))
        const extra = focusCopy ? copyPanel(focusCopy) : placeRow()
        if (extra) headEl.append(extra)
        const insert = focusCopy ? null : insertRow()
        if (insert) headEl.append(insert)
      }
      renderSelectionButtons()
    }

    /** Place this snippet in a document: the document, Place (before its bibliography; move it after). A snippet may be placed more than once. */
    function placeForm(id) {
      const docs = ms.documents
      if (!docs.length) return null
      const sel = el('select', { 'aria-label': 'Document' }, docs.map(d => el('option', { value: d.name, text: d.name, selected: d.name === doc })))
      return el('span', { class: 'ms-place' }, el('span', { class: 'muted', text: '· Place in' }), sel,
        el('button', { type: 'button', text: 'Place', title: 'Copy it into that document as plain LaTeX, before its bibliography (move it there afterwards)', onclick: () => place(sel.value, id) }))
    }

    /** A document's row for placing a snippet from the library in the open file: which, after what; or making the selected passage a copy of it. */
    function placeRow() {
      const d = theDoc()
      if (!d || !/\.(tex|ltx)$/i.test(openRel())) return null
      if (!ms.snippets.length) return el('div', { class: 'ms-head-row muted', text: 'No snippets yet to place here.' })
      const which = el('select', { 'aria-label': 'Snippet' }, ms.snippets.map(s => el('option', { value: s.id, text: `${s.id} ${s.title}${d.copies.some(c => c.id === s.id) ? ' (already here)' : ''}` })))
      const after = afterSelect()
      return el('div', { class: 'ms-head-row' }, el('span', { class: 'muted', text: 'Place' }), which, el('span', { class: 'muted', text: 'after' }), after,
        el('button', { type: 'button', text: 'Place', title: 'Write the snippet out here as plain LaTeX, between two marker lines, referenced to it', onclick: () => place(doc, which.value, after.value, openRel()) }),
        el('button', { type: 'button', class: 'ms-sel-copy', text: 'Selection is a copy', title: 'The selected passage becomes a copy of this snippet as it is: text a co-author wrote, tied to the tree without being replaced', onclick: () => void pointAt(which.value) }))
    }

    /** What a note gives a document, as the Insert menu offers it: `number:acc.1k`, `figure:loss`, `table:by_seed`, `citation:`. */
    const insertChoices = saved => (!saved ? [] : [
      ...(saved.reference ? [['citation:', 'cite it']] : []),
      ...Object.entries(saved.numbers || {}).map(([k, v]) => [`number:${k}`, `${k} = ${v}`]),
      ...(saved.figures || []).map(f => [`figure:${f}`, `figure ${f}`]), ...(saved.tables || []).map(x => [`table:${x}`, `table ${x}`]),
    ])

    /** A document's row for writing something of the tree at the cursor, outside any copy: a note's saved number, figure or table, or a citation of a reference. It is plain LaTeX there, and tracked. */
    function insertRow() {
      const d = theDoc()
      if (!d || !/\.(tex|ltx)$/i.test(openRel())) return null
      const all = [...nodes().values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      const note = el('input', { type: 'text', list: 'ms-insert-notes', size: 10, autocomplete: 'off', spellcheck: 'false', placeholder: 'E05, R07…', 'aria-label': 'The note it comes from' })
      note.value = inserting.note
      const what = el('select', { 'aria-label': 'What of the note' })
      const go = el('button', {
        type: 'button', text: 'Insert', title: 'Write it at the cursor as plain LaTeX. It is tracked: when the tree changes it, it is listed under Values to look at',
        onclick: async () => {
          const [kind, key] = [what.value.slice(0, what.value.indexOf(':')), what.value.slice(what.value.indexOf(':') + 1)]
          if (!cm || !kind) return
          const at = cm.getCursor()
          const got = await ask({ action: 'insert', name: doc, kind, id: inserting.note, ...(kind === 'citation' ? {} : { match: key }), file: openRel(), from: at.line + 1, to: at.ch }, 'insert it')
          if (got && cm) cm.focus()
        },
      })
      const fill = () => {
        const choices = insertChoices(inserting.saved)
        what.replaceChildren(...(choices.length ? choices.map(([value, text]) => el('option', { value, text, selected: value === inserting.pick }))
          : [el('option', { value: '', text: inserting.note ? (inserting.saved ? 'nothing saved to insert' : 'no such note') : 'a number, figure, table or citation' })]))
        what.disabled = go.disabled = !choices.length
      }
      const look = async () => {
        inserting.note = note.value.trim().toUpperCase()
        inserting.saved = null
        if (/^[A-Z]\d+$/.test(inserting.note)) {
          try { const r = await api(`api/manuscript/saved?id=${encodeURIComponent(inserting.note)}`); if (r.ok) inserting.saved = r.data } catch { /* the next try */ }
        }
        fill()
      }
      note.addEventListener('change', () => void look())
      note.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); void look() } })
      what.addEventListener('change', () => { inserting.pick = what.value })
      fill()
      return el('div', { class: 'ms-head-row' }, el('span', { class: 'muted', text: 'Insert from' }), note,
        el('datalist', { id: 'ms-insert-notes' }, all.map(n => el('option', { value: n.id, text: `${n.id} ${n.title}` }))), what, go)
    }

    /** Where in the open file: the end (before the bibliography), after a heading, or after a copy. */
    function afterSelect(skip) {
      return el('select', { 'aria-label': 'Where' }, el('option', { value: '', text: 'the end' }),
        outline().filter(o => !(o.type === 'copy' && o.name === skip)).map(o => el('option', { value: o.type === 'copy' ? o.name : o.title, text: o.type === 'copy' ? o.name : `§ ${o.title}` })))
    }

    /** The copy the cursor is in: its state, its text when placed and its snippet now when in review, take or keep, move, remove. */
    function copyPanel(c) {
      const s = theSnippet(c.id)
      const after = afterSelect(c.name)
      const tracked = ((theDoc() || {}).copies || []).find(x => x.name === c.name) || {}
      const box = el('div', { class: `ms-copy-panel ms-copy-${c.state}` },
        el('div', { class: 'ms-head-row' },
          el('strong', { text: `Copy of ${c.name}` }), s ? el('span', { class: 'muted', text: s.title }) : null, copyBadge(c),
          c.snippetReview ? el('span', { class: 'ms-flag-text', text: 'its snippet is in review: its notes changed' }) : null,
          c.markers === false ? el('button', { type: 'button', text: 'Put its marker lines back', title: 'Its two marker lines were deleted: it was found by its text. Put them back around it', onclick: () => ask({ action: 'markers', name: doc, id: c.name }, 'put the marker lines back') }) : null,
          s ? el('button', { type: 'button', text: 'Open the snippet', onclick: () => openSnippet(c.id) }) : null,
          el('span', { class: 'ms-spacer' }),
          el('span', { class: 'muted', text: 'Move after' }), after,
          el('button', { type: 'button', text: 'Move', onclick: () => ask({ action: 'move', name: doc, id: c.name, file: openRel(), ...(after.value ? { after: after.value } : {}) }, 'move the copy') }),
          el('button', { type: 'button', text: 'Remove', title: 'Take the copy out of this document (the snippet stays)', onclick: () => { if (confirm(`Take the copy of ${c.name} out of ${doc}? The snippet stays.`)) void ask({ action: 'remove', name: doc, id: c.name }, 'remove the copy') } }),
          el('button', { type: 'button', class: 'icon-btn', text: '✕', title: 'Close', onclick: () => { focusCopy = null; renderList(); renderHead() } })))
      if (c.state === 'review' && s) {
        const now = el('pre', { class: 'ms-diff-text', text: '…' })
        api(`api/manuscript/file?path=${encodeURIComponent(`snippets/${c.id}.tex`)}`).then(r => { now.textContent = r.ok ? contentOf(r.data.text) : '(not read)' }).catch(() => {})
        box.append(
          el('div', { class: 'ms-diff' },
            el('div', {}, el('div', { class: 'muted', text: 'The snippet as it was placed here' }), el('pre', { class: 'ms-diff-text', text: tracked.placed != null ? tracked.placed : '(not recorded)' })),
            el('div', {}, el('div', { class: 'muted', text: 'The snippet now' }), now)),
          el('div', { class: 'ms-head-row' },
            el('button', { type: 'button', class: 'primary', text: 'Take the new text', title: 'Replace this copy with the snippet\'s text now, written out as plain LaTeX (what you adapted here is lost)', onclick: () => { if (confirm(`Replace the copy of ${c.name} in ${doc} with the snippet's text now? What you adapted here is lost.`)) void ask({ action: 'take', name: doc, id: c.name }, 'take the new text') } }),
            el('button', { type: 'button', text: 'Keep mine', title: 'Keep this copy as it is: it answers to the snippet as it is now', onclick: () => ask({ action: 'keep', name: doc, id: c.name }, 'keep the copy') })))
      }
      return box
    }

    /** The Comment or Suggest button: on the text selected in the editor. */
    function selButton(kind) {
      return iconBtn(kind, kind === 'comment' ? 'Comment' : 'Suggest', {
        class: 'ms-sel-btn', 'data-kind': kind,
        title: kind === 'comment' ? 'A question or remark on the selected text' : 'New text for the selected text, or what should change in words',
        onclick: () => compose(kind),
      })
    }

    /** A button as a symbol and a word (on a phone the symbol alone, its word its name in aria-label), as the toolbar's are. */
    function iconBtn(name, word, props) {
      const b = el('button', { type: 'button', ...props, class: `ms-ib${props.class ? ` ${props.class}` : ''}`, 'aria-label': word })
      const t = document.createElement('template')
      t.innerHTML = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`
      b.append(t.content.firstChild, el('span', { class: 'lbl', text: word }))
      return b
    }

    function renderSelectionButtons() {
      const selected = !!(cm && file && cm.somethingSelected())
      const on = selected && !dirty && !!subject()
      for (const b of headEl.querySelectorAll('.ms-sel-btn')) {
        b.disabled = !on
        if (dirty) b.title = 'Save first: a thread is anchored on the text as saved'
        else if (level === 'documents' && !subject()) b.title = 'A document is discussed on its main file: open it to comment or suggest'
      }
      for (const b of headEl.querySelectorAll('.ms-sel-copy')) b.disabled = !selected
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
      file = { path, version: r.data.version, text: r.data.text }
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

    /** Opens a document on the file holding a copy, the cursor in it: `id` a copy's name there (S04, S04#2) or a snippet (its first copy in `rel`). */
    async function showCopy(name, id, rel) {
      if (dirty && !confirm('Leave the unsaved changes?')) return
      dirty = false
      doc = name
      store.set('msDoc', doc)
      const d = theDoc()
      const held = d && (d.copies || []).find(c => c.state !== 'lost' && (c.name === id || c.id === id) && (!rel || c.file === rel))
      docFile = rel || (held && held.file) || ''
      await setLevel('documents', true)
      const c = outline().find(o => o.type === 'copy' && (o.name === id || o.id === id))
      if (c && cm) { focusCopy = c; cm.setCursor({ line: c.line + 1, ch: 0 }); cm.scrollIntoView({ line: c.line, ch: 0 }, 80); renderList(); renderHead() }
    }

    /** Opens another file of the open document in the editor. */
    async function openDocFile(rel) {
      if (dirty && !confirm('Leave the unsaved changes?')) return false
      dirty = false
      docFile = rel
      focusCopy = null
      closeView()
      return openFile(pathOf())
    }

    /** The editor back where an image or a PDF was shown. */
    function closeView() {
      if (!viewing) return
      URL.revokeObjectURL(viewing.url)
      viewing = null
      viewEl.hidden = true
      viewEl.replaceChildren()
      cmEl.hidden = false
      if (cm) setTimeout(() => cm.refresh(), 0)
    }

    /** Shows an image or a PDF of the open document where the editor is: it is not opened as text. */
    async function showFile(e) {
      if (!canWrite()) { needKey('see the file'); return }
      if (dirty && !confirm('Leave the unsaved changes?')) return
      let res
      try { res = await fetch(`api/manuscript/raw?doc=${encodeURIComponent(doc)}&path=${encodeURIComponent(e.path)}`, { cache: 'no-store', headers: { 'X-RFT-Token': key() } }) } catch { notify('The server is not answering.'); return }
      if (!res.ok) { notify(`${e.path} could not be shown (${res.status})`); return }
      closeView()
      dirty = false
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      // an image is shown from a data: address, which the page's policy lets an <img> have (a blob: one it does not)
      const src = e.show !== 'image' ? url : await new Promise(done => { const r = new FileReader(); r.onload = () => done(r.result); r.onerror = () => done(''); r.readAsDataURL(blob) })
      viewing = { rel: e.path, kind: e.show, url }
      const size = e.size == null ? '' : ` · ${e.size >= 1e5 ? megabytes(e.size) : `${Math.max(1, Math.round(e.size / 1000))} kB`}`
      viewEl.replaceChildren(
        el('div', { class: 'ms-view-head' }, el('strong', { text: e.path }), el('span', { class: 'muted', text: `${e.show === 'pdf' ? 'a PDF' : 'an image'}${size}` }),
          el('span', { class: 'ms-spacer' }), el('a', { href: url, target: '_blank', rel: 'noopener', text: 'Open' }),
          el('button', { type: 'button', text: 'Back to the text', onclick: () => { closeView(); renderList(); renderHead() } })),
        e.show === 'image' ? el('img', { src, alt: e.path }) : drawn ? el('p', { class: 'muted ms-pad', text: 'This browser shows no PDF inside a page: Open shows it on its own.' })
          : el('iframe', { src: url, title: e.path }))
      viewEl.hidden = false
      cmEl.hidden = true
      renderList()
      renderHead()
    }

    // ---------------------------------------------------------------- the document's files

    /** A change to the open document's file list, asked of the server; a deletion that would lose copies is asked about first. The manuscript as it is then, or null. */
    async function filesAsk(body, whatFor) {
      if (!canWrite()) { needKey(whatFor); return null }
      let r = await api('api/manuscript/files', { method: 'POST', body: { doc, ...body } })
      if (r.status === 409 && r.data.ask) {
        if (!confirm(r.data.error)) return null
        r = await api('api/manuscript/files', { method: 'POST', body: { doc, ...body, sure: true } })
      }
      if (!r.ok) { notify(r.data.error || `Could not ${whatFor} (${r.status})`); return null }
      ms = r.data
      return r.data
    }

    /** Unsaved text is saved, or dropped, before the files under it change. */
    async function settle() {
      if (!dirty) return true
      if (confirm('The open file has unsaved changes: save them first? (Cancel: drop them)')) await save(false)
      else dirty = false
      return !dirty
    }

    async function newEntry(kind, folder) {
      const typed = prompt(kind === 'file' ? `A new file${folder ? ` in ${folder}/` : ''}: its name (a path makes its folders, e.g. chapters/intro.tex)` : `A new folder${folder ? ` in ${folder}/` : ''}: its name`, kind === 'file' ? '.tex' : '')
      if (typed == null) return
      const { path, problem } = typedPath(typed, folder)
      if (problem) { notify(problem); return }
      const got = await filesAsk({ action: kind === 'file' ? 'new-file' : 'new-folder', path }, `make the ${kind}`)
      if (!got) return
      if (kind === 'file') { render(); await openDocFile(got.path) } else render()
    }

    async function renameEntry(e) {
      const typed = prompt(`Rename or move ${e.path} (a path inside the document):`, e.path)
      if (typed == null) return
      const { path, problem } = typedPath(typed, '')
      if (problem) { notify(problem); return }
      if (path === e.path || !(await settle())) return
      const got = await filesAsk({ action: 'move', path: e.path, to: path }, 'rename it')
      if (!got) return
      // the open file follows its new name
      const follow = rel => (rel === e.path ? path : rel.startsWith(`${e.path}/`) ? path + rel.slice(e.path.length) : rel)
      const was = docFile || (file && level === 'documents' ? openRel() : '')
      if (viewing) closeView()
      docFile = follow(was)
      render()
      if (file && docFile !== was) await openFile(pathOf())
      const d = theDoc()
      if (d && (d.notIncluded || []).includes(path)) notify(`${path} is no longer taken in by the main file: change the line that names it (\\input{…}) to its new name.`)
    }

    async function deleteEntry(e) {
      if (!(await settle())) return
      // a file with nothing tracked in it is asked about here; one that holds copies, by the server, which says what would be lost
      const d = theDoc()
      const holds = ((d && d.copies) || []).some(c => c.state !== 'lost' && (c.file === e.path || c.file.startsWith(`${e.path}/`)))
      const isMain = d && (d.main === e.path || d.main.startsWith(`${e.path}/`))
      if (!holds && !isMain && !confirm(e.kind === 'folder' ? `Delete the folder ${e.path} and all it holds?` : `Delete ${e.path}?`)) return
      const was = openRel()
      const got = await filesAsk({ action: 'delete', path: e.path }, 'delete it')
      if (!got) return
      if (viewing && (viewing.rel === e.path || viewing.rel.startsWith(`${e.path}/`))) closeView()
      render()
      if (was === e.path || was.startsWith(`${e.path}/`)) { docFile = ''; file = null; if (pathOf() && editable(theDoc()).length) await openFile(pathOf()); else if (cm) { loading = true; cm.setValue(''); loading = false; renderHead() } }
    }

    /** A document's main file or engine, kept by the server. */
    async function setting(body, whatFor) {
      if (!canWrite()) { needKey(whatFor); render(); return false }
      const r = await api('api/manuscript/settings', { method: 'POST', body: { doc, ...body } })
      if (!r.ok) { notify(r.data.error || `Could not ${whatFor} (${r.status})`); render(); return false }
      ms = r.data
      render()
      if (body.main) await loadPdf()
      return true
    }

    function pickFiles(folder) {
      if (!canWrite()) { needKey('upload'); return }
      uploadTo = folder
      uploadInput.value = ''
      uploadInput.click()
    }

    /** Files of the user's machine put in a folder of the open document, one by one, their bytes as they are. */
    async function uploadFiles(list, folder) {
      if (!canWrite()) { needKey('upload'); return }
      const d = theDoc()
      if (!d || !list.length) return
      let done = 0
      for (const f of list) {
        const { path, problem } = typedPath(f.name, folder)
        const why = problem || uploadProblem(f.name, f.size)
        if (why) { notify(problem ? `${f.name}: ${problem}` : why); continue }
        renderStatus(`Uploading ${path}…`)
        const send = replace => fetch(`api/manuscript/upload?doc=${encodeURIComponent(d.name)}&path=${encodeURIComponent(path)}${replace ? '&replace=1' : ''}`,
          { method: 'PUT', cache: 'no-store', headers: { 'Content-Type': 'application/octet-stream', 'X-RFT-Token': key() }, body: f })
        try {
          let res = await send(false)
          let data = await res.json().catch(() => ({}))
          if (res.status === 409 && data.ask) {
            if (!confirm(`${d.name} already has ${path}. Replace it?`)) continue
            res = await send(true)
            data = await res.json().catch(() => ({}))
          }
          if (!res.ok) { notify(data.error || `${path} was not uploaded (${res.status})`); continue }
          ms = data
          done++
        } catch { notify('The server is not answering.'); break }
      }
      renderStatus(done ? `Uploaded ${done} file${done === 1 ? '' : 's'}` : '')
      render()
    }

    /** Shows a place of the open document: its file, at a line (from 1). */
    async function goTo(rel, line) {
      const d = theDoc()
      if (!d || !(d.files || []).includes(rel)) return
      if (rel !== openRel() && !(await openDocFile(rel))) return
      if (cm && line) { cm.setCursor({ line: line - 1, ch: 0 }); cm.scrollIntoView({ line: line - 1, ch: 0 }, 80); cm.focus() }
    }

    /** The selected passage becomes a copy: `id` a lost copy (found again there) or a snippet (a new copy of it, its text kept). */
    async function pointAt(id) {
      if (!cm || !file || !cm.somethingSelected()) { notify('Select the passage in the editor first: its lines become the copy.'); return }
      const from = cm.getCursor('from'), to = cm.getCursor('to')
      const last = to.ch === 0 && to.line > from.line ? to.line - 1 : to.line
      await ask({ action: 'point', name: doc, id, file: openRel(), from: from.line + 1, to: last + 1 }, 'make it a copy')
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
      closeView()
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
        if (c.ok || pdfView.hidden) await loadPdf()
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
            if (e.in && level === 'documents') { await goTo(e.in, e.line); return }
            if (e.line && cm) { cm.setCursor({ line: e.line - 1, ch: 0 }); cm.focus() }
          },
        }))
        // the document asks for another engine: one action sets it and compiles again
        if (e.engine && level === 'documents') {
          const word = (ENGINES.find(x => x[0] === e.engine) || [])[1] || e.engine
          errorsEl.append(el('button', {
            type: 'button', class: 'ms-fix', text: `Set the engine to ${word} and compile`,
            title: `This document's engine becomes ${word} (LuaLaTeX is in the Engine menu too)`,
            onclick: async () => { if (await setting({ engine: e.engine }, 'change the engine')) await compile() },
          }))
        }
        // a copy's environment the document does not declare: one action adds its line to the preamble
        if (e.declare && THEOREM_NAMES[e.declare] && level === 'documents') {
          errorsEl.append(el('button', {
            type: 'button', class: 'ms-fix', text: `Add \\newtheorem{${e.declare}}{${THEOREM_NAMES[e.declare]}} to the preamble`,
            title: `This document declares no ${e.declare} environment: add its declaration to the main file's preamble, and compile again`,
            onclick: async () => { if (await ask({ action: 'declare', name: doc, environment: e.declare }, 'declare the environment')) await compile() },
          }))
        }
      }
      for (const w of warns) errorsEl.append(el('div', { class: 'ms-warn', text: w }))
      errorsEl.hidden = !errs.length && !warns.length && !c.error
    }

    async function loadPdf() {
      const w = what()
      if (!w) { pdfView.hidden = true; pdfNote.hidden = false; pdfNote.textContent = level === 'snippets' ? 'Open a snippet: Compile snippet shows it alone.' : 'No document yet.'; return }
      if (!canWrite()) { pdfNote.textContent = 'The PDF is shown to the page carrying the key: open the address /rft printed once.'; pdfNote.hidden = false; return }
      try {
        const q = w.snippet ? `snippet=${encodeURIComponent(w.snippet)}` : `doc=${encodeURIComponent(w.doc)}`
        const res = await fetch(`api/manuscript/pdf?${q}`, { cache: 'no-store', headers: { 'X-RFT-Token': key() } })
        if (!res.ok) {
          pdfView.hidden = true
          pdfNote.textContent = `${w.snippet || w.doc} has not been compiled yet: ${w.snippet ? 'Compile snippet' : 'Compile'}.`
          pdfNote.hidden = false
          return
        }
        const blob = await res.blob()
        if (pdfUrl) URL.revokeObjectURL(pdfUrl)
        pdfUrl = URL.createObjectURL(blob)
        if (!drawn) {
          pdfFrame.src = pdfUrl
          pdfFrame.hidden = false
          pdfNote.hidden = true
          return
        }
        try {
          await drawPdf(new Uint8Array(await blob.arrayBuffer()))
          pdfPages.hidden = false
          pdfNote.hidden = true
        } catch (err) {
          // pdf.js not loaded or the file not read: the PDF itself, for the phone's own viewer
          pdfPages.hidden = true
          pdfNote.replaceChildren(`The PDF could not be drawn here (${(err && err.message) || err}): `,
            el('a', { href: pdfUrl, download: `${w.snippet || w.doc}.pdf`, text: 'open the PDF' }), '.')
          pdfNote.hidden = false
        }
      } catch { /* the next compile */ }
    }

    // ---------------------------------------------------------------- the PDF drawn in the page

    /** The pages as pdf.js draws them, each when it comes near the screen and let go when it is far
     * (a thesis of 200 pages would not fit in a phone's memory drawn at once), at the screen's
     * resolution, drawn again when the pane's width changes (the phone turned). */
    async function drawPdf(bytes) {
      const gen = ++pdfGen
      const lib = await pdfLib()
      const d = await lib.getDocument({ data: bytes, isEvalSupported: false }).promise
      if (gen !== pdfGen) { void d.destroy(); return }
      const pages = []
      for (let i = 1; i <= d.numPages; i++) pages.push(await d.getPage(i))
      if (gen !== pdfGen) { void d.destroy(); return }
      // where the reader was, kept across a compile
      const at = pdfPages.scrollHeight > 0 ? pdfPages.scrollTop / pdfPages.scrollHeight : 0
      for (const c of pdfPages.children) { pdfSeen.unobserve(c); if (c._task) c._task.cancel() }
      if (pdfDoc) void pdfDoc.destroy()
      pdfDoc = d
      pdfPages.replaceChildren(...pages.map((page, i) => {
        const v = page.getViewport({ scale: 1 })
        const c = el('canvas', { class: 'ms-pdf-page', role: 'img', 'aria-label': `Page ${i + 1} of ${pages.length}`, width: 0, height: 0 })
        c.style.aspectRatio = `${v.width} / ${v.height}`
        c._page = page
        return c
      }))
      pdfPages.scrollTop = at * pdfPages.scrollHeight
      for (const c of pdfPages.children) pdfSeen.observe(c)
    }

    async function drawPage(c) {
      const w = c.clientWidth
      if (!c._page || !w) return
      const dpr = Math.min(root.devicePixelRatio || 1, 3)
      const vp = c._page.getViewport({ scale: (w * dpr) / c._page.getViewport({ scale: 1 }).width })
      const size = `${Math.round(vp.width)}x${Math.round(vp.height)}`
      if (c.dataset.drawn === size) return
      if (c._task) c._task.cancel()
      c.dataset.drawn = size
      c.width = Math.round(vp.width)
      c.height = Math.round(vp.height)
      const task = c._page.render({ canvasContext: c.getContext('2d'), viewport: vp })
      c._task = task
      try { await task.promise } catch { if (c._task === task) delete c.dataset.drawn } finally { if (c._task === task) c._task = null }
    }

    function letGo(c) {
      if (c._task) c._task.cancel()
      c._task = null
      delete c.dataset.drawn
      c.width = 0
      c.height = 0
    }

    // pdf.js is a module that names itself globalThis.pdfjsLib: loaded by a module script (a module's
    // load event comes once it has run), the first time a PDF is drawn
    function pdfLib() {
      if (!pdfjs) {
        pdfjs = new Promise((done, fail) => {
          const ready = () => root.pdfjsLib && root.pdfjsLib.getDocument
          if (ready()) return done(root.pdfjsLib)
          const s = el('script', { type: 'module', src: PDFJS })
          s.onload = () => ready() ? done(root.pdfjsLib) : fail(new Error('pdf.js did not load'))
          s.onerror = () => fail(new Error('pdf.js did not load'))
          document.head.append(s)
        }).then(lib => { lib.GlobalWorkerOptions.workerSrc = new URL(PDFJS_WORKER, document.baseURI).href; return lib })
        pdfjs.catch(() => { pdfjs = null })
      }
      return pdfjs
    }

    // ---------------------------------------------------------------- the discussion

    async function loadThreads() {
      const id = subject()
      if (!file || !id) { clearMarks(); note = null; threadsShown = ''; threadsEl.replaceChildren(); threadsEl.hidden = true; return }
      try {
        const r = await api(`api/note?id=${encodeURIComponent(id)}`)
        note = r.ok ? r.data : null
      } catch { note = null }
      // the threads read again every few seconds: the same, the discussion stays as it is (a box being
      // typed in keeps its text, its cursor and the phone's keyboard)
      if (threadsKey() !== threadsShown) renderThreads()
    }

    const threadsKey = () => JSON.stringify([subject(), file && file.version, dirty, (note && note.threads) || [], composing && [composing.kind, composing.anchor]])

    function clearMarks() {
      for (const m of marks) m.clear()
      marks = []
    }

    function renderThreads() {
      threadsShown = threadsKey()
      // a box being typed in, found again once drawn (what is typed is kept in composing and replies)
      const active = document.activeElement
      const typing = active && threadsEl.contains(active) && active.dataset.draft
        ? { draft: active.dataset.draft, from: active.selectionStart, to: active.selectionEnd } : null
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
      const again = typing && [...threadsEl.querySelectorAll('[data-draft]')].find(b => b.dataset.draft === typing.draft)
      if (again) { again.focus({ preventScroll: true }); try { again.setSelectionRange(typing.from, typing.to) } catch { /* not a text box */ } }
    }

    function threadEl(t) {
      const isOpen = t.state === 'open'
      const id = subject()
      const reply = el('textarea', { rows: 1, placeholder: 'Reply…', 'aria-label': 'Reply', 'data-draft': `reply:${t.id}` })
      reply.value = replies.get(t.id) || ''
      reply.addEventListener('input', () => { if (reply.value) replies.set(t.id, reply.value); else replies.delete(t.id) })
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
          else { note = r.data; replies.delete(t.id) }
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
      const msg = el('textarea', { rows: 2, 'data-draft': 'msg', placeholder: c.kind === 'comment' ? 'Your comment' : 'Why, or what should change (optional when you write the new text)' })
      const repl = c.kind === 'suggestion' ? el('textarea', { rows: 3, class: 'ms-repl-box', 'aria-label': 'New text', 'data-draft': 'repl' }) : null
      msg.value = c.msg || ''
      msg.addEventListener('input', () => { c.msg = msg.value })
      if (repl) {
        repl.value = c.repl != null ? c.repl : c.anchor.quote
        repl.addEventListener('input', () => { c.repl = repl.value })
      }
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
      if (dirty && level === 'documents' && ['take', 'keep', 'place', 'move', 'remove', 'take-value', 'keep-value', 'point', 'markers', 'allow', 'declare', 'convert', 'insert'].includes(body.action)) {
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

    async function place(name, id, after, rel) {
      const before = ((ms.documents.find(d => d.name === name) || {}).copies || []).map(c => c.name)
      const got = await ask({ action: 'place', name, id, ...(rel ? { file: rel } : {}), ...(after ? { after } : {}) }, 'place the copy')
      if (!got) return
      // the copy just made: the one of this snippet the document did not have (a copy placed before another takes its number)
      const copies = ((got.documents.find(d => d.name === name) || {}).copies || []).filter(c => c.id === id && c.state !== 'lost')
      const made = copies.find(c => (!rel || c.file === rel) && !before.includes(c.name)) || copies[copies.length - 1]
      await showCopy(name, made ? made.name : id, made ? made.file : rel)
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
    const docTemplate = $('ms-doc-template'), zipInput = $('ms-template-zip'), folderInput = $('ms-template-folder')
    let template = 'article' // the template the new document is made from
    let nameTouched = false // once the user types a name, the title no longer makes it
    const templatesNow = () => (ms && ms.templates) || [{ name: 'article', builtIn: true }, { name: 'report', builtIn: true }]

    function renderDocForm() {
      const all = templatesNow()
      if (!all.some(t => t.name === template)) template = 'article'
      docTemplate.replaceChildren(...all.map(t => el('option', { value: t.name, text: templateWords(t), selected: t.name === template })))
      const builtIn = (all.find(t => t.name === template) || {}).builtIn
      // a kit's files come as they are: only a built-in template has a title to set in
      docTitle.disabled = !builtIn
      docTitle.placeholder = builtIn ? 'Title, e.g. Strong augmentation on small data' : 'The template\'s own files are copied as they are'
      const name = docName.value.trim()
      const problem = docNameProblem(name, ms && ms.exists ? ms.documents.map(d => d.name) : [])
      docName.setAttribute('aria-invalid', String(!!problem && (nameTouched || !!name)))
      docHint.textContent = problem && (nameTouched || name) ? problem
        : `documents/${name || '<name>'}/ · ${builtIn ? (template === 'report' ? 'a report with a \\chapter' : 'an article with \\section headings') : `every file of the template ${template}, copied in`}`
      docHint.classList.toggle('ms-flag-text', !!problem && (nameTouched || !!name))
      docOk.disabled = !!problem
    }

    function openDocForm(prefill) {
      docForm.hidden = false
      $('ms-new-form').hidden = true
      template = 'article'
      docTitle.value = ''
      docName.value = prefill || ''
      nameTouched = !!prefill
      renderDocForm()
      docTitle.focus()
    }

    const closeDocForm = () => { docForm.hidden = true }

    docTemplate.addEventListener('change', () => {
      template = docTemplate.value
      // a thesis chapter's default name follows its template, a kit's is the kit's, until the user names the document
      if (!nameTouched && !docTitle.value.trim()) docName.value = template === 'report' ? 'thesis-ch1' : template === 'article' ? '' : slugOf(template)
      renderDocForm()
    })

    /** A template loaded into the vault's templates/ from a zip (a Blob); a name that is taken is asked for again. Its name, or ''. */
    async function loadTemplate(blob, suggested) {
      if (!canWrite()) { needKey('load a template'); return '' }
      let name = templateName(suggested)
      for (;;) {
        if (!name) { name = templateName(prompt('A name for the template (letters, digits, dots and dashes):', '') || ''); if (!name) return '' }
        renderStatus(`Loading the template ${name}…`)
        let res, data
        try {
          res = await fetch(`api/manuscript/template?name=${encodeURIComponent(name)}`, { method: 'PUT', cache: 'no-store', headers: { 'Content-Type': 'application/zip', 'X-RFT-Token': key() }, body: blob })
          data = await res.json().catch(() => ({}))
        } catch { renderStatus(''); notify('The server is not answering.'); return '' }
        renderStatus('')
        if (res.ok) { ms = data; notify(`The template ${data.name} is in the vault's templates/ (${data.files} file${data.files === 1 ? '' : 's'}): New document offers it from now on.`); return data.name }
        if (data.ask !== 'name') { notify(data.error || `The template was not loaded (${res.status})`); return '' }
        const typed = prompt(`${data.error}.\nAnother name for the template:`, `${name}-2`)
        if (typed == null) return ''
        name = templateName(typed)
      }
    }

    async function templateLoaded(name) {
      if (!name) return
      template = name
      if (!nameTouched && !docTitle.value.trim()) docName.value = slugOf(name)
      renderDocForm()
    }

    $('ms-doc-load-zip').addEventListener('click', () => { zipInput.value = ''; zipInput.click() })
    $('ms-doc-load-folder').addEventListener('click', () => { folderInput.value = ''; folderInput.click() })
    zipInput.addEventListener('change', async () => {
      const f = zipInput.files[0]
      if (f) await templateLoaded(await loadTemplate(f, f.name))
    })
    folderInput.addEventListener('change', async () => {
      // a folder picked in the page reaches the server as a zip of its files, stored as they are, under the folder's own name
      const list = [...folderInput.files]
      if (!list.length) return
      const total = list.reduce((n, f) => n + f.size, 0)
      if (total > 50000000) { notify(`That folder is ${megabytes(total)}: a template is at most 50.0 MB.`); return }
      const files = []
      for (const f of list) files.push({ path: f.webkitRelativePath || f.name, bytes: new Uint8Array(await f.arrayBuffer()) })
      const top = (list[0].webkitRelativePath || '').split('/')[0]
      await templateLoaded(await loadTemplate(new Blob(zipOf(files), { type: 'application/zip' }), top || 'template'))
    })
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
      const got = await ask({ action: 'document', name, template, ...(title && !docTitle.disabled ? { title } : {}) }, ms && ms.exists ? 'create the document' : 'start')
      docOk.disabled = false
      if (!got) return
      closeDocForm()
      doc = name
      docFile = ''
      store.set('msDoc', doc)
      await setLevel('documents', true)
    })
    $('ms-new-doc').addEventListener('click', () => (docForm.hidden ? openDocForm() : closeDocForm()))
    $('ms-start').addEventListener('click', () => openDocForm('paper'))
    docSel.addEventListener('change', async () => {
      if (dirty && !confirm('Leave the unsaved changes?')) { docSel.value = doc; return }
      dirty = false
      doc = docSel.value
      docFile = ''
      store.set('msDoc', doc)
      await setLevel('documents', true)
    })
    uploadInput.addEventListener('change', () => void uploadFiles([...uploadInput.files], uploadTo))
    // files dropped on the list go into the folder they are dropped on (a file's row: its folder), else the document's top folder
    const dropping = ev => level === 'documents' && !!theDoc() && [...(ev.dataTransfer ? ev.dataTransfer.types : [])].includes('Files')
    listEl.addEventListener('dragover', ev => { if (!dropping(ev)) return; ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; listEl.classList.add('ms-drop') })
    listEl.addEventListener('dragleave', ev => { if (!listEl.contains(ev.relatedTarget)) listEl.classList.remove('ms-drop') })
    listEl.addEventListener('drop', ev => {
      if (!dropping(ev)) return
      ev.preventDefault()
      listEl.classList.remove('ms-drop')
      const row = ev.target instanceof Element ? ev.target.closest('[data-folder]') : null
      void uploadFiles([...ev.dataTransfer.files], row ? row.dataset.folder : '')
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

  root.RftManuscript = { CONTEXT, KINDS, MAX_UPLOAD, anchorOf, contentOf, byKind, stateOf, usedWords, usedCount, parseMarkers, outlineOf, valueWords, traceWords, fileOrder, treeRows, editable, typedPath, uploadProblem, crc32, zipOf, templateName, templateWords, writtenIn, slugOf, docNameProblem, errorText, mount }
})(typeof window !== 'undefined' ? window : globalThis)
