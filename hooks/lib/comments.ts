// The discussion of each note: comments and suggestions on a part of its text, kept beside the
// notes in <vault>/.comments/<id>.json (a dot folder, which Obsidian leaves alone), in the format
// the tree view's server (server/rft_server.py) writes. A thread is anchored by its quote and the
// text around it, and found again after the note is edited (locate). The user writes threads in
// the tree view; Claude reads them with rft_comments and answers with rft_comment and rft_suggest,
// when the user asks it to from the view (the server's RFT_ASK line, made into a prompt by askText).
// A locked note (`locked: true`) is the user's: Claude only suggests changes to it.

import type { Io, Loaded, RftNode } from './vault'
import { bodyOf, front, join, resolveId, unquote } from './vault'

export const COMMENTS_DIR = '.comments'
/** The characters kept on each side of a quote, to find it again. */
export const CONTEXT = 40
const MAX_TEXT = 20_000

export type Message = { by: 'you' | 'claude'; at: string; text: string }
export type ThreadState = 'open' | 'resolved' | 'accepted' | 'rejected' | 'applied'
export type Thread = {
  id: string
  kind: 'comment' | 'suggestion'
  state: ThreadState
  quote: string
  prefix: string
  suffix: string
  /** A suggestion's new text for the quote; null for a comment, and for an instruction not yet written. */
  replacement: string | null
  /** When the user last asked Claude to answer, until Claude does. */
  asked: string | null
  messages: Message[]
  closed: { by: 'you' | 'claude'; at: string } | null
}
export type Comments = { note: string; next: number; threads: Thread[] }

export class CommentError extends Error {}

export const commentsPath = (vault: string, id: string) => join(vault, COMMENTS_DIR, `${id}.json`)

/** Whether a note's text says it is locked: the user's to change, Claude's only to suggest changes to. */
export const isLocked = (text: string) => ['true', 'yes'].includes(unquote(front(text).locked).toLowerCase())

/**
 * A change that writes a line into a locked note's History (a move, a supersede mark): made only
 * unlocked, once the user agrees; thrown, before anything is written, while they have not.
 */
export class LockedChange extends Error {
  constructor(readonly node: { id: string; name: string }, readonly change: 'move' | 'supersede') {
    super(`${node.name} is locked: to ${change === 'move' ? 'move it' : 'mark it as superseded'}, the user must agree to unlock it`)
  }
}

/** When a message is written, to the minute, local time. */
export function stamp(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`
}

/** A note's comments file; empty when there is none, or it cannot be read. */
export async function readComments(io: Io, vault: string, id: string): Promise<Comments> {
  let data: unknown = null
  try {
    data = JSON.parse(await io.read(commentsPath(vault, id)))
  } catch { /* none yet */ }
  const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  const threads = (Array.isArray(d.threads) ? d.threads : []).filter(
    (t): t is Thread => !!t && typeof t === 'object' && typeof (t as Thread).id === 'string')
  const last = Math.max(0, ...threads.map(t => (/^c(\d+)$/.exec(t.id) ? Number(t.id.slice(1)) : 0)))
  return { note: id, next: Math.max(typeof d.next === 'number' ? d.next : 0, last + 1), threads }
}

/** Writes a note's comments file; with the note's body, the open threads' context taken anew from it first. */
export async function writeComments(io: Io, vault: string, c: Comments, body?: string): Promise<void> {
  if (body != null) refreshed(body, c.threads)
  await io.write(commentsPath(vault, c.note), JSON.stringify(c, null, 2) + '\n')
}

const commonPrefix = (a: string, b: string) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n }
const commonSuffix = (a: string, b: string) => { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n }
const allIndexes = (body: string, s: string) => { const out: number[] = []; for (let i = body.indexOf(s); i >= 0; i = body.indexOf(s, i + 1)) out.push(i); return out }

/**
 * Where a thread's quote is in a note's body. Of several occurrences, the one with the most of its
 * context around it. When the quote is gone (the text was edited), not exact: the text between the
 * end of what came before it and the start of what came after, when both are still there and close
 * together; else, beside the one that is still there, text that begins (or ends) as the quote did,
 * at least half of it; else null: the thread is detached. As locate() in server/rft_server.py.
 */
export function locate(body: string, quote: string, prefix: string, suffix: string): { start: number; end: number; exact: boolean } | null {
  let best: [number, number] | null = null
  for (const i of quote ? allIndexes(body, quote) : []) {
    const score = commonSuffix(body.slice(0, i), prefix) + commonPrefix(body.slice(i + quote.length), suffix)
    if (!best || score > best[0]) best = [score, i]
  }
  if (best) return { start: best[1], end: best[1] + quote.length, exact: true }
  if (!prefix && !suffix) return null
  const head = prefix.slice(-24), tail = suffix.slice(0, 24)
  const starts = prefix ? allIndexes(body, head).map(i => i + head.length) : [0]
  const ends = suffix ? allIndexes(body, tail) : [body.length]
  const room = Math.max(3 * quote.length, quote.length + 120)
  let pick: [number, number, number] | null = null
  for (const s of starts) {
    for (const e of ends) {
      if (e - s < 0 || e - s > room) continue
      const cand: [number, number, number] = [Math.abs(e - s - quote.length), s, e]
      if (!pick || cand[0] < pick[0] || (cand[0] === pick[0] && (cand[1] < pick[1] || (cand[1] === pick[1] && cand[2] < pick[2])))) pick = cand
    }
  }
  if (pick) return { start: pick[1], end: pick[2], exact: false }
  const need = Math.max(4, Math.floor((quote.length + 1) / 2))
  let side: [number, number, number] | null = null
  const consider = (score: number, s: number, e: number) => {
    if (score >= need && (!side || score > side[0] || (score === side[0] && s < side[1]))) side = [score, s, e]
  }
  if (prefix) for (const s of starts) consider(commonPrefix(body.slice(s, s + quote.length), quote), s, s + quote.length)
  if (suffix) for (const e of ends) { const s = Math.max(0, e - quote.length); consider(commonSuffix(body.slice(s, e), quote), s, e) }
  const found = side as [number, number, number] | null
  return found ? { start: found[1], end: found[2], exact: false } : null
}

/** Takes anew from the body the context of each open thread still found as it was, so later edits around it leave enough to find it by. */
export function refreshed(body: string, threads: Thread[]): void {
  for (const t of threads) {
    if (t.state !== 'open') continue
    const at = locate(body, t.quote, t.prefix, t.suffix)
    if (at?.exact) { t.prefix = body.slice(Math.max(0, at.start - CONTEXT), at.start); t.suffix = body.slice(at.end, at.end + CONTEXT) }
  }
}

/** The anchor of a new thread on `quote`, which must occur exactly once in the body. */
export function anchorFor(body: string, quote: string): { quote: string; prefix: string; suffix: string } {
  const q = quote.replace(/\r\n/g, '\n')
  if (!q.trim()) throw new CommentError('quote is empty: give the exact text of the note the thread is about')
  const at = allIndexes(body, q)
  if (!at.length) throw new CommentError('quote is not in the note: copy the exact text, markdown included, from below its frontmatter')
  if (at.length > 1) throw new CommentError(`quote occurs ${at.length} times in the note: quote more of the text around it, so it occurs once`)
  const s = at[0]!, e = s + q.length
  return { quote: q, prefix: body.slice(Math.max(0, s - CONTEXT), s), suffix: body.slice(e, e + CONTEXT) }
}

const noteOf = (loaded: Loaded, ref: string): RftNode => {
  const id = resolveId(loaded.tree, ref)
  if (!id) throw new CommentError(`"${ref}" is not a note of the tree`)
  return loaded.tree.nodes[id]!
}

const textArg = (v: unknown, what: string): string => {
  const t = typeof v === 'string' ? v.trim() : ''
  if (t.length > MAX_TEXT) throw new CommentError(`${what} holds at most ${MAX_TEXT} characters`)
  return t
}

function findThread(c: Comments, id: string, thread: string): Thread {
  const t = c.threads.find(x => x.id === thread)
  if (!t) throw new CommentError(`${id} has no thread ${thread}${c.threads.length ? ` (it has ${c.threads.map(x => x.id).join(', ')})` : ''}`)
  if (t.state !== 'open') throw new CommentError(`${id} ${thread} is ${t.state}: only the user reopens it, in the tree view`)
  return t
}

const quoted = (s: string) => s.split('\n').map(l => `> ${l}`).join('\n')

/** Where a thread stands against the note as it is now, in words. */
function placeText(body: string, t: Thread): string {
  const at = locate(body, t.quote, t.prefix, t.suffix)
  if (!at) return 'The quoted text is no longer in the note.'
  if (at.exact) return 'The quoted text is in the note as quoted.'
  return `The quoted text changed since; that part of the note now reads:\n${quoted(body.slice(at.start, at.end))}`
}

function threadText(body: string, t: Thread, full: boolean): string {
  const what = t.kind === 'comment' ? 'comment'
    : t.replacement == null ? 'suggestion, an instruction (no replacement text yet)' : 'suggestion'
  const head = `${t.id} · ${what} · ${t.state}${t.asked && t.state === 'open' ? ` · Claude asked at ${t.asked}` : ''}`
  const lines = [head, quoted(t.quote)]
  if (t.kind === 'suggestion' && t.replacement != null) lines.push('Replacement:', quoted(t.replacement))
  if (t.state === 'open') lines.push(placeText(body, t))
  const msgs = full ? t.messages : t.messages.slice(-1)
  for (const m of msgs) lines.push(`- ${m.by === 'you' ? 'user' : 'claude'} · ${m.at}: ${m.text.replace(/\n/g, '\n  ')}`)
  if (!full && t.messages.length > 1) lines.splice(lines.length - 1, 0, `  (${t.messages.length - 1} earlier message(s))`)
  return lines.join('\n')
}

/** rft_comments: one note's threads (open ones in full, the history in short), or the notes with open threads. */
export async function commentsReport(io: Io, loaded: Loaded, ref?: string): Promise<string> {
  const vault = loaded.config.vault
  if (ref) {
    const n = noteOf(loaded, ref)
    const c = await readComments(io, vault, n.id)
    if (!c.threads.length) return `${n.name}: no comments or suggestions.`
    const body = bodyOf(loaded.texts[n.id] ?? '')
    const open = c.threads.filter(t => t.state === 'open')
    const closed = c.threads.filter(t => t.state !== 'open')
    const out = [`${n.name}${isLocked(loaded.texts[n.id] ?? '') ? ' (locked: suggest changes, never edit it)' : ''}: ${open.length} open, ${closed.length} closed.`]
    for (const t of open) out.push('', threadText(body, t, true))
    if (closed.length) out.push('', 'History:', ...closed.map(t => threadText(body, t, false)))
    return out.join('\n')
  }
  const rows: string[] = []
  for (const n of Object.values(loaded.tree.nodes)) {
    const open = (await readComments(io, vault, n.id)).threads.filter(t => t.state === 'open')
    if (open.length) rows.push(`- ${n.name}: ${open.map(t => `${t.id} ${t.kind}${t.asked ? ' (asked)' : ''}`).join(', ')}`)
  }
  return rows.length ? `Notes with open threads (rft_comments with an id shows them):\n${rows.join('\n')}` : 'No open comments or suggestions in the tree.'
}

/**
 * rft_comment: Claude's reply in a thread (with `applied`, on a suggestion it made in the note
 * itself, which closes the thread), or a new comment thread on `quote`.
 */
export async function comment(io: Io, loaded: Loaded, i: { id: string; thread?: string; quote?: string; text?: unknown; applied?: boolean }, now = stamp()): Promise<string> {
  const n = noteOf(loaded, i.id)
  const vault = loaded.config.vault
  const c = await readComments(io, vault, n.id)
  const text = textArg(i.text, 'text')
  const body = bodyOf(loaded.texts[n.id] ?? '')
  if (i.thread) {
    const t = findThread(c, n.id, i.thread)
    if (i.applied) {
      if (t.kind !== 'suggestion') throw new CommentError(`${n.id} ${t.id} is a comment: reply to it, or apply nothing`)
      if (isLocked(loaded.texts[n.id] ?? '')) throw new CommentError(`${n.name} is locked: you cannot apply a change to it; write the replacement with rft_suggest {id, thread, replacement}, and the user accepts it`)
    } else if (!text) throw new CommentError('text is empty: write the reply')
    if (text) t.messages.push({ by: 'claude', at: now, text })
    t.asked = null
    if (i.applied) { t.state = 'applied'; t.closed = { by: 'claude', at: now } }
    await writeComments(io, vault, c, body)
    return i.applied ? `${n.id} ${t.id}: marked applied and closed; the user sees it in the thread's history.` : `${n.id} ${t.id}: replied.`
  }
  if (i.applied) throw new CommentError('applied closes an existing suggestion: give its thread')
  if (!text) throw new CommentError('text is empty: write the comment')
  const a = anchorFor(body, String(i.quote ?? ''))
  const t: Thread = { id: `c${c.next}`, kind: 'comment', state: 'open', ...a, replacement: null, asked: null, messages: [{ by: 'claude', at: now, text }], closed: null }
  c.threads.push(t)
  c.next++
  await writeComments(io, vault, c, body)
  return `${n.id} ${t.id}: comment added; the user sees it in the tree view.`
}

/**
 * rft_suggest: the replacement for a suggestion thread (an instruction gets its text), or a new
 * suggestion replacing `quote`. The user accepts or rejects it in the tree view.
 */
export async function suggest(io: Io, loaded: Loaded, i: { id: string; thread?: string; quote?: string; replacement?: unknown; text?: unknown }, now = stamp()): Promise<string> {
  const n = noteOf(loaded, i.id)
  const vault = loaded.config.vault
  const c = await readComments(io, vault, n.id)
  if (typeof i.replacement !== 'string') throw new CommentError('replacement is missing: the new text, in markdown, for the quoted text')
  const replacement = i.replacement.replace(/\r\n/g, '\n')
  if (replacement.length > MAX_TEXT) throw new CommentError(`replacement holds at most ${MAX_TEXT} characters`)
  const text = textArg(i.text, 'text')
  const body = bodyOf(loaded.texts[n.id] ?? '')
  if (i.thread) {
    const t = findThread(c, n.id, i.thread)
    if (t.kind !== 'suggestion') throw new CommentError(`${n.id} ${t.id} is a comment: propose the change as a new suggestion, with its quote`)
    const at = locate(body, t.quote, t.prefix, t.suffix)
    if (!at?.exact) throw new CommentError(`the text ${n.id} ${t.id} is on changed since: reply in the thread, or make a new suggestion on the text as it is now (quote)`)
    if (replacement === t.quote) throw new CommentError('the replacement is the quoted text itself: change something, or reply instead')
    t.replacement = replacement
    if (text) t.messages.push({ by: 'claude', at: now, text })
    t.asked = null
    await writeComments(io, vault, c, body)
    return `${n.id} ${t.id}: replacement written; the user accepts or rejects it in the tree view.`
  }
  const a = anchorFor(body, String(i.quote ?? ''))
  if (replacement === a.quote) throw new CommentError('the replacement is the quoted text itself: change something')
  const t: Thread = { id: `c${c.next}`, kind: 'suggestion', state: 'open', ...a, replacement, asked: null, messages: text ? [{ by: 'claude', at: now, text }] : [], closed: null }
  c.threads.push(t)
  c.next++
  await writeComments(io, vault, c, body)
  return `${n.id} ${t.id}: suggestion added; the user accepts or rejects it in the tree view.`
}

/** The prompt that asks Claude to answer one thread, as the user did from the tree view. `path`: the note's file as the session sees it. */
export function askText(loaded: Loaded, c: Comments, id: string, thread: string, path: string): string {
  const n = loaded.tree.nodes[id]
  const t = c.threads.find(x => x.id === thread)
  if (!n || !t) throw new CommentError(`${id} has no thread ${thread}`)
  const locked = isLocked(loaded.texts[id] ?? '')
  const ref = `{id: "${id}", thread: "${t.id}"`
  const todo = t.kind === 'comment'
    ? `It is a comment: a discussion of this part of the note before any edit. Read what it needs (the note, and its code, results or references when the question is about them), then reply with rft_comment ${ref}, text}. Do not edit the note. When a change looks right, say so in the reply, or propose it with rft_suggest {id: "${id}", quote, replacement}.`
    : locked
      ? `${id} is locked: do not edit it. Write the new text for the quoted part with rft_suggest ${ref}, replacement, text: why}; the user accepts or rejects it in the tree view. A change needed elsewhere in the note is one more rft_suggest {id: "${id}", quote, replacement}. When the suggestion is unclear or looks wrong, reply with rft_comment ${ref}, text} instead.`
      : `Make the change in the note yourself: edit the quoted part as ${t.replacement == null ? 'the instruction says' : 'the replacement has it (adapting it only where the note needs it)'}, and only what that needs. Then close the thread with rft_comment ${ref}, applied: true, text: what you changed}. When the suggestion is unclear or looks wrong, reply with rft_comment ${ref}, text} instead and leave the note as it is.`
  return [
    `The user asks you, from the tree view, to answer thread ${t.id} on ${n.name} (${path}). Answer in the thread with the rft tools; in the chat, one short line at most.`,
    '',
    threadText(bodyOf(loaded.texts[id] ?? ''), t, true),
    '',
    todo,
  ].join('\n')
}

/**
 * The task of the read-only subagent that answers one thread (Ask Claude): its final message is
 * the answer, which the plugin writes into the thread (`answerThread`). It edits nothing, so a
 * change to the note is a replacement the user accepts in the tree view.
 */
export function subagentAskText(loaded: Loaded, c: Comments, id: string, thread: string, path: string): string {
  const n = loaded.tree.nodes[id]
  const t = c.threads.find(x => x.id === thread)
  if (!n || !t) throw new CommentError(`${id} has no thread ${thread}`)
  const todo = t.kind === 'comment'
    ? 'It is a comment: a discussion of this part of the note. Your final message is your reply in the thread, as the user will read it (markdown, short).'
    : `It is a suggestion. Your final message is the new text for the quoted part, between <replacement> and </replacement>, ${t.replacement == null ? 'written as the instruction says' : 'from the proposed replacement, adapted only where the note needs it'}, then one line on why; the user accepts or rejects it in the tree view. When the suggestion is unclear or looks wrong, write no replacement: your final message is then your reply.`
  return [
    `Answer thread ${t.id} on ${n.name} (${path}). Read what it needs (the note, and its code, results or references when the question is about them) and nothing more.`,
    '',
    threadText(bodyOf(loaded.texts[id] ?? ''), t, true),
    '',
    todo,
  ].join('\n')
}

/** Writes a thread subagent's final message into its thread: a replacement for a suggestion, else a reply. */
export async function answerThread(io: Io, loaded: Loaded, id: string, thread: string, answer: string, now = stamp()): Promise<string> {
  const m = /<replacement>\n?([\s\S]*?)\n?<\/replacement>/.exec(answer)
  const text = (m ? answer.replace(m[0], '') : answer).trim()
  if (m) {
    try {
      return await suggest(io, loaded, { id, thread, replacement: m[1]!, text }, now)
    } catch (err) {
      // the text moved, or the thread is a comment: the replacement goes into the reply
      if (!(err instanceof CommentError)) throw err
      return comment(io, loaded, { id, thread, text: `${text}\n\n${m[1]}`.trim() }, now)
    }
  }
  return comment(io, loaded, { id, thread, text: text || '(no answer)' }, now)
}

/** Moves a note's comments when its id changes (rft_set_type). */
export async function renameComments(io: Io, vault: string, from: string, to: string): Promise<void> {
  if (!(await io.exists(commentsPath(vault, from)))) return
  const c = await readComments(io, vault, from)
  await writeComments(io, vault, { ...c, note: to })
  await io.remove(commentsPath(vault, from))
}
