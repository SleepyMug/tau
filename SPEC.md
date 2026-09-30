# tau: Transportable Agent Unit

A tau is an agent packaged as a directory. Like a program, it declares the external services it
needs, but it never contains their implementations or any credentials. It also declares what it
takes and gives: its arguments, the environment variables it may see, and the files and
directories it reads and writes. Whoever runs it provides the implementations behind one Unix
socket. A tau may also ship modules: code that runs with the agent's own programs. A **runtime**
such as pi-run executes the tau, binds its services to that socket, and presents them to the model
in whatever way it chooses.

This spec defines a **compiled format**: a tau as runtimes read and run it, as a built package is
what gets installed, not the sources it is built from. That is why its links are limited (see
[Directory](#directory)): a tau holds everything it uses, so a manifest or a module that two taus
share is a copy in each. A source format, in which taus could share such parts and from which they
would be built into this one, is a work in progress.

## Directory

```
my-agent/
├── PROMPT.md            # required: the prompt, naming each argument as ${name}
├── tau.json             # optional: what it does, what it takes, and what runtimes copy
├── skills/              # optional: skills (any dir with SKILL.md, recursively)
├── api/                 # optional: the services the agent needs, one manifest each
│   └── notes.d.ts
└── modules/             # optional: packages the agent's programs can import
    ├── journal/
    │   ├── package.json
    │   ├── index.js
    │   └── index.d.ts
    └── node_modules/    # optional: what the modules import, and the types of the services
        └── @svc/notes/
            ├── package.json
            └── index.d.ts → ../../../../api/notes.d.ts
```

A tau is self-contained, so that it can be moved or copied as a whole. What a runtime reads of it
(PROMPT.md, tau.json, skills/, api/, and what tau.json lists in `copy`) may hold symlinks, but only
relative ones, each leading, through any further symlinks, all relative, to something that exists
in the tau. Runtimes keep symlinks as they are. Anything else in the directory, such as the
sources a module is built from, is the author's, and no runtime reads it.

Services and modules are both code the agent's programs can call, and differ in where it runs:
- **A service runs outside** the agent's environment, where its provider is, and is reached over
  the socket. Anything that needs credentials, or reaches beyond the environment, is a service.
  Programs and modules import it as `@svc/<name>`.
- **A module runs inside**, in the same process as the program that imports it. A module adds
  code, not authority: it can do only what the agent's programs could do themselves, such as
  reading and writing files in the agent's working directory.

A module may import services, so it can give the agent a service in the shape the agent needs: a
thin wrapper, or one that adds what JSON cannot carry, such as dates, classes and iterators.

### Metadata

`tau.json` declares what a tau takes from whoever runs it, and what it gives back. Without it, a
tau takes no arguments and sees no environment variables.

```json
{
  "description": "Replace text in every file of a directory, and report what changed.",
  "args": [
    { "name": "src",    "type": "dir",  "role": "inout", "description": "The files to edit." },
    { "name": "old",    "type": "text", "description": "The text to replace." },
    { "name": "new",    "type": "text", "description": "What to replace it with." },
    { "name": "rules",  "type": "file", "role": "in" },
    { "name": "report", "type": "file", "role": "out" }
  ],
  "env": ["LANG", "TZ"],
  "copy": ["modules"]
}
```

- **`description`** says what the tau does, for whoever runs it, and each argument may have one
  too. A runtime can show them as usage, or offer the tau to another agent as a tool.
- **`args`** are positional, in this order, and all required. `name` matches
  `^[A-Za-z_][A-Za-z0-9_]*$`, and `type` says what the argument is:
  - `text`: any string, the empty one included.
  - `file` or `dir`: the path of a file or a directory on the caller's side, resolved against the
    caller's working directory. Its `role` says what the agent does with it:
    - `in`: reads it. It exists before the run, and the agent leaves it as it is.
    - `out`: writes it. Its directory exists before the run, and the agent starts without it:
      what the caller has at the path, if anything, is not shown to the agent, and a successful
      run replaces it with what the agent wrote.
    - `inout`: reads and changes it. It exists before the run, and a successful run leaves the
      agent's changes in it.

  No path may be another, or lie inside another, even once symlinks are followed, so that a
  runtime can place each on its own.
- **`env`** names the variables of the caller's environment the agent may see. Those the caller
  has not set are left out: what a tau cannot do without, it takes as an argument. What the
  runtime needs for itself, such as `TAU_SOCKET` or a model's credentials, is not the tau's to
  list.
- **`copy`** lists what a runtime copies into the agent's environment for its programs: paths in
  the tau, relative to it, such as `modules`. Without it, a runtime copies `modules`, if the tau
  has one. Each path exists, is written without `.` or `..` segments, and lies in the tau itself,
  not under a symlink, and no path is, or lies inside, another. A symlink in what is copied leads
  to what is copied, except under `modules/node_modules/@svc/` (see Modules). What is not listed
  stays out of the agent's environment: a module's sources, say, when its build writes to what is
  listed.
- Nothing else: an unknown key is refused.

`tau.json` says what the agent reads and writes, not how it gets there: that is up to the runtime
(see Running).

### Prompt

`PROMPT.md` is the prompt. The runtime replaces each `${name}` with the argument `name`: a text
argument with its value, and a path with where the agent sees it. `$${` stands for a literal `${`,
and any other `${` that does not name an argument of `tau.json` is refused. Nothing else is
expanded, so `$1` or `$@` are text.

### Service manifests

`api/<name>.d.ts` declares the service `<name>` in TypeScript. The file name is the service's
only name. It matches `^[A-Za-z0-9][A-Za-z0-9._-]*$`.

```ts
/**
 * A notebook of short notes, each with tags to find it by later.
 *
 * @packageDocumentation
 */

/** A saved note. */
export interface Note {
	id: number;
	text: string;
	tags: string[];
}

/**
 * Remember something and return the new note.
 * @param text - What to remember.
 * @param tags - Labels to find it by later.
 */
export declare function addNote(text: string, tags?: string[]): Promise<Note>;
```

- **Functions:** every exported function is a function of the service, and there is at least one.
  Parameters are positional; only trailing ones may be optional, written `name?: T`. A default
  value is refused: a declaration cannot have one, and what an omitted argument means is the
  provider's business.
- **Results:** every function's return type is written `Promise<T>`, where `T` is the type of its
  result, or `void` for a function without one. Any other return type is refused, including `T`
  or `void` alone, `PromiseLike<T>`, `globalThis.Promise<T>`, an alias of `Promise`, and a `T`
  that is itself a `Promise`.
- **Types:** a manifest may declare interfaces and type aliases, except ones named `Promise` or
  `Uint8Array`. Nothing else is allowed, including imports, values, classes and enums, so a
  manifest is self-contained.
- **Documentation:** TSDoc. The first doc comment, if it has `@packageDocumentation`, describes the
  service. A declaration's doc comment describes it, and `@param name - text` describes a
  parameter.
- **What a call can carry:** every parameter and result travels as JSON (see [Calls](#calls)), so
  its type must mean the same after the trip: JSON's values, and bytes. A manifest is refused, with
  the reason, when it cannot be translated to JSON Schema without changing its meaning. That
  includes:
  - `Date`, `Map`, `Set`, `bigint`, functions and class instances;
  - `T | undefined` (an optional property `p?: T` is fine);
  - generic and overloaded functions, rest and destructured parameters;
  - `any`, `readonly`, and TypeScript `enum` (use a union of string literals).
- **Bytes:** `Uint8Array` is bytes. It may stand wherever a type may: a parameter, a result, a
  property, the items of an array, the values of a record, a member of a union. Programs and
  providers hold bytes as a `Uint8Array`; on the wire they are base64. A union is refused when one
  string could be bytes in one of its members and text in the same place of another, as in
  `string | Uint8Array`, or `{ data: string } | { data: Uint8Array }`: the runtime could not tell
  which to hand over. `{ kind: "text"; data: string } | { kind: "bytes"; data: Uint8Array }` is
  fine, since `kind` tells them apart.

The check is mechanical: the manifest is translated to a small subset of JSON Schema (see the
header of [src/schema/service-schema.ts](src/schema/service-schema.ts)), in which bytes are
`{ "type": "string", "contentEncoding": "base64" }`. That schema is printed back as TypeScript, and
`tsc` must find each function's parameters and return type identical to the manifest's. The JSON
Schema is what runtimes validate calls against. The printed declarations serve only this check:
`@svc/<name>` is typed by the manifest as written.

### Modules

Each directory in `modules/` other than `node_modules/` is a package that programs import by its
`name` in `package.json`. The `@svc/` scope is reserved for services, and no two modules share a
name.

- **A built package:** `package.json` has `name` and `exports`, and the `"."` entry has type
  declarations (a `types` condition, or a `.d.ts` beside the JavaScript). The package's
  `description` describes it. How it was built is the author's business, and its `package.json`
  is copied (see `copy`).
- **Run from a copy:** a runtime runs modules from its copy of what `copy` lists, with every
  symlink kept as it is. A module's imports resolve as Node resolves them, from the real location
  of the importing file in that copy. A runtime adds nothing to resolve against but Node's
  builtins and the services. So a module brings what it imports, in what is copied: in its own
  files, in a `node_modules/` of its own, or in `modules/node_modules/`, which all modules share.
- **Services:** a file in `modules/` imports the service `<name>` as `@svc/<name>`. In its copy, a
  runtime puts its binding for each service at `modules/node_modules/@svc/<name>`, in place of
  whatever the tau has there, and Node finds it from anywhere in `modules/`. The tau itself may
  keep there, for each service, a package of the manifest's types to build modules against: a
  `package.json` with `"types": "./index.d.ts"`, and `index.d.ts` a symlink to
  `api/<name>.d.ts`. Anything there names a service of `api/`.
- **Pure JavaScript:** a module imports no native addons (`.node` files), which would tie the tau
  to one platform.
- **Node.js 24 or later:** runtimes run modules on Node.js 24 or later, so a module may use its
  APIs.

Reading a tau checks only the package itself. Whether a module's imports resolve, and to what,
depends on the files they lead to, so it is left to the runtime. `checkModule` in `@sleepymug/tau`
follows every import from a module's entry points and reports each one that does not resolve to
what the tau copies, each service `api/` does not declare, and each native addon, so a runtime can
refuse a module before a program depends on it.

## Binding

A tau that declares services runs only when **`TAU_SOCKET`** names a Unix domain stream socket that
a provider listens on. One socket serves every service. A runtime refuses to start a tau when it
has services and the socket is missing, just as a linker refuses an unresolved symbol.

The provider chooses the socket's path and permissions. The path must fit in `sun_path`, which is
107 bytes on Linux and 103 on macOS.

There is no handshake, discovery or metadata: the manifests are the only description of the
services.

## Calls

Each call uses its own connection: the runtime writes one request line, the provider writes one
response line, and the connection closes.

```
→ {"service":"notes","function":"addNote","args":["buy milk",["shopping"]]}
← {"result":{"id":1,"text":"buy milk"}}
```
or
```
← {"error":{"message":"disk full"}}
```

- **Framing:** UTF-8 JSON, one message per line, ended by the LF byte. Split only on LF, never on
  U+2028/U+2029, which JSON leaves unescaped inside strings.
- **`args`** are positional, in the order of `params`. Trailing optional arguments may be left out.
- **`result`** is required in a success response. A function that returns `Promise<void>` answers
  `{"result":null}`.
- **Bytes:** where the manifest declares a `Uint8Array`, the value is a JSON string of base64
  (RFC 4648 §4: the standard alphabet, padded). The runtime and the provider convert it from and to
  a `Uint8Array` where the manifest declares one, and nowhere else, so neither a program nor a
  provider sees base64.
- **Cancellation:** if the runtime closes its side before the response arrives, the call is
  cancelled, and the provider should stop the work. The runtime does not half-close while waiting.
- **Failure:** a connection that closes before a complete response line is a failed call.
- **Guarantee to providers:** the runtime sends only arguments that are valid under the manifest.
  Whether it checks results is its own business.

## Running

How the agent reaches its paths and environment is up to the runtime.
- **In place**, the agent sees each path where the caller has it, and the caller's environment.
  Nothing keeps it from other files and variables, or from changing an `in` path.
- **Isolated**, in a sandbox or a container, the runtime places each path where it chooses, by
  mounting or copying it, and gives the agent only the variables `env` names. It may keep the
  agent from changing its `in` paths.

Either way, the prompt names each path where the agent sees it.

### Results

A run gives back whether it succeeded, the agent's final message, and its `out` and `inout`
paths. Anything else the agent writes is scratch: nothing after the run may rely on it, and a
runtime may keep it or throw it away. So a tau does not rely on its working directory either,
which is up to the runtime.

A run fails when the runtime cannot run the agent to the end, or when its paths do not fit
(below). Whether the agent did what it was asked is not the runtime's to judge: a tau that needs
to say so defines how, in its prompt and outputs. Run as a command, without a person at the
terminal, a runtime writes the agent's final message to stdout, and why a run failed to stderr,
and exits with 0 only when the run succeeded.

### Paths

A runtime keeps to what `tau.json` promises the caller:
- **Before the run**, each `in` and `inout` path is a file or a directory as declared, and each
  `out` goes into an existing directory, and replaces nothing of the other type. No path is, or
  lies inside, another. A runtime refuses to start a run whose paths do not fit.
- **After a successful run**, each `out` path holds what the agent wrote there, in place of what
  the caller had, and each `out` and `inout` path is a file or a directory as declared. A runtime
  reports a run whose paths do not fit as failed.
- **After a failed run**, what the `out` and `inout` paths hold is up to the runtime.

Symlinks are followed, except at an `out` path, which the run replaces. `checkInputs` and
`checkOutputs` in `@sleepymug/tau` check all of this.

## Runtimes

How services and modules reach the model is up to the runtime. For example, pi-run gives the model
a TypeScript `execute` tool. The programs it runs import each service as `@svc/<name>`, typed by
its manifest, and each module by its package name.
