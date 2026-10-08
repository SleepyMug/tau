# APIs

Each directory in `api/` is an API, and `api/` holds nothing else. `api/<alias>/` holds a copy of
a contract (see [Contracts](contracts.md)): its `package.json` and its declarations, each where the
package has it, and nothing else. The agent's programs import it as `@api/<alias>`: as with a
package's types, they get its `index.d.ts`. The **alias**, the directory's name, is the tau's
own, and matches `^[A-Za-z0-9][A-Za-z0-9._-]*$`; the contract's name and version, in the copy's
`package.json`, are what a runtime implements. A tau holds a contract under one alias at most.

```
api/
├── notes/            @sleepymug/tau-api-notes, which programs import as @api/notes
│   ├── package.json
│   ├── index.d.ts
│   └── tags.d.ts
└── tau/              @sleepymug/tau-api, the tau API
    ├── package.json
    └── index.d.ts
```

A tau keeps the copy as the contract has it. A runtime gives the contract's implementation,
whatever the copy declares, so a copy changed misleads only the tau's own code.

The runtime gives `@api/<alias>` (see [Implementations](implementations.md)). Wherever the tau's
own code imports it, its declarations are `api/<alias>/index.d.ts`, as a `tsconfig.json` in the
tau with `"paths": { "@api/*": ["./api/*/index.d.ts"] }` has it.
