import path from "node:path";
import type { WireAdaptor } from "../client/adaptor.js";
import { readStatus, readTrace } from "../core/forms.js";
import { isObject, messageOf } from "../core/util.js";
import { packCall, unpackResult } from "../wire-tar/archive.js";

/**
 * The socket wire adaptor (docs/spec/socket.md): a run on a backend served on a Unix socket, or
 * on whatever carries its requests in the socket's place. A request is JSON, with bytes after it
 * for a submit, its call as a tar archive (docs/spec/serialization.md), and an answer is JSON,
 * with bytes after it for a result, as a tar archive, which the adaptor checks and puts at the
 * caller's paths. A transport carries each request and its answer: the socket
 * (./socket-transport.ts), or whatever the caller has in its place, such as a relay from a
 * container, or the backend itself, in its own process.
 */

/** The version of the socket wire, which each request on the socket says, and the backend checks. */
export const SOCKET_PROTOCOL = 1;

/**
 * A request of the backend: its `op`, and what the op takes. A run's are tau's
 * ({@link RunRequest}); the backend may serve others of its own, which a transport carries just
 * the same.
 */
export interface SocketRequest {
	readonly op: string;
	readonly [field: string]: unknown;
}

/** What the backend is asked of a run: its life, as docs/spec/protocol.md has it. */
export type RunRequest =
	/** Start a run of the call that follows, which carries its tau. Answers `{ id }`. */
	| { readonly op: "submit"; readonly title: string; readonly project?: string }
	/** Where the run is, at once. Answers its status. */
	| { readonly op: "status"; readonly id: string }
	/** Send the run's latest result after the answer, `{ result }`, its number; refused while it has none. */
	| { readonly op: "result"; readonly id: string }
	/** What the run's agent did so far. Answers `{ format, events }`. */
	| { readonly op: "trace"; readonly id: string }
	/** Drop the run, stopping it if it has not ended. Answers `null`. */
	| { readonly op: "release"; readonly id: string };

/** What the backend answers a request with: JSON, and the bytes that follow it, for an op that sends them. */
export interface SocketAnswer {
	readonly value: unknown;
	readonly body?: AsyncIterable<Uint8Array>;
}

/** What carries a request to the backend, and its answer back. */
export interface SocketTransport {
	/**
	 * Send `request`, with `body` after it, if given, and read the answer.
	 * Aborting `signal` gives up the request, and the reading of what follows its answer.
	 * @throws the backend's error, or when it cannot be reached.
	 */
	exchange(request: SocketRequest, body?: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<SocketAnswer>;
}

/**
 * What serves a request, as the backend does: given what follows it, empty when nothing does,
 * and a signal that aborts once its client went away.
 * @throws the error to answer with.
 */
export type RequestHandler = (request: SocketRequest, body: AsyncIterable<Uint8Array>, signal: AbortSignal) => Promise<SocketAnswer>;

export interface SocketOptions {
	readonly transport: SocketTransport;
	/** The caller's folder, absolute, such as its working directory, which the backend may use, as for where it lists the run. */
	readonly project?: string;
}

/** The socket wire adaptor, over `transport`. A run's title is the name of its tau's directory. */
export function createSocketAdaptor({ transport, project }: SocketOptions): WireAdaptor {
	return {
		async submit(job, signal) {
			const request: RunRequest = { op: "submit", title: path.basename(job.tau), ...(project === undefined ? {} : { project }) };
			const { value } = await transport.exchange(request, packCall(job), signal);
			const id = isObject(value) ? value.id : undefined;
			if (typeof id !== "string" || id === "") throw broke(`submit answered ${JSON.stringify(value)}, not { id }`);
			return id;
		},
		async status(id, signal) {
			const request: RunRequest = { op: "status", id };
			const { value } = await transport.exchange(request, undefined, signal);
			try {
				return readStatus(value);
			} catch (error) {
				throw broke(`status answered ${JSON.stringify(value)}: ${messageOf(error)}`);
			}
		},
		async result(id, delivery, signal) {
			const request: RunRequest = { op: "result", id };
			const { value, body } = await transport.exchange(request, undefined, signal);
			const result = isObject(value) ? value.result : undefined;
			if (!Number.isSafeInteger(result) || (result as number) < 1 || Object.keys(value as object).length !== 1)
				throw broke(`result answered ${JSON.stringify(value)}, not { result }, its number`);
			if (body === undefined) return { result: result as number, report: { ok: false, text: "", failure: "the backend broke the protocol: result sent no result", outputs: {} } };
			return { result: result as number, report: await unpackResult(body, delivery) };
		},
		async trace(id, signal) {
			const request: RunRequest = { op: "trace", id };
			const { value } = await transport.exchange(request, undefined, signal);
			try {
				return readTrace(value);
			} catch (error) {
				throw broke(`trace answered what is no trace: ${messageOf(error)}`);
			}
		},
		async release(id) {
			const request: RunRequest = { op: "release", id };
			await transport.exchange(request);
		},
	};
}

function broke(problem: string): Error {
	return new Error(`the backend broke the protocol: ${problem}`);
}

/**
 * A transport to `handle`, in this process, such as a backend, for a caller beside it. The
 * request and its answer are passed as they are, not serialized.
 */
export function loopbackTransport(handle: RequestHandler): SocketTransport {
	return {
		async exchange(request, body, signal) {
			signal?.throwIfAborted();
			return handle(request, body ?? empty(), signal ?? new AbortController().signal);
		},
	};
}

/**
 * `request` as one of a run's ops, its fields checked, as from a client the backend does not
 * trust; or undefined, when its op is none of a run's.
 * @throws for a run's op that lacks what it takes, or takes what it does not.
 */
export function readRunRequest(request: SocketRequest): RunRequest | undefined {
	const { op, ...fields } = request;
	const refuse = (problem: string): never => {
		throw new TypeError(`${op} ${problem}`);
	};
	const only = (...keys: string[]): void => {
		const extra = Object.keys(fields).find((key) => !keys.includes(key));
		if (extra !== undefined) refuse(`takes no ${extra}`);
	};
	switch (op) {
		case "submit": {
			only("title", "project");
			const { title, project } = fields;
			if (typeof title !== "string" || title.trim() === "") return refuse("takes a title, a string");
			if (project !== undefined && (typeof project !== "string" || !path.isAbsolute(project))) return refuse("takes project, an absolute path, if anything");
			return project === undefined ? { op, title } : { op, title, project };
		}
		case "status":
		case "result":
		case "trace":
		case "release": {
			only("id");
			const { id } = fields;
			if (typeof id !== "string" || id === "") return refuse("takes the run's id, a string");
			return { op, id };
		}
		default:
			return undefined;
	}
}

async function* empty(): AsyncGenerator<Uint8Array> {}
