import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { type Api, apisOf, type Exposed, readExposed } from "./apis.js";
import { checkEnvelope, type Declared, resolveCall, scopeOfCall } from "./call.js";
import { linkProblems } from "./links.js";
import { readMetadata } from "./metadata.js";
import { type Envelope, type FileDeclaration, type Json, type ResolvedCall, SELF } from "./model.js";
import { expand, expansion, parseTemplate, placeholderProblem, scopeOf, shellWord, type Template } from "./placeholders.js";
import { isObject, messageOf } from "./util.js";

/** A skill of a tau: `skills/<name>/`, with its `SKILL.md` (docs/spec/directory.md). */
export interface Skill {
	readonly name: string;
	/** `skills/<name>/`, absolute. */
	readonly dir: string;
}

/** A tau, read and checked: `PROMPT.md`, `tau.json`, its APIs, what it exposes, and its skills. */
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
	/** Its APIs, each a contract's name and a range, as `apis` in tau.json names them, in the order of their names. */
	readonly apis: readonly Api[];
	/**
	 * What the agent's programs import, in the order tau.json's `exposes` lists it: an API, or a
	 * package of the tau's own; without the list, every API.
	 */
	readonly exposed: readonly Exposed[];
	/** Each directory in `skills/` that holds a `SKILL.md`, in the order of their names. */
	readonly skills: readonly Skill[];
	/**
	 * The command the backend runs, with `sh -c`, before the agent, which may do the run
	 * without it (docs/spec/init.md), as tau.json gives it; undefined without one. `expand` expands it.
	 */
	readonly init: string | undefined;
	/**
	 * The client's side of a run: `call`, as a caller gives it (docs/spec/calls.md), checked against
	 * the tau, each path resolved against `cwd`. Throws TypeError, listing every problem.
	 */
	resolve(call: unknown, cwd: string): ResolvedCall;
	/**
	 * The backend's side: an envelope from a client it does not trust, its form checked,
	 * checked against the tau: each file's mode and kind, each extra file's name, and the args.
	 * Throws TypeError, listing every problem.
	 */
	check(envelope: Envelope): Envelope;
	/**
	 * What the agent is given: the args, the prompt and init of `call`, a call `resolve` or `check`
	 * gave, their placeholders expanded (docs/spec/placeholders.md), with `places`, where the agent
	 * sees each file, by name, and `self`, where it sees the tau's own directory, by default `dir`.
	 * Throws TypeError for a file with no place, or args whose placeholders do not expand, which
	 * `resolve` and `check` refuse.
	 */
	expand(call: Envelope, places: { readonly [name: string]: string }, self?: string): Expanded;
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

/**
 * The tau at `dir`: its PROMPT.md, and its tau.json if it has one (without it, the tau takes no
 * files and no args). Throws, naming the file and the reason, when tau.json breaks the spec or the
 * prompt names what it cannot, and, listing every one, for a symlink that breaks the spec in what a
 * runtime reads, node_modules/ included when the tau exposes a package of its own, and then for
 * what the tau exposes that breaks the spec, its packages' APIs included. It reads nothing of
 * `.tau/`, type-checks neither the APIs nor the packages, and loads no TypeScript.
 */
export function loadTau(dir: string): Tau {
	const absolute = path.resolve(dir);
	const promptFile = path.join(absolute, "PROMPT.md");
	if (!existsSync(promptFile)) throw new Error(`${absolute}: not a tau (no PROMPT.md)`);
	const metadataFile = path.join(absolute, "tau.json");
	const metadata = existsSync(metadataFile) ? readMetadata(metadataFile) : undefined;
	const { description, files = {}, args, validate, apis: named, exposes, init } = metadata ?? {};
	const declared: Declared = {
		files,
		declaredArgs: new Set(Object.keys(isObject(args?.properties) ? args.properties : {})),
		validate,
	};
	const prompt = readFileSync(promptFile, "utf8");
	let template: Template;
	try {
		const scope = scopeOf(files, declared.declaredArgs, {}, [], []);
		const unknown = `neither \${${SELF}}, a file, nor an arg the schema declares in its properties`;
		template = parseTemplate(prompt, (inside) => placeholderProblem(inside, scope, unknown), (line) => `line ${line}`);
	} catch (error) {
		throw new Error(`${promptFile}: ${messageOf(error)}`);
	}
	let command: Template | undefined;
	try {
		const scope = scopeOf(files, new Set(), {}, [], []);
		const unknown = `neither \${${SELF}} nor a file: init reads the args through the tau API`;
		command = init === undefined ? undefined : parseTemplate(init, (inside) => placeholderProblem(inside, scope, unknown), () => "`init`");
	} catch (error) {
		throw new Error(`${metadataFile}: ${messageOf(error)}`);
	}
	const apis = apisOf(named);
	const problems = linkProblems(absolute, exposes?.some((specifier) => !Object.hasOwn(named ?? {}, specifier)) ?? false);
	if (problems.length > 0) throw new Error(`${absolute}: breaks the spec:\n  ${problems.join("\n  ")}`);
	const root = realpathSync(absolute);
	const exposed = readExposed(root, exposes, apis, problems);
	if (problems.length > 0) throw new Error(`${absolute}: breaks the spec:\n  ${problems.join("\n  ")}`);

	return {
		dir: absolute,
		description,
		prompt,
		files,
		args,
		apis,
		exposed,
		skills: readSkills(absolute),
		init,
		resolve: (call, cwd) => resolveCall(declared, call, cwd),
		check: (envelope) => checkEnvelope(declared, envelope),
		expand(call, places, self = absolute) {
			for (const name of Object.keys(call.files)) if (typeof places[name] !== "string") throw new TypeError(`${name}: has no place`);
			const placeOf = (name: string): string => (name === SELF ? self : (places[name] as string));
			const run = expansion(call.args, scopeOfCall(declared, call), placeOf);
			if (run.problems.length > 0) throw new TypeError(`the args do not expand:\n  ${run.problems.join("\n  ")}`);
			return {
				prompt: run.text(template),
				args: run.args,
				init: command === undefined ? undefined : expand(command, ([first = ""]) => shellWord(placeOf(first))),
			};
		},
	};
}

function readSkills(dir: string): Skill[] {
	const skillsDir = path.join(dir, "skills");
	if (!existsSync(skillsDir)) return [];
	return readdirSync(skillsDir)
		.sort()
		.map((name) => ({ name, dir: path.join(skillsDir, name) }))
		.filter((skill) => statSync(path.join(skill.dir, "SKILL.md"), { throwIfNoEntry: false })?.isFile() === true);
}
