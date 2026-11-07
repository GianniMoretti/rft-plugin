---
type: index
---

# small-data-regularisation — the reasoning tree

One note per experiment (E..), direction (D..), reference (R..) and theory note (T..); each links
to its parent and lists its children. Legend: ✓ done · … running · → planned · ? idea · ✗ dropped · · discussed, not pursued · ↗ moved.

## The tree
- ✓ [[D00 Can strong augmentation replace early stopping on small datasets]]
    - ✓ [[E01 Literature check on augmentation and training length]]
        - ✓ [[D01 Baseline, early stopping vs long training]]
            - ✓ [[E02 Baseline on CIFAR-10 subsets of 1k, 5k and 10k images]]
                - ✓ [[D02 Strong augmentation closes the gap]]
                    - ✓ [[E07 RandAugment magnitude sweep with long training]]
                        - … [[D03 Why augmentation fails at 1k images]]
                            - … [[E04 Distance of augmented samples to the training set]]
                        - ✓ [[D04 Mixup as an alternative]]
                            - ✓ [[E05 Mixup and CutMix at 1k images]]
                                - → [[D05 A schedule that needs no stopping]]
                                    - → [[E06 CutMix with cosine schedule on three datasets]]
                                - ? [[D09 Self-supervised pretraining on the same images]]
                                - ↗ [[D10 Test on medical images]]
                        - ? [[D08 Theory, augmentation as a data-dependent prior]]
                - ✗ [[D06 Label smoothing instead of augmentation]]
                - · [[D07 Larger models overfit less]]

## How to keep it up to date
The rft plugin maintains this list, the canvas and the children / up / down fields from the
`parent:` field of every note: create and update notes with its tools (rft_add_node,
rft_set_status), or edit notes by hand and run rft_sync.

## Elsewhere
Code, results, reports, related notes.
