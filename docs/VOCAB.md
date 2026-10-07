# Vocabulary

The names tau gives things, what each means, and the names it no longer uses. [TAU.md](../TAU.md),
the [spec](spec/index.md) and the library use these, and no others.

## A tau

| Name | What it is |
|---|---|
| **tau** | An agent packaged as a directory: Transportable Agent Unit. Written TAU where a model reads it, as in TAU.md. |
| **prompt** | `PROMPT.md`, what the agent is asked, with its placeholders. |
| **metadata** | `tau.json`: the tau's description, files, args, what it exposes, and its init. |
| **file** | A file or a directory of the caller's that the tau takes, by its **name**, which `files` in `tau.json` declares, with its mode, its kind and a description, as what the prompt and init need. A file of kind `dir` is a directory: file as Unix means it. Files do not nest. |
| **mode** | What the agent does with a file: `in`, reads it; `out`, leaves something there; `inout`, changes it in place. |
| **kind** | What a file is: `file` or `dir`; a file declared without one may be either. |
| **args** | The JSON a run takes beside its files: an object, nesting to any depth. **An arg** is one of its properties. |
| **schema** | `args` in `tau.json`: a JSON Schema (draft 2020-12) that a call's args fit. |
| **placeholder** | `${name}`, `${a.b}` or `${self}`, in the prompt, in a string of the args, or in init, which **expanding** replaces: a file by its place, `self` by the tau's directory, and, in the prompt, an arg by its value. |
| **escaped** | A placeholder preceded by `$`: in the args, expanding drops one `$`, so `$${name}` reaches the agent as `${name}`, for a run it makes; in the prompt and init, `$${` is a literal `${`. |
| **self** | The tau's own directory, as `${self}` names it. |
| **API** | `api/<name>/`: TypeScript declarations of what the tau's code calls, imported as `@api/<name>`. |
| **implementation** | The module a runtime gives for an API. |
| **package** | Code of the tau's own, in its `node_modules/`, built on its APIs. |
| **exposes** | What the agent's programs import: APIs, and packages of the tau's own. |
| **skill** | `skills/<name>/`, with a `SKILL.md`, which the agent can use. |
| **init** | A command a runtime runs before the agent, which may **skip** it, doing the run itself, **run** it, or **fall back** to it, having failed. |
| **tau API** | `@api/tau`: a run's files and args, runs of other taus, and init's exit codes. |

## A run

| Name | What it is |
|---|---|
| **runtime** | What runs a tau, such as pi-run or fleet. |
| **caller** | Who runs a tau: a person, a program, or another agent. |
| **agent** | The model the runtime runs on the tau's prompt. |
| **program** | Code the agent runs with `node`, importing what the tau exposes. |
| **run** | One run of a tau, for one call. |
| **call** | What a caller gives a run: a path for each file, extra files, and the args. |
| **extra file** | A file a call gives the agent that `tau.json` does not declare, with its mode, and its kind if any, which the args name, and the tau API gives. |
| **path** | Where the caller has a file, relative to its working directory or absolute. |
| **view** | The file system as the agent sees it. |
| **place** | Where the agent sees a file in its view, which the runtime chooses, keeping the base name of the file's path. |
| **working directory** | Where the agent's commands, and init, start. |
| **scratch** | What the agent writes anywhere but at its files' places: nothing after the run relies on it. |
| **isolated**, **unisolated** | A runtime that keeps the agent to its files and APIs, or one that runs it with the caller's access. |
| **result** | How a run ended: whether it succeeded, its final text, and why it failed, if it did. |
| **outputs** | What a run leaves at its `out` and `inout` files' places, which the caller's paths hold once it succeeds. |
| **targets** | The caller's paths of a run's `out` and `inout` files, by name, where its outputs go. |
| **archive** | A call or a result as a tar file, to send elsewhere: its JSON, then the tau, and each file's content under its name. |

## Names no longer used

| Name | What took its place |
|---|---|
| parameter, `params` | A file, or an arg. |
| value, values | A file's path, or the args. |
| handle, `{"$in": path}`, `{"$out": path}`, `{"$inout": path}` | A file: the call gives its path, and `tau.json` its mode. |
| type, `text`, `list`, `record`, `of`, `fields` | A file's kind and mode, or the schema: JSON Schema's `string`, `array` and `object`. |
| `path`, as a kind | A file declared without a kind. |
| JSON Pointer, blob id | A file's name, which keys outputs and names content in an archive. |
| `at`, `share`, `role`, `vars`, `paths`; `args` as a positional list | Earlier designs: places were declared, then are the runtime's; `share` and `role` became modes; texts and paths became files and args. |
