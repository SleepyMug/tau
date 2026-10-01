# tau

**tau** (Transportable Agent Unit) packages an agent as a directory. The directory holds a prompt,
skills, and, in `api/`, TypeScript declarations of the APIs the agent needs, but never their
implementations. A runtime such as pi-run provides an implementation of each API, which programs
import as `@api/<name>`; how it runs, in the program's process or behind a boundary that keeps
credentials from the agent, is the runtime's business. Its `tau.json` declares what it takes and
gives: arguments, environment variables, and the files and directories it reads and writes. How
they reach the agent is up to the runtime.

- [SPEC.md](SPEC.md) specifies the directory, the metadata, the APIs, their implementations, and
  what every runtime keeps to.
- This package, `@sleepymug/tau`, reads and checks a tau for runtimes written in TypeScript.

## Library

```ts
import { checkImplementation, checkInputs, checkOutputs, loadApis, loadTau } from "@sleepymug/tau";

// PROMPT.md and tau.json. A tau.json that breaks the spec, or a prompt naming an undeclared
// argument, throws, naming its file and the reason; so do symlinks that break the spec.
const tau = loadTau(agentDir);
// What it does, and each argument: `text`, or a `file` or `dir` with its `role`, each with its
// description, for usage or to offer the tau to another agent as a tool.
tau.description;
tau.args;
// Checks argv against the arguments, and computes, without doing it, what the run needs: the
// prompt with each ${name} expanded, the variables `env` names, and for each path its role, the
// caller's path, and where the agent sees it. `place` chooses that; without it, the caller's path.
const run = tau.bind(argv, { cwd: process.cwd(), env: process.env }, place);
// Each input a file or a directory as declared, and each output's directory there. Paths may
// overlap; whether the runtime can keep each to its role is its own to check. Throws, listing
// every problem.
checkInputs(run);
// ... run the agent on run.prompt, with run.paths and run.env ...
// When the agent is done: each out path as declared, where `locate` finds it (without it, at the
// caller's path), and each share path at the caller's path.
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
```

Apart from reading the tau and checking its paths, the library does no I/O: mounting, copying and
running implementations are the runtime's job. It loads TypeScript 6.0 to check APIs, against
Node.js 24's types, which it pins: `loadApis` takes about 0.4 s for a tau, and
`checkImplementation` about 0.15 s.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | install |
| `pnpm typecheck` | type-check the sources and tests |
| `pnpm test` | build into `dist/`, then run the tests from it |
