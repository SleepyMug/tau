import { createReadStream, createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, readdir, readlink, symlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Job, Kind } from "../core/model.js";
import { kindAt } from "../core/paths.js";

export { kindAt };

/**
 * Contents, for a wire adaptor and a backend to use as they will (docs/spec/protocol.md): a file or a
 * directory as a stream of entries, the tau's, an input's or an output's. Read from the file
 * system, checked as they come from elsewhere, and made on the file system again.
 */

/** What an entry is: all a content holds. */
export type EntryType = "file" | "dir" | "symlink";

/** An entry of a content. */
export interface ContentEntry {
	/** Where it is in the content, `/`-separated; empty for the content itself. */
	readonly path: string;
	readonly type: EntryType;
	/** Its permission bits, `mode & 0o777`. */
	readonly mode: number;
	/** A file's size in bytes, which its body holds; 0 for anything else. */
	readonly size: number;
	/** A symlink's target. */
	readonly target?: string;
	/** A file's bytes, read once; nothing for anything else. */
	readonly body: AsyncIterable<Uint8Array>;
}

/**
 * A content: a file's, by its name, or, without one, the tau's; its entries, each directory before
 * what it holds, read once, before the next content, which skips those left unread.
 */
export interface Content {
	readonly file?: string;
	readonly kind: Kind;
	readonly entries: AsyncIterable<ContentEntry>;
}

/**
 * A content to read: a file's, by its name, or, without one, the tau's; read from `from`, a file or
 * a directory, not a symlink, or several, which make a directory holding each under its base name.
 */
export interface ContentSource {
	readonly file?: string;
	readonly from: string | readonly string[];
}

/** More links in a row than this is a loop, as Linux has it. */
const MAX_HOPS = 40;

const NOTHING: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: async function* () {} };

/**
 * The contents of `sources`, in their order, each read from the file system as its entries are:
 * a directory's in order of name, each with its permission bits, and its symlinks as they are.
 */
export async function* readContents(sources: readonly ContentSource[]): AsyncGenerator<Content> {
	for (const { file, from } of sources) {
		const entries = typeof from === "string" ? walkSource(from) : walkSources(from);
		yield { ...(file === undefined ? {} : { file }), kind: typeof from === "string" ? kindAt(from) : "dir", entries };
	}
}

/** The entries of `source`, which is not a symlink. */
async function* walkSource(source: string): AsyncGenerator<ContentEntry> {
	if ((await lstat(source)).isSymbolicLink()) throw new Error(`${source} is a symlink, which a content is not`);
	yield* walk(source, "");
}

/** Several paths: a directory holding each under its base name. */
async function* walkSources(sources: readonly string[]): AsyncGenerator<ContentEntry> {
	yield { path: "", type: "dir", mode: 0o755, size: 0, body: NOTHING };
	const sorted = [...sources].sort((a, b) => (path.basename(a) < path.basename(b) ? -1 : 1));
	for (const source of sorted) {
		if ((await lstat(source)).isSymbolicLink()) throw new Error(`${source} is a symlink, which a content is not`);
		yield* walk(source, path.basename(source));
	}
}

/** The entries of `file`, at `at` in its content, and of all a directory holds, in order of name. */
async function* walk(file: string, at: string): AsyncGenerator<ContentEntry> {
	const stats = await lstat(file);
	const mode = stats.mode & 0o777;
	if (stats.isSymbolicLink()) yield { path: at, type: "symlink", mode, size: 0, target: await readlink(file), body: NOTHING };
	else if (stats.isFile()) yield { path: at, type: "file", mode, size: stats.size, body: { [Symbol.asyncIterator]: () => createReadStream(file)[Symbol.asyncIterator]() } };
	else if (stats.isDirectory()) {
		yield { path: at, type: "dir", mode, size: 0, body: NOTHING };
		for (const entry of (await readdir(file)).sort()) yield* walk(path.join(file, entry), at === "" ? entry : `${at}/${entry}`);
	} else throw new Error(`${file} is neither a file, a directory nor a symlink, which a content holds`);
}

/** A job's contents: the tau's, then each `in` and `inout` file's, in the envelope's order, each read as it is read. */
export function jobContents(job: Job): AsyncGenerator<Content> {
	const files = Object.keys(job.envelope.files).filter((name) => Object.hasOwn(job.inputs, name));
	return readContents([{ from: job.tau }, ...files.map((file) => ({ file, from: job.inputs[file] as string | readonly string[] }))]);
}

/**
 * Make a content's file or directory at `to`, which is not there yet, in a directory that is, with
 * each entry's mode, and its symlinks last, once the content is read whole, and so checked, when
 * it comes from elsewhere (see {@link checkContents}).
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

/**
 * The entries of a content, as they come, checked: each once, each directory before what it holds,
 * every name relative with no empty, `.` or `..` component, and, once all are read, each symlink
 * relative, leading, through any further symlinks, all relative, to something in the content,
 * never leaving it on the way (docs/spec/paths.md). `label` names the content in each problem.
 */
export class ContentTree {
	readonly #label: string;
	readonly #tree = new Map<string, { type: EntryType; target?: string }>();

	constructor(label: string) {
		this.#label = label;
	}

	/** Why the next entry does not fit, if it does not; the content's own entry comes first. */
	add(at: string, type: EntryType, target?: string): string | undefined {
		const name = at === "" ? this.#label : `${this.#label}/${at}`;
		if (this.#tree.size === 0) {
			if (at !== "") return `${name} does not follow its content`;
			if (type === "symlink") return `${name} is a symlink, which a content is not`;
		} else {
			if (at === "" || at.split("/").some((step) => step === "" || step === "." || step === ".."))
				return `${name}: an entry's name has no empty, \`.\` or \`..\` component`;
			if (this.#tree.has(at)) return `${name} appears twice`;
			const parent = at.includes("/") ? at.slice(0, at.lastIndexOf("/")) : "";
			if (this.#tree.get(parent)?.type !== "dir") return `${name} does not follow its directory`;
		}
		this.#tree.set(at, target === undefined ? { type } : { type, target });
		return undefined;
	}

	/** The symlinks that break the spec, once every entry is added. */
	linkProblems(): string[] {
		const problems: string[] = [];
		const label = this.#label;
		for (const [at, { type, target }] of this.#tree) {
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
				const found = this.#tree.get(next);
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
}

/**
 * `contents` from elsewhere, checked as they are read, against `named`, the kind of each content
 * the JSON before them names, by its file's name, or, for the tau's, undefined: each content is
 * named, of its kind, and comes once; its entries are as {@link ContentTree} has them; and every
 * content named comes. `refuse` throws a problem.
 */
export async function* checkContents(
	contents: AsyncIterable<Content>,
	named: ReadonlyMap<string | undefined, Kind>,
	refuse: (problem: string) => never,
): AsyncGenerator<Content> {
	const seen = new Set<string | undefined>();
	for await (const content of contents) {
		const label = content.file ?? "the tau";
		if (seen.has(content.file)) refuse(`the content of ${label} comes twice`);
		seen.add(content.file);
		const kind = named.get(content.file);
		if (kind === undefined) refuse(`the content of ${label} is not one it names`);
		if (content.kind !== kind) refuse(`${label} is ${article(content.kind)}, where ${article(kind)} goes`);
		const tree = new ContentTree(label);
		const entries = async function* (): AsyncGenerator<ContentEntry> {
			let empty = true;
			for await (const entry of content.entries) {
				empty = false;
				const problem = tree.add(entry.path, entry.type, entry.target);
				if (problem !== undefined) refuse(problem);
				if (entry.path === "" && entry.type !== (kind === "dir" ? "dir" : "file")) refuse(`${label} is ${article(kind === "dir" ? "file" : "dir")}, where ${article(kind)} goes`);
				if (kind === "file" && entry.path !== "") refuse(`${label} is a file, which holds no ${entry.path}`);
				yield entry;
			}
			if (empty) refuse(`the content of ${label} has no entries`);
			const problems = tree.linkProblems();
			if (problems.length > 0) refuse(problems.join("; "));
		};
		const reading = entries();
		yield { ...content, entries: { [Symbol.asyncIterator]: () => ({ next: () => reading.next() }) } };
		// What was not read of it, so that it is checked whole before the next.
		for await (const _ of reading);
	}
	const missing = [...named.keys()].filter((file) => !seen.has(file)).map((file) => file ?? "the tau");
	if (missing.length > 0) refuse(`the content of ${missing.join(", ")} does not come`);
}

function article(kind: Kind): string {
	return kind === "dir" ? "a directory" : "a file";
}
