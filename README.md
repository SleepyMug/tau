# tau

**tau** (Transportable Agent Unit) packages an agent as a directory. The directory holds a prompt,
skills, and, in `api/`, TypeScript manifests of the external services the agent needs, but never
their implementations. Whoever runs a tau serves its services on one Unix socket, and a runtime
such as pi-run binds them for the agent. A tau may also ship modules: packages that run with the
agent's own programs, and may wrap its services. Its `tau.json` declares what it takes and gives:
arguments, environment variables, and the files and directories it reads and writes; and what a
runtime copies for the agent's programs. How they reach the agent is up to the runtime.

- [SPEC.md](SPEC.md) specifies the directory, the metadata, the service manifests, the modules,
  what every runtime keeps to, and the socket protocol.
- This package, `@sleepymug/tau`, reads and checks a tau's metadata, services and modules for
  runtimes written in TypeScript.

## Library

```ts
import { checkInputs, checkModule, checkOutputs, loadModules, loadServices, loadTau, TAU_SOCKET } from "@sleepymug/tau";

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
// Each input a file or a directory as declared, each output's directory there, and no path
// inside another once symlinks are followed. Throws, listing every problem.
checkInputs(run);
// ... run the agent on run.prompt, with run.paths and run.env ...
// After a successful run: each out and inout path as declared, where `locate` finds it; without
// it, at the caller's path.
checkOutputs(run, locate);

// Every api/<name>.d.ts of the tau, translated to JSON Schema and verified. A manifest that
// cannot be translated without changing its meaning throws, naming its file and the reason.
const services = loadServices(agentDir);
for (const service of services) {
	service.declarations; // the manifest as written: what `@svc/<name>` declares
	// What to send the provider: validated, and reduced to what the manifest declares.
	const args = service.checkArguments("addNote", ["buy milk"]);
	// The same for what came back; null for a function without a result.
	const result = service.checkResult("addNote", response);
}

// Every modules/<dir>/ of the tau: typed packages, named by their package.json.
for (const module of loadModules(tau)) {
	// Throws, listing every import from the module's entry points that does not resolve to what
	// the tau copies, or names a service api/ does not declare.
	checkModule(module, tau);
}
// Then copy each of `tau.copy`, keeping symlinks as they are; put each service's binding at
// modules/node_modules/@svc/<name> in the copy; and make each module importable by its name from
// there, e.g. with ts-executor's packageModule.
```

Apart from reading the tau and checking its paths, the library does no I/O: mounting, copying and
talking to the socket are the runtime's job. It loads TypeScript 5.9 and ts-json-schema-generator to read manifests, which takes about
0.2 s per manifest.

The code is adapted from fyona at commit 008a6f5, and must stay in step with it until fyona uses
this package:
- `src/schema/` is copied from `fbox-host`;
- `src/read-manifest.ts` and `src/verify.ts` are adapted from `fbox-derive`.

## Commands

| Command | What it does |
|---|---|
| `pnpm install` | install |
| `pnpm typecheck` | type-check the sources and tests |
| `pnpm test` | build into `dist/`, then run the tests from it |
