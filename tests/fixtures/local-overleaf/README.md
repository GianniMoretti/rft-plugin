# The clean-source fixture

A small project whose vault holds one document, `paper`, as a co-author would see it in Overleaf,
and what every reader of that document must yield (`expected.json`). The tests of clean source
(`.scratch/local-overleaf`, step 1) rest on it.

Status: written by Claude on 2026-11-23 as a proposal, brought here on 2026-11-24 when the build
started. The user read `expected.json` on 2026-11-24 and confirmed it as it is.

## What is here

- `project/vault/documents/paper/`: the document. `main.tex`, `sections/method.tex`, `refs.bib`,
  `figures/loss.pdf`. It holds no trace of the tree and compiles from its folder alone.
- `project/vault/documents/.rft/paper/tracking.json`: what the plugin recorded when things were placed.
- `project/vault/`: what the tree holds now: five notes, six snippets (with their macros and ids),
  two saved results, one figure.
- `expected.json`: the copies with their states, where each snippet is used, the tracked values
  with their states, the `.bib` entries and where each came from, and the scan's result (nothing).
- `to_ts.py`: copies all of it to `tests/fixtures/local-overleaf.ts` for the plugin's tests.

## The cases

| Where | What | Expected |
|---|---|---|
| `main.tex`, introduction | "Labelled images are scarce…" (S05), markers deleted, text intact | found by its text; placed; markers missing |
| `main.tex`, introduction | Definition: CutMix (S01) | placed |
| `sections/method.tex` | Definition: CutMix (S01) again, reworded, no label | adapted |
| `sections/method.tex` | Method: Training setup (S04); the snippet now says 300 epochs | in review |
| `sections/method.tex` | Figure: Training loss (S03) | placed |
| `sections/method.tex` | Lemma: Mixing bound (S07); no such snippet in the vault | gone |
| `main.tex`, results | Result: CutMix at 1k images (S02) | placed, with one number in review |
| `main.tex`, discussion | Limitations (S06), markers deleted and text rewritten | lost |
| abstract | 73.2 (E05 acc.1k), outside any copy | current |
| results, in S02's copy | 73.2 (E05 acc.1k) | current |
| results, in S02's copy | 81.4 (E05 acc.full); the tree now says 81.6 | in review |
| `sections/method.tex` | "over 5 seeds"; written as 3, the tree says 3 | changed here, no longer the tree's |
| `refs.bib` | `yun2019cutmix` from R07; `zhang2018mixup` added by hand | the second is the user's own |

## Changed from the proposal

- The vault is a real one (notes, registries, `results/<id>.json` as a notebook's run writes it), so
  the plugin's own loaders read it.
- A tracked value is found by the text before and after it (`before`, `after`), not by one string.
- Citations are tracked per `.bib` entry (`bib`), not per occurrence.
- Each copy records its marker's words, so a copy whose snippet is gone or was retitled is still found.
