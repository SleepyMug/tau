# The rpc adaptor

The **rpc** adaptor carries a run to a backend that serves `tau.v1.Runs`, a Connect service, such
as dsh's, which runs each in a session and a container of its own, reached through fleet's
gateway. It is built in: the `tau` command has it as `rpc`, and `createRpcAdaptor`, of
`@sleepymug/tau/rpc`, makes it for a client, over a **transport** the caller gives.

## The service

`tau.v1.Runs` (`proto/tau/v1/runs.proto`) is a run's life, as [Protocol](protocol.md#a-runs-life)
has it:

| Method | Takes | Gives |
|---|---|---|
| `Submit` | first `{start: {title, project?}}`, then the call, as a tar archive (see [Serialization](serialization.md)), which carries the tau, in chunks | `{id}`, the run's |
| `Status` | `{id}` | `{running}`, or `{ended: {result, ok, failure?}}` |
| `Result` | `{id}` | first `{result}`, the latest result's number, then the result, as a tar archive, in chunks |
| `Trace` | `{id}` | `{format, events}`, the events as JSON values |
| `Release` | `{id}` | nothing |

- **Submit** starts a run of the call, and gives its id. `title` is what names the run, the name
  of its tau's directory; `project`, absolute, is the caller's folder, such as its working
  directory, which the backend may use, as for where it lists the run, or the backend's to choose
  without it. The backend may refuse the call, as `invalid_argument`.
- **Status** gives where the run is, at once.
- **Result** gives the run's latest result, at once, each time it is asked, and refuses a run that
  has none yet, as `failed_precondition`.
- **Trace** gives what the run's agent did so far, its format the backend's.
- **Release** drops the run, stopping it if it has not ended.

A run the backend does not know is `not_found`. The adaptor checks a status, a result's number and
a trace as forms, and a result as [Protocol](protocol.md#trust) asks of every adaptor, with
`unpackResult`, before it puts anything at the caller's paths: what does not fit is a run that
failed. A failed call is an error, its message the backend's.

Who the caller is, the backend learns from the transport, not from the request: it is no field of
the service. `runsRoutes(backendOf)` serves the service for a backend, `backendOf` giving the
backend that serves each call from the call's context, as from who the headers of a gateway that
carries the call say it is; each request is checked as from a client the backend does not trust,
before the backend, a `RunBackend`, gets it. `descriptors()` gives the schema with its comments,
for a backend that registers it where they are read, such as fleet's gateway, which makes a client
of it for each box.

## Transports

Any Connect transport carries the calls:

- `rpcTransport({ socket, path? })`: Connect's protocol, in protobuf's binary form, over HTTP/2 on
  a Unix socket, the calls below `path`, such as `/services/tau` on a gateway that carries them to
  the backend, as the `tau` command uses it;
- `createRouterTransport(runsRoutes(...))`, of `@connectrpc/connect`: a backend's routes in the
  caller's process, as the backend itself is to a caller beside it;
- any other, such as one over TCP, or one whose interceptors add headers.

For the `tau` command, the backend is at `$TAU_RPC_SOCKET`, its calls below `$TAU_RPC_PATH`
(`defaultRpcPlace`), or where its config file says (see [The config file](client.md#the-config-file)).
