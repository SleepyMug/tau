import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { createProgram, diagnosticsOf, format, type Import, importPath, inside, message, NOT_A_MODULE, OPTIONS } from "./typescript.js";

/** What checking contracts' declarations found. */
export interface Checked {
	/** What breaks docs/spec/contracts.md, each relative to the base. */
	readonly problems: string[];
	/** Each contract's declarations, by its directory, as given: `index.d.ts` and the files it reaches, relative to it. */
	readonly declarations: ReadonlyMap<string, readonly string[]>;
}

/**
 * Check the declarations of the contracts whose packages are at `dirs`, as docs/spec/contracts.md
 * has them, together: TypeScript finds no errors in them, each `index.d.ts` is a module, and they
 * import only their own files, by relative paths, and Node.js's own modules. With `copies`, each
 * directory is a tau's copy, and holds no declaration file but those `index.d.ts` reaches.
 * `base` is what the problems name files relative to.
 */
export function checkDeclarations(base: string, dirs: readonly string[], copies: boolean): Checked {
	const where = (file: string): string => path.relative(base, file) || ".";
	const folders = dirs.map((dir) => realpathSync(dir));
	const indexes = folders.map((folder) => path.join(folder, "index.d.ts"));
	// Imports every contract as a program would, so one that is not a module fails here.
	const entry = path.join(realpathSync(base), "__tau_contracts__.mts");
	const text = indexes.map((index, at) => `import type * as contract${at} from ${JSON.stringify(importPath(entry, index))};`);
	const imports: Import[] = [];
	const { program, ambient } = createProgram([entry], new Map([[entry, text.join("\n")]]), OPTIONS, imports);

	const problems = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()].map((d) => format(d, where));
	/** What a contract imports that it may not, which is reported as such, and nothing more of it. */
	const refused = new Set<string>();
	for (const { from, specifier, to } of imports) {
		const own = folders.filter((folder) => inside(from, folder));
		// Not a contract's file; or TypeScript reports what did not resolve, or finds it among Node.js's own modules.
		if (own.length === 0 || to === undefined) continue;
		if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
			if (own.some((folder) => inside(to, folder))) continue;
			problems.push(`${where(from)}: imports ${specifier}, which lies outside its contract's directory`);
		} else {
			problems.push(`${where(from)}: imports the package ${specifier}; a contract imports no package, and no other contract, but Node.js's own modules`);
		}
		refused.add(to);
	}
	for (const source of program.getSourceFiles()) {
		if (ambient.has(source.fileName) || refused.has(source.fileName)) continue;
		const diagnostics = diagnosticsOf(program, source);
		if (source.fileName === entry) {
			for (const diagnostic of diagnostics) {
				const line = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line;
				const index = indexes[line] as string;
				problems.push(diagnostic.code === NOT_A_MODULE ? `${where(index)}: is not a module, so programs cannot import it` : `${where(index)}: ${message(diagnostic)}`);
			}
			continue;
		}
		const real = realpathSync(source.fileName);
		const folder = folders.find((candidate) => inside(real, candidate));
		if (folder === undefined) problems.push(`the declarations reach ${where(real)}, which lies in no contract's directory`);
		else problems.push(...diagnostics.map((d) => format(d, where)));
	}
	// What each file imports, or references, of the files TypeScript read.
	const edges = new Map<string, string[]>();
	const realOf = (file: string): string => (existsSync(file) ? realpathSync(file) : file);
	const edge = (from: string, to: string): void => void edges.set(realOf(from), [...(edges.get(realOf(from)) ?? []), realOf(to)]);
	for (const { from, to } of imports) if (to !== undefined) edge(from, to);
	for (const source of program.getSourceFiles())
		for (const reference of source.referencedFiles) {
			const to = path.resolve(path.dirname(source.fileName), reference.fileName);
			if (program.getSourceFile(to) !== undefined) edge(source.fileName, to);
		}
	const declarations = new Map<string, string[]>();
	for (const [at, folder] of folders.entries()) {
		// What its index.d.ts reaches, within its directory.
		const reached = new Set<string>();
		const pending = [indexes[at] as string];
		for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
			if (reached.has(file) || !inside(file, folder) || !existsSync(file)) continue;
			reached.add(file);
			pending.push(...(edges.get(file) ?? []));
		}
		const own = [...reached].map((file) => path.relative(folder, file)).sort();
		declarations.set(dirs[at] as string, own);
		if (!copies) continue;
		const kept = new Set(own);
		for (const file of declarationFiles(folder))
			if (!kept.has(file)) problems.push(`${where(path.join(folder, file))}: index.d.ts does not reach it, so it is no declaration of the contract's`);
	}
	return { problems, declarations };
}

/** The declaration files under `dir`, relative to it, symlinks followed. */
function declarationFiles(dir: string): string[] {
	const found: string[] = [];
	const walk = (folder: string, prefix: string): void => {
		for (const entry of readdirSync(folder).sort()) {
			const file = path.join(folder, entry);
			if (statSync(file, { throwIfNoEntry: false })?.isDirectory()) walk(file, `${prefix}${entry}${path.sep}`);
			else if (entry.endsWith(".d.ts")) found.push(prefix + entry);
		}
	};
	walk(dir, "");
	return found;
}
