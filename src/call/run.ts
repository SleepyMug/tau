import { chmod, cp, lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type BoundHandle, type Caller, checkInputs, checkOutputs, loadTau } from "../tau/tau.js";
import {
	type Archive,
	type BlobSource,
	type CallJson,
	extractBlob,
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

/** Where a caller has each `$out` and `$inout` handle: its path, absolute, by the handle's JSON Pointer. */
export type Targets = { readonly [pointer: string]: string };

/** A call, packed. */
export interface PackedCall {
	/** The tau's directory, absolute, as the caller has it. */
	readonly tauDir: string;
	/** The call's archive, read from the caller's files as it is read. */
	readonly archive: AsyncIterable<Uint8Array>;
	readonly targets: Targets;
}

/** A run that ended, as a runtime gives it back: its result's archive, and where the caller has its handles. */
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
 * The call of a run of the tau at `tauDir` with `values` (docs/spec/serialization.md), and its
 * targets: the tau read, the values bound and the handles' paths checked as a runtime would
 * (docs/spec/library.md), then each `$in` and `$inout` path a blob, one for each path, and, unless
 * `tau` is false, the tau a blob too. The archive reads the files as it is read.
 */
export function packCall(tauDir: string, values: unknown, caller: Caller, options: { readonly tau?: boolean } = {}): PackedCall {
	const tau = loadTau(tauDir);
	const run = tau.bind(values, caller);
	checkInputs(run);
	const blobs: BlobSource[] = [];
	const ids = new Map<string, string>();
	const targets: Record<string, string> = {};
	const callValues = structuredClone(run.values) as Record<string, unknown>;
	for (const handle of run.handles) {
		const host = handle.host as string;
		if (handle.mode !== "in") targets[handle.pointer] = host;
		if (handle.mode === "out") {
			replaceAt(callValues, handle.pointer, { $out: { name: handle.name } });
			continue;
		}
		let blob = ids.get(host);
		if (blob === undefined) {
			blob = `b${ids.size}`;
			ids.set(host, blob);
			blobs.push({ id: blob, path: host });
		}
		replaceAt(callValues, handle.pointer, { [`$${handle.mode}`]: { name: handle.name, kind: kindAt(host), blob } });
	}
	const json: CallJson = { values: callValues as CallJson["values"], ...(options.tau === false ? {} : { tau: { kind: "dir", blob: "tau" } }) };
	// The tau first, so that a runtime can read it, and bind the values, before it reads the rest.
	if (options.tau !== false) blobs.unshift({ id: "tau", path: tau.dir });
	return { tauDir: tau.dir, archive: writeCall(json, blobs), targets };
}

/**
 * Put what a result holds at the caller's paths, `targets`, as docs/spec/results.md has it: a
 * directory merges into a directory there, each of its entries put the same way, and anything else
 * replaces what is there; a path's symlinks are followed, and paths that lie in one another are put
 * outer first. The result is trusted to say what goes where: only its archive is checked.
 * @returns how the run ended.
 * @throws for an output at a pointer `targets` has no path for, before anything is put.
 */
export async function applyResult(archive: AsyncIterable<Uint8Array>, targets: Targets): Promise<Result> {
	const { json, blobs } = await readResult(archive);
	const given = Object.entries(json.outputs).map(([pointer, output]) => {
		const to = targets[pointer];
		if (to === undefined) throw new Error(`the result has an output at ${pointer}, where the caller has no $out or $inout handle`);
		return { to, blob: contentOf(output).blob };
	});
	const scratch = await mkdtemp(path.join(os.tmpdir(), "tau-result-"));
	try {
		for await (const blob of blobs) await extractBlob(blob, path.join(scratch, blob.id));
		given.sort((a, b) => depth(a.to) - depth(b.to));
		for (const { to, blob } of given) await put(path.join(scratch, blob), await realpath(to).catch(() => to));
	} finally {
		await removeAll(scratch);
	}
	return resultOf(json);
}

/**
 * Place a call where the agent works: the content of each handle with a blob at its view, and the
 * tau at `tau`, when given. Each place is not there yet; the directories it lies in are made, as
 * they are for each `$out` handle's place, which is left empty. Blobs placed nowhere are read past.
 */
export async function placeCall(call: Archive<CallJson>, at: { readonly handles?: readonly BoundHandle[]; readonly tau?: string }): Promise<void> {
	const places = new Map<string, string[]>();
	const add = (blob: string, to: string): void => {
		const known = places.get(blob) ?? [];
		// Handles placed at the same place share it.
		if (!known.includes(to)) places.set(blob, [...known, to]);
	};
	if (at.tau !== undefined) {
		if (call.json.tau === undefined) throw new Error("the call does not carry its tau");
		add(call.json.tau.blob, at.tau);
	}
	for (const handle of at.handles ?? []) {
		if (handle.blob !== undefined) add(handle.blob, handle.view);
		else if (handle.mode === "out") await mkdir(path.dirname(handle.view), { recursive: true });
	}
	for await (const blob of call.blobs) {
		const [first, ...rest] = places.get(blob.id) ?? [];
		if (first === undefined) continue;
		await mkdir(path.dirname(first), { recursive: true });
		await extractBlob(blob, first);
		// A blob several handles name is given to each as a copy of its own.
		for (const to of rest) {
			await mkdir(path.dirname(to), { recursive: true });
			await cp(first, to, { recursive: true, verbatimSymlinks: true });
		}
	}
}

/**
 * A result's archive, once the run ended as `outcome` says: if the run succeeded, what the agent
 * left at each `$out` and `$inout` handle, where `locate` finds it, by default its view, checked as
 * docs/spec/paths.md asks; if that does not fit, the run failed, with why, and gives back nothing.
 * The archive reads the files as it is read.
 */
export function packResult(outcome: Result, handles: readonly BoundHandle[], locate: (handle: BoundHandle) => string = ({ view }) => view): AsyncGenerator<Uint8Array> {
	let result: Result = outcome.ok ? { ok: true, text: outcome.text } : outcome;
	if (result.ok) {
		try {
			checkOutputs({ prompt: "", values: {}, handles }, locate);
		} catch (error) {
			result = { ok: false, text: result.text, failure: error instanceof Error ? error.message : String(error) };
		}
	}
	const outputs: Record<string, Output> = {};
	const blobs: BlobSource[] = [];
	if (result.ok) {
		for (const handle of handles) {
			if (handle.mode === "in") continue;
			const id = `o${blobs.length}`;
			const file = locate(handle);
			blobs.push({ id, path: file });
			const named = { name: handle.name, kind: kindAt(file), blob: id };
			outputs[handle.pointer] = handle.mode === "out" ? { $out: named } : { $inout: named };
		}
	}
	return writeResult({ ...result, outputs }, blobs);
}

/**
 * Whether a result fits the run whose handles are `handles`, as one from a runtime the caller does
 * not trust must: each output is at an `$out` or `$inout` handle, of its mode and name; and if the
 * run succeeded, every such handle has one, of the kind its type declares.
 * @throws listing every problem.
 */
export function checkResult(result: ResultJson, handles: readonly Pick<BoundHandle, "at" | "pointer" | "mode" | "kind" | "name">[]): void {
	const problems: string[] = [];
	const given = new Map(handles.filter(({ mode }) => mode !== "in").map((handle) => [handle.pointer, handle]));
	for (const [pointer, output] of Object.entries(result.outputs)) {
		const handle = given.get(pointer);
		if (handle === undefined) {
			problems.push(`${pointer}: is no $out or $inout handle of the run`);
			continue;
		}
		const mode = "$out" in output ? "out" : "inout";
		const { name, kind } = contentOf(output);
		if (mode !== handle.mode) problems.push(`${handle.at}: is an $${handle.mode} handle, given back as an $${mode} one`);
		if (name !== handle.name) problems.push(`${handle.at}: is named ${handle.name}, given back as ${name}`);
		if (handle.kind !== "path" && kind !== handle.kind)
			problems.push(`${handle.at}: is ${handle.kind === "dir" ? "a directory" : "a file"}, given back as ${kind === "dir" ? "a directory" : "a file"}`);
	}
	if (result.ok) for (const handle of given.values()) if (!Object.hasOwn(result.outputs, handle.pointer)) problems.push(`${handle.at}: the run succeeded, but gave nothing back for it`);
	if (problems.length > 0) throw new Error(`the result does not fit the run:\n  ${problems.join("\n  ")}`);
}

/**
 * Run the tau at `tauDir` with `values` on `runtime`, and wait for it to end: pack the call, start
 * it, finish it, and put what it gives back at the caller's paths. Aborting `signal` cancels the run,
 * which then fails, and is finished all the same.
 * @throws when the run cannot start, such as when the values do not fit the tau.
 */
export async function runTau(runtime: Runtime, tauDir: string, values: unknown, caller: Caller, signal?: AbortSignal): Promise<Result> {
	signal?.throwIfAborted();
	const id = await runtime.start(packCall(tauDir, values, caller));
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

function contentOf(output: Output): { name: string; kind: "file" | "dir"; blob: string } {
	return "$out" in output ? output.$out : output.$inout;
}

/** Replace the value at `pointer` in `values`, where one is. */
function replaceAt(values: Record<string, unknown>, pointer: string, value: unknown): void {
	const steps = pointer.slice(1).split("/");
	const last = steps.pop() as string;
	let parent = values as Record<string, unknown>;
	for (const step of steps) parent = parent[step] as Record<string, unknown>;
	parent[last] = value;
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
