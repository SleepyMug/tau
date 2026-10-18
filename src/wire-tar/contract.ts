import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { type Contract, readContract, within } from "../core/apis.js";
import { messageOf } from "../core/util.js";
import { ContentTree } from "../transfer/content.js";
import { ArchiveError, readTar, type WriteEntry, writeTar } from "./tar.js";

/**
 * Contracts as tar archives (docs/spec/serialization.md#contracts), as a backend gives one to an
 * adaptor that asks for it (docs/spec/protocol.md#contracts): a directory at `contract/`, holding
 * the contract's package.json and its declarations, where the package has them, and nothing else,
 * no symlink and no JSON before it.
 */

/** Where the contract is in its archive. */
const CONTRACT = "contract";

/** Whether a file, at `at` in a contract's package, is one a contract's archive holds. */
function held(at: string): boolean {
	return at === "package.json" || at.endsWith(".d.ts");
}

/**
 * The archive of the contract whose package is at `dir`: its package.json, and each declaration
 * file under it, but in a node_modules/, in order of name, each directory before what it holds.
 * Throws for a symlink among them, which a contract's archive does not hold.
 */
export async function* packContract(dir: string): AsyncGenerator<Uint8Array> {
	const root = await realpath(dir);
	const files: string[] = [];
	const walk = async (folder: string, prefix: string): Promise<void> => {
		for (const name of (await readdir(folder)).sort()) {
			const file = path.join(folder, name);
			const at = prefix + name;
			const stats = await lstat(file);
			if (stats.isDirectory()) {
				if (name !== "node_modules") await walk(file, `${at}/`);
			} else if (held(at)) {
				if (stats.isSymbolicLink()) throw new Error(`${file}: is a symlink, which a contract's archive does not hold`);
				if (stats.isFile()) files.push(at);
			}
		}
	};
	await walk(root, "");
	if (!files.includes("package.json")) throw new Error(`${dir}: holds no package.json, a contract's`);
	async function* entries(): AsyncGenerator<WriteEntry> {
		yield { name: CONTRACT, type: "dir", mode: 0o755, size: 0 };
		const made = new Set<string>();
		for (const at of files) {
			const parts = at.split("/");
			for (let depth = 1; depth < parts.length; depth++) {
				const folder = parts.slice(0, depth).join("/");
				if (made.has(folder)) continue;
				made.add(folder);
				yield { name: `${CONTRACT}/${folder}`, type: "dir", mode: 0o755, size: 0 };
			}
			const file = path.join(root, ...parts);
			const { size } = await lstat(file);
			yield { name: `${CONTRACT}/${at}`, type: "file", mode: 0o644, size, body: () => createReadStream(file) };
		}
	}
	yield* writeTar(entries());
}

/**
 * Read a contract's archive into `dir`, which does not exist yet, in a directory made if need be, and check it, as from a backend
 * the reader does not trust: a contract's package, as docs/spec/contracts.md has it, named `name`,
 * at a version within `range`, when one is given, holding its index.d.ts, and nothing but its
 * package.json and declaration files, and no symlink. Throws {@link ArchiveError}, leaving nothing
 * at `dir`, for one that is not.
 * @returns the contract.
 */
export async function unpackContract(
	bytes: AsyncIterable<Uint8Array>,
	dir: string,
	{ name, range }: { readonly name: string; readonly range?: string },
): Promise<Contract> {
	const refuse = (problem: string): never => {
		throw new ArchiveError(`the contract breaks the spec: ${problem}`);
	};
	const tree = new ContentTree(CONTRACT);
	let made = false;
	try {
		for await (const entry of readTar(bytes, "the contract")) {
			const at = entry.name === CONTRACT ? "" : entry.name.startsWith(`${CONTRACT}/`) ? entry.name.slice(CONTRACT.length + 1) : refuse(`${entry.name} is not in contract/`);
			const problem = tree.add(at, entry.type, entry.target);
			if (problem !== undefined) refuse(problem);
			if (entry.type === "symlink") refuse(`${entry.name} is a symlink, which a contract's archive does not hold`);
			const to = at === "" ? dir : path.join(dir, ...at.split("/"));
			if (entry.type === "dir") {
				if (at === "") await mkdir(path.dirname(dir), { recursive: true });
				await mkdir(to, at === "" ? {} : { recursive: true });
				made = true;
			} else {
				if (!held(at)) refuse(`${entry.name} is neither its package.json nor a declaration file`);
				await pipeline(entry.body, createWriteStream(to, { flags: "wx", mode: 0o644 }));
			}
		}
		if (!made) refuse("it holds no contract/");
		let contract: Contract;
		try {
			contract = readContract(dir);
		} catch (error) {
			return refuse(messageOf(error).replaceAll(dir, CONTRACT));
		}
		if (contract.name !== name) refuse(`it is ${contract.name}, not ${name}`);
		if (range !== undefined && !within(contract.version, range)) refuse(`it is at ${contract.version}, which is not within ${range}`);
		if (!(await lstat(path.join(dir, "index.d.ts")).catch(() => undefined))?.isFile()) refuse("it holds no index.d.ts");
		return contract;
	} catch (error) {
		if (made) await rm(dir, { recursive: true, force: true });
		throw error;
	}
}
