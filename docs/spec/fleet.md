# The fleet adaptor

The **fleet** adaptor carries a run to the **fleet service**, the backend of deepseek-fleet, which
runs each in a dsh session and a container of its own. It is built in: the `tau` command has it as
`fleet`, and `createFleetAdaptor`, of `@sleepymug/tau/adaptors`, makes it for a client, over a
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
| `{op: "contract", name, range?}` | none | `{name, version, description}` | the contract, as a tar archive (see [Serialization](serialization.md#contracts)) |

- **Submit** starts a run of the call, and gives its id, its dsh session's. `title` is what names
  the run, the name of its tau's directory; `project`, absolute, is the folder whose dsh workspace
  its session is in, by default the caller's working directory, or the service's to choose without
  it. The service may refuse the call, as the backend may (see [Protocol](protocol.md#a-runs-life)).
- **Status** gives where the run is, at once.
- **Result** sends the run's latest result, at once, each time it is asked, and refuses a run that
  has none yet.
- **Trace** gives what the run's agent did so far, its format the service's: for fleet, the events
  of the run's dsh session, as dsh logs them.
- **Release** drops the run, stopping it if it has not ended.
- **Contract** gives the contract `name` at the newest version the service implements, within
  `range`, a range as [APIs](apis.md) has it, when one is given, as the adaptor's `contract` asks
  (see [Protocol](protocol.md#contracts)); the service packs it with `packContract`, and the
  adaptor unpacks it with `unpackContract`.

The adaptor checks a status, a result's number and a trace as forms, and a result as
[Protocol](protocol.md#trust) asks of every adaptor, with `unpackResult`, before it puts anything
at the caller's paths: what does not fit is a run that failed. A failed request is an error, its message the service's. The service may serve requests of
its own, with other ops, such as listing its runs; `readFleetRunRequest` tells a run's from those,
and `readFleetContractRequest` a contract's, checking each as from a client the service does not
trust.

## Transports

```ts
interface FleetTransport {
  exchange(request: FleetRequest, body?: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<{ value: unknown; body?: AsyncIterable<Uint8Array> }>;
}
```

A transport sends one request, with the bytes after it, and gives its answer, with the bytes after
that, or throws the service's error; aborting `signal` gives up the request, and the reading of
what follows its answer. Who the caller is, the service learns from the transport, not from the
request: it is no field of the wire.

- `fleetSocket(path)`: the service's socket (see below), as the `tau` command uses it.
- `fleetLoopback(handle)`: a handler in the same process, as the service itself is to a caller
  beside it, the request and its answer passed as they are.
- Anything else with `exchange`, such as a relay from a container to the service, which says who is
  calling as it passes each request on.

## The socket

The service listens on a Unix socket, which only its owner can open, its authentication:
`$TAU_FLEET_SOCKET`, or, for the `tau` command, the one its config file names (see
[The config file](client.md#the-config-file)), or `fleet/tau.sock` in the dsh home, `$DSH_HOME` or
`~/.dsh` (`defaultFleetSocket`, which has all but the config file's). Each connection carries one
request:

- The client sends the request as one line of JSON, with `protocol`, the wire's version, `1`, and,
  when bytes follow it, `body: true`; then the bytes, up to the end of what it sends.
- The service answers with one line of JSON, `{ok: true, value}`, with `body: true` when bytes
  follow it, up to the end of the connection, or `{ok: false, error}`, and refuses a request of
  another version, one that is not a JSON object, and one without an op.
- A client that closes the connection before the answer, or ends what it sends after a request
  without a body, has gone away.

`listenFleet(path, handle)` serves a handler on the socket, as the service does, taking over a
socket that no service answers on.
