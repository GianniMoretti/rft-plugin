// A document of the first design brought to clean source, once
// (docs/adr/0003-a-document-holds-no-trace.md). The first design kept the link to the tree in the
// document's own text: a copy between `% rft-begin S04 3f2a1c9d` and `% rft-end S04`, numbers,
// figures and tables as macros resolved from the vault when it compiled, \usepackage{rft}. Such a
// document cannot be shared as it is, so it is rewritten as plain LaTeX:
//
//   % rft-begin S04 3f2a1c9d … % rft-end S04   %%% Method: Training setup %%% … %%% end %%%
//   \rftnum, \rftfig, \rfttable, \cite{R07}    written out, in the copies and in the text around them
//   \usepackage{rft}                           the packages and theorem environments it gave, where the document uses them
//   refs.bib of every reference                the document's own refs.bib, of what it cites
//   .blocks.json                               the tracking file, outside the document's folder
//
// Each copy keeps the stamp it had, so one in review stays in review; what it is compared with is
// the snippet it was taken from, written out the same way, so an adapted one stays adapted. The
// document's files as they were are kept beside the tracking file and never overwritten.
// Converting a document that is already clean changes nothing.

import { readingOrder, locateCopies } from './copies'
import { documentFiles } from './scan'
import type { Snippet } from './snippets'
import { BLOCKS_FILE, DOCUMENTS_DIR, ManuscriptError, THEOREMS, contentFingerprint, contentOf, listDocuments, listSnippets, parseBlocks, uncommented } from './snippets'
import type { TrackedValue, Tracking } from './tracking'
import { TRACKING_DIR, readTracking, writeTracking } from './tracking'
import type { Io, Loaded } from './vault'
import { join } from './vault'
import type { WriteContext, WrittenText } from './writeout'
import { labelOf, markedText, markerWords, sameContext, withoutComments, writeContext, writeText } from './writeout'

const TEX_FILE = /\.(tex|ltx)$/i
const CONTEXT = 28

/** Whether a text is of the first design: its markers, its package or its macros. */
export const isFirstDesign = (text: string) =>
  /^\s*%\s*rft-(?:begin|end)\b/m.test(text) || /\\usepackage(?:\[[^\]]*\])?\{rft\}/.test(text) || /\\rft(?:num|fig|table|snippet)\b/.test(uncommented(text))

/** Where a document's files of the first design are kept, beside its tracking file. */
export const keptRel = (name: string, file: string) => `${TRACKING_DIR}/${name}/first-design/${file}`

const OLD_COMMENT = /^% Your text, and copies of snippets between % rft-begin and % rft-end lines: adapt a copy to the\n% narrative as you like; when its snippet changes, the copy is flagged for review\.$/m
const NEW_COMMENT = '% Your text. A passage taken from your notes sits between two comment lines, %%% Kind: title %%%\n% and %%% end %%%: change it as you like, and leave the two lines where they are.'
const THEOREM_NAMES: Record<string, string> = { theorem: 'Theorem', lemma: 'Lemma', proposition: 'Proposition', corollary: 'Corollary', definition: 'Definition' }
const USE_RFT = /^[ \t]*\\usepackage(?:\[[^\]]*\])?\{rft\}[ \t]*(?:%.*)?$/m

/** What rft.sty gave a document, as lines of its own: the packages it loaded and the theorem environments it declared, those the document uses and does not have. */
function preambleLines(all: string): string[] {
  const has = (pkg: string) => new RegExp(`\\\\(?:usepackage|RequirePackage)(?:\\[[^\\]]*\\])?\\{[^}]*\\b${pkg}\\b[^}]*\\}`).test(all)
  const declared = (env: string) => new RegExp(`\\\\(?:newtheorem\\*?|newenvironment|declaretheorem(?:\\[[^\\]]*\\])?)\\{${env}\\}`).test(all)
  const out: string[] = []
  if (/\\includegraphics/.test(all) && !has('graphicx')) out.push('\\usepackage{graphicx}')
  if (/\\(?:toprule|midrule|bottomrule)\b/.test(all) && !has('booktabs')) out.push('\\usepackage{booktabs}')
  const used = THEOREMS.filter(e => new RegExp(`\\\\begin\\{${e}\\}`).test(all) && !declared(e))
  if (!used.length) return out
  const other = has('ntheorem') || has('theorem')
  if (!has('amsthm') && !other) out.push('\\usepackage{amsthm}')
  const styled = !other
  const plain = used.filter(e => e !== 'definition')
  if (plain.length) {
    if (styled) out.push('\\theoremstyle{plain}')
    if (!declared('theorem')) out.push('\\newtheorem{theorem}{Theorem}')
    for (const e of plain) if (e !== 'theorem') out.push(`\\newtheorem{${e}}[theorem]{${THEOREM_NAMES[e]}}`)
  }
  if (used.includes('definition')) {
    if (styled) out.push('\\theoremstyle{definition}')
    out.push('\\newtheorem{definition}{Definition}')
  }
  return out
}

/** What a copy whose snippet is gone says of itself: the environment it opens and that environment's title, else its paragraph's heading. */
function headerOf(content: string): { kind: string; title: string } {
  const env = /\\begin\{(definition|theorem|lemma|proposition|corollary|proof|figure|table)\}(?:\[([^\]]*)\])?/.exec(uncommented(content))
  const caption = /\\caption\{([^}]*)\}/.exec(content)?.[1]
  if (env) return { kind: env[1]!, title: (env[2] ?? caption ?? 'from a snippet that is gone').trim() }
  return { kind: 'passage', title: (/\\paragraph\{([^}]*)\}/.exec(content)?.[1] ?? 'from a snippet that is gone').replace(/[.:]\s*$/, '').trim() }
}

const tracked = (w: WrittenText, file: string): TrackedValue[] => w.values.map(v => ({
  kind: v.kind, from: v.from, key: v.key, written: v.written, file,
  before: w.text.slice(Math.max(0, v.at - CONTEXT), v.at), after: w.text.slice(v.at + v.written.length, v.at + v.written.length + CONTEXT),
}))

/**
 * One document converted; null when nothing of the first design is in it. The answer says what
 * was written out and what is left for the user to look at.
 */
export async function convertDocument(io: Io, loaded: Loaded, snippets: readonly Snippet[], name: string): Promise<string | null> {
  const vault = loaded.config.vault
  const dir = join(vault, DOCUMENTS_DIR, name)
  const files: Record<string, string> = {}
  const others: string[] = []
  for (const f of await documentFiles(io, vault, name)) {
    if (!/\.(tex|ltx|bib)$/i.test(f.rel)) { others.push(f.rel); continue }
    try { files[f.rel] = (await io.read(join(dir, f.rel))).replace(/\r\n/g, '\n') } catch { others.push(f.rel) }
  }
  const tex = Object.keys(files).filter(f => TEX_FILE.test(f))
  if (!tex.some(f => isFirstDesign(files[f]!))) return null
  let taken: Record<string, string> = {}
  try {
    const d = JSON.parse(await io.read(join(dir, BLOCKS_FILE)))
    if (d && typeof d === 'object') taken = d as Record<string, string>
  } catch { /* none recorded: a copy is then compared with its snippet as it is, when its stamp is that snippet's */ }

  const tracking: Tracking = await readTracking(io, vault, name)
  const main = files[tracking.main] !== undefined ? tracking.main : tex.includes('main.tex') ? 'main.tex' : tex[0]!
  const ctx: WriteContext = writeContext(loaded, { files: Object.fromEntries(others.filter(f => f !== BLOCKS_FILE).map(f => [f, ''])) })
  const copies: Tracking['copies'] = []
  const values: TrackedValue[] = []
  const toCopy: WrittenText['files'] = []
  const bib: WrittenText['bib'] = []
  const missing: string[] = []
  const next: Record<string, string> = {}
  const take = (w: WrittenText, file: string) => {
    values.push(...tracked(w, file))
    toCopy.push(...w.files)
    for (const b of w.bib) if (!bib.some(x => x.key === b.key)) bib.push(b)
    missing.push(...w.missing)
    return w.text
  }
  const order = readingOrder(files, main)
  // a copy's label, known before any text is written out: a reference to it may come before the copy
  for (const file of tex) {
    for (const b of parseBlocks(files[file]!)) {
      const s = snippets.find(x => x.id === b.id)
      const own = s ?? headerOf(b.content)
      if (new RegExp(`\\\\label\\{\\s*${b.id}\\s*\\}`).test(b.content) && !ctx.renamed.has(b.id)) ctx.renamed.set(b.id, labelOf(own.kind, own.title))
    }
  }
  for (const file of [...tex].sort((a, b) => order.at(a, 0) - order.at(b, 0))) {
    const lines = files[file]!.replace(OLD_COMMENT, NEW_COMMENT).split('\n')
    const out: string[] = []
    let at = 0
    const outside = async (to: number) => {
      if (to > at) out.push(...take(await writeText(io, loaded, lines.slice(at, to).join('\n'), snippets, ctx, { missing: 'mark' }), file).split('\n'))
    }
    for (const b of parseBlocks(lines.join('\n'))) {
      await outside(b.begin)
      const s = snippets.find(x => x.id === b.id)
      const own = s ?? { id: b.id, ...headerOf(b.content) }
      const marker = markerWords(own.kind, own.title)
      // the snippet as the copy was taken from it, written out as the copy is: what tells an adapted copy from one left as it was
      const then = taken[b.id] ?? (s && contentFingerprint(contentOf(s.text)) === b.stamp ? contentOf(s.text) : null)
      const placed = then === null ? null : (await writeText(io, loaded, withoutComments(then).replace(/^(\s*\n)+/, '').replace(/\s+$/, ''), snippets, sameContext(ctx), { own, missing: 'mark' })).text
      const content = take(await writeText(io, loaded, b.content, snippets, ctx, { own, missing: 'mark' }), file)
      copies.push({ snippet: b.id, marker, file, stamp: b.stamp, placed: placed ?? content })
      out.push(...markedText(marker, content).split('\n'))
      at = b.end + 1
    }
    await outside(lines.length)
    next[file] = out.join('\n')
  }
  // what the package gave, where the document asked for it
  const all = uncommented(Object.values(next).join('\n'))
  const own = preambleLines(all.replace(USE_RFT, ''))
  for (const file of tex) if (USE_RFT.test(next[file]!)) next[file] = next[file]!.replace(USE_RFT, own.join('\n')).replace(/\n{3,}/g, '\n\n')

  // the entries it cites, in a .bib of its own
  const named = /\\bibliography\{([^}]+)\}/.exec(all)?.[1]?.split(',')[0]?.trim() ?? 'refs'
  const bibFile = /\.bib$/i.test(named) ? named : `${named}.bib`
  let bibText = files[bibFile] ?? ''
  const have = new Set([...bibText.matchAll(/^\s*@\w+\s*\{\s*([^,\s]+)\s*,/gm)].map(m => m[1]!))
  for (const e of bib) {
    if (!have.has(e.key)) bibText = `${bibText.replace(/\s+$/, '')}${bibText.trim() ? '\n\n' : ''}${e.entry}\n`
    tracking.bib[e.key] = { from: e.from, file: bibFile }
  }

  // the files as they were, kept once; then the document as it is now
  for (const file of tex) if (next[file] !== files[file] && !(await io.exists(join(vault, keptRel(name, file))))) await io.write(join(vault, keptRel(name, file)), files[file]!)
  if (await io.exists(join(dir, BLOCKS_FILE))) {
    if (!(await io.exists(join(vault, keptRel(name, 'blocks.json'))))) await io.write(join(vault, keptRel(name, 'blocks.json')), await io.read(join(dir, BLOCKS_FILE)))
    await io.remove(join(dir, BLOCKS_FILE))
  }
  for (const f of toCopy) await (io.copy ? io.copy(join(vault, f.from), join(dir, f.to)) : io.read(join(vault, f.from)).then(text => io.write(join(dir, f.to), text)))
  for (const file of tex) if (next[file] !== files[file]) await io.write(join(dir, file), next[file]!)
  if (bib.length || /\\bibliography\{/.test(all)) await io.write(join(dir, bibFile), bibText)
  // the copies in the order the document is read, as the tracking file keeps them
  const located = locateCopies(next, { copies })
  const now = readingOrder(next, main)
  const sorted = [...located].sort((a, b) => now.at(a.file, a.begin ?? 0) - now.at(b.file, b.begin ?? 0)).map(c => copies[c.index]!)
  await writeTracking(io, vault, name, { ...tracking, main, copies: [...tracking.copies, ...sorted], values: [...tracking.values, ...values] })

  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`
  const left = [...new Set(missing)]
  return `${name}: converted to plain LaTeX, which compiles from its folder alone and names nothing of the tree (${n(copies.length, 'copy', 'copies')}, ${n(values.length, 'value')} of the tree written out` +
    `${toCopy.length ? `, ${toCopy.map(f => f.to).join(', ')} copied in` : ''}${bib.length ? `, ${n(bib.length, 'entry', 'entries')} in ${bibFile}` : ''}). ` +
    `Its ${n(tex.filter(f => next[f] !== files[f]).length, 'file')} as ${tex.filter(f => next[f] !== files[f]).length === 1 ? 'it was' : 'they were'}: ${vault}/${TRACKING_DIR}/${name}/first-design/.` +
    (left.length ? ` Written as ?? (no notebook saved it), as it printed before: ${left.join(', ')}.` : '')
}

/** Every document of the first design converted; a line for each one that was. */
export async function convertDocuments(io: Io, loaded: Loaded, only?: string): Promise<string[]> {
  const vault = loaded.config.vault
  const names = (await listDocuments(io, vault)).filter(n => !only || n === only)
  if (only && !names.length) throw new ManuscriptError(`"${only}" is no document`)
  const out: string[] = []
  let snippets: Snippet[] | null = null
  for (const name of names) {
    // a look at its main file first: a clean document costs one read
    let text = ''
    try { text = await io.read(join(vault, DOCUMENTS_DIR, name, 'main.tex')) } catch { continue }
    const others = isFirstDesign(text) ? [] : (await documentFiles(io, vault, name)).filter(f => TEX_FILE.test(f.rel) && f.rel !== 'main.tex')
    let first = isFirstDesign(text)
    for (const f of others) {
      if (first) break
      try { first = isFirstDesign(await io.read(join(vault, DOCUMENTS_DIR, name, f.rel))) } catch { /* not read */ }
    }
    if (!first) continue
    snippets ??= await listSnippets(io, vault)
    const line = await convertDocument(io, loaded, snippets, name)
    if (line) out.push(line)
  }
  return out
}
