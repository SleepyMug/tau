import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import ts from "typescript";
import { COMPILER_OPTIONS } from "./read-manifest.js";

/** A package a tau ships in `modules/<dir>/`, checked against the spec. */
export interface Module {
	/** The package name, which programs import it by. */
	readonly name: string;
	/** The package.json `description`. */
	readonly description: string | undefined;
	/** The package's absolute directory, as the tau names it (it may be a symlink). */
	readonly root: string;
}

/** Every `modules/<dir>/` of the tau at `dir`; none when there is no modules/. Symlinks are followed. */
export function loadModules(dir: string): Module[] {
	const modulesDir = path.join(dir, "modules");
	if (!existsSync(modulesDir)) return [];
	const modules = readdirSync(modulesDir)
		.filter((name) => statSync(path.join(modulesDir, name)).isDirectory())
		.sort()
		.map((name) => loadModule(path.join(modulesDir, name)));
	const seen = new Map<string, string>();
	for (const module of modules) {
		const other = seen.get(module.name);
		if (other !== undefined) throw new Error(`${module.root}: package name ${module.name} is also used by ${other}`);
		seen.set(module.name, module.root);
	}
	return modules;
}

/** npm's rule for package names, scoped or not. */
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u;

/**
 * One module: a package with a `name`, `exports` and type declarations for its `"."` entry.
 * Throws, naming the package and the reason. Whether its imports resolve is `checkModule`'s job.
 */
export function loadModule(root: string): Module {
	const absolute = path.resolve(root);
	try {
		const { name, description, exports } = packageJson(absolute);
		if (typeof name !== "string" || !PACKAGE_NAME.test(name)) throw new TypeError("package.json needs a valid `name`");
		if (name.startsWith("@svc/")) throw new TypeError(`package name ${name}: the @svc/ scope is reserved for services`);
		if (description !== undefined && typeof description !== "string")
			throw new TypeError("package.json `description` must be a string");
		if (exports === undefined) throw new TypeError("package.json needs `exports`");
		if (resolve(name, entryImporter(absolute), TYPES, ts.ModuleKind.ESNext) === undefined)
			throw new TypeError(`${name} has no type declarations for its "." export`);
		return { name, description, root: absolute };
	} catch (error) {
		throw new Error(`${absolute}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Whether a module works as the tau ships it. From each entry point (every subpath of `exports`,
 * as JavaScript and as declarations), every import is followed the way Node and TypeScript
 * resolve it from the importing file's real location: each must be a Node builtin or resolve to a
 * file, and none may be a native addon. Files no entry point reaches are not looked at. Throws,
 * listing every problem.
 */
export function checkModule(module: Module): void {
	const problems: string[] = [];
	const realRoot = realpathSync(module.root);
	const where = (file: string): string => {
		const relative = path.relative(realRoot, file);
		return relative.startsWith("..") || path.isAbsolute(relative) ? file : relative;
	};
	const queue: string[] = [];
	const seen = new Set<string>();
	const follow = (file: string): void => {
		const real = realpathSync(file);
		if (!seen.has(real)) {
			seen.add(real);
			queue.push(real);
		}
	};

	const importer = entryImporter(module.root);
	for (const subpath of exportedSubpaths(packageJson(module.root).exports)) {
		const specifier = module.name + subpath.slice(1);
		const types = resolve(specifier, importer, TYPES, ts.ModuleKind.ESNext);
		const code = resolve(specifier, importer, JAVASCRIPT, ts.ModuleKind.ESNext);
		if (types === undefined) problems.push(`"${specifier}" has no type declarations`);
		else follow(types);
		if (code === undefined) problems.push(`"${specifier}" does not resolve to JavaScript`);
		else follow(code);
	}

	for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
		if (!CODE.test(file)) continue;
		const options = DECLARATIONS.test(file) ? TYPES : JAVASCRIPT;
		const mode = ts.getImpliedNodeFormatForFile(file, undefined, ts.sys, options);
		const { importedFiles, referencedFiles, typeReferenceDirectives } = ts.preProcessFile(
			readFileSync(file, "utf8"),
			true,
			true,
		);
		for (const { fileName: specifier } of importedFiles) {
			if (isBuiltin(specifier)) continue;
			if (specifier.endsWith(".node")) {
				problems.push(`${where(file)}: imports the native addon "${specifier}"; a module must be pure JavaScript`);
				continue;
			}
			const resolved = resolve(specifier, file, options, mode);
			if (resolved === undefined) problems.push(`${where(file)}: cannot resolve "${specifier}"`);
			else follow(resolved);
		}
		for (const { fileName } of referencedFiles) {
			const target = path.resolve(path.dirname(file), fileName);
			if (existsSync(target)) follow(target);
			else problems.push(`${where(file)}: refers to "${fileName}", which does not exist`);
		}
		for (const { fileName } of typeReferenceDirectives) {
			// Node's own types come with the runtime.
			if (fileName === "node") continue;
			const resolved = ts.resolveTypeReferenceDirective(fileName, file, TYPES, ts.sys).resolvedTypeReferenceDirective;
			if (resolved?.resolvedFileName === undefined) problems.push(`${where(file)}: cannot resolve types "${fileName}"`);
			else follow(resolved.resolvedFileName);
		}
	}
	if (problems.length > 0) throw new Error(`${module.root}: does not work as it is:\n  ${problems.join("\n  ")}`);
}

const CODE = /\.(?:[mc]?js|d\.[mc]?ts)$/u;
const DECLARATIONS = /\.d\.[mc]?ts$/u;
const TYPESCRIPT = /\.[mc]?ts$/u;

/** How declarations are resolved: TypeScript's NodeNext rules. */
const TYPES: ts.CompilerOptions = { ...COMPILER_OPTIONS, types: [] };
/**
 * How JavaScript is resolved: NodeNext without declaration files, which is Node's own resolution.
 * `noDtsResolution` is not in TypeScript's public typings.
 */
const JAVASCRIPT: ts.CompilerOptions = { ...TYPES, allowJs: true, resolveJsonModule: true, noDtsResolution: true };

/**
 * The file `specifier` resolves to from `importer`. Looking for types, TypeScript falls back to a
 * package's JavaScript when it has no declarations; that counts as not found.
 */
function resolve(
	specifier: string,
	importer: string,
	options: ts.CompilerOptions,
	mode: ts.ResolutionMode,
): string | undefined {
	const file = ts.resolveModuleName(specifier, importer, options, ts.sys, undefined, undefined, mode).resolvedModule
		?.resolvedFileName;
	return options === TYPES && file !== undefined && !TYPESCRIPT.test(file) ? undefined : file;
}

/** A file inside the package, as ESM, so its own name resolves through `exports`. */
function entryImporter(root: string): string {
	return path.join(root, "__tau_module__.mts");
}

/** The subpaths `exports` names: `"."` for a single entry, and no patterns. */
function exportedSubpaths(exports: unknown): string[] {
	if (typeof exports !== "object" || exports === null || Array.isArray(exports)) return ["."];
	const subpaths = Object.keys(exports).filter((key) => key.startsWith("."));
	return subpaths.length === 0 ? ["."] : subpaths.filter((key) => !key.includes("*"));
}

function packageJson(root: string): Record<string, unknown> {
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
	} catch (error) {
		throw new TypeError(`${path.basename(root)} is not a package: ${(error as Error).message}`);
	}
	if (typeof json !== "object" || json === null || Array.isArray(json))
		throw new TypeError("package.json must be an object");
	return json as Record<string, unknown>;
}
