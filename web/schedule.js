// Dates and deadlines as pure functions, one copy for the tree view's Calendar (its Month and
// Timeline) and for the plugin (hooks/lib/dates.ts loads it): reading `due:`, `start:` and
// `est:`, planning backwards from each deadline, the days the runs need more GPUs than the
// machine has, the windows a calendar draws, the meetings' occurrences, and the text of an .ics
// file. It sets `globalThis.RftSchedule` and touches nothing else.
//
// Days are `YYYY-MM-DD`, counted whole. A run of `est` days from `start` holds the days `start`
// to `start + est - 1`, and ends (its next free day) at `start + est`. A deadline's needs must
// end by its due day, which is left for what comes after them (the writing).
//
// A meeting (vault/meetings/) happens once, at `when:`, or comes back `every:` day, week or
// month (`2 weeks`, `month on the first Tuesday`) from `when:` up to `until:` (a day, included),
// but on the days in `skip:`; `moved:` takes one occurrence elsewhere (`2026-12-01 → 2026-12-02
// 10:00`). A meeting with `needs:` is a deadline too, at its next occurrence.
(function (root) {
  'use strict'

  const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
  // a day, a time and a zone: `2026-11-13`, `2026-11-13 23:59`, `2026-11-13 23:59 AoE` (server/rft_server.py has the same)
  const DUE_RE = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?(?:\s*(AoE|UTC|Z|[+-]\d{2}:?\d{2}))?$/i
  const EST_RE = /^(\d+)\s*([dw])?$/i
  // a meeting's length, how often it comes back and an occurrence moved (server/rft_server.py has the same)
  const DURATION_RE = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?$/i
  const EVERY_RE = /^(?:every\s+)?(?:(\d+)\s*)?(d|w|m|days?|weeks?|months?|daily|weekly|monthly)(?:\s+on\s+the\s+(first|second|third|fourth|fifth|last)\s+([a-z]{3,}))?$/i
  const MOVED_RE = /^(\d{4}-\d{2}-\d{2})\s*(?:→|->)\s*(.+)$/
  const MS_DAY = 86400000
  // a note that no longer needs doing (its result is in, or it will not be done)
  const GONE = ['dropped', 'discussed', 'moved']
  // done, and the two a done note goes on to: verified by the user, and back in review
  const FINISHED = ['done', 'review', 'verified']
  const ENDED = [...FINISHED, ...GONE]
  /** A milestone's statuses: open (planned for), done, suggested (by Claude, until the user answers) and dismissed. */
  const MILESTONE_STATUSES = ['open', 'done', 'suggested', 'dismissed']
  const DUE_EXAMPLES = '2026-11-13, 2026-11-13 23:59, 2026-11-13 23:59 AoE'

  const unquote = v => (typeof v === 'string' ? v.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim() : v)

  /** Whether `v` is a day of the calendar, `YYYY-MM-DD`. */
  function isDay(v) {
    const m = typeof v === 'string' ? DAY_RE.exec(v) : null
    if (!m) return false
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
  }

  /** The day `v` names, or null. */
  const parseDay = v => (isDay(unquote(v)) ? unquote(v) : null)

  const num = day => Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) / MS_DAY
  const fromNum = n => new Date(n * MS_DAY).toISOString().slice(0, 10)
  /** The day `n` days after `day` (before, when negative). */
  const addDays = (day, n) => fromNum(num(day) + n)
  /** How many days from `a` to `b` (negative when `b` comes first). */
  const between = (a, b) => num(b) - num(a)
  const later = (a, b) => (a > b ? a : b)
  /** Monday 0 … Sunday 6. */
  const weekday = day => (new Date(num(day) * MS_DAY).getUTCDay() + 6) % 7

  /** A due date as written: `{day}`, with `time` (HH:MM) and `zone` (AoE, UTC or ±HH:MM) when given; null when it is none. */
  function parseDue(v) {
    if (v && typeof v === 'object') return v.day && isDay(v.day) ? v : null
    if (typeof v !== 'string') return null
    const m = DUE_RE.exec(unquote(v))
    if (!m || !isDay(m[1])) return null
    const out = { day: m[1] }
    if (m[2] !== undefined) {
      if (+m[2] > 23 || +m[3] > 59) return null
      out.time = `${m[2]}:${m[3]}`
    }
    if (m[4]) {
      const z = m[4].toUpperCase()
      // a zone without a time: the end of that day there
      if (!out.time) out.time = '23:59'
      out.zone = z === 'AOE' ? 'AoE' : z === 'UTC' || z === 'Z' ? 'UTC' : `${z.slice(0, 3)}:${z.slice(-2)}`
    }
    return out
  }

  /** A due date as it is written back: `2026-11-13 23:59 AoE`. */
  const formatDue = due => (due ? [due.day, due.time, due.zone].filter(Boolean).join(' ') : '')

  /** Minutes east of UTC. */
  const offsetOf = zone => (zone === 'AoE' ? -720 : zone === 'UTC' ? 0 : (zone[0] === '-' ? -1 : 1) * (60 * +zone.slice(1, 3) + +zone.slice(4, 6)))

  /** The moment a due date with a time and a zone falls on, in UTC (`2026-11-14T11:59:00Z`); null for a day or a local time. */
  function utcOf(due) {
    if (!due || !due.time || !due.zone) return null
    const at = num(due.day) * MS_DAY + (60 * +due.time.slice(0, 2) + +due.time.slice(3, 5) - offsetOf(due.zone)) * 60000
    return new Date(at).toISOString().replace(/\.\d+Z$/, 'Z')
  }

  /** An estimate in whole days: `3d`, `2w` (14), `4`; null when it is none, or not above 0. */
  function parseEst(v) {
    if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : null
    const m = typeof v === 'string' ? EST_RE.exec(unquote(v)) : null
    if (!m) return null
    const days = +m[1] * (m[2] && m[2].toLowerCase() === 'w' ? 7 : 1)
    return days > 0 ? days : null
  }

  const nodesOf = nodes => (Array.isArray(nodes) ? nodes : Object.values(nodes || {}))
  const naturally = (a, b) => a.localeCompare(b, 'en', { numeric: true })
  const usable = n => !n.supersededBy && !ENDED.includes(n.status)

  /**
   * The days each experiment holds on a calendar, `from` up to `to` (its end, the day after the
   * last): planned with a start and an estimate; running from `started`, `plannedTo` its
   * estimate's end and `to` today's end once it is over that, `noEnd` without an estimate; done
   * between `started` and `finished`. One with no date of its own (running with no `started:`)
   * has none: it is not on the calendar, nor counted for the GPUs.
   */
  function windows(nodes, today) {
    const out = []
    for (const n of nodesOf(nodes)) {
      if (n.type !== 'experiment' || n.supersededBy) continue
      if (n.status === 'running') {
        if (!n.started) continue
        const from = n.started
        if (n.est > 0) {
          const plannedTo = addDays(from, n.est)
          out.push({ id: n.id, from, to: later(plannedTo, addDays(today, 1)), plannedTo, kind: 'running', over: plannedTo <= today })
        } else out.push({ id: n.id, from, to: addDays(later(from, today), 1), kind: 'running', noEnd: true })
      } else if (FINISHED.includes(n.status)) {
        if (n.started && n.finished && n.finished >= n.started) out.push({ id: n.id, from: n.started, to: addDays(n.finished, 1), kind: 'done' })
      } else if (!GONE.includes(n.status) && n.start && n.est > 0) {
        out.push({ id: n.id, from: n.start, to: addDays(n.start, n.est), kind: 'planned' })
      }
    }
    return out
  }

  /**
   * The days, from today on, on which the planned and running experiments need more GPUs than
   * `capacity` (`gpus:` in the config; each experiment one unless its `gpus:` says more), each run
   * of such days with the same experiments as one clash; and the running ones with no end
   * planned, which hold their GPUs through today. Nothing without a capacity.
   */
  function gpuLoad(nodes, capacity, today) {
    if (!(capacity > 0)) return { clashes: [], noEnd: [] }
    const { days, noEnd } = gpuDays(nodes, today)
    const clashes = []
    for (const { day, need, notes } of days) {
      if (need <= capacity) continue
      const key = notes.map(x => x.id).join(',')
      const last = clashes[clashes.length - 1]
      if (last && last.key === key && addDays(last.to, 1) === day) last.to = day
      else clashes.push({ from: day, to: day, need, notes, key })
    }
    return { clashes: clashes.map(({ key, ...c }) => c), noEnd }
  }

  /** The GPUs the planned and running experiments take on each day from today on, the days in order; and the runs with no end planned. */
  function gpuDays(nodes, today) {
    const byId = new Map(nodesOf(nodes).map(n => [n.id, n]))
    const days = new Map()
    const noEnd = []
    for (const w of windows(nodes, today)) {
      if (w.kind === 'done') continue
      if (w.noEnd) noEnd.push(w.id)
      const gpus = byId.get(w.id).gpus > 0 ? byId.get(w.id).gpus : 1
      for (let d = later(w.from, today); d < w.to; d = addDays(d, 1)) {
        if (!days.has(d)) days.set(d, [])
        days.get(d).push({ id: w.id, gpus })
      }
    }
    return {
      days: [...days.keys()].sort().map(day => {
        const notes = days.get(day).sort((a, b) => naturally(a.id, b.id))
        return { day, need: notes.reduce((s, x) => s + x.gpus, 0), notes }
      }),
      noEnd: noEnd.sort(naturally),
    }
  }

  /**
   * Each deadline planned backwards from its due day, nearest first: the open milestones (their
   * `needs:`) and the notes with a `due:` of their own (needing themselves). For each note still
   * to do: its latest start and end (the due day, or the latest start of a needed note that comes
   * `after:` it), its slack (from its earliest start, or for a running one from its expected end),
   * and for a run over its estimate how far over. A deadline's slack is its smallest; it is at
   * risk at 0 days or less, or when a needed note was dropped, superseded or is missing. A meeting
   * with `needs:` is planned for at its next occurrence.
   */
  function plan(nodes, milestones, today, meetings) {
    const list = nodesOf(nodes)
    const byId = new Map(list.map(n => [n.id, n]))

    // when a running note may end: its estimate's end, today at the earliest; unknown without a
    // start
    const expectedEnd = n => (n.est > 0 && n.started ? later(addDays(n.started, n.est), today) : null)

    // a note's earliest start: today, its planned start, the earliest end of the notes it comes after
    const starts = new Map()
    function earliestStart(n, seen) {
      if (starts.has(n.id)) return starts.get(n.id)
      let s = today
      if (n.status !== 'running' && n.start) s = later(s, n.start)
      for (const p of n.after || []) {
        const pn = byId.get(p)
        if (!pn || seen.has(p) || !usable(pn)) continue
        const end = pn.status === 'running' ? expectedEnd(pn) : pn.est > 0 ? addDays(earliestStart(pn, new Set([...seen, n.id])), pn.est) : null
        if (end) s = later(s, end)
      }
      starts.set(n.id, s)
      return s
    }

    function one(id, name, kind, due, needs, missing) {
      const items = []
      const problems = []
      for (const nid of needs) {
        const n = byId.get(nid)
        if (!n) problems.push(`${nid} is not a note of the tree`)
        else if (n.supersededBy) problems.push(`${n.name} was superseded by ${n.supersededBy}`)
        else if (GONE.includes(n.status)) problems.push(`${n.name} was ${n.status}`)
        else if (!FINISHED.includes(n.status)) items.push(n)
      }
      for (const m of missing || []) problems.push(`${m} is not a note of the tree`)
      const latest = new Map()
      const latestOf = (n, seen = new Set()) => {
        if (latest.has(n.id)) return latest.get(n.id)
        seen.add(n.id)
        let end = due.day
        for (const m of items) {
          if (m.id === n.id || seen.has(m.id) || !(m.after || []).includes(n.id)) continue
          const l = latestOf(m, new Set(seen))
          if (l.start && l.start < end) end = l.start
        }
        const v = { end, start: n.est > 0 ? addDays(end, -n.est) : null }
        latest.set(n.id, v)
        return v
      }
      const planned = items.map(n => {
        const l = latestOf(n)
        const item = { id: n.id, latestEnd: l.end }
        if (l.start) item.latestStart = l.start
        if (!(n.est > 0)) return { ...item, noEstimate: true, slack: null }
        if (n.status === 'running') {
          if (!n.started) return { ...item, noStart: true, slack: null }
          item.expectedEnd = expectedEnd(n)
          item.slack = between(item.expectedEnd, l.end)
          if (n.started && between(n.started, today) > n.est) item.overrun = between(n.started, today) - n.est
          item.est = n.est
          return item
        }
        item.earliestStart = earliestStart(n, new Set())
        if (item.earliestStart > today) item.waits = true
        if (n.start) item.start = n.start
        item.slack = between(item.earliestStart, l.start)
        item.est = n.est
        return item
      })
      const known = planned.filter(i => i.slack !== null).map(i => i.slack)
      const slack = known.length ? Math.min(...known) : null
      return {
        id, name, kind, due: due.day, dueText: formatDue(due), at: due, daysLeft: between(today, due.day),
        slack, atRisk: problems.length > 0 || (slack !== null && slack <= 0), items: planned, problems,
      }
    }

    const out = []
    for (const m of milestones || []) {
      const due = parseDue(m.due)
      if (!due || (m.status || 'open') !== 'open') continue
      out.push(one(m.id, m.name, 'milestone', due, m.needs || [], m.missing))
    }
    for (const n of list) {
      const due = n.due ? parseDue(n.due) : null
      if (due && usable(n)) out.push(one(n.id, n.name, 'note', due, [n.id], []))
    }
    for (const m of meetings || []) {
      if (!(m.needs || []).length && !(m.missing || []).length) continue
      const occ = nextOccurrence(m, today)
      if (occ) out.push({ ...one(m.id, m.name, 'meeting', occ.at, m.needs || [], m.missing), orig: occ.orig })
    }
    return out.sort((a, b) => a.due.localeCompare(b.due) || (a.at.time || '24').localeCompare(b.at.time || '24') || naturally(a.id, b.id))
  }

  /** `in 3d`, `today`, `2d ago`. */
  const when = daysLeft => (daysLeft === 0 ? 'today' : daysLeft > 0 ? `in ${daysLeft}d` : `${-daysLeft}d ago`)

  /** What puts a deadline at risk, or how much room it has, in words. */
  function detail(p) {
    const parts = [...p.problems]
    for (const i of p.items) {
      if (i.noEstimate) parts.push(`${i.id} has no estimate (est:)`)
      else if (i.noStart) parts.push(`${i.id} is running with no start date (started:)`)
      else if (!p.atRisk) continue
      else if (i.overrun) parts.push(`${i.id} ${i.overrun}d over its ${i.est}d estimate`)
      else if (i.slack > 0) continue
      else if (i.expectedEnd) parts.push(`${i.id} ends ${-i.slack}d after its latest end (${i.latestEnd})`)
      else if (i.slack === 0) parts.push(i.waits ? `${i.id} must start on ${i.earliestStart}, its latest start` : `${i.id} must start today`)
      else if (!i.waits) parts.push(`${i.id} should have started by ${i.latestStart}`)
      else if (i.start === i.earliestStart) parts.push(`${i.id} planned to start ${i.start}, ${-i.slack}d after its latest start (${i.latestStart})`)
      else parts.push(`${i.id} can start ${i.earliestStart} at the earliest, ${-i.slack}d after its latest start (${i.latestStart})`)
    }
    if (p.atRisk) return `at risk: ${parts.join('; ')}`
    if (p.slack === null) return parts.length ? parts.join('; ') : p.items.length ? '' : 'nothing left to do for it'
    const by = p.items.filter(i => i.slack !== null).map(i => (i.expectedEnd ? `${i.id} ends by ${i.latestEnd}` : `${i.id} by ${i.latestStart}`))
    return `${p.slack}d of slack: ${by.join(', ')}${parts.length ? `; ${parts.join('; ')}` : ''}`
  }

  /** A deadline in one line: `M01 Workshop paper · 2026-12-05 (in 26d) · 18d of slack: E03 by 2026-11-27`. */
  const deadlineLine = p => [`${p.name} · ${p.dueText} (${when(p.daysLeft)})`, detail(p)].filter(Boolean).join(' · ')

  /** `a`, `a and b`, `a, b and c`. */
  const andList = items => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items.join(''))

  /** A GPU clash in one line: `2026-11-28→2026-11-29, E03 (2 GPUs) and E04 (1 GPU) need 3 of 2`. */
  const clashLine = (c, capacity) =>
    `${c.from === c.to ? c.from : `${c.from}→${c.to}`}, ${andList(c.notes.map(x => `${x.id} (${x.gpus} GPU${x.gpus === 1 ? '' : 's'})`))} need ${c.need} of ${capacity}`

  // ---------------------------------------------------------------- the meetings

  const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
  const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth']

  /** A meeting's length in minutes: `1h`, `45m`, `1h30m`, `90 min`; null when it is none, or not above 0. */
  function parseDuration(v) {
    if (typeof v === 'number') return Number.isInteger(v) && v > 0 ? v : null
    const m = typeof v === 'string' ? DURATION_RE.exec(unquote(v)) : null
    if (!m || (m[1] === undefined && m[2] === undefined)) return null
    const min = 60 * +(m[1] || 0) + +(m[2] || 0)
    return min > 0 ? min : null
  }

  /** Minutes as they are written back: `1h30m`, `45m`, `2h`. */
  const formatDuration = min => (min > 0 ? `${Math.floor(min / 60) ? `${Math.floor(min / 60)}h` : ''}${min % 60 ? `${min % 60}m` : ''}` : '')

  /**
   * How often a meeting comes back, as written in `every:`: `week`, `2 weeks`, `day`, `month`
   * (the same date), `month on the first Tuesday` (`second` … `fifth`, `last`), also `1w`,
   * `weekly`, `every 2 weeks`. `{unit: 'day' | 'week' | 'month', n}`, with `nth` (1-5, -1 for the
   * last) and `wd` (Monday 0 … Sunday 6) for a weekday of the month; null when it is none.
   */
  function parseEvery(v) {
    const m = typeof v === 'string' ? EVERY_RE.exec(unquote(v).replace(/\s+/g, ' ')) : null
    if (!m) return null
    const word = m[2].toLowerCase()
    if (word.endsWith('ly') && m[1] !== undefined) return null
    const unit = { d: 'day', w: 'week', m: 'month' }[word[0]]
    const n = m[1] === undefined ? 1 : +m[1]
    if (!(n >= 1 && n <= 99)) return null
    if (!m[3]) return { unit, n }
    const wd = WEEKDAY_NAMES.findIndex(d => d.toLowerCase().startsWith(m[4].toLowerCase()))
    if (unit !== 'month' || wd < 0) return null
    const ord = m[3].toLowerCase()
    return { unit, n, nth: ord === 'last' ? -1 : ORDINALS.indexOf(ord) + 1, wd }
  }

  /** A rule as it is written back: `week`, `2 weeks`, `month on the first Tuesday`. */
  function formatEvery(r) {
    if (!r) return ''
    const base = r.n === 1 ? r.unit : `${r.n} ${r.unit}s`
    return r.nth ? `${base} on the ${r.nth === -1 ? 'last' : ORDINALS[r.nth - 1]} ${WEEKDAY_NAMES[r.wd]}` : base
  }

  /** The items of a one-line list as written (`[2026-12-22, "2026-12-29"]`), or the list itself. */
  function listItems(v) {
    if (Array.isArray(v)) return v.map(x => unquote(String(x))).filter(Boolean)
    if (typeof v !== 'string') return []
    const s = v.trim().replace(/^\[(.*)\]$/, '$1')
    return s.split(',').map(x => unquote(x)).filter(Boolean)
  }

  const days = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()
  const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

  /** The day of a month (1-12) that is its `nth` weekday `wd` (-1: the last); null when it has none (a fifth). */
  function nthWeekday(y, m, nth, wd) {
    const dim = days(y, m)
    if (nth === -1) {
      const last = ymd(y, m, dim)
      return ymd(y, m, dim - ((weekday(last) - wd + 7) % 7))
    }
    const d = 1 + ((wd - weekday(ymd(y, m, 1)) + 7) % 7) + 7 * (nth - 1)
    return d <= dim ? ymd(y, m, d) : null
  }

  /** Which weekday of its month a day is: `{wd, nth}` (1-5) and whether it is the last one (`last`). */
  const nthOf = day => ({ wd: weekday(day), nth: Math.ceil(+day.slice(8) / 7), last: +day.slice(8) + 7 > days(+day.slice(0, 4), +day.slice(5, 7)) })

  /**
   * A meeting read: its first occurrence (`start`, a due date), its length in minutes, how often it
   * comes back (`rule`), its last day (`until`), the days skipped and each occurrence moved (its
   * day → where it went, which keeps the meeting's time and zone when it gives none); null
   * without a `when:`.
   */
  function meetingOf(m) {
    const start = parseDue(m && m.when)
    if (!start) return null
    const moved = new Map()
    for (const item of listItems(m.moved)) {
      const x = parseMoved(item, start)
      if (x) moved.set(x.from, x.to)
    }
    return {
      start, minutes: parseDuration(m.duration), rule: m.every ? parseEvery(m.every) : null, badRule: Boolean(m.every) && !parseEvery(m.every),
      until: parseDay(m.until), skip: new Set(listItems(m.skip).filter(isDay)), moved,
    }
  }

  /** `2026-12-01 → 2026-12-02 10:00` read: `{from, to}`; a `to` with no time takes the meeting's, one with no zone its zone. */
  function parseMoved(v, start) {
    const m = typeof v === 'string' ? MOVED_RE.exec(unquote(v)) : null
    const to = m && isDay(m[1]) ? parseDue(m[2]) : null
    if (!to) return null
    if (start && start.time && !to.time) Object.assign(to, { time: start.time }, start.zone ? { zone: start.zone } : {})
    else if (start && start.zone && to.time && !to.zone) to.zone = start.zone
    return { from: m[1], to }
  }

  /** An occurrence moved, as it is written back: `2026-12-01 → 2026-12-02 10:00`. */
  const formatMoved = (from, to) => `${from} → ${formatDue(to)}`

  /** The days the rule falls on from `from` up to `to` (excluded), from the first one on and up to `until`. */
  function ruleDays(mt, from, to) {
    const out = []
    const first = mt.start.day
    const end = mt.until && addDays(mt.until, 1) < to ? addDays(mt.until, 1) : to
    from = later(from, first)
    if (from >= end) return out
    const r = mt.rule
    if (!r) return first >= from && first < end ? [first] : out
    if (r.unit !== 'month') {
      const step = r.n * (r.unit === 'week' ? 7 : 1)
      for (let d = addDays(first, Math.ceil(between(first, from) / step) * step); d < end; d = addDays(d, step)) out.push(d)
      return out
    }
    const y0 = +first.slice(0, 4), m0 = +first.slice(5, 7)
    const at = 12 * y0 + m0 - 1
    const dom = +first.slice(8)
    for (let k = Math.max(0, Math.floor((12 * +from.slice(0, 4) + +from.slice(5, 7) - 1 - at) / r.n)); ; k++) {
      const i = at + k * r.n
      const y = Math.floor(i / 12), mo = (i % 12) + 1
      if (ymd(y, mo, 1) >= end) break
      const d = r.nth ? nthWeekday(y, mo, r.nth, r.wd) : dom <= days(y, mo) ? ymd(y, mo, dom) : null
      if (d && d >= from && d < end) out.push(d)
    }
    return out
  }

  /** Whether `day` is one of the meeting's occurrences by its rule (skipped or moved ones too). */
  function isOccurrence(m, day) {
    const mt = m && m.start ? m : meetingOf(m)
    return Boolean(mt) && isDay(day) && ruleDays(mt, day, addDays(day, 1)).length === 1
  }

  /**
   * A meeting's occurrences from `from` up to `to` (excluded), in order: `{day, at, orig}`, `at`
   * its day, time and zone, `orig` the day its rule gives (`moved` when it went elsewhere); the
   * skipped ones only with `skipped` (`{day, at, orig, skipped: true}`).
   */
  function occurrences(m, from, to, opts = {}) {
    const mt = meetingOf(m)
    if (!mt) return []
    const out = []
    const at = day => ({ ...mt.start, day })
    for (const d of ruleDays(mt, from, to)) {
      if (mt.skip.has(d)) { if (opts.skipped) out.push({ day: d, at: at(d), orig: d, skipped: true }); continue }
      if (!mt.moved.has(d)) out.push({ day: d, at: at(d), orig: d })
    }
    for (const [orig, dest] of mt.moved) {
      if (mt.skip.has(orig) || !(dest.day >= from && dest.day < to) || !isOccurrence(mt, orig)) continue
      out.push({ day: dest.day, at: dest, orig, moved: true })
    }
    return out.sort((a, b) => a.day.localeCompare(b.day) || (a.at.time || '').localeCompare(b.at.time || ''))
  }

  /** A meeting's next occurrence from `today` on (today's too), or null when there is none left. */
  function nextOccurrence(m, today) {
    for (let f = today, i = 0; i < 10; f = addDays(f, 400), i++) {
      const o = occurrences(m, f, addDays(f, 400))
      if (o.length) return o[0]
    }
    return null
  }

  /** The meetings' occurrences from `from` up to `to` (excluded), in order: `{meeting, occ}`. */
  function upcoming(meetings, from, to) {
    const out = []
    for (const m of meetings || []) for (const occ of occurrences(m, from, to)) out.push({ meeting: m, occ })
    return out.sort((a, b) => a.occ.day.localeCompare(b.occ.day) || (a.occ.at.time || '').localeCompare(b.occ.at.time || '') || naturally(a.meeting.id, b.meeting.id))
  }

  /** How a meeting comes back, in words: `once`, `every week`, `every 2 weeks until 2027-06-30`. */
  function repeatText(m) {
    const mt = meetingOf(m)
    if (!mt || !mt.rule) return 'once'
    return `every ${formatEvery(mt.rule)}${mt.until ? ` until ${mt.until}` : ''}`
  }

  /** An occurrence in one line: `G01 Supervisor meeting · 2026-11-24 14:00 (in 4d) · 1h, every week`. */
  function meetingLine(m, occ, today) {
    const mt = meetingOf(m)
    const what = [mt && mt.minutes ? formatDuration(mt.minutes) : '', repeatText(m), occ.moved ? `moved from ${occ.orig}` : ''].filter(Boolean).join(', ')
    return `${m.name} · ${formatDue(occ.at)} (${when(between(today, occ.day))}) · ${what}`
  }

  // ---------------------------------------------------------------- the calendar file

  const icsText = s => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
  const icsDay = day => day.replace(/-/g, '')
  const slug = s => String(s).replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'rft'

  /** A content line folded at 75 characters, as RFC 5545 asks. */
  function fold(line) {
    if (line.length <= 75) return line
    const parts = [line.slice(0, 75)]
    for (let i = 75; i < line.length; i += 74) parts.push(' ' + line.slice(i, i + 74))
    return parts.join('\r\n')
  }

  /** When a deadline falls: a day; a local time, floating; a time in a zone, in UTC. */
  function icsStart(due) {
    const utc = utcOf(due)
    if (utc) return `DTSTART:${utc.replace(/[-:]/g, '')}`
    if (due.time) return `DTSTART:${icsDay(due.day)}T${due.time.replace(':', '')}00`
    return `DTSTART;VALUE=DATE:${icsDay(due.day)}`
  }

  const ICS_DAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
  const icsOffset = min => `${min < 0 ? '-' : '+'}${String(Math.floor(Math.abs(min) / 60)).padStart(2, '0')}${String(Math.abs(min) % 60).padStart(2, '0')}`

  /**
   * How a meeting's time is written: a day (`;VALUE=DATE`), a local time (floating), a time in UTC;
   * one in another zone, for a meeting that comes back, in that zone (`;TZID=`, kept in `tz`: its
   * rule then counts days and weekdays there, not in UTC), else in UTC. `{param, value}`.
   */
  function icsAt(at, recurring, tz) {
    if (!at.time) return { param: ';VALUE=DATE', value: icsDay(at.day) }
    const local = `${icsDay(at.day)}T${at.time.replace(':', '')}00`
    if (!at.zone) return { param: '', value: local }
    const off = offsetOf(at.zone)
    if (!recurring || off === 0) return { param: '', value: utcOf(at).replace(/[-:]/g, '') }
    // a whole hour has its IANA name (Etc/GMT-1 is UTC+01:00), which every calendar app knows
    const id = off % 60 === 0 ? `Etc/GMT${off === 0 ? '' : off > 0 ? '-' : '+'}${Math.abs(off) / 60}` : `UTC${at.zone}`
    tz.set(id, off)
    return { param: `;TZID=${id}`, value: local }
  }

  /**
   * A meeting as events: one, or a series (RRULE, its skipped days as EXDATE) with each occurrence
   * moved as an event of its own (RECURRENCE-ID). Its first event is the rule's first day.
   */
  function icsMeeting(m, ctx) {
    const mt = meetingOf(m)
    if (!mt) return
    const r = mt.rule
    const first = ruleDays(mt, mt.start.day, addDays(mt.start.day, r ? 372 * r.n : 1))[0]
    if (!first) return
    const at = day => ({ ...mt.start, day })
    const put = (prop, a) => { const x = icsAt(a, Boolean(r), ctx.tz); return `${prop}${x.param}:${x.value}` }
    const needs = (m.needs || []).map(id => (ctx.byId.get(id) ? ctx.byId.get(id).name : id))
    const tail = [
      ...(mt.start.time && mt.minutes ? [`DURATION:PT${Math.floor(mt.minutes / 60) ? `${Math.floor(mt.minutes / 60)}H` : ''}${mt.minutes % 60 ? `${mt.minutes % 60}M` : ''}`] : []),
      `SUMMARY:${icsText(m.name)}`,
      ...(needs.length ? [`DESCRIPTION:${icsText(`Needs ${needs.join(', ')}`)}`] : []),
    ]
    const uid = `UID:${m.id}@${ctx.host}`
    if (!r) return ctx.event([uid, ctx.stamp, put('DTSTART', at(first)), ...tail])
    const rule = [`FREQ=${{ day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY' }[r.unit]}`]
    if (r.n > 1) rule.push(`INTERVAL=${r.n}`)
    if (r.unit === 'month') rule.push(r.nth ? `BYDAY=${r.nth}${ICS_DAYS[r.wd]}` : `BYMONTHDAY=${+mt.start.day.slice(8)}`)
    if (mt.until) {
      const x = icsAt(at(mt.until), true, ctx.tz)
      rule.push(`UNTIL=${!mt.start.time ? x.value : !mt.start.zone ? `${icsDay(mt.until)}T235959` : utcOf({ day: mt.until, time: '23:59', zone: mt.start.zone }).replace(/[-:]/g, '').replace(/00Z$/, '59Z')}`)
    }
    const skipped = [...mt.skip].filter(d => isOccurrence(mt, d)).sort()
    const ex = skipped.map(d => icsAt(at(d), true, ctx.tz))
    ctx.event([uid, ctx.stamp, put('DTSTART', at(first)), `RRULE:${rule.join(';')}`,
      ...(ex.length ? [`EXDATE${ex[0].param}:${ex.map(x => x.value).join(',')}`] : []), ...tail])
    for (const [orig, dest] of [...mt.moved].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (mt.skip.has(orig) || !isOccurrence(mt, orig)) continue
      ctx.event([uid, ctx.stamp, put('RECURRENCE-ID', at(orig)), put('DTSTART', dest), ...tail])
    }
  }

  /**
   * The deadlines (the milestones but the suggested and dismissed ones, and the notes' own due
   * dates), the meetings and the experiments' planned and past runs as an iCalendar file, for any
   * calendar to import. Claude's suggestions are left out. `stamp`: when it was made (ISO).
   * Nothing in it depends on today, so the file changes only when the dates do.
   */
  function ics(o) {
    const stamp = `DTSTAMP:${String(o.stamp).replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '')}`
    const host = `${slug(o.project)}.rft`
    const nodes = nodesOf(o.nodes)
    const byId = new Map(nodes.map(n => [n.id, n]))
    const events = []
    const event = lines => events.push('BEGIN:VEVENT', ...lines.map(fold), 'END:VEVENT')
    for (const m of o.milestones || []) {
      const due = parseDue(m.due)
      if (!due || !['open', 'done', undefined].includes(m.status)) continue
      const needs = (m.needs || []).map(id => (byId.get(id) ? byId.get(id).name : id))
      event([`UID:${m.id}@${host}`, stamp, icsStart(due), `SUMMARY:${icsText(m.name)}`,
        ...(needs.length || m.source ? [`DESCRIPTION:${icsText([needs.length ? `Needs ${needs.join(', ')}` : '', m.source || ''].filter(Boolean).join('\n'))}`] : [])])
    }
    for (const n of nodes) {
      const due = n.due ? parseDue(n.due) : null
      if (due && usable(n)) event([`UID:${n.id}-due@${host}`, stamp, icsStart(due), `SUMMARY:${icsText(`${n.name} (due)`)}`])
    }
    const tz = new Map()
    for (const m of o.meetings || []) icsMeeting(m, { host, stamp, byId, tz, event })
    // the runs as planned: a running one from its start for its estimate, none without an end
    for (const w of windows(nodes, '1970-01-01')) {
      const n = byId.get(w.id)
      if (w.noEnd) continue
      const to = w.kind === 'running' ? w.plannedTo : w.to
      event([`UID:${n.id}@${host}`, stamp, `DTSTART;VALUE=DATE:${icsDay(w.from)}`, `DTEND;VALUE=DATE:${icsDay(to)}`,
        `SUMMARY:${icsText(n.name)}`, `DESCRIPTION:${icsText(`${n.status}${n.gpus > 1 ? `, ${n.gpus} GPUs` : ''}`)}`])
    }
    // the fixed offsets the meetings' times are in
    const zones = [...tz].sort((a, b) => a[0].localeCompare(b[0])).flatMap(([id, off]) => ['BEGIN:VTIMEZONE', `TZID:${id}`, 'BEGIN:STANDARD', 'DTSTART:19700101T000000',
      `TZOFFSETFROM:${icsOffset(off)}`, `TZOFFSETTO:${icsOffset(off)}`, `TZNAME:UTC${icsOffset(off).replace(/(\d\d)$/, ':$1')}`, 'END:STANDARD', 'END:VTIMEZONE'])
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//rft//${icsText(o.project)}//EN`, 'CALSCALE:GREGORIAN', fold(`X-WR-CALNAME:${icsText(o.project)}`), ...zones, ...events, 'END:VCALENDAR']
    return { text: lines.join('\r\n') + '\r\n', events: events.filter(l => l === 'BEGIN:VEVENT').length }
  }

  // ---------------------------------------------------------------- the month

  /** The weeks shown for a month (1-12): Monday to Sunday, from the week of its first day to that of its last. */
  function monthWeeks(year, month) {
    const first = `${year}-${String(month).padStart(2, '0')}-01`
    const last = addDays(month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`, -1)
    const weeks = []
    for (let d = addDays(first, -weekday(first)); d <= last; d = addDays(d, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)))
    return weeks
  }

  /**
   * Bars across a week: the windows that cross it, each cut to the week, in lanes so that two
   * never overlap; `from` and `to` are columns (0-6, `to` excluded).
   */
  function weekBars(week, wins) {
    const start = week[0], end = addDays(week[6], 1)
    const bars = wins.filter(w => w.from < end && w.to > start)
      .sort((a, b) => a.from.localeCompare(b.from) || b.to.localeCompare(a.to))
      .map(w => ({ ...w, col: between(start, later(w.from, start)), span: between(later(w.from, start), w.to < end ? w.to : end), cutStart: w.from < start, cutEnd: w.to > end }))
    const lanes = []
    for (const b of bars) {
      let lane = lanes.findIndex(l => l <= b.col)
      if (lane < 0) { lane = lanes.length; lanes.push(0) }
      lanes[lane] = b.col + b.span
      b.lane = lane
    }
    return bars
  }

  root.RftSchedule = {
    MILESTONE_STATUSES, DUE_EXAMPLES, DUE_RE, DURATION_RE, EVERY_RE, MOVED_RE, WEEKDAY_NAMES, ORDINALS,
    isDay, parseDay, addDays, between, weekday, parseDue, formatDue, utcOf, parseEst,
    windows, gpuLoad, gpuDays, plan, when, detail, deadlineLine, clashLine, andList, ics, monthWeeks, weekBars,
    parseDuration, formatDuration, parseEvery, formatEvery, listItems, parseMoved, formatMoved, nthOf, nthWeekday,
    meetingOf, isOccurrence, occurrences, nextOccurrence, upcoming, repeatText, meetingLine,
  }
})(typeof globalThis !== 'undefined' ? globalThis : window)
