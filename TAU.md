# TAU (Transportable Agent Unit)

A **tau** is an agent packaged as a directory: a prompt, the files and args it takes, and the APIs
its programs call, declared in TypeScript.

## Layout

```
plan-trip/
├── PROMPT.md                   the prompt, the only file required
├── tau.json                    its files and args, what its programs import, and its init
├── init.mts                    run first: writes the itinerary itself if the trip is booked
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
  "files": {
    "wishes": { "kind": "file", "mode": "in", "description": "What the group likes and avoids." },
    "trip": { "kind": "dir", "mode": "inout", "description": "The trip's bookings." },
    "itinerary": { "kind": "file", "mode": "out", "description": "The plan, day by day." }
  },
  "args": {
    "type": "object",
    "properties": {
      "cities": { "type": "array", "items": { "type": "string" }, "description": "Where to go, in order." },
      "dates": {
        "type": "object",
        "properties": { "start": { "type": "string" }, "end": { "type": "string" } },
        "required": ["start", "end"],
        "description": "When the trip starts and ends."
      },
      "travelers": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "home": { "type": "string" },
            "nationality": { "type": "string" },
            "notes": { "type": "string" }
          },
          "required": ["name", "home", "nationality"]
        },
        "description": "Who goes, and where each sets out from."
      }
    },
    "required": ["cities", "dates", "travelers"]
  },
  "exposes": ["trip-search", "@api/tau"],
  "init": "node ${self}/init.mts"
}
```

`PROMPT.md`:

```
Plan a trip through ${cities}, from ${dates.start} to ${dates.end}, for ${travelers}, each setting
out from their home, and check the visas each needs. Keep to ${wishes}. Book it with trip-search,
saving each booking in ${trip}, and write the plan, day by day, to ${itinerary}. Then have the tau
at ${self}/taus/city-guide write a guide to each city, with the same wishes, into ${trip}.
```

`init.mts`:

```ts
import { writeFileSync } from "node:fs";
import { TAU_RUN, files } from "@api/tau";
import { planDays, readBookings } from "trip-search";

const { trip, itinerary } = files();
const bookings = readBookings(trip);
if (bookings.length === 0) process.exit(TAU_RUN); // nothing booked yet: the agent plans the trip
writeFileSync(itinerary, planDays(bookings));
// Ending normally exits 0, TAU_SKIP: the agent does not run, and this is the run's final text.
console.log(`The trip was booked already; wrote its itinerary, from ${bookings.length} bookings.`);
```

A **call** gives each file a path, and the args, as JSON:

```json
{
  "files": { "wishes": "wishes.md", "trip": "portugal", "itinerary": "itinerary.md" },
  "args": {
    "cities": ["Lisbon", "Porto"],
    "dates": { "start": "2027-05-01", "end": "2027-05-08" },
    "travelers": [
      { "name": "Ana", "home": "Madrid", "nationality": "Spanish" },
      { "name": "Ben", "home": "Toronto", "nationality": "Canadian", "notes": "Booked his flight: ${trip}/ben.pdf" }
    ]
  }
}
```

- **Files** are the caller's files and directories the run takes, each by name, with its `mode`:
  `in`, the agent reads it; `out`, it leaves something there; `inout`, it changes it in place;
  and its `kind`, `file` or `dir`, or, without one, either. A call gives each file a path of the
  caller's, or, for an `in`, a list of paths, which the agent sees as one directory holding each
  under its base name. Files do not nest.
- **Args** are any JSON, nesting to any depth, that fits `args`, a JSON Schema (draft 2020-12) of
  an object.
- **Placeholders**: `${name}`, naming a file, becomes its **place**, where the agent sees it, and
  `${self}` the tau's own directory, which the agent reads but does not change, in the prompt, in
  every string of the args, at any depth, and in init. The prompt also names args, `${cities}` or
  `${dates.start}`: a string as it is, anything else as JSON, and nothing for what the args lack.
  In args, `$${trip}` is a literal `${trip}`, and anything else stays as written; in the prompt
  and init, `$${` is a literal `${`, and any other `${` is refused.
- An API is declared in `api/<name>/` as TypeScript, whose doc comments say what it does, and the
  runtime implements it, so the tau holds neither its code nor credentials. `node_modules/` holds
  packages built on the APIs. The agent runs its programs with `node`, Node.js 24 or later, as
  JavaScript or as TypeScript Node.js runs as is, and they import what `exposes` lists, by default
  every API, resolving from the tau's directory, as its own code does.
- The **tau API**, `@api/tau`, gives programs `files()`, the place of each file; `args()`, the
  args, their placeholders expanded; `run(tau, call)`, which runs another tau and resolves to how
  it ended; and `TAU_SKIP`, `TAU_RUN` and `TAU_FALLBACK`, init's exit codes.
- Each directory `skills/<name>/` with a `SKILL.md` is a skill the agent can use.
- `init`, optional in `tau.json`, here `node ${self}/init.mts`, is a command the runtime runs
  before the agent, in the agent's working directory, each placeholder one word for `sh`: exiting
  0, `TAU_SKIP`, it did the run, its stdout the final text, and the agent does not run; 100,
  `TAU_RUN`, the agent runs as it would without it; 101, `TAU_FALLBACK`, or any other ending, such
  as a throw, it failed, and the agent runs, told so, with what it wrote.

## Semantics

A **runtime** runs a tau for a **caller**: a person, a program, or another agent.

- **A call** gives every file a path, and args that fit the schema. A runtime refuses one it
  cannot carry out as declared: args or a path that do not fit, an API it has no implementation
  of.
- **The run succeeds** if the agent finishes on its own, neither stopped nor failing, or its init
  does the run in its place, and leaves a file or a directory, as declared, at each `out` and
  `inout` file's place. The caller's paths then hold what it left, a directory merging into one
  already there. Either way, the caller gets the outcome, why if it failed, and the agent's final
  text, or init's. Success says the agent finished, not that it did well: a tau that must say so
  does it in its `out`s or its text.
- **Its effects are its final text, its `out` and `inout` files, and its API calls**, which take
  effect when made, and stay if the run fails. What the agent writes anywhere else is scratch. It
  learns of the caller only what the call gives it.
- **Runs nest.** An agent that runs a tau is that run's caller, giving paths in its own view, such
  as the places of its own files, and it can make several runs at once.

A tau says what its agent needs, never how: where it runs, which model and tools drive it, how its
skills and APIs are shown to it and implemented, and what else it finds, such as commands or the
network, are the runtime's. So are the places, and whether a file is the caller's own or a copy, so
a tau relies on nothing that sets them apart: whether the caller's later changes reach the agent,
what an `out` holds at first, and what a failed run leaves at the caller's paths. An isolated
runtime keeps these promises whatever the agent does; an unisolated one, which runs the agent with
the caller's access, only as far as the agent keeps to its files.
