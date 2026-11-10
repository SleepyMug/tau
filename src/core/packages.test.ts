import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadTau } from "./index.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tau-packages-"));
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

const KIT = "node_modules/.pnpm/notes-kit@1.0.0/node_modules/notes-kit";

test("a tau exposes packages of its own, in the order it lists them, each described by its package.json", () => {
	const dir = write(
		"kit",
		{
			"PROMPT.md": "Keep notes.",
			[`${KIT}/package.json`]: { name: "notes-kit", description: "Notes in fewer calls.", types: "index.d.ts" },
			"node_modules/plain-kit/package.json": { name: "plain-kit", types: "index.d.ts" },
			"tau.json": { exposes: ["notes-kit", "plain-kit"] },
		},
		{ "node_modules/notes-kit": ".pnpm/notes-kit@1.0.0/node_modules/notes-kit" },
	);
	assert.deepEqual(loadTau(dir).exposed, [
		{ specifier: "notes-kit", description: "Notes in fewer calls.", dir: path.join(dir, "node_modules/notes-kit") },
		{ specifier: "plain-kit", description: undefined, dir: path.join(dir, "node_modules/plain-kit") },
	]);
	assert.deepEqual(loadTau(write("none", { "PROMPT.md": "Hi.", "node_modules/plain-kit/package.json": { name: "plain-kit" } })).exposed, []);
});

test("what a tau exposes that it lacks is refused", () => {
	const dir = write("missing", { "PROMPT.md": "Hi.", "tau.json": { exposes: ["@acme/missing"] } });
	assert.throws(() => loadTau(dir), /exposes @acme\/missing, which is no package in node_modules\//u);
});

test("APIs are no part of a tau: tau.json's apis is refused", () => {
	const dir = write("apis", { "PROMPT.md": "Hi.", "tau.json": { apis: { "@acme/notes": "^1.0.0" } } });
	assert.throws(() => loadTau(dir), /tau\.json: unknown key "apis"/u);
});

test("node_modules/ follows the tau's rule for symlinks, since a runtime gives the agent's programs its packages", () => {
	const dir = write("absolute", { "PROMPT.md": "Hi.", "node_modules/notes-kit/package.json": { name: "notes-kit" } }, { "node_modules/elsewhere": "/usr" });
	assert.throws(() => loadTau(dir), /node_modules\/elsewhere: leads to the absolute path \/usr; a symlink in a tau is relative/u);
});
