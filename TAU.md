# TAU (Transportable Agent Unit)

A **TAU** is an agent packaged as a directory: a prompt, the files and args it takes, and the APIs
its programs call. A **runtime** runs one for a **caller**, a person, a program or another agent:
the TAU's **agent**, a model, does the task its prompt sets, with what the caller gives it. This
says what a TAU takes and what a run of one promises; TAU_DEV.md says how to make one.

## What a TAU takes

A TAU's directory holds its prompt, `PROMPT.md`, which says what the agent does, and, if it takes
anything, `tau.json`, which declares what:

```json
{
  "description": "Plan a trip for a group, and write its itinerary.",
  "files": {
    "wishes": { "kind": "file", "mode": "in", "description": "What the group likes and avoids." },
    "trip": { "kind": "dir", "mode": "inout", "description": "The trip's bookings." },
    "itinerary": { "kind": "file", "mode": "out", "description": "The plan, day by day." }
  },
  "args": {
    "type": "object",
    "properties": {
      "cities": { "type": "array", "items": { "type": "string" }, "description": "Where to go, in order." },
      "travelers": { "type": "array", "items": { "type": "string" }, "description": "Who goes, and from where." }
    },
    "required": ["cities", "travelers"]
  }
}
```

- **Files** are the caller's files and directories the agent works with, each by name, with its
  `mode`: `in`, the agent reads it; `out`, it leaves one there; `inout`, it changes it. Its `kind`
  is `file` or `dir`, or, without one, either.
- **Args** are JSON that fits `args`, a JSON Schema (draft 2020-12) of an object.

## A call

A **call** gives a path of the caller's for each file, and the args:

```json
{
  "files": { "wishes": "wishes.md", "trip": "portugal", "itinerary": "itinerary.md" },
  "args": {
    "cities": ["Lisbon", "Porto"],
    "travelers": ["Ana, from Madrid", "Ben, from Toronto, who booked his flight: ${trip}/ben.pdf"]
  }
}
```

- A relative path is the caller's working directory's. An `out` file's directory must exist.
- An `in` file may be given a list of paths, which the agent sees as one directory holding each
  under its base name. Files do not nest.
- **Extra files**, which `tau.json` does not declare, are given with their mode, and optionally
  their kind, as `"notes": {"mode": "in", "path": "notes.md"}`, for the args to name.
- The agent sees none of the caller's paths: it sees each file at its **place**, which the runtime
  chooses. So an arg names a file only by a **placeholder**: `${trip}` becomes the place of the file
  `trip`, and `${trip}/ben.pdf` a path in it. `${cities}` becomes that arg's value, a string as it
  is, anything else as JSON, and `${a.b}` the value at `b` in an object arg `a`. A run of `$` before
  a `{` loses one, so `$${trip}` is a literal `${trip}`, and any other `${` is refused. The prompt's
  placeholders expand the same way.

## A run

- **It succeeds** if the agent finishes on its own, neither stopped nor failing, or the TAU's init
  does the run in its place (TAU_DEV.md), and leaves a file or a directory, as declared, at each
  `out` and `inout` file's place. The caller's paths then hold what it left: a file replaces what is
  there, and a directory merges into one there, so what the agent removed from it may stay.
- **The caller gets** whether it succeeded, why if not, and the agent's final text, or init's.
  Success says the agent finished, not that it did well: a TAU that must say so does it in its
  outputs or its text.
- **Its effects** are its final text, its `out` and `inout` files, and its API calls, which take
  effect when made, and stay if the run fails. What the agent writes anywhere else is scratch. The
  agent learns of the caller only what the call gives it, and cannot ask the caller anything.
- **Runs nest.** An agent whose TAU has the TAU API, `@sleepymug/tau-api`, runs a TAU with `run(tau,
  call)`, giving paths in its own view, such as its files' places, and it can make several runs at
  once. A caller can hand an agent a call to make as an arg, its placeholders for the new run
  escaped: `"$${trip}/ben.pdf"` reaches the agent as `"${trip}/ben.pdf"`, which the new run expands.

A TAU says what its agent needs, never how: where it runs, which model and tools drive it, and what
else it finds, such as commands or the network, are the runtime's. So are the places, and whether a
file is the caller's own or a copy, so a caller relies on nothing that sets them apart: whether its
later changes reach the agent, what an `out` holds at first, and what a failed run leaves at its
paths. An isolated runtime keeps these promises whatever the agent does; one that runs the agent
with the caller's access, only as far as the agent keeps to its files.
