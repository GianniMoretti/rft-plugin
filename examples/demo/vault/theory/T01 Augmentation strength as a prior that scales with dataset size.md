---
id: T01
type: theory
status: running
date: 2026-03-22
summary: "Draft: an augmentation's magnitude acts as the width of a prior around each training image, and the best width shrinks with the dataset"
parent: "[[D08 Theory, augmentation as a data-dependent prior]]"
children: []
up: "[[D08 Theory, augmentation as a data-dependent prior]]"
down: []
tags: [small-data-regularisation, theory, augmentation, prior, running]
---

# T01 · Augmentation strength as a prior that scales with dataset size

**Parent:** [[D08 Theory, augmentation as a data-dependent prior]]  
**Status:** running · **Date:** 2026-03-22

## Statement
Training on augmented images is training on a smoothed copy of the training set. The magnitude sets the width of the smoothing around each image. Claim: below some dataset size, the magnitude with the lowest test error goes down as the dataset shrinks, because a wide smoothing leaves the data faster than it fills the gaps between samples.

## Builds on
- [[E07 RandAugment magnitude sweep with long training]]: magnitude 15 closes the gap at 5k and 10k images and not at 1k.
- [[E04 Distance of augmented samples to the training set]]: the distance to the source image grows linearly with magnitude (1k pending).
- [[R01 Cubuk 2019 RandAugment, no separate search phase]]: the strength may be tailored to model and dataset size.

## Explanation
With many images, neighbours are close and a wide smoothing mostly lands on other plausible images. With 1k images the neighbours are far apart, and the same width lands between classes.

## Open questions
- A width that can be compared across transformations (rotation against colour).
- Whether E04's feature-space distance is the right measure of it.

## Status
Draft. Waits for E04's results at 1k.

## Children in the tree
