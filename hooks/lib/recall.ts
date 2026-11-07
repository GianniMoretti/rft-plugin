// Recall: when Claude is about to search the vault's notes with Grep, Glob or a shell grep, it is
// pointed to rft_search and rft_map first, which answer from the summaries without opening the
// files. Reading one note's file is the last layer and is left alone.

import { resolvePath } from './vault'

const SEARCH_CMD = /(^|[\s|;&(])(grep|egrep|rg|ag|ack|find|fd)\s/

/** Whether `p` is `dir` or inside it (both absolute, resolved). */
const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith('/') ? dir : `${dir}/`)

/** Whether this tool call searches the vault: Grep or Glob in it, or a shell grep / find naming it. */
export function searchesVault(tool: string, input: Record<string, unknown>, vault: string, cwd: string): boolean {
  const dir = typeof input.path === 'string' && input.path ? resolvePath(cwd, input.path) : resolvePath(cwd, '.')
  if (tool === 'Grep') return inside(dir, vault)
  if (tool === 'Glob') {
    // the folder searched, or the fixed head of the pattern (vault/**/*.md)
    const head = (typeof input.pattern === 'string' ? input.pattern : '').split(/[*?[{]/)[0]!
    return inside(dir, vault) || (!!head && inside(resolvePath(dir, head), vault))
  }
  if (tool === 'Bash') {
    const cmd = typeof input.command === 'string' ? input.command : ''
    if (!SEARCH_CMD.test(cmd)) return false
    if (cmd.includes(vault)) return true
    // the vault named relative to the session's folder, or a search of the folder when it is the vault
    const rel = vault.startsWith(`${cwd}/`) ? vault.slice(cwd.length + 1) : null
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (rel && new RegExp(`(^|[\\s'"=])(\\./)?${esc(rel)}(/|[\\s'"]|$)`).test(cmd)) return true
    return inside(resolvePath(cwd, '.'), vault) && /\s(\.|\*\.md|\*\*)(\s|$|\/)/.test(cmd)
  }
  return false
}

export const RECALL_HINT =
  'rft: this searches the notes of the reasoning tree. rft_search answers from them directly (each match with its one-line summary, ' +
  'where it sits and the line that matched, the concepts whose digest matches first), rft_map <concept> gives a concept\'s state and ' +
  'its notes one per line, rft_graph <id> a note\'s neighbours: use them first, and open a note\'s file only for the detail.'
