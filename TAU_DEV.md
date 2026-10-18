# Making a TAU

TAU.md says what a TAU takes, and what a run of one promises; this says what else its directory
holds:

```
plan-trip/
├── PROMPT.md                   the prompt, the only file required
├── tau.json                    its files and args, its APIs, what its programs import, and its init
├── init.mts                    run first: writes the itinerary itself if the trip is booked
├── skills/visas/SKILL.md       a skill the agent can use
├── node_modules/trip-search/   a package of its own, built on @acme/travel
├── taus/city-guide/            the author's own: here, a TAU it runs
└── .tau/                       the tau command's: its APIs' contracts, for its author, never carried
```

`tau.json` is TAU.md's, each file with a `description`, and three keys more:

```json
{
  "apis": { "@acme/travel": "^1.2.0", "@sleepymug/tau-api": "^0.1.0" },
  "exposes": ["trip-search", "@sleepymug/tau-api"],
  "init": "node ${self}/init.mts"
}
```

`PROMPT.md`:

```
Plan a trip through ${cities} for ${travelers}, keeping to ${wishes}. Book it with trip-search,
saving each booking in ${trip}, and write the plan, day by day, to ${itinerary}. Then have the TAU
at ${self}/taus/city-guide write a guide to each city into ${trip}.
```

`init.mts`:

```ts
import { writeFileSync } from "node:fs";
import { TAU_RUN, files } from "@sleepymug/tau-api";
import { planDays, readBookings } from "trip-search";

const { trip, itinerary } = files();
const bookings = readBookings(trip);
if (bookings.length === 0) process.exit(TAU_RUN); // nothing booked yet: the agent plans the trip
writeFileSync(itinerary, planDays(bookings));
// Ending normally exits 0, TAU_SKIP: the agent does not run, and this is the run's final text.
console.log(`The trip was booked already; wrote its itinerary, from ${bookings.length} bookings.`);
```

- **The prompt** names the files and the args by placeholders, as the args do (TAU.md), and
  `${self}` names the TAU's own directory, which the agent reads but does not change. It names no
  extra file, which the TAU cannot know of.
- **An API** is a **contract**, an npm package of TypeScript declarations whose doc comments say
  what it does, named and versioned. A TAU names it in `apis`, by its name and a range, `^` and the
  version it is written against, and programs import it by its name; no `dependencies` of a
  `package.json` lists it. The runtime gives its code and its declarations, at a version that
  serves the range's, so the TAU holds neither, nor credentials. A runtime refuses a run whose APIs
  it does not implement so.
- **Programs**: the agent runs programs with `node`, Node.js 24 or later, as JavaScript, or as
  TypeScript Node.js runs as is, its types stripped. They import what `exposes` lists, by default
  every API, resolving from the TAU's directory, as its own code does. `node_modules/` holds
  packages of the TAU's own, built on its APIs.
- **The contracts, for its author**: `tau api add @acme/travel --from fleet` pulls one, from npm,
  the default, a wire adaptor's backend, or a path, into `.tau/`, and names it in `apis`;
  `tau api sync` pulls them again after a clone. A `tsconfig.json` with
  `"extends": "./.tau/tsconfig.json"` type-checks the TAU's code against them. A package of the
  TAU's own names the APIs it imports in its `package.json`'s `"tau": { "apis": { … } }`, and its
  build leaves their imports as they are.
- **The TAU API**, `@sleepymug/tau-api`, gives programs `files()`, the place of each file, extra
  files included; `args()`, the args, their placeholders expanded; `run(tau, call)`, which runs
  another TAU (TAU.md); and `TAU_SKIP`, `TAU_RUN` and `TAU_FALLBACK`, init's exit codes.
- **A skill** is `skills/<name>/SKILL.md`, which starts with YAML frontmatter giving its `name`, its
  directory's, and its `description`, by which the agent tells when to use it.
- **init**, optional, is a command the runtime runs before the agent, in the agent's working
  directory. Its placeholders name `self` and the files, each one word for `sh`, and no arg: it
  reads the args with `args()`. Exiting 0, `TAU_SKIP`, it did the run, its stdout the final text,
  and the agent does not run; 100, `TAU_RUN`, the agent runs as it would without it; 101,
  `TAU_FALLBACK`, or any other ending, such as a throw, it failed, and the agent runs, told so, with
  what it wrote.

Write for any runtime: name each file by its placeholder, never by where a runtime places it, and
rely on nothing TAU.md leaves to the runtime.
