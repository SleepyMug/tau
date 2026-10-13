import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/** How the agent's programs import an API: `@api/<alias>` (docs/spec/apis.md). */
export const API_SCOPE = "@api/";

/** An API of a tau: `api/<alias>/`, a copy of a contract (docs/spec/apis.md). */
export interface Api {
	/** Its directory's name, by which programs import it. */
	readonly alias: string;
	/** What programs import it as: `@api/<alias>`. */
	readonly specifier: string;
	/** `api/<alias>/`, absolute, which holds its `package.json` and its declarations, `index.d.ts` first. */
	readonly dir: string;
	/** The contract's name, its package's. */
	readonly contract: string;
	/** The contract's version, which an implementation's must serve. */
	readonly version: string;
	/** What the contract is, as its `package.json` says. */
	readonly description: string;
}

/** What a tau exposes to the agent's programs (docs/spec/packages.md): one of its APIs, or a package of its own. */
export type Exposed =
	| {
			readonly kind: "api";
			/** `@api/<alias>`. */
			readonly specifier: string;
			readonly description: string;
			readonly api: Api;
	  }
	| {
			readonly kind: "package";
			/** The package's name, which programs import. */
			readonly specifier: string;
			/** Its package.json's `description`, if it has one. */
			readonly description: string | undefined;
			/** `node_modules/<name>` in the tau, absolute: where Node.js finds it. */
			readonly dir: string;
	  };

/** A contract's identity, and what it is, as its package.json gives them (docs/spec/contracts.md). */
export interface Contract {
	readonly name: string;
	readonly version: string;
	readonly description: string;
}

/** What an alias may be. */
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
/** An npm package's name, scoped or not. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
/** SemVer 2.0.0's own expression for a version. */
const VERSION =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/u;
/** What types a contract, in its directory. */
const INDEX = "index.d.ts";

/** A version's parts, its build metadata aside. */
interface Version {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	readonly prerelease: string | undefined;
}

/** `version`'s parts, or undefined when it is not a SemVer 2.0.0 version. */
export function parseVersion(version: string): Version | undefined {
	const match = VERSION.exec(version);
	if (match === null) return undefined;
	const [, major, minor, patch, prerelease] = match;
	return { major: Number(major), minor: Number(minor), patch: Number(patch), prerelease };
}

/**
 * Whether an implementation of a contract at `version` serves an API whose copy is at `held`
 * (docs/spec/contracts.md): with a major of 1 or more, the same major and a minor no less; with a
 * major of 0, the same minor too; with a prerelease, only itself, build metadata aside. Throws
 * TypeError for what is not a version.
 */
export function serves(version: string, held: string): boolean {
	const given = parseVersion(version);
	const wanted = parseVersion(held);
	if (given === undefined) throw new TypeError(`${JSON.stringify(version)} is not a SemVer version`);
	if (wanted === undefined) throw new TypeError(`${JSON.stringify(held)} is not a SemVer version`);
	if (given.prerelease !== undefined)
		return (
			given.major === wanted.major &&
			given.minor === wanted.minor &&
			given.patch === wanted.patch &&
			given.prerelease === wanted.prerelease
		);
	if (given.major !== wanted.major) return false;
	return given.major === 0 ? given.minor === wanted.minor : given.minor >= wanted.minor;
}

/**
 * The contract whose package.json is in `dir`, as docs/spec/contracts.md has it: its `name`, an npm
 * package's, its `version`, its `description`, not blank, `tau`, `{ "contract": true }`, `type`,
 * `module`, and `types`, `./index.d.ts`. Throws TypeError, listing every problem.
 */
export function readContract(dir: string): Contract {
	const file = path.join(dir, "package.json");
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new TypeError(`${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const problems = contractProblems(json);
	if (problems.length > 0) throw new TypeError(`${file}: not a contract's:\n  ${problems.join("\n  ")}`);
	const { name, version, description } = json as Contract;
	return { name, version, description };
}

function contractProblems(json: unknown): string[] {
	if (typeof json !== "object" || json === null || Array.isArray(json)) return ["must be an object"];
	const { name, version, description, tau, type, types } = json as Record<string, unknown>;
	const problems: string[] = [];
	if (typeof name !== "string" || !PACKAGE_NAME.test(name) || name.length > 214)
		problems.push("`name` must be an npm package's name, the contract's");
	if (typeof version !== "string" || parseVersion(version) === undefined)
		problems.push("`version` must be a SemVer 2.0.0 version");
	if (typeof description !== "string" || description.trim() === "")
		problems.push("`description` must say what the contract is, a string that is not blank");
	if (typeof tau !== "object" || tau === null || (tau as { contract?: unknown }).contract !== true)
		problems.push('`tau` must be { "contract": true }');
	if (type !== "module") problems.push("`type` must be module: a contract's declarations are an ES module's");
	if (typeof types !== "string" || path.posix.normalize(types) !== INDEX) problems.push(`\`types\` must be ./${INDEX}`);
	return problems;
}

/**
 * The APIs of the tau whose real directory is `root`, each a directory in `api/`, which holds
 * nothing else, named by its alias, and holding a contract's package.json, its `index.d.ts`, and
 * no file but declaration files, no two the same contract; none without `api/`. Each problem is
 * pushed to `problems`, relative to the tau.
 */
export function readApis(root: string, problems: string[]): Api[] {
	const apiDir = path.join(root, "api");
	if (!existsSync(apiDir)) return [];
	const apis: Api[] = [];
	const aliases = new Map<string, string>();
	for (const alias of readdirSync(apiDir).sort()) {
		const dir = path.join(apiDir, alias);
		const at = `api/${alias}`;
		if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
			problems.push(`${at}: api/ holds only APIs, each a directory with a contract's package.json`);
			continue;
		}
		if (!ALIAS.test(alias)) problems.push(`${at}: an API's alias matches ${ALIAS.source}`);
		if (!existsSync(path.join(dir, "package.json"))) {
			problems.push(`${at}: holds no package.json, a contract's`);
			continue;
		}
		let contract: Contract;
		try {
			contract = readContract(dir);
		} catch (error) {
			problems.push((error as Error).message.replace(dir, at));
			continue;
		}
		if (!statSync(path.join(dir, INDEX), { throwIfNoEntry: false })?.isFile()) problems.push(`${at}: holds no ${INDEX}`);
		for (const file of strayFiles(dir)) problems.push(`${at}/${file}: an API holds only its package.json and declaration files`);
		const other = aliases.get(contract.name);
		if (other !== undefined) problems.push(`${at}: holds ${contract.name}, as api/${other} does; a tau holds a contract once`);
		else aliases.set(contract.name, alias);
		apis.push({
			alias,
			specifier: API_SCOPE + alias,
			dir,
			contract: contract.name,
			version: contract.version,
			description: contract.description,
		});
	}
	return apis;
}

/** The files under `dir`, relative to it, that are neither its package.json nor declaration files. */
function strayFiles(dir: string): string[] {
	const stray: string[] = [];
	const walk = (folder: string, prefix: string): void => {
		for (const entry of readdirSync(folder).sort()) {
			const file = path.join(folder, entry);
			const relative = prefix + entry;
			if (statSync(file, { throwIfNoEntry: false })?.isDirectory()) walk(file, `${relative}/`);
			else if (relative !== "package.json" && !entry.endsWith(".d.ts")) stray.push(relative);
		}
	};
	walk(dir, "");
	return stray;
}

/**
 * What the tau whose real directory is `root` exposes, as `exposes` lists it; without the list,
 * every API in `apis`. Each `@api/<alias>` it lists is an API of the tau, and each other name a
 * package in its node_modules/, with a package.json, and no node_modules/ in the tau holds an
 * `@api` scope, which would hide the runtime's implementations. Each problem is pushed to
 * `problems`.
 */
export function readExposed(root: string, exposes: readonly string[] | undefined, apis: readonly Api[], problems: string[]): Exposed[] {
	const toExpose = (api: Api): Exposed => ({ kind: "api", specifier: api.specifier, description: api.description, api });
	if (exposes === undefined) return apis.map(toExpose);
	const declared = new Map(apis.map((api) => [api.specifier, api]));
	const exposed: Exposed[] = [];
	for (const specifier of exposes) {
		if (specifier.startsWith(API_SCOPE)) {
			const api = declared.get(specifier);
			if (api === undefined) problems.push(`exposes ${specifier}, but the tau has no api/${specifier.slice(API_SCOPE.length)}/`);
			else exposed.push(toExpose(api));
			continue;
		}
		const dir = path.join(root, "node_modules", ...specifier.split("/"));
		let manifest: { description?: unknown };
		try {
			manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { description?: unknown };
		} catch {
			problems.push(`exposes ${specifier}, which is not a package in node_modules/`);
			continue;
		}
		const { description } = manifest;
		exposed.push({
			kind: "package",
			specifier,
			description: typeof description === "string" && description.trim() !== "" ? description : undefined,
			dir,
		});
	}
	if (exposed.some((entry) => entry.kind === "package"))
		problems.push(...apiScopes(root).map((scope) => `${scope}: an @api scope in the tau would hide the runtime's implementations`));
	return exposed;
}

/** Each `@api` scope in a node_modules/ under the tau's own, relative to the tau. */
function apiScopes(root: string): string[] {
	const found: string[] = [];
	const walked = new Set<string>();
	const walk = (dir: string): void => {
		let real: string;
		try {
			real = realpathSync(dir);
		} catch {
			// loadTau reports a symlink that leads nowhere.
			return;
		}
		if (walked.has(real)) return;
		walked.add(real);
		for (const entry of readdirSync(real, { withFileTypes: true })) {
			const file = path.join(real, entry.name);
			if (!(entry.isDirectory() || (entry.isSymbolicLink() && statSync(file, { throwIfNoEntry: false })?.isDirectory())))
				continue;
			if (entry.name === API_SCOPE.slice(0, -1) && path.basename(real) === "node_modules") found.push(path.relative(root, file));
			else walk(file);
		}
	};
	walk(path.join(root, "node_modules"));
	return found.sort();
}
