# Metadata

`tau.json` declares what a tau takes from its caller, what its programs import, and its init. Without it, a
tau takes no parameters, and its programs import every API.

```json
{
  "description": "Replace text in every file of a directory, and report what changed.",
  "params": {
    "site": { "type": "dir", "mode": "inout", "description": "The files to edit." },
    "edits": {
      "type": "list",
      "description": "The replacements, made in order.",
      "of": {
        "type": "record",
        "fields": {
          "old": { "type": "text", "description": "The text to replace." },
          "new": { "type": "text", "description": "What replaces it." }
        }
      }
    },
    "rules": { "type": "file", "mode": "in", "description": "How to edit." },
    "report": { "type": "file", "mode": "out", "description": "What changed." }
  },
  "exposes": ["@api/file-edits"]
}
```

Each key is optional, and any other is refused:
- **`description`** says what the tau does, for whoever runs it. A runtime can show it as usage,
  or offer the tau to another agent as a tool.
- **`params`** declares the parameters, from each one's name to its type, which has a
  `description` of what it is. The caller gives a value for every one (see [Values](values.md)).
  A name matches `^[A-Za-z_][A-Za-z0-9_]*$`, and is not `self`, which names the tau's own directory
  (see [Prompt](prompt.md)).
- **`exposes`** names what the agent's programs import, each once: an API, as `@api/<name>` (see
  [APIs](apis.md)), or a package of the tau's own, by its name (see [Packages](packages.md)).
  Without it, they import every API.
- **`init`** is a command, a string that is not blank, that a runtime runs before the agent, and
  which may do the run without it (see [Init](init.md)).

## Types

A type is an object with `type`, the keys that kind asks for, and `description`, optional but for
a parameter's, and no other key. A value fits it as follows:
- `{"type": "text"}`: a text.
- `{"type": "file" | "dir" | "path", "mode": "in" | "out" | "inout"}`: a handle of that mode, to a
  file, a directory, or either, as [Paths](paths.md) checks.
- `{"type": "list", "of": <type>}`: a list, each of whose values fits `of`.
- `{"type": "record", "fields": {<name>: <type>, …}}`: a closed record, with a value for each field,
  which fits its type, and no other.
- `{"type": "record"}`: an open record, with any names and any values.

A field's name matches the pattern a parameter's does.
