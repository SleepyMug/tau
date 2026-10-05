# Directory

```
my-agent/
├── PROMPT.md            # required: the prompt (prompt.md)
├── tau.json             # optional: what it takes and gives (metadata.md)
├── skills/              # optional: skills, each a directory in it with a SKILL.md
├── api/                 # optional: the APIs, a directory each (apis.md)
│   └── notes/
│       ├── index.d.ts
│       └── tags.d.ts
└── node_modules/        # optional: packages of its own, built on its APIs (packages.md)
```

A tau is self-contained, so that it can be moved or copied as a whole. What a runtime reads of it,
`PROMPT.md`, `tau.json`, `skills/` and `api/`, and `node_modules/` when the tau exposes a package
of its own, may hold symlinks, but only relative ones, each leading, through any further
symlinks, all relative, to something that exists in the tau. Runtimes keep symlinks as they are.

Anything else in the directory, such as the sources of its skills, or a tau it runs, is the
author's: no runtime reads it, though the agent may, where `${self}` names the directory (see
[Prompt](prompt.md)).
