# TAU (Transportable Agent Unit)

A **tau** is an agent packaged as a directory: a prompt, what it takes and gives, and the APIs its
programs call, declared in TypeScript. A **runtime** runs it for a **caller**: a person, a
program, or another agent. The full spec is in [docs/spec/](docs/spec/index.md).

## Layout

```
count-words/
├── PROMPT.md                   the prompt
├── tau.json                    what it takes and gives
├── skills/<skill>/SKILL.md     skills the agent can use (optional)
├── api/stats/index.d.ts        an API, which programs import as @api/stats (optional)
└── node_modules/<package>/     packages of its own, built on its APIs (optional)
```

`tau.json`:

```json
{
  "description": "Count the words of a file, and write the most frequent.",
  "params": {
    "notes":  { "type": "file", "mode": "in",  "description": "The file to count." },
    "top":    { "type": "text", "description": "How many words to list." },
    "counts": { "type": "file", "mode": "out", "description": "The most frequent words." }
  },
  "exposes": ["@api/stats"]
}
```

`PROMPT.md`:

```
With the stats API, count the words of ${notes}, and write the ${top} most frequent to ${counts}.
```

A call gives a value for each parameter, as JSON:

```json
{ "notes": { "$in": "notes.txt" }, "top": "10", "counts": { "$out": "counts.txt" } }
```

- `params` are what the caller gives, each by name, all required: a `text`; a **handle** to a
  `file`, `dir`, or `path` (either) of the caller's, which the agent reads (`in`), writes (`out`),
  or changes in place (`inout`); or a `list` or a `record` of such values, to any depth.
- In the prompt, `${name}` becomes a text's value, a handle's path where the agent sees it, or a
  list of either, as a JSON array; `${a.b}`, a field of a closed record; `${self}`, where the tau's
  own directory is; and `$${`, a literal `${`. Records, and lists of lists or records, are not in
  the prompt: the agent's programs read them, through the tau API.
- `exposes` lists what the agent's programs import, by default every API.

More: [Directory](docs/spec/directory.md), [Metadata](docs/spec/metadata.md),
[Values](docs/spec/values.md), [Prompt](docs/spec/prompt.md), [APIs](docs/spec/apis.md),
[Packages](docs/spec/packages.md).

## Semantics

A tau specifies an agent's interface, not how it runs: the instructions the model receives, the
files it is given as input, the output and file changes expected of it, and the actions it may
take that have visible effects.

### A run

1. **Call.** The caller gives every parameter a value. A runtime refuses a call it cannot carry out
   as declared: a value that does not fit its type, a handle whose path does not fit its mode, an
   API it has no implementation of.
2. **Start.** The runtime gives the agent each handle, where it chooses, keeping its base name:
   the caller's own file or directory, or a copy; and the tau's directory at `${self}`, to read but
   not change.
3. **Work.** The agent works on the prompt, values substituted. It reads its `in` handles, leaves
   at its `out`s what goes there, changes its `inout`s in place, uses its skills, and writes
   programs, in TypeScript for Node.js 24 or later, that import what the tau exposes, each API
   through the runtime's implementation.
4. **End.** The run succeeds if the agent finishes on its own, neither stopped nor failing, and
   leaves at each `out` and `inout` handle a file or a directory as declared. By the time the
   caller learns it, each of those paths holds what the agent left: a copy is put there, a
   directory merging into a directory already there. Either way, the caller gets the outcome, why
   if it failed, and the agent's final text, and nothing else. Success says the agent finished,
   not that it did well: a tau that must say so does it in its `out`s or its text.

### What a run promises

- **Its effects are its final text, its `out` and `inout` handles, and its API calls.** It
  changes no path of the caller's but those its values hand it to write, so a runtime can list
  them before it starts. API calls take effect when made, and stay if the run fails.
- **Copying or not is the runtime's.** A tau relies on nothing that sets them apart: whether the
  caller's later changes reach the agent, what an `out`'s place holds at first, and whether the
  agent's changes reach the caller's paths as it makes them or once the run succeeds, so what a
  failed run leaves there. A caller that needs all or nothing gives fresh `out` paths, and moves
  them once the run succeeds.
- **The caller's paths may overlap.** Whether the agent sees through one what it does through
  another is not specified; copies are put once every `in` was read, inner paths last.
- **A handle holds all it leads to.** Its path is never a symlink itself, and a symlink in a
  directory is relative, and leads, through any others, to something inside that directory: an
  `in` or `inout` that breaks this refuses the call; an `out` or `inout` left breaking it fails
  the run. A copy keeps modes and such symlinks.
- **The agent learns of the caller only what the call gives it**: texts, and the files and
  directories its handles name. Never the caller's environment or working directory. What it
  writes anywhere else is scratch: a runtime may keep it or throw it away, and nothing after the
  run relies on it.

### What it leaves to the runtime

A tau says what its agent needs, never how it gets it, so a runtime is free to choose:
- **Where the run happens**: on the caller's machine or another, in a sandbox or not, inside
  another run or not, alongside any number of others.
- **How each handle is given**: the caller's own file or directory, at its path or mounted
  elsewhere, or a copy, made eagerly, lazily, or copy-on-write; and where the working directory
  and the tau's directory are. The tau's directory, which no run changes, can be shared by all its runs, and prepared
  ahead.
- **How each API is implemented**: in the program's process or behind a channel, acting on
  whatever the runtime binds it to, with credentials the tau never holds. Wherever it runs, its
  calls mean what its declarations say, in the program's terms: a path names a file of the view.
- **How the model is driven**: which model, what tools it reads, writes and runs programs with,
  and how its skills and what the tau exposes are shown to it.
- **What else the agent finds**: commands, the network, other files. A tau that relies on them
  runs only where a runtime gives them.

An **isolated** runtime keeps these promises whatever the agent does, since the agent reaches
nothing of the caller's but its handles and its APIs, and it may hold the agent to each handle's
mode. An **unisolated** one runs the agent with the caller's own access, and keeps them only as far
as the agent keeps to its handles.

More: [Implementations](docs/spec/implementations.md), [Running](docs/spec/running.md),
[Results](docs/spec/results.md), [Paths](docs/spec/paths.md), [Runtimes](docs/spec/runtimes.md),
[The tau API](docs/spec/tau-api.md).
