# tau: Transportable Agent Unit

A tau is an agent packaged as a directory. Like a program, it declares the APIs it needs, as
TypeScript declarations, but it never contains their implementations or any credentials. It also
declares what it takes and gives: its arguments, the environment variables it may see, and the
files and directories it reads and writes. A **runtime** such as pi-run executes the tau, provides
an implementation of each of its APIs, and presents them to the model in whatever way it chooses.

An API is an abstraction boundary, not a security one. It says what the agent's programs can call,
and what they get back, in whatever TypeScript can declare. How a call is carried out is the
runtime's business (see [Implementations](#implementations)): in the program's own process, or
through another that holds what the agent must not see. A tau cannot tell the difference, and does
not depend on it.

This spec defines a **compiled format**: a tau as runtimes read and run it, as a built package is
what gets installed, not the sources it is built from. That is why its links are limited (see
[Directory](#directory)): a tau holds everything it uses, so an API or a skill that two taus share
is a copy in each. A source format, in which taus could share such parts and from which they would
be built into this one, is a work in progress.

## Directory

```
my-agent/
├── PROMPT.md            # required: the prompt, naming each argument as ${name}
├── tau.json             # optional: what it does, and what it takes and gives
├── skills/              # optional: skills (any dir with SKILL.md, recursively)
└── api/                 # optional: the APIs the agent needs, one declaration file each
    ├── notes.d.ts
    └── shared/          # optional: anything the API files import
```

A tau is self-contained, so that it can be moved or copied as a whole. What a runtime reads of it
(PROMPT.md, tau.json, skills/ and api/) may hold symlinks, but only relative ones, each leading,
through any further symlinks, all relative, to something that exists in the tau. Runtimes keep
symlinks as they are. Anything else in the directory, such as the sources of its skills, or a tau
it runs, is the author's: no runtime reads it, though the agent may, where `${self}` names the
directory (see [Prompt](#prompt)).

### Metadata

`tau.json` declares what a tau takes from whoever runs it, and what it gives back. Without it, a
tau takes no arguments and sees no environment variables.

```json
{
  "description": "Replace text in every file of a directory, and report what changed.",
  "args": [
    { "name": "src",    "type": "dir",  "role": "share", "description": "The files to edit." },
    { "name": "old",    "type": "text", "description": "The text to replace." },
    { "name": "new",    "type": "text", "description": "What to replace it with." },
    { "name": "rules",  "type": "file", "role": "in" },
    { "name": "report", "type": "file", "role": "out" }
  ],
  "env": ["LANG", "TZ"]
}
```

- **`description`** says what the tau does, for whoever runs it, and each argument may have one
  too. A runtime can show them as usage, or offer the tau to another agent as a tool.
- **`args`** are positional, in this order, and all required. `name` matches
  `^[A-Za-z_][A-Za-z0-9_]*$` and is not `self`, which names the tau's own directory (see
  [Prompt](#prompt)), and `type` says what the argument is:
  - `text`: any string, the empty one included.
  - `file` or `dir`: the path of a file or a directory on the caller's side, resolved against the
    caller's working directory. Its `role` says what the agent does with it:
    - `in`: reads it. It exists when the run starts.
    - `out`: writes it. The directory it goes in exists when the run starts, and if the agent
      returns normally, the path exists when the run ends. The agent does not rely on what is at
      the path before it writes it.
    - `share`: reads and changes it. It exists when the run starts, and the agent works on the
      caller's own file or directory, not a copy, so its changes reach the caller as it makes
      them, whether or not the run succeeds.

  Paths may overlap: one may be another, or lie inside it. What one shows of another is up to
  the runtime.

  A tau with no `share` path is **functional**: it needs nothing live from the caller, only its
  `in` paths to read and its `out` paths to write, so a runtime can run it wherever it can copy
  those in and out, including inside another run. A tau with a `share` path is
  **procedural**: it changes the caller's files as it goes, so it runs only where the runtime can
  give it those files themselves.
- **`env`** names the variables of the caller's environment the agent may see. Those the caller
  has not set are left out: what a tau cannot do without, it takes as an argument. What the
  runtime needs for itself, such as a model's credentials or what its implementations use, is not
  the tau's to list.
- Nothing else: an unknown key is refused.

`tau.json` says what the agent reads and writes, not where the agent sees it: that is up to the
runtime (see Running).

### Prompt

`PROMPT.md` is the prompt. The runtime replaces each `${name}` with the argument `name`: a text
argument with its value, and a path with where the agent sees it. It replaces `${self}` with where
the agent sees the tau's own directory, so the prompt can name what the tau holds beside its
prompt, such as a file to read or another tau to run. `$${` stands for a literal `${`, and any
other `${` that is neither `${self}` nor names an argument of `tau.json` is refused. Nothing else
is expanded, so `$1` or `$@` are text.

### APIs

`api/<name>.d.ts` declares the API `<name>`, which the agent's programs import as `@api/<name>`.
The file name is the API's only name, and matches `^[A-Za-z0-9][A-Za-z0-9._-]*$`. Anything else in
`api/`, such as a directory of types that several APIs share, is not an API, but API files may
import it.

```ts
/**
 * A notebook of short notes, each with tags to find it by later.
 *
 * @packageDocumentation
 */

import type { Tag } from "./shared/tags.js";

/** A saved note. */
export interface Note {
	readonly id: number;
	text: string;
	tags: Tag[];
	written: Date;
}

/**
 * Remember something and return the new note.
 * @param text - What to remember.
 * @param tags - Labels to find it by later.
 */
export declare function addNote(text: string, tags?: Tag[]): Promise<Note>;

/** Notes carrying `tag`, oldest first, as they are found. */
export declare function byTag(tag: Tag, signal?: AbortSignal): AsyncIterable<Note>;
```

An API file is a TypeScript declaration file, and may declare whatever one can: functions, sync or
async, overloaded or generic; classes, constants, namespaces, interfaces and types. Beyond what
TypeScript asks of such a file, a tau asks only that it hold what the file imports:
- **It type-checks.** The API files, and what they import, are checked together by TypeScript 6.0,
  with `strict` on, imports resolved as Node.js resolves them (`"module": "NodeNext"`), and the
  ES2022 library and the types of Node.js 24 (`@types/node`) as the environment, since the agent's
  programs run on Node.js 24 or later. TypeScript must find no errors in them, and each API file is a module, so
  that programs can import it. A package's types that they import from a `node_modules/` are taken
  as they are, as `skipLibCheck` would.
- **It is self-contained.** Every file the API files reach lies in the tau, apart from the ES library
  and Node.js's types. An API file imports another as `./other.js`, and a package's types from a
  `node_modules/` in the tau, such as `api/node_modules/`.
- **Documentation:** TSDoc. The first doc comment of an API file, if it has
  `@packageDocumentation`, describes the API. Programs, and the agent, learn an API from its
  declarations and their doc comments.

`loadApis` in `@sleepymug/tau` checks all of this.

### Implementations

A tau runs only when the runtime has an implementation of each of its APIs: a module whose exports
are what the API declares. A runtime refuses to start a tau when an API has no implementation, just
as a linker refuses an unresolved symbol, and when TypeScript does not find the implementation's
module type, `typeof import(implementation)`, assignable to the API's: each value the API exports,
the implementation exports too, with a type that fits. `checkImplementation` in `@sleepymug/tau`
checks this.

- **An API is written for its agent.** It declares what the agent's programs use, with documentation
  written for the agent, and may declare less than an implementation offers. One implementation can
  serve every tau whose API it fits. Since the check is TypeScript's, a class with `private` members
  fits only its own declaration, so an API declares what programs use of a class, and leaves its
  private members out.
- **Programs see the API.** `@api/<name>` is typed by `api/<name>.d.ts` as the tau has it, with its
  imports resolving as they do there, whatever else the implementation declares.
- **How an implementation runs is the runtime's business.** It may run in the program's process, or
  be split in two: a part there, which calls, over a socket or any other channel, a part that holds
  credentials or reaches beyond the agent's environment. The agent can read and change whatever
  runs in its environment, so a runtime that keeps something from the agent keeps it outside,
  behind its implementations. Values that cross a process boundary are the implementation's to
  carry: an API declares them as programs hold them.

## Running

How the agent reaches its paths, its environment and the tau's own directory is up to the runtime.
- **In place**, the agent sees each path where the caller has it, the tau's directory where it
  is, and the caller's environment. Nothing keeps it from other files and variables, or from
  changing an `in` path or the tau.
- **Isolated**, in a sandbox or a container, the runtime places each path where it chooses: an
  `in` or `out` path by copying or mounting it, and a `share` path by mounting it, since it must
  stay the caller's own. It places the tau's directory too, whole, by copying or mounting it. It
  gives the agent only the variables `env` names, and may keep the agent from changing its `in`
  paths or the tau.

Either way, the prompt names each path, and the tau's directory, where the agent sees it.

### Results

A run gives back whether it succeeded, the agent's final message, and its `out` paths; its `share`
paths already hold its changes. Anything else the agent writes is scratch: nothing after the run
may rely on it, and a runtime may keep it or throw it away. So a tau does not rely on its working
directory either, which is up to the runtime.

A run fails when the agent does not return normally, running to the end without being stopped
or failing, or when its paths do not fit (below). Whether the agent did what it was asked is not the
runtime's to judge: a tau that needs to say so defines how, in its prompt and outputs. Run as a
command, without a person at the terminal, a runtime writes the agent's final message to stdout,
and why a run failed to stderr, and exits with 0 only when the run succeeded.

### Paths

A runtime keeps to what `tau.json` promises the caller:
- **When the run starts**, each `in` and `share` path is a file or a directory as declared, and
  each `out` goes into an existing directory, and is not already something of the other type. A
  runtime refuses to start a run whose paths do not fit, or a procedural tau where it cannot
  give the agent the caller's own `share` paths.
- **When the run ends**, if the agent returned normally, each `out` and `share` path is a file
  or a directory as declared. A runtime reports a run whose paths do not fit as failed.

Nothing else is promised: what an `in` path holds once the run has started, what an `out` path
holds before the agent writes it or beside what it wrote, and what a failed run leaves at an
`out` path are up to the runtime. Symlinks are followed. `checkInputs` and `checkOutputs` in
`@sleepymug/tau` check the paths' shapes.

## Runtimes

How APIs reach the model is up to the runtime. For example, pi-run gives the model a TypeScript
`execute` tool. The programs it runs import each API as `@api/<name>`, typed by its declarations.
