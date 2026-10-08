import { realpathSync } from "node:fs";
import { loadTau } from "@sleepymug/tau";
import { checkDeclarations } from "./declarations.js";
import { packageProblems } from "./packages.js";

/**
 * Check the tau at `dir` as its author makes it (docs/spec/development.md): what `loadTau` checks;
 * each API's copy, as a contract's declarations, holding them all and no other declaration file;
 * and each package of the tau's own that it exposes. Throws, listing every problem.
 */
export function checkTau(dir: string = process.cwd()): void {
	const tau = loadTau(dir);
	const root = realpathSync(tau.dir);
	const problems = [
		...(tau.apis.length === 0 ? [] : checkDeclarations(root, tau.apis.map((api) => api.dir), true).problems),
		...packageProblems(root, tau.apis, tau.exposed.flatMap((entry) => (entry.kind === "package" ? [entry] : []))),
	];
	if (problems.length > 0) throw new Error(`${tau.dir}: breaks the spec:\n  ${problems.join("\n  ")}`);
}
