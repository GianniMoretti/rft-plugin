// The tree view's scratchpad (web/scratchpad.js): the to-dos counted for its button, Enter
// continuing a list, Ctrl/Cmd+Enter making lines to-dos or ticking them, and the To-do button.

import { describe, expect, test } from 'claude-code/testing'

import '../web/scratchpad.js'

type Edit = { from: number; to: number; insert: string; caret?: number; start?: number; end?: number }
type Api = {
  todos: (text: string) => { open: number; done: number }
  continueList: (text: string, start: number, end: number) => Edit | null
  toggleTodo: (text: string, start: number, end: number) => Edit
  newTodo: (text: string, at: number) => Edit
}

const P = (globalThis as unknown as { RftScratchpad: Api }).RftScratchpad

/** A text with `|` at the caret, or `«` … `»` round the selection: the text, and where they are. */
function parse(marked: string): [string, number, number] {
  if (marked.includes('|')) {
    const at = marked.indexOf('|')
    return [marked.replace('|', ''), at, at]
  }
  const start = marked.indexOf('«')
  const end = marked.indexOf('»') - 1
  return [marked.replace('«', '').replace('»', ''), start, end]
}

/** The text once the edit is made, marked as `parse` reads it; 'no edit' for none. */
function after(text: string, e: Edit | null): string {
  if (!e) return 'no edit'
  const t = text.slice(0, e.from) + e.insert + text.slice(e.to)
  const s = e.start ?? e.caret!, en = e.end ?? e.caret!
  return s === en ? `${t.slice(0, s)}|${t.slice(s)}` : `${t.slice(0, s)}«${t.slice(s, en)}»${t.slice(en)}`
}

const enter = (marked: string) => { const [t, s, e] = parse(marked); return after(t, P.continueList(t, s, e)) }
const toggle = (marked: string) => { const [t, s, e] = parse(marked); return after(t, P.toggleTodo(t, s, e)) }
const button = (marked: string) => { const [t, s] = parse(marked); return after(t, P.newTodo(t, s)) }

describe('scratchpad', () => {
  test('counts the open and done to-dos, outside code blocks', () => {
    const text = [
      '# Today', '- [ ] email the lab', '* [x] rerun E04', '  - [ ] nested', '1. [X] numbered', '- [ ]', '- plain item',
      '-[ ] no space', '[ ] no mark', '```', '- [ ] in code', '```', '- [ ] after the code',
    ].join('\n')
    expect(P.todos(text)).toEqual({ open: 4, done: 2 })
    expect(P.todos('')).toEqual({ open: 0, done: 0 })
  })

  test('Enter continues a list: the same mark, a box unticked, a number one up', () => {
    expect(enter('- [ ] buy milk|')).toBe('- [ ] buy milk\n- [ ] |')
    expect(enter('- [x] done|')).toBe('- [x] done\n- [ ] |')
    expect(enter('  * item|')).toBe('  * item\n  * |')
    expect(enter('3. three|')).toBe('3. three\n4. |')
    expect(enter('9) nine|')).toBe('9) nine\n10) |')
    // the text after the caret moves into the new item
    expect(enter('- ab|cd')).toBe('- ab\n- |cd')
    expect(enter('a\n- [ ] one|\nb')).toBe('a\n- [ ] one\n- [ ] |\nb')
  })

  test('Enter on an empty item ends the list; elsewhere it is a plain Enter', () => {
    expect(enter('- [ ] a\n- [ ] |')).toBe('- [ ] a\n|')
    expect(enter('- [ ] a\n- [ ]|')).toBe('- [ ] a\n|')
    expect(enter('- a\n  - |')).toBe('- a\n|')
    expect(enter('plain text|')).toBe('no edit')
    expect(enter('-| [ ] x')).toBe('no edit') // the caret inside the mark
    expect(enter('«- [ ] x»')).toBe('no edit') // a selection
    expect(enter('-|')).toBe('no edit')
  })

  test('Ctrl+Enter makes a line a to-do, or ticks and unticks it, the caret kept on its text', () => {
    expect(toggle('buy milk|')).toBe('- [ ] buy milk|')
    expect(toggle('|buy milk')).toBe('- [ ] |buy milk')
    expect(toggle('  - item|')).toBe('  - [ ] item|')
    expect(toggle('2. item|')).toBe('2. [ ] item|')
    expect(toggle('- [ ] a|')).toBe('- [x] a|')
    expect(toggle('- [X] a|')).toBe('- [ ] a|')
    expect(toggle('one\n- [ ] t|wo\nthree')).toBe('one\n- [x] t|wo\nthree')
    expect(toggle('|')).toBe('|') // a blank line stays blank
  })

  test('Ctrl+Enter on a selection: the plain lines become to-dos first, then all are ticked, then unticked', () => {
    expect(toggle('«a\n- [x] b\n\nc»')).toBe('«- [ ] a\n- [x] b\n\n- [ ] c»')
    expect(toggle('«- [ ] a\n- [x] b»')).toBe('«- [x] a\n- [x] b»')
    expect(toggle('«- [x] a\n- [x] b»')).toBe('«- [ ] a\n- [ ] b»')
    // a selection that ends at the start of a line leaves that line out
    expect(toggle('«a\n»b')).toBe('«- [ ] a\n»b')
    // one that starts inside a line takes the whole line
    expect(toggle('x«y\nz»')).toBe('- [ ] x«y\n- [ ] z»')
  })

  test('the To-do button adds one below the caret\'s line, or on it when blank', () => {
    expect(button('|')).toBe('- [ ] |')
    expect(button('notes|')).toBe('notes\n- [ ] |')
    expect(button('no|tes\nmore')).toBe('notes\n- [ ] |\nmore')
    expect(button('  - [ ] a|')).toBe('  - [ ] a\n  - [ ] |')
    expect(button('a\n|\nb')).toBe('a\n- [ ] |\nb')
    expect(button('a\n  |')).toBe('a\n- [ ] |')
  })
})
