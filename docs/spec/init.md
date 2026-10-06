# Init

A tau may have an **init**: a command, which `tau.json` gives as `init` (see
[Metadata](metadata.md)), that a runtime runs before the agent, and which may do the run without
it, such as when a program can do the task alone, for some values.

```json
{ "init": "node ${self}/init.mts" }
```

A runtime runs it once for each run, with `sh -c`, in the agent's working directory, with the
handles in place, and the APIs linked. In it, `${self}` becomes the tau's own directory, where
the agent sees it, as one word for `sh`, quoted if need be, and `$${` a literal `${`. It names
nothing else: it reads the run's values through the tau API (see [The tau API](tau-api.md)), each
handle's path where the agent sees it. A program of the tau's, such as `${self}/init.mts`,
imports what the agent's programs do, resolving as the tau's own code does (see
[Runtimes](runtimes.md)). Like the agent, init reads the tau's directory but does not change it,
and what it writes but at the handles' places is scratch (see [Results](results.md)). What it does
is the run's, as what the agent does is: what it leaves at the handles' places, which the agent
finds there, and its API calls, which stay done, the runs of other taus included.

How it exits says what comes next, each code named in the tau API:
- **0, `TAU_SKIP`**: the agent does not run. The run succeeds as if the agent returned normally,
  with init's stdout as its final text (see [Results](results.md)): init leaves what each `$out`
  and `$inout` handle needs.
- **100, `TAU_RUN`**: the agent runs on the prompt, as it would without init.
- **101, `TAU_FALLBACK`**, or any other ending, such as another code or a signal: init failed, and
  the agent runs on the prompt, which the runtime tells that init failed, with what init wrote to
  stdout and stderr.

A run cancelled while init runs fails, as one cancelled while the agent works does.
