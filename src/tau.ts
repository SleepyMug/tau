import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { linkProblems } from "./links.js";

/** What a path argument names on the caller's side. */
export type PathType = "file" | "dir";

/**
 * What the agent does with a path argument (SPEC.md):
 * - `in`: reads it, and leaves it as it is;
 * - `out`: writes it, starting without it; a successful run replaces the caller's path;
 * - `share`: reads and changes the caller's own, not a copy, so its changes reach the caller as it
 *   makes them, whether or not the run succeeds.
 *
 * A tau with no `share` path is functional; one with any is procedural.
 */
export type PathRole = "in" | "out" | "share";

/** An argument as `tau.json` declares it: tagged by `type`, and only a path has a `role`. */
export type Arg =
	| { readonly name: string; readonly type: "text"; readonly description: string | undefined }
	| { readonly name: string; readonly type: PathType; readonly role: PathRole; readonly description: string | undefined };

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
	 * One run: `argv` checked against `args`, and the prompt expanded, with each path where `place`
	 * puts it; by default, where the caller's path is. Throws TypeError.
	 */
	bind(argv: readonly string[], caller: Caller, place?: Place): Run;
}

/** Who runs the tau. */
export interface Caller {
	/** What relative paths in argv are resolved against. */
	readonly cwd: string;
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** Where the agent sees a path: the runtime's choice. */
export type Place = (path: Omit<BoundPath, "view">) => string;

/** What a runtime needs to set up one run: computed, not done. */
export interface Run {
	/** PROMPT.md with each `${name}` replaced: a text argument by its value, a path by its view. */
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
	/** The caller's path, absolute. */
	readonly host: string;
	/** Where the agent sees it. */
	readonly view: string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const TYPES: readonly string[] = ["text", "file", "dir"] satisfies Arg["type"][];
const ROLES: readonly string[] = ["in", "out", "share"] satisfies PathRole[];
/** `$${` is a literal `${`; any other `${` must be a `${name}` of a declared argument. */
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
		template = parsePrompt(prompt, new Set(args.map((arg) => arg.name)));
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
		bind(argv, caller, place = ({ host }) => host) {
			if (argv.length !== args.length) {
				const names = args.length === 0 ? "" : ` (${args.map((arg) => arg.name).join(", ")})`;
				throw new TypeError(`expected ${args.length} argument(s)${names}, got ${argv.length}`);
			}
			const values = new Map<string, string>();
			const paths: BoundPath[] = [];
			args.forEach((arg, index) => {
				const value = argv[index] as string;
				if (arg.type === "text") {
					values.set(arg.name, value);
					return;
				}
				if (value === "") throw new TypeError(`${arg.name}: a path cannot be empty`);
				const bound = { name: arg.name, type: arg.type, role: arg.role, host: path.resolve(caller.cwd, value) };
				const view = place(bound);
				paths.push({ ...bound, view });
				values.set(arg.name, view);
			});
			const overlap = overlapping(paths.map(({ name, host }) => ({ name, host, at: host })));
			if (overlap !== undefined) {
				const [inner, outer] = overlap;
				throw new TypeError(
					`${inner.name} (${inner.host}) and ${outer.name} (${outer.host}) overlap: no path may be, or lie inside, another`,
				);
			}
			const set = env.flatMap((name) => {
				const value = caller.env[name];
				return value === undefined ? [] : [[name, value] as const];
			});
			return { prompt: expand(template, values), env: Object.fromEntries(set), paths };
		},
	};
}

/**
 * Before a run: whether the caller's paths fit the tau. Each `in` and `share` path is a file or a
 * directory as declared; each `out` goes into an existing directory, and would replace only a path
 * of its own type. Symlinks are followed, and once they are, still no path may be, or lie inside,
 * another. Throws, listing every problem.
 */
export function checkInputs(run: Run): void {
	const problems: string[] = [];
	// Where each path really is. What an `out` would replace is not followed: the run replaces it.
	const real: Located[] = [];
	for (const { name, type, role, host } of run.paths) {
		if (role !== "out") {
			const problem = shapeProblem(host, type);
			if (problem !== undefined) problems.push(`${name}: ${host} ${problem}`);
			else real.push({ name, host, at: realpathSync(host) });
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
		else real.push({ name, host, at: path.join(realpathSync(parent), path.basename(host)) });
	}
	const overlap = overlapping(real);
	if (overlap !== undefined) {
		const [inner, outer] = overlap;
		const how = inner.at === outer.at ? `both are ${inner.at}` : `${inner.at} lies inside ${outer.at}`;
		problems.push(`${inner.name} (${inner.host}) and ${outer.name} (${outer.host}) overlap once symlinks are followed: ${how}`);
	}
	if (problems.length > 0) throw new Error(`the arguments do not fit the tau:\n  ${problems.join("\n  ")}`);
}

/**
 * After a successful run: whether the agent left what the tau declares. Each `out` path is a file
 * or a directory as declared where `locate` finds it: by default the caller's path, which is right
 * for a runtime that runs the agent in place, or has brought its `out` paths back. Each `share`
 * path is one where the caller has it, since the agent worked on the caller's own. Throws, listing
 * every problem.
 */
export function checkOutputs(run: Run, locate: (path: BoundPath) => string = ({ host }) => host): void {
	const problems: string[] = [];
	for (const bound of run.paths) {
		if (bound.role === "in") continue;
		const at = bound.role === "share" ? bound.host : locate(bound);
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
	const { name, type, role, description, ...rest } = value;
	if (typeof name !== "string" || !NAME.test(name))
		throw new TypeError(`args[${index}] needs a \`name\` matching ${NAME.source}`);
	refuseKeys(rest, name);
	if (description !== undefined && typeof description !== "string")
		throw new TypeError(`${name}: \`description\` must be a string`);
	if (type === undefined) throw new TypeError(`${name}: needs a \`type\`, one of ${TYPES.join(", ")}`);
	if (typeof type !== "string" || !TYPES.includes(type))
		throw new TypeError(`${name}: \`type\` ${JSON.stringify(type)} is not one of ${TYPES.join(", ")}`);
	if (type === "text") {
		if (role !== undefined) throw new TypeError(`${name}: a text argument has no \`role\``);
		return { name, type, description };
	}
	if (role === undefined) throw new TypeError(`${name}: a ${type} needs a \`role\`, one of ${ROLES.join(", ")}`);
	if (typeof role !== "string" || !ROLES.includes(role))
		throw new TypeError(`${name}: \`role\` ${JSON.stringify(role)} is not one of ${ROLES.join(", ")}`);
	return { name, type: type as PathType, role: role as PathRole, description };
}

/** A path argument, and where it is compared with the others. */
interface Located {
	readonly name: string;
	readonly host: string;
	readonly at: string;
}

/** The first two paths of which one is, or lies inside, the other: `[inner, outer]`. */
function overlapping(paths: readonly Located[]): [Located, Located] | undefined {
	for (const [index, first] of paths.entries()) {
		for (const second of paths.slice(index + 1)) {
			const [outer, inner] = first.at.length <= second.at.length ? [first, second] : [second, first];
			if (inner.at === outer.at || inner.at.startsWith(outer.at.endsWith("/") ? outer.at : `${outer.at}/`))
				return [inner, outer];
		}
	}
	return undefined;
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
				`line ${line}: ${placeholder} is not an argument tau.json declares; write $\${ for a literal \${`,
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
