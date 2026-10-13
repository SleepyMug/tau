# Backend

`@sleepymug/tau/backend`, the **backend SDK**, does for a backend what this spec asks of every
backend alike (see [Protocol](protocol.md)), whatever carried the call, however its files reached
the backend, and however the agent runs. It works on JSON and paths: moving the files is the
backend's, which the transfer helpers can do for it (see [Protocol](protocol.md#transfer)).

```ts
import { catalogOf, createBackendSdk, initDecision, placesUnder } from "@sleepymug/tau/backend";

const sdk = createBackendSdk({ implementations: catalogOf(mine) });
// … the tau that came with the call is at `${work}/tau` …
const admitted = sdk.admit(envelope, `${work}/tau`);            // or refuse, before any file comes
const places = placesUnder(`${work}/files`, admitted.envelope);
// … each `in` and `inout` file's content goes to its place, as it comes …
const placed = admitted.place(places);
const rendered = placed.render();        // prompt, args, init, context, skills, exposed, links
// … run init, and decide by initDecision(code); run the agent on rendered.prompt …
const { report, sources } = placed.collect({ ok, text, failure });   // send these back
```

- **Admit a call.** `admit(envelope, tauDir)` checks the envelope's form, reads the tau at
  `tauDir`, where the backend placed the tau that came with it, as the client does, and checks the
  envelope against it, as from a client the backend does not trust: each file's mode and kind
  against what `tau.json` declares, each extra file's name, the args against the schema, and their
  placeholders (see [Calls](calls.md)); and finds each API an implementation in its catalog (see
  [Implementations](implementations.md)). It throws when the call cannot run as declared, before
  the backend need take any file.
- **Its implementations.** An `ImplementationCatalog` finds an implementation of a contract at a
  version that serves the tau's copy (see [Contracts](contracts.md#versions)): `{contract, version,
  module}`, where `module` is what the backend gives the agent's programs as `@api/<alias>`, its to
  say. `catalogOf(list)` finds the first in a list that serves, by name and version alone.
- **Place the files.** The backend chooses each file's place, absolute and ending in its file's base
  name (`placesUnder(dir, envelope)` gives `<dir>/<name>/<base>`), puts each `in` and `inout`
  file's content there, and makes the directory of each `out` file's place. `admitted.place(places)`
  checks that it did, each content of its kind and holding what a path may (see [Paths](paths.md)),
  and throws, listing every problem, when it did not.
- **Render.** `placed.render(self)` gives what the agent is given, its placeholders expanded with
  the places, and `self`, where the agent sees the tau's directory, by default where it is (see
  [Placeholders](placeholders.md)): the `prompt`; the `args`; `init`, each placeholder one word for
  `sh`; `context`, what the tau API gives the agent's programs, `files`, the place of each file,
  and `args` (see [The tau API](tau-api.md)); and the tau's `skills`, what it `exposed`, and each
  API's implementation, `links`, for the backend to present to the model and link as
  [Runtimes](runtimes.md) and [Implementations](implementations.md) have it.
- **Init.** `initDecision(code)` says what init's exit code means (see [Init](init.md)): `skip`,
  `run` or `fallback`, which an ending without a code, such as by a signal, is too.
- **Collect.** `placed.collect(outcome)` gives the run's `report`, and the place of each output it
  gives back, its `sources`, for the backend to send: if the agent ended well, or init skipped it,
  what it left at each `out` and `inout` file's place, checked as [Paths](paths.md) asks; if that
  does not fit, or the run failed, a run that failed, giving back nothing. It may be collected
  again as the run goes on, each time giving the latest, for a client that finishes it again (see
  [Protocol](protocol.md#a-runs-life)).

What the backend SDK does not do is the backend's: carry calls and results, choose where a run
works, move its files, run init and the agent, present skills and APIs to the model, give the tau
API, keep each run's result until it is released, and stop a run released before it ended.
