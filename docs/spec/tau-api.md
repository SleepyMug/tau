# The tau API

The **tau API** lets the agent's programs read the run's files and args, and run other taus, and
names the exit codes of the tau's init (see [Init](init.md)). It is the contract
`@sleepymug/tau-api` (see [Contracts](contracts.md)), whose declarations, in this repository's
`contracts/tau-api/`, say what each of these does. A tau that uses it holds a copy of it, by
convention at `api/tau/` (see [APIs](apis.md)), and a runtime that implements it gives its
implementation (see [Implementations](implementations.md)):
- `files()`, where this agent sees each of the run's files, by name, extra files included;
- `args()`, the run's args, their placeholders expanded (see [Placeholders](placeholders.md));
- `run(agent, call, signal)`, which runs the tau at `agent`, a directory, with `call`, as
  [Calls](calls.md) has it, and resolves to how the run ended, as [Results](results.md) has it;
- `TAU_SKIP`, `TAU_RUN` and `TAU_FALLBACK`, init's exit codes.

The agent that calls `run` is the new run's caller: the paths it gives are in its view, such as
the places `files()` gives, and the run may change only those it gives for `out` and `inout`
files. Runs share nothing but the caller's files and the APIs, so an agent can make several at
once.
