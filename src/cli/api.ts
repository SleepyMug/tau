import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import type { WireAdaptor } from "../client/adaptor.js";
import { compareVersions, type Contract, PACKAGE_NAME, parseVersion, rangeVersion, readContract } from "../core/apis.js";
import { isObject, messageOf } from "../core/util.js";
import { readTar } from "../wire-tar/tar.js";

/**
 * `tau api`: a tau's APIs, in `apis` in its tau.json, and their contracts, which the command pulls
 * for its author into `.tau/`, which no runtime reads and no client carries (docs/spec/authoring.md).
 */

/** What `tau api` reaches: the provider, whose backend gives contracts; the npm registry. */
export interface ApiContext {
	readonly adaptors: { readonly [name: string]: WireAdaptor };
	/** The adaptor whose backend is the provider: the one a run goes through, as the command chooses it. */
	readonly provider: string;
	readonly env: { readonly [name: string]: string | undefined };
	/** What reaches the npm registry; by default the global `fetch`. */
	readonly fetch?: typeof fetch;
	readonly signal?: AbortSignal;
}

/** `.tau/lock.json`: each API's contract, the version pulled, and where from. */
interface Lock {
	readonly contracts: { [name: string]: { readonly version: string; readonly from: string } };
}

const NPM = "npm";
/** The source that is the provider, whichever adaptor that is where the command runs. */
const PROVIDER = "provider";
const DEFAULT_REGISTRY = "https://registry.npmjs.org";

/**
 * Pull the contract `spec` names, `<name>[@<range>]`, from `from`, npm, the default, or a path, or
 * from the provider, into the tau at `dir`'s `.tau/`, and name it in `apis`, at its range, or at
 * `^` and the version pulled.
 * @param cwd - what a path given as `from` is relative to.
 * @returns what it did, for whoever ran it.
 */
export async function addApi(
	dir: string,
	spec: string,
	{ from, provider = false }: { readonly from?: string; readonly provider?: boolean },
	cwd: string,
	context: ApiContext,
): Promise<string> {
	const { name, range } = parseSpec(spec);
	const tau = tauDir(dir);
	if (provider && from !== undefined) throw new Error("give a source once: --from, or --from-provider");
	if (from !== undefined && from !== NPM && !isPath(from))
		throw new Error(`no source ${JSON.stringify(from)}: --from takes npm or a path, one that holds a / or starts with a .; --from-provider pulls from the provider`);
	const source = provider ? PROVIDER : from === undefined ? NPM : isPath(from) ? path.resolve(cwd, from) : from;
	const contract = await pull(tau, name, range, source, context);
	const metadata = await readMetadata(tau);
	const apis = isObject(metadata.apis) ? { ...metadata.apis } : {};
	apis[name] = range ?? `^${contract.version}`;
	await writeMetadata(tau, { ...metadata, apis: sorted(apis) });
	const lock = await readLock(tau);
	lock.contracts[name] = { version: contract.version, from: lockedFrom(tau, source) };
	await writeTauDir(tau, lock);
	return `${name}@${apis[name] as string}: its contract at ${contract.version}, from ${lockedFrom(tau, source)}`;
}

/** Take the API `name` out of the tau at `dir`'s `apis`, and `exposes`, and its contract out of `.tau/`. */
export async function removeApi(dir: string, name: string): Promise<string> {
	const tau = tauDir(dir);
	const metadata = await readMetadata(tau);
	const apis = isObject(metadata.apis) ? { ...metadata.apis } : {};
	if (!Object.hasOwn(apis, name)) throw new Error(`${path.join(tau, "tau.json")}: \`apis\` names no ${name}`);
	delete apis[name];
	const rest = Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== "apis"));
	const exposes = Array.isArray(metadata.exposes) ? { exposes: metadata.exposes.filter((entry) => entry !== name) } : {};
	await writeMetadata(tau, { ...rest, ...exposes, ...(Object.keys(apis).length === 0 ? {} : { apis }) });
	await rm(contractDir(tau, name), { recursive: true, force: true });
	const lock = await readLock(tau);
	delete lock.contracts[name];
	await writeTauDir(tau, lock);
	return `${name}: removed`;
}

/**
 * Pull each API's contract that `.tau/` lacks, or holds at another version than its range gives,
 * from where `.tau/lock.json` says it came, or else from npm; and drop those of no API.
 */
export async function syncApis(dir: string, context: ApiContext): Promise<string> {
	const tau = tauDir(dir);
	const metadata = await readMetadata(tau);
	const apis = isObject(metadata.apis) ? (metadata.apis as { [name: string]: unknown }) : {};
	const lock = await readLock(tau);
	const pulled: string[] = [];
	const contracts: Lock["contracts"] = {};
	for (const [name, range] of Object.entries(apis)) {
		if (typeof range !== "string" || rangeVersion(range) === undefined)
			throw new Error(`${path.join(tau, "tau.json")}: \`apis\`: ${name}: ${JSON.stringify(range)} is not a range, ^ and a version`);
		const wanted = rangeVersion(range) as string;
		const locked = lock.contracts[name];
		const from = locked?.from ?? NPM;
		const source = isPath(from) ? path.resolve(tau, from) : from;
		let held: Contract | undefined;
		try {
			held = readContract(contractDir(tau, name));
		} catch {
			held = undefined;
		}
		if (held?.name !== name || held.version !== wanted) {
			await pull(tau, name, range, source, context);
			pulled.push(`${name}@${wanted}, from ${from}`);
		}
		contracts[name] = { version: wanted, from };
	}
	await dropStray(tau, Object.keys(apis));
	await writeTauDir(tau, { contracts });
	return pulled.length === 0 ? "every contract is in .tau/ already" : `pulled ${pulled.join("; ")}`;
}

/** `<name>[@<range>]`, checked. */
function parseSpec(spec: string): { name: string; range?: string } {
	const at = spec.lastIndexOf("@");
	const [name, range] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, undefined];
	if (!PACKAGE_NAME.test(name)) throw new Error(`${JSON.stringify(name)} is not a contract's name, an npm package's`);
	if (range !== undefined && rangeVersion(range) === undefined) throw new Error(`${JSON.stringify(range)} is not a range, ^ and a version, as ^1.2.0`);
	return range === undefined ? { name } : { name, range };
}

/** The tau at `dir`, absolute; throws for what is not one. */
function tauDir(dir: string): string {
	const tau = path.resolve(dir);
	if (!existsSync(path.join(tau, "PROMPT.md"))) throw new Error(`${tau}: not a tau (no PROMPT.md)`);
	return tau;
}

/** Whether a source is a path: one that holds a `/`, or starts with a `.`; otherwise npm, or the provider. */
function isPath(from: string): boolean {
	return from.includes("/") || from.includes(path.sep) || from.startsWith(".");
}

/** A source as `.tau/lock.json` keeps it: a path relative to the tau, starting with `.`. */
function lockedFrom(tau: string, source: string): string {
	if (!path.isAbsolute(source)) return source;
	const relative = path.relative(tau, source).split(path.sep).join("/");
	return relative.startsWith(".") ? relative : `./${relative}`;
}

function contractDir(tau: string, name: string): string {
	return path.join(tau, ".tau", "contracts", ...name.split("/"));
}

/**
 * Pull the contract `name`, at the version `range` gives, or, without one, the newest `source` has,
 * into `.tau/contracts/`, in place of what is there, once it is checked: a contract's package, of
 * that name, at that version, holding its index.d.ts.
 */
async function pull(tau: string, name: string, range: string | undefined, source: string, context: ApiContext): Promise<Contract> {
	const wanted = range === undefined ? undefined : (rangeVersion(range) as string);
	const scratch = path.join(tau, ".tau", `pulling-${randomUUID()}`);
	await mkdir(path.join(tau, ".tau"), { recursive: true });
	try {
		const where = source === NPM ? "npm" : path.isAbsolute(source) ? source : `the provider, the ${context.provider} adaptor's backend,`;
		if (source === NPM) await fromNpm(name, wanted, scratch, context);
		else if (path.isAbsolute(source)) await copyDeclarations(source, scratch);
		else if (source === PROVIDER) {
			const adaptor = context.adaptors[context.provider];
			if (adaptor === undefined) throw new Error(`no wire adaptor ${JSON.stringify(context.provider)}, the provider; there are ${Object.keys(context.adaptors).join(", ")}`);
			if (adaptor.contract === undefined) throw new Error(`the provider, the ${context.provider} adaptor, gives no contracts`);
			await adaptor.contract(name, range, scratch, context.signal);
		} else throw new Error(`no source ${JSON.stringify(source)}: npm, a path, or the provider`);
		let contract: Contract;
		try {
			contract = readContract(scratch);
		} catch (error) {
			throw new Error(`${where} gives no contract ${name}: ${messageOf(error).replaceAll(scratch, name)}`);
		}
		if (contract.name !== name) throw new Error(`${where} gives ${contract.name}, not ${name}`);
		if (wanted !== undefined && contract.version !== wanted)
			throw new Error(`${where} has ${name} at ${contract.version}, not ${wanted}, the version ${range as string} gives, which is what the tau is written against`);
		if (!(await lstat(path.join(scratch, "index.d.ts")).catch(() => undefined))?.isFile()) throw new Error(`${where}: ${name} holds no index.d.ts`);
		const to = contractDir(tau, name);
		await rm(to, { recursive: true, force: true });
		await mkdir(path.dirname(to), { recursive: true });
		await rename(scratch, to);
		return contract;
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

/** Whether a file, at `at` in a contract's package, is one `.tau/` keeps: its package.json and its declarations. */
function kept(at: string): boolean {
	return at === "package.json" || at.endsWith(".d.ts");
}

/** Copy the package.json and declarations of the contract at `from`, but those in a node_modules/, to `to`. */
async function copyDeclarations(from: string, to: string): Promise<void> {
	const root = await realpath(from);
	await mkdir(to);
	const walk = async (folder: string, prefix: string): Promise<void> => {
		for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const at = prefix + entry.name;
			if (entry.isDirectory()) {
				if (entry.name !== "node_modules") await walk(path.join(folder, entry.name), `${at}/`);
			} else if (entry.isFile() && kept(at)) {
				await mkdir(path.join(to, path.dirname(at)), { recursive: true });
				await copyFile(path.join(folder, entry.name), path.join(to, at));
			}
		}
	};
	await walk(root, "");
}

/** Pull the contract `name` from the npm registry, `$npm_config_registry` or npm's own, at `wanted`, or the latest. */
async function fromNpm(name: string, wanted: string | undefined, to: string, context: ApiContext): Promise<void> {
	const get = context.fetch ?? fetch;
	const registry = (context.env.npm_config_registry || DEFAULT_REGISTRY).replace(/\/+$/u, "");
	const init = context.signal === undefined ? {} : { signal: context.signal };
	const response = await get(`${registry}/${name.replace("/", "%2f")}`, { ...init, headers: { accept: "application/json" } });
	if (response.status === 404) throw new Error(`npm has no ${name}`);
	if (!response.ok) throw new Error(`npm answered ${response.status} for ${name}`);
	const packument = (await response.json()) as { versions?: { [version: string]: { dist?: { tarball?: string } } }; "dist-tags"?: { latest?: string } };
	const versions = Object.keys(packument.versions ?? {}).filter((version) => parseVersion(version) !== undefined);
	const latest = packument["dist-tags"]?.latest;
	const version = wanted ?? (latest !== undefined && versions.includes(latest) ? latest : versions.sort(compareVersions).at(-1));
	if (version === undefined) throw new Error(`npm has no version of ${name}`);
	if (!versions.includes(version))
		throw new Error(`npm has ${name} at ${versions.sort(compareVersions).join(", ")}, not ${version}, which is what the tau is written against`);
	const tarball = packument.versions?.[version]?.dist?.tarball;
	if (typeof tarball !== "string") throw new Error(`npm gives no tarball of ${name}@${version}`);
	const download = await get(tarball, init);
	if (!download.ok || download.body === null) throw new Error(`npm answered ${download.status} for ${tarball}`);
	const bytes = Readable.fromWeb(download.body as import("node:stream/web").ReadableStream<Uint8Array>).pipe(createGunzip());
	await mkdir(to);
	for await (const entry of readTar(bytes, `${name}@${version}'s tarball`)) {
		// Its package is in the archive's one folder, `package/` as npm packs it.
		const at = entry.name.split("/").slice(1).join("/");
		if (entry.type !== "file" || !kept(at) || at.split("/").includes("node_modules")) continue;
		const chunks: Uint8Array[] = [];
		for await (const chunk of entry.body) chunks.push(chunk);
		await mkdir(path.join(to, path.dirname(at)), { recursive: true });
		await writeFile(path.join(to, at), Buffer.concat(chunks));
	}
}

/** Remove what `.tau/contracts/` holds of no API in `names`. */
async function dropStray(tau: string, names: readonly string[]): Promise<void> {
	const contracts = path.join(tau, ".tau", "contracts");
	const entries = await readdir(contracts).catch(() => [] as string[]);
	for (const entry of entries) {
		if (!entry.startsWith("@")) {
			if (!names.includes(entry)) await rm(path.join(contracts, entry), { recursive: true, force: true });
			continue;
		}
		for (const inner of await readdir(path.join(contracts, entry)).catch(() => [] as string[]))
			if (!names.includes(`${entry}/${inner}`)) await rm(path.join(contracts, entry, inner), { recursive: true, force: true });
		if ((await readdir(path.join(contracts, entry)).catch(() => [])).length === 0) await rm(path.join(contracts, entry), { recursive: true, force: true });
	}
}

async function readMetadata(tau: string): Promise<{ [key: string]: unknown }> {
	const file = path.join(tau, "tau.json");
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		throw new Error(`${file}: is not JSON: ${messageOf(error)}`);
	}
	if (!isObject(json)) throw new Error(`${file}: must be an object`);
	return json;
}

async function writeMetadata(tau: string, metadata: { readonly [key: string]: unknown }): Promise<void> {
	await writeFile(path.join(tau, "tau.json"), `${JSON.stringify(metadata, undefined, 2)}\n`);
}

async function readLock(tau: string): Promise<{ contracts: Lock["contracts"] }> {
	const file = path.join(tau, ".tau", "lock.json");
	let json: unknown;
	try {
		json = JSON.parse(await readFile(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { contracts: {} };
		throw new Error(`${file}: ${messageOf(error)}`);
	}
	const contracts = isObject(json) && isObject(json.contracts) ? json.contracts : undefined;
	if (contracts === undefined) throw new Error(`${file}: must be { "contracts": { … } }`);
	const read: Lock["contracts"] = {};
	for (const [name, entry] of Object.entries(contracts)) {
		if (!isObject(entry) || typeof entry.version !== "string" || typeof entry.from !== "string")
			throw new Error(`${file}: ${name}: must be { "version", "from" }`);
		read[name] = { version: entry.version, from: entry.from };
	}
	return { contracts: read };
}

/** Write `.tau/`: `lock.json`, a `tsconfig.json` mapping each API to its declarations, and a `.gitignore` that keeps only `lock.json`. */
async function writeTauDir(tau: string, lock: Lock): Promise<void> {
	const dir = path.join(tau, ".tau");
	await mkdir(dir, { recursive: true });
	const contracts = sorted(lock.contracts);
	await writeFile(path.join(dir, "lock.json"), `${JSON.stringify({ contracts }, undefined, 2)}\n`);
	const paths = Object.fromEntries(Object.keys(contracts).map((name) => [name, [`./contracts/${name}/index.d.ts`]]));
	await writeFile(path.join(dir, "tsconfig.json"), `${JSON.stringify({ compilerOptions: { paths } }, undefined, 2)}\n`);
	await writeFile(path.join(dir, ".gitignore"), "*\n!lock.json\n");
}

function sorted<T>(record: { readonly [key: string]: T }): { [key: string]: T } {
	return Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
