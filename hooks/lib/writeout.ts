// A snippet written out as plain LaTeX (docs/adr/0003-a-document-holds-no-trace.md). A snippet
// stays in the vault and keeps the macros that take the tree's numbers, figures and tables; what a
// document holds of it is plain LaTeX, which compiles anywhere and names nothing of the tree:
//
//   \rftnum{E05}{acc.1k}              73.2                      the number as the notebook saved it
//   \rftfig[width=…]{E08}{loss}       \includegraphics[width=…]{figures/loss.pdf}, the file to copy in
//   \rfttable{E08}{by_seed}           the tabular itself
//   \cite{R07}                        \cite{yun2019cutmix}, the entry to add to the document's .bib
//   \label{S01}, \ref{S01}            \label{def:cutmix}, \ref{def:cutmix}: from the kind and the title
//   % a comment                       left out: a snippet's comments are notes to oneself
//
// `writeOut` gives the text, each value it wrote with its place in that text (so the document's
// tracking file can watch it), the files to copy and the entries to add. It writes nothing itself.
// A macro that names nothing saved refuses the whole snippet, and so does a text that would carry
// a trace (an id in its words or its title).

import { citeIndex, macroProblems } from './manuscript'
import type { Snippet } from './snippets'
import { ManuscriptError, contentOf } from './snippets'
import { tracesInText } from './scan'
import type { ValueKind } from './tracking'
import type { Io, Loaded } from './vault'
import { isLiterature, join, resolveId, sectionText } from './vault'

// ---------------------------------------------------------------- what a note's run saved, as text

/** A number of a JSON text, kept as it is written there: 73.0 stays 73.0, as the notebook rounded it. */
class Raw { constructor(readonly text: string) {} }

/** JSON read with its numbers kept as written (JSON.parse would make 73.0 into 73); also Python's NaN and Infinity. */
export function parseKeepingNumbers(s: string): unknown {
  let i = 0
  const ws = () => { while (i < s.length && /\s/.test(s[i]!)) i++ }
  const fail = (): never => { throw new SyntaxError(`not JSON at ${i}`) }
  const value = (): unknown => {
    ws()
    const c = s[i]
    if (c === '{') {
      i++
      const out: Record<string, unknown> = {}
      ws()
      if (s[i] === '}') { i++; return out }
      for (;;) {
        ws()
        const key = value()
        if (typeof key !== 'string') fail()
        ws()
        if (s[i++] !== ':') fail()
        out[key as string] = value()
        ws()
        const sep = s[i++]
        if (sep === '}') return out
        if (sep !== ',') fail()
      }
    }
    if (c === '[') {
      i++
      const out: unknown[] = []
      ws()
      if (s[i] === ']') { i++; return out }
      for (;;) {
        out.push(value())
        ws()
        const sep = s[i++]
        if (sep === ']') return out
        if (sep !== ',') fail()
      }
    }
    if (c === '"') {
      let j = i + 1
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1
      if (j >= s.length) fail()
      const text = JSON.parse(s.slice(i, j + 1)) as string
      i = j + 1
      return text
    }
    const word = /^(?:true|false|null|-?Infinity|NaN|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(s.slice(i, i + 40))?.[0]
    if (!word) return fail()
    i += word.length
    return word === 'true' ? true : word === 'false' ? false : word === 'null' ? null : new Raw(word)
  }
  const out = value()
  ws()
  if (i < s.length) fail()
  return out
}

const TEX_SPECIAL: Record<string, string> = {
  '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', $: '\\$', '#': '\\#', _: '\\_', '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
}
/** Text as LaTeX typesets it: its special characters escaped, ± as math (tex_text in server/rft_results.py). */
export const texEscape = (s: string) => [...s].map(ch => TEX_SPECIAL[ch] ?? ch).join('').replace(/±/g, '$\\pm$')

/**
 * The numbers a note's run saved (results/<id>.json), each as the text a document holds: as the
 * notebook rounded it, escaped for LaTeX. What rft-numbers.tex gives \rftnum (numbers_tex in
 * server/rft_latex.py). Null when the note has no saved run.
 */
export async function savedNumbers(io: Io, vault: string, id: string): Promise<Record<string, string> | null> {
  let d: unknown
  try { d = parseKeepingNumbers(await io.read(join(vault, 'results', `${id}.json`))) } catch { return null }
  const out: Record<string, string> = {}
  const visit = (x: unknown, key: string) => {
    if (Array.isArray(x)) x.forEach((v, k) => visit(v, `${key}[${k}]`))
    else if (x instanceof Raw) { if (key) out[key] = texEscape(x.text) }
    else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) visit(v, key ? `${key}.${k}` : k)
    else if (typeof x === 'string' && key) out[key] = texEscape(x)
  }
  visit(d && typeof d === 'object' ? (d as Record<string, unknown>).results : null, '')
  for (const k of Object.keys(out)) if (/[{}]/.test(k)) delete out[k]
  return out
}

/** Where the vault keeps a note's figure for LaTeX, and a table's tabular. */
export const figureRel = (id: string, name: string) => `figures/${id}_${name}.pdf`
export const tableRel = (id: string, name: string) => `tables/${id}_${name}.tex`

// ---------------------------------------------------------------- the words a document may carry

const KIND_LABEL: Record<string, string> = {
  definition: 'def', theorem: 'thm', lemma: 'lem', proposition: 'prop', corollary: 'cor', proof: 'proof', figure: 'fig', table: 'tab',
  method: 'meth', result: 'res', 'related-work': 'rel', motivation: 'mot', discussion: 'disc',
}

/** A title as part of a label or a key: lower case, its words joined by dashes. */
export const slug = (title: string) =>
  title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'untitled'

/** A snippet's label in a document, from its kind and its title: `def:cutmix`. */
export const labelOf = (kind: string, title: string) => `${KIND_LABEL[kind] ?? 'sec'}:${slug(title)}`

/** A marker's words: the kind and the title, what any reader may know (`Definition: CutMix`). */
export function markerWords(kind: string, title: string): string {
  const k = (kind || 'snippet').replace(/-/g, ' ')
  return `${k[0]!.toUpperCase()}${k.slice(1)}: ${title.replace(/%/g, '').replace(/\s+/g, ' ').trim()}`
}

/** A copy between its two marker lines, as a document holds it. */
export const markedText = (marker: string, content: string) => `%%% ${marker} %%%\n${content}\n%%% end %%%`

/** The text without its comments: a line that is only a comment is left out; a comment after text leaves its % (it may hold a line together). */
export const withoutComments = (text: string) =>
  text.split('\n').flatMap(l => (/^\s*%/.test(l) ? [] : [l.replace(/(^|[^\\])%.+$/, '$1%')])).join('\n')

// ---------------------------------------------------------------- citations

/** Each BibTeX entry of a note's ```bibtex blocks, with its key. */
export function bibEntries(noteText: string): { key: string; entry: string }[] {
  const out: { key: string; entry: string }[] = []
  for (const block of noteText.matchAll(/```bibtex\n([\s\S]*?)```/g)) {
    const b = block[1]!
    const re = /@\w+\s*\{\s*([^,\s]+)\s*,/g
    for (let m = re.exec(b); m; m = re.exec(b)) {
      let depth = 0, i = b.indexOf('{', m.index)
      for (; i < b.length; i++) {
        if (b[i] === '{') depth++
        else if (b[i] === '}' && --depth === 0) break
      }
      out.push({ key: m[1]!, entry: b.slice(m.index, i + 1).trim() })
      re.lastIndex = i + 1
    }
  }
  return out
}

const LINK_RE = /(https?:\/\/\S+|\b10\.\d{4,9}\/\S+|\barXiv:\s*\d{4}\.\d{4,5}(?:v\d+)?)/i

/**
 * The entry a document's .bib takes for a citation key of a snippet: a reference note cited by its
 * id gives its own entry under that entry's key (a note with no BibTeX gives a @misc keyed by its
 * title); a key of an entry gives that entry. Null: the tree does not know the key, so it is the
 * document's own.
 */
export function citationOf(loaded: Loaded, cites: Record<string, string>, key: string): { key: string; from: string; entry: string } | null {
  const id = cites[key]
  const n = id ? loaded.tree.nodes[id] : undefined
  if (!id || !n) return null
  const text = loaded.texts[id] ?? ''
  const entries = bibEntries(text)
  if (key !== id) {
    const e = entries.find(x => x.key === key)
    return e ? { key, from: id, entry: e.entry } : null
  }
  if (isLiterature(n)) {
    throw new ManuscriptError(`\\cite{${id}}: ${id} is a literature note, which holds many papers: cite one by its own key (${entries.map(e => e.key).join(', ') || 'none has a BibTeX entry yet'})`)
  }
  if (entries.length) return { key: entries[0]!.key, from: id, entry: entries[0]!.entry }
  const own = slug(n.title).replace(/-/g, '').slice(0, 30)
  const link = LINK_RE.exec(sectionText(text, 'Source'))?.[1]?.replace(/[.,;)]+$/, '') ?? ''
  const how = link.startsWith('http') ? `,\n  howpublished = {\\url{${link}}}` : link ? `,\n  note = {${texEscape(link)}}` : ''
  return { key: own, from: id, entry: `@misc{${own},\n  title = {{${texEscape(n.title)}}}${how}\n}` }
}

// ---------------------------------------------------------------- writing out

/** A value of the tree as a text holds it once written out: what it is, where it came from, and where it sits in the text. */
export type WrittenValue = { kind: ValueKind; from: string; key: string; written: string; at: number }
export type Written = {
  /** The snippet's text as plain LaTeX. */
  text: string
  /** Its marker's words. */
  marker: string
  values: WrittenValue[]
  /** The files to copy: from the vault (`figures/E08_loss.pdf`) into the document (`figures/loss.pdf`). */
  files: { from: string; to: string }[]
  /** The entries its citations need in the document's .bib. */
  bib: { key: string; from: string; entry: string }[]
  /** The labels it defines. */
  labels: string[]
}

/** What the document already holds, so that nothing is defined or copied twice. */
export type Held = {
  /** The labels its files define. */
  labels?: Iterable<string>
  /** Its files that came from the tree, by their path in the document, each with its source (`E08 loss`); '' for a file that did not. */
  files?: Record<string, string>
}

const CITE_NAMES = 'cite|citep|citet|citealp|citealt|citeauthor|citeyear|citeyearpar|parencite|textcite|autocite|footcite|fullcite|nocite'
const MACRO_RE = new RegExp([
  '\\\\rftnum\\{([^}]*)\\}\\{([^}]*)\\}', // 1, 2
  '\\\\rftfig(\\[[^\\]]*\\])?\\{([^}]*)\\}\\{([^}]*)\\}', // 3, 4, 5
  '\\\\rfttable\\{([^}]*)\\}\\{([^}]*)\\}', // 6, 7
  `\\\\(?:${CITE_NAMES})\\*?(?:\\[[^\\]]*\\]){0,2}\\{([^}]*)\\}`, // 8
  '\\\\label\\{([^}]*)\\}', // 9
  '\\\\(?:ref|cref|Cref|autoref|eqref|nameref|pageref|vref)\\{([^}]*)\\}', // 10
].join('|'), 'g')

/** `base`, or `base-2`, `base-3`… when it is taken. */
function free(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base
  for (let k = 2; ; k++) if (!taken(`${base}-${k}`)) return `${base}-${k}`
}

/**
 * A snippet's text as a document holds it. `snippets`: every snippet, for a reference to another
 * one (\ref{S02}); `ids`: the ids of the vault's notes and snippets, which the result must not
 * carry; `held`: what the document already has.
 */
export async function writeOut(io: Io, loaded: Loaded, s: Snippet, snippets: readonly Snippet[], ids: ReadonlySet<string>, held: Held = {}): Promise<Written> {
  const vault = loaded.config.vault
  const problems = await macroProblems(io, loaded, s.text)
  if (problems.length) throw new ManuscriptError(`${s.id} cannot be placed: its macros name what no notebook saved:\n${problems.join('\n')}`)
  const source = withoutComments(contentOf(s.text)).replace(/^(\s*\n)+/, '').replace(/\s+$/, '')
  const cites = citeIndex(loaded)
  const numbers: Record<string, Record<string, string> | null> = {}
  const labelsHeld = new Set(held.labels ?? [])
  const filesHeld: Record<string, string> = { ...(held.files ?? {}) }
  const out: Written = { text: '', marker: markerWords(s.kind, s.title), values: [], files: [], bib: [], labels: [] }

  // the labels the snippet defines, each given a name the document does not have yet
  const renamed = new Map<string, string>()
  for (const m of source.matchAll(/\\label\{([^}]*)\}/g)) {
    const name = m[1]!.trim()
    if (renamed.has(name)) continue
    const label = free(name === s.id ? labelOf(s.kind, s.title) : name, l => labelsHeld.has(l))
    renamed.set(name, label)
    labelsHeld.add(label)
    out.labels.push(label)
  }
  const refTo = (name: string) => {
    const other = snippets.find(x => x.id === name)
    return renamed.get(name) ?? (other ? labelOf(other.kind, other.title) : name)
  }

  let text = '', last = 0
  for (const m of source.matchAll(MACRO_RE)) {
    text += source.slice(last, m.index!)
    last = m.index! + m[0].length
    const value = (kind: ValueKind, from: string, key: string, written: string, lead = '', tail = '') => {
      out.values.push({ kind, from, key, written, at: text.length + lead.length })
      text += lead + written + tail
    }
    if (m[1] !== undefined) {
      const id = resolveId(loaded.tree, m[1].trim()) ?? m[1].trim(), key = m[2]!.trim()
      const saved = id in numbers ? numbers[id]! : (numbers[id] = await savedNumbers(io, vault, id))
      const written = saved?.[key]
      if (written === undefined) throw new ManuscriptError(`${s.id} cannot be placed: \\rftnum{${m[1]}}{${key}} is not a number or a text (${id}'s saved RESULTS give it no value to write)`)
      value('number', id, key, written)
    } else if (m[4] !== undefined) {
      const id = resolveId(loaded.tree, m[4].trim()) ?? m[4].trim(), name = m[5]!.trim()
      const from = figureRel(id, name)
      if (!(await io.exists(join(vault, from)))) {
        throw new ManuscriptError(`${s.id} cannot be placed: ${id}'s figure ${name} has no PDF (${vault}/${from}); a notebook saves one for a matplotlib figure`)
      }
      const src = `${id} ${name}`
      const to = free(`figures/${name}`, base => (filesHeld[`${base}.pdf`] ?? src) !== src) + '.pdf'
      if (filesHeld[to] === undefined) out.files.push({ from, to })
      filesHeld[to] = src
      value('figure', id, name, to, `\\includegraphics${m[3] ?? ''}{`, '}')
    } else if (m[6] !== undefined) {
      const id = resolveId(loaded.tree, m[6].trim()) ?? m[6].trim(), name = m[7]!.trim()
      let tabular: string
      try { tabular = (await io.read(join(vault, tableRel(id, name)))).replace(/\r\n/g, '\n').trim() } catch {
        throw new ManuscriptError(`${s.id} cannot be placed: ${id}'s table ${name} has no LaTeX (${vault}/${tableRel(id, name)})`)
      }
      value('table', id, name, tabular)
    } else if (m[8] !== undefined) {
      const keys = m[8].split(',').map(k => k.trim()).filter(Boolean).map(k => {
        const c = citationOf(loaded, cites, k)
        if (!c) return k
        if (!out.bib.some(b => b.key === c.key)) out.bib.push(c)
        return c.key
      })
      text += m[0].slice(0, m[0].lastIndexOf('{') + 1) + keys.join(',') + '}'
    } else if (m[9] !== undefined) {
      text += `\\label{${renamed.get(m[9].trim()) ?? m[9]}}`
    } else {
      text += m[0].slice(0, m[0].lastIndexOf('{') + 1) + m[10]!.split(',').map(r => refTo(r.trim())).join(',') + '}'
    }
  }
  out.text = text + source.slice(last)

  const traces = [...tracesInText(out.text, ids), ...tracesInText(out.marker, ids)]
  if (traces.length) {
    throw new ManuscriptError(`${s.id} cannot be placed: written out, it would still carry a trace of the tree, which a document's files must not (${[...new Set(traces.map(t => `${t.match} in "${t.text.slice(0, 80)}"`))].join('; ')}). ` +
      'Say it in the snippet without the id or the macro, or take the number, the figure or the table with \\rftnum, \\rftfig or \\rfttable.')
  }
  return out
}
