// Templates (docs/design/manuscript.md): what a new document starts from. A template is a folder
// of files, copied into the new document as it is, sample text included; the document then owns
// its files and keeps no tie to the template, so a template changed afterwards changes no
// document. Two are built in, `article` and `report` (what a document's kind was). A folder
// `vault/templates/<name>/` is a template of the vault's own: a conference's kit, a thesis class,
// put there by hand or loaded from a zip or a folder in the page (server/rft_documents.py). It may
// say what its documents compile with and which file is the main one in a small settings file,
// `template.json` ({"engine": "xelatex", "main": "thesis.tex"}), which is not copied.
//
// The vault's `templates/` folder also holds the notes' own templates (`_experiment.md`, files):
// a document's template is a folder there.

import type { Engine } from './tracking'
import { ENGINES } from './tracking'
import type { Io } from './vault'
import { join } from './vault'

export const TEMPLATES_DIR = 'templates'
export const TEMPLATE_SETTINGS = 'template.json'
export const BUILT_IN = ['article', 'report'] as const
export type BuiltIn = (typeof BUILT_IN)[number]
export const isBuiltIn = (name: string): name is BuiltIn => (BUILT_IN as readonly string[]).includes(name)
/** A vault template's name: its folder's, with no space and no leading dot. */
export const TEMPLATE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Plain text as LaTeX prints it: its special characters escaped (a title typed in the tree view). */
export const texText = (s: string) =>
  s.replace(/[\\&%$#_{}~^]/g, c => ({ '\\': '\\textbackslash{}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' } as Record<string, string>)[c] ?? `\\${c}`)

/** A built-in template's main.tex: `article` (a paper) or `report` (a thesis chapter). Plain LaTeX: nothing of the plugin's. */
export function documentTemplate(title: string, kind: BuiltIn): string {
  return `\\documentclass[11pt]{${kind}}
\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage{amsmath,amssymb,amsthm}
\\usepackage{graphicx,booktabs}
\\usepackage[numbers]{natbib}
\\usepackage{hyperref}

\\theoremstyle{plain}
\\newtheorem{theorem}{Theorem}
\\newtheorem{lemma}[theorem]{Lemma}
\\newtheorem{proposition}[theorem]{Proposition}
\\newtheorem{corollary}[theorem]{Corollary}
\\theoremstyle{definition}
\\newtheorem{definition}{Definition}

\\title{${title}}
\\author{}
\\date{\\today}

\\begin{document}
\\maketitle
${kind === 'report' ? `\n\\chapter{${title}}\n` : ''}
% Your text. A passage taken from your notes sits between two comment lines, %%% Kind: title %%%
% and %%% end %%%: change it as you like, and leave the two lines where they are.

\\bibliographystyle{plainnat}
\\bibliography{refs}
\\end{document}
`
}

/** A built-in template's files, by their path in the document: its main.tex with the title set in, and an empty refs.bib. */
export const builtInFiles = (name: BuiltIn, title: string): Record<string, string> => ({ 'main.tex': documentTemplate(texText(title), name), 'refs.bib': '' })

/** Every file of a vault template, by its path inside it, in order; its settings file and what a file manager leaves (.DS_Store) left out. */
export async function templateFiles(io: Io, vault: string, name: string): Promise<string[]> {
  const root = join(vault, TEMPLATES_DIR, name)
  const out: string[] = []
  const visit = async (dir: string) => {
    let entries: Awaited<ReturnType<Io['list']>>
    try { entries = await io.list(join(root, dir)) } catch { return }
    for (const f of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const rel = dir ? `${dir}/${f.name}` : f.name
      if (f.kind === 'dir') await visit(rel)
      else if (rel !== TEMPLATE_SETTINGS && f.name !== '.DS_Store') out.push(rel)
    }
  }
  await visit('')
  return out
}

export type TemplateSettings = { engine?: Engine; main?: string }

/** What a vault template says of its documents (template.json); nothing when it has no such file, or one that is not JSON. */
export async function templateSettings(io: Io, vault: string, name: string): Promise<TemplateSettings> {
  let d: Record<string, unknown>
  try { d = JSON.parse(await io.read(join(vault, TEMPLATES_DIR, name, TEMPLATE_SETTINGS))) as Record<string, unknown> } catch { return {} }
  if (!d || typeof d !== 'object') return {}
  return {
    ...((ENGINES as readonly string[]).includes(String(d.engine)) ? { engine: d.engine as Engine } : {}),
    ...(typeof d.main === 'string' && d.main.trim() ? { main: d.main.trim() } : {}),
  }
}

/** The vault's own templates, by name: the folders of vault/templates/. */
export async function vaultTemplates(io: Io, vault: string): Promise<string[]> {
  const dir = join(vault, TEMPLATES_DIR)
  if (!(await io.exists(dir))) return []
  let entries: Awaited<ReturnType<Io['list']>>
  try { entries = await io.list(dir) } catch { return [] }
  return entries.filter(f => f.kind === 'dir' && TEMPLATE_NAME.test(f.name) && !isBuiltIn(f.name)).map(f => f.name).sort()
}

/** The templates a document can be made from, as a sentence says them. */
export const templatesWords = async (io: Io, vault: string) => {
  const own = await vaultTemplates(io, vault)
  return `${BUILT_IN.join(' and ')} (built in)${own.length ? `; ${own.join(', ')} (${vault}/${TEMPLATES_DIR}/)` : ''}`
}
