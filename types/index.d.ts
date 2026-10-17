// The values the rft plugin keeps in the session's `$.state`.

export type RftNodeState = {
  id: string
  name: string
  title: string
  type: 'experiment' | 'direction'
  status: string
  date: string
  parent: string | null
  children: string[]
  path: string
}

/** The tree as last read from the vault; `null` until the session has looked. */
export type RftSnapshot = {
  isActive: boolean
  vault: string
  project: string
  nodes: Record<string, RftNodeState>
  roots: string[]
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
