import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { type Admitted, catalogOf, createBackendSdk, type Implementation, type Placed, placesUnder } from "../backend/backend.js";
import { readContract } from "../core/apis.js";
import type { Outcome } from "../core/model.js";
import { removeAll } from "../transfer/deliver.js";
import { packResult, unpackCall } from "../wire-tar/archive.js";
import { packContract } from "../wire-tar/contract.js";
import { type FleetHandler, type FleetRequest, readFleetContractRequest, readFleetRunRequest } from "./fleet.js";

/**
 * A fleet service for the tests, in this process, built on the backend SDK: each run's agent
 * runs as it is submitted, and has ended once the agent has and the gate is open; its result is
 * collected again each time it is asked for, so that what the agent did since shows. Its traces
 * are its own, {@link FAKE_TRACE}.
 */
export const FAKE_TRACE = "fake-fleet";

interface Kept {
	placed: Placed;
	work: string;
	/** How the agent ended, once it did, and the gate was open. */
	outcome?: Outcome;
}

export class FakeFleet {
	/** Each submit's request, as it came. */
	readonly submitted: FleetRequest[] = [];
	readonly released: string[] = [];
	/** The signal of each request, by its op, the last one's. */
	readonly signals = new Map<string, AbortSignal>();
	private readonly runs = new Map<string, Kept>();
	/** What a run's end waits for, besides its agent, as a run submitted takes it. */
	gate: Promise<void> = Promise.resolve();

	/** @param implementations - the APIs it serves, and gives the contracts of. */
	constructor(
		private readonly agent: (placed: Placed) => Promise<Outcome>,
		private readonly implementations: readonly Implementation[] = [],
	) {}

	readonly handle: FleetHandler = async (request, body, signal) => {
		this.signals.set(request.op, signal);
		const asked = readFleetContractRequest(request);
		if (asked !== undefined) {
			const found = catalogOf(this.implementations).find(asked.name, asked.range);
			if (found?.declarations === undefined) throw new Error(`no contract ${asked.name}${asked.range === undefined ? "" : ` within ${asked.range}`}`);
			return { value: readContract(found.declarations), body: Readable.from(packContract(found.declarations)) };
		}
		const run = readFleetRunRequest(request);
		if (run === undefined) throw new Error(`no op ${request.op}`);
		switch (run.op) {
			case "submit": {
				this.submitted.push(request);
				const sdk = createBackendSdk({ implementations: catalogOf(this.implementations) });
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
				const kept: Kept = { placed, work };
				this.runs.set(id, kept);
				void Promise.all([this.agent(placed), this.gate]).then(([outcome]) => {
					kept.outcome = outcome;
				});
				return { value: { id } };
			}
			case "status": {
				const { outcome } = this.runOf(run.id);
				if (outcome === undefined) return { value: { state: "running" } };
				const { ok, failure } = outcome;
				return { value: { state: "ended", result: 1, ok, ...(failure === undefined ? {} : { failure }) } };
			}
			case "result": {
				const { placed, outcome } = this.runOf(run.id);
				if (outcome === undefined) throw new Error(`${run.id} has no result yet`);
				const { report, sources } = placed.collect(outcome);
				return { value: { result: 1 }, body: Readable.from(packResult(report, sources)) };
			}
			case "trace": {
				const { placed, outcome } = this.runOf(run.id);
				const events = [{ type: "placed", files: Object.keys(placed.places) }, ...(outcome === undefined ? [] : [{ type: "ended", ...outcome }])];
				return { value: { format: FAKE_TRACE, events } };
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

	private runOf(id: string): Kept {
		const kept = this.runs.get(id);
		if (kept === undefined) throw new Error(`no run ${id}`);
		return kept;
	}
}
