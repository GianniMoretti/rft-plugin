// Copied from tests/fixtures/reading-note/ by tests/fixtures/reading-note/to_ts.py: edit those files, then run it.
export const CASES = {
 "names": [
  [
   "arxiv:2406.01234",
   "Mixup at scale",
   "arxiv-2406.01234.md",
   "arxiv-2406.01234-2.md",
   "Mixup at scale"
  ],
  [
   "arxiv:hep-th/9901001",
   "",
   "arxiv-hep-th-9901001.md",
   "arxiv-hep-th-9901001-2.md",
   "arXiv hep-th/9901001"
  ],
  [
   "doi:10.1007/s11263-021-01453-z",
   "",
   "doi-10.1007-s11263-021-01453-z.md",
   "doi-10.1007-s11263-021-01453-z-2.md",
   "doi 10.1007/s11263-021-01453-z"
  ],
  [
   "https://lilianweng.github.io/posts/2021-05-31-contrastive",
   "",
   "lilianweng.github.io-posts-2021-05-31-contrastive.md",
   "lilianweng.github.io-posts-2021-05-31-contrastive-2.md",
   "lilianweng.github.io/posts/2021-05-31-contrastive"
  ],
  [
   "https://openreview.net/forum?id=abc123",
   "  Video  MAE v3 ",
   "openreview.net-forum-id-abc123.md",
   "openreview.net-forum-id-abc123-2.md",
   "Video MAE v3"
  ],
  [
   "http://example.org/a/../../etc/passwd?q=\u00fc&x=1",
   "",
   "example.org-a-..-..-etc-passwd-q-x-1.md",
   "example.org-a-..-..-etc-passwd-q-x-1-2.md",
   "example.org/a/../../etc/passwd?q=\u00fc&x=1"
  ],
  [
   "https://example.org/a.",
   "",
   "example.org-a.md",
   "example.org-a-2.md",
   "example.org/a."
  ],
  [
   "https://\u00fc\u00fc",
   "",
   "item.md",
   "item-2.md",
   "\u00fc\u00fc"
  ],
  [
   "https://example.org/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
   "",
   "example.org-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.md",
   "example.org-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx-2.md",
   "example.org/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  ]
 ],
 "reads": [
  {
   "name": "the two parts under their headings",
   "text": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "key": "arxiv:2406.01234",
   "mine": "> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?",
   "impression": {
    "date": "2026-11-24",
    "text": "### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images."
   }
  },
  {
   "name": "no impression yet",
   "text": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n",
   "key": "arxiv:2406.01234",
   "mine": "> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?",
   "impression": null
  },
  {
   "name": "the file's endings do not change what it holds",
   "text": "# Mixup at scale\r\n<https://arxiv.org/abs/2406.01234>\r\n\r\n## My reading\r\n\r\n> The gain vanishes below 1k images (Sec. 4.2)\r\n\r\nSame subset sizes as E05?\r\n\r\n## Claude's impression (2026-11-24)\r\n\r\n### Claims\r\n\r\nMixup still helps at ViT-H scale.\r\n\r\n### How\r\n\r\nViT-H on ImageNet-21k subsets.\r\n\r\n### Key results\r\n\r\n+1.2 top-1 at 10% of the data (Table 3).\r\n\r\n### Bearing on\r\n\r\nD04, E05: same subset sizes.\r\n\r\n### Left open\r\n\r\nNothing below 1k images.\r\n",
   "key": "arxiv:2406.01234",
   "mine": "> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?",
   "impression": {
    "date": "2026-11-24",
    "text": "### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images."
   }
  },
  {
   "name": "the user's part keeps its own headings; a second My reading is theirs",
   "text": "# T\n<https://a.org/x>\n\n## My reading\n\n### Section 3\n\n> a quote\n\n## My reading\n\nagain\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "key": "https://a.org/x",
   "mine": "### Section 3\n\n> a quote\n\n## My reading\n\nagain",
   "impression": {
    "date": "2026-11-24",
    "text": "### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images."
   }
  },
  {
   "name": "a file made by hand, with no heading: no part of either",
   "text": "https://a.org/x\n\nsome lines of mine\n",
   "key": "https://a.org/x",
   "mine": "",
   "impression": null
  },
  {
   "name": "the impression's heading as Obsidian may retype it, with no day",
   "text": "# T\n<https://a.org/x>\n\n## my reading\n\nmine\n\n##  Claude\u2019s Impression  \n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.",
   "key": "https://a.org/x",
   "mine": "mine",
   "impression": {
    "date": "",
    "text": "### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images."
   }
  },
  {
   "name": "two impression headings: the last one starts the impression",
   "text": "# T\n<https://a.org/x>\n\n## My reading\n\nmine\n\n## Claude's impression (2026-11-20)\n\nold\n\n## Claude's impression (2026-11-24)\n\nnew\n",
   "key": "https://a.org/x",
   "mine": "mine\n\n## Claude's impression (2026-11-20)\n\nold",
   "impression": {
    "date": "2026-11-24",
    "text": "new"
   }
  },
  {
   "name": "an empty file",
   "text": "",
   "key": null,
   "mine": "",
   "impression": null
  },
  {
   "name": "an impression and no part of the user's",
   "text": "# T\n[T](https://arxiv.org/pdf/2406.01234v2)\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "key": "arxiv:2406.01234",
   "mine": "",
   "impression": {
    "date": "2026-11-24",
    "text": "### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images."
   }
  },
  {
   "name": "no link in its head: of no item",
   "text": "# T\n\n## My reading\n\nhttps://a.org/x is in my part, not the head\n",
   "key": null,
   "mine": "https://a.org/x is in my part, not the head",
   "impression": null
  },
  {
   "name": "blank lines around a part are not the part's",
   "text": "# T\n<https://a.org/x>\n## My reading\n\n\n  \nmine  \n\n\n## Claude's impression (2026-11-24)\n\n\nimp\n\n\n",
   "key": "https://a.org/x",
   "mine": "mine  ",
   "impression": {
    "date": "2026-11-24",
    "text": "imp"
   }
  },
  {
   "name": "a heading that only looks like one",
   "text": "# T\n<https://a.org/x>\n\n## My reading notes\n\n### My reading\n\n## Claude's impression of it\n",
   "key": "https://a.org/x",
   "mine": "",
   "impression": null
  }
 ],
 "mine": [
  {
   "name": "no file yet: the head, then the part",
   "text": null,
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "mine": "> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?",
   "want": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n",
   "changed": true
  },
  {
   "name": "no file yet, an item with no title",
   "text": null,
   "item": {
    "key": "https://a.org/x",
    "url": "https://a.org/x/#top",
    "title": ""
   },
   "mine": "one line\n",
   "want": "# a.org/x\n<https://a.org/x/#top>\n\n## My reading\n\none line\n",
   "changed": true
  },
  {
   "name": "in place of what the part held; the impression as it was",
   "text": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "mine": "> another quote\n> on two lines\n\nmine",
   "want": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> another quote\n> on two lines\n\nmine\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "changed": true
  },
  {
   "name": "the part emptied: its heading stays",
   "text": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "mine": "  \n\n",
   "want": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "changed": true
  },
  {
   "name": "the same text: the file as it was, its own spacing too",
   "text": "# T\n<https://a.org/x>\n## My reading\n\n\nmine\n\n\n\n## Claude's impression (2026-11-24)\nimp",
   "item": {
    "key": "https://a.org/x",
    "url": "https://a.org/x/#top",
    "title": ""
   },
   "mine": "\nmine\n\n",
   "want": "# T\n<https://a.org/x>\n## My reading\n\n\nmine\n\n\n\n## Claude's impression (2026-11-24)\nimp",
   "changed": false
  },
  {
   "name": "a file with the impression alone: the part goes before it",
   "text": "# T\n<https://a.org/x>\n\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "item": {
    "key": "https://a.org/x",
    "url": "https://a.org/x/#top",
    "title": ""
   },
   "mine": "mine",
   "want": "# T\n<https://a.org/x>\n\n## My reading\n\nmine\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "changed": true
  },
  {
   "name": "the file's endings are kept",
   "text": "# Mixup at scale\r\n<https://arxiv.org/abs/2406.01234>\r\n\r\n## My reading\r\n\r\n> The gain vanishes below 1k images (Sec. 4.2)\r\n\r\nSame subset sizes as E05?\r\n\r\n## Claude's impression (2026-11-24)\r\n\r\n### Claims\r\n\r\nMixup still helps at ViT-H scale.\r\n\r\n### How\r\n\r\nViT-H on ImageNet-21k subsets.\r\n\r\n### Key results\r\n\r\n+1.2 top-1 at 10% of the data (Table 3).\r\n\r\n### Bearing on\r\n\r\nD04, E05: same subset sizes.\r\n\r\n### Left open\r\n\r\nNothing below 1k images.\r\n",
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "mine": "line one\r\nline two",
   "want": "# Mixup at scale\r\n<https://arxiv.org/abs/2406.01234>\r\n\r\n## My reading\r\n\r\nline one\r\nline two\r\n\r\n## Claude's impression (2026-11-24)\r\n\r\n### Claims\r\n\r\nMixup still helps at ViT-H scale.\r\n\r\n### How\r\n\r\nViT-H on ImageNet-21k subsets.\r\n\r\n### Key results\r\n\r\n+1.2 top-1 at 10% of the data (Table 3).\r\n\r\n### Bearing on\r\n\r\nD04, E05: same subset sizes.\r\n\r\n### Left open\r\n\r\nNothing below 1k images.\r\n",
   "changed": true
  },
  {
   "name": "a file made by hand with no heading and no last newline: the part at its end",
   "text": "https://a.org/x\n\nsome lines of mine",
   "item": {
    "key": "https://a.org/x",
    "url": "https://a.org/x/#top",
    "title": ""
   },
   "mine": "> q",
   "want": "https://a.org/x\n\nsome lines of mine\n\n## My reading\n\n> q\n",
   "changed": true
  },
  {
   "name": "an empty file",
   "text": "",
   "item": {
    "key": "https://a.org/x",
    "url": "https://a.org/x/#top",
    "title": ""
   },
   "mine": "mine",
   "want": "## My reading\n\nmine\n",
   "changed": true
  },
  {
   "name": "an impression saved first, the part empty: filled in its place",
   "text": "# T\n<https://a.org/x>\n\n## My reading\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "item": {
    "key": "https://a.org/x",
    "url": "https://a.org/x/#top",
    "title": ""
   },
   "mine": "> q\n\nmine",
   "want": "# T\n<https://a.org/x>\n\n## My reading\n\n> q\n\nmine\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "changed": true
  },
  {
   "name": "spaces at a line's end and blank lines inside are the user's",
   "text": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "mine": "> q  \n\n\n\tindented\n",
   "want": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> q  \n\n\n\tindented\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "changed": true
  },
  {
   "name": "a heading of the user's own in their part, My reading among them, is theirs",
   "text": "# T\n<https://a.org/x>\n\n## My reading\n\n### Section 3\n\n> a quote\n\n## My reading\n\nagain\n",
   "item": {
    "key": "https://a.org/x",
    "url": "https://a.org/x/#top",
    "title": ""
   },
   "mine": "### Section 3\n\n> a quote\n\n## My reading\n\nagain",
   "want": "# T\n<https://a.org/x>\n\n## My reading\n\n### Section 3\n\n> a quote\n\n## My reading\n\nagain\n",
   "changed": false
  },
  {
   "name": "a line that reads as the heading of Claude's part is refused",
   "text": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "mine": "mine\n## Claude's impression\nnot his",
   "error": true
  },
  {
   "name": "so is one with a day",
   "text": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "mine": "##  claude\u2019s impression (2026-11-24) ",
   "error": true
  }
 ],
 "impressions": [
  {
   "name": "no file yet: the head, the user's part empty, the impression",
   "text": null,
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "impression": "### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.",
   "today": "2026-11-24",
   "want": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n"
  },
  {
   "name": "after the user's part, which stays as it was",
   "text": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n",
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "impression": "### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.",
   "today": "2026-11-24",
   "want": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n"
  },
  {
   "name": "in place of the impression it had, with the new day",
   "text": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "impression": "### Claims\n\nA second reading.\n\n### How\n\nh\n\n### Key results\n\n- 71.3 top-1 (Table 2)\n- 68.0 at 1k images (Fig. 4)\n\n### Bearing on\n\nD04\n\n### Left open\n\no",
   "today": "2026-11-25",
   "want": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n## Claude's impression (2026-11-25)\n\n### Claims\n\nA second reading.\n\n### How\n\nh\n\n### Key results\n\n- 71.3 top-1 (Table 2)\n- 68.0 at 1k images (Fig. 4)\n\n### Bearing on\n\nD04\n\n### Left open\n\no\n"
  },
  {
   "name": "the file's endings are kept",
   "text": "# Mixup at scale\r\n<https://arxiv.org/abs/2406.01234>\r\n\r\n## My reading\r\n\r\n> The gain vanishes below 1k images (Sec. 4.2)\r\n\r\nSame subset sizes as E05?\r\n\r\n## Claude's impression (2026-11-24)\r\n\r\n### Claims\r\n\r\nMixup still helps at ViT-H scale.\r\n\r\n### How\r\n\r\nViT-H on ImageNet-21k subsets.\r\n\r\n### Key results\r\n\r\n+1.2 top-1 at 10% of the data (Table 3).\r\n\r\n### Bearing on\r\n\r\nD04, E05: same subset sizes.\r\n\r\n### Left open\r\n\r\nNothing below 1k images.\r\n",
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "impression": "### Claims\n\nA second reading.\n\n### How\n\nh\n\n### Key results\n\n- 71.3 top-1 (Table 2)\n- 68.0 at 1k images (Fig. 4)\n\n### Bearing on\n\nD04\n\n### Left open\n\no",
   "today": "2026-11-25",
   "want": "# Mixup at scale\r\n<https://arxiv.org/abs/2406.01234>\r\n\r\n## My reading\r\n\r\n> The gain vanishes below 1k images (Sec. 4.2)\r\n\r\nSame subset sizes as E05?\r\n\r\n## Claude's impression (2026-11-25)\r\n\r\n### Claims\r\n\r\nA second reading.\r\n\r\n### How\r\n\r\nh\r\n\r\n### Key results\r\n\r\n- 71.3 top-1 (Table 2)\r\n- 68.0 at 1k images (Fig. 4)\r\n\r\n### Bearing on\r\n\r\nD04\r\n\r\n### Left open\r\n\r\no\r\n"
  },
  {
   "name": "given loosely (headings of another level or case, a colon, no blank lines): written the one way",
   "text": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n",
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "impression": "\n\n## claims:\nMixup still helps at ViT-H scale.  \n\n\n# HOW\n\nViT-H on ImageNet-21k subsets.\n#### Key Results ###\n+1.2 top-1 at 10% of the data (Table 3).\n### Bearing on\n\nD04, E05: same subset sizes.\n### left open:\nNothing below 1k images.\n\n",
   "today": "2026-11-24",
   "want": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n"
  },
  {
   "name": "a file made by hand with no heading and no last newline: both parts at its end",
   "text": "https://a.org/x\n\nsome lines of mine",
   "item": {
    "key": "https://a.org/x",
    "url": "https://a.org/x/#top",
    "title": ""
   },
   "impression": "### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.",
   "today": "2026-11-24",
   "want": "https://a.org/x\n\nsome lines of mine\n\n## My reading\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n"
  },
  {
   "name": "a user's part with its own spacing and no line after it: not a byte of it changes",
   "text": "# T\n<https://a.org/x>\n## My reading\n\n\n> q  \n\tmine",
   "item": {
    "key": "https://a.org/x",
    "url": "https://a.org/x/#top",
    "title": ""
   },
   "impression": "### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.",
   "today": "2026-11-24",
   "want": "# T\n<https://a.org/x>\n## My reading\n\n\n> q  \n\tmine\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n"
  },
  {
   "name": "blank lines at the file's end become the one before the impression",
   "text": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n\n\n  \n",
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "impression": "### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.",
   "today": "2026-11-24",
   "want": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n"
  },
  {
   "name": "an impression retyped by hand, with no day and text after it: all of it is replaced",
   "text": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n## Claude\u2019s Impression\nold\n\n### Extra\nmore\n",
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "impression": "### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.",
   "today": "2026-11-24",
   "want": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n"
  },
  {
   "name": "a part missing: refused, the file as it was",
   "text": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "impression": "### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.",
   "today": "2026-11-25",
   "error": true
  },
  {
   "name": "the parts out of their order: refused, the file as it was",
   "text": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "impression": "### How\n\nViT-H on ImageNet-21k subsets.\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.",
   "today": "2026-11-25",
   "error": true
  },
  {
   "name": "a heading that is none of the five: refused, the file as it was",
   "text": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "impression": "### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n\n### Verdict\n\ngood",
   "today": "2026-11-25",
   "error": true
  },
  {
   "name": "text before the first heading: refused, the file as it was",
   "text": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "impression": "A paper on mixup.\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.",
   "today": "2026-11-25",
   "error": true
  },
  {
   "name": "an empty part: refused, the file as it was",
   "text": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "impression": "### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\n\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.",
   "today": "2026-11-25",
   "error": true
  },
  {
   "name": "a part twice: refused, the file as it was",
   "text": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "impression": "### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n\n### Claims\n\nagain",
   "today": "2026-11-25",
   "error": true
  },
  {
   "name": "longer than a screen: refused, the file as it was",
   "text": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "impression": "### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images. xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
   "today": "2026-11-25",
   "error": true
  },
  {
   "name": "nothing: refused, the file as it was",
   "text": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "impression": "",
   "today": "2026-11-25",
   "error": true
  },
  {
   "name": "a heading of the note itself: refused, the file as it was",
   "text": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E05?\n\n## Claude's impression (2026-11-24)\n\n### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n",
   "item": {
    "key": "arxiv:2406.01234",
    "url": "https://arxiv.org/abs/2406.01234",
    "title": "Mixup at scale"
   },
   "impression": "### Claims\n\nMixup still helps at ViT-H scale.\n\n### How\n\nViT-H on ImageNet-21k subsets.\n\n### Key results\n\n+1.2 top-1 at 10% of the data (Table 3).\n\n### Bearing on\n\nD04, E05: same subset sizes.\n\n### Left open\n\nNothing below 1k images.\n\n## My reading\n\nfake",
   "today": "2026-11-25",
   "error": true
  }
 ],
 "quotes": [
  {
   "name": "a quote of one line, a quote of two, the user's own lines between",
   "mine": "> one\n\nmine\n> two a\n>two b  \n\nmine again",
   "quotes": [
    [
     "one"
    ],
    [
     "two a",
     "two b"
    ]
   ]
  },
  {
   "name": "a blank quote line inside a quote stays; alone it is none",
   "mine": "> a\n>\n> b\n\n>\n> \n",
   "quotes": [
    [
     "a",
     "",
     "b"
    ]
   ]
  },
  {
   "name": "no quote",
   "mine": "mine\n\\> not one\n",
   "quotes": []
  },
  {
   "name": "an indented quote, and what follows the mark as typed",
   "mine": "  > a  b\n\t>  two spaces",
   "quotes": [
    [
     "a  b",
     " two spaces"
    ]
   ]
  }
 ],
 "held": [
  {
   "name": "word for word, among other quotes",
   "mine": "> one\n\n> two a\n> two b",
   "note": "## Quotes\n\n> zero\n> one\n\ntext\n\n> two a\n> two b\n",
   "missing": []
  },
  {
   "name": "a quote that is plain text in the note is not marked as one",
   "mine": "> one",
   "note": "## Quotes\n\none\n",
   "missing": [
    [
     "one"
    ]
   ]
  },
  {
   "name": "a word changed, a letter's case, a space",
   "mine": "> The gain vanishes\n\n> a  b\n\n> same",
   "note": "> the gain vanishes\n\n> a b\n\n> same\n",
   "missing": [
    [
     "The gain vanishes"
    ],
    [
     "a  b"
    ]
   ]
  },
  {
   "name": "the lines of a quote together and in their order",
   "mine": "> a\n> b",
   "note": "> a\n\n> b\n\n> b\n> a\n",
   "missing": [
    [
     "a",
     "b"
    ]
   ]
  },
  {
   "name": "under an entry of a literature note, indented",
   "mine": "> a\n> b",
   "note": "### 2024 Doe \u2014 T\n\n  > a\n  > b\n",
   "missing": []
  },
  {
   "name": "part of a longer line is not the line",
   "mine": "> gain",
   "note": "> the gain vanishes\n",
   "missing": [
    [
     "gain"
    ]
   ]
  },
  {
   "name": "no quote to carry",
   "mine": "mine alone",
   "note": "",
   "missing": []
  }
 ]
}
export const SCENARIOS = {
 "A": {
  "title": "A. The user quotes on the phone, Process later (blind), marks as read, the discussion, a reference under a direction",
  "steps": [
   {
    "who": "given",
    "does": "A week ago the user saved the paper from the phone. The item has no reading note.",
    "files": {
     "Inbox.md": "# Inbox\n\n- [Mixup at scale](https://arxiv.org/abs/2406.01234) \u2014 maybe relevant to D01 \u00b7 high \u00b7 added 2026-11-16\n"
    }
   },
   {
    "who": "user",
    "does": "Opens the item's reading note on the phone and writes a quote and a line of their own. The box saves itself: the file is made.",
    "page": {
     "method": "PUT",
     "path": "/api/reading",
     "body": {
      "key": "arxiv:2406.01234",
      "text": "> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E02?",
      "version": "@read"
     }
    },
    "status": 200,
    "files": {
     "Reading notes/arxiv-2406.01234.md": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E02?\n"
    }
   },
   {
    "who": "claude",
    "does": "The user presses Process. If Claude asks for the reading note, the user's part is not given, whatever it holds.",
    "tool": {
     "link": "https://arxiv.org/abs/2406.01234",
     "reading": true
    },
    "says": [
     "No impression of Mixup at scale",
     "The user's part of its reading note is closed to you"
    ],
    "never": [
     "gain vanishes",
     "subset sizes"
    ]
   },
   {
    "who": "claude",
    "does": "Claude reads the paper itself and saves its impression, then its brief. It says the brief in the chat and stops: no outcome is asked for.",
    "tool": {
     "link": "https://arxiv.org/abs/2406.01234",
     "impression": "### Claims\n\nMixup still improves top-1 accuracy at ViT-H scale, and the gain grows as labelled data shrinks down to 10% of ImageNet.\n\n### How\n\nViT-B/L/H trained on ImageNet subsets of 1%, 10% and 100%, with and without mixup, three seeds each.\n\n### Key results\n\n- +1.2 top-1 for ViT-H at 10% of the data (Table 3)\n- no gain at 1% (Fig. 4)\n\n### Bearing on\n\nD01: the same question at larger scale. E02 uses the 10% subset.\n\n### Left open\n\nWhether the 1% result is the model or the schedule: only one schedule was tried.",
     "brief": "claims mixup still helps at ViT-H scale, most at 10% of the labels\ntouches D01, E02\nrecommends: reference under D01"
    },
    "says": [
     "Impression saved on Mixup at scale",
     "The user's part of the reading note stays closed until they mark the item as read.",
     "Brief saved on Mixup at scale"
    ],
    "never": [
     "gain vanishes"
    ],
    "files": {
     "Inbox.md": "# Inbox\n\n- [Mixup at scale](https://arxiv.org/abs/2406.01234) \u2014 maybe relevant to D01 \u00b7 high \u00b7 added 2026-11-16\n  - briefed {today}: claims mixup still helps at ViT-H scale, most at 10% of the labels\n  - touches D01, E02\n  - recommends: reference under D01\n",
     "Reading notes/arxiv-2406.01234.md": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E02?\n\n## Claude's impression ({today})\n\n### Claims\n\nMixup still improves top-1 accuracy at ViT-H scale, and the gain grows as labelled data shrinks down to 10% of ImageNet.\n\n### How\n\nViT-B/L/H trained on ImageNet subsets of 1%, 10% and 100%, with and without mixup, three seeds each.\n\n### Key results\n\n- +1.2 top-1 for ViT-H at 10% of the data (Table 3)\n- no gain at 1% (Fig. 4)\n\n### Bearing on\n\nD01: the same question at larger scale. E02 uses the 10% subset.\n\n### Left open\n\nWhether the 1% result is the model or the schedule: only one schedule was tried.\n"
    }
   },
   {
    "who": "user",
    "does": "Reads on and adds a second quote, after Claude's impression was saved. No conflict: the impression is not the user's part and stays as it is.",
    "page": {
     "method": "PUT",
     "path": "/api/reading",
     "body": {
      "key": "arxiv:2406.01234",
      "text": "> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E02?\n\n> We find mixup complementary to RandAugment at every scale (Table 3)",
      "version": "@read"
     }
    },
    "status": 200,
    "files": {
     "Reading notes/arxiv-2406.01234.md": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E02?\n\n> We find mixup complementary to RandAugment at every scale (Table 3)\n\n## Claude's impression ({today})\n\n### Claims\n\nMixup still improves top-1 accuracy at ViT-H scale, and the gain grows as labelled data shrinks down to 10% of ImageNet.\n\n### How\n\nViT-B/L/H trained on ImageNet subsets of 1%, 10% and 100%, with and without mixup, three seeds each.\n\n### Key results\n\n- +1.2 top-1 for ViT-H at 10% of the data (Table 3)\n- no gain at 1% (Fig. 4)\n\n### Bearing on\n\nD01: the same question at larger scale. E02 uses the 10% subset.\n\n### Left open\n\nWhether the 1% result is the model or the schedule: only one schedule was tried.\n"
    }
   },
   {
    "who": "user",
    "does": "Marks the item as read, with a chat connected. The mark is saved on the item's line and the discussion is asked of the chat.",
    "page": {
     "method": "POST",
     "path": "/api/inbox",
     "body": {
      "key": "arxiv:2406.01234",
      "action": "read",
      "read": true
     }
    },
    "chat": true,
    "status": 200,
    "answer": {
     "asked": true,
     "waiting": []
    },
    "files": {
     "Inbox.md": "# Inbox\n\n- [Mixup at scale](https://arxiv.org/abs/2406.01234) \u2014 maybe relevant to D01 \u00b7 high \u00b7 added 2026-11-16 \u00b7 read {today}\n  - briefed {today}: claims mixup still helps at ViT-H scale, most at 10% of the labels\n  - touches D01, E02\n  - recommends: reference under D01\n"
    }
   },
   {
    "who": "claude",
    "does": "The discussion: Claude opens the reading note and is given the user's part for the first time, word for word, beside its own impression.",
    "tool": {
     "link": "https://arxiv.org/abs/2406.01234",
     "reading": true
    },
    "says": [
     "Your impression of Mixup at scale",
     "### Key results",
     "The user's part, marked as read {today}",
     "> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E02?\n\n> We find mixup complementary to RandAugment at every scale (Table 3)"
    ]
   },
   {
    "who": "claude",
    "does": "A new impression now would be written after seeing the user's part: refused. The impression is frozen.",
    "tool": {
     "link": "https://arxiv.org/abs/2406.01234",
     "impression": "### Claims\n\nMixup helps at every model scale tried, most at 10% of the labels; at 1% it does not help.\n\n### How\n\nViT-B/L/H trained on ImageNet subsets of 1%, 10% and 100%, with and without mixup, three seeds each.\n\n### Key results\n\n- +1.2 top-1 for ViT-H at 10% of the data (Table 3)\n- no gain at 1% (Fig. 4)\n\n### Bearing on\n\nD01: the same question at larger scale. E02 uses the 10% subset.\n\n### Left open\n\nWhether the 1% result is the model or the schedule: only one schedule was tried."
    },
    "says": [
     "Impression not saved",
     "is frozen from then on"
    ]
   },
   {
    "who": "given",
    "does": "The user picks: reference, under D01. Claude writes the reference note R02, but paraphrases the second quote.",
    "files": {
     "references/R02 Mixup at scale.md": "---\nid: R02\ntype: reference\nstatus: done\ndate: 2026-11-24\nparent: \"[[D01 A better variant]]\"\nchildren: []\ntags: [demo, reference, done]\n---\n\n# R02 \u00b7 Mixup at scale\n\n**Parent:** [[D01 A better variant]]\n**Status:** done \u00b7 **Date:** 2026-11-24\n\n## Source\nDoe et al. 2024, Mixup at scale. https://arxiv.org/abs/2406.01234\n\n## Summary\nMixup still helps at ViT-H scale, most at 10% of the labels; no gain at 1%.\n\n## Quotes\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\n> Mixup is found to complement RandAugment at all scales (Table 3)\n\n## Relevance\nSame subset sizes as E02?\n\n## Children in the tree\n"
    }
   },
   {
    "who": "claude",
    "does": "Claude closes the item: refused, because a quote of the user's is not in R02 word for word.",
    "tool": {
     "link": "https://arxiv.org/abs/2406.01234",
     "outcome": "reference",
     "note": "R02"
    },
    "says": [
     "Not closed: 1 of the user's 2 quotes is not in R02 word for word, as quote lines (>).",
     "> We find mixup complementary to RandAugment at every scale (Table 3)"
    ]
   },
   {
    "who": "given",
    "does": "Claude puts the quote in as the user wrote it. The user's own line was rephrased by Claude, proposed in the chat and accepted by the user.",
    "files": {
     "references/R02 Mixup at scale.md": "---\nid: R02\ntype: reference\nstatus: done\ndate: 2026-11-24\nparent: \"[[D01 A better variant]]\"\nchildren: []\ntags: [demo, reference, done]\n---\n\n# R02 \u00b7 Mixup at scale\n\n**Parent:** [[D01 A better variant]]\n**Status:** done \u00b7 **Date:** 2026-11-24\n\n## Source\nDoe et al. 2024, Mixup at scale. https://arxiv.org/abs/2406.01234\n\n## Summary\nMixup still helps at ViT-H scale, most at 10% of the labels; no gain at 1%.\n\n## Quotes\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\n> We find mixup complementary to RandAugment at every scale (Table 3)\n\n## Relevance\nE02 uses the same 10% subset, so its numbers can be set beside Table 3; the 1k-image regime, where the paper finds no gain, is ours.\n\n## Children in the tree\n"
    }
   },
   {
    "who": "claude",
    "does": "Claude closes the item. It leaves the inbox for one line under Processed, and its reading note is removed: what it held is in R02.",
    "tool": {
     "link": "https://arxiv.org/abs/2406.01234",
     "outcome": "reference",
     "note": "R02"
    },
    "says": [
     "Closed: Mixup at scale (https://arxiv.org/abs/2406.01234) \u2192 R02.",
     "Its reading note (Reading notes/arxiv-2406.01234.md) is removed: the user's quotes are in R02."
    ],
    "files": {
     "Inbox.md": "# Inbox\n\n## Processed\n\n- {today} [Mixup at scale](https://arxiv.org/abs/2406.01234) \u2192 R02\n",
     "Reading notes/arxiv-2406.01234.md": null
    }
   }
  ]
 },
 "B": {
  "title": "B. Process with no reading note, then later",
  "steps": [
   {
    "who": "given",
    "does": "The item is in the inbox. The user has not opened its reading note: there is no file.",
    "files": {
     "Inbox.md": "# Inbox\n\n- [Mixup at scale](https://arxiv.org/abs/2406.01234) \u2014 maybe relevant to D01 \u00b7 high \u00b7 added 2026-11-16\n- https://example.org/blog/post \u2014 from Bea\n"
    }
   },
   {
    "who": "claude",
    "does": "The user presses Process. Claude reads the paper and saves its impression and its brief: the reading note is made, with the user's part empty.",
    "tool": {
     "link": "https://arxiv.org/abs/2406.01234",
     "impression": "### Claims\n\nMixup still improves top-1 accuracy at ViT-H scale, and the gain grows as labelled data shrinks down to 10% of ImageNet.\n\n### How\n\nViT-B/L/H trained on ImageNet subsets of 1%, 10% and 100%, with and without mixup, three seeds each.\n\n### Key results\n\n- +1.2 top-1 for ViT-H at 10% of the data (Table 3)\n- no gain at 1% (Fig. 4)\n\n### Bearing on\n\nD01: the same question at larger scale. E02 uses the 10% subset.\n\n### Left open\n\nWhether the 1% result is the model or the schedule: only one schedule was tried.",
     "brief": "claims mixup still helps at ViT-H scale, most at 10% of the labels\ntouches D01, E02\nrecommends: reference under D01"
    },
    "says": [
     "Impression saved on Mixup at scale",
     "Brief saved on Mixup at scale"
    ],
    "files": {
     "Inbox.md": "# Inbox\n\n- [Mixup at scale](https://arxiv.org/abs/2406.01234) \u2014 maybe relevant to D01 \u00b7 high \u00b7 added 2026-11-16\n  - briefed {today}: claims mixup still helps at ViT-H scale, most at 10% of the labels\n  - touches D01, E02\n  - recommends: reference under D01\n- https://example.org/blog/post \u2014 from Bea\n",
     "Reading notes/arxiv-2406.01234.md": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n## Claude's impression ({today})\n\n### Claims\n\nMixup still improves top-1 accuracy at ViT-H scale, and the gain grows as labelled data shrinks down to 10% of ImageNet.\n\n### How\n\nViT-B/L/H trained on ImageNet subsets of 1%, 10% and 100%, with and without mixup, three seeds each.\n\n### Key results\n\n- +1.2 top-1 for ViT-H at 10% of the data (Table 3)\n- no gain at 1% (Fig. 4)\n\n### Bearing on\n\nD01: the same question at larger scale. E02 uses the 10% subset.\n\n### Left open\n\nWhether the 1% result is the model or the schedule: only one schedule was tried.\n"
    }
   },
   {
    "who": "claude",
    "does": "The user presses Process again, before any read mark: the impression is rewritten, from the paper alone.",
    "tool": {
     "link": "https://arxiv.org/abs/2406.01234",
     "impression": "### Claims\n\nMixup helps at every model scale tried, most at 10% of the labels; at 1% it does not help.\n\n### How\n\nViT-B/L/H trained on ImageNet subsets of 1%, 10% and 100%, with and without mixup, three seeds each.\n\n### Key results\n\n- +1.2 top-1 for ViT-H at 10% of the data (Table 3)\n- no gain at 1% (Fig. 4)\n\n### Bearing on\n\nD01: the same question at larger scale. E02 uses the 10% subset.\n\n### Left open\n\nWhether the 1% result is the model or the schedule: only one schedule was tried."
    },
    "says": [
     "Impression saved on Mixup at scale",
     "in place of the one of {today}"
    ],
    "files": {
     "Reading notes/arxiv-2406.01234.md": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n## Claude's impression ({today})\n\n### Claims\n\nMixup helps at every model scale tried, most at 10% of the labels; at 1% it does not help.\n\n### How\n\nViT-B/L/H trained on ImageNet subsets of 1%, 10% and 100%, with and without mixup, three seeds each.\n\n### Key results\n\n- +1.2 top-1 for ViT-H at 10% of the data (Table 3)\n- no gain at 1% (Fig. 4)\n\n### Bearing on\n\nD01: the same question at larger scale. E02 uses the 10% subset.\n\n### Left open\n\nWhether the 1% result is the model or the schedule: only one schedule was tried.\n"
    }
   },
   {
    "who": "claude",
    "does": "The user says: later. Nothing is closed and nothing is removed.",
    "tool": {
     "link": "https://arxiv.org/abs/2406.01234",
     "outcome": "later"
    },
    "says": [
     "Left in the inbox for later: Mixup at scale",
     "Nothing closed."
    ]
   },
   {
    "who": "user",
    "does": "Days later, on the phone with no chat connected, the user marks the item as read. The mark is saved; the row says \"waiting for chat connection\"; nothing is queued.",
    "page": {
     "method": "POST",
     "path": "/api/inbox",
     "body": {
      "key": "arxiv:2406.01234",
      "action": "read",
      "read": true
     }
    },
    "chat": false,
    "status": 200,
    "answer": {
     "asked": false,
     "waiting": [
      "arxiv:2406.01234"
     ]
    },
    "files": {
     "Inbox.md": "# Inbox\n\n- [Mixup at scale](https://arxiv.org/abs/2406.01234) \u2014 maybe relevant to D01 \u00b7 high \u00b7 added 2026-11-16 \u00b7 read {today}\n  - briefed {today}: claims mixup still helps at ViT-H scale, most at 10% of the labels\n  - touches D01, E02\n  - recommends: reference under D01\n- https://example.org/blog/post \u2014 from Bea\n"
    }
   },
   {
    "who": "user",
    "does": "At the desk, with a chat connected, the user presses Discuss: the discussion is asked of the chat.",
    "page": {
     "method": "POST",
     "path": "/api/inbox",
     "body": {
      "key": "arxiv:2406.01234",
      "action": "discuss"
     }
    },
    "chat": true,
    "status": 200,
    "answer": {
     "asked": true
    }
   },
   {
    "who": "claude",
    "does": "In the discussion the user says: later, again. The item, its reading note and its read mark all stay.",
    "tool": {
     "link": "https://arxiv.org/abs/2406.01234",
     "outcome": "later"
    },
    "says": [
     "Left in the inbox for later: Mixup at scale"
    ]
   }
  ]
 },
 "C": {
  "title": "C. A discard after quoting asks first",
  "steps": [
   {
    "who": "given",
    "does": "The user has quoted from the paper; the item is not marked as read and has no impression.",
    "files": {
     "Inbox.md": "# Inbox\n\n- [Mixup at scale](https://arxiv.org/abs/2406.01234) \u2014 maybe relevant to D01 \u00b7 high \u00b7 added 2026-11-16\n- https://example.org/blog/post \u2014 from Bea\n",
     "Reading notes/arxiv-2406.01234.md": "# Mixup at scale\n<https://arxiv.org/abs/2406.01234>\n\n## My reading\n\n> The gain vanishes below 1k images (Sec. 4.2)\n\nSame subset sizes as E02?\n"
    }
   },
   {
    "who": "user",
    "does": "Taps \u2715 on the item in the panel: refused, the panel asks first, because the reading note holds what they wrote.",
    "page": {
     "method": "POST",
     "path": "/api/inbox",
     "body": {
      "key": "arxiv:2406.01234",
      "action": "discard"
     }
    },
    "status": 409,
    "answer": {
     "holds": true
    }
   },
   {
    "who": "claude",
    "does": "In the chat the user says to discard it. Claude closes with discard: refused, it must ask the user first.",
    "tool": {
     "link": "https://arxiv.org/abs/2406.01234",
     "outcome": "discard",
     "reason": "superseded by R01"
    },
    "says": [
     "Not closed: the user's part of the reading note of Mixup at scale",
     "Ask the user first; once they say yes, close with confirmed: true."
    ],
    "never": [
     "gain vanishes"
    ]
   },
   {
    "who": "claude",
    "does": "The user says yes. Claude closes with the confirmation: the item goes under Processed with its reason, the reading note is removed.",
    "tool": {
     "link": "https://arxiv.org/abs/2406.01234",
     "outcome": "discard",
     "reason": "superseded by R01",
     "confirmed": true
    },
    "says": [
     "Closed: Mixup at scale (https://arxiv.org/abs/2406.01234) \u2014 discarded: superseded by R01.",
     "Its reading note (Reading notes/arxiv-2406.01234.md) is removed, with what the user had written in it."
    ],
    "files": {
     "Inbox.md": "# Inbox\n\n- https://example.org/blog/post \u2014 from Bea\n\n## Processed\n\n- {today} [Mixup at scale](https://arxiv.org/abs/2406.01234) \u2014 discarded: superseded by R01\n",
     "Reading notes/arxiv-2406.01234.md": null
    }
   },
   {
    "who": "user",
    "after": 2,
    "does": "Or, from step 2, on the panel: the user taps \u2715 and confirms the question. The item goes under Processed as discarded, the reading note is removed.",
    "page": {
     "method": "POST",
     "path": "/api/inbox",
     "body": {
      "key": "arxiv:2406.01234",
      "action": "discard",
      "confirm": true
     }
    },
    "status": 200,
    "files": {
     "Inbox.md": "# Inbox\n\n- https://example.org/blog/post \u2014 from Bea\n\n## Processed\n\n- {today} [Mixup at scale](https://arxiv.org/abs/2406.01234) \u2014 discarded\n",
     "Reading notes/arxiv-2406.01234.md": null
    }
   }
  ]
 }
}
