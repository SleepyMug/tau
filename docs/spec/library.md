# Library

`@sleepymug/tau` reads and checks a tau for runtimes written in TypeScript, so that they keep to
this spec alike. Apart from reading the tau, and the shapes of a run's paths, it does no I/O, but
to pack and place a run's call and result (see [Calls and results](#calls-and-results)), and each
of its checks throws, listing every problem it finds. A runtime uses it in the order of a run:

```ts
import { checkImplementation, checkInputs, checkOutputs, loadApis, loadExposed, loadTau } from "@sleepymug/tau";

const tau = loadTau(dir);                                    // 1. read the tau
const call = tau.resolve(given, cwd);                        // 2. resolve the call
checkInputs(call);                                           // 3. check the files
const apis = loadApis(dir);                                  // 4. load the APIs
for (const api of apis) checkImplementation(api, implementationOf(api.name));
const exposed = loadExposed(tau, apis);
const run = tau.expand(call, places, self);                  // 5. expand it with each file's place, and run:
// give the files, link the APIs, run the agent on run.prompt
checkOutputs(call, places);                                  // 6. check what the agent left
```

1. **Read the tau.** `loadTau(dir)` reads `PROMPT.md` and `tau.json` (see [Metadata](metadata.md)
   and [Placeholders](placeholders.md)), checks the schema of the args with JSON Schema's
   meta-schema, and checks the symlinks of what a runtime reads (see [Directory](directory.md)).
   The tau it gives has its `description`, `files`, `args`, the schema, `exposes`, and `init`, as
   `tau.json` declares them, for usage, or to offer the tau to another agent as a tool.
2. **Resolve the call.** `tau.resolve(call, cwd)` checks `call` against the tau (see
   [Calls](calls.md)), the args against the schema, with Ajv, and gives, without doing anything,
   the call as a run takes it: its `files`, by name, those `tau.json` declares first, in its order,
   then the extra files, in the call's, each with its `mode`, its `kind`, where it has one, and the
   base name its place keeps (`base`); their `paths`, each resolved against `cwd`, or, for an `in`
   given a list, each of its paths; and the `args`, as given.
3. **Check the files.** `checkInputs(call)` checks what [Paths](paths.md) asks when the run starts.
4. **Load the APIs.** `loadApis(dir)` checks the APIs as [APIs](apis.md) has them, and gives each
   one's `name`, `specifier` (`@api/<name>`), `file`, its `index.d.ts`, whose directory holds its
   files, and `description`. `checkImplementation(api, module)` checks that a module, its
   JavaScript with declarations beside it, or its declarations, fits the API (see
   [Implementations](implementations.md)). `loadExposed(tau, apis)` gives what the agent's programs
   import, as `exposes` lists it: each an API, or a package of the tau's own, with its `dir`,
   checked as [Packages](packages.md) has it; and each with its `specifier` and `description`.
5. **Expand, and run.** This is the runtime's: it chooses each file's **place**, where the agent
   sees it, keeping its base name (see [Running](running.md)), such as its path, for a runtime
   that does not copy, which cannot place an `in` given a list. `tau.expand(call, places, self)`
   gives what the agent is given: the `args`, the `prompt` and the `init`, if the tau has one, their
   placeholders expanded with the places, and `self`, where the agent sees the tau's own directory,
   by default where the tau is (see [Placeholders](placeholders.md)). The runtime gives the agent
   its files as [Running](running.md) has it; links each API to its implementation as
   `@api/<name>`, wherever the tau's code imports it (see [Implementations](implementations.md));
   presents what the tau exposes, and its skills, to the model (see [Runtimes](runtimes.md)); gives
   the agent's programs the places of the files and the args; runs the tau's init, if it has one
   (see [Init](init.md)); and runs the agent on the prompt, unless init skipped it.
6. **Check what the agent left.** Once the agent returns normally, or init skipped it,
   `checkOutputs(call, places)` checks what [Paths](paths.md) asks when the run ends, where `places`
   finds what the agent left at each `out` and `inout` file: its place, for a runtime whose agent
   works on its own machine; where the runtime can check it, for one whose agent works elsewhere,
   such as in a container. A runtime that gave copies then puts them at the caller's paths (see
   [Results](results.md)).

## Calls and results

For a runtime whose agent works elsewhere, the library packs a run as a call and a result (see
[Serialization](serialization.md)), in `@sleepymug/tau/call`, which the package's main entry
exports too, and which loads no TypeScript, so that a caller can use it wherever it runs:

```ts
import { applyResult, packCall, packResult, placeCall, readCall } from "@sleepymug/tau/call";

// The caller
const { archive, targets } = packCall(dir, call, cwd);                 // steps 1 to 3, and the call
// … the runtime takes the archive, runs it, and gives back the result's …
const outcome = await applyResult(result, targets);                    // its outputs at the paths

// The runtime, once it has placed the tau the call carries, with placeCall, and read it
const read = await readCall(archive);
const call = tau.check(read.json);                                     // step 2, for a caller not trusted
const run = tau.expand(call, places, self);                            // step 5, with its places
await placeCall(read, { places });                                     // and its files
// … run the agent …
const result = packResult({ ok, text, failure }, call, places);        // step 6, and the result
```

- **Pack a call.** `packCall(dir, call, cwd)` reads the tau, resolves the call and checks the
  files, as steps 1 to 3 do, with the caller's paths, and gives the call's archive, with the
  content of each `in` and `inout` file, and the tau's, first, unless `{ tau: false }`; and its
  **targets**, the caller's path of each `out` and `inout` file, by its name. The archive reads the
  files as it is read.
- **Read one.** `readCall(bytes)` and `readResult(bytes)` read an archive in one pass, as an async
  iterable of bytes: its JSON at once, checked, then its contents, each an async iterable of its
  entries, checked as they come, and its symlinks once they all have. One that breaks
  [Serialization](serialization.md) throws an `ArchiveError`. `extractContent(content, to)` makes a
  content's file or directory, its symlinks last.
- **Check an archive's call.** `tau.check(json)` checks a call `readCall` read, from a caller the
  runtime does not trust, against the tau, as step 2 does: each file's mode and kind against what
  `tau.json` declares, each extra file's name, and the args against the schema. It gives the call,
  its files in step 2's order, each with the kind `tau.json` declares, where the call gives none.
- **Place it.** `placeCall(call, { places, tau })` gives each `in` and `inout` file its content at
  its place, and the tau's directory at `tau`, when given, making the directories each lies in, and
  that of each `out` file's place.
- **Pack a result.** `packResult(outcome, call, places)` checks what the agent left, as step 6
  does, if the run succeeded, and gives the result's archive: what the agent left at each `out`
  and `inout` file, by its name, or, when that does not fit, a run that failed, with why, and
  nothing given back.
- **Check one.** `checkResult(json, call)` checks a result from a runtime the caller does not
  trust against the call's files: each output is an `out` or `inout` file's, of its kind, and a run
  that succeeded gives back every one.
- **Apply one.** `applyResult(bytes, targets)` puts each output at its file's path in `targets`, as
  [Results](results.md) has it, and gives how the run ended. It trusts the result as to what goes
  where, and checks only its archive.

A **runtime**, wherever the agent works, is anything with `start(call)`, which takes a packed call
and gives the run's id; `finish(id, signal)`, which waits for the run to end, and gives back the
result's archive and the call's targets; and `cancel(id)`. It keeps the targets without reading
them, so the caller who finishes a run need not be the one who started it. `runTau(runtime, dir,
call, cwd, signal)` runs a tau on one, and waits for it: it packs the call, starts it, finishes
it, and applies the result; aborting `signal` cancels the run, which fails. A runtime can implement
the tau API's `run` as `runTau` on whatever runs the runs it starts (see
[The tau API](tau-api.md)).

What the library does not read, or check, is the runtime's or the author's to keep to the spec:
the tau's skills, and the JavaScript of its packages.

It checks declarations with TypeScript 6.0, against Node.js 24's types, both of which it pins, and
the args with Ajv 8, against draft 2020-12: `loadApis` takes about 0.4 s for a tau, `loadExposed`
about as long when the tau exposes packages of its own, and `checkImplementation` about 0.15 s.
