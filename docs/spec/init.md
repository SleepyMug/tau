# Init

A tau may have an **init**: a command, which `tau.json` gives as `init` (see
[Metadata](metadata.md)), that a runtime runs before the agent, and which may do the run without
it, such as when a program can do the task alone, for some values.

```json
{ "init": "node init.ts" }
```

A runtime runs it once for each run, with `sh -c`, in the tau's own directory, as `${self}` names
it, with the handles in place, and the APIs linked: its imports resolve as the agent's programs'
do (see [Runtimes](runtimes.md)), and it reads the run's values through the tau API (see
[The tau API](tau-api.md)), each handle's path where the agent sees it. Like the agent, it reads
the tau's directory, but does not change it. What it does is the run's, as what the agent does is:
what it leaves at the handles' places, which the agent finds there, and its API calls, which stay
done, the runs of other taus included.

How it exits says what comes next:
- **0, skip**: the agent does not run. The run succeeds as if the agent returned normally, with
  init's stdout as its final text (see [Results](results.md)): init leaves what each `$out` and
  `$inout` handle needs.
- **100, run**: the agent runs on the prompt, as it would without init.
- **101, fall back**, or any other ending, such as another code or a signal: init failed, and the
  agent runs on the prompt, which the runtime tells that init failed, with what init wrote to
  stdout and stderr.

A run cancelled while init runs fails, as one cancelled while the agent works does.
