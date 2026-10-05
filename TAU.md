# TAU (Transportable Agent Unit)

A **tau** is an agent packaged as a directory: a prompt, what it takes and gives, and the APIs its
programs call, declared in TypeScript.

## Layout

```
plan-trip/
├── PROMPT.md                   the prompt, the only file required
├── tau.json                    what it takes, and what its programs import
├── skills/visas/SKILL.md       a skill the agent can use
├── api/travel/index.d.ts       an API, which programs import as @api/travel
├── api/tau/index.d.ts          the tau API
├── node_modules/trip-search/   a package of its own, built on @api/travel
└── taus/city-guide/            the author's own: here, a tau it runs
```

`tau.json`:

```json
{
  "description": "Plan and book a trip for a group, and write its itinerary.",
  "params": {
    "cities": { "type": "list", "of": { "type": "text" }, "description": "Where to go, in order." },
    "dates": {
      "type": "record",
      "fields": { "start": { "type": "text" }, "end": { "type": "text" } },
      "description": "When the trip starts and ends."
    },
    "travelers": {
      "type": "list",
      "of": {
        "type": "record",
        "fields": {
          "name": { "type": "text" },
          "home": { "type": "text" },
          "nationality": { "type": "text" }
        }
      },
      "description": "Who goes, and where each sets out from."
    },
    "wishes": { "type": "file", "mode": "in", "description": "What the group likes and avoids." },
    "trip": { "type": "dir", "mode": "inout", "description": "The trip's bookings." },
    "itinerary": { "type": "file", "mode": "out", "description": "The plan, day by day." }
  },
  "exposes": ["trip-search", "@api/tau"]
}
```

`PROMPT.md`:

```
Plan a trip through ${cities}, from ${dates.start} to ${dates.end}, for the travelers your programs
read through the tau API, each setting out from their home, and check the visas each needs. Keep
to ${wishes}. Book it with trip-search, saving each booking in ${trip}, and write the plan, day by
day, to ${itinerary}. Then have the tau at ${self}/taus/city-guide write a guide to each city, with
the same wishes, into ${trip}.
```

A call gives a value for each parameter, as JSON:

```json
{
  "cities": ["Lisbon", "Porto"],
  "dates": { "start": "2027-05-01", "end": "2027-05-08" },
  "travelers": [
    { "name": "Ana", "home": "Madrid", "nationality": "Spanish" },
    { "name": "Ben", "home": "Toronto", "nationality": "Canadian" }
  ],
  "wishes": { "$in": "wishes.md" },
  "trip": { "$inout": "portugal" },
  "itinerary": { "$out": "itinerary.md" }
}
```

- `params` are what the caller gives, all required: a `text`; a **handle**,
  `{"$in" | "$out" | "$inout": path}`, to a `file`, `dir`, or `path` (either) of the caller's, which
  the agent reads, leaves something at, or changes in place; a `list` `of` a type; or a `record`,
  closed with its `fields`, or open. Types nest to any depth.
- The prompt is expanded once for the run: `${name}` becomes a text, a handle's path where the
  agent sees it, or a list of either, as a JSON array; `${a.b}`, a field of a closed record;
  `${self}`, the tau's own directory, which the agent reads but does not change; and `$${`, a
  literal `${`. The rest, such as `travelers`, the agent's programs read through the tau API.
- An API is declared in `api/<name>/` as TypeScript, whose doc comments say what it does, and the
  runtime implements it, so the tau holds neither its code nor credentials. `node_modules/` holds
  packages built on the APIs. The agent's programs, in TypeScript for Node.js 24 or later, import
  what `exposes` lists, by default every API.
- The **tau API**, `@api/tau`, gives programs `values()`, the run's values, each handle as its path
  where the agent sees it, and `run(tau, values)`, which runs another tau and resolves to how it
  ended.
- Each directory with a `SKILL.md` in `skills/`, at any depth, is a skill the agent can use.

## Semantics

A **runtime** runs a tau for a **caller**: a person, a program, or another agent.

- **A call** gives every parameter a value. A runtime refuses one it cannot carry out as declared:
  a value or a path that does not fit, an API it has no implementation of.
- **The run succeeds** if the agent finishes on its own, neither stopped nor failing, and leaves a
  file or a directory, as declared, at each `out` and `inout` handle. The caller's paths then hold
  what it left, a directory merging into one already there. Either way, the caller gets the
  outcome, why if it failed, and the agent's final text. Success says the agent finished, not that
  it did well: a tau that must say so does it in its `out`s or its text.
- **Its effects are its final text, its `out` and `inout` handles, and its API calls**, which take
  effect when made, and stay if the run fails. What the agent writes anywhere else is scratch. It
  learns of the caller only what the call gives it.
- **Runs nest.** An agent that runs a tau is that run's caller, giving paths in its own view. A
  handle carries its mode, so the agent can pass on a value it was given as it is, and it can make
  several runs at once.

A tau says what its agent needs, never how: where it runs, which model and tools drive it, how its
skills and APIs are shown to it and implemented, and what else it finds, such as commands or the
network, are the runtime's. So is whether a handle is the caller's own file or a copy, so a tau
relies on nothing that sets them apart: whether the caller's later changes reach the agent, what an
`out` holds at first, and what a failed run leaves at the caller's paths. An isolated runtime keeps
these promises whatever the agent does; an unisolated one, which runs the agent with the caller's
access, only as far as the agent keeps to its handles.
