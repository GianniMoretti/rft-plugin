// The experiment queue's monitor in the tree view: this machine's GPUs, the jobs running and
// waiting (in their order, which the user changes by dragging, or with ↑ ↓ and Top), and the
// history of the jobs that ended, each with the experiment it ran. It reads api/queue and sends
// the user's changes to it (POST api/queue, with the key); the jobs run in the queue's runner
// (server/rft_queue.py), apart from the page and the session. No model turn, no token.
// The pure part is tested on its own; `mount` wires the panel of the live page. Loaded before
// app.js; it sets `globalThis.RftQueue` and touches nothing else until mounted.
(function (root) {
  'use strict'

  /** A duration in its two largest units: 45s, 4m, 1h 2m, 1d 2h. */
  function duration(seconds) {
    const s = Math.max(0, Math.round(seconds))
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`
    const d = Math.floor(h / 24)
    return `${d}d${h % 24 ? ` ${h % 24}h` : ''}`
  }

  /**
   * The change that puts waiting job `id` at index `to` of the waiting order (`order`, the ids):
   * {id, before}, `before` the job it will precede, null for the end.
   */
  function moveOp(order, id, to) {
    const rest = order.filter(x => x !== id)
    const t = Math.max(0, Math.min(rest.length, to))
    return { id, before: rest[t] === undefined ? null : rest[t] }
  }

  const shortName = name => String(name || '').replace(/^NVIDIA\s+(GeForce\s+)?/i, '')
  const gpuWord = n => `${n} GPU${n === 1 ? '' : 's'}`
  const gpuList = ids => (ids && ids.length ? `GPU${ids.length === 1 ? '' : 's'} ${ids.join(', ')}` : 'no GPU')

  /** What a GPU is doing: {kind: job | kept | elsewhere | free, text, exp}. */
  function gpuState(g, jobs) {
    if (g.job) {
      const j = (jobs || []).find(x => x.id === g.job)
      return { kind: 'job', text: `${g.job}${j ? ` ${j.exp}` : ''}`, exp: j ? j.exp : null }
    }
    if (g.allowed === false) return { kind: 'kept', text: 'kept out of the queue', exp: null }
    if (g.busy) {
      const who = (g.procs || []).map(p => String(p.name || '').split('/').pop() || String(p.pid)).filter(Boolean)
      return { kind: 'elsewhere', text: `in use outside the queue${who.length ? ` (${[...new Set(who)].join(', ')})` : ''}`, exp: null }
    }
    return { kind: 'free', text: 'free', exp: null }
  }

  /** How a job ended: "done", "failed (exit 1)", "failed (lost)", "cancelled". */
  function endWord(j) {
    if (j.state === 'failed') return `failed (${j.exit != null ? `exit ${j.exit}` : String(j.reason || '').startsWith('lost') ? 'lost' : 'no exit code'})`
    return j.state
  }

  const ranFor = j => (j.started && j.ended ? ` after ${duration(j.ended - j.started)}` : j.state === 'cancelled' && !j.started ? ' before it started' : '')

  /** How the run of an experiment's notebook went (the runner queues it after the experiment's jobs), as hooks/lib/queue.ts says it. */
  function notebookWord(j) {
    const o = j.outcome
    const err = String(j.error || '').trim().split('\n').pop()
    if (!o) return j.state === 'done' ? 'ran' : endWord(j)
    if (o.state === 'failed') return `failed${err ? `: ${err}` : ''}`
    if (o.recorded) return 'wrote the numbers in its Result'
    if (o.state === 'ok') return 'reproduced its Result'
    if (o.state === 'differs') return 'differs from its Result'
    return `ran (${o.why || 'nothing checked'})`
  }

  /**
   * How far a running job is, as its row shows it (server/rft_queue.py's progress_of): its stage
   * ($RFT_PROGRESS), each tqdm bar still going (label, fraction, numbers and time left), its last
   * line of text; null when it says nothing yet.
   */
  function progressParts(p) {
    if (!p || (!(p.bars && p.bars.length) && !p.line && !p.stage)) return null
    const st = p.stage
    const stage = st && (st.stage || st.n != null) ? `${st.i != null && st.n != null ? `Stage ${st.i}/${st.n}` : 'Stage'}${st.stage ? `: ${st.stage}` : ''}` : ''
    const bars = (p.bars || []).map(b => ({
      label: b.desc || 'progress',
      pct: b.total ? b.pct : null,
      nums: b.total ? `${b.n}/${b.total} · ${b.pct}%${b.left && b.left !== '?' ? ` · ${b.left} left` : ''}` : `${b.n}${b.rate ? ` · ${b.rate}` : ''}`,
      title: [b.elapsed ? `${b.elapsed} so far` : '', b.rate || ''].filter(Boolean).join(', '),
    }))
    return { stage, bars, line: p.line || '' }
  }

  // ---------------------------------------------------------------- a log, followed piece by piece

  const LOG_LINES = 3000 // the lines a log keeps in the page; earlier ones are in the whole log
  // colour codes and cursor moves, which a terminal reads and a page shows as junk
  const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g

  /** A line as a terminal leaves it: a progress bar's redraws (\r) end on its last state, colour codes dropped. */
  const cleanLine = line => line.replace(/\r+$/, '').split('\r').pop().replace(ANSI, '')

  /** A log as the page keeps it: its lines, the line still being written, whether earlier ones were left out. */
  const newLog = () => ({ lines: [], partial: '', cut: false, next: -1 })

  /**
   * The log once a piece read from the server is added (api/queue/output: {text, start, end, reset}):
   * whole lines join `lines`, the last one waits in `partial` until its newline comes (so a bar
   * redrawn across two reads ends on its last state); `reset` starts it again from that piece.
   */
  function feedLog(log, piece) {
    const out = piece.reset ? { ...newLog(), cut: piece.start > 0 } : { ...log, lines: log.lines.slice() }
    const parts = (out.partial + (piece.text || '')).split('\n')
    out.partial = parts.pop()
    for (const p of parts) out.lines.push(cleanLine(p))
    if (out.lines.length > LOG_LINES) {
      out.lines.splice(0, out.lines.length - LOG_LINES)
      out.cut = true
    }
    out.next = piece.end
    return out
  }

  /** The text the page shows for a log. */
  const logText = log => [...(log.cut ? ['… earlier output: Whole log'] : []), ...log.lines, ...(log.partial ? [cleanLine(log.partial)] : [])].join('\n')

  /** The button's badge and label: how many jobs run and wait. */
  function badge(v) {
    const running = v.jobs.filter(j => j.state === 'running').length
    const waiting = v.jobs.filter(j => j.state === 'pending').length
    return { count: running + waiting, running, waiting, label: `Experiment queue: ${running} running, ${waiting} waiting${v.paused ? ' (paused)' : ''}` }
  }

  /** A time as a clock reads it: 14:02 today, else "Nov 14, 14:02". */
  function when(t, now = Date.now() / 1000) {
    if (!t) return ''
    const d = new Date(t * 1000), n = new Date(now * 1000)
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return d.toDateString() === n.toDateString() ? hm : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${hm}`
  }

  /**
   * The panel in the live page. The button at the top left opens it and counts the jobs running
   * and waiting. `key()`: the key for changes ('': read-only); `store`: the page's storage for
   * this project; `open(id)`: shows a note in the drawer; `title(id)`: a note's title.
   */
  function mount({ key, store, open, title, every = 3000, idle = 15000 }) {
    const $ = id => document.getElementById(id)
    const btn = $('jobs-toggle'), badgeEl = $('jobs-badge'), panel = $('jobs'), sum = $('jobs-sum')
    const foldBtn = $('jobs-fold'), pauseBtn = $('jobs-pause'), hosts = $('jobs-hosts'), gpusEl = $('jobs-gpus'), list = $('jobs-list'), msg = $('jobs-msg')
    const tabs = [...panel.querySelectorAll('[data-jtab]')]
    let view = null
    let tab = store.get('jobsTab', 'queue') === 'history' ? 'history' : 'queue'
    const shown = new Set() // the jobs whose command and log are unfolded
    // their logs: what was read so far, its box (kept across redraws, so its scroll stays) and the last error
    const logs = new Map()
    let armed = null // a cancel waiting for its second press: { id, until }
    let dragging = null
    let timer = 0
    let compact = store.get('jobsCompact', false) === true // folded: the running jobs and how far they are, nothing else
    let answered = 0 // when the server last answered the queue: a log it does not answer is then refused on the way
    // where a job's output is read: api/queue/output, or api/queue/log on a server started before it
    let outputAt = 'api/queue/output'
    const canWrite = () => !!key()
    const now = () => Date.now() / 1000

    function el(tag, props, ...kids) {
      const e = document.createElement(tag)
      for (const [k, v] of Object.entries(props || {})) {
        if (v == null || v === false) continue
        if (k === 'class') e.className = v
        else if (k === 'text') e.textContent = v
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
        else e.setAttribute(k, v === true ? '' : String(v))
      }
      for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid instanceof Node ? kid : String(kid))
      return e
    }

    function setMsg(text, isError = false) {
      msg.textContent = text
      msg.classList.toggle('error', isError)
    }

    /** Reads the queue; false when the server has none (one started before it existed). */
    async function load() {
      try {
        const res = await fetch('api/queue', { cache: 'no-store' })
        if (res.status === 404) return false
        const got = await res.json().catch(() => null)
        if (!res.ok || !got || !Array.isArray(got.jobs)) {
          setMsg(`Not read: ${(got && got.error) || `the server answered ${res.status}`}.`, true)
          return true
        }
        view = got
        answered = Date.now()
        // an open log follows its job while it runs, and gets its last lines once it has ended
        for (const id of shown) {
          const j = view.jobs.find(x => x.id === id) || view.history.find(x => x.id === id)
          const l = logs.get(id)
          if (!j || j.state === 'pending' || !l) continue
          if (j.state === 'running') readLog(id)
          else if (!l.final) { l.final = true; readLog(id) }
        }
        if (dragging) showBadge()
        else draw()
      } catch (e) {
        // the page's own light says when the server is gone
      }
      return true
    }

    async function change(body, done = '') {
      if (!canWrite()) return
      setMsg('Saving…')
      try {
        const res = await fetch('api/queue', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'X-RFT-Token': key() },
          body: JSON.stringify(body),
        })
        const got = await res.json().catch(() => ({}))
        setMsg(res.ok ? done : `Not done: ${got.error || `the server answered ${res.status}`}.`, !res.ok)
      } catch (e) {
        setMsg('Not done: the server is not answering.', true)
      }
      await load()
    }

    /** A job's log in the page: what was read, its box, and its error; made the first time it is shown. */
    function logOf(id) {
      let l = logs.get(id)
      if (!l) {
        const box = el('pre', { class: 'jobs-log', tabindex: '0', 'aria-label': `The output of ${id}` })
        l = { log: newLog(), box, error: '', stick: true, top: 0, busy: false }
        // following the end, unless the user scrolled up to read
        box.addEventListener('scroll', () => {
          if (!box.isConnected) return
          l.stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 8
          l.top = box.scrollTop
        }, { passive: true })
        logs.set(id, l)
      }
      return l
    }

    /** Shows a log in its box, at the end when it follows, else where the user left it. */
    function paint(l) {
      const text = l.log.next < 0 && !l.error ? 'Reading…' : (logText(l.log) || 'No output yet.')
      if (l.box.textContent !== text) l.box.textContent = text
      l.box.scrollTop = l.stick ? l.box.scrollHeight : l.top
    }

    /** Reads what a job wrote since the last read (all of its last 64 KB the first time). */
    async function readLog(id) {
      const l = logOf(id)
      if (!canWrite()) {
        l.error = 'A job’s output needs the key: open the address /rft printed (it ends in ?token=…).'
        if (shown.has(id) && !dragging) draw()
        return
      }
      if (l.busy) return
      l.busy = true
      const from = l.log.next >= 0 ? `&from=${l.log.next}` : ''
      try {
        let res = await fetch(`${outputAt}?id=${encodeURIComponent(id)}${from}`, { cache: 'no-store', headers: { 'X-RFT-Token': key() } })
        let got = await res.json().catch(() => null)
        if (res.status === 404 && !got && outputAt !== 'api/queue/log') {
          outputAt = 'api/queue/log'
          res = await fetch(`${outputAt}?id=${encodeURIComponent(id)}${from}`, { cache: 'no-store', headers: { 'X-RFT-Token': key() } })
          got = await res.json().catch(() => null)
        }
        if (res.ok && got && typeof got.end === 'number') {
          l.log = feedLog(l.log, got)
          l.error = ''
        } else if (res.ok && got && typeof got.text === 'string') {
          // a server started before logs were followed: its last lines each time
          l.log = feedLog(newLog(), { text: got.text, start: 0, end: 0, reset: true })
          l.error = 'This server shows only the last lines: restart it to follow the log (in the Claude session, /rft stop, then /rft; the address stays the same).'
        } else {
          l.error = `Not read: the server answered ${res.status}${got && got.error ? `: ${got.error}` : ''}.`
        }
      } catch (e) {
        l.error = noAnswer(e)
      }
      l.busy = false
      if (shown.has(id) && !dragging) {
        const err = l.box.parentNode && l.box.parentNode.querySelector('.jobs-log-err')
        if (err) {
          err.textContent = l.error
          err.hidden = !l.error
          paint(l)
        } else draw()
      }
    }

    /** Why a request got no answer, with what the browser says: refused on the way while the server answers the queue, else the server gone. */
    function noAnswer(e) {
      const said = e && e.message ? ` (the browser says: ${e.message})` : ''
      return Date.now() - answered < 3 * every + 2000
        ? `Not read: the request did not reach the server, though it answers the queue${said}. A blocker extension (uBlock, AdGuard, Brave shields…) may refuse it: allow this page in it, or open its console to see what refused it.`
        : `Not read: no answer from the server${said}. If the light at the top is not green, it has stopped: it runs with the Claude session that ran /rft (run /rft again), and over SSH it needs the tunnel to its port.`
    }

    /** Saves a job's whole log as a file (it needs the key, so it is fetched, then handed to the browser). */
    async function saveLog(id) {
      setMsg(`Reading ${id}'s whole log…`)
      try {
        const res = await fetch(`${outputAt}?id=${encodeURIComponent(id)}&raw=1`, { cache: 'no-store', headers: { 'X-RFT-Token': key() } })
        if (!res.ok) {
          const got = await res.json().catch(() => ({}))
          setMsg(`Not saved: ${got.error || `the server answered ${res.status}`}.`, true)
          return
        }
        const url = URL.createObjectURL(await res.blob())
        const a = el('a', { href: url, download: `${id}.log` })
        document.body.append(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 10000)
        setMsg('')
      } catch (e) {
        setMsg(noAnswer(e).replace('Not read', 'Not saved'), true)
      }
    }

    function showBadge() {
      const b = badge(view)
      badgeEl.textContent = b.count > 99 ? '99+' : String(b.count)
      badgeEl.hidden = !b.count
      badgeEl.classList.toggle('idle', !b.running)
      btn.title = b.label
      btn.setAttribute('aria-label', b.label)
    }

    function link(exp, text) {
      const t = title(exp)
      return el('a', {
        href: `#${exp}`, class: 'jobs-exp', title: t ? `${exp} · ${t}: open its note` : exp,
        onclick: ev => { ev.preventDefault(); open(exp) },
      }, text || exp)
    }

    function setAllowed(index, on) {
      const all = view.gpus.map(g => g.index)
      const was = view.allowed == null ? all : view.allowed
      const next = on ? [...new Set([...was, index])].sort((a, b) => a - b) : was.filter(i => i !== index)
      change({ op: 'gpus', allowed: all.every(i => next.includes(i)) ? null : next }, on ? `GPU ${index} back in the queue` : `GPU ${index} kept out of the queue`)
    }

    function drawGpus() {
      const gpus = view.gpus || []
      if (view.gpu_error) return gpusEl.replaceChildren(el('div', { class: 'jobs-gpu-error', text: view.gpu_error }))
      if (!gpus.length) return gpusEl.replaceChildren(el('div', { class: 'muted', text: 'No GPU found on this machine: only jobs that take none run.' }))
      gpusEl.replaceChildren(...gpus.map(g => {
        const s = gpuState(g, view.jobs)
        const meter = el('span')
        meter.style.width = `${g.mem_total ? Math.min(100, Math.round(100 * g.mem_used / g.mem_total)) : 0}%`
        return el('div', { class: `jobs-gpu ${s.kind}` },
          el('div', { class: 'jobs-gpu-head' },
            canWrite() ? el('input', {
              type: 'checkbox', checked: g.allowed !== false, title: 'The queue may start jobs on this GPU',
              'aria-label': `The queue may use GPU ${g.index}`, onchange: ev => setAllowed(g.index, ev.target.checked),
            }) : null,
            el('strong', { text: `GPU ${g.index}` }),
            el('span', { class: 'muted jobs-gpu-name', text: shortName(g.name) }),
            el('span', { class: 'jobs-gpu-owner' }, s.exp ? [el('span', { text: `${g.job} ` }), link(s.exp)] : s.text)),
          el('div', { class: 'jobs-meter', title: `Memory: ${g.mem_used} of ${g.mem_total} MiB` }, meter),
          el('div', { class: 'jobs-gpu-nums muted', text: `${(g.mem_used / 1024).toFixed(1)} / ${(g.mem_total / 1024).toFixed(1)} GiB · ${g.util != null ? g.util : '–'}% use${g.temp != null ? ` · ${g.temp} °C` : ''}` }))
      }))
    }

    function toggle(j) {
      if (shown.has(j.id)) {
        shown.delete(j.id)
        logs.delete(j.id) // read anew, from its end, the next time
      } else {
        shown.add(j.id)
        if (j.state !== 'pending') readLog(j.id)
      }
      draw()
    }

    function details(j) {
      if (!shown.has(j.id)) return null
      const by = j.by === 'user' ? 'you' : j.by === 'runner' ? `the runner, after ${j.after || 'its jobs'}` : 'Claude'
      const code = j.commit ? `${j.repo ? `${j.repo} ` : ''}@ ${j.commit}${j.branch ? ` (${j.branch})` : ''}${j.patch ? ', with its uncommitted changes (code.patch)' : ''}${j.changed ? ' · the code moved while it ran' : ''}` : ''
      if (j.state === 'pending') {
        return el('div', { class: 'jobs-details' },
          el('code', { class: 'jobs-cmd', text: `$ ${j.cmd}` }),
          el('div', { class: 'muted', text: `in ${j.cwd} · queued by ${by}${j.added ? ` ${when(j.added)}` : ''}${j.retry_of ? ` · retry of ${j.retry_of}` : ''}` }))
      }
      const l = logOf(j.id)
      const box = el('div', { class: 'jobs-details' },
        el('code', { class: 'jobs-cmd', text: `$ ${j.cmd}` }),
        el('div', { class: 'muted', text: `in ${j.cwd} · queued by ${by}${j.added ? ` ${when(j.added)}` : ''}${j.retry_of ? ` · retry of ${j.retry_of}` : ''}${j.reason && j.state !== 'done' ? ` · ${j.reason}` : ''}` }),
        code ? el('div', { class: 'muted', text: `code: ${code}` }) : null,
        j.out ? el('div', { class: 'muted', text: `outputs: ${j.out}` }) : null,
        el('div', { class: 'jobs-log-bar' },
          el('span', { class: 'muted', text: j.state === 'running' ? 'Its output, as it comes' : 'Its output' }),
          canWrite() ? el('button', { type: 'button', title: 'Save its whole output as a file', onclick: () => saveLog(j.id) }, 'Whole log') : null),
        l.box,
        el('div', { class: 'jobs-log-err', role: 'status', hidden: !l.error, text: l.error }))
      paint(l)
      return box
    }

    function cancelBtn(j) {
      if (!canWrite()) return null
      const isArmed = armed && armed.id === j.id && armed.until > Date.now()
      const running = j.state === 'running'
      return el('button', {
        type: 'button', class: isArmed ? 'danger' : null,
        title: running ? 'Stop this job (its whole process group); press twice' : 'Take it off the queue; press twice',
        onclick: () => {
          if (isArmed) {
            armed = null
            change({ op: 'cancel', id: j.id }, `${j.id} ${running ? 'stopped' : 'cancelled'}`)
            return
          }
          armed = { id: j.id, until: Date.now() + 4000 }
          draw()
          setTimeout(() => { if (armed && armed.id === j.id) { armed = null; draw() } }, 4100)
        },
      }, isArmed ? (running ? 'Stop it?' : 'Cancel it?') : (running ? 'Stop' : 'Cancel'))
    }

    const moreBtn = j => el('button', {
      type: 'button', class: 'jobs-more', 'aria-expanded': String(shown.has(j.id)),
      title: j.state === 'pending' ? 'Its command' : 'Its command and the end of its output',
      onclick: () => toggle(j),
    }, j.state === 'pending' ? 'Command' : 'Log')

    /** A running job's stage, bars and last line (the line only when there is no bar, folded). */
    function progressEl(p, folded = false) {
      const parts = progressParts(p)
      if (!parts) return null
      return el('div', { class: 'jobs-progress' },
        parts.stage ? el('div', { class: 'jobs-stage', text: parts.stage }) : null,
        ...parts.bars.map(b => {
          const fill = el('span')
          if (b.pct != null) fill.style.width = `${b.pct}%`
          return el('div', { class: 'jobs-bar', title: b.title || null },
            el('span', { class: 'jobs-bar-label', text: b.label, title: b.label }),
            el('span', { class: `jobs-bar-meter${b.pct == null ? ' none' : ''}` }, fill),
            el('span', { class: 'jobs-bar-nums muted', text: b.nums }))
        }),
        parts.line && !(folded && parts.bars.length) ? el('div', { class: 'jobs-lastline muted', text: parts.line, title: parts.line }) : null)
    }

    /** Folded: one short row per running job with how far it is, and a line for those waiting; a click unfolds it. */
    function compactRows() {
      const running = view.jobs.filter(j => j.state === 'running')
      const waiting = view.jobs.filter(j => j.state === 'pending')
      const open = id => { compact = false; store.set('jobsCompact', false); if (!shown.has(id)) { shown.add(id); readLog(id) } draw() }
      const out = running.map(j => el('div', { class: 'jobs-row jobs-mini s-running', 'data-id': j.id, title: 'Unfold, with its log', onclick: ev => { if (!ev.target.closest('a')) open(j.id) } },
        el('span', { class: 'jobs-dot', 'aria-hidden': 'true' }),
        el('div', { class: 'jobs-main' },
          el('div', { class: 'jobs-line' },
            el('span', { class: 'jobs-id', text: j.id }), link(j.exp),
            j.label ? el('span', { class: 'jobs-label', text: j.label }) : el('span', { class: 'jobs-title muted', text: duration(now() - (j.started || now())) })),
          progressEl(j.progress, true))))
      if (waiting.length) out.push(el('div', { class: 'jobs-sep muted', text: `${waiting.length} waiting: ${waiting.slice(0, 6).map(j => `${j.id} ${j.exp}`).join(', ')}${waiting.length > 6 ? ', …' : ''}` }))
      if (!out.length) out.push(el('p', { class: 'muted jobs-empty', text: 'Nothing runs or waits.' }))
      return out
    }

    function row(j, o) {
      const t = title(j.exp)
      const r = el('div', { class: `jobs-row s-${j.state}`, 'data-id': j.id, draggable: o.drag ? 'true' : null },
        o.drag ? el('span', { class: 'jobs-grip', title: 'Drag to reorder', 'aria-hidden': 'true', text: '⠿' }) : el('span', { class: 'jobs-dot', 'aria-hidden': 'true' }),
        el('div', { class: 'jobs-main' },
          el('div', { class: 'jobs-line' },
            o.place ? el('span', { class: 'jobs-place muted', text: `${o.place}.` }) : null,
            el('span', { class: 'jobs-id', text: j.id }),
            link(j.exp),
            t ? el('span', { class: 'jobs-title', text: t, title: t }) : null,
            j.label ? el('span', { class: 'jobs-label', text: j.label }) : null),
          el('div', { class: 'jobs-meta muted', text: o.meta }),
          j.state === 'running' ? progressEl(j.progress) : null,
          details(j)),
        el('div', { class: 'jobs-actions' }, ...o.actions))
      if (o.drag) wireDrag(r, j, o.order)
      return r
    }

    function wireDrag(r, j, order) {
      const half = ev => { const b = r.getBoundingClientRect(); return ev.clientY > b.top + b.height / 2 }
      r.addEventListener('dragstart', ev => {
        dragging = j.id
        r.classList.add('dragging')
        ev.dataTransfer.effectAllowed = 'move'
        ev.dataTransfer.setData('text/plain', j.id)
      })
      r.addEventListener('dragend', () => { dragging = null; draw() })
      r.addEventListener('dragover', ev => {
        if (!dragging || dragging === j.id) return
        ev.preventDefault()
        const after = half(ev)
        r.classList.toggle('drop-before', !after)
        r.classList.toggle('drop-after', after)
      })
      r.addEventListener('dragleave', () => r.classList.remove('drop-before', 'drop-after'))
      r.addEventListener('drop', ev => {
        ev.preventDefault()
        const id = dragging
        dragging = null
        if (!id || id === j.id) return draw()
        const to = order.filter(x => x !== id).indexOf(j.id) + (half(ev) ? 1 : 0)
        change({ op: 'move', ...moveOp(order, id, to) }, `${id} moved`)
      })
    }

    function queueRows() {
      const running = view.jobs.filter(j => j.state === 'running')
      const waiting = view.jobs.filter(j => j.state === 'pending')
      if (!running.length && !waiting.length) {
        return [el('p', { class: 'muted jobs-empty', text: 'Nothing runs or waits. Claude queues a run with rft_queue; it starts here as soon as its GPUs are free, in the order shown.' })]
      }
      const order = waiting.map(j => j.id)
      const w = canWrite()
      const out = running.map(j => row(j, { meta: `running on ${gpuList(j.gpu_ids)} · ${duration(now() - (j.started || now()))}`, actions: [moreBtn(j), cancelBtn(j)] }))
      if (running.length && waiting.length) out.push(el('div', { class: 'jobs-sep muted', text: `Waiting, in order${w ? ' (drag to reorder)' : ''}` }))
      waiting.forEach((j, i) => out.push(row(j, {
        place: i + 1, drag: w, order,
        meta: `${gpuWord(j.gpus)}${j.outlook ? ` · ${j.outlook}` : ''}`,
        actions: [moreBtn(j), ...(w ? [
          el('button', { type: 'button', title: 'Move up', 'aria-label': `Move ${j.id} up`, disabled: i === 0, onclick: () => change({ op: 'move', ...moveOp(order, j.id, i - 1) }) }, '↑'),
          el('button', { type: 'button', title: 'Move down', 'aria-label': `Move ${j.id} down`, disabled: i === order.length - 1, onclick: () => change({ op: 'move', ...moveOp(order, j.id, i + 1) }) }, '↓'),
          el('button', { type: 'button', title: 'First in line', disabled: i === 0, onclick: () => change({ op: 'move', id: j.id, before: 'top' }, `${j.id} first in line`) }, 'Top'),
          cancelBtn(j)] : [])],
      })))
      return out
    }

    function historyRows() {
      if (!view.history.length) return [el('p', { class: 'muted jobs-empty', text: 'No job has ended yet. Each one that does is kept here, with the experiment it ran and how it ended.' })]
      return view.history.map(j => row(j, {
        meta: `${j.kind === 'notebook' ? `notebook ${notebookWord(j)}` : endWord(j)}${ranFor(j)}${j.ended ? ` · ${when(j.ended)}` : ''}${j.gpu_ids && j.gpu_ids.length ? ` · ${gpuList(j.gpu_ids)}` : ''}` +
          `${j.state === 'failed' && j.error ? ` · ${String(j.error).trim().split('\n').pop()}` : ''}`,
        actions: [moreBtn(j), canWrite() ? el('button', { type: 'button', title: 'Queue it again, first in line', onclick: () => change({ op: 'retry', id: j.id }, `${j.id} queued again`) }, 'Retry') : null],
      }))
    }

    function draw() {
      if (!view) return
      showBadge()
      if (panel.hidden) return
      const b = badge(view)
      const failed = view.history.filter(j => j.state === 'failed').length
      sum.textContent = `${b.running} running · ${b.waiting} waiting${view.paused ? ' · paused' : ''}`
      pauseBtn.hidden = !canWrite()
      pauseBtn.textContent = view.paused ? 'Resume' : 'Pause'
      pauseBtn.classList.toggle('primary', !!view.paused)
      pauseBtn.title = view.paused ? 'Start waiting jobs again as their GPUs free up' : 'Start no new job (the running ones go on)'
      const n = (view.gpus || []).length
      hosts.replaceChildren(el('button', { type: 'button', role: 'tab', 'aria-selected': 'true', class: 'jobs-host', title: 'The jobs run on this machine' },
        el('strong', { text: view.host || 'this machine' }), el('span', { class: 'muted', text: ` · ${n ? gpuWord(n) : 'no GPU'}${view.runner ? '' : (b.count ? ' · runner starting' : '')}` })))
      drawGpus()
      for (const t of tabs) t.setAttribute('aria-selected', String(t.dataset.jtab === tab))
      $('jobs-nq').textContent = view.jobs.length ? String(view.jobs.length) : ''
      $('jobs-nh').textContent = view.history.length ? `${view.history.length}${failed ? ` · ${failed} failed` : ''}` : ''
      panel.classList.toggle('compact', compact)
      foldBtn.textContent = compact ? '▾' : '▴'
      foldBtn.setAttribute('aria-expanded', String(!compact))
      foldBtn.title = compact ? 'Unfold: the GPUs, the queue in its order, the history, the logs' : 'Fold to the running jobs and how far they are'
      foldBtn.setAttribute('aria-label', compact ? 'Unfold the experiment queue' : 'Fold the experiment queue')
      const top = list.scrollTop
      list.replaceChildren(...(compact ? compactRows() : tab === 'queue' ? queueRows() : historyRows()))
      list.scrollTop = top
      // a log's box moved into the new rows: back at its end, or where the user left it
      for (const l of logs.values()) if (l.box.isConnected) l.box.scrollTop = l.stick ? l.box.scrollHeight : l.top
      if (!canWrite()) setMsg('Read-only: open the address /rft printed (it ends in ?token=…) to change the queue.')
    }

    function schedule() {
      clearTimeout(timer)
      timer = setTimeout(async () => {
        if (!document.hidden) await load()
        schedule()
      }, panel.hidden ? idle : every)
    }

    function setOpen(on) {
      panel.hidden = !on
      btn.setAttribute('aria-expanded', String(on))
      store.set('jobsOpen', on)
      if (on) load()
      else if (panel.contains(document.activeElement)) btn.focus()
      schedule()
    }

    btn.addEventListener('click', () => setOpen(panel.hidden))
    $('jobs-close').addEventListener('click', () => setOpen(false))
    foldBtn.addEventListener('click', () => {
      compact = !compact
      store.set('jobsCompact', compact)
      draw()
    })
    pauseBtn.addEventListener('click', () => view && change({ op: 'pause', paused: !view.paused }, view.paused ? 'Resumed' : 'Paused: no new job starts'))
    for (const t of tabs) {
      t.addEventListener('click', () => {
        tab = t.dataset.jtab
        store.set('jobsTab', tab)
        draw()
      })
    }
    panel.addEventListener('keydown', ev => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      setOpen(false)
    })
    document.addEventListener('visibilitychange', () => { if (!document.hidden && view) load() })

    // the button only once the server is known to keep a queue; `?jobs` in the address opens it
    load().then(found => {
      if (!found) return
      btn.hidden = false
      const asked = new URLSearchParams(location.search).get('jobs')
      if (asked === 'history') tab = 'history'
      if (asked !== null || store.get('jobsOpen', false)) setOpen(true)
      else schedule()
    })
  }

  root.RftQueue = { duration, moveOp, gpuState, endWord, notebookWord, progressParts, cleanLine, newLog, feedLog, logText, badge, when, mount }
})(typeof globalThis !== 'undefined' ? globalThis : window)
