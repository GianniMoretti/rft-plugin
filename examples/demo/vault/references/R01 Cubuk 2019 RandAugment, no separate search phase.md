---
id: R01
type: reference
status: done
date: 2026-03-04
summary: "RandAugment drops the separate search phase of learned augmentation; its strength can be set to the model and dataset size"
parent: "[[D02 Strong augmentation closes the gap]]"
children: []
up: "[[D02 Strong augmentation closes the gap]]"
down: []
tags: [small-data-regularisation, reference, augmentation, randaugment, done]
---

# R01 · Cubuk 2019 RandAugment, no separate search phase

**Parent:** [[D02 Strong augmentation closes the gap]]  
**Status:** done · **Date:** 2026-03-04

## Source
Ekin D. Cubuk, Barret Zoph, Jonathon Shlens, Quoc V. Le. RandAugment: Practical automated data augmentation with a reduced search space. 2019. arXiv:1909.13719, https://arxiv.org/abs/1909.13719

## Summary
Learned augmentation policies need a separate search phase, usually on a smaller proxy task. RandAugment has a much smaller search space, so it is trained on the target task directly, with no proxy task.

## Method
A reduced search space with an interpretable strength parameter, tuned on the task itself.

## Key results
From the abstract: the regularisation strength may be tailored to different model and dataset sizes. No number is copied here; the tables were not read for this note.

## Relevance
The one claim this project leans on is that the right strength changes with dataset size. The paper's datasets are far larger than our 1k to 10k subsets, so D02 and E07 test it where it was not measured.

## Directions found

## Children in the tree
