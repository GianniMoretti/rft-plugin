// A note's markdown as the tree view shows it (the subset notes use, read as Obsidian reads it),
// and where each part of the page comes from in the note. Every run of text is wrapped in
// <span class="src" data-s data-e>, its offsets in the source; what may not be split (code, a
// formula, an image, an embed, a footnote mark) is marked data-atom. `cells` says which source
// characters each visible character of one run stands for, so a selection in the page becomes a
// range of the note's text (a comment's quote, where a footnote goes), and a range of the text
// a highlight. Footnotes: a mark [^label] with a definition line `[^label]: text` (indented lines
// continue it), or inline ^[text]; their texts come back beside the HTML, for the page to show in
// the margin. Pure: loaded by the page before app.js, and by the plugin's tests; it sets
// `globalThis.RftMarkdown` and touches nothing else.
(function (root) {
  'use strict'

  const escH = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  // what the other inline rules must not touch: `code` first, as it binds tightest (a $ in it
  // stays a $), then images, inline footnotes (whose text may hold math), as Obsidian reads them
  // \$ (a dollar), $$display math$$ and $inline math$, whose dollars have no space just inside
  // them and no digit just after ("$5 and $10" is text), and footnote marks outside math
  const CODE = /`([^`]+)`/g
  const MATH = /\\\$|\$\$([^\u0000]+?)\$\$|\$(?=[^\s$])((?:\\[^\u0000]|[^\\$\u0000])+?)(?<!\s)\$(?!\d)/g
  // images as Obsidian embeds them: ![[name.png]], ![[name.png|400]] (a width, or 400x300) and
  // ![alt](path.png), ![alt|400](<a path with spaces.png>); the page finds the file. In a
  // table the | is written \|
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i
  const WIKI_IMAGE = /!\[\[([^\]\n]+)\]\]/g
  const MD_IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g
  const FN_INLINE = /\^\[((?:[^[\]\u0000]|\[\[[^\]\u0000]*\]\])+)\]/g
  const FN_REF = /\[\^([^\]\s\u0000]+)\]/g
  const FN_DEF = /^\[\^([^\]\s]+)\]:[ \t]?(.*)$/
  // and the rules of the text around them
  const EMBED = /!\[\[([^\]]+)\]\]/g
  const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g
  const BOLD = /\*\*([^*]+)\*\*/g
  const ITALIC = /(^|[^*])\*([^*\s][^*]*)\*/g
  const LINK = /\[([^\]]+)\]\((https?:[^)\s]+)\)/g

  const sizeOf = o => /^\s*(\d+)(?:x(\d+))?\s*$/.exec(o)
  const isImageEmbed = inner => IMAGE_EXT.test(inner.split(/\\?\|/)[0].trim())
  const atomHtml = html => `<span class="atom" data-atom>${html}</span>`

  /**
   * A renderer for the page: `tex(src, display)` gives a formula's HTML, `image(src, alt, size)` a
   * local image's (size: [_, width, height?] or undefined), `link(target)` the id a wikilink
   * leads to, or null.
   */
  function make(o) {
    let notes = { count: 0, byLabel: new Map() } // the footnotes of the note being rendered

    /** `![[inner]]` as an image, or null when it embeds something else (a note, a PDF). */
    function wikiImage(inner) {
      const [target, ...opts] = inner.split(/\\?\|/)
      if (!IMAGE_EXT.test(target.trim())) return null
      const alt = opts.find(x => !sizeOf(x))
      return o.image(target.trim(), alt ? alt.trim() : '', opts.map(sizeOf).find(Boolean))
    }
    /** `![alt](src)`: a local image, a link to a remote one (the page fetches nothing from elsewhere). */
    function mdImage(alt, src) {
      const [text, ...opts] = alt.split(/\\?\|/)
      src = src.replace(/^<(.*)>$/, '$1')
      if (/^https?:/i.test(src)) return `<a href="${escH(src)}" target="_blank" rel="noopener noreferrer">(image: ${escH(text.trim() || src)})</a>`
      let path = src
      try { path = decodeURIComponent(src) } catch (e) { /* a % of its own */ }
      if (!IMAGE_EXT.test(path)) return `<em>(embedded: ${escH(text.trim() || path)})</em>`
      return o.image(path, text.trim(), opts.map(sizeOf).find(Boolean))
    }
    /** A footnote's mark: numbered in the order the marks come, as Obsidian numbers them. */
    function mark(label, html) {
      let f = label != null ? notes.byLabel.get(label) : null
      if (!f) {
        f = { label: label != null ? label : `^${notes.count + 1}`, n: ++notes.count, html: html != null ? html : null }
        notes.byLabel.set(f.label, f)
      }
      return `<sup class="fn-ref" data-fn="${escH(f.label)}" data-atom>${f.n}</sup>`
    }

    function inline(t) {
      const held = []
      const hold = html => `\u0000${held.push(html) - 1}\u0000`
      t = t.replace(CODE, (m, code) => hold(`<code data-atom>${escH(code)}</code>`))
        .replace(WIKI_IMAGE, (m, inner) => { const html = wikiImage(inner); return html == null ? m : hold(atomHtml(html)) })
        .replace(MD_IMAGE, (m, alt, src) => hold(atomHtml(mdImage(alt, src))))
        .replace(FN_INLINE, (m, text) => hold(mark(null, inline(text))))
        .replace(MATH, (m, display, math) => hold(display != null ? atomHtml(o.tex(display, true)) : math != null ? atomHtml(o.tex(math, false)) : '$'))
        .replace(FN_REF, (m, label) => hold(mark(label)))
      return escH(t)
        .replace(EMBED, '<em data-atom>(embedded: $1)</em>')
        .replace(WIKILINK, (m, target, alias) => {
          const id = o.link(target.replace(/&amp;/g, '&'))
          const label = alias || target
          return id ? `<a data-go="${id}">${label}</a>` : `<span class="missing">${label}</span>`
        })
        .replace(BOLD, '<strong>$1</strong>')
        .replace(ITALIC, '$1<em>$2</em>')
        .replace(LINK, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(/\u0000(\d+)\u0000/g, (m, i) => held[i])
    }

    /** The note's body as { html, notes }: the footnotes by number, { label, n, html }. */
    function render(src) {
      notes = { count: 0, byLabel: new Map() }
      const out = []
      let list = 0, inCode = false, table = false
      let para = [] // the lines of a paragraph: { text, s }
      let math = null // a $$ block opened on a line of its own, until its closing $$: { lines, s }
      let def = null // the footnote definition read, while indented lines continue it
      const defs = new Map()
      const run = (text, s) => `<span class="src" data-s="${s}" data-e="${s + text.length}">${inline(text)}</span>`
      // a line ending in two spaces breaks the line, as in Obsidian
      const flush = () => {
        if (para.length) out.push(`<p>${para.map((l, i) => run(l.text.replace(/\s+$/, ''), l.s) + (i < para.length - 1 ? (/ {2}$/.test(l.text) ? '<br>' : ' ') : '')).join('')}</p>`)
        para = []
      }
      const close = () => { flush(); while (list > 0) { out.push('</ul>'); list-- } if (table) { out.push('</table>'); table = false } }
      const mathBlock = (lines, s, e) => `<div class="math-block src" data-s="${s}" data-e="${e}" data-whole>${o.tex(lines.join('\n'), true)}</div>`
      let at = 0
      for (const raw of src.split('\n')) {
        const s0 = at
        at += raw.length + 1
        if (def) {
          if (/^(\t| {2,})\S/.test(raw)) { def.lines.push(raw.trim()); continue }
          def = null
        }
        if (math) {
          const end = raw.indexOf('$$')
          if (end < 0) { math.lines.push(raw); continue }
          out.push(mathBlock([...math.lines, raw.slice(0, end)], math.s, s0 + end + 2))
          math = null
          if (raw.slice(end + 2).trim()) para.push({ text: raw.slice(end + 2), s: s0 + end + 2 })
          continue
        }
        if (!inCode && /^\s*\$\$/.test(raw) && !raw.trim().slice(2).includes('$$')) {
          close()
          math = { lines: [raw.trim().slice(2)], s: s0 + raw.indexOf('$$') }
          continue
        }
        if (raw.startsWith('```')) { close(); out.push(inCode ? '</pre>' : '<pre>'); inCode = !inCode; continue }
        if (inCode) { out.push(`<span class="src" data-s="${s0}" data-e="${s0 + raw.length}" data-raw>${escH(raw)}</span>`); continue }
        const fd = FN_DEF.exec(raw)
        if (fd) {
          close()
          def = { label: fd[1], lines: [fd[2]] }
          if (!defs.has(fd[1])) defs.set(fd[1], def)
          continue
        }
        const h = /^(#{1,6})\s+(.*)$/.exec(raw)
        const li = /^(\s*)[-*]\s+(.*)$/.exec(raw)
        if (h) { close(); const l = Math.min(h[1].length, 2); out.push(`<h${l}>${run(h[2], s0 + raw.length - h[2].length)}</h${l}>`) }
        else if (li) {
          flush()
          if (table) { out.push('</table>'); table = false }
          const depth = Math.floor(li[1].replace(/\t/g, '    ').length / 2) + 1
          while (list < depth) { out.push('<ul>'); list++ }
          while (list > depth) { out.push('</ul>'); list-- }
          out.push(`<li>${run(li[2], s0 + raw.length - li[2].length)}</li>`)
        } else if (/^\|.*\|\s*$/.test(raw)) {
          if (/^\|[\s:|-]+\|\s*$/.test(raw)) continue
          if (!table) { close(); out.push('<table>'); table = true }
          let pos = s0 + (raw.length - raw.trimStart().length) + 1
          const tds = raw.trim().slice(1, -1).split(/(?<!\\)\|/).map(c => {
            const s = pos + (c.length - c.trimStart().length)
            pos += c.length + 1
            return `<td>${run(c.trim(), s)}</td>`
          })
          out.push('<tr>' + tds.join('') + '</tr>')
        } else if (raw.trim() === '') close()
        else if (list && /^\s+\S/.test(raw) && out[out.length - 1].endsWith('</li>')) {
          // an indented line continues the list item above
          out[out.length - 1] = out[out.length - 1].slice(0, -5) + ' ' + run(raw.trim(), s0 + raw.length - raw.trimStart().length) + '</li>'
        } else { if (list || table) close(); para.push({ text: raw, s: s0 }) }
      }
      close()
      if (inCode) out.push('</pre>')
      if (math) out.push(mathBlock(math.lines, math.s, src.length))
      // the footnotes' texts, once every mark is numbered (a definition may hold a mark of its own)
      const orphans = []
      for (const [label, d] of defs) {
        const f = notes.byLabel.get(label)
        const html = d.lines.map(inline).join('<br>')
        if (f) f.html = html
        else orphans.push(`<p><sup class="fn-label">${escH(label)}</sup> ${html}</p>`)
      }
      for (const f of notes.byLabel.values()) {
        if (f.html == null) f.html = `<em class="missing">No text for [^${escH(f.label)}]: add a line [^${escH(f.label)}]: … to the note.</em>`
      }
      // a definition no mark points at still shows, at the end
      if (orphans.length) out.push(`<div class="fn-orphans">${orphans.join('')}</div>`)
      return { html: out.join('\n'), notes: [...notes.byLabel.values()].sort((a, b) => a.n - b.n) }
    }

    return { inline, render }
  }

  // ---------------------------------------------------------------- source positions

  /**
   * The visible characters of `inline(t)`, in order, each as { ch, s, e }: the source range
   * [s, e) of `t` it stands for, and [ts, te) when it belongs to a token a range may not split
   * (a link's label: its brackets and target go with it). Each atom of the HTML (data-atom) is
   * one cell, ch "\u0000". It follows inline()'s rules in inline()'s order.
   */
  function cells(t) {
    let cs = Array.from({ length: t.length }, (_, i) => ({ ch: t[i], s: i, e: i + 1 }))
    const pass = (re, become) => {
      const text = cs.map(c => (c.atom ? '\u0000' : c.ch)).join('')
      const out = []
      let last = 0
      for (const m of text.matchAll(new RegExp(re.source, re.flags + 'd'))) {
        const s = cs[m.index].s, e = cs[m.index + m[0].length - 1].e
        const group = g => (m.indices[g] ? cs.slice(m.indices[g][0], m.indices[g][1]) : [])
        const made = become(m, { s, e, group })
        if (made == null) continue // left as it is
        out.push(...cs.slice(last, m.index), ...made)
        last = m.index + m[0].length
      }
      out.push(...cs.slice(last))
      cs = out
    }
    const atom = (m, r) => [{ ch: '\u0000', atom: true, s: r.s, e: r.e, ts: r.s, te: r.e }]
    const label = (r, list) => list.map(c => ({ ...c, ts: Math.min(r.s, c.ts != null ? c.ts : r.s), te: Math.max(r.e, c.te != null ? c.te : r.e) }))
    pass(CODE, atom)
    pass(WIKI_IMAGE, (m, r) => (isImageEmbed(m[1]) ? atom(m, r) : null))
    pass(MD_IMAGE, atom)
    pass(FN_INLINE, atom)
    pass(MATH, (m, r) => (m[0] === '\\$' ? [{ ch: '$', s: r.s, e: r.e, ts: r.s, te: r.e }] : atom(m, r)))
    pass(FN_REF, atom)
    pass(EMBED, atom)
    pass(WIKILINK, (m, r) => label(r, r.group(m[2] != null ? 2 : 1)))
    pass(BOLD, (m, r) => r.group(1))
    pass(ITALIC, (m, r) => [...r.group(1), ...r.group(2)])
    pass(LINK, (m, r) => label(r, r.group(1)))
    return cs
  }

  /** The cells of a source run as the page marks it: a code line as it is, a formula block as one atom. */
  function runCells(text, kind) {
    if (kind === 'raw') return Array.from({ length: text.length }, (_, i) => ({ ch: text[i], s: i, e: i + 1 }))
    if (kind === 'whole') return [{ ch: '\u0000', atom: true, s: 0, e: text.length, ts: 0, te: text.length }]
    return cells(text)
  }

  /**
   * The source offset, within the run, of a boundary between visible characters: `vis` cells come
   * before it. A start takes the whole token it falls in, and so does an end.
   */
  function sourceAt(cs, vis, isEnd, length) {
    if (isEnd) {
      if (vis <= 0) return 0
      const c = cs[Math.min(vis, cs.length) - 1]
      return c.te != null ? c.te : c.e
    }
    if (vis >= cs.length) return length
    const c = cs[Math.max(vis, 0)]
    return c.ts != null ? c.ts : c.s
  }

  /** The visible cells [from, to) of a run that cover any of the source range [s, e) (run offsets). */
  function cellsIn(cs, s, e) {
    let from = -1, to = -1
    cs.forEach((c, i) => {
      if (c.s < e && c.e > s) { if (from < 0) from = i; to = i + 1 }
    })
    return from < 0 ? null : [from, to]
  }

  /** The highest numeric footnote label in a note's text, so a new one takes the next. */
  function lastFootnote(src) {
    let n = 0
    for (const m of src.matchAll(/\[\^(\d+)\]/g)) n = Math.max(n, Number(m[1]))
    return n
  }

  /**
   * The note's text with a footnote at `at` (a source offset): the mark there, and its definition
   * at the end, after the other definitions when the note ends with them.
   */
  function withFootnote(src, at, text) {
    const label = String(lastFootnote(src) + 1)
    const lines = text.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    const def = `[^${label}]: ${lines.join('\n    ')}`
    let head = src.slice(0, at) + `[^${label}]` + src.slice(at)
    const trimmed = head.replace(/\s+$/, '')
    const endsWithDefs = /(^|\n)\[\^[^\]\s]+\]:[^\n]*(\n(\t| {2,})\S[^\n]*)*$/.test(trimmed)
    head = `${trimmed}${endsWithDefs ? '\n' : '\n\n'}${def}\n`
    return { text: head, label }
  }

  root.RftMarkdown = { make, cells, runCells, sourceAt, cellsIn, escH, lastFootnote, withFootnote }
})(typeof globalThis !== 'undefined' ? globalThis : window)
