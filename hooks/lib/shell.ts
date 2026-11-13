// The files a shell command writes, read from the command itself: the targets of its
// redirections, and the file arguments of the commands that change files (tee, sed -i, perl -i,
// awk -i inplace, mv, cp, rm, truncate, dd of=). The guards of locked notes, priorities and dates
// decide on these files rather than on words in the command, so a command that only reads a note,
// or writes elsewhere, passes. A script run by an interpreter (python, node, a shell -c, ...) may
// write anything: `script` says so, and the guards fall back to what the command names.

import { resolvePath } from './vault'

export type ShellWrites = {
  /** The files written, as absolute paths; a glob stays a glob (see `matches`). */
  files: string[]
  /** Whether the command runs a script whose writes cannot be read from it. */
  script: boolean
}

type Token = { text: string; op?: boolean }

/** Marks a quoted or escaped glob character (a backslash would read as a path separator). */
const LIT = '\uE000'

/** Words and operators, with quotes and backslashes resolved; a quoted glob character is marked literal. */
function tokens(cmd: string): Token[] {
  const out: Token[] = []
  let cur = '', has = false, i = 0
  const push = () => { if (has) out.push({ text: cur }); cur = ''; has = false }
  while (i < cmd.length) {
    const c = cmd[i]!
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1)
      const lit = cmd.slice(i + 1, end < 0 ? undefined : end)
      cur += lit.replace(/[*?[]/g, m => `${LIT}${m}`); has = true
      i = end < 0 ? cmd.length : end + 1
    } else if (c === '"') {
      i++
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === '\\' && i + 1 < cmd.length && '"\\$`'.includes(cmd[i + 1]!)) i++
        cur += /[*?[]/.test(cmd[i]!) ? `${LIT}${cmd[i]}` : cmd[i]!
        i++
      }
      has = true; i++
    } else if (c === '\\' && i + 1 < cmd.length) {
      if (cmd[i + 1] !== '\n') cur += /[*?[]/.test(cmd[i + 1]!) ? `${LIT}${cmd[i + 1]}` : cmd[i + 1]!
      has = true; i += 2
    } else if (/\s/.test(c)) {
      push()
      if (c === '\n') out.push({ text: ';', op: true })
      i++
    } else {
      const op = /^(&&|\|\||;|\||&>>|&>|&|\d*>>|\d*>&\d*-?|\d*>|<<<|<<-?|<)/.exec(cmd.slice(i))
      // a digit starts a redirection only at the start of a word (2>err), not inside one (a2>b)
      if (op && !(has && /^\d/.test(op[0]))) {
        push()
        out.push({ text: op[0], op: true })
        i += op[0].length
      } else {
        cur += c; has = true; i++
      }
    }
  }
  push()
  return out
}

const INTERPRETERS = new Set(['python', 'python3', 'python2', 'node', 'deno', 'bun', 'ruby', 'php', 'bash', 'sh', 'zsh', 'fish', 'Rscript', 'julia', 'osascript'])
const WRAPPERS = new Set(['sudo', 'env', 'nice', 'nohup', 'time', 'command', 'exec', 'xargs', 'timeout'])

const unescape = (t: string) => t.split(LIT).join('')
const isGlob = (t: string) => new RegExp(`(^|[^${LIT}])[*?[]`).test(t)

/** The non-option arguments of `args`, skipping the values of the options in `withValue`. */
function operands(args: string[], withValue: string[] = []): string[] {
  const out: string[] = []
  let rest = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (rest || !a.startsWith('-') || a === '-') out.push(a)
    else if (a === '--') rest = true
    else if (withValue.includes(a)) i++
  }
  return out
}

/** The files one simple command (its words) writes, and whether it runs a script. */
function commandWrites(words: string[]): ShellWrites {
  let w = words
  // past the wrappers (sudo, env, timeout 60, ...) and the variable settings, to the command run
  while (w.length && (WRAPPERS.has(w[0]!) || /^\w+=/.test(w[0]!))) {
    const wrapper = w[0]!
    w = w.slice(1)
    while (w.length && w[0]!.startsWith('-')) w = w.slice(1) // the wrapper's own options
    if (wrapper === 'timeout' && w.length && /^\d/.test(w[0]!)) w = w.slice(1)
  }
  const [name = '', ...args] = w
  // python3.11 is python, gawk stays gawk
  const base = name.split('/').pop()!.replace(/\d+(\.\d+)*$/, '')
  const files: string[] = []
  switch (base) {
    case 'tee':
      files.push(...operands(args))
      break
    case 'sed': {
      if (!args.some(a => /^-[^-]*i/.test(a) || a.startsWith('--in-place'))) break
      const hasScript = args.some(a => a === '-e' || a === '-f' || a.startsWith('--expression') || a.startsWith('--file'))
      const ops = operands(args, ['-e', '-f', '--expression', '--file', '-l'])
      files.push(...(hasScript ? ops : ops.slice(1)))
      break
    }
    case 'perl': {
      if (!args.some(a => /^-[a-zA-Z]*i/.test(a))) return { files, script: true }
      const hasScript = args.some(a => /^-[a-zA-Z]*[eE]$/.test(a))
      const ops: string[] = []
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!
        if (/^-[a-zA-Z]*[eE]$/.test(a)) i++
        else if (!a.startsWith('-')) ops.push(a)
      }
      files.push(...(hasScript ? ops : ops.slice(1)))
      break
    }
    case 'awk': case 'gawk': {
      const inplace = args.some((a, i) => a === '-i' && args[i + 1] === 'inplace') || args.includes('-iinplace')
      if (!inplace) break
      const hasProgram = args.includes('-f')
      const ops = operands(args, ['-i', '-f', '-v'])
      files.push(...(hasProgram ? ops : ops.slice(1)))
      break
    }
    case 'mv': case 'cp': case 'install': case 'rsync': {
      const ops = operands(args, ['-t', '--target-directory', '-S', '--suffix', '-m', '-o', '-g'])
      const target = args.find((a, i) => args[i - 1] === '-t' || a.startsWith('--target-directory='))
      const dest = target ? target.replace(/^--target-directory=/, '') : ops[ops.length - 1]
      const sources = target ? ops : ops.slice(0, -1)
      if (dest) files.push(dest, ...sources.map(s => `${dest.replace(/\/$/, '')}/${s.split('/').pop()}`))
      if (base === 'mv' || base === 'rsync') files.push(...sources)
      break
    }
    case 'rm': case 'unlink': case 'shred':
      files.push(...operands(args))
      break
    case 'truncate':
      files.push(...operands(args, ['-s', '--size', '-r', '--reference']))
      break
    case 'dd':
      for (const a of args) if (a.startsWith('of=')) files.push(a.slice(3))
      break
    default:
      if (INTERPRETERS.has(base)) return { files, script: true }
  }
  return { files, script: false }
}

/** The files a shell command writes, resolved from `cwd` (a `cd` in the command moves it). */
export function shellWrites(cmd: string, cwd: string): ShellWrites {
  const out: ShellWrites = { files: [], script: false }
  let dir = cwd
  let words: string[] = []
  const toks = tokens(cmd)
  const end = () => {
    if (words[0] === 'cd' && words[1]) dir = resolvePath(dir, unescape(words[1]))
    else if (words.length) {
      const w = commandWrites(words)
      out.files.push(...w.files.map(f => resolvePath(dir, f)))
      out.script ||= w.script
    }
    words = []
  }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    if (!t.op) { words.push(t.text); continue }
    if (/^(&&|\|\||;|\||&)$/.test(t.text)) { end(); continue }
    if (/^(\d*>>?|&>>?)$/.test(t.text)) {
      const target = toks[i + 1]
      if (target && !target.op) { out.files.push(resolvePath(dir, target.text)); i++ }
      continue
    }
    // a heredoc feeds a script; an input redirection reads
    if (/^<<-?$/.test(t.text)) out.script ||= INTERPRETERS.has((words[0] ?? '').split('/').pop()!.replace(/\d+(\.\d+)*$/, ''))
    if (/^(<|<<-?|<<<)$/.test(t.text) && toks[i + 1] && !toks[i + 1]!.op) i++
  }
  end()
  out.files = out.files.filter(f => !f.startsWith('/dev/'))
  return out
}

/** Whether a written file (a path, perhaps a glob) is `path`. */
export function matches(file: string, path: string): boolean {
  if (!isGlob(file)) return unescape(file) === path
  let re = ''
  for (let i = 0; i < file.length; i++) {
    const c = file[i]!
    if (c === LIT && i + 1 < file.length) { re += file[++i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue }
    if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '[') {
      const close = file.indexOf(']', i + 1)
      if (close < 0) re += '\\['
      else { re += `[${file.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; i = close }
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`).test(path)
}
