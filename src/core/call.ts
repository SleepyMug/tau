import path from "node:path";
import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import { type CallFile, type Envelope, type FileDeclaration, type Json, KINDS, type Kind, MODES, type Mode, type ResolvedCall } from "./model.js";
import { expansion, type Scope, scopeOf } from "./placeholders.js";
import { isObject } from "./util.js";

/**
 * A call checked against its tau (docs/spec/calls.md): a caller's, with its paths, on the client;
 * and an envelope from a client not trusted, on the backend.
 */

/** What a tau declares that a call is checked against. */
export interface Declared {
	readonly files: { readonly [name: string]: FileDeclaration };
	/** The args the schema declares in its properties. */
	readonly declaredArgs: ReadonlySet<string>;
	readonly validate: ValidateFunction | undefined;
}

/**
 * `call`, as a caller gives it, checked against the tau, each path resolved against `cwd`. Throws
 * TypeError, listing every problem.
 */
export function resolveCall(declared: Declared, call: unknown, cwd: string): ResolvedCall {
	const { files } = declared;
	const problems: string[] = [];
	const { files: given, args: givenArgs } = callParts(call, problems);
	const scope = scopeOf(files, declared.declaredArgs, givenArgs ?? {}, Object.keys(given ?? {}), problems);
	const resolved: Record<string, CallFile> = {};
	const paths: Record<string, string | readonly string[]> = {};
	if (given !== undefined)
		for (const name of fileNames(files, given, problems)) {
			if (scope.get(name) !== "file") continue;
			const file = resolveFile(name, files[name], given[name], cwd, (text) => void problems.push(`${name}: ${text}`));
			if (file === undefined) continue;
			resolved[name] = file.file;
			paths[name] = file.paths;
		}
	refuseUnfit(givenArgs === undefined ? problems : [...problems, ...argsProblems(givenArgs, scope, declared.validate)]);
	return { files: resolved, paths, args: givenArgs ?? {} };
}

/**
 * `envelope`, its form checked, checked against the tau, as one from a client not trusted must be:
 * each file's mode and kind, each extra file's name, and the args. Gives it with its files in the
 * order {@link resolveCall} gives, each with the kind tau.json declares where it gives none. Throws
 * TypeError, listing every problem.
 */
export function checkEnvelope(declared: Declared, envelope: Envelope): Envelope {
	const { files } = declared;
	const problems: string[] = [];
	const scope = scopeOf(files, declared.declaredArgs, envelope.args, Object.keys(envelope.files), problems);
	const checked: Record<string, CallFile> = {};
	for (const name of fileNames(files, envelope.files, problems)) {
		if (scope.get(name) !== "file") continue;
		const declaredFile = files[name];
		const { mode, kind, base } = envelope.files[name] as CallFile;
		const misfit = fitProblem(declaredFile, mode, kind);
		if (misfit !== undefined) {
			problems.push(`${name}: ${misfit}`);
			continue;
		}
		const known = kind ?? declaredFile?.kind;
		checked[name] = { mode, ...(known === undefined ? {} : { kind: known }), base };
	}
	refuseUnfit([...problems, ...argsProblems(envelope.args, scope, declared.validate)]);
	return { files: checked, args: envelope.args };
}

/** The scope a checked call's placeholders name in. */
export function scopeOfCall(declared: Declared, call: Envelope): Scope {
	return scopeOf(declared.files, declared.declaredArgs, call.args, Object.keys(call.files), []);
}

/** The call's files and args, each undefined, its problem recorded, when it is not an object. */
function callParts(call: unknown, problems: string[]): { files?: Record<string, unknown>; args?: { [name: string]: Json } } {
	if (!isObject(call)) {
		problems.push('the call must be an object, {"files": {...}, "args": {...}}');
		return {};
	}
	const { files = {}, args = {}, ...rest } = call;
	for (const key of Object.keys(rest)) problems.push(`the call has no ${JSON.stringify(key)}, only "files" and "args"`);
	if (!isObject(files)) problems.push("`files` must be an object, from each file's name to its path");
	if (!isObject(args)) problems.push("`args` must be an object");
	return { ...(isObject(files) ? { files } : {}), ...(isObject(args) ? { args: args as { [name: string]: Json } } : {}) };
}

/**
 * The names of the files `given`: those tau.json declares, in its order, then the extra files, in
 * the call's; a declared file not given is a problem.
 */
function fileNames(declared: { readonly [name: string]: FileDeclaration }, given: object, problems: string[]): string[] {
	const missing = Object.keys(declared).filter((name) => !Object.hasOwn(given, name));
	if (missing.length > 0) problems.push(`no path for ${missing.join(", ")}`);
	return [...Object.keys(declared).filter((name) => Object.hasOwn(given, name)), ...Object.keys(given).filter((name) => !Object.hasOwn(declared, name))];
}

/** Why a file of `mode` and `kind`, if given, does not fit what tau.json declares, if it declares it. */
function fitProblem(declared: FileDeclaration | undefined, mode: Mode, kind: Kind | undefined): string | undefined {
	if (declared === undefined) return undefined;
	if (mode !== declared.mode) return `is an \`${mode}\` in the call, and an \`${declared.mode}\` in the tau`;
	if (declared.kind !== undefined && kind !== undefined && kind !== declared.kind) return `holds ${article(kind)}, where ${article(declared.kind)} goes`;
	return undefined;
}

/** The problems of `args`: what tau.json's schema finds, and what their placeholders name but cannot, in `scope`. */
function argsProblems(args: { readonly [name: string]: Json }, scope: Scope, validate: ValidateFunction | undefined): string[] {
	const problems: string[] = [];
	if (validate === undefined) {
		if (Object.keys(args).length > 0) problems.push(`the tau takes no args, but is given ${Object.keys(args).join(", ")}`);
	} else if (!validate(args)) problems.push(...(validate.errors ?? []).map(schemaProblem));
	return [...problems, ...expansion(args, scope, () => "").problems];
}

/** Refuses a call with `problems`, listing each. */
function refuseUnfit(problems: readonly string[]): void {
	if (problems.length > 0) throw new TypeError(`the call does not fit the tau:\n  ${problems.join("\n  ")}`);
}

/**
 * The file `name`, as `given` in a call: a path; for an `in` whose kind is not `file`, a list of
 * paths whose base names differ; or the file with its mode, `{mode, path, kind}`, which an extra
 * file is given as. For a file tau.json declares, `declared`, the mode and kind given fit it.
 * Undefined once its problem is recorded.
 */
function resolveFile(
	name: string,
	declared: FileDeclaration | undefined,
	given: unknown,
	cwd: string,
	problem: (text: string) => void,
): { file: CallFile; paths: string | readonly string[] } | undefined {
	let paths = given;
	let mode = declared?.mode;
	let kind = declared?.kind;
	if (isObject(given)) {
		const stated = modedFile(given);
		if (stated === undefined) return void problem(`${JSON.stringify(given)} is neither a path, a list of paths, nor a file with its mode, {mode, path, kind}`);
		const misfit = fitProblem(declared, stated.mode, stated.kind);
		if (misfit !== undefined) return void problem(misfit);
		mode = stated.mode;
		kind = stated.kind ?? kind;
		paths = given.path;
	}
	if (mode === undefined) return void problem(`is no file the tau declares, so the call gives its mode, as {"mode": "in", "path": ${JSON.stringify(given)}}`);
	if (typeof paths === "string") {
		if (paths === "") return void problem("a path cannot be empty");
		const host = path.resolve(cwd, paths);
		return { file: { mode, ...(kind === undefined ? {} : { kind }), base: path.basename(host) }, paths: host };
	}
	if (Array.isArray(paths)) {
		if (mode !== "in" || kind === "file") return void problem("is given a list of paths, which only an `in` that may be a directory takes");
		const hosts: string[] = [];
		for (const item of paths) {
			if (typeof item !== "string" || item === "") return void problem(`${JSON.stringify(item)} is not a path`);
			hosts.push(path.resolve(cwd, item));
		}
		const bases = hosts.map((host) => path.basename(host));
		const twice = bases.filter((base, index) => bases.indexOf(base) !== index);
		if (twice.length > 0) return void problem(`is given several paths named ${[...new Set(twice)].join(", ")}, which one directory cannot hold`);
		return { file: { mode, kind: "dir", base: name }, paths: hosts };
	}
	return void problem(`${JSON.stringify(paths)} is not a path`);
}

/** A file given with its mode, `{mode, path, kind}`, its path checked later; or undefined when it is not one. */
function modedFile(value: Record<string, unknown>): { mode: Mode; kind?: Kind } | undefined {
	const { mode, path: paths, kind, ...rest } = value;
	if (Object.keys(rest).length > 0 || paths === undefined || !MODES.includes(mode as Mode)) return undefined;
	if (kind !== undefined && !KINDS.includes(kind as Kind)) return undefined;
	return { mode: mode as Mode, ...(kind === undefined ? {} : { kind: kind as Kind }) };
}

/** A problem JSON Schema found in the args, where it is in them. */
function schemaProblem({ instancePath, message, keyword, params }: ErrorObject): string {
	const at = instancePath.split("/").slice(1).map((step) => step.replaceAll("~1", "/").replaceAll("~0", "~"));
	const extra = keyword === "additionalProperties" ? `: ${String((params as { additionalProperty?: unknown }).additionalProperty)}` : "";
	return `${["args", ...at].join(".")}: ${message ?? "does not fit the schema"}${extra}`;
}

export function article(kind: Kind): string {
	return kind === "dir" ? "a directory" : "a file";
}
