import { once } from "node:events";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isObject, messageOf } from "../core/util.js";
import { FLEET_PROTOCOL, type FleetAnswer, type FleetHandler, type FleetRequest, type FleetTransport } from "./fleet.js";

/**
 * The fleet service's socket (docs/spec/fleet.md#the-socket): a Unix socket on which a client sends
 * one request, a line of JSON, with bytes after it when it says so, up to the end of what the
 * client sends, and the service answers with a line of JSON, with bytes after it when it says so,
 * up to the end of the connection. Only its owner can open it, which is its authentication.
 */

/** No fleet service listens on the socket. */
export class FleetUnreachable extends Error {}

/**
 * Where the fleet service listens: `$TAU_FLEET_SOCKET`, or `fleet/tau.sock` in the dsh home, as
 * dsh finds it: `$DSH_HOME`, a leading `~` the user's home, or else `~/.dsh`.
 */
export function defaultFleetSocket(env: { readonly [name: string]: string | undefined } = process.env): string {
	const given = env.TAU_FLEET_SOCKET ?? "";
	if (given.trim() !== "") return path.resolve(given);
	const home = env.DSH_HOME ?? "";
	if (home.trim() === "") return path.join(os.homedir(), ".dsh", "fleet", "tau.sock");
	const expanded = home === "~" || home.startsWith("~/") ? os.homedir() + home.slice(1) : home;
	return path.join(path.resolve(expanded), "fleet", "tau.sock");
}

/** A transport over the fleet service's socket at `socket`: a connection for each request. */
export function fleetSocket(socket: string): FleetTransport {
	return { exchange: (request, body, signal) => exchange(socket, request, body, signal) };
}

function exchange(socket: string, request: FleetRequest, body: AsyncIterable<Uint8Array> | undefined, signal: AbortSignal | undefined): Promise<FleetAnswer> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted === true) {
			reject(signal.reason);
			return;
		}
		const connection = createConnection(socket);
		let connected = false;
		let settled = false;
		let received = Buffer.alloc(0);
		const abort = (): void => {
			connection.destroy();
			fail(signal?.reason);
		};
		signal?.addEventListener("abort", abort, { once: true });
		const done = (): void => signal?.removeEventListener("abort", abort);
		const settle = (outcome: () => void): void => {
			if (settled) return;
			settled = true;
			// Paused before it loses its reader, so that nothing is dropped until a pipe reads it.
			connection.pause();
			connection.off("data", read);
			connection.off("end", lost);
			connection.off("close", lost);
			outcome();
		};
		const fail = (error: unknown): void =>
			settle(() => {
				done();
				connection.destroy();
				reject(error);
			});
		const lost = (): void => fail(new Error(`the fleet service at ${socket} went away before it answered`));
		const read = (chunk: Buffer): void => {
			received = Buffer.concat([received, chunk]);
			const end = received.indexOf(0x0a);
			if (end === -1) return;
			const line = received.subarray(0, end).toString("utf8");
			let answer: unknown;
			try {
				answer = JSON.parse(line);
			} catch {
				fail(new Error(`the fleet service broke the protocol: it answered ${JSON.stringify(line)}, not JSON`));
				return;
			}
			if (!isObject(answer) || typeof answer.ok !== "boolean") {
				fail(new Error(`the fleet service broke the protocol: it answered ${line}`));
				return;
			}
			if (!answer.ok) {
				fail(new Error(typeof answer.error === "string" ? answer.error : `the fleet service failed, saying ${line}`));
				return;
			}
			if (answer.body !== true) {
				settle(() => {
					done();
					connection.destroy();
					resolve({ value: answer.value });
				});
				return;
			}
			settle(() => {
				const rest = new PassThrough();
				rest.write(received.subarray(end + 1));
				let ended = false;
				connection.once("end", () => {
					ended = true;
				});
				// A connection cut before its end cuts what follows the answer, which its reader then sees.
				connection.once("close", () => {
					done();
					if (!ended) rest.destroy(signal?.aborted === true ? signal.reason : new Error(`the fleet service at ${socket} went away while it sent ${request.op}'s answer`));
				});
				connection.pipe(rest);
				resolve({ value: answer.value, body: rest });
			});
		};
		connection.once("connect", () => {
			connected = true;
			connection.write(`${JSON.stringify({ ...request, protocol: FLEET_PROTOCOL, ...(body === undefined ? {} : { body: true }) })}\n`);
			if (body !== undefined) void send(connection, body);
		});
		connection.on("data", read);
		// Once answered, an error is seen by what reads what follows the answer, as the connection closes.
		connection.on("error", () => {});
		connection.once("error", (error: NodeJS.ErrnoException) => {
			if (connected) {
				lost();
				return;
			}
			fail(
				error.code === "ENOENT" || error.code === "ECONNREFUSED"
					? new FleetUnreachable(`no fleet service at ${socket}: is dsh running, with fleet installed?`, { cause: error })
					: error,
			);
		});
		connection.once("end", lost);
		connection.once("close", lost);
	});
}

/** Send what follows a request, and end it; what cannot be read cuts the connection, which the service then refuses. */
async function send(connection: Socket, body: AsyncIterable<Uint8Array>): Promise<void> {
	try {
		for await (const chunk of body) {
			if (connection.destroyed) return;
			if (!connection.write(chunk)) await once(connection, "drain");
		}
		connection.end();
	} catch (error) {
		connection.destroy(error instanceof Error ? error : new Error(String(error)));
	}
}

/**
 * Serve `handle` on a socket at `socket`, as the fleet service does: each connection's request,
 * of the wire's version, and what follows it, if it says so; and its answer, and what follows that.
 * A client that goes away aborts its request's signal. The socket's folder is made if missing;
 * the socket is its owner's alone.
 * @returns what closes the socket and its connections.
 * @throws when a service already answers there.
 */
export async function listenFleet(socket: string, handle: FleetHandler): Promise<() => Promise<void>> {
	await mkdir(path.dirname(socket), { recursive: true, mode: 0o700 });
	await claim(socket);
	const sockets = new Set<Socket>();
	// A client ends what it sends after a request's body, and reads the answer after.
	const server = createServer({ allowHalfOpen: true }, (connection) => {
		sockets.add(connection);
		connection.once("close", () => sockets.delete(connection));
		serve(connection, handle);
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socket, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const close = async (): Promise<void> => {
		const closed = new Promise<void>((resolve) => server.close(() => resolve()));
		for (const connection of sockets) connection.destroy();
		await closed;
	};
	try {
		await chmod(socket, 0o600);
	} catch (error) {
		await close();
		throw error;
	}
	return close;
}

/** Take over a socket's path, unless a service answers on it. */
async function claim(socket: string): Promise<void> {
	const answering = await new Promise<boolean>((resolve) => {
		const probe = createConnection(socket);
		probe.once("connect", () => {
			probe.destroy();
			resolve(true);
		});
		probe.once("error", () => resolve(false));
	});
	if (answering) throw new Error(`another fleet service serves ${socket}`);
	// What is left of a service that did not close it.
	await unlink(socket).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") throw error;
	});
}

/** Read one connection's request, up to its first newline, and answer it; what follows the newline is its body, if it has one. */
function serve(connection: Socket, handle: FleetHandler): void {
	let received = Buffer.alloc(0);
	let withBody = false;
	const gone = new AbortController();
	const leave = (): void => gone.abort(new Error("the client went away"));
	connection.once("close", leave);
	// A client that ends what it sends ends a request's body, and with any other request goes away.
	connection.once("end", () => {
		if (!withBody) leave();
	});
	// A client that went away before its answer.
	connection.on("error", () => {});
	const read = (chunk: Buffer): void => {
		received = Buffer.concat([received, chunk]);
		const end = received.indexOf(0x0a);
		if (end === -1) return;
		// Paused before it loses its reader, so that nothing is dropped until a pipe reads it.
		connection.pause();
		connection.off("data", read);
		const line = received.subarray(0, end).toString("utf8");
		let request: FleetRequest | undefined;
		let refusal: string | undefined;
		try {
			({ request, body: withBody } = parse(line));
		} catch (error) {
			refusal = messageOf(error);
		}
		const body = new PassThrough();
		if (withBody) {
			body.write(received.subarray(end + 1));
			connection.pipe(body);
		} else body.end();
		void respond(connection, () => (request === undefined ? Promise.reject(new Error(refusal)) : handle(request, body, gone.signal)), body);
	};
	connection.on("data", read);
}

async function respond(connection: Socket, answer: () => Promise<FleetAnswer>, body: Readable): Promise<void> {
	let line: object;
	let rest: AsyncIterable<Uint8Array> | undefined;
	try {
		const { value, body: after } = await answer();
		line = { ok: true, value: value ?? null, ...(after === undefined ? {} : { body: true }) };
		rest = after;
	} catch (error) {
		line = { ok: false, error: messageOf(error) };
	}
	// What the client sends that was not read, read to its end, so that the client reads the answer.
	body.resume();
	connection.write(`${JSON.stringify(line)}\n`);
	if (rest === undefined) {
		connection.end();
		return;
	}
	await pipeline(rest, connection).catch(() => connection.destroy());
}

/** A request, of the wire's version, as an object with its op, without the version; and whether a body follows it. */
function parse(line: string): { request: FleetRequest; body: boolean } {
	let json: unknown;
	try {
		json = JSON.parse(line);
	} catch {
		throw new Error("the request is not JSON");
	}
	if (!isObject(json)) throw new Error("the request is not a JSON object");
	const { protocol, body, ...request } = json;
	if (protocol !== FLEET_PROTOCOL) throw new Error(`the client speaks the fleet wire ${String(protocol)}, and the service ${FLEET_PROTOCOL}`);
	if (body !== undefined && body !== true) throw new Error("a request's body is true, if anything");
	if (typeof request.op !== "string" || request.op === "") throw new Error("the request has no op");
	return { request: request as FleetRequest, body: body === true };
}
