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
  (saves a link), and the inbox's panel in the tree view, beside the scratchpad's, with
  **Process** on each item.

## Processing an item

The user asks to **process** an item (the panel's Process, or in the chat): you read it and
discuss it with them until they pick what becomes of it. One item at a time.

1. **Read the item itself**: the page or the paper at its link, with the tools you have. If it
   cannot be read (a paywall, a dead link, a login), say so and save no brief: never brief from
   the title, the abstract of another version or what you remember. Offer to discard it, to
   leave it for later, or to read its PDF if the user gives its path in the vault.
2. **Save the brief before anything else**: `rft_inbox {link, brief}`, at most three lines:
   what it claims; which notes of the tree it touches, by id (`rft_search`, `rft_map`); the one
   outcome you recommend, and where it would go. It is saved under the item and replaces a brief
   it had. An item that already has a brief (`rft_inbox {link}` prints it) starts from it: do
   not read it again unless the user asks or the brief leaves the decision open.
3. **Give the brief in the chat and wait.** Write nothing to the tree until the user picks an
   **outcome**; you recommend one, only the user picks. Answer what they ask about the item
   meanwhile.
4. **Write what the outcome needs, then close the item** with `rft_inbox {link, outcome, ...}`.
   It leaves the inbox for one line under `## Processed`, with the date and what it became. A
   note that is missing or of another kind is refused, and nothing is closed.

| Outcome | What is written first | Closing call |
|---|---|---|
| `reference` | a reference note of the item (`rft_add_node`, `type: reference`, its link in **Source**), under the note it bears on | `outcome: "reference", note: "R15"` |
| `literature entry` | one `### <year> <first author> — <title>` entry, with the link, in the **Papers** of an existing literature note | `outcome: "literature entry", note: "R07"` |
| `direction` | the reference note of the item, then the direction with it among its `refs` | `outcome: "direction", note: "D12", cites: "R15"` |
| `discard` | nothing | `outcome: "discard", reason: "one line, in the user's terms"` |
| `later` | nothing: the item stays in the inbox with its brief | none needed (`outcome: "later"` closes nothing) |

A note made from an item gets **no priority**, and none suggested because the item had a reading
priority: the two are different things. The notes follow the core's rules as any other (a
reference is written from what was read; parent, summary, tags).
