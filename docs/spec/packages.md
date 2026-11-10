# Packages

A tau may hold packages of its own in `node_modules/`, as Node.js finds them: code that its author,
or a tool that tunes agents, puts beside the model, such as a function that does in one call what
would take the model many, so that it can do more with less. A runtime gives every one to the
agent's programs, from its program directory (see [Runtimes](runtimes.md)), and to init, which runs
the tau's own code; `exposes` names those the runtime presents to the model (see
[Metadata](metadata.md)), and a package may import anything else in the tau's `node_modules/`,
whether `exposes` names it or not.

A runtime reads `node_modules/` (see [Directory](directory.md)), as it is: it installs and builds
nothing. Each package `exposes` names keeps to this:
- **It is JavaScript, with declarations.** It is at `node_modules/<name>`, runs on Node.js 24 or
  later, and has TypeScript declarations of what programs import of it.
- **It is self-contained.** Each import, in its declarations and its JavaScript, resolves to a
  file in the tau, or to Node.js's own modules.
- **Documentation:** its `package.json`'s `description`, if it has one, describes it.

What a package needs beyond the tau, such as a module a runtime would give it, or a command of the
runtime's it runs, is the runtime's: a tau whose packages rely on any runs only where the runtime
gives it, and its prompt says so (see [Running](running.md)).
