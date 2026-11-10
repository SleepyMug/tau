# The socket adaptor

The **socket** adaptor carries a run to a backend that serves a Unix socket, such as dsh's, which
runs each in a session and a container of its own. It is built in: the `tau` command has it as
`socket`, and `createSocketAdaptor`, of `@sleepymug/tau/adaptors`, makes it for a client, over a
**transport** the caller gives.

## Requests

A request is a JSON object, its `op` and what the op takes, and its answer is JSON; a submit sends
bytes after its request, and a result's answer bytes after it:

| Request | Bytes after it | Answer | Bytes after it |
|---|---|---|---|
| `{op: "submit", title, project?}` | the call, as a tar archive (see [Serialization](serialization.md)), which carries the tau | `{id}`, the run's | none |
| `{op: "status", id}` | none | the run's status (see [Protocol](protocol.md#what-is-modelled)) | none |
| `{op: "result", id}` | none | `{result}`, the result's number | the run's latest result, as a tar archive |
| `{op: "trace", id}` | none | the run's trace, `{format, events}` | none |
| `{op: "release", id}` | none | `null` | none |

- **Submit** starts a run of the call, and gives its id. `title` is what names the run, the name
  of its tau's directory; `project`, absolute, is the caller's folder, such as its working
  directory, which the backend may use, as for where it lists the run, or the backend's to choose
  without it. The backend may refuse the call (see [Protocol](protocol.md#a-runs-life)).
- **Status** gives where the run is, at once.
- **Result** sends the run's latest result, at once, each time it is asked, and refuses a run that
  has none yet.
- **Trace** gives what the run's agent did so far, its format the backend's.
- **Release** drops the run, stopping it if it has not ended.

The adaptor checks a status, a result's number and a trace as forms, and a result as
[Protocol](protocol.md#trust) asks of every adaptor, with `unpackResult`, before it puts anything
at the caller's paths: what does not fit is a run that failed. A failed request is an error, its
message the backend's. The backend may serve requests of its own, with other ops, such as listing
its runs; `readRunRequest` tells a run's from those, checking each as from a client the backend
does not trust.

## Transports

```ts
interface SocketTransport {
  exchange(request: SocketRequest, body?: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<{ value: unknown; body?: AsyncIterable<Uint8Array> }>;
}
```

A transport sends one request, with the bytes after it, and gives its answer, with the bytes after
that, or throws the backend's error; aborting `signal` gives up the request, and the reading of
what follows its answer. Who the caller is, the backend learns from the transport, not from the
request: it is no field of the wire.

- `socketTransport(path)`: the backend's socket (see below), as the `tau` command uses it.
- `loopbackTransport(handle)`: a handler in the same process, as the backend itself is to a caller
  beside it, the request and its answer passed as they are.
- Anything else with `exchange`.

## The socket

The backend listens on a Unix socket, which only its owner can open, its authentication:
`$TAU_SOCKET` (`defaultSocket`), or, for the `tau` command, the one its config file names (see
[The config file](client.md#the-config-file)). Each connection carries one request:

- The client sends the request as one line of JSON, with `protocol`, the wire's version, `1`, and,
  when bytes follow it, `body: true`; then the bytes, up to the end of what it sends.
- The backend answers with one line of JSON, `{ok: true, value}`, with `body: true` when bytes
  follow it, up to the end of the connection, or `{ok: false, error}`, and refuses a request of
  another version, one that is not a JSON object, and one without an op.
- A client that closes the connection before the answer, or ends what it sends after a request
  without a body, has gone away.

`listenSocket(path, handle)` serves a handler on the socket, taking over a socket that no backend
answers on. `serveConnection(connection, handle)` serves one connection so, for one that reaches
the backend otherwise, such as through a relay from a container that tells the backend, before the
request, whose it is: so the caller is the relay's to say, and the request's form stays the same.
