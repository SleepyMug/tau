import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/** An API of a tau: a contract its code calls, which `apis` in tau.json names with a range (docs/spec/apis.md). */
export interface Api {
	/** The contract's name, an npm package's, by which programs import it. */
	readonly name: string;
	/** The versions of it the tau works with: `^` and a version. */
	readonly range: string;
	/** The range's version, which an implementation's must serve. */
	readonly version: string;
}

/** What a tau exposes to the agent's programs (docs/spec/packages.md): one of its APIs, or a package of its own. */
export type Exposed =
	| {
			readonly kind: "api";
			/** The contract's name, which programs import. */
			readonly specifier: string;
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

/** An npm package's name, scoped or not, as a contract's is. */
export const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
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

/** The version a range gives, `1.2.0` for `^1.2.0`, or undefined when it is not a range: `^` and a version (docs/spec/apis.md). */
export function rangeVersion(range: string): string | undefined {
	return range.startsWith("^") && parseVersion(range.slice(1)) !== undefined ? range.slice(1) : undefined;
}

/** Whether `version` is within `range`: whether it serves the version the range gives. Throws TypeError for what is not a range. */
export function within(version: string, range: string): boolean {
	const wanted = rangeVersion(range);
	if (wanted === undefined) throw new TypeError(`${JSON.stringify(range)} is not a range, ^ and a version`);
	return serves(version, wanted);
}

/**
 * How two versions compare, by SemVer 2.0.0's precedence: negative when `a` is older than `b`,
 * positive when newer, 0 when neither, build metadata aside. Throws TypeError for what is not a version.
 */
export function compareVersions(a: string, b: string): number {
	const [x, y] = [parseVersion(a), parseVersion(b)];
	if (x === undefined) throw new TypeError(`${JSON.stringify(a)} is not a SemVer version`);
	if (y === undefined) throw new TypeError(`${JSON.stringify(b)} is not a SemVer version`);
	const order = x.major - y.major || x.minor - y.minor || x.patch - y.patch;
	if (order !== 0) return order;
	if (x.prerelease === undefined || y.prerelease === undefined) return (x.prerelease === undefined ? 1 : 0) - (y.prerelease === undefined ? 1 : 0);
	const [xs, ys] = [x.prerelease.split("."), y.prerelease.split(".")];
	for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
		const [p, q] = [xs[i] as string, ys[i] as string];
		const [pn, qn] = [/^\d+$/u.test(p), /^\d+$/u.test(q)];
		if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
		if (pn !== qn) return pn ? -1 : 1;
		if (p !== q) return p < q ? -1 : 1;
	}
	return xs.length - ys.length;
}

/**
 * Whether an implementation of a contract at `version` serves an API whose range gives `held`
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
 * The APIs `apis` in tau.json names, each a contract's name and a range, in the order of their
 * names; none without it. tau.json's reader checks each name and range.
 */
export function apisOf(apis: { readonly [name: string]: string } | undefined): Api[] {
	return Object.entries(apis ?? {})
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name, range]) => ({ name, range, version: rangeVersion(range) as string }));
}

/**
 * What the tau whose real directory is `root` exposes, as `exposes` lists it; without the list,
 * every API in `apis`. Each name it lists is one of the tau's APIs, or else a package in its
 * node_modules/, with a package.json, which names in `tau.apis` the APIs it imports, each one of
 * the tau's, at a range whose version serves the package's. No node_modules/ in the tau holds a
 * package named as one of its APIs, which would hide the runtime's implementation. Each problem
 * is pushed to `problems`.
 */
export function readExposed(root: string, exposes: readonly string[] | undefined, apis: readonly Api[], problems: string[]): Exposed[] {
	const toExpose = (api: Api): Exposed => ({ kind: "api", specifier: api.name, api });
	if (exposes === undefined) return apis.map(toExpose);
	const declared = new Map(apis.map((api) => [api.name, api]));
	const exposed: Exposed[] = [];
	for (const specifier of exposes) {
		const api = declared.get(specifier);
		if (api !== undefined) {
			exposed.push(toExpose(api));
			continue;
		}
		const dir = path.join(root, "node_modules", ...specifier.split("/"));
		let manifest: { description?: unknown; tau?: unknown };
		try {
			manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { description?: unknown; tau?: unknown };
		} catch {
			problems.push(`exposes ${specifier}, which is neither one of its APIs nor a package in node_modules/`);
			continue;
		}
		problems.push(...packageApiProblems(specifier, manifest.tau, declared));
		const { description } = manifest;
		exposed.push({
			kind: "package",
			specifier,
			description: typeof description === "string" && description.trim() !== "" ? description : undefined,
			dir,
		});
	}
	if (apis.length > 0 && exposed.some((entry) => entry.kind === "package"))
		problems.push(...shadows(root, apis).map((at) => `${at}: is named as an API of the tau, whose implementation it would hide`));
	return exposed;
}

/** Why the `tau` of the package `name`'s package.json does not fit the tau's APIs, `declared`, by name. */
function packageApiProblems(name: string, tau: unknown, declared: ReadonlyMap<string, Api>): string[] {
	if (tau === undefined) return [];
	const at = `node_modules/${name}/package.json`;
	const apis = typeof tau === "object" && tau !== null && !Array.isArray(tau) ? (tau as { apis?: unknown }).apis : undefined;
	if (apis === undefined) return [];
	if (typeof apis !== "object" || apis === null || Array.isArray(apis)) return [`${at}: \`tau.apis\` must be an object, from each API's name to a range`];
	const problems: string[] = [];
	for (const [api, range] of Object.entries(apis)) {
		const version = typeof range === "string" ? rangeVersion(range) : undefined;
		if (!PACKAGE_NAME.test(api) || version === undefined) {
			problems.push(`${at}: \`tau.apis\`: ${JSON.stringify(api)}: ${JSON.stringify(range)} is not a contract's name and a range, ^ and a version`);
			continue;
		}
		const held = declared.get(api);
		if (held === undefined) problems.push(`${at}: imports the API ${api}, which the tau's \`apis\` does not name`);
		else if (!serves(held.version, version))
			problems.push(`${at}: needs ${api}@${range as string}, which the tau's ${held.range} does not give`);
	}
	return problems;
}

/** Each package or symlink in a node_modules/ under the tau's own named as one of `apis`, relative to the tau. */
function shadows(root: string, apis: readonly Api[]): string[] {
	const names = new Set(apis.map((api) => api.name));
	const found: string[] = [];
	const walked = new Set<string>();
	const isDir = (file: string): boolean => statSync(file, { throwIfNoEntry: false })?.isDirectory() === true;
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
		const inModules = path.basename(dir) === "node_modules";
		for (const entry of readdirSync(real, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const file = path.join(dir, entry.name);
			if (inModules) {
				if (names.has(entry.name)) {
					found.push(path.relative(root, file));
					continue;
				}
				if (entry.name.startsWith("@") && isDir(file))
					for (const inner of readdirSync(file).sort())
						if (names.has(`${entry.name}/${inner}`)) found.push(path.relative(root, path.join(file, inner)));
			}
			if (entry.isDirectory() || (entry.isSymbolicLink() && isDir(file))) walk(file);
		}
	};
	walk(path.join(root, "node_modules"));
	return [...new Set(found)].sort();
}
