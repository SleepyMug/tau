import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

import type { Tag } from "./shared/tags.js";
import type { Options } from "tiny-options";

/** A saved note. */
export interface Note {
	readonly id: number;
	text: string;
	tags: Tag[];
	written: Date;
	attachments: Map<string, Buffer>;
}

/**
 * Remember something and return the new note.
 * @param text - What to remember.
 * @param tags - Labels to find it by later.
 */
export declare function addNote(text: string, tags?: Tag[], options?: Options): Promise<Note>;

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
	"api/notes.d.ts": NOTES,
	"api/clock.d.ts": "export declare function now(): Date;\n",
	"api/shared/tags.d.ts": "export type Tag = `#${string}`;\n",
	"api/node_modules/tiny-options/package.json": JSON.stringify({ name: "tiny-options", types: "index.d.ts" }),
	// A package's types are taken as they are, errors and all.
	"api/node_modules/tiny-options/index.d.ts": "export interface Options { pinned?: boolean }\nexport const broken: Missing;\n",
};

test("each api/<name>.d.ts is an API, in whatever TypeScript can declare", () => {
	const dir = write("notes", TAU);
	const apis = loadApis(dir);
	assert.deepEqual(
		apis.map(({ name, specifier, file }) => ({ name, specifier, file })),
		[
			{ name: "clock", specifier: "@api/clock", file: path.join(dir, "api/clock.d.ts") },
			{ name: "notes", specifier: "@api/notes", file: path.join(dir, "api/notes.d.ts") },
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
	const dir = write("outside/broken", {
		"PROMPT.md": "Hi.",
		"api/typo.d.ts": "export declare function f(x: strin): void;\n",
		"api/script.d.ts": "declare function g(): void;\n",
		"api/missing.d.ts": 'import type { X } from "./nowhere.js";\nexport declare const x: X;\n',
		"api/far.d.ts": 'import type { Far } from "far-away";\nexport declare const far: Far;\n',
		"api/bad name.d.ts": "export {};\n",
	});
	assert.throws(() => loadApis(dir), (error: Error) => {
		assert.deepEqual(error.message.split("\n"), [
			`${dir}: its APIs break the spec:`,
			`  api/bad name.d.ts: an API's name matches ^[A-Za-z0-9][A-Za-z0-9._-]*$`,
			`  the APIs reach ${path.join(tmp, "outside/node_modules/far-away/index.d.ts")}, which lies outside the tau`,
			"  api/missing.d.ts:1:24: Cannot find module './nowhere.js' or its corresponding type declarations.",
			"  api/typo.d.ts:1:30: Cannot find name 'strin'. Did you mean 'string'?",
			"  api/script.d.ts: is not a module, so programs cannot import it",
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
		assert.match(error.message, /is missing the following properties from type 'typeof import\(.*\/api\/notes"\)': byTag, find, pick, Draft/);
		return true;
	});
});
