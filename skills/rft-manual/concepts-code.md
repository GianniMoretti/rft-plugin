# Concepts and their code

A part of the rft manual (the `rft-manual` skill is its core, with the index of the parts).

## Concepts

Concepts split the tree into **lines of research**. A note with `concept: "<name>"` (and an
optional `concept_summary: "<one line>"`) in its frontmatter starts a concept: it and its whole
subtree belong to it, until a descendant starts a sub-concept. Concepts nest; notes with no
concept above them belong to the project itself; a concept on the root note covers the whole tree
and takes the project's place at the top of the concept tree. Concepts are explicit, never inferred:

- **Propose, then apply.** When a direction opens a new line of research (not a single
  experiment), propose a concept to the user: the note it starts at, a short name and a
  one-line summary. Call `rft_set_concept` only after they confirm. Never set, rename or remove
  a concept silently.
- **Names** are short and readable, in words as in a heading: `Strong augmentation`, not
  `strong-augmentation` and not the title of one experiment. No `^ # | [ ]`. Avoid reusing a
  name.
- Start a concept at the direction that opened the line, usually; nest at most two or three
  levels, and leave shared setup (the starting question, baselines everyone builds on) in the
  project root when it is not a line of its own.
- `rft_concepts` shows the concept tree; `rft_set_concept(id, name, summary?)` sets or renames
  one, and `name: null` removes it. `/rft-concepts suggest` asks you to propose a full split:
  answer with a short table (start note, name, summary, what stays in the root) and wait for
  the user's yes before applying anything.
- **Ask for the code.** Once a new concept is set, ask the user whether code for that line of
  research already exists on this machine, and where (see Code below).

## Code

A concept can link the **code repositories** its work runs on: folders on this machine, in
`concept_repos:` on the note that starts it (on the root note, the code of the whole project).

```yaml
concept: "Schedule-free training"
concept_summary: "Training without a stopping rule"
concept_repos: ["/home/me/code/sfree", "../code/train-utils"]
```

- **Priority.** A note works with its concept's own repos first, then with those its concept
  inherits from the concepts above it, nearest first. A sub-concept's code is the most specific;
  its parent's is context.
- **Linking.** When a concept is created, ask whether code for it already exists and where. Link
  it with `rft_set_repos(id, repos)` using the path the user gives (absolute, `~/…`, or relative
  to the tree's folder, the one holding `.rft/`); never guess a path. An empty list removes the
  link. Its answer gives each repo's git state, whether sessions started in the repo reach this
  tree (if not, it says which `.rft/config.json` link would do it: ask before writing it into the
  repo), and the notes that now need a Code section.
- **After linking, read the code** as it is now, and give every experiment and direction of the
  concept (sub-concepts included) a `## Code` section with `rft_set_code`. Ideas `discussed` or
  `moved` need none.
- **The `## Code` section** says how the note relates to the code: entry points, files,
  functions and classes, configs, what has to change, where outputs go. A direction gets a short
  pointer (where the idea would land in the code). It opens with one line per repo, written by
  the plugin, never by hand:
  `` - `../code/sfree` @ 3f2a1c9d0e (main) · checked 2026-11-06 ``: the commit the references
  were checked against. `rft_set_code(id, text?, reproduce?)` writes the section and records
  each repo's current commit; `text` or `reproduce` left out keeps what the section holds.
- **The current state comes first.** Plan and propose changes from the code as it is now (the
  current commit and the uncommitted changes), not from the commit an older note recorded.
- **Before working on an experiment** (planning it, launching it, analysing its results) whose
  concept links code, call `rft_code(id)`: it lists, per repo, the commit the note was checked
  against, the commits since and the files changed (uncommitted changes included). Read the
  changes that touch what the note refers to (`git -C <repo> diff <commit> -- <files>`), update
  the references, and call `rft_set_code` to record the current commits. `rft_add_node` writes
  the section at creation, stamped: pass its description as `sections.Code` once you have read
  the code, or fill it right after with `rft_set_code`.
- **Results live in the experiment's note.** Each repo keeps its outputs its own way (logs,
  CSVs, checkpoints, tracker exports): read them where the repo puts them, process them (seeds
  aggregated, tables, the figures that matter) and write the numbers in **Result**, so the note
  can be discussed without the repo. Then record how to reproduce them with `rft_set_code`'s
  `reproduce`: the commit the run used (and whether the tree had uncommitted changes), the
  command and config, where the raw outputs are, and how they were processed into Result (the
  script or command). The Reproduce part keeps the commit of the run even when the references
  are checked again later.
- `rft_validate` warns about repos that are missing or not under git, `concept_repos` on a note
  that starts no concept, and notes whose Code section is missing or names repos the concept no
  longer links.
