# tau

**tau** (Transportable Agent Unit) packages an agent as a directory: its prompt, the files and args
it takes, its skills, and the APIs it needs, contracts of TypeScript declarations, which a runtime
such as pi-run implements.

- [TAU.md](TAU.md): taus in brief: their layout, and what a run means. The package exports it as
  `@sleepymug/tau/TAU.md`, for a runtime to give its agents.
- [docs/spec/](docs/spec/index.md): the spec.
- [docs/VOCAB.md](docs/VOCAB.md): the names of things, and those no longer used.
- This package, `@sleepymug/tau`, reads and checks a tau for runtimes written in TypeScript, and
  packs a run as a call and a result, for a runtime whose agent works elsewhere: see
  [docs/spec/library.md](docs/spec/library.md).
- [dev/](dev/): `@sleepymug/tau-dev`, the `tau` command, for those who make taus and contracts:
  see [docs/spec/development.md](docs/spec/development.md).
- [contracts/](contracts/): the contracts tau publishes, the tau API, `@sleepymug/tau-api`, among
  them: see [docs/spec/contracts.md](docs/spec/contracts.md).

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | install |
| `pnpm typecheck` | type-check the sources and tests |
| `pnpm test` | build into `dist/`, then run the tests from it |
| `pnpm -C dev test` | the same for `@sleepymug/tau-dev`, once the library is built |
| `node dev/dist/cli.js contract check contracts/notes` | check a contract of tau's own |
