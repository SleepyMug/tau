import { Buffer } from "node:buffer";
import { createReadStream, createWriteStream, lstatSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, readlink, symlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Json, Kind, Mode } from "../tau/tau.js";
import { ArchiveError, type EntryType, readTar, type TarEntry, type WriteEntry, writeTar } from "./tar.js";

/**
 * Calls and results as archives (docs/spec/serialization.md): their JSON, and their contents, written
 * from files and directories, and read, checked, as they come, into files and directories again.
 */

/** A file of an archive's call: its mode, the base name its place keeps, and, for an `in` or an `inout`, what its content is. */
export interface CallFile {
	readonly mode: Mode;
	readonly base: string;
	readonly kind?: Kind;
}

/** `call.json`. */
export interface CallJson {
	/** Each file of the call, by its name. */
	readonly files: { readonly [name: string]: CallFile };
	/** The args, as the caller gave them, their placeholders not yet expanded. */
	readonly args: { readonly [name: string]: Json };
	/** True when the call carries its tau, a directory, at `tau/`. */
	readonly tau?: true;
}

/** How a run ended (docs/spec/results.md). */
export interface Result {
	readonly ok: boolean;
	/** The agent's final text; empty when it gave none. */
	readonly text: string;
	/** Why the run failed, when it did. */
	readonly failure?: string;
}

/** What a run left at an `out` or `inout` file: what it is, whose content is at `files/<name>`. */
export interface Output {
	readonly kind: Kind;
}

/** `result.json`. */
export interface ResultJson extends Result {
	/** By the name of each `out` and `inout` file. */
	readonly outputs: { readonly [name: string]: Output };
}

/**
 * A content to write: a file's, by its name, or, without one, the tau's; read from `from`, a file
 * or a directory, not a symlink, or several, which make a directory holding each under its base name.
 */
export interface ContentSource {
	readonly file?: string;
	readonly from: string | readonly string[];
}

/** An entry of a content, read. */
export interface ContentEntry {
	/** Where it is in the content, `/`-separated; empty for the content itself. */
	readonly path: string;
	readonly type: EntryType;
	readonly mode: number;
	readonly size: number;
	readonly target?: string;
	/** A file's bytes, read once. */
	readonly body: AsyncIterable<Uint8Array>;
}

/**
 * A content, read: a file's, by its name, or, without one, the tau's; its entries, each directory
 * before what it holds, read once, before the next content, which skips those left unread. Its
 * symlinks are checked once all its entries are read, so a reader that makes them makes them last.
 */
export interface Content {
	readonly file?: string;
	readonly kind: Kind;
	readonly entries: AsyncIterable<ContentEntry>;
}

/** An archive, read: its JSON, checked, and its contents, read as they come. */
export interface Archive<T> {
	readonly json: T;
	readonly contents: AsyncIterable<Content>;
}

export { ArchiveError };

/** A file's name (docs/spec/metadata.md), which names its content in an archive. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const MODES: readonly string[] = ["in", "out", "inout"];
const KINDS: readonly string[] = ["file", "dir"];
/** Where the tau's content is in a call, and each file's, under its name. */
const TAU = "tau";
const FILES = "files";
/** More links in a row than this is a loop, as Linux has it. */
const MAX_HOPS = 40;

/** A call's archive: `json`, then the contents, read from the files and directories given. */
export function writeCall(json: CallJson, contents: readonly ContentSource[]): AsyncGenerator<Uint8Array> {
	return writeArchive("call.json", json, contents);
}

/** A result's archive: `json`, then the contents, read from the files and directories given. */
export function writeResult(json: ResultJson, contents: readonly ContentSource[]): AsyncGenerator<Uint8Array> {
	return writeArchive("result.json", json, contents);
}

/** Read a call: its JSON at once, checked, and then its contents. Throws {@link ArchiveError} for one that breaks the spec. */
export function readCall(bytes: AsyncIterable<Uint8Array>): Promise<Archive<CallJson>> {
	return readArchive(bytes, "call.json", "the call", callContents);
}

/** Read a result: its JSON at once, checked, and then its contents. Throws {@link ArchiveError} for one that breaks the spec. */
export function readResult(bytes: AsyncIterable<Uint8Array>): Promise<Archive<ResultJson>> {
	return readArchive(bytes, "result.json", "the result", resultContents);
}

/** What is at `file`, as its content would be: a file or a directory, never a symlink. */
export function kindAt(file: string): Kind {
	const stats = lstatSync(file);
	if (stats.isFile()) return "file";
	if (stats.isDirectory()) return "dir";
	throw new Error(`${file} is neither a file nor a directory`);
}

/**
 * Make a content's file or directory at `to`, which is not there yet, in a directory that is, with
 * each entry's mode, and its symlinks last, once the content is checked whole.
 */
export async function extractContent(content: Content, to: string): Promise<void> {
	const links: [string, string][] = [];
	const dirs: [string, number][] = [];
	for await (const entry of content.entries) {
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

async function* writeArchive(first: string, json: object, contents: readonly ContentSource[]): AsyncGenerator<Uint8Array> {
	const data = Buffer.from(`${JSON.stringify(json, undefined, 2)}\n`);
	async function* entries(): AsyncGenerator<WriteEntry> {
		yield { name: first, type: "file", mode: 0o644, size: data.length, body: async function* () { yield data; } };
		for (const { file, from } of contents) {
			const root = file === undefined ? TAU : `${FILES}/${file}`;
			if (typeof from === "string") {
				yield* walkSource(from, root);
				continue;
			}
			// Several paths: a directory holding each under its base name.
			yield { name: root, type: "dir", mode: 0o755, size: 0 };
			const sorted = [...from].sort((a, b) => (path.basename(a) < path.basename(b) ? -1 : 1));
			for (const source of sorted) yield* walkSource(source, `${root}/${path.basename(source)}`);
		}
	}
	yield* writeTar(entries());
}

/** The entries of `source`, named `name`, which is not a symlink. */
async function* walkSource(source: string, name: string): AsyncGenerator<WriteEntry> {
	if ((await lstat(source)).isSymbolicLink()) throw new Error(`${source} is a symlink, which a content is not`);
	yield* walk(source, name);
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

/**
 * The JSON read, checked, and the contents it names: what each is, by where it is in the archive,
 * `tau` or `files/<name>`. Throws a problem, which the archive's reader names.
 */
type Parse<T> = (json: unknown) => { value: T; named: Map<string, Kind> };

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
	let parsed: { value: T; named: Map<string, Kind> };
	try {
		parsed = parse(json);
	} catch (error) {
		return refuse(`${first}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return { json: parsed.value, contents: contentsOf(entries, first, parsed.named, refuse) };
}

/** The contents that follow the JSON, each checked as its entries are read, and each one it names there. */
async function* contentsOf(
	entries: AsyncIterator<TarEntry>,
	first: string,
	named: ReadonlyMap<string, Kind>,
	refuse: (problem: string) => never,
): AsyncGenerator<Content> {
	const seen = new Set<string>();
	let next = await entries.next();
	while (next.done !== true) {
		const root = next.value;
		const [top, name, ...rest] = root.name.split("/");
		const known = top === TAU ? name === undefined : top === FILES && name !== undefined && NAME.test(name) && rest.length === 0;
		if (!known) {
			if (top === TAU || (top === FILES && name !== undefined && NAME.test(name)))
				return refuse(`${root.name} is not in the content before it, whose entries are together`);
			return refuse(`${root.name} is in no content, which is at tau/ or files/<name>`);
		}
		if (seen.has(root.name)) return refuse(`the content ${root.name} appears twice`);
		seen.add(root.name);
		const kind = named.get(root.name);
		if (kind === undefined) return refuse(`${first} names no content ${root.name}`);
		if (root.type === "symlink") return refuse(`${root.name} is a symlink, which a content is not`);
		if (root.type !== (kind === "dir" ? "dir" : "file"))
			return refuse(`${root.name} is a ${root.type === "dir" ? "directory" : "file"}, but ${first} says it is a ${kind === "dir" ? "directory" : "file"}`);
		const prefix = `${root.name}/`;
		/** The content's entries read so far, by their path in it, for its symlinks. */
		const tree = new Map<string, { type: EntryType; target?: string }>([["", { type: root.type }]]);
		const contentEntries = async function* (): AsyncGenerator<ContentEntry> {
			yield { path: "", type: root.type, mode: root.mode, size: root.size, body: root.body };
			next = await entries.next();
			if (kind === "file") return;
			while (next.done !== true && next.value.name.startsWith(prefix)) {
				const entry = next.value;
				const inContent = entry.name.slice(prefix.length);
				if (tree.has(inContent)) refuse(`${entry.name} appears twice`);
				const parent = inContent.includes("/") ? inContent.slice(0, inContent.lastIndexOf("/")) : "";
				if (tree.get(parent)?.type !== "dir") refuse(`${entry.name} does not follow its directory`);
				tree.set(inContent, entry.target === undefined ? { type: entry.type } : { type: entry.type, target: entry.target });
				yield { path: inContent, type: entry.type, mode: entry.mode, size: entry.size, body: entry.body, ...(entry.target === undefined ? {} : { target: entry.target }) };
				next = await entries.next();
			}
			const problems = linkProblems(tree, root.name);
			if (problems.length > 0) refuse(problems.join("; "));
		};
		const reading = contentEntries();
		// Without `return`, so that a reader that stops early leaves the rest to be skipped here.
		yield { ...(top === FILES ? { file: name as string } : {}), kind, entries: { [Symbol.asyncIterator]: () => ({ next: () => reading.next() }) } };
		// What was not read of it, so that the next content is checked from its start, and this one whole.
		for await (const _ of reading);
	}
	const missing = [...named.keys()].filter((root) => !seen.has(root));
	if (missing.length > 0) refuse(`${first} names ${missing.join(", ")}, but the archive does not hold ${missing.length > 1 ? "them" : "it"}`);
}

/**
 * The symlinks of a content that break the spec: each is relative, and leads, through any further
 * symlinks, all relative, to something that exists in the content, never leaving it on the way.
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
			problem(`leads to the absolute path ${target}; a symlink in a content is relative`);
			continue;
		}
		for (;;) {
			const step = steps.shift();
			if (step === undefined) break;
			if (step === "" || step === ".") continue;
			if (step === "..") {
				if (directory.length === 0) {
					problem("leads outside its content");
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
					problem(`leads through ${label}/${next} to the absolute path ${found.target}; a symlink in a content is relative`);
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

function callContents(json: unknown): { value: CallJson; named: Map<string, Kind> } {
	const { files, args, tau, ...rest } = record(json, "it");
	refuseKeys(rest, "it");
	const named = new Map<string, Kind>();
	if (tau !== undefined) {
		if (tau !== true) throw new TypeError("`tau` is true, when the call carries its tau");
		named.set(TAU, "dir");
	}
	for (const [name, file] of Object.entries(record(files, "`files`"))) {
		if (!NAME.test(name)) throw new TypeError(`\`files\`: ${JSON.stringify(name)} is not a file's name, which matches ${NAME.source}`);
		const at = `\`files\`.${name}`;
		const { mode, base, kind, ...others } = record(file, at);
		refuseKeys(others, at);
		if (typeof mode !== "string" || !MODES.includes(mode)) throw new TypeError(`${at}: \`mode\` is "in", "out" or "inout"`);
		checkBase(base, at);
		if (mode === "out") {
			if (kind !== undefined) throw new TypeError(`${at}: an \`out\` has no \`kind\`, since it has no content`);
			continue;
		}
		checkKind(kind, at);
		named.set(`${FILES}/${name}`, kind as Kind);
	}
	record(args, "`args`");
	return { value: json as CallJson, named };
}

function resultContents(json: unknown): { value: ResultJson; named: Map<string, Kind> } {
	const { ok, text, failure, outputs, ...rest } = record(json, "it");
	refuseKeys(rest, "it");
	if (typeof ok !== "boolean") throw new TypeError("`ok` is true or false");
	if (typeof text !== "string") throw new TypeError("`text` is a string");
	if (failure !== undefined && (ok || typeof failure !== "string")) throw new TypeError("`failure` is a string, only when the run failed");
	const named = new Map<string, Kind>();
	for (const [name, output] of Object.entries(record(outputs, "`outputs`"))) {
		if (!NAME.test(name)) throw new TypeError(`\`outputs\`: ${JSON.stringify(name)} is not a file's name, which matches ${NAME.source}`);
		const at = `\`outputs\`.${name}`;
		const { kind, ...others } = record(output, at);
		refuseKeys(others, at);
		checkKind(kind, at);
		named.set(`${FILES}/${name}`, kind as Kind);
	}
	return { value: json as ResultJson, named };
}

function checkKind(kind: unknown, at: string): void {
	if (typeof kind !== "string" || !KINDS.includes(kind)) throw new TypeError(`${at}: \`kind\` is "file" or "dir"`);
}

/** A base name: not empty, not `.` or `..`, with no `/` and no NUL. */
function checkBase(base: unknown, at: string): void {
	if (typeof base !== "string" || base === "" || base === "." || base === ".." || /[/\0]/u.test(base))
		throw new TypeError(`${at}: \`base\` is a base name, not empty, \`.\` or \`..\`, with no / and no NUL`);
}

function record(value: unknown, at: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${at}: is an object`);
	return value as Record<string, unknown>;
}

function refuseKeys(rest: Record<string, unknown>, at: string): void {
	const [key] = Object.keys(rest);
	if (key !== undefined) throw new TypeError(`${at}: unknown key ${JSON.stringify(key)}`);
}
