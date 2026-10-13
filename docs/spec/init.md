# Init

A tau may have an **init**: a command, which `tau.json` gives as `init` (see
[Metadata](metadata.md)), that a runtime runs before the agent, and which may do the run without
it, such as when a program can do the task alone, for some args.

```json
{ "init": "node ${self}/init.mts" }
```

A runtime runs it once for each run, with `sh -c`, in the agent's working directory, with the
files in place, and the APIs linked. Its placeholders, `${self}`, the tau's own directory, and a
file's name, its place, each become one word for `sh` (see [Placeholders](placeholders.md)). It
names no arg: it reads the args through the tau API, as it can the places of the files (see
[The tau API](tau-api.md)). A program of the tau's, such as `${self}/init.mts`, imports what the
agent's programs do, resolving as the tau's own code does (see [Runtimes](runtimes.md)). Like the
agent, init reads the tau's directory but does not change it, and what it writes but at the files'
places is scratch (see [Results](results.md)). What it does is the run's, as what the agent does
is: what it leaves at the files' places, which the agent finds there, and its API calls, which
stay done, the runs of other taus included.

How it exits says what comes next, each code named in the tau API:
- **0, `TAU_SKIP`**: the agent does not run. The run succeeds as if the agent returned normally,
  with init's stdout as its final text (see [Results](results.md)): init leaves what each `out`
  and `inout` file needs.
- **100, `TAU_RUN`**: the agent runs on the prompt, as it would without init.
- **101, `TAU_FALLBACK`**, or any other ending, such as another code or a signal: init failed, and
  the agent runs on the prompt, which the runtime tells that init failed, with what init wrote to
  stdout and stderr.

A run released while init runs is stopped, as one released while the agent works is.
