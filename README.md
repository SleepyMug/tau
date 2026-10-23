# tau

**tau** (Transportable Agent Unit) runs agents as a service. A tau packages an agent as a
directory: its prompt, the files and args it takes, its skills, and the APIs it needs, contracts of
TypeScript declarations. The `tau` command, or the client SDK, checks a tau and a call of it where
the caller is, and hands the run to a **wire adaptor**, which carries it to a **backend** that runs
the agent with the **backend SDK**, and puts what comes back at the caller's paths.

- [TAU.md](TAU.md): taus in brief, for a model: what one takes, and what a run of one promises;
  and [TAU_DEV.md](TAU_DEV.md): how to make one. The package exports them as
  `@sleepymug/tau/TAU.md` and `@sleepymug/tau/TAU_DEV.md`, for a runtime to give its agents.
- [docs/spec/](docs/spec/index.md): the spec; [protocol.md](docs/spec/protocol.md) has the parts
  of the runtime, and the modules.
- [docs/VOCAB.md](docs/VOCAB.md): the names of things, and those no longer used.
- [contracts/](contracts/): the tau API, `@sleepymug/tau-api`.

| Module | Import | What it is |
|---|---|---|
| `src/core` | `@sleepymug/tau/core` | The format and the semantics: a tau, a call, its paths, placeholders, envelopes, jobs, deliveries, reports |
| `src/client` | `@sleepymug/tau` | The client SDK: `createClient`, the `WireAdaptor` it takes, run stores ([client.md](docs/spec/client.md)) |
| `src/backend` | `@sleepymug/tau/backend` | The backend SDK: `admit`, `place`, `render`, `collect` ([backend.md](docs/spec/backend.md)) |
| `src/transfer` | `@sleepymug/tau/transfer` | Helpers for moving files: contents, checked as they come, and outputs merged at their targets |
| `src/wire-tar` | `@sleepymug/tau/wire-tar` | Calls and results as tar archives ([serialization.md](docs/spec/serialization.md)) |
| `src/adaptors` | `@sleepymug/tau/adaptors` | The built-in wire adaptors: `dummy`, a loopback to a backend in the same process, and `fleet`, runs on the fleet service ([fleet.md](docs/spec/fleet.md)) |
| `src/cli` | the `tau` command | `check`, `describe`, `run`, `start`, `status`, `result`, `trace`, `finish`, `release`, `wait` |

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | install |
| `pnpm typecheck` | type-check the sources and tests |
| `pnpm test` | build into `dist/`, then run the tests from it |
| `node dist/cli/main.js run <dir> --call call.json` | run a tau through the dummy adaptor, whose backend prints the prompt it rendered |
