# Client

The client runs a tau for a caller, where the caller is (see [Protocol](protocol.md)): it checks
the tau and the call there, and hands the run to a wire adaptor, which carries it to a backend and
puts what comes back at the caller's paths. It is `@sleepymug/tau`, the client SDK, and the `tau`
command built on it.

## The SDK

```ts
import { createClient, createDummyAdaptor, fileRunStore } from "@sleepymug/tau";

const client = createClient({
  adaptors: { dummy: createDummyAdaptor() },        // each wire adaptor, by name, made by the caller
  adaptor: "dummy",                                 // the one a run goes through when it names none
  runs: fileRunStore(".tau/runs"),                  // where runs are kept; by default in memory
});

const outcome = await client.run("plan-trip", call, { cwd, signal });   // start, and wait
const run = await client.start("plan-trip", call, { cwd });             // or start …
const first = await client.finish(run);                                 // … finish, as often as asked …
await client.release(run);                                              // … and release
```

- `load(dir)` reads and checks the tau at `dir`, as [Directory](directory.md),
  [Metadata](metadata.md), [Placeholders](placeholders.md), [APIs](apis.md) and
  [Packages](packages.md) have it, and gives its `description`, `files`, `args`, `apis`, `exposed`,
  `skills` and `init`. It loads no TypeScript, and checks neither the declarations nor the
  packages' code, which are their authors'.
- `check(dir, call, cwd)` reads the tau, resolves `call` against it, its paths against `cwd`, and
  checks the args against the schema and their placeholders (see [Calls](calls.md)), and the
  caller's paths, as a run's are when it starts (see [Paths](paths.md)), without starting it.
  Each check throws, listing every problem it finds.
- `start(dir, call, { cwd, adaptor, signal })` checks the run as `check` does, then hands the
  adaptor its job (see [Protocol](protocol.md#what-is-modelled)), keeps the run in the run store,
  and gives its id, `<adaptor>:<the adaptor's id>`. It throws when the run cannot start: the call
  does not fit the tau, or the backend refuses it.
- `finish(run, { signal })` has the adaptor wait for the run's result and put its outputs at the
  caller's paths, and gives how it ended: `ok`, `text`, and `failure`, when it failed. The run is
  kept: finishing it again gives the latest result, which need not be the same, and puts its
  outputs again (see [Protocol](protocol.md#a-runs-life)). A report that does not fit the run is a
  run that failed. Aborting `signal` stops the waiting, not the run.
- `release(run)` drops the run, here and on its backend, stopping it if it has not ended.
- `wait(run, { signal })` finishes the run, then releases it: the client's own verb, made of the
  two, which the adaptor never sees.
- `run(dir, call, { cwd, adaptor, signal })` starts a run and waits for it; aborting `signal` once
  it started releases it, and it fails, having put nothing.

## Wire adaptors

A **wire adaptor** is anything with `submit`, `finish` and `release` (see
[Protocol](protocol.md#a-runs-life)), which the client is given, never loads. It is the part of
the client that takes in what its backend sends, and checks it before it puts anything at the
caller's paths, with the transfer helpers or as it will (see [Protocol](protocol.md#transfer)).

The **dummy** adaptor, `createDummyAdaptor({ agent, implementations, spool })`, packs a job as a
tar archive (see [Serialization](serialization.md)), and a backend of its own, in the same process,
built on the backend SDK (see [Backend](backend.md)), unpacks it, runs `agent` on it, and keeps the
result, as an archive too, in `spool`, until the run is released; finishing it unpacks the result
at the caller's paths. A run ends before `submit` gives its id. By default, its catalog serves
every API, and its agent, `echoAgent`, leaves an empty file or directory at each `out` file's
place, and gives back the prompt, rendered, as its text: a dry run.

The **fleet** adaptor, `createFleetAdaptor({ transport, project })`, carries a run to the fleet
service, over the service's socket, `fleetSocket(path)`, or another transport (see
[The fleet adaptor](fleet.md)).

## The `tau` command

```
tau check <dir> [call]                    check a tau, and a call of it, without running it
tau describe <dir>                        what a tau takes, as JSON
tau run <dir> [call] [--adaptor <name>] [--json]
tau start <dir> [call] [--adaptor <name>]
tau finish <run> [--json]
tau release <run>
tau wait <run> [--json]
```

A call is JSON, `{"files": {...}, "args": {...}}`: `--call <file>`, `-` for stdin, or
`--call-json '<json>'`; without one, `{}`. Its paths are relative to the working directory. `run`,
`finish` and `wait` print the run's final text, and, when it failed, why, to stderr, exiting 1;
`--json` prints `{ok, text, failure}` instead. The command keeps runs, and the dummy backend's
results, in `$TAU_STATE_DIR`, by default `tau` in `$XDG_STATE_HOME`, or in `~/.local/state`. A run
goes through `--adaptor`, or `$TAU_ADAPTOR`, or `dummy`: `dummy`, or `fleet`, the fleet service at
its socket, `$TAU_FLEET_SOCKET` or in the dsh home, each run's session in the dsh workspace of the
working directory. Interrupting `run` releases the run, which then fails; interrupting `finish` or
`wait` stops the waiting, not the run.
