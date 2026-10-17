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
      /** V: vertical indented tree; TD / LR: tidy trees. */
      orientation: 'V' | 'TD' | 'LR'
      /** fit: the whole tree in the pane; full: drawn at `scale`. */
      zoom: 'fit' | 'full'
      scale: number
      /** The node whose subtree alone is drawn; null for the whole tree. */
      focus: string | null
      /** The pane's view; null is the surface's default (the tree where Svg draws). */
      view: 'tree' | 'list' | null
    }
  }
}
