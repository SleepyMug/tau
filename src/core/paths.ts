import { lstatSync, type Stats, statSync } from "node:fs";
import path from "node:path";
import { valueLinkProblems } from "./links.js";
import type { Envelope, Kind, ResolvedCall } from "./model.js";
import { messageOf } from "./util.js";

/** What a runtime promises of the caller's paths, and asks of what the agent leaves (docs/spec/paths.md). */

const MISSING = "does not exist";

/** What is at `file`, as its content would be: a file or a directory, never a symlink. */
export function kindAt(file: string): Kind {
	const stats = lstatSync(file);
	if (stats.isFile()) return "file";
	if (stats.isDirectory()) return "dir";
	throw new Error(`${file} is neither a file nor a directory`);
}

/**
 * Before a run, on the client: whether the caller's paths fit the call. Each `in` and `inout` path
 * is a file or a directory as its kind says, and each of a list's either, and holds what a path
 * may (see `valueProblems`); each `out` path lies in a directory that exists, and is not there
 * yet, or is of its kind, symlinks followed. Paths may overlap. Throws, listing every problem.
 */
export function checkInputs(call: ResolvedCall): void {
	const problems: string[] = [];
	for (const [name, { mode, kind }] of Object.entries(call.files)) {
		const host = call.paths[name];
		if (host === undefined) continue;
		if (typeof host !== "string") {
			for (const item of host) problems.push(...valueProblems(item, undefined).map((problem) => `${name}: ${problem}`));
			continue;
		}
		if (mode !== "out") {
			problems.push(...valueProblems(host, kind).map((problem) => `${name}: ${problem}`));
			continue;
		}
		const parent = path.dirname(host);
		const parentProblem = shapeProblem(parent, "dir");
		if (parentProblem !== undefined) {
			problems.push(`${name}: cannot go in ${parent}, which ${parentProblem}`);
			continue;
		}
		const problem = shapeProblem(host, kind);
		if (problem !== undefined && problem !== MISSING) problems.push(`${name}: ${host} ${problem}`);
	}
	if (problems.length > 0) throw new Error(`the files do not fit the tau:\n  ${problems.join("\n  ")}`);
}

/**
 * Before a run, on the backend: whether `places`, where the backend placed each file of `call`,
 * fit it. Each place is absolute and ends in its file's base name; each `in` and `inout` place
 * holds what its path did, a file or a directory as its kind says, which holds what a path may
 * (see `valueProblems`); and each `out` place lies in a directory that exists. Throws, listing
 * every problem.
 */
export function checkPlaced(call: Pick<Envelope, "files">, places: { readonly [name: string]: string }): void {
	const problems: string[] = [];
	for (const [name, { mode, kind, base }] of Object.entries(call.files)) {
		const place = places[name];
		if (place === undefined) {
			problems.push(`${name}: has no place`);
			continue;
		}
		if (!path.isAbsolute(place) || path.basename(place) !== base) {
			problems.push(`${name}: its place, ${place}, is not absolute, or does not end in its base name, ${base}`);
			continue;
		}
		if (mode !== "out") {
			problems.push(...valueProblems(place, kind).map((problem) => `${name}: ${problem}`));
			continue;
		}
		const parentProblem = shapeProblem(path.dirname(place), "dir");
		if (parentProblem !== undefined) problems.push(`${name}: cannot go in ${path.dirname(place)}, which ${parentProblem}`);
	}
	if (problems.length > 0) throw new Error(`the files are not placed as the call asks:\n  ${problems.join("\n  ")}`);
}

/**
 * When the run ends, on the backend, if the agent returned normally: whether it left what the call
 * asks. What is at each `out` and `inout` file's place, in `places`, is a file or a
 * directory as its kind says, and holds what a path may (see `valueProblems`). Throws, listing
 * every problem.
 */
export function checkOutputs(call: Pick<Envelope, "files">, places: { readonly [name: string]: string }): void {
	const problems: string[] = [];
	for (const [name, { mode, kind }] of Object.entries(call.files)) {
		if (mode === "in") continue;
		const place = places[name];
		if (place === undefined) problems.push(`${name}: has no place`);
		else problems.push(...valueProblems(place, kind).map((problem) => `${name}: ${problem}`));
	}
	if (problems.length > 0) throw new Error(`the run did not leave what the call asks:\n  ${problems.join("\n  ")}`);
}

/**
 * Why `file`, an `in` or `inout` file's path, or what the agent left at an `out` or `inout` one's
 * place, is not of `kind`, either when undefined: it is not a symlink, and each symlink in a
 * directory is relative, and leads, through any further symlinks, all relative, to something that
 * exists in it.
 */
function valueProblems(file: string, kind: Kind | undefined): string[] {
	let stats: Stats;
	try {
		stats = lstatSync(file);
	} catch (error) {
		return [`${file} ${statProblem(error)}`];
	}
	if (stats.isSymbolicLink()) return [`${file} is a symlink, which a file's path cannot be`];
	const problem = kindProblem(stats, kind);
	if (problem !== undefined) return [`${file} ${problem}`];
	return stats.isDirectory() ? valueLinkProblems(file) : [];
}

/** Why `file` is not of `kind`, following symlinks; undefined when it is. */
function shapeProblem(file: string, kind: Kind | undefined): string | undefined {
	try {
		return kindProblem(statSync(file), kind);
	} catch (error) {
		return statProblem(error);
	}
}

function kindProblem(stats: Stats, kind: Kind | undefined): string | undefined {
	if (kind === "file") return stats.isFile() ? undefined : "is not a file";
	if (kind === "dir") return stats.isDirectory() ? undefined : "is not a directory";
	return stats.isFile() || stats.isDirectory() ? undefined : "is neither a file nor a directory";
}

function statProblem(error: unknown): string {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR" ? MISSING : `cannot be read: ${messageOf(error)}`;
}
