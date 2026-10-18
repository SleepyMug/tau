# Implementations

A tau runs only when the runtime has an implementation of each of its APIs: a module that does what
the API's contract declares, at a version that serves the tau's range (see [APIs](apis.md) and
[Contracts](contracts.md#versions)). Whoever provides an implementation says which contract it
implements, and at which version, such as the version of the contract's package that it is built
and type-checked against. A runtime refuses to start a tau when an API has no implementation, just
as a linker refuses an unresolved symbol. It matches an implementation by the contract's name and
version alone, and does not check its code against the declarations.

- **The agent sees the implementation's declarations.** The tau holds none: a runtime shows the
  agent the declarations of the contract at the version its implementation implements, which
  serves the tau's range, so they declare what the tau's author wrote against, and maybe more,
  added since (see [Contracts](contracts.md#versions)).
- **Every import gets the same implementation.** Wherever an agent's program or a package of the
  tau imports an API, by its contract's name, it gets the runtime's implementation, one module for
  all of them in a process. A runtime can give it with a `node_modules/` of its own in a directory
  above the tau's, holding a package by the contract's name for each API, since Node.js looks for
  a package in every directory above the file that imports it, and none in the tau has that name
  (see [APIs](apis.md)); or with a hook that resolves the contract's name, such as Node.js's
  `module.registerHooks`.
- **How an implementation runs is the runtime's business**, which a tau cannot tell, and does not
  depend on. It may run in the program's process, or be split in two: a part there, which calls,
  over a socket or any other channel, a part that holds credentials or reaches beyond the agent's
  environment. An API is an abstraction boundary, not a security one: the agent can read and
  change whatever runs in its environment, so a runtime that keeps something from the agent keeps
  it outside, behind its implementations. Values that cross a process boundary are the
  implementation's to carry: a contract declares them as programs hold them.
