---
id: E07
type: experiment
status: done
date: 2026-03-14
parent: "[[D02 Strong augmentation closes the gap]]"
children: ["[[D03 Why augmentation fails at 1k images]]", "[[D04 Mixup as an alternative]]", "[[D08 Theory, augmentation as a data-dependent prior]]"]
up: "[[D02 Strong augmentation closes the gap]]"
down: ["[[D03 Why augmentation fails at 1k images]]", "[[D04 Mixup as an alternative]]", "[[D08 Theory, augmentation as a data-dependent prior]]"]
tags: [small-data-regularisation, experiment, augmentation, cifar, done]
---

# E07 · RandAugment magnitude sweep with long training

**Parent:** [[D02 Strong augmentation closes the gap]]  
**Status:** done · **Date:** 2026-03-14  
**Code / data:** commit, script, results folder, machine

## What
Magnitude 5, 9, 15; 200 epochs; 5 seeds per size.

## Why

## Result
At magnitude 15 the gap closes at 5k and 10k images, but not at 1k (still 1.9 ± 0.7 points).

## Directions found

## Children in the tree
- [[D03 Why augmentation fails at 1k images]]
- [[D04 Mixup as an alternative]]
- [[D08 Theory, augmentation as a data-dependent prior]]
