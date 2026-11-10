# Making a TAU

TAU.md says what a TAU takes, and what a run of one promises; this says what else its directory
holds:

```
plan-trip/
├── PROMPT.md                   the prompt, the only file required
├── tau.json                    its files and args, what its programs import, and its init
├── init.mts                    run first: writes the itinerary itself if the trip is booked
├── skills/visas/SKILL.md       a skill the agent can use
├── node_modules/trip-days/     a package of its own, which its programs import
├── taus/city-guide/            the author's own: here, a TAU it runs
└── .tau/                       its author's tools', never carried
```

`tau.json` is TAU.md's, each file with a `description`, and two keys more:

```json
{
  "exposes": ["trip-days"],
  "init": "node ${self}/init.mts"
}
```

`PROMPT.md`:

```
Plan a trip through ${cities} for ${travelers}, keeping to ${wishes}, from the bookings in ${trip},
and write the plan, day by day, to ${itinerary}, with trip-days. Then have the TAU at
${self}/taus/city-guide write a guide to each city into ${trip}, with the tau command.
```

`init.mts`:

```ts
import { readFileSync, writeFileSync } from "node:fs";
import { planDays, readBookings } from "trip-days";

const { files } = JSON.parse(readFileSync(process.env.TAU_CONTEXT as string, "utf8"));
const bookings = readBookings(files.trip);
if (bookings.length === 0) process.exit(100); // TAU_RUN: nothing booked yet, so the agent plans the trip
writeFileSync(files.itinerary, planDays(bookings));
// Ending normally exits 0, TAU_SKIP: the agent does not run, and this is the run's final text.
console.log(`The trip was booked already; wrote its itinerary, from ${bookings.length} bookings.`);
```

- **The prompt** names the files and the args by placeholders, as the args do (TAU.md), and
  `${self}` names the TAU's own directory, which the agent reads but does not change. It names no
  extra file, which the TAU cannot know of.
- **Programs**: the agent runs programs with `node`, Node.js 24 or later, as JavaScript, or as
  TypeScript Node.js runs as is, its types stripped, from a program directory its runtime gives
  it, where they import the TAU's packages by name, as its own code does. `node_modules/` holds
  them, as installed, each self-contained, with declarations of what programs import; `exposes`
  names those the runtime presents to the model, and the commands a package declares are on the
  agent's PATH.
- **The run context**: init and the agent's programs read `TAU_CONTEXT`, a JSON file, `{ self,
  files, args }`: the TAU's directory, the place of each file, extra files included, by its name,
  and the args, their placeholders expanded.
- **What else it needs** is its runtime's: a command, a service, the network. The TAU says so in
  its prompt, and runs only where it is there. So it runs another TAU with the `tau` command, where
  its runtime gives it, as `tau run ${self}/taus/city-guide --call-json '…' --json` (TAU.md).
- **A skill** is `skills/<name>/SKILL.md`, which starts with YAML frontmatter giving its `name`, its
  directory's, and its `description`, by which the agent tells when to use it.
- **init**, optional, is a command the runtime runs before the agent, in the agent's working
  directory. Its placeholders name `self` and the files, each one word for `sh`, and no arg: it
  reads the args from the run context. Exiting 0, `TAU_SKIP`, it did the run, its stdout the final
  text, and the agent does not run; 100, `TAU_RUN`, the agent runs as it would without it; 101,
  `TAU_FALLBACK`, or any other ending, such as a throw, it failed, and the agent runs, told so,
  with what it wrote.

Write for any runtime: name each file by its placeholder, never by where a runtime places it, and
rely on nothing TAU.md leaves to the runtime but what the prompt says the TAU needs.
