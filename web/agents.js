// The agents the user set up (server/rft_agents.py, GET api/agents): who answers a thread or
// processes an inbox item, picked beside the buttons that ask. With no setup there is nothing to
// pick: no picker is drawn, no request names an agent, and the page is as it was, with the
// connected Claude Code chat alone.
(() => {
  const CHAT = 'chat'
  const KEY = task => `rft-agent-${task}`
  let state = { found: false, agents: [], defaults: {}, errors: [], chat: true }
  const listeners = new Set()

  const saved = task => { try { return localStorage.getItem(KEY(task)) } catch { return null } }
  const any = () => state.agents.length > 0

  /** Everyone a task could go to, each {name, label, where, off, why}: the chat first, then the setup's agents in its order. */
  function options(task) {
    const chat = { name: CHAT, label: 'Claude Code chat', where: state.chat ? 'the chat that is connected' : 'no chat is connected', off: !state.chat, why: state.chat ? '' : 'no Claude Code chat is connected: run /rft in one' }
    return [chat, ...state.agents.map(a => {
      const off = !(a.tasks || []).includes(task)
      // a ready-made entry nobody ran on a real install yet says so
      return { name: a.name, label: a.name, where: a.unverified ? `${a.where}; its ready-made commands were never tried` : a.where, off, why: off ? (a.problem || (a.why_not || {})[task] || 'its grant does not allow this') : '', grant: a.grant_words, kind: a.kind }
    })]
  }

  /** Who a task goes to: the user's last pick while it may still do it, else the setup's default, else the chat when one is connected, else the first that may. */
  function chosen(task) {
    const names = options(task).filter(o => !o.off).map(o => o.name)
    const mine = saved(task)
    if (mine && names.includes(mine)) return mine
    const d = state.defaults[task]
    if (d && names.includes(d)) return d
    if (names.includes(CHAT)) return CHAT
    return names[0] || CHAT
  }

  function choose(task, name) {
    try { localStorage.setItem(KEY(task), name) } catch { /* private mode: the pick lasts the page */ }
    for (const f of listeners) f()
  }

  /** What a request for a task carries: the agent picked, or nothing at all when there is no setup. */
  const extra = task => (any() ? { agent: chosen(task) } : {})
  /** Who answers, by name, for a button's label: Claude with no setup or with the chat picked. */
  const name = task => (!any() || chosen(task) === CHAT ? 'Claude' : chosen(task))
  /** Who wrote a message of a thread. */
  const who = m => (m && m.by === 'you' ? 'You' : (m && m.agent) || 'Claude')
  /** Who a thread waits for. */
  const asking = t => (t && t.asking) || 'Claude'

  /** The picker for a task, to put beside its buttons; null with no setup. `onPick`: called after a pick. */
  function picker(task, onPick) {
    if (!any()) return null
    const box = document.createElement('label')
    box.className = 'agent-pick'
    const said = document.createElement('span')
    said.textContent = task === 'process' ? 'Process with' : 'Answers by'
    const select = document.createElement('select')
    select.setAttribute('aria-label', task === 'process' ? 'The agent that processes an item' : 'The agent that answers a thread')
    const where = document.createElement('span')
    where.className = 'agent-where muted'
    const now = chosen(task)
    for (const o of options(task)) {
      const opt = document.createElement('option')
      opt.value = o.name
      opt.textContent = o.off ? `${o.label} (${o.why})` : o.label
      opt.disabled = o.off
      opt.selected = o.name === now
      select.append(opt)
    }
    const say = () => {
      const o = options(task).find(x => x.name === select.value)
      where.textContent = o ? o.where : ''
      box.title = o && o.grant ? `${o.label}: ${o.kind}, ${o.grant}; ${o.where}` : o ? o.where : ''
    }
    say()
    select.addEventListener('change', () => { choose(task, select.value); say(); if (onPick) onPick() })
    box.append(said, select, where)
    const more = setupLink('Agents…')
    if (more) box.append(more)
    for (const e of state.errors) {
      const err = document.createElement('span')
      err.className = 'agent-error'
      err.textContent = e.name ? `${e.name}: ${e.error}` : e.error
      box.append(err)
    }
    return box
  }


  // ------------------------------------------------ the setup, changed from the page
  // One agent added, changed or removed at a time, written by the server into the user's own
  // file (POST api/agents). Nothing is prefilled: where a model is reached is the user's to say.

  let key = () => ''
  const el = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag)
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v
      else if (k === 'text') e.textContent = v
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v)
    }
    e.append(...kids.flat().filter(k => k != null && k !== false))
    return e
  }
  const KIND = { model: 'A model (text in, text out)', 'claude-code': 'Claude Code (a harness)', codex: 'Codex (a harness)' }
  const GRANT = { text: 'text only', read: 'read the project', change: 'change the project' }

  async function post(body) {
    try {
      const r = await fetch('api/agents', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RFT-Token': key() }, body: JSON.stringify(body) })
      const data = await r.json().catch(() => ({}))
      if (Array.isArray(data.agents)) take(data)
      return { ok: r.ok, data, error: r.ok ? '' : data.error || (r.status === 404 ? 'the server running is older than this page: restart it' : `the server answered ${r.status}`) }
    } catch (e) {
      return { ok: false, data: {}, error: 'the server did not answer' }
    }
  }

  function take(next) {
    const changed = JSON.stringify(next) !== JSON.stringify(state)
    state = next
    if (changed) for (const f of listeners) f()
  }

  let dialog = null
  /** Opens the setup: the agents there are, and the form that adds or changes one. */
  function setup() {
    if (dialog) dialog.remove()
    const msg = el('p', { class: 'agent-msg', role: 'status' })
    const say = (text, bad = false) => { msg.textContent = text; msg.classList.toggle('bad', bad) }
    const rows = el('ul', { class: 'agent-list' })
    const f = {
      name: el('input', { type: 'text', maxlength: '40', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'a name of your choice' }),
      kind: el('select', {}, (state.kinds || ['model']).map(k => el('option', { value: k, text: KIND[k] || k }))),
      url: el('input', { type: 'text', inputmode: 'url', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'the address of its endpoint, ending in /v1' }),
      key: el('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'the NAME of the variable that holds its key, if it needs one' }),
      model: el('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', list: 'agent-models' }),
      grant: el('select', {}, Object.entries(GRANT).map(([v, text]) => el('option', { value: v, text }))),
    }
    const models = el('datalist', { id: 'agent-models' })
    const listBtn = el('button', { type: 'button', text: 'List its models', title: 'Ask the endpoint which models it has' })
    const field = (label, input, hint, cls) => el('label', { class: `agent-field ${cls || ''}` }, el('span', { text: label }), input, hint ? el('small', { class: 'muted', text: hint }) : null)
    const urlField = field('Where it is', f.url, 'For a model on this machine, the address its server prints, with /v1 (Ollama: http://localhost:11434/v1).', 'for-model')
    const keyField = field('Its key', f.key, 'Never the key itself: the name of an environment variable, set where the server is started.', 'for-model')
    const modelField = el('label', { class: 'agent-field' }, el('span', { text: 'Model' }), el('span', { class: 'agent-row' }, f.model, listBtn), models)
    const grantField = field('It may', f.grant, 'Below "change the project" a harness is run locked: it can read, and cannot write a file or run a command.', 'for-harness')
    const saveBtn = el('button', { type: 'submit', class: 'primary', text: 'Save' })
    const form = el('form', { class: 'agent-form', autocomplete: 'off' },
      el('h3', { text: 'Add an agent' }),
      field('Name', f.name), field('What it is', f.kind), urlField, keyField, modelField, grantField,
      el('div', { class: 'agent-row' }, saveBtn, el('button', { type: 'button', text: 'Clear', onclick: () => fill(null) })))
    const shape = () => {
      const isModel = f.kind.value === 'model'
      urlField.hidden = keyField.hidden = listBtn.hidden = !isModel
      grantField.hidden = isModel
      f.model.placeholder = isModel ? 'the name the endpoint knows it by' : 'optional: the model the harness is told to run'
    }
    let editing = null
    function fill(entry) {
      editing = entry ? entry.name : null
      form.querySelector('h3').textContent = entry ? `Change ${entry.name}` : 'Add an agent'
      f.name.value = entry ? entry.name : ''
      f.name.disabled = Boolean(entry)
      f.kind.value = entry ? entry.kind : 'model'
      f.kind.disabled = Boolean(entry)
      f.url.value = entry ? entry.url : ''
      f.key.value = entry ? entry.key : ''
      f.model.value = entry ? entry.model : ''
      f.grant.value = entry && entry.kind !== 'model' ? entry.grant : 'text'
      models.replaceChildren()
      shape()
    }
    f.kind.addEventListener('change', shape)
    listBtn.addEventListener('click', async () => {
      if (!f.url.value.trim()) { say('Say where the model is first.', true); f.url.focus(); return }
      say('Asking the endpoint…')
      const r = await post({ action: 'models', url: f.url.value, key: f.key.value.trim() })
      if (!r.ok) { say(`No list: ${r.error}.`, true); return }
      models.replaceChildren(...r.data.models.map(m => el('option', { value: m })))
      say(r.data.models.length ? `It has ${r.data.models.length}: ${r.data.models.slice(0, 12).join(', ')}${r.data.models.length > 12 ? ', …' : ''}.` : 'It lists no model: pull or load one first.', !r.data.models.length)
      if (r.data.models.length === 1 && !f.model.value) f.model.value = r.data.models[0]
      f.model.focus()
    })
    form.addEventListener('submit', async ev => {
      ev.preventDefault()
      const name = f.name.value.trim()
      if (!name) { say('Give it a name.', true); f.name.focus(); return }
      saveBtn.disabled = true
      const r = await post({ action: 'save', name, kind: f.kind.value, url: f.url.value, key: f.key.value.trim(), model: f.model.value.trim(), grant: f.grant.value })
      saveBtn.disabled = false
      if (!r.ok) { say(`Not saved: ${r.error}.`, true); return }
      say(`${name} is saved in ${state.path}.`)
      fill(null)
      draw()
    })
    function draw() {
      rows.replaceChildren(...state.agents.map(a => {
        const remove = el('button', { type: 'button', text: 'Remove', onclick: async () => {
          if (remove.dataset.armed !== '1') { remove.dataset.armed = '1'; remove.textContent = 'Remove it?'; setTimeout(() => { remove.dataset.armed = ''; remove.textContent = 'Remove' }, 4000); return }
          const r = await post({ action: 'remove', name: a.name })
          say(r.ok ? `${a.name} is removed.` : `Not removed: ${r.error}.`, !r.ok)
          if (editing === a.name) fill(null)
          draw()
        } })
        const change = el('button', { type: 'button', text: 'Change', onclick: async () => {
          const r = await post({ action: 'entry', name: a.name })
          if (!r.ok) { say(`Not read: ${r.error}.`, true); return }
          if (r.data.by_hand) { say(`${a.name} is a harness written by its commands: change it in ${state.path}.`, true); return }
          fill(r.data)
          f.model.focus()
        } })
        return el('li', { class: a.problem ? 'off' : '' },
          el('span', { class: 'agent-name', text: a.name }),
          el('span', { class: 'muted', text: ` ${a.kind === 'model' ? `model ${a.model}` : a.preset || 'harness'} · ${a.grant_words} · ${a.where}` }),
          a.problem ? el('span', { class: 'agent-error', text: a.problem }) : null,
          el('span', { class: 'agent-row' }, change, remove))
      }), ...state.errors.map(e => el('li', { class: 'off' }, el('span', { class: 'agent-error', text: e.name ? `${e.name}: ${e.error}` : e.error }))))
      rows.hidden = !rows.childNodes.length
    }
    dialog = el('dialog', { class: 'agent-setup', 'aria-label': 'Agents' },
      el('div', { class: 'agent-head' }, el('h2', { text: 'Agents' }), el('button', { type: 'button', text: '✕', 'aria-label': 'Close', onclick: () => dialog.close() })),
      el('p', { class: 'muted', text: 'Who may answer a thread or process an inbox item beside the connected Claude Code chat: a model, which answers text with text and reads nothing, or a harness run once per task. What they answer is written by the page\'s server; a suggestion\'s new text still waits for you.' }),
      rows, form, msg,
      el('p', { class: 'muted agent-path', text: state.path ? `Kept in ${state.path}, yours alone, outside the project. A harness other than the ready-made ones is added there by hand (the guide's page on agents says how).` : '' }))
    document.body.append(dialog)
    fill(null)
    draw()
    dialog.addEventListener('close', () => { dialog.remove(); dialog = null })
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '')
    f.name.focus()
  }

  /** Whether this page may change the setup: it carries the vault's key, and the server says where the setup is kept. */
  const canSetup = () => Boolean(key() && state.path)

  /** The way into the setup, where a picker would stand: a small button. Null when the page may not write, or the server keeps no setup. */
  function setupLink(label) {
    if (!canSetup()) return null
    return el('button', { type: 'button', class: 'linkish agent-open', text: label || (any() ? 'Agents…' : 'Set up an agent'), title: 'Add a model or a harness of your own to answer threads and process inbox items', onclick: setup })
  }

  async function load() {
    try {
      const r = await fetch('api/agents', { cache: 'no-store' })
      if (!r.ok) return
      const next = await r.json()
      const changed = JSON.stringify(next) !== JSON.stringify(state)
      state = next
      if (changed) for (const f of listeners) f()
    } catch { /* an older server, or a page saved as a file: no agents */ }
  }

  window.RftAgents = { CHAT, load, any, options, chosen, choose, extra, name, who, asking, picker, setup, setupLink, canSetup, setKey: f => { key = f }, onChange: f => { listeners.add(f) }, state: () => state }
  if (location.protocol.startsWith('http')) {
    load()
    setInterval(load, 5000)
  }
})()
