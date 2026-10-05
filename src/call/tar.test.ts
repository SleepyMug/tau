import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { ArchiveError, readTar, type WriteEntry, writeTar } from "./tar.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tau-tar-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

async function bytesOf(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
	const all: Uint8Array[] = [];
	for await (const chunk of chunks) all.push(chunk);
	return Buffer.concat(all);
}

/** Each entry read, with a file's bytes as text. */
async function read(bytes: Uint8Array): Promise<object[]> {
	const entries: object[] = [];
	for await (const { body, ...header } of readTar((async function* () { yield bytes; })())) {
		entries.push(header.type === "file" ? { ...header, text: (await bytesOf(body)).toString() } : header);
	}
	return entries;
}

const file = (name: string, text: string, mode = 0o644): WriteEntry => ({
	name,
	type: "file",
	mode,
	size: Buffer.byteLength(text),
	body: async function* () { yield Buffer.from(text); },
});

const LONG = `blobs/b0/${"deep/".repeat(30)}név.md`;
const ENTRIES: WriteEntry[] = [
	file("call.json", "{}\n"),
	{ name: "blobs/b0", type: "dir", mode: 0o755, size: 0 },
	file("blobs/b0/run.sh", "#!/bin/sh\n", 0o750),
	{ name: "blobs/b0/latest", type: "symlink", mode: 0o777, size: 0, target: "run.sh" },
	file(LONG, "x".repeat(1000)),
	{ name: "blobs/b0/far", type: "symlink", mode: 0o777, size: 0, target: `${"../".repeat(40)}x` },
];

test("what is written is read back: names, types, modes, sizes, targets and bytes, long ones in pax headers", async () => {
	const bytes = await bytesOf(writeTar(ENTRIES));
	assert.equal(bytes.length % 512, 0);
	assert.deepEqual(await read(bytes), [
		{ name: "call.json", type: "file", mode: 0o644, size: 3, text: "{}\n" },
		{ name: "blobs/b0", type: "dir", mode: 0o755, size: 0 },
		{ name: "blobs/b0/run.sh", type: "file", mode: 0o750, size: 10, text: "#!/bin/sh\n" },
		{ name: "blobs/b0/latest", type: "symlink", mode: 0o777, size: 0, target: "run.sh" },
		{ name: LONG, type: "file", mode: 0o644, size: 1000, text: "x".repeat(1000) },
		{ name: "blobs/b0/far", type: "symlink", mode: 0o777, size: 0, target: `${"../".repeat(40)}x` },
	]);
});

test("tar reads what is written, and what it writes in the pax format is read", async () => {
	const archive = path.join(tmp, "written.tar");
	writeFileSync(archive, await bytesOf(writeTar(ENTRIES)));
	const listed = execFileSync("tar", ["-tf", archive], { encoding: "utf8" }).trim().split("\n");
	assert.deepEqual(listed, ["call.json", "blobs/b0/", "blobs/b0/run.sh", "blobs/b0/latest", LONG, "blobs/b0/far"]);

	const dir = path.join(tmp, "by-tar");
	mkdirSync(path.join(dir, "blobs/b1/sub"), { recursive: true });
	writeFileSync(path.join(dir, "result.json"), "{}");
	writeFileSync(path.join(dir, "blobs/b1/sub", "ä".repeat(60)), "long\n");
	symlinkSync(`sub/${"ä".repeat(60)}`, path.join(dir, "blobs/b1/link"));
	// One block a record, so that nothing follows the two zero blocks.
	const bytes = execFileSync("tar", ["--format=pax", "-b1", "-cf", "-", "-C", dir, "result.json", "blobs"]);
	const entries = (await read(bytes)) as { name: string; type: string; target?: string }[];
	// tar lists a directory's entries in no set order.
	assert.deepEqual(entries.map(({ name, type }) => `${name} ${type}`).sort(), [
		"blobs dir",
		"blobs/b1 dir",
		"blobs/b1/link symlink",
		"blobs/b1/sub dir",
		`blobs/b1/sub/${"ä".repeat(60)} file`,
		"result.json file",
	]);
	assert.equal(entries.find(({ name }) => name === "blobs/b1/link")?.target, `sub/${"ä".repeat(60)}`);
});

/** `bytes` with its first header changed by `change`, its checksum made right again. */
function withHeader(bytes: Buffer, change: (head: Buffer) => void): Buffer {
	const changed = Buffer.from(bytes);
	const head = changed.subarray(0, 512);
	change(head);
	head.write(" ".repeat(8), 148, "ascii");
	head.write(`${head.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148, "ascii");
	return changed;
}

test("an archive that breaks the spec is refused, naming why", async () => {
	const one = await bytesOf(writeTar([file("call.json", "{}")]));
	const refused = async (bytes: Buffer, problem: RegExp) =>
		assert.rejects(read(bytes), (error: Error) => error instanceof ArchiveError && /^the archive breaks the spec: /u.test(error.message) && problem.test(error.message));

	await refused(one.subarray(0, one.length - 1024), /ends without the two zero blocks/u);
	await refused(one.subarray(0, one.length - 512), /a zero block is not followed by another/u);
	await refused(Buffer.concat([one, Buffer.alloc(512)]), /bytes after its end/u);
	await refused(Buffer.concat([one.subarray(0, 512), one.subarray(0, 1)]), /ends in its bytes|ends without/u);
	const corrupt = Buffer.from(one);
	corrupt[0] = 0x41;
	await refused(corrupt, /checksum/u);
	await refused(withHeader(one, (head) => head.write("1", 156)), /call\.json: is a hard link/u);
	await refused(withHeader(one, (head) => head.write("L", 156)), /a GNU long name/u);
	await refused(withHeader(one, (head) => head.write("ustar  \0", 257)), /not of the ustar format/u);
	await refused(withHeader(one, (head) => head.write("/etc/passwd\0", 0)), /a name is relative/u);
	await refused(withHeader(one, (head) => head.write("a/../b\0", 0)), /no empty, `\.` or `\.\.` component/u);
	await refused(withHeader(one, (head) => head.write("a//b\0", 0)), /no empty/u);
	await refused(withHeader(one, (head) => head.write("5", 156)), /call\.json: a directory has a size/u);

	const gnu = path.join(tmp, "gnu");
	mkdirSync(gnu);
	writeFileSync(path.join(gnu, "n".repeat(120)), "");
	await refused(execFileSync("tar", ["--format=gnu", "-b1", "-cf", "-", "-C", gnu, "n".repeat(120)]), /not of the ustar format|GNU long name/u);
});

test("an entry's bytes left unread are read past", async () => {
	const bytes = await bytesOf(writeTar([file("a", "x".repeat(700)), file("b", "y")]));
	const names: string[] = [];
	for await (const entry of readTar((async function* () { yield bytes.subarray(0, 100); yield bytes.subarray(100); })())) names.push(entry.name);
	assert.deepEqual(names, ["a", "b"]);
});
