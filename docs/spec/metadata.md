# Metadata

`tau.json` declares what a tau takes from its caller, its files and its args, the APIs its code
calls, what its programs import, and its init. Without it, a tau takes no files and no args, and
calls no API.

```json
{
  "description": "Replace text in every file of a directory, and report what changed.",
  "files": {
    "site": { "kind": "dir", "mode": "inout", "description": "The files to edit." },
    "rules": { "kind": "file", "mode": "in", "description": "How to edit." },
    "report": { "kind": "file", "mode": "out", "description": "What changed." }
  },
  "args": {
    "type": "object",
    "properties": {
      "edits": {
        "type": "array",
        "description": "The replacements, made in order.",
        "items": {
          "type": "object",
          "properties": {
            "old": { "type": "string", "description": "The text to replace." },
            "new": { "type": "string", "description": "What replaces it." }
          },
          "required": ["old", "new"]
        }
      }
    },
    "required": ["edits"]
  },
  "apis": { "@acme/file-edits": "^1.0.0" },
  "exposes": ["@acme/file-edits"]
}
```

Each key is optional, and any other is refused:
- **`description`** says what the tau does, for whoever runs it. A runtime can show it as usage,
  or offer the tau to another agent as a tool.
- **`files`** declares the files the tau needs, which its prompt and init name, from each one's
  name to what it is (see [Files](#files)). A call gives a path for every one, and may give
  others, with their modes (see [Calls](calls.md)).
- **`args`** is the **schema** of the args (see [Args](#args)).
- **`apis`** names the APIs the tau's code calls, each a contract, from its name to the range of
  its versions the tau works with (see [APIs](apis.md)).
- **`exposes`** names what the agent's programs import, each once, by the name they import it as:
  an API, one `apis` names, or a package of the tau's own (see [Packages](packages.md)). Without
  it, they import every API.
- **`init`** is a command, a string that is not blank, that a runtime runs before the agent, and
  which may do the run without it (see [Init](init.md)).

Files and the args the schema declares are named as a run's scope has it (see
[Placeholders](placeholders.md)): a placeholder names each, and one name names one thing.

## Files

A file is an object with these keys, and no other:
- `mode`: what the agent does with it, `in`, `out` or `inout` (see [Calls](calls.md)).
- `kind`: optional, `file` or `dir`, what it is; without it, it may be either.
- `description`: what it is, a string that is not blank.

## Args

`args` is a JSON Schema, draft 2020-12, of an object: its `type` is `"object"`, and a call's args
fit it (see [Calls](calls.md)). It is the tau's whole schema: whatever `$ref` resolves, it finds in
`args` itself, such as in its `$defs`, never by fetching. A schema that JSON Schema's meta-schema
refuses, or that holds a keyword the draft does not define, is refused with the tau. A `format`
says what a string is, and is not checked. The top-level `properties` declare the args the prompt
may name (see [Placeholders](placeholders.md)), and their `description`s say what each is.

Without `args`, a tau takes no args: a call's args are empty.
