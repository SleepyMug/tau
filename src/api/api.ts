import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import { inside } from "../tau/links.js";
import { API_SCOPE } from "../tau/tau.js";

/** An API a tau declares in its directory `api/<name>/`, checked against the spec. */
export interface Api {
	/** Its directory's name. */
	readonly name: string;
	/** What programs import it as: `@api/<name>`. */
	readonly specifier: string;
	/**
	 * `api/<name>/index.d.ts`, absolute: what types `@api/<name>`, its imports resolving from there.
	 * The directory it is in holds the API's every file.
	 */
	readonly file: string;
	/** Its TSDoc package documentation. */
	readonly description: string | undefined;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
/** What types an API, in its directory. */
const INDEX = "index.d.ts";

const require = createRequire(import.meta.url);
/** Node.js's types: `@types/node`, which this package pins. */
const NODE_TYPES = path.dirname(path.dirname(require.resolve("@types/node/package.json")));

/** How API files are checked: strict, as Node.js resolves imports, on ES2022 and Node.js's types. */
export const OPTIONS: ts.CompilerOptions = {
	target: ts.ScriptTarget.ES2022,
	lib: ["lib.es2022.d.ts"],
	module: ts.ModuleKind.NodeNext,
	moduleResolution: ts.ModuleResolutionKind.NodeNext,
	strict: true,
	noEmit: true,
	types: ["node"],
	typeRoots: [NODE_TYPES],
};

/**
 * `@api/<name>` typed by `api/<name>/index.d.ts` in `apiDir`, the tau's api/, absolute: as the
 * tau's own code imports it, and a tsconfig.json's `paths` would have it.
 */
export function apiPaths(apiDir: string): ts.MapLike<string[]> {
	return { [`${API_SCOPE}*`]: [path.join(apiDir, "*", INDEX)] };
}

/**
 * Every API of the tau at `dir`, by name: each a directory `api/<name>/`, which `api/` holds
 * nothing but; none when there is no api/. TypeScript checks their files as one project, with each
 * `@api/<name>` typed by `api/<name>/index.d.ts`: it must find no errors, and each `index.d.ts` must
 * be a module programs can import. An API's files lie in its directory and import one another by
 * relative paths, and beyond them, only other APIs of the tau, as `@api/<name>`, and Node.js's own
 * modules, whose types, with the ES library, are the environment's. Throws, listing every problem.
 */
export function loadApis(dir: string): Api[] {
	const root = realpathSync(path.resolve(dir));
	const apiDir = path.join(root, "api");
	if (!existsSync(apiDir)) return [];
	const problems: string[] = [];
	const apis: Api[] = [];
	for (const entry of readdirSync(apiDir).sort()) {
		const folder = path.join(apiDir, entry);
		if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
			problems.push(`api/${entry}: api/ holds only APIs, each a directory with its ${INDEX}`);
			continue;
		}
		if (!NAME.test(entry)) problems.push(`api/${entry}: an API's name matches ${NAME.source}`);
		const file = path.join(folder, INDEX);
		if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
			problems.push(`api/${entry}: an API's directory holds its ${INDEX}`);
			continue;
		}
		apis.push({ name: entry, specifier: API_SCOPE + entry, file, description: packageDescription(readFileSync(file, "utf8")) });
	}
	if (apis.length > 0) problems.push(...checkApis(root, apis));
	if (problems.length > 0) throw new Error(`${root}: its APIs break the spec:\n  ${problems.join("\n  ")}`);
	return apis;
}

/** A module an API's file imports: the file, what it names, and the file that resolved to, if any. */
interface Import {
	readonly from: string;
	readonly specifier: string;
	readonly to: string | undefined;
}

/** What TypeScript finds wrong with `apis`, and what they reach, or import, that they may not. */
function checkApis(root: string, apis: readonly Api[]): string[] {
	const apiDir = path.join(root, "api");
	const options: ts.CompilerOptions = { ...OPTIONS, paths: apiPaths(apiDir) };
	// Imports every API as a program would, so one that is not a module fails here.
	const entry = path.join(apiDir, "__tau_apis__.mts");
	const imports = apis.map((api, index) => `import type * as api${index} from ${JSON.stringify(api.specifier)};`);
	// What a program of its own brings is the environment's, not the tau's.
	const empty = path.join(apiDir, "__tau_environment__.mts");
	const host = memoryHost(
		new Map([
			[entry, imports.join("\n")],
			[empty, ""],
		]),
	);
	const resolved: Import[] = [];
	host.resolveModuleNameLiterals = (literals, from, redirected, compilerOptions, source) =>
		literals.map((literal) => {
			const mode = ts.getModeForUsageLocation(source, literal, compilerOptions);
			const resolution = ts.resolveModuleName(literal.text, from, compilerOptions, host, undefined, redirected, mode);
			resolved.push({ from, specifier: literal.text, to: resolution.resolvedModule?.resolvedFileName });
			return resolution;
		});
	const environment = ts.createProgram({ rootNames: [empty], options, host });
	const ambient = new Set(environment.getSourceFiles().map((file) => file.fileName));
	const program = ts.createProgram({
		rootNames: [entry, ...apis.map((api) => realpathSync(api.file))],
		options,
		host,
		oldProgram: environment,
	});

	const where = (file: string): string => path.relative(root, file);
	const problems = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()].map((d) => format(d, where));
	// Each API's directory, as TypeScript names the files in it.
	const folders = apis.map((api) => realpathSync(path.dirname(api.file)));
	const indexes = new Map(apis.map((api) => [api.specifier, realpathSync(api.file)]));
	/** What an API imports that it may not, which is reported as such, and nothing more of it. */
	const refused = new Set<string>();
	for (const { from, specifier, to } of resolved) {
		const own = folders.filter((folder) => inside(from, folder));
		// Not an API's file; or TypeScript reports what did not resolve, or finds it among Node.js's own modules.
		if (own.length === 0 || to === undefined) continue;
		if (specifier.startsWith(API_SCOPE)) {
			if (to !== indexes.get(specifier)) problems.push(`${where(from)}: imports ${specifier}, which is not an API of the tau`);
		} else if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
			if (own.some((folder) => inside(to, folder))) continue;
			problems.push(`${where(from)}: imports ${specifier}, which lies outside its API's directory; it imports another API as @api/<name>`);
			refused.add(to);
		} else {
			problems.push(
				`${where(from)}: imports the package ${specifier}; an API imports no package but another API of the tau, as @api/<name>, and Node.js's own modules`,
			);
			refused.add(to);
		}
	}
	for (const source of program.getSourceFiles()) {
		if (ambient.has(source.fileName) || refused.has(source.fileName)) continue;
		const diagnostics = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
		if (source.fileName === entry) {
			for (const diagnostic of diagnostics) {
				const line = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line;
				const api = apis[line] as Api;
				problems.push(
					diagnostic.code === NOT_A_MODULE
						? `${where(api.file)}: is not a module, so programs cannot import it`
						: `${where(api.file)}: ${message(diagnostic)}`,
				);
			}
			continue;
		}
		const real = realpathSync(source.fileName);
		if (!inside(real, root)) problems.push(`the APIs reach ${real}, which lies outside the tau`);
		else if (!folders.some((folder) => inside(real, folder))) problems.push(`the APIs reach ${where(real)}, which lies in no API's directory`);
		else problems.push(...diagnostics.map((d) => format(d, where)));
	}
	return problems;
}

/**
 * Whether the module `implementation` implements `api`, as a runtime checks before linking it:
 * TypeScript must find its type assignable to the API's, so that each value the API exports, it
 * exports too, of a type that fits. It may export more. `implementation` is the module's file:
 * JavaScript with declarations where TypeScript finds them (`index.d.ts` for `index.js`), or the
 * declarations themselves. Throws, with TypeScript's reasons.
 */
export function checkImplementation(api: Api, implementation: string): void {
	const file = path.resolve(implementation);
	// CommonJS, which sees an ES module and a CommonJS one alike: as their exports, without the
	// `default` an ES module importing CommonJS would add.
	const check = path.join(path.dirname(api.file), "__tau_link__.cts");
	const text = [
		`import type * as Api from ${JSON.stringify(importPath(check, api.file))};`,
		`import type * as Implementation from ${JSON.stringify(importPath(check, file))};`,
		"declare const implementation: typeof Implementation;",
		"export const linked: typeof Api = implementation;",
	].join("\n");
	// The API is checked by loadApis, and the implementation is its provider's. The API may import others.
	const options = { ...OPTIONS, skipLibCheck: true, paths: apiPaths(path.dirname(path.dirname(api.file))) };
	const program = ts.createProgram({ rootNames: [check], options, host: memoryHost(new Map([[check, text]])) });
	const source = program.getSourceFile(check) as ts.SourceFile;
	const diagnostics = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
	if (diagnostics.length > 0)
		throw new Error(
			`${file}: does not implement ${api.specifier}:\n  ${diagnostics.map((d) => message(d)).join("\n  ")}`,
		);
}

/** TS2306: File '…' is not a module. */
const NOT_A_MODULE = 2306;

/** How `from` imports `file` under NodeNext: relative, declarations by the JavaScript they describe. */
function importPath(from: string, file: string): string {
	const relative = path.relative(path.dirname(from), file).replace(/(?:\.d)?\.([mc]?)ts$/u, ".$1js");
	return relative.startsWith(".") ? relative : `./${relative}`;
}

/**
 * The description in a declaration file's TSDoc package documentation: its first doc comment, when
 * that comment has the `@packageDocumentation` tag, up to any other tag.
 */
export function packageDescription(text: string): string | undefined {
	for (const range of ts.getLeadingCommentRanges(text, 0) ?? []) {
		const comment = text.slice(range.pos, range.end);
		if (!comment.startsWith("/**")) continue;
		if (!/@packageDocumentation\b/u.test(comment)) return undefined;
		const lines = comment
			.slice(3, -2)
			.replace(/@packageDocumentation\b/u, "")
			.split("\n")
			.map((line) => line.replace(/^\s*\*? ?/u, "").trimEnd());
		const end = lines.findIndex((line) => line.startsWith("@"));
		const description = (end === -1 ? lines : lines.slice(0, end)).join("\n").trim();
		return description === "" ? undefined : description;
	}
	return undefined;
}

/** A compiler host that serves `files` from memory and everything else from disk. */
export function memoryHost(files: ReadonlyMap<string, string>): ts.CompilerHost {
	const host = ts.createCompilerHost(OPTIONS);
	const base = { getSourceFile: host.getSourceFile, fileExists: host.fileExists, readFile: host.readFile };
	host.getSourceFile = (name, version, onError) => {
		const text = files.get(name);
		return text === undefined ? base.getSourceFile(name, version, onError) : ts.createSourceFile(name, text, version, true);
	};
	host.fileExists = (name) => files.has(name) || base.fileExists(name);
	host.readFile = (name) => files.get(name) ?? base.readFile(name);
	return host;
}

/** `file:line:column: message`, with `where` naming the file. */
export function format(diagnostic: ts.Diagnostic, where: (file: string) => string): string {
	const { file, start } = diagnostic;
	if (file === undefined || start === undefined) return message(diagnostic);
	const { line, character } = file.getLineAndCharacterOfPosition(start);
	return `${where(file.fileName)}:${line + 1}:${character + 1}: ${message(diagnostic)}`;
}

export function message(diagnostic: ts.Diagnostic): string {
	return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n    ");
}
