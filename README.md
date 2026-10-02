# tau

**tau** (Transportable Agent Unit) packages an agent as a directory. The directory holds a prompt,
skills, and, in `api/`, TypeScript declarations of the APIs the agent needs, but never their
implementations. A runtime such as pi-run provides an implementation of each API, which programs
import as `@api/<name>`; how it runs, in the program's process or behind a boundary that keeps
credentials from the agent, is the runtime's business. A tau may also hold packages of its own in
`node_modules/`, built on those APIs, and expose them to the model's programs alongside the APIs or
in their place. Its `tau.json` declares what it takes and
gives: arguments, environment variables, and the files and directories it reads and writes, each
at its place in the agent's working directory, which the runtime fills before the run and takes
the outputs from after it.

- [SPEC.md](SPEC.md) specifies the directory, the metadata, the APIs and their implementations, the
  tau's packages, and what every runtime keeps to.
- This package, `@sleepymug/tau`, reads and checks a tau for runtimes written in TypeScript.

## Library

```ts
import { checkImplementation, checkInputs, checkOutputs, loadApis, loadExposed, loadTau } from "@sleepymug/tau";

// PROMPT.md and tau.json. A tau.json that breaks the spec, or a prompt naming an undeclared
// argument, throws, naming its file and the reason; so do symlinks that break the spec.
const tau = loadTau(agentDir);
// What it does, and each argument: `text`, or a `file` or `dir` with its `role` and its place,
// `at`, each with its description, for usage or to offer the tau to another agent as a tool.
tau.description;
tau.args;
// Checks argv against the arguments, and computes, without doing it, what the run needs: the
// prompt with each ${name} expanded, the variables `env` names, and for each path its role, its
// place, the caller's path, and where the agent sees it: its place in `work`, the working
// directory as the agent sees it. ${self} becomes where the agent sees the tau's own directory:
// `self`, or without it, `tau.dir`.
const run = tau.bind(argv, { cwd: process.cwd(), env: process.env }, work, self);
// Each input a file or a directory as declared, and each output's directory there; paths may
// overlap. Throws, listing every problem.
checkInputs(run);
// ... fill the working directory, run the agent on run.prompt, with run.env ...
// When the run ends, if the agent returned normally: what it left at each out's place, as
// declared, where `locate` finds it (without it, at its view); then put each at the caller's path.
checkOutputs(run, locate);

// Every api/<name>.d.ts of the tau, once TypeScript finds them and what they import free of
// errors, and inside the tau. Throws, listing every problem.
for (const api of loadApis(agentDir)) {
	api.specifier; // "@api/notes": what programs import
	api.file; // what types it, with its imports resolving from there
	api.description; // its @packageDocumentation
	// Before linking an implementation: TypeScript must find its module assignable to the API's,
	// reading the declarations beside it. Throws, with TypeScript's reasons.
	checkImplementation(api, "/path/to/notes-implementation/index.js");
}

// What the agent's programs import, as tau.json's `exposes` lists it, or else every API: an API,
// or a package of the tau's own in node_modules/, once TypeScript finds its declarations free of
// errors with each @api/<name> typed by api/<name>.d.ts, and no @api scope in the tau's
// node_modules/ would hide the runtime's implementations. Throws, listing every problem.
for (const exposed of loadExposed(tau, loadApis(agentDir))) {
	exposed.specifier; // "@api/notes", or a package's name: what programs import
	exposed.description; // its @packageDocumentation, or a package.json's description
	if (exposed.kind === "package") exposed.dir; // node_modules/<name>, where Node.js finds it
}
```

Apart from reading the tau and checking its paths, the library does no I/O: filling the working
directory, putting the outputs in place and running implementations are the runtime's job. It loads TypeScript 6.0 to check APIs, against
Node.js 24's types, which it pins: `loadApis` takes about 0.4 s for a tau, `loadExposed` about
as long when the tau exposes packages of its own, and `checkImplementation` about 0.15 s.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | install |
| `pnpm typecheck` | type-check the sources and tests |
| `pnpm test` | build into `dist/`, then run the tests from it |
