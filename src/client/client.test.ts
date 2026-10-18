import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createDummyAdaptor, type DummyAgent, type DummyRun } from "../adaptors/dummy.js";
import type { Delivery, Job, Report } from "../core/model.js";
import type { WireAdaptor } from "./adaptor.js";
import { createClient } from "./client.js";
import { fileRunStore } from "./store.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tau-client-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

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

/** An agent that edits the site, writes the report and a page, and records what it was given. */
function editor(seen: DummyRun[] = []): DummyAgent {
	return async (run) => {
		seen.push(run);
		const view = (name: string) => run.placed.places[name] as string;
		writeFileSync(path.join(view("site"), "index.md"), "new\n");
		mkdirSync(path.join(view("site"), "new"));
		writeFileSync(path.join(view("site"), "new", "page.md"), "page\n");
		writeFileSync(view("report"), `rules: ${readFileSync(view("rules"), "utf8")}`);
		mkdirSync(view("pages"));
		writeFileSync(path.join(view("pages"), "a.md"), "a\n");
		return { ok: true, text: "Done." };
	};
}

const dummy = (agent: DummyAgent) => createDummyAdaptor({ agent, spool: path.join(tmp, "spool") });

/** An adaptor that records each job, and hands it to `inner`. */
function recording(inner: WireAdaptor, jobs: Job[]): WireAdaptor {
	return { ...inner, submit: (job, signal) => (jobs.push(job), inner.submit(job, signal)) };
}

test("a run goes from the caller's paths, through a wire adaptor, to a backend, and its outputs back to the paths", async () => {
	const caller = home("home1");
	const seen: DummyRun[] = [];
	const jobs: Job[] = [];
	const client = createClient({ adaptors: { dummy: recording(dummy(editor(seen)), jobs) } });
	assert.deepEqual(await client.run(TAU, CALL, { cwd: caller }), { ok: true, text: "Done." });

	// The client hands over the call without the caller's paths, each input with the kind of what is at its path.
	const [job] = jobs as [Job];
	assert.equal(job.tau, TAU);
	assert.deepEqual(job.envelope, {
		files: {
			site: { mode: "inout", base: "site", kind: "dir" },
			rules: { mode: "in", base: "style.md", kind: "file" },
			report: { mode: "out", kind: "file", base: "report.md" },
			pages: { mode: "out", kind: "dir", base: "pages" },
			extras: { mode: "in", base: "extras", kind: "dir" },
		},
		args: { tone: "dry, as ${rules} says," },
	});
	assert.deepEqual(job.inputs, { site: path.join(caller, "site"), rules: path.join(caller, "style.md"), extras: [path.join(caller, "style.md"), path.join(caller, "site/kept.md")] });

	// The backend places each file, and renders the prompt with where it placed them.
	const [{ placed, rendered }] = seen as [DummyRun];
	const at = (name: string) => placed.places[name] as string;
	assert.equal(rendered.prompt, `Edit ${at("site")} by ${at("rules")}, in a dry, as ${at("rules")} says, tone, with ${at("extras")}; report to ${at("report")}, and write ${at("pages")}.\n`);
	assert.deepEqual(rendered.context, { files: placed.places, args: { tone: `dry, as ${at("rules")} says,` } });
	assert.deepEqual(rendered.skills.map(({ name }) => name), ["edit"]);
	assert.equal(path.basename(at("extras")), "extras");

	assert.deepEqual(readdirSync(path.join(caller, "site")).sort(), ["index.md", "kept.md", "new"]);
	assert.equal(readFileSync(path.join(caller, "site", "index.md"), "utf8"), "new\n");
	assert.equal(readFileSync(path.join(caller, "site", "new", "page.md"), "utf8"), "page\n");
	assert.equal(readFileSync(path.join(caller, "out", "report.md"), "utf8"), "rules: rules\n");
	assert.deepEqual(readdirSync(path.join(caller, "out", "pages")), ["a.md"]);
});

test("an `in` given several paths is a directory holding each, and extra files travel with the modes the call gives them", async () => {
	const caller = home("home-extras");
	const call = {
		files: { ...CALL.files, notes: { mode: "in", path: "site/kept.md" }, log: { mode: "out", kind: "file", path: "out/log.md" } },
		args: { tone: "dry", call: { files: { notes: "${notes}" }, args: { start: "$${notes}" } } },
	};
	const seen: DummyRun[] = [];
	const agent: DummyAgent = async (run) => {
		const view = (name: string) => run.placed.places[name] as string;
		assert.deepEqual(readdirSync(view("extras")).sort(), ["kept.md", "style.md"]);
		writeFileSync(view("log"), `read ${readFileSync(view("notes"), "utf8")}`);
		return editor(seen)(run);
	};
	assert.deepEqual(await createClient({ adaptors: { dummy: dummy(agent) } }).run(TAU, call, { cwd: caller }), { ok: true, text: "Done." });
	const [{ placed, rendered }] = seen as [DummyRun];
	assert.deepEqual(Object.keys(placed.envelope.files).slice(5), ["notes", "log"]);
	assert.deepEqual(rendered.args.call, { files: { notes: placed.places.notes }, args: { start: "${notes}" } });
	assert.equal(readFileSync(path.join(caller, "out", "log.md"), "utf8"), "read kept\n");
});

test("a run whose agent did not leave what the call asks fails, and gives back nothing", async () => {
	const caller = home("home2");
	const outcome = await createClient({ adaptors: { dummy: dummy(async () => ({ ok: true, text: "Done." })) } }).run(TAU, CALL, { cwd: caller });
	assert.equal(outcome.ok, false);
	assert.equal(outcome.text, "Done.");
	assert.match(outcome.failure ?? "", /^the run did not leave what the call asks:\n {2}report: \S+\/report\.md does not exist\n {2}pages: /u);
	assert.deepEqual(readdirSync(path.join(caller, "out")), []);
	assert.equal(readFileSync(path.join(caller, "site", "index.md"), "utf8"), "old\n");

	const failing = createClient({ adaptors: { dummy: dummy(async () => { throw new Error("no model"); }) } });
	assert.deepEqual(await failing.run(TAU, CALL, { cwd: caller }), { ok: false, text: "", failure: "the agent failed: no model" });
});

test("the call and the caller's paths are checked before the run goes anywhere", async () => {
	const caller = home("home3");
	const jobs: Job[] = [];
	const client = createClient({ adaptors: { dummy: recording(dummy(editor()), jobs) } });
	const files = (rules: unknown) => ({ ...CALL, files: { ...CALL.files, rules } });
	await assert.rejects(client.start(TAU, files("missing.md"), { cwd: caller }), /^Error: the files do not fit the tau:\n {2}rules: \S+\/missing\.md does not exist$/u);
	await assert.rejects(client.start(TAU, files({ $in: "style.md" }), { cwd: caller }), /rules: \{"\$in":"style\.md"\} is neither a path, a list of paths, nor a file with its mode, \{mode, path, kind\}$/mu);
	await assert.rejects(client.start(TAU, { files: CALL.files }, { cwd: caller }), /args: must have required property 'tone'/u);
	assert.throws(() => client.check(TAU, files("missing.md"), caller), /rules: \S+\/missing\.md does not exist/u);
	assert.equal(client.check(TAU, CALL, caller).call.paths.report, path.join(caller, "out/report.md"));
	assert.equal(jobs.length, 0);
});

test("a backend that refuses a run refuses it to the caller: here, an API it implements at no version that serves", async () => {
	const tau = write("tau-api", {
		"PROMPT.md": "Go.\n",
		"tau.json": JSON.stringify({ apis: { "@acme/notes": "^1.2.0" } }),
	});
	const adaptor = createDummyAdaptor({ spool: path.join(tmp, "spool"), implementations: { find: () => undefined } });
	await assert.rejects(createClient({ adaptors: { dummy: adaptor } }).run(tau, {}), /no implementation serves:\n {2}@acme\/notes@\^1\.2\.0/u);
});

test("a run is finished as often as asked, from any client sharing its run store, each time putting its outputs, until it is released", async () => {
	const caller = home("home-detached");
	const runs = fileRunStore(path.join(tmp, "runs"));
	const run = await createClient({ adaptors: { dummy: dummy(editor()) }, runs }).start(TAU, CALL, { cwd: caller });
	assert.match(run, /^dummy:/u);
	const other = createClient({ adaptors: { dummy: dummy(editor()) }, runs });
	assert.deepEqual(await other.finish(run), { ok: true, text: "Done." });
	assert.equal(readFileSync(path.join(caller, "out", "report.md"), "utf8"), "rules: rules\n");
	writeFileSync(path.join(caller, "out", "report.md"), "changed since\n");
	assert.deepEqual(await other.finish(run), { ok: true, text: "Done." });
	assert.equal(readFileSync(path.join(caller, "out", "report.md"), "utf8"), "rules: rules\n");
	await other.release(run);
	await assert.rejects(other.finish(run), /^Error: no run dummy:/u);
	await assert.rejects(other.release(run), /^Error: no run dummy:/u);
	assert.deepEqual(readdirSync(path.join(tmp, "runs")), []);
});

/** An adaptor in this process whose runs have a new result each time they finish, once `ready` resolves. */
class FollowedAdaptor implements WireAdaptor {
	readonly released: string[] = [];
	readonly deliveries: Delivery[] = [];
	submitted = 0;
	finished = 0;

	constructor(
		private readonly report: (finished: number) => Report = (finished) => ({ ok: true, text: `result ${finished}`, outputs: { report: { kind: "file" }, pages: { kind: "dir" }, site: { kind: "dir" } } }),
		private readonly ready: Promise<void> = Promise.resolve(),
	) {}

	async submit(): Promise<string> {
		return `run-${this.submitted++}`;
	}

	async finish(_id: string, delivery: Delivery, signal?: AbortSignal): Promise<Report> {
		signal?.throwIfAborted();
		await new Promise<void>((resolve, reject) => {
			signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			this.ready.then(resolve);
		});
		this.deliveries.push(delivery);
		return this.report(++this.finished);
	}

	async release(id: string): Promise<void> {
		this.released.push(id);
	}
}

test("finishing again gives the latest result, and waiting is finishing, then releasing", async () => {
	const caller = home("home-follow");
	const adaptor = new FollowedAdaptor();
	const client = createClient({ adaptors: { followed: adaptor } });
	const run = await client.start(TAU, CALL, { cwd: caller });
	assert.equal(run, "followed:run-0");
	assert.deepEqual(await client.finish(run), { ok: true, text: "result 1" });
	assert.deepEqual(await client.finish(run), { ok: true, text: "result 2" });
	assert.deepEqual(adaptor.released, []);
	assert.deepEqual(await client.wait(run), { ok: true, text: "result 3" });
	assert.deepEqual(adaptor.released, ["run-0"]);
	// The adaptor is told where each output goes, and what the run's files are.
	assert.deepEqual(adaptor.deliveries[0], {
		files: {
			site: { mode: "inout", base: "site", kind: "dir" },
			rules: { mode: "in", base: "style.md", kind: "file" },
			report: { mode: "out", kind: "file", base: "report.md" },
			pages: { mode: "out", kind: "dir", base: "pages" },
			extras: { mode: "in", base: "extras", kind: "dir" },
		},
		targets: { site: path.join(caller, "site"), report: path.join(caller, "out/report.md"), pages: path.join(caller, "out/pages") },
	});
});

test("aborting a run releases it, and it fails", async () => {
	const caller = home("home-abort");
	const adaptor = new FollowedAdaptor(undefined, new Promise(() => {}));
	const controller = new AbortController();
	const running = createClient({ adaptors: { held: adaptor } }).run(TAU, CALL, { cwd: caller, signal: controller.signal });
	while (adaptor.submitted === 0) await new Promise((resolve) => setImmediate(resolve));
	controller.abort();
	assert.deepEqual(await running, { ok: false, text: "", failure: "the run was stopped" });
	assert.deepEqual(adaptor.released, ["run-0"]);
});

test("a report from an adaptor that does not fit the run is a run that failed", async () => {
	const adaptor = new FollowedAdaptor(() => ({ ok: true, text: "Done.", outputs: { site: { kind: "file" } } }));
	const outcome = await createClient({ adaptors: { odd: adaptor } }).run(TAU, CALL, { cwd: home("home-odd") });
	assert.deepEqual(outcome.failure?.split("\n"), [
		"the wire adaptor odd broke the protocol: the report does not fit the run:",
		"  site: is a directory, given back as a file",
		"  report: the run succeeded, but gave nothing back for it",
		"  pages: the run succeeded, but gave nothing back for it",
	]);
	assert.equal(outcome.ok, false);
});
