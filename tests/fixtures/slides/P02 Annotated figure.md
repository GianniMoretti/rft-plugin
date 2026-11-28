---
id: P02
type: deck
locked: false
---

# Boxes and lines

Written by hand: tests/test_slides.py measures where they are drawn

---

<!-- slide layout="figure" -->

## Accuracy holds at 1k images

![[E08_loss.svg]]

Three seeds, mean and spread

<!-- box x="1300" y="330" w="420" color="contrast" size="40" -->
gap closes here
<!-- /box -->

<!-- box shape="ellipse" x="1104" y="638" w="160" h="120" outline="contrast" weight="medium" -->
<!-- /box -->

<!-- line from="1330 410" to="1246 648" arrow="end" outline="contrast" -->

note: say why 1k and not 10k

---

## A diagram, typed

<!-- box x="140" y="260" w="360" h="160" fill="fill" outline="accent" align="center" valign="middle" -->
**Encoder**
<!-- /box -->

<!-- box x="780" y="260" w="360" h="160" fill="fill" outline="accent" align="center" valign="middle" -->
**Bottleneck**
<!-- /box -->

<!-- box x="1420" y="260" w="360" h="160" fill="fill" outline="accent" align="center" valign="middle" -->
**Decoder**
<!-- /box -->

<!-- line from="500 340" to="780 340" arrow="end" -->
<!-- line from="1140 340" to="1420 340" arrow="end" -->

<!-- box x="140" y="540" w="560" outline="grid" weight="thin" -->
![[E08_loss.svg]]
<!-- /box -->

<!-- box shape="ellipse" x="800" y="600" w="360" h="220" fill="c3" color="#ffffff" size="36" align="center" valign="middle" -->
a filled ellipse
<!-- /box -->

<!-- line from="1260 620" to="1720 860" arrow="both" outline="contrast" weight="thick" -->
<!-- line from="1260 860" to="1720 620" outline="muted" weight="thin" -->
