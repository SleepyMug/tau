/** `@sleepymug/tau/adaptors`: the wire adaptors built into tau. */
export { createDummyAdaptor, DUMMY_TRACE, type DummyAgent, type DummyOptions, type DummyRun, echoAgent } from "./dummy.js";
export {
	createSocketAdaptor,
	loopbackTransport,
	readRunRequest,
	type RequestHandler,
	type RunRequest,
	SOCKET_PROTOCOL,
	type SocketAnswer,
	type SocketOptions,
	type SocketRequest,
	type SocketTransport,
} from "./socket.js";
export { defaultSocket, listenSocket, serveConnection, SocketUnreachable, socketTransport } from "./socket-transport.js";
