# Agents: what an agent's answer becomes, case by case

Written from tests/fixtures/agents/cases.json by to_ts.py: edit that file, not this one.

Claude proposed these cases on 2026-11-25; the user has not read them yet.

An agent answers with text and the app writes it. Each case gives the answer as it came and what
must be in the vault afterwards. Both sides are held to them: the page's server
(tests/test_agents.py) and the plugin (tests/agents.test.ts).

## A thread

Every thread is on the sentence `Text of E02.` of the note E02.
The note itself is never changed by an answer: a new text waits for the user to accept it.

### T1. a comment thread: the answer is the reply, without the blanks around it

The thread is a comment. The agent answers:

```
  Yes: 5 seeds, see the table.
```

- The thread's new text: unchanged
- Added to the thread: `"Yes: 5 seeds, see the table."`

### T2. a suggestion: the new text between the tags, then why

The thread is a suggestion with no new text yet. The agent answers:

```
<replacement>
Text of E02, over 5 seeds.
</replacement>
The note gave no seed count.
```

- The thread's new text: `"Text of E02, over 5 seeds."`, for the user to accept or reject
- Added to the thread: `"The note gave no seed count."`

### T3. a suggestion: the new text alone, no message added

The thread is a suggestion with no new text yet. The agent answers:

```
<replacement>Text of E02, over 5 seeds.</replacement>
```

- The thread's new text: `"Text of E02, over 5 seeds."`, for the user to accept or reject
- Added to the thread: no message

### T4. a suggestion the agent finds unclear: no tags, so a reply and no new text

The thread is a suggestion with no new text yet. The agent answers:

```
Which seeds do you mean? E02 ran one.
```

- The thread's new text: unchanged
- Added to the thread: `"Which seeds do you mean? E02 ran one."`

### T5. the tag left open: a reply holding the text as it came, never a replacement

The thread is a suggestion with no new text yet. The agent answers:

```
<replacement>
Text of E02, over 5 seeds.
```

- The thread's new text: unchanged
- Added to the thread: `"<replacement>\nText of E02, over 5 seeds."`

### T6. the closing tag misspelt: a reply, never a replacement

The thread is a suggestion with no new text yet. The agent answers:

```
<replacement>Text of E02, over 5 seeds.</replace>
Why.
```

- The thread's new text: unchanged
- Added to the thread: `"<replacement>Text of E02, over 5 seeds.</replace>\nWhy."`

### T7. two replacements: the first is the new text, the rest stays in the message

The thread is a suggestion with no new text yet. The agent answers:

```
<replacement>First.</replacement>
or
<replacement>Second.</replacement>
```

- The thread's new text: `"First."`, for the user to accept or reject
- Added to the thread: `"or\n<replacement>Second.</replacement>"`

### T8. a replacement on a comment thread: it goes into the reply

The thread is a comment. The agent answers:

```
It should say the seeds.
<replacement>Text of E02, over 5 seeds.</replacement>
```

- The thread's new text: unchanged
- Added to the thread: `"It should say the seeds.\n\nText of E02, over 5 seeds."`

### T9. the quoted text is no longer in the note: the new text goes into the reply

The thread is a suggestion with no new text yet. The agent answers:

```
<replacement>New.</replacement>
Why.
```

- The thread's new text: unchanged
- Added to the thread: `"Why.\n\nNew."`

### T10. the new text is the quoted text itself: a reply

The thread is a suggestion with no new text yet. The agent answers:

```
<replacement>Text of E02.</replacement>
It is fine as it is.
```

- The thread's new text: unchanged
- Added to the thread: `"It is fine as it is.\n\nText of E02."`

### T11. a suggestion that had the user's new text: the agent's takes its place

The thread is a suggestion with the new text `Text of E02 (5 seeds).`. The agent answers:

```
<replacement>Text of E02, over 5 seeds.</replacement>
Adapted to the sentence.
```

- The thread's new text: `"Text of E02, over 5 seeds."`, for the user to accept or reject
- Added to the thread: `"Adapted to the sentence."`

### T12. line endings of another system in the new text: written with the note's

The thread is a suggestion with no new text yet. The agent answers:

```
<replacement>Text of E02,␍
over 5 seeds.</replacement>
```

- The thread's new text: `"Text of E02,\nover 5 seeds."`, for the user to accept or reject
- Added to the thread: no message

### T13. a thread the user closed meanwhile: nothing is written

The thread is a comment, resolved. The agent answers:

```
Yes.
```

Nothing is written, and the page says the thread was not answered.

## Process

The agent is asked for its impression between `<impression>` and `</impression>` and its brief
between `<brief>` and `</brief>`, or for `<unreadable>why</unreadable>` when it could not read the item.
Either both are saved or nothing is.

### P1. the impression's five parts and the brief's three lines

The agent answers:

```
<impression>
### Claims

Mixup still helps at ViT-H scale.

### How

ViT-H on ImageNet-21k subsets of 1k to 1M images.

### Key results

+1.2 top-1 at 100k images (Table 2); no gain below 1k (Sec. 4.2).

### Bearing on

E05 uses the same subset sizes; D04 assumes the gain holds at every size.

### Left open

Whether the gain survives longer schedules.
</impression>
<brief>
Mixup helps ViT-H above 1k images, not below.
Touches E05 and D04.
Recommends: reference under D04.
</brief>
```

Saved as the impression, in the item's reading note:

```
### Claims

Mixup still helps at ViT-H scale.

### How

ViT-H on ImageNet-21k subsets of 1k to 1M images.

### Key results

+1.2 top-1 at 100k images (Table 2); no gain below 1k (Sec. 4.2).

### Bearing on

E05 uses the same subset sizes; D04 assumes the gain holds at every size.

### Left open

Whether the gain survives longer schedules.
```

Saved as the brief, under the item in the inbox:

```
Mixup helps ViT-H above 1k images, not below.
Touches E05 and D04.
Recommends: reference under D04.
```

### P2. words around the two blocks are dropped

The agent answers:

```
Here is my reading.

<impression>
### Claims

Mixup still helps at ViT-H scale.

### How

ViT-H on ImageNet-21k subsets of 1k to 1M images.

### Key results

+1.2 top-1 at 100k images (Table 2); no gain below 1k (Sec. 4.2).

### Bearing on

E05 uses the same subset sizes; D04 assumes the gain holds at every size.

### Left open

Whether the gain survives longer schedules.
</impression>
<brief>
Mixup helps ViT-H above 1k images, not below.
Touches E05 and D04.
Recommends: reference under D04.
</brief>

Let me know.
```

Saved as the impression, in the item's reading note:

```
### Claims

Mixup still helps at ViT-H scale.

### How

ViT-H on ImageNet-21k subsets of 1k to 1M images.

### Key results

+1.2 top-1 at 100k images (Table 2); no gain below 1k (Sec. 4.2).

### Bearing on

E05 uses the same subset sizes; D04 assumes the gain holds at every size.

### Left open

Whether the gain survives longer schedules.
```

Saved as the brief, under the item in the inbox:

```
Mixup helps ViT-H above 1k images, not below.
Touches E05 and D04.
Recommends: reference under D04.
```

### P3. the brief as a list, and headings of another level

The agent answers:

```
<impression>
## Claims

Mixup still helps at ViT-H scale.

## How

ViT-H on ImageNet-21k subsets of 1k to 1M images.

## Key results

+1.2 top-1 at 100k images (Table 2); no gain below 1k (Sec. 4.2).

## Bearing on

E05 uses the same subset sizes; D04 assumes the gain holds at every size.

## Left open

Whether the gain survives longer schedules.
</impression>
<brief>
- Mixup helps ViT-H above 1k images, not below.
- Touches E05 and D04.
- Recommends: reference under D04.
</brief>
```

Saved as the impression, in the item's reading note:

```
### Claims

Mixup still helps at ViT-H scale.

### How

ViT-H on ImageNet-21k subsets of 1k to 1M images.

### Key results

+1.2 top-1 at 100k images (Table 2); no gain below 1k (Sec. 4.2).

### Bearing on

E05 uses the same subset sizes; D04 assumes the gain holds at every size.

### Left open

Whether the gain survives longer schedules.
```

Saved as the brief, under the item in the inbox:

```
Mixup helps ViT-H above 1k images, not below.
Touches E05 and D04.
Recommends: reference under D04.
```

### P4. a brief of two lines: nothing is saved

The agent answers:

```
<impression>
### Claims

Mixup still helps at ViT-H scale.

### How

ViT-H on ImageNet-21k subsets of 1k to 1M images.

### Key results

+1.2 top-1 at 100k images (Table 2); no gain below 1k (Sec. 4.2).

### Bearing on

E05 uses the same subset sizes; D04 assumes the gain holds at every size.

### Left open

Whether the gain survives longer schedules.
</impression>
<brief>
Mixup helps ViT-H above 1k images, not below.
Touches E05 and D04.
</brief>
```

Nothing is saved. The item shows why, in words that hold: `three lines`

### P5. a brief of four lines: nothing is saved

The agent answers:

```
<impression>
### Claims

Mixup still helps at ViT-H scale.

### How

ViT-H on ImageNet-21k subsets of 1k to 1M images.

### Key results

+1.2 top-1 at 100k images (Table 2); no gain below 1k (Sec. 4.2).

### Bearing on

E05 uses the same subset sizes; D04 assumes the gain holds at every size.

### Left open

Whether the gain survives longer schedules.
</impression>
<brief>
Mixup helps ViT-H above 1k images, not below.
Touches E05 and D04.
Recommends: reference under D04.
And one more.
</brief>
```

Nothing is saved. The item shows why, in words that hold: `three lines`

### P6. no brief at all: nothing is saved

The agent answers:

```
<impression>
### Claims

Mixup still helps at ViT-H scale.

### How

ViT-H on ImageNet-21k subsets of 1k to 1M images.

### Key results

+1.2 top-1 at 100k images (Table 2); no gain below 1k (Sec. 4.2).

### Bearing on

E05 uses the same subset sizes; D04 assumes the gain holds at every size.

### Left open

Whether the gain survives longer schedules.
</impression>
```

Nothing is saved. The item shows why, in words that hold: `no brief`

### P7. no impression: nothing is saved

The agent answers:

```
<brief>
Mixup helps ViT-H above 1k images, not below.
Touches E05 and D04.
Recommends: reference under D04.
</brief>
```

Nothing is saved. The item shows why, in words that hold: `no impression`

### P8. an impression with a part missing: nothing is saved

The agent answers:

```
<impression>
### Claims

Mixup still helps at ViT-H scale.

### How

ViT-H on ImageNet-21k subsets of 1k to 1M images.

### Key results

+1.2 top-1 at 100k images (Table 2); no gain below 1k (Sec. 4.2).

### Bearing on

E05 uses the same subset sizes; D04 assumes the gain holds at every size.
</impression>
<brief>
Mixup helps ViT-H above 1k images, not below.
Touches E05 and D04.
Recommends: reference under D04.
</brief>
```

Nothing is saved. The item shows why, in words that hold: `Left open`

### P9. an impression longer than a screen: nothing is saved

The agent answers:

```
<impression>
### Claims

Mixup still helps at ViT-H scale.

### How

ViT-H on ImageNet-21k subsets of 1k to 1M images.

### Key results

+1.2 top-1 at 100k images (Table 2); no gain below 1k (Sec. 4.2).

### Bearing on

E05 uses the same subset sizes; D04 assumes the gain holds at every size.

### Left open

Whether the gain survives longer schedules.
More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. More. 
… (4085 characters in all)
```

Nothing is saved. The item shows why, in words that hold: `3000`

### P10. the impression's block left open: nothing is saved

The agent answers:

```
<impression>
### Claims

Mixup still helps at ViT-H scale.

### How

ViT-H on ImageNet-21k subsets of 1k to 1M images.

### Key results

+1.2 top-1 at 100k images (Table 2); no gain below 1k (Sec. 4.2).

### Bearing on

E05 uses the same subset sizes; D04 assumes the gain holds at every size.

### Left open

Whether the gain survives longer schedules.
<brief>
Mixup helps ViT-H above 1k images, not below.
Touches E05 and D04.
Recommends: reference under D04.
</brief>
```

Nothing is saved. The item shows why, in words that hold: `no impression`

### P11. the item could not be read: the agent's reason is the failure, nothing is saved

The agent answers:

```
<unreadable>The page asks for a login.</unreadable>
```

Nothing is saved. The item shows why, in words that hold: `The page asks for a login.`

### P12. unreadable and an impression together: the agent said it could not read it, nothing is saved

The agent answers:

```
<unreadable>Paywall.</unreadable>
<impression>
### Claims

Mixup still helps at ViT-H scale.

### How

ViT-H on ImageNet-21k subsets of 1k to 1M images.

### Key results

+1.2 top-1 at 100k images (Table 2); no gain below 1k (Sec. 4.2).

### Bearing on

E05 uses the same subset sizes; D04 assumes the gain holds at every size.

### Left open

Whether the gain survives longer schedules.
</impression>
<brief>
Mixup helps ViT-H above 1k images, not below.
Touches E05 and D04.
Recommends: reference under D04.
</brief>
```

Nothing is saved. The item shows why, in words that hold: `Paywall.`

### P13. plain text with no block: nothing is saved

The agent answers:

```
The paper claims that mixup helps.
```

Nothing is saved. The item shows why, in words that hold: `no impression`
