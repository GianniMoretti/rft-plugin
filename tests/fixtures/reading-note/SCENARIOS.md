# Reading notes: the three cases, step by step

Written from tests/fixtures/reading-note/scenarios.json by to_ts.py: edit that file, not this one.

Each step says who acts and what happens, the call it is tested with, what the answer must say, and the
files it changes, as they are after it. `{today}` is the day the test runs. A step of the user's is run
against the page's server (tests/test_reading.py), a step of Claude's against the plugin's tool
(tests/reading.test.ts); each starts from the files the step before it left. A "given" step is not
run: it is what the user or Claude did outside the two (saving the link, writing a note of the tree).

## A. The user quotes on the phone, Process later (blind), marks as read, the discussion, a reference under a direction

### A0. Given

A week ago the user saved the paper from the phone. The item has no reading note.


`Inbox.md`

```markdown
# Inbox

- [Mixup at scale](https://arxiv.org/abs/2406.01234) — maybe relevant to D01 · high · added 2026-11-16
```

### A1. The user, on the page

Opens the item's reading note on the phone and writes a quote and a line of their own. The box saves itself: the file is made.

- Asked: `PUT /api/reading` `{"key": "arxiv:2406.01234", "text": "> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E02?", "version": "@read"}`
- Answered: 200
- Files: only these change

`Reading notes/arxiv-2406.01234.md`

```markdown
# Mixup at scale
<https://arxiv.org/abs/2406.01234>

## My reading

> The gain vanishes below 1k images (Sec. 4.2)

Same subset sizes as E02?
```

### A2. Claude, with `rft_inbox`

The user presses Process. If Claude asks for the reading note, the user's part is not given, whatever it holds.

- Asked: `rft_inbox {"link": "https://arxiv.org/abs/2406.01234", "reading": true}`
- The answer says: "No impression of Mixup at scale"
- The answer says: "The user's part of its reading note is closed to you"
- The answer never says: "gain vanishes"
- The answer never says: "subset sizes"
- Files: none changes

### A3. Claude, with `rft_inbox`

Claude reads the paper itself and saves its impression, then its brief. It says the brief in the chat and stops: no outcome is asked for.

- Asked: `rft_inbox {"link": "https://arxiv.org/abs/2406.01234", "impression": "### Claims\n\nMixup still improves top-1 accuracy at ViT-H sca…", "brief": "claims mixup still helps at ViT-H scale, most at 10% of the …"}`
- The answer says: "Impression saved on Mixup at scale"
- The answer says: "The user's part of the reading note stays closed until they mark the item as read."
- The answer says: "Brief saved on Mixup at scale"
- The answer never says: "gain vanishes"
- Files: only these change

`Inbox.md`

```markdown
# Inbox

- [Mixup at scale](https://arxiv.org/abs/2406.01234) — maybe relevant to D01 · high · added 2026-11-16
  - briefed {today}: claims mixup still helps at ViT-H scale, most at 10% of the labels
  - touches D01, E02
  - recommends: reference under D01
```

`Reading notes/arxiv-2406.01234.md`

```markdown
# Mixup at scale
<https://arxiv.org/abs/2406.01234>

## My reading

> The gain vanishes below 1k images (Sec. 4.2)

Same subset sizes as E02?

## Claude's impression ({today})

### Claims

Mixup still improves top-1 accuracy at ViT-H scale, and the gain grows as labelled data shrinks down to 10% of ImageNet.

### How

ViT-B/L/H trained on ImageNet subsets of 1%, 10% and 100%, with and without mixup, three seeds each.

### Key results

- +1.2 top-1 for ViT-H at 10% of the data (Table 3)
- no gain at 1% (Fig. 4)

### Bearing on

D01: the same question at larger scale. E02 uses the 10% subset.

### Left open

Whether the 1% result is the model or the schedule: only one schedule was tried.
```

### A4. The user, on the page

Reads on and adds a second quote, after Claude's impression was saved. No conflict: the impression is not the user's part and stays as it is.

- Asked: `PUT /api/reading` `{"key": "arxiv:2406.01234", "text": "> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E02?\n\n> We find mixup complementary to RandAugment at every scale (Table 3)", "version": "@read"}`
- Answered: 200
- Files: only these change

`Reading notes/arxiv-2406.01234.md`

```markdown
# Mixup at scale
<https://arxiv.org/abs/2406.01234>

## My reading

> The gain vanishes below 1k images (Sec. 4.2)

Same subset sizes as E02?

> We find mixup complementary to RandAugment at every scale (Table 3)

## Claude's impression ({today})

### Claims

Mixup still improves top-1 accuracy at ViT-H scale, and the gain grows as labelled data shrinks down to 10% of ImageNet.

### How

ViT-B/L/H trained on ImageNet subsets of 1%, 10% and 100%, with and without mixup, three seeds each.

### Key results

- +1.2 top-1 for ViT-H at 10% of the data (Table 3)
- no gain at 1% (Fig. 4)

### Bearing on

D01: the same question at larger scale. E02 uses the 10% subset.

### Left open

Whether the 1% result is the model or the schedule: only one schedule was tried.
```

### A5. The user, on the page

Marks the item as read, with a chat connected. The mark is saved on the item's line and the discussion is asked of the chat.

- Asked: `POST /api/inbox` `{"key": "arxiv:2406.01234", "action": "read", "read": true}`, a chat connected
- Answered: 200, with `{"asked": true, "waiting": []}`
- Files: only these change

`Inbox.md`

```markdown
# Inbox

- [Mixup at scale](https://arxiv.org/abs/2406.01234) — maybe relevant to D01 · high · added 2026-11-16 · read {today}
  - briefed {today}: claims mixup still helps at ViT-H scale, most at 10% of the labels
  - touches D01, E02
  - recommends: reference under D01
```

### A6. Claude, with `rft_inbox`

The discussion: Claude opens the reading note and is given the user's part for the first time, word for word, beside its own impression.

- Asked: `rft_inbox {"link": "https://arxiv.org/abs/2406.01234", "reading": true}`
- The answer says: "Your impression of Mixup at scale"
- The answer says: "### Key results"
- The answer says: "The user's part, marked as read {today}"
- The answer says: "> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E02?\n\n> We find mixup complementary to RandAugment at every scale (Table 3)"
- Files: none changes

### A7. Claude, with `rft_inbox`

A new impression now would be written after seeing the user's part: refused. The impression is frozen.

- Asked: `rft_inbox {"link": "https://arxiv.org/abs/2406.01234", "impression": "### Claims\n\nMixup helps at every model scale tried, most at …"}`
- The answer says: "Impression not saved"
- The answer says: "is frozen from then on"
- Files: none changes

### A8. Given

The user picks: reference, under D01. Claude writes the reference note R02, but paraphrases the second quote.


`references/R02 Mixup at scale.md`

```markdown
---
id: R02
type: reference
status: done
date: 2026-11-24
parent: "[[D01 A better variant]]"
children: []
tags: [demo, reference, done]
---

# R02 · Mixup at scale

**Parent:** [[D01 A better variant]]
**Status:** done · **Date:** 2026-11-24

## Source
Doe et al. 2024, Mixup at scale. https://arxiv.org/abs/2406.01234

## Summary
Mixup still helps at ViT-H scale, most at 10% of the labels; no gain at 1%.

## Quotes

> The gain vanishes below 1k images (Sec. 4.2)

> Mixup is found to complement RandAugment at all scales (Table 3)

## Relevance
Same subset sizes as E02?

## Children in the tree
```

### A9. Claude, with `rft_inbox`

Claude closes the item: refused, because a quote of the user's is not in R02 word for word.

- Asked: `rft_inbox {"link": "https://arxiv.org/abs/2406.01234", "outcome": "reference", "note": "R02"}`
- The answer says: "Not closed: 1 of the user's 2 quotes is not in R02 word for word, as quote lines (>)."
- The answer says: "> We find mixup complementary to RandAugment at every scale (Table 3)"
- Files: none changes

### A10. Given

Claude puts the quote in as the user wrote it. The user's own line was rephrased by Claude, proposed in the chat and accepted by the user.


`references/R02 Mixup at scale.md`

```markdown
---
id: R02
type: reference
status: done
date: 2026-11-24
parent: "[[D01 A better variant]]"
children: []
tags: [demo, reference, done]
---

# R02 · Mixup at scale

**Parent:** [[D01 A better variant]]
**Status:** done · **Date:** 2026-11-24

## Source
Doe et al. 2024, Mixup at scale. https://arxiv.org/abs/2406.01234

## Summary
Mixup still helps at ViT-H scale, most at 10% of the labels; no gain at 1%.

## Quotes

> The gain vanishes below 1k images (Sec. 4.2)

> We find mixup complementary to RandAugment at every scale (Table 3)

## Relevance
E02 uses the same 10% subset, so its numbers can be set beside Table 3; the 1k-image regime, where the paper finds no gain, is ours.

## Children in the tree
```

### A11. Claude, with `rft_inbox`

Claude closes the item. It leaves the inbox for one line under Processed, and its reading note is removed: what it held is in R02.

- Asked: `rft_inbox {"link": "https://arxiv.org/abs/2406.01234", "outcome": "reference", "note": "R02"}`
- The answer says: "Closed: Mixup at scale (https://arxiv.org/abs/2406.01234) → R02."
- The answer says: "Its reading note (Reading notes/arxiv-2406.01234.md) is removed: the user's quotes are in R02."
- Files: only these change

`Inbox.md`

```markdown
# Inbox

## Processed

- {today} [Mixup at scale](https://arxiv.org/abs/2406.01234) → R02
```

`Reading notes/arxiv-2406.01234.md`: removed

## B. Process with no reading note, then later

### B0. Given

The item is in the inbox. The user has not opened its reading note: there is no file.


`Inbox.md`

```markdown
# Inbox

- [Mixup at scale](https://arxiv.org/abs/2406.01234) — maybe relevant to D01 · high · added 2026-11-16
- https://example.org/blog/post — from Bea
```

### B1. Claude, with `rft_inbox`

The user presses Process. Claude reads the paper and saves its impression and its brief: the reading note is made, with the user's part empty.

- Asked: `rft_inbox {"link": "https://arxiv.org/abs/2406.01234", "impression": "### Claims\n\nMixup still improves top-1 accuracy at ViT-H sca…", "brief": "claims mixup still helps at ViT-H scale, most at 10% of the …"}`
- The answer says: "Impression saved on Mixup at scale"
- The answer says: "Brief saved on Mixup at scale"
- Files: only these change

`Inbox.md`

```markdown
# Inbox

- [Mixup at scale](https://arxiv.org/abs/2406.01234) — maybe relevant to D01 · high · added 2026-11-16
  - briefed {today}: claims mixup still helps at ViT-H scale, most at 10% of the labels
  - touches D01, E02
  - recommends: reference under D01
- https://example.org/blog/post — from Bea
```

`Reading notes/arxiv-2406.01234.md`

```markdown
# Mixup at scale
<https://arxiv.org/abs/2406.01234>

## My reading

## Claude's impression ({today})

### Claims

Mixup still improves top-1 accuracy at ViT-H scale, and the gain grows as labelled data shrinks down to 10% of ImageNet.

### How

ViT-B/L/H trained on ImageNet subsets of 1%, 10% and 100%, with and without mixup, three seeds each.

### Key results

- +1.2 top-1 for ViT-H at 10% of the data (Table 3)
- no gain at 1% (Fig. 4)

### Bearing on

D01: the same question at larger scale. E02 uses the 10% subset.

### Left open

Whether the 1% result is the model or the schedule: only one schedule was tried.
```

### B2. Claude, with `rft_inbox`

The user presses Process again, before any read mark: the impression is rewritten, from the paper alone.

- Asked: `rft_inbox {"link": "https://arxiv.org/abs/2406.01234", "impression": "### Claims\n\nMixup helps at every model scale tried, most at …"}`
- The answer says: "Impression saved on Mixup at scale"
- The answer says: "in place of the one of {today}"
- Files: only these change

`Reading notes/arxiv-2406.01234.md`

```markdown
# Mixup at scale
<https://arxiv.org/abs/2406.01234>

## My reading

## Claude's impression ({today})

### Claims

Mixup helps at every model scale tried, most at 10% of the labels; at 1% it does not help.

### How

ViT-B/L/H trained on ImageNet subsets of 1%, 10% and 100%, with and without mixup, three seeds each.

### Key results

- +1.2 top-1 for ViT-H at 10% of the data (Table 3)
- no gain at 1% (Fig. 4)

### Bearing on

D01: the same question at larger scale. E02 uses the 10% subset.

### Left open

Whether the 1% result is the model or the schedule: only one schedule was tried.
```

### B3. Claude, with `rft_inbox`

The user says: later. Nothing is closed and nothing is removed.

- Asked: `rft_inbox {"link": "https://arxiv.org/abs/2406.01234", "outcome": "later"}`
- The answer says: "Left in the inbox for later: Mixup at scale"
- The answer says: "Nothing closed."
- Files: none changes

### B4. The user, on the page

Days later, on the phone with no chat connected, the user marks the item as read. The mark is saved; the row says "waiting for chat connection"; nothing is queued.

- Asked: `POST /api/inbox` `{"key": "arxiv:2406.01234", "action": "read", "read": true}`, no chat connected
- Answered: 200, with `{"asked": false, "waiting": ["arxiv:2406.01234"]}`
- Files: only these change

`Inbox.md`

```markdown
# Inbox

- [Mixup at scale](https://arxiv.org/abs/2406.01234) — maybe relevant to D01 · high · added 2026-11-16 · read {today}
  - briefed {today}: claims mixup still helps at ViT-H scale, most at 10% of the labels
  - touches D01, E02
  - recommends: reference under D01
- https://example.org/blog/post — from Bea
```

### B5. The user, on the page

At the desk, with a chat connected, the user presses Discuss: the discussion is asked of the chat.

- Asked: `POST /api/inbox` `{"key": "arxiv:2406.01234", "action": "discuss"}`, a chat connected
- Answered: 200, with `{"asked": true}`
- Files: none changes

### B6. Claude, with `rft_inbox`

In the discussion the user says: later, again. The item, its reading note and its read mark all stay.

- Asked: `rft_inbox {"link": "https://arxiv.org/abs/2406.01234", "outcome": "later"}`
- The answer says: "Left in the inbox for later: Mixup at scale"
- Files: none changes

## C. A discard after quoting asks first

### C0. Given

The user has quoted from the paper; the item is not marked as read and has no impression.


`Inbox.md`

```markdown
# Inbox

- [Mixup at scale](https://arxiv.org/abs/2406.01234) — maybe relevant to D01 · high · added 2026-11-16
- https://example.org/blog/post — from Bea
```

`Reading notes/arxiv-2406.01234.md`

```markdown
# Mixup at scale
<https://arxiv.org/abs/2406.01234>

## My reading

> The gain vanishes below 1k images (Sec. 4.2)

Same subset sizes as E02?
```

### C1. The user, on the page

Taps ✕ on the item in the panel: refused, the panel asks first, because the reading note holds what they wrote.

- Asked: `POST /api/inbox` `{"key": "arxiv:2406.01234", "action": "discard"}`
- Answered: 409, with `{"holds": true}`
- Files: none changes

### C2. Claude, with `rft_inbox`

In the chat the user says to discard it. Claude closes with discard: refused, it must ask the user first.

- Asked: `rft_inbox {"link": "https://arxiv.org/abs/2406.01234", "outcome": "discard", "reason": "superseded by R01"}`
- The answer says: "Not closed: the user's part of the reading note of Mixup at scale"
- The answer says: "Ask the user first; once they say yes, close with confirmed: true."
- The answer never says: "gain vanishes"
- Files: none changes

### C3. Claude, with `rft_inbox`

The user says yes. Claude closes with the confirmation: the item goes under Processed with its reason, the reading note is removed.

- Asked: `rft_inbox {"link": "https://arxiv.org/abs/2406.01234", "outcome": "discard", "reason": "superseded by R01", "confirmed": true}`
- The answer says: "Closed: Mixup at scale (https://arxiv.org/abs/2406.01234) — discarded: superseded by R01."
- The answer says: "Its reading note (Reading notes/arxiv-2406.01234.md) is removed, with what the user had written in it."
- Files: only these change

`Inbox.md`

```markdown
# Inbox

- https://example.org/blog/post — from Bea

## Processed

- {today} [Mixup at scale](https://arxiv.org/abs/2406.01234) — discarded: superseded by R01
```

`Reading notes/arxiv-2406.01234.md`: removed

### C4. The user, on the page

Or, from step 2, on the panel: the user taps ✕ and confirms the question. The item goes under Processed as discarded, the reading note is removed.

- Asked: `POST /api/inbox` `{"key": "arxiv:2406.01234", "action": "discard", "confirm": true}`
- Answered: 200
- Files: only these change

`Inbox.md`

```markdown
# Inbox

- https://example.org/blog/post — from Bea

## Processed

- {today} [Mixup at scale](https://arxiv.org/abs/2406.01234) — discarded
```

`Reading notes/arxiv-2406.01234.md`: removed
