---
id: E03
type: experiment
status: done
date: 2026-03-14
parent: "[[D02 Strong augmentation closes the gap]]"
children: ["[[D03 Why augmentation fails at 1k images]]", "[[D04 Mixup as an alternative]]", "[[D08 Theory, augmentation as a data-dependent prior]]"]
up: "[[D02 Strong augmentation closes the gap]]"
down: ["[[D03 Why augmentation fails at 1k images]]", "[[D04 Mixup as an alternative]]", "[[D08 Theory, augmentation as a data-dependent prior]]"]
tags: [small-data-regularisation, experiment, augmentation, cifar, done]
---

# E03 · RandAugment magnitude sweep with long training

**Parent:** [[D02 Strong augmentation closes the gap]]  
**Status:** done · **Date:** 2026-03-14

## What
Magnitude 5, 9, 15; 200 epochs; 5 seeds per size.

## Result
At magnitude 15 the gap closes at 5k and 10k images, but not at 1k (still 1.9 ± 0.7 points).

## Children in the tree
- [[D03 Why augmentation fails at 1k images]]
- [[D04 Mixup as an alternative]]
- [[D08 Theory, augmentation as a data-dependent prior]]
