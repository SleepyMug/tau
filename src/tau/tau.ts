import { existsSync, lstatSync, readFileSync, type Stats, statSync } from "node:fs";
import path from "node:path";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { linkProblems, valueLinkProblems } from "./links.js";

/** How the agent's programs import an API: `@api/<name>` (docs/spec/apis.md). */
export const API_SCOPE = "@api/";

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

/** A tau's prompt and what it takes: `PROMPT.md` and `tau.json`. */
export interface Tau {
	readonly dir: string;
	/** What the tau does, for whoever runs it. */
	readonly description: string | undefined;
	/** PROMPT.md as written. */
	readonly prompt: string;
	/** Each file, by name, in the order `tau.json` declares them. */
	readonly files: { readonly [name: string]: FileDeclaration };
	/** The schema of the args, a JSON Schema (draft 2020-12) of an object; undefined when the tau takes none. */
	readonly args: { readonly [keyword: string]: Json } | undefined;
	/**
	 * What the agent's programs import, as tau.json lists it: an API, as `@api/<name>`, or a package
	 * of the tau's own, by its name; undefined without the list, when they import every API.
	 * `loadExposed` checks it against the tau.
	 */
	readonly exposes: readonly string[] | undefined;
	/**
	 * The command a runtime runs, with `sh -c`, before the agent, which may do the run without it
	 * (docs/spec/init.md), as tau.json gives it; undefined without one. `expand` expands it.
	 */
	readonly init: string | undefined;
	/**
	 * The caller's side of a run: `call`, as a caller gives it (docs/spec/calls.md), checked against
	 * the tau, each path resolved against `cwd`. Throws TypeError, listing every problem.
	 */
	resolve(call: unknown, cwd: string): ResolvedCall;
	/**
	 * A call that reached a runtime as an archive's call has it (docs/spec/serialization.md), its
	 * form checked by `readCall`, checked against the tau, as one from a caller the runtime does
	 * not trust must be: each file's mode and kind, and the args. Throws TypeError, listing every
	 * problem.
	 */
	check(call: CheckedCall): CheckedCall;
	/**
	 * The agent's side of a run: the args, the prompt and init of `call`, a call `resolve` or
	 * `check` gave, their placeholders expanded (docs/spec/placeholders.md), with `places`, where
	 * the agent sees each file, by name, and `self`, where it sees the tau's own directory, by
	 * default `dir`. Throws TypeError for a file with no place, or args whose placeholders do not
	 * expand, which `resolve` and `check` refuse.
	 */
	expand(call: CheckedCall, places: { readonly [name: string]: string }, self?: string): Expanded;
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

/** A call, checked against its tau: what an archive's call holds (docs/spec/serialization.md). */
export interface CheckedCall {
	/** Each file, by name: those tau.json declares, in its order, then the extra files, in the call's. */
	readonly files: { readonly [name: string]: CallFile };
	/** The args, as the caller gave them, their placeholders not yet expanded. */
	readonly args: { readonly [name: string]: Json };
}

/** A call as a caller gives it, checked, with the caller's paths. */
export interface ResolvedCall extends CheckedCall {
	/** Each file's path, by name, absolute, or, for an `in` given a list, each of its paths. */
	readonly paths: { readonly [name: string]: string | readonly string[] };
}

/** What the agent is given, once each file has its place. */
export interface Expanded {
	/** PROMPT.md, its placeholders expanded. */
	readonly prompt: string;
	/** The args, their placeholders expanded: what the agent's programs are given. */
	readonly args: { readonly [name: string]: Json };
	/** The tau's init, its placeholders expanded, each one word for `sh`; undefined without one. */
	readonly init: string | undefined;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** What `exposes` lists: a package's name, scoped or not, as programs import it. */
const PACKAGE = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/u;
/** What `${self}` names: the tau's own directory, so no file and no arg has this name. */
const SELF = "self";
const MODES: readonly Mode[] = ["in", "out", "inout"];
const KINDS: readonly Kind[] = ["file", "dir"];
/** `$`s before a `{`: one opens a placeholder; more are text, with one `$` less. */
const OPENING = /(\$+)\{/gu;
/** What follows a placeholder's `${`: its names, and the `}` that closes it on its line. */
const INSIDE = /([^}\n]*)(\}?)/uy;

/**
 * The tau at `dir`: its PROMPT.md, and its tau.json if it has one (without it, the tau takes no
 * files and no args). Throws, naming the file and the reason, when tau.json breaks the spec or the
 * prompt names what it cannot, and, listing every one, for a symlink that breaks the spec in what a
 * runtime reads, node_modules/ included when the tau exposes a package of its own. APIs are loaded
 * separately, with `loadApis`, and what the tau exposes is checked against them with `loadExposed`.
 */
export function loadTau(dir: string): Tau {
	const absolute = path.resolve(dir);
	const promptFile = path.join(absolute, "PROMPT.md");
	if (!existsSync(promptFile)) throw new Error(`${absolute}: not a tau (no PROMPT.md)`);
	const metadataFile = path.join(absolute, "tau.json");
	const metadata = existsSync(metadataFile) ? readMetadata(metadataFile) : undefined;
	const { description, files = {}, args, validate, exposes, init } = metadata ?? {};
	const declaredArgs = new Set(Object.keys(isObject(args?.properties) ? args.properties : {}));
	const prompt = readFileSync(promptFile, "utf8");
	let template: Template;
	try {
		template = parseTemplate(
			prompt,
			(inside) =>
				placeholderProblem(
					inside,
					(name) => Object.hasOwn(files, name),
					(name) => declaredArgs.has(name),
					"an arg the schema declares in its properties",
				),
			(line) => `line ${line}`,
		);
	} catch (error) {
		throw new Error(`${promptFile}: ${messageOf(error)}`);
	}
	let command: Template | undefined;
	try {
		command = init === undefined ? undefined : parseTemplate(init, (inside) => initProblem(inside, files), () => "`init`");
	} catch (error) {
		throw new Error(`${metadataFile}: ${messageOf(error)}`);
	}
	const problems = linkProblems(absolute, exposes?.some((specifier) => !specifier.startsWith(API_SCOPE)) ?? false);
	if (problems.length > 0) throw new Error(`${absolute}: breaks the spec:\n  ${problems.join("\n  ")}`);

	return {
		dir: absolute,
		description,
		prompt,
		files,
		args,
		exposes,
		init,
		resolve(call, cwd) {
			const problems: string[] = [];
			const { files: given, args: givenArgs } = callParts(call, problems);
			const resolved: Record<string, CallFile> = {};
			const paths: Record<string, string | readonly string[]> = {};
			if (given !== undefined)
				for (const name of fileNames(files, given, problems)) {
					const problem = (text: string): void => void problems.push(`${name}: ${text}`);
					if (!Object.hasOwn(files, name) && extraProblem(name, declaredArgs, givenArgs, problem)) continue;
					const file = resolveFile(name, files[name], given[name], cwd, problem);
					if (file === undefined) continue;
					resolved[name] = file.file;
					paths[name] = file.paths;
				}
			if (givenArgs !== undefined)
				problems.push(
					...argsProblems(givenArgs, files, validate),
					...argPlaceholderProblems(givenArgs, [...Object.keys(files), ...Object.keys(given ?? {})], declaredArgs),
				);
			if (problems.length > 0) throw new TypeError(`the call does not fit the tau:\n  ${problems.join("\n  ")}`);
			return { files: resolved, paths, args: givenArgs ?? {} };
		},
		check(call) {
			const problems: string[] = [];
			const checked: Record<string, CallFile> = {};
			for (const name of fileNames(files, call.files, problems)) {
				const problem = (text: string): void => void problems.push(`${name}: ${text}`);
				const declared = files[name];
				if (declared === undefined && extraProblem(name, declaredArgs, call.args, problem)) continue;
				const { mode, kind, base } = call.files[name] as CallFile;
				const misfit = fitProblem(declared, mode, kind);
				if (misfit !== undefined) {
					problem(misfit);
					continue;
				}
				const known = kind ?? declared?.kind;
				checked[name] = { mode, ...(known === undefined ? {} : { kind: known }), base };
			}
			problems.push(
				...argsProblems(call.args, files, validate),
				...argPlaceholderProblems(call.args, [...Object.keys(files), ...Object.keys(call.files)], declaredArgs),
			);
			if (problems.length > 0) throw new TypeError(`the call does not fit the tau:\n  ${problems.join("\n  ")}`);
			return { files: checked, args: call.args };
		},
		expand(call, places, self = absolute) {
			const placeOf = new Map<string, string>();
			for (const name of Object.keys(call.files)) {
				const place = places[name];
				if (typeof place !== "string") throw new TypeError(`${name}: has no place`);
				placeOf.set(name, place);
			}
			placeOf.set(SELF, self);
			const { args: expandedArgs, problems } = expandArgs(call.args, placeOf, declaredArgs);
			if (problems.length > 0) throw new TypeError(`the args do not expand:\n  ${problems.join("\n  ")}`);
			return {
				prompt: expand(template, (names) => {
					const place = names.length === 1 ? placeOf.get(names[0] as string) : undefined;
					if (place !== undefined) return place;
					const found = lookup(expandedArgs, names);
					return found === undefined ? "" : textOf(found);
				}),
				args: expandedArgs,
				init: command === undefined ? undefined : expand(command, ([first = ""]) => shellWord(placeOf.get(first) as string)),
			};
		},
	};
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

/**
 * Whether an extra file's name is one no file can have: not a name, `self`, or an arg's, which the
 * schema declares, or the call gives; its problem recorded.
 */
function extraProblem(name: string, declaredArgs: ReadonlySet<string>, args: object | undefined, problem: (text: string) => void): boolean {
	if (!NAME.test(name)) problem(`is not a file's name, which matches ${NAME.source}`);
	else if (name === SELF) problem("names the tau's own directory, which no file does");
	else if (declaredArgs.has(name) || (args !== undefined && Object.hasOwn(args, name))) problem("is an arg's name, which no file has");
	else return false;
	return true;
}

/** Why a file of `mode` and `kind`, if given, does not fit what tau.json declares, if it declares it. */
function fitProblem(declared: FileDeclaration | undefined, mode: Mode, kind: Kind | undefined): string | undefined {
	if (declared === undefined) return undefined;
	if (mode !== declared.mode) return `is an \`${mode}\` in the call, and an \`${declared.mode}\` in the tau`;
	if (declared.kind !== undefined && kind !== undefined && kind !== declared.kind) return `holds ${article(kind)}, where ${article(declared.kind)} goes`;
	return undefined;
}

/** The problems of `args`, which tau.json's schema checks, its names neither a file's nor `self`. */
function argsProblems(args: { readonly [name: string]: Json }, files: { readonly [name: string]: FileDeclaration }, validate: ValidateFunction | undefined): string[] {
	const problems: string[] = [];
	for (const name of Object.keys(args)) {
		if (Object.hasOwn(files, name)) problems.push(`args.${name}: is a file's name, which no arg has`);
		else if (name === SELF) problems.push(`args.${SELF}: names the tau's own directory, which no arg does`);
	}
	if (validate === undefined) {
		if (Object.keys(args).length > 0) problems.push(`the tau takes no args, but is given ${Object.keys(args).join(", ")}`);
	} else if (!validate(args)) problems.push(...(validate.errors ?? []).map(schemaProblem));
	return problems;
}

/**
 * The file `name`, as `given` in a call (docs/spec/calls.md): a path; for an `in` whose kind is
 * not `file`, a list of paths whose base names differ; or the file with its mode, `{mode, path,
 * kind}`, which an extra file is given as. For a file tau.json declares, `declared`, the mode and
 * kind given fit it. Undefined once its problem is recorded.
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

/** A file given with its mode (docs/spec/calls.md), `{mode, path, kind}`, its path checked later; or undefined when it is not one. */
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

/** Where a value lies in the args: a property's name, or an item's index. */
type Step = string | number;

/**
 * The args, each string's placeholders expanded (docs/spec/placeholders.md): `${self}` and
 * `${name}` naming a file become the place `places` gives, and `${name}` naming an arg, or
 * `${name.field}` what lies in one, the expansion of its value, a string as it is and anything
 * else as JSON, and nothing for what the args lack. Each placeholder `places` and the args do not
 * name, and each value that names itself, through as many others as it does, is a problem, and
 * expands to nothing.
 */
function expandArgs(
	args: { readonly [name: string]: Json },
	places: ReadonlyMap<string, string>,
	declaredArgs: ReadonlySet<string>,
): { args: { readonly [name: string]: Json }; problems: string[] } {
	const problems: string[] = [];
	const done = new Map<string, string>();
	const expanding: { key: string; at: string }[] = [];
	const problemOf = (inside: string) =>
		placeholderProblem(
			inside,
			(name) => places.has(name),
			(name) => declaredArgs.has(name) || Object.hasOwn(args, name),
			"an arg",
		);
	const where = (at: readonly Step[]): string => ["args", ...at].join(".");
	const value = (item: Json, at: readonly Step[]): Json => {
		if (typeof item === "string") return string(item, at);
		if (Array.isArray(item)) return item.map((entry, index) => value(entry, [...at, index]));
		if (isObject(item)) return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, value(entry as Json, [...at, key])]));
		return item;
	};
	const string = (text: string, at: readonly Step[]): string => {
		const key = JSON.stringify(at);
		const known = done.get(key);
		if (known !== undefined) return known;
		const cycle = expanding.findIndex((entry) => entry.key === key);
		if (cycle !== -1) {
			const through = expanding.slice(cycle + 1).map((entry) => entry.at);
			problems.push(`${where(at)}: names itself${through.length === 0 ? "" : `, through ${through.join(", ")}`}`);
			return "";
		}
		expanding.push({ key, at: where(at) });
		let expanded = "";
		try {
			expanded = expand(parseTemplate(text, problemOf, () => where(at)), (names) => {
				const place = names.length === 1 ? places.get(names[0] as string) : undefined;
				if (place !== undefined) return place;
				const found = lookup(args, names);
				return found === undefined ? "" : textOf(value(found, names));
			});
		} catch (error) {
			problems.push(messageOf(error));
		}
		expanding.pop();
		done.set(key, expanded);
		return expanded;
	};
	return { args: value(args, []) as { readonly [name: string]: Json }, problems };
}

/** The problems of the placeholders in `args`, given the files `names`, before any has a place. */
function argPlaceholderProblems(args: { readonly [name: string]: Json }, names: Iterable<string>, declaredArgs: ReadonlySet<string>): string[] {
	return expandArgs(args, new Map([SELF, ...names].map((name) => [name, ""])), declaredArgs).problems;
}

/** What `names` finds in the args: through as many objects as it lies in; undefined for what they lack. */
function lookup(args: { readonly [name: string]: Json }, names: readonly string[]): Json | undefined {
	let value: Json | undefined = args;
	for (const name of names) value = isObject(value) && Object.hasOwn(value, name) ? (value[name] as Json) : undefined;
	return value;
}

/** A value as a placeholder becomes it: a string as it is, anything else as JSON. */
function textOf(value: Json): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

function article(kind: Kind): string {
	return kind === "dir" ? "a directory" : "a file";
}

/**
 * Before a run: whether the caller's paths fit the call (docs/spec/paths.md). Each `in` and `inout`
 * path is a file or a directory as its kind says, and each of a list's either, and holds what a
 * path may (see `valueProblems`); each `out` path lies in a directory that exists, and is not
 * there yet, or is of its kind, symlinks followed. Paths may overlap. Throws, listing every problem.
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
 * When the run ends, if the agent returned normally: whether it left what the call asks. What is at
 * each `out` and `inout` file's place, in `places`, is a file or a directory as its kind says, and
 * holds what a path may (see `valueProblems`). A runtime whose agent works elsewhere, such as in a
 * container, gives where it finds each place. Throws, listing every problem.
 */
export function checkOutputs(call: Pick<CheckedCall, "files">, places: { readonly [name: string]: string }): void {
	const problems: string[] = [];
	for (const [name, { mode, kind }] of Object.entries(call.files)) {
		if (mode === "in") continue;
		const place = places[name];
		if (place === undefined) problems.push(`${name}: has no place`);
		else problems.push(...valueProblems(place, kind).map((problem) => `${name}: ${problem}`));
	}
	if (problems.length > 0) throw new Error(`the run did not leave what the call asks:\n  ${problems.join("\n  ")}`);
}

function readMetadata(file: string): {
	description: string | undefined;
	files: { [name: string]: FileDeclaration };
	args: { [keyword: string]: Json } | undefined;
	validate: ValidateFunction | undefined;
	exposes: string[] | undefined;
	init: string | undefined;
} {
	try {
		let json: unknown;
		try {
			json = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			throw new TypeError(`is not JSON: ${messageOf(error)}`);
		}
		if (!isObject(json)) throw new TypeError("must be an object");
		const { description, files = {}, args, exposes, init, ...rest } = json;
		refuseKeys(rest, "tau.json");
		if (description !== undefined && typeof description !== "string")
			throw new TypeError("`description` must be a string");
		if (!isObject(files)) throw new TypeError("`files` must be an object, from each file's name to what it is");
		if (exposes !== undefined && !Array.isArray(exposes)) throw new TypeError("`exposes` must be an array");
		if (init !== undefined && (typeof init !== "string" || init.trim() === ""))
			throw new TypeError("`init` must be a command, a string that is not blank");

		const declared: { [name: string]: FileDeclaration } = {};
		for (const [name, value] of Object.entries(files)) {
			checkName(name, "`files`", "a file");
			declared[name] = readDeclaration(value, `\`files\`: ${name}`);
		}
		const validate = args === undefined ? undefined : readSchema(args, declared);

		const exposed = new Set<string>();
		for (const specifier of exposes ?? []) {
			if (typeof specifier !== "string" || !PACKAGE.test(specifier))
				throw new TypeError(`\`exposes\`: ${JSON.stringify(specifier)} is not a package's name`);
			if (exposed.has(specifier)) throw new TypeError(`\`exposes\` lists ${specifier} twice`);
			exposed.add(specifier);
		}

		return {
			description,
			files: declared,
			args: args as { [keyword: string]: Json } | undefined,
			validate,
			exposes: exposes === undefined ? undefined : [...exposed],
			init,
		};
	} catch (error) {
		throw new Error(`${file}: ${messageOf(error)}`);
	}
}

/** Refuses a name that a file, or an arg the schema declares, cannot have. */
function checkName(name: string, where: string, what: string): void {
	if (!NAME.test(name)) throw new TypeError(`${where}: ${JSON.stringify(name)} is not ${what}'s name, which matches ${NAME.source}`);
	if (name === SELF) throw new TypeError(`${where}: \`${SELF}\` names the tau's own directory, so ${what} cannot have that name`);
}

/** A file as tau.json declares it at `at`. */
function readDeclaration(value: unknown, at: string): FileDeclaration {
	if (!isObject(value)) throw new TypeError(`${at} must be an object, with its \`mode\` and \`description\``);
	const { mode, kind, description, ...rest } = value;
	refuseKeys(rest, at);
	if (mode === undefined) throw new TypeError(`${at}: needs a \`mode\`, one of ${MODES.join(", ")}`);
	if (typeof mode !== "string" || !(MODES as readonly string[]).includes(mode))
		throw new TypeError(`${at}: \`mode\` ${JSON.stringify(mode)} is not one of ${MODES.join(", ")}`);
	if (kind !== undefined && (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)))
		throw new TypeError(`${at}: \`kind\` ${JSON.stringify(kind)} is not one of ${KINDS.join(", ")}`);
	if (typeof description !== "string" || description.trim() === "")
		throw new TypeError(`${at}: needs a \`description\`, saying what it is`);
	return { mode: mode as Mode, ...(kind === undefined ? {} : { kind: kind as Kind }), description };
}

/**
 * `args` as tau.json declares it: a JSON Schema, draft 2020-12, of an object, that JSON Schema's
 * meta-schema takes, with no keyword the draft does not define, and every `$ref` resolved in it;
 * its top-level properties named as files are, and none a file's. Gives what checks args against it.
 */
function readSchema(args: unknown, files: { readonly [name: string]: FileDeclaration }): ValidateFunction {
	if (!isObject(args) || args.type !== "object")
		throw new TypeError('`args` must be a JSON Schema of an object, whose `type` is "object"');
	if (args.properties !== undefined && isObject(args.properties))
		for (const name of Object.keys(args.properties)) {
			checkName(name, "`args`", "an arg");
			if (Object.hasOwn(files, name)) throw new TypeError(`\`args\`: ${name} is a file's name, which no arg has`);
		}
	// Formats say what a string is, and are not checked, as draft 2020-12 has it by default.
	const ajv = new Ajv2020({ allErrors: true, strictSchema: true, strictTypes: false, strictTuples: false, strictRequired: false, validateFormats: false });
	try {
		return ajv.compile(args);
	} catch (error) {
		throw new TypeError(`\`args\` is not a JSON Schema the spec takes: ${messageOf(error)}`);
	}
}

/** A prompt, an init, or a string of the args, as text around placeholders: `text` has one more entry than `names`, each a path of names. */
interface Template {
	readonly text: readonly string[];
	readonly names: readonly (readonly string[])[];
}

/**
 * `source` as a template (docs/spec/placeholders.md), each placeholder checked by `problemOf`,
 * and named in what it throws as `where` says from its line.
 */
function parseTemplate(
	source: string,
	problemOf: (inside: string) => string | undefined,
	where: (line: number) => string,
): Template {
	const text: string[] = [];
	const names: string[][] = [];
	let chunk = "";
	let last = 0;
	const opening = new RegExp(OPENING);
	for (let match = opening.exec(source); match !== null; match = opening.exec(source)) {
		const dollars = match[1] as string;
		chunk += source.slice(last, match.index);
		last = opening.lastIndex;
		if (dollars.length > 1) {
			chunk += `${dollars.slice(1)}{`;
			continue;
		}
		INSIDE.lastIndex = last;
		const [rest, inside = "", closed] = INSIDE.exec(source) as RegExpExecArray;
		const placeholder = `\${${rest}`;
		const at = where(source.slice(0, match.index).split("\n").length);
		if (closed === "") throw new TypeError(`${at}: ${placeholder} is not closed; write $\${ for a literal \${`);
		const problem = problemOf(inside);
		if (problem !== undefined) throw new TypeError(`${at}: ${placeholder} ${problem}`);
		last += rest.length;
		opening.lastIndex = last;
		text.push(chunk);
		names.push(inside.split("."));
		chunk = "";
	}
	text.push(chunk + source.slice(last));
	return { text, names };
}

/**
 * Why `${inside}` cannot be in a prompt, or in the args, if it cannot: it names `self`, a file, or
 * an arg, `isFile` and `isArg` say which, or what lies in an arg; `anArg` says which args it may name.
 */
function placeholderProblem(inside: string, isFile: (name: string) => boolean, isArg: (name: string) => boolean, anArg: string): string | undefined {
	const [first = "", ...rest] = inside.split(".");
	if (inside.split(".").some((name) => name === "")) return "names nothing between its dots; write $\${ for a literal \${";
	if (first === SELF || isFile(first))
		return rest.length === 0 ? undefined : `names what lies in ${first === SELF ? "the tau's own directory" : `the file ${first}`}, which is a path`;
	if (isArg(first)) return undefined;
	return `names neither \${${SELF}}, a file, nor ${anArg}; write $\${ for a literal \${`;
}

/** Why `${inside}` cannot be in an init, if it cannot: it names neither `self` nor a file. */
function initProblem(inside: string, files: { readonly [name: string]: FileDeclaration }): string | undefined {
	if (inside === SELF || Object.hasOwn(files, inside)) return undefined;
	return `names neither \${${SELF}} nor a file: init reads the args through the tau API; write $\${ for a literal \${`;
}

/** A path as one word for `sh`: as it is when nothing in it is special, else in single quotes. */
function shellWord(text: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

function expand(template: Template, valueOf: (names: readonly string[]) => string): string {
	return template.names.reduce((text, names, index) => text + valueOf(names) + template.text[index + 1], template.text[0] as string);
}

const MISSING = "does not exist";

/**
 * Why `file`, an `in` or `inout` file's path, or what the agent left at an `out` or `inout` one's
 * place, is not of `kind`, either when undefined (docs/spec/paths.md): it is not a symlink, and
 * each symlink in a directory is relative, and leads, through any further symlinks, all relative,
 * to something that exists in it.
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

function refuseKeys(rest: Record<string, unknown>, where: string): void {
	const [key] = Object.keys(rest);
	if (key !== undefined) throw new TypeError(`${where}: unknown key ${JSON.stringify(key)}`);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
