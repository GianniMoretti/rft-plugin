# Locked notes, comments and suggestions

A part of the rft manual (the `rft-manual` skill is its core, with the index of the parts).

- **A locked note** (`locked: true` in its frontmatter; the user sets it with the padlock in the
  tree view) is the user's: never change its text. Edit, Write and shell commands that write to
  it are refused, and so are `rft_set_status` with a note and `rft_set_code` on it. Propose each
  change with `rft_suggest {id, quote, replacement}`, one per passage; the user accepts or rejects
  it in the tree view, and an accepted one is written into the note. Its status, tags and derived
  fields still change through the rft tools. Never unlock a note: that is the user's alone.
  `rft_move_node` and `rft_supersede` write a line in its History, so on a locked note the plugin
  asks the user whether to unlock it; if they keep it locked the call fails and nothing changes:
  do not retry it, and do not work around it (e.g. by moving its children instead).
- **The discussion of a note** is kept beside it, in `<vault>/.comments/<id>.json`, written by
  the tree view and the rft tools only (never by hand). `rft_comments <id>` gives a note's threads
  (the open ones in full); with no id, the notes with open threads. A thread is on a part of the text, its
  quote (the note's markdown as written), found again after edits from the text around it:
  - a **comment** discusses that part before any edit;
  - a **suggestion** has new text for it, or says in words what should change (an instruction,
    with no replacement yet).
- **Answer a thread only when the user asks**: the tree view's **Ask Claude** sends you the thread
  as a prompt (when it cannot answer it in a subagent). Answer in the thread, not in the chat:
  - a comment: read what the question needs, reply with `rft_comment {id, thread, text}`, and do
    not edit the note; propose a change with `rft_suggest` if one is needed;
  - a suggestion on a locked note: write the new text with `rft_suggest {id, thread,
    replacement, text}`; the user accepts it;
  - a suggestion on a note that is not locked: make the change in the note yourself, then close the
    thread with `rft_comment {id, thread, applied: true, text: what you changed}`;
  - unclear or wrong: reply with `rft_comment` and change nothing.
- **A message another agent wrote**: the user may have other agents answer a thread (a local
  model, another harness); `rft_comments` names the agent on its message. It is not yours:
  weigh it as you would a colleague's reply, and say so when you disagree.
- **Quotes** are exact text of the note below its frontmatter, markdown included, occurring once
  in it: quote more of the text around it when a phrase repeats.
- **Footnotes** are part of the note, as Obsidian writes them: a mark `[^1]` and its text on a line
  `[^1]: …` at the end (indented lines continue it), or inline `^[…]`. The tree view shows them in
  the margin. Keep them when you edit a note.
- **Highlights** `==text==` are the user's, as Obsidian writes them: keep them when you edit a note.
