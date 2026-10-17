// The static export: one self-contained HTML file (no server, no external requests) with the
// tree drawn top-down and left-right, each note's text, and a small script to select a note,
// fold a branch and switch the orientation.

import { treeSvg } from './svg'
import type { Tree } from './vault'
import { LEGEND, MARK, bodyOf, counts } from './vault'
import { esc } from './svg'

export function treeHtml(tree: Tree, texts: Record<string, string>, project: string, generated: string): string {
  const td = treeSvg(tree, { orientation: 'TD', isScripted: true }).svg
  const lr = treeSvg(tree, { orientation: 'LR', isScripted: true }).svg
  const data = Object.values(tree.nodes).map(n => ({
    id: n.id, name: n.name, type: n.type, status: n.status, date: n.date, mark: MARK[n.status] ?? '',
    parent: n.parent, children: n.children, body: bodyOf(texts[n.id] ?? ''),
  }))
  const c = counts(tree)
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(project)} reasoning tree</title>
<style>
:root { --bg:#ffffff; --fg:#1f2328; --muted:#656d76; --line:#d0d7de; --panel:#f6f8fa; --accent:#8250df; }
@media (prefers-color-scheme: dark) { :root { --bg:#0d1117; --fg:#e6edf3; --muted:#8d96a0; --line:#30363d; --panel:#161b22; --accent:#a371f7; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
header { padding:12px 16px; border-bottom:1px solid var(--line); display:flex; flex-wrap:wrap; gap:8px 16px; align-items:baseline; }
header h1 { font-size:17px; margin:0; }
header .meta { color:var(--muted); font-size:12.5px; }
.bar { display:flex; gap:6px; flex-wrap:wrap; margin-left:auto; }
button { font:inherit; font-size:12.5px; padding:3px 10px; border:1px solid var(--line); border-radius:6px; background:var(--panel); color:var(--fg); cursor:pointer; }
button[aria-pressed="true"] { border-color:var(--accent); color:var(--accent); }
main { display:grid; grid-template-columns:minmax(0,1fr) minmax(280px,420px); height:calc(100vh - 58px); }
#canvas { overflow:auto; padding:8px; }
#canvas svg { display:block; }
#canvas.fit svg { width:100%; height:auto; }
#note { border-left:1px solid var(--line); background:var(--panel); overflow:auto; padding:14px 18px; }
#note h1, #note h2 { font-size:15px; margin:14px 0 6px; }
#note h1 { font-size:17px; margin-top:0; }
#note a { color:var(--accent); cursor:pointer; text-decoration:none; }
#note code { background:var(--bg); padding:0 3px; border-radius:4px; }
#note pre { background:var(--bg); padding:8px; overflow:auto; border-radius:6px; }
#note table { border-collapse:collapse; } #note td, #note th { border:1px solid var(--line); padding:2px 6px; }
.hint { color:var(--muted); }
g[data-id].hidden, path.hidden { display:none; }
@media (max-width: 760px) { main { grid-template-columns:1fr; height:auto; } #canvas { max-height:70vh; } #note { border-left:0; border-top:1px solid var(--line); } }
</style>
</head>
<body>
<header>
  <h1>${esc(project)} — the reasoning tree</h1>
  <span class="meta">${c.direction ?? 0} directions · ${c.experiment ?? 0} experiments · ${esc(LEGEND)} · generated ${esc(generated)}</span>
  <div class="bar">
    <button id="td" aria-pressed="true">Top-down</button>
    <button id="lr" aria-pressed="false">Left-right</button>
    <button id="fit" aria-pressed="false">Fit</button>
    <button id="fold">Fold branch</button>
    <button id="unfold">Unfold all</button>
  </div>
</header>
<main>
  <div id="canvas"><div id="v-td">${td}</div><div id="v-lr" style="display:none">${lr}</div></div>
  <aside id="note"><p class="hint">Click a node to read its note. Select a node and press “Fold branch” to hide what grows from it.</p></aside>
</main>
<script>
const NODES = ${json};
const byId = Object.fromEntries(NODES.map(n => [n.id, n]));
const byName = Object.fromEntries(NODES.map(n => [n.name, n.id]));
const folded = new Set();
let selected = null;
const escH = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function inline(t) {
  return escH(t)
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    .replace(/!\\[\\[([^\\]]+)\\]\\]/g, '<em>(embedded: $1)</em>')
    .replace(/\\[\\[([^\\]|#]+)(?:#[^\\]|]*)?(?:\\|([^\\]]+))?\\]\\]/g, (m, target, alias) => {
      const id = byName[target.trim()];
      const label = alias || target;
      return id ? '<a data-go="' + id + '">' + label + '</a>' : '<span>' + label + '</span>';
    })
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\\*([^*]+)\\*/g, '$1<em>$2</em>')
    .replace(/\\[([^\\]]+)\\]\\((https?:[^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function markdown(src) {
  const out = []; let list = 0, inCode = false, table = false;
  const close = () => { while (list > 0) { out.push('</ul>'); list--; } if (table) { out.push('</table>'); table = false; } };
  for (const raw of src.split('\\n')) {
    if (raw.startsWith('\`\`\`')) { close(); out.push(inCode ? '</pre>' : '<pre>'); inCode = !inCode; continue; }
    if (inCode) { out.push(escH(raw)); continue; }
    const h = /^(#{1,6})\\s+(.*)$/.exec(raw);
    const li = /^(\\s*)[-*]\\s+(.*)$/.exec(raw);
    if (h) { close(); const l = Math.min(h[1].length, 2); out.push('<h' + l + '>' + inline(h[2]) + '</h' + l + '>'); }
    else if (li) {
      const depth = Math.floor(li[1].replace(/\\t/g, '    ').length / 2) + 1;
      while (list < depth) { out.push('<ul>'); list++; }
      while (list > depth) { out.push('</ul>'); list--; }
      out.push('<li>' + inline(li[2]) + '</li>');
    } else if (/^\\|.*\\|\\s*$/.test(raw)) {
      if (/^\\|[\\s:|-]+\\|\\s*$/.test(raw)) continue;
      if (!table) { close(); out.push('<table>'); table = true; }
      out.push('<tr>' + raw.trim().slice(1, -1).split('|').map(c => '<td>' + inline(c.trim()) + '</td>').join('') + '</tr>');
    } else if (raw.trim() === '') { close(); }
    else { close(); out.push('<p>' + inline(raw) + '</p>'); }
  }
  close(); if (inCode) out.push('</pre>');
  return out.join('\\n');
}
function select(id) {
  selected = id;
  document.querySelectorAll('g[data-id] rect:first-of-type').forEach(r => { r.style.strokeWidth = ''; });
  document.querySelectorAll('g[data-id="' + id + '"] rect:first-of-type').forEach(r => { r.style.strokeWidth = '3.5'; });
  const n = byId[id];
  document.getElementById('note').innerHTML =
    '<p class="hint">' + n.type + ' · ' + n.status + ' ' + n.mark + (n.date ? ' · ' + n.date : '') + '</p>' + markdown(n.body);
}
function descendants(id, acc = []) { for (const k of byId[id].children) { acc.push(k); descendants(k, acc); } return acc; }
function applyFolds() {
  const hidden = new Set(); for (const f of folded) descendants(f).forEach(d => hidden.add(d));
  document.querySelectorAll('g[data-id]').forEach(g => g.classList.toggle('hidden', hidden.has(g.dataset.id)));
  document.querySelectorAll('path[data-edge]').forEach(p => p.classList.toggle('hidden', hidden.has(p.dataset.edge)));
}
document.addEventListener('click', ev => {
  const g = ev.target.closest('g[data-id]'); if (g) { select(g.dataset.id); return; }
  const a = ev.target.closest('a[data-go]'); if (a) { ev.preventDefault(); select(a.dataset.go); }
});
document.getElementById('fold').onclick = () => { if (selected) { folded.has(selected) ? folded.delete(selected) : folded.add(selected); applyFolds(); } };
document.getElementById('unfold').onclick = () => { folded.clear(); applyFolds(); };
const orient = o => {
  document.getElementById('v-td').style.display = o === 'td' ? '' : 'none';
  document.getElementById('v-lr').style.display = o === 'lr' ? '' : 'none';
  document.getElementById('td').setAttribute('aria-pressed', String(o === 'td'));
  document.getElementById('lr').setAttribute('aria-pressed', String(o === 'lr'));
};
document.getElementById('fit').onclick = ev => {
  const on = document.getElementById('canvas').classList.toggle('fit');
  ev.target.setAttribute('aria-pressed', String(on));
};
function showRoot() {
  const svg = [...document.querySelectorAll('#canvas svg')].find(s => s.parentElement.style.display !== 'none');
  const root = NODES.find(n => !n.parent);
  const g = root && svg && svg.querySelector('g[data-id="' + root.id + '"] rect');
  if (g) { const c = document.getElementById('canvas'); const r = g.getBoundingClientRect(), b = c.getBoundingClientRect();
    c.scrollLeft += r.left - b.left - b.width / 2 + r.width / 2; c.scrollTop += r.top - b.top - 40; }
}
window.addEventListener('load', showRoot);
document.getElementById('td').onclick = () => orient('td');
document.getElementById('lr').onclick = () => { orient('lr'); showRoot(); };
</script>
</body>
</html>
`
}
