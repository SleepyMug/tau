import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { compareVersions, loadTau, rangeVersion, readContract, serves, within } from "./index.js";

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
	"tau.json": { apis: { "@sleepymug/tau-api-notes": "^1.2.0", clock: "^0.3.1-rc.1" } },
};

test("apis in tau.json names each API, a contract's name and a range, in the order of their names", () => {
	const dir = write("apis", APIS);
	const tau = loadTau(dir);
	assert.deepEqual(tau.apis, [
		{ name: "@sleepymug/tau-api-notes", range: "^1.2.0", version: "1.2.0" },
		{ name: "clock", range: "^0.3.1-rc.1", version: "0.3.1-rc.1" },
	]);
	assert.deepEqual(
		tau.exposed,
		tau.apis.map((api) => ({ kind: "api", specifier: api.name, api })),
	);
});

test("apis that break the spec are refused", () => {
	for (const [name, apis, problem] of [
		["not-object", ["clock"], /`apis` must be an object/],
		["bad-name", { Clock: "^1.0.0" }, /`apis`: "Clock" is not a contract's name/],
		["no-caret", { clock: "1.0.0" }, /`apis`: clock: "1\.0\.0" is not a range, \^ and a SemVer version/],
		["bad-version", { clock: "^1.0" }, /`apis`: clock: "\^1\.0" is not a range/],
		["not-string", { clock: 1 }, /`apis`: clock: 1 is not a range/],
	] as const)
		assert.throws(() => loadTau(write(name, { "PROMPT.md": "Hi.", "tau.json": { apis } })), problem, name);
});

test("api/ is no part of a tau: a runtime reads nothing there", () => {
	const dir = write("old-copies", { "PROMPT.md": "Hi.", "api/notes/package.json": "not JSON", "api/link": "" }, { "api/abs": "/usr" });
	assert.deepEqual(loadTau(dir).apis, []);
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

test("a range is ^ and a version, and takes the versions that serve that one", () => {
	assert.equal(rangeVersion("^1.2.0"), "1.2.0");
	for (const range of ["1.2.0", "~1.2.0", "^1.2", ">=1.2.0", "^"]) assert.equal(rangeVersion(range), undefined, range);
	assert.equal(within("1.4.0", "^1.2.0"), true);
	assert.equal(within("2.0.0", "^1.2.0"), false);
	assert.equal(within("0.2.5", "^0.2.0"), true);
	assert.equal(within("0.3.0", "^0.2.0"), false);
	assert.throws(() => within("1.2.0", "1.2.0"), /"1\.2\.0" is not a range/);
});

test("versions compare by SemVer's precedence, build metadata aside", () => {
	const ordered = ["0.9.0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.2.0", "1.10.0", "2.0.0"];
	assert.deepEqual([...ordered].reverse().sort(compareVersions), ordered);
	assert.equal(compareVersions("1.0.0+a", "1.0.0+b"), 0);
});

const KIT = "node_modules/.pnpm/notes-kit@1.0.0/node_modules/notes-kit";

test("a tau exposes APIs and packages of its own, in the order it lists them, each package described by its package.json", () => {
	const dir = write(
		"kit",
		{
			...APIS,
			[`${KIT}/package.json`]: { name: "notes-kit", description: "Notes in fewer calls.", types: "index.d.ts", tau: { apis: { "@sleepymug/tau-api-notes": "^1.1.0" } } },
			"node_modules/plain-kit/package.json": { name: "plain-kit", types: "index.d.ts" },
			"tau.json": { ...APIS["tau.json"], exposes: ["notes-kit", "clock", "plain-kit"] },
		},
		{ "node_modules/notes-kit": ".pnpm/notes-kit@1.0.0/node_modules/notes-kit" },
	);
	const tau = loadTau(dir);
	assert.deepEqual(tau.exposed, [
		{ kind: "package", specifier: "notes-kit", description: "Notes in fewer calls.", dir: path.join(dir, "node_modules/notes-kit") },
		{ kind: "api", specifier: "clock", api: tau.apis[1] },
		{ kind: "package", specifier: "plain-kit", description: undefined, dir: path.join(dir, "node_modules/plain-kit") },
	]);
});

test("what a tau exposes is refused, listing every problem, when it lacks it, a package needs an API it does not give, or a package would hide an API", () => {
	const dir = write("refused", {
		...APIS,
		"tau.json": { ...APIS["tau.json"], exposes: ["@acme/missing", "notes-kit", "newer-kit", "odd-kit"] },
		[`${KIT}/package.json`]: { name: "notes-kit", tau: { apis: { "@acme/travel": "^1.0.0" } } },
		// A stub the author built against, left in the tau.
		"node_modules/.pnpm/notes-kit@1.0.0/node_modules/@sleepymug/tau-api-notes/package.json": { name: "@sleepymug/tau-api-notes" },
		"node_modules/notes-kit/package.json": { name: "notes-kit", tau: { apis: { "@acme/travel": "^1.0.0" } } },
		"node_modules/newer-kit/package.json": { name: "newer-kit", tau: { apis: { "@sleepymug/tau-api-notes": "^1.3.0" } } },
		"node_modules/odd-kit/package.json": { name: "odd-kit", tau: { apis: { clock: "0.3" } } },
		"node_modules/clock/package.json": { name: "clock" },
	});
	assert.throws(() => loadTau(dir), (error: Error) => {
		assert.deepEqual(error.message.split("\n").slice(1).map((line) => line.trim()), [
			"exposes @acme/missing, which is neither one of its APIs nor a package in node_modules/",
			"node_modules/notes-kit/package.json: imports the API @acme/travel, which the tau's `apis` does not name",
			"node_modules/newer-kit/package.json: needs @sleepymug/tau-api-notes@^1.3.0, which the tau's ^1.2.0 does not give",
			'node_modules/odd-kit/package.json: `tau.apis`: "clock": "0.3" is not a contract\'s name and a range, ^ and a version',
			"node_modules/.pnpm/notes-kit@1.0.0/node_modules/@sleepymug/tau-api-notes: is named as an API of the tau, whose implementation it would hide",
			"node_modules/clock: is named as an API of the tau, whose implementation it would hide",
		]);
		return true;
	});
});

test("node_modules/ follows the tau's rule for symlinks once the tau exposes a package of its own", () => {
	const files = { ...APIS, "node_modules/notes-kit/package.json": { name: "notes-kit" } };
	const links = { "node_modules/elsewhere": "/usr" };
	assert.doesNotThrow(() => loadTau(write("apis-only", { ...files, "tau.json": { ...APIS["tau.json"], exposes: ["clock"] } }, links)));
	assert.throws(
		() => loadTau(write("absolute", { ...files, "tau.json": { ...APIS["tau.json"], exposes: ["notes-kit"] } }, links)),
		/node_modules\/elsewhere: leads to the absolute path \/usr; a symlink in a tau is relative/,
	);
});
