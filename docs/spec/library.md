# Library

`@sleepymug/tau` reads and checks a tau for runtimes written in TypeScript, so that they keep to
this spec alike. Apart from reading the tau, and the shapes of a run's paths, it does no I/O, but
to pack and place a run's call and result (see [Calls and results](#calls-and-results)), and each
of its checks throws, listing every problem it finds. A runtime uses it in the order of a run:

```ts
import { checkImplementation, checkInputs, checkOutputs, loadApis, loadExposed, loadTau } from "@sleepymug/tau";

const tau = loadTau(dir);                                    // 1. read the tau
const run = tau.bind(call, { cwd }, place, self);            // 2. bind the call
checkInputs(run);                                            // 3. check the files
const apis = loadApis(dir);                                  // 4. load the APIs
for (const api of apis) checkImplementation(api, implementationOf(api.name));
const exposed = loadExposed(tau, apis);
// 5. run: give the files, link the APIs, run the agent on run.prompt
checkOutputs(run, locate);                                   // 6. check what the agent left
```

1. **Read the tau.** `loadTau(dir)` reads `PROMPT.md` and `tau.json` (see [Metadata](metadata.md)
   and [Placeholders](placeholders.md)), checks the schema of the args with JSON Schema's
   meta-schema, and checks the symlinks of what a runtime reads (see [Directory](directory.md)).
   The tau it gives has its `description`, `files`, `args`, the schema, `exposes`, and `init`, as
   `tau.json` declares them, for usage, or to offer the tau to another agent as a tool.
2. **Bind the call.** `tau.bind(call, caller, place, self)` checks `call` against the tau (see
   [Calls](calls.md)), the args against the schema, with Ajv, and computes, without doing it, what
   the run needs: the `files`, each with its `name`, its `mode`, its `kind`, where it has one, the
   caller's path (`host`), resolved against `caller.cwd`, or, for an `in` given a list, each of
   its paths, the base name its place keeps (`base`), and where the agent sees it (`view`); the
   `args`, their placeholders expanded, to give the agent; the `prompt`, expanded; and the `init`,
   if the tau has one, expanded (see [Placeholders](placeholders.md)). `place` gives each file its
   view, asked in the order `tau.json` declares them, then for each extra file, in the call's
   order; without it, the view is the caller's path
   itself, for a runtime that does not copy, which cannot place an `in` given a list. `${self}`
   becomes `self`, where the agent sees the tau's own directory; without it, where the tau is.
3. **Check the files.** `checkInputs(run)` checks what [Paths](paths.md) asks when the run starts.
4. **Load the APIs.** `loadApis(dir)` checks the APIs as [APIs](apis.md) has them, and gives each
   one's `name`, `specifier` (`@api/<name>`), `file`, its `index.d.ts`, whose directory holds its
   files, and `description`. `checkImplementation(api, module)` checks that a module, its
   JavaScript with declarations beside it, or its declarations, fits the API (see
   [Implementations](implementations.md)). `loadExposed(tau, apis)` gives what the agent's programs
   import, as `exposes` lists it: each an API, or a package of the tau's own, with its `dir`,
   checked as [Packages](packages.md) has it; and each with its `specifier` and `description`.
5. **Run.** This is the runtime's: it gives the agent its files as [Running](running.md) has it;
   links each API to its implementation as
   `@api/<name>`, wherever the tau's code imports it (see [Implementations](implementations.md));
   presents what the tau exposes, and its skills, to the model (see [Runtimes](runtimes.md)); and
   gives the agent's programs the places of the files and the args; runs the tau's init, if it has
   one (see [Init](init.md)); and runs the agent on the prompt, unless init skipped it.
6. **Check what the agent left.** Once the agent returns normally, or init skipped it,
   `checkOutputs(run, locate)` checks what [Paths](paths.md) asks when the run ends, where `locate`
   finds what the agent left at each `out` and `inout` file's place: by default its `view`, which
   suits a runtime whose agent works on its own machine; one whose agent works elsewhere, such as
   in a container, checks where it can. A runtime that gave copies then puts them at the caller's
   paths (see [Results](results.md)).

## Calls and results

For a runtime whose agent works elsewhere, the library packs a run as a call and a result (see
[Serialization](serialization.md)), in `@sleepymug/tau/call`, which the package's main entry
exports too, and which loads no TypeScript, so that a caller can use it wherever it runs:

```ts
import { applyResult, packCall, packResult, placeCall, readCall } from "@sleepymug/tau/call";

// The caller
const { archive, targets } = packCall(dir, call, { cwd });             // steps 1 to 3, and the call
// … the runtime takes the archive, runs it, and gives back the result's …
const outcome = await applyResult(result, targets);                    // its outputs at the paths

// The runtime
const read = await readCall(archive);
const run = loadTau(tauDir).bind({ files: read.json.files, args: read.json.args }, { cwd: "/" }, place, self);
await placeCall(read, { files: run.files });                           // step 5's files
// … run the agent …
const result = packResult({ ok, text, failure }, run.files, locate);   // step 6, and the result
```

- **Pack a call.** `packCall(dir, call, caller)` reads the tau, binds the call and checks the
  files, as steps 1 to 3 do, with the caller's paths, and gives the call's archive, with the
  content of each `in` and `inout` file, and the tau's, first, unless `{ tau: false }`; and its
  **targets**, the caller's path of each `out` and `inout` file, by its name. The archive reads the
  files as it is read.
- **Read one.** `readCall(bytes)` and `readResult(bytes)` read an archive in one pass, as an async
  iterable of bytes: its JSON at once, checked, then its contents, each an async iterable of its
  entries, checked as they come, and its symlinks once they all have. One that breaks
  [Serialization](serialization.md) throws an `ArchiveError`. `extractContent(content, to)` makes a
  content's file or directory, its symlinks last.
- **Bind an archive's call.** `tau.bind` takes an archive's files too, `{mode, base, kind}`, each
  mode checked against the tau's, and each kind against its kind; they have no `host`, so a
  runtime gives `place`.
- **Place it.** `placeCall(call, { files, tau })` gives each `in` and `inout` file its content at
  its view, and the tau's directory at `tau`, when given, making the directories each lies in, and
  that of each `out` file's view.
- **Pack a result.** `packResult(outcome, files, locate)` checks what the agent left, as step 6
  does, if the run succeeded, and gives the result's archive: what the agent left at each `out`
  and `inout` file, by its name, or, when that does not fit, a run that failed, with why, and
  nothing given back.
- **Check one.** `checkResult(json, files)` checks a result from a runtime the caller does not
  trust against the run's files: each output is an `out` or `inout` file's, of its kind, and a run
  that succeeded gives back every one.
- **Apply one.** `applyResult(bytes, targets)` puts each output at its file's path in `targets`, as
  [Results](results.md) has it, and gives how the run ended. It trusts the result as to what goes
  where, and checks only its archive.

A **runtime**, wherever the agent works, is anything with `start(call)`, which takes a packed call
and gives the run's id; `finish(id, signal)`, which waits for the run to end, and gives back the
result's archive and the call's targets; and `cancel(id)`. It keeps the targets without reading
them, so the caller who finishes a run need not be the one who started it. `runTau(runtime, dir,
call, caller, signal)` runs a tau on one, and waits for it: it packs the call, starts it, finishes
it, and applies the result; aborting `signal` cancels the run, which fails. A runtime can implement
the tau API's `run` as `runTau` on whatever runs the runs it starts (see
[The tau API](tau-api.md)).

What the library does not read, or check, is the runtime's or the author's to keep to the spec:
the tau's skills, and the JavaScript of its packages.

It checks declarations with TypeScript 6.0, against Node.js 24's types, both of which it pins, and
the args with Ajv 8, against draft 2020-12: `loadApis` takes about 0.4 s for a tau, `loadExposed`
about as long when the tau exposes packages of its own, and `checkImplementation` about 0.15 s.
