import type { Contract } from "../core/apis.js";
import type { Delivery, Job, Numbered, Status, Trace } from "../core/model.js";

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
	 * Where the run `id` is, at once: running until it has a result, then ended, with its latest
	 * result's number and how that result ended, as from a backend the adaptor does not trust.
	 * Aborting `signal` gives up asking.
	 */
	status(id: string, signal?: AbortSignal): Promise<Status>;
	/**
	 * Put the outputs of the run `id`'s latest result at `delivery.targets`, as docs/spec/results.md
	 * has it, and give the result's number and its report, at once. It refuses a run that has no
	 * result yet, and may be called again: each call gives a whole result, the latest, which need not
	 * be the same, and puts its outputs again. What does not fit `delivery.files`, or breaks the
	 * protocol, is a result that failed, which puts nothing.
	 */
	result(id: string, delivery: Delivery, signal?: AbortSignal): Promise<Numbered>;
	/**
	 * What the run `id`'s agent did so far, as the backend records it, in a format it names, for a
	 * person looking into the run: nothing relies on what it holds (docs/spec/protocol.md#traces).
	 */
	trace(id: string, signal?: AbortSignal): Promise<Trace>;
	/** Let the backend drop the run `id`, stopping it if it has not ended; then nothing else knows it. */
	release(id: string): Promise<void>;
	// No `finish` or `wait`: the client's are its status until it ended, then its result, and then its release.
	/**
	 * Optional, and no run uses it (docs/spec/protocol.md#contracts): put at `dir`, which does not
	 * exist, the contract `name`, its package.json and declarations, at the newest version the
	 * backend implements within `range`, or of all without one, checked as from a backend the
	 * adaptor does not trust, and give its name, version and description.
	 * @throws when the backend implements no such version.
	 */
	contract?(name: string, range: string | undefined, dir: string, signal?: AbortSignal): Promise<Contract>;
}
