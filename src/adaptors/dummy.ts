import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { type Admitted, createBackendSdk, type ImplementationCatalog, type Placed, placesUnder, type Rendered } from "../backend/backend.js";
import type { WireAdaptor } from "../client/adaptor.js";
import type { Json, Outcome, Status, Trace } from "../core/model.js";
import { messageOf } from "../core/util.js";
import { removeAll } from "../transfer/deliver.js";
import { packCall, packResult, unpackCall, unpackResult } from "../wire-tar/archive.js";

/**
 * The dummy wire adaptor: a loopback to a dummy backend of its own, in this process. It packs a
 * job as a tar archive (docs/spec/serialization.md), and the dummy backend unpacks it with the
 * backend SDK, runs a dummy agent, and keeps the result, a tar archive too, with the run's status
 * and its trace beside it, until the run is released, from this process or another; its result
 * unpacks the archive at the caller's paths. A run ends, with its one result, before `submit` gives
 * its id.
 */

/** The format of the dummy backend's traces: its own events, `admitted`, `rendered` and `ended`, and the agent's, in between. */
export const DUMMY_TRACE = "tau-dummy";

/** A run, as the dummy agent is given it. */
export interface DummyRun {
	readonly placed: Placed;
	readonly rendered: Rendered;
	readonly signal: AbortSignal;
	/** Add an event to the run's trace, after the backend's own, before its end. */
	readonly trace: (event: Json) => void;
}

/** The dummy agent: does the run, as it will, and says how it ended. */
export type DummyAgent = (run: DummyRun) => Promise<Outcome>;

export interface DummyOptions {
	/** By default {@link echoAgent}. */
	readonly agent?: DummyAgent;
	/** By default {@link anyImplementation}. */
	readonly implementations?: ImplementationCatalog;
	/** Where the dummy backend keeps results, one file each; by default under the system's temporary directory. */
	readonly spool?: string;
}

/** A catalog that serves any API, as if with an implementation at the version its range gives, and holds no declarations. */
export const anyImplementation: ImplementationCatalog = {
	find: (contract, range) => (range === undefined ? undefined : { contract, version: range.slice(1), module: `dummy:${contract}` }),
};

/**
 * An agent that does nothing but leave something where the call asks it to, an empty file or
 * directory at each `out` file's place, and gives back the prompt, rendered, as its final text.
 */
export const echoAgent: DummyAgent = async ({ placed, rendered }) => {
	for (const [name, { mode, kind }] of Object.entries(placed.envelope.files)) {
		if (mode !== "out") continue;
		const place = placed.places[name] as string;
		if (kind === "dir") await mkdir(place, { recursive: true });
		else await writeFile(place, "", { flag: "a" });
	}
	return { ok: true, text: rendered.prompt };
};

export function createDummyAdaptor(options: DummyOptions = {}): WireAdaptor {
	const { agent = echoAgent, implementations = anyImplementation } = options;
	const spool = options.spool ?? path.join(os.tmpdir(), `tau-dummy-${os.userInfo().uid}`);
	const sdk = createBackendSdk({ implementations });
	const kept = (id: string, extension: "tar" | "json"): string => {
		if (!/^[0-9a-f-]+$/u.test(id)) throw new Error(`no run ${id}`);
		return path.join(spool, `${id}.${extension}`);
	};
	/** What the dummy backend keeps of a run beside its result's archive: its status and its trace. */
	const about = async (id: string): Promise<{ status: Status; trace: Trace }> => {
		const text = await readFile(kept(id, "json"), "utf8").catch(() => undefined);
		if (text === undefined) throw new Error(`no run ${id}`);
		return JSON.parse(text) as { status: Status; trace: Trace };
	};
	/** Write `content` to `file` whole, or not at all. */
	const keep = async (file: string, content: AsyncIterable<Uint8Array> | string): Promise<void> => {
		const partial = `${file}.${randomUUID()}.part`;
		if (typeof content === "string") await writeFile(partial, content, { mode: 0o600 });
		else await pipeline(content, createWriteStream(partial, { mode: 0o600 }));
		await rename(partial, file);
	};

	/** The dummy backend: takes in a call's archive, runs it, and keeps its result's. */
	const serve = async (id: string, call: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<void> => {
		const work = await mkdtemp(path.join(os.tmpdir(), "tau-dummy-run-"));
		try {
			const tau = path.join(work, "tau");
			let admitted: Admitted | undefined;
			let places: { readonly [name: string]: string } = {};
			await unpackCall(call, {
				tau,
				place(envelope) {
					admitted = sdk.admit(envelope, tau);
					places = placesUnder(path.join(work, "files"), admitted.envelope);
					return places;
				},
			});
			const placed = (admitted as Admitted).place(places);
			const rendered = placed.render();
			const events: Json[] = [
				{ type: "admitted", envelope: placed.envelope as unknown as Json },
				{ type: "rendered", prompt: rendered.prompt },
			];
			let outcome: Outcome;
			try {
				outcome = await agent({ placed, rendered, signal, trace: (event) => events.push(event) });
				if (signal.aborted) outcome = { ok: false, text: outcome.text, failure: "the run was stopped" };
			} catch (error) {
				outcome = { ok: false, text: "", failure: `the agent failed: ${messageOf(error)}` };
			}
			const { report, sources } = placed.collect(outcome);
			const { ok, text, failure } = report;
			events.push(failure === undefined ? { type: "ended", ok, text } : { type: "ended", ok, text, failure });
			const status: Status = failure === undefined ? { state: "ended", result: 1, ok } : { state: "ended", result: 1, ok, failure };
			await mkdir(spool, { recursive: true, mode: 0o700 });
			await keep(kept(id, "tar"), packResult(report, sources));
			await keep(kept(id, "json"), JSON.stringify({ status, trace: { format: DUMMY_TRACE, events } }));
		} finally {
			await removeAll(work);
		}
	};

	return {
		async submit(job, signal) {
			signal?.throwIfAborted();
			const id = randomUUID();
			await serve(id, packCall(job), signal ?? new AbortController().signal);
			return id;
		},
		async status(id, signal) {
			signal?.throwIfAborted();
			return (await about(id)).status;
		},
		async result(id, delivery, signal) {
			signal?.throwIfAborted();
			// Every run has ended by now, with its one result.
			await about(id);
			return { result: 1, report: await unpackResult(createReadStream(kept(id, "tar")), delivery) };
		},
		async trace(id, signal) {
			signal?.throwIfAborted();
			return (await about(id)).trace;
		},
		async release(id) {
			// Every run has ended by now: there is nothing to stop.
			await rm(kept(id, "json"), { force: true });
			await rm(kept(id, "tar"), { force: true });
		},
	};
}
