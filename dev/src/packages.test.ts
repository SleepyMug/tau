import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { checkTau } from "./index.js";

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

/** A contract's package.json. */
const contract = (name: string) => ({ name, version: "1.0.0", description: `The ${name} API.`, tau: { contract: true }, type: "module", types: "./index.d.ts" });

const APIS = {
	"PROMPT.md": "Keep notes.",
	"api/notes/package.json": contract("notes"),
	"api/notes/index.d.ts": "export interface Note { id: number; text: string }\nexport declare function addNote(text: string): Promise<Note>;\n",
	"api/clock/package.json": contract("clock"),
	"api/clock/index.d.ts": "export declare function now(): Date;\n",
};

const KIT = "node_modules/.pnpm/notes-kit@1.0.0/node_modules/notes-kit";
const WORDS = "node_modules/.pnpm/word-list@2.0.0/node_modules/word-list";

/** A package built on the notes API, laid out as pnpm installs it, with a dependency of its own. */
const PACKAGES = {
	[`${KIT}/package.json`]: {
		name: "notes-kit",
		type: "module",
		exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
		dependencies: { "word-list": "2.0.0" },
	},
	[`${KIT}/index.d.ts`]: [
		'import type { Note } from "@api/notes";',
		'import type { Words } from "word-list";',
		"export declare function rememberAll(texts: Words): Promise<Note[]>;",
	].join("\n"),
	[`${KIT}/index.js`]: 'import { addNote } from "@api/notes";\nexport const rememberAll = (texts) => Promise.all(texts.map(addNote));\n',
	[`${WORDS}/package.json`]: { name: "word-list", types: "index.d.ts" },
	// A dependency's types are taken as they are, errors and all.
	[`${WORDS}/index.d.ts`]: "export type Words = string[];\nexport declare const broken: Missing;\n",
	"node_modules/plain-kit/package.json": { name: "plain-kit", types: "index.d.ts" },
	"node_modules/plain-kit/index.d.ts": "export declare function hello(): string;\n",
};

const LINKS = {
	"node_modules/notes-kit": ".pnpm/notes-kit@1.0.0/node_modules/notes-kit",
	[`node_modules/.pnpm/notes-kit@1.0.0/node_modules/word-list`]: "../../word-list@2.0.0/node_modules/word-list",
};

test("a tau's packages it exposes are built on its APIs, as the tau holds them", () => {
	const dir = write("kit", { ...APIS, ...PACKAGES, "tau.json": { exposes: ["notes-kit", "@api/clock", "plain-kit"] } }, LINKS);
	assert.doesNotThrow(() => checkTau(dir));
});

test("what a tau exposes is refused, listing every problem, unless its packages type-check on its APIs alone", () => {
	const dir = write(
		"refused",
		{
			...APIS,
			...PACKAGES,
			"tau.json": { exposes: ["broken", "notes-kit"] },
			[`${WORDS}/index.d.ts`]: 'import type { Phantom } from "phantom";\nexport type Words = Phantom[];\n',
			"node_modules/broken/package.json": { name: "broken", types: "index.d.ts" },
			"node_modules/broken/index.d.ts": [
				'import type { Notee } from "@api/notes";',
				'import type { Other } from "@api/other";',
				'import type { Lonely } from "lonely";',
				"export declare const a: [Notee, Other, Lonely];",
			].join("\n"),
		},
		LINKS,
	);
	assert.throws(() => checkTau(dir), (error: Error) => {
		const lines = error.message.split("\n");
		assert.equal(lines[0], `${dir}: breaks the spec:`);
		const problems = lines.slice(1).map((line) => line.trim());
		for (const expected of [
			/^node_modules\/broken\/index\.d\.ts:1:15: '"@api\/notes"' has no exported member named 'Notee'/,
			/^node_modules\/broken\/index\.d\.ts:2:28: Cannot find module '@api\/other'/,
			/^node_modules\/broken\/index\.d\.ts:3:29: Cannot find module 'lonely'/,
			/^node_modules\/\.pnpm\/word-list@2\.0\.0\/node_modules\/word-list\/index\.d\.ts:1:30: Cannot find module 'phantom'/,
		])
			assert.ok(problems.some((problem) => expected.test(problem)), `${String(expected)} in:\n${problems.join("\n")}`);
		assert.equal(problems.length, 4, problems.join("\n"));
		return true;
	});
});
