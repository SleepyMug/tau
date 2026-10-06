# Library

`@sleepymug/tau` reads and checks a tau for runtimes written in TypeScript, so that they keep to
this spec alike. Apart from reading the tau, and the shapes of a run's paths, it does no I/O, but
to pack and place a run's call and result (see [Calls and results](#calls-and-results)), and each
of its checks throws, listing every problem it finds. A runtime uses it in the order of a run:

```ts
import { checkImplementation, checkInputs, checkOutputs, loadApis, loadExposed, loadTau } from "@sleepymug/tau";

const tau = loadTau(dir);                                    // 1. read the tau
const run = tau.bind(values, { cwd }, place, self);          // 2. bind the values
checkInputs(run);                                            // 3. check the handles
const apis = loadApis(dir);                                  // 4. load the APIs
for (const api of apis) checkImplementation(api, implementationOf(api.name));
const exposed = loadExposed(tau, apis);
// 5. run: give the handles, link the APIs, run the agent on run.prompt
checkOutputs(run, locate);                                   // 6. check what the agent left
```

1. **Read the tau.** `loadTau(dir)` reads `PROMPT.md` and `tau.json` (see [Metadata](metadata.md)
   and [Prompt](prompt.md)), and checks the symlinks of what a runtime reads (see
   [Directory](directory.md)). The tau it gives has its `description`, `params`, each a `Type`,
   `exposes`, and `init`, as `tau.json` declares them, for usage, or to offer the tau to another
   agent as a tool.
2. **Bind the values.** `tau.bind(values, caller, place, self)` checks `values` against the
   parameters' types (see [Values](values.md)), and computes, without doing it, what the run
   needs: the `handles`, each with where it lies in the values (`at`, such as `edits[0]` or
   `args.src`, and `pointer`, a JSON Pointer, such as `/edits/0`), its `mode`, its `kind` (`file`,
   `dir`, or `path` where no type declares one), the caller's path (`host`), resolved against
   `caller.cwd`, its base name (`name`), and where the agent sees it (`view`);
   the `values`, each handle's path its view, to give the agent; the `prompt`, expanded; and the
   `init`, if the tau has one, expanded (see [Init](init.md)). `place` gives each handle its view,
   asked in the order of the values; without it, the view is the caller's path itself, for a
   runtime that does not copy. `${self}` becomes `self`, where the agent sees the tau's own
   directory; without it, where the tau is.
3. **Check the handles.** `checkInputs(run)` checks what [Paths](paths.md) asks when the run
   starts.
4. **Load the APIs.** `loadApis(dir)` checks the APIs as [APIs](apis.md) has them, and gives each
   one's `name`, `specifier` (`@api/<name>`), `file`, its `index.d.ts`, whose directory holds its
   files, and `description`. `checkImplementation(api, module)` checks that a module, its
   JavaScript with declarations beside it, or its declarations, fits the API (see
   [Implementations](implementations.md)). `loadExposed(tau, apis)` gives what the agent's programs
   import, as `exposes` lists it: each an API, or a package of the tau's own, with its `dir`,
   checked as [Packages](packages.md) has it; and each with its `specifier` and `description`.
5. **Run.** This is the runtime's: it gives the agent its handles as [Running](running.md) has it;
   links each API to its implementation as
   `@api/<name>`, wherever the tau's code imports it (see [Implementations](implementations.md));
   presents what the tau exposes, and its skills, to the model (see [Runtimes](runtimes.md)); and
   shows the agent its values; runs the tau's init, if it has one (see [Init](init.md)); and runs
   the agent on the prompt, unless init skipped it.
6. **Check what the agent left.** Once the agent returns normally, or init skipped it,
   `checkOutputs(run, locate)` checks what [Paths](paths.md) asks when the run ends, where `locate`
   finds what the agent left at each `$out` and `$inout` handle's place: by default its `view`,
   which suits a runtime whose agent works on its own machine; one whose agent works elsewhere, such
   as in a container, checks where it can. A runtime that gave copies then puts them at the caller's
   paths (see [Results](results.md)).

## Calls and results

For a runtime whose agent works elsewhere, the library packs a run as a call and a result (see
[Serialization](serialization.md)), in `@sleepymug/tau/call`, which the package's main entry
exports too, and which loads no TypeScript, so that a caller can use it wherever it runs:

```ts
import { applyResult, packCall, packResult, placeCall, readCall } from "@sleepymug/tau/call";

// The caller
const { archive, targets } = packCall(dir, values, { cwd });           // steps 1 to 3, and the call
// … the runtime takes the archive, runs it, and gives back the result's …
const outcome = await applyResult(result, targets);                    // its outputs at the paths

// The runtime
const call = await readCall(archive);
const run = loadTau(tauDir).bind(call.json.values, { cwd: "/" }, place, self);
await placeCall(call, { handles: run.handles });                       // step 5's handles
// … run the agent …
const result = packResult({ ok, text, failure }, run.handles, locate); // step 6, and the result
```

- **Pack a call.** `packCall(dir, values, caller)` reads the tau, binds the values and checks the
  handles, as steps 1 to 3 do, with the caller's paths, and gives the call's archive, each `$in`
  and `$inout` path's content a blob, one for each path, and the tau's directory a blob, first,
  unless `{ tau: false }`; and its **targets**, the caller's path of each `$out` and `$inout`
  handle, by its pointer. The archive reads the files as it is read.
- **Read one.** `readCall(bytes)` and `readResult(bytes)` read an archive in one pass, as an async
  iterable of bytes: its JSON at once, checked, then its blobs, each an async iterable of its
  entries, checked as they come, and its symlinks once they all have. One that breaks
  [Serialization](serialization.md) throws an `ArchiveError`. `extractBlob(blob, to)` makes a
  blob's file or directory, its symlinks last.
- **Bind a call's values.** `tau.bind` takes a call's handles too, `{"$in": {name, kind, blob}}`,
  each `kind` checked against its type, and each handle's `kind` the content's, and `blob` its
  blob; it has no `host`, so a runtime gives `place`.
- **Place it.** `placeCall(call, { handles, tau })` gives each handle with a blob its content at
  its view, and the tau's directory at `tau`, when given, making the directories each lies in, and
  that of each `$out` handle's view.
- **Pack a result.** `packResult(outcome, handles, locate)` checks what the agent left, as step 6
  does, if the run succeeded, and gives the result's archive: what the agent left at each `$out`
  and `$inout` handle, by its pointer, or, when that does not fit, a run that failed, with why, and
  nothing given back.
- **Check one.** `checkResult(json, handles)` checks a result from a runtime the caller does not
  trust against the run's handles: each output is at an `$out` or `$inout` handle, of its mode,
  name and kind, and a run that succeeded gives back every one.
- **Apply one.** `applyResult(bytes, targets)` puts each output at the path its pointer has in
  `targets`, as [Results](results.md) has it, and gives how the run ended. It trusts the result as
  to what goes where, and checks only its archive.

A **runtime**, wherever the agent works, is anything with `start(call)`, which takes a packed call
and gives the run's id; `finish(id, signal)`, which waits for the run to end, and gives back the
result's archive and the call's targets; and `cancel(id)`. It keeps the targets without reading
them, so the caller who finishes a run need not be the one who started it. `runTau(runtime, dir,
values, caller, signal)` runs a tau on one, and waits for it: it packs the call, starts it,
finishes it, and applies the result; aborting `signal` cancels the run, which fails. A runtime can
implement the tau API's `run` as `runTau` on whatever runs the runs it starts (see
[The tau API](tau-api.md)).

What the library does not read, or check, is the runtime's or the author's to keep to the spec:
the tau's skills, and the JavaScript of its packages.

It checks declarations with TypeScript 6.0, against Node.js 24's types, both of which it pins:
`loadApis` takes about 0.4 s for a tau, `loadExposed` about as long when the tau exposes packages
of its own, and `checkImplementation` about 0.15 s.
