# Vocabulary

The names tau gives things, what each means, and the names it no longer uses. [TAU.md](../TAU.md),
[TAU_DEV.md](../TAU_DEV.md), the [spec](spec/index.md) and the code use these, and no others.

## A tau

| Name | What it is |
|---|---|
| **tau** | An agent packaged as a directory: Transportable Agent Unit. Written TAU where a model reads it, as in TAU.md and TAU_DEV.md. |
| **prompt** | `PROMPT.md`, what the agent is asked, with its placeholders. |
| **metadata** | `tau.json`: the tau's description, files, args, what it exposes, and its init. |
| **file** | A file or a directory of the caller's that the tau takes, by its **name**, which `files` in `tau.json` declares, with its mode, its kind and a description, as what the prompt and init need. A file of kind `dir` is a directory: file as Unix means it. Files do not nest. |
| **mode** | What the agent does with a file: `in`, reads it; `out`, leaves something there; `inout`, changes it in place. |
| **kind** | What a file is: `file` or `dir`; a file declared without one may be either. |
| **args** | The JSON a run takes beside its files: an object, nesting to any depth. **An arg** is one of its properties. |
| **schema** | `args` in `tau.json`: a JSON Schema (draft 2020-12) that a call's args fit. |
| **placeholder** | `${name}`, `${a.b}` or `${self}`, in the prompt, in a string of the args, or in init, which **expanding** replaces: a file by its place, `self` by the tau's directory, and, except in init, an arg by its value, expanded. |
| **scope** | What a run's placeholders name, each by its first name: `self`, its files and its args, one name naming one thing. |
| **escaped** | A placeholder preceded by `$`: expanding drops one `$` from each run of `$` before a `{`, so `$${name}` is a literal `${name}`, which an agent passes on to a run it makes. |
| **self** | The tau's own directory, as `${self}` names it. |
| **package** | Code of the tau's own, in its `node_modules/`, which init and the agent's programs import. |
| **exposes** | The packages of the tau's own a runtime presents to the model. |
| **skill** | `skills/<name>/`, with a `SKILL.md`, which the agent can use. |
| **init** | A command a runtime runs before the agent, which may **skip** it, doing the run itself, **run** it, or **fall back** to it, having failed; its exit codes, `TAU_SKIP`, 0, `TAU_RUN`, 100, and `TAU_FALLBACK`, 101. |
| **`.tau/`** | For the tools of a tau's author: no runtime reads it; no client carries it. |

## A run

| Name | What it is |
|---|---|
| **runtime** | What runs a tau: a client, with its wire adaptor, and a backend, together. |
| **caller** | Who runs a tau: a person, a program, or another agent. |
| **agent** | The model the runtime runs on the tau's prompt. |
| **program** | Code the agent runs with `node`, importing the tau's packages from its program directory. |
| **program directory** | A directory the runtime gives the agent, other than the tau's own, whose `node_modules/` holds the tau's packages, so that a program anywhere below it imports them. |
| **run context** | A JSON file `TAU_CONTEXT` names for init and the agent's processes: `self`, each file's place, and the args, expanded. |
| **run** | One run of a tau, for one call. |
| **call** | What a caller gives a run: a path for each file, extra files, and the args. |
| **extra file** | A file a call gives the agent that `tau.json` does not declare, with its mode, and its kind if any, which the args name, and the run context gives. |
| **path** | Where the caller has a file, relative to its working directory or absolute. |
| **view** | The file system as the agent sees it. |
| **place** | Where the agent sees a file in its view, which the runtime chooses, keeping the base name of the file's path. |
| **working directory** | Where the agent's commands, and init, start. |
| **scratch** | What the agent writes anywhere but at its files' places: nothing after the run relies on it. |
| **isolated**, **unisolated** | A runtime that keeps the agent to its files and what it gives it, or one that runs it with the caller's access. |
| **result** | How a run ended: whether it succeeded, its final text, and why it failed, if it did; numbered, from 1, a later one the next number. |
| **trace** | What a run's agent did, so far, in a format its backend names, for a person looking into the run: no result, and nothing relies on it. |
| **outputs** | What a run leaves at its `out` and `inout` files' places, which the caller's paths hold once it succeeds. |
| **targets** | The caller's paths of a run's `out` and `inout` files, by name, where its outputs go. |
| **archive** | A call or a result as a tar file, one way to carry it: its JSON, then the tau, and each file's content under its name. |

## The runtime

| Name | What it is |
|---|---|
| **client** | What runs a tau where the caller is, the `tau` command or the client SDK: it checks the tau, the call and the paths, and hands the run to a wire adaptor. |
| **wire adaptor** | The part of the client that talks to one backend, given to it by name: it packages a run, carries it, checks what comes back, and puts the outputs at the targets. |
| **dummy adaptor** | A wire adaptor built in: a loopback to a **dummy backend** of its own, in the client's process. |
| **socket adaptor** | A wire adaptor built in: runs on a backend that serves a Unix socket, such as dsh's, each in a session and a container of its own. |
| **transport** | What carries the socket adaptor's requests to the backend, and their answers back: its socket, a loopback in its process, or another, such as a relay. |
| **backend** | What runs the agent, wherever it is, with the backend SDK. |
| **backend SDK** | What every backend does alike: **admit** a call, check its files once **placed**, **render** what the agent is given, and **collect** the run's report. |
| **job** | A run as the client hands it to its adaptor: its envelope, the tau's directory, and the paths of its inputs. |
| **delivery** | Where the client asks its adaptor to put a run's outputs: the run's files, and their targets. |
| **envelope** | A call, checked, without the caller's paths: each file's mode, base name and kind, and the args. |
| **report** | How a run ended, and the kind of each output it gives back. |
| **status** | Where a run is: running, until it has a result; then ended, with its latest result's number and how it ended. |
| **submit**, **status**, **result**, **trace**, **release** | A run's life, the whole contract of a run, of a wire adaptor and its backend, none of which waits: hand it over; where it is; have its latest result put at the targets, as often as asked, refused till it has one; what its agent did so far; drop it, stopping it if it has not ended. |
| **finish** | The client's verb, in the SDK and the `tau` command: its status, asked again, a longer pause each time, until it has ended, then its result; no adaptor or backend sees it. |
| **wait** | The client's verb, in the SDK and the `tau` command: finish, then, if asked, the trace, then release; no adaptor or backend sees it. |
| **content** | A file or a directory as a stream of entries, which the transfer helpers read, check and make: the tau's, an input's, or an output's. |
| **run store** | Where the client keeps each run it started, by its id, until it is released: its adaptor, its files, and its targets. |

## Names no longer used

| Name | What took its place |
|---|---|
| parameter, `params` | A file, or an arg. |
| value, values | A file's path, or the args. |
| handle, `{"$in": path}`, `{"$out": path}`, `{"$inout": path}` | A file: the call gives its path, and `tau.json` its mode. |
| type, `text`, `list`, `record`, `of`, `fields` | A file's kind and mode, or the schema: JSON Schema's `string`, `array` and `object`. |
| `path`, as a kind | A file declared without a kind. |
| JSON Pointer, blob id | A file's name, which keys outputs and names content in an archive. |
| `bind`, `BoundFile`, `Placing`, a file's `host` and `view` | `resolve`, a call on the caller's side, with its paths; `check`, an envelope on the backend's; `expand`, with each file's place. |
| an API's name, an API declared for its tau; `api/<alias>/`, an alias, `@api/<alias>`; an implementation that fits an API, `checkImplementation`, `loadApis`, `loadExposed` | Contracts, then nothing in the format, as API, below. |
| the library, `Runtime`, `runTau`, `placeCall`, `applyResult`, `CheckedCall`, `call.json`'s `tau` | The client and its wire adaptors, `client.run`, the backend SDK's `admit` and `place`, an adaptor's `result`; an envelope, which always comes with its tau. |
| finish, as an adaptor's verb, which waited for a run's result | The client's finish: the adaptor's status, until the run ended, then its result. |
| history, fleet's `history` op and `fleet history` | A run's trace: `tau trace`, and the adaptor's `trace`. |
| backend, as the client's link; remote service; server SDK | A wire adaptor; a backend; the backend SDK. |
| API, `apis` in `tau.json`, a package's `tau.apis`; contract, declarations, version, range, implementation, implementation catalog; the tau API, `@sleepymug/tau-api`; `tau api add`, `remove` and `sync`, `.tau/`'s contracts and lock, a source, the provider; contract, as an adaptor's verb | Nothing in the format: what a tau's code needs beyond the tau is the runtime's, such as its commands; the run context, for a run's files and args; the `tau` command, for runs that nest; init's exit codes, as numbers. |
| fleet adaptor, the fleet service, `$TAU_FLEET_SOCKET` | The socket adaptor, a backend on a Unix socket, `$TAU_SOCKET`. |
| parcel, a call or a result as JSON with its contents | An envelope or a report, and the paths of a job or a delivery: contents are the adaptor's and the backend's, with the transfer helpers. |
| cancel | Release, which stops a run that has not ended. |
| `@sleepymug/tau-dev`: `tau check` type-checking a tau, `tau add`, `tau update`, `tau contract` | The `tau` command, which checks a tau without TypeScript. |
| `@packageDocumentation`, as what describes a package | Its `package.json`'s `description`. |
| `at`, `share`, `role`, `vars`, `paths`; `args` as a positional list | Earlier designs: places were declared, then are the runtime's; `share` and `role` became modes; texts and paths became files and args. |
