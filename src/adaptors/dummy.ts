import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { type Admitted, createBackendSdk, type ImplementationCatalog, type Placed, placesUnder, type Rendered } from "../backend/backend.js";
import type { WireAdaptor } from "../client/adaptor.js";
import type { Outcome } from "../core/model.js";
import { messageOf } from "../core/util.js";
import { removeAll } from "../transfer/deliver.js";
import { packCall, packResult, unpackCall, unpackResult } from "../wire-tar/archive.js";

/**
 * The dummy wire adaptor: a loopback to a dummy backend of its own, in this process. It packs a
 * job as a tar archive (docs/spec/serialization.md), and the dummy backend unpacks it with the
 * backend SDK, runs a dummy agent, and keeps the result, a tar archive too, until the run is
 * released, from this process or another; finishing it unpacks the result at the caller's paths.
 * A run ends before `submit` gives its id.
 */

/** A run, as the dummy agent is given it. */
export interface DummyRun {
	readonly placed: Placed;
	readonly rendered: Rendered;
	readonly signal: AbortSignal;
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

/** A catalog that serves any API, as if with an implementation at the tau's own version. */
export const anyImplementation: ImplementationCatalog = {
	find: (contract, held) => ({ contract, version: held, module: `dummy:${contract}` }),
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
	const kept = (id: string): string => {
		if (!/^[0-9a-f-]+$/u.test(id)) throw new Error(`no run ${id}`);
		return path.join(spool, `${id}.tar`);
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
			let outcome: Outcome;
			try {
				outcome = await agent({ placed, rendered: placed.render(), signal });
				if (signal.aborted) outcome = { ok: false, text: outcome.text, failure: "the run was stopped" };
			} catch (error) {
				outcome = { ok: false, text: "", failure: `the agent failed: ${messageOf(error)}` };
			}
			const { report, sources } = placed.collect(outcome);
			await mkdir(spool, { recursive: true, mode: 0o700 });
			const partial = `${kept(id)}.${randomUUID()}.part`;
			await pipeline(packResult(report, sources), createWriteStream(partial, { mode: 0o600 }));
			await rename(partial, kept(id));
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
		async finish(id, delivery, signal) {
			signal?.throwIfAborted();
			const file = kept(id);
			if ((await stat(file).catch(() => undefined)) === undefined) throw new Error(`no run ${id}`);
			return unpackResult(createReadStream(file), delivery);
		},
		async release(id) {
			// Every run has ended by now: there is nothing to stop.
			await rm(kept(id), { force: true });
		},
	};
}
