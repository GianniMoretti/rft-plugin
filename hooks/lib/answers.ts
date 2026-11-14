// The subagents that answer the tree view's threads (Ask Claude): which thread each answers, and
// its report, which reaches the main conversation (a task notification, or a hand-back message)
// though the main conversation does not need it, since the answer is in the thread.

export type ThreadJob = { id: string; thread: string; what: string }

export class Answers {
  // by agentId: the thread it answers
  private answering = new Map<string, ThreadJob>()
  // the agents whose report is still to come
  private quiet = new Set<string>()

  watch(agentId: string, job: ThreadJob): void {
    this.answering.set(agentId, job)
    this.quiet.add(agentId)
  }

  /** The thread a subagent that just ended answered, or null when it is not one of these. */
  ended(agentId: string | undefined): ThreadJob | null {
    const job = agentId ? this.answering.get(agentId) : undefined
    if (!job) return null
    this.answering.delete(agentId!)
    return job
  }

  /** Whether this prompt is the report of one of these subagents (and forgets it). */
  isNotification(text: string, kind: string | undefined): boolean {
    if ((kind !== 'task-notification' && kind !== 'peer') || !this.quiet.size) return false
    const ids = [...this.quiet].filter(id => text.includes(id))
    for (const id of ids) this.quiet.delete(id)
    return ids.length > 0
  }
}
