# Making a TAU

TAU.md says what a TAU takes, and what a run of one promises; this says what else its directory
holds:

```
plan-trip/
├── PROMPT.md                   the prompt, the only file required
├── tau.json                    its files and args, and its init
├── init.mts                    run first: writes the itinerary itself if the trip is booked
├── skills/visas/SKILL.md       a skill the agent can use
├── tests/                      its author's, which tau.json excludes
└── .tau/                       its author's tools', never carried
```

`tau.json` is TAU.md's, each file with a `description`, and two keys more:

```json
{
  "init": "node ${self}/init.mts",
  "exclude": ["tests"]
}
```

`PROMPT.md`:

```
Plan a trip through ${cities} for ${travelers}, keeping to ${wishes}, from the bookings in ${trip},
and write the plan, day by day, to ${itinerary}.
```

`init.mts`:

```ts
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const { files } = JSON.parse(readFileSync(process.env.TAU_CONTEXT as string, "utf8"));
const bookings = readdirSync(files.trip).filter((name) => name.endsWith(".pdf")).sort();
if (bookings.length === 0) process.exit(100); // TAU_RUN: nothing booked yet, so the agent plans the trip
writeFileSync(files.itinerary, bookings.map((booking, day) => `Day ${day + 1}: ${booking}\n`).join(""));
// Ending normally exits 0, TAU_SKIP: the agent does not run, and this is the run's final text.
console.log(`The trip was booked already; wrote its itinerary, from ${bookings.length} bookings.`);
```

- **The prompt** names the files and the args by placeholders, as the args do (TAU.md), and
  `${self}` names the TAU's own directory, which the agent reads but does not change. It names no
  extra file, which the TAU cannot know of.
- **Programs**, init's and the agent's, run with `node`, Node.js 24 or later: JavaScript, or
  TypeScript that Node.js runs as is, its types stripped.
- **The run context**: init and the agent's programs read `TAU_CONTEXT`, a JSON file, `{ self,
  files, args }`: the TAU's directory, the place of each file, extra files included, by its name,
  and the args, their placeholders expanded.
- **What else it needs** is its runtime's: a command, a service, the network. The TAU says so in
  its prompt, and runs only where it is there.
- **exclude**, optional, lists what of the directory does not go with a call: paths relative to it,
  or globs of them, such as `tests` or `**/*.draft.md`, but none of what a runtime reads. `.tau/`
  never goes.
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
