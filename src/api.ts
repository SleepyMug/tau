import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";
import { inside } from "./links.js";

/** How the agent's programs import an API: `@api/<name>` (SPEC.md). */
export const API_SCOPE = "@api/";

/** An API a tau declares in `api/<name>.d.ts`, checked against the spec. */
export interface Api {
	/** The file's name, without `.d.ts`. */
	readonly name: string;
	/** What programs import it as: `@api/<name>`. */
	readonly specifier: string;
	/** `api/<name>.d.ts`, absolute: what types `@api/<name>`, its imports resolving from there. */
	readonly file: string;
	/** Its TSDoc package documentation. */
	readonly description: string | undefined;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const EXTENSION = ".d.ts";

const require = createRequire(import.meta.url);
/** Node.js's types: `@types/node`, which this package pins. */
const NODE_TYPES = path.dirname(path.dirname(require.resolve("@types/node/package.json")));

/** How API files are checked: strict, as Node.js resolves imports, on ES2022 and Node.js's types. */
const OPTIONS: ts.CompilerOptions = {
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
 * Every `api/<name>.d.ts` of the tau at `dir`, by name; none when there is no api/. TypeScript
 * checks them, and what they import, as one project: it must find no errors, and each must be a
 * module programs can import. Every file they reach lies in the tau, except for the ES library and
 * Node.js's types; those in a `node_modules/` are a package's types, taken as they are. Throws,
 * listing every problem.
 */
export function loadApis(dir: string): Api[] {
	const root = realpathSync(path.resolve(dir));
	const apiDir = path.join(root, "api");
	if (!existsSync(apiDir)) return [];
	const problems: string[] = [];
	const apis = readdirSync(apiDir)
		.filter(
			(entry) => entry.endsWith(EXTENSION) && statSync(path.join(apiDir, entry), { throwIfNoEntry: false })?.isFile(),
		)
		.sort()
		.map((entry): Api => {
			const name = entry.slice(0, -EXTENSION.length);
			if (!NAME.test(name)) problems.push(`api/${entry}: an API's name matches ${NAME.source}`);
			const file = path.join(apiDir, entry);
			return { name, specifier: API_SCOPE + name, file, description: packageDescription(readFileSync(file, "utf8")) };
		});
	if (apis.length === 0) return [];

	// Imports every API as a program would, so one that is not a module fails here.
	const entry = path.join(apiDir, "__tau_apis__.mts");
	const imports = apis.map((api, index) => `import type * as api${index} from ${JSON.stringify(`./${api.name}.js`)};`);
	// What a program of its own brings is the environment's, not the tau's.
	const empty = path.join(apiDir, "__tau_environment__.mts");
	const host = memoryHost(
		new Map([
			[entry, imports.join("\n")],
			[empty, ""],
		]),
	);
	const environment = ts.createProgram({ rootNames: [empty], options: OPTIONS, host });
	const ambient = new Set(environment.getSourceFiles().map((file) => file.fileName));
	const program = ts.createProgram({
		rootNames: [entry, ...apis.map((api) => api.file)],
		options: OPTIONS,
		host,
		oldProgram: environment,
	});

	const where = (file: string): string => path.relative(root, file);
	problems.push(...[...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()].map((d) => format(d, where)));
	for (const source of program.getSourceFiles()) {
		if (ambient.has(source.fileName)) continue;
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
		else if (!real.split(path.sep).includes("node_modules")) problems.push(...diagnostics.map((d) => format(d, where)));
	}
	if (problems.length > 0) throw new Error(`${root}: its APIs break the spec:\n  ${problems.join("\n  ")}`);
	return apis;
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
	// The API is checked by loadApis, and the implementation is its provider's.
	const options = { ...OPTIONS, skipLibCheck: true };
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
function packageDescription(text: string): string | undefined {
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
function memoryHost(files: ReadonlyMap<string, string>): ts.CompilerHost {
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
function format(diagnostic: ts.Diagnostic, where: (file: string) => string): string {
	const { file, start } = diagnostic;
	if (file === undefined || start === undefined) return message(diagnostic);
	const { line, character } = file.getLineAndCharacterOfPosition(start);
	return `${where(file.fileName)}:${line + 1}:${character + 1}: ${message(diagnostic)}`;
}

function message(diagnostic: ts.Diagnostic): string {
	return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n    ");
}
