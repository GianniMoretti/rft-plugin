// The values the rft plugin keeps in the session's `$.state`.

export type RftNodeState = {
  id: string
  name: string
  title: string
  type: 'experiment' | 'direction' | 'reference' | 'theory'
  status: string
  date: string
  parent: string | null
  children: string[]
  path: string
  tags: string[]
  concept: string
}

export type RftConceptState = {
  id: string
  name: string
  summary: string
  root: string | null
  parent: string | null
  children: string[]
  depth: number
  count: number
  total: number
  statuses: Record<string, number>
}

/** The tree as last read from the vault; `null` until the session has looked. */
export type RftSnapshot = {
  isActive: boolean
  /** The vault's folder, absolute: the tree may be outside the session's folder. */
  vault: string
  project: string
  nodes: Record<string, RftNodeState>
  roots: string[]
  concepts: Record<string, RftConceptState>
  signature: string
  problems: string[]
  error: string | null
}

export type RftNoteView = { id: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    rft: {
      snapshot: RftSnapshot | null
      collapsed: string[]
      selected: string | null
      note: RftNoteView | null
      /** The web view's address while its server runs. */
      webUrl: string | null
    }
  }
}
