import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { checkModule, loadModule, loadModules } from "./index.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tau-modules-"));
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

const PACKAGE = {
	name: "file-edits",
	description: "Edit text files in bulk.",
	type: "module",
	exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
};
const EDITS = {
	"package.json": PACKAGE,
	"index.js": 'import { readFile } from "node:fs/promises";\nimport path from "path";\nimport { split } from "./lib/split.js";\nexport const x = 1;\n',
	"index.d.ts": "export declare const x: number;\n",
	"lib/split.js": "export const split = (s) => s.split(/\\n/);\n",
};

test("a module is a package named by its package.json, and may be a symlink", () => {
	write("agent/modules/edits", EDITS);
	const elsewhere = write("elsewhere/notes-format", { ...EDITS, "package.json": { ...PACKAGE, name: "notes-format" } });
	symlinkSync(elsewhere, path.join(tmp, "agent/modules/format"));
	const modules = loadModules(path.join(tmp, "agent"));
	assert.deepEqual(modules, [
		{ name: "file-edits", description: "Edit text files in bulk.", root: path.join(tmp, "agent/modules/edits") },
		{ name: "notes-format", description: "Edit text files in bulk.", root: path.join(tmp, "agent/modules/format") },
	]);
	for (const module of modules) checkModule(module);
	assert.deepEqual(loadModules(tmp), []);
});

test("a module that is not a typed package is refused, with the reason", () => {
	const { exports: _, ...unexported } = PACKAGE;
	const refused: [string, Record<string, string | object>, RegExp][] = [
		["empty", {}, /empty is not a package/],
		["caps", { ...EDITS, "package.json": { ...PACKAGE, name: "Edits" } }, /needs a valid `name`/],
		["svc", { ...EDITS, "package.json": { ...PACKAGE, name: "@svc/notes" } }, /the @svc\/ scope is reserved/],
		["unexported", { ...EDITS, "package.json": unexported }, /needs `exports`/],
		["untyped", { "package.json": PACKAGE, "index.js": EDITS["index.js"] }, /has no type declarations for its "\." export/],
	];
	for (const [dir, files, reason] of refused) {
		assert.throws(() => loadModule(write(dir, files)), reason, dir);
	}
});

test("two modules may not share a package name", () => {
	write("twice/modules/a", EDITS);
	write("twice/modules/b", EDITS);
	assert.throws(() => loadModules(path.join(tmp, "twice")), /package name file-edits is also used by/);
});

test("a module's imports may resolve anywhere: its own node_modules, symlinks, or files outside it", () => {
	write("shared", {
		"util.js": "export const util = 1;\n",
		"vendor/yaml/package.json": { name: "yaml", main: "index.cjs" },
		"vendor/yaml/index.cjs": 'const util = require("util");\nmodule.exports = {};\n',
	});
	const root = write("resolving", {
		...EDITS,
		"package.json": { ...PACKAGE, exports: { ...PACKAGE.exports, "./extra": { types: "./extra.d.ts", default: "./extra.js" } } },
		"index.js": 'import yaml from "yaml";\nimport { util } from "../shared/util.js";\nimport { x } from "file-edits/extra";\n',
		"extra.js": "export const x = 1;\n",
		"extra.d.ts": "export declare const x: number;\n",
	});
	mkdirSync(path.join(root, "node_modules"));
	symlinkSync(path.join(tmp, "shared/vendor/yaml"), path.join(root, "node_modules/yaml"));
	checkModule(loadModule(root));
});

test("a module whose imports do not resolve fails the check, listing each import", () => {
	const root = write("broken", {
		...EDITS,
		"package.json": { ...PACKAGE, exports: { ...PACKAGE.exports, "./extra": "./extra.js" } },
		"index.js": 'import yaml from "yaml";\nimport "./lib/split.js";\nimport addon from "./build/addon.node";\n',
		"index.d.ts": 'import type { Doc } from "yaml";\nexport declare const x: Doc;\n',
		"lib/split.js": 'import "./missing.js";\n',
		"extra.js": "export const x = 1;\n",
		// No entry point imports this, so its missing dev dependency is not a problem.
		"test/split.test.js": 'import "mocha";\n',
	});
	assert.throws(
		() => checkModule(loadModule(root)),
		(error: Error) => {
			const lines = error.message.split("\n").slice(1).map((line) => line.trim());
			assert.deepEqual(lines.sort(), [
				'"file-edits/extra" has no type declarations',
				'index.d.ts: cannot resolve "yaml"',
				'index.js: cannot resolve "yaml"',
				'index.js: imports the native addon "./build/addon.node"; a module must be pure JavaScript',
				'lib/split.js: cannot resolve "./missing.js"',
			]);
			return true;
		},
	);
});
