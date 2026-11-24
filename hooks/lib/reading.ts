// The reading note of an inbox item: what was written on reading it, in two parts, the user's
// (quotes from the item and lines of their own) and Claude's impression. One markdown file per item
// in a folder at the vault's top (Reading notes/, beside Inbox.md), outside the tree, made on the
// first write and tied to the item by its link.
//
//     # Mixup at scale
//     <https://arxiv.org/abs/2406.01234>
//
//     ## My reading
//
//     > The gain vanishes below 1k images (Sec. 4.2)
//
//     Same subset sizes as E05?
//
//     ## Claude's impression (2026-11-24)
//
//     ### Claims
//     ...
//
// The user's part is what stands between the first `## My reading` heading and the last `## Claude's
// impression` heading (the file's end, when there is none); the impression is what follows that
// heading. Two writers, each of its own part: the plugin writes the impression (here), the page's
// server the user's part (server/rft_reading.py), and each leaves every other line as it was, in
// the endings the file has. Claude is given the user's part only once the user marked the item as
// read (docs/adr/0004): what decides that is in inbox.ts.
//
// server/rft_reading.py reads the same file the same way, pattern for pattern, and
// tests/fixtures/reading-note holds both to one list of cases. A change to a pattern here is a
// change to the same pattern there.

import type { CloseInput } from './inbox'
import { InboxError, OUTCOMES, closeItem, itemAt, itemName, linkAt, oneLine, outcomeOf, rx, strip } from './inbox'
import type { Io, Loaded } from './vault'
import { join, resolveId } from './vault'

export const READING_DIR = 'Reading notes'
export const MINE_HEAD = '## My reading'
export const IMPRESSION_HEAD = "## Claude's impression"
const MINE = rx(String.raw`^##[ \t]+my[ \t]+reading[ \t]*$`, true)
const IMPRESSION = rx(String.raw`^##[ \t]+claude['’]s[ \t]+impression(?:[ \t]+\(([0-9]{4}-[0-9]{2}-[0-9]{2})\))?[ \t]*$`, true)
const BLANK = rx(String.raw`^[ \t]*$`)
const SCHEME = rx('^https?://', true)
const UNSAFE = rx('[^A-Za-z0-9._-]+', false, true)
const EDGE = rx('^[-.]+|[-.]+$', false, true)
const NAME_CHARS = 100
const TRIES = 50 // how many files of one name's family are looked at for an item's own

/** What cannot be written in a reading note, in words for Claude. */
export class ReadingError extends InboxError {}

export type Impression = { date: string; text: string }
/**
 * The file as read: its lines, as they are (`cr`: which ended with a carriage return before its
 * newline), and what they hold. `key`: the item it is of, by the first link of its head; `mine`:
 * the user's part; `impression`: Claude's, or null. `at`: the lines of the two headings.
 */
export type ReadingNote = { crlf: boolean; lines: string[]; cr: boolean[]; key: string | null; mine: string; impression: Impression | null; at: [number | null, number | null] }

/** The file of the item with this key: its key in the characters a file name may have. `n`: the next name of the family. */
export function fileName(key: string, n = 0): string {
  const stem = key.replace(SCHEME, '').replace(UNSAFE, '-').replace(EDGE, '').slice(0, NAME_CHARS).replace(EDGE, '') || 'item'
  return n === 0 ? `${stem}.md` : `${stem}-${n + 1}.md`
}

/** What a reading note is headed: the item's title, else what the inbox's list calls it. */
export function nameOf(key: string, title = ''): string {
  const t = oneLine(title)
  if (t) return t
  if (key.startsWith('arxiv:')) return `arXiv ${key.slice(6)}`
  if (key.startsWith('doi:')) return `doi ${key.slice(4)}`
  return key.replace(SCHEME, '')
}

/** A text as lines, without the blank ones at its two ends. */
export function linesOf(text: string): string[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  while (lines.length && BLANK.test(lines[0]!)) lines.shift()
  while (lines.length && BLANK.test(lines[lines.length - 1]!)) lines.pop()
  return lines
}

/** Reads the file's text. */
export function readNote(text: string): ReadingNote {
  const raw = text.split('\n')
  const cr = raw.map((line, n) => n < raw.length - 1 && line.endsWith('\r'))
  return readLines(raw.map((line, n) => (cr[n] ? line.slice(0, -1) : line)), cr, cr.includes(true))
}

function readLines(lines: string[], cr: boolean[], crlf: boolean): ReadingNote {
  let imp: number | null = null
  for (let n = lines.length - 1; n >= 0 && imp === null; n--) if (IMPRESSION.test(lines[n]!)) imp = n
  const stop = imp ?? lines.length
  let mine: number | null = null
  for (let n = 0; n < stop && mine === null; n++) if (MINE.test(lines[n]!)) mine = n
  let key: string | null = null
  for (const line of lines.slice(0, mine ?? stop)) {
    const got = linkAt(strip(line))
    if (got) {
      key = got.key
      break
    }
  }
  return {
    crlf, lines, cr, key,
    mine: mine === null ? '' : linesOf(lines.slice(mine + 1, stop).join('\n')).join('\n'),
    impression: imp === null ? null : { date: IMPRESSION.exec(lines[imp]!)![1] ?? '', text: linesOf(lines.slice(imp + 1).join('\n')).join('\n') },
    at: [mine, imp],
  }
}

/** The file again: as it was read, when nothing changed. */
export const noteText = (note: ReadingNote): string => note.lines.map((line, n) => (note.cr[n] ? `${line}\r` : line)).join('\n')

/** The note of an item that has none yet: its head alone. Not a file until a part is written. */
export function newNote(key: string, url: string, title = ''): ReadingNote {
  for (const link of [`<${url}>`, url]) {
    const note = readNote(`# ${nameOf(key, title)}\n${link}\n`)
    if (note.key === key) return note
  }
  throw new ReadingError("the item's link would not read back from its reading note")
}

/** Lines a to b replaced by new ones, with the file's endings. */
function splice(note: ReadingNote, a: number, b: number, add: string[]): ReadingNote {
  const lines = [...note.lines], cr = [...note.cr]
  if (a === lines.length && a > 0) cr[a - 1] = note.crlf // the last line had no ending: it has the file's now
  lines.splice(a, b - a, ...add)
  cr.splice(a, b - a, ...add.map(() => note.crlf))
  cr[cr.length - 1] = false // nothing ends the last line
  return readLines(lines, cr, note.crlf)
}

/** The parts of an impression, in their order: every impression has each, once. */
export const IMPRESSION_PARTS = ['Claims', 'How', 'Key results', 'Bearing on', 'Left open'] as const
/** About one screen. */
export const IMPRESSION_CHARS = 3000
const PART = rx(String.raw`^#{1,6}[ \t]+(.*?)[ \t]*:?[ \t]*#*[ \t]*$`)
const SAYS = 'An impression has five parts, each under its heading and in this order: '
  + `${IMPRESSION_PARTS.map(p => `### ${p}`).join(', ')} (what the item claims; how it gets there; its key results, with their numbers and where they are in the item; its bearing on notes of the tree, named by id; what it leaves open)`

/**
 * An impression as it is written in the file: its five parts under their headings, a blank line
 * between two. ReadingError when a part is missing, empty, twice or out of its place, when there
 * is a heading that is none of the five or text before the first, or when it is longer than a
 * screen.
 */
export function impressionLines(text: string): string[] {
  const out: string[] = []
  let part = -1
  let body: string[] = []
  const close = () => {
    const kept = linesOf(body.join('\n'))
    if (part >= 0 && !kept.length) throw new ReadingError(`the part "${IMPRESSION_PARTS[part]}" of the impression is empty. ${SAYS}`)
    if (part < 0 && kept.length) throw new ReadingError(`the impression starts with text under no heading. ${SAYS}`)
    if (part >= 0) out.push(...(out.length ? [''] : []), `### ${IMPRESSION_PARTS[part]}`, '', ...kept)
    body = []
  }
  for (const line of linesOf(text).map(l => l.replace(/[ \t]+$/, ''))) {
    const h = PART.exec(line)
    if (!h) {
      body.push(line)
      continue
    }
    const at = IMPRESSION_PARTS.findIndex(p => p.toLowerCase() === oneLine(h[1]).toLowerCase())
    if (at < 0) throw new ReadingError(`"${oneLine(h[1])}" is not a part of an impression. ${SAYS}`)
    if (at !== part + 1) throw new ReadingError(`the part "${IMPRESSION_PARTS[at]}" is ${at <= part ? 'there twice or out of its place' : `before "${IMPRESSION_PARTS[part + 1]}"`}. ${SAYS}`)
    close()
    part = at
  }
  close()
  if (part !== IMPRESSION_PARTS.length - 1) throw new ReadingError(`the impression has no part "${IMPRESSION_PARTS[part + 1]}". ${SAYS}`)
  const chars = out.join('\n').length
  if (chars > IMPRESSION_CHARS) throw new ReadingError(`an impression is about one screen, at most ${IMPRESSION_CHARS} characters, and this has ${chars}: keep what the user needs to compare it with their own reading`)
  return out
}

/**
 * The note with Claude's impression of the day: its heading and its lines in place of the
 * impression the file had (everything from that heading on), or at the file's end. The user's
 * part and every line before it stay as they were.
 */
export function withImpression(note: ReadingNote, impression: string[], today: string): ReadingNote {
  const block = [`${IMPRESSION_HEAD} (${today})`, '', ...impression, '']
  const imp = note.at[1]
  if (imp !== null) return splice(note, imp, note.lines.length, block)
  let at = note.lines.length
  while (at > 0 && BLANK.test(note.lines[at - 1]!)) at--
  // a note with no part yet gets the user's, empty, before the impression: the file always shows the two
  const mine = note.at[0] === null ? [MINE_HEAD, ''] : []
  return splice(note, at, note.lines.length, [...(at > 0 ? [''] : []), ...mine, ...block])
}

/**
 * The quotes of a text: each run of lines that start with `>`, as its lines without the mark (and
 * the one space after it). A run of blank quote lines alone is none.
 */
export function quotesOf(text: string): string[][] {
  const out: string[][] = []
  let run: string[] = []
  const close = () => {
    const kept = linesOf(run.join('\n'))
    if (kept.length) out.push(kept)
    run = []
  }
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = QUOTE.exec(line)
    if (m) run.push(m[1]!.replace(/[ \t]+$/, ''))
    else close()
  }
  close()
  return out
}
const QUOTE = rx(String.raw`^[ \t]*>[ \t]?(.*)$`)

/** The quotes of `mine` that `text` does not hold word for word, as a quote of its own lines. */
export function quotesMissing(mine: string, text: string): string[][] {
  const held = quotesOf(text).map(q => q.join('\n'))
  return quotesOf(mine).filter(q => !held.some(h => `\n${h}\n`.includes(`\n${q.join('\n')}\n`)))
}

/**
 * The file of the item with this key, by its path, and the note in it: the first of its name's
 * family that is of this item (or names no item at all), else the first name that is free, with no
 * note.
 */
export async function findNote(io: Io, vault: string, key: string): Promise<{ path: string; note: ReadingNote | null }> {
  for (let n = 0; n < TRIES; n++) {
    const path = join(vault, READING_DIR, fileName(key, n))
    if (!(await io.exists(path))) return { path, note: null }
    const note = readNote(await io.read(path))
    if (note.key === key || note.key === null) return { path, note }
  }
  throw new ReadingError("too many reading notes share this item's file name")
}

// ---------------------------------------------------------------- in a session

const fileOf = (path: string) => `${READING_DIR}/${path.slice(path.lastIndexOf('/') + 1)}`

/**
 * Saves Claude's impression of an item (rft_inbox {link, impression}) in its reading note, made
 * when the item had none. Before the user's read mark an impression replaces the one it had; after
 * it the impression is frozen, and only an item that has none yet gets one.
 */
export async function saveImpression(io: Io, loaded: Loaded, link: string, impression: string, today: string): Promise<string> {
  const vault = loaded.config.vault
  const { item } = await itemAt(io, vault, link)
  const { path, note } = await findNote(io, vault, item.key)
  const had = note?.impression ?? null
  if (item.read && had) {
    throw new ReadingError(`Impression not saved: the user marked ${itemName(item)} as read on ${item.read}, and its impression${had.date ? ` of ${had.date}` : ''} is frozen from then on. It was written before you saw the user's part, and it is what their reading is compared with.`)
  }
  let lines: string[]
  try {
    lines = impressionLines(impression)
  } catch (err) {
    if (err instanceof ReadingError) throw new ReadingError(`Impression not saved: ${err.message}.`)
    throw err
  }
  await io.write(path, noteText(withImpression(note ?? newNote(item.key, item.url, item.title), lines, today)))
  return `Impression saved on ${itemName(item)}, in its reading note (${fileOf(path)})${had ? `, in place of the one${had.date ? ` of ${had.date}` : ' it had'}` : ''}. `
    + (item.read ? 'The user has marked the item as read: rft_inbox {link, reading: true} gives their part now.' : "The user's part of the reading note stays closed until they mark the item as read.")
}

/**
 * An item's reading note for Claude (rft_inbox {link, reading: true}): its own impression, and the
 * user's part only once the user marked the item as read and an impression is saved (ADR 0004).
 * Before the mark the user's part is not given, whatever it holds; after it, with no impression
 * yet, it is refused until one is saved, so that no impression is written after the user's part
 * was seen.
 */
export async function readingOf(io: Io, loaded: Loaded, link: string): Promise<string> {
  const vault = loaded.config.vault
  const { item } = await itemAt(io, vault, link)
  const { note } = await findNote(io, vault, item.key)
  const imp = note?.impression ?? null
  const yours = imp ? `Your impression of ${itemName(item)}${imp.date ? `, saved ${imp.date}` : ''}:\n\n${imp.text}` : `No impression of ${itemName(item)} is saved yet.`
  if (!item.read) {
    return `${yours}\n\nThe user's part of its reading note is closed to you: the user has not marked the item as read. Only they set that mark, on the item's row in the tree view; `
      + 'until then your reading is written from the item alone, and a second one replaces the impression (rft_inbox {link, impression}).'
  }
  if (!imp) {
    throw new ReadingError(`The user's part stays closed until your impression is saved: the user marked ${itemName(item)} as read (${item.read}) and it has no impression yet. `
      + 'Read the item itself, from the item alone, save the impression (rft_inbox {link, impression}), then ask again.')
  }
  const mine = note?.mine ?? ''
  return `${yours}\n\n${mine
    ? `The user's part, marked as read ${item.read} (theirs: never edit it; a line that starts with > is a quote from the item, any other is their own):\n\n${mine}`
    : `The user marked the item as read (${item.read}) and wrote nothing in their part.`}`
}

/**
 * Closes an item with the outcome the user picked, its reading note with it. While the user's part
 * holds something: a discard is refused until the user said yes to losing it (`confirmed`); an
 * outcome that writes to the tree is refused until the user marked the item as read, and until
 * every quote of theirs stands word for word, as a quote, in the note the outcome names (the
 * reference, the literature note, the reference a direction cites). Once the item is closed the
 * reading note's file is removed. `later` closes nothing and removes nothing.
 */
export async function closeWithNote(io: Io, loaded: Loaded, input: CloseInput & { confirmed?: boolean }): Promise<string> {
  const vault = loaded.config.vault
  const outcome = outcomeOf(input.outcome)
  if (outcome === 'later' || !(OUTCOMES as readonly string[]).includes(outcome)) return closeItem(io, loaded, input)
  const { item } = await itemAt(io, vault, input.link)
  const { path, note } = await findNote(io, vault, item.key)
  const mine = note?.mine ?? ''
  let carried = ''
  if (mine && outcome === 'discard') {
    if (!input.confirmed) {
      throw new ReadingError(`Not closed: the user's part of the reading note of ${itemName(item)} holds something, and a discard removes the reading note with it. Ask the user first; once they say yes, close with confirmed: true.`)
    }
  } else if (mine) {
    if (!item.read) {
      throw new ReadingError(`Not closed: the user's part of the reading note of ${itemName(item)} holds something you have not seen, and the outcome ${outcome} carries their quotes into the tree. `
        + 'Ask the user to mark the item as read (on its row in the tree view): the discussion starts from there.')
    }
    const id = resolveId(loaded.tree, (outcome === 'direction' ? input.cites : input.note)?.trim())
    const missing = id ? quotesMissing(mine, loaded.texts[id] ?? '') : []
    if (id && missing.length) {
      const n = quotesOf(mine).length
      throw new ReadingError(`Not closed: ${missing.length} of the user's ${n} ${n === 1 ? 'quote is' : 'quotes are'} not in ${id} word for word, as quote lines (>). The first missing:\n${missing[0]!.map(l => `> ${l}`).join('\n')}\n`
        + `Put ${missing.length === 1 ? 'it' : 'them'} in ${id} as the user wrote ${missing.length === 1 ? 'it' : 'them'}, then close the item.`)
    }
    if (id && quotesOf(mine).length) carried = id
  }
  const said = await closeItem(io, loaded, input)
  if (!note) return said
  await io.remove(path)
  return `${said} Its reading note (${fileOf(path)}) is removed${carried ? `: the user's quotes are in ${carried}` : mine && outcome === 'discard' ? ', with what the user had written in it' : ''}.`
}
