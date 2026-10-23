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
  runs: fileRunStore("state/runs"),                 // where runs are kept; by default in memory
});

const outcome = await client.run("plan-trip", call, { cwd, signal });   // start, and wait
const run = await client.start("plan-trip", call, { cwd });             // or start …
const { state } = await client.status(run);                             // … look in, at once …
const first = await client.finish(run);                                 // … finish, as often as asked …
const { format, events } = await client.trace(run);                     // … see what its agent did …
await client.release(run);                                              // … and release
```

- `load(dir)` reads and checks the tau at `dir`, as [Directory](directory.md),
  [Metadata](metadata.md), [Placeholders](placeholders.md), [APIs](apis.md) and
  [Packages](packages.md) have it, and gives its `description`, `files`, `args`, `apis`, each a
  contract's name and range, `exposed`, `skills` and `init`. It reads nothing of `.tau/`, loads no
  TypeScript, and checks neither the APIs' declarations nor the packages' code, which are their
  authors'.
- `check(dir, call, cwd)` reads the tau, resolves `call` against it, its paths against `cwd`, and
  checks the args against the schema and their placeholders (see [Calls](calls.md)), and the
  caller's paths, as a run's are when it starts (see [Paths](paths.md)), without starting it.
  Each check throws, listing every problem it finds.
- `start(dir, call, { cwd, adaptor, signal })` checks the run as `check` does, then hands the
  adaptor its job (see [Protocol](protocol.md#what-is-modelled)), keeps the run in the run store,
  and gives its id, `<adaptor>:<the adaptor's id>`. It throws when the run cannot start: the call
  does not fit the tau, or the backend refuses it.
- `status(run, { signal })` gives where the run is, at once, as its adaptor says: `{ state:
  "running" }`, or `{ state: "ended", result, ok, failure }`, with its latest result's number (see
  [Protocol](protocol.md#what-is-modelled)).
- `result(run, { signal })` has the adaptor put the outputs of the run's latest result at the
  caller's paths, at once, and gives how it ended: `result`, its number, `ok`, `text`, and
  `failure`, when it failed. It throws for a run that has no result yet. The run is kept: asking
  again gives the latest result, which need not be the same, and puts its outputs again (see
  [Protocol](protocol.md#a-runs-life)). A report that does not fit the run is a result that
  failed.
- `trace(run, { signal })` gives the run's trace, what its agent did so far, `{ format, events }`,
  as its backend records it (see [Protocol](protocol.md#traces)).
- `finish(run, { signal })` asks the run's status until it has ended, pausing between, at first for
  a tenth of a second, each pause twice the last, up to two seconds; then gives its result, as
  `result` does, without the number: `ok`, `text`, and `failure`. Aborting `signal` stops the
  waiting, not the run.
- `release(run)` drops the run, here and on its backend, stopping it if it has not ended.
- `wait(run, { signal, trace })` finishes the run, then gives its trace to `trace`, if given, then
  releases it: the client's own verb, which the adaptor never sees. What `trace` throws, or the
  adaptor does while giving it, `wait` throws, once the run is released.
- `run(dir, call, { cwd, adaptor, signal, trace })` starts a run and waits for it; aborting `signal`
  once it started releases it, and it fails.

## Wire adaptors

A **wire adaptor** is anything with `submit`, `status`, `result`, `trace` and `release` (see
[Protocol](protocol.md#a-runs-life)), and maybe `contract` (see
[Protocol](protocol.md#contracts)), which the client is given, never loads. It is the part of
the client that takes in what its backend sends, and checks it before it puts anything at the
caller's paths, with the transfer helpers or as it will (see [Protocol](protocol.md#transfer)).

The **dummy** adaptor, `createDummyAdaptor({ agent, implementations, spool })`, packs a job as a
tar archive (see [Serialization](serialization.md)), and a backend of its own, in the same process,
built on the backend SDK (see [Backend](backend.md)), unpacks it, runs `agent` on it, and keeps the
result, as an archive too, with the run's status and trace, in `spool`, until the run is released;
its result unpacks the archive at the caller's paths. A run ends, with its one result, before
`submit` gives its id. Its trace's format is `tau-dummy`: its own events, `admitted`, with the
envelope, `rendered`, with the prompt, and `ended`, with how the run ended, and between them what
`agent` adds, with `trace(event)`. By default, its catalog serves
every API, and its agent, `echoAgent`, leaves an empty file or directory at each `out` file's
place, and gives back the prompt, rendered, as its text: a dry run.

The dummy adaptor gives no contract: its backend holds no declarations.

The **fleet** adaptor, `createFleetAdaptor({ transport, project })`, carries a run to the fleet
service, and gives the contracts it implements, over the service's socket, `fleetSocket(path)`,
or another transport (see [The fleet adaptor](fleet.md)).

## The `tau` command

```
tau check <dir> [call]                    check a tau, and a call of it, without running it
tau describe <dir>                        what a tau takes, as JSON
tau run <dir> [call] [--adaptor <name>] [--json] [--trace <file>]
tau start <dir> [call] [--adaptor <name>]
tau status <run> [--json]
tau result <run> [--json]
tau trace <run>
tau finish <run> [--json]
tau release <run>
tau wait <run> [--json] [--trace <file>]
tau api add <name>[@<range>] [--from <npm|path> | --from-provider] [dir]
tau api remove <name> [dir]
tau api sync [dir]
```

`tau api` keeps a tau's APIs, in `tau.json`, and their contracts, in `.tau/`, for its author (see
[Authoring](authoring.md)).

A call is JSON, `{"files": {...}, "args": {...}}`: `--call <file>`, `-` for stdin, or
`--call-json '<json>'`; without one, `{}`. Its paths are relative to the working directory. `run`,
`result`, `finish` and `wait` print the run's final text, and, when it failed, why, to stderr,
exiting 1; `--json` prints `{ok, text, failure}` instead, and for `result` its number too,
`{result, ok, text, failure}`. `status` prints `running`, or `ended: result <n>` and how it ended,
or, with `--json`, the status. `trace` prints the trace as JSON Lines: a line `{"format": …}`, then
each event, a line each; `--trace <file>` has `run` and `wait` write it so to the file, relative
to the working directory, once the run finished, before they release it. The command keeps runs, and the dummy backend's
results, in `$TAU_STATE_DIR`, by default `tau` in `$XDG_STATE_HOME`, or in `~/.local/state`. A run
goes through `--adaptor`, or `$TAU_ADAPTOR`, or the config file's `adaptor`, or `dummy`: `dummy`, or
`fleet`, the fleet service at its socket, `$TAU_FLEET_SOCKET`, or the config file's, or in the dsh
home, each run's session in the dsh workspace of the working directory. Interrupting `run` releases
the run, which then fails; interrupting `finish` or `wait` stops the waiting, not the run.

### The config file

The command reads its config file, YAML, at `$TAU_CONFIG`, or `tau/config.yaml` in
`$XDG_CONFIG_HOME`, or in `~/.config`. None there, or an empty one, says nothing; one with anything
else in it than the following fails every command, saying where and why:

```yaml
# The adaptor a run goes through, unless --adaptor or $TAU_ADAPTOR names one.
adaptor: fleet
# The options of the adaptors built into tau, each optional.
adaptors:
  fleet:
    # The fleet service's socket, unless $TAU_FLEET_SOCKET names one: relative to the file's
    # folder, a leading ~ the user's home.
    socket: ~/.dsh/fleet/tau.sock
```

The command line comes first, then the environment, then the file, then the defaults.
