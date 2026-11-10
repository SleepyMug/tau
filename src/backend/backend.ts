import path from "node:path";
import { readEnvelope } from "../core/forms.js";
import { type CallFile, type Envelope, type Json, type Outcome, type Output, type Report, TAU_RUN, TAU_SKIP } from "../core/model.js";
import type { Exposed } from "../core/packages.js";
import { checkOutputs, checkPlaced, kindAt } from "../core/paths.js";
import { type Expanded, loadTau, type Skill, type Tau } from "../core/tau.js";
import { messageOf } from "../core/util.js";

/**
 * The backend SDK (docs/spec/backend.md): what a backend does with a call, whatever carried it,
 * however its files reached it, and however the agent runs. It admits a call against its tau,
 * before any file arrives; checks the files once the backend placed them; renders what the agent
 * is given; and collects the run's report, with where each output is. Paths alone: moving the
 * files is the backend's, which the transfer helpers can do for it.
 */

/** Each file at `<dir>/<name>/<base>`: a place for each file of `envelope`, by its name. */
export function placesUnder(dir: string, envelope: Envelope): { [name: string]: string } {
	return Object.fromEntries(Object.entries(envelope.files).map(([name, file]: [string, CallFile]) => [name, path.join(path.resolve(dir), name, file.base)]));
}

/** A call the backend admitted: checked against its tau, before any file arrives. */
export interface Admitted {
	readonly tau: Tau;
	/** The call, checked against the tau. */
	readonly envelope: Envelope;
	/**
	 * The run, once the backend placed its files: each `in` and `inout` file's content at its place,
	 * and each `out` file's place in a directory that exists, each place absolute and ending in its
	 * file's base name. Throws, listing every problem, when they are not placed as the call asks.
	 */
	place(places: { readonly [name: string]: string }): Placed;
}

/** A run whose files are where the agent sees them. */
export interface Placed extends Omit<Admitted, "place"> {
	/** Where each file is, by its name. */
	readonly places: { readonly [name: string]: string };
	/**
	 * What the agent is given, its placeholders expanded with the places, and `self`, where the
	 * agent sees the tau's directory, by default where the tau is.
	 */
	render(self?: string): Rendered;
	/**
	 * The run's report, once it ended as `outcome` says: if it succeeded, the kind of what the agent
	 * left at each `out` and `inout` file's place, checked as docs/spec/paths.md asks, and where
	 * each is, for the backend to send; if that does not fit, a run that failed, with why, giving
	 * back nothing. It may be collected again, as the run goes on, such as after a follow-up.
	 */
	collect(outcome: Outcome): Collected;
}

/** A run's report, and where each output it gives back is. */
export interface Collected {
	readonly report: Report;
	/** The place of each output, by its file's name. */
	readonly sources: { readonly [name: string]: string };
}

/** A run's context (docs/spec/context.md): where the agent sees the tau's directory and each file, and the args, expanded. */
export interface Context {
	readonly self: string;
	readonly files: { readonly [name: string]: string };
	readonly args: { readonly [name: string]: Json };
}

/** What the agent is given, for the backend to present it as it will. */
export interface Rendered extends Expanded {
	/** The run's context, which the backend writes where `TAU_CONTEXT` names it, for init and the agent's programs. */
	readonly context: Context;
	/** Where the agent sees the tau's own directory. */
	readonly self: string;
	readonly skills: readonly Skill[];
	readonly exposed: readonly Exposed[];
}

export interface BackendSdk {
	/**
	 * Admit a call: `envelope`, as it came, its form checked, and checked against the tau at
	 * `tauDir`, where the backend placed the tau that came with it, as from a client the backend
	 * does not trust. Throws when the call cannot run as declared, before the backend need take any
	 * file.
	 */
	admit(envelope: unknown, tauDir: string): Admitted;
}

export function createBackendSdk(): BackendSdk {
	return {
		admit(json, tauDir) {
			let given: Envelope;
			try {
				given = readEnvelope(json);
			} catch (error) {
				throw new TypeError(`the call breaks the protocol: ${messageOf(error)}`);
			}
			const tau = loadTau(tauDir);
			const envelope = tau.check(given);
			return {
				tau,
				envelope,
				place(places) {
					checkPlaced(envelope, places);
					return placed(tau, envelope, { ...places });
				},
			};
		},
	};
}

function placed(tau: Tau, envelope: Envelope, places: { readonly [name: string]: string }): Placed {
	return {
		tau,
		envelope,
		places,
		render(self = tau.dir) {
			const expanded = tau.expand(envelope, places, self);
			return { ...expanded, context: { self, files: places, args: expanded.args }, self, skills: tau.skills, exposed: tau.exposed };
		},
		collect(outcome) {
			let result: Outcome = outcome.ok ? { ok: true, text: outcome.text } : outcome;
			if (result.ok) {
				try {
					checkOutputs(envelope, places);
				} catch (error) {
					result = { ok: false, text: result.text, failure: messageOf(error) };
				}
			}
			const outputs: Record<string, Output> = {};
			const sources: Record<string, string> = {};
			if (result.ok)
				for (const [name, { mode }] of Object.entries(envelope.files)) {
					if (mode === "in") continue;
					sources[name] = places[name] as string;
					outputs[name] = { kind: kindAt(sources[name]) };
				}
			return { report: { ...result, outputs }, sources };
		},
	};
}

/**
 * What init's ending says (docs/spec/init.md): `skip`, it did the run, and its stdout is the final
 * text; `run`, the agent runs as it would without it; `fallback`, it failed, and the agent runs,
 * told so. `code` is undefined when init did not exit, such as when a signal ended it.
 */
export function initDecision(code: number | undefined): "skip" | "run" | "fallback" {
	if (code === TAU_SKIP) return "skip";
	if (code === TAU_RUN) return "run";
	return "fallback";
}
