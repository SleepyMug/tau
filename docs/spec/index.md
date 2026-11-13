# tau: Transportable Agent Unit

A tau is an agent packaged as a directory, which carries what its agent needs: its prompt, its
skills, and code of its own, which the agent's programs build on. It declares what it takes:
**files**, the caller's files and directories, each saying whether the agent reads it, writes it,
or both; and **args**, JSON that a JSON Schema describes. It holds no credentials, and names
nothing of where it runs.

A **runtime** runs a tau for a **caller**, who gives a path for each file, and may give more
files, and the args: a **client** where the caller is, which checks the run, and whose **wire
adaptor** carries it to a **backend**, which runs the agent (see [Protocol](protocol.md)). The
**agent**, the model the runtime runs on the tau's prompt, writes **programs**, which import the
tau's own code from a directory the runtime gives them.

What else the agent reaches, such as commands of the runtime's or the network, is the runtime's:
a tau that relies on any says so in its prompt, and runs only where it is there.

This spec defines a **compiled format**: a tau as runtimes read and run it, as a built package is
what gets installed, not the sources it is built from. A tau holds everything it uses, so a
package or a skill that two taus share is a copy in each. A source format, in which taus could
share such parts and from which they would be built into this one, is a work in progress.

[TAU.md](../../TAU.md) introduces taus in brief, what one takes and what a run promises,
[TAU_DEV.md](../../TAU_DEV.md) how to make one, and [VOCAB.md](../VOCAB.md) names their parts.
This spec is the reference:

- The tau:
  - [Directory](directory.md): its layout, and the symlinks it may hold.
  - [Metadata](metadata.md): `tau.json`, its files and args, what its programs import, and its
    init.
  - [Prompt](prompt.md): `PROMPT.md`.
  - [Placeholders](placeholders.md): `${...}` in the prompt, the args and init, and what each
    becomes.
  - [Packages](packages.md): `node_modules/`, code of the tau's own.
- A run:
  - [Calls](calls.md): what a run takes: a path for each file, extra files, and the args; and
    a call passed on.
  - [Running](running.md): the agent's view, what else it reaches, and runs that nest.
  - [The run context](context.md): where init and the agent's programs read the run's files and
    args.
  - [Init](init.md): a command run before the agent, which may do the run without it.
  - [Results](results.md): what a run gives back, and when it fails.
  - [Paths](paths.md): what a runtime promises of the caller's paths.
  - [Runtimes](runtimes.md): how the agent runs programs, from its program directory, and what a
    runtime presents to the model.
- The runtime:
  - [Protocol](protocol.md): the client, its wire adaptors, and the backend; what is modelled
    between them, a run's life, its trace, and the modules of `@sleepymug/tau`.
  - [Client](client.md): the client SDK, its wire adaptors, and the `tau` command.
  - [Backend](backend.md): the backend SDK, for backends.
  - [The rpc adaptor](rpc.md): runs on a backend that serves `tau.v1.Runs` over Connect, and the
    transports that carry them.
  - [Serialization](serialization.md): a run's call and result as tar archives, one way to carry
    them.
