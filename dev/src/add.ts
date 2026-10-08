import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Contract, loadTau, parseVersion, readContract } from "@sleepymug/tau";
import { checkContract } from "./contract.js";
import { fetchPackage } from "./fetch.js";

/** What an alias may be (docs/spec/apis.md). */
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/**
 * Copy the contract `spec` names, as npm names packages, into the tau in `cwd`, as `api/<alias>/`:
 * its package.json and its declarations, replacing what is there, once checked as a contract
 * (docs/spec/development.md). Refuses what is not a contract, or one the tau holds under another
 * alias. Gives the contract copied.
 */
export async function addContract(alias: string, spec: string, cwd: string = process.cwd()): Promise<Contract> {
	if (!ALIAS.test(alias)) throw new TypeError(`${JSON.stringify(alias)} is not an alias, which matches ${ALIAS.source}`);
	if (!existsSync(path.join(cwd, "PROMPT.md"))) throw new Error(`${cwd}: not a tau (no PROMPT.md)`);
	const fetched = await fetchPackage(spec, cwd);
	try {
		const contract = fetched.named(checkContract);
		const apiDir = path.join(cwd, "api");
		for (const other of existsSync(apiDir) ? readdirSync(apiDir).sort() : []) {
			if (other === alias) continue;
			let held: string | undefined;
			try {
				held = readContract(path.join(apiDir, other)).name;
			} catch {
				// Not a contract's copy, which `tau check` reports.
			}
			if (held === contract.name) throw new Error(`${spec}: the tau holds ${contract.name} as api/${other} already`);
		}
		const staging = mkdtempSync(path.join(os.tmpdir(), "tau-add-"));
		try {
			for (const file of ["package.json", ...contract.declarations]) {
				mkdirSync(path.dirname(path.join(staging, file)), { recursive: true });
				cpSync(path.join(fetched.dir, file), path.join(staging, file), { dereference: true });
			}
			const target = path.join(apiDir, alias);
			rmSync(target, { recursive: true, force: true });
			cpSync(staging, target, { recursive: true });
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
		const { name, version, description } = contract;
		return { name, version, description };
	} finally {
		fetched.dispose();
	}
}

/**
 * Copy into the tau in `cwd`, for each of its APIs, or those `aliases` names, the newest version of
 * its contract that serves the one it holds (docs/spec/contracts.md), as `addContract` does. Gives
 * each API's alias, with the version it held and the one it holds now.
 */
export async function updateContracts(
	aliases: readonly string[] = [],
	cwd: string = process.cwd(),
): Promise<{ alias: string; was: string; is: string }[]> {
	const { apis } = loadTau(cwd);
	const unknown = aliases.filter((alias) => !apis.some((api) => api.alias === alias));
	if (unknown.length > 0) throw new Error(`${cwd}: has no API ${unknown.join(", ")}`);
	const updated: { alias: string; was: string; is: string }[] = [];
	for (const api of apis) {
		if (aliases.length > 0 && !aliases.includes(api.alias)) continue;
		const { version } = await addContract(api.alias, `${api.contract}@${servingRange(api.version)}`, cwd);
		updated.push({ alias: api.alias, was: api.version, is: version });
	}
	return updated;
}

/** An npm range of the versions that serve `held`, prereleases aside. */
function servingRange(held: string): string {
	const { major, minor } = parseVersion(held) ?? { major: 0, minor: 0 };
	return major === 0 ? `>=0.${minor}.0 <0.${minor + 1}.0` : `>=${major}.${minor}.0 <${major + 1}.0.0`;
}
