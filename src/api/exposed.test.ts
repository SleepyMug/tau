import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadApis, loadExposed, loadTau } from "../index.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tau-exposed-"));
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

const APIS = {
	"PROMPT.md": "Keep notes.",
	"api/notes/index.d.ts": "export interface Note { id: number; text: string }\nexport declare function addNote(text: string): Promise<Note>;\n",
	"api/clock/index.d.ts": "/**\n * The time.\n *\n * @packageDocumentation\n */\nexport declare function now(): Date;\n",
};

const KIT = "node_modules/.pnpm/notes-kit@1.0.0/node_modules/notes-kit";
const WORDS = "node_modules/.pnpm/word-list@2.0.0/node_modules/word-list";

/** A package built on the notes API, laid out as pnpm installs it, with a dependency of its own. */
const PACKAGES = {
	[`${KIT}/package.json`]: {
		name: "notes-kit",
		type: "module",
		exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
		peerDependencies: { "@api/notes": "*" },
		dependencies: { "word-list": "2.0.0" },
	},
	[`${KIT}/index.d.ts`]: [
		"/**\n * Notes in fewer calls.\n *\n * @packageDocumentation\n */",
		'import type { Note } from "@api/notes";',
		'import type { Words } from "word-list";',
		"export declare function rememberAll(texts: Words): Promise<Note[]>;",
	].join("\n"),
	[`${KIT}/index.js`]: 'import { addNote } from "@api/notes";\nexport const rememberAll = (texts) => Promise.all(texts.map(addNote));\n',
	[`${WORDS}/package.json`]: { name: "word-list", types: "index.d.ts" },
	// A dependency's types are taken as they are, errors and all.
	[`${WORDS}/index.d.ts`]: "export type Words = string[];\nexport declare const broken: Missing;\n",
	"node_modules/plain-kit/package.json": { name: "plain-kit", description: "Plain helpers.", types: "index.d.ts" },
	"node_modules/plain-kit/index.d.ts": "export declare function hello(): string;\n",
};

const LINKS = {
	"node_modules/notes-kit": ".pnpm/notes-kit@1.0.0/node_modules/notes-kit",
	[`node_modules/.pnpm/notes-kit@1.0.0/node_modules/word-list`]: "../../word-list@2.0.0/node_modules/word-list",
};

const load = (dir: string) => loadExposed(loadTau(dir), loadApis(dir));

test("without exposes, the programs import every API", () => {
	const dir = write("every", { ...APIS, ...PACKAGES }, LINKS);
	const apis = loadApis(dir);
	assert.deepEqual(loadExposed(loadTau(dir), apis), [
		{ kind: "api", specifier: "@api/clock", description: "The time.", api: apis[0] },
		{ kind: "api", specifier: "@api/notes", description: undefined, api: apis[1] },
	]);
});

test("a tau exposes APIs and packages of its own, built on its APIs, in the order it lists them", () => {
	const dir = write("kit", { ...APIS, ...PACKAGES, "tau.json": { exposes: ["notes-kit", "@api/clock", "plain-kit"] } }, LINKS);
	const tau = loadTau(dir);
	assert.deepEqual(tau.exposes, ["notes-kit", "@api/clock", "plain-kit"]);
	const apis = loadApis(dir);
	assert.deepEqual(loadExposed(tau, apis), [
		{ kind: "package", specifier: "notes-kit", description: "Notes in fewer calls.", dir: path.join(dir, "node_modules/notes-kit") },
		{ kind: "api", specifier: "@api/clock", description: "The time.", api: apis[0] },
		{ kind: "package", specifier: "plain-kit", description: "Plain helpers.", dir: path.join(dir, "node_modules/plain-kit") },
	]);
});

test("what a tau exposes is refused, listing every problem, unless its packages are built on its APIs alone", () => {
	const dir = write(
		"refused",
		{
			...APIS,
			...PACKAGES,
			"tau.json": { exposes: ["broken", "@api/missing", "absent", "notes-kit"] },
			[`${WORDS}/index.d.ts`]: 'import type { Phantom } from "phantom";\nexport type Words = Phantom[];\n',
			// A stub the author built against, left in the tau.
			"node_modules/.pnpm/notes-kit@1.0.0/node_modules/@api/notes/package.json": { name: "@api/notes", types: "index.d.ts" },
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
	assert.throws(() => load(dir), (error: Error) => {
		const lines = error.message.split("\n");
		assert.equal(lines[0], `${dir}: what it exposes breaks the spec:`);
		const problems = lines.slice(1).map((line) => line.trim());
		for (const expected of [
			"exposes @api/missing, but the tau has no api/missing/index.d.ts",
			"exposes absent, which is not a package in node_modules/",
			"node_modules/.pnpm/notes-kit@1.0.0/node_modules/@api: an @api scope in the tau would hide the runtime's implementations",
			/^node_modules\/broken\/index\.d\.ts:1:15: '"@api\/notes"' has no exported member named 'Notee'/,
			/^node_modules\/broken\/index\.d\.ts:2:28: Cannot find module '@api\/other'/,
			/^node_modules\/broken\/index\.d\.ts:3:29: Cannot find module 'lonely'/,
			/^node_modules\/\.pnpm\/word-list@2\.0\.0\/node_modules\/word-list\/index\.d\.ts:1:30: Cannot find module 'phantom'/,
		]) {
			assert.ok(
				problems.some((problem) => (typeof expected === "string" ? problem === expected : expected.test(problem))),
				`${String(expected)} in:\n${problems.join("\n")}`,
			);
		}
		assert.equal(problems.length, 7, problems.join("\n"));
		return true;
	});
});

test("node_modules/ follows the tau's rule for symlinks once the tau exposes a package of its own", () => {
	const files = { ...APIS, ...PACKAGES };
	const links = { ...LINKS, "node_modules/elsewhere": "/usr" };
	assert.doesNotThrow(() => loadTau(write("apis-only", { ...files, "tau.json": { exposes: ["@api/notes"] } }, links)));
	assert.throws(
		() => loadTau(write("absolute", { ...files, "tau.json": { exposes: ["notes-kit"] } }, links)),
		/node_modules\/elsewhere: leads to the absolute path \/usr; a symlink in a tau is relative/,
	);
});
