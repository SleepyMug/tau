import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadService, loadServices, serviceCodec } from "./index.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tau-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function write(file: string, text: string): string {
	const full = path.join(tmp, file);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, text);
	return full;
}

const NOTES = `/**
 * A notebook of short notes, each with tags to find it by later.
 *
 * @packageDocumentation
 */

export interface Note {
	id: number;
	text: string;
	tags: string[];
}

/**
 * Remember something and return the new note.
 * @param text - What to remember.
 */
export declare function addNote(text: string, tags?: string[]): Promise<Note>;

/** Forget a note. */
export function forget(id: number): Promise<void>;
`;

const notes = () => loadService(write("agent/api/notes.d.ts", NOTES));

test("a manifest's exported functions are the service's, named by its file", () => {
	const service = notes();
	assert.deepEqual(
		loadServices(path.join(tmp, "agent")).map((s) => s.name),
		["notes"],
	);
	assert.equal(service.name, "notes");
	assert.deepEqual(service.functions, ["addNote", "forget"]);
	// What `@svc/notes` declares: the manifest as written.
	assert.equal(service.declarations, NOTES);
	assert.deepEqual(loadServices(tmp), []);
});

test("a manifest may be a symlink, and so may api/", () => {
	const shared = write("shared/notes.d.ts", NOTES);
	mkdirSync(path.join(tmp, "linked/api"), { recursive: true });
	symlinkSync(shared, path.join(tmp, "linked/api/notes.d.ts"));
	mkdirSync(path.join(tmp, "via-dir"));
	symlinkSync(path.join(tmp, "linked/api"), path.join(tmp, "via-dir/api"));
	for (const dir of ["linked", "via-dir"]) {
		assert.deepEqual(
			loadServices(path.join(tmp, dir)).map((service) => service.functions),
			[["addNote", "forget"]],
		);
	}
});

test("the package documentation describes the service", () => {
	const service = notes();
	assert.equal(service.description, "A notebook of short notes, each with tags to find it by later.");

	const undescribed = loadService(write("plain.d.ts", "/** Say hi. */\nexport function hi(): Promise<string>;\n"));
	assert.equal(undescribed.description, undefined);
});

test("a manifest outside the translatable subset is refused, naming the file and the reason", () => {
	const refused: [string, string, RegExp][] = [
		["syntax", "export function f(: void;", /syntax\.d\.ts: is not valid TypeScript/],
		["none", "export interface A { a: string }", /none\.d\.ts: declares no exported function/],
		["imports", 'import type { X } from "./x.js";\nexport function f(): Promise<void>;', /line 1: declares something other/],
		["values", "export declare const limit: number;\nexport function f(): Promise<void>;", /line 1: declares something other/],
		["enums", "export enum Color { Red }\nexport function f(c: Color): Promise<void>;", /line 1: declares something other/],
		["hidden", "declare function f(): Promise<void>;\nexport function g(): Promise<void>;", /f: must be exported/],
		["untyped", "export function f(a: string);", /f: needs a return type annotation/],
		["bare", "export function f(): string;", /f: must return Promise<T>, or Promise<void> for no result/],
		["bare-void", "export function f(): void;", /f: must return Promise<T>/],
		["promise-like", "export function f(): PromiseLike<string>;", /f: must return Promise<T>/],
		["qualified", "export function f(): globalThis.Promise<string>;", /f: must return Promise<T>/],
		["aliased", "type Later<T> = Promise<T>;\nexport function f(): Later<string>;", /f: must return Promise<T>/],
		["shadowed", "interface Promise<T> { value: T }\nexport function f(): Promise<string>;", /Promise: is the global Promise/],
		["generic", "export function f<T>(a: T): Promise<T>;", /f: is generic/],
		["overload", "export function f(a: string): Promise<void>;\nexport function f(a: number): Promise<void>;", /f: must be declared exactly once/],
		["rest", "export function f(...a: string[]): Promise<void>;", /f\(a\): is a rest parameter/],
		["default", "export function f(a: string, b: number = 1): Promise<void>;", /f\(b\): has a default value, which only an implementation can have; write it optional with \?/],
		["undefined", "export function f(a: string | undefined): Promise<void>;", /f\(a\): has a type including `undefined`/],
	];
	for (const [name, text, reason] of refused) {
		assert.throws(() => loadService(write(`${name}.d.ts`, text)), reason, name);
	}
});

test("a type JSON cannot carry faithfully is refused by the identity check", () => {
	const dated = write("dated.d.ts", "export function at(day: Date): Promise<void>;\n");
	assert.throws(() => loadService(dated), (error: Error) => {
		assert.match(error.message, /dated\.d\.ts: does not translate to JSON Schema/);
		assert.match(error.message, /at: its parameters cannot be carried as JSON without changing/);
		assert.match(error.message, /declared: function at\(day: Date\): Promise<void>/);
		return true;
	});
	const counted = write("counted.d.ts", "export function counts(): Promise<Map<string, number>>;\n");
	assert.throws(() => loadService(counted), /counts: its result cannot be carried as JSON without changing/);
	const nested = write("nested.d.ts", "export function later(): Promise<Promise<string>>;\n");
	assert.throws(() => loadService(nested), /later: its result cannot be carried as JSON without changing/);
});

test("arguments are checked, and reduced to what the manifest declares", () => {
	const service = notes();
	assert.deepEqual(service.checkArguments("addNote", ["milk"]), ["milk"]);
	assert.throws(() => service.checkArguments("addNote", [42]), /^TypeError: notes\.addNote: text: must be string$/);
	assert.throws(() => service.checkArguments("addNote", []), /notes\.addNote: expected 1 to 2 arguments, got 0/);
	assert.throws(() => service.checkArguments("forget", [1, 2]), /notes\.forget: expected 1 arguments, got 2/);
	assert.throws(() => service.checkArguments("nope", []), /notes: no function "nope"/);
});

test("results are checked, and reduced to what the manifest declares", () => {
	const service = notes();
	const note = { id: 1, text: "milk", tags: [] };
	assert.deepEqual(service.checkResult("addNote", { ...note, secret: "hash" }), note);
	assert.throws(
		() => service.checkResult("addNote", { ...note, id: "one" }),
		/notes\.addNote: the result does not match the manifest: \/id: must be number/,
	);
	// A function without a result answers null, whatever the provider sent.
	assert.equal(service.checkResult("forget", "ignored"), null);
});

const FILES = `/** Files kept as bytes. @packageDocumentation */

export interface File {
	name: string;
	/** What the file holds. */
	data: Uint8Array;
}

export type Chunk = { kind: "text"; text: string } | { kind: "bytes"; data: Uint8Array };

export declare function put(file: File, chunks?: Chunk[]): Promise<Uint8Array>;

export declare function sizes(files: Record<string, Uint8Array>): Promise<Uint8Array | null>;

export declare function note(meta: Record<string, unknown>): Promise<number>;
`;

const files = () => loadService(write("agent/api/files.d.ts", FILES));

test("Uint8Array is bytes: base64 on the wire, a Uint8Array in programs and providers", () => {
	const service = files();
	const wire = [
		{ name: "a", data: "aGk=" },
		[
			{ kind: "bytes", data: "AAE=" },
			{ kind: "text", text: "AAE=" },
		],
	];
	// What a provider takes: bytes where the manifest has them, text elsewhere.
	const taken = [
		{ name: "a", data: new Uint8Array([104, 105]) },
		[
			{ kind: "bytes", data: new Uint8Array([0, 1]) },
			{ kind: "text", text: "AAE=" },
		],
	];
	assert.deepEqual(service.decodeArguments("put", wire), taken);
	// A program's arguments go out as the provider will read them.
	assert.deepEqual(service.encodeArguments("put", taken), wire);
	// A relay keeps the wire form.
	assert.deepEqual(service.checkArguments("put", wire), wire);
	assert.equal(service.encodeResult("put", new Uint8Array([104, 105])), "aGk=");
	assert.deepEqual(service.decodeResult("put", "aGk="), new Uint8Array([104, 105]));
	assert.deepEqual(service.decodeArguments("sizes", [{ empty: "" }]), [{ empty: new Uint8Array() }]);
	assert.equal(service.decodeResult("sizes", null), null);
	// A Buffer is a Uint8Array.
	assert.equal(service.encodeResult("sizes", Buffer.from("hi")), "aGk=");
});

test("bytes are checked in either form, and go only where the manifest has them", () => {
	const service = files();
	assert.throws(
		() => service.checkArguments("put", [{ name: "a", data: "aGk" }]),
		/^TypeError: files\.put: file\/data: must be bytes, as a base64 string/,
	);
	assert.throws(() => service.decodeArguments("put", [{ name: "a", data: 7 }]), /files\.put: file\/data: must be bytes/);
	assert.throws(
		() => service.encodeArguments("put", [{ name: "a", data: "aGk=" }]),
		/files\.put: file\/data: must be bytes, a Uint8Array/,
	);
	assert.throws(
		() => service.encodeArguments("put", [{ name: new Uint8Array(), data: new Uint8Array() }]),
		/files\.put: file\/name: must be string, not bytes/,
	);
	assert.throws(() => service.encodeResult("put", "aGk="), /the result does not match the manifest: result: must be bytes/);
	// Where the manifest allows anything, a value must still be what JSON carries.
	assert.throws(
		() => service.encodeArguments("note", [{ raw: new Uint8Array() }]),
		/files\.note: meta\/raw: must not be bytes: the manifest declares no Uint8Array here/,
	);
	assert.throws(() => service.encodeArguments("note", [{ at: new Date() } as never]), /meta\/at: must be JSON/);
	assert.throws(() => service.encodeResult("note", Number.NaN), /result: must be a finite number/);
	const loop: Record<string, unknown> = {};
	loop.self = loop;
	assert.throws(() => service.encodeArguments("note", [loop as never]), /meta\/self: must not contain itself/);
});

test("a manifest in which one string could be bytes or text is refused", () => {
	const refused: [string, string, RegExp][] = [
		["mixed", "export function f(a: string | Uint8Array): Promise<void>;", /mixed\.f\(a\) is a union that one string could match as bytes/],
		["overlap", "export function f(a: { data: string } | { data: Uint8Array }): Promise<void>;", /overlap\.f\(a\) is a union/],
		["loose", "export function f(): Promise<{ data: Uint8Array } | Record<string, unknown>>;", /loose\.f: its result is a union/],
		["own", "export interface Uint8Array { length: number }\nexport function f(a: Uint8Array): Promise<void>;", /Uint8Array: is the global Uint8Array/],
		["buffer", "export function f(a: Uint8Array<ArrayBuffer>): Promise<void>;", /f: its parameters cannot be carried as JSON without changing/],
	];
	for (const [name, text, reason] of refused) {
		assert.throws(() => loadService(write(`${name}.d.ts`, text)), reason, name);
	}
	// Members no value can match both of are fine, however they hold bytes.
	const told = loadService(
		write("told.d.ts", "export function f(a: Uint8Array | null | number, b: { kind: 1; v: Uint8Array } | { kind: 2; v: string }): Promise<void>;\n"),
	);
	assert.deepEqual(told.decodeArguments("f", [null, { kind: 2, v: "AA==" }]), [null, { kind: 2, v: "AA==" }]);
	assert.deepEqual(told.decodeArguments("f", ["AA==", { kind: 1, v: "AA==" }]), [new Uint8Array([0]), { kind: 1, v: new Uint8Array([0]) }]);
});

test("a codec made from a service's schema, as JSON, handles calls as the service does", () => {
	const service = files();
	const codec = serviceCodec(JSON.parse(JSON.stringify(service.schema)));
	assert.deepEqual(codec.schema, service.schema);
	assert.deepEqual(codec.functions, service.functions);
	assert.equal(codec.description, "Files kept as bytes.");
	const args = [{ name: "a", data: new Uint8Array([1, 2, 3]) }];
	assert.deepEqual(codec.encodeArguments("put", args), service.encodeArguments("put", args));
	assert.deepEqual(codec.decodeResult("put", "AQID"), new Uint8Array([1, 2, 3]));
});
