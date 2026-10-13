import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { CallFile, Output } from "../core/model.js";
import { readContents } from "./content.js";
import { deliver, mergeOutputs } from "./deliver.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tau-deliver-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Writes `files` under `dir`, made fresh in the test directory, and returns its absolute path. */
function write(dir: string, files: Record<string, string>): string {
	const root = path.join(tmp, dir);
	mkdirSync(root, { recursive: true });
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		writeFileSync(path.join(root, file), text);
	}
	return root;
}

/** Each output as a file of the run, of its kind, by its name. */
function filesOf(outputs: Record<string, Output>): Record<string, CallFile> {
	return Object.fromEntries(Object.entries(outputs).map(([name, { kind }]) => [name, { mode: "out", kind, base: name }]));
}

/** Deliver `outputs`, each from a directory or file of `staged`, by its name, to `targets`. */
function deliverFrom(outputs: Record<string, Output>, staged: string, targets: Record<string, string>, files = filesOf(outputs)) {
	const contents = readContents(Object.keys(outputs).map((name) => ({ file: name, from: path.join(staged, name) })));
	return deliver({ ok: true, text: "", outputs }, contents, { files, targets });
}

test("a directory given back merges into the caller's, entry by entry, and anything else replaces what is there", async () => {
	const caller = write("home4", { "site/kept.md": "kept\n", "site/index.md": "old\n", "site/old/x.md": "x\n", "outside.md": "not the run's\n", "report.md": "an old report\n" });
	symlinkSync("../outside.md", path.join(caller, "site", "link.md"));
	const staged = write("staged4", { "site/index.md": "new\n", "site/old": "a file now\n", "site/link.md": "mine\n", "site/new/run.sh": "#!/bin/sh\n", report: "report\n" });
	chmodSync(path.join(staged, "site/new/run.sh"), 0o750);
	symlinkSync("run.sh", path.join(staged, "site/new/latest"));
	const report = await deliverFrom({ site: { kind: "dir" }, report: { kind: "file" } }, staged, { site: path.join(caller, "site"), report: path.join(caller, "report.md") });
	assert.equal(report.ok, true);
	assert.deepEqual(readdirSync(path.join(caller, "site")).sort(), ["index.md", "kept.md", "link.md", "new", "old"]);
	assert.equal(readFileSync(path.join(caller, "site", "index.md"), "utf8"), "new\n");
	assert.equal(readFileSync(path.join(caller, "site", "old"), "utf8"), "a file now\n");
	// The caller's link was replaced, not followed.
	assert.ok(lstatSync(path.join(caller, "site", "link.md")).isFile());
	assert.equal(readFileSync(path.join(caller, "outside.md"), "utf8"), "not the run's\n");
	assert.equal(lstatSync(path.join(caller, "site", "new", "run.sh")).mode & 0o777, 0o750);
	assert.equal(readlinkSync(path.join(caller, "site", "new", "latest")), "run.sh");
	assert.equal(readFileSync(path.join(caller, "report.md"), "utf8"), "report\n");
});

test("a target's symlink is followed, an inner target is put last, and an output with no target is refused before anything is put", async () => {
	const caller = write("home5", { "real/kept.md": "kept\n" });
	symlinkSync("real", path.join(caller, "pages"));
	const staged = write("staged5", { a: "from the inner file\n", "pages/a.md": "from the outer file\n" });
	await mergeOutputs({ a: path.join(staged, "a"), pages: path.join(staged, "pages") }, { a: path.join(caller, "pages", "a.md"), pages: path.join(caller, "pages") });
	assert.equal(readlinkSync(path.join(caller, "pages")), "real");
	assert.deepEqual(readdirSync(path.join(caller, "real")).sort(), ["a.md", "kept.md"]);
	assert.equal(readFileSync(path.join(caller, "real", "a.md"), "utf8"), "from the inner file\n");

	await assert.rejects(mergeOutputs({ a: path.join(staged, "a"), pages: path.join(staged, "pages") }, { a: path.join(caller, "b.md") }), /^Error: pages: has no target$/u);
	assert.deepEqual(readdirSync(caller).sort(), ["pages", "real"]);
});

test("what does not fit the run, or breaks the protocol, is a run that failed, and puts nothing", async () => {
	const caller = write("home6", { "site/index.md": "old\n" });
	const targets = { site: path.join(caller, "site"), report: path.join(caller, "report.md") };
	const files: Record<string, CallFile> = { site: { mode: "inout", kind: "dir", base: "site" }, report: { mode: "out", kind: "file", base: "report.md" } };
	const staged = write("staged6", { "site/index.md": "new\n", "report/x": "x\n" });
	symlinkSync("../../outside", path.join(staged, "site", "escape"));

	assert.deepEqual(await deliver({ ok: "yes" }, readContents([]), { files, targets }), { ok: false, text: "", failure: "the report breaks the protocol: `ok` is true or false", outputs: {} });
	const misfit = await deliverFrom({ site: { kind: "file" } }, staged, targets, files);
	assert.deepEqual(misfit.failure?.split("\n"), ["the report does not fit the run:", "  site: is a directory, given back as a file", "  report: the run succeeded, but gave nothing back for it"]);
	const lying = await deliverFrom({ site: { kind: "dir" }, report: { kind: "file" } }, staged, targets, files);
	assert.equal(lying.failure, "the result breaks the protocol: site/escape: leads outside its content");
	assert.deepEqual([lying.ok, lying.outputs], [false, {}]);
	assert.equal(readFileSync(path.join(caller, "site", "index.md"), "utf8"), "old\n");
	assert.deepEqual(readdirSync(caller), ["site"]);
});
