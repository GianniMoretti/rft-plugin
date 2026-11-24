// Copied from tests/fixtures/local-overleaf/ by tests/fixtures/local-overleaf/to_ts.py: edit those files, then run it.
export const FILES: Record<string, string> = {
 ".rft/config.json": "{\"version\": 2, \"vault\": \"vault\", \"project\": \"cutmix\", \"canvas\": false, \"mermaid\": false, \"lastId\": {\"E\": 8, \"D\": 1, \"T\": 2, \"R\": 7}}\n",
 "vault/00 Index.md": "---\ntype: index\n---\n\n# cutmix\n\n## The tree\n\n## Elsewhere\nNothing.\n",
 "vault/directions/D01 Does CutMix help with little data.md": "---\nid: D01\ntype: direction\nstatus: done\ndate: 2026-11-01\nparent: \"\"\nchildren: [\"[[T02 What CutMix computes]]\", \"[[E05 CutMix at 1k images]]\", \"[[R07 CutMix]]\"]\ntags: [cutmix, direction, done]\n---\n\n# D01 · Does CutMix help with little data\n\n**Parent:** (root)\n**Status:** done · **Date:** 2026-11-01\n\n## Idea\nLabelled images are scarce in applied settings; test CutMix with a thousand images.\n\n## Why\nAugmentations are tuned on the full set.\n\n## Status\nDone.\n\n## Children in the tree\n- [[T02 What CutMix computes]]\n- [[E05 CutMix at 1k images]]\n- [[R07 CutMix]]\n",
 "vault/documents/.rft/paper/tracking.json": "{\n  \"version\": 1,\n  \"main\": \"main.tex\",\n  \"copies\": [\n    {\n      \"snippet\": \"S05\",\n      \"marker\": \"Motivation: Why low data\",\n      \"file\": \"main.tex\",\n      \"stamp\": \"47ae7c0d\",\n      \"placed\": \"Labelled images are scarce in most applied settings, and augmentations tuned on the full ImageNet\\nare rarely tested with a thousand images or fewer.\"\n    },\n    {\n      \"snippet\": \"S01\",\n      \"marker\": \"Definition: CutMix\",\n      \"file\": \"main.tex\",\n      \"stamp\": \"2a248ff2\",\n      \"placed\": \"\\\\begin{definition}[CutMix]\\\\label{def:cutmix}\\nGiven two labelled images $(x_A, y_A)$ and $(x_B, y_B)$, CutMix~\\\\cite{yun2019cutmix} forms\\n$\\\\tilde{x} = M \\\\odot x_A + (1 - M) \\\\odot x_B$ and $\\\\tilde{y} = \\\\lambda y_A + (1 - \\\\lambda) y_B$,\\nwhere $M$ is a binary box mask and $\\\\lambda$ is the fraction of $x_A$ that it keeps.\\n\\\\end{definition}\"\n    },\n    {\n      \"snippet\": \"S01\",\n      \"marker\": \"Definition: CutMix\",\n      \"file\": \"sections/method.tex\",\n      \"stamp\": \"2a248ff2\",\n      \"placed\": \"\\\\begin{definition}[CutMix]\\\\label{def:cutmix}\\nGiven two labelled images $(x_A, y_A)$ and $(x_B, y_B)$, CutMix~\\\\cite{yun2019cutmix} forms\\n$\\\\tilde{x} = M \\\\odot x_A + (1 - M) \\\\odot x_B$ and $\\\\tilde{y} = \\\\lambda y_A + (1 - \\\\lambda) y_B$,\\nwhere $M$ is a binary box mask and $\\\\lambda$ is the fraction of $x_A$ that it keeps.\\n\\\\end{definition}\"\n    },\n    {\n      \"snippet\": \"S04\",\n      \"marker\": \"Method: Training setup\",\n      \"file\": \"sections/method.tex\",\n      \"stamp\": \"df889d41\",\n      \"placed\": \"We train a ResNet-50 for 200 epochs with SGD, a cosine schedule and a batch size of 256. CutMix is\\napplied to every batch with $\\\\lambda \\\\sim \\\\mathrm{Beta}(1, 1)$.\"\n    },\n    {\n      \"snippet\": \"S03\",\n      \"marker\": \"Figure: Training loss\",\n      \"file\": \"sections/method.tex\",\n      \"stamp\": \"913f49be\",\n      \"placed\": \"\\\\begin{figure}[t]\\n  \\\\centering\\n  \\\\includegraphics[width=.8\\\\linewidth]{figures/loss.pdf}\\n  \\\\caption{Training loss}\\\\label{fig:training-loss}\\n\\\\end{figure}\"\n    },\n    {\n      \"snippet\": \"S07\",\n      \"marker\": \"Lemma: Mixing bound\",\n      \"file\": \"sections/method.tex\",\n      \"stamp\": \"b0a0fad8\",\n      \"placed\": \"\\\\begin{lemma}[Mixing bound]\\\\label{lem:mixing-bound}\\nThe mixed label $\\\\tilde{y}$ lies in the convex hull of $y_A$ and $y_B$.\\n\\\\end{lemma}\"\n    },\n    {\n      \"snippet\": \"S02\",\n      \"marker\": \"Result: CutMix at 1k images\",\n      \"file\": \"main.tex\",\n      \"stamp\": \"ac5a9b18\",\n      \"placed\": \"\\\\paragraph{CutMix at 1k images.}\\nWith 1k labelled images, CutMix reaches 73.2\\\\% top-1 accuracy, against 81.4\\\\% when trained on the\\nfull set.\"\n    },\n    {\n      \"snippet\": \"S06\",\n      \"marker\": \"Discussion: Limitations\",\n      \"file\": \"main.tex\",\n      \"stamp\": \"5dca5cfb\",\n      \"placed\": \"Our study uses one architecture and one dataset. Whether the gain holds for vision transformers is\\nleft open.\"\n    }\n  ],\n  \"values\": [\n    {\n      \"kind\": \"number\",\n      \"from\": \"E05\",\n      \"key\": \"acc.1k\",\n      \"written\": \"73.2\",\n      \"file\": \"main.tex\",\n      \"before\": \"available. It reaches \",\n      \"after\": \"\\\\% top-1\\naccuracy, most of\"\n    },\n    {\n      \"kind\": \"number\",\n      \"from\": \"E05\",\n      \"key\": \"acc.1k\",\n      \"written\": \"73.2\",\n      \"file\": \"main.tex\",\n      \"before\": \"images, CutMix reaches \",\n      \"after\": \"\\\\% top-1 accuracy, against \"\n    },\n    {\n      \"kind\": \"number\",\n      \"from\": \"E05\",\n      \"key\": \"acc.full\",\n      \"written\": \"81.4\",\n      \"file\": \"main.tex\",\n      \"before\": \"\\\\% top-1 accuracy, against \",\n      \"after\": \"\\\\% when trained on the\\nfull\"\n    },\n    {\n      \"kind\": \"number\",\n      \"from\": \"E05\",\n      \"key\": \"seeds\",\n      \"written\": \"3\",\n      \"file\": \"sections/method.tex\",\n      \"before\": \"numbers are averaged over \",\n      \"after\": \" seeds.\"\n    },\n    {\n      \"kind\": \"figure\",\n      \"from\": \"E08\",\n      \"key\": \"loss\",\n      \"written\": \"figures/loss.pdf\",\n      \"file\": \"sections/method.tex\",\n      \"before\": \"\\\\includegraphics[width=.8\\\\linewidth]{\",\n      \"after\": \"}\\n  \\\\caption{Training loss}\"\n    }\n  ],\n  \"bib\": {\n    \"yun2019cutmix\": {\n      \"from\": \"R07\",\n      \"file\": \"refs.bib\"\n    }\n  },\n  \"allowed\": []\n}\n",
 "vault/documents/documents.json": "{\n  \"locked\": true,\n  \"unlocked\": []\n}\n",
 "vault/documents/paper/figures/loss.pdf": "%PDF stand-in 710cb71bf335\n",
 "vault/documents/paper/main.tex": "\\documentclass[11pt]{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage[T1]{fontenc}\n\\usepackage{amsmath,amssymb,amsthm}\n\\usepackage{graphicx,booktabs}\n\\usepackage[numbers]{natbib}\n\\usepackage{hyperref}\n\n\\newtheorem{definition}{Definition}\n\\newtheorem{lemma}{Lemma}\n\n\\title{CutMix in the low-data regime}\n\\author{A. Author \\and B. Coauthor}\n\\date{}\n\n\\begin{document}\n\\maketitle\n\n\\begin{abstract}\nWe study CutMix when only a thousand labelled images are available. It reaches 73.2\\% top-1\naccuracy, most of the way to training on the full set.\n\\end{abstract}\n\n\\section{Introduction}\n\nMixing augmentations such as mixup~\\cite{zhang2018mixup} and CutMix~\\cite{yun2019cutmix} are standard\nwhen data is plentiful.\nLabelled images are scarce in most applied settings, and augmentations tuned on the full ImageNet\nare rarely tested with a thousand images or fewer.\n\n%%% Definition: CutMix %%%\n\\begin{definition}[CutMix]\\label{def:cutmix}\nGiven two labelled images $(x_A, y_A)$ and $(x_B, y_B)$, CutMix~\\cite{yun2019cutmix} forms\n$\\tilde{x} = M \\odot x_A + (1 - M) \\odot x_B$ and $\\tilde{y} = \\lambda y_A + (1 - \\lambda) y_B$,\nwhere $M$ is a binary box mask and $\\lambda$ is the fraction of $x_A$ that it keeps.\n\\end{definition}\n%%% end %%%\n\n\\input{sections/method}\n\n\\section{Results}\n\n%%% Result: CutMix at 1k images %%%\n\\paragraph{CutMix at 1k images.}\nWith 1k labelled images, CutMix reaches 73.2\\% top-1 accuracy, against 81.4\\% when trained on the\nfull set.\n%%% end %%%\n\n\\section{Discussion}\n\nWe only looked at ResNet-50 on ImageNet subsets, so these findings may not transfer to other\nbackbones; a co-author rewrote this paragraph in Overleaf.\n\n\\bibliographystyle{plainnat}\n\\bibliography{refs}\n\\end{document}\n",
 "vault/documents/paper/refs.bib": "@inproceedings{yun2019cutmix,\n  title     = {CutMix: Regularization Strategy to Train Strong Classifiers with Localizable Features},\n  author    = {Yun, Sangdoo and Han, Dongyoon and Oh, Seong Joon and Chun, Sanghyuk and Choe, Junsuk and Yoo, Youngjoon},\n  booktitle = {ICCV},\n  year      = {2019}\n}\n\n@inproceedings{zhang2018mixup,\n  title     = {mixup: Beyond Empirical Risk Minimization},\n  author    = {Zhang, Hongyi and Cisse, Moustapha and Dauphin, Yann N. and Lopez-Paz, David},\n  booktitle = {ICLR},\n  year      = {2018}\n}\n",
 "vault/documents/paper/sections/method.tex": "\\section{Method}\n\n%%% Definition: CutMix %%%\nRecall that CutMix pastes a box of one image onto another and mixes the two labels in\nproportion to the area that each image keeps.\n%%% end %%%\n\n%%% Method: Training setup %%%\nWe train a ResNet-50 for 200 epochs with SGD, a cosine schedule and a batch size of 256. CutMix is\napplied to every batch with $\\lambda \\sim \\mathrm{Beta}(1, 1)$.\n%%% end %%%\nAll numbers are averaged over 5 seeds.\n\n%%% Figure: Training loss %%%\n\\begin{figure}[t]\n  \\centering\n  \\includegraphics[width=.8\\linewidth]{figures/loss.pdf}\n  \\caption{Training loss}\\label{fig:training-loss}\n\\end{figure}\n%%% end %%%\n\n%%% Lemma: Mixing bound %%%\n\\begin{lemma}[Mixing bound]\\label{lem:mixing-bound}\nThe mixed label $\\tilde{y}$ lies in the convex hull of $y_A$ and $y_B$.\n\\end{lemma}\n%%% end %%%\n",
 "vault/experiments/E05 CutMix at 1k images.md": "---\nid: E05\ntype: experiment\nstatus: verified\ndate: 2026-11-05\nparent: \"[[D01 Does CutMix help with little data]]\"\nchildren: [\"[[E08 Training curves]]\"]\ntags: [cutmix, experiment, verified]\n---\n\n# E05 · CutMix at 1k images\n\n**Parent:** [[D01 Does CutMix help with little data]]\n**Status:** verified · **Date:** 2026-11-01\n\n## What\nResNet-50, 300 epochs, 1k labelled images, 3 seeds.\n\n## Result\n73.2% top-1 at 1k images, 81.6% on the full set.\n\n## Children in the tree\n- [[E08 Training curves]]\n",
 "vault/experiments/E08 Training curves.md": "---\nid: E08\ntype: experiment\nstatus: verified\ndate: 2026-11-08\nparent: \"[[E05 CutMix at 1k images]]\"\nchildren: []\ntags: [cutmix, experiment, verified]\n---\n\n# E08 · Training curves\n\n**Parent:** [[E05 CutMix at 1k images]]\n**Status:** verified · **Date:** 2026-11-01\n\n## What\nThe loss of the runs of E05.\n\n## Result\nThe loss flattens after epoch 200.\n\n## Children in the tree\n\n",
 "vault/figures/E08_loss.pdf": "%PDF stand-in 710cb71bf335\n",
 "vault/figures/E08_loss.svg": "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 80 40\"><path d=\"M2 4 Q 20 34 78 36\" fill=\"none\" stroke=\"#4D4875\"/></svg>\n",
 "vault/references/R07 CutMix.md": "---\nid: R07\ntype: reference\nstatus: verified\ndate: 2026-11-07\nparent: \"[[D01 Does CutMix help with little data]]\"\nchildren: []\ntags: [cutmix, reference, verified]\n---\n\n# R07 · CutMix\n\n**Parent:** [[D01 Does CutMix help with little data]]\n**Status:** verified · **Date:** 2026-11-01\n\n## Source\nYun et al. 2019, arXiv:1905.04899\n```bibtex\n@inproceedings{yun2019cutmix,\n  title     = {CutMix: Regularization Strategy to Train Strong Classifiers with Localizable Features},\n  author    = {Yun, Sangdoo and Han, Dongyoon and Oh, Seong Joon and Chun, Sanghyuk and Choe, Junsuk and Yoo, Youngjoon},\n  booktitle = {ICCV},\n  year      = {2019}\n}\n```\n\n## Key results\nCutMix improves ImageNet top-1 over mixup and Cutout.\n\n## Children in the tree\n\n",
 "vault/results/E05.json": "{\n \"exp\": \"E05\",\n \"date\": \"2026-11-20\",\n \"results\": {\n  \"acc\": {\n   \"1k\": 73.2,\n   \"full\": 81.6\n  },\n  \"seeds\": 3\n },\n \"figures\": [],\n \"tables\": []\n}\n",
 "vault/results/E08.json": "{\n \"exp\": \"E08\",\n \"date\": \"2026-11-20\",\n \"results\": {},\n \"figures\": [\n  \"figures/E08_loss.svg\"\n ],\n \"tables\": []\n}\n",
 "vault/snippets/S01.tex": "% rft-snippet S01 · definition · CutMix\n% basis: T02, R07\n\\begin{definition}[CutMix]\\label{S01}\nGiven two labelled images $(x_A, y_A)$ and $(x_B, y_B)$, CutMix~\\cite{R07} forms\n$\\tilde{x} = M \\odot x_A + (1 - M) \\odot x_B$ and $\\tilde{y} = \\lambda y_A + (1 - \\lambda) y_B$,\nwhere $M$ is a binary box mask and $\\lambda$ is the fraction of $x_A$ that it keeps.\n\\end{definition}\n",
 "vault/snippets/S02.tex": "% rft-snippet S02 · result · CutMix at 1k images\n% basis: E05\n\\paragraph{CutMix at 1k images.}\nWith 1k labelled images, CutMix reaches \\rftnum{E05}{acc.1k}\\% top-1 accuracy, against \\rftnum{E05}{acc.full}\\% when trained on the\nfull set.\n",
 "vault/snippets/S03.tex": "% rft-snippet S03 · figure · Training loss\n% basis: E08\n\\begin{figure}[t]\n  \\centering\n  \\rftfig[width=.8\\linewidth]{E08}{loss}\n  \\caption{Training loss}\\label{S03}\n\\end{figure}\n",
 "vault/snippets/S04.tex": "% rft-snippet S04 · method · Training setup\n% basis: E05\nWe train a ResNet-50 for 300 epochs with SGD, a cosine schedule and a batch size of 256. CutMix is\napplied to every batch with $\\lambda \\sim \\mathrm{Beta}(1, 1)$.\n",
 "vault/snippets/S05.tex": "% rft-snippet S05 · motivation · Why low data\n% basis: D01\nLabelled images are scarce in most applied settings, and augmentations tuned on the full ImageNet\nare rarely tested with a thousand images or fewer.\n",
 "vault/snippets/S06.tex": "% rft-snippet S06 · discussion · Limitations\n% basis: E05\nOur study uses one architecture and one dataset. Whether the gain holds for vision transformers is\nleft open.\n",
 "vault/snippets/snippets.json": "{\n  \"locked\": true,\n  \"next\": 8,\n  \"snippets\": {},\n  \"unlocked\": []\n}\n",
 "vault/theory/T02 What CutMix computes.md": "---\nid: T02\ntype: theory\nstatus: verified\ndate: 2026-11-02\nparent: \"[[D01 Does CutMix help with little data]]\"\nchildren: []\ntags: [cutmix, theory, verified]\n---\n\n# T02 · What CutMix computes\n\n**Parent:** [[D01 Does CutMix help with little data]]\n**Status:** verified · **Date:** 2026-11-01\n\n## Statement\nCutMix mixes two images with a box mask and their labels by the kept area.\n\n## Explanation\nThe mask is binary; lambda is the kept fraction.\n\n## Children in the tree\n\n"
}
export const EXPECTED = {
 "copies": [
  {
   "snippet": "S05",
   "file": "main.tex",
   "order": 1,
   "state": "placed",
   "markers": false,
   "why": "markers deleted, text intact: found by its text",
   "marker": "Motivation: Why low data"
  },
  {
   "snippet": "S01",
   "file": "main.tex",
   "order": 2,
   "state": "placed",
   "markers": true,
   "why": "",
   "marker": "Definition: CutMix"
  },
  {
   "snippet": "S01",
   "file": "sections/method.tex",
   "order": 3,
   "state": "adapted",
   "markers": true,
   "why": "second copy of the same snippet, reworded",
   "marker": "Definition: CutMix"
  },
  {
   "snippet": "S04",
   "file": "sections/method.tex",
   "order": 4,
   "state": "review",
   "markers": true,
   "why": "the snippet now says 300 epochs",
   "marker": "Method: Training setup"
  },
  {
   "snippet": "S03",
   "file": "sections/method.tex",
   "order": 5,
   "state": "placed",
   "markers": true,
   "why": "",
   "marker": "Figure: Training loss"
  },
  {
   "snippet": "S07",
   "file": "sections/method.tex",
   "order": 6,
   "state": "gone",
   "markers": true,
   "why": "no snippet S07 in the vault",
   "marker": "Lemma: Mixing bound"
  },
  {
   "snippet": "S02",
   "file": "main.tex",
   "order": 7,
   "state": "placed",
   "markers": true,
   "why": "its text is the snippet written out as placed; one of its numbers is in review, below",
   "marker": "Result: CutMix at 1k images"
  },
  {
   "snippet": "S06",
   "file": null,
   "order": null,
   "state": "lost",
   "markers": false,
   "why": "markers deleted and text rewritten",
   "marker": "Discussion: Limitations"
  }
 ],
 "usedIn": {
  "S01": {
   "main.tex": 1,
   "sections/method.tex": 1
  },
  "S02": {
   "main.tex": 1
  },
  "S03": {
   "sections/method.tex": 1
  },
  "S04": {
   "sections/method.tex": 1
  },
  "S05": {
   "main.tex": 1
  }
 },
 "values": [
  {
   "kind": "number",
   "file": "main.tex",
   "from": "E05",
   "state": "current",
   "inCopyOf": null,
   "why": "in the abstract, outside any copy",
   "key": "acc.1k"
  },
  {
   "kind": "number",
   "file": "main.tex",
   "from": "E05",
   "state": "current",
   "inCopyOf": "S02",
   "why": "",
   "key": "acc.1k"
  },
  {
   "kind": "number",
   "file": "main.tex",
   "from": "E05",
   "state": "review",
   "inCopyOf": "S02",
   "why": "written 81.4, the tree now says 81.6",
   "key": "acc.full"
  },
  {
   "kind": "number",
   "file": "sections/method.tex",
   "from": "E05",
   "state": "changed",
   "inCopyOf": null,
   "why": "written 3, the text now says 5, the tree says 3",
   "key": "seeds"
  },
  {
   "kind": "figure",
   "file": "sections/method.tex",
   "from": "E08",
   "state": "current",
   "inCopyOf": "S03",
   "why": "",
   "key": "loss"
  }
 ],
 "bib": {
  "yun2019cutmix": "R07",
  "zhang2018mixup": null
 },
 "scan": []
}
export const TRACES = {
 "ids": [
  "D01",
  "T02",
  "E05",
  "E08",
  "R07",
  "S01",
  "S02",
  "S03",
  "S04",
  "S05",
  "S06"
 ],
 "treeKeys": [
  "yun2019cutmix",
  "R07"
 ],
 "cases": [
  {
   "why": "plain LaTeX with a marker of the new kind: nothing",
   "files": {
    "main.tex": "%%% Definition: CutMix %%%\n\\begin{definition}[CutMix]\\label{def:cutmix}\nMixes two images.\n\\end{definition}\n%%% end %%%\n"
   },
   "traces": []
  },
  {
   "why": "a macro of the plugin and its package",
   "files": {
    "main.tex": "\\usepackage{rft}\nIt reaches \\rftnum{X1}{acc}\\% and \\rftfig[width=1cm]{X1}{loss}.\n"
   },
   "traces": [
    {
     "file": "main.tex",
     "line": 1,
     "kind": "plugin",
     "match": "rft"
    },
    {
     "file": "main.tex",
     "line": 2,
     "kind": "plugin",
     "match": "\\rftnum"
    },
    {
     "file": "main.tex",
     "line": 2,
     "kind": "plugin",
     "match": "\\rftfig"
    }
   ]
  },
  {
   "why": "the markers of the first design, with the snippet's id in them",
   "files": {
    "main.tex": "% rft-begin S04 3f2a1c9d\nText.\n% rft-end S04\n"
   },
   "traces": [
    {
     "file": "main.tex",
     "line": 1,
     "kind": "marker",
     "match": "rft-begin"
    },
    {
     "file": "main.tex",
     "line": 1,
     "kind": "id",
     "match": "S04"
    },
    {
     "file": "main.tex",
     "line": 3,
     "kind": "marker",
     "match": "rft-end"
    },
    {
     "file": "main.tex",
     "line": 3,
     "kind": "id",
     "match": "S04"
    }
   ]
  },
  {
   "why": "the id of a note in the words, in a comment and in a label; an id that is no note's is the user's own",
   "files": {
    "sections/method.tex": "As E05 shows (Table S1, Figure A12, model B2).\n% from E08\n\\label{fig:E08_loss}\nThe words craft, RFT and E055 are no trace, nor is xE05 or E05b.\n"
   },
   "traces": [
    {
     "file": "sections/method.tex",
     "line": 1,
     "kind": "id",
     "match": "E05"
    },
    {
     "file": "sections/method.tex",
     "line": 2,
     "kind": "id",
     "match": "E08"
    },
    {
     "file": "sections/method.tex",
     "line": 3,
     "kind": "id",
     "match": "E08"
    }
   ]
  },
  {
   "why": "a snippet's title that carries an id is flagged in its marker",
   "files": {
    "main.tex": "%%% Result: What E05 found %%%\nText.\n%%% end %%%\n"
   },
   "traces": [
    {
     "file": "main.tex",
     "line": 1,
     "kind": "id",
     "match": "E05"
    }
   ]
  },
  {
   "why": "ids and the plugin's names in the names of files and folders; a figure's content is not read",
   "files": {
    "figures/E08_loss.pdf": null,
    "rft.sty": "\\ProvidesPackage{mine}\n",
    "S01/notes.txt": "nothing\n",
    "figures/loss.pdf": null
   },
   "traces": [
    {
     "file": "S01/notes.txt",
     "line": null,
     "kind": "id",
     "match": "S01"
    },
    {
     "file": "figures/E08_loss.pdf",
     "line": null,
     "kind": "id",
     "match": "E08"
    },
    {
     "file": "rft.sty",
     "line": null,
     "kind": "plugin",
     "match": "rft"
    }
   ]
  },
  {
   "why": "an entry of the tree that the document does not cite; the user's own entry is not the tree's; an entry keyed by a note's id",
   "files": {
    "main.tex": "Mixup~\\citep[see][p. 3]{zhang2018mixup} is older. % \\cite{yun2019cutmix}\n",
    "refs.bib": "@inproceedings{yun2019cutmix,\n  title = {CutMix}\n}\n\n@inproceedings{zhang2018mixup,\n  title = {mixup}\n}\n\n@misc{unread2020,\n  title = {Never cited, not the tree's}\n}\n\n@misc{R07,\n  title = {CutMix}\n}\n"
   },
   "traces": [
    {
     "file": "refs.bib",
     "line": 1,
     "kind": "reference",
     "match": "yun2019cutmix"
    },
    {
     "file": "refs.bib",
     "line": 13,
     "kind": "id",
     "match": "R07"
    },
    {
     "file": "refs.bib",
     "line": 13,
     "kind": "reference",
     "match": "R07"
    }
   ]
  },
  {
   "why": "cited from any file of the document, among other keys; \\nocite{*} cites everything",
   "files": {
    "main.tex": "\\input{sections/intro}\n\\nocite{*}\n",
    "sections/intro.tex": "As shown~\\cite{other2020, yun2019cutmix}.\n",
    "refs.bib": "@inproceedings{yun2019cutmix,\n  title = {CutMix}\n}\n"
   },
   "traces": []
  },
  {
   "why": "an occurrence the user allowed is not flagged again; the same id on another line is",
   "files": {
    "main.tex": "See Table S01 of the supplement.\nAnd S01 again.\n"
   },
   "allowed": [
    {
     "file": "main.tex",
     "match": "S01",
     "text": "See Table S01 of the supplement."
    }
   ],
   "traces": [
    {
     "file": "main.tex",
     "line": 2,
     "kind": "id",
     "match": "S01"
    }
   ],
   "allowedCount": 1
  }
 ]
}
// the same document as the first design had it (before), and as its conversion must leave it (after: its folder, and tracking.json)
export const FIRST_DESIGN: { before: Record<string, string>; after: Record<string, string>; expected: { copies: { snippet: string; state: string }[] } } = {
 "expected": {
  "copies": [
   {
    "snippet": "S01",
    "state": "placed"
   },
   {
    "snippet": "S04",
    "state": "review"
   },
   {
    "snippet": "S03",
    "state": "placed"
   },
   {
    "snippet": "S02",
    "state": "adapted"
   },
   {
    "snippet": "S07",
    "state": "gone"
   }
  ]
 },
 "before": {
  ".blocks.json": "{\n  \"S01\": \"\\\\begin{definition}[CutMix]\\\\label{S01}\\nGiven two labelled images $(x_A, y_A)$ and $(x_B, y_B)$, CutMix~\\\\cite{R07} forms\\n$\\\\tilde{x} = M \\\\odot x_A + (1 - M) \\\\odot x_B$ and $\\\\tilde{y} = \\\\lambda y_A + (1 - \\\\lambda) y_B$,\\nwhere $M$ is a binary box mask and $\\\\lambda$ is the fraction of $x_A$ that it keeps.\\n\\\\end{definition}\",\n  \"S04\": \"We train a ResNet-50 for 200 epochs with SGD, a cosine schedule and a batch size of 256. CutMix is\\napplied to every batch with $\\\\lambda \\\\sim \\\\mathrm{Beta}(1, 1)$.\",\n  \"S03\": \"\\\\begin{figure}[t]\\n  \\\\centering\\n  \\\\rftfig[width=.8\\\\linewidth]{E08}{loss}\\n  \\\\caption{Training loss}\\\\label{S03}\\n\\\\end{figure}\",\n  \"S02\": \"\\\\paragraph{CutMix at 1k images.}\\nWith 1k labelled images, CutMix reaches \\\\rftnum{E05}{acc.1k}\\\\% top-1 accuracy, against \\\\rftnum{E05}{acc.full}\\\\% when trained on the\\nfull set.\"\n}\n",
  "main.tex": "\\documentclass[11pt]{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage[T1]{fontenc}\n\\usepackage{amsmath,amssymb,amsthm}\n\\usepackage{graphicx,booktabs}\n\\usepackage[numbers]{natbib}\n\\usepackage{rft}\n\\usepackage{hyperref}\n\n\\title{CutMix in the low-data regime}\n\\author{A. Author}\n\\date{}\n\n\\begin{document}\n\\maketitle\n\n\\begin{abstract}\nWe study CutMix when only a thousand labelled images are available. It reaches \\rftnum{E05}{acc.1k}\\% top-1\naccuracy over \\rftnum{E05}{runs} runs.\n\\end{abstract}\n\n\\section{Introduction}\n\n% Your text, and copies of snippets between % rft-begin and % rft-end lines: adapt a copy to the\n% narrative as you like; when its snippet changes, the copy is flagged for review.\n\nMixing augmentations such as CutMix~\\cite{R07} and mixup~\\cite{zhang2018mixup} are standard; see\nDefinition~\\ref{S01}, Lemma~\\ref{S07} and Figure~\\ref{S03}.\n\n% rft-begin S01 2a248ff2\n\\begin{definition}[CutMix]\\label{S01}\nGiven two labelled images $(x_A, y_A)$ and $(x_B, y_B)$, CutMix~\\cite{R07} forms\n$\\tilde{x} = M \\odot x_A + (1 - M) \\odot x_B$ and $\\tilde{y} = \\lambda y_A + (1 - \\lambda) y_B$,\nwhere $M$ is a binary box mask and $\\lambda$ is the fraction of $x_A$ that it keeps.\n\\end{definition}\n% rft-end S01\n\n\\section{Method}\n\n% rft-begin S04 df889d41\nWe train a ResNet-50 for 200 epochs with SGD, a cosine schedule and a batch size of 256. CutMix is\napplied to every batch with $\\lambda \\sim \\mathrm{Beta}(1, 1)$.\n% rft-end S04\n\n% rft-begin S03 913f49be\n\\begin{figure}[t]\n  \\centering\n  \\rftfig[width=.8\\linewidth]{E08}{loss}\n  \\caption{Training loss}\\label{S03}\n\\end{figure}\n% rft-end S03\n\n\\section{Results}\n\n% rft-begin S02 ac5a9b18\n\\paragraph{CutMix at 1k images.}\nIn our setting, CutMix reaches \\rftnum{E05}{acc.1k}\\% top-1 accuracy with 1k labelled images. % was: against the full set\n% rft-end S02\n\n% rft-begin S07 0badf00d\n\\begin{lemma}[Mixing bound]\\label{S07}\nThe mixed label $\\tilde{y}$ lies in the convex hull of $y_A$ and $y_B$.\n\\end{lemma}\n% rft-end S07\n\n\\bibliographystyle{plainnat}\n\\bibliography{refs}\n\\end{document}\n"
 },
 "after": {
  "figures/loss.pdf": "%PDF stand-in 710cb71bf335\n",
  "main.tex": "\\documentclass[11pt]{article}\n\\usepackage[utf8]{inputenc}\n\\usepackage[T1]{fontenc}\n\\usepackage{amsmath,amssymb,amsthm}\n\\usepackage{graphicx,booktabs}\n\\usepackage[numbers]{natbib}\n\\theoremstyle{plain}\n\\newtheorem{theorem}{Theorem}\n\\newtheorem{lemma}[theorem]{Lemma}\n\\theoremstyle{definition}\n\\newtheorem{definition}{Definition}\n\\usepackage{hyperref}\n\n\\title{CutMix in the low-data regime}\n\\author{A. Author}\n\\date{}\n\n\\begin{document}\n\\maketitle\n\n\\begin{abstract}\nWe study CutMix when only a thousand labelled images are available. It reaches 73.2\\% top-1\naccuracy over \\textbf{??} runs.\n\\end{abstract}\n\n\\section{Introduction}\n\n% Your text. A passage taken from your notes sits between two comment lines, %%% Kind: title %%%\n% and %%% end %%%: change it as you like, and leave the two lines where they are.\n\nMixing augmentations such as CutMix~\\cite{yun2019cutmix} and mixup~\\cite{zhang2018mixup} are standard; see\nDefinition~\\ref{def:cutmix}, Lemma~\\ref{lem:mixing-bound} and Figure~\\ref{fig:training-loss}.\n\n%%% Definition: CutMix %%%\n\\begin{definition}[CutMix]\\label{def:cutmix}\nGiven two labelled images $(x_A, y_A)$ and $(x_B, y_B)$, CutMix~\\cite{yun2019cutmix} forms\n$\\tilde{x} = M \\odot x_A + (1 - M) \\odot x_B$ and $\\tilde{y} = \\lambda y_A + (1 - \\lambda) y_B$,\nwhere $M$ is a binary box mask and $\\lambda$ is the fraction of $x_A$ that it keeps.\n\\end{definition}\n%%% end %%%\n\n\\section{Method}\n\n%%% Method: Training setup %%%\nWe train a ResNet-50 for 200 epochs with SGD, a cosine schedule and a batch size of 256. CutMix is\napplied to every batch with $\\lambda \\sim \\mathrm{Beta}(1, 1)$.\n%%% end %%%\n\n%%% Figure: Training loss %%%\n\\begin{figure}[t]\n  \\centering\n  \\includegraphics[width=.8\\linewidth]{figures/loss.pdf}\n  \\caption{Training loss}\\label{fig:training-loss}\n\\end{figure}\n%%% end %%%\n\n\\section{Results}\n\n%%% Result: CutMix at 1k images %%%\n\\paragraph{CutMix at 1k images.}\nIn our setting, CutMix reaches 73.2\\% top-1 accuracy with 1k labelled images. % was: against the full set\n%%% end %%%\n\n%%% Lemma: Mixing bound %%%\n\\begin{lemma}[Mixing bound]\\label{lem:mixing-bound}\nThe mixed label $\\tilde{y}$ lies in the convex hull of $y_A$ and $y_B$.\n\\end{lemma}\n%%% end %%%\n\n\\bibliographystyle{plainnat}\n\\bibliography{refs}\n\\end{document}\n",
  "refs.bib": "@inproceedings{yun2019cutmix,\n  title     = {CutMix: Regularization Strategy to Train Strong Classifiers with Localizable Features},\n  author    = {Yun, Sangdoo and Han, Dongyoon and Oh, Seong Joon and Chun, Sanghyuk and Choe, Junsuk and Yoo, Youngjoon},\n  booktitle = {ICCV},\n  year      = {2019}\n}\n",
  "tracking.json": "{\n  \"version\": 1,\n  \"main\": \"main.tex\",\n  \"copies\": [\n    {\n      \"snippet\": \"S01\",\n      \"marker\": \"Definition: CutMix\",\n      \"file\": \"main.tex\",\n      \"stamp\": \"2a248ff2\",\n      \"placed\": \"\\\\begin{definition}[CutMix]\\\\label{def:cutmix}\\nGiven two labelled images $(x_A, y_A)$ and $(x_B, y_B)$, CutMix~\\\\cite{yun2019cutmix} forms\\n$\\\\tilde{x} = M \\\\odot x_A + (1 - M) \\\\odot x_B$ and $\\\\tilde{y} = \\\\lambda y_A + (1 - \\\\lambda) y_B$,\\nwhere $M$ is a binary box mask and $\\\\lambda$ is the fraction of $x_A$ that it keeps.\\n\\\\end{definition}\"\n    },\n    {\n      \"snippet\": \"S04\",\n      \"marker\": \"Method: Training setup\",\n      \"file\": \"main.tex\",\n      \"stamp\": \"df889d41\",\n      \"placed\": \"We train a ResNet-50 for 200 epochs with SGD, a cosine schedule and a batch size of 256. CutMix is\\napplied to every batch with $\\\\lambda \\\\sim \\\\mathrm{Beta}(1, 1)$.\"\n    },\n    {\n      \"snippet\": \"S03\",\n      \"marker\": \"Figure: Training loss\",\n      \"file\": \"main.tex\",\n      \"stamp\": \"913f49be\",\n      \"placed\": \"\\\\begin{figure}[t]\\n  \\\\centering\\n  \\\\includegraphics[width=.8\\\\linewidth]{figures/loss.pdf}\\n  \\\\caption{Training loss}\\\\label{fig:training-loss}\\n\\\\end{figure}\"\n    },\n    {\n      \"snippet\": \"S02\",\n      \"marker\": \"Result: CutMix at 1k images\",\n      \"file\": \"main.tex\",\n      \"stamp\": \"ac5a9b18\",\n      \"placed\": \"\\\\paragraph{CutMix at 1k images.}\\nWith 1k labelled images, CutMix reaches 73.2\\\\% top-1 accuracy, against 81.6\\\\% when trained on the\\nfull set.\"\n    },\n    {\n      \"snippet\": \"S07\",\n      \"marker\": \"Lemma: Mixing bound\",\n      \"file\": \"main.tex\",\n      \"stamp\": \"0badf00d\",\n      \"placed\": \"\\\\begin{lemma}[Mixing bound]\\\\label{lem:mixing-bound}\\nThe mixed label $\\\\tilde{y}$ lies in the convex hull of $y_A$ and $y_B$.\\n\\\\end{lemma}\"\n    }\n  ],\n  \"values\": [\n    {\n      \"kind\": \"number\",\n      \"from\": \"E05\",\n      \"key\": \"acc.1k\",\n      \"written\": \"73.2\",\n      \"file\": \"main.tex\",\n      \"before\": \"s are available. It reaches \",\n      \"after\": \"\\\\% top-1\\naccuracy over \\\\text\"\n    },\n    {\n      \"kind\": \"figure\",\n      \"from\": \"E08\",\n      \"key\": \"loss\",\n      \"written\": \"figures/loss.pdf\",\n      \"file\": \"main.tex\",\n      \"before\": \"raphics[width=.8\\\\linewidth]{\",\n      \"after\": \"}\\n  \\\\caption{Training loss}\\\\\"\n    },\n    {\n      \"kind\": \"number\",\n      \"from\": \"E05\",\n      \"key\": \"acc.1k\",\n      \"written\": \"73.2\",\n      \"file\": \"main.tex\",\n      \"before\": \"our setting, CutMix reaches \",\n      \"after\": \"\\\\% top-1 accuracy with 1k la\"\n    }\n  ],\n  \"bib\": {\n    \"yun2019cutmix\": {\n      \"from\": \"R07\",\n      \"file\": \"refs.bib\"\n    }\n  },\n  \"allowed\": []\n}\n"
 }
}
