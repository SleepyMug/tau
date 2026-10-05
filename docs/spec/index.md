# tau: Transportable Agent Unit

A tau is an agent packaged as a directory. Like a program, it declares the APIs it needs, as
TypeScript declarations, but never holds their implementations or any credentials. It also
declares its parameters: texts, and handles to the caller's files and directories, each saying
whether the agent reads it, writes it, or both.

A **runtime**, such as pi-run, runs a tau for a **caller**, who gives a value for each parameter.
The **agent**, the model the runtime runs on the tau's prompt, writes **programs** that call the
APIs, each through the runtime's implementation.

This spec defines a **compiled format**: a tau as runtimes read and run it, as a built package is
what gets installed, not the sources it is built from. A tau holds everything it uses, so an API
or a skill that two taus share is a copy in each. A source format, in which taus could share such
parts and from which they would be built into this one, is a work in progress.

[TAU.md](../../TAU.md) introduces taus in brief. This spec is the reference:

- The tau:
  - [Directory](directory.md): its layout, and the symlinks it may hold.
  - [Metadata](metadata.md): `tau.json`, its parameters, and what its programs import.
  - [Prompt](prompt.md): `PROMPT.md`, and what a runtime expands in it.
  - [APIs](apis.md): `api/`, what the agent's programs call.
  - [Packages](packages.md): `node_modules/`, code of the tau's own, built on its APIs.
- A run:
  - [Values](values.md): what a run takes: texts, handles, lists and records.
  - [Implementations](implementations.md): how a runtime links each API to its implementation.
  - [Running](running.md): the agent's view, and what else it reaches.
  - [Results](results.md): what a run gives back, and when it fails.
  - [Paths](paths.md): what a runtime promises of the caller's paths.
  - [Runtimes](runtimes.md): what each runtime presents to the model.
  - [The tau API](tau-api.md): how the agent's programs read the run's values, and run other taus.
  - [Serialization](serialization.md): a run's call and result as archives, to send elsewhere.
- [Library](library.md): `@sleepymug/tau`, which reads and checks a tau for runtimes, and packs a
  run as a call and a result.
