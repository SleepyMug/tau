# Calls

A run takes a **call**: a path for each of the tau's files, and for any other the caller gives the
agent, and the args (see
[Metadata](metadata.md)). It gives back the agent's final text and, if it succeeds, what the agent
left at its `out` and `inout` files (see [Results](results.md)).

## Syntax

A call is JSON:

```
call  := {"files": {name: file, …}, "args": {name: json, …}}
file  := paths | {"mode": mode, "path": paths, "kind": kind}
paths := path | [path, …]
```

- `files` gives a path for each file the tau declares, and may give others, **extra files**. A
  **path** is the caller's, not empty: relative to the caller's working directory, or absolute.
  An `in` file whose kind is not `file` may be given a list of paths instead, whose base names
  differ: the agent sees one directory, holding what is at each path under its base name.
- An extra file is given as an object, with its `mode`, `in`, `out` or `inout`, its `path` or
  paths, and, optionally, its `kind`, `file` or `dir`; without one, it may be either. A declared
  file may be given so too, its `mode` the one `tau.json` declares, and its `kind`, if given, the
  declared one, or either when the tau declares none.
- An extra file is named as any file is, in the run's scope, where no arg, declared or given,
  has its name (see [Placeholders](placeholders.md)).
- `args` are any JSON object that fits the schema (see [Metadata](metadata.md)). They hold no file:
  a string in them names one only with a placeholder (see [Placeholders](placeholders.md)).

Either key may be left out when it would be empty. This runs the tau of
[Metadata](metadata.md):

```json
{
  "files": { "site": "site", "rules": "style.md", "report": "out/report.md" },
  "args": { "edits": [{ "old": "colour", "new": "color" }, { "old": "grey", "new": "gray" }] }
}
```

How a caller writes a call, on a command line for instance, is the runtime's to choose: any form
that converts to this one.

## Files

A file's mode, which `tau.json` declares, or the call, for an extra file, says what the agent
does with it:
- `in`: the agent reads what is at the path when the run starts.
- `out`: the agent leaves at the file's place what goes at the path. What the place holds at
  first, nothing or what is at the path, is not specified, so the agent makes what it leaves.
- `inout`: the agent changes in place what is at the path when the run starts.

A runtime gives the agent either the caller's own file or directory, or a copy, which it puts at
the path once the run succeeds (see [Results](results.md)). Both are allowed, so a tau relies on
nothing that sets them apart:
- whether what the caller does at a path after the run starts reaches the agent;
- whether what the agent does at an `out` or `inout` file's place reaches the path as it does it,
  or once the run succeeds, and so what a run that fails leaves there;
- what writing at an `in` file's place does to the path: the agent does not write one.

The files `tau.json` declares are what the prompt and init need, and they name them (see
[Placeholders](placeholders.md)). A caller may give more: the agent reaches an extra file through
the args, which name it with a placeholder, and through the [tau API](tau-api.md), and the
runtime places and puts it as any other.

The paths of the `out` and `inout` files are every path of the caller's the run may change: a run
writes nowhere its caller has not given it as such a file, and a runtime can list them all, from
the call and the tau, before the run starts. Anything else a run changes, it changes through its
APIs.

## Args

The args are the caller's data. A runtime checks them against the schema, as JSON Schema does,
before the run starts, and their placeholders, and refuses a call whose args do not fit, or name
what they cannot, or themselves (see [Placeholders](placeholders.md)). Once the files are placed,
it expands the args' placeholders, and that is how the agent sees them: in the prompt, and through
the [tau API](tau-api.md).

## Passing a call on

An agent that runs another tau is that run's caller, and its paths are in its own view: it gives a
file of its own by its place, as the tau API has it. An arg that named one of its files reaches it
expanded, as a place in its view; to point the new run's agent there, it names the new run's file
with a placeholder, in that run's args, as in `"${src}/index.html"`, and gives `src` the place.

A caller may hand an agent a whole call to make, as an arg, such as to a tau that makes several
runs of another and keeps the best. The call's paths are the agent's to give, so the caller writes
each as a placeholder naming a file it gives the agent, which expanding makes that file's place
in the agent's view. A placeholder meant for the new run takes one `$` more, which expanding
drops, so that the agent passes it on as the new run expands it (see
[Placeholders](placeholders.md)). The caller gives the agent what the new run takes as extra
files, here the tau to run, `inner`, and the call's files, to a tau whose schema declares `tau`,
`runs` and `call`:

```json
{
  "files": {
    "inner": { "mode": "in", "kind": "dir", "path": "plan-trip" },
    "wishes": { "mode": "in", "path": "wishes.md" },
    "trip": { "mode": "inout", "path": "portugal" }
  },
  "args": {
    "tau": "${inner}",
    "runs": 3,
    "call": {
      "files": { "wishes": "${wishes}", "trip": "${trip}" },
      "args": { "notes": "Ben booked his flight: $${trip}/ben.pdf" }
    }
  }
}
```

The agent sees `tau` as `/in/plan-trip`, and the call as `{"files": {"wishes": "/in/wishes.md",
"trip": "/work/portugal"}, "args": {"notes": "Ben booked his flight: ${trip}/ben.pdf"}}`, with its
own places: it gives each run a copy of `trip` of its own, and leaves the best at
`/work/portugal`.

## Open

- Whether a tau may name a file as the agent's working directory, such as the `inout` project of a
  coding agent.
