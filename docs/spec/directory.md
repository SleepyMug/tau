# Directory

```
my-agent/
├── PROMPT.md            # required: the prompt (prompt.md)
├── tau.json             # optional: its files, args and APIs, and more (metadata.md)
├── skills/              # optional: skills, each a directory in it with a SKILL.md
├── node_modules/        # optional: packages of its own, built on its APIs (packages.md)
└── .tau/                # the tau command's: the APIs' contracts, never carried (authoring.md)
```

A skill's `SKILL.md` starts with YAML frontmatter that gives its `name`, which is its directory's,
in lowercase letters, digits and single hyphens, such as `book-flights`, and its `description`:
what it is for, by which the agent tells when to use it. The rest is the skill's instructions,
which may name other files of its directory by their paths relative to it:

```markdown
---
name: book-flights
description: Find and book flights for a group, cheapest first.
---

Search with `@acme/travel`, ...
```

A tau is self-contained, so that it can be moved or copied as a whole, but for its APIs, which
the runtime gives it (see [APIs](apis.md)). What a runtime reads of it, `PROMPT.md`, `tau.json`,
`skills/`, and `node_modules/` when the tau exposes a package of its own, may hold symlinks, but
only relative ones, each leading, through any further symlinks, all relative, to something that
exists in the tau. Runtimes keep symlinks as they are.

`.tau/` is the `tau` command's, holding what the tau's author needs of its APIs (see
[Authoring](authoring.md)): no runtime reads it, and no client carries it, so the agent never sees
it. Anything else in the directory, such as the sources of its skills, or a tau it runs, is the
author's: no runtime reads it, though the agent may, where `${self}` names the directory (see
[Placeholders](placeholders.md)).
