// The manual in parts. skills/rft-manual/SKILL.md is its core (what the notes are, when to create
// and update them, the index of the parts); every other subject is a file beside it, read alone
// when the work needs it, so that no session carries the whole manual. The rules and the commands'
// prompts cite a part by its file, in the plugin's folder: one Read brings it, without loading
// the skill first. tests/test_manual.py holds the parts, the index and these citations together.

/** The manual's folder, in the plugin's. */
export const MANUAL_DIR = 'skills/rft-manual'

/** The parts, in the order of the core's index. */
export const PARTS = ['concepts-code', 'literature', 'map', 'artifacts', 'notebooks', 'planning', 'queue', 'writing', 'slides', 'comments', 'inbox', 'grilling'] as const

export type Part = (typeof PARTS)[number]

/** The manual's folder for the plugin installed at `root`. */
export const manualDir = (root: string): string => `${root.replace(/\/+$/, '')}/${MANUAL_DIR}`

/** How a text cites a part, or one section of it: the file to read. `dir`: the manual's folder, when the text knows it. */
export function cite(dir: string | undefined, part: Part, section?: string): string {
  const file = dir ? `${dir}/${part}.md` : `${part}.md`
  return section ? `the manual's "${section}" (${file})` : `the manual's ${file}`
}
