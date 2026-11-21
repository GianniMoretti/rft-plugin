// Slide decks (docs/design/presentations.md) as pure functions, one copy for the tree view's Slides
// tab and Calendar and for the plugin (hooks/lib/decks.ts loads it): a deck's frontmatter and its
// slides (split at a line `---` outside code, each with its options, its text and its speaker
// notes), the slide a line of the text is in, what the deck is for (a meeting's occurrence, a
// once-only meeting, a deadline) and when that is, what is wrong with it, the decks in the order the
// tab lists them, and a slide's HTML in its layout. The Markdown itself is web/markdown.js's, handed
// in. It sets `globalThis.RftSlides` and touches nothing else.
(function (root) {
  'use strict'

  /** A deck's id, and the folder the decks are in (hooks/lib/vault.ts and server/rft_decks.py have the same). */
  const DECK_RE = /^P(\d+)$/
  const DECKS = 'decks'
  /** The layouts a slide may take: `<!-- slide layout="two-cols" -->`. */
  const LAYOUTS = ['default', 'title', 'section', 'two-cols', 'figure']
  /** The slide's size, in the units it is laid out in: scaled to fit wherever it is shown. */
  const WIDTH = 1920
  const HEIGHT = 1080

  const SEP_RE = /^---\s*$/
  const FENCE_RE = /^\s*(```|~~~)/
  const OPTIONS_RE = /^\s*<!--\s*slide\b([\s\S]*?)-->\s*$/i
  const ATTR_RE = /([a-z][\w-]*)\s*=\s*"([^"]*)"/gi
  const NOTE_RE = /^note:\s?(.*)$/i
  const RIGHT_RE = /^::right::\s*$/
  const HEADING_RE = /^#{1,6}\s+\S/
  const IMAGE_LINE_RE = /^\s*(!\[\[[^\]\n]+\]\]|!\[[^\]\n]*\]\([^)\n]+\))\s*$/
  const MEETING_ID = /^G\d+$/
  const DEADLINE_ID = /^M\d+$/
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

  const unquote = v => (typeof v === 'string' ? v.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim() : v)
  const naturally = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true })

  /**
   * A deck's frontmatter: its fields as written (a value on the key's line, or a block list of
   * `- item` lines under it, as an array), and the line its body starts at (0-based). A text with
   * no frontmatter has none, and its body starts at 0.
   */
  function frontOf(text) {
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
    const fields = {}
    if (!SEP_RE.test(lines[0] || '')) return { fields, body: 0 }
    const end = lines.findIndex((l, i) => i > 0 && SEP_RE.test(l))
    if (end < 0) return { fields, body: 0 }
    let key = null
    for (const line of lines.slice(1, end)) {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
      if (kv) {
        key = kv[1]
        fields[key] = kv[2].trim() === '' ? [] : kv[2].trim()
        continue
      }
      const item = /^\s+-\s+(.*)$/.exec(line) || /^-\s+(.*)$/.exec(line)
      if (item && key && Array.isArray(fields[key])) fields[key].push(unquote(item[1]))
    }
    for (const k of Object.keys(fields)) if (Array.isArray(fields[k]) && !fields[k].length) fields[k] = ''
    return { fields, body: end + 1 }
  }

  /** The items of a list as written: `[G01 2026-11-24, M04]`, a block list, or one item alone. */
  function listItems(v) {
    if (Array.isArray(v)) return v.map(x => unquote(String(x))).filter(Boolean)
    if (typeof v !== 'string') return []
    const s = v.trim().replace(/^\[(.*)\]$/, '$1')
    return s.split(',').map(x => unquote(x)).filter(Boolean)
  }

  /** Whether a deck is locked: unless its frontmatter says `locked: false`, it is the user's to write. */
  const isLocked = fields => String(unquote((fields || {}).locked) ?? '').toLowerCase() !== 'false'

  /** A slide's options from its `<!-- slide … -->` line: `{layout, cls}`, a layout none of LAYOUTS left out. */
  function optionsOf(attrs) {
    const out = {}
    for (const m of String(attrs || '').matchAll(ATTR_RE)) out[m[1].toLowerCase()] = m[2]
    const layout = LAYOUTS.includes(out.layout) ? out.layout : ''
    const cls = (out.class || '').split(/\s+/).filter(c => /^[a-z][a-z0-9-]*$/i.test(c)).join(' ')
    return { layout, cls, badLayout: out.layout && !layout ? out.layout : '' }
  }

  /**
   * A deck's text as its frontmatter and slides. Each slide: `n` (from 1), `from` and `to` its
   * lines in the text (0-based, `to` excluded, its separator not in it), `layout` (as written, or
   * `title` for the first slide and `default` for the others), `cls`, `body` (its Markdown, the
   * options line and the notes left out), `bodyLine` (the line `body` starts at) and `notes`.
   */
  function split(text) {
    const src = String(text || '').replace(/\r\n/g, '\n')
    const lines = src.split('\n')
    const { fields, body } = frontOf(src)
    const ranges = []
    let from = body, fenced = false
    for (let i = body; i < lines.length; i++) {
      if (FENCE_RE.test(lines[i])) fenced = !fenced
      else if (!fenced && SEP_RE.test(lines[i])) { ranges.push([from, i]); from = i + 1 }
    }
    ranges.push([from, lines.length])
    const slides = ranges.map(([a, b], k) => {
      let i = a
      while (i < b && !lines[i].trim()) i++
      const opt = i < b ? OPTIONS_RE.exec(lines[i]) : null
      const o = optionsOf(opt ? opt[1] : '')
      const start = opt ? i + 1 : a
      let noteAt = -1, inCode = false
      for (let j = start; j < b; j++) {
        if (FENCE_RE.test(lines[j])) inCode = !inCode
        else if (!inCode && NOTE_RE.test(lines[j])) { noteAt = j; break }
      }
      const end = noteAt < 0 ? b : noteAt
      const notes = noteAt < 0 ? '' : [NOTE_RE.exec(lines[noteAt])[1], ...lines.slice(noteAt + 1, b)].join('\n').trim()
      let first = start
      while (first < end && !lines[first].trim()) first++
      return {
        n: k + 1, from: a, to: b, layout: o.layout || (k === 0 ? 'title' : 'default'), cls: o.cls, badLayout: o.badLayout,
        body: lines.slice(first, end).join('\n').replace(/\s+$/, ''), bodyLine: first, notes,
      }
    })
    return { fields, body, slides }
  }

  /** The index of the slide that line `line` (0-based) of the text is in: the frontmatter's is the first slide. */
  function slideAt(slides, line) {
    let k = 0
    for (let i = 0; i < slides.length; i++) if (line >= slides[i].from) k = i
    return k
  }

  /**
   * What a deck is for, one item each, as written: `{raw, id, day}`, `day` the occurrence's day by
   * its meeting's rule (`G01 2026-11-24`), or '' (a once-only meeting, a deadline).
   */
  function forItems(v) {
    return listItems(v).map(raw => {
      const [id, day = '', ...rest] = raw.split(/\s+/)
      return { raw, id, day: rest.length ? `${day} ${rest.join(' ')}` : day }
    })
  }

  /**
   * Each item a deck is for, resolved against the meetings and deadlines (S: web/schedule.js):
   * `{raw, kind, id, name, day, orig, at, moved, skipped, problem}`. `day` is when it is presented
   * (a moved occurrence's new day), `orig` the day its rule gives, `at` its time as the calendar
   * has it (a deadline's due). `problem` says what is wrong, in words, or is ''.
   */
  function attach(fields, meetings, milestones, S) {
    return forItems((fields || {}).for).map(item => {
      const out = { raw: item.raw, kind: '', id: item.id, name: item.id, day: '', orig: '', at: null, moved: false, skipped: false, problem: '' }
      if (MEETING_ID.test(item.id)) {
        out.kind = 'meeting'
        const m = (meetings || []).find(x => x.id === item.id)
        if (!m) return { ...out, problem: `${item.raw}: there is no meeting ${item.id}` }
        out.name = m.name
        const mt = S.meetingOf(m)
        if (!mt) return { ...out, problem: `${item.raw}: ${m.name} has no when:` }
        const recurring = Boolean(m.every)
        if (!item.day) {
          if (recurring) return { ...out, problem: `${item.raw}: ${m.name} comes back ${S.repeatText(m)}: name the occurrence, as ${item.id} ${mt.start.day}` }
          return { ...out, day: mt.start.day, orig: mt.start.day, at: mt.start }
        }
        if (!DAY_RE.test(item.day) || !S.isDay(item.day)) return { ...out, problem: `${item.raw}: ${item.day} is no day (YYYY-MM-DD)` }
        out.orig = item.day
        if (!S.isOccurrence(mt, item.day)) return { ...out, day: item.day, problem: `${item.raw}: ${m.name} does not fall on ${item.day}` }
        if (mt.skip.has(item.day)) return { ...out, day: item.day, skipped: true, problem: `${item.raw}: that occurrence of ${m.name} is skipped, so the deck is presented nowhere` }
        const dest = mt.moved.get(item.day)
        if (dest) return { ...out, day: dest.day, at: dest, moved: true }
        return { ...out, day: item.day, at: { ...mt.start, day: item.day } }
      }
      if (DEADLINE_ID.test(item.id)) {
        out.kind = 'deadline'
        const d = (milestones || []).find(x => x.id === item.id)
        if (!d) return { ...out, problem: `${item.raw}: there is no deadline ${item.id}` }
        out.name = d.name
        const due = S.parseDue(d.due)
        if (!due) return { ...out, problem: `${item.raw}: ${d.name} has no due day` }
        if (item.day) return { ...out, day: due.day, orig: due.day, at: due, problem: `${item.raw}: a deadline is named by its id alone (${item.id})` }
        return { ...out, day: due.day, orig: due.day, at: due }
      }
      return { ...out, problem: `${item.raw}: a deck is for a meeting (G01 2026-11-24, or G04 for a once-only one) or a deadline (M04)` }
    })
  }

  /** What is wrong with a deck, in lines: what it is for, and its slides' layouts. */
  function problems(deck, meetings, milestones, S) {
    const out = []
    const { fields, slides } = split(deck.text)
    for (const a of attach(fields, meetings, milestones, S)) if (a.problem) out.push(a.problem)
    for (const s of slides) if (s.badLayout) out.push(`slide ${s.n}: no layout ${s.badLayout} (${LAYOUTS.join(', ')})`)
    return out
  }

  /** The `for:` item of a meeting's occurrence (its day by the rule), or of a once-only meeting or a deadline. */
  const forItem = (id, orig) => (orig ? `${id} ${orig}` : id)

  /** The decks a meeting's occurrence (`orig`, the rule's day) or a deadline is shown with: their ids. */
  function decksFor(decks, id, orig, meetings, milestones, S) {
    return (decks || []).filter(d => attach(d.fields || split(d.text).fields, meetings, milestones, S)
      .some(a => a.id === id && !a.problem && (a.kind === 'deadline' || !orig || a.orig === orig))).map(d => d.id)
  }

  /**
   * The decks as the tab lists them: `upcoming` (the next thing each is for from `today` on, soonest
   * first), `none` (for nothing that resolves), `past` (the latest thing each was for, latest
   * first). Each entry `{deck, when}`, `when` the attachment that places it (null in `none`).
   */
  function groups(decks, meetings, milestones, today, S) {
    const upcoming = [], none = [], past = []
    for (const deck of decks || []) {
      const as = attach(deck.fields || split(deck.text).fields, meetings, milestones, S).filter(a => !a.problem && a.day)
      const ahead = as.filter(a => a.day >= today).sort((a, b) => a.day.localeCompare(b.day))
      const before = as.filter(a => a.day < today).sort((a, b) => b.day.localeCompare(a.day))
      if (ahead.length) upcoming.push({ deck, when: ahead[0] })
      else if (before.length) past.push({ deck, when: before[0] })
      else none.push({ deck, when: null })
    }
    const at = w => `${w.day} ${(w.at && w.at.time) || ''}`
    upcoming.sort((a, b) => at(a.when).localeCompare(at(b.when)) || naturally(a.deck.id, b.deck.id))
    past.sort((a, b) => at(b.when).localeCompare(at(a.when)) || naturally(a.deck.id, b.deck.id))
    none.sort((a, b) => naturally(b.deck.id, a.deck.id))
    return { upcoming, none, past }
  }

  const escAttr = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  /** The lines of `body` before and after a line `::right::` outside code, or null when there is none. */
  function columns(body) {
    const lines = body.split('\n')
    let fenced = false
    for (let i = 0; i < lines.length; i++) {
      if (FENCE_RE.test(lines[i])) fenced = !fenced
      else if (!fenced && RIGHT_RE.test(lines[i])) return [lines.slice(0, i).join('\n'), lines.slice(i + 1).join('\n')]
    }
    return null
  }

  /** The body's leading heading line, and the rest: a layout that spans its heading over its parts. */
  function headOf(body) {
    const lines = body.split('\n')
    let i = 0
    while (i < lines.length && !lines[i].trim()) i++
    return i < lines.length && HEADING_RE.test(lines[i]) ? [lines[i], lines.slice(i + 1).join('\n')] : ['', body]
  }

  /**
   * A slide's HTML in its layout, `md(src)` giving a piece of Markdown's HTML: a box of the
   * slide's size (WIDTH × HEIGHT), which the page scales to fit.
   */
  function slideHtml(slide, md) {
    const cls = `slide layout-${slide.layout}${slide.cls ? ` ${slide.cls}` : ''}`
    const part = (name, src) => (src.trim() ? `<div class="${name}">${md(src)}</div>` : '')
    let inner
    if (slide.layout === 'two-cols') {
      const cols = columns(slide.body)
      const [head, rest] = headOf(cols ? cols[0] : slide.body)
      const [left, right] = cols ? [rest, cols[1]] : [rest, '']
      inner = part('slide-head', head) + `<div class="slide-cols">${part('slide-col', left) || '<div class="slide-col"></div>'}${part('slide-col', right) || '<div class="slide-col"></div>'}</div>`
    } else if (slide.layout === 'figure') {
      const [head, rest] = headOf(slide.body)
      const lines = rest.split('\n')
      const k = lines.findIndex(l => IMAGE_LINE_RE.test(l))
      const figure = k < 0 ? '' : lines[k]
      const caption = k < 0 ? rest : [...lines.slice(0, k), ...lines.slice(k + 1)].join('\n')
      inner = part('slide-head', head) + (figure ? part('slide-figure', figure) : '') + part('slide-caption', caption)
    } else inner = part('slide-content', slide.body)
    return `<div class="${escAttr(cls)}" data-slide="${slide.n}">${inner}</div>`
  }

  root.RftSlides = {
    DECK_RE, DECKS, LAYOUTS, WIDTH, HEIGHT,
    frontOf, listItems, isLocked, optionsOf, split, slideAt, forItems, forItem, attach, problems, decksFor, groups, slideHtml,
  }
})(typeof globalThis !== 'undefined' ? globalThis : window)
