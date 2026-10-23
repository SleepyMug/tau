import { checkReport } from "../core/forms.js";
import type { CallFile, Outcome, ResolvedCall, Status, Trace } from "../core/model.js";
import { checkInputs, kindAt } from "../core/paths.js";
import { loadTau, type Tau } from "../core/tau.js";
import { messageOf } from "../core/util.js";
import type { WireAdaptor } from "./adaptor.js";
import { memoryRunStore, type RunStore } from "./store.js";

/**
 * The client (docs/spec/client.md): it reads and checks a tau and a caller's call where the caller
 * is, and hands the run to a wire adaptor, which carries it to its backend and puts what comes
 * back at the caller's paths. Every adaptor is injected; none is loaded by name.
 */

export interface ClientOptions {
	/** The wire adaptors a run may go through, by name. */
	readonly adaptors: { readonly [name: string]: WireAdaptor };
	/** The adaptor a run goes through when it names none; by default the first. */
	readonly adaptor?: string;
	/** Where the client keeps the runs it started, until they are released; by default in memory. */
	readonly runs?: RunStore;
}

export interface StartOptions {
	/** What the call's paths are relative to; by default `process.cwd()`. */
	readonly cwd?: string;
	/** The wire adaptor to hand the run to, by name. */
	readonly adaptor?: string;
	/** Aborting it stops handing the run over; once {@link TauClient.run} has, it releases the run. */
	readonly signal?: AbortSignal;
}

export interface WaitOptions {
	/** Aborting it stops the waiting, not the run. */
	readonly signal?: AbortSignal;
	/** Given the run's trace once it finished, before it is released; what it throws, the waiting throws, the run released. */
	readonly trace?: (trace: Trace) => void | Promise<void>;
}

/** How a run's result ended, as the client put its outputs: its number, as the run's status counts them, too. */
export interface Delivered extends Outcome {
	readonly result: number;
}

export interface TauClient {
	/** The tau at `dir`, read and checked. */
	load(dir: string): Tau;
	/**
	 * The tau at `dir`, and `call` resolved against it and `cwd`, its paths checked as a run's are
	 * when it starts (docs/spec/paths.md), without starting it. Throws, listing every problem.
	 */
	check(dir: string, call: unknown, cwd?: string): { readonly tau: Tau; readonly call: ResolvedCall };
	/**
	 * Check a run of the tau at `dir` for `call`, and hand it to a wire adaptor.
	 * @returns the run's id, by which this client, or another with the same run store, finishes it.
	 * @throws when the run cannot start: the call does not fit the tau, or the backend refuses it.
	 */
	start(dir: string, call: unknown, options?: StartOptions): Promise<string>;
	/** Where the run `run` is, at once: running, or ended, with its latest result's number and how that result ended. */
	status(run: string, options?: { readonly signal?: AbortSignal }): Promise<Status>;
	/**
	 * Put the outputs of the run `run`'s latest result at the caller's paths, and give how it ended,
	 * and its number, at once. Throws for a run that has no result yet. The run is kept: asking again
	 * gives the latest result, which need not be the same, and puts its outputs again.
	 */
	result(run: string, options?: { readonly signal?: AbortSignal }): Promise<Delivered>;
	/** What the run `run`'s agent did so far, in its backend's format, for a person to look into. */
	trace(run: string, options?: { readonly signal?: AbortSignal }): Promise<Trace>;
	/**
	 * Wait for the run `run` to have a result, asking its status until it has ended, then put its
	 * outputs at the caller's paths, and give how it ended: the client's own verb, made of the two.
	 * Aborting `signal` stops the waiting, not the run.
	 */
	finish(run: string, options?: { readonly signal?: AbortSignal }): Promise<Outcome>;
	/** Drop the run `run`, here and on its backend, stopping it if it has not ended. */
	release(run: string): Promise<void>;
	/** Finish the run `run`, give its trace to `options.trace`, if asked, then release it: the client's own verb. */
	wait(run: string, options?: WaitOptions): Promise<Outcome>;
	/**
	 * Start a run, and wait for it. Aborting `signal` once it started releases it, and it fails,
	 * having put nothing.
	 */
	run(dir: string, call: unknown, options?: StartOptions & WaitOptions): Promise<Outcome>;
}

/** Wait `ms`; aborting `signal` rejects with its reason, as the rest of the client does. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted === true) return reject(signal.reason);
		const stop = (): void => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", stop);
			resolve();
		}, ms);
		signal?.addEventListener("abort", stop, { once: true });
	});
}

/** The first pause between asking a run's status, in milliseconds, which doubles each time, up to {@link MOST_PAUSE}. */
const FIRST_PAUSE = 100;
const MOST_PAUSE = 2000;

export function createClient(options: ClientOptions): TauClient {
	const { adaptors, runs = memoryRunStore() } = options;
	const fallback = options.adaptor ?? Object.keys(adaptors)[0];
	if (fallback === undefined) throw new Error("a client needs a wire adaptor");
	const adaptorNamed = (name: string): WireAdaptor => {
		const adaptor = adaptors[name];
		if (adaptor === undefined) throw new Error(`no wire adaptor ${JSON.stringify(name)}; there are ${Object.keys(adaptors).join(", ")}`);
		return adaptor;
	};
	adaptorNamed(fallback);
	const recordOf = async (run: string) => {
		const record = await runs.get(run);
		if (record === undefined) throw new Error(`no run ${run}`);
		return record;
	};

	const check = (dir: string, call: unknown, cwd = process.cwd()): { tau: Tau; call: ResolvedCall } => {
		const tau = loadTau(dir);
		const resolved = tau.resolve(call, cwd);
		checkInputs(resolved);
		return { tau, call: resolved };
	};

	const client: TauClient = {
		load: loadTau,
		check,
		async start(dir, call, { cwd, adaptor: name = fallback, signal } = {}) {
			signal?.throwIfAborted();
			const adaptor = adaptorNamed(name);
			const { tau, call: resolved } = check(dir, call, cwd);
			const files: Record<string, CallFile> = {};
			const inputs: Record<string, string | readonly string[]> = {};
			const targets: Record<string, string> = {};
			for (const [file, given] of Object.entries(resolved.files)) {
				const from = resolved.paths[file] as string | readonly string[];
				if (given.mode !== "in") targets[file] = from as string;
				if (given.mode === "out") {
					files[file] = given;
					continue;
				}
				files[file] = { ...given, kind: typeof from === "string" ? kindAt(from) : "dir" };
				inputs[file] = from;
			}
			const id = await adaptor.submit({ envelope: { files, args: resolved.args }, tau: tau.dir, inputs }, signal);
			const run = `${name}:${id}`;
			await runs.put(run, { adaptor: name, id, files, targets });
			return run;
		},
		async status(run, { signal } = {}) {
			signal?.throwIfAborted();
			const { adaptor, id } = await recordOf(run);
			return adaptorNamed(adaptor).status(id, signal);
		},
		async result(run, { signal } = {}) {
			signal?.throwIfAborted();
			const { adaptor, id, files, targets } = await recordOf(run);
			const { result, report } = await adaptorNamed(adaptor).result(id, { files, targets }, signal);
			// The adaptor checked what the backend gave back; this checks the adaptor.
			try {
				checkReport(report, files);
			} catch (error) {
				return { result, ok: false, text: report.text, failure: `the wire adaptor ${adaptor} broke the protocol: ${messageOf(error)}` };
			}
			const { ok, text, failure } = report;
			return failure === undefined ? { result, ok, text } : { result, ok, text, failure };
		},
		async trace(run, { signal } = {}) {
			signal?.throwIfAborted();
			const { adaptor, id } = await recordOf(run);
			return adaptorNamed(adaptor).trace(id, signal);
		},
		async finish(run, options = {}) {
			const { signal } = options;
			for (let pause = FIRST_PAUSE; (await client.status(run, options)).state !== "ended"; pause = Math.min(pause * 2, MOST_PAUSE)) {
				await sleep(pause, signal);
			}
			const { result: _number, ...outcome } = await client.result(run, options);
			return outcome;
		},
		async release(run) {
			const { adaptor, id } = await recordOf(run);
			await adaptorNamed(adaptor).release(id);
			await runs.delete(run);
		},
		async wait(run, { signal, trace } = {}) {
			const outcome = await client.finish(run, signal === undefined ? {} : { signal });
			try {
				if (trace !== undefined) await trace(await client.trace(run, signal === undefined ? {} : { signal }));
			} finally {
				await client.release(run);
			}
			return outcome;
		},
		async run(dir, call, options = {}) {
			const run = await client.start(dir, call, options);
			const { signal } = options;
			try {
				return await client.wait(run, { ...(signal === undefined ? {} : { signal }), ...(options.trace === undefined ? {} : { trace: options.trace }) });
			} catch (error) {
				if (signal?.aborted !== true) throw error;
				// Unless waiting released it already, as it does once the run finished.
				if ((await runs.get(run)) !== undefined) await client.release(run);
				return { ok: false, text: "", failure: "the run was stopped" };
			}
		},
	};
	return client;
}
