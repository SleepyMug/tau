import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { checkModule, loadModule, loadModules, loadTau } from "./index.js";

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

/** A symlink at `link`, relative to the test directory, leading to `target` as written. */
function link(target: string, at: string): void {
	mkdirSync(path.dirname(path.join(tmp, at)), { recursive: true });
	symlinkSync(target, path.join(tmp, at));
}

/** Each line of a thrown error after the first, sorted. */
function problems(run: () => void): string[] {
	try {
		run();
	} catch (error) {
		return (error as Error).message.split("\n").slice(1).map((line) => line.trim()).sort();
	}
	assert.fail("did not throw");
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
const NOTES = "export declare function addNote(text: string): Promise<number>;\n";

test("a module is a package named by its package.json, and may be a symlink", () => {
	write("agent", { "PROMPT.md": "Edit.", "tau.json": { copy: ["modules", "lib"] } });
	write("agent/modules/edits", EDITS);
	write("agent/lib/notes-format", { ...EDITS, "package.json": { ...PACKAGE, name: "notes-format" } });
	link("../lib/notes-format", "agent/modules/format");
	const tau = loadTau(path.join(tmp, "agent"));
	const modules = loadModules(tau);
	assert.deepEqual(modules, [
		{ name: "file-edits", description: "Edit text files in bulk.", root: path.join(tmp, "agent/modules/edits") },
		{ name: "notes-format", description: "Edit text files in bulk.", root: path.join(tmp, "agent/modules/format") },
	]);
	for (const module of modules) checkModule(module, tau);
	assert.deepEqual(loadModules(loadTau(write("bare", { "PROMPT.md": "Hi." }))), []);
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
	write("twice", { "PROMPT.md": "Edit." });
	write("twice/modules/a", EDITS);
	write("twice/modules/b", EDITS);
	assert.throws(() => loadModules(loadTau(path.join(tmp, "twice"))), /package name file-edits is also used by/);
});

test("a module is something the tau copies, and modules/node_modules/ holds none", () => {
	write("partly", { "PROMPT.md": "Edit.", "tau.json": { copy: ["modules/a/package.json", "modules/a/index.js", "modules/a/index.d.ts", "modules/a/lib", "modules/node_modules"] } });
	write("partly/modules/a", { ...EDITS, "src/index.ts": "export const x = 1;\n" });
	write("partly/modules/node_modules/yaml", { "package.json": { name: "yaml" }, "index.js": "" });
	const tau = loadTau(path.join(tmp, "partly"));
	const [edits, ...rest] = loadModules(tau);
	assert.equal(rest.length, 0);
	assert.ok(edits);
	checkModule(edits, tau);

	write("partly/modules/b", { ...EDITS, "package.json": { ...PACKAGE, name: "b" } });
	assert.throws(() => loadModules(loadTau(path.join(tmp, "partly"))), /modules\/b: tau\.json does not copy it/);
});

test("a module's imports resolve within what the tau copies: its files, a node_modules/, relative symlinks", () => {
	write("resolving", { "PROMPT.md": "Edit.", "tau.json": { copy: ["modules", "shared"] } });
	write("resolving/shared", { "util.js": "export const util = 1;\n" });
	// Laid out the way pnpm installs it.
	write("resolving/modules/node_modules/.pnpm/yaml@2.0.0/node_modules/yaml", {
		"package.json": { name: "yaml", main: "index.cjs" },
		"index.cjs": 'const util = require("util");\nmodule.exports = {};\n',
	});
	link("../../node_modules/.pnpm/yaml@2.0.0/node_modules/yaml", "resolving/modules/edits/node_modules/yaml");
	write("resolving/modules/edits", {
		...EDITS,
		"package.json": { ...PACKAGE, exports: { ...PACKAGE.exports, "./extra": { types: "./extra.d.ts", default: "./extra.js" } } },
		"index.js": 'import yaml from "yaml";\nimport { util } from "../../shared/util.js";\nimport { x } from "file-edits/extra";\n',
		"extra.js": "export const x = 1;\n",
		"extra.d.ts": "export declare const x: number;\n",
	});
	const tau = loadTau(path.join(tmp, "resolving"));
	for (const module of loadModules(tau)) checkModule(module, tau);
});

test("a module whose imports do not resolve within what the tau copies fails the check, listing each", () => {
	write("broken", { "PROMPT.md": "Edit." });
	// Outside the tau, where Node would find it from the tau, but not from a copy.
	write("node_modules/left-pad", { "package.json": { name: "left-pad", main: "index.js" }, "index.js": "" });
	write("broken/src", { "util.js": "export const util = 1;\n" });
	write("broken/modules/edits", {
		...EDITS,
		"package.json": { ...PACKAGE, exports: { ...PACKAGE.exports, "./extra": "./extra.js" } },
		"index.js": 'import yaml from "yaml";\nimport "./lib/split.js";\nimport addon from "./build/addon.node";\nimport pad from "left-pad";\nimport "../../src/util.js";\n',
		"index.d.ts": 'import type { Doc } from "yaml";\nexport declare const x: Doc;\n',
		"lib/split.js": 'import "./missing.js";\n',
		"extra.js": "export const x = 1;\n",
		// No entry point imports this, so its missing dev dependency is not a problem.
		"test/split.test.js": 'import "mocha";\n',
	});
	const tau = loadTau(path.join(tmp, "broken"));
	const [edits] = loadModules(tau);
	assert.ok(edits);
	assert.deepEqual(problems(() => checkModule(edits, tau)), [
		'"file-edits/extra" has no type declarations',
		`index.js: "left-pad" resolves to ${path.join(tmp, "node_modules/left-pad/index.js")}, which the tau does not copy`,
		'index.js: "../../src/util.js" resolves to src/util.js, which the tau does not copy',
		'index.d.ts: cannot resolve "yaml"',
		'index.js: cannot resolve "yaml"',
		'index.js: imports the native addon "./build/addon.node"; a module must be pure JavaScript',
		'lib/split.js: cannot resolve "./missing.js"',
	].sort());
});

test("a module imports a service of api/ as @svc/<name>, typed while it is built by what the tau keeps there", () => {
	write("wrapping", { "PROMPT.md": "Take notes.", "tau.json": { copy: ["modules", "lib"] }, "api/notes.d.ts": NOTES });
	// What a module is built against; a runtime puts its own @svc/notes in its place.
	write("wrapping/modules/node_modules/@svc/notes", { "package.json": { name: "@svc/notes", types: "./index.d.ts" } });
	link("../../../../api/notes.d.ts", "wrapping/modules/node_modules/@svc/notes/index.d.ts");
	write("wrapping/lib", { "mail.js": 'import { send } from "@svc/mail";\nimport { addNote } from "@svc/notes";\n' });
	write("wrapping/modules/notes-plus", {
		...EDITS,
		"package.json": { ...PACKAGE, name: "notes-plus" },
		"index.js": 'import { addNote } from "@svc/notes";\nimport "../../lib/mail.js";\nexport const remember = (text) => addNote(text);\n',
		"index.d.ts": 'import type { addNote } from "@svc/notes";\nexport declare const remember: typeof addNote;\n',
	});
	const tau = loadTau(path.join(tmp, "wrapping"));
	const [notesPlus] = loadModules(tau);
	assert.ok(notesPlus);
	assert.deepEqual(problems(() => checkModule(notesPlus, tau)), [
		'lib/mail.js: imports "@svc/mail", but api/ declares no service mail',
		'lib/mail.js: imports "@svc/notes", which resolves only from modules/',
	]);

	write("wrapping/modules/node_modules/@svc/mail", { "package.json": { name: "@svc/mail" } });
	assert.throws(() => loadModules(loadTau(path.join(tmp, "wrapping"))), /@svc\/mail: api\/ declares no service mail/);
});
