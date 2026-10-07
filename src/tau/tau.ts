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
	 * (docs/spec/init.md), as tau.json gives it; undefined without one. `bind` expands it.
	 */
	readonly init: string | undefined;
	/**
	 * One run, for `call` (docs/spec/calls.md): a path for each file, and for each extra file, with
	 * its mode, resolved against `caller.cwd`, and given its place by `place`, called for each file
	 * in the order tau.json declares them, then for each extra file in the call's order, by default
	 * the path itself; the args checked against the schema; and the
	 * placeholders of the args, the prompt and init expanded (docs/spec/placeholders.md), with
	 * `${self}` where the agent sees the tau's own directory, `self`, by default `dir`. A file may
	 * also be as an archive's call has it (docs/spec/serialization.md), naming its content in place
	 * of a path, whose kind is checked, and which `place` then places. Throws TypeError, listing
	 * every problem.
	 */
	bind(call: unknown, caller: Caller, place?: (file: Placing) => string, self?: string): Run;
}

/** Who runs the tau. */
export interface Caller {
	/** What relative paths in the call are resolved against. */
	readonly cwd: string;
}

/** A file of a call, as its runtime is asked to place it. */
export interface Placing {
	/** Its name, as tau.json declares it, or the call gives it, for an extra file. */
	readonly name: string;
	readonly mode: Mode;
	/**
	 * What it is: as tau.json declares it, or the call gives it; or else `dir` for an `in` given a
	 * list of paths, or what an archive's call says its content is; undefined while it may be
	 * either.
	 */
	readonly kind?: Kind;
	/** The base name its place keeps: its path's, or its name, for an `in` given a list of paths. */
	readonly base: string;
	/**
	 * The caller's path, absolute, or, for an `in` given a list, each of its paths; none for an
	 * archive's call, which names the file's content instead.
	 */
	readonly host?: string | readonly string[];
}

/** A file of a call, placed. */
export interface BoundFile extends Placing {
	/** Where the agent sees it, absolute. */
	readonly view: string;
}

/** What a runtime needs to set up one run: computed, not done. */
export interface Run {
	/** PROMPT.md, its placeholders expanded. */
	readonly prompt: string;
	/** Each file, placed, in the order tau.json declares them, then each extra file, in the call's order. */
	readonly files: readonly BoundFile[];
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
/** In the prompt and init: `$${` is a literal `${`; any other `${` opens a placeholder. */
const PLACEHOLDER = /\$\$\{|\$\{([^}\n]*)(\}?)/gu;
/** In the args: `${name}`, after any `$`s, each of which escapes it once. */
const ARG_PLACEHOLDER = /(\$*)\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;

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
		template = parseTemplate(prompt, (inside) => placeholderProblem(inside, files, declaredArgs), (line) => `line ${line}`);
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
		bind(call, caller, place = placeAtHost, self = absolute) {
			const problems: string[] = [];
			const { files: given = {}, args: givenArgs = {}, ...rest } = isObject(call) ? call : {};
			if (!isObject(call)) problems.push('the call must be an object, {"files": {...}, "args": {...}}');
			for (const key of Object.keys(rest)) problems.push(`the call has no ${JSON.stringify(key)}, only "files" and "args"`);
			const placings: Placing[] = [];
			if (!isObject(given)) problems.push("`files` must be an object, from each file's name to its path");
			else {
				const missing = Object.keys(files).filter((name) => !Object.hasOwn(given, name));
				if (missing.length > 0) problems.push(`no path for ${missing.join(", ")}`);
				const argNames = new Set([...declaredArgs, ...(isObject(givenArgs) ? Object.keys(givenArgs) : [])]);
				const extras = Object.keys(given).filter((name) => !Object.hasOwn(files, name));
				for (const name of [...Object.keys(files).filter((name) => Object.hasOwn(given, name)), ...extras]) {
					const problem = (text: string): void => void problems.push(`${name}: ${text}`);
					const declared = files[name];
					if (declared === undefined) {
						if (!NAME.test(name)) {
							problem(`is not a file's name, which matches ${NAME.source}`);
							continue;
						}
						if (name === SELF) {
							problem("names the tau's own directory, which no file does");
							continue;
						}
						if (argNames.has(name)) {
							problem("is an arg's name, which no file has");
							continue;
						}
					}
					const placing = placingOf(name, declared, given[name], caller, problem);
					if (placing !== undefined) placings.push(placing);
				}
			}
			if (!isObject(givenArgs)) problems.push("`args` must be an object");
			else {
				for (const name of Object.keys(givenArgs)) {
					if (Object.hasOwn(files, name)) problems.push(`args.${name}: is a file's name, which no arg has`);
					else if (name === SELF) problems.push(`args.${SELF}: names the tau's own directory, which no arg does`);
				}
				if (validate === undefined) {
					if (Object.keys(givenArgs).length > 0) problems.push(`the tau takes no args, but is given ${Object.keys(givenArgs).join(", ")}`);
				} else if (!validate(givenArgs)) problems.push(...(validate.errors ?? []).map(schemaProblem));
			}
			if (problems.length > 0) throw new TypeError(`the call does not fit the tau:\n  ${problems.join("\n  ")}`);
			const bound = placings.map((placing) => ({ ...placing, view: place(placing) }));
			const places = new Map([...bound.map(({ name, view }) => [name, view] as const), [SELF, self] as const]);
			const expandedArgs = expandArgs(givenArgs as { readonly [name: string]: Json }, places) as { readonly [name: string]: Json };
			return {
				prompt: expand(template, (names) => {
					const [first = ""] = names;
					const view = names.length === 1 ? places.get(first) : undefined;
					return view ?? argText(expandedArgs, names);
				}),
				files: bound,
				args: expandedArgs,
				init: command === undefined ? undefined : expand(command, ([first = ""]) => shellWord(places.get(first) as string)),
			};
		},
	};
}

/** Where a file is by default: the caller's path itself, which an archive's call has not. */
function placeAtHost({ name, host }: Placing): string {
	if (host === undefined) throw new TypeError(`${name}: an archive's call names no path of the caller's, so the runtime places it`);
	if (typeof host !== "string") throw new TypeError(`${name}: is given several paths, so the runtime places it, as a directory holding each`);
	return host;
}

/**
 * The file `name`, as `given` in a call: a path; for an `in` whose kind is not `file`, a list of
 * paths whose base names differ; the file with its mode, `{mode, path, kind}`; or an archive's file
 * (docs/spec/serialization.md), `{mode, base, kind}`. For a file tau.json declares, `declared`,
 * the mode and kind given fit the declaration; an extra file is given with its mode. Undefined once
 * its problem is recorded.
 */
function placingOf(name: string, declared: FileDeclaration | undefined, given: unknown, caller: Caller, problem: (text: string) => void): Placing | undefined {
	let paths = given;
	let mode = declared?.mode;
	let kind = declared?.kind;
	if (isObject(given)) {
		const archived = archivedFile(given);
		const stated = archived ?? modedFile(given);
		if (stated === undefined)
			return void problem(`${JSON.stringify(given)} is neither a path, a list of paths, a file with its mode, {mode, path, kind}, nor an archive's file, {mode, base, kind}`);
		if (declared !== undefined && stated.mode !== declared.mode) return void problem(`is an \`${stated.mode}\` in the call, and an \`${declared.mode}\` in the tau`);
		if (declared?.kind !== undefined && stated.kind !== undefined && stated.kind !== declared.kind)
			return void problem(`holds ${article(stated.kind)}, where ${article(declared.kind)} goes`);
		mode = stated.mode;
		kind = stated.kind ?? kind;
		if (archived !== undefined) return { name, mode, ...(kind === undefined ? {} : { kind }), base: archived.base };
		paths = given.path;
	}
	if (mode === undefined) return void problem(`is no file the tau declares, so the call gives its mode, as {"mode": "in", "path": ${JSON.stringify(given)}}`);
	if (typeof paths === "string") {
		if (paths === "") return void problem("a path cannot be empty");
		const host = path.resolve(caller.cwd, paths);
		return { name, mode, ...(kind === undefined ? {} : { kind }), base: path.basename(host), host };
	}
	if (Array.isArray(paths)) {
		if (mode !== "in" || kind === "file") return void problem("is given a list of paths, which only an `in` that may be a directory takes");
		const hosts: string[] = [];
		for (const item of paths) {
			if (typeof item !== "string" || item === "") return void problem(`${JSON.stringify(item)} is not a path`);
			hosts.push(path.resolve(caller.cwd, item));
		}
		const bases = hosts.map((host) => path.basename(host));
		const twice = bases.filter((base, index) => bases.indexOf(base) !== index);
		if (twice.length > 0) return void problem(`is given several paths named ${[...new Set(twice)].join(", ")}, which one directory cannot hold`);
		return { name, mode, kind: "dir", base: name, host: hosts };
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

/**
 * A file as an archive's call has it (docs/spec/serialization.md): `{mode, base, kind}` for an
 * `in` or an `inout`, `{mode, base}` for an `out`; or undefined when it is not one.
 */
function archivedFile(value: Record<string, unknown>): { mode: Mode; base: string; kind?: Kind } | undefined {
	const { mode, base, kind, ...rest } = value;
	if (Object.keys(rest).length > 0 || !MODES.includes(mode as Mode) || !isBase(base)) return undefined;
	if (mode === "out") return kind === undefined ? { mode, base } : undefined;
	return KINDS.includes(kind as Kind) ? { mode: mode as Mode, base, kind: kind as Kind } : undefined;
}

/** A base name: not empty, not `.` or `..`, with no `/` and no NUL. */
function isBase(value: unknown): value is string {
	return typeof value === "string" && value !== "" && value !== "." && value !== ".." && !/[/\0]/u.test(value);
}

/** A problem JSON Schema found in the args, where it is in them. */
function schemaProblem({ instancePath, message, keyword, params }: ErrorObject): string {
	const at = instancePath.split("/").slice(1).map((step) => step.replaceAll("~1", "/").replaceAll("~0", "~"));
	const extra = keyword === "additionalProperties" ? `: ${String((params as { additionalProperty?: unknown }).additionalProperty)}` : "";
	return `${["args", ...at].join(".")}: ${message ?? "does not fit the schema"}${extra}`;
}

/**
 * `value`, each string's placeholders expanded (docs/spec/placeholders.md): `${name}`, where
 * `places` has `name`, becomes its place; after one or more `$`, `${name}` loses one, whatever the
 * name; anything else stays.
 */
function expandArgs(value: Json, places: ReadonlyMap<string, string>): Json {
	if (typeof value === "string")
		return value.replace(ARG_PLACEHOLDER, (whole, escapes: string, name: string) => {
			if (escapes !== "") return `${escapes.slice(1)}\${${name}}`;
			return places.get(name) ?? whole;
		});
	if (Array.isArray(value)) return value.map((item) => expandArgs(item, places));
	if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandArgs(item as Json, places)]));
	return value;
}

/** What `names` finds in the args, as the prompt has it: a string as it is, anything else as JSON, and nothing for what they lack. */
function argText(args: { readonly [name: string]: Json }, names: readonly string[]): string {
	let value: Json | undefined = args;
	for (const name of names) value = isObject(value) && Object.hasOwn(value, name) ? (value[name] as Json) : undefined;
	if (value === undefined) return "";
	return typeof value === "string" ? value : JSON.stringify(value);
}

function article(kind: Kind): string {
	return kind === "dir" ? "a directory" : "a file";
}

/**
 * Before a run: whether the files' paths fit the tau (docs/spec/paths.md). Each `in` and `inout`
 * path is a file or a directory as its kind says, and each of a list's either, and holds what a
 * path may (see `valueProblems`); each `out` path lies in a directory that exists, and is not
 * there yet, or is of its kind, symlinks followed. Paths may overlap. Throws, listing every problem.
 */
export function checkInputs(run: Run): void {
	const problems: string[] = [];
	for (const { name, mode, kind, host } of run.files) {
		// An archive's file names content, which its reader checked.
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
 * When the run ends, if the agent returned normally: whether it left what the tau declares. What
 * `locate` finds of each `out` and `inout` file is a file or a directory as its kind says, and
 * holds what a path may (see `valueProblems`): by default its view, which is right for a runtime
 * whose agent works on the runtime's own machine; one whose agent works elsewhere, such as in a
 * container, checks where it can. Throws, listing every problem.
 */
export function checkOutputs(run: Pick<Run, "files">, locate: (file: BoundFile) => string = ({ view }) => view): void {
	const problems: string[] = [];
	for (const file of run.files) {
		if (file.mode === "in") continue;
		problems.push(...valueProblems(locate(file), file.kind).map((problem) => `${file.name}: ${problem}`));
	}
	if (problems.length > 0)
		throw new Error(`the run did not leave what the tau declares:\n  ${problems.join("\n  ")}`);
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

/** A prompt, or an init, as text around placeholders: `text` has one more entry than `names`, each a path of names. */
interface Template {
	readonly text: readonly string[];
	readonly names: readonly (readonly string[])[];
}

/**
 * `prompt` as a template, each placeholder checked by `problemOf`, and named in what it throws as
 * `where` says from its line.
 */
function parseTemplate(
	prompt: string,
	problemOf: (inside: string) => string | undefined,
	where: (line: number) => string,
): Template {
	const text: string[] = [];
	const names: string[][] = [];
	let chunk = "";
	let last = 0;
	for (const match of prompt.matchAll(PLACEHOLDER)) {
		chunk += prompt.slice(last, match.index);
		last = match.index + match[0].length;
		if (match[0] === "$${") {
			chunk += "${";
			continue;
		}
		const [placeholder, inside = "", closed] = match;
		const at = where(prompt.slice(0, match.index).split("\n").length);
		if (closed === "") throw new TypeError(`${at}: ${placeholder} is not closed; write $\${ for a literal \${`);
		const problem = problemOf(inside);
		if (problem !== undefined) throw new TypeError(`${at}: ${placeholder} ${problem}`);
		text.push(chunk);
		names.push(inside.split("."));
		chunk = "";
	}
	text.push(chunk + prompt.slice(last));
	return { text, names };
}

/**
 * Why `${inside}` cannot be in a prompt, if it cannot: it names `self`, a file, or an arg the
 * schema declares in its top-level properties, or what lies in one of those args.
 */
function placeholderProblem(inside: string, files: { readonly [name: string]: FileDeclaration }, args: ReadonlySet<string>): string | undefined {
	const [first = "", ...rest] = inside.split(".");
	if (inside.split(".").some((name) => name === "")) return "names nothing between its dots; write $\${ for a literal \${";
	if (first === SELF || Object.hasOwn(files, first))
		return rest.length === 0 ? undefined : `names what lies in ${first === SELF ? "the tau's own directory" : `the file ${first}`}, which is a path`;
	if (args.has(first)) return undefined;
	return `names neither \${${SELF}}, a file, nor an arg the schema declares in its properties; write $\${ for a literal \${`;
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
