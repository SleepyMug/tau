import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { ArchiveError, type CallJson, extractContent, readCall, readResult, writeCall } from "./archive.js";
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
	files: {
		notes: { mode: "in", kind: "file", base: "notes.txt" },
		site: { mode: "inout", kind: "dir", base: "site" },
		pages: { mode: "in", kind: "dir", base: "pages" },
		counts: { mode: "out", base: "counts.txt" },
	},
	args: { top: 10, label: "${site}" },
	tau: true,
};

test("a call's tau, files and directories are written into it, and made again from it as they were", async () => {
	const home = path.join(tmp, "home");
	mkdirSync(path.join(home, "site", "assets"), { recursive: true });
	writeFileSync(path.join(home, "notes.txt"), "notes\n");
	chmodSync(path.join(home, "notes.txt"), 0o644);
	writeFileSync(path.join(home, "site", "index.html"), "<p>hi</p>\n");
	chmodSync(path.join(home, "site", "index.html"), 0o644);
	writeFileSync(path.join(home, "site", "assets", "logo.png"), "png");
	chmodSync(path.join(home, "site", "assets", "logo.png"), 0o600);
	writeFileSync(path.join(home, "site", "run.sh"), "#!/bin/sh\n");
	chmodSync(path.join(home, "site", "run.sh"), 0o755);
	symlinkSync("assets/logo.png", path.join(home, "site", "logo.png"));
	mkdirSync(path.join(home, "site", "locked"));
	writeFileSync(path.join(home, "site", "locked", "kept"), "kept\n");
	chmodSync(path.join(home, "site", "locked"), 0o555);
	const tau = path.join(tmp, "tau");
	mkdirSync(tau);
	writeFileSync(path.join(tau, "PROMPT.md"), "Go.\n");

	const sources = [
		{ from: tau },
		{ file: "notes", from: path.join(home, "notes.txt") },
		{ file: "site", from: path.join(home, "site") },
		// Several paths, a directory holding each under its base name.
		{ file: "pages", from: [path.join(home, "site", "index.html"), path.join(home, "notes.txt")] },
	];
	const bytes = await bytesOf(writeCall(CALL, sources));
	const { json, contents } = await readCall(once(bytes));
	assert.deepEqual(json, CALL);
	const out = path.join(tmp, "out");
	mkdirSync(out);
	const read: string[] = [];
	for await (const content of contents) {
		read.push(`${content.file ?? "the tau"} ${content.kind}`);
		await extractContent(content, path.join(out, content.file === undefined ? "tau" : content.file === "notes" ? "notes.txt" : content.file));
	}
	assert.deepEqual(read, ["the tau dir", "notes file", "site dir", "pages dir"]);
	assert.deepEqual(tree(path.join(out, "tau")), tree(tau));
	assert.deepEqual(tree(path.join(out, "site")), tree(path.join(home, "site")));
	assert.deepEqual(tree(path.join(out, "notes.txt")), tree(path.join(home, "notes.txt")));
	assert.deepEqual(tree(path.join(out, "pages")), ["/ 755", "index.html 644 <p>hi</p>\n", "notes.txt 644 notes\n"]);
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

/** Read a call whole, its contents and their entries. */
async function readWhole(bytes: Buffer): Promise<void> {
	const { contents } = await readCall(once(bytes));
	for await (const content of contents) for await (const _ of content.entries);
}

const DIR: CallJson = { files: { site: { mode: "inout", kind: "dir", base: "site" } }, args: {} };

test("a call that breaks the spec is refused, naming why, its contents as they are read", async () => {
	const refused = async (bytes: Promise<Buffer>, problem: string) =>
		assert.rejects(readWhole(await bytes), (error: Error) => {
			assert.ok(error instanceof ArchiveError);
			assert.equal(error.message, `the call breaks the spec: ${problem}`);
			return true;
		});
	await refused(call(DIR, [], "result.json"), "its first entry is not the file call.json");
	await refused(call({ files: {}, args: {}, extra: 1 }, []), 'call.json: it: unknown key "extra"');
	await refused(call({ files: {} }, []), "call.json: `args`: is an object");
	await refused(call({ args: {} }, []), "call.json: `files`: is an object");
	await refused(call({ files: { a: "a.txt" }, args: {} }, []), "call.json: `files`.a: is an object");
	await refused(call({ files: { "a-b": { mode: "in", kind: "file", base: "a" } }, args: {} }, []), 'call.json: `files`: "a-b" is not a file\'s name, which matches ^[A-Za-z_][A-Za-z0-9_]*$');
	await refused(call({ files: { a: { mode: "in", kind: "file", base: "../x" } }, args: {} }, []), "call.json: `files`.a: `base` is a base name, not empty, `.` or `..`, with no / and no NUL");
	await refused(call({ files: { a: { mode: "share", kind: "file", base: "a" } }, args: {} }, []), 'call.json: `files`.a: `mode` is "in", "out" or "inout"');
	await refused(call({ files: { a: { mode: "in", base: "a" } }, args: {} }, []), 'call.json: `files`.a: `kind` is "file" or "dir"');
	await refused(call({ files: { a: { mode: "out", kind: "link", base: "x" } }, args: {} }, []), 'call.json: `files`.a: `kind` is "file" or "dir"');
	await refused(call({ files: {}, args: {}, tau: { kind: "dir" } }, []), "call.json: `tau` is true, when the call carries its tau");
	await refused(call({ files: {}, args: {}, tau: true }, [["tau", "x"]]), "tau is a file, but call.json says it is a directory");
	await refused(call(DIR, []), "call.json names files/site, but the archive does not hold it");
	await refused(call(DIR, [["files/site", "/"], ["files/other", "x"]]), "call.json names no content files/other");
	await refused(call(DIR, [["tau", "/"]]), "call.json names no content tau");
	await refused(call(DIR, [["files/site", "x"]]), "files/site is a file, but call.json says it is a directory");
	await refused(call(DIR, [["files/site", "-> b0"]]), "files/site is a symlink, which a content is not");
	await refused(call(DIR, [["files/site", "/"], ["files/site", "/"]]), "the content files/site appears twice");
	await refused(call(DIR, [["files/site/a", "x"]]), "files/site/a is not in the content before it, whose entries are together");
	await refused(call(DIR, [["files/site", "/"], ["files/site/a/b", "x"]]), "files/site/a/b does not follow its directory");
	await refused(call(DIR, [["files/site", "/"], ["files/site/a", "x"], ["files/site/a", "y"]]), "files/site/a appears twice");
	await refused(call(DIR, [["other", "x"]]), "other is in no content, which is at tau/ or files/<name>");
	await refused(call(DIR, [["files/a-b", "x"]]), "files/a-b is in no content, which is at tau/ or files/<name>");
	await refused(
		call(DIR, [
			["files/site", "/"],
			["files/site/sub", "/"],
			["files/site/a", "x"],
			["files/site/abs", "-> /etc/passwd"],
			["files/site/up", "-> ../b0"],
			["files/site/sub/up", "-> ../../x"],
			["files/site/gone", "-> nowhere"],
			["files/site/loop", "-> loop"],
			["files/site/into", "-> a/b"],
			["files/site/via", "-> abs"],
		]),
		[
			"files/site/abs: leads to the absolute path /etc/passwd; a symlink in a content is relative",
			"files/site/up: leads outside its content",
			"files/site/sub/up: leads outside its content",
			"files/site/gone: leads to files/site/nowhere, which does not exist",
			"files/site/loop: is a loop of symlinks",
			"files/site/into: leads into files/site/a, which is a file",
			"files/site/via: leads through files/site/abs to the absolute path /etc/passwd; a symlink in a content is relative",
		].join("; "),
	);
	// Links that stay in the content, through others, and into directories, are its.
	await readWhole(
		await call(DIR, [
			["files/site", "/"],
			["files/site/sub", "/"],
			["files/site/sub/a", "x"],
			["files/site/here", "-> ."],
			["files/site/to", "-> sub"],
			["files/site/chain", "-> to/../to/a"],
			["files/site/sub/back", "-> ../chain"],
		]),
	);
});

test("a reader that stops reading a content early still has the next one, and the archive checked whole", async () => {
	const json: CallJson = { files: { a: { mode: "in", kind: "dir", base: "a" }, b: { mode: "in", kind: "file", base: "b" } }, args: {} };
	const read = async (entries: [string, string][]) => {
		const { contents } = await readCall(once(await call(json, entries)));
		const files: string[] = [];
		for await (const content of contents) {
			files.push(content.file as string);
			for await (const _ of content.entries) break;
		}
		return files;
	};
	assert.deepEqual(await read([["files/a", "/"], ["files/a/x", "x"], ["files/b", "y"]]), ["a", "b"]);
	await assert.rejects(read([["files/a", "/"], ["files/a/x", "-> /x"], ["files/b", "y"]]), /files\/a\/x: leads to the absolute path/u);
});

test("a result's JSON is checked as the spec has it", async () => {
	const result = (json: object, entries: [string, string][] = []) => call(json, entries, "result.json");
	const ok = { ok: true, text: "Done.", outputs: { site: { kind: "dir" } } };
	const { json, contents } = await readResult(once(await result(ok, [["files/site", "/"]])));
	assert.deepEqual(json, ok);
	for await (const _ of contents);
	const refused = async (bytes: Promise<Buffer>, problem: string) =>
		assert.rejects(async () => {
			const { contents } = await readResult(once(await bytes));
			for await (const _ of contents);
		}, (error: Error) => {
			assert.equal(error.message, `the result breaks the spec: ${problem}`);
			return true;
		});
	await refused(result({ ok: true, text: "", failure: "no", outputs: {} }), "result.json: `failure` is a string, only when the run failed");
	await refused(result({ ok: "yes", text: "", outputs: {} }), "result.json: `ok` is true or false");
	await refused(result({ ok: false, text: "" }), "result.json: `outputs`: is an object");
	await refused(result({ ok: true, text: "", outputs: { "/site": {} } }), 'result.json: `outputs`: "/site" is not a file\'s name, which matches ^[A-Za-z_][A-Za-z0-9_]*$');
	await refused(result({ ok: true, text: "", outputs: { a: { kind: "file", mode: "out" } } }), 'result.json: `outputs`.a: unknown key "mode"');
	await refused(result({ ok: true, text: "", outputs: { a: { kind: "file" } } }, [["tau", "/"]]), "result.json names no content tau");
});
