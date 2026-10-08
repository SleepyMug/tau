import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadTau, readContract, serves } from "../index.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tau-apis-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Writes `files` under `dir` (relative to the test directory), and `links` as symlinks, and returns its absolute path. */
function write(dir: string, files: Record<string, string | object>, links: Record<string, string> = {}): string {
	const root = path.join(tmp, dir);
	mkdirSync(root, { recursive: true });
	for (const [file, contents] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		writeFileSync(path.join(root, file), typeof contents === "string" ? contents : JSON.stringify(contents));
	}
	for (const [file, target] of Object.entries(links)) {
		mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		symlinkSync(target, path.join(root, file));
	}
	return root;
}

/** A contract's package.json. */
const contract = (name: string, version: string, description: string) => ({
	name,
	version,
	description,
	tau: { contract: true },
	type: "module",
	types: "./index.d.ts",
	scripts: { test: "true" },
});

const APIS = {
	"PROMPT.md": "Keep notes.",
	"api/notes/package.json": contract("@sleepymug/tau-api-notes", "1.2.0", "Notes, with tags."),
	"api/notes/index.d.ts": 'import type { Tag } from "./types/tags.js";\nexport declare function addNote(text: string, tags?: Tag[]): Promise<number>;\n',
	"api/notes/types/tags.d.ts": "export type Tag = string;\n",
	"api/clock/package.json": contract("clock", "0.3.1-rc.1+build.5", "The time."),
	"api/clock/index.d.ts": "export declare function now(): Date;\n",
};

test("each directory in api/ is an API, a copy of a contract, by its alias", () => {
	const dir = write("apis", APIS);
	const tau = loadTau(dir);
	assert.deepEqual(tau.apis, [
		{
			alias: "clock",
			specifier: "@api/clock",
			dir: path.join(dir, "api/clock"),
			contract: "clock",
			version: "0.3.1-rc.1+build.5",
			description: "The time.",
		},
		{
			alias: "notes",
			specifier: "@api/notes",
			dir: path.join(dir, "api/notes"),
			contract: "@sleepymug/tau-api-notes",
			version: "1.2.0",
			description: "Notes, with tags.",
		},
	]);
	assert.deepEqual(
		tau.exposed,
		tau.apis.map((api) => ({ kind: "api", specifier: api.specifier, description: api.description, api })),
	);
});

test("APIs that break the spec are refused, listing every problem", () => {
	const dir = write("broken", {
		"PROMPT.md": "Hi.",
		"api/old.d.ts": "export {};\n",
		"api/bad name/package.json": contract("bad", "1.0.0", "Bad."),
		"api/bad name/index.d.ts": "export {};\n",
		"api/plain/package.json": { name: "plain", version: "1", types: "index.js" },
		"api/plain/index.d.ts": "export {};\n",
		"api/empty/package.json": contract("empty", "1.0.0", "Nothing yet."),
		"api/stray/package.json": contract("stray", "1.0.0", "With more than declarations."),
		"api/stray/index.d.ts": "export {};\n",
		"api/stray/index.js": "export {};\n",
		"api/stray/docs/README.md": "",
		"api/again/package.json": contract("stray", "1.1.0", "Twice."),
		"api/again/index.d.ts": "export {};\n",
		"api/none/README.md": "",
	});
	assert.throws(() => loadTau(dir), (error: Error) => {
		const [first, ...problems] = error.message.split("\n").map((line) => line.trim());
		assert.equal(first, `${dir}: breaks the spec:`);
		assert.deepEqual(problems, [
			"api/bad name: an API's alias matches ^[A-Za-z0-9][A-Za-z0-9._-]*$",
			"api/empty: holds no index.d.ts",
			"api/none: holds no package.json, a contract's",
			"api/old.d.ts: api/ holds only APIs, each a directory with a contract's package.json",
			"api/plain/package.json: not a contract's:",
			"`version` must be a SemVer 2.0.0 version",
			"`description` must say what the contract is, a string that is not blank",
			'`tau` must be { "contract": true }',
			"`type` must be module: a contract's declarations are an ES module's",
			"`types` must be ./index.d.ts",
			"api/stray/docs/README.md: an API holds only its package.json and declaration files",
			"api/stray/index.js: an API holds only its package.json and declaration files",
			"api/stray: holds stray, as api/again does; a tau holds a contract once",
		]);
		return true;
	});
});

test("readContract reads a contract's package.json, and refuses what is not one", () => {
	const dir = write("contract", { "package.json": contract("@acme/travel", "2.0.0", "Trips.") });
	assert.deepEqual(readContract(dir), { name: "@acme/travel", version: "2.0.0", description: "Trips." });
	const bad = write("not-contract", { "package.json": { ...contract("Travel", "2.0", "  "), tau: {}, type: "commonjs", types: "./lib/index.d.ts" } });
	assert.throws(() => readContract(bad), (error: Error) => {
		assert.deepEqual(error.message.split("\n").map((line) => line.trim()), [
			`${bad}/package.json: not a contract's:`,
			"`name` must be an npm package's name, the contract's",
			"`version` must be a SemVer 2.0.0 version",
			"`description` must say what the contract is, a string that is not blank",
			'`tau` must be { "contract": true }',
			"`type` must be module: a contract's declarations are an ES module's",
			"`types` must be ./index.d.ts",
		]);
		return true;
	});
});

test("a version serves another with the same major and a minor no less, the same minor under 1.0.0, and a prerelease only itself", () => {
	for (const [version, held, expected] of [
		["1.2.0", "1.2.0", true],
		["1.4.1", "1.2.7", true],
		["1.2.0", "1.2.9", true],
		["1.1.9", "1.2.0", false],
		["2.0.0", "1.2.0", false],
		["0.3.4", "0.3.0", true],
		["0.4.0", "0.3.0", false],
		["0.0.9", "0.0.1", true],
		["1.3.0", "1.3.0-rc.1", true],
		["1.3.0-rc.2", "1.3.0-rc.1", false],
		["1.3.0-rc.1+other", "1.3.0-rc.1", true],
		["1.3.0+build.2", "1.2.0+build.1", true],
	] as const)
		assert.equal(serves(version, held), expected, `${version} serves ${held}`);
	assert.throws(() => serves("1.2", "1.2.0"), /"1\.2" is not a SemVer version/);
});

const KIT = "node_modules/.pnpm/notes-kit@1.0.0/node_modules/notes-kit";

test("a tau exposes APIs and packages of its own, in the order it lists them, each described by its package.json", () => {
	const dir = write(
		"kit",
		{
			...APIS,
			[`${KIT}/package.json`]: { name: "notes-kit", description: "Notes in fewer calls.", types: "index.d.ts" },
			"node_modules/plain-kit/package.json": { name: "plain-kit", types: "index.d.ts" },
			"tau.json": { exposes: ["notes-kit", "@api/clock", "plain-kit"] },
		},
		{ "node_modules/notes-kit": ".pnpm/notes-kit@1.0.0/node_modules/notes-kit" },
	);
	const tau = loadTau(dir);
	assert.deepEqual(tau.exposed, [
		{ kind: "package", specifier: "notes-kit", description: "Notes in fewer calls.", dir: path.join(dir, "node_modules/notes-kit") },
		{ kind: "api", specifier: "@api/clock", description: "The time.", api: tau.apis[0] },
		{ kind: "package", specifier: "plain-kit", description: undefined, dir: path.join(dir, "node_modules/plain-kit") },
	]);
});

test("what a tau exposes is refused, listing every problem, when it lacks it, or an @api scope would hide an implementation", () => {
	const dir = write("refused", {
		...APIS,
		"tau.json": { exposes: ["@api/missing", "absent", "notes-kit"] },
		[`${KIT}/package.json`]: { name: "notes-kit" },
		// A stub the author built against, left in the tau.
		"node_modules/.pnpm/notes-kit@1.0.0/node_modules/@api/notes/package.json": { name: "@api/notes" },
		"node_modules/notes-kit/package.json": { name: "notes-kit" },
	});
	assert.throws(() => loadTau(dir), (error: Error) => {
		assert.deepEqual(error.message.split("\n").slice(1).map((line) => line.trim()), [
			"exposes @api/missing, but the tau has no api/missing/",
			"exposes absent, which is not a package in node_modules/",
			"node_modules/.pnpm/notes-kit@1.0.0/node_modules/@api: an @api scope in the tau would hide the runtime's implementations",
		]);
		return true;
	});
});

test("node_modules/ follows the tau's rule for symlinks once the tau exposes a package of its own", () => {
	const files = { ...APIS, "node_modules/notes-kit/package.json": { name: "notes-kit" } };
	const links = { "node_modules/elsewhere": "/usr" };
	assert.doesNotThrow(() => loadTau(write("apis-only", { ...files, "tau.json": { exposes: ["@api/notes"] } }, links)));
	assert.throws(
		() => loadTau(write("absolute", { ...files, "tau.json": { exposes: ["notes-kit"] } }, links)),
		/node_modules\/elsewhere: leads to the absolute path \/usr; a symlink in a tau is relative/,
	);
});
