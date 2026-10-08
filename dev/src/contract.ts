import path from "node:path";
import { type Contract, parseVersion, readContract, serves } from "@sleepymug/tau";
import { checkDeclarations } from "./declarations.js";
import { fetchPackage } from "./fetch.js";
import { assignabilityProblems } from "./typescript.js";

/** A contract checked, with its declarations: `index.d.ts` and the files it reaches, relative to its directory. */
export interface CheckedContract extends Contract {
	readonly declarations: readonly string[];
}

/**
 * Check the contract whose package is at `dir`, as docs/spec/contracts.md has it: its package.json,
 * and its declarations. Throws, listing every problem.
 */
export function checkContract(dir: string): CheckedContract {
	const contract = readContract(dir);
	const { problems, declarations } = checkDeclarations(dir, [dir], false);
	if (problems.length > 0) throw new Error(`${dir}: ${contract.name} breaks the spec:\n  ${problems.join("\n  ")}`);
	return { ...contract, declarations: declarations.get(dir) ?? [] };
}

/**
 * Check that the contract `after` may follow `before`, each a package as npm names it
 * (docs/spec/development.md): the same name, a greater version, and, when its version serves
 * `before`'s, a module TypeScript finds assignable to `before`'s. Throws, listing every problem.
 */
export async function diffContracts(before: string, after: string, cwd: string = process.cwd()): Promise<void> {
	const old = await fetchPackage(before, cwd);
	try {
		const next = await fetchPackage(after, cwd);
		try {
			const was = old.named(checkContract);
			const is = next.named(checkContract);
			const problems: string[] = [];
			if (is.name !== was.name) problems.push(`it is ${is.name}, not ${was.name}`);
			else if (compareVersions(is.version, was.version) <= 0) problems.push(`its version, ${is.version}, is not greater than ${was.version}`);
			else if (serves(is.version, was.version))
				for (const problem of assignabilityProblems(path.join(old.dir, "index.d.ts"), path.join(next.dir, "index.d.ts")))
					problems.push(`${is.version} serves ${was.version}, but code written for it does not fit: ${problem}`);
			if (problems.length > 0) throw new Error(`${after}: cannot follow ${before}:\n  ${problems.join("\n  ")}`);
		} finally {
			next.dispose();
		}
	} finally {
		old.dispose();
	}
}

/** Which of two versions SemVer puts first: negative for `a`, positive for `b`, 0 when equal, build metadata aside. */
export function compareVersions(a: string, b: string): number {
	const x = parseVersion(a);
	const y = parseVersion(b);
	if (x === undefined || y === undefined) throw new TypeError(`${x === undefined ? a : b} is not a SemVer version`);
	const order = x.major - y.major || x.minor - y.minor || x.patch - y.patch;
	if (order !== 0) return order;
	if (x.prerelease === y.prerelease) return 0;
	if (x.prerelease === undefined) return 1;
	if (y.prerelease === undefined) return -1;
	const xs = x.prerelease.split(".");
	const ys = y.prerelease.split(".");
	for (let at = 0; at < Math.max(xs.length, ys.length); at++) {
		const [p, q] = [xs[at], ys[at]];
		if (p === undefined) return -1;
		if (q === undefined) return 1;
		const [pn, qn] = [/^\d+$/u.test(p), /^\d+$/u.test(q)];
		if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
		if (pn !== qn) return pn ? -1 : 1;
		if (p !== q) return p < q ? -1 : 1;
	}
	return 0;
}
