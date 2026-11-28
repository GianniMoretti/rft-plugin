---
id: R02
type: reference
status: done
date: 2026-03-04
summary: "TrivialAugment applies a single augmentation per image with no parameter to tune, and is reported to outperform earlier methods"
parent: "[[D02 Strong augmentation closes the gap]]"
children: []
up: "[[D02 Strong augmentation closes the gap]]"
down: []
tags: [small-data-regularisation, reference, augmentation, trivialaugment, done]
---

# R02 · Müller 2021 TrivialAugment, nothing to tune

**Parent:** [[D02 Strong augmentation closes the gap]]  
**Status:** done · **Date:** 2026-03-04

## Source
Samuel G. Müller, Frank Hutter. TrivialAugment: Tuning-free Yet State-of-the-Art Data Augmentation. ICCV 2021 (oral). arXiv:2103.10158, https://arxiv.org/abs/2103.10158

## Summary
An augmentation method with no parameters: each image gets a single augmentation.

## Method
One augmentation per image, nothing searched and nothing tuned.

## Key results
From the abstract: it outperforms previous methods at almost no cost. No number is copied here.

## Relevance
A control for E07: if a method with nothing to tune does as well as the magnitude sweep, the sweep's best magnitude says little about dataset size.

## Directions found

## Children in the tree
