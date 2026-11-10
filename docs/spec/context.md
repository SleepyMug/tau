# The run context

A runtime gives init and every process the agent starts the variable `TAU_CONTEXT`, the path of a
JSON file, the run's **context**, which does not change while the run goes on:

```json
{
  "self": "/tau/self",
  "files": { "notes": "/tau/in/notes.md", "site": "/tau/workspace/site", "report": "/tau/out/report.md" },
  "args": { "style": "terse, as in /tau/workspace/site/about.html" }
}
```

- `self` is where the agent sees the tau's own directory, as `${self}` names it (see
  [Placeholders](placeholders.md));
- `files` is the place of each file, by its name, extra files included (see [Calls](calls.md));
- `args` is the args, their placeholders expanded, as the agent sees them.

So init, which names no arg, reads the args there, and a program of the tau's finds a file the
prompt does not name, such as an extra file an arg names, by its name:

```ts
import { readFileSync } from "node:fs";
const { files, args } = JSON.parse(readFileSync(process.env.TAU_CONTEXT as string, "utf8"));
```
