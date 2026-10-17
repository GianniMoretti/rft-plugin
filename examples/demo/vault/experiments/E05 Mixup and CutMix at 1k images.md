---
id: E05
type: experiment
status: done
date: 2026-03-20
parent: "[[D04 Mixup as an alternative]]"
children: ["[[D05 A schedule that needs no stopping]]", "[[D09 Self-supervised pretraining on the same images]]", "[[D10 Test on medical images]]"]
up: "[[D04 Mixup as an alternative]]"
down: ["[[D05 A schedule that needs no stopping]]", "[[D09 Self-supervised pretraining on the same images]]", "[[D10 Test on medical images]]"]
tags: [small-data-regularisation, experiment, mixup, cifar, done]
---

# E05 · Mixup and CutMix at 1k images

**Parent:** [[D04 Mixup as an alternative]]  
**Status:** done · **Date:** 2026-03-20

## What
Mixup alpha 0.2 and 1.0, CutMix; 200 epochs; 5 seeds.

## Result
CutMix closes the gap at 1k (0.3 ± 0.5 points); Mixup does not.

## Children in the tree
- [[D05 A schedule that needs no stopping]]
- [[D09 Self-supervised pretraining on the same images]]
- [[D10 Test on medical images]]
