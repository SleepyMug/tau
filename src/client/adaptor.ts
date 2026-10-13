import type { Delivery, Job, Report } from "../core/model.js";

/**
 * A wire adaptor: the part of the client that talks to one backend (docs/spec/protocol.md). The
 * client gives it a job, checked, and where the outputs go; how it packages the tau and the files,
 * carries them, and puts the outputs is its own, which the transfer helpers can do for it. It is
 * part of the client, and checks what the backend gives back before it puts anything.
 */
export interface WireAdaptor {
	/**
	 * Hand a run to the backend. Aborting `signal` stops the handing over.
	 * @returns the run's id, by which this adaptor knows it, from any process.
	 * @throws when the backend refuses the run, such as when it implements no version of an API
	 * that serves the tau's.
	 */
	submit(job: Job, signal?: AbortSignal): Promise<string>;
	/**
	 * Wait for the run `id` to have a result, put its outputs at `delivery.targets`, as
	 * docs/spec/results.md has it, and give its report. It may be called again: each call gives a
	 * whole result, the latest, which need not be the same, and puts its outputs again. What does
	 * not fit `delivery.files`, or breaks the protocol, is a run that failed, which puts nothing.
	 * Aborting `signal` stops the waiting, not the run.
	 */
	finish(id: string, delivery: Delivery, signal?: AbortSignal): Promise<Report>;
	/** Let the backend drop the run `id`, stopping it if it has not ended; then `finish` knows it no more. */
	release(id: string): Promise<void>;
	// No `wait`: the client's is `finish`, then `release`, each made here.
}
