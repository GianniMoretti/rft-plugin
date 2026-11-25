---
id: R03
type: reference
status: done
date: 2026-03-18
summary: "mixup trains on convex combinations of pairs of examples and their labels; reported to reduce memorisation of corrupt labels"
parent: "[[D04 Mixup as an alternative]]"
children: []
up: "[[D04 Mixup as an alternative]]"
down: []
tags: [small-data-regularisation, reference, mixup, done]
---

# R03 · mixup, training on combinations of pairs of examples

**Parent:** [[D04 Mixup as an alternative]]  
**Status:** done · **Date:** 2026-03-18

## Source
Hongyi Zhang, Moustapha Cissé, Yann N. Dauphin, David Lopez-Paz. mixup: Beyond Empirical Risk Minimization. 2017 (ICLR camera-ready version). arXiv:1710.09412, https://arxiv.org/abs/1710.09412

## Summary
The network is trained on convex combinations of pairs of examples and of their labels.

## Method
Each training sample is a mix of two examples, and its label the same mix of their labels.

## Key results
From the abstract: mixup reduces the memorisation of corrupt labels and increases robustness to adversarial examples. No number is copied here.

## Relevance
It regularises without any geometric transformation, so it does not move a sample away from the data the way a strong magnitude does (D03). E05 tests it at 1k images.

## Directions found

## Children in the tree
