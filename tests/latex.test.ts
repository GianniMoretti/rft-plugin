// An artifact's tables as LaTeX (web/latex.js), for the frame's Copy LaTeX button: a booktabs
// table float with its caption and a label, the header rows above the midrule, columns of numbers
// right-aligned, LaTeX's specials escaped and symbols in math, bold and italic kept.

import { describe, expect, test } from 'claude-code/testing'

import '../web/latex.js'

type Run = { text: string; b?: boolean; i?: boolean; sup?: boolean; sub?: boolean }
type Cell = { runs: Run[]; span?: number; align?: string }
type Table = { caption?: string; rows: { header?: boolean; cells: Cell[] }[] }
type Api = {
  escape: (text: string) => string
  cellLatex: (cell: Cell) => string
  columnSpec: (rows: Table['rows']) => string
  label: (caption: string) => string
  tableFloat: (table: Table) => string
  floatAround: (caption: string, tabular: string) => string
  isNumber: (text: string) => boolean
}

const X = (globalThis as unknown as { RftLatex: Api }).RftLatex

const cell = (text: string, more: Partial<Cell> = {}): Cell => ({ runs: [{ text }], ...more })
const row = (texts: string[], header = false) => ({ header, cells: texts.map(t => cell(t)) })

describe('artifact tables as LaTeX', () => {
  test('the results table of the demo, as the preview the user chose', () => {
    const table: Table = {
      caption: 'Results',
      rows: [
        row(['Run', 'Method', 'Gap at 1k (points)', 'Seeds'], true),
        row(['E05', 'CutMix, 200 epochs', '0.3 ± 0.5', '5']),
      ],
    }
    expect(X.tableFloat(table)).toBe([
      '\\begin{table}[t]',
      '\\centering',
      '\\caption{Results}',
      '\\label{tab:results}',
      '\\begin{tabular}{llrr}',
      '\\toprule',
      'Run & Method & Gap at 1k (points) & Seeds \\\\',
      '\\midrule',
      'E05 & CutMix, 200 epochs & 0.3 $\\pm$ 0.5 & 5 \\\\',
      '\\bottomrule',
      '\\end{tabular}',
      '\\end{table}',
    ].join('\n'))
  })

  test("LaTeX's specials are escaped, and symbols go into math", () => {
    expect(X.escape('50% of a_b & c #1 {x} $5 ~ ^ \\')).toBe('50\\% of a\\_b \\& c \\#1 \\{x\\} \\$5 \\textasciitilde{} \\textasciicircum{} \\textbackslash{}')
    expect(X.escape('−0.3 ± 0.5, α = 0.2 → R² ≥ 0.9 × 2… — ok')).toBe('$-$0.3 $\\pm$ 0.5, $\\alpha$ = 0.2 $\\rightarrow$ R$^2$ $\\geq$ 0.9 $\\times$ 2\\dots{} --- ok')
    expect(X.escape('  two\n spaces  ')).toBe(' two spaces ')
  })

  test('bold, italic, super- and subscripts are kept; runs of the same kind join; the edges are trimmed', () => {
    expect(X.cellLatex({ runs: [{ text: ' 0.3', b: true }, { text: ' ± 0.5 ', b: true }] })).toBe('\\textbf{0.3 $\\pm$ 0.5}')
    expect(X.cellLatex({ runs: [{ text: 'R' }, { text: '2', sup: true }, { text: ' best', i: true }] })).toBe('R\\textsuperscript{2}\\textit{ best}')
    expect(X.cellLatex({ runs: [{ text: 'x' }, { text: 'i', sub: true }] })).toBe('x\\textsubscript{i}')
    expect(X.cellLatex({ runs: [] })).toBe('')
  })

  test('a column of numbers is right-aligned; text, a mixed column or a header is not', () => {
    expect(['5', '0.3 ± 0.5', '-4.1 ± 0.6', '−2.7', '+3.1 ± 1.3', '12%', '1,024', '3e-4', '~0.5', '0.4 +/- 0.1'].every(X.isNumber)).toBe(true)
    expect(['E05', 'not closed', '5 seeds', ''].some(X.isNumber)).toBe(false)
    const rows = [row(['Method', 'Gap', 'Note'], true), row(['A', '0.1', 'x']), row(['B', '—', '0.2']), row(['C', '0.3', 'y'])]
    expect(X.columnSpec(rows)).toBe('lrl')
    // a cell the page right-aligns (td.num) right-aligns its column
    expect(X.columnSpec([{ cells: [cell('a'), cell('n/a', { align: 'r' })] }])).toBe('lr')
  })

  test('several header rows, a cell over several columns, short rows padded', () => {
    const out = X.tableFloat({
      caption: 'Mean change across backbones',
      rows: [
        { header: true, cells: [cell(''), cell('Linear probe', { span: 2 }), cell('MLP probe', { span: 2 })] },
        row(['Method', 'patches', 'geometry', 'patches', 'geometry'], true),
        row(['BFD', '+3.1 ± 1.3', '−0.3 ± 0.5', '+0.5 ± 0.7', '0.0 ± 0.9']),
        row(['RASA', '0.0 ± 0.0']),
      ],
    })
    expect(out).toContain('\\begin{tabular}{lrrrr}')
    expect(out).toContain(' & \\multicolumn{2}{c}{Linear probe} & \\multicolumn{2}{c}{MLP probe} \\\\\nMethod & patches & geometry & patches & geometry \\\\\n\\midrule')
    expect(out).toContain('BFD & +3.1 $\\pm$ 1.3 & $-$0.3 $\\pm$ 0.5 & +0.5 $\\pm$ 0.7 & 0.0 $\\pm$ 0.9 \\\\')
    expect(out).toContain('RASA & 0.0 $\\pm$ 0.0 &  &  &  \\\\')
    expect(out).toContain('\\label{tab:mean-change-across-backbones}')
  })

  test('the caption: escaped, else "Table"; the label from its words, kept short', () => {
    expect(X.tableFloat({ rows: [row(['a'])] })).toContain('\\caption{Table}\n\\label{tab:table}')
    expect(X.tableFloat({ caption: 'Gap at 1k: 50% & more', rows: [row(['a'])] })).toContain('\\caption{Gap at 1k: 50\\% \\& more}')
    expect(X.label('Gap at 1k: 50% & more')).toBe('tab:gap-at-1k-50-more')
    expect(X.label('Résumé of the semantic and geometric radars across every backbone we ran')).toBe('tab:resume-of-the-semantic-and-geometric')
    // no header row: no midrule
    expect(X.tableFloat({ caption: 'x', rows: [row(['a', '1'])] })).not.toContain('\\midrule')
  })

  test('a table its notebook typeset is copied as that tabular, in a float with its caption', () => {
    const tabular = '% needs: \\usepackage[table]{xcolor}\n\\begin{tabular}{lc}\n\\toprule\nA & \\cellcolor[HTML]{ABC5E0}$+$2.1 \\\\\n\\bottomrule\n\\end{tabular}\n'
    expect(X.floatAround('Scores, 50% & more', tabular)).toBe([
      '\\begin{table}[t]', '\\centering', '\\caption{Scores, 50\\% \\& more}', '\\label{tab:scores-50-more}',
      '% needs: \\usepackage[table]{xcolor}', '\\begin{tabular}{lc}', '\\toprule', 'A & \\cellcolor[HTML]{ABC5E0}$+$2.1 \\\\', '\\bottomrule', '\\end{tabular}',
      '\\end{table}',
    ].join('\n'))
  })

  test('LaTeX that is a float already is copied as it is', () => {
    const float = '% needs graphicx\n\\providecolor{better1}{HTML}{DDEBF2}\n\\begin{table*}[t]\n\\centering\n\\caption{Its own}\n\\resizebox{\\linewidth}{!}{%\n\\begin{tabular}{lc}\nA & \\cellcolor{better1}+2.1 \\\\\n\\end{tabular}}\n\\end{table*}'
    expect(X.floatAround('Scores', '\n' + float + '\n')).toBe(float)
  })
})
