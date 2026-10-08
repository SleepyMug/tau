import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { addContract, updateContracts } from "./index.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tau-add-"));
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

/** Every file under `dir`, relative to it. */
function list(dir: string): string[] {
	return (readdirSync(dir, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
		.filter((entry) => entry.isFile())
		.map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
		.sort();
}

const NOTES = {
	"package.json": { name: "@acme/notes", version: "1.2.0", description: "Notes.", tau: { contract: true }, type: "module", types: "./index.d.ts" },
	"index.d.ts": 'import type { Tag } from "./types/tag.js";\nexport declare function addNote(text: string, tags?: Tag[]): Promise<number>;\n',
	"types/tag.d.ts": "export type Tag = string;\n",
	"README.md": "# Notes\n",
	"conformance/index.js": "export {};\n",
	"conformance/index.d.ts": "export {};\n",
};

test("a contract is copied into the tau as api/<alias>/: its package.json and its declarations, replacing what is there", async () => {
	const contract = write("notes", NOTES);
	const tau = write("tau", { "PROMPT.md": "Keep notes.", "api/notes/old.d.ts": "export {};\n" });
	assert.deepEqual(await addContract("notes", contract, tau), { name: "@acme/notes", version: "1.2.0", description: "Notes." });
	assert.deepEqual(list(path.join(tau, "api/notes")), ["index.d.ts", "package.json", path.join("types", "tag.d.ts")]);
	assert.deepEqual(JSON.parse(readFileSync(path.join(tau, "api/notes/package.json"), "utf8")), NOTES["package.json"]);
});

test("a contract is copied from a tarball, as npm packs it", async () => {
	const packed = write("packed", {});
	cpSync(write("notes-src", NOTES), path.join(packed, "package"), { recursive: true });
	execFileSync("tar", ["-czf", path.join(tmp, "notes.tgz"), "-C", packed, "package"]);
	const tau = write("from-tarball", { "PROMPT.md": "Keep notes." });
	await addContract("memo", path.join(tmp, "notes.tgz"), tau);
	assert.deepEqual(list(path.join(tau, "api/memo")), ["index.d.ts", "package.json", path.join("types", "tag.d.ts")]);
});

test("what is not a contract, a contract held under another alias, a bad alias, or a directory that is no tau is refused", async () => {
	const contract = write("held", NOTES);
	const tau = write("holding", { "PROMPT.md": "Hi." });
	await addContract("notes", contract, tau);
	await assert.rejects(addContract("memo", contract, tau), /the tau holds @acme\/notes as api\/notes already/);
	await assert.rejects(addContract("notes", write("plain", { "package.json": { name: "plain" } }), tau), /not a contract's/);
	await assert.rejects(addContract("bad alias", contract, tau), /"bad alias" is not an alias/);
	await assert.rejects(addContract("notes", contract, write("no-tau", {})), /not a tau \(no PROMPT\.md\)/);
	assert.equal(existsSync(path.join(tau, "api/memo")), false);
});

test("an update names only APIs the tau has", async () => {
	const tau = write("updating", { "PROMPT.md": "Hi." });
	await addContract("notes", write("for-update", NOTES), tau);
	await assert.rejects(updateContracts(["memo"], tau), /has no API memo/);
});
