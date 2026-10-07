import { chmod, cp, lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type BoundFile, type Caller, checkInputs, checkOutputs, type Json, loadTau } from "../tau/tau.js";
import {
	type Archive,
	type CallFile,
	type CallJson,
	type ContentSource,
	extractContent,
	kindAt,
	type Output,
	type Result,
	type ResultJson,
	readResult,
	writeCall,
	writeResult,
} from "./archive.js";

/**
 * A run as a call and a result (docs/spec/library.md): the caller packs a call from its paths, and
 * puts the result at them; the runtime places the call where its agent works, and packs the result
 * from there; and a {@link Runtime}, wherever it runs, takes the one and gives back the other.
 */

/** Where a caller has each `out` and `inout` file: its path, absolute, by the file's name. */
export type Targets = { readonly [name: string]: string };

/** A call, packed. */
export interface PackedCall {
	/** The tau's directory, absolute, as the caller has it. */
	readonly tauDir: string;
	/** The call's archive, read from the caller's files as it is read. */
	readonly archive: AsyncIterable<Uint8Array>;
	readonly targets: Targets;
}

/** A run that ended, as a runtime gives it back: its result's archive, and where the caller has its files. */
export interface Finished {
	readonly result: AsyncIterable<Uint8Array>;
	readonly targets: Targets;
}

/**
 * Whatever runs a call, here or elsewhere. It keeps a call's targets, without reading them, and
 * gives them back with its result, so that a caller who finishes a run need not be the one who
 * started it, and puts what the result holds where the targets say.
 */
export interface Runtime {
	/** Start a run of a call. @returns the run's id. */
	start(call: PackedCall): Promise<string>;
	/** Wait for a run to end, and give it back; aborting `signal` stops the waiting, not the run. */
	finish(id: string, signal?: AbortSignal): Promise<Finished>;
	/** Stop a run, which then fails. */
	cancel(id: string): Promise<void>;
}

/**
 * The archive of a run of the tau at `tauDir` for `call` (docs/spec/serialization.md), and its
 * targets: the tau read, the call bound and the files' paths checked as a runtime would
 * (docs/spec/library.md), then the content of each `in` and `inout` file, and, unless `tau` is
 * false, the tau's, first. The archive reads the files as it is read.
 */
export function packCall(tauDir: string, call: unknown, caller: Caller, options: { readonly tau?: boolean } = {}): PackedCall {
	const tau = loadTau(tauDir);
	// Where the agent sees each file is the runtime's: here, only the caller's paths count.
	const run = tau.bind(call, caller, ({ host, base }) => (typeof host === "string" ? host : base));
	checkInputs(run);
	// The tau first, so that a runtime can read it, and bind the call, before it reads the rest.
	const contents: ContentSource[] = options.tau === false ? [] : [{ from: tau.dir }];
	const targets: Record<string, string> = {};
	const files: Record<string, CallFile> = {};
	for (const { name, mode, base, host } of run.files) {
		if (mode === "out") {
			targets[name] = host as string;
			files[name] = { mode, base };
			continue;
		}
		if (mode === "inout") targets[name] = host as string;
		files[name] = { mode, base, kind: typeof host === "string" ? kindAt(host) : "dir" };
		contents.push({ file: name, from: host as string | readonly string[] });
	}
	const args = ((call as { args?: { [name: string]: Json } }).args ?? {}) as { [name: string]: Json };
	const json: CallJson = { files, args, ...(options.tau === false ? {} : { tau: true }) };
	return { tauDir: tau.dir, archive: writeCall(json, contents), targets };
}

/**
 * Put what a result holds at the caller's paths, `targets`, as docs/spec/results.md has it: a
 * directory merges into a directory there, each of its entries put the same way, and anything else
 * replaces what is there; a path's symlinks are followed, and paths that lie in one another are put
 * outer first. The result is trusted to say what goes where: only its archive is checked.
 * @returns how the run ended.
 * @throws for an output of a file `targets` has no path for, before anything is put.
 */
export async function applyResult(archive: AsyncIterable<Uint8Array>, targets: Targets): Promise<Result> {
	const { json, contents } = await readResult(archive);
	const given = Object.keys(json.outputs).map((name) => {
		const to = targets[name];
		if (to === undefined) throw new Error(`the result has an output for ${name}, which is no \`out\` or \`inout\` file of the caller's`);
		return { name, to };
	});
	const scratch = await mkdtemp(path.join(os.tmpdir(), "tau-result-"));
	try {
		for await (const content of contents) await extractContent(content, path.join(scratch, content.file as string));
		given.sort((a, b) => depth(a.to) - depth(b.to));
		for (const { name, to } of given) await put(path.join(scratch, name), await realpath(to).catch(() => to));
	} finally {
		await removeAll(scratch);
	}
	return resultOf(json);
}

/**
 * Place a call where the agent works: the content of each `in` and `inout` file at its view, and
 * the tau at `tau`, when given. Each place is not there yet; the directories it lies in are made,
 * as they are for each `out` file's place, which is left empty. Contents placed nowhere are read
 * past.
 */
export async function placeCall(call: Archive<CallJson>, at: { readonly files?: readonly BoundFile[]; readonly tau?: string }): Promise<void> {
	const places = new Map<string | undefined, string>();
	if (at.tau !== undefined) {
		if (call.json.tau !== true) throw new Error("the call does not carry its tau");
		places.set(undefined, at.tau);
	}
	for (const file of at.files ?? []) {
		if (file.mode === "out") await mkdir(path.dirname(file.view), { recursive: true });
		else places.set(file.name, file.view);
	}
	for await (const content of call.contents) {
		const to = places.get(content.file);
		if (to === undefined) continue;
		await mkdir(path.dirname(to), { recursive: true });
		await extractContent(content, to);
	}
}

/**
 * A result's archive, once the run ended as `outcome` says: if the run succeeded, what the agent
 * left at each `out` and `inout` file, where `locate` finds it, by default its view, checked as
 * docs/spec/paths.md asks; if that does not fit, the run failed, with why, and gives back nothing.
 * The archive reads the files as it is read.
 */
export function packResult(outcome: Result, files: readonly BoundFile[], locate: (file: BoundFile) => string = ({ view }) => view): AsyncGenerator<Uint8Array> {
	let result: Result = outcome.ok ? { ok: true, text: outcome.text } : outcome;
	if (result.ok) {
		try {
			checkOutputs({ files }, locate);
		} catch (error) {
			result = { ok: false, text: result.text, failure: error instanceof Error ? error.message : String(error) };
		}
	}
	const outputs: Record<string, Output> = {};
	const contents: ContentSource[] = [];
	if (result.ok) {
		for (const file of files) {
			if (file.mode === "in") continue;
			const from = locate(file);
			contents.push({ file: file.name, from });
			outputs[file.name] = { kind: kindAt(from) };
		}
	}
	return writeResult({ ...result, outputs }, contents);
}

/**
 * Whether a result fits the run whose files are `files`, as one from a runtime the caller does not
 * trust must: each output is an `out` or `inout` file's, of the kind it declares; and if the run
 * succeeded, every such file has one.
 * @throws listing every problem.
 */
export function checkResult(result: ResultJson, files: readonly Pick<BoundFile, "name" | "mode" | "kind">[]): void {
	const problems: string[] = [];
	const given = new Map(files.filter(({ mode }) => mode !== "in").map((file) => [file.name, file]));
	for (const [name, { kind }] of Object.entries(result.outputs)) {
		const file = given.get(name);
		if (file === undefined) {
			problems.push(`${name}: is no \`out\` or \`inout\` file of the run`);
			continue;
		}
		if (file.kind !== undefined && kind !== file.kind)
			problems.push(`${name}: is ${file.kind === "dir" ? "a directory" : "a file"}, given back as ${kind === "dir" ? "a directory" : "a file"}`);
	}
	if (result.ok) for (const name of given.keys()) if (!Object.hasOwn(result.outputs, name)) problems.push(`${name}: the run succeeded, but gave nothing back for it`);
	if (problems.length > 0) throw new Error(`the result does not fit the run:\n  ${problems.join("\n  ")}`);
}

/**
 * Run the tau at `tauDir` for `call` on `runtime`, and wait for it to end: pack the call, start it,
 * finish it, and put what it gives back at the caller's paths. Aborting `signal` cancels the run,
 * which then fails, and is finished all the same.
 * @throws when the run cannot start, such as when the call does not fit the tau.
 */
export async function runTau(runtime: Runtime, tauDir: string, call: unknown, caller: Caller, signal?: AbortSignal): Promise<Result> {
	signal?.throwIfAborted();
	const id = await runtime.start(packCall(tauDir, call, caller));
	const cancel = (): void => {
		runtime.cancel(id).catch(() => {});
	};
	signal?.addEventListener("abort", cancel, { once: true });
	if (signal?.aborted === true) cancel();
	try {
		const { result, targets } = await runtime.finish(id);
		return await applyResult(result, targets);
	} finally {
		signal?.removeEventListener("abort", cancel);
	}
}

function resultOf({ ok, text, failure }: ResultJson): Result {
	return failure === undefined ? { ok, text } : { ok, text, failure };
}

function depth(file: string): number {
	return path.resolve(file).split(path.sep).length;
}

/** A directory merges into a directory; anything else replaces what is there, as a copy that keeps modes and symlinks. */
async function put(from: string, to: string): Promise<void> {
	if ((await lstat(from)).isDirectory() && (await lstat(to).catch(() => undefined))?.isDirectory() === true) {
		for (const name of await readdir(from)) await put(path.join(from, name), path.join(to, name));
		return;
	}
	await rm(to, { recursive: true, force: true });
	await cp(from, to, { recursive: true, verbatimSymlinks: true });
}

/** Remove a directory and all it holds, directories that are not writable included. */
async function removeAll(dir: string): Promise<void> {
	const open = async (file: string): Promise<void> => {
		const stats = await lstat(file).catch(() => undefined);
		if (stats?.isDirectory() !== true) return;
		await chmod(file, 0o700);
		for (const name of await readdir(file)) await open(path.join(file, name));
	};
	await open(dir);
	await rm(dir, { recursive: true, force: true });
}
