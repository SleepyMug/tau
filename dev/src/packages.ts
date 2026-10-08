import { realpathSync } from "node:fs";
import path from "node:path";
import type { Api } from "@sleepymug/tau";
import { apiPaths, createProgram, diagnosticsOf, format, inside, message, OPTIONS } from "./typescript.js";

/** Why a module could not be resolved: TS2307, TS2792, or TS7016 for one without declarations. */
const UNRESOLVED = new Set([2307, 2792, 7016]);

/**
 * What breaks docs/spec/packages.md in the packages of the tau whose real directory is `root`, each
 * by the name programs import it as, and its directory: TypeScript checks their declarations as a
 * contract's, with each `@api/<alias>` typed by `api/<alias>/index.d.ts`, and must find no errors
 * in the packages' own files, and every import it follows from them resolves to a file in the tau.
 * The types of the packages they use are taken as they are.
 */
export function packageProblems(
	root: string,
	apis: readonly Api[],
	packages: readonly { readonly specifier: string; readonly dir: string }[],
): string[] {
	if (packages.length === 0) return [];
	const options = { ...OPTIONS, paths: apiPaths(path.join(root, "api")) };
	// Imports every package as a program would.
	const importer = path.join(root, "__tau_exposed__.mts");
	const imports = packages.map((entry, index) => `import type * as package${index} from ${JSON.stringify(entry.specifier)};`);
	const { program, ambient } = createProgram([importer], new Map([[importer, imports.join("\n")]]), options);

	const where = (file: string): string => path.relative(root, file);
	const problems = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()].map((d) => format(d, where));
	/** Each package's own files: its folder, but not the packages it holds in a node_modules/ of its own. */
	const owners = packages.map((entry) => realpathSync(entry.dir));
	const own = (file: string): boolean =>
		owners.some((dir) => inside(file, dir) && !path.relative(dir, file).split(path.sep).includes("node_modules"));
	const apiFolders = apis.map((api) => realpathSync(api.dir));
	for (const source of program.getSourceFiles()) {
		if (ambient.has(source.fileName)) continue;
		const diagnostics = diagnosticsOf(program, source);
		if (source.fileName === importer) {
			for (const diagnostic of diagnostics) {
				const line = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line;
				problems.push(`${packages[line]?.specifier}: ${message(diagnostic)}`);
			}
			continue;
		}
		const real = realpathSync(source.fileName);
		if (!inside(real, root)) problems.push(`the packages reach ${real}, which lies outside the tau`);
		// The APIs are checked as contracts; other packages' types are taken as they are, but for what they import.
		else if (apiFolders.some((folder) => inside(real, folder))) continue;
		else problems.push(...diagnostics.filter((d) => own(real) || UNRESOLVED.has(d.code)).map((d) => format(d, where)));
	}
	return problems;
}
