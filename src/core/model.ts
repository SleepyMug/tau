/**
 * What the client, its wire adaptor and the backend share (docs/spec/protocol.md): what a tau
 * declares, the envelope of a call, how a run ended, and what the client hands its adaptor. JSON
 * and paths alone: how the files' contents travel is the adaptor's.
 */

/**
 * What the agent does with a file (docs/spec/calls.md): `in`, reads it; `out`, leaves something
 * there; `inout`, changes it in place.
 */
export type Mode = "in" | "out" | "inout";

/** What a file is: a file, or a directory. */
export type Kind = "file" | "dir";

/** A JSON value. */
export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

/** A file a tau takes, as tau.json declares it (docs/spec/metadata.md); without a kind, it may be either. */
export interface FileDeclaration {
	readonly mode: Mode;
	readonly kind?: Kind;
	readonly description: string;
}

/** A file of a call, checked against the tau. */
export interface CallFile {
	readonly mode: Mode;
	/**
	 * What it is, as tau.json declares it, or the call gives it; for an `in` given a list of paths,
	 * `dir`; undefined while it may be either.
	 */
	readonly kind?: Kind;
	/** The base name its place keeps: its path's, or its name, for an `in` given a list of paths. */
	readonly base: string;
}

/**
 * A call, checked against its tau, without the caller's paths: what the client sends the backend
 * (docs/spec/protocol.md). In an envelope that is sent, each `in` and `inout` file has the
 * kind of its content.
 */
export interface Envelope {
	/** Each file, by name: those tau.json declares, in its order, then the extra files, in the call's. */
	readonly files: { readonly [name: string]: CallFile };
	/** The args, as the caller gave them, their placeholders not yet expanded. */
	readonly args: { readonly [name: string]: Json };
}

/** A call as a caller gives it, checked, with the caller's paths. */
export interface ResolvedCall extends Envelope {
	/** Each file's path, by name, absolute, or, for an `in` given a list, each of its paths. */
	readonly paths: { readonly [name: string]: string | readonly string[] };
}

/** How a run ended (docs/spec/results.md). */
export interface Outcome {
	readonly ok: boolean;
	/** The agent's final text, or init's; empty when it gave none. */
	readonly text: string;
	/** Why the run failed, when it did. */
	readonly failure?: string;
}

/** What a run left at an `out` or `inout` file. */
export interface Output {
	readonly kind: Kind;
}

/** How a run ended, and what it gives back: what the backend sends the client. */
export interface Report extends Outcome {
	/** By the name of each `out` and `inout` file it gives back. */
	readonly outputs: { readonly [name: string]: Output };
}

/** A run, as the client hands it to its wire adaptor, checked against the tau and the caller's paths. */
export interface Job {
	/** The call, without the caller's paths, each `in` and `inout` file with the kind of what is at its path. */
	readonly envelope: Envelope;
	/** The tau's directory, absolute, which always goes with the call. */
	readonly tau: string;
	/** The caller's path of each `in` and `inout` file, absolute, by its name, or, for an `in`, its paths. */
	readonly inputs: { readonly [name: string]: string | readonly string[] };
}

/** Where a run's outputs go, as the client asks its wire adaptor to put them. */
export interface Delivery {
	/** The envelope's files, which the report is checked against. */
	readonly files: { readonly [name: string]: CallFile };
	/** The caller's path of each `out` and `inout` file, absolute, by its name. */
	readonly targets: { readonly [name: string]: string };
}

/** Init's exit code when it did the run: the agent does not run, and init's stdout is its text. */
export const TAU_SKIP = 0;
/** Init's exit code when the agent is to run on the prompt, as it would without init. */
export const TAU_RUN = 100;
/** Init's exit code when it failed: the agent runs, told so, as with any other ending. */
export const TAU_FALLBACK = 101;

/** What a file, or an arg the schema declares, may be named. */
export const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** What `${self}` names: the tau's own directory, so no file and no arg has this name. */
export const SELF = "self";
export const MODES: readonly Mode[] = ["in", "out", "inout"];
export const KINDS: readonly Kind[] = ["file", "dir"];
