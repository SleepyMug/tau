# Running

The agent works in a **view**: the file system as it sees it, with a **working directory**, where
its commands start. Each file of the call (see [Calls](calls.md)) is in the view at a **place** of
its own, which keeps the base name of the caller's path, or, for an `in` file given a list of
paths, the file's name: the caller's own file or directory, at its path or wherever the runtime
gives it, or a copy. The tau's own directory is in the view too, whole, where `${self}` names it
(see [Placeholders](placeholders.md)), for the agent to read but not change. Where the working
directory, each place, and the tau's directory are, is up to the runtime.

What the agent writes anywhere but at its files' places is scratch (see [Results](results.md)).
A tau needs nothing of its caller's but its call, so a runtime can run it wherever it can give it
its files, inside another run included. What else the agent reaches is up to the runtime too:
- **Unisolated**, the agent runs as the caller does, with the caller's access. Nothing keeps it to
  its files, or to their modes, so the runtime keeps this spec's promises only as far as the agent
  keeps to them.
- **Isolated**, in a sandbox or a container, the agent reaches nothing of the caller's but its
  files and its APIs, and the runtime may hold it to each file's mode, giving an `in` read-only.
