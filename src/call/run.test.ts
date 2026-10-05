import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { type BoundHandle, loadTau } from "../tau/tau.js";
import { type Output, readCall, readResult, writeResult } from "./archive.js";
import { applyResult, checkResult, type Finished, type PackedCall, packCall, packResult, placeCall, type Runtime, runTau } from "./run.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tau-run-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

async function bytesOf(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
	const all: Uint8Array[] = [];
	for await (const chunk of chunks) all.push(chunk);
	return Buffer.concat(all);
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
	yield bytes;
}

/** Writes `files` under `dir`, made fresh in the test directory, and returns its absolute path. */
function write(dir: string, files: Record<string, string>): string {
	const root = path.join(tmp, dir);
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		if (file.endsWith("/")) mkdirSync(path.join(root, file), { recursive: true });
		else writeFileSync(path.join(root, file), text);
	}
	return root;
}

const TAU = write("tau", {
	"PROMPT.md": "Edit ${site} by ${rules}; report to ${report}, and write ${pages}.\n",
	"tau.json": JSON.stringify({
		params: {
			site: { type: "dir", mode: "inout", description: "The site." },
			rules: { type: "file", mode: "in", description: "How." },
			report: { type: "file", mode: "out", description: "What changed." },
			pages: { type: "dir", mode: "out", description: "New pages." },
			args: { type: "record", description: "Anything else." },
		},
	}),
	"skills/edit/SKILL.md": "Edit.\n",
});

/** The caller's folder: a site, its rules, and somewhere for the report and the pages. */
function home(dir: string): string {
	return write(dir, { "site/index.md": "old\n", "site/kept.md": "kept\n", "style.md": "rules\n", "out/": "" });
}

const VALUES = {
	site: { $inout: "site" },
	rules: { $in: "style.md" },
	report: { $out: "out/report.md" },
	pages: { $out: "out/pages" },
	args: { again: { $in: "style.md" }, tone: "dry" },
};

/** Where a runtime that copies places each handle: `<work>/<mode>/<name>`. */
const placer = (work: string) => ({ mode, name }: { mode: string; name: string }) => path.join(work, mode, name);

/** The runtime's side of a run, here: read the call, place it, let `agent` work, and pack how it ended. */
async function runtimeSide(call: Uint8Array, work: string, agent: (handles: readonly BoundHandle[]) => void, outcome = { ok: true, text: "Done." }) {
	const self = path.join(work, "self");
	await placeCall(await readCall(once(call)), { tau: self });
	const { json, blobs } = await readCall(once(call));
	const run = loadTau(self).bind(json.values, { cwd: "/" }, placer(work), self);
	await placeCall({ json, blobs }, { handles: run.handles });
	agent(run.handles);
	return { run, result: await bytesOf(packResult(outcome, run.handles)) };
}

/** What an agent does with VALUES: edits the site, writes the report and a page. */
function edit(handles: readonly BoundHandle[]): void {
	const view = (at: string) => (handles.find((handle) => handle.at === at) as BoundHandle).view;
	writeFileSync(path.join(view("site"), "index.md"), "new\n");
	mkdirSync(path.join(view("site"), "new"));
	writeFileSync(path.join(view("site"), "new", "page.md"), "page\n");
	writeFileSync(view("report"), `rules: ${readFileSync(view("rules"), "utf8")}`);
	mkdirSync(view("pages"));
	writeFileSync(path.join(view("pages"), "a.md"), "a\n");
}

test("a run travels as a call and a result: packed from the caller's paths, placed where the agent works, and put back at them", async () => {
	const caller = home("home1");
	const packed = packCall(TAU, VALUES, { cwd: caller });
	assert.equal(packed.tauDir, TAU);
	assert.deepEqual(packed.targets, {
		"/site": path.join(caller, "site"),
		"/report": path.join(caller, "out/report.md"),
		"/pages": path.join(caller, "out/pages"),
	});
	const call = await bytesOf(packed.archive);
	const { json } = await readCall(once(call));
	// One blob for each path, and the tau's own.
	assert.deepEqual(json, {
		values: {
			site: { $inout: { name: "site", kind: "dir", blob: "b0" } },
			rules: { $in: { name: "style.md", kind: "file", blob: "b1" } },
			report: { $out: { name: "report.md" } },
			pages: { $out: { name: "pages" } },
			args: { again: { $in: { name: "style.md", kind: "file", blob: "b1" } }, tone: "dry" },
		},
		tau: { kind: "dir", blob: "tau" },
	});

	const work = path.join(tmp, "work1");
	const { run, result } = await runtimeSide(call, work, edit);
	assert.equal(run.prompt, `Edit ${work}/inout/site by ${work}/in/style.md; report to ${work}/out/report.md, and write ${work}/out/pages.\n`);
	assert.equal(readFileSync(path.join(work, "self", "skills/edit/SKILL.md"), "utf8"), "Edit.\n");
	// A blob two handles name is given to each.
	assert.equal(readFileSync(path.join(work, "in", "style.md"), "utf8"), "rules\n");
	const read = await readResult(once(result));
	assert.deepEqual(read.json, {
		ok: true,
		text: "Done.",
		outputs: {
			"/site": { $inout: { name: "site", kind: "dir", blob: "o0" } },
			"/report": { $out: { name: "report.md", kind: "file", blob: "o1" } },
			"/pages": { $out: { name: "pages", kind: "dir", blob: "o2" } },
		},
	});
	checkResult(read.json, run.handles);

	assert.deepEqual(await applyResult(once(result), packed.targets), { ok: true, text: "Done." });
	assert.deepEqual(readdirSync(path.join(caller, "site")).sort(), ["index.md", "kept.md", "new"]);
	assert.equal(readFileSync(path.join(caller, "site", "index.md"), "utf8"), "new\n");
	assert.equal(readFileSync(path.join(caller, "site", "new", "page.md"), "utf8"), "page\n");
	assert.equal(readFileSync(path.join(caller, "out", "report.md"), "utf8"), "rules: rules\n");
	assert.deepEqual(readdirSync(path.join(caller, "out", "pages")), ["a.md"]);
});

test("a run whose agent did not leave what the tau declares fails, and gives back nothing", async () => {
	const caller = home("home2");
	const packed = packCall(TAU, VALUES, { cwd: caller });
	const { result } = await runtimeSide(await bytesOf(packed.archive), path.join(tmp, "work2"), () => {});
	const { json } = await readResult(once(result));
	assert.equal(json.ok, false);
	assert.match(json.failure ?? "", /^the run did not leave what the tau declares:\n {2}report: \S+\/out\/report\.md does not exist\n {2}pages: /u);
	assert.deepEqual(json.outputs, {});
	assert.deepEqual(await applyResult(once(result), packed.targets), { ok: false, text: "Done.", failure: json.failure });
	assert.deepEqual(readdirSync(path.join(caller, "out")), []);
	assert.equal(readFileSync(path.join(caller, "site", "index.md"), "utf8"), "old\n");
});

test("the caller's paths are checked when the call is packed, as a runtime would", () => {
	const caller = home("home3");
	assert.throws(() => packCall(TAU, { ...VALUES, rules: { $in: "missing.md" } }, { cwd: caller }), /^Error: the handles do not fit the tau:\n {2}rules: \S+\/missing\.md does not exist$/u);
	assert.throws(() => packCall(TAU, { ...VALUES, rules: "style.md" }, { cwd: caller }), /rules: is a text, where an \$in handle goes/u);
});

/** A result of `outputs`, each from a directory or file of `staged`, by blob id. */
async function resultOf(outputs: Record<string, Output>, staged: string): Promise<Buffer> {
	const ids = new Set(Object.values(outputs).map((output) => ("$out" in output ? output.$out : output.$inout).blob));
	return bytesOf(writeResult({ ok: true, text: "", outputs }, [...ids].map((id) => ({ id, path: path.join(staged, id) }))));
}

test("a directory given back merges into the caller's, entry by entry, and anything else replaces what is there", async () => {
	const caller = write("home4", { "site/kept.md": "kept\n", "site/index.md": "old\n", "site/old/x.md": "x\n", "outside.md": "not the run's\n", "report.md": "an old report\n" });
	symlinkSync("../outside.md", path.join(caller, "site", "link.md"));
	const staged = write("staged4", { "o0/index.md": "new\n", "o0/old": "a file now\n", "o0/link.md": "mine\n", "o0/new/run.sh": "#!/bin/sh\n", o1: "report\n" });
	chmodSync(path.join(staged, "o0/new/run.sh"), 0o750);
	symlinkSync("run.sh", path.join(staged, "o0/new/latest"));
	const result = await resultOf(
		{ "/site": { $inout: { name: "site", kind: "dir", blob: "o0" } }, "/report": { $out: { name: "report.md", kind: "file", blob: "o1" } } },
		staged,
	);
	await applyResult(once(result), { "/site": path.join(caller, "site"), "/report": path.join(caller, "report.md") });
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

test("the caller's own path leads where its symlink does, an inner path is put last, and an output with no target is refused", async () => {
	const caller = write("home5", { "real/kept.md": "kept\n" });
	symlinkSync("real", path.join(caller, "pages"));
	const staged = write("staged5", { o0: "from the inner handle\n", "o1/a.md": "from the outer handle\n" });
	const outputs: Record<string, Output> = {
		"/a": { $out: { name: "a.md", kind: "file", blob: "o0" } },
		"/pages": { $out: { name: "pages", kind: "dir", blob: "o1" } },
	};
	const result = await resultOf(outputs, staged);
	await applyResult(once(result), { "/a": path.join(caller, "pages", "a.md"), "/pages": path.join(caller, "pages") });
	assert.equal(readlinkSync(path.join(caller, "pages")), "real");
	assert.deepEqual(readdirSync(path.join(caller, "real")).sort(), ["a.md", "kept.md"]);
	assert.equal(readFileSync(path.join(caller, "real", "a.md"), "utf8"), "from the inner handle\n");

	await assert.rejects(applyResult(once(result), { "/a": path.join(caller, "b.md") }), /^Error: the result has an output at \/pages, where the caller has no \$out or \$inout handle$/u);
	assert.deepEqual(readdirSync(caller).sort(), ["pages", "real"]);
});

test("a result from a runtime not trusted is checked against the run's handles", () => {
	const handles = [
		{ at: "site", pointer: "/site", mode: "inout", kind: "dir", name: "site" },
		{ at: "rules", pointer: "/rules", mode: "in", kind: "file", name: "style.md" },
		{ at: "report", pointer: "/report", mode: "out", kind: "file", name: "report.md" },
		{ at: "args.out", pointer: "/args/out", mode: "out", kind: "path", name: "x" },
	] as const;
	const named = (name: string, kind: "file" | "dir", blob: string) => ({ name, kind, blob });
	checkResult({ ok: true, text: "", outputs: { "/site": { $inout: named("site", "dir", "o0") }, "/report": { $out: named("report.md", "file", "o1") }, "/args/out": { $out: named("x", "dir", "o2") } } }, handles);
	checkResult({ ok: false, text: "", outputs: {} }, handles);
	assert.throws(
		() =>
			checkResult(
				{
					ok: true,
					text: "",
					outputs: {
						"/site": { $out: named("other", "file", "o0") },
						"/rules": { $inout: named("style.md", "file", "o1") },
						"/elsewhere": { $out: named("x", "file", "o2") },
					},
				},
				handles,
			),
		(error: Error) => {
			assert.deepEqual(error.message.split("\n"), [
				"the result does not fit the run:",
				"  site: is an $inout handle, given back as an $out one",
				"  site: is named site, given back as other",
				"  site: is a directory, given back as a file",
				"  /rules: is no $out or $inout handle of the run",
				"  /elsewhere: is no $out or $inout handle of the run",
				"  report: the run succeeded, but gave nothing back for it",
				"  args.out: the run succeeded, but gave nothing back for it",
			]);
			return true;
		},
	);
});

test("a call's handles bind by their content, whose kind must fit the type, and which the runtime places", async () => {
	const tau = loadTau(TAU);
	const values = (site: object) => ({
		site,
		rules: { $in: { name: "style.md", kind: "file", blob: "b1" } },
		report: { $out: { name: "report.md" } },
		pages: { $out: { name: "pages" } },
		args: {},
	});
	const run = tau.bind(values({ $inout: { name: "site", kind: "dir", blob: "b0" } }), { cwd: "/" }, ({ name }) => `/work/${name}`);
	assert.deepEqual(run.handles[0], { at: "site", pointer: "/site", mode: "inout", kind: "dir", name: "site", blob: "b0", view: "/work/site" });
	assert.deepEqual(run.handles[2], { at: "report", pointer: "/report", mode: "out", kind: "file", name: "report.md", view: "/work/report.md" });
	assert.throws(() => tau.bind(values({ $inout: { name: "site", kind: "file", blob: "b0" } }), { cwd: "/" }, () => "/w"), /site: holds a file, where a directory goes/u);
	assert.throws(() => tau.bind(values({ $inout: { name: "site", kind: "dir" } }), { cwd: "/" }, () => "/w"), /site: .* is not a handle/u);
	assert.throws(() => tau.bind(values({ $inout: { name: "site", kind: "dir", blob: "b0" } }), { cwd: "/" }), /site: a call's handle names no path of the caller's, so the runtime places it/u);
});

/** A runtime in this process, whose runs are `agent`'s, each waiting for `release` before it ends. */
class LocalRuntime implements Runtime {
	readonly runs = new Map<string, { call: PackedCall; ended: Promise<Finished>; cancelled: boolean }>();

	constructor(
		private readonly agent: (handles: readonly BoundHandle[]) => void,
		private readonly release: Promise<void> = Promise.resolve(),
	) {}

	async start(call: PackedCall): Promise<string> {
		const id = `run-${this.runs.size}`;
		const bytes = await bytesOf(call.archive);
		const entry = { call, cancelled: false, ended: Promise.resolve() as unknown as Promise<Finished> };
		entry.ended = this.release.then(async () => {
			const outcome = entry.cancelled ? { ok: false, text: "", failure: "the run was cancelled" } : { ok: true, text: "Done." };
			const { result } = await runtimeSide(bytes, mkdtempSync(path.join(tmp, `${id}-`)), entry.cancelled ? () => {} : this.agent, outcome);
			return { result: once(result), targets: call.targets };
		});
		this.runs.set(id, entry);
		return id;
	}

	finish(id: string): Promise<Finished> {
		return (this.runs.get(id) as { ended: Promise<Finished> }).ended;
	}

	async cancel(id: string): Promise<void> {
		(this.runs.get(id) as { cancelled: boolean }).cancelled = true;
	}
}

test("runTau runs a tau on a runtime, and waits for it; aborting it cancels the run, which fails", async () => {
	const caller = home("home6");
	assert.deepEqual(await runTau(new LocalRuntime(edit), TAU, VALUES, { cwd: caller }), { ok: true, text: "Done." });
	assert.equal(readFileSync(path.join(caller, "out", "report.md"), "utf8"), "rules: rules\n");

	const again = home("home7");
	let release = (): void => {};
	const runtime = new LocalRuntime(edit, new Promise((resolve) => { release = resolve; }));
	const controller = new AbortController();
	const running = runTau(runtime, TAU, VALUES, { cwd: again }, controller.signal);
	while (runtime.runs.size === 0) await new Promise((resolve) => setImmediate(resolve));
	controller.abort();
	release();
	assert.deepEqual(await running, { ok: false, text: "", failure: "the run was cancelled" });
	assert.deepEqual(readdirSync(path.join(again, "out")), []);
});
