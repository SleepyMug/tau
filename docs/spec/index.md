# tau: Transportable Agent Unit

A tau is an agent packaged as a directory. Like a program, it names the APIs it needs, each a
**contract**, a package of TypeScript declarations with a name and a version, of which it holds a
copy, but never their implementations or any credentials. It also
declares what it takes: **files**, the caller's files and directories, each saying whether the
agent reads it, writes it, or both; and **args**, JSON that a JSON Schema describes.

A **runtime** runs a tau for a **caller**, who gives a path for each file, and may give more
files, and the args: a **client** where the caller is, which checks the run, and whose **wire
adaptor** carries it to a **backend**, which runs the agent (see [Protocol](protocol.md)). The **agent**, the model the runtime runs on the tau's prompt, writes **programs** that
call the APIs, each through the runtime's implementation.

This spec defines a **compiled format**: a tau as runtimes read and run it, as a built package is
what gets installed, not the sources it is built from. A tau holds everything it uses, so an API
or a skill that two taus share is a copy in each. A source format, in which taus could share such
parts and from which they would be built into this one, is a work in progress.

[TAU.md](../../TAU.md) introduces taus in brief, and [VOCAB.md](../VOCAB.md) names their parts.
This spec is the reference:

- The tau:
  - [Directory](directory.md): its layout, and the symlinks it may hold.
  - [Metadata](metadata.md): `tau.json`, its files and args, what its programs import, and its
    init.
  - [Prompt](prompt.md): `PROMPT.md`.
  - [Placeholders](placeholders.md): `${...}` in the prompt, the args and init, and what each
    becomes.
  - [APIs](apis.md): `api/`, what the agent's programs call.
  - [Contracts](contracts.md): an API as it is published, its package, and its versions.
  - [Packages](packages.md): `node_modules/`, code of the tau's own, built on its APIs.
- A run:
  - [Calls](calls.md): what a run takes: a path for each file, extra files, and the args; and
    a call passed on.
  - [Implementations](implementations.md): how a runtime links each API to its implementation.
  - [Running](running.md): the agent's view, and what else it reaches.
  - [Init](init.md): a command run before the agent, which may do the run without it.
  - [Results](results.md): what a run gives back, and when it fails.
  - [Paths](paths.md): what a runtime promises of the caller's paths.
  - [Runtimes](runtimes.md): how the agent runs programs, and what a runtime presents to the model.
  - [The tau API](tau-api.md): how the agent's programs read the run's files and args, and run
    other taus.
- The runtime:
  - [Protocol](protocol.md): the client, its wire adaptors, and the backend; what is modelled
    between them, a run's life, and the modules of `@sleepymug/tau`.
  - [Client](client.md): the client SDK, its wire adaptors, and the `tau` command.
  - [Backend](backend.md): the backend SDK, for backends.
  - [The fleet adaptor](fleet.md): runs on the fleet service, and the transports that carry them.
  - [Serialization](serialization.md): a run's call and result as tar archives, one way to carry
    them.
