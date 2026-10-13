import { checkReport } from "../core/forms.js";
import type { CallFile, Outcome, ResolvedCall } from "../core/model.js";
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
	/**
	 * Wait for the run `run` to have a result, put its outputs at the caller's paths, and give how
	 * it ended. The run is kept: finishing it again gives a whole result, the latest, which need not
	 * be the same, and puts its outputs again. Aborting `signal` stops the waiting, not the run.
	 */
	finish(run: string, options?: { readonly signal?: AbortSignal }): Promise<Outcome>;
	/** Drop the run `run`, here and on its backend, stopping it if it has not ended. */
	release(run: string): Promise<void>;
	/** Finish the run `run`, then release it: the client's own verb, which its adaptor never sees. */
	wait(run: string, options?: { readonly signal?: AbortSignal }): Promise<Outcome>;
	/**
	 * Start a run, and wait for it. Aborting `signal` once it started releases it, and it fails,
	 * having put nothing.
	 */
	run(dir: string, call: unknown, options?: StartOptions): Promise<Outcome>;
}

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
		async finish(run, { signal } = {}) {
			signal?.throwIfAborted();
			const { adaptor, id, files, targets } = await recordOf(run);
			const report = await adaptorNamed(adaptor).finish(id, { files, targets }, signal);
			// The adaptor checked what the backend gave back; this checks the adaptor.
			try {
				checkReport(report, files);
			} catch (error) {
				return { ok: false, text: report.text, failure: `the wire adaptor ${adaptor} broke the protocol: ${messageOf(error)}` };
			}
			const { ok, text, failure } = report;
			return failure === undefined ? { ok, text } : { ok, text, failure };
		},
		async release(run) {
			const { adaptor, id } = await recordOf(run);
			await adaptorNamed(adaptor).release(id);
			await runs.delete(run);
		},
		async wait(run, options) {
			const outcome = await client.finish(run, options);
			await client.release(run);
			return outcome;
		},
		async run(dir, call, options = {}) {
			const run = await client.start(dir, call, options);
			const { signal } = options;
			try {
				return await client.wait(run, signal === undefined ? {} : { signal });
			} catch (error) {
				if (signal?.aborted !== true) throw error;
				await client.release(run);
				return { ok: false, text: "", failure: "the run was stopped" };
			}
		},
	};
	return client;
}
