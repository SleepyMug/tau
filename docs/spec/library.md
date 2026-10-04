# Library

`@sleepymug/tau` reads and checks a tau for runtimes written in TypeScript, so that they keep to
this spec alike. Apart from reading the tau, and the shapes of a run's paths, it does no I/O, and
each of its checks throws, listing every problem it finds. A runtime uses it in the order of a run:

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
   and `exposes`, as `tau.json` declares them, for usage, or to offer the tau to another agent as a
   tool.
2. **Bind the values.** `tau.bind(values, caller, place, self)` checks `values` against the
   parameters' types (see [Values](values.md)), and computes, without doing it, what the run
   needs: the `handles`, each with where it lies in the values (`at`, such as `edits[0]` or
   `args.src`), its `mode`, its `kind` (`file`, `dir`, or `path` where no type declares one), the
   caller's path (`host`), resolved against `caller.cwd`, and where the agent sees it (`view`);
   the `values`, each handle's path its view, to give the agent; and the `prompt`, expanded.
   `place` gives each handle its view, asked in the order of the values; without it, the view is
   the caller's path itself, for a runtime that does not copy. `${self}` becomes `self`, where the
   agent sees the tau's own directory; without it, where the tau is.
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
   shows the agent its values; and runs the agent on the prompt.
6. **Check what the agent left.** Once the agent returns normally, `checkOutputs(run, locate)`
   checks what [Paths](paths.md) asks when the run ends, where `locate` finds what the agent left
   at each `$out` and `$inout` handle's place: by default its `view`, which suits a runtime whose
   agent works on its own machine; one whose agent works elsewhere, such as in a container, checks
   where it can. A runtime that gave copies then puts them at the caller's paths (see
   [Results](results.md)).

What the library does not read, or check, is the runtime's or the author's to keep to the spec:
the tau's skills, and the JavaScript of its packages.

It checks declarations with TypeScript 6.0, against Node.js 24's types, both of which it pins:
`loadApis` takes about 0.4 s for a tau, `loadExposed` about as long when the tau exposes packages
of its own, and `checkImplementation` about 0.15 s.
