# Values

A run takes a **value** for each parameter of the tau (see [Metadata](metadata.md)), and gives back
the agent's final text and, if it succeeds, the changes at its `$out` and `$inout` handles (see
[Results](results.md)).

## Syntax

A value is JSON:

```
value  := text | handle | list | record
text   := a string
handle := {"$in": path} | {"$out": path} | {"$inout": path}
list   := [value, …]
record := {name: value, …}
```

- A **text** is any string, the empty one included.
- A **handle** is a file or a directory of the caller's, with its **mode**, what the agent does with
  it. `path` is the caller's path, not empty: relative to the caller's working directory, or
  absolute.
- A **list** holds values in order, and a **record** values by name, to any depth. A name matches
  `^[A-Za-z_][A-Za-z0-9_]*$`, so no record has a key that begins with `$`, and a handle is never
  taken for a record.

A run's values are a record, from each parameter's name to its value. These run the tau of
[Metadata](metadata.md):

```json
{
  "site": { "$inout": "site" },
  "edits": [{ "old": "colour", "new": "color" }, { "old": "grey", "new": "gray" }],
  "rules": { "$in": "style.md" },
  "report": { "$out": "out/report.md" }
}
```

How a caller writes values, on a command line for instance, is the runtime's to choose: any form
that converts to this one.

## Handles

A handle gives the agent a file or a directory of the caller's, with its mode, what the agent does
with it:
- `$in`: the agent reads what is at the path when the run starts.
- `$out`: the agent leaves at the handle's place what goes at the path. What the place holds at
  first, nothing or what is at the path, is not specified, so the agent makes what it leaves.
- `$inout`: the agent changes in place what is at the path when the run starts.

A runtime gives the agent either the caller's own file or directory, or a copy, which it puts at
the path once the run succeeds (see [Results](results.md)). Both are allowed, so a tau relies on
nothing that sets them apart:
- whether what the caller does at a path after the run starts reaches the agent;
- whether what the agent does at an `$out` or `$inout` handle reaches the path as it does it, or
  once the run succeeds, and so what a run that fails leaves there;
- what writing an `$in` handle does to the path: the agent does not write one.

The `$out` and `$inout` handles in a run's values, at any depth, are every path of the caller's the
run may change: a run writes nowhere its caller has not handed it a handle to, and a runtime can
list them all before the run starts. Anything else a run changes, it changes through its APIs.

## Passing values on

A handle carries its mode, so a value means the same without its type. An agent that runs another
tau is that run's caller, and its paths are in its own view. It can pass on a value it was given,
whole, or build one from it. An agent given `args`, an open record of another tau's values, can
run that tau with them, or, as a best-of-N agent does for each of its runs, with values in which
each `$out` and `$inout` handle names a path of its own, which it fills first for an `$inout`.

## How the agent sees them

What the model learns of the values, the prompt tells it: the prompt names texts, handles, and
lists of them, a parameter's or a field's of a closed record (see [Prompt](prompt.md)), and says
what the agent needs of the rest. The agent's programs read every value, each handle as its place in the view,
through the [tau API](tau-api.md), when the tau declares it.

## Open

- The kind of an `$out` handle no type declares, such as one in an open record: whatever the agent
  leaves, or one the handle carries, as in `{"$out": "r.md", "$type": "file"}`.
- Numbers and booleans: none for now; a text holds them.
- Whether an `$inout` handle may be given where a type's mode is `in`, which only reads it, as
  Rust's `&mut T` coerces to `&T`.
- Whether a tau may name a handle as the agent's working directory, such as the `$inout` project
  of a coding agent.
