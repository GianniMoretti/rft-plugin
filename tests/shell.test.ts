// The files a shell command writes, read from the command: what the guards of locked notes,
// priorities and dates decide on.

import { describe, expect, mock, test } from 'claude-code/testing'

import { matches, shellWrites } from '../hooks/lib/shell'
import { CWD, E02, demoFiles, world } from './fixture'

const cwd = '/work/demo'
const note = `${cwd}/vault/experiments/${E02}.md`
const writes = (cmd: string) => shellWrites(cmd, cwd)
const hits = (cmd: string) => writes(cmd).files.some(f => matches(f, note))

describe('shell writes', () => {
  test('commands that write the note', () => {
    for (const cmd of [
      `echo x >> "vault/experiments/${E02}.md"`,
      'echo x > vault/experiments/E02\\ Variant\\ run.md',
      `printf 'priority: high\\n' >> vault/experiments/E02*`,
      `sed -i 's/a/b/' "vault/experiments/${E02}.md"`,
      `sed -i.bak -e 's/a/b/' vault/experiments/E0?\\ *`,
      'perl -pi -e s/a/b/ vault/experiments/E02*',
      `cat x | tee -a "vault/experiments/${E02}.md" > /dev/null`,
      `mv "vault/experiments/${E02}.md" /tmp/old.md`,
      `cp /tmp/new.md "vault/experiments/${E02}.md"`,
      `cp /tmp/x/"${E02}.md" vault/experiments/`,
      `rm -f "vault/experiments/${E02}.md"`,
      `cd vault/experiments && sed -i 's/a/b/' "${E02}.md"`,
      `truncate -s 0 "vault/experiments/${E02}.md"`,
      `dd if=/dev/zero of="vault/experiments/${E02}.md" count=0`,
      `sudo sed -i 's/a/b/' ${cwd}/vault/experiments/E02*.md`,
    ]) expect({ cmd, hit: hits(cmd) }).toEqual({ cmd, hit: true })
  })

  test('commands that only read it, or write elsewhere', () => {
    for (const cmd of [
      `cat "vault/experiments/${E02}.md"`,
      `grep -n "priority:" "vault/experiments/${E02}.md" > /tmp/out.txt`,
      `sed -n '1,10p' "vault/experiments/${E02}.md"`,
      `sed 's/a/b/' "vault/experiments/${E02}.md" > /tmp/copy.md`,
      `cp "vault/experiments/${E02}.md" /tmp/backup.md`,
      `wc -l vault/experiments/* 2>/dev/null`,
      `echo "start: 2026-12-01" > notes.txt`,
      `awk '/priority:/' vault/experiments/E02* >> report.txt`,
      `git diff -- "vault/experiments/${E02}.md" | head`,
      `echo 'vault/experiments/E02*' > list.txt`,
    ]) expect({ cmd, hit: hits(cmd) }).toEqual({ cmd, hit: false })
  })

  test('an interpreter is a script, whose writes are not known', () => {
    expect(writes('python train.py --run E02 > runs/E02.log')).toEqual({ files: [`${cwd}/runs/E02.log`], script: true })
    expect(writes("python3 - <<'EOF'\nopen('x','w')\nEOF").script).toBe(true)
    expect(writes('bash -c "echo hi"').script).toBe(true)
    expect(writes('sed -i s/a/b/ f.md').script).toBe(false)
    expect(writes('perl -ne print f.md').script).toBe(true)
  })

  test('globs match one path segment; a quoted star is literal', () => {
    expect(matches('/a/E02*', '/a/E02 x.md')).toBe(true)
    expect(matches('/a/*', '/a/b/c.md')).toBe(false)
    expect(matches('/a/E0[12]*', '/a/E02 x.md')).toBe(true)
    const [quoted] = writes(`echo x > 'vault/E02*'`).files
    expect(matches(quoted!, `${cwd}/vault/E02 x.md`)).toBe(false)
    expect(matches(quoted!, `${cwd}/vault/E02*`)).toBe(true)
  })
})

describe('the guards on shell commands', () => {
  const lockedE02 = () => {
    const files = demoFiles()
    const path = `vault/experiments/${E02}.md`
    files[path] = files[path]!.replace('---\n\n#', 'locked: true\npriority: high\n---\n\n#')
    return files
  }

  test('a command that reads a locked note, or mentions priority: while writing elsewhere, passes', async ($, on) => {
    mock.clock(on)
    world(on, lockedE02())
    on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }) as never)
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    for (const command of [
      `grep -n "priority:" "vault/experiments/${E02}.md" > /tmp/out.txt`,
      `cp "vault/experiments/${E02}.md" /tmp/backup.md`,
      `echo "priority: high, start: monday" > /tmp/todo.txt`,
    ]) {
      const res = await $.tool.call({ tool: 'Bash', command } as never)
      expect({ command, deny: (res as { deny?: string }).deny }).toEqual({ command, deny: undefined })
    }
  })

  test('a command that writes it is refused', async ($, on) => {
    mock.clock(on)
    world(on, lockedE02())
    on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }) as never)
    await $.session.start({ cwd: CWD, source: 'startup' } as never)
    const res = await $.tool.call({ tool: 'Bash', command: `cd vault/experiments && cp /tmp/x.md "${E02}.md"` } as never)
    expect((res as { deny?: string }).deny).toContain('is locked')
  })
})
