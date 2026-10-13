import path from "node:path";
import type { WireAdaptor } from "../client/adaptor.js";
import { isObject } from "../core/util.js";
import { packCall, unpackResult } from "../wire-tar/archive.js";

/**
 * The fleet wire adaptor (docs/spec/fleet.md): a run on the fleet service, the backend of
 * deepseek-fleet, which runs each in a dsh session and a container of its own. A request is JSON,
 * with bytes after it for a submit, its call as a tar archive (docs/spec/serialization.md), and an
 * answer is JSON, with bytes after it for a finish, its result as a tar archive, which the adaptor
 * checks and puts at the caller's paths. A transport carries each request and its answer: the
 * service's socket (./fleet-socket.ts), or whatever the caller has in its place, such as a relay
 * from a container, or the service itself, in its own process.
 */

/** The version of the fleet wire, which each request on the socket says, and the service checks. */
export const FLEET_PROTOCOL = 1;

/**
 * A request of the fleet service: its `op`, and what the op takes. A run's three are tau's
 * ({@link FleetRunRequest}); the service may serve others of its own, which a transport carries
 * just the same.
 */
export interface FleetRequest {
	readonly op: string;
	readonly [field: string]: unknown;
}

/** What the fleet service is asked of a run: its life, as docs/spec/protocol.md has it. */
export type FleetRunRequest =
	/** Start a run of the call that follows, which carries its tau. Answers `{ id }`. */
	| { readonly op: "submit"; readonly title: string; readonly project?: string }
	/** Wait for the run's latest result, and send it after the answer, `null`. */
	| { readonly op: "finish"; readonly id: string }
	/** Drop the run, stopping it if it has not ended. Answers `null`. */
	| { readonly op: "release"; readonly id: string };

/** What the fleet service answers a request with: JSON, and the bytes that follow it, for an op that sends them. */
export interface FleetAnswer {
	readonly value: unknown;
	readonly body?: AsyncIterable<Uint8Array>;
}

/** What carries a request to the fleet service, and its answer back. */
export interface FleetTransport {
	/**
	 * Send `request`, with `body` after it, if given, and read the answer.
	 * Aborting `signal` gives up the request, and the reading of what follows its answer.
	 * @throws the service's error, or when it cannot be reached.
	 */
	exchange(request: FleetRequest, body?: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<FleetAnswer>;
}

/**
 * What serves a request, as the fleet service does: given what follows it, empty when nothing
 * does, and a signal that aborts once its client went away.
 * @throws the error to answer with.
 */
export type FleetHandler = (request: FleetRequest, body: AsyncIterable<Uint8Array>, signal: AbortSignal) => Promise<FleetAnswer>;

export interface FleetOptions {
	readonly transport: FleetTransport;
	/**
	 * The folder whose dsh workspace each run's session is in, absolute, such as the caller's
	 * working directory; the service's to choose without one.
	 */
	readonly project?: string;
}

/**
 * The fleet wire adaptor, over `transport`. A run's title is the name of its tau's directory; its
 * id is its session's.
 */
export function createFleetAdaptor({ transport, project }: FleetOptions): WireAdaptor {
	return {
		async submit(job, signal) {
			const request: FleetRunRequest = { op: "submit", title: path.basename(job.tau), ...(project === undefined ? {} : { project }) };
			const { value } = await transport.exchange(request, packCall(job), signal);
			const id = isObject(value) ? value.id : undefined;
			if (typeof id !== "string" || id === "") throw new Error(`the fleet service broke the protocol: submit answered ${JSON.stringify(value)}, not { id }`);
			return id;
		},
		async finish(id, delivery, signal) {
			const request: FleetRunRequest = { op: "finish", id };
			const { body } = await transport.exchange(request, undefined, signal);
			if (body === undefined) return { ok: false, text: "", failure: "the fleet service broke the protocol: finish sent no result", outputs: {} };
			return unpackResult(body, delivery);
		},
		async release(id) {
			const request: FleetRunRequest = { op: "release", id };
			await transport.exchange(request);
		},
	};
}

/**
 * A transport to `handle`, in this process, such as the fleet service, for a caller beside it.
 * The request and its answer are passed as they are, not serialized.
 */
export function fleetLoopback(handle: FleetHandler): FleetTransport {
	return {
		async exchange(request, body, signal) {
			signal?.throwIfAborted();
			return handle(request, body ?? empty(), signal ?? new AbortController().signal);
		},
	};
}

/**
 * `request` as one of a run's ops, its fields checked, as from a client the service does not
 * trust; or undefined, when its op is none of a run's.
 * @throws for a run's op that lacks what it takes, or takes what it does not.
 */
export function readFleetRunRequest(request: FleetRequest): FleetRunRequest | undefined {
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
		case "finish":
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
