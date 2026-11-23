// The inbox: links the user saved to read later, in one markdown file at the vault's top (Inbox.md,
// beside the scratchpad's), outside the tree. The file is the user's: they paste into it and edit
// it in Obsidian, so it is read as it is typed and nothing here rewrites it. A write changes single
// lines and leaves the rest as it was.
//
//     # Inbox
//
//     - [Mixup at scale](https://arxiv.org/abs/2406.01234) — maybe relevant to D04 · high · added 2026-11-16
//       - briefed 2026-11-23: claims …
//     - https://example.org/blog/post
//
//     ## Processed
//
//     - 2026-11-23 https://example.org/blog/post — discarded: superseded by R07
//
// An item is a top-level list line that starts with a link: a markdown link, a URL, an arXiv id or
// a DOI. After the link, parts set apart by `·`: why it was saved (after a dash), its reading
// priority as one word, `added <date>`. A brief is the indented list lines under it, the first
// starting `briefed <date>:`. Any other line is not an item.
//
// server/rft_inbox.py reads and writes the same file the same way, pattern for pattern, and
// tests/fixtures/inbox holds both to one file and one list of cases. So that the two cannot differ
// on a line no case has, nothing here is left to what JavaScript and Python each take a word to
// mean: white space is the set spelled out in WS (not `\s` or `trim()`), digits are `[0-9]`, no
// pattern has the `u` flag (letters match without case in ASCII alone), and `.` takes any character
// (the `s` flag). A change to a pattern here is a change to the same pattern there.

import { cite } from './manual'
import type { Io, Loaded } from './vault'
import { isLiterature, join, resolveId } from './vault'

export const INBOX = 'Inbox.md'
/** The reading priorities, the most pressing first; an item may have none. */
export const READING_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const

/** What cannot be added to the inbox, in words for the user. */
export class InboxError extends Error {}

export type Brief = { date: string; lines: string[] }
/** An item as the page and the tool show it. `key` is what it is: the same paper has the same key however its link was typed. */
export type InboxItem = { key: string; url: string; title: string; why: string; priority: string; added: string; duplicate: boolean; brief: Brief | null }
export type ProcessedItem = { date: string; key: string; title: string; outcome: string }
/**
 * The file as read: its lines, as they are, and what they hold, in the file's order. Each line is
 * apart from how it ended (`cr`: with a carriage return before its newline), so that a file goes
 * back with the endings it had, mixed or not. `at`: an item's first line, and one past its last.
 */
export type Inbox = { crlf: boolean; lines: string[]; cr: boolean[]; items: (InboxItem & { at: [number, number] })[]; processed: ProcessedItem[] }

/** White space, for inside a character class. */
const WS = String.raw` \t\n\v\f\r   -     　`
const rx = (pattern: string, nocase = false, all = false) => new RegExp(pattern, `s${nocase ? 'i' : ''}${all ? 'g' : ''}`)

const EDGES = rx(`^[${WS}]+|[${WS}]+$`, false, true)
const SPACES = rx(`[${WS}]+`, false, true)
const SPACE = rx(`^[${WS}]`)
const ARXIV_ID = String.raw`(?:[0-9]{4}\.[0-9]{4,5}|[a-z-]+(?:\.[A-Z]{2})?/[0-9]{7})`
const ARXIV_URL = rx(String.raw`^https?://(?:www\.|export\.)?arxiv\.org/(?:abs|pdf|html)/(${ARXIV_ID})(?:v[0-9]+)?(?:\.pdf)?/?(?:[?#].*)?$`, true)
const ARXIV_BARE = rx(String.raw`^(?:arxiv:[${WS}]*)?(${ARXIV_ID})(?:v[0-9]+)?$`, true)
const DOI_ID = String.raw`10\.[0-9]{4,9}/[^${WS}]+`
const DOI_URL = rx(String.raw`^https?://(?:dx\.)?doi\.org/(${DOI_ID})$`, true)
const DOI_BARE = rx(String.raw`^(?:doi:[${WS}]*)?(${DOI_ID})$`, true)
// a web address in its parts: scheme, host, path, query; the fragment is not part of what it is
const URL_PARTS = rx(String.raw`^(https?)://([^/?#${WS}]+)([^?#]*)(?:\?([^#]*))?(?:#.*)?$`, true)
// a link at the start of an item: [title](target), <target>, or the target itself
const MD_LINK = rx(String.raw`^\[([^\]]*)\]\([${WS}]*<?([^)${WS}>]+)>?[${WS}]*\)`)
const ANGLE = rx(String.raw`^<([^>${WS}]+)>`)
const BARE = rx(String.raw`^(?:https?://[^${WS}]+|arxiv:[${WS}]*${ARXIV_ID}(?:v[0-9]+)?|${ARXIV_ID}(?:v[0-9]+)?|doi:[${WS}]*${DOI_ID}|${DOI_ID})`, true)
const WEB = rx('^https?://', true)
// the links anywhere in a text (a reference's Source): a URL, an arXiv id said to be one, a DOI
const LINKS = String.raw`(https?://[^${WS})>\]"']+)|\barxiv(?:\.org/(?:abs|pdf|html)/|:?[${WS}]*)(${ARXIV_ID})(?:v[0-9]+)?(?![0-9])`
  + String.raw`|\b(10\.[0-9]{4,9}/[^${WS})>\]"']+)`
const ITEM = rx(String.raw`^[-*+][ \t]+(.*)$`)
const SUB = rx(String.raw`^[ \t]+[-*+][ \t]+(.*)$`)
const PROCESSED = rx(String.raw`^##[ \t]+processed[ \t]*$`, true)
const HEADING = rx(String.raw`^#{1,2}[ \t]`)
const SOURCE = rx(String.raw`^##[ \t]+Source[ \t]*$`)
const BRIEFED = rx(String.raw`^briefed[ \t]+([0-9]{4}-[0-9]{2}-[0-9]{2})[ \t]*:?[ \t]*(.*)$`, true)
const ADDED = rx(String.raw`^added[ \t]+([0-9]{4}-[0-9]{2}-[0-9]{2})$`, true)
const DATED = rx(String.raw`^([0-9]{4}-[0-9]{2}-[0-9]{2})[ \t]+(.*)$`)
const DASH = rx(String.raw`^(?:—|–|->|-{1,2}|→)[ \t]*`) // `->` before `-`, or its `>` is left behind
const ENDS = rx(String.raw`[.,;]+$`) // what ends a sentence, not an address
const MARKER = rx(String.raw`^[-*+][ \t]+`)

export const strip = (text: string) => text.replace(EDGES, '')
const oneLine = (text: string | undefined) => strip((text ?? '').replace(SPACES, ' '))

/**
 * A link's identity and the address that opens it: `arxiv:<id>` whatever the form the paper was
 * given in (abs, pdf, html, a version), `doi:<doi>`, or the URL without its fragment and trailing
 * slash. Null when it is none of these.
 */
export function targetOf(target: string): { key: string; url: string } | null {
  const t = strip(target)
  let m = ARXIV_URL.exec(t) ?? ARXIV_BARE.exec(t)
  if (m) return { key: `arxiv:${m[1]}`, url: `https://arxiv.org/abs/${m[1]}` }
  m = DOI_URL.exec(t) ?? DOI_BARE.exec(t)
  if (m) return { key: `doi:${m[1]!.toLowerCase()}`, url: `https://doi.org/${m[1]}` }
  m = URL_PARTS.exec(t)
  if (!m) return null
  const [, scheme, host, path, query] = m
  return { key: `${scheme!.toLowerCase()}://${host!.toLowerCase()}${path!.replace(/\/+$/, '')}${query ? `?${query}` : ''}`, url: t }
}

/** The link a line's text starts with: its key, its address, its title and the text after it. */
export function linkAt(text: string): { key: string; url: string; title: string; tail: string } | null {
  let m = MD_LINK.exec(text)
  if (m) {
    const got = targetOf(m[2]!)
    return got ? { ...got, title: strip(m[1]!), tail: text.slice(m[0].length) } : null
  }
  m = ANGLE.exec(text)
  if (m) {
    const got = targetOf(m[1]!)
    return got ? { ...got, title: '', tail: text.slice(m[0].length) } : null
  }
  m = BARE.exec(text)
  if (!m || (m[0].length < text.length && !SPACE.test(text[m[0].length]!))) return null
  const got = targetOf(WEB.test(m[0]) ? m[0].replace(ENDS, '') : m[0])
  return got ? { ...got, title: '', tail: text.slice(m[0].length) } : null
}

/**
 * What follows an item's link: why it was saved, its reading priority, the day it was added. A
 * priority word counts only as a part of its own (or as all there is): inside a why it is the why's.
 */
export function tailOf(tail: string): { why: string; priority: string; added: string } {
  const why: string[] = []
  let priority = '', added = ''
  for (const part of strip(tail).replace(DASH, '').split('·').map(strip)) {
    const a = ADDED.exec(part)
    if (a && !added) added = a[1]!
    else if ((READING_PRIORITIES as readonly string[]).includes(part.toLowerCase()) && !priority) priority = part.toLowerCase()
    else if (part) why.push(part)
  }
  return { why: why.join(' · '), priority, added }
}

/** The identities of the links a text names, each once, in its order. */
export function linksIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(rx(LINKS, true, true))) {
    const [, url, arxiv, doi] = m
    const key = url ? targetOf(url.replace(ENDS, ''))?.key : arxiv ? `arxiv:${arxiv}` : doi ? `doi:${doi.replace(ENDS, '').toLowerCase()}` : ''
    if (key && !out.includes(key)) out.push(key)
  }
  return out
}

/** A note's `## Source` section (a reference says there what it is a note of), else nothing. */
export function sourceOf(note: string): string {
  const out: string[] = []
  let inside = false
  for (const line of note.replace(/\r\n/g, '\n').split('\n')) {
    if (HEADING.test(line)) inside = SOURCE.test(line)
    else if (inside) out.push(line)
  }
  return out.join('\n')
}

/** An item's line as the plugin writes it. */
export function itemLine(url: string, title = '', why = '', priority = '', added = ''): string {
  const parts = [priority, added ? `added ${added}` : ''].filter(Boolean)
  return `- ${title ? `[${title}](${url})` : url}${why ? ` — ${why}` : ''}${parts.map(p => ` · ${p}`).join('')}`
}

/** Reads the file's text. */
export function readInbox(text: string): Inbox {
  const raw = text.split('\n')
  const cr = raw.map((line, n) => n < raw.length - 1 && line.endsWith('\r'))
  return readLines(raw.map((line, n) => (cr[n] ? line.slice(0, -1) : line)), cr, cr.includes(true))
}

function readLines(lines: string[], cr: boolean[], crlf: boolean): Inbox {
  const box: Inbox = { crlf, lines, cr, items: [], processed: [] }
  const seen = new Set<string>()
  let done = false
  for (let i = 0; i < box.lines.length;) {
    const line = box.lines[i++]!
    if (HEADING.test(line)) {
      done = PROCESSED.test(line)
      continue
    }
    const m = ITEM.exec(line)
    if (!m) continue
    const rest = strip(m[1]!)
    if (done) {
      const d = DATED.exec(rest)
      const got = linkAt(d ? d[2]! : rest)
      if (got) box.processed.push({ date: d ? d[1]! : '', key: got.key, title: got.title, outcome: strip(strip(got.tail).replace(DASH, '')) })
      continue
    }
    const got = linkAt(rest)
    if (!got) continue
    const subs: string[] = []
    for (let s = SUB.exec(box.lines[i] ?? ''); i < box.lines.length && s; s = SUB.exec(box.lines[i] ?? '')) {
      subs.push(strip(s[1]!))
      i++
    }
    const b = subs.length ? BRIEFED.exec(subs[0]!) : null
    const brief = b ? { date: b[1]!, lines: [strip(b[2]!), ...subs.slice(1)].filter(Boolean) } : null
    box.items.push({ key: got.key, url: got.url, title: got.title, ...tailOf(got.tail), duplicate: seen.has(got.key), brief, at: [i - subs.length - 1, i] })
    seen.add(got.key)
  }
  return box
}

/** The file again: as it was read, when nothing changed. */
export const inboxText = (box: Inbox): string => box.lines.map((line, n) => (box.cr[n] ? `${line}\r` : line)).join('\n')

/** The items as the page and the tool show them (without their place in the file), each field in the page's order. */
export const shown = (box: Inbox): InboxItem[] =>
  box.items.map(({ key, url, title, why, priority, added, duplicate, brief }) => ({ key, url, title, why, priority, added, duplicate, brief }))

/** What already holds this link: the first item with it, else the latest processed item with it. */
export function findIn(box: Inbox, key: string): { item: InboxItem } | { processed: ProcessedItem } | null {
  const item = box.items.find(i => i.key === key)
  if (item) return { item }
  const processed = box.processed.filter(p => p.key === key).pop()
  return processed ? { processed } : null
}

export type AddInput = { link: string; why?: string; priority?: string; title?: string; today?: string }

/**
 * The file with one more item at the end of its open list (before the processed ones), as one new
 * line, and the item. The caller looks for a duplicate first (`findIn`). InboxError when the link
 * is none, the reading priority is not one, or the line would not read back as meant.
 */
export function addTo(box: Inbox, input: AddInput): { box: Inbox; item: InboxItem } {
  const got = linkAt(oneLine(input.link))
  if (!got || strip(got.tail)) throw new InboxError('not a link: give a URL, an arXiv id or a DOI')
  const why = oneLine(input.why), priority = oneLine(input.priority).toLowerCase(), today = input.today ?? ''
  const title = oneLine(input.title || got.title).replace(/\[/g, '(').replace(/\]/g, ')')
  if (priority && !(READING_PRIORITIES as readonly string[]).includes(priority)) {
    throw new InboxError(`a reading priority is ${READING_PRIORITIES.slice(0, -1).join(', ')} or ${READING_PRIORITIES[READING_PRIORITIES.length - 1]}`)
  }
  let line: string | null = null
  for (const t of title ? [title, ''] : ['']) { // a title the line cannot carry is left out
    const back = shown(readInbox(itemLine(got.url, t, why, priority, today)))
    const b = back[0]
    if (back.length === 1 && b && b.key === got.key && b.title === t && b.why === why && b.priority === priority && b.added === today) {
      line = itemLine(got.url, t, why, priority, today)
      break
    }
  }
  if (line === null) throw new InboxError('the why would read as a reading priority or a date: say it in other words')
  let lines: string[], cr: boolean[], at: number
  if (!box.lines.some(l => strip(l))) [lines, cr, at] = [['# Inbox', '', line, ''], [box.crlf, box.crlf, box.crlf, false], 2]
  else {
    // the end of the open list: before the processed heading and the blank lines above it
    const found = box.lines.findIndex(l => PROCESSED.test(l))
    const stop = found < 0 ? box.lines.length : found
    let end = stop
    while (end > 0 && !strip(box.lines[end - 1]!)) end--
    // after free text or a heading, a blank line first; one after it when nothing follows or the
    // processed heading is right there
    const before = end > 0 && !(ITEM.test(box.lines[end - 1]!) || SUB.test(box.lines[end - 1]!)) ? [''] : []
    const after = end === stop ? [''] : []
    const put = [...before, line, ...after]
    lines = [...box.lines.slice(0, end), ...put, ...box.lines.slice(end)]
    cr = [...box.cr.slice(0, end), ...put.map(() => box.crlf), ...box.cr.slice(end)]
    if (end === box.lines.length) cr[end - 1] = box.crlf // the last line had no ending: it has the file's now
    cr[cr.length - 1] = false // nothing ends the last line
    at = end + before.length
  }
  const next = readLines(lines, cr, box.crlf)
  return { box: next, item: shown(next)[next.items.findIndex(i => i.at[0] === at)]! }
}

/** The item with this link: the first, or the `nth` after it when the link was typed more than once. */
export const nthItem = (box: Inbox, key: string, nth = 0): Inbox['items'][number] | null => (nth >= 0 ? box.items.filter(i => i.key === key)[nth] ?? null : null)

/** New lines before line `end` (after the last one, when there is none), with the file's endings. */
function put(lines: string[], cr: boolean[], crlf: boolean, end: number, add: string[]): void {
  if (end === lines.length && end > 0) cr[end - 1] = crlf // the last line had no ending: it has the file's now
  lines.splice(end, 0, ...add)
  cr.splice(end, 0, ...add.map(() => crlf))
  cr[cr.length - 1] = false // nothing ends the last line
}

/** A brief is short: read in a minute, shown whole in the panel. */
export const BRIEF_LINES = 3
export const BRIEF_LINE_CHARS = 400

/**
 * The file with a brief under an item: at most three indented lines, the first saying the day. A
 * brief the item had is replaced whole; indented lines of the user's that are no brief stay, after
 * it. Null when the inbox has no such item; InboxError when the brief is empty or too long.
 */
export function briefOn(box: Inbox, key: string, nth: number, brief: string, today: string): { box: Inbox; item: InboxItem } | null {
  const item = nthItem(box, key, nth)
  if (!item) return null
  // as it may be given: a list, its first line saying "briefed <day>:" already
  const said = brief.split('\n').map(l => oneLine(l).replace(MARKER, '')).map((l, n) => (n === 0 ? strip(BRIEFED.exec(l)?.[2] ?? l) : l)).filter(l => l && !MARKER.test(`${l} `))
  if (!said.length) throw new InboxError('a brief says what the item claims, which notes of the tree it touches and the outcome you recommend')
  if (said.length > BRIEF_LINES) throw new InboxError(`a brief is at most ${BRIEF_LINES} lines and this has ${said.length}: what the item claims, which notes of the tree it touches, the outcome you recommend`)
  if (said.some(l => l.length > BRIEF_LINE_CHARS)) throw new InboxError(`a line of a brief is at most ${BRIEF_LINE_CHARS} characters: the user decides from it in a minute`)
  const lines = [...box.lines], cr = [...box.cr]
  const [a, b] = item.at
  if (item.brief) {
    lines.splice(a + 1, b - a - 1)
    cr.splice(a + 1, b - a - 1)
  }
  put(lines, cr, box.crlf, a + 1, said.map((l, n) => `  - ${n === 0 ? `briefed ${today}: ` : ''}${l}`))
  const next = readLines(lines, cr, box.crlf)
  const now = next.items.find(i => i.at[0] === a)
  if (!now?.brief || now.brief.date !== today || said.some((l, n) => now.brief!.lines[n] !== l)) throw new InboxError('the brief would not read back as written: say it in other words')
  return { box: next, item: shown(next)[next.items.indexOf(now)]! }
}

/**
 * The file with an item taken out of the inbox and what was decided for it: its line and its brief
 * go (and a blank line with them, where that would leave two together or one at the file's top),
 * and one line with the day, the link and the outcome is added at the end of the processed ones
 * (under a `## Processed` heading, made when there is none). An outcome that starts with an arrow
 * is the note the item became (`→ R15`) and is written as it is; any other follows a dash
 * (`— discarded: why`). Null when the inbox has no such item. As server/rft_inbox.py's `close`.
 */
export function closeIn(box: Inbox, key: string, nth = 0, outcome = 'discarded', today = ''): { box: Inbox; processed: ProcessedItem } | null {
  const item = nthItem(box, key, nth)
  if (!item) return null
  const said = oneLine(outcome)
  const arrow = said.startsWith('→')
  let line: string | null = null
  let want: ProcessedItem | null = null
  for (const t of item.title ? [item.title, ''] : ['']) { // a title the line cannot carry is left out
    const made = `- ${today ? `${today} ` : ''}${t ? `[${t}](${item.url})` : item.url}${arrow ? ` ${said}` : said ? ` — ${said}` : ''}`
    want = { date: today, key, title: t, outcome: arrow ? strip(said.slice(1)) : said }
    const back = readInbox(`## Processed\n${made}`).processed
    if (back.length === 1 && back[0]!.date === want.date && back[0]!.key === want.key && back[0]!.title === want.title && back[0]!.outcome === want.outcome) {
      line = made
      break
    }
  }
  if (line === null || !want) throw new InboxError('the outcome would not read back as it is: say it in other words')
  const lines = [...box.lines], cr = [...box.cr]
  const [a, b] = item.at
  lines.splice(a, b - a)
  cr.splice(a, b - a)
  if (!lines.length) {
    lines.push('')
    cr.push(false)
  }
  // where the item was: a blank line that is now the file's first, or the second of two, goes
  if (lines.length > 1 && a < lines.length && !strip(lines[a]!) && (a === 0 || !strip(lines[a - 1]!))) {
    lines.splice(a, 1)
    cr.splice(a, 1)
  }
  cr[cr.length - 1] = false
  const head = lines.findIndex(l => PROCESSED.test(l))
  let end: number, stop: number, add: string[]
  if (head < 0) {
    // at the file's end, a blank line before the heading unless one is there
    stop = lines.length
    end = lines[lines.length - 1] === '' ? stop - 1 : stop
    add = [...(end > 0 && strip(lines[end - 1]!) ? [''] : []), '## Processed', '', line]
  } else {
    // the end of the processed ones: before the next heading and the blank lines above it
    const after = lines.findIndex((l, n) => n > head && HEADING.test(l))
    stop = after < 0 ? lines.length : after
    end = stop
    while (end > head + 1 && !strip(lines[end - 1]!)) end--
    add = [...(ITEM.test(lines[end - 1]!) || SUB.test(lines[end - 1]!) ? [] : ['']), line]
  }
  put(lines, cr, box.crlf, end, [...add, ...(end === stop ? [''] : [])])
  return { box: readLines(lines, cr, box.crlf), processed: want }
}

// ---------------------------------------------------------------- in a session

const itemName = (item: { key: string; url: string; title: string }) => (item.title ? `${item.title} (${item.url})` : item.url)

const RANK = (p: string) => {
  const at = (READING_PRIORITIES as readonly string[]).indexOf(p)
  return at < 0 ? READING_PRIORITIES.length : at
}

/** The items by reading priority (urgent first, those with none last), the newest first within one; as the page lists them. */
export const byPriority = <T extends InboxItem>(items: readonly T[]): T[] =>
  items.map((item, at) => ({ item, at }))
    .sort((a, b) => RANK(a.item.priority) - RANK(b.item.priority) || (a.item.added < b.item.added ? 1 : a.item.added > b.item.added ? -1 : 0) || (a.item.added ? b.at - a.at : a.at - b.at))
    .map(x => x.item)

/** The vault's inbox; an empty one when it has no file yet. */
export async function loadInbox(io: Io, vault: string): Promise<Inbox> {
  const path = join(vault, INBOX)
  return readInbox((await io.exists(path)) ? await io.read(path) : '')
}

/** The reference note whose Source names this link, by id. */
export function referenceOf(loaded: Loaded, key: string): string | null {
  for (const [id, n] of Object.entries(loaded.tree.nodes)) {
    if (n.type === 'reference' && linksIn(sourceOf(loaded.texts[id] ?? '')).includes(key)) return id
  }
  return null
}

const HOW_TO_ADD = '/rft-inbox <link> [reading priority] [why] saves one (a URL, an arXiv id or a DOI)'

/** The inbox in words: what waits, the most pressing first. */
export function inboxReport(box: Inbox): string {
  const items = shown(box)
  if (!items.length) return `The inbox is empty (${INBOX} in the vault holds what the user saved to read later). ${HOW_TO_ADD}.`
  const lines = byPriority(items).map((item, n) => {
    const parts = [item.priority, itemName(item), item.why, item.added ? `added ${item.added}` : '', item.brief ? `briefed ${item.brief.date}` : '', item.duplicate ? 'in the inbox twice' : '']
    return `${n + 1}. ${parts.filter(Boolean).join(' · ')}`
  })
  return [`${countsOf(items)}, saved to read later and not decided about (${INBOX} in the vault).`, ...lines].join('\n')
}

function countsOf(items: readonly InboxItem[]): string {
  const urgent = items.filter(i => i.priority === 'urgent').length
  const briefed = items.filter(i => i.brief).length
  return [`Inbox: ${items.length} ${items.length === 1 ? 'item' : 'items'}`, urgent ? `${urgent} urgent` : '', briefed ? `${briefed} briefed` : ''].filter(Boolean).join(', ')
}

/** rft_next's line on the inbox, or nothing when it is empty. */
export function inboxLine(box: Inbox): string {
  const items = shown(box)
  return items.length ? `${countsOf(items)} (rft_inbox lists them; one is processed when the user asks).` : ''
}

/**
 * Saves a link to read later and says so, or says where it already is: in the inbox, among the
 * processed items, or in a reference's Source. Nothing is written for a duplicate.
 */
export async function addItem(io: Io, loaded: Loaded, input: AddInput): Promise<string> {
  const vault = loaded.config.vault
  const box = await loadInbox(io, vault)
  const got = linkAt(oneLine(input.link))
  if (!got || strip(got.tail)) throw new InboxError(`"${oneLine(input.link)}" is not a link: give a URL, an arXiv id or a DOI.`)
  const held = findIn(box, got.key)
  if (held && 'item' in held) {
    const about = [held.item.added ? `added ${held.item.added}` : '', held.item.priority ? `reading priority ${held.item.priority}` : ''].filter(Boolean).join(', ')
    return `Already in the inbox${about ? ` (${about})` : ''}: ${itemName(held.item)}. Nothing added.${briefText(held.item)}`
  }
  if (held) {
    const p = held.processed
    return `Already processed${p.date ? ` on ${p.date}` : ''}${p.outcome ? ` (${p.outcome})` : ''}: ${itemName({ ...got, title: p.title })}. Nothing added.`
  }
  const ref = referenceOf(loaded, got.key)
  if (ref) return `Already in the tree: ${ref} is a reference of it (${got.url}). Nothing added.`
  let added: { box: Inbox; item: InboxItem }
  try {
    added = addTo(box, input)
  } catch (err) {
    if (err instanceof InboxError) throw new InboxError(`Not added: ${err.message}.`)
    throw err
  }
  await io.write(join(vault, INBOX), inboxText(added.box))
  const { item } = added
  const about = [item.priority ? `reading priority ${item.priority}` : '', item.why ? `why: ${item.why}` : ''].filter(Boolean).join('; ')
  return `Saved to the inbox: ${itemName(item)}${about ? ` (${about})` : ''}. ${countsOf(shown(added.box))}.`
}

const briefText = (item: InboxItem) => (item.brief ? `\nIts brief, saved ${item.brief.date}:\n${item.brief.lines.map(l => `- ${l}`).join('\n')}` : '')

/** The item a tool call names by its link, and the inbox; InboxError when the link is none or no item has it. */
async function itemAt(io: Io, vault: string, link: string): Promise<{ box: Inbox; item: Inbox['items'][number] }> {
  const got = linkAt(oneLine(link))
  if (!got || strip(got.tail)) throw new InboxError(`"${oneLine(link)}" is not a link: name the item by its link (a URL, an arXiv id or a DOI), as rft_inbox lists it.`)
  const box = await loadInbox(io, vault)
  const item = nthItem(box, got.key)
  if (item) return { box, item }
  const p = box.processed.filter(x => x.key === got.key).pop()
  throw new InboxError(p
    ? `Not in the inbox any more: ${itemName({ ...got, title: p.title })} was processed${p.date ? ` on ${p.date}` : ''}${p.outcome ? ` (${p.outcome})` : ''}.`
    : `No item of the inbox has this link (${got.url}). rft_inbox with no field lists them.`)
}

/** Saves the brief of an item (rft_inbox {link, brief}) and says so. */
export async function saveBrief(io: Io, loaded: Loaded, link: string, brief: string, today: string): Promise<string> {
  const vault = loaded.config.vault
  const { box, item } = await itemAt(io, vault, link)
  let done: ReturnType<typeof briefOn>
  try {
    done = briefOn(box, item.key, 0, brief, today)
  } catch (err) {
    if (err instanceof InboxError) throw new InboxError(`Brief not saved: ${err.message}.`)
    throw err
  }
  await io.write(join(vault, INBOX), inboxText(done!.box))
  return `Brief saved on ${itemName(item)} (${done!.item.brief!.lines.length} ${done!.item.brief!.lines.length === 1 ? 'line' : 'lines'}): it stays in the inbox until the user picks an outcome.`
}

/** What the user may decide for a processed item; Claude recommends one and only the user picks. */
export const OUTCOMES = ['reference', 'literature entry', 'direction', 'discard', 'later'] as const
export type Outcome = (typeof OUTCOMES)[number]
export type CloseInput = { link: string; outcome: string; note?: string; cites?: string; reason?: string; today: string }

const A = (type: string) => `${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}`

/**
 * Closes an item with the outcome the user picked (rft_inbox {link, outcome, ...}): it leaves the
 * inbox for the processed ones, pointing at the note it became or saying why it was discarded.
 * The note is there already: an outcome that needs one is refused while it is missing or of
 * another kind. `later` closes nothing.
 */
export async function closeItem(io: Io, loaded: Loaded, input: CloseInput): Promise<string> {
  const vault = loaded.config.vault
  const said = oneLine(input.outcome).toLowerCase().replace(/[-_]/g, ' ')
  const outcome = (said === 'discarded' ? 'discard' : said === 'literature' ? 'literature entry' : said) as Outcome
  if (!(OUTCOMES as readonly string[]).includes(outcome)) throw new InboxError(`Not closed: an outcome is ${OUTCOMES.slice(0, -1).join(', ')} or ${OUTCOMES[OUTCOMES.length - 1]}, and "${oneLine(input.outcome)}" is none of them.`)
  const { box, item } = await itemAt(io, vault, input.link)
  const name = itemName(item)
  if (outcome === 'later') return `Left in the inbox for later: ${name}${item.brief ? `, with its brief (${item.brief.date})` : ', with no brief'}. Nothing closed.`
  const { nodes } = loaded.tree
  const noteOf = (given: string | undefined, field: string, what: string) => {
    const id = resolveId(loaded.tree, given?.trim())
    if (!id) {
      throw new InboxError(given?.trim()
        ? `Not closed: there is no note ${given.trim()}. Make ${what} first (rft_add_node), then close the item with its id.`
        : `Not closed: the outcome ${outcome} names ${what} (${field}). Make it first (rft_add_node), then close the item with its id.`)
    }
    return id
  }
  let line: string
  let advice = ''
  if (outcome === 'discard') {
    const reason = oneLine(input.reason)
    if (!reason) throw new InboxError('Not closed: a discard gives its reason in one line (reason): the user reads it later to know why they passed on the item.')
    line = `discarded: ${reason}`
  } else if (outcome === 'reference') {
    const id = noteOf(input.note, 'note', 'the reference note of the item')
    const n = nodes[id]!
    if (n.type !== 'reference') throw new InboxError(`Not closed: ${id} is ${A(n.type)}, not a reference.`)
    if (isLiterature(n)) throw new InboxError(`Not closed: ${id} is a literature note. An item added to it as one of its papers has the outcome "literature entry"; the outcome reference names a reference note of the item alone.`)
    if (!linksIn(sourceOf(loaded.texts[id] ?? '')).includes(item.key)) advice = ` ${id}'s Source does not name this link (${item.url}): add it there, so that the link is known as ${id}'s when it is saved again.`
    line = `→ ${id}`
  } else if (outcome === 'literature entry') {
    const id = noteOf(input.note, 'note', 'the literature note the item was added to')
    const n = nodes[id]!
    if (!isLiterature(n)) throw new InboxError(`Not closed: ${id} is ${n.type === 'reference' ? 'a reference of one source' : A(n.type)}, not a literature note (a reference tagged literature, with its papers in a Papers section).`)
    if (!linksIn(loaded.texts[id] ?? '').includes(item.key)) advice = ` ${id} does not name this link (${item.url}): check that its entry is in the Papers section, with the link.`
    line = `→ ${id} (literature entry)`
  } else {
    const id = noteOf(input.note, 'note', 'the direction the item sparked')
    const n = nodes[id]!
    if (n.type !== 'direction') throw new InboxError(`Not closed: ${id} is ${A(n.type)}, not a direction.`)
    const ref = noteOf(input.cites, 'cites', 'the reference note of the item, which the direction cites')
    if (nodes[ref]!.type !== 'reference') throw new InboxError(`Not closed: ${ref} is ${A(nodes[ref]!.type)}, not a reference. A direction from an item cites the reference note of the item (cites).`)
    if (!(n.refs ?? []).includes(ref) && !(loaded.texts[id] ?? '').includes(`[[${nodes[ref]!.name}`)) advice = ` ${id} does not link ${ref}: add it to its refs, so that the direction cites what it came from.`
    line = `→ ${id}, citing ${ref}`
  }
  // a link the user typed twice is two items: both are closed, each with its own line
  let now = box
  let closed = 0
  let done: ProcessedItem | null = null
  try {
    for (let next = closeIn(now, item.key, 0, line, input.today); next; next = closeIn(now, item.key, 0, line, input.today)) {
      now = next.box
      done = next.processed
      closed++
    }
  } catch (err) {
    if (err instanceof InboxError) throw new InboxError(`Not closed: ${err.message}.`)
    throw err
  }
  await io.write(join(vault, INBOX), inboxText(now))
  const left = shown(now)
  return `Closed: ${name} ${line.startsWith('→') ? line : `— ${line}`}. It is under Processed in ${INBOX}${done?.date ? `, dated ${done.date}` : ''}${closed > 1 ? ` (it was in the inbox ${closed} times: all are closed)` : ''}. `
    + `${left.length ? countsOf(left) : 'The inbox is empty'}.${advice}`
}

/**
 * What Process asks of Claude, as a turn of the chat (ADR 0001): read the item, save its brief,
 * recommend one outcome and wait. The detail is in the manual's part on the inbox.
 */
export function processPrompt(m: string, item: InboxItem): string {
  const about = [item.why ? `saved because: ${item.why}` : '', item.added ? `added ${item.added}` : ''].filter(Boolean).join('; ')
  const head = `Process this inbox item with me (read ${cite(m, 'inbox', 'Processing an item')} first): ${itemName(item)}${about ? ` (${about})` : ''}.`
  const tool = `rft_inbox {link: ${JSON.stringify(item.url)}, `
  const wait = `Then wait: write nothing to the tree until I pick an outcome (reference, literature entry, direction, discard or later). When I pick, write what that outcome needs and close the item with ${tool}outcome, ...}.`
  if (item.brief) {
    return `${head}\n\nIt has a brief, saved ${item.brief.date}:\n${item.brief.lines.map(l => `- ${l}`).join('\n')}\n\n`
      + `Start from this brief: do not read the item again unless I ask, or the brief leaves open what I need to decide. Give me the brief and the outcome it recommends; if you read the item again and the brief changes, save the new one with ${tool}brief} first. ${wait}`
  }
  return `${head}\n\n`
    + 'Read the item itself before you say anything about it: the page or the paper at its link, with the tools you have (for an arXiv paper, the abstract page and as much of the paper as the brief needs). '
    + `Then, before anything else, save its brief with ${tool}brief}: at most three lines, what it claims, which notes of the tree it touches (by id: rft_search and rft_map find them), and the one outcome you recommend, with where it would go. Give me the brief in the chat too. ${wait}\n\n`
    + 'If you cannot read it (a paywall, a dead link, a page that needs a login), say so and save no brief: never brief from the title or from what you remember of the paper. Offer me to discard it, to leave it for later, or to give you the path of its PDF in the vault.'
}

/** What `/rft-inbox <link> [reading priority] [why]` was given: a first word that is a reading priority is one, the rest is the why. */
export function commandInput(args: string): AddInput | null {
  const line = oneLine(args)
  const got = linkAt(line)
  if (!got) return null
  const rest = strip(strip(got.tail).replace(DASH, ''))
  const [first = '', ...more] = rest.split(' ')
  const priority = (READING_PRIORITIES as readonly string[]).includes(first.toLowerCase()) ? first.toLowerCase() : ''
  const why = strip((priority ? more.join(' ') : rest).replace(DASH, ''))
  return { link: line.slice(0, line.length - got.tail.length), why, priority }
}
