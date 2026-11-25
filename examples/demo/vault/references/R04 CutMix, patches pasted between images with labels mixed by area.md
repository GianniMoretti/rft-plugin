---
id: R04
type: reference
status: done
date: 2026-03-18
summary: "CutMix pastes patches between training images and mixes the labels by patch area; reported to beat other augmentation strategies on CIFAR and ImageNet"
parent: "[[D04 Mixup as an alternative]]"
children: []
up: "[[D04 Mixup as an alternative]]"
down: []
tags: [small-data-regularisation, reference, cutmix, done]
---

# R04 · CutMix, patches pasted between images with labels mixed by area

**Parent:** [[D04 Mixup as an alternative]]  
**Status:** done · **Date:** 2026-03-18

## Source
Sangdoo Yun, Dongyoon Han, Seong Joon Oh, Sanghyuk Chun, Junsuk Choe, Youngjoon Yoo. CutMix: Regularization Strategy to Train Strong Classifiers with Localizable Features. ICCV 2019 (oral). arXiv:1905.04899, https://arxiv.org/abs/1905.04899

## Summary
Patches are cut and pasted among training images, and the labels are mixed in proportion to the area of the patches.

## Method
A patch of one image replaces a region of another; the label is weighted by the share of each image's area.

## Key results
From the abstract: it consistently outperforms state-of-the-art augmentation strategies on CIFAR and ImageNet classification, and on ImageNet weakly supervised localisation. No number is copied here.

## Relevance
The mix-based method that E05 found to close the gap at 1k images, where mixup did not. E06 carries it to three datasets.

## Directions found

## Children in the tree
