# The inbox

A part of the rft manual (the `rft-manual` skill is its core, with the index of the parts).

- **The inbox** is the list of what the user saved to read later and has not decided about:
  papers, articles, blog posts. It is outside the tree, in `Inbox.md` at the vault's top, beside
  the scratchpad. An **inbox item** is one link (a URL, an arXiv id or a DOI) with, when given, a
  line on why it was saved and a reading priority. It is not a note: it has no id and no parent,
  and no note links to it.
- **`rft_inbox`** with no argument lists the items, the most urgent first; `rft_inbox {link, why,
  title}` saves one (`title` only when the source's title is known, never a guess). A link that
  is already in the inbox, among the processed items or the **Source** of a reference note is
  reported and nothing is added. `rft_next` says in one line how many items wait.
- **Save to the inbox what nobody read yet.** When the user asks to keep something for later,
  save it. When a source turns up in the work that there is no time to read now, offer to save
  it: a reference note is for a source that was read (the core's rule 4).
- **The reading priority** (urgent, high, medium or low) is the user's alone, and is not a note's
  priority: `rft_inbox` does not take one, and it is never set, changed or removed by editing the
  file either. It ends with the item; it is never carried to a note.
- **Never process an item unasked.** The items wait for the user: do not open their links,
  summarise them or turn them into notes because they are there, and say no more of the inbox
  than `rft_next`'s line unless the user asks.
- **The file** is the user's to edit in Obsidian: one list line per item, `- [Title](link) — why
  · high · added 2026-11-16`, and the processed items under `## Processed`. Add through
  `rft_inbox`, not by hand: it checks for duplicates and keeps the rest of the file as it is.
- The user has `/rft-inbox` (prints the inbox) and `/rft-inbox <link> [reading priority] [why]`
  (saves a link), and the inbox's panel in the tree view, beside the scratchpad's.
