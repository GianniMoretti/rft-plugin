// The slide tools' edits of a deck's text (docs/design/presentations.md, "The slide tools"), as
// pure functions: the tools on the slide (web/slide-tools.js) change nothing but the deck's text,
// and of it only the lines of what they act on. An edit is `{from, to, lines}`: the lines `from`
// to `to` (0-based, `to` excluded) of the text replaced by `lines`. Here too, with no page: where
// a drag ends (snapping, the slide's edges, a handle's rectangle). It reads web/slides.js's parser
// (`RftSlides`) and sets `globalThis.RftSlideEdit`.
(function (root) {
  'use strict'

  const P = root.RftSlides
  const ATTR_RE = /([a-z][\w-]*)\s*=\s*"([^"]*)"/gi
  /** The order a box's, a line's and a slide's options are written in. */
  const BOX_ORDER = ['shape', 'x', 'y', 'w', 'h', 'fill', 'outline', 'weight', 'color', 'size', 'align', 'valign']
  const LINE_ORDER = ['from', 'to', 'arrow', 'outline', 'weight']
  const SLIDE_ORDER = ['layout', 'class', 'split', 'title-color', 'title-size']
  const BOX_END = '<!-- /box -->'
  /** The least of a box that stays on the slide, and the least a box is, in the slide's units. */
  const KEEP = 40
  const SMALLEST = 20

  const blank = l => !String(l || '').trim()

  /**
   * A comment line (`<!-- box … -->`, `<!-- line … -->`, `<!-- slide … -->`) with some of its
   * options changed, the rest of the line as it was: a value replaced where it is, a new option
   * put after those that come before it in `order` (first when there is none), one whose value is
   * null taken out with the space before it.
   */
  function setOptions(line, changes, order) {
    let out = String(line)
    for (const [k, v] of Object.entries(changes)) {
      const has = new RegExp(`(\\s${k}\\s*=\\s*)"[^"]*"`, 'gi')
      if (v == null) { out = out.replace(new RegExp(`\\s+${k}\\s*=\\s*"[^"]*"`, 'gi'), ''); continue }
      if (has.test(out)) { has.lastIndex = 0; out = out.replace(has, (_, head) => `${head}"${v}"`); continue }
      const tag = /^\s*<!--\s*[a-z]+/i.exec(out)
      let at = tag ? tag[0].length : 0
      for (const m of out.matchAll(ATTR_RE)) {
        // only an option written as one: a name after a space
        if (!/\s/.test(out[m.index - 1] || '')) continue
        const i = order.indexOf(m[1].toLowerCase())
        if (i >= 0 && i < order.indexOf(k)) at = Math.max(at, m.index + m[0].length)
      }
      out = `${out.slice(0, at)} ${k}="${v}"${out.slice(at)}`
    }
    return out
  }

  /** A text with edits applied, none of them over another. */
  function applyEdits(text, edits) {
    const lines = String(text).split('\n')
    for (const e of [...edits].sort((a, b) => b.from - a.from || b.to - a.to)) lines.splice(e.from, e.to - e.from, ...e.lines)
    return lines.join('\n')
  }

  /** A box's or a line's options changed: the edit of its comment line. */
  function set(lines, item, changes) {
    return { from: item.from, to: item.from + 1, lines: [setOptions(lines[item.from], changes, item.kind === 'line' ? LINE_ORDER : BOX_ORDER)] }
  }

  /** The options that put a box or a line `dx`, `dy` from where it is. */
  function at(item, dx, dy) {
    if (item.kind === 'line') {
      const out = {}
      if (item.x1 != null) out.from = `${item.x1 + dx} ${item.y1 + dy}`
      if (item.x2 != null) out.to = `${item.x2 + dx} ${item.y2 + dy}`
      return out
    }
    return { x: item.x + dx, y: item.y + dy }
  }

  /**
   * Boxes and lines (`blocks`, each its lines) added to a slide: after its content and before its
   * notes, so in front of what is there, a blank line before each and one before what follows.
   * `{edit, firsts}`, `firsts` the line each block starts at once the edit is made.
   */
  function inserted(lines, slide, blocks) {
    const end = slide.noteLine >= 0 ? slide.noteLine : slide.to
    let p = end
    while (p > slide.from && blank(lines[p - 1])) p--
    const out = [], firsts = []
    for (const b of blocks) {
      if (out.length || (p > 0 && !blank(lines[p - 1]))) out.push('')
      firsts.push(p + out.length)
      out.push(...b)
    }
    if (p === end && end < lines.length) out.push('')
    return { edit: { from: p, to: p, lines: out }, firsts }
  }

  /** Boxes and lines removed, each with the blank line it would leave beside another. */
  function removed(lines, items) {
    return items.map(it => ({ from: it.from, to: it.from > 0 && blank(lines[it.from - 1]) && it.to < lines.length && blank(lines[it.to]) ? it.to + 1 : it.to, lines: [] }))
  }

  /** A box's or a line's own lines, a box left open closed. */
  function block(lines, item) {
    if (item.kind === 'line' || item.closed) return lines.slice(item.from, item.to)
    let to = item.to
    while (to > item.from + 1 && blank(lines[to - 1])) to--
    return [...lines.slice(item.from, to), BOX_END]
  }

  /**
   * A slide's box or line `k` put at place `to` among its boxes and lines (the later in the text
   * in front): their lines change places, the lines between them stay.
   */
  function reordered(lines, slide, k, to) {
    const items = slide.items
    if (k === to || !items[k] || !items[to]) return []
    const order = items.map((_, i) => i)
    order.splice(to, 0, order.splice(k, 1)[0])
    const out = []
    for (let i = Math.min(k, to); i <= Math.max(k, to); i++) out.push({ from: items[i].from, to: items[i].to, lines: block(lines, items[order[i]]) })
    return out
  }

  /** A box's Markdown replaced by `text` (a box left open is closed). */
  function content(lines, item, text) {
    const body = String(text).replace(/\s+$/, '')
    const now = body ? body.split('\n') : []
    if (item.closed) return { from: item.from + 1, to: item.to - 1, lines: now }
    let to = item.to
    while (to > item.from + 1 && blank(lines[to - 1])) to--
    return { from: item.from + 1, to, lines: [...now, BOX_END] }
  }

  /** The boxes and lines in a text (one copied from a deck), each as its lines. */
  function blocks(text) {
    const src = String(text || '').replace(/\r\n/g, '\n')
    const lines = src.split('\n')
    return P.split(src).slides.flatMap(s => s.items.map(it => block(lines, it)))
  }

  /** A box's or a line's lines, `dx`, `dy` from where they put it. */
  function shifted(lines, dx, dy) {
    const item = P.split(lines.join('\n')).slides[0].items[0]
    return item ? [set(lines, { ...item, from: 0 }, at(item, dx, dy)).lines[0], ...lines.slice(1)] : lines
  }

  const written = (tag, o, order) => `<!-- ${tag}${order.filter(k => o[k] != null && o[k] !== '').map(k => ` ${k}="${o[k]}"`).join('')} -->`

  /** A new box's lines from its options (those with no value left out) and its Markdown. */
  function newBox(o, text = '') {
    const body = String(text).replace(/\s+$/, '')
    return [written('box', o, BOX_ORDER), ...(body ? body.split('\n') : []), BOX_END]
  }

  /** A new line's line from its options. */
  const newLine = o => [written('line', o, LINE_ORDER)]

  /**
   * How far to move so that one of `edges` falls on one of `targets`, when one is within `tol`:
   * `{d, at}`, the least move and the target it reaches (the first of several as near); `{d: 0,
   * at: null}` when none is.
   */
  function snap(edges, targets, tol) {
    let d = 0, hit = null
    for (const e of edges) {
      for (const t of targets) {
        if (Math.abs(t - e) <= tol && (hit === null || Math.abs(t - e) < Math.abs(d))) { d = t - e; hit = t }
      }
    }
    return { d, at: hit }
  }

  /** A rectangle kept on the slide: it may hang over an edge, with `margin` of it (or all of it, when it is smaller) left on. */
  function keepOn(r, margin = KEEP) {
    const mx = Math.min(margin, r.w), my = Math.min(margin, r.h)
    return { ...r, x: Math.min(Math.max(r.x, mx - r.w), P.WIDTH - mx), y: Math.min(Math.max(r.y, my - r.h), P.HEIGHT - my) }
  }

  /**
   * A rectangle with the handle `handle` (n, s, e, w or a corner, as nw) dragged by `dx`, `dy`:
   * the edges the handle holds move, the others stay, no side under SMALLEST. `keep`: its
   * proportions kept, by the side that changed the more, the opposite corner or edge staying.
   */
  function resized(r, handle, dx, dy, keep = false) {
    const west = handle.includes('w'), east = handle.includes('e'), north = handle.includes('n'), south = handle.includes('s')
    let w = Math.max(SMALLEST, r.w + (east ? dx : west ? -dx : 0))
    let h = Math.max(SMALLEST, r.h + (south ? dy : north ? -dy : 0))
    if (keep) {
      const ratio = r.w / r.h
      const byWidth = (east || west) && (!(north || south) || Math.abs(w - r.w) / r.w >= Math.abs(h - r.h) / r.h)
      if (byWidth) h = w / ratio
      else w = h * ratio
      const k = Math.max(1, SMALLEST / w, SMALLEST / h)
      w *= k
      h *= k
    }
    return { x: west ? r.x + r.w - w : r.x, y: north ? r.y + r.h - h : r.y, w, h }
  }

  // ---------------------------------------------------------------- the slide itself: its options, its layout, its slots

  /** Lines put in the text at line `q`, a blank line kept between them and what is on each side. */
  function put(lines, q, block) {
    const out = [...block]
    if (q > 0 && !blank(lines[q - 1])) out.unshift('')
    if (q < lines.length && !blank(lines[q])) out.push('')
    return { from: q, to: q, lines: out }
  }

  /** Where a slide's boxes and lines are added: after its content, before its notes. */
  function endOf(lines, slide) {
    let p = slide.noteLine >= 0 ? slide.noteLine : slide.to
    while (p > slide.from && blank(lines[p - 1])) p--
    return p
  }

  /**
   * A slide's options changed (`<!-- slide layout="…" split="…" -->`): on its options line, which
   * is written when the slide had none and taken out when it is left with none. Null when there
   * is nothing to change.
   */
  function slideOptions(lines, slide, changes) {
    if (slide.optLine >= 0) {
      const at = slide.optLine, line = setOptions(lines[at], changes, SLIDE_ORDER)
      if (line === lines[at]) return null
      if (!/^\s*<!--\s*slide\s*-->\s*$/i.test(line)) return { from: at, to: at + 1, lines: [line] }
      return { from: at, to: at > 0 && blank(lines[at - 1]) && at + 1 < lines.length && blank(lines[at + 1]) ? at + 2 : at + 1, lines: [] }
    }
    const given = Object.fromEntries(Object.entries(changes).filter(([, v]) => v != null))
    if (!Object.keys(given).length) return null
    const line = setOptions('<!-- slide -->', given, SLIDE_ORDER)
    const end = slide.noteLine >= 0 ? slide.noteLine : slide.to
    if (slide.bodyLine >= end) return put(lines, slide.from, [line])
    // above its first line, as close to it as the separator above is
    const q = slide.bodyLine
    return { from: q, to: q, lines: q > 0 && !blank(lines[q - 1]) ? [line] : [line, ''] }
  }

  /** A slide's layout changed: written, unless it is the one the slide has unasked (the first slide's title, the others' default). */
  const withLayout = (lines, slide, layout) => slideOptions(lines, slide, { layout: layout === (slide.n === 1 ? 'title' : 'default') ? null : layout })

  const SKELETON = { default: ['## Title'], title: ['# Title'], section: ['# Title'], 'two-cols': ['## Title', '', '::right::'], figure: ['## Title'] }

  /** A new slide of `layout` after `slide`, with a heading to type over: `{edit, line}`, `line` its heading's once the edit is made. */
  function newSlide(lines, slide, layout) {
    const natural = layout === 'default'
    const body = ['---', '', ...(natural ? [] : [`<!-- slide layout="${layout}" -->`, '']), ...(SKELETON[layout] || SKELETON.default), '']
    const head = 2 + (natural ? 0 : 2)
    if (slide.to < lines.length) {
      const pre = slide.to > 0 && !blank(lines[slide.to - 1]) ? [''] : []
      return { edit: { from: slide.to, to: slide.to, lines: [...pre, ...body] }, line: slide.to + pre.length + head }
    }
    let end = lines.length
    while (end > slide.from && blank(lines[end - 1])) end--
    const pre = end > 0 ? [''] : []
    return { edit: { from: end, to: lines.length, lines: [...pre, ...body] }, line: end + pre.length + head }
  }

  /** The lines a slot's content spans, first to last, the blank ones around it left out; null for a slot with nothing in it. */
  function span(slot) {
    const real = slot.rows.filter(r => r.line >= 0 && r.text.trim())
    return real.length ? [real[0].line, real[real.length - 1].line + 1] : null
  }

  /** The boxes and lines written between the lines `a` and `b` of a slide, each as its lines after a blank one. */
  const within = (lines, slide, a, b) => slide.items.filter(it => it.from > a && it.from < b).flatMap(it => ['', ...block(lines, it)])

  /**
   * A slot's content replaced by `text` (Markdown; '' empties it). A box or a line written
   * between its lines is kept, after it. A slot with nothing in it is written where it starts:
   * under the heading (or the options, or the separator) for the first ones, after a line
   * `::right::` for the right column (added when there is none), at the end for a caption.
   * `tidy`: emptied, it takes the blank line it leaves with it. Null when there is nothing to do.
   */
  function slotEdit(lines, slide, name, text, tidy = true) {
    const all = P.slots(slide), slot = all.find(s => s.name === name)
    if (!slot) return null
    const body = String(text).replace(/^(\s*\n)+/, '').replace(/\s+$/, '')
    const now = body ? body.split('\n') : []
    const at = span(slot)
    if (at) {
      const kept = within(lines, slide, at[0], at[1])
      const out = now.length ? [...now, ...kept] : kept.slice(1)
      const to = !out.length && tidy && at[0] > 0 && blank(lines[at[0] - 1]) && at[1] < lines.length && blank(lines[at[1]]) ? at[1] + 1 : at[1]
      return { from: at[0], to, lines: out }
    }
    if (!now.length) return null
    if (name === 'right' && slot.at >= 0) return put(lines, slot.at + 1, now)
    if (name === 'right') return put(lines, endOf(lines, slide), ['::right::', '', ...now])
    if (name === 'caption') return put(lines, endOf(lines, slide), now)
    const head = all.find(s => s.name === 'head')
    const above = name !== 'head' && head && span(head) ? span(head)[1] : slide.optLine >= 0 ? slide.optLine + 1 : slide.from
    return put(lines, above, now)
  }

  /** Two columns' content changed over: what was on the left on the right, and the reverse. A box or a line written among them is kept, after them. */
  function swapped(lines, slide) {
    const all = P.slots(slide), left = all.find(s => s.name === 'left'), right = all.find(s => s.name === 'right')
    if (!left || !right || (!span(left) && !span(right))) return null
    const marks = [span(left), span(right), right.at >= 0 ? [right.at, right.at + 1] : null].filter(Boolean)
    const a = Math.min(...marks.map(m => m[0])), b = Math.max(...marks.map(m => m[1]))
    const out = []
    if (right.text) out.push(...right.text.split('\n'), '')
    out.push('::right::')
    if (left.text) out.push('', ...left.text.split('\n'))
    return { from: a, to: b, lines: [...out, ...within(lines, slide, a, b)] }
  }

  /**
   * A slot's content taken out of its layout and made a box at `rect` (`{x, y, w}`: where it is
   * drawn), in front of the others: `{edits, first}`, `first` the line the box starts at once the
   * edits are made. Null for a slot with nothing in it.
   */
  function detached(lines, slide, name, rect) {
    const slot = P.slots(slide).find(s => s.name === name)
    if (!slot || !slot.text) return null
    const added = inserted(lines, slide, [newBox({ x: rect.x, y: rect.y, w: rect.w }, slot.text)])
    // with the blank line it leaves, unless that is where the box goes
    const tidy = slotEdit(lines, slide, name, '')
    const out = tidy.to <= added.edit.from ? tidy : slotEdit(lines, slide, name, '', false)
    return { edits: [out, added.edit], first: added.firsts[0] + out.lines.length - (out.to - out.from) }
  }

  /** The left column's share of two columns `width` wide from `left`, `gap` apart, when their divide is at `x`: in percent, within what a slide may ask. */
  const share = (x, left, width, gap) => Math.min(P.SPLIT_MAX, Math.max(P.SPLIT_MIN, Math.round(100 * (x - left - gap / 2) / (width - gap))))

  root.RftSlideEdit = {
    BOX_ORDER, LINE_ORDER, SLIDE_ORDER, KEEP, SMALLEST,
    setOptions, applyEdits, set, at, inserted, removed, block, reordered, content, blocks, shifted, newBox, newLine, snap, keepOn, resized,
    slideOptions, withLayout, newSlide, slotEdit, swapped, detached, share,
  }
})(typeof globalThis !== 'undefined' ? globalThis : window)
