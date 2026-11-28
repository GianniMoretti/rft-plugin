// rft artifact LaTeX: a table of a concept's artifact as a LaTeX table float (booktabs), for the
// frame's Copy LaTeX button. Pure functions over a table read from the page (frame.js reads it):
//   { caption, rows: [{ header, cells: [{ runs: [{ text, b, i, sup, sub }], span, align }] }] }
// Loaded inside the artifact's frame before frame.js, and by the plugin's tests; it sets
// `globalThis.RftLatex` and touches nothing else.
(function (root) {
  'use strict'

  // text characters LaTeX reads as commands, and symbols it needs in math mode
  const SPECIAL = { '\\': '\\textbackslash{}', '&': '\\&', '%': '\\%', $: '\\$', '#': '\\#', _: '\\_', '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' }
  const SYMBOL = {
    '±': '$\\pm$', '∓': '$\\mp$', '−': '$-$', '×': '$\\times$', '÷': '$\\div$', '≤': '$\\leq$', '≥': '$\\geq$', '≠': '$\\neq$',
    '≈': '$\\approx$', '∼': '$\\sim$', '∝': '$\\propto$', '∞': '$\\infty$', '→': '$\\rightarrow$', '←': '$\\leftarrow$',
    '↑': '$\\uparrow$', '↓': '$\\downarrow$', '°': '$^\\circ$', '²': '$^2$', '³': '$^3$', '¹': '$^1$', '·': '$\\cdot$',
    '…': '\\dots{}', '–': '--', '—': '---', '✓': '$\\checkmark$', '✗': '$\\times$', '‰': '\\textperthousand{}',
    α: '$\\alpha$', β: '$\\beta$', γ: '$\\gamma$', δ: '$\\delta$', ε: '$\\epsilon$', ζ: '$\\zeta$', η: '$\\eta$', θ: '$\\theta$',
    κ: '$\\kappa$', λ: '$\\lambda$', μ: '$\\mu$', µ: '$\\mu$', ν: '$\\nu$', ξ: '$\\xi$', π: '$\\pi$', ρ: '$\\rho$', σ: '$\\sigma$',
    τ: '$\\tau$', φ: '$\\phi$', χ: '$\\chi$', ψ: '$\\psi$', ω: '$\\omega$', Γ: '$\\Gamma$', Δ: '$\\Delta$', Θ: '$\\Theta$',
    Λ: '$\\Lambda$', Π: '$\\Pi$', Σ: '$\\Sigma$', Φ: '$\\Phi$', Ψ: '$\\Psi$', Ω: '$\\Omega$',
  }

  /** Plain text as LaTeX: its specials escaped, its symbols in math, its spaces one. */
  function escape(text) {
    let out = ''
    for (const ch of String(text).replace(/\s+/g, ' ')) out += SPECIAL[ch] || SYMBOL[ch] || ch
    return out
  }

  const same = (a, b) => !!a.b === !!b.b && !!a.i === !!b.i && !!a.sup === !!b.sup && !!a.sub === !!b.sub

  /** A cell's runs of text as LaTeX: bold, italic, super- and subscripts kept, the edges' spaces trimmed. */
  function cellLatex(cell) {
    const runs = []
    for (const r of cell.runs || []) {
      if (!r.text) continue
      const last = runs[runs.length - 1]
      if (last && same(last, r)) last.text += r.text
      else runs.push({ ...r })
    }
    if (runs.length) {
      runs[0].text = runs[0].text.replace(/^\s+/, '')
      runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, '')
    }
    return runs.filter(r => r.text).map(r => {
      let t = escape(r.text)
      if (r.sup) t = `\\textsuperscript{${t}}`
      if (r.sub) t = `\\textsubscript{${t}}`
      if (r.i) t = `\\textit{${t}}`
      if (r.b) t = `\\textbf{${t}}`
      return t
    }).join('')
  }

  const plain = cell => (cell.runs || []).map(r => r.text).join('').replace(/\s+/g, ' ').trim()
  /** A number, maybe with its spread, a sign or a unit: what a column of numbers holds. */
  const NUMBER = /^[~≈<>≤≥]?\s*[-+−]?\d[\d,.]*(e[-+−]?\d+)?\s*(%|pp|x|×)?(\s*(±|\+\/-|\+-)\s*\d[\d,.]*(e[-+−]?\d+)?\s*(%|pp)?)?$/i
  const EMPTY = /^(|-|–|—|n\/a|na)$/i
  const isNumber = text => NUMBER.test(text)

  /** The columns: a column right-aligned when every body cell in it is a number (or empty) or is right-aligned, else left. */
  function columnSpec(rows) {
    const width = Math.max(1, ...rows.map(r => r.cells.reduce((n, c) => n + (c.span || 1), 0)))
    const cols = Array.from({ length: width }, () => ({ numbers: 0, other: 0, right: 0 }))
    for (const r of rows) {
      if (r.header) continue
      let at = 0
      for (const c of r.cells) {
        const span = c.span || 1
        if (span === 1 && cols[at]) {
          const t = plain(c)
          if (c.align === 'r') cols[at].right++
          if (isNumber(t)) cols[at].numbers++
          else if (!EMPTY.test(t)) cols[at].other++
        }
        at += span
      }
    }
    return cols.map(c => (c.right || (c.numbers && !c.other) ? 'r' : 'l')).join('')
  }

  /** A label for a caption: `tab:` and its words in kebab case. */
  function label(caption) {
    const words = String(caption || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z0-9]+/g) || []
    let slug = ''
    for (const w of words) {
      if (slug && (slug + '-' + w).length > 40) break
      slug = slug ? `${slug}-${w}` : w
    }
    return `tab:${slug || 'table'}`
  }

  /** The table as a LaTeX table float: caption, label, a booktabs tabular, its header rows above the midrule. */
  function tableFloat(table) {
    const rows = (table.rows || []).filter(r => r.cells && r.cells.length)
    const spec = columnSpec(rows)
    const width = spec.length
    const line = r => {
      const parts = r.cells.map(c => ((c.span || 1) > 1 ? `\\multicolumn{${c.span}}{c}{${cellLatex(c)}}` : cellLatex(c)))
      const used = r.cells.reduce((n, c) => n + (c.span || 1), 0)
      for (let k = used; k < width; k++) parts.push('')
      return `${parts.join(' & ')} \\\\`
    }
    const head = rows.filter(r => r.header)
    const body = rows.filter(r => !r.header)
    const caption = String(table.caption || '').replace(/\s+/g, ' ').trim() || 'Table'
    return [
      '\\begin{table}[t]',
      '\\centering',
      `\\caption{${escape(caption)}}`,
      `\\label{${label(caption)}}`,
      `\\begin{tabular}{${spec}}`,
      '\\toprule',
      ...head.map(line),
      ...(head.length && body.length ? ['\\midrule'] : []),
      ...body.map(line),
      '\\bottomrule',
      '\\end{tabular}',
      '\\end{table}',
    ].join('\n')
  }

  /** A table float around a tabular its notebook typeset itself (LATEX, on the table as data-latex): caption and label, its lines as they are.
   *  LaTeX that is a float already (its own caption, label, width) is copied as it is. */
  function floatAround(caption, tabular) {
    if (/\\begin\{table\*?\}/.test(String(tabular))) return String(tabular).replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, '')
    const cap = String(caption || '').replace(/\s+/g, ' ').trim() || 'Table'
    return ['\\begin{table}[t]', '\\centering', `\\caption{${escape(cap)}}`, `\\label{${label(cap)}}`,
      String(tabular).replace(/\r\n?/g, '\n').replace(/^\n+|\s+$/g, ''), '\\end{table}'].join('\n')
  }

  root.RftLatex = { escape, cellLatex, columnSpec, label, tableFloat, floatAround, isNumber }
})(typeof globalThis !== 'undefined' ? globalThis : window)
