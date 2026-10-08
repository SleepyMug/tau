import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkContract, compareVersions, diffContracts } from "./index.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tau-contract-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Writes `files` under `dir` (relative to the test directory) and returns its absolute path. */
function write(dir: string, files: Record<string, string | object>): string {
	const root = path.join(tmp, dir);
	mkdirSync(root, { recursive: true });
	for (const [file, contents] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		writeFileSync(path.join(root, file), typeof contents === "string" ? contents : JSON.stringify(contents));
	}
	return root;
}

/** A contract's package at `dir`, `@acme/clock` at `version`, declaring `index`. */
const clock = (dir: string, version: string, index: string, name = "@acme/clock") =>
	write(dir, {
		"package.json": { name, version, description: "The time.", tau: { contract: true }, type: "module", types: "./index.d.ts" },
		"index.d.ts": index,
	});

/** The contracts this repository publishes. */
const CONTRACTS = path.resolve(fileURLToPath(import.meta.url), "../../../contracts");

test("the contracts tau publishes are contracts", () => {
	const names = readdirSync(CONTRACTS).map((dir) => checkContract(path.join(CONTRACTS, dir)).name);
	assert.deepEqual(names.sort(), ["@sleepymug/tau-api", "@sleepymug/tau-api-notes"]);
});

test("a contract is checked with its declarations, and gives those index.d.ts reaches", () => {
	const dir = write("zones", {
		"package.json": { name: "zones", version: "0.1.0", description: "Time zones.", tau: { contract: true }, type: "module", types: "index.d.ts" },
		"index.d.ts": 'import type { Zone } from "./lib/zone.js";\nexport declare function here(): Zone;\n',
		"lib/zone.d.ts": "export type Zone = string;\n",
		// Its publisher's, which no tau copies.
		"conformance/index.d.ts": "export {};\n",
	});
	assert.deepEqual(checkContract(dir), {
		name: "zones",
		version: "0.1.0",
		description: "Time zones.",
		declarations: ["index.d.ts", path.join("lib", "zone.d.ts")],
	});
	const broken = clock("broken", "1.0.0", "export declare function now(): Dat;\n");
	assert.throws(() => checkContract(broken), /@acme\/clock breaks the spec:\n {2}index\.d\.ts:1:32: Cannot find name 'Dat'/);
	assert.throws(() => checkContract(write("plain", { "package.json": { name: "plain" } })), /not a contract's/);
});

test("a contract may follow another of its name with a greater version, and a module that fits where its version says it serves", async () => {
	const NOW = "export declare function now(): Date;\n";
	const before = clock("before", "1.2.0", NOW);
	// A minor that adds an export, and takes more.
	const added = clock("added", "1.3.0", "export declare function now(zone?: string): Date;\nexport declare function today(): string;\n");
	await diffContracts(before, added);
	// A major may change anything.
	await diffContracts(before, clock("major", "2.0.0", "export declare function today(): string;\n"));
	await assert.rejects(diffContracts(before, clock("removed", "1.3.0", "export declare function today(): string;\n")), (error: Error) => {
		assert.match(error.message, /removed: cannot follow \S+before:\n {2}1\.3\.0 serves 1\.2\.0, but code written for it does not fit: Property 'now' is missing/);
		return true;
	});
	await assert.rejects(diffContracts(before, clock("narrowed", "1.2.1", "export declare function now(): string;\n")), /does not fit/);
	await assert.rejects(diffContracts(before, clock("older", "1.1.0", NOW)), /its version, 1\.1\.0, is not greater than 1\.2\.0/);
	await assert.rejects(diffContracts(before, clock("other", "1.3.0", NOW, "@acme/time")), /it is @acme\/time, not @acme\/clock/);
	await assert.rejects(diffContracts(before, path.join(tmp, "nowhere")), /nowhere: cannot be fetched/);
});

test("versions are ordered as SemVer orders them", () => {
	const ordered = ["0.9.0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.10.0", "2.0.0"];
	for (let at = 1; at < ordered.length; at++) {
		assert.ok(compareVersions(ordered[at - 1] as string, ordered[at] as string) < 0, `${ordered[at - 1]} < ${ordered[at]}`);
		assert.ok(compareVersions(ordered[at] as string, ordered[at - 1] as string) > 0);
	}
	assert.equal(compareVersions("1.0.0+a", "1.0.0+b"), 0);
});
