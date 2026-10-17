# rft — Reasoning Flow Tree for Claude Code

A Claude Code plugin that keeps the reasoning of a research project readable: **one note per
experiment and one per idea, linked parent → children as a tree**, kept up to date by Claude as
it works and shown live in a pane next to the conversation.

- **Experiments (E..)**: something run or computed that produced a result.
- **Directions (D..)**: ideas, questions, hypotheses, including the ones rejected, so the tree
  also says why a path was not taken. **D00** is the starting question.

The notes are plain, Obsidian-compatible markdown in your repository (`vault/` by default) and
are the source of truth. You never need Obsidian open: the tree is drawn by Claude Code itself.

<!-- Screenshots to add in docs/screenshots/: pane-desktop.png, pane-terminal.png, tree-html.png -->
_Screenshots: coming soon (the pane on the desktop app, the pane in the terminal, `tree.html`)._

## Install

At the prompt of a Claude Code terminal session:

```
/plugin marketplace add GianniMoretti/rft-plugin
/plugin install rft@rft-plugin
```

or in one step, `/plugin install rft --marketplace GianniMoretti/rft-plugin` (answer `y` to
add the marketplace, then pick a scope). Installed at the user scope it is available in every
project, and stays inert in projects where RFT is not activated.

The plugin is a Claude Code *mod* (a hooks module plus a skill): it needs a Claude Code build
with function hooks (2.1.29x or later). No Node, Python or server is required.

## Usage

### Activate it in a project

```
/rft-init Is there a better way to do X?
```

creates `.rft/config.json` (the per-project marker) and the vault:

```
vault/
  00 Index.md               the whole tree as an indented list, regenerated
  Reasoning tree.canvas     an Obsidian canvas of the tree, regenerated
  experiments/              E01 <title>.md, ...
  directions/               D00 <starting question>.md, ...
  templates/                _experiment.md, _direction.md
```

If `vault/experiments` or `vault/directions` already hold notes, `/rft-init` adopts them as
they are (ids, statuses and the next free id are read from the notes).

### What changes once it is active

- **At session start** Claude receives short operating rules and a compact copy of the tree, so
  it knows to create an experiment's node *before* launching it, record only real results, and
  add a direction for every new idea. The full manual is the `rft-manual` skill.
- **Tools** Claude calls to keep the tree consistent:

  | tool | does |
  |---|---|
  | `rft_add_node` | creates a note with the next free id, a sanitised title (no `^ # \| [ ]`), the template sections, and links it under its parent |
  | `rft_set_status` | changes a status (frontmatter, tag, Status line), optionally appending results or the reason |
  | `rft_tree` | prints the tree or a subtree |
  | `rft_validate` | checks ids, types, statuses, titles, parents, broken wikilinks, derived fields |
  | `rft_sync` | regenerates children / up / down, the index tree and the canvas after hand edits |

- **The tree pane** opens as a sidebar where the surface docks panes (turn this off with the
  `autoOpen` option), or with `/rft`. On the desktop app and in VS Code it draws the tree as a
  picture (top-down or left-right, coloured by type and status) with a clickable outline; in
  the terminal it is an indented, coloured outline. Click a node to read its note, ▾ / ▸ to
  fold a branch. It refreshes by itself when notes change, whoever changed them.

### Commands

| command | does |
|---|---|
| `/rft` | open the tree pane (`/rft text` prints the tree in the transcript) |
| `/rft-init [starting question]` | activate RFT here and create (or adopt) the vault |
| `/rft-view` | write `vault/tree.html`, a standalone page of the tree to open in any browser or share |

### Statuses

`planned` →, `running` …, `done` ✓, `idea` ?, `dropped` ✗, `discussed` · (not pursued),
`moved` ↗.

### Configuration

`.rft/config.json`:

```json
{ "version": 1, "vault": "vault", "project": "my-project", "canvas": true, "mermaid": false,
  "lastId": { "E": 12, "D": 9 } }
```

`mermaid: true` also writes `Reasoning tree (diagram).md`, a Mermaid flowchart Obsidian draws
natively. `lastId` keeps ids from being reused after a note is deleted.

### Obsidian, if you use it

Every note keeps `up:` / `down:` (the parent and the children), the default fields of the
Breadcrumbs plugin, so its tree view works without configuration; `Reasoning tree.canvas` is a
native Obsidian canvas whose hand-moved cards keep their place.

## Development

```
claude plugin validate .
claude plugin test .
claude --plugin-dir .          # a session with the plugin loaded from this folder
```

`hooks/register.tsx` is the hooks module (commands, tools, prompt injection, pane);
`hooks/lib/vault.ts` the vault model, `hooks/lib/svg.ts` the tree layout and drawing,
`hooks/lib/html.ts` the static export; `skills/rft-manual/SKILL.md` the manual; `tests/` runs on an
in-memory vault, the pane on both the terminal and the desktop surface.

## License

MIT
