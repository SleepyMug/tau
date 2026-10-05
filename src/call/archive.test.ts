import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { ArchiveError, type CallJson, extractBlob, readCall, readResult, writeCall } from "./archive.js";
import { type WriteEntry, writeTar } from "./tar.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tau-archive-"));
after(() => {
	execFileSync("chmod", ["-R", "u+rwx", tmp]);
	rmSync(tmp, { recursive: true, force: true });
});

async function bytesOf(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
	const all: Uint8Array[] = [];
	for await (const chunk of chunks) all.push(chunk);
	return Buffer.concat(all);
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
	yield bytes;
}

/** Everything under `dir`: each path, with a file's mode and text, a directory's mode, a symlink's target. */
function tree(dir: string, at = ""): string[] {
	const stats = lstatSync(path.join(dir, at));
	const mode = (stats.mode & 0o777).toString(8);
	if (stats.isSymbolicLink()) return [`${at} -> ${readlinkSync(path.join(dir, at))}`];
	if (stats.isFile()) return [`${at} ${mode} ${readFileSync(path.join(dir, at), "utf8")}`];
	return [`${at}/ ${mode}`, ...readdirSync(path.join(dir, at)).sort().flatMap((name) => tree(dir, path.join(at, name)))];
}

const CALL: CallJson = {
	values: {
		notes: { $in: { name: "notes.txt", kind: "file", blob: "b0" } },
		top: "10",
		site: { $inout: { name: "site", kind: "dir", blob: "b1" } },
		counts: { $out: { name: "counts.txt" } },
	},
};

test("a call's files and directories are written into it, and made again from it as they were", async () => {
	const home = path.join(tmp, "home");
	mkdirSync(path.join(home, "site", "assets"), { recursive: true });
	writeFileSync(path.join(home, "notes.txt"), "notes\n");
	writeFileSync(path.join(home, "site", "index.html"), "<p>hi</p>\n");
	writeFileSync(path.join(home, "site", "assets", "logo.png"), "png");
	chmodSync(path.join(home, "site", "assets", "logo.png"), 0o600);
	writeFileSync(path.join(home, "site", "run.sh"), "#!/bin/sh\n");
	chmodSync(path.join(home, "site", "run.sh"), 0o755);
	symlinkSync("assets/logo.png", path.join(home, "site", "logo.png"));
	mkdirSync(path.join(home, "site", "locked"));
	writeFileSync(path.join(home, "site", "locked", "kept"), "kept\n");
	chmodSync(path.join(home, "site", "locked"), 0o555);

	const bytes = await bytesOf(writeCall(CALL, [{ id: "b0", path: path.join(home, "notes.txt") }, { id: "b1", path: path.join(home, "site") }]));
	const { json, blobs } = await readCall(once(bytes));
	assert.deepEqual(json, CALL);
	const out = path.join(tmp, "out");
	mkdirSync(out);
	const ids: string[] = [];
	for await (const blob of blobs) {
		ids.push(`${blob.id} ${blob.kind}`);
		await extractBlob(blob, path.join(out, blob.id === "b0" ? "notes.txt" : "site"));
	}
	assert.deepEqual(ids, ["b0 file", "b1 dir"]);
	assert.deepEqual(tree(out), tree(home));
});

/** A call's JSON, and then `entries`, each a file's text, a directory, `/` at its end, or a symlink, `-> target`. */
async function call(json: object, entries: [string, string][], first = "call.json"): Promise<Buffer> {
	const data = JSON.stringify(json);
	const written: WriteEntry[] = [{ name: first, type: "file", mode: 0o644, size: Buffer.byteLength(data), body: async function* () { yield Buffer.from(data); } }];
	for (const [name, what] of entries) {
		if (what === "/") written.push({ name, type: "dir", mode: 0o755, size: 0 });
		else if (what.startsWith("-> ")) written.push({ name, type: "symlink", mode: 0o777, size: 0, target: what.slice(3) });
		else written.push({ name, type: "file", mode: 0o644, size: Buffer.byteLength(what), body: async function* () { yield Buffer.from(what); } });
	}
	return bytesOf(writeTar(written));
}

/** Read a call whole, its blobs and their entries. */
async function readWhole(bytes: Buffer): Promise<void> {
	const { blobs } = await readCall(once(bytes));
	for await (const blob of blobs) for await (const _ of blob.entries);
}

const DIR: CallJson = { values: { site: { $inout: { name: "site", kind: "dir", blob: "b1" } } } };

test("a call that breaks the spec is refused, naming why, its blobs as they are read", async () => {
	const refused = async (bytes: Promise<Buffer>, problem: string) =>
		assert.rejects(readWhole(await bytes), (error: Error) => {
			assert.ok(error instanceof ArchiveError);
			assert.equal(error.message, `the call breaks the spec: ${problem}`);
			return true;
		});
	await refused(call(DIR, [], "result.json"), "its first entry is not the file call.json");
	await refused(call({ values: {}, extra: 1 }, []), 'call.json: it: unknown key "extra"');
	await refused(call({ values: { a: { $in: "a.txt" } } }, []), "call.json: `values`/a/$in: is an object");
	await refused(call({ values: { a: { $in: { name: "../x", kind: "file", blob: "b" } } } }, []), "call.json: `values`/a/$in: `name` is a base name, not empty, `.` or `..`, with no / and no NUL");
	await refused(call({ values: { a: { $out: { name: "x", kind: "file" } } } }, []), 'call.json: `values`/a/$out: unknown key "kind"');
	await refused(call({ values: { a: { $in: { name: "a", kind: "file", blob: "b" }, b: "x" } } }, []), "call.json: `values`/a: is not a handle, {\"$in\" | \"$inout\": {name, kind, blob}} or {\"$out\": {name}}");
	await refused(call({ values: {}, tau: { kind: "file", blob: "t" } }, [["blobs/t", "x"]]), "call.json: `tau` is a directory");
	await refused(call(DIR, []), "the blob b1 is named, but not in it");
	await refused(call(DIR, [["blobs/b1", "/"], ["blobs/b2", "x"]]), "no handle names the blob b2");
	await refused(call(DIR, [["blobs/b1", "x"]]), "the blob b1 is a file, but is named as a directory");
	await refused(call(DIR, [["blobs/b1", "-> b0"]]), "the blob b1 is a symlink, which a blob is not");
	await refused(call(DIR, [["blobs/b1", "/"], ["blobs/b1", "/"]]), "the blob b1 appears twice");
	await refused(call(DIR, [["blobs/b1/a", "x"]]), "blobs/b1/a is not in the blob before it, whose entries are together");
	await refused(call(DIR, [["blobs/b1", "/"], ["blobs/b1/a/b", "x"]]), "blobs/b1/a/b does not follow its directory");
	await refused(call(DIR, [["blobs/b1", "/"], ["blobs/b1/a", "x"], ["blobs/b1/a", "y"]]), "blobs/b1/a appears twice");
	await refused(call(DIR, [["other", "x"]]), "other is not in a blob, under blobs/<id>");
	await refused(
		call(DIR, [
			["blobs/b1", "/"],
			["blobs/b1/sub", "/"],
			["blobs/b1/a", "x"],
			["blobs/b1/abs", "-> /etc/passwd"],
			["blobs/b1/up", "-> ../b0"],
			["blobs/b1/sub/up", "-> ../../x"],
			["blobs/b1/gone", "-> nowhere"],
			["blobs/b1/loop", "-> loop"],
			["blobs/b1/into", "-> a/b"],
			["blobs/b1/via", "-> abs"],
		]),
		[
			"blobs/b1/abs: leads to the absolute path /etc/passwd; a symlink in a blob is relative",
			"blobs/b1/up: leads outside its blob",
			"blobs/b1/sub/up: leads outside its blob",
			"blobs/b1/gone: leads to blobs/b1/nowhere, which does not exist",
			"blobs/b1/loop: is a loop of symlinks",
			"blobs/b1/into: leads into blobs/b1/a, which is a file",
			"blobs/b1/via: leads through blobs/b1/abs to the absolute path /etc/passwd; a symlink in a blob is relative",
		].join("; "),
	);
	// Links that stay in the blob, through others, and into directories, are its.
	await readWhole(
		await call(DIR, [
			["blobs/b1", "/"],
			["blobs/b1/sub", "/"],
			["blobs/b1/sub/a", "x"],
			["blobs/b1/here", "-> ."],
			["blobs/b1/to", "-> sub"],
			["blobs/b1/chain", "-> to/../to/a"],
			["blobs/b1/sub/back", "-> ../chain"],
		]),
	);
});

test("a reader that stops reading a blob early still has the next one, and the archive checked whole", async () => {
	const json: CallJson = { values: { a: { $in: { name: "a", kind: "dir", blob: "b1" } }, b: { $in: { name: "b", kind: "file", blob: "b2" } } } };
	const read = async (entries: [string, string][]) => {
		const { blobs } = await readCall(once(await call(json, entries)));
		const ids: string[] = [];
		for await (const blob of blobs) {
			ids.push(blob.id);
			for await (const _ of blob.entries) break;
		}
		return ids;
	};
	assert.deepEqual(await read([["blobs/b1", "/"], ["blobs/b1/x", "x"], ["blobs/b2", "y"]]), ["b1", "b2"]);
	await assert.rejects(read([["blobs/b1", "/"], ["blobs/b1/x", "-> /x"], ["blobs/b2", "y"]]), /blobs\/b1\/x: leads to the absolute path/u);
});

test("a result's JSON is checked as the spec has it", async () => {
	const result = (json: object, entries: [string, string][] = []) => call(json, entries, "result.json");
	const ok = { ok: true, text: "Done.", outputs: { "/site": { $inout: { name: "site", kind: "dir", blob: "o0" } } } };
	const { json, blobs } = await readResult(once(await result(ok, [["blobs/o0", "/"]])));
	assert.deepEqual(json, ok);
	for await (const _ of blobs);
	const refused = async (bytes: Promise<Buffer>, problem: string) =>
		assert.rejects(async () => {
			const { blobs } = await readResult(once(await bytes));
			for await (const _ of blobs);
		}, (error: Error) => {
			assert.equal(error.message, `the result breaks the spec: ${problem}`);
			return true;
		});
	await refused(result({ ok: true, text: "", failure: "no", outputs: {} }), "result.json: `failure` is a string, only when the run failed");
	await refused(result({ ok: "yes", text: "", outputs: {} }), "result.json: `ok` is true or false");
	await refused(result({ ok: false, text: "" }), "result.json: `outputs`: is an object");
	await refused(result({ ok: true, text: "", outputs: { site: {} } }), 'result.json: `outputs`: "site" is not a JSON Pointer into the values');
	await refused(result({ ok: true, text: "", outputs: { "/a~1b": {} } }), 'result.json: `outputs`: "/a~1b" is not a JSON Pointer into the values');
	await refused(result({ ok: true, text: "", outputs: { "/a": { $in: { name: "a", kind: "file", blob: "o" } } } }), 'result.json: /a: unknown key "$in"');
});
