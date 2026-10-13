import { Buffer } from "node:buffer";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { inputKinds, outputKinds, readEnvelope, readReport } from "../core/forms.js";
import { type Delivery, type Envelope, type Job, type Kind, NAME, type Report } from "../core/model.js";
import { messageOf } from "../core/util.js";
import { type Content, type ContentEntry, ContentTree, extractContent, jobContents, readContents } from "../transfer/content.js";
import { deliver } from "../transfer/deliver.js";
import { ArchiveError, readTar, type TarEntry, type WriteEntry, writeTar } from "./tar.js";

/**
 * Calls and results as tar archives (docs/spec/serialization.md): JSON, then the contents it
 * names, written in one pass, and read in one pass, checked as they come, never held whole.
 */

export { ArchiveError };

/** An archive, read: its JSON, checked, and its contents, read as they come. */
export interface Archive<T> {
	readonly json: T;
	readonly contents: AsyncIterable<Content>;
}

/** Where the tau's content is in a call, and each file's, under its name. */
const TAU = "tau";
const FILES = "files";
const CALL = "call.json";
const RESULT = "result.json";

/** A job's archive: its envelope, then the tau, then each `in` and `inout` file, read from the caller's paths as it is read. */
export function packCall(job: Job): AsyncGenerator<Uint8Array> {
	return encodeCall(job.envelope, jobContents(job));
}

/**
 * Read a call's archive onto the file system: the tau's content, which comes first, at `layout.tau`,
 * which is not there yet; then `layout.place` is given the envelope, and may refuse the call,
 * before any file's content is read, or give each file's place, absolute and not there yet, where
 * each `in` and `inout` file's content then goes, the directories it lies in made, as they are for
 * each `out` file's. Throws {@link ArchiveError} for an archive that breaks the spec.
 * @returns the envelope.
 */
export async function unpackCall(
	bytes: AsyncIterable<Uint8Array>,
	layout: {
		readonly tau: string;
		place(envelope: Envelope): { readonly [name: string]: string } | Promise<{ readonly [name: string]: string }>;
	},
): Promise<Envelope> {
	const { json, contents } = await decodeCall(bytes);
	const reading = contents[Symbol.asyncIterator]();
	const first = await reading.next();
	if (first.done === true || first.value.file !== undefined) throw new ArchiveError("the call breaks the spec: its tau does not come first");
	await mkdir(path.dirname(layout.tau), { recursive: true });
	await extractContent(first.value, layout.tau);
	const places = await layout.place(json);
	for (const name of Object.keys(json.files)) {
		const place = places[name];
		if (place === undefined) throw new Error(`${name}: has no place`);
		await mkdir(path.dirname(place), { recursive: true });
	}
	for (let next = await reading.next(); next.done !== true; next = await reading.next())
		await extractContent(next.value, places[next.value.file as string] as string);
	return json;
}

/** A result's archive: `report`, then the content of each output, read from `sources`, a path by its file's name, as it is read. */
export function packResult(report: Report, sources: { readonly [name: string]: string }): AsyncGenerator<Uint8Array> {
	return encodeResult(report, readContents(Object.keys(report.outputs).map((file) => ({ file, from: sources[file] as string }))));
}

/**
 * Read a result's archive, and put its outputs at the caller's paths, as `deliver`, of the
 * transfer helpers, does: nothing put unless all of it fits.
 * @returns its report; or, when the archive breaks the spec or does not fit the run, a run that
 * failed, with why.
 */
export async function unpackResult(bytes: AsyncIterable<Uint8Array>, delivery: Delivery): Promise<Report> {
	try {
		const { json, contents } = await decodeResult(bytes);
		return await deliver(json, contents, delivery);
	} catch (error) {
		if (!(error instanceof ArchiveError)) throw error;
		return { ok: false, text: "", failure: error.message, outputs: {} };
	}
}

/** A call's archive: `envelope`, as `call.json`, then `contents`, the tau's first, then each file's. */
export function encodeCall(envelope: Envelope, contents: AsyncIterable<Content>): AsyncGenerator<Uint8Array> {
	return encode(CALL, envelope, contents);
}

/** A result's archive: `report`, as `result.json`, then `contents`, each output's. */
export function encodeResult(report: Report, contents: AsyncIterable<Content>): AsyncGenerator<Uint8Array> {
	return encode(RESULT, report, contents);
}

/** Read a call: its envelope at once, checked, and then its contents. Throws {@link ArchiveError} for one that breaks the spec. */
export function decodeCall(bytes: AsyncIterable<Uint8Array>): Promise<Archive<Envelope>> {
	return decode(bytes, CALL, "the call", callContents);
}

/** Read a result: its report at once, checked, and then its contents. Throws {@link ArchiveError} for one that breaks the spec. */
export function decodeResult(bytes: AsyncIterable<Uint8Array>): Promise<Archive<Report>> {
	return decode(bytes, RESULT, "the result", resultContents);
}

async function* encode(first: string, json: object, contents: AsyncIterable<Content>): AsyncGenerator<Uint8Array> {
	const data = Buffer.from(`${JSON.stringify(json, undefined, 2)}\n`);
	async function* entries(): AsyncGenerator<WriteEntry> {
		yield { name: first, type: "file", mode: 0o644, size: data.length, body: async function* () { yield data; } };
		for await (const content of contents) {
			const root = content.file === undefined ? TAU : `${FILES}/${content.file}`;
			for await (const entry of content.entries) yield writeEntry(entry, entry.path === "" ? root : `${root}/${entry.path}`);
		}
	}
	yield* writeTar(entries());
}

function writeEntry({ type, mode, size, target, body }: ContentEntry, name: string): WriteEntry {
	if (type === "symlink") return { name, type, mode, size: 0, target: target as string };
	if (type === "dir") return { name, type, mode, size: 0 };
	return { name, type, mode, size, body: () => body };
}

/**
 * The JSON read, checked, and the contents it names: what each is, by where it is in the archive,
 * `tau` or `files/<name>`. Throws a problem, which the archive's reader names.
 */
type Parse<T> = (json: unknown) => { value: T; named: Map<string, Kind> };

async function decode<T>(bytes: AsyncIterable<Uint8Array>, first: string, what: string, parse: Parse<T>): Promise<Archive<T>> {
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
		return refuse(`${first} is not JSON: ${messageOf(error)}`);
	}
	let parsed: { value: T; named: Map<string, Kind> };
	try {
		parsed = parse(json);
	} catch (error) {
		return refuse(`${first}: ${messageOf(error)}`);
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
		const tree = new ContentTree(root.name);
		tree.add("", root.type);
		const contentEntries = async function* (): AsyncGenerator<ContentEntry> {
			yield { path: "", type: root.type, mode: root.mode, size: root.size, body: root.body };
			next = await entries.next();
			if (kind === "file") return;
			while (next.done !== true && next.value.name.startsWith(prefix)) {
				const entry = next.value;
				const inContent = entry.name.slice(prefix.length);
				const problem = tree.add(inContent, entry.type, entry.target);
				if (problem !== undefined) refuse(problem);
				yield { path: inContent, type: entry.type, mode: entry.mode, size: entry.size, body: entry.body, ...(entry.target === undefined ? {} : { target: entry.target }) };
				next = await entries.next();
			}
			const problems = tree.linkProblems();
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

/** `call.json`: an envelope; the tau's content always comes, and each `in` and `inout` file's. */
function callContents(json: unknown): { value: Envelope; named: Map<string, Kind> } {
	const envelope = readEnvelope(json);
	return { value: envelope, named: new Map([[TAU, "dir"], ...rooted(inputKinds(envelope))]) };
}

/** `result.json`: a report, and each output's content. */
function resultContents(json: unknown): { value: Report; named: Map<string, Kind> } {
	const report = readReport(json);
	return { value: report, named: rooted(outputKinds(report)) };
}

/** Each content by where it is in the archive. */
function rooted(named: ReadonlyMap<string, Kind>): Map<string, Kind> {
	return new Map([...named].map(([file, kind]) => [`${FILES}/${file}`, kind]));
}
