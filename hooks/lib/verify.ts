// Verified notes: the user checked a note's claim (`status: verified`), the gate for manuscript
// snippets (docs/design/manuscript.md). Only the user verifies, in the tree view; Claude suggests it
// (`suggested_verified:`, its reason), through rft_set_status. Verifying locks the note and stamps
// it (`verified: <date> <fingerprint>`) with a fingerprint of its substance, the sections that hold
// what it claims. When that substance changes (an accepted suggestion, an edit by hand, a new
// result), when it is superseded, or when its notebook's run no longer reproduces it, the note goes
// to `review`, unlocked, with a History line: the user verifies it again or gives it another status.

import type { Io, Loaded, NodeType, RftNode, Tree } from './vault'
import { LockedChange, isLocked } from './comments'
import { fnv1a, front, join, load, removeField, resolveId, sectionText, setField, sync, unquote, walk, withHistory, withStatus } from './vault'

export class VerifyError extends Error {}

/** The vault read again after a note's status changed, and the index and canvas that show it regenerated. */
async function reloaded(io: Io, loaded: Loaded): Promise<void> {
  const fresh = await load(io, loaded.config)
  await sync(io, fresh)
  Object.assign(loaded, await load(io, loaded.config))
}

export const MAX_WHY = 240

/** The sections that hold what a note of each type claims: what verifying it checks. */
export const SUBSTANCE: Record<NodeType, string[]> = {
  experiment: ['Result'],
  theory: ['Statement', 'Explanation'],
  reference: ['Source', 'Key results'],
  direction: ['Idea'],
}

/** A note's substance, as compared: its sections' text, comments left out and whitespace collapsed. */
export function substanceOf(type: NodeType, text: string): string {
  return (SUBSTANCE[type] ?? []).map(s => `${s}: ${sectionText(text, s).replace(/<!--[\s\S]*?-->/g, ' ').replace(/\s+/g, ' ').trim()}`).join('\n')
}

export const substanceFingerprint = (type: NodeType, text: string) => fnv1a(substanceOf(type, text))

/** The `verified:` line for a note verified on `date`, as written. */
export const verifiedLine = (type: NodeType, text: string, date: string) => `"${date} ${substanceFingerprint(type, text)}"`

/** What keeps a note from being verified, one item each; none when it can be. */
export function verifyBlockers(tree: Tree, n: RftNode, text: string): string[] {
  const out: string[] = []
  if (n.status === 'verified') return ['it is verified already']
  if (!['done', 'review'].includes(n.status)) out.push(`it is ${n.status || 'without a status'}: only a done note, or one in review, is verified`)
  if (n.supersededBy) out.push(`it is superseded by ${n.supersededBy}`)
  const empty = SUBSTANCE[n.type].filter(s => !sectionText(text, s).replace(/<!--[\s\S]*?-->/g, '').trim())
  if (empty.length === SUBSTANCE[n.type].length) out.push(`its ${SUBSTANCE[n.type].join(' and ')} ${empty.length > 1 ? 'are' : 'is'} empty: there is no claim to check`)
  if (n.type === 'experiment' && n.notebook && n.reproduced?.state !== 'ok') {
    out.push(n.reproduced ? `its notebook's last run ${n.reproduced.state === 'unchecked' ? 'checked nothing' : n.reproduced.state} (${n.reproduced.date}): it must reproduce the Result (ok) first` : 'its notebook has not run: it must reproduce the Result (ok) first')
  }
  if (n.type === 'direction') {
    let under = false
    walk(tree, m => { if (m.id !== n.id && m.status === 'verified') under = true }, [n.id])
    if (!under) out.push('no verified note under it confirms it')
  }
  return out
}

/** One line, as a reason. */
function oneLine(why: unknown): string {
  const one = typeof why === 'string' ? why.trim().replace(/\s+/g, ' ') : ''
  if (!one) throw new VerifyError('say why in one line (note): what was checked, and how (the notebook reproduced it, the proof was gone through, the paper was read against its summary)')
  if (one.length > MAX_WHY) throw new VerifyError(`keep the reason to one line (${MAX_WHY} characters at most; this one has ${one.length})`)
  return one
}

const noteOf = (loaded: Loaded, ref: string) => {
  const id = resolveId(loaded.tree, ref)
  if (!id) throw new VerifyError(`"${ref}" is not a note of the tree`)
  return loaded.tree.nodes[id]!
}

/** Claude's suggestion that the user verify a note, with its reason; refused while the note cannot be verified. */
export async function suggestVerified(io: Io, loaded: Loaded, ref: string, why: unknown, summary?: string): Promise<string> {
  const n = noteOf(loaded, ref)
  const text = loaded.texts[n.id]!
  const blockers = verifyBlockers(loaded.tree, n, text)
  if (blockers.length) throw new VerifyError(`${n.name} cannot be verified yet: ${blockers.join('; ')}.`)
  const reason = oneLine(why)
  let out = setField(text, 'suggested_verified', JSON.stringify(reason), 'status')
  if (summary?.trim()) out = setField(out, 'summary', JSON.stringify(summary.trim().replace(/\s+/g, ' ')), 'status')
  await io.write(join(loaded.config.vault, n.path), out)
  Object.assign(loaded, await load(io, loaded.config))
  return `Suggested verifying ${n.name}: ${reason}. Only the user verifies a note: they accept or dismiss this in the tree view (the note's drawer), and verifying locks it. It stays ${n.status} until then; never write status: verified yourself.`
}

/** The user verifies a note (the tree view's Verify): verified, locked and stamped, Claude's suggestion answered, a History line. */
export async function verifyNote(io: Io, loaded: Loaded, ref: string, date: string): Promise<string> {
  const n = noteOf(loaded, ref)
  if (n.status === 'verified') throw new VerifyError(`${n.name} is verified already`)
  let out = withStatus(loaded.texts[n.id]!, n, 'verified')
  out = removeField(out, 'suggested_verified')
  out = setField(out, 'locked', 'true', 'status')
  out = withHistory(out, `- ${date}: verified`)
  out = setField(out, 'verified', verifiedLine(n.type, out, date), 'status')
  await io.write(join(loaded.config.vault, n.path), out)
  await reloaded(io, loaded)
  return `${n.name} is verified and locked.`
}

/** The user dismisses Claude's suggestion to verify a note. */
export async function dismissVerified(io: Io, loaded: Loaded, ref: string): Promise<string> {
  const n = noteOf(loaded, ref)
  if (!n.suggestedVerified) return `${n.name} has no suggestion to verify it.`
  await io.write(join(loaded.config.vault, n.path), removeField(loaded.texts[n.id]!, 'suggested_verified'))
  Object.assign(loaded, await load(io, loaded.config))
  return `The suggestion to verify ${n.name} is dismissed.`
}

/** A verified note's text, gone to review: unlocked, with a History line saying why. */
export function reviewText(n: RftNode, text: string, reason: string, date: string): string {
  return withHistory(removeField(withStatus(text, n, 'review'), 'locked'), `- ${date}: to review, ${reason}`)
}

/**
 * Sets a verified note to review (by Claude through rft_set_status, or by the user in the tree
 * view). A locked one only once the user agrees to unlock it (`unlock`), as for a move.
 */
export async function toReview(io: Io, loaded: Loaded, ref: string, why: string | undefined, date: string, unlock = false): Promise<string> {
  const n = noteOf(loaded, ref)
  if (n.status === 'review') return `${n.name} is in review already.`
  if (n.status !== 'verified') throw new VerifyError(`review is for a verified note whose claim may no longer hold; ${n.name} is ${n.status}`)
  const text = loaded.texts[n.id]!
  if (isLocked(text) && !unlock) throw new LockedChange(n, 'review')
  const reason = why?.trim() ? why.trim().replace(/\s+/g, ' ') : 'asked'
  await io.write(join(loaded.config.vault, n.path), reviewText(n, text, reason, date))
  await reloaded(io, loaded)
  return `${n.name}: verified → review (${reason}), and unlocked. The user verifies it again, or gives it another status.`
}

/** Why a verified note no longer holds as verified (its substance changed since its stamp); null when it does, or it is not verified. */
export function changedReason(n: RftNode, text: string): string | null {
  if (n.status !== 'verified' || !n.verified) return null
  if (substanceFingerprint(n.type, text) === n.verified.fingerprint) return null
  return `its ${SUBSTANCE[n.type].join(' or ')} changed since it was verified on ${n.verified.date}`
}

/**
 * Keeps the verified notes honest, after the notes changed on disk (the session's watch of the
 * vault): a verified note with no stamp (the user wrote `status: verified` by hand) is stamped and
 * locked; one whose substance no longer matches its stamp goes to review, unlocked. Each file is
 * read again just before it is written, so two sessions do not write the same change twice.
 * The answer: one line per note changed.
 */
export async function keepVerified(io: Io, loaded: Loaded, date: string): Promise<string[]> {
  const done: string[] = []
  for (const n of Object.values(loaded.tree.nodes)) {
    if (n.status !== 'verified') continue
    const path = join(loaded.config.vault, n.path)
    let text: string
    try { text = (await io.read(path)).replace(/\r\n/g, '\n') } catch { continue }
    const fm = front(text)
    if (unquote(fm.status) !== 'verified') continue
    if (!n.verified || !unquote(fm.verified)) {
      let out = setField(text, 'locked', 'true', 'status')
      out = setField(out, 'verified', verifiedLine(n.type, out, date), 'status')
      await io.write(path, out)
      done.push(`${n.id} verified by hand: stamped and locked`)
      continue
    }
    const reason = changedReason(n, text)
    if (!reason) continue
    await io.write(path, reviewText(n, text, reason, date))
    done.push(`${n.id} to review: ${reason}`)
  }
  if (done.length) await reloaded(io, loaded)
  return done
}

/** Whether a note's text would say another verification than `before` does: its status to or from verified, or its stamp. */
export function changesVerified(before: string, after: string): boolean {
  const a = front(before), b = front(after)
  const isV = (fm: Record<string, string>) => unquote(fm.status) === 'verified'
  return isV(a) !== isV(b) || unquote(a.verified) !== unquote(b.verified)
}

/** Why Claude may not write a note's verification, and what it does instead. */
export const verifiedText = (n: { id: string; name: string } | null) =>
  `${n ? `Verifying ${n.name}` : 'Verifying a note'} is the user's alone: they verify it in the tree view, which locks it, and your edits that write \`status: verified\` or \`verified:\` are refused. To propose it, call rft_set_status {id${n ? `: "${n.id}"` : ''}, status: "verified", note: what was checked and how}; the user accepts or dismisses it.`
