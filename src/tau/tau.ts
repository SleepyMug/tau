import { existsSync, lstatSync, readFileSync, type Stats, statSync } from "node:fs";
import path from "node:path";
import { linkProblems, valueLinkProblems } from "./links.js";

/** How the agent's programs import an API: `@api/<name>` (docs/spec/apis.md). */
export const API_SCOPE = "@api/";

/**
 * What the agent does with a handle's file or directory (docs/spec/values.md): `in`, reads it;
 * `out`, writes it; `inout`, changes it in place.
 */
export type Mode = "in" | "out" | "inout";

/** What a handle's path is: a file, a directory, or `path`, either. */
export type Kind = "file" | "dir" | "path";

/**
 * A parameter's type, or that of what lies in one, as tau.json declares it (docs/spec/metadata.md).
 * A record without `fields` is open: any names, any values.
 */
export type Type =
	| { readonly type: "text"; readonly description?: string }
	| { readonly type: Kind; readonly mode: Mode; readonly description?: string }
	| { readonly type: "list"; readonly of: Type; readonly description?: string }
	| { readonly type: "record"; readonly fields?: { readonly [name: string]: Type }; readonly description?: string };

/** A value a run takes (docs/spec/values.md). */
export type Value = string | Handle | readonly Value[] | { readonly [name: string]: Value };

/** A file or a directory of the caller's, with its mode. */
export type Handle = { readonly $in: string } | { readonly $out: string } | { readonly $inout: string };

/** A tau's prompt and what it takes: `PROMPT.md` and `tau.json`. */
export interface Tau {
	readonly dir: string;
	/** What the tau does, for whoever runs it. */
	readonly description: string | undefined;
	/** PROMPT.md as written. */
	readonly prompt: string;
	/** Each parameter's type, in the order `tau.json` declares them; each has a description. */
	readonly params: { readonly [name: string]: Type };
	/**
	 * What the agent's programs import, as tau.json lists it: an API, as `@api/<name>`, or a package
	 * of the tau's own, by its name; undefined without the list, when they import every API.
	 * `loadExposed` checks it against the tau.
	 */
	readonly exposes: readonly string[] | undefined;
	/**
	 * One run: `values`, by parameter, checked against `params`; each handle's path resolved against
	 * `caller.cwd`, and given its place by `place`, called for each handle in the order of the values,
	 * by default the path itself; and the prompt expanded, with `${self}` where the agent sees the
	 * tau's own directory, `self`, by default `dir`. A handle may also be as a call has it
	 * (docs/spec/serialization.md), naming its content in place of a path, whose kind is checked
	 * against its type, and which `place` then places. Throws TypeError, listing every problem.
	 */
	bind(values: unknown, caller: Caller, place?: (handle: Placing) => string, self?: string): Run;
}

/** Who runs the tau. */
export interface Caller {
	/** What relative paths in the values are resolved against. */
	readonly cwd: string;
}

/** A handle in a run's values, as its runtime is asked to place it. */
export interface Placing {
	/** Where it lies in the values: `site`, `edits[0]`, `args.src`. */
	readonly at: string;
	/** Where it lies in the values, as a JSON Pointer, as a result names it: `/site`, `/edits/0`, `/args/src`. */
	readonly pointer: string;
	readonly mode: Mode;
	/**
	 * What its type declares it is; `path`, either, where no type declares it, unless it is a call's,
	 * whose content says.
	 */
	readonly kind: Kind;
	/** The base name of the caller's path, which its place keeps. */
	readonly name: string;
	/** The caller's path, absolute; none for a call's handle, which names its content instead. */
	readonly host?: string;
	/** A call's `$in` or `$inout` handle's content: its blob in the call. */
	readonly blob?: string;
}

/** A handle in a run's values, placed. */
export interface BoundHandle extends Placing {
	/** Where the agent sees it, absolute. */
	readonly view: string;
}

/** What a runtime needs to set up one run: computed, not done. */
export interface Run {
	/** PROMPT.md, each `${...}` replaced: a text by its value, a handle by its view, `${self}` by `self`. */
	readonly prompt: string;
	/** The values, each handle's path its view: what the agent's programs, and the model, are given. */
	readonly values: { readonly [name: string]: Value };
	/** Every handle in the values, in their order. */
	readonly handles: readonly BoundHandle[];
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** What `exposes` lists: a package's name, scoped or not, as programs import it. */
const PACKAGE = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/u;
/** What `${self}` names in a prompt: the tau's own directory, so no parameter has this name. */
const SELF = "self";
const TYPES: readonly string[] = ["text", "file", "dir", "path", "list", "record"] satisfies Type["type"][];
const MODES: readonly Mode[] = ["in", "out", "inout"];
/** `$${` is a literal `${`; any other `${` must be `${self}` or name a text or a handle. */
const PLACEHOLDER = /\$\$\{|\$\{([^}\n]*)(\}?)/gu;

/**
 * The tau at `dir`: its PROMPT.md, and its tau.json if it has one (without it, the tau takes no
 * parameters). Throws, naming the file and the reason, when tau.json breaks the spec or the prompt
 * names what it cannot, and, listing every one, for a symlink that breaks the spec in what a runtime
 * reads, node_modules/ included when the tau exposes a package of its own. APIs are loaded
 * separately, with `loadApis`, and what the tau exposes is checked against them with `loadExposed`.
 */
export function loadTau(dir: string): Tau {
	const absolute = path.resolve(dir);
	const promptFile = path.join(absolute, "PROMPT.md");
	if (!existsSync(promptFile)) throw new Error(`${absolute}: not a tau (no PROMPT.md)`);
	const metadataFile = path.join(absolute, "tau.json");
	const metadata = existsSync(metadataFile) ? readMetadata(metadataFile) : undefined;
	const { description, params = {}, exposes } = metadata ?? {};
	const prompt = readFileSync(promptFile, "utf8");
	let template: Template;
	try {
		template = parsePrompt(prompt, params);
	} catch (error) {
		throw new Error(`${promptFile}: ${messageOf(error)}`);
	}
	const problems = linkProblems(absolute, exposes?.some((specifier) => !specifier.startsWith(API_SCOPE)) ?? false);
	if (problems.length > 0) throw new Error(`${absolute}: breaks the spec:\n  ${problems.join("\n  ")}`);

	return {
		dir: absolute,
		description,
		prompt,
		params,
		exposes,
		bind(values, caller, place = placeAtHost, self = absolute) {
			const problems: string[] = [];
			const handles: BoundHandle[] = [];
			const fit = (value: unknown, type: Type | undefined, at: string, pointer: string): Value | undefined => {
				const problem = (text: string): undefined => {
					problems.push(`${at}: ${text}`);
					return undefined;
				};
				const handle = isObject(value) && Object.keys(value).some((key) => key.startsWith("$"));
				if (handle) {
					const [key, ...more] = Object.keys(value);
					const mode = key?.slice(1) as Mode;
					const host = value[key as string];
					const content = isObject(host) ? callContent(host, mode) : undefined;
					if (more.length > 0 || !MODES.includes(mode) || (typeof host !== "string" && content === undefined))
						return problem(`${JSON.stringify(value)} is not a handle, which is {"$in" | "$out" | "$inout": <path>}`);
					if (type !== undefined && type.type !== "file" && type.type !== "dir" && type.type !== "path")
						return problem(`is a handle, where ${describe(type)} goes`);
					if (type !== undefined && type.mode !== mode) return problem(`is an $${mode} handle, where an $${type.mode} one goes`);
					let placing: Placing;
					if (content !== undefined) {
						const declared = type?.type ?? "path";
						if (content.kind !== undefined && declared !== "path" && content.kind !== declared)
							return problem(`holds a ${content.kind === "dir" ? "directory" : "file"}, where ${declared === "dir" ? "a directory" : "a file"} goes`);
						placing = { at, pointer, mode, kind: content.kind ?? declared, name: content.name, ...(content.blob === undefined ? {} : { blob: content.blob }) };
					} else {
						if (host === "") return problem("a handle's path cannot be empty");
						const resolved = path.resolve(caller.cwd, host as string);
						placing = { at, pointer, mode, kind: type?.type ?? "path", name: path.basename(resolved), host: resolved };
					}
					const view = place(placing);
					handles.push({ ...placing, view });
					return { [`$${mode}`]: view } as Handle;
				}
				if (typeof value === "string") return type === undefined || type.type === "text" ? value : problem(`is a text, where ${describe(type)} goes`);
				if (Array.isArray(value)) {
					if (type !== undefined && type.type !== "list") return problem(`is a list, where ${describe(type)} goes`);
					const items = value.map((item, index) => fit(item, type?.of, `${at}[${index}]`, `${pointer}/${index}`));
					return items.every((item) => item !== undefined) ? items : undefined;
				}
				if (!isObject(value)) return problem(`${JSON.stringify(value)} is not a value: a text, a handle, a list or a record`);
				if (type !== undefined && type.type !== "record") return problem(`is a record, where ${describe(type)} goes`);
				return fitRecord(value, type?.fields, at, pointer, fit, problem);
			};
			const bound = isObject(values)
				? fitRecord(values, params, "", "", fit, (text) => {
						problems.push(text);
						return undefined;
					})
				: (problems.push("the values must be a record, from each parameter's name to its value"), undefined);
			if (problems.length > 0 || bound === undefined)
				throw new TypeError(`the values do not fit the tau:\n  ${problems.join("\n  ")}`);
			return { prompt: expand(template, bound, self), values: bound, handles };
		},
	};
}

/** What `fit` makes of a value: its handles placed, or undefined once its problem is recorded. */
type Fit = (value: unknown, type: Type | undefined, at: string, pointer: string) => Value | undefined;

/** Where a handle is by default: the caller's path itself, which a call's handle has not. */
function placeAtHost({ at, host }: Placing): string {
	if (host === undefined) throw new TypeError(`${at}: a call's handle names no path of the caller's, so the runtime places it`);
	return host;
}

/**
 * A call's handle's content (docs/spec/serialization.md): `{name, kind, blob}` for an `$in` or an
 * `$inout`, `{name}` for an `$out`; or undefined when it is not one.
 */
function callContent(value: Record<string, unknown>, mode: Mode): { name: string; kind?: "file" | "dir"; blob?: string } | undefined {
	const { name, kind, blob, ...rest } = value;
	if (Object.keys(rest).length > 0 || typeof name !== "string" || name === "" || name === "." || name === ".." || /[/\0]/u.test(name)) return undefined;
	if (mode === "out") return kind === undefined && blob === undefined ? { name } : undefined;
	if ((kind !== "file" && kind !== "dir") || typeof blob !== "string") return undefined;
	return { name, kind, blob };
}

/**
 * A record's values fitted to `fields`: exactly those when it has them, or else any, each named as a
 * parameter is. `at` is where the record lies, empty for the values themselves.
 */
function fitRecord(
	record: Record<string, unknown>,
	fields: { readonly [name: string]: Type } | undefined,
	at: string,
	pointer: string,
	fit: Fit,
	problem: (text: string) => undefined,
): { readonly [name: string]: Value } | undefined {
	const what = at === "" ? "parameter" : "field";
	const within = (name: string): string => (at === "" ? name : `${at}.${name}`);
	let fits = true;
	if (fields !== undefined) {
		const missing = Object.keys(fields).filter((name) => !Object.hasOwn(record, name));
		if (missing.length > 0) fits = problem(`no value for ${missing.join(", ")}`) ?? false;
		const unknown = Object.keys(record).filter((name) => !Object.hasOwn(fields, name));
		if (unknown.length > 0) fits = problem(`no ${what} is named ${unknown.join(", ")}`) ?? false;
	} else {
		const misnamed = Object.keys(record).filter((name) => !NAME.test(name));
		if (misnamed.length > 0) fits = problem(`${misnamed.map((name) => JSON.stringify(name)).join(", ")} is not a name, which matches ${NAME.source}`) ?? false;
	}
	const fitted: Record<string, Value> = {};
	for (const [name, value] of Object.entries(record)) {
		if (fields !== undefined && !Object.hasOwn(fields, name)) continue;
		const result = fit(value, fields?.[name], within(name), `${pointer}/${name}`);
		if (result === undefined) fits = false;
		else fitted[name] = result;
	}
	return fits ? fitted : undefined;
}

/** A type, as a problem names it. */
function describe(type: Type): string {
	switch (type.type) {
		case "text":
			return "a text";
		case "list":
			return "a list";
		case "record":
			return "a record";
		default:
			return `an $${type.mode} handle`;
	}
}

/**
 * Before a run: whether the handles' paths fit the tau (docs/spec/paths.md). Each `$in` and `$inout`
 * path is a file or a directory as its kind says, and a value (see `valueProblems`); each `$out`
 * path lies in a directory that exists, and is not there yet, or is of its kind, symlinks followed.
 * Paths may overlap. Throws, listing every problem.
 */
export function checkInputs(run: Run): void {
	const problems: string[] = [];
	for (const { at, mode, kind, host } of run.handles) {
		// A call's handle names content, which its reader checked.
		if (host === undefined) continue;
		if (mode !== "out") {
			problems.push(...valueProblems(host, kind).map((problem) => `${at}: ${problem}`));
			continue;
		}
		const parent = path.dirname(host);
		const parentProblem = shapeProblem(parent, "dir");
		if (parentProblem !== undefined) {
			problems.push(`${at}: cannot go in ${parent}, which ${parentProblem}`);
			continue;
		}
		const problem = shapeProblem(host, kind);
		if (problem !== undefined && problem !== MISSING) problems.push(`${at}: ${host} ${problem}`);
	}
	if (problems.length > 0) throw new Error(`the handles do not fit the tau:\n  ${problems.join("\n  ")}`);
}

/**
 * When the run ends, if the agent returned normally: whether it left what the tau declares. What
 * `locate` finds of each `$out` and `$inout` handle is a file or a directory as its kind says, and a
 * value (see `valueProblems`): by default its view, which is right for a runtime whose agent works
 * on the runtime's own machine; one whose agent works elsewhere, such as in a container, checks
 * where it can. Throws, listing every problem.
 */
export function checkOutputs(run: Run, locate: (handle: BoundHandle) => string = ({ view }) => view): void {
	const problems: string[] = [];
	for (const handle of run.handles) {
		if (handle.mode === "in") continue;
		problems.push(...valueProblems(locate(handle), handle.kind).map((problem) => `${handle.at}: ${problem}`));
	}
	if (problems.length > 0)
		throw new Error(`the run did not leave what the tau declares:\n  ${problems.join("\n  ")}`);
}

function readMetadata(file: string): {
	description: string | undefined;
	params: { [name: string]: Type };
	exposes: string[] | undefined;
} {
	try {
		let json: unknown;
		try {
			json = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			throw new TypeError(`is not JSON: ${messageOf(error)}`);
		}
		if (!isObject(json)) throw new TypeError("must be an object");
		const { description, params = {}, exposes, ...rest } = json;
		refuseKeys(rest, "tau.json");
		if (description !== undefined && typeof description !== "string")
			throw new TypeError("`description` must be a string");
		if (!isObject(params)) throw new TypeError("`params` must be an object, from each parameter's name to its type");
		if (exposes !== undefined && !Array.isArray(exposes)) throw new TypeError("`exposes` must be an array");

		const declared: { [name: string]: Type } = {};
		for (const [name, type] of Object.entries(params)) {
			if (!NAME.test(name))
				throw new TypeError(`\`params\`: ${JSON.stringify(name)} is not a parameter's name, which matches ${NAME.source}`);
			if (name === SELF)
				throw new TypeError(`\`params\`: \`${SELF}\` names the tau's own directory, so no parameter has that name`);
			declared[name] = readType(type, name, true);
		}

		const exposed = new Set<string>();
		for (const specifier of exposes ?? []) {
			if (typeof specifier !== "string" || !PACKAGE.test(specifier))
				throw new TypeError(`\`exposes\`: ${JSON.stringify(specifier)} is not a package's name`);
			if (exposed.has(specifier)) throw new TypeError(`\`exposes\` lists ${specifier} twice`);
			exposed.add(specifier);
		}

		return { description, params: declared, exposes: exposes === undefined ? undefined : [...exposed] };
	} catch (error) {
		throw new Error(`${file}: ${messageOf(error)}`);
	}
}

/** A type as tau.json declares it at `at`: a parameter's, which has a description, or what lies in one. */
function readType(value: unknown, at: string, parameter: boolean): Type {
	if (!isObject(value)) throw new TypeError(`${at} must be an object, with its \`type\``);
	const { type, description, mode, of, fields, ...rest } = value;
	refuseKeys(rest, at);
	if (parameter && (typeof description !== "string" || description.trim() === ""))
		throw new TypeError(`${at}: needs a \`description\`, saying what it is`);
	if (description !== undefined && typeof description !== "string") throw new TypeError(`${at}: \`description\` must be a string`);
	const described = description === undefined ? {} : { description };
	if (type === undefined) throw new TypeError(`${at}: needs a \`type\`, one of ${TYPES.join(", ")}`);
	if (typeof type !== "string" || !TYPES.includes(type))
		throw new TypeError(`${at}: \`type\` ${JSON.stringify(type)} is not one of ${TYPES.join(", ")}`);
	const refuse = (key: string, present: unknown): void => {
		if (present !== undefined) throw new TypeError(`${at}: a ${type} has no \`${key}\``);
	};
	if (type !== "file" && type !== "dir" && type !== "path") refuse("mode", mode);
	if (type !== "list") refuse("of", of);
	if (type !== "record") refuse("fields", fields);
	switch (type) {
		case "text":
			return { type, ...described };
		case "list":
			if (of === undefined) throw new TypeError(`${at}: a list needs \`of\`, the type of its values`);
			return { type, of: readType(of, `${at}[]`, false), ...described };
		case "record": {
			if (fields === undefined) return { type, ...described };
			if (!isObject(fields)) throw new TypeError(`${at}: \`fields\` must be an object, from each field's name to its type`);
			const read: { [name: string]: Type } = {};
			for (const [name, field] of Object.entries(fields)) {
				if (!NAME.test(name)) throw new TypeError(`${at}: ${JSON.stringify(name)} is not a field's name, which matches ${NAME.source}`);
				read[name] = readType(field, `${at}.${name}`, false);
			}
			return { type, fields: read, ...described };
		}
		default:
			if (mode === undefined) throw new TypeError(`${at}: a ${type} needs a \`mode\`, one of ${MODES.join(", ")}`);
			if (typeof mode !== "string" || !(MODES as readonly string[]).includes(mode))
				throw new TypeError(`${at}: \`mode\` ${JSON.stringify(mode)} is not one of ${MODES.join(", ")}`);
			return { type: type as Kind, mode: mode as Mode, ...described };
	}
}

/** A prompt as text around placeholders: `text` has one more entry than `names`, each a path of names. */
interface Template {
	readonly text: readonly string[];
	readonly names: readonly (readonly string[])[];
}

function parsePrompt(prompt: string, params: { readonly [name: string]: Type }): Template {
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
		const line = prompt.slice(0, match.index).split("\n").length;
		if (closed === "") throw new TypeError(`line ${line}: ${placeholder} is not closed; write $\${ for a literal \${`);
		const problem = placeholderProblem(inside, params);
		if (problem !== undefined) throw new TypeError(`line ${line}: ${placeholder} ${problem}`);
		text.push(chunk);
		names.push(inside.split("."));
		chunk = "";
	}
	text.push(chunk + prompt.slice(last));
	return { text, names };
}

/**
 * Why `${inside}` cannot be in a prompt, if it cannot: it names `self`, or a text, a handle, or a
 * list of texts or handles, through closed records only.
 */
function placeholderProblem(inside: string, params: { readonly [name: string]: Type }): string | undefined {
	if (inside === SELF) return undefined;
	const [first = "", ...rest] = inside.split(".");
	let type = Object.hasOwn(params, first) ? params[first] : undefined;
	if (type === undefined) return `is neither \${${SELF}} nor a parameter tau.json declares; write $\${ for a literal \${`;
	let named = first;
	for (const field of rest) {
		if (type.type !== "record" || type.fields === undefined)
			return `names what lies in ${named}, ${describe(type)}${type.type === "record" ? " that is open" : ""}, which the prompt cannot hold: the agent's programs read it, through the tau API`;
		if (!Object.hasOwn(type.fields, field)) return `names no field of ${named}`;
		type = type.fields[field] as Type;
		named = `${named}.${field}`;
	}
	if (type.type === "list" && (type.of.type === "list" || type.of.type === "record"))
		return `names a list of ${describe(type.of).replace(/^an? /u, "")}s, which the prompt cannot hold: name a list of texts or handles, or read it in a program, through the tau API`;
	if (type.type === "record")
		return `names ${describe(type)}, which the prompt cannot hold: name a text, a handle, or a list of them, or read it in a program, through the tau API`;
	return undefined;
}

function expand(template: Template, values: { readonly [name: string]: Value }, self: string): string {
	return template.names.reduce((prompt, names, index) => {
		let value: Value | undefined = values;
		if (names.length === 1 && names[0] === SELF) value = self;
		else for (const name of names) value = (value as { readonly [name: string]: Value })[name];
		const expanded = Array.isArray(value) ? JSON.stringify(value.map(scalar)) : scalar(value as Value);
		return prompt + expanded + template.text[index + 1];
	}, template.text[0] as string);
}

/** A text as it is, or a handle as its view. */
function scalar(value: Value): string {
	return typeof value === "string" ? value : (Object.values(value as Handle)[0] as string);
}

const MISSING = "does not exist";

/**
 * Why `file`, an `$in` or `$inout` handle's path, or what the agent left at an `$out` or `$inout`
 * one's, is not of `kind` (docs/spec/paths.md): it is not a symlink, and each symlink in a directory
 * is relative, and leads, through any further symlinks, all relative, to something that exists in it.
 */
function valueProblems(file: string, kind: Kind): string[] {
	let stats: Stats;
	try {
		stats = lstatSync(file);
	} catch (error) {
		return [`${file} ${statProblem(error)}`];
	}
	if (stats.isSymbolicLink()) return [`${file} is a symlink, which a handle's path cannot be`];
	const problem = kindProblem(stats, kind);
	if (problem !== undefined) return [`${file} ${problem}`];
	return stats.isDirectory() ? valueLinkProblems(file) : [];
}

/** Why `file` is not of `kind`, following symlinks; undefined when it is. */
function shapeProblem(file: string, kind: Kind): string | undefined {
	try {
		return kindProblem(statSync(file), kind);
	} catch (error) {
		return statProblem(error);
	}
}

function kindProblem(stats: Stats, kind: Kind): string | undefined {
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
