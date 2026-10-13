import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { type Admitted, catalogOf, createBackendSdk, type Placed, placesUnder } from "../backend/backend.js";
import type { Outcome } from "../core/model.js";
import { removeAll } from "../transfer/deliver.js";
import { packResult, unpackCall } from "../wire-tar/archive.js";
import { type FleetHandler, type FleetRequest, readFleetRunRequest } from "./fleet.js";

/**
 * A fleet service for the tests, in this process, built on the backend SDK: each run's agent
 * runs as it is submitted, and its result is collected again at each finish, so that what the agent
 * did since shows.
 */
export class FakeFleet {
	/** Each submit's request, as it came. */
	readonly submitted: FleetRequest[] = [];
	readonly released: string[] = [];
	/** The signal of each request, by its op, the last one's. */
	readonly signals = new Map<string, AbortSignal>();
	private readonly runs = new Map<string, { placed: Placed; work: string; ended: Promise<Outcome> }>();
	/** What a finish waits for before it collects. */
	gate: Promise<void> = Promise.resolve();

	constructor(private readonly agent: (placed: Placed) => Promise<Outcome>) {}

	readonly handle: FleetHandler = async (request, body, signal) => {
		this.signals.set(request.op, signal);
		const run = readFleetRunRequest(request);
		if (run === undefined) throw new Error(`no op ${request.op}`);
		switch (run.op) {
			case "submit": {
				this.submitted.push(request);
				const sdk = createBackendSdk({ implementations: catalogOf([]) });
				const work = await mkdtemp(path.join(os.tmpdir(), "tau-fake-fleet-"));
				const tau = path.join(work, "tau");
				let admitted: Admitted | undefined;
				let places: { readonly [name: string]: string } = {};
				try {
					await unpackCall(body, {
						tau,
						place(envelope) {
							admitted = sdk.admit(envelope, tau);
							places = placesUnder(path.join(work, "files"), admitted.envelope);
							return places;
						},
					});
				} catch (error) {
					await removeAll(work);
					throw error;
				}
				const placed = (admitted as Admitted).place(places);
				const id = `session-${randomUUID()}`;
				this.runs.set(id, { placed, work, ended: this.agent(placed) });
				return { value: { id } };
			}
			case "finish": {
				const kept = this.runOf(run.id);
				await Promise.race([this.gate, new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
				const { report, sources } = kept.placed.collect(await kept.ended);
				return { value: null, body: Readable.from(packResult(report, sources)) };
			}
			case "release": {
				const kept = this.runOf(run.id);
				this.runs.delete(run.id);
				this.released.push(run.id);
				await removeAll(kept.work);
				return { value: null };
			}
		}
	};

	/** Where a run's files are placed. */
	places(id: string): { readonly [name: string]: string } {
		return this.runOf(id).placed.places;
	}

	private runOf(id: string): { placed: Placed; work: string; ended: Promise<Outcome> } {
		const kept = this.runs.get(id);
		if (kept === undefined) throw new Error(`no run ${id}`);
		return kept;
	}
}
