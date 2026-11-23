// Copied from tests/fixtures/inbox/ by tests/fixtures/inbox/to_ts.py: edit those files, then run it.
export const INBOX_MD: string = "# Inbox\n\npapers to look at when I have time\n\n- [Mixup at scale](https://arxiv.org/abs/2406.01234) \u2014 maybe relevant to D04 \u00b7 high \u00b7 added 2026-11-16\n  - briefed 2026-11-20: claims strong augmentation still helps at ViT-H scale\n  - touches R07, E12\n  - recommends: reference under D04\n- https://lilianweng.github.io/posts/2021-05-31-contrastive/\n- 2311.09876\n* arXiv:2406.01234v2 - same one from Gianni?\n- https://doi.org/10.1007/s11263-021-01453-z \u2014 IJCV survey, low\n-   [Video MAE v3](https://openreview.net/forum?id=abc123#discussion)   urgent\n- doi:10.1109/CVPR.2022.01553 \u00b7 added 2026-11-02\n\n### from the reading group\n- https://arxiv.org/pdf/2501.00001v3.pdf \u2014 Thomas mentioned it \u00b7 medium \u00b7 added 2026-11-22\n- [ ] ask Bea for the slides\n- see also the list in Scratchpad\n\n## Processed\n\n- 2026-11-10 [Masked autoencoders](https://arxiv.org/abs/2111.06377) \u2192 R03\n- 2026-11-12 https://example.org/blog/old-post \u2014 discarded: superseded by R07\n- 2026-11-14 https://arxiv.org/abs/2210.00001 \u2014 discarded\n"
export const EXPECTED = {
 "items": [
  {
   "key": "arxiv:2406.01234",
   "url": "https://arxiv.org/abs/2406.01234",
   "title": "Mixup at scale",
   "why": "maybe relevant to D04",
   "priority": "high",
   "added": "2026-11-16",
   "duplicate": false,
   "brief": {
    "date": "2026-11-20",
    "lines": [
     "claims strong augmentation still helps at ViT-H scale",
     "touches R07, E12",
     "recommends: reference under D04"
    ]
   }
  },
  {
   "key": "https://lilianweng.github.io/posts/2021-05-31-contrastive",
   "url": "https://lilianweng.github.io/posts/2021-05-31-contrastive/",
   "title": "",
   "why": "",
   "priority": "",
   "added": "",
   "duplicate": false,
   "brief": null
  },
  {
   "key": "arxiv:2311.09876",
   "url": "https://arxiv.org/abs/2311.09876",
   "title": "",
   "why": "",
   "priority": "",
   "added": "",
   "duplicate": false,
   "brief": null
  },
  {
   "key": "arxiv:2406.01234",
   "url": "https://arxiv.org/abs/2406.01234",
   "title": "",
   "why": "same one from Gianni?",
   "priority": "",
   "added": "",
   "duplicate": true,
   "brief": null
  },
  {
   "key": "doi:10.1007/s11263-021-01453-z",
   "url": "https://doi.org/10.1007/s11263-021-01453-z",
   "title": "",
   "why": "IJCV survey, low",
   "priority": "",
   "added": "",
   "duplicate": false,
   "brief": null
  },
  {
   "key": "https://openreview.net/forum?id=abc123",
   "url": "https://openreview.net/forum?id=abc123#discussion",
   "title": "Video MAE v3",
   "why": "",
   "priority": "urgent",
   "added": "",
   "duplicate": false,
   "brief": null
  },
  {
   "key": "doi:10.1109/cvpr.2022.01553",
   "url": "https://doi.org/10.1109/CVPR.2022.01553",
   "title": "",
   "why": "",
   "priority": "",
   "added": "2026-11-02",
   "duplicate": false,
   "brief": null
  },
  {
   "key": "arxiv:2501.00001",
   "url": "https://arxiv.org/abs/2501.00001",
   "title": "",
   "why": "Thomas mentioned it",
   "priority": "medium",
   "added": "2026-11-22",
   "duplicate": false,
   "brief": null
  }
 ],
 "processed": [
  {
   "date": "2026-11-10",
   "key": "arxiv:2111.06377",
   "title": "Masked autoencoders",
   "outcome": "R03"
  },
  {
   "date": "2026-11-12",
   "key": "https://example.org/blog/old-post",
   "title": "",
   "outcome": "discarded: superseded by R07"
  },
  {
   "date": "2026-11-14",
   "key": "arxiv:2210.00001",
   "title": "",
   "outcome": "discarded"
  }
 ]
}
export const CASES = {
 "identity": [
  [
   "2406.01234",
   "arxiv:2406.01234"
  ],
  [
   "arXiv:2406.01234v3",
   "arxiv:2406.01234"
  ],
  [
   "arxiv: 2406.01234",
   "arxiv:2406.01234"
  ],
  [
   "https://arxiv.org/abs/2406.01234",
   "arxiv:2406.01234"
  ],
  [
   "http://ARXIV.org/pdf/2406.01234v2.pdf",
   "arxiv:2406.01234"
  ],
  [
   "https://export.arxiv.org/abs/2406.01234v1",
   "arxiv:2406.01234"
  ],
  [
   "https://www.arxiv.org/abs/2406.01234?context=cs.CV",
   "arxiv:2406.01234"
  ],
  [
   "https://arxiv.org/html/2406.01234v2#S3",
   "arxiv:2406.01234"
  ],
  [
   "[Mixup](https://arxiv.org/pdf/2406.01234)",
   "arxiv:2406.01234"
  ],
  [
   "<https://arxiv.org/abs/2406.01234>",
   "arxiv:2406.01234"
  ],
  [
   "[t]( <https://arxiv.org/abs/2406.01234> )",
   "arxiv:2406.01234"
  ],
  [
   "2406.01234 \u2014 a why",
   "arxiv:2406.01234"
  ],
  [
   "hep-th/9901001v2",
   "arxiv:hep-th/9901001"
  ],
  [
   "math.GT/0309136",
   "arxiv:math.GT/0309136"
  ],
  [
   "doi:10.1109/CVPR.2022.01553",
   "doi:10.1109/cvpr.2022.01553"
  ],
  [
   "DOI: 10.1109/CVPR.2022.01553",
   "doi:10.1109/cvpr.2022.01553"
  ],
  [
   "10.1109/CVPR.2022.01553",
   "doi:10.1109/cvpr.2022.01553"
  ],
  [
   "https://doi.org/10.1109/cvpr.2022.01553",
   "doi:10.1109/cvpr.2022.01553"
  ],
  [
   "http://dx.doi.org/10.1109/CVPR.2022.01553",
   "doi:10.1109/cvpr.2022.01553"
  ],
  [
   "https://Example.org/a/b/#top",
   "https://example.org/a/b"
  ],
  [
   "HTTPS://example.org/a/b",
   "https://example.org/a/b"
  ],
  [
   "https://example.org/a/b?x=1#y",
   "https://example.org/a/b?x=1"
  ],
  [
   "https://example.org/a/b?",
   "https://example.org/a/b"
  ],
  [
   "https://example.org",
   "https://example.org"
  ],
  [
   "https://example.org/",
   "https://example.org"
  ],
  [
   "https://example.org/a. and then",
   "https://example.org/a"
  ],
  [
   "https://example.org/A/b",
   "https://example.org/A/b"
  ],
  [
   "https://example.org/wiki/Mixup_(x)",
   "https://example.org/wiki/Mixup_(x)"
  ],
  [
   "https://example.org/a\u00a0\u2014 pasted with a hard space",
   "https://example.org/a"
  ],
  [
   "ftp://example.org/file",
   null
  ],
  [
   "[no target]()",
   null
  ],
  [
   "[t](not a link)",
   null
  ],
  [
   "see https://example.org/later",
   null
  ],
  [
   "[ ] a to-do",
   null
  ],
  [
   "a remark",
   null
  ],
  [
   "2311.09876abc",
   null
  ],
  [
   "12345.678",
   null
  ],
  [
   "https://",
   null
  ],
  [
   "http://?x",
   null
  ],
  [
   "www.example.org/x",
   null
  ],
  [
   "\u0662\u0664\u0660\u0666.\u0660\u0661\u0662\u0663\u0664",
   null
  ],
  [
   "http\u017f://example.org/a",
   null
  ],
  [
   "do\u0130:10.1109/x",
   null
  ],
  [
   "arx\u0130v:2406.01234",
   null
  ],
  [
   "https://EXAMPLE.org/\u00c9t\u00e9",
   "https://example.org/\u00c9t\u00e9"
  ],
  [
   "https://example.org/a\ufeffb",
   "https://example.org/a\ufeffb"
  ],
  [
   "https://example.org/a\u0085b",
   "https://example.org/a\u0085b"
  ],
  [
   "https://example.org/a\u001cb",
   "https://example.org/a\u001cb"
  ],
  [
   "https://example.org/a\u2028b",
   "https://example.org/a"
  ],
  [
   "https://example.org/a\rb",
   "https://example.org/a"
  ],
  [
   "https://example.org/a\u3000b",
   "https://example.org/a"
  ]
 ],
 "sources": [
  [
   "Zhang et al., *Mixup at scale*, 2024. arXiv:2406.01234v2.",
   [
    "arxiv:2406.01234"
   ]
  ],
  [
   "He et al., CVPR 2022. https://doi.org/10.1109/CVPR.2022.01553.",
   [
    "doi:10.1109/cvpr.2022.01553"
   ]
  ],
  [
   "doi 10.1109/CVPR.2022.01553; [pdf](https://arxiv.org/pdf/2111.06377v3.pdf)",
   [
    "doi:10.1109/cvpr.2022.01553",
    "arxiv:2111.06377"
   ]
  ],
  [
   "arxiv.org/abs/2406.01234 and arXiv 2406.01234 again, hep-th/9901001 is not said to be one, arXiv:hep-th/9901001 is",
   [
    "arxiv:2406.01234",
    "arxiv:hep-th/9901001"
   ]
  ],
  [
   "A blog: <https://Example.org/blog/post/#intro>, read 2026-01-05",
   [
    "https://example.org/blog/post"
   ]
  ],
  [
   "Section 2406.01234 of the book, 210.1234/x, arXiv:2406.012345678, ftp://example.org/x",
   []
  ],
  [
   "",
   []
  ]
 ],
 "notes": [
  [
   "# R03 \u00b7 MAE\n\n## Source\nHe et al., 2022. arXiv:2111.06377\n\n## Summary\nSee also https://example.org/other\n",
   [
    "arxiv:2111.06377"
   ]
  ],
  [
   "## Summary\nhttps://example.org/other\n",
   []
  ],
  [
   "## Source\r\nhttps://example.org/a\r\n## Relevance\r\nhttps://example.org/b\r\n",
   [
    "https://example.org/a"
   ]
  ],
  [
   "## Source \nhttps://example.org/a\n### As cited\nhttps://example.org/c\n# Top\nhttps://example.org/b",
   [
    "https://example.org/a",
    "https://example.org/c"
   ]
  ],
  [
   "## Sources\nhttps://example.org/a\n",
   []
  ]
 ],
 "finds": [
  [
   "arxiv:2406.01234",
   "item",
   {
    "why": "maybe relevant to D04",
    "duplicate": false
   }
  ],
  [
   "doi:10.1109/cvpr.2022.01553",
   "item",
   {
    "added": "2026-11-02"
   }
  ],
  [
   "arxiv:2111.06377",
   "processed",
   {
    "date": "2026-11-10",
    "outcome": "R03"
   }
  ],
  [
   "https://example.org/blog/old-post",
   "processed",
   {
    "outcome": "discarded: superseded by R07"
   }
  ],
  [
   "arxiv:9999.99999",
   null,
   null
  ]
 ],
 "adds": [
  {
   "name": "no file yet: a heading, then the item",
   "text": "",
   "link": "https://b.org/y",
   "today": "2026-11-23",
   "want": "# Inbox\n\n- https://b.org/y \u00b7 added 2026-11-23\n"
  },
  {
   "name": "a heading alone",
   "text": "# Inbox\n",
   "link": "https://b.org/y",
   "today": "2026-11-23",
   "want": "# Inbox\n\n- https://b.org/y \u00b7 added 2026-11-23\n"
  },
  {
   "name": "free text without a newline at its end",
   "text": "some text",
   "link": "https://b.org/y",
   "today": "2026-11-23",
   "want": "some text\n\n- https://b.org/y \u00b7 added 2026-11-23\n"
  },
  {
   "name": "after the last item",
   "text": "- https://a.org/x\n",
   "link": "2511.00042v2",
   "why": "from  the talk",
   "priority": "High",
   "today": "2026-11-23",
   "want": "- https://a.org/x\n- https://arxiv.org/abs/2511.00042 \u2014 from the talk \u00b7 high \u00b7 added 2026-11-23\n"
  },
  {
   "name": "before the processed ones",
   "text": "## Processed\n- 2026-01-01 https://a.org/x \u2014 discarded\n",
   "link": "https://b.org/y",
   "today": "2026-11-23",
   "want": "- https://b.org/y \u00b7 added 2026-11-23\n\n## Processed\n- 2026-01-01 https://a.org/x \u2014 discarded\n"
  },
  {
   "name": "the processed heading right under the last item",
   "text": "- https://a.org/x\n## Processed\n",
   "link": "https://b.org/y",
   "today": "2026-11-23",
   "want": "- https://a.org/x\n- https://b.org/y \u00b7 added 2026-11-23\n\n## Processed\n"
  },
  {
   "name": "CRLF, the user's own line under an item and blank lines at the end, all kept",
   "text": "a\r\n\r\n- https://a.org/x\r\n  - mine\r\n\r\n\r\n",
   "link": "https://b.org/y",
   "today": "2026-11-23",
   "want": "a\r\n\r\n- https://a.org/x\r\n  - mine\r\n- https://b.org/y \u00b7 added 2026-11-23\r\n\r\n\r\n"
  },
  {
   "name": "line endings of both kinds: each line keeps its own, the new ones have the file's",
   "text": "a\r\n- https://a.org/x\nb\n",
   "link": "https://b.org/y",
   "want": "a\r\n- https://a.org/x\nb\n\r\n- https://b.org/y\r\n"
  },
  {
   "name": "CRLF and no newline at the end",
   "text": "a\r\n- https://a.org/x",
   "link": "https://b.org/y",
   "want": "a\r\n- https://a.org/x\r\n- https://b.org/y\r\n"
  },
  {
   "name": "a carriage return of the line's own before its ending: the heading is not the processed one, before or after",
   "text": "## Processed\r\r\n- https://a.org/x\r\n",
   "link": "https://b.org/y",
   "want": "## Processed\r\r\n- https://a.org/x\r\n- https://b.org/y\r\n"
  },
  {
   "name": "a list that goes on after the processed ones: still before them",
   "text": "- https://a.org/x\n\n## Processed\n\n## Later\n- https://c.org/z\n",
   "link": "https://b.org/y",
   "want": "- https://a.org/x\n- https://b.org/y\n\n## Processed\n\n## Later\n- https://c.org/z\n"
  },
  {
   "name": "a title, and a why with parts",
   "text": "",
   "link": "[A title](https://a.org/p)",
   "why": "A \u00b7 B",
   "want": "# Inbox\n\n- [A title](https://a.org/p) \u2014 A \u00b7 B\n"
  },
  {
   "name": "a title given apart, its brackets made round",
   "text": "",
   "link": "doi:10.1109/CVPR.2022.01553",
   "title": "Mix [up]  at scale",
   "priority": "low",
   "want": "# Inbox\n\n- [Mix (up) at scale](https://doi.org/10.1109/CVPR.2022.01553) \u00b7 low\n"
  },
  {
   "name": "an address a markdown link cannot hold: the title left out",
   "text": "",
   "link": "https://en.wikipedia.org/wiki/Mixup_(x)",
   "title": "Mixup",
   "want": "# Inbox\n\n- https://en.wikipedia.org/wiki/Mixup_(x)\n"
  },
  {
   "name": "not a link",
   "text": "",
   "link": "hello",
   "error": true
  },
  {
   "name": "a link and more",
   "text": "",
   "link": "https://a.org x",
   "error": true
  },
  {
   "name": "a why that is a reading priority",
   "text": "",
   "link": "https://a.org",
   "why": "low",
   "error": true
  },
  {
   "name": "a why that holds one as a part",
   "text": "",
   "link": "https://a.org",
   "why": "for D04 \u00b7 urgent",
   "error": true
  },
  {
   "name": "a why that holds a date as a part",
   "text": "",
   "link": "https://a.org",
   "why": "x \u00b7 added 2026-01-01",
   "error": true
  },
  {
   "name": "not a reading priority",
   "text": "",
   "link": "https://a.org",
   "priority": "soon",
   "error": true
  }
 ],
 "changes": [
  {
   "name": "a reading priority on a bare link",
   "text": "- https://a.org/x\n",
   "key": "https://a.org/x",
   "priority": "high",
   "want": "- https://a.org/x \u00b7 high\n"
  },
  {
   "name": "a reading priority taken away: the bullet and its spaces as typed",
   "text": "-   [T](https://a.org/x)   urgent\n",
   "key": "https://a.org/x",
   "priority": "",
   "want": "-   [T](https://a.org/x)\n"
  },
  {
   "name": "another reading priority: the why and the day stay",
   "text": "- https://a.org/x \u2014 why \u00b7 low \u00b7 added 2026-11-01\n",
   "key": "https://a.org/x",
   "priority": "urgent",
   "want": "- https://a.org/x \u2014 why \u00b7 urgent \u00b7 added 2026-11-01\n"
  },
  {
   "name": "a why: the link as typed, what follows it written again",
   "text": "* arXiv:2406.01234v2 - same one \u00b7 high\n",
   "key": "arxiv:2406.01234",
   "why": "from Gianni",
   "want": "* arXiv:2406.01234v2 \u2014 from Gianni \u00b7 high\n"
  },
  {
   "name": "a link in angle brackets stays in them",
   "text": "- <https://a.org/x> why\n",
   "key": "https://a.org/x",
   "priority": "high",
   "want": "- <https://a.org/x> \u2014 why \u00b7 high\n"
  },
  {
   "name": "a why taken away",
   "text": "- https://a.org/x \u2014 why \u00b7 added 2026-11-01\n",
   "key": "https://a.org/x",
   "why": "",
   "want": "- https://a.org/x \u00b7 added 2026-11-01\n"
  },
  {
   "name": "both at once",
   "text": "- https://a.org/x \u2014 old \u00b7 low\n",
   "key": "https://a.org/x",
   "why": "new",
   "priority": "",
   "want": "- https://a.org/x \u2014 new\n"
  },
  {
   "name": "the second of two with one link",
   "text": "- https://a.org/x\n- https://a.org/x/ \u2014 again\n",
   "key": "https://a.org/x",
   "nth": 1,
   "priority": "low",
   "want": "- https://a.org/x\n- https://a.org/x/ \u2014 again \u00b7 low\n"
  },
  {
   "name": "the brief under it stays",
   "text": "- https://a.org/x \u2014 why\n  - briefed 2026-11-20: claims x\n  - touches R07\n- https://b.org/y\n",
   "key": "https://a.org/x",
   "priority": "medium",
   "want": "- https://a.org/x \u2014 why \u00b7 medium\n  - briefed 2026-11-20: claims x\n  - touches R07\n- https://b.org/y\n"
  },
  {
   "name": "CRLF",
   "text": "# Inbox\r\n\r\n- https://a.org/x\r\n",
   "key": "https://a.org/x",
   "priority": "high",
   "want": "# Inbox\r\n\r\n- https://a.org/x \u00b7 high\r\n"
  },
  {
   "name": "nothing changes: the line stays as typed",
   "text": "- https://a.org/x - why \u00b7  LOW\n",
   "key": "https://a.org/x",
   "why": "why",
   "priority": "low",
   "want": "- https://a.org/x - why \u00b7  LOW\n"
  },
  {
   "name": "a why in several lines is one",
   "text": "- https://a.org/x\n",
   "key": "https://a.org/x",
   "why": " for\n D04,  maybe ",
   "want": "- https://a.org/x \u2014 for D04, maybe\n"
  },
  {
   "name": "a reading priority in capitals",
   "text": "- https://a.org/x\n",
   "key": "https://a.org/x",
   "priority": " High ",
   "want": "- https://a.org/x \u00b7 high\n"
  },
  {
   "name": "a why that starts with a dash",
   "text": "- https://a.org/x\n",
   "key": "https://a.org/x",
   "why": "- see R03",
   "want": "- https://a.org/x \u2014 - see R03\n"
  },
  {
   "name": "a why that is a reading priority",
   "text": "- https://a.org/x\n",
   "key": "https://a.org/x",
   "why": "urgent",
   "error": true
  },
  {
   "name": "a why that is one beside the item's own",
   "text": "- https://a.org/x \u00b7 high\n",
   "key": "https://a.org/x",
   "why": "low",
   "error": true
  },
  {
   "name": "a why that holds a date as a part",
   "text": "- https://a.org/x\n",
   "key": "https://a.org/x",
   "why": "x \u00b7 added 2026-01-01",
   "error": true
  },
  {
   "name": "not a reading priority",
   "text": "- https://a.org/x\n",
   "key": "https://a.org/x",
   "priority": "soon",
   "error": true
  },
  {
   "name": "no item has the link",
   "text": "- https://a.org/x\n",
   "key": "https://b.org/y",
   "priority": "low",
   "none": true
  },
  {
   "name": "no second item has it",
   "text": "- https://a.org/x\n",
   "key": "https://a.org/x",
   "nth": 1,
   "priority": "low",
   "none": true
  },
  {
   "name": "a processed item is not in the inbox",
   "text": "## Processed\n- https://a.org/x \u2014 discarded\n",
   "key": "https://a.org/x",
   "priority": "low",
   "none": true
  }
 ],
 "closes": [
  {
   "name": "under the processed ones, at their end",
   "text": "# Inbox\n\n- https://a.org/x \u2014 why \u00b7 high \u00b7 added 2026-11-01\n- https://b.org/y\n\n## Processed\n\n- 2026-11-10 https://c.org/z \u2014 discarded\n",
   "key": "https://a.org/x",
   "today": "2026-11-23",
   "want": "# Inbox\n\n- https://b.org/y\n\n## Processed\n\n- 2026-11-10 https://c.org/z \u2014 discarded\n- 2026-11-23 https://a.org/x \u2014 discarded\n",
   "processed": {
    "date": "2026-11-23",
    "key": "https://a.org/x",
    "title": "",
    "outcome": "discarded"
   }
  },
  {
   "name": "no processed ones yet: the heading is made",
   "text": "# Inbox\n\n- https://a.org/x\n",
   "key": "https://a.org/x",
   "today": "2026-11-23",
   "want": "# Inbox\n\n## Processed\n\n- 2026-11-23 https://a.org/x \u2014 discarded\n"
  },
  {
   "name": "the only line of the file",
   "text": "- https://a.org/x",
   "key": "https://a.org/x",
   "today": "2026-11-23",
   "want": "## Processed\n\n- 2026-11-23 https://a.org/x \u2014 discarded\n"
  },
  {
   "name": "its brief goes with it",
   "text": "- https://a.org/x \u2014 why\n  - briefed 2026-11-20: claims x\n  - touches R07\n- https://b.org/y\n\n## Processed\n",
   "key": "https://a.org/x",
   "today": "2026-11-23",
   "want": "- https://b.org/y\n\n## Processed\n\n- 2026-11-23 https://a.org/x \u2014 discarded\n"
  },
  {
   "name": "its title goes with it, the address as it opens",
   "text": "- [A title](https://arxiv.org/pdf/2406.01234v2) \u2014 why\n\n## Processed\n\n- 2026-11-10 https://c.org/z \u2192 R03\n",
   "key": "arxiv:2406.01234",
   "today": "2026-11-23",
   "want": "## Processed\n\n- 2026-11-10 https://c.org/z \u2192 R03\n- 2026-11-23 [A title](https://arxiv.org/abs/2406.01234) \u2014 discarded\n",
   "processed": {
    "date": "2026-11-23",
    "key": "arxiv:2406.01234",
    "title": "A title",
    "outcome": "discarded"
   }
  },
  {
   "name": "no newline at the end",
   "text": "- https://a.org/x\n- https://b.org/y",
   "key": "https://b.org/y",
   "today": "2026-11-23",
   "want": "- https://a.org/x\n\n## Processed\n\n- 2026-11-23 https://b.org/y \u2014 discarded\n"
  },
  {
   "name": "CRLF",
   "text": "# Inbox\r\n\r\n- https://a.org/x\r\n- https://b.org/y\r\n\r\n## Processed\r\n\r\n- 2026-11-10 https://c.org/z \u2014 discarded\r\n",
   "key": "https://a.org/x",
   "today": "2026-11-23",
   "want": "# Inbox\r\n\r\n- https://b.org/y\r\n\r\n## Processed\r\n\r\n- 2026-11-10 https://c.org/z \u2014 discarded\r\n- 2026-11-23 https://a.org/x \u2014 discarded\r\n"
  },
  {
   "name": "a heading after the processed ones: before it, a blank line between",
   "text": "# Inbox\n- https://a.org/x\n\n## Processed\n- 2026-11-10 https://c.org/z \u2014 discarded\n## Notes\nkeep\n",
   "key": "https://a.org/x",
   "today": "2026-11-23",
   "want": "# Inbox\n\n## Processed\n- 2026-11-10 https://c.org/z \u2014 discarded\n- 2026-11-23 https://a.org/x \u2014 discarded\n\n## Notes\nkeep\n"
  },
  {
   "name": "the heading in small letters",
   "text": "- https://a.org/x\n\n## processed\n",
   "key": "https://a.org/x",
   "today": "2026-11-23",
   "want": "## processed\n\n- 2026-11-23 https://a.org/x \u2014 discarded\n"
  },
  {
   "name": "the second of two with one link: its own address",
   "text": "- https://a.org/x\n- https://a.org/x/ \u2014 again\n",
   "key": "https://a.org/x",
   "nth": 1,
   "today": "2026-11-23",
   "want": "- https://a.org/x\n\n## Processed\n\n- 2026-11-23 https://a.org/x/ \u2014 discarded\n"
  },
  {
   "name": "an outcome with its reason",
   "text": "- https://a.org/x\n",
   "key": "https://a.org/x",
   "today": "2026-11-23",
   "outcome": " discarded:  superseded\nby R07 ",
   "want": "## Processed\n\n- 2026-11-23 https://a.org/x \u2014 discarded: superseded by R07\n",
   "processed": {
    "date": "2026-11-23",
    "key": "https://a.org/x",
    "title": "",
    "outcome": "discarded: superseded by R07"
   }
  },
  {
   "name": "between two blank lines: one is left",
   "text": "# Inbox\n\n- https://a.org/x\n\n### later\n- https://b.org/y\n",
   "key": "https://a.org/x",
   "today": "2026-11-23",
   "want": "# Inbox\n\n### later\n- https://b.org/y\n\n## Processed\n\n- 2026-11-23 https://a.org/x \u2014 discarded\n"
  },
  {
   "name": "no day",
   "text": "- https://a.org/x\n",
   "key": "https://a.org/x",
   "today": "",
   "want": "## Processed\n\n- https://a.org/x \u2014 discarded\n",
   "processed": {
    "date": "",
    "key": "https://a.org/x",
    "title": "",
    "outcome": "discarded"
   }
  },
  {
   "name": "no item has the link",
   "text": "- https://a.org/x\n",
   "key": "https://b.org/y",
   "today": "2026-11-23",
   "none": true
  },
  {
   "name": "a processed item is not in the inbox",
   "text": "## Processed\n- https://a.org/x \u2014 discarded\n",
   "key": "https://a.org/x",
   "today": "2026-11-23",
   "none": true
  },
  {
   "name": "the note it became: an arrow, no dash",
   "text": "- [A title](https://a.org/x) \u2014 why \u00b7 urgent\n  - briefed 2026-11-20: claims x\n\n## Processed\n\n- 2026-11-10 https://c.org/z \u2014 discarded\n",
   "key": "https://a.org/x",
   "today": "2026-11-23",
   "outcome": "\u2192 R15",
   "want": "## Processed\n\n- 2026-11-10 https://c.org/z \u2014 discarded\n- 2026-11-23 [A title](https://a.org/x) \u2192 R15\n",
   "processed": {
    "date": "2026-11-23",
    "key": "https://a.org/x",
    "title": "A title",
    "outcome": "R15"
   }
  },
  {
   "name": "a direction and the reference it cites",
   "text": "- 2406.01234\n",
   "key": "arxiv:2406.01234",
   "today": "2026-11-23",
   "outcome": "\u2192  D12, citing R15 ",
   "want": "## Processed\n\n- 2026-11-23 https://arxiv.org/abs/2406.01234 \u2192 D12, citing R15\n",
   "processed": {
    "date": "2026-11-23",
    "key": "arxiv:2406.01234",
    "title": "",
    "outcome": "D12, citing R15"
   }
  },
  {
   "name": "an arrow inside an outcome is the outcome's",
   "text": "- https://a.org/x\n",
   "key": "https://a.org/x",
   "today": "2026-11-23",
   "outcome": "discarded: A \u2192 B is known",
   "want": "## Processed\n\n- 2026-11-23 https://a.org/x \u2014 discarded: A \u2192 B is known\n",
   "processed": {
    "date": "2026-11-23",
    "key": "https://a.org/x",
    "title": "",
    "outcome": "discarded: A \u2192 B is known"
   }
  },
  {
   "name": "the first of two with one link: the other stays",
   "text": "- https://a.org/x \u2014 one\n  - briefed 2026-11-20: claims x\n- https://a.org/x#top \u2014 two\n",
   "key": "https://a.org/x",
   "today": "2026-11-23",
   "outcome": "\u2192 R15",
   "want": "- https://a.org/x#top \u2014 two\n\n## Processed\n\n- 2026-11-23 https://a.org/x \u2192 R15\n"
  }
 ],
 "briefs": [
  {
   "name": "three lines under the item",
   "text": "# Inbox\n\n- https://a.org/x \u2014 why \u00b7 high\n- https://b.org/y\n",
   "key": "https://a.org/x",
   "today": "2026-11-23",
   "brief": "claims x\ntouches R07, E12\nrecommends: reference under D04",
   "want": "# Inbox\n\n- https://a.org/x \u2014 why \u00b7 high\n  - briefed 2026-11-23: claims x\n  - touches R07, E12\n  - recommends: reference under D04\n- https://b.org/y\n",
   "is": {
    "date": "2026-11-23",
    "lines": [
     "claims x",
     "touches R07, E12",
     "recommends: reference under D04"
    ]
   }
  },
  {
   "name": "a brief there already is replaced, whole",
   "text": "- https://a.org/x\n  - briefed 2026-11-20: old\n  - old two\n  - old three\n- https://b.org/y\n",
   "key": "https://a.org/x",
   "today": "2026-11-23",
   "brief": "new",
   "want": "- https://a.org/x\n  - briefed 2026-11-23: new\n- https://b.org/y\n",
   "is": {
    "date": "2026-11-23",
    "lines": [
     "new"
    ]
   }
  },
  {
   "name": "the user's lines under an item are kept, after it",
   "text": "- https://a.org/x\n    * from Bea\n",
   "key": "https://a.org/x",
   "today": "2026-11-23",
   "brief": "claims x",
   "want": "- https://a.org/x\n  - briefed 2026-11-23: claims x\n    * from Bea\n",
   "is": {
    "date": "2026-11-23",
    "lines": [
     "claims x",
     "from Bea"
    ]
   }
  },
  {
   "name": "the last line of a file with no newline at its end",
   "text": "- https://a.org/x",
   "key": "https://a.org/x",
   "today": "2026-11-23",
   "brief": "claims x\nrecommends: later",
   "want": "- https://a.org/x\n  - briefed 2026-11-23: claims x\n  - recommends: later",
   "is": {
    "date": "2026-11-23",
    "lines": [
     "claims x",
     "recommends: later"
    ]
   }
  },
  {
   "name": "CRLF",
   "text": "- https://a.org/x\r\n  - briefed 2026-11-20: old\r\n\r\n## Processed\r\n",
   "key": "https://a.org/x",
   "today": "2026-11-23",
   "brief": "claims x\r\ntouches nothing",
   "want": "- https://a.org/x\r\n  - briefed 2026-11-23: claims x\r\n  - touches nothing\r\n\r\n## Processed\r\n",
   "is": {
    "date": "2026-11-23",
    "lines": [
     "claims x",
     "touches nothing"
    ]
   }
  },
  {
   "name": "typed as a list, with its own date, blank lines between",
   "text": "- https://a.org/x\n",
   "key": "https://a.org/x",
   "today": "2026-11-23",
   "brief": "- briefed 2026-11-01: claims  x\n\n * touches R07\n",
   "want": "- https://a.org/x\n  - briefed 2026-11-23: claims x\n  - touches R07\n",
   "is": {
    "date": "2026-11-23",
    "lines": [
     "claims x",
     "touches R07"
    ]
   }
  },
  {
   "name": "the second of two with one link",
   "text": "- https://a.org/x\n- https://a.org/x/\n",
   "key": "https://a.org/x",
   "nth": 1,
   "today": "2026-11-23",
   "brief": "claims x",
   "want": "- https://a.org/x\n- https://a.org/x/\n  - briefed 2026-11-23: claims x\n",
   "is": {
    "date": "2026-11-23",
    "lines": [
     "claims x"
    ]
   }
  },
  {
   "name": "four lines are one too many",
   "text": "- https://a.org/x\n",
   "key": "https://a.org/x",
   "today": "2026-11-23",
   "brief": "a\nb\nc\nd",
   "error": true
  },
  {
   "name": "nothing said",
   "text": "- https://a.org/x\n",
   "key": "https://a.org/x",
   "today": "2026-11-23",
   "brief": " \n - \n",
   "error": true
  },
  {
   "name": "a line too long to read in a minute",
   "text": "- https://a.org/x\n",
   "key": "https://a.org/x",
   "today": "2026-11-23",
   "brief": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
   "error": true
  },
  {
   "name": "no item has the link",
   "text": "- https://a.org/x\n",
   "key": "https://b.org/y",
   "today": "2026-11-23",
   "brief": "claims x",
   "none": true
  }
 ]
}
