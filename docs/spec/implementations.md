# Implementations

A tau runs only when the runtime has an implementation of each of its APIs: a module whose exports
are what the API declares. A runtime refuses to start a tau when an API has no implementation,
just as a linker refuses an unresolved symbol, and when TypeScript does not find the
implementation's module type, `typeof import(implementation)`, assignable to the API's: each value
the API exports, the implementation exports too, with a type that fits.

- **An API is written for the tau.** It declares what the tau's code, the agent's programs and
  the tau's packages, uses, with documentation written for whoever reads it, and may declare less
  than an implementation offers. One implementation can serve every tau whose API it fits. Since
  the check is TypeScript's, a class with `private` members fits only its own declaration, so an
  API declares what the tau's code uses of a class, and leaves its private members out.
- **The tau's code sees the API.** `@api/<name>` is typed by `api/<name>/index.d.ts` as the tau
  has it, with its imports resolving as they do there, whatever else the implementation declares.
- **Every import gets the same implementation.** Wherever an agent's program or a package of the
  tau imports `@api/<name>`, it gets the runtime's implementation, one module for all of them in a
  process. A runtime can give it with a `node_modules/` of its own in a directory above the tau's
  and the agent's programs, holding a package `@api/<name>` for each API, since Node.js looks for a
  package in every directory above the file that imports it, as TypeScript does for an API that
  imports another; or with a hook that resolves `@api/<name>`, such as Node.js's
  `module.registerHooks`.
- **How an implementation runs is the runtime's business**, which a tau cannot tell, and does not
  depend on. It may run in the program's process, or be split in two: a part there, which calls,
  over a socket or any other channel, a part that holds credentials or reaches beyond the agent's
  environment. An API is an abstraction boundary, not a security one: the agent can read and
  change whatever runs in its environment, so a runtime that keeps something from the agent keeps
  it outside, behind its implementations. Values that cross a process boundary are the
  implementation's to carry: an API declares them as programs hold them.
