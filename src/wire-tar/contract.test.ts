import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { packContract, unpackContract } from "./contract.js";
import { ArchiveError, type WriteEntry, writeTar } from "./tar.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tau-contract-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const MANIFEST = JSON.stringify({ name: "@acme/notes", version: "1.2.0", description: "Notes.", tau: { contract: true }, type: "module", types: "./index.d.ts" });

function write(dir: string, files: Record<string, string>): string {
	const root = path.join(tmp, dir);
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		writeFileSync(path.join(root, file), text);
	}
	return root;
}

/** An archive of `entries`, each a file's text, or, as null, a directory. */
function archive(entries: Record<string, string | null>, links: Record<string, string> = {}): AsyncGenerator<Uint8Array> {
	const written: WriteEntry[] = Object.entries(entries).map(([name, text]) =>
		text === null
			? { name, type: "dir", mode: 0o755, size: 0 }
			: { name, type: "file", mode: 0o644, size: Buffer.byteLength(text), body: async function* () { yield Buffer.from(text); } },
	);
	for (const [name, target] of Object.entries(links)) written.push({ name, type: "symlink", mode: 0o777, size: 0, target });
	return writeTar(written);
}

let made = 0;
const fresh = (): string => path.join(tmp, `out-${made++}`);

test("a contract's archive holds its package.json and declarations, and unpacks into a checked contract", async () => {
	const dir = write("notes", {
		"package.json": MANIFEST,
		"index.d.ts": "export {};\n",
		"lib/tags.d.ts": "export {};\n",
		"lib/tags.js": "",
		"node_modules/dep/index.d.ts": "",
		"README.md": "",
	});
	const to = fresh();
	assert.deepEqual(await unpackContract(packContract(dir), to, { name: "@acme/notes", range: "^1.0.0" }), { name: "@acme/notes", version: "1.2.0", description: "Notes." });
	assert.deepEqual(readdirSync(to, { recursive: true }).sort(), ["index.d.ts", "lib", "lib/tags.d.ts", "package.json"]);
});

test("packing refuses a symlinked declaration file", async () => {
	const dir = write("linked", { "package.json": MANIFEST, "real.d.ts": "" });
	symlinkSync("real.d.ts", path.join(dir, "index.d.ts"));
	await assert.rejects(async () => {
		for await (const _ of packContract(dir));
	}, /index\.d\.ts: is a symlink/u);
});

test("an archive that is not the contract asked for is refused, and leaves nothing", async () => {
	const good = { contract: null, "contract/package.json": MANIFEST, "contract/index.d.ts": "export {};\n" };
	for (const [entries, links, asked, problem] of [
		[{ ...good, "contract/index.js": "" }, {}, {}, /contract\/index\.js is neither its package\.json nor a declaration file/u],
		[{ ...good, "other/index.d.ts": "" }, {}, {}, /other\/index\.d\.ts is not in contract\//u],
		[good, { "contract/link.d.ts": "index.d.ts" }, {}, /contract\/link\.d\.ts is a symlink/u],
		[{ contract: null, "contract/package.json": MANIFEST }, {}, {}, /it holds no index\.d\.ts/u],
		[good, {}, { name: "@acme/other" }, /it is @acme\/notes, not @acme\/other/u],
		[good, {}, { range: "^1.3.0" }, /it is at 1\.2\.0, which is not within \^1\.3\.0/u],
		[{ contract: null, "contract/package.json": "{}", "contract/index.d.ts": "" }, {}, {}, /contract\/package\.json: not a contract's/u],
		[{ "contract/index.d.ts": "" }, {}, {}, /does not follow its content|does not follow its directory/u],
	] as const) {
		const to = fresh();
		await assert.rejects(
			unpackContract(archive(entries as Record<string, string | null>, links), to, { name: "@acme/notes", ...asked }),
			(error: Error) => error instanceof ArchiveError && problem.test(error.message),
		);
		assert.equal(existsSync(to), false);
	}
});
