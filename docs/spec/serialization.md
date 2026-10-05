# Serialization

A run can travel as bytes, to a runtime on another machine and back, in two formats: a **call**,
the values and the content of the handles the agent reads, and a **result**, how the run ended and
the content the agent left at its `$out` and `$inout` handles. Each stands alone, and holds its
content in its own blobs: a result is read without its call. A call may carry the tau it runs, for
a runtime that does not have it otherwise; a result never does.

Each is an archive, written and read in one pass, so a large file never has to be held whole.

## Archives

A call or a result is a tar archive in the POSIX.1-2001 pax format, restricted as follows:
- Its first entry is a regular file holding JSON: `call.json` in a call, `result.json` in a
  result.
- Every other entry belongs to a **blob**, named by an **id**, which matches
  `^[A-Za-z0-9_-]{1,64}$`. A file blob is a regular file at `blobs/<id>`. A directory blob is a
  directory at `blobs/<id>/`, then what it holds, under it: directories, regular files and
  symlinks, each directory before its contents. A blob's entries are contiguous, and each id
  appears once.
- An entry's name is UTF-8, relative, with no empty, `.` or `..` component. A name or a size that
  does not fit the ustar header goes in a pax extended header (`x`) before the entry.
- A symlink is relative, and leads, through any further symlinks, all relative, to something that
  exists in its blob, as [Paths](paths.md) asks of a handle. A file blob is never a symlink.
- Of each entry's header, a reader keeps the name, the type, the size, the permission bits
  (`mode & 0o777`) and a symlink's target, and ignores the rest: owners, times, and any other mode
  bits.
- The archive ends with the two zero blocks tar ends with, and nothing follows them.

A reader refuses an archive that breaks any of these, or whose JSON does not fit what follows.
Compressing the archive, as a whole, is up to whatever carries it.

## Calls

`call.json` holds a run's values, by parameter, under `values`, the tau it runs under `tau`, when
it carries it, and no other key:

```json
{
  "values": {
    "notes":  { "$in":    { "name": "notes.txt", "kind": "file", "blob": "b0" } },
    "top":    "10",
    "site":   { "$inout": { "name": "site",      "kind": "dir",  "blob": "b1" } },
    "counts": { "$out":   { "name": "counts.txt" } }
  },
  "tau": { "kind": "dir", "blob": "t" }
}
```

The values are as [Values](values.md) defines them, but for handles, which name content in place
of the caller's paths, the caller's paths staying the caller's:

```
handle  := {"$in": named} | {"$inout": named} | {"$out": {"name": name}}
named   := content, with "name": name
content := {"kind": "file" | "dir", "blob": id}
```

- `name` is the base name of the caller's path, which the handle's place keeps (see
  [Running](running.md)): not empty, not `.` or `..`, with no `/` and no NUL.
- `kind` says what the blob is, so that a call that does not fit the tau's types can be refused
  before its blobs are read. It agrees with the blob.
- `blob` is where the content is: the blob with that id, in the archive. It is the only **source**
  for now: a content holds exactly one, so that others can be added (see Open).

An `$out` handle carries no content, since what its place holds at first is not specified.
Several handles may name the same blob: each place is given the blob's content, as if from a copy
of its own.

`tau` is a `content` of kind `dir`: the tau's directory, as [Directory](directory.md) has it,
whose symlinks lead inside it. Its blob may come first, so that a runtime can read the tau, and
check the values against it, before it reads the handles' blobs.

Every blob in the archive is named by a handle, or by `tau`.

```
call.json
blobs/t/
blobs/t/PROMPT.md
blobs/t/tau.json
blobs/b0
blobs/b1/
blobs/b1/index.html
blobs/b1/assets/
blobs/b1/assets/logo.png
blobs/b1/logo.png -> assets/logo.png
```

## Results

`result.json` holds how the run ended, as [Results](results.md) defines it, and what it left at
each `$out` and `$inout` handle, and no other key:

```json
{
  "ok": true,
  "text": "Replaced 12 words.",
  "outputs": {
    "/site":   { "$inout": { "name": "site",       "kind": "dir",  "blob": "o0" } },
    "/counts": { "$out":   { "name": "counts.txt", "kind": "file", "blob": "o1" } }
  }
}
```

- `ok` says whether the run succeeded; `text` is the agent's final text, empty when it gave none;
  `failure` says why the run failed, and is there only when it did.
- `outputs` maps where each `$out` and `$inout` handle is in the run's values to what the agent
  left at its place: the handle, with its mode and name, and the content, as a `named` of a call
  is. Its keys are JSON Pointers (RFC 6901) into the values, such as `/site` or `/reports/2/out`.
  A name never holds `~` or `/`, so a pointer needs no escapes.
- When the run succeeded, there is an output for every `$out` and `$inout` handle of the run's
  values, of the kind [Paths](paths.md) asks. When it failed, there are outputs for any of them,
  or none, since what a failed run leaves is not specified.

Several outputs may name the same blob, and every blob in the archive is named by an output.

```
result.json
blobs/o0/
blobs/o0/index.html
blobs/o0/assets/
blobs/o0/assets/logo.png
blobs/o0/logo.png -> assets/logo.png
blobs/o1
```

A result says what to put where by the run's own values, never by the caller's paths, which no
archive holds. A caller that holds its values, with its paths, puts each output at the path of the
handle its key points to, as [Results](results.md) says: a directory merging into a directory
already there, anything else replacing what is there.

## Open

- Other sources: `{"digest": "sha256:…", "size": n}`, for content the reader already holds or
  can fetch, which asks for a canonical digest of a directory; `{"url": "…"}`.
- Whether times are kept, for a tau whose programs rely on them.
- Whether a reader accepts GNU long-name entries, which GNU tar writes by default, as well as pax.
- Whether zero blocks may follow the two that end the archive: tar pads an archive to its record
  size, 10 KiB by default, so an archive it writes is read only when written one block a record
  (`tar -b1`).
- The kind of an `$out` handle no type declares (see [Values](values.md)), which a call could
  carry, as `{"$out": {"name": "r.md", "kind": "file"}}`.
