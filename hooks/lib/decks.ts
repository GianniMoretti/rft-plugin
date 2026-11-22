// Slide decks (docs/design/presentations.md) as the session sees them: one Markdown file each in
// the vault's decks/ folder, `P03 Weekly wrap-up.md`, for a meeting's occurrence, a once-only
// meeting or a deadline (`for:`). The decks are the user's: one is locked unless its frontmatter
// says `locked: false`, and Claude's own writes of a locked deck, or of a new deck by hand, are
// refused (guards.ts), so Claude proposes an outline instead. The deck's logic itself is
// web/slides.js, shared with the tree view's Slides tab; the tab writes the decks through the
// server (server/rft_decks.py).

import '../../web/slides.js'

import { S } from './dates'
import type { Io, Loaded } from './vault'
import { compareNames, join } from './vault'

type Fields = Record<string, unknown>
type SlidesApi = {
  DECK_RE: RegExp
  DECKS: string
  frontOf: (text: string) => { fields: Fields; body: number }
  isLocked: (fields: Fields) => boolean
  problems: (deck: { id: string; text: string }, meetings: unknown[], milestones: unknown[], s: unknown) => string[]
}

export const P = (globalThis as unknown as { RftSlides: SlidesApi }).RftSlides
export const DECKS_DIR = P.DECKS

/** A deck as read from disk. */
export type Deck = { id: string; name: string; path: string; text: string; locked: boolean }

const idOf = (name: string) => name.split(' ')[0]!

/** The decks in the vault's decks/ folder, by id (a file whose name starts with no P id left out). */
export async function readDecks(io: Io, vault: string): Promise<Deck[]> {
  const dir = join(vault, DECKS_DIR)
  if (!(await io.exists(dir).catch(() => false))) return []
  const files = (await io.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.md') && P.DECK_RE.test(idOf(f.name.slice(0, -3))))
  const out: Deck[] = []
  for (const f of files.sort((a, b) => compareNames(a.name, b.name))) {
    const name = f.name.slice(0, -3)
    const text = (await io.read(join(dir, f.name))).replace(/\r\n/g, '\n')
    out.push({ id: idOf(name), name, path: `${DECKS_DIR}/${f.name}`, text, locked: P.isLocked(P.frontOf(text).fields) })
  }
  return out
}

/** The milestones as web/slides.js reads them: `due` as written. */
const milestonesOf = (loaded: Loaded) => (loaded.milestones ?? []).map(m => ({ ...m, due: m.dueText }))

/** What is wrong with the decks, for rft_validate: what each is for, and its slides' layouts. */
export async function deckWarnings(io: Io, loaded: Loaded): Promise<string[]> {
  const out: string[] = []
  for (const d of await readDecks(io, loaded.config.vault)) {
    for (const p of P.problems(d, loaded.meetings ?? [], milestonesOf(loaded), S)) out.push(`${loaded.config.vault}/${d.path}: ${p}`)
  }
  return out
}

/** Why Claude may not write a deck by hand that does not exist yet. */
export const NEW_DECK_TEXT =
  'A new deck is made in the tree view\'s Slides tab (+ Deck, or + Slides on a meeting in the Calendar), which numbers it and locks it: the decks are the user\'s to write. ' +
  'Propose its outline in the chat instead (each slide: its heading, what it shows, the notes and figures it rests on).'

/** Why Claude may not write a locked deck. */
export const deckLockedText = (id: string) =>
  `${id} is locked: the deck is the user's to write. Propose your changes in the chat (an outline, or a slide's text), for the user to write; ` +
  'or ask them to unlock it with the padlock in the Slides tab, so you may write it too.'
