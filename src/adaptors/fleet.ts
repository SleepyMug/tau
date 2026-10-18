import { rm } from "node:fs/promises";
import path from "node:path";
import type { WireAdaptor } from "../client/adaptor.js";
import { isObject } from "../core/util.js";
import { PACKAGE_NAME, rangeVersion } from "../core/apis.js";
import { packCall, unpackResult } from "../wire-tar/archive.js";
import { unpackContract } from "../wire-tar/contract.js";

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
 * ({@link FleetRunRequest}), and so is `contract` ({@link FleetContractRequest}); the service may
 * serve others of its own, which a transport carries just the same.
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

/**
 * Give the contract `name`, at the newest version the service implements within `range`, or of all
 * without one: answers `{ name, version, description }`, and sends the contract after it, as a tar
 * archive (docs/spec/serialization.md#contracts).
 */
export type FleetContractRequest = { readonly op: "contract"; readonly name: string; readonly range?: string };

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
		async contract(name, range, dir, signal) {
			const request: FleetContractRequest = { op: "contract", name, ...(range === undefined ? {} : { range }) };
			const { value, body } = await transport.exchange(request, undefined, signal);
			const broke = (problem: string): Error => new Error(`the fleet service broke the protocol: ${problem}`);
			const said = isObject(value) ? value : {};
			if (typeof said.name !== "string" || typeof said.version !== "string" || typeof said.description !== "string")
				throw broke(`contract answered ${JSON.stringify(value)}, not { name, version, description }`);
			if (body === undefined) throw broke("contract sent no contract");
			const contract = await unpackContract(body, dir, range === undefined ? { name } : { name, range });
			if (contract.version !== said.version || contract.description !== said.description) {
				await rm(dir, { recursive: true, force: true });
				throw broke(`contract said ${said.name}@${said.version}, but sent ${contract.name}@${contract.version}`);
			}
			return contract;
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

/**
 * `request` as a request for a contract, its fields checked, as from a client the service does not
 * trust; or undefined, when its op is not `contract`.
 * @throws for one that lacks what it takes, or takes what it does not.
 */
export function readFleetContractRequest(request: FleetRequest): FleetContractRequest | undefined {
	const { op, ...fields } = request;
	if (op !== "contract") return undefined;
	const extra = Object.keys(fields).find((key) => key !== "name" && key !== "range");
	if (extra !== undefined) throw new TypeError(`contract takes no ${extra}`);
	const { name, range } = fields;
	if (typeof name !== "string" || !PACKAGE_NAME.test(name)) throw new TypeError("contract takes name, a contract's, an npm package's");
	if (range === undefined) return { op, name };
	if (typeof range !== "string" || rangeVersion(range) === undefined) throw new TypeError("contract takes range, ^ and a version, if anything");
	return { op, name, range };
}

async function* empty(): AsyncGenerator<Uint8Array> {}
