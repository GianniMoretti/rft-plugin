# The inbox

A part of the rft manual (the `rft-manual` skill is its core, with the index of the parts).

- **The inbox** is the list of what the user saved to read later and has not decided about:
  papers, articles, blog posts. It is outside the tree, in `Inbox.md` at the vault's top, beside
  the scratchpad. An **inbox item** is one link (a URL, an arXiv id or a DOI) with, when given, a
  line on why it was saved and a reading priority. It is not a note: it has no id and no parent,
  and no note links to it.
- **`rft_inbox`** with no argument lists the items, the most urgent first; `rft_inbox {link, why,
  title}` saves one (`title` only when the source's title is known, never a guess). A link that
  is already in the inbox, discarded, processed or the **Source** of a reference note is
  reported and nothing is added. `rft_next` says in one line how many items wait.
- **Save to the inbox what nobody read yet.** When the user asks to keep something for later,
  save it. When a source turns up in the work that there is no time to read now, offer to save
  it: a reference note is for a source that was read (the core's rule 4).
- **The reading priority** (urgent, high, medium or low) is the user's alone, and is not a note's
  priority: `rft_inbox` takes none, and it is never set by editing the file either. It ends
  with the item; it is never carried to a note.
- **The read mark** (`read 2026-11-24` on the item's line) is the user's alone too: they set it
  once they have read the item, and may take it off. Never set, change or remove it, through the
  tool (it cannot) or by editing the file.
- **A reading note** belongs to one item, in two parts: the user's (quotes from the item, as
  lines that start with `>`, and lines of their own) and an **impression**: yours, or one the
  tool says another agent of the user's wrote (yours replaces it). One file per item in
  `Reading notes/`. Reach it through `rft_inbox` alone:
  **never open, search or edit its file by other means**, and never edit the user's part. Until the user marks the item as read their part is closed to you, so that the
  two readings are two points of view.
- **Never process an item unasked.** The items wait for the user: do not open their links,
  summarise them or turn them into notes because they are there, and say no more of the inbox
  than `rft_next`'s line unless the user asks.
- **The file** is the user's to edit in Obsidian: one list line per item, `- [Title](link) — why
  · high · added 2026-11-16`, and the processed items under `## Processed`. Add through
  `rft_inbox`, not by hand: it checks for duplicates and keeps the rest of the file as it is.
- The user has `/rft-inbox` (prints the inbox) and `/rft-inbox <link> [reading priority] [why]`
  (saves a link), and the inbox's panel in the tree view, beside the scratchpad's. Each item's
  row there opens its reading note, carries the read mark, and has one button: **Process**
  before the mark, **Discuss** after it.

## Processing an item

The user asks to **process** an item (the row's Process, or in the chat): your own reading of
it, which ends at the brief. No outcome is picked here. One item at a time.

1. **Read the item itself, from the item alone**: the page or the paper at its link, with the
   tools you have, again even when it has a brief or is already an entry of a literature note.
   If it cannot be read (a paywall, a dead link, a login), say so and save nothing: never write
   from the title, the abstract of another version or what you remember. Offer to discard it,
   to leave it for later, or to read its PDF if the user gives its path in the vault.
2. **Save your impression**: `rft_inbox {link, impression}`, about one screen (at most 3000
   characters), five parts under these headings and in this order:
   `### Claims` (what it claims); `### How` (how it gets there); `### Key results` (with their
   numbers, and where they are in the item: table, figure, section); `### Bearing on` (the notes
   of the tree it bears on, by id: `rft_search`, `rft_map`); `### Left open`. It goes in the
   item's reading note, made if there is none, and replaces an impression it had.
3. **Save the brief**: `rft_inbox {link, brief}`, at most three lines: what it claims; which
   notes of the tree it touches, by id; the one outcome you recommend, and where it would go.
4. **Give the brief in the chat and stop.** Write nothing to the tree. The user reads the item
   themselves and marks it as read when they are done; the discussion starts then.

Before the mark, `rft_inbox {link, reading: true}` gives your impression and says that the
user's part is closed; it never gives that part, whatever it holds. Once the user has marked
the item as read the impression is **frozen**: a new one is refused.

## Discussing an item

The user marks an item as **read** (or presses Discuss on a read item): the discussion, which
ends with the outcome. One item at a time.

1. **Open the reading note**: `rft_inbox {link, reading: true}`. It gives your impression and
   the user's part, which you see for the first time. With no impression yet the call is
   refused: read the item from the item alone, save your impression (and the brief), then ask
   again. Your reading is always written before you see the user's.
2. **Say where the two readings differ**: what the user kept that you passed over, what you
   found that they did not note, what the two of you read differently. Recommend one
   **outcome** and wait: you recommend, only the user picks. Write nothing to the tree until
   they do.
3. **Write what the outcome needs**, with the user's part carried over:
   - their **quotes** go in word for word, as quote lines (`>`), never paraphrased, merged or
     corrected: under a `## Quotes` section of the item's reference note (for `reference` and
     for `direction`), under the paper's entry of the literature note (for `literature entry`);
   - their **own lines** you may rephrase, but propose the wording in the chat first and write
     it only once they accept: into the reference's **Relevance**, or into the direction.
4. **Close the item** with `rft_inbox {link, outcome, ...}`. It leaves the inbox for one line
   under `## Processed`, with the date and what it became, and its reading note is removed. A
   note that is missing or of another kind is refused, and so is a close while a quote of the
   user's is not in the note word for word; nothing is closed then.

An item whose user's part is empty needs no mark: if the user picks an outcome right after
the brief, write it and close. While their part holds something, an outcome that writes to
the tree is refused until they mark the item as read. A `discard` asks nothing: the item is
kept (`## Discarded`, `Reading notes/Discarded/`), closed to you. Only the user brings it back
(`restore: true` if they ask); met again, it stays discarded.

| Outcome | What is written first | Closing call |
|---|---|---|
| `reference` | a reference note of the item (`rft_add_node`, `type: reference`, its link in **Source**), under the note it bears on | `outcome: "reference", note: "R15"` |
| `literature entry` | one `### <year> <first author> — <title>` entry, with the link, in the **Papers** of an existing literature note (kept as it is when the paper already has one) | `outcome: "literature entry", note: "R07"` |
| `direction` | the reference note of the item, then the direction with it among its `refs` | `outcome: "direction", note: "D12", cites: "R15"` |
| `discard` | nothing | `outcome: "discard", reason: "one line, in the user's terms"` |
| `later` | nothing: it stays, with its brief, its reading note and its read mark | none needed (`outcome: "later"` closes nothing) |

A note made from an item gets **no priority**, and none suggested because the item had a reading
priority: the two are different things. The notes follow the core's rules as any other (a
reference is written from what was read; parent, summary, tags).
