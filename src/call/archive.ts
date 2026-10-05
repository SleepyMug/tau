import { Buffer } from "node:buffer";
import { createReadStream, createWriteStream, lstatSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, readlink, symlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { ArchiveError, type EntryType, readTar, type TarEntry, type WriteEntry, writeTar } from "./tar.js";

/**
 * Calls and results as archives (docs/spec/serialization.md): their JSON, and their blobs, written
 * from files and directories, and read, checked, as they come, into files and directories again.
 */

/** What a blob is. */
export type ContentKind = "file" | "dir";

/** Content in an archive: what it is, and its blob. */
export interface Content {
	readonly kind: ContentKind;
	readonly blob: string;
}

/** Content with the base name of the path it is for. */
export interface Named extends Content {
	readonly name: string;
}

/** A handle in a call: the content of an `$in` or `$inout`, or the name of an `$out`. */
export type CallHandle = { readonly $in: Named } | { readonly $inout: Named } | { readonly $out: { readonly name: string } };

/** A value in a call: a value of docs/spec/values.md, each handle a {@link CallHandle}. */
export type CallValue = string | CallHandle | readonly CallValue[] | { readonly [name: string]: CallValue };

/** `call.json`. */
export interface CallJson {
	readonly values: { readonly [name: string]: CallValue };
	/** The tau the call runs, a directory, when the call carries it. */
	readonly tau?: Content;
}

/** How a run ended (docs/spec/results.md). */
export interface Result {
	readonly ok: boolean;
	/** The agent's final text; empty when it gave none. */
	readonly text: string;
	/** Why the run failed, when it did. */
	readonly failure?: string;
}

/** What a run left at an `$out` or `$inout` handle. */
export type Output = { readonly $out: Named } | { readonly $inout: Named };

/** `result.json`. */
export interface ResultJson extends Result {
	/** By where each handle is in the run's values, a JSON Pointer. */
	readonly outputs: { readonly [pointer: string]: Output };
}

/** A blob to write: its id, and the file or directory it is read from, which is not a symlink. */
export interface BlobSource {
	readonly id: string;
	readonly path: string;
}

/** An entry of a blob, read. */
export interface BlobEntry {
	/** Where it is in the blob, `/`-separated; empty for the blob itself. */
	readonly path: string;
	readonly type: EntryType;
	readonly mode: number;
	readonly size: number;
	readonly target?: string;
	/** A file's bytes, read once. */
	readonly body: AsyncIterable<Uint8Array>;
}

/**
 * A blob, read: its entries, each directory before what it holds, read once, before the next blob,
 * which skips those left unread. Its symlinks are checked once all its entries are read, so a
 * reader that makes them makes them last.
 */
export interface Blob {
	readonly id: string;
	readonly kind: ContentKind;
	readonly entries: AsyncIterable<BlobEntry>;
}

/** An archive, read: its JSON, checked, and its blobs, read as they come. */
export interface Archive<T> {
	readonly json: T;
	readonly blobs: AsyncIterable<Blob>;
}

export { ArchiveError };

const ID = /^[A-Za-z0-9_-]{1,64}$/u;
/** A JSON Pointer into values: each step a name (docs/spec/values.md) or an index. */
const POINTER = /^(?:\/(?:[A-Za-z_][A-Za-z0-9_]*|0|[1-9][0-9]*))+$/u;
const KINDS: readonly string[] = ["file", "dir"];
/** More links in a row than this is a loop, as Linux has it. */
const MAX_HOPS = 40;

/** A call's archive: `json`, then the blobs, read from the files and directories given. */
export function writeCall(json: CallJson, blobs: readonly BlobSource[]): AsyncGenerator<Uint8Array> {
	return writeArchive("call.json", json, blobs);
}

/** A result's archive: `json`, then the blobs, read from the files and directories given. */
export function writeResult(json: ResultJson, blobs: readonly BlobSource[]): AsyncGenerator<Uint8Array> {
	return writeArchive("result.json", json, blobs);
}

/** Read a call: its JSON at once, checked, and then its blobs. Throws {@link ArchiveError} for one that breaks the spec. */
export function readCall(bytes: AsyncIterable<Uint8Array>): Promise<Archive<CallJson>> {
	return readArchive(bytes, "call.json", "the call", callContents);
}

/** Read a result: its JSON at once, checked, and then its blobs. Throws {@link ArchiveError} for one that breaks the spec. */
export function readResult(bytes: AsyncIterable<Uint8Array>): Promise<Archive<ResultJson>> {
	return readArchive(bytes, "result.json", "the result", resultContents);
}

/** What is at `file`, as a blob of it would be: a file or a directory, never a symlink. */
export function kindAt(file: string): ContentKind {
	const stats = lstatSync(file);
	if (stats.isFile()) return "file";
	if (stats.isDirectory()) return "dir";
	throw new Error(`${file} is neither a file nor a directory`);
}

/**
 * Make a blob's file or directory at `to`, which is not there yet, in a directory that is, with
 * each entry's mode, and its symlinks last, once the blob is checked whole.
 */
export async function extractBlob(blob: Blob, to: string): Promise<void> {
	const links: [string, string][] = [];
	const dirs: [string, number][] = [];
	for await (const entry of blob.entries) {
		const at = entry.path === "" ? to : path.join(to, ...entry.path.split("/"));
		if (entry.type === "dir") {
			await mkdir(at, { mode: 0o700 });
			dirs.push([at, entry.mode]);
		} else if (entry.type === "file") {
			await pipeline(entry.body, createWriteStream(at, { flags: "wx", mode: 0o600 }));
			await chmod(at, entry.mode);
		} else links.push([at, entry.target as string]);
	}
	for (const [at, target] of links) await symlink(target, at);
	// Innermost first, so that a directory that is not writable is made so after what it holds.
	for (const [at, mode] of dirs.reverse()) await chmod(at, mode);
}

async function* writeArchive(first: string, json: object, blobs: readonly BlobSource[]): AsyncGenerator<Uint8Array> {
	const data = Buffer.from(`${JSON.stringify(json, undefined, 2)}\n`);
	async function* entries(): AsyncGenerator<WriteEntry> {
		yield { name: first, type: "file", mode: 0o644, size: data.length, body: async function* () { yield data; } };
		for (const { id, path: source } of blobs) {
			if ((await lstat(source)).isSymbolicLink()) throw new Error(`${source} is a symlink, which a blob is not`);
			yield* walk(source, `blobs/${id}`);
		}
	}
	yield* writeTar(entries());
}

/** The entries of `file`, named `name`, and of all a directory holds, in order of name. */
async function* walk(file: string, name: string): AsyncGenerator<WriteEntry> {
	const stats = await lstat(file);
	const mode = stats.mode & 0o777;
	if (stats.isSymbolicLink()) yield { name, type: "symlink", mode, size: 0, target: await readlink(file) };
	else if (stats.isFile()) yield { name, type: "file", mode, size: stats.size, body: () => createReadStream(file) };
	else if (stats.isDirectory()) {
		yield { name, type: "dir", mode, size: 0 };
		for (const entry of (await readdir(file)).sort()) yield* walk(path.join(file, entry), `${name}/${entry}`);
	} else throw new Error(`${file} is neither a file, a directory nor a symlink, which an archive holds`);
}

/** The JSON read, checked, and every content it names. Throws a problem, which the archive's reader names. */
type Parse<T> = (json: unknown) => { value: T; contents: Content[] };

async function readArchive<T>(bytes: AsyncIterable<Uint8Array>, first: string, what: string, parse: Parse<T>): Promise<Archive<T>> {
	const refuse = (problem: string): never => {
		throw new ArchiveError(`${what} breaks the spec: ${problem}`);
	};
	const entries = readTar(bytes, what)[Symbol.asyncIterator]();
	const head = await entries.next();
	if (head.done === true || head.value.name !== first || head.value.type !== "file") return refuse(`its first entry is not the file ${first}`);
	const chunks: Uint8Array[] = [];
	for await (const chunk of head.value.body) chunks.push(chunk);
	let json: unknown;
	try {
		json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch (error) {
		return refuse(`${first} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	let parsed: { value: T; contents: Content[] };
	try {
		parsed = parse(json);
	} catch (error) {
		return refuse(`${first}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const named = new Map<string, ContentKind>();
	for (const { kind, blob } of parsed.contents) {
		if (named.has(blob) && named.get(blob) !== kind) refuse(`${first} names the blob ${blob} as both a file and a directory`);
		named.set(blob, kind);
	}
	return { json: parsed.value, blobs: blobsOf(entries, named, refuse) };
}

/** The blobs that follow the JSON, each checked as its entries are read, and each named one there. */
async function* blobsOf(
	entries: AsyncIterator<TarEntry>,
	named: ReadonlyMap<string, ContentKind>,
	refuse: (problem: string) => never,
): AsyncGenerator<Blob> {
	const seen = new Set<string>();
	let next = await entries.next();
	while (next.done !== true) {
		const root = next.value;
		const [top, id, ...rest] = root.name.split("/");
		if (top !== "blobs" || id === undefined || !ID.test(id)) return refuse(`${root.name} is not in a blob, under blobs/<id>`);
		if (rest.length > 0) return refuse(`${root.name} is not in the blob before it, whose entries are together`);
		if (seen.has(id)) return refuse(`the blob ${id} appears twice`);
		seen.add(id);
		const kind = named.get(id);
		if (kind === undefined) return refuse(`no handle names the blob ${id}`);
		if (root.type === "symlink") return refuse(`the blob ${id} is a symlink, which a blob is not`);
		if (root.type !== (kind === "dir" ? "dir" : "file"))
			return refuse(`the blob ${id} is a ${root.type === "dir" ? "directory" : "file"}, but is named as a ${kind === "dir" ? "directory" : "file"}`);
		const prefix = `blobs/${id}/`;
		/** The blob's entries read so far, by their path in it, for its symlinks. */
		const tree = new Map<string, { type: EntryType; target?: string }>([["", { type: root.type }]]);
		const blobEntries = async function* (): AsyncGenerator<BlobEntry> {
			yield { path: "", type: root.type, mode: root.mode, size: root.size, body: root.body };
			next = await entries.next();
			if (kind === "file") return;
			while (next.done !== true && next.value.name.startsWith(prefix)) {
				const entry = next.value;
				const inBlob = entry.name.slice(prefix.length);
				if (tree.has(inBlob)) refuse(`${entry.name} appears twice`);
				const parent = inBlob.includes("/") ? inBlob.slice(0, inBlob.lastIndexOf("/")) : "";
				if (tree.get(parent)?.type !== "dir") refuse(`${entry.name} does not follow its directory`);
				tree.set(inBlob, entry.target === undefined ? { type: entry.type } : { type: entry.type, target: entry.target });
				yield { path: inBlob, type: entry.type, mode: entry.mode, size: entry.size, body: entry.body, ...(entry.target === undefined ? {} : { target: entry.target }) };
				next = await entries.next();
			}
			const problems = linkProblems(tree, `blobs/${id}`);
			if (problems.length > 0) refuse(problems.join("; "));
		};
		const reading = blobEntries();
		// Without `return`, so that a reader that stops early leaves the rest to be skipped here.
		yield { id, kind, entries: { [Symbol.asyncIterator]: () => ({ next: () => reading.next() }) } };
		// What was not read of it, so that the next blob is checked from its start, and this one whole.
		for await (const _ of reading);
	}
	const missing = [...named.keys()].filter((id) => !seen.has(id));
	if (missing.length > 0) refuse(`the blob${missing.length > 1 ? "s" : ""} ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} named, but not in it`);
}

/**
 * The symlinks of a blob that break the spec: each is relative, and leads, through any further
 * symlinks, all relative, to something that exists in the blob, never leaving it on the way.
 */
function linkProblems(tree: ReadonlyMap<string, { type: EntryType; target?: string }>, label: string): string[] {
	const problems: string[] = [];
	for (const [at, { type, target }] of tree) {
		if (type !== "symlink") continue;
		const problem = (text: string): void => {
			problems.push(`${label}/${at}: ${text}`);
		};
		let hops = 1;
		let directory = at.split("/").slice(0, -1);
		let steps = (target as string).split("/");
		if ((target as string).startsWith("/")) {
			problem(`leads to the absolute path ${target}; a symlink in a blob is relative`);
			continue;
		}
		for (;;) {
			const step = steps.shift();
			if (step === undefined) break;
			if (step === "" || step === ".") continue;
			if (step === "..") {
				if (directory.length === 0) {
					problem("leads outside its blob");
					break;
				}
				directory.pop();
				continue;
			}
			const next = [...directory, step].join("/");
			const found = tree.get(next);
			if (found === undefined) {
				problem(`leads to ${label}/${next}, which does not exist`);
				break;
			}
			if (found.type === "symlink") {
				if (++hops > MAX_HOPS) {
					problem("is a loop of symlinks");
					break;
				}
				if ((found.target as string).startsWith("/")) {
					problem(`leads through ${label}/${next} to the absolute path ${found.target}; a symlink in a blob is relative`);
					break;
				}
				steps = [...(found.target as string).split("/"), ...steps];
				continue;
			}
			if (found.type === "file" && steps.some((rest) => rest !== "" && rest !== ".")) {
				problem(`leads into ${label}/${next}, which is a file`);
				break;
			}
			directory = [...directory, step];
		}
	}
	return problems;
}

function callContents(json: unknown): { value: CallJson; contents: Content[] } {
	const { values, tau, ...rest } = record(json, "it");
	refuseKeys(rest, "it");
	const contents: Content[] = [];
	if (tau !== undefined) contents.push(content(tau, "`tau`"));
	if (contents[0]?.kind === "file") throw new TypeError("`tau` is a directory");
	const walk = (value: unknown, at: string): void => {
		if (typeof value === "string") return;
		if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${at}/${index}`));
		const object = record(value, at);
		if (!Object.keys(object).some((key) => key.startsWith("$"))) {
			for (const [name, item] of Object.entries(object)) walk(item, `${at}/${name}`);
			return;
		}
		const [key, ...more] = Object.keys(object);
		if (more.length > 0 || (key !== "$in" && key !== "$out" && key !== "$inout"))
			throw new TypeError(`${at}: is not a handle, {"$in" | "$inout": {name, kind, blob}} or {"$out": {name}}`);
		if (key === "$out") {
			const { name, ...others } = record(object[key], `${at}/$out`);
			refuseKeys(others, `${at}/$out`);
			checkName(name, `${at}/$out`);
		} else contents.push(named(object[key], `${at}/${key}`));
	};
	walk(record(values, "`values`"), "`values`");
	return { value: json as CallJson, contents };
}

function resultContents(json: unknown): { value: ResultJson; contents: Content[] } {
	const { ok, text, failure, outputs, ...rest } = record(json, "it");
	refuseKeys(rest, "it");
	if (typeof ok !== "boolean") throw new TypeError("`ok` is true or false");
	if (typeof text !== "string") throw new TypeError("`text` is a string");
	if (failure !== undefined && (ok || typeof failure !== "string")) throw new TypeError("`failure` is a string, only when the run failed");
	const contents: Content[] = [];
	for (const [pointer, output] of Object.entries(record(outputs, "`outputs`"))) {
		if (!POINTER.test(pointer)) throw new TypeError(`\`outputs\`: ${JSON.stringify(pointer)} is not a JSON Pointer into the values`);
		const { $out, $inout, ...others } = record(output, pointer);
		refuseKeys(others, pointer);
		if (($out === undefined) === ($inout === undefined)) throw new TypeError(`${pointer}: is {"$out" | "$inout": {name, kind, blob}}`);
		contents.push(named($out ?? $inout, pointer));
	}
	return { value: json as ResultJson, contents };
}

function named(value: unknown, at: string): Content {
	const { name, ...rest } = record(value, at);
	checkName(name, at);
	return content(rest, at);
}

function content(value: unknown, at: string): Content {
	const { kind, blob, ...rest } = record(value, at);
	refuseKeys(rest, at);
	if (typeof kind !== "string" || !KINDS.includes(kind)) throw new TypeError(`${at}: \`kind\` is "file" or "dir"`);
	if (typeof blob !== "string" || !ID.test(blob)) throw new TypeError(`${at}: \`blob\` is an id, which matches ${ID.source}`);
	return { kind: kind as ContentKind, blob };
}

/** A base name: not empty, not `.` or `..`, with no `/` and no NUL. */
function checkName(name: unknown, at: string): void {
	if (typeof name !== "string" || name === "" || name === "." || name === ".." || /[/\0]/u.test(name))
		throw new TypeError(`${at}: \`name\` is a base name, not empty, \`.\` or \`..\`, with no / and no NUL`);
}

function record(value: unknown, at: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${at}: is an object`);
	return value as Record<string, unknown>;
}

function refuseKeys(rest: Record<string, unknown>, at: string): void {
	const [key] = Object.keys(rest);
	if (key !== undefined) throw new TypeError(`${at}: unknown key ${JSON.stringify(key)}`);
}
