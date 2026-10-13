# Protocol

tau runs agents as a service. The **runtime** this spec speaks of is two parts, in two places:

```
 caller ──► client: the tau command, or the client SDK ═══ wire ═══► backend: runs the agent,
            its wire adaptor packs, carries, unpacks                 with the backend SDK
```

- The **client** runs where the caller is: the `tau` command, or the client SDK (see
  [Client](client.md)). It reads and checks the tau and the call, and the caller's paths, and hands
  the run to one of its **wire adaptors**, each the part of the client that talks to one backend,
  chosen by name among those the client is given. An adaptor packages the tau and the files,
  carries them, and puts the outputs at the caller's paths. The adaptors there are are built in,
  the **dummy** adaptor among them, whose backend is its own, in the client's process.
- The **backend** runs the agent. The backend SDK (see [Backend](backend.md)) does for it what this
  spec asks of every backend alike: it admits a call, checks its files once placed, renders what
  the agent is given, and collects the run's report. Where and how the agent runs, the model, its
  tools and its isolation, are the backend's.

What a runtime must do, the side that does it does: the client checks a call and its paths (see
[Calls](calls.md) and [Paths](paths.md)) before the run goes anywhere, and its adaptor puts the
outputs (see [Results](results.md)); the backend chooses the places, links each API to its
implementation (see [Implementations](implementations.md)), runs init and the agent (see
[Init](init.md) and [Running](running.md)), and checks what the agent left.

## What is modelled

The protocol models JSON and paths alone. How a file's content travels, all at once or in parts,
streamed, compressed, deduplicated or fetched from elsewhere, is the adaptor's and its backend's,
so that they can do it as well as they know how.

- **The envelope**: the call, checked against the tau, without the caller's paths. Its `files`,
  by name, each with its `mode`; its `base`, the base name its place keeps (see
  [Running](running.md)), not empty, not `.` or `..`, with no `/` and no NUL; and its `kind`,
  `file` or `dir`, which an `in` and an `inout` have, the kind of what is at its path, and an `out`
  may, as what the agent must leave; and `args`, as the caller gave them, their placeholders not
  yet expanded. Nothing else: the caller's paths stay the caller's.

  ```json
  {
    "files": {
      "notes":  { "mode": "in",    "kind": "file", "base": "notes.txt" },
      "site":   { "mode": "inout", "kind": "dir",  "base": "site" },
      "counts": { "mode": "out",                   "base": "counts.txt" }
    },
    "args": { "top": 10 }
  }
  ```

- **The job**: what the client hands its adaptor: the envelope; the tau's directory, which always
  goes with the call; and the caller's path of each `in` and `inout` file, or, for an `in`, its
  paths.
- **The delivery**: where the client asks its adaptor to put a run's outputs: the envelope's
  files, and the caller's path of each `out` and `inout` file, its **target**.
- **The report**: how a run ended, and what it gives back: `ok`, whether it succeeded; `text`, the
  agent's final text, or init's, empty when it gave none; `failure`, why it failed, only when it
  did; and `outputs`, by the name of each `out` and `inout` file it gives back, its `kind`. A run
  that succeeded gives back every one; one that failed gives back none.

  ```json
  { "ok": true, "text": "Replaced 12 words.", "outputs": { "site": { "kind": "dir" }, "counts": { "kind": "file" } } }
  ```

## A run's life

```ts
interface WireAdaptor {
  submit(job: Job, signal?: AbortSignal): Promise<string>;
  finish(id: string, delivery: Delivery, signal?: AbortSignal): Promise<Report>;
  release(id: string): Promise<void>;
}
```

- **Submit.** The adaptor hands the run to its backend, which may refuse it: a call that does not
  fit the tau, or an API it implements at no version that serves the tau's copy. It gives the
  run's **id**, which means the same run to it in any process.
- **Finish.** The adaptor waits until the run has a result, puts its outputs at the targets, as
  [Results](results.md) has it, a directory merging into one there, and gives its report. It
  deletes nothing, here or on the backend, and may be asked again: each time it gives a whole
  result, the latest, which need not be the same, as when the agent has since been asked to
  improve it, and puts its outputs again, merging as before, so what an earlier result alone left
  in a directory stays. Aborting the waiting stops the waiting, not the run.
- **Release.** The backend drops the run, stopping it if it has not ended; then nothing finishes it.
  There is no other way to stop a run.

These three are the whole contract, of an adaptor and of the backend behind it. **Wait** is not
among them: it is the client's verb, in the SDK and the `tau` command, and it is finish, then
release, each made as above, so an adaptor and a backend never see a wait.

The client keeps, for each run it started, its adaptor, its id, and its delivery, in a **run
store**, until it is released, so that whoever finishes or releases the run, in the process that
started it or another sharing the store, can. Runs nest: an agent's program that runs a tau,
through the tau API, is the caller of that run (see [The tau API](tau-api.md)), and the backend
can make it as a client does.

## Trust

Neither side trusts what the other sends. The backend checks an envelope, as an envelope, then
against the tau it came with, before it takes any file, and the files once it placed them, before
it runs anything. The adaptor, being the part of the client that takes in what the backend sends,
checks the report, as a report and against the run's files, and each output, its kind and its
symlinks, which lead, relative and through any further symlinks, all relative, to something in
it (see [Paths](paths.md)), before it puts anything at the caller's paths: what does not fit is a
run that failed, which puts nothing. The client checks the report the adaptor gives it against
the run's files too.

## Transfer

What moving the files asks, an adaptor and a backend may do with `@sleepymug/tau/transfer`, or as
they will:

- **Contents**: a file or a directory as a stream of entries, the content's own first, then, for a
  directory, each entry under it, each directory before what it holds, with its path in the
  content, `/`-separated, its type, a directory, a regular file or a symlink, its permission bits,
  a file's bytes, read as they are read, and a symlink's target. `readContents` reads them from the
  file system, `jobContents` a job's, `extractContent` makes them there again, and `checkContents`
  checks them as they come from elsewhere: each content as named, once, its entries in order, and
  its symlinks inside it.
- **Delivery**: `deliver` checks a report against the delivery's files, stages each output's
  content apart, checked whole, and only then merges each at its target; `mergeOutputs` merges
  outputs staged otherwise, which the core's `checkOutputs` checks.

[Serialization](serialization.md) gives one way to carry it all, tar archives, which the dummy
adaptor uses.

## Modules

`@sleepymug/tau` is built of modules that know of one another only as follows, each taking what it
uses as arguments, never loading it by name:

| Module | What it is | What it uses |
|---|---|---|
| `core` (`@sleepymug/tau/core`) | The format and the semantics: reading and checking a tau, a call and its paths, the placeholders, the envelope, the job, the delivery and the report | nothing |
| `client` (`@sleepymug/tau`) | The client SDK, the `WireAdaptor` it takes, and the run store | `core` |
| `backend` (`@sleepymug/tau/backend`) | The backend SDK, and the implementation catalog it takes | `core` |
| `transfer` (`@sleepymug/tau/transfer`) | Contents, and delivery, for adaptors and backends | `core` |
| `wire-tar` (`@sleepymug/tau/wire-tar`) | Calls and results as tar archives | `core`, `transfer` |
| `adaptors` (`@sleepymug/tau/adaptors`) | The built-in wire adaptors: `dummy` | any of the above |
| `cli` | The `tau` command, which puts the client and its adaptors together | `core`, `client`, `adaptors` |

Neither the client nor the backend SDK knows how files move.

## Open

- Which APIs a backend serves, which a client could ask for through its adaptor before a run, and
  from which a tau could take its APIs; for now a tau holds its copies, and the backend matches
  them.
- Asking a run's agent to improve its result, after which finishing gives the new one.
- A tau the backend already holds, which a call could name by a digest rather than carry.
