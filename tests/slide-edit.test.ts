// The slide tools' edits of a deck's text (web/slide-edit.js; docs/design/presentations.md, "The
// slide tools"): each tool action is an edit of the lines of what it acts on and of nothing else.

import { describe, expect, test } from 'claude-code/testing'

import '../web/slides.js'
import '../web/slide-edit.js'

type Item = { kind: string; from: number; to: number; x?: number; y?: number; w?: number; h?: number | null; x1?: number | null; y1?: number | null; x2?: number | null; y2?: number | null; content?: string }
type Slide = { n: number; from: number; to: number; noteLine: number; items: Item[]; body: string }
type Edit = { from: number; to: number; lines: string[] }
type Rect = { x: number; y: number; w: number; h: number }
type Api = {
  BOX_ORDER: string[]
  LINE_ORDER: string[]
  setOptions: (line: string, changes: Record<string, string | number | null>, order: string[]) => string
  applyEdits: (text: string, edits: Edit[]) => string
  set: (lines: string[], item: Item, changes: Record<string, string | number | null>) => Edit
  at: (item: Item, dx: number, dy: number) => Record<string, string | number>
  inserted: (lines: string[], slide: Slide, blocks: string[][]) => { edit: Edit; firsts: number[] }
  removed: (lines: string[], items: Item[]) => Edit[]
  reordered: (lines: string[], slide: Slide, k: number, to: number) => Edit[]
  content: (lines: string[], item: Item, text: string) => Edit
  block: (lines: string[], item: Item) => string[]
  blocks: (text: string) => string[][]
  shifted: (block: string[], dx: number, dy: number) => string[]
  newBox: (o: Record<string, string | number | null | undefined>, content?: string) => string[]
  newLine: (o: Record<string, string | number | null | undefined>) => string[]
  snap: (edges: number[], targets: number[], tol: number) => { d: number; at: number | null }
  keepOn: (r: Rect, margin?: number) => Rect
  resized: (r: Rect, handle: string, dx: number, dy: number, keep?: boolean) => Rect
  aligned: (rects: Rect[], how: string) => Rect[]
  distributed: (rects: Rect[], axis: string) => Rect[]
  slideOptions: (lines: string[], slide: Slide, changes: Record<string, string | number | null>) => Edit | null
  withLayout: (lines: string[], slide: Slide, layout: string) => Edit | null
  newSlide: (lines: string[], slide: Slide, layout: string) => { edit: Edit; line: number }
  slotEdit: (lines: string[], slide: Slide, name: string, text: string) => Edit | null
  swapped: (lines: string[], slide: Slide) => Edit | null
  detached: (lines: string[], slide: Slide, name: string, rect: { x: number; y: number; w: number }) => { edits: Edit[]; first: number } | null
  share: (x: number, left: number, width: number, gap: number) => number
}

const P = (globalThis as unknown as { RftSlides: { split: (t: string) => { slides: Slide[] } } }).RftSlides
const E = (globalThis as unknown as { RftSlideEdit: Api }).RftSlideEdit

const DECK = [
  '---', 'id: P02', 'type: deck', '---', '',
  '# Title', '', '---', '',
  '## Head', '', 'text', '',
  '<!-- box x="1180" y="620" w="520" color="accent" size="40" -->', 'gap closes here', '<!-- /box -->', '',
  '<!-- box shape="ellipse" x="980" y="410" w="160" h="120" outline="contrast" -->', '<!-- /box -->', '',
  '<!-- line from="1180 660" to="1130 500" arrow="end" outline="contrast" -->', '',
  'note: say why', '', '---', '', '## Last', '',
].join('\n')
const deck = (text = DECK) => ({ lines: text.split('\n'), slides: P.split(text).slides })
const after = (text: string, edits: Edit[]) => E.applyEdits(text, edits)

describe('an option of a comment line changed, the rest of the line as it was', () => {
  test('a value changed where it is, whatever the spacing and the order', () => {
    const line = '<!--  box  w="520" x = "1180"   y="620" color="accent" -->  '
    expect(E.setOptions(line, { x: 1200, y: 600 }, E.BOX_ORDER)).toBe('<!--  box  w="520" x = "1200"   y="600" color="accent" -->  ')
  })

  test('a new one put at its place in the usual order, or first; one taken out with its space', () => {
    const line = '<!-- box x="1" y="2" w="3" color="accent" -->'
    expect(E.setOptions(line, { h: 40 }, E.BOX_ORDER)).toBe('<!-- box x="1" y="2" w="3" h="40" color="accent" -->')
    expect(E.setOptions(line, { size: 40, fill: '#ffffff' }, E.BOX_ORDER)).toBe('<!-- box x="1" y="2" w="3" fill="#ffffff" color="accent" size="40" -->')
    expect(E.setOptions(line, { shape: 'ellipse' }, E.BOX_ORDER)).toBe('<!-- box shape="ellipse" x="1" y="2" w="3" color="accent" -->')
    expect(E.setOptions(line, { color: null, w: null }, E.BOX_ORDER)).toBe('<!-- box x="1" y="2" -->')
    expect(E.setOptions('<!-- line -->', { to: '3 4', from: '1 2' }, E.LINE_ORDER)).toBe('<!-- line from="1 2" to="3 4" -->')
  })

  test('title-color is not color', () => {
    const order = ['layout', 'class', 'split', 'title-color', 'title-size']
    expect(E.setOptions('<!-- slide layout="two-cols" title-color="accent" -->', { split: 60 }, order)).toBe('<!-- slide layout="two-cols" split="60" title-color="accent" -->')
    expect(E.setOptions('<!-- box x="1" title-color="accent" -->', { color: 'text' }, E.BOX_ORDER)).toBe('<!-- box x="1" color="text" title-color="accent" -->')
  })
})

describe('a box or a line moved, resized, styled: its own line, nothing else', () => {
  test('a box moved changes x and y on its line; a line, its two ends', () => {
    const { lines, slides } = deck()
    const [box, , line] = slides[1]!.items
    const text = after(DECK, [E.set(lines, box!, E.at(box!, -30, 15)), E.set(lines, line!, E.at(line!, 10, -20))])
    expect(text).toBe(DECK
      .replace('x="1180" y="620" w="520"', 'x="1150" y="635" w="520"')
      .replace('from="1180 660" to="1130 500"', 'from="1190 640" to="1140 480"'))
  })

  test('a height given to a box that had none, and taken away', () => {
    const { lines, slides } = deck()
    const box = slides[1]!.items[0]!
    const text = after(DECK, [E.set(lines, box, { w: 600, h: 200 })])
    expect(text).toBe(DECK.replace('w="520" color', 'w="600" h="200" color'))
    const again = deck(text)
    expect(after(text, [E.set(again.lines, again.slides[1]!.items[0]!, { h: null, w: 520 })])).toBe(DECK)
  })
})

describe('a box or a line added: after the slide\'s content and before its notes', () => {
  const box = ['<!-- box x="1" y="2" w="3" -->', 'new', '<!-- /box -->']
  const add = (text: string, k: number, blocks = [box]) => {
    const { lines, slides } = deck(text)
    const { edit, firsts } = E.inserted(lines, slides[k]!, blocks)
    const out = after(text, [edit])
    for (const [i, f] of firsts.entries()) expect(out.split('\n')[f]).toBe(blocks[i]![0])
    return out
  }

  test('with a blank line before it, and one before the notes or the next slide', () => {
    expect(add('## Head\n\ntext\n\nnote: n\n', 0)).toBe('## Head\n\ntext\n\n<!-- box x="1" y="2" w="3" -->\nnew\n<!-- /box -->\n\nnote: n\n')
    expect(add('## Head\ntext\nnote: n', 0)).toBe('## Head\ntext\n\n<!-- box x="1" y="2" w="3" -->\nnew\n<!-- /box -->\n\nnote: n')
    expect(add('text\n\n---\n\n# Next\n', 0)).toBe('text\n\n<!-- box x="1" y="2" w="3" -->\nnew\n<!-- /box -->\n\n---\n\n# Next\n')
    expect(add('text\n---\n# Next\n', 0)).toBe('text\n\n<!-- box x="1" y="2" w="3" -->\nnew\n<!-- /box -->\n\n---\n# Next\n')
  })

  test('at the end of the deck, and on a slide with nothing on it', () => {
    expect(add('# One\n\n---\n\ntext\n', 1)).toBe('# One\n\n---\n\ntext\n\n<!-- box x="1" y="2" w="3" -->\nnew\n<!-- /box -->\n')
    expect(add('text', 0)).toBe('text\n\n<!-- box x="1" y="2" w="3" -->\nnew\n<!-- /box -->')
    expect(add('# One\n\n---\n', 1)).toBe('# One\n\n---\n\n<!-- box x="1" y="2" w="3" -->\nnew\n<!-- /box -->\n')
    expect(add('---\nid: P02\n---\n', 0)).toBe('---\nid: P02\n---\n\n<!-- box x="1" y="2" w="3" -->\nnew\n<!-- /box -->\n')
    expect(add('# One\n---\n<!-- slide layout="figure" -->\n\n---\n# Three', 1)).toBe('# One\n---\n<!-- slide layout="figure" -->\n\n<!-- box x="1" y="2" w="3" -->\nnew\n<!-- /box -->\n\n---\n# Three')
  })

  test('several at once, a blank line between them; in front of those there were', () => {
    const line = ['<!-- line from="0 0" to="9 9" -->']
    const out = add(DECK, 1, [box, line])
    expect(out).toBe(DECK.replace('outline="contrast" -->\n\nnote:', 'outline="contrast" -->\n\n<!-- box x="1" y="2" w="3" -->\nnew\n<!-- /box -->\n\n<!-- line from="0 0" to="9 9" -->\n\nnote:'))
    expect(P.split(out).slides[1]!.items.map(i => i.kind)).toEqual(['box', 'box', 'line', 'box', 'line'])
  })
})

describe('boxes and lines removed, put in front or behind, their text changed', () => {
  test('removed with the blank line it leaves', () => {
    const { lines, slides } = deck()
    const [a, b, c] = slides[1]!.items
    expect(after(DECK, E.removed(lines, [b!]))).toBe(DECK.replace('<!-- box shape="ellipse" x="980" y="410" w="160" h="120" outline="contrast" -->\n<!-- /box -->\n\n', ''))
    const none = after(DECK, E.removed(lines, [a!, b!, c!]))
    expect(none).toBe(DECK.slice(0, DECK.indexOf('<!-- box x="1180"')) + 'note: say why\n\n---\n\n## Last\n')
    expect(after('a\n<!-- line from="0 0" to="1 1" -->\nb', E.removed(['a', '<!-- line from="0 0" to="1 1" -->', 'b'], [{ kind: 'line', from: 1, to: 2 }]))).toBe('a\nb')
  })

  test('put in front or behind: its lines change places with the others\', the rest as it was', () => {
    const { lines, slides } = deck()
    const order = (text: string) => P.split(text).slides[1]!.items.map(i => (i.kind === 'line' ? 'line' : i.content ? 'text' : 'ellipse'))
    const front = after(DECK, E.reordered(lines, slides[1]!, 0, 2))
    expect(order(front)).toEqual(['ellipse', 'line', 'text'])
    expect(front.length).toBe(DECK.length)
    expect(front.split('\n').filter(l => !l.startsWith('<!--') && l !== 'gap closes here')).toEqual(DECK.split('\n').filter(l => !l.startsWith('<!--') && l !== 'gap closes here'))
    const one = after(DECK, E.reordered(lines, slides[1]!, 2, 1))
    expect(order(one)).toEqual(['text', 'line', 'ellipse'])
    expect(E.reordered(lines, slides[1]!, 1, 1)).toEqual([])
    const back = deck(front)
    expect(after(front, E.reordered(back.lines, back.slides[1]!, 2, 0))).toBe(DECK)
  })

  test('a box\'s text changed; a box left open is closed by it', () => {
    const { lines, slides } = deck()
    expect(after(DECK, [E.content(lines, slides[1]!.items[0]!, 'gap closes\n\n**here**')])).toBe(DECK.replace('gap closes here', 'gap closes\n\n**here**'))
    expect(after(DECK, [E.content(lines, slides[1]!.items[1]!, 'a label')])).toBe(DECK.replace('outline="contrast" -->\n<!-- /box -->', 'outline="contrast" -->\na label\n<!-- /box -->'))
    expect(after(DECK, [E.content(lines, slides[1]!.items[0]!, '')])).toBe(DECK.replace('gap closes here\n', ''))
    const open = '## Head\n<!-- box x="1" y="2" w="3" -->\nleft open\n\nnote: n'
    const d = deck(open)
    expect(after(open, [E.content(d.lines, d.slides[0]!.items[0]!, 'closed')])).toBe('## Head\n<!-- box x="1" y="2" w="3" -->\nclosed\n<!-- /box -->\n\nnote: n')
  })
})

describe('boxes and lines as text: copied, pasted, made', () => {
  test('a box\'s and a line\'s own lines, and those in a text pasted', () => {
    const { lines, slides } = deck()
    const copied = slides[1]!.items.map(i => E.block(lines, i).join('\n')).join('\n\n')
    expect(copied).toBe(DECK.slice(DECK.indexOf('<!-- box x="1180"'), DECK.indexOf('\n\nnote:')))
    expect(E.blocks(copied)).toEqual(slides[1]!.items.map(i => E.block(lines, i)))
    expect(E.blocks('some text\n<!-- box x="1" y="2" w="3" -->\nleft open')).toEqual([['<!-- box x="1" y="2" w="3" -->', 'left open', '<!-- /box -->']])
    expect(E.blocks('no box in it')).toEqual([])
  })

  test('shifted: a copy beside what it copies', () => {
    expect(E.shifted(['<!-- box x="1180" y="620" w="520" -->', 'x', '<!-- /box -->'], 20, 20)).toEqual(['<!-- box x="1200" y="640" w="520" -->', 'x', '<!-- /box -->'])
    expect(E.shifted(['<!-- line from="1180 660" to="1130 500" arrow="end" -->'], 20, -20)).toEqual(['<!-- line from="1200 640" to="1150 480" arrow="end" -->'])
  })

  test('a new box and a new line, their options in the usual order, those with no value left out', () => {
    expect(E.newBox({ w: 420, color: 'contrast', x: 1300, y: 330, size: 40, h: null }, 'gap closes here')).toEqual(['<!-- box x="1300" y="330" w="420" color="contrast" size="40" -->', 'gap closes here', '<!-- /box -->'])
    expect(E.newBox({ shape: 'ellipse', x: 1, y: 2, w: 3, h: 4, outline: 'text', fill: undefined })).toEqual(['<!-- box shape="ellipse" x="1" y="2" w="3" h="4" outline="text" -->', '<!-- /box -->'])
    expect(E.newLine({ arrow: 'end', to: '5 6', from: '1 2' })).toEqual(['<!-- line from="1 2" to="5 6" arrow="end" -->'])
  })
})

describe('where a drag ends', () => {
  test('snapping: the nearest of the targets within reach of one of the edges', () => {
    expect(E.snap([100, 300, 500], [0, 960, 1920, 296], 8)).toEqual({ d: -4, at: 296 })
    expect(E.snap([100, 300, 500], [0, 960, 1920], 8)).toEqual({ d: 0, at: null })
    expect(E.snap([953, 1500], [0, 960, 1920, 1493], 8)).toEqual({ d: 7, at: 960 }) // the first of two as near
    expect(E.snap([1915.4], [1920], 8).d).toBeGreaterThan(4.5)
  })

  test('a box may hang over the slide\'s edge, not leave it', () => {
    expect(E.keepOn({ x: -500, y: 20, w: 300, h: 100 })).toEqual({ x: -260, y: 20, w: 300, h: 100 })
    expect(E.keepOn({ x: 1900, y: 1070, w: 300, h: 100 })).toEqual({ x: 1880, y: 1040, w: 300, h: 100 })
    expect(E.keepOn({ x: 100, y: -300, w: 20, h: 20 })).toEqual({ x: 100, y: 0, w: 20, h: 20 })
    expect(E.keepOn({ x: -30, y: 1000, w: 300, h: 100 })).toEqual({ x: -30, y: 1000, w: 300, h: 100 })
  })

  test('a handle dragged: the edges it holds move, the others stay; never smaller than 20', () => {
    const r = { x: 100, y: 200, w: 400, h: 200 }
    expect(E.resized(r, 'se', 50, -30)).toEqual({ x: 100, y: 200, w: 450, h: 170 })
    expect(E.resized(r, 'nw', 50, -30)).toEqual({ x: 150, y: 170, w: 350, h: 230 })
    expect(E.resized(r, 'e', 50, 999)).toEqual({ x: 100, y: 200, w: 450, h: 200 })
    expect(E.resized(r, 'n', 999, 50)).toEqual({ x: 100, y: 250, w: 400, h: 150 })
    expect(E.resized(r, 'w', 999, 0)).toEqual({ x: 480, y: 200, w: 20, h: 200 })
    expect(E.resized(r, 's', 0, -999)).toEqual({ x: 100, y: 200, w: 400, h: 20 })
  })

  test('its proportions kept: the other side follows, the opposite corner or edge stays', () => {
    const r = { x: 100, y: 200, w: 400, h: 200 }
    expect(E.resized(r, 'se', 100, 0, true)).toEqual({ x: 100, y: 200, w: 500, h: 250 })
    expect(E.resized(r, 'e', 100, 0, true)).toEqual({ x: 100, y: 200, w: 500, h: 250 })
    expect(E.resized(r, 's', 0, 50, true)).toEqual({ x: 100, y: 200, w: 500, h: 250 })
    expect(E.resized(r, 'nw', -100, 0, true)).toEqual({ x: 0, y: 150, w: 500, h: 250 })
    expect(E.resized(r, 'ne', 0, -50, true)).toEqual({ x: 100, y: 150, w: 500, h: 250 })
    expect(E.resized(r, 'w', 100, 0, true)).toEqual({ x: 200, y: 200, w: 300, h: 150 })
  })
})

describe('a slide\'s own options: on its options line, written when it had none, taken out when none is left', () => {
  const opt = (text: string, k: number, changes: Record<string, string | number | null>) => {
    const { lines, slides } = deck(text)
    const e = E.slideOptions(lines, slides[k]!, changes)
    return e ? after(text, [e]) : null
  }

  test('changed and added on the line there is', () => {
    const text = '# T\n---\n\n<!-- slide layout="two-cols" -->\n\n## H\n'
    const wide = '# T\n---\n\n<!-- slide layout="two-cols" split="60" -->\n\n## H\n'
    expect(opt(text, 1, { split: 60 })).toBe(wide)
    expect(opt(wide, 1, { split: null })).toBe(text)
    expect(opt(wide, 1, { 'title-color': 'contrast', 'title-size': 72 })).toBe('# T\n---\n\n<!-- slide layout="two-cols" split="60" title-color="contrast" title-size="72" -->\n\n## H\n')
    expect(opt(text, 1, { split: null })).toBe(null)
  })

  test('the line written above the slide\'s first line, as close to it as the separator is; on a slide with nothing on it', () => {
    expect(opt('# T\n---\n\n## H\n', 1, { layout: 'section' })).toBe('# T\n---\n\n<!-- slide layout="section" -->\n\n## H\n')
    expect(opt('# T\n---\n## H', 1, { layout: 'section' })).toBe('# T\n---\n<!-- slide layout="section" -->\n## H')
    expect(opt('---\nid: P01\n---\n\n# T\n', 0, { 'title-color': 'accent' })).toBe('---\nid: P01\n---\n\n<!-- slide title-color="accent" -->\n\n# T\n')
    expect(opt('# T\n---\n', 1, { layout: 'section' })).toBe('# T\n---\n\n<!-- slide layout="section" -->\n')
    expect(opt('# T\n---\n\nnote: only notes\n', 1, { layout: 'section' })).toBe('# T\n---\n\n<!-- slide layout="section" -->\n\nnote: only notes\n')
    expect(opt('# T\n---\n\n## H\n', 1, { split: null })).toBe(null)
  })

  test('the line taken out with its last option, and the blank line it leaves', () => {
    expect(opt('# T\n---\n\n<!-- slide layout="section" -->\n\n## H\n', 1, { layout: null })).toBe('# T\n---\n\n## H\n')
    expect(opt('# T\n---\n<!-- slide layout="section" -->\n## H', 1, { layout: null })).toBe('# T\n---\n## H')
    expect(opt('# T\n---\n<!-- slide layout="section" -->\n\n## H', 1, { layout: null })).toBe('# T\n---\n\n## H')
  })

  test('a layout: written, unless it is the one the slide has unasked', () => {
    const lay = (text: string, k: number, layout: string) => { const { lines, slides } = deck(text); const e = E.withLayout(lines, slides[k]!, layout); return e ? after(text, [e]) : null }
    expect(lay('# T\n---\n\n## H\n', 1, 'two-cols')).toBe('# T\n---\n\n<!-- slide layout="two-cols" -->\n\n## H\n')
    expect(lay('# T\n---\n\n<!-- slide layout="two-cols" split="60" -->\n\n## H\n', 1, 'default')).toBe('# T\n---\n\n<!-- slide split="60" -->\n\n## H\n')
    expect(lay('# T\n---\n\n<!-- slide layout="two-cols" -->\n\n## H\n', 1, 'default')).toBe('# T\n---\n\n## H\n')
    expect(lay('<!-- slide layout="section" -->\n# T', 0, 'title')).toBe('# T')
    expect(lay('# T', 0, 'default')).toBe('<!-- slide layout="default" -->\n\n# T')
    expect(lay('# T\n---\n\n## H\n', 1, 'default')).toBe(null)
  })
})

describe('a new slide after this one', () => {
  const add = (text: string, k: number, layout: string) => {
    const { lines, slides } = deck(text)
    const { edit, line } = E.newSlide(lines, slides[k]!, layout)
    const out = after(text, [edit])
    expect(out.split('\n')[line]).toMatch(/^#{1,2} Title$/)
    return out
  }

  test('between two slides, with its layout and a heading to type over', () => {
    const text = '# T\n\n---\n\n## A\n\nnote: n\n\n---\n\n## B\n'
    expect(add(text, 1, 'two-cols')).toBe('# T\n\n---\n\n## A\n\nnote: n\n\n---\n\n<!-- slide layout="two-cols" -->\n\n## Title\n\n::right::\n\n---\n\n## B\n')
    expect(add(text, 0, 'default')).toBe('# T\n\n---\n\n## Title\n\n---\n\n## A\n\nnote: n\n\n---\n\n## B\n')
    expect(add('# T\n---\n## B', 0, 'figure')).toBe('# T\n\n---\n\n<!-- slide layout="figure" -->\n\n## Title\n\n---\n## B')
  })

  test('at the end of the deck', () => {
    expect(add('# T\n\n---\n\n## A\n', 1, 'default')).toBe('# T\n\n---\n\n## A\n\n---\n\n## Title\n')
    expect(add('# T', 0, 'section')).toBe('# T\n\n---\n\n<!-- slide layout="section" -->\n\n# Title\n')
    expect(add('# T\n\n\n', 0, 'title')).toBe('# T\n\n---\n\n<!-- slide layout="title" -->\n\n# Title\n')
  })
})

describe('a slot\'s content: replaced, changed over with the other column\'s, taken out of the layout', () => {
  const COLS = ['# T', '---', '<!-- slide layout="two-cols" -->', '', '## Head', '', 'left one', '<!-- line from="0 0" to="1 1" -->', 'left two', '', '::right::', '', '- right', '', 'note: n'].join('\n')
  const slot = (text: string, k: number, name: string, now: string) => {
    const { lines, slides } = deck(text)
    const e = E.slotEdit(lines, slides[k]!, name, now)
    return e ? after(text, [e]) : null
  }

  test('replaced where it is; a line written among its lines is kept, after it', () => {
    expect(slot(COLS, 1, 'head', '## New head')).toBe(COLS.replace('## Head', '## New head'))
    expect(slot(COLS, 1, 'right', '- a\n- b\n')).toBe(COLS.replace('- right', '- a\n- b'))
    expect(slot(COLS, 1, 'left', 'new left\n\nsecond')).toBe(COLS.replace('left one\n<!-- line from="0 0" to="1 1" -->\nleft two', 'new left\n\nsecond\n\n<!-- line from="0 0" to="1 1" -->'))
    expect(slot(COLS, 1, 'nope', 'x')).toBe(null)
  })

  test('emptied, with the blank line it leaves', () => {
    expect(slot(COLS, 1, 'right', '')).toBe(COLS.replace('::right::\n\n- right\n\nnote', '::right::\n\nnote'))
    expect(slot(COLS, 1, 'left', '  \n')).toBe(COLS.replace('left one\n<!-- line from="0 0" to="1 1" -->\nleft two', '<!-- line from="0 0" to="1 1" -->'))
    expect(slot('# T\n---\n<!-- slide layout="two-cols" -->\nleft', 1, 'right', '')).toBe(null)
  })

  test('a slot with nothing in it is written where it starts', () => {
    const fresh = '# T\n\n---\n\n<!-- slide layout="two-cols" -->\n\n## Title\n\n::right::\n'
    const withLeft = '# T\n\n---\n\n<!-- slide layout="two-cols" -->\n\n## Title\n\n![[E06_loss.svg]]\n\n::right::\n'
    expect(slot(fresh, 1, 'left', '![[E06_loss.svg]]')).toBe(withLeft)
    expect(slot(withLeft, 1, 'right', '- one\n- two\n- three')).toBe('# T\n\n---\n\n<!-- slide layout="two-cols" -->\n\n## Title\n\n![[E06_loss.svg]]\n\n::right::\n\n- one\n- two\n- three\n')
    expect(slot('# T\n---\n<!-- slide layout="two-cols" -->\n## Head\nleft\n', 1, 'right', '- x')).toBe('# T\n---\n<!-- slide layout="two-cols" -->\n## Head\nleft\n\n::right::\n\n- x\n')
    expect(slot('# T\n---\n<!-- slide layout="two-cols" -->\n\n::right::\n\nr\n', 1, 'left', 'l')).toBe('# T\n---\n<!-- slide layout="two-cols" -->\n\nl\n\n::right::\n\nr\n')
    expect(slot('# T\n---\n<!-- slide layout="two-cols" -->\n\nleft\n', 1, 'head', '## Head')).toBe('# T\n---\n<!-- slide layout="two-cols" -->\n\n## Head\n\nleft\n')
    expect(slot('# T\n---\n', 1, 'content', 'text')).toBe('# T\n---\n\ntext\n')
    expect(slot('# T\n---\n<!-- slide layout="figure" -->\n## L\n![[f.svg]]', 1, 'caption', 'three seeds')).toBe('# T\n---\n<!-- slide layout="figure" -->\n## L\n![[f.svg]]\n\nthree seeds')
    expect(slot('# T\n---\n<!-- slide layout="figure" -->\n## L\n\ncaption\n\nnote: n', 1, 'figure', '![[f.svg]]')).toBe('# T\n---\n<!-- slide layout="figure" -->\n## L\n\n![[f.svg]]\n\ncaption\n\nnote: n')
  })

  test('two columns changed over', () => {
    const swap = (text: string, k: number) => { const { lines, slides } = deck(text); const e = E.swapped(lines, slides[k]!); return e ? after(text, [e]) : null }
    const over = COLS.replace('left one\n<!-- line from="0 0" to="1 1" -->\nleft two\n\n::right::\n\n- right', '- right\n\n::right::\n\nleft one\n\nleft two\n\n<!-- line from="0 0" to="1 1" -->')
    expect(swap(COLS, 1)).toBe(over)
    const twice = swap(over, 1)!
    expect(P.split(twice).slides[1]!.body.replace(/\n+/g, '\n')).toBe('## Head\nleft one\nleft two\n::right::\n- right')
    // one of them with nothing in it: its content goes over
    expect(swap('# T\n---\n<!-- slide layout="two-cols" -->\n## Head\n\nleft\n', 1)).toBe('# T\n---\n<!-- slide layout="two-cols" -->\n## Head\n\n::right::\n\nleft\n')
    expect(swap('# T\n---\n<!-- slide layout="two-cols" -->\n## Head\n\n::right::\n\nright\n', 1)).toBe('# T\n---\n<!-- slide layout="two-cols" -->\n## Head\n\nright\n\n::right::\n')
    expect(swap('# T\n---\n<!-- slide layout="two-cols" -->\n## Head\n', 1)).toBe(null)
    expect(swap('# T\n---\n## Head\ntext', 1)).toBe(null)
  })

  test('taken out of the layout: a box where it was drawn, in front, its lines gone from the slot', () => {
    const { lines, slides } = deck(COLS)
    const d = E.detached(lines, slides[1]!, 'left', { x: 90, y: 248, w: 850 })!
    const out = after(COLS, d.edits)
    expect(out).toBe(['# T', '---', '<!-- slide layout="two-cols" -->', '', '## Head', '', '<!-- line from="0 0" to="1 1" -->', '', '::right::', '', '- right', '',
      '<!-- box x="90" y="248" w="850" -->', 'left one', '', 'left two', '<!-- /box -->', '', 'note: n'].join('\n'))
    expect(out.split('\n')[d.first]).toBe('<!-- box x="90" y="248" w="850" -->')
    const fig = '# T\n---\n<!-- slide layout="figure" -->\n\n## Loss\n\n![[E08_loss.svg]]\n\nThree seeds\n'
    const f = deck(fig)
    const df = E.detached(f.lines, f.slides[1]!, 'figure', { x: 400, y: 190, w: 1120 })!
    const outf = after(fig, df.edits)
    expect(outf).toBe('# T\n---\n<!-- slide layout="figure" -->\n\n## Loss\n\nThree seeds\n\n<!-- box x="400" y="190" w="1120" -->\n![[E08_loss.svg]]\n<!-- /box -->\n')
    expect(outf.split('\n')[df.first]).toBe('<!-- box x="400" y="190" w="1120" -->')
    expect(E.detached(f.lines, f.slides[0]!, 'nope', { x: 0, y: 0, w: 1 })).toBe(null)
  })

  test('the left column\'s share where the divide is dragged to', () => {
    // two columns 1700 wide from 110, 80 apart: the divide in the middle is half
    expect(E.share(110 + 850, 110, 1700, 80)).toBe(50)
    expect(E.share(110 + 0.6 * 1620 + 40, 110, 1700, 80)).toBe(60)
    expect(E.share(0, 110, 1700, 80)).toBe(10)
    expect(E.share(1920, 110, 1700, 80)).toBe(90)
  })
})
