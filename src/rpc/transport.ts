import { connect } from "node:net";
import type { Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";

/**
 * Where a backend of the rpc adaptor serves `tau.v1.Runs` (docs/spec/rpc.md): a Unix socket, and
 * the path its calls go below, if any, as `/services/tau` on a gateway that carries them to it.
 */
export interface RpcPlace {
	/** The socket, absolute. */
	readonly socket: string;
	/** What the calls' paths start with; nothing by default. */
	readonly path?: string;
}

/**
 * Where the rpc adaptor's backend is, as `$TAU_RPC_SOCKET` and `$TAU_RPC_PATH` name it; undefined
 * when the socket is unset or blank.
 */
export function defaultRpcPlace(env: { readonly [name: string]: string | undefined } = process.env): RpcPlace | undefined {
	const socket = env.TAU_RPC_SOCKET ?? "";
	if (socket.trim() === "") return undefined;
	const path = env.TAU_RPC_PATH ?? "";
	return path.trim() === "" ? { socket } : { socket, path };
}

/**
 * Calls to a backend at `place`: Connect's protocol, in protobuf's binary form, over one HTTP/2
 * connection to the socket, made as a call needs it, which keeps no process alive once its calls
 * are done.
 */
export function rpcTransport(place: RpcPlace): Transport {
	return createConnectTransport({
		baseUrl: `http://tau${place.path ?? ""}`,
		httpVersion: "2",
		useBinaryFormat: true,
		nodeOptions: { createConnection: () => connect(place.socket) },
	});
}
