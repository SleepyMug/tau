import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Code, ConnectError } from "@connectrpc/connect";
import { type Admitted, createBackendSdk, type Placed, placesUnder } from "../backend/backend.js";
import type { Outcome } from "../core/model.js";
import { removeAll } from "../transfer/deliver.js";
import { packResult, unpackCall } from "../wire-tar/archive.js";
import type { RunBackend } from "./routes.js";

/**
 * A backend for the tests, in this process, built on the backend SDK: each run's agent runs as it
 * is submitted, and has ended once the agent has and the gate is open; its result is collected
 * again each time it is asked for, so that what the agent did since shows. Its traces are its
 * own, {@link FAKE_TRACE}.
 */
export const FAKE_TRACE = "fake-backend";

interface Kept {
	placed: Placed;
	work: string;
	/** How the agent ended, once it did, and the gate was open. */
	outcome?: Outcome;
}

export class FakeBackend implements RunBackend {
	/** What named each run submitted, as it came. */
	readonly submitted: { readonly title: string; readonly project?: string }[] = [];
	readonly released: string[] = [];
	private readonly runs = new Map<string, Kept>();
	/** What a run's end waits for, besides its agent, as a run submitted takes it. */
	gate: Promise<void> = Promise.resolve();

	constructor(private readonly agent: (placed: Placed) => Promise<Outcome>) {}

	async submit(call: AsyncIterable<Uint8Array>, start: { readonly title: string; readonly project?: string }): Promise<string> {
		this.submitted.push(start);
		const sdk = createBackendSdk();
		const work = await mkdtemp(path.join(os.tmpdir(), "tau-fake-backend-"));
		const tau = path.join(work, "tau");
		let admitted: Admitted | undefined;
		let places: { readonly [name: string]: string } = {};
		try {
			await unpackCall(call, {
				tau,
				place(envelope) {
					admitted = sdk.admit(envelope, tau);
					places = placesUnder(path.join(work, "files"), admitted.envelope);
					return places;
				},
			});
		} catch (error) {
			await removeAll(work);
			throw new ConnectError(error instanceof Error ? error.message : String(error), Code.InvalidArgument);
		}
		const placed = (admitted as Admitted).place(places);
		const id = `session-${randomUUID()}`;
		const kept: Kept = { placed, work };
		this.runs.set(id, kept);
		void Promise.all([this.agent(placed), this.gate]).then(([outcome]) => {
			kept.outcome = outcome;
		});
		return id;
	}

	async status(id: string) {
		const { outcome } = this.runOf(id);
		if (outcome === undefined) return { state: "running" } as const;
		const { ok, failure } = outcome;
		return { state: "ended", result: 1, ok, ...(failure === undefined ? {} : { failure }) } as const;
	}

	async result(id: string) {
		const { placed, outcome } = this.runOf(id);
		if (outcome === undefined) throw new ConnectError(`${id} has no result yet`, Code.FailedPrecondition);
		const { report, sources } = placed.collect(outcome);
		return { result: 1, archive: packResult(report, sources) };
	}

	async trace(id: string) {
		const { placed, outcome } = this.runOf(id);
		const events = [{ type: "placed", files: Object.keys(placed.places) }, ...(outcome === undefined ? [] : [{ type: "ended", ...outcome }])];
		return { format: FAKE_TRACE, events };
	}

	async release(id: string) {
		const kept = this.runOf(id);
		this.runs.delete(id);
		this.released.push(id);
		await removeAll(kept.work);
	}

	/** Where a run's files are placed. */
	places(id: string): { readonly [name: string]: string } {
		return this.runOf(id).placed.places;
	}

	private runOf(id: string): Kept {
		const kept = this.runs.get(id);
		if (kept === undefined) throw new ConnectError(`no run ${id}`, Code.NotFound);
		return kept;
	}
}
