# Directory

```
my-agent/
├── PROMPT.md            # required: the prompt (prompt.md)
├── tau.json             # optional: its files and args, and more (metadata.md)
├── skills/              # optional: skills, each a directory in it with a SKILL.md
└── .tau/                # optional: its author's tools', never carried
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

Search with `trip-search`, ...
```

How a skill reaches the model is the runtime's.

A tau is self-contained, so that it can be moved or copied as a whole. What a runtime reads of it,
`PROMPT.md`, `tau.json` and `skills/`, may hold symlinks, but only relative ones, each leading,
through any further symlinks, all relative, to something that exists in the tau and goes with a
call. Runtimes keep symlinks as they are.

`.tau/` is for the tools of the tau's author. No client carries it, nor what `tau.json`'s `exclude`
leaves out (see [Metadata](metadata.md)), so the agent never sees either. Anything else in the
directory, such as a program its init runs, the sources of its skills, or a tau it runs, is the
author's: no runtime reads it, though init and the agent may, where `${self}` names the directory
(see [Placeholders](placeholders.md)).
