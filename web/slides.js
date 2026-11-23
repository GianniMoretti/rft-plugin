// Slide decks (docs/design/presentations.md) as pure functions, one copy for the tree view's Slides
// tab and Calendar and for the plugin (hooks/lib/decks.ts loads it): a deck's frontmatter and its
// slides (split at a line `---` outside code, each with its options, its text, the boxes and lines
// placed on it and its speaker notes), the slide a line of the text is in, what the deck is for (a
// meeting's occurrence, a once-only meeting, a deadline) and when that is, what is wrong with it,
// the decks in the order the tab lists them, and a slide's HTML in its layout with its boxes and
// lines over it. The Markdown itself is web/markdown.js's, handed in. It sets
// `globalThis.RftSlides` and touches nothing else.
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
  // a box and a line, placed on the slide: `<!-- box x="…" y="…" w="…" -->` to `<!-- /box -->`, `<!-- line from="…" to="…" -->`
  const BOX_RE = /^\s*<!--\s*box\b([\s\S]*?)-->\s*$/i
  const BOX_END_RE = /^\s*<!--\s*\/box\s*-->\s*$/i
  const LINE_RE = /^\s*<!--\s*line\b([\s\S]*?)-->\s*$/i
  const WHOLE_RE = /^-?\d+$/
  const HEX_RE = /^#[0-9a-f]{6}$/i
  /** The colours a box or a line may name: the project's figure tokens (server/rft_style.py), its categorical ones as c1 to c6. */
  const COLORS = ['text', 'muted', 'accent', 'contrast', 'baseline', 'neutral', 'axis', 'grid', 'fill', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6']
  const COLORS_TEXT = 'a token\'s name (text, muted, accent, contrast, baseline, neutral, axis, grid, fill, c1 to c6) or #rrggbb'
  /** An outline's weights, in the slide's units. */
  const WEIGHTS = { thin: 2, medium: 4, thick: 8 }
  const BOX_OPTIONS = ['x', 'y', 'w', 'h', 'shape', 'fill', 'outline', 'weight', 'color', 'size', 'align', 'valign']
  const LINE_OPTIONS = ['from', 'to', 'arrow', 'outline', 'weight']
  const CHOICES = {
    shape: ['rect', 'ellipse'], weight: Object.keys(WEIGHTS), align: ['left', 'center', 'right'], valign: ['top', 'middle', 'bottom'], arrow: ['start', 'end', 'both'],
  }
  /** A box with no width that can be read is this wide. */
  const BOX_W = 480
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
   * The options of a box's or a line's comment as written (`names` those it may have), with what
   * is wrong with them said to `say`: text that is no `name="value"`, an option it has none of.
   * A name written twice keeps its last value.
   */
  function optionsAs(attrs, names, what, say) {
    const out = {}
    const rest = String(attrs || '').replace(ATTR_RE, (_, k, v) => { out[k.toLowerCase()] = v.trim(); return ' ' }).trim().replace(/\s+/g, ' ')
    if (rest) say(`"${rest}" is not read: an option is written name="value"`)
    for (const k of Object.keys(out)) {
      if (names.includes(k)) continue
      say(`${what} has no option "${k}" (${names.join(', ')})`)
      delete out[k]
    }
    return out
  }

  /** A whole number an option gives (`above`: above 0), or null when it gives none or one that is none, which is said. */
  function wholeOf(o, k, say, above = false) {
    if (!(k in o)) return null
    if (WHOLE_RE.test(o[k]) && (!above || Number(o[k]) > 0)) return Number(o[k])
    say(`${k}="${o[k]}" is no whole number${above ? ' above 0' : ''}`)
    return null
  }

  /** One of an option's values, or '' when it gives none or one it cannot take, which is said. */
  function choiceOf(o, k, say) {
    if (!(k in o)) return ''
    const v = o[k].toLowerCase()
    if (CHOICES[k].includes(v)) return v
    say(`${k}="${o[k]}" is none of ${CHOICES[k].join(', ')}`)
    return ''
  }

  /** A colour an option gives: a token's name, `#rrggbb`, '' when it gives none, the text's colour for one there is none of, which is said. */
  function colorOf(o, k, say) {
    if (!(k in o)) return ''
    if (HEX_RE.test(o[k])) return o[k]
    if (COLORS.includes(o[k].toLowerCase())) return o[k].toLowerCase()
    say(`no colour "${o[k]}": ${COLORS_TEXT}`)
    return 'currentColor'
  }

  /** A point an option gives, `"1180 660"`, as `[x, y]`, or null. */
  function pointOf(o, k, say) {
    if (!(k in o)) return null
    const p = o[k].split(/\s+/)
    if (p.length === 2 && p.every(v => WHOLE_RE.test(v))) return p.map(Number)
    say(`${k}="${o[k]}" is no point: two whole numbers, as "1180 660"`)
    return null
  }

  /** What an option list is missing of `needs`, said. */
  function needs(o, names, what, say) {
    const missing = names.filter(k => !(k in o))
    if (missing.length) say(`${what} needs ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}: no ${missing.join(', ')}`)
  }

  /**
   * A box from its opening comment's options, lines `from` to `to` of the text (`to` excluded, its
   * closing comment in it when it is `closed`) and its Markdown. One that cannot be read in part
   * is still a box: at the slide's corner, BOX_W wide, as high as its text, in the layout's style.
   */
  function boxOf(attrs, from, to, closed, content, say) {
    const o = optionsAs(attrs, BOX_OPTIONS, 'a box', say)
    needs(o, ['x', 'y', 'w'], 'a box', say)
    const x = wholeOf(o, 'x', say), y = wholeOf(o, 'y', say), w = wholeOf(o, 'w', say, true), h = wholeOf(o, 'h', say, true)
    const shape = choiceOf(o, 'shape', say), fill = colorOf(o, 'fill', say), outline = colorOf(o, 'outline', say), weight = choiceOf(o, 'weight', say)
    const color = colorOf(o, 'color', say), size = wholeOf(o, 'size', say, true), align = choiceOf(o, 'align', say), valign = choiceOf(o, 'valign', say)
    if (!closed) say('this box is not closed: add <!-- /box --> after its text')
    return { kind: 'box', from, to, closed, x: x ?? 0, y: y ?? 0, w: w ?? BOX_W, h, shape: shape || 'rect', fill, outline, color, weight, size, align, valign, content }
  }

  /** A line from its comment's options, at line `at` of the text: its two ends (null when they cannot be read), its arrow, colour and weight. */
  function lineOf(attrs, at, say) {
    const o = optionsAs(attrs, LINE_OPTIONS, 'a line', say)
    needs(o, ['from', 'to'], 'a line', say)
    const a = pointOf(o, 'from', say), b = pointOf(o, 'to', say)
    const arrow = choiceOf(o, 'arrow', say), outline = colorOf(o, 'outline', say), weight = choiceOf(o, 'weight', say)
    return { kind: 'line', from: at, to: at + 1, x1: a ? a[0] : null, y1: a ? a[1] : null, x2: b ? b[0] : null, y2: b ? b[1] : null, arrow, outline, weight }
  }

  /**
   * Where the box opened on the line before `from` ends, in lines `from` to `to` of a slide: at
   * its `<!-- /box -->` outside code (`closed`), else at the next box, at the speaker's notes or at
   * the slide's end, whichever comes first.
   */
  function boxEnd(lines, from, to) {
    let fenced = false, note = -1
    for (let i = from; i < to; i++) {
      if (FENCE_RE.test(lines[i])) fenced = !fenced
      else if (fenced) continue
      else if (BOX_END_RE.test(lines[i])) return { at: i, closed: true }
      else if (BOX_RE.test(lines[i])) return { at: note < 0 ? i : note, closed: false }
      else if (note < 0 && NOTE_RE.test(lines[i])) note = i
    }
    return { at: note < 0 ? to : note, closed: false }
  }

  /**
   * A slide's lines `from` to `to` of the text, its options line left out, read: `kept` (the lines
   * of the layout's content, a blank one where a box or a line was, as its comment breaks a
   * paragraph), `items` (its boxes and lines in the order written), `problems` (`{line, text}`)
   * and `noteAt` (the line its speaker's notes start at, or -1).
   */
  function readSlide(lines, from, to) {
    const kept = [], items = [], problems = []
    const sayAt = line => text => problems.push({ line, text })
    let fenced = false, noteAt = -1
    for (let i = from; i < to; i++) {
      const line = lines[i]
      let m
      if (FENCE_RE.test(line)) { fenced = !fenced; kept.push(line) }
      else if (fenced) kept.push(line)
      else if (NOTE_RE.test(line)) { noteAt = i; break }
      else if ((m = BOX_RE.exec(line))) {
        const end = boxEnd(lines, i + 1, to)
        const content = lines.slice(i + 1, end.at).join('\n').replace(/^(\s*\n)+/, '').replace(/\s+$/, '')
        items.push(boxOf(m[1], i, end.closed ? end.at + 1 : end.at, end.closed, content, sayAt(i)))
        kept.push('')
        i = end.closed ? end.at : end.at - 1
      } else if (BOX_END_RE.test(line)) { sayAt(i)('this <!-- /box --> closes no box'); kept.push('') }
      else if ((m = LINE_RE.exec(line))) { items.push(lineOf(m[1], i, sayAt(i))); kept.push('') }
      else kept.push(line)
    }
    return { kept, items, problems, noteAt }
  }

  /**
   * A deck's text as its frontmatter and slides. Each slide: `n` (from 1), `from` and `to` its
   * lines in the text (0-based, `to` excluded, its separator not in it), `layout` (as written, or
   * `title` for the first slide and `default` for the others), `cls`, `body` (its Markdown, the
   * options line, the boxes, the lines and the notes left out), `bodyLine` (the line its text
   * starts at), `notes`, `items` (its boxes and lines, the later in the text in front) and
   * `problems` (what is wrong with them, `{line, text}`).
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
      const { kept, items, problems, noteAt } = readSlide(lines, start, b)
      const end = noteAt < 0 ? b : noteAt
      const notes = noteAt < 0 ? '' : [NOTE_RE.exec(lines[noteAt])[1], ...lines.slice(noteAt + 1, b)].join('\n').trim()
      let first = start
      while (first < end && !lines[first].trim()) first++
      return {
        n: k + 1, from: a, to: b, layout: o.layout || (k === 0 ? 'title' : 'default'), cls: o.cls, badLayout: o.badLayout,
        body: kept.join('\n').replace(/^(\s*\n)+/, '').replace(/\s+$/, ''), bodyLine: first, notes, items, problems,
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

  /** What is wrong with a deck, in lines: what it is for, its slides' layouts, their boxes and lines (by the line of the text, from 1). */
  function problems(deck, meetings, milestones, S) {
    const out = []
    const { fields, slides } = split(deck.text)
    for (const a of attach(fields, meetings, milestones, S)) if (a.problem) out.push(a.problem)
    for (const s of slides) {
      if (s.badLayout) out.push(`slide ${s.n}: no layout ${s.badLayout} (${LAYOUTS.join(', ')})`)
      for (const p of s.problems) out.push(`slide ${s.n}, line ${p.line + 1}: ${p.text}`)
    }
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

  /** A colour as CSS: `#rrggbb` as it is, a token by the slide's own name for it (app.css, `--slide-c-…`). */
  const cssColor = c => (COLORS.includes(c) ? `var(--slide-c-${c})` : c)
  const tenth = v => Math.round(v * 10) / 10

  /**
   * A box's HTML: at its place on the slide, its fill and outline around its Markdown (none for a
   * plain shape). A figure or an image alone in it fills it (`figure`); a box with a height keeps
   * it whatever its text (`fixed`).
   */
  function boxHtml(b, k, md) {
    const lines = b.content.split('\n').filter(l => l.trim())
    const cls = ['slide-box', b.shape === 'ellipse' ? 'ellipse' : '', b.h ? 'fixed' : '', lines.length === 1 && IMAGE_LINE_RE.test(lines[0]) ? 'figure' : '',
      b.valign && b.valign !== 'top' ? `valign-${b.valign}` : ''].filter(Boolean).join(' ')
    const style = [
      `left:${b.x}px`, `top:${b.y}px`, `width:${b.w}px`, b.h ? `height:${b.h}px` : '',
      b.fill ? `background:${cssColor(b.fill)}` : '', b.outline ? `border:${WEIGHTS[b.weight || 'medium']}px solid ${cssColor(b.outline)}` : '',
      b.color ? `color:${cssColor(b.color)}` : '', b.size ? `font-size:${b.size}px` : '', b.align ? `text-align:${b.align}` : '',
    ].filter(Boolean).join(';')
    return `<div class="${cls}" data-item="${k}" style="${style}">${lines.length ? `<div class="slide-box-text">${md(b.content)}</div>` : ''}</div>`
  }

  /**
   * A line's SVG, over the whole slide: its stroke, and a head at each end its arrow names, the
   * head's tip on the end and the stroke stopping inside it. None for a line with no place.
   */
  function lineHtml(l, k) {
    if ([l.x1, l.y1, l.x2, l.y2].some(v => v == null)) return ''
    const s = WEIGHTS[l.weight || 'medium']
    const len = Math.hypot(l.x2 - l.x1, l.y2 - l.y1)
    const ux = len ? (l.x2 - l.x1) / len : 0, uy = len ? (l.y2 - l.y1) / len : 0
    const long = 3 * s + 12, half = long * 0.45, cut = len > long ? long * 0.8 : 0
    // a head at (x, y), pointing along (dx, dy)
    const head = (x, y, dx, dy) => {
      const bx = x - dx * long, by = y - dy * long
      return `<polygon points="${x},${y} ${tenth(bx - dy * half)},${tenth(by + dx * half)} ${tenth(bx + dy * half)},${tenth(by - dx * half)}" fill="currentColor"/>`
    }
    const atStart = len > 0 && (l.arrow === 'start' || l.arrow === 'both'), atEnd = len > 0 && (l.arrow === 'end' || l.arrow === 'both')
    const x1 = atStart ? tenth(l.x1 + ux * cut) : l.x1, y1 = atStart ? tenth(l.y1 + uy * cut) : l.y1
    const x2 = atEnd ? tenth(l.x2 - ux * cut) : l.x2, y2 = atEnd ? tenth(l.y2 - uy * cut) : l.y2
    return `<svg class="slide-line" data-item="${k}" viewBox="0 0 ${WIDTH} ${HEIGHT}"${l.outline ? ` style="color:${cssColor(l.outline)}"` : ''}>` +
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="currentColor" stroke-width="${s}" stroke-linecap="round"/>` +
      `${atStart ? head(l.x1, l.y1, -ux, -uy) : ''}${atEnd ? head(l.x2, l.y2, ux, uy) : ''}</svg>`
  }

  /**
   * A slide's HTML in its layout, `md(src)` giving a piece of Markdown's HTML: a box of the
   * slide's size (WIDTH × HEIGHT), which the page scales to fit. Its boxes and lines are drawn
   * over the layout, the later in the text in front.
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
    const placed = (slide.items || []).map((it, k) => (it.kind === 'box' ? boxHtml(it, k, md) : lineHtml(it, k))).join('')
    return `<div class="${escAttr(cls)}" data-slide="${slide.n}">${inner}${placed}</div>`
  }

  root.RftSlides = {
    DECK_RE, DECKS, LAYOUTS, WIDTH, HEIGHT, COLORS, WEIGHTS,
    frontOf, listItems, isLocked, optionsOf, split, slideAt, forItems, forItem, attach, problems, decksFor, groups, slideHtml,
  }
})(typeof globalThis !== 'undefined' ? globalThis : window)
