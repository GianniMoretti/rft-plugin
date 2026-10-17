---
id: E02
type: experiment
status: done
date: 2026-03-08
parent: "[[D01 Baseline, early stopping vs long training]]"
children: ["[[D02 Strong augmentation closes the gap]]", "[[D06 Label smoothing instead of augmentation]]", "[[D07 Larger models overfit less]]"]
up: "[[D01 Baseline, early stopping vs long training]]"
down: ["[[D02 Strong augmentation closes the gap]]", "[[D06 Label smoothing instead of augmentation]]", "[[D07 Larger models overfit less]]"]
tags: [small-data-regularisation, experiment, baseline, cifar, done]
---

# E02 · Baseline on CIFAR-10 subsets of 1k, 5k and 10k images

**Parent:** [[D01 Baseline, early stopping vs long training]]  
**Status:** done · **Date:** 2026-03-08

## What
ResNet-18, 3 subset sizes, 5 seeds, early stopping vs 200 epochs.

## Result
Long training loses 4.1 ± 0.6 points at 1k images and 0.8 ± 0.3 at 10k.

## Children in the tree
- [[D02 Strong augmentation closes the gap]]
- [[D06 Label smoothing instead of augmentation]]
- [[D07 Larger models overfit less]]
