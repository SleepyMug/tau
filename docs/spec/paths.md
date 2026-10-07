# Paths

A runtime checks each file's path (see [Calls](calls.md)) against the file system:
- **When the run starts**, the path of each `in` and `inout` file is a file or a directory, as its
  kind says, if it has one, and each path of an `in` file given a list is a file or a directory;
  the path of each `out` file lies in a directory that exists, and is not something of the other
  kind. A runtime refuses to start a run whose paths do not fit.
- **When the run ends**, if the agent returned normally (see [Results](results.md)), what it left
  at the place of each `out` and `inout` file is a file or a directory, as its kind says, if it
  has one, or the run fails.

Neither the path of an `in` or `inout` file when the run starts, each of a list's included, nor
what the agent left at the place of an `out` or `inout` file when it ends, is a symlink itself, and
each symlink in a directory there is relative, and leads, through any further symlinks, all
relative, to something that exists in that directory: what a path holds is all it leads to,
wherever a runtime places it, and a copy keeps modes and such symlinks as they are. Where an `out`
file's path goes, symlinks are followed, as in any path the caller names.

The caller's paths may overlap: one may be another, or lie inside it. Whether the agent sees
through one what it does through another is not specified. A runtime that puts copies at the
paths puts them once every `in` was read, the inner one last where the paths lie in one another;
what two put at the same path is not specified.
