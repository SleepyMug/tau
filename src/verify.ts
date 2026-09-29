// Adapted from fyona packages/fbox-derive/src/verify.ts at commit 008a6f5.
import path from "node:path";
import ts from "typescript";
import { COMPILER_OPTIONS, importName, memoryHost, type ReadManifest } from "./read-manifest.js";

/**
 * Proves a translation: for every function, the declarations printed from the JSON Schema must
 * mean what the manifest means. `tsc` checks that the parameter lists, and the awaited results,
 * are identical types: TypeScript's identity relation, which also tells optional properties, index
 * signatures, `readonly` and `any` apart. A lossy translation (`Map` printed as `{ size: number }`,
 * `Date` as `string`, `T | undefined` as optional) fails here, whatever the converter did. Identity
 * also refuses some faithful translations (`readonly` arrays, `any`); that is the incomplete side,
 * not the unsound one.
 */
export function verifyTranslation(file: string, read: ReadManifest, declarations: string): void {
	// Virtual files beside the manifest, which they import relatively, as ES modules. Not a
	// `.d.mts`: skipLibCheck would hide the printed declarations' own errors.
	const printedPath = path.join(path.dirname(file), "__tau_printed__.mts");
	const checkPath = path.join(path.dirname(file), "__tau_check__.mts");
	const functions = Object.keys(read.functions);
	const checks = functions.flatMap((name) => [
		{ name, part: "parameters", code: `Same<Parameters<typeof O.${name}>, Parameters<typeof P.${name}>>` },
		{
			name,
			part: "result",
			code: `Same<Awaited<ReturnType<typeof O.${name}>>, Awaited<ReturnType<typeof P.${name}>>>`,
		},
	]);
	const header = [
		`import type * as O from ${JSON.stringify(importName(file))};`,
		`import type * as P from "./__tau_printed__.mjs";`,
		"type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;",
	];
	const check = [...header, ...checks.map((item, index) => `export const check${index}: ${item.code} = true;`)].join(
		"\n",
	);
	const manifest = read.program.getSourceFile(file)?.text ?? "";
	const host = memoryHost(
		new Map([
			[file, manifest],
			[printedPath, declarations],
			[checkPath, check],
		]),
	);
	const verification = ts.createProgram([file, checkPath], COMPILER_OPTIONS, host, read.program);

	const problems: string[] = [];
	const printed = verification.getSourceFile(printedPath);
	for (const diagnostic of [
		...verification.getSyntacticDiagnostics(printed),
		...verification.getSemanticDiagnostics(printed),
	]) {
		// A bug in the printer, not in the manifest: report it as such.
		problems.push(`the printed declarations do not compile: ${message(diagnostic)}`);
	}
	for (const diagnostic of verification.getSemanticDiagnostics(verification.getSourceFile(file))) {
		problems.push(message(diagnostic));
	}
	const checkFile = verification.getSourceFile(checkPath);
	for (const diagnostic of verification.getSemanticDiagnostics(checkFile)) {
		const line =
			checkFile !== undefined && diagnostic.start !== undefined
				? checkFile.getLineAndCharacterOfPosition(diagnostic.start).line - header.length
				: -1;
		const failed = checks[line];
		if (failed === undefined) {
			problems.push(message(diagnostic));
			continue;
		}
		problems.push(
			`${failed.name}: its ${failed.part} cannot be carried as JSON without changing\n` +
				`    declared: ${read.signatures.get(failed.name) ?? "?"}\n` +
				`    as JSON:  ${printedSignature(declarations, failed.name)}`,
		);
	}
	if (problems.length > 0) throw new TypeError(`does not translate to JSON Schema:\n  ${problems.join("\n  ")}`);
}

/** One function's printed declaration on one line (blocks are separated by blank lines). */
function printedSignature(declarations: string, name: string): string {
	const start = `export declare function ${name}(`;
	const block = declarations.split("\n\n").find((text) => text.includes(start));
	if (block === undefined) return "?";
	return block
		.slice(block.indexOf(start) + "export declare ".length)
		.replace(/\s+/gu, " ")
		.replace(/;\s*$/u, "");
}

function message(diagnostic: ts.Diagnostic): string {
	return ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
}
