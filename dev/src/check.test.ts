import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { checkTau } from "./index.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tau-check-"));
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

/** A contract's package.json. */
const contract = (name: string) => ({ name, version: "1.0.0", description: `The ${name} API.`, tau: { contract: true }, type: "module", types: "./index.d.ts" });

/** A copy of a contract at api/<alias>/, its package.json and `files`. */
function copy(alias: string, files: Record<string, string>): Record<string, string | object> {
	const copied: Record<string, string | object> = { [`api/${alias}/package.json`]: contract(alias) };
	for (const [file, text] of Object.entries(files)) copied[`api/${alias}/${file}`] = text;
	return copied;
}

const NOTES = `/**
 * A notebook of short notes, each with tags to find it by later.
 *
 * @packageDocumentation
 */

import type { EventEmitter } from "node:events";
import type { Readable } from "stream";
import type { Tag } from "./types/tags.js";

/** A saved note. */
export interface Note {
	readonly id: number;
	text: string;
	tags: Tag[];
	written: Date;
	attachments: Map<string, Buffer>;
}

export declare function addNote(text: string, tags?: Tag[]): Promise<Note>;
export declare function byTag(tag: Tag, signal?: AbortSignal): AsyncIterable<Note>;
export declare function find(id: number): Note | undefined;
export declare function find(text: string): Note[];
export declare function pick<K extends keyof Note>(note: Note, key: K): Note[K];
export declare function watch(): EventEmitter | Readable;

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

test("a tau's APIs are copies of contracts, in whatever TypeScript can declare, each holding what its index.d.ts reaches", () => {
	const dir = write("notes", {
		"PROMPT.md": "Keep notes.",
		...copy("notes", { "index.d.ts": NOTES, "types/tags.d.ts": "export type Tag = `#${string}`;\n" }),
		...copy("clock", { "index.d.ts": "export declare function now(): Date;\n" }),
	});
	assert.doesNotThrow(() => checkTau(dir));
	assert.doesNotThrow(() => checkTau(write("none", { "PROMPT.md": "Hi." })));
});

test("an API's copy must type-check, be a module, import only its own files and Node.js's, and hold only its declarations, listing every problem", () => {
	write("outside/node_modules/far-away", { "package.json": { name: "far-away", types: "index.d.ts" }, "index.d.ts": "export type Far = string;\n" });
	write("outside", { "stray.d.ts": "declare const stray: string;\n" });
	const dir = write("outside/broken", {
		"PROMPT.md": "Hi.",
		...copy("typo", { "index.d.ts": "export declare function f(x: strin): void;\n" }),
		...copy("script", { "index.d.ts": "declare function g(): void;\n" }),
		...copy("missing", { "index.d.ts": 'import type { X } from "./nowhere.js";\nexport declare const x: X;\n' }),
		...copy("ghost", { "index.d.ts": 'import type { G } from "@api/clock";\nexport declare const g: G;\n' }),
		...copy("stray", { "index.d.ts": '/// <reference path="../../../stray.d.ts" />\nexport declare const s: typeof stray;\n' }),
		...copy("lib", { "index.d.ts": '/// <reference path="../../lib/types.d.ts" />\nexport declare const l: Lib;\n' }),
		"lib/types.d.ts": "type Lib = number;\n",
		...copy("far", { "index.d.ts": 'import type { Far } from "far-away";\nexport declare const far: Far;\n' }),
		...copy("clock", { "index.d.ts": 'export type { Zone } from "./zones.js";\nexport type Instant = Date;\n', "zones.d.ts": "export type Zone = string;\n", "old/unused.d.ts": "export {};\n" }),
		...copy("peek", { "index.d.ts": 'import type { Zone } from "../clock/zones.js";\nexport declare const zone: Zone;\n' }),
	});
	assert.throws(() => checkTau(dir), (error: Error) => {
		const [first, ...problems] = error.message.split("\n");
		assert.equal(first, `${dir}: breaks the spec:`);
		const other = "a contract imports no package, and no other contract, but Node.js's own modules";
		assert.deepEqual(problems.map((line) => line.trim()).sort(), [
			"api/clock/old/unused.d.ts: index.d.ts does not reach it, so it is no declaration of the contract's",
			`api/far/index.d.ts: imports the package far-away; ${other}`,
			"api/ghost/index.d.ts:1:24: Cannot find module '@api/clock' or its corresponding type declarations.",
			"api/missing/index.d.ts:1:24: Cannot find module './nowhere.js' or its corresponding type declarations.",
			"api/peek/index.d.ts: imports ../clock/zones.js, which lies outside its contract's directory",
			"api/script/index.d.ts: is not a module, so programs cannot import it",
			"api/typo/index.d.ts:1:30: Cannot find name 'strin'. Did you mean 'string'?",
			"the declarations reach ../stray.d.ts, which lies in no contract's directory",
			"the declarations reach lib/types.d.ts, which lies in no contract's directory",
		]);
		return true;
	});
});

test("what loadTau refuses, tau check refuses as loadTau does", () => {
	const dir = write("unread", { "PROMPT.md": "Hi.", "api/notes/index.d.ts": "export {};\n" });
	assert.throws(() => checkTau(dir), /api\/notes: holds no package\.json, a contract's/);
});
