import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { checkImplementation, loadApis } from "./index.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tau-api-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Writes `files` under `dir` (relative to the test directory) and returns its absolute path. */
function write(dir: string, files: Record<string, string>): string {
	const root = path.join(tmp, dir);
	mkdirSync(root, { recursive: true });
	for (const [file, contents] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		writeFileSync(path.join(root, file), contents);
	}
	return root;
}

const NOTES = `/**
 * A notebook of short notes, each with tags to find it by later.
 *
 * @packageDocumentation
 */

import type { Instant } from "@api/clock";
import type { Tag } from "./tags.js";

/** A saved note. */
export interface Note {
	readonly id: number;
	text: string;
	tags: Tag[];
	written: Instant;
	attachments: Map<string, Buffer>;
}

/**
 * Remember something and return the new note.
 * @param text - What to remember.
 * @param tags - Labels to find it by later.
 */
export declare function addNote(text: string, tags?: Tag[]): Promise<Note>;

/** Notes carrying \`tag\`, oldest first, as they are found. */
export declare function byTag(tag: Tag, signal?: AbortSignal): AsyncIterable<Note>;

export declare function find(id: number): Note | undefined;
export declare function find(text: string): Note[];

export declare function pick<K extends keyof Note>(note: Note, key: K): Note[K];

/** Notes, kept in memory until \`save\`. */
export declare class Draft {
	constructor(title: string);
	readonly title: string;
	add(text: string): this;
	save(): Promise<Note[]>;
	static open(title: string): Promise<Draft>;
}

export declare const version: string;
`;

const TAU = {
	"PROMPT.md": "Keep notes.",
	"api/notes/index.d.ts": NOTES,
	"api/notes/tags.d.ts": "export type Tag = `#${string}`;\n",
	// Node.js's own modules are the environment's, by either name.
	"api/clock/index.d.ts": [
		'import type { EventEmitter } from "node:events";',
		'import type { Readable } from "stream";',
		"export type Instant = Date;",
		"export declare function now(): Instant;",
		"export declare function ticks(): EventEmitter | Readable;",
	].join("\n"),
};

test("each directory in api/ is an API, in whatever TypeScript can declare", () => {
	const dir = write("notes", TAU);
	const apis = loadApis(dir);
	assert.deepEqual(
		apis.map(({ name, specifier, file }) => ({ name, specifier, file })),
		[
			{ name: "clock", specifier: "@api/clock", file: path.join(dir, "api/clock/index.d.ts") },
			{ name: "notes", specifier: "@api/notes", file: path.join(dir, "api/notes/index.d.ts") },
		],
	);
	assert.equal(apis[1]?.description, "A notebook of short notes, each with tags to find it by later.");
	assert.equal(apis[0]?.description, undefined);
	assert.deepEqual(loadApis(write("none", { "PROMPT.md": "Hi." })), []);
});

test("API files must type-check as TypeScript does, and be modules, listing every problem", () => {
	// Types the tau does not have, resolved from above it.
	write("outside/node_modules/far-away", {
		"package.json": JSON.stringify({ name: "far-away", types: "index.d.ts" }),
		"index.d.ts": "export type Far = string;\n",
	});
	write("outside", { "stray.d.ts": "declare const stray: string;\n" });
	const dir = write("outside/broken", {
		"PROMPT.md": "Hi.",
		"api/typo/index.d.ts": "export declare function f(x: strin): void;\n",
		"api/script/index.d.ts": "declare function g(): void;\n",
		"api/missing/index.d.ts": 'import type { X } from "./nowhere.js";\nexport declare const x: X;\n',
		"api/ghost/index.d.ts": 'import type { G } from "@api/nothing";\nexport declare const g: G;\n',
		"api/bad name/index.d.ts": "export {};\n",
		"api/stray/index.d.ts": '/// <reference path="../../../stray.d.ts" />\nexport declare const s: typeof stray;\n',
		"api/lib/index.d.ts": '/// <reference path="../../lib/types.d.ts" />\nexport declare const l: Lib;\n',
		"lib/types.d.ts": "type Lib = number;\n",
		// Gone: a file of its own in api/, and a directory without index.d.ts.
		"api/old.d.ts": "export {};\n",
		"api/empty/README.md": "",
	});
	assert.throws(() => loadApis(dir), (error: Error) => {
		const [first, ...problems] = error.message.split("\n");
		assert.equal(first, `${dir}: its APIs break the spec:`);
		assert.deepEqual(problems.map((line) => line.trim()).sort(), [
			"api/bad name: an API's name matches ^[A-Za-z0-9][A-Za-z0-9._-]*$",
			"api/empty: an API's directory holds its index.d.ts",
			"api/ghost/index.d.ts:1:24: Cannot find module '@api/nothing' or its corresponding type declarations.",
			"api/missing/index.d.ts:1:24: Cannot find module './nowhere.js' or its corresponding type declarations.",
			"api/old.d.ts: api/ holds only APIs, each a directory with its index.d.ts",
			"api/script/index.d.ts: is not a module, so programs cannot import it",
			"api/typo/index.d.ts:1:30: Cannot find name 'strin'. Did you mean 'string'?",
			`the APIs reach ${path.join(tmp, "outside/stray.d.ts")}, which lies outside the tau`,
			"the APIs reach lib/types.d.ts, which lies in no API's directory",
		]);
		return true;
	});
});

test("an API imports another as @api/<name>, and no package", () => {
	write("packages/node_modules/far-away", {
		"package.json": JSON.stringify({ name: "far-away", types: "index.d.ts" }),
		"index.d.ts": "export type Far = string;\n",
	});
	const dir = write("packages/importing", {
		"PROMPT.md": "Hi.",
		"api/clock/index.d.ts": "export type Instant = Date;\nexport declare function now(): Instant;\n",
		"api/clock/zones.d.ts": "export type Zone = string;\n",
		"api/far/index.d.ts": 'import type { Far } from "far-away";\nexport declare const far: Far;\n',
		"api/own/index.d.ts": 'import type { Own } from "own-types";\nexport declare const own: Own;\n',
		"api/own/node_modules/own-types/package.json": JSON.stringify({ name: "own-types", types: "index.d.ts" }),
		"api/own/node_modules/own-types/index.d.ts": "export type Own = number;\nexport declare const broken: Missing;\n",
		"api/peek/index.d.ts": 'import type { Zone } from "../clock/zones.js";\nexport declare const zone: Zone;\n',
		"api/deep/index.d.ts": 'import type { Zone } from "@api/clock/zones";\nexport declare const zone: Zone;\n',
		"api/fine/index.d.ts": 'import type { Instant } from "@api/clock";\nexport declare function later(): Instant;\n',
	});
	assert.throws(() => loadApis(dir), (error: Error) => {
		const problems = error.message.split("\n").slice(1).map((line) => line.trim()).sort();
		const packages = "an API imports no package but another API of the tau, as @api/<name>, and Node.js's own modules";
		assert.deepEqual(problems, [
			"api/deep/index.d.ts:1:27: Cannot find module '@api/clock/zones' or its corresponding type declarations.",
			`api/far/index.d.ts: imports the package far-away; ${packages}`,
			`api/own/index.d.ts: imports the package own-types; ${packages}`,
			"api/peek/index.d.ts: imports ../clock/zones.js, which lies outside its API's directory; it imports another API as @api/<name>",
		]);
		return true;
	});
});

test("a runtime links an implementation whose module fits the API, and may offer more", () => {
	const dir = write("linked", TAU);
	const notes = loadApis(dir).find((api) => api.name === "notes");
	assert.ok(notes !== undefined);
	// An ES module, where the API is CommonJS.
	const implementation = write("implementations/notes", {
		"package.json": JSON.stringify({ type: "module" }),
		"index.js": "",
		"index.d.ts": `export interface Note {
	readonly id: number;
	text: string;
	tags: \`#\${string}\`[];
	written: Date;
	attachments: Map<string, Buffer>;
	revision?: number;
}
export declare function addNote(text: string, tags?: string[], options?: { pinned?: boolean }): Promise<Note>;
export declare function byTag(tag: string, signal?: AbortSignal): AsyncGenerator<Note>;
export declare function find(id: number): Note | undefined;
export declare function find(text: string): Note[];
export declare function pick<K extends keyof Note>(note: Note, key: K): Note[K];
export declare class Draft {
	constructor(title: string);
	readonly title: string;
	add(text: string): this;
	save(): Promise<Note[]>;
	static open(title: string): Promise<Draft>;
	discard(): void;
}
export declare const version: string;
export declare function remove(id: number): Promise<void>;
`,
	});
	checkImplementation(notes, path.join(implementation, "index.d.ts"));
	// Or by its JavaScript, with the declarations beside it.
	checkImplementation(notes, path.join(implementation, "index.js"));

	const partial = write("implementations/partial", {
		"index.d.ts": `export declare function addNote(text: number): Promise<{ id: number }>;
export declare const version: string;
`,
	});
	// JavaScript without declarations tells TypeScript nothing.
	const untyped = write("implementations/untyped", { "index.js": "export function addNote() {}\n" });
	assert.throws(
		() => checkImplementation(notes, path.join(untyped, "index.js")),
		/index\.js: does not implement @api\/notes:\n {2}Could not find a declaration file for module/,
	);
	assert.throws(() => checkImplementation(notes, path.join(partial, "index.d.ts")), (error: Error) => {
		assert.match(error.message, /^\S+\/implementations\/partial\/index\.d\.ts: does not implement @api\/notes:\n/);
		assert.match(error.message, /is missing the following properties from type 'typeof import\(.*\/api\/notes\/index"\)': byTag, find, pick, Draft/);
		return true;
	});
	// The API's types from another API are that API's: an Instant is a Date.
	const fitting = readFileSync(path.join(implementation, "index.d.ts"), "utf8");
	const stringly = write("implementations/stringly", { "index.d.ts": fitting.replace("written: Date;", "written: string;") });
	assert.throws(() => checkImplementation(notes, path.join(stringly, "index.d.ts")), /Type 'string' is not assignable to type 'Date'/);
});
