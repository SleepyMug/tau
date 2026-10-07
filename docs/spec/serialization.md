# Serialization

A run can travel as bytes, to a runtime on another machine and back, in two formats: a **call**,
the call's args and the content of the files the agent reads, and a **result**, how the run ended
and the content the agent left at its `out` and `inout` files. Each stands alone: a result is read
without its call. A call may carry the tau it runs, for a runtime that does not have it otherwise;
a result never does.

Each is an **archive**, written and read in one pass, so a large file never has to be held whole.

## Archives

A call or a result is a tar archive in the POSIX.1-2001 pax format, restricted as follows:
- Its first entry is a regular file holding JSON: `call.json` in a call, `result.json` in a
  result.
- Every other entry belongs to a **content**: a file's, at `files/<name>`, under the file's name,
  a regular file, or a directory followed by what it holds, under it; or, in a call, the tau's, a
  directory at `tau/`, followed by what it holds. Directories, regular files and symlinks are the
  only entries in a directory, each directory before its contents. A content's entries are
  contiguous, and each content appears once.
- An entry's name is UTF-8, relative, with no empty, `.` or `..` component. A name or a size that
  does not fit the ustar header goes in a pax extended header (`x`) before the entry.
- A symlink is relative, and leads, through any further symlinks, all relative, to something that
  exists in its content, as [Paths](paths.md) asks of a file. A content is never a symlink itself.
- Of each entry's header, a reader keeps the name, the type, the size, the permission bits
  (`mode & 0o777`) and a symlink's target, and ignores the rest: owners, times, and any other mode
  bits.
- The archive ends with the two zero blocks tar ends with, and nothing but zero bytes follows
  them, as tar pads an archive to its record size.

A reader refuses an archive that breaks any of these, or whose JSON does not fit what follows.
Compressing the archive, as a whole, is up to whatever carries it.

## Calls

`call.json` holds the call's files, under `files`, its args, under `args`, and, under `tau`, `true`
when the call carries its tau, and no other key:

```json
{
  "files": {
    "notes":  { "mode": "in",    "kind": "file", "base": "notes.txt" },
    "site":   { "mode": "inout", "kind": "dir",  "base": "site" },
    "counts": { "mode": "out",                   "base": "counts.txt" }
  },
  "args": { "top": 10 },
  "tau": true
}
```

- `files` has each file of the call, by its name, in place of its path, the caller's paths staying
  the caller's: its `mode`, as the tau declares it, or the call gives it for an extra file; its
  `base`, the base name of its path, or, for an `in` file given a list of paths, its name, which
  its place keeps (see [Running](running.md)): not empty, not `.` or `..`, with no `/` and no NUL;
  and its `kind`, `file` or `dir`: for an `in` or an `inout`, what its content is, so that a call
  that does not fit the tau can be refused before its content is read; for an `out`, optional,
  what the agent leaves there, as the tau or the call says. An `in` file given a list of paths is
  a `dir`, holding what is at each path under its base name. Each `in` and `inout` file has its
  content in the archive, at `files/<name>`; an `out` has none, since what its place holds at
  first is not specified.
- `args` are the call's args, as the caller gave them, their placeholders not yet expanded.
- The tau, when the call carries it, is the directory at `tau/`, as [Directory](directory.md) has
  it, whose symlinks lead inside it. It may come first, so that a runtime can read the tau, and
  check the call against it, before it reads the files.

Every content in the archive is a file's that `files` names with content, or the tau's.

```
call.json
tau/
tau/PROMPT.md
tau/tau.json
files/notes
files/site/
files/site/index.html
files/site/assets/
files/site/assets/logo.png
files/site/logo.png -> assets/logo.png
```

## Results

`result.json` holds how the run ended, as [Results](results.md) defines it, and what it left at
each `out` and `inout` file, and no other key:

```json
{
  "ok": true,
  "text": "Replaced 12 words.",
  "outputs": {
    "site":   { "kind": "dir" },
    "counts": { "kind": "file" }
  }
}
```

- `ok` says whether the run succeeded; `text` is the agent's final text, empty when it gave none;
  `failure` says why the run failed, and is there only when it did.
- `outputs` has what the agent left at the place of each `out` and `inout` file, by the file's
  name: its `kind`, `file` or `dir`, and its content, at `files/<name>`.
- When the run succeeded, there is an output for every `out` and `inout` file of the call, of the
  kind [Paths](paths.md) asks. When it failed, there are outputs for any of them, or none, since
  what a failed run leaves is not specified.

Every content in the archive is an output's.

```
result.json
files/site/
files/site/index.html
files/site/assets/
files/site/assets/logo.png
files/site/logo.png -> assets/logo.png
files/counts
```

A result says what to put where by the files' names, never by the caller's paths, which no archive
holds. A caller that keeps the path of each of its `out` and `inout` files puts each output at its
file's path, as [Results](results.md) says: a directory merging into a directory already there,
anything else replacing what is there.

## Open

- Content from elsewhere: a file's entry in `call.json` naming its content by a digest, as in
  `{"digest": "sha256:…", "size": n}`, for content the reader already holds or can fetch, which
  asks for a canonical digest of a directory; or by a URL.
- Whether times are kept, for a tau whose programs rely on them.
- Whether a reader accepts GNU long-name entries, which GNU tar writes by default, as well as pax.
