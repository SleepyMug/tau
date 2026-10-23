# Authoring

What a runtime reads of a tau is all this spec asks of it; how its author makes it is theirs. A
tau needs no package manager, and is no npm package, but its author needs what its APIs declare,
to write and type-check its code, and the tau holds none of it (see [APIs](apis.md)). The `tau`
command pulls each API's contract for its author, from wherever it is published, and keeps it in
`.tau/`, which no runtime reads, and no client carries (see [Directory](directory.md)).

## The APIs

```
tau api add <name>[@<range>] [--from <npm|path> | --from-provider] [dir]
tau api remove <name> [dir]
tau api sync [dir]
```

- **`add`** pulls the contract `name`, at the version `range` gives, `1.2.0` for `^1.2.0`, or,
  without one, the newest its source has, keeps it in `.tau/`, and adds it to `apis`, at `range`,
  or at `^` and the version pulled, from its **source**, where the contract is published:
  - `--from npm`, the npm registry, `$npm_config_registry` or npm's own, as `npm` would install
    it: the default;
  - `--from <path>`, a path, one that holds a `/` or starts with a `.`, to a contract's package
    directory, such as one its publisher is writing;
  - `--from-provider`, the **provider**: the backend of the wire adaptor a run goes through, as
    `--adaptor`, `$TAU_ADAPTOR` or the config file chooses it (see
    [Client](client.md#the-tau-command)), which gives the contracts it implements (see
    [Protocol](protocol.md#contracts)), such as the fleet service, for the contracts its
    extensions implement.
- **`remove`** takes it out of `apis`, and out of `exposes`, and its contract out of `.tau/`.
- **`sync`** pulls each API's contract that `.tau/` lacks, or holds at another version than its
  range gives, from where `.tau/lock.json` says it came, or else from npm, and drops those of no
  API: after a tau is cloned, or its ranges are changed by hand.

The author writes against the version a range gives, the oldest a runtime may implement, never a
newer one, whose additions the tau could call where a runtime lacks them: a source that does not
have that version is refused, naming the versions it has, and `add` without a range takes the
newest of them. Each refuses, too, a contract its source gives that is not one (see
[Contracts](contracts.md)), or not the one asked for. None touches a `package.json`: no package
manager sees an API (see [APIs](apis.md)).

A tau's ranges are what it works with, and are the tau's; where each contract came from is its
author's, and no runtime asks, since it implements an API by its name and version alone.

## `.tau/`

```
.tau/
├── lock.json                     each API's contract: the version pulled, and where from
├── contracts/@acme/travel/       its package.json and declarations, as the contract has them
├── tsconfig.json                 where TypeScript finds each API
└── .gitignore                    everything but lock.json
```

```json
{
  "contracts": {
    "@acme/travel": { "version": "1.2.0", "from": "provider" },
    "@sleepymug/tau-api": { "version": "0.1.0", "from": "npm" }
  }
}
```

`lock.json` says, for each API, the version of its contract `.tau/contracts/` holds, the one its
range gives, and its source, `npm`, a path, relative to the tau, or `provider`, whichever the
provider is where `sync` runs, so that `sync` pulls the same contracts again; the rest of `.tau/` is made from it, and is not kept with
the tau's sources.

`tsconfig.json` maps each API to its declarations, by `paths`:

```json
{
  "compilerOptions": {
    "paths": {
      "@acme/travel": ["./contracts/@acme/travel/index.d.ts"],
      "@sleepymug/tau-api": ["./contracts/@sleepymug/tau-api/index.d.ts"]
    }
  }
}
```

A `tsconfig.json` of the tau's that extends it, `"extends": "./.tau/tsconfig.json"`, type-checks
the tau's code, its init, and its packages' sources, against the contracts `.tau/` holds, as
[Packages](packages.md) asks. TypeScript takes `paths` whole from the one file that sets it, so a
tau's own `paths`, if it has any, repeat these.

## Building and running

- **Nothing of an API runs where its author is.** The tau holds no implementation, so its programs
  and its init run only in a runtime: `tau run` with the `fleet` adaptor, say. The dummy adaptor's
  backend serves every API by name, and its agent runs no program, so `tau run` with it checks the
  tau, its prompt and its files, not its code.
- **A package of the tau's own leaves its APIs to the runtime.** Whatever builds it, a bundler
  such as esbuild with `--external:@acme/travel`, or `tsc`, keeps each import of an API as it is,
  so that the program gets the runtime's implementation, and names the APIs it imports in its
  `package.json`'s `tau.apis` (see [Packages](packages.md)).
- **What the tau ships is its directory**, but for `.tau/`, which a client never carries: the
  agent reads each API's declarations as the runtime gives them (see
  [Implementations](implementations.md)), not as its author pulled them.
