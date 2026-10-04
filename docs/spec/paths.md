# Paths

A runtime checks each handle's path (see [Values](values.md)) against the file system:
- **When the run starts**, the path of each `$in` and `$inout` handle is a file or a directory, as
  its type declares, if it declares one, and the path of each `$out` handle lies in a directory
  that exists, and is not something of the other type. A runtime refuses to start a run whose
  handles do not fit.
- **When the run ends**, if the agent returned normally (see [Results](results.md)), what it left
  at the place of each `$out` and `$inout` handle is a file or a directory, as its type declares,
  if it declares one, or the run fails.

Neither the path of an `$in` or `$inout` handle when the run starts, nor what the agent left at
the place of an `$out` or `$inout` handle when it ends, is a symlink itself, and each symlink in a
directory there is relative, and leads, through any further symlinks, all relative, to something
that exists in that directory: a handle holds all it leads to, wherever a runtime places it, and a
copy keeps modes and such symlinks as they are. Where an `$out` handle's path goes, symlinks are
followed, as in any path the caller names.

The caller's paths may overlap: one may be another, or lie inside it. Whether the agent sees
through one what it does through another is not specified. A runtime that puts copies at the
paths puts them once every `$in` was read, the inner one last where the paths lie in one another;
what two put at the same path is not specified.
