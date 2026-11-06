---
id: D02
type: direction
status: done
date: 2026-03-09
parent: "[[E02 Baseline on CIFAR-10 subsets of 1k, 5k and 10k images]]"
children: ["[[E07 RandAugment magnitude sweep with long training]]"]
up: "[[E02 Baseline on CIFAR-10 subsets of 1k, 5k and 10k images]]"
down: ["[[E07 RandAugment magnitude sweep with long training]]"]
tags: [small-data-regularisation, direction, augmentation, done]
concept: "Strong augmentation"
concept_summary: "Whether heavy augmentation alone closes the small-data gap"
---

# D02 · Strong augmentation closes the gap

**Parent:** [[E02 Baseline on CIFAR-10 subsets of 1k, 5k and 10k images]]  
**Status:** done · **Date:** 2026-03-09

## Idea
With RandAugment at high magnitude, long training should stop overfitting.

## Status
Tested in E07.

## Children in the tree
- [[E07 RandAugment magnitude sweep with long training]]
