// The note renderer (web/markdown.js): each run of text knows where it is in the source, the
// visible characters map back to it exactly (so a selection becomes a quote of the note, and a
// quote a highlight), and footnotes become numbered marks with their texts beside the HTML.

import { describe, expect, test } from 'claude-code/testing'
import '../web/markdown.js'
import { demoFiles } from './fixture'

type Cell = { ch: string; s: number; e: number; ts?: number; te?: number; atom?: boolean }
type Note = { label: string; n: number; html: string }
type Api = {
  make: (o: { tex: (s: string, d: boolean) => string; image: (src: string, alt: string, size?: string[]) => string; link: (t: string) => string | null }) => {
    inline: (t: string) => string
    render: (src: string) => { html: string; notes: Note[] }
  }
  cells: (t: string) => Cell[]
  runCells: (t: string, kind: string) => Cell[]
  sourceAt: (cs: Cell[], vis: number, isEnd: boolean, length: number) => number
  cellsIn: (cs: Cell[], s: number, e: number) => [number, number] | null
  lastFootnote: (src: string) => number
  withFootnote: (src: string, at: number, text: string) => { text: string; label: string }
}

const M = (globalThis as unknown as { RftMarkdown: Api }).RftMarkdown
const md = M.make({
  tex: (s, d) => `<span class="katex">${d ? 'D' : 'I'}:${s.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>`,
  image: (src, alt) => `<a class="image"><img src="${src}" alt="${alt}"></a>`,
  link: t => (/^E0\d/.test(t) ? t.split(' ')[0]! : null),
})

const VOID = new Set(['img', 'br', 'hr'])
const decode = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')

/** Each source run of the HTML: its offsets, kind, and visible text with each atom as "\u0000", as the page counts it. */
function runs(html: string) {
  const out: { s: number; e: number; kind: string; text: string }[] = []
  const stack: { run: boolean; atom: boolean }[] = []
  let cur: (typeof out)[number] | null = null
  for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)((?:[^>"]|"[^"]*")*)>|([^<]+)/g)) {
    if (m[4] != null) {
      if (cur && !stack.some(x => x.atom)) cur.text += decode(m[4])
      continue
    }
    const [, close, name, attrs] = m as unknown as [string, string, string, string]
    if (VOID.has(name.toLowerCase())) continue
    if (close) {
      const el = stack.pop()!
      if (el.run) { out.push(cur!); cur = null }
      continue
    }
    const el = { run: false, atom: false }
    if (/ class="[^"]*\bsrc\b/.test(attrs)) {
      el.run = true
      const kind = /data-raw/.test(attrs) ? 'raw' : /data-whole/.test(attrs) ? 'whole' : 'text'
      cur = { s: Number(/data-s="(\d+)"/.exec(attrs)![1]), e: Number(/data-e="(\d+)"/.exec(attrs)![1]), kind, text: kind === 'whole' ? '\u0000' : '' }
      el.atom = kind === 'whole'
    } else if (/\bdata-atom\b/.test(attrs)) {
      if (cur && !stack.some(x => x.atom)) cur.text += '\u0000'
      el.atom = true
    }
    stack.push(el)
  }
  return out
}

const visible = (cs: Cell[]) => cs.map(c => (c.atom ? '\u0000' : c.ch)).join('')

const RICH = `
# E05 · Mixup & CutMix at **1k** images

**Parent:** [[D04 Mixup as an alternative]]
**Status:** done · **Date:** 2026-03-20

## Result
CutMix closes the gap at **1k** (0.3 ± 0.5 points)[^1]; Mixup does *not*. See [[E02 Variant run|the baseline]] and [the paper](https://arxiv.org/abs/1905.04899).
Cost $5 and $10, loss $\\mathcal{L} = x^2$ and \\$ sign; \`code $x$ here\`; ![[fig.png|300]] and ![[Other note]], ![a plot](plots/a.png).
An inline note^[with $y$ and [[E01 First check]]] here, *a* b **c** *d*.

- item with *emphasis* and \`code\`
  continued line [[Missing note]]
    - nested < & > "quotes" [^1]

| a | b \\| c | [[E02 Variant run\\|alias]] |
|---|---|---|
| 1 | **2** | $z$ |

\`\`\`python
x = a ** 2  # not bold **here** [^1]
\`\`\`

$$
\\int_0^1 f
$$

$$ x = 1 $$ trailing text

[^1]: Seeds 0–4, same splits as E02.
    A continued line with $m$.
[^orphan]: Nobody points here.
`

/** The fixture's notes, below their frontmatter. */
function demoBodies(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [path, text] of Object.entries(demoFiles())) {
    if (path.endsWith('.md')) out[path] = text.slice(text.indexOf('\n---', 4) + 5)
  }
  return out
}

describe('source runs', () => {
  test('every run\'s visible text is what cells() says of its source, in the demo notes and a note with every rule', () => {
    const notes = { ...demoBodies(), rich: RICH }
    let checked = 0
    for (const [name, src] of Object.entries(notes)) {
      const { html } = md.render(src)
      for (const r of runs(html)) {
        const cs = M.runCells(src.slice(r.s, r.e), r.kind)
        expect({ name, text: visible(cs) }).toEqual({ name, text: r.text })
        checked++
      }
    }
    expect(checked).toBeGreaterThan(40)
  })

  test('a run covers its source exactly: headings, list items, table cells, code lines, formula blocks', () => {
    const { html } = md.render(RICH)
    const sources = runs(html).map(r => RICH.slice(r.s, r.e))
    expect(sources).toContain('E05 · Mixup & CutMix at **1k** images')
    expect(sources).toContain('item with *emphasis* and `code`')
    expect(sources).toContain('continued line [[Missing note]]')
    expect(sources).toContain('b \\| c')
    expect(sources).toContain('[[E02 Variant run\\|alias]]')
    expect(sources).toContain('x = a ** 2  # not bold **here** [^1]')
    expect(sources).toContain('$$\n\\int_0^1 f\n$$')
    // $$ closed on its own line is display math inside the paragraph
    expect(sources).toContain('$$ x = 1 $$ trailing text')
    // footnote definitions are not part of the text
    expect(sources.some(s => s.includes('Seeds 0–4'))).toBe(false)
  })
})

describe('selections and highlights', () => {
  const line = 'CutMix closes the gap at **1k** (0.3 ± 0.5 points)[^1]; Mixup does *not*. See [[E02 Variant run|the baseline]].'
  const cs = M.cells(line)
  const vis = visible(cs)
  /** The source a selection of the visible text [a, b) stands for. */
  const quote = (a: number, b: number) => line.slice(M.sourceAt(cs, a, false, line.length), M.sourceAt(cs, b, true, line.length))
  const sel = (text: string) => { const a = vis.indexOf(text); return quote(a, a + text.length) }

  test('plain text inside bold or italic is quoted as it is written', () => {
    expect(sel('1k')).toBe('1k')
    expect(sel('0.3 ± 0.5 points')).toBe('0.3 ± 0.5 points')
    expect(sel('at 1k (')).toBe('at **1k** (')
    expect(sel('not')).toBe('not')
  })

  test('a link is never split: part of its label quotes the whole link', () => {
    expect(sel('base')).toBe('[[E02 Variant run|the baseline]]')
    expect(sel('See the')).toBe('See [[E02 Variant run|the baseline]]')
  })

  test('a footnote mark, a formula or code goes whole into a selection that reaches it', () => {
    expect(sel('points)\u0000;')).toBe('points)[^1];')
    const c2 = M.cells('loss $x^2$ and `a b c` end')
    const v2 = visible(c2)
    expect(v2).toBe('loss \u0000 and \u0000 end')
    expect('loss $x^2$ and `a b c` end'.slice(M.sourceAt(c2, 5, false, 99), M.sourceAt(c2, 6, true, 99))).toBe('$x^2$')
  })

  test('a source range is highlighted on the visible characters it covers', () => {
    const at = line.indexOf('1k')
    const [from, to] = M.cellsIn(cs, at, at + 2)!
    expect(vis.slice(from, to)).toBe('1k')
    const link = line.indexOf('[[E02')
    const [lf, lt] = M.cellsIn(cs, link, line.indexOf(']]') + 2)!
    expect(vis.slice(lf, lt)).toBe('the baseline')
    expect(M.cellsIn(cs, line.length, line.length + 5)).toBeNull()
  })
})

describe('footnotes', () => {
  test('marks are numbered in reading order, inline ones too, and their texts come beside the HTML', () => {
    const { html, notes } = md.render(RICH)
    expect(notes.map(n => [n.label, n.n])).toEqual([['1', 1], ['^2', 2]])
    expect(notes[0]!.html).toContain('Seeds 0–4, same splits as E02.<br>A continued line with')
    expect(notes[1]!.html).toContain('<a data-go="E01">E01 First check</a>')
    expect(html).toContain('<sup class="fn-ref" data-fn="1" data-atom>1</sup>')
    expect(html.match(/data-fn="1"/g)).toHaveLength(2) // the same note marked twice
    expect(html).not.toContain('Seeds 0–4')
    // a definition no mark points at still shows, at the end
    expect(html).toMatch(/<div class="fn-orphans"><p><sup class="fn-label">orphan<\/sup> Nobody points here.<\/p><\/div>$/)
  })

  test('a mark without a definition says so', () => {
    const { notes } = md.render('Text[^x].\n')
    expect(notes[0]!.html).toContain('No text for [^x]')
  })

  test('a mark in code or a formula stays text', () => {
    expect(md.render('`a[^1]` and $x[^1]$\n').notes).toEqual([])
    expect(md.render('`^[a-z]+` matches\n').notes).toEqual([])
  })

  test('a new footnote takes the next number, its mark where the selection ends and its text at the end', () => {
    const src = '\n# T\n\nFive seeds here.\n'
    const at = src.indexOf(' here')
    expect(M.withFootnote(src, at, 'Seeds 0-4.')).toEqual({ text: '\n# T\n\nFive seeds[^1] here.\n\n[^1]: Seeds 0-4.\n', label: '1' })
    const withDefs = 'A[^1] b[^3].\n\n[^1]: one\n[^3]: three\n    more\n'
    expect(M.withFootnote(withDefs, withDefs.indexOf('.'), ' two\nlines ').text).toBe('A[^1] b[^3][^4].\n\n[^1]: one\n[^3]: three\n    more\n[^4]: two\n    lines\n')
    expect(M.lastFootnote('x[^a] [^12] [^2]')).toBe(12)
  })
})
