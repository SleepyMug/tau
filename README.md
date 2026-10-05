# tau

**tau** (Transportable Agent Unit) packages an agent as a directory: its prompt, the parameters it
takes, its skills, and TypeScript declarations of the APIs it needs, which a runtime such as pi-run
implements.

- [TAU.md](TAU.md): taus in brief: their layout, and what a run means.
- [docs/spec/](docs/spec/index.md): the spec.
- This package, `@sleepymug/tau`, reads and checks a tau for runtimes written in TypeScript, and
  packs a run as a call and a result, for a runtime whose agent works elsewhere: see
  [docs/spec/library.md](docs/spec/library.md).

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | install |
| `pnpm typecheck` | type-check the sources and tests |
| `pnpm test` | build into `dist/`, then run the tests from it |
