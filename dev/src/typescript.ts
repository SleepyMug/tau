import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";

const require = createRequire(import.meta.url);
/** Node.js's types: `@types/node`, which this package pins. */
const NODE_TYPES = path.dirname(path.dirname(require.resolve("@types/node/package.json")));

/** How declarations are checked: strict, as Node.js resolves imports, on ES2022 and Node.js's types. */
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

/** TS2306: File '…' is not a module. */
export const NOT_A_MODULE = 2306;

/**
 * `@api/<alias>` typed by `api/<alias>/index.d.ts` in `apiDir`, the tau's api/, absolute: as the
 * tau's own code imports it, and a tsconfig.json's `paths` would have it.
 */
export function apiPaths(apiDir: string): ts.MapLike<string[]> {
	return { "@api/*": [path.join(apiDir, "*", "index.d.ts")] };
}

/** A module a file imports: the file, what it names, and the file that resolved to, if any. */
export interface Import {
	readonly from: string;
	readonly specifier: string;
	readonly to: string | undefined;
}

/**
 * A program of `roots`, with `files` in memory, and the files the environment brings, Node.js's
 * types and the ES library, which are not the checked code's; each import its files make is
 * pushed to `imports`, when given.
 */
export function createProgram(
	roots: readonly string[],
	files: ReadonlyMap<string, string>,
	options: ts.CompilerOptions,
	imports?: Import[],
): { program: ts.Program; ambient: ReadonlySet<string> } {
	// What a program of its own brings is the environment's.
	const empty = path.join(path.dirname(roots[0] ?? process.cwd()), "__tau_environment__.mts");
	const host = memoryHost(new Map([...files, [empty, ""]]));
	if (imports !== undefined)
		host.resolveModuleNameLiterals = (literals, from, redirected, compilerOptions, source) =>
			literals.map((literal) => {
				const mode = ts.getModeForUsageLocation(source, literal, compilerOptions);
				const resolution = ts.resolveModuleName(literal.text, from, compilerOptions, host, undefined, redirected, mode);
				imports.push({ from, specifier: literal.text, to: resolution.resolvedModule?.resolvedFileName });
				return resolution;
			});
	const environment = ts.createProgram({ rootNames: [empty], options, host });
	const ambient = new Set(environment.getSourceFiles().map((file) => file.fileName));
	const program = ts.createProgram({ rootNames: [...roots], options, host, oldProgram: environment });
	return { program, ambient };
}

/** A file's syntactic and semantic diagnostics. */
export function diagnosticsOf(program: ts.Program, source: ts.SourceFile): ts.Diagnostic[] {
	return [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
}

/**
 * Whether the module `to` declares, its type, can stand for the module `from` declares, both
 * declaration files, absolute: so that each value `from` exports, `to` exports too, of a type that
 * fits wherever code written for `from` uses it. TypeScript's reasons why not; none when it can.
 */
export function assignabilityProblems(from: string, to: string): string[] {
	// An ES module, as contracts are, and as programs import them.
	const check = path.join(path.dirname(from), "__tau_follows__.mts");
	const text = [
		`import type * as Before from ${JSON.stringify(importPath(check, from))};`,
		`import type * as After from ${JSON.stringify(importPath(check, to))};`,
		"declare const after: typeof After;",
		"export const before: typeof Before = after;",
	].join("\n");
	const options = { ...OPTIONS, skipLibCheck: true };
	const program = ts.createProgram({ rootNames: [check], options, host: memoryHost(new Map([[check, text]])) });
	const source = program.getSourceFile(check) as ts.SourceFile;
	return diagnosticsOf(program, source).map((diagnostic) => message(diagnostic));
}

/** How `from` imports `file` under NodeNext: relative, declarations by the JavaScript they describe. */
export function importPath(from: string, file: string): string {
	const relative = path.relative(path.dirname(from), file).replace(/(?:\.d)?\.([mc]?)ts$/u, ".$1js");
	return relative.startsWith(".") ? relative : `./${relative}`;
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

/** Whether `file` is `directory` or lies inside it; both absolute and normalized. */
export function inside(file: string, directory: string): boolean {
	return file === directory || file.startsWith(directory.endsWith(path.sep) ? directory : directory + path.sep);
}
