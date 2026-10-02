import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { linkProblems } from "./links.js";

/** What a path argument names on the caller's side. */
export type PathType = "file" | "dir";

/**
 * What the agent does with a path argument (SPEC.md):
 * - `in`: reads it; it exists when the run starts;
 * - `out`: writes it; the directory it goes in exists when the run starts, and if the agent returns
 *   normally, it exists when the run ends, holding what the agent left at its place.
 *
 * The caller's paths may overlap.
 */
export type PathRole = "in" | "out";

/**
 * An argument as `tau.json` declares it: tagged by `type`, and only a path has a `role`, and an `at`,
 * its place: where the agent finds it, relative to its working directory; by default, its name. No
 * two places are the same, but for an `in` and an `out` of the same type, which may share one, the
 * `out` starting as a copy of the `in`. A place may lie in another's, but not in a file's: the inner
 * one wins.
 */
export type Arg =
	| { readonly name: string; readonly type: "text"; readonly description: string | undefined }
	| {
			readonly name: string;
			readonly type: PathType;
			readonly role: PathRole;
			readonly at: string;
			readonly description: string | undefined;
	  };

/** A tau's prompt and what it takes and gives: `PROMPT.md` and `tau.json`. */
export interface Tau {
	readonly dir: string;
	/** What the tau does, for whoever runs it. */
	readonly description: string | undefined;
	/** PROMPT.md as written. */
	readonly prompt: string;
	/** In argv order; all required. */
	readonly args: readonly Arg[];
	/** The variables of the caller's environment the agent may see. */
	readonly env: readonly string[];
	/**
	 * One run: `argv` checked against `args`, and the prompt expanded, with each path at its place in
	 * `work`, the working directory as the agent sees it, which is absolute; and `${self}` where the
	 * agent sees the tau's own directory, `self`; by default, `dir`. Throws TypeError.
	 */
	bind(argv: readonly string[], caller: Caller, work: string, self?: string): Run;
}

/** Who runs the tau. */
export interface Caller {
	/** What relative paths in argv are resolved against. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** What a runtime needs to set up one run: computed, not done. */
export interface Run {
	/**
	 * PROMPT.md with each `${name}` replaced: a text argument by its value, a path by its view, and
	 * `${self}` by where the agent sees the tau's own directory.
	 */
	readonly prompt: string;
	/** The tau's `env`, with the caller's values; unset ones are left out. */
	readonly env: Readonly<Record<string, string>>;
	/** The path arguments, in argv order. */
	readonly paths: readonly BoundPath[];
}

export interface BoundPath {
	readonly name: string;
	readonly type: PathType;
	readonly role: PathRole;
	/** Its place, relative to the working directory. */
	readonly at: string;
	/** The caller's path, absolute. */
	readonly host: string;
	/** Where the agent sees it: its place in the working directory. */
	readonly view: string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** What `${self}` names in a prompt: the tau's own directory, so no argument has this name. */
const SELF = "self";
const TYPES: readonly string[] = ["text", "file", "dir"] satisfies Arg["type"][];
const ROLES: readonly string[] = ["in", "out"] satisfies PathRole[];
/** `$${` is a literal `${`; any other `${` must be `${self}` or a `${name}` of a declared argument. */
const PLACEHOLDER = /\$\$\{|\$\{([^}\n]*)(\}?)/gu;

/**
 * The tau at `dir`: its PROMPT.md, and its tau.json if it has one (without it, the tau takes no
 * arguments and sees no variables). Throws, naming the file and the reason, when tau.json breaks
 * the spec or the prompt names an argument tau.json does not declare, and, listing every one, for
 * a symlink that breaks the spec in what a runtime reads. APIs are loaded separately, with
 * `loadApis`.
 */
export function loadTau(dir: string): Tau {
	const absolute = path.resolve(dir);
	const promptFile = path.join(absolute, "PROMPT.md");
	if (!existsSync(promptFile)) throw new Error(`${absolute}: not a tau (no PROMPT.md)`);
	const metadataFile = path.join(absolute, "tau.json");
	const metadata = existsSync(metadataFile) ? readMetadata(metadataFile) : undefined;
	const { description, args = [], env = [] } = metadata ?? {};
	const prompt = readFileSync(promptFile, "utf8");
	let template: Template;
	try {
		template = parsePrompt(prompt, new Set([SELF, ...args.map((arg) => arg.name)]));
	} catch (error) {
		throw new Error(`${promptFile}: ${messageOf(error)}`);
	}
	const problems = linkProblems(absolute);
	if (problems.length > 0) throw new Error(`${absolute}: breaks the spec:\n  ${problems.join("\n  ")}`);

	return {
		dir: absolute,
		description,
		prompt,
		args,
		env,
		bind(argv, caller, work, self = absolute) {
			if (!path.isAbsolute(work)) throw new TypeError(`the working directory must be an absolute path: ${work}`);
			if (argv.length !== args.length) {
				const names = args.length === 0 ? "" : ` (${args.map((arg) => arg.name).join(", ")})`;
				throw new TypeError(`expected ${args.length} argument(s)${names}, got ${argv.length}`);
			}
			const values = new Map<string, string>([[SELF, self]]);
			const paths: BoundPath[] = [];
			args.forEach((arg, index) => {
				const value = argv[index] as string;
				if (arg.type === "text") {
					values.set(arg.name, value);
					return;
				}
				if (value === "") throw new TypeError(`${arg.name}: a path cannot be empty`);
				const view = path.join(work, arg.at);
				paths.push({ name: arg.name, type: arg.type, role: arg.role, at: arg.at, host: path.resolve(caller.cwd, value), view });
				values.set(arg.name, view);
			});
			const set = env.flatMap((name) => {
				const value = caller.env[name];
				return value === undefined ? [] : [[name, value] as const];
			});
			return { prompt: expand(template, values), env: Object.fromEntries(set), paths };
		},
	};
}

/**
 * Before a run: whether the caller's paths fit the tau. Each `in` path is a file or a directory as
 * declared; each `out` goes into an existing directory, and is not there yet, or is of its own
 * type. Symlinks are followed, and paths may overlap. Throws, listing every problem.
 */
export function checkInputs(run: Run): void {
	const problems: string[] = [];
	for (const { name, type, role, host } of run.paths) {
		if (role === "in") {
			const problem = shapeProblem(host, type);
			if (problem !== undefined) problems.push(`${name}: ${host} ${problem}`);
			continue;
		}
		const parent = path.dirname(host);
		const parentProblem = shapeProblem(parent, "dir");
		if (parentProblem !== undefined) {
			problems.push(`${name}: cannot go in ${parent}, which ${parentProblem}`);
			continue;
		}
		const problem = shapeProblem(host, type);
		if (problem !== undefined && problem !== MISSING) problems.push(`${name}: ${host} ${problem}`);
	}
	if (problems.length > 0) throw new Error(`the arguments do not fit the tau:\n  ${problems.join("\n  ")}`);
}

/**
 * When the run ends, if the agent returned normally: whether it left what the tau declares, before
 * the runtime puts its `out` paths in place. Each `out` path is a file or a directory as declared
 * where `locate` finds what the agent left at its place: by default its view, which is right for a
 * runtime whose agent works on the runtime's own machine; one whose agent works elsewhere, such as
 * in a container, checks a copy. Throws, listing every problem.
 */
export function checkOutputs(run: Run, locate: (path: BoundPath) => string = ({ view }) => view): void {
	const problems: string[] = [];
	for (const bound of run.paths) {
		if (bound.role === "in") continue;
		const at = locate(bound);
		const problem = shapeProblem(at, bound.type);
		if (problem !== undefined) problems.push(`${bound.name}: ${at} ${problem}`);
	}
	if (problems.length > 0)
		throw new Error(`the run did not leave what the tau declares:\n  ${problems.join("\n  ")}`);
}

function readMetadata(file: string): {
	description: string | undefined;
	args: Arg[];
	env: string[];
} {
	try {
		let json: unknown;
		try {
			json = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			throw new TypeError(`is not JSON: ${messageOf(error)}`);
		}
		if (!isObject(json)) throw new TypeError("must be an object");
		const { description, args = [], env = [], ...rest } = json;
		refuseKeys(rest, "tau.json");
		if (description !== undefined && typeof description !== "string")
			throw new TypeError("`description` must be a string");
		if (!Array.isArray(args)) throw new TypeError("`args` must be an array");
		if (!Array.isArray(env)) throw new TypeError("`env` must be an array");

		const declared = args.map(readArg);
		const names = new Set<string>();
		for (const { name } of declared) {
			if (names.has(name)) throw new TypeError(`two arguments are named ${name}`);
			names.add(name);
		}
		const paths = declared.filter((arg) => arg.type !== "text");
		for (const [index, path] of paths.entries()) {
			for (const other of paths.slice(index + 1)) {
				const problem = placesProblem(path, other);
				if (problem !== undefined) throw new TypeError(problem);
			}
		}

		const variables = new Set<string>();
		for (const name of env) {
			if (typeof name !== "string" || !NAME.test(name))
				throw new TypeError(`\`env\`: ${JSON.stringify(name)} is not a variable name`);
			if (variables.has(name)) throw new TypeError(`\`env\` lists ${name} twice`);
			variables.add(name);
		}

		return { description, args: declared, env: [...variables] };
	} catch (error) {
		throw new Error(`${file}: ${messageOf(error)}`);
	}
}

function readArg(value: unknown, index: number): Arg {
	if (!isObject(value)) throw new TypeError(`args[${index}] must be an object`);
	const { name, type, role, at, description, ...rest } = value;
	if (typeof name !== "string" || !NAME.test(name))
		throw new TypeError(`args[${index}] needs a \`name\` matching ${NAME.source}`);
	if (name === SELF) throw new TypeError(`args[${index}]: \`${SELF}\` names the tau's own directory, so no argument has that name`);
	refuseKeys(rest, name);
	if (description !== undefined && typeof description !== "string")
		throw new TypeError(`${name}: \`description\` must be a string`);
	if (type === undefined) throw new TypeError(`${name}: needs a \`type\`, one of ${TYPES.join(", ")}`);
	if (typeof type !== "string" || !TYPES.includes(type))
		throw new TypeError(`${name}: \`type\` ${JSON.stringify(type)} is not one of ${TYPES.join(", ")}`);
	if (type === "text") {
		if (role !== undefined) throw new TypeError(`${name}: a text argument has no \`role\``);
		if (at !== undefined) throw new TypeError(`${name}: a text argument has no \`at\``);
		return { name, type, description };
	}
	if (role === undefined) throw new TypeError(`${name}: a ${type} needs a \`role\`, one of ${ROLES.join(", ")}`);
	if (typeof role !== "string" || !ROLES.includes(role))
		throw new TypeError(`${name}: \`role\` ${JSON.stringify(role)} is not one of ${ROLES.join(", ")}`);
	if (at !== undefined && (typeof at !== "string" || !isPlace(at)))
		throw new TypeError(
			`${name}: \`at\` ${JSON.stringify(at)} is not a relative path of names separated by /, none of them empty, . or ..`,
		);
	return { name, type: type as PathType, role: role as PathRole, at: at ?? name, description };
}

/** Whether `at` is a place: names separated by `/`, none of them empty, `.` or `..`. */
function isPlace(at: string): boolean {
	return at.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.includes("\0"));
}

type PathArg = Extract<Arg, { readonly at: string }>;

/**
 * Why two paths cannot have their places, if they cannot: only an `in` and an `out` of one type share
 * one, and nothing lies in a file's.
 */
function placesProblem(a: PathArg, b: PathArg): string | undefined {
	if (a.at === b.at) {
		if (a.role !== b.role && a.type === b.type) return undefined;
		return `${a.name} and ${b.name} are both at ${a.at}, where only an in and an out of the same type may be`;
	}
	const [outer, inner] = b.at.startsWith(`${a.at}/`) ? [a, b] : a.at.startsWith(`${b.at}/`) ? [b, a] : [];
	if (outer === undefined || inner === undefined || outer.type === "dir") return undefined;
	return `${inner.name} is at ${inner.at}, inside ${outer.name}'s place ${outer.at}, which is a file`;
}

/** A prompt as text around placeholders: `text` has one more entry than `names`. */
interface Template {
	readonly text: readonly string[];
	readonly names: readonly string[];
}

function parsePrompt(prompt: string, declared: ReadonlySet<string>): Template {
	const text: string[] = [];
	const names: string[] = [];
	let chunk = "";
	let last = 0;
	for (const match of prompt.matchAll(PLACEHOLDER)) {
		chunk += prompt.slice(last, match.index);
		last = match.index + match[0].length;
		if (match[0] === "$${") {
			chunk += "${";
			continue;
		}
		const [placeholder, name = "", closed] = match;
		const line = prompt.slice(0, match.index).split("\n").length;
		if (closed === "") throw new TypeError(`line ${line}: ${placeholder} is not closed; write $\${ for a literal \${`);
		if (!declared.has(name))
			throw new TypeError(
				`line ${line}: ${placeholder} is neither \${${SELF}} nor an argument tau.json declares; write $\${ for a literal \${`,
			);
		text.push(chunk);
		names.push(name);
		chunk = "";
	}
	text.push(chunk + prompt.slice(last));
	return { text, names };
}

function expand(template: Template, values: ReadonlyMap<string, string>): string {
	return template.names.reduce(
		(prompt, name, index) => prompt + values.get(name) + template.text[index + 1],
		template.text[0] as string,
	);
}

const MISSING = "does not exist";

/** Why `file` is not a `type`, following symlinks; undefined when it is. */
function shapeProblem(file: string, type: PathType): string | undefined {
	let stats;
	try {
		stats = statSync(file);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" || code === "ENOTDIR" ? MISSING : `cannot be read: ${messageOf(error)}`;
	}
	if (type === "file") return stats.isFile() ? undefined : "is not a file";
	return stats.isDirectory() ? undefined : "is not a directory";
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
