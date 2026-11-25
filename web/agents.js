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
    for (const e of state.errors) {
      const err = document.createElement('span')
      err.className = 'agent-error'
      err.textContent = e.name ? `${e.name}: ${e.error}` : e.error
      box.append(err)
    }
    return box
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

  window.RftAgents = { CHAT, load, any, options, chosen, choose, extra, name, who, asking, picker, onChange: f => { listeners.add(f) }, state: () => state }
  if (location.protocol.startsWith('http')) {
    load()
    setInterval(load, 5000)
  }
})()
