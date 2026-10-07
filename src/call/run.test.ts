import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { loadTau } from "../tau/tau.js";
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
	"PROMPT.md": "Edit ${site} by ${rules}, in a ${tone} tone, with ${extras}; report to ${report}, and write ${pages}.\n",
	"tau.json": JSON.stringify({
		files: {
			site: { kind: "dir", mode: "inout", description: "The site." },
			rules: { kind: "file", mode: "in", description: "How." },
			report: { kind: "file", mode: "out", description: "What changed." },
			pages: { kind: "dir", mode: "out", description: "New pages." },
			extras: { mode: "in", description: "Anything else to read." },
		},
		args: { type: "object", properties: { tone: { type: "string", description: "How it reads." } }, required: ["tone"] },
	}),
	"skills/edit/SKILL.md": "Edit.\n",
});

/** The caller's folder: a site, its rules, and somewhere for the report and the pages. */
function home(dir: string): string {
	return write(dir, { "site/index.md": "old\n", "site/kept.md": "kept\n", "style.md": "rules\n", "out/": "" });
}

const CALL = {
	files: { site: "site", rules: "style.md", report: "out/report.md", pages: "out/pages", extras: ["style.md", "site/kept.md"] },
	args: { tone: "dry, as ${rules} says," },
};

/** Where the agent sees each file, by name. */
type Places = { readonly [name: string]: string };

/**
 * The runtime's side of a run, here: read the call, check it, place each file at
 * `<work>/<mode>/<base>`, let `agent` work, and pack how it ended.
 */
async function runtimeSide(call: Uint8Array, work: string, agent: (places: Places) => void, outcome = { ok: true, text: "Done." }) {
	const self = path.join(work, "self");
	await placeCall(await readCall(once(call)), { tau: self });
	const { json, contents } = await readCall(once(call));
	const tau = loadTau(self);
	const checked = tau.check(json);
	const places = Object.fromEntries(Object.entries(checked.files).map(([name, { mode, base }]) => [name, path.join(work, mode, base)]));
	const expanded = tau.expand(checked, places, self);
	await placeCall({ json, contents }, { places });
	agent(places);
	return { run: { ...checked, ...expanded }, result: await bytesOf(packResult(outcome, checked, places)) };
}

/** What an agent does with CALL: edits the site, writes the report and a page. */
function edit(places: Places): void {
	const view = (name: string) => places[name] as string;
	writeFileSync(path.join(view("site"), "index.md"), "new\n");
	mkdirSync(path.join(view("site"), "new"));
	writeFileSync(path.join(view("site"), "new", "page.md"), "page\n");
	writeFileSync(view("report"), `rules: ${readFileSync(view("rules"), "utf8")}`);
	mkdirSync(view("pages"));
	writeFileSync(path.join(view("pages"), "a.md"), "a\n");
}

test("a run travels as a call and a result: packed from the caller's paths, placed where the agent works, and put back at them", async () => {
	const caller = home("home1");
	const packed = packCall(TAU, CALL, caller);
	assert.equal(packed.tauDir, TAU);
	assert.deepEqual(packed.targets, {
		site: path.join(caller, "site"),
		report: path.join(caller, "out/report.md"),
		pages: path.join(caller, "out/pages"),
	});
	const call = await bytesOf(packed.archive);
	const { json } = await readCall(once(call));
	// Each file's content by its name, its args as the caller gave them, and the tau's own.
	assert.deepEqual(json, {
		files: {
			site: { mode: "inout", base: "site", kind: "dir" },
			rules: { mode: "in", base: "style.md", kind: "file" },
			report: { mode: "out", kind: "file", base: "report.md" },
			pages: { mode: "out", kind: "dir", base: "pages" },
			extras: { mode: "in", base: "extras", kind: "dir" },
		},
		args: { tone: "dry, as ${rules} says," },
		tau: true,
	});

	const work = path.join(tmp, "work1");
	const { run, result } = await runtimeSide(call, work, edit);
	assert.equal(
		run.prompt,
		`Edit ${work}/inout/site by ${work}/in/style.md, in a dry, as ${work}/in/style.md says, tone, with ${work}/in/extras; report to ${work}/out/report.md, and write ${work}/out/pages.\n`,
	);
	assert.equal(readFileSync(path.join(work, "self", "skills/edit/SKILL.md"), "utf8"), "Edit.\n");
	// An `in` given several paths is a directory holding each.
	assert.deepEqual(readdirSync(path.join(work, "in", "extras")).sort(), ["kept.md", "style.md"]);
	assert.equal(readFileSync(path.join(work, "in", "extras", "kept.md"), "utf8"), "kept\n");
	const read = await readResult(once(result));
	assert.deepEqual(read.json, { ok: true, text: "Done.", outputs: { site: { kind: "dir" }, report: { kind: "file" }, pages: { kind: "dir" } } });
	checkResult(read.json, run);

	assert.deepEqual(await applyResult(once(result), packed.targets), { ok: true, text: "Done." });
	assert.deepEqual(readdirSync(path.join(caller, "site")).sort(), ["index.md", "kept.md", "new"]);
	assert.equal(readFileSync(path.join(caller, "site", "index.md"), "utf8"), "new\n");
	assert.equal(readFileSync(path.join(caller, "site", "new", "page.md"), "utf8"), "page\n");
	assert.equal(readFileSync(path.join(caller, "out", "report.md"), "utf8"), "rules: rules\n");
	assert.deepEqual(readdirSync(path.join(caller, "out", "pages")), ["a.md"]);
});

test("extra files travel as declared ones do, with the modes the call gives them, and the args name them", async () => {
	const caller = home("home-extras");
	const call = {
		files: { ...CALL.files, notes: { mode: "in", path: "site/kept.md" }, log: { mode: "out", kind: "file", path: "out/log.md" } },
		args: { tone: "dry", call: { files: { notes: "${notes}" }, args: { start: "$${notes}" } } },
	};
	const packed = packCall(TAU, call, caller);
	assert.equal(packed.targets.log, path.join(caller, "out/log.md"));
	const archive = await bytesOf(packed.archive);
	const { json } = await readCall(once(archive));
	assert.deepEqual(Object.entries(json.files).slice(5), [
		["notes", { mode: "in", base: "kept.md", kind: "file" }],
		["log", { mode: "out", kind: "file", base: "log.md" }],
	]);

	const work = path.join(tmp, "work-extras");
	const { run, result } = await runtimeSide(archive, work, (places) => {
		edit(places);
		const view = (name: string) => places[name] as string;
		writeFileSync(view("log"), `read ${readFileSync(view("notes"), "utf8")}`);
	});
	assert.deepEqual(run.args.call, { files: { notes: `${work}/in/kept.md` }, args: { start: "${notes}" } });
	assert.deepEqual(await applyResult(once(result), packed.targets), { ok: true, text: "Done." });
	assert.equal(readFileSync(path.join(caller, "out", "log.md"), "utf8"), "read kept\n");
});

test("a run whose agent did not leave what the call asks fails, and gives back nothing", async () => {
	const caller = home("home2");
	const packed = packCall(TAU, CALL, caller);
	const { result } = await runtimeSide(await bytesOf(packed.archive), path.join(tmp, "work2"), () => {});
	const { json } = await readResult(once(result));
	assert.equal(json.ok, false);
	assert.match(json.failure ?? "", /^the run did not leave what the call asks:\n {2}report: \S+\/out\/report\.md does not exist\n {2}pages: /u);
	assert.deepEqual(json.outputs, {});
	assert.deepEqual(await applyResult(once(result), packed.targets), { ok: false, text: "Done.", failure: json.failure });
	assert.deepEqual(readdirSync(path.join(caller, "out")), []);
	assert.equal(readFileSync(path.join(caller, "site", "index.md"), "utf8"), "old\n");
});

test("the caller's paths are checked when the call is packed, as a runtime would", () => {
	const caller = home("home3");
	const files = (rules: unknown) => ({ ...CALL, files: { ...CALL.files, rules } });
	assert.throws(() => packCall(TAU, files("missing.md"), caller), /^Error: the files do not fit the tau:\n {2}rules: \S+\/missing\.md does not exist$/u);
	assert.throws(() => packCall(TAU, files({ $in: "style.md" }), caller), /rules: \{"\$in":"style\.md"\} is neither a path, a list of paths, nor a file with its mode, \{mode, path, kind\}$/mu);
	assert.throws(() => packCall(TAU, { files: CALL.files }, caller), /args: must have required property 'tone'/u);
});

/** A result of `outputs`, each from a directory or file of `staged`, by its name. */
async function resultOf(outputs: Record<string, Output>, staged: string): Promise<Buffer> {
	return bytesOf(writeResult({ ok: true, text: "", outputs }, Object.keys(outputs).map((name) => ({ file: name, from: path.join(staged, name) }))));
}

test("a directory given back merges into the caller's, entry by entry, and anything else replaces what is there", async () => {
	const caller = write("home4", { "site/kept.md": "kept\n", "site/index.md": "old\n", "site/old/x.md": "x\n", "outside.md": "not the run's\n", "report.md": "an old report\n" });
	symlinkSync("../outside.md", path.join(caller, "site", "link.md"));
	const staged = write("staged4", { "site/index.md": "new\n", "site/old": "a file now\n", "site/link.md": "mine\n", "site/new/run.sh": "#!/bin/sh\n", report: "report\n" });
	chmodSync(path.join(staged, "site/new/run.sh"), 0o750);
	symlinkSync("run.sh", path.join(staged, "site/new/latest"));
	const result = await resultOf({ site: { kind: "dir" }, report: { kind: "file" } }, staged);
	await applyResult(once(result), { site: path.join(caller, "site"), report: path.join(caller, "report.md") });
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
	const staged = write("staged5", { a: "from the inner file\n", "pages/a.md": "from the outer file\n" });
	const result = await resultOf({ a: { kind: "file" }, pages: { kind: "dir" } }, staged);
	await applyResult(once(result), { a: path.join(caller, "pages", "a.md"), pages: path.join(caller, "pages") });
	assert.equal(readlinkSync(path.join(caller, "pages")), "real");
	assert.deepEqual(readdirSync(path.join(caller, "real")).sort(), ["a.md", "kept.md"]);
	assert.equal(readFileSync(path.join(caller, "real", "a.md"), "utf8"), "from the inner file\n");

	await assert.rejects(applyResult(once(result), { a: path.join(caller, "b.md") }), /^Error: the result has an output for pages, which is no `out` or `inout` file of the caller's$/u);
	assert.deepEqual(readdirSync(caller).sort(), ["pages", "real"]);
});

test("a result from a runtime not trusted is checked against the run's files", () => {
	const files = {
		files: {
			site: { mode: "inout", kind: "dir", base: "site" },
			rules: { mode: "in", kind: "file", base: "rules.md" },
			report: { mode: "out", kind: "file", base: "report.md" },
			either: { mode: "out", base: "either" },
		},
	} as const;
	checkResult({ ok: true, text: "", outputs: { site: { kind: "dir" }, report: { kind: "file" }, either: { kind: "dir" } } }, files);
	checkResult({ ok: false, text: "", outputs: {} }, files);
	assert.throws(
		() => checkResult({ ok: true, text: "", outputs: { site: { kind: "file" }, rules: { kind: "file" }, elsewhere: { kind: "file" } } }, files),
		(error: Error) => {
			assert.deepEqual(error.message.split("\n"), [
				"the result does not fit the run:",
				"  site: is a directory, given back as a file",
				"  rules: is no `out` or `inout` file of the run",
				"  elsewhere: is no `out` or `inout` file of the run",
				"  report: the run succeeded, but gave nothing back for it",
				"  either: the run succeeded, but gave nothing back for it",
			]);
			return true;
		},
	);
});

/** A runtime in this process, whose runs are `agent`'s, each waiting for `release` before it ends. */
class LocalRuntime implements Runtime {
	readonly runs = new Map<string, { call: PackedCall; ended: Promise<Finished>; cancelled: boolean }>();

	constructor(
		private readonly agent: (places: Places) => void,
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
	assert.deepEqual(await runTau(new LocalRuntime(edit), TAU, CALL, caller), { ok: true, text: "Done." });
	assert.equal(readFileSync(path.join(caller, "out", "report.md"), "utf8"), "rules: rules\n");

	const again = home("home7");
	let release = (): void => {};
	const runtime = new LocalRuntime(edit, new Promise((resolve) => { release = resolve; }));
	const controller = new AbortController();
	const running = runTau(runtime, TAU, CALL, again, controller.signal);
	while (runtime.runs.size === 0) await new Promise((resolve) => setImmediate(resolve));
	controller.abort();
	release();
	assert.deepEqual(await running, { ok: false, text: "", failure: "the run was cancelled" });
	assert.deepEqual(readdirSync(path.join(again, "out")), []);
});
