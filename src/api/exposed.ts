import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { type Api, apiPaths, format, memoryHost, message, OPTIONS, packageDescription } from "./api.js";
import { inside } from "../tau/links.js";
import { API_SCOPE, type Tau } from "../tau/tau.js";

/** What a tau exposes to the agent's programs (docs/spec/packages.md): one of its APIs, or a package of its own. */
export type Exposed =
	| {
			readonly kind: "api";
			/** `@api/<name>`. */
			readonly specifier: string;
			readonly description: string | undefined;
			readonly api: Api;
	  }
	| {
			readonly kind: "package";
			/** The package's name, which programs import. */
			readonly specifier: string;
			/** Its declarations' package documentation, or else its package.json's `description`. */
			readonly description: string | undefined;
			/** `node_modules/<name>` in the tau, absolute: where Node.js finds it. */
			readonly dir: string;
	  };

type ExposedPackage = Extract<Exposed, { kind: "package" }>;

/** Why a module could not be resolved: TS2307, TS2792, or TS7016 for one without declarations. */
const UNRESOLVED = new Set([2307, 2792, 7016]);

/**
 * What the tau's programs import, in the order tau.json's `exposes` lists it; without the list,
 * every API in `apis`, which `loadApis` gave. Each `@api/<name>` it lists is an API of the tau, and
 * each other name a package in its node_modules/, whose declarations TypeScript checks as it checks
 * API files, with each `@api/<name>` typed by `api/<name>/index.d.ts`: it must find no errors in the
 * packages' own files, and every import it follows from them must resolve to a file in the tau. No
 * node_modules/ in the tau holds an `@api` scope, which would hide the runtime's implementation.
 * The packages' JavaScript is the author's to keep to the spec. Throws, listing every problem.
 */
export function loadExposed(tau: Tau, apis: readonly Api[]): Exposed[] {
	const toExpose = (api: Api): Exposed => ({ kind: "api", specifier: api.specifier, description: api.description, api });
	if (tau.exposes === undefined) return apis.map(toExpose);
	const root = realpathSync(tau.dir);
	const declared = new Map(apis.map((api) => [api.specifier, api]));
	const problems: string[] = [];
	const exposed: Exposed[] = [];
	for (const specifier of tau.exposes) {
		if (specifier.startsWith(API_SCOPE)) {
			const api = declared.get(specifier);
			if (api === undefined) problems.push(`exposes ${specifier}, but the tau has no api/${specifier.slice(API_SCOPE.length)}/index.d.ts`);
			else exposed.push(toExpose(api));
			continue;
		}
		const dir = path.join(root, "node_modules", ...specifier.split("/"));
		if (!existsSync(path.join(dir, "package.json"))) problems.push(`exposes ${specifier}, which is not a package in node_modules/`);
		else exposed.push({ kind: "package", specifier, description: undefined, dir });
	}
	const packages = exposed.filter((entry): entry is ExposedPackage => entry.kind === "package");
	if (packages.length > 0) {
		problems.push(...apiScopes(root).map((scope) => `${scope}: an @api scope in the tau would hide the runtime's implementations`));
		problems.push(...checkPackages(root, apis, packages, exposed));
	}
	if (problems.length > 0) throw new Error(`${root}: what it exposes breaks the spec:\n  ${problems.join("\n  ")}`);
	return exposed;
}

/**
 * Type-check the packages as API files are, with `@api/<name>` typed by `api/<name>/index.d.ts`, each
 * package's description put in `exposed`; the problems found.
 */
function checkPackages(root: string, apis: readonly Api[], packages: readonly ExposedPackage[], exposed: Exposed[]): string[] {
	const options: ts.CompilerOptions = { ...OPTIONS, paths: apiPaths(path.join(root, "api")) };
	// Imports every package as a program would.
	const importer = path.join(root, "__tau_exposed__.mts");
	const imports = packages.map((entry, index) => `import type * as package${index} from ${JSON.stringify(entry.specifier)};`);
	// What a program of its own brings is the environment's, not the tau's.
	const empty = path.join(root, "__tau_environment__.mts");
	const host = memoryHost(
		new Map([
			[importer, imports.join("\n")],
			[empty, ""],
		]),
	);
	const environment = ts.createProgram({ rootNames: [empty], options, host });
	const ambient = new Set(environment.getSourceFiles().map((file) => file.fileName));
	const program = ts.createProgram({ rootNames: [importer], options, host, oldProgram: environment });

	const where = (file: string): string => path.relative(root, file);
	const problems = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()].map((d) => format(d, where));
	/** Each package's own files: its folder, but not the packages it holds in a node_modules/ of its own. */
	const owners = packages.map((entry) => realpathSync(entry.dir));
	const own = (file: string): boolean =>
		owners.some((dir) => inside(file, dir) && !path.relative(dir, file).split(path.sep).includes("node_modules"));
	const apiFolders = apis.map((api) => realpathSync(path.dirname(api.file)));
	for (const source of program.getSourceFiles()) {
		if (ambient.has(source.fileName)) continue;
		const diagnostics = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
		if (source.fileName === importer) {
			for (const diagnostic of diagnostics) {
				const line = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line;
				problems.push(`${(packages[line] as ExposedPackage).specifier}: ${message(diagnostic)}`);
			}
			continue;
		}
		const real = realpathSync(source.fileName);
		if (!inside(real, root)) problems.push(`the packages reach ${real}, which lies outside the tau`);
		// The API files are loadApis's to check; other packages' types are taken as they are, but for what they import.
		else if (apiFolders.some((folder) => inside(real, folder))) continue;
		else problems.push(...diagnostics.filter((d) => own(real) || UNRESOLVED.has(d.code)).map((d) => format(d, where)));
	}

	for (const [index, entry] of exposed.entries()) {
		if (entry.kind !== "package") continue;
		const types = ts.resolveModuleName(entry.specifier, importer, options, host, undefined, undefined, ts.ModuleKind.ESNext)
			.resolvedModule?.resolvedFileName;
		const manifest = JSON.parse(readFileSync(path.join(entry.dir, "package.json"), "utf8")) as { description?: unknown };
		const description =
			(types === undefined ? undefined : packageDescription(readFileSync(types, "utf8"))) ??
			(typeof manifest.description === "string" && manifest.description !== "" ? manifest.description : undefined);
		exposed[index] = { ...entry, description };
	}
	return problems;
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
