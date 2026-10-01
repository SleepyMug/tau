import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { checkInputs, checkOutputs, loadTau } from "./index.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tau-metadata-"));
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

const PROMPT = `In every file under \${src}, replace "\${old}" with "\${new}", following the rules in \${rules}.
Then write each changed file, and how many replacements it got, to \${report}.
`;

const REPLACE = {
	description: "Replace text in every file of a directory, and report what changed.",
	args: [
		{ name: "src", type: "dir", role: "in", at: "site", description: "The files to edit." },
		{ name: "edited", type: "dir", role: "out", at: "site", description: "Where they go, edited." },
		{ name: "old", type: "text" },
		{ name: "new", type: "text" },
		{ name: "rules", type: "file", role: "in", at: "style/rules.md" },
		{ name: "report", type: "file", role: "out" },
	],
	env: ["LANG", "TZ"],
};

const caller = { cwd: "/home/u", env: { LANG: "C.UTF-8", HOME: "/home/u", PATH: "/usr/bin" } };
const ARGV = ["site", "site", "foo", "", "style.md", "out/report.md"];

const replace = () => loadTau(write("replace", { "PROMPT.md": PROMPT, "tau.json": REPLACE }));

test("the agent sees each path at its place in its working directory", () => {
	const tau = replace();
	assert.equal(tau.description, REPLACE.description);
	assert.deepEqual(tau.args.slice(0, 3), [
		{ name: "src", type: "dir", role: "in", at: "site", description: "The files to edit." },
		{ name: "edited", type: "dir", role: "out", at: "site", description: "Where they go, edited." },
		{ name: "old", type: "text", description: undefined },
	]);
	const run = tau.bind(ARGV, caller, "/work");
	assert.equal(
		run.prompt,
		`In every file under /work/site, replace "foo" with "", following the rules in /work/style/rules.md.
Then write each changed file, and how many replacements it got, to /work/report.
`,
	);
	// Only what tau.json lists, and only what the caller has set.
	assert.deepEqual(run.env, { LANG: "C.UTF-8" });
	// A place is its name unless tau.json gives one; an in and an out of one type may share one.
	assert.deepEqual(run.paths, [
		{ name: "src", type: "dir", role: "in", at: "site", host: "/home/u/site", view: "/work/site" },
		{ name: "edited", type: "dir", role: "out", at: "site", host: "/home/u/site", view: "/work/site" },
		{ name: "rules", type: "file", role: "in", at: "style/rules.md", host: "/home/u/style.md", view: "/work/style/rules.md" },
		{ name: "report", type: "file", role: "out", at: "report", host: "/home/u/out/report.md", view: "/work/report" },
	]);
	assert.throws(() => tau.bind(ARGV, caller, "work"), /the working directory must be an absolute path: work/);
});

test("a tau without tau.json takes no arguments and sees no variables", () => {
	const tau = loadTau(write("plain", { "PROMPT.md": "Say hi. Costs $1, and $${x} stays as it is." }));
	assert.deepEqual([tau.description, tau.args, tau.env], [undefined, [], []]);
	assert.deepEqual(tau.bind([], caller, "/work"), { prompt: "Say hi. Costs $1, and ${x} stays as it is.", env: {}, paths: [] });
	assert.throws(() => tau.bind(["x"], caller, "/work"), /expected 0 argument\(s\), got 1/);
	assert.throws(() => loadTau(tmp), /not a tau \(no PROMPT\.md\)/);
});

test("tau.json outside the spec is refused, naming the file and the reason", () => {
	const refused: [string, unknown, RegExp][] = [
		["syntax", "{", /tau\.json: is not JSON/],
		["array", [], /tau\.json: must be an object/],
		["unknown", { args: [], shell: "bash" }, /tau\.json: unknown key "shell"/],
		["description", { description: ["hi"] }, /tau\.json: `description` must be a string/],
		["nameless", { args: [{ type: "text" }] }, /args\[0\] needs a `name`/],
		["badname", { args: [{ name: "2nd", type: "text" }] }, /args\[0\] needs a `name`/],
		["twice", { args: [{ name: "a", type: "text" }, { name: "a", type: "text" }] }, /two arguments are named a/],
		["untyped", { args: [{ name: "a" }] }, /a: needs a `type`, one of text, file, dir/],
		["type", { args: [{ name: "a", type: "path" }] }, /a: `type` "path" is not one of text, file, dir/],
		["roleless", { args: [{ name: "a", type: "file" }] }, /a: a file needs a `role`, one of in, out/],
		["role", { args: [{ name: "a", type: "dir", role: "share" }] }, /a: `role` "share" is not one of in, out/],
		["textrole", { args: [{ name: "a", type: "text", role: "in" }] }, /a: a text argument has no `role`/],
		["textat", { args: [{ name: "a", type: "text", at: "a" }] }, /a: a text argument has no `at`/],
		...["", "/a", "a/", "a//b", "./a", "a/../b", ".."].map((at): [string, unknown, RegExp] => [
			`at${JSON.stringify(at).replace(/\W/gu, "_")}`,
			{ args: [{ name: "a", type: "dir", role: "in", at }] },
			/a: `at` "[^"]*" is not a relative path of names separated by \/, none of them empty, \. or \.\./,
		]),
		["atnumber", { args: [{ name: "a", type: "dir", role: "in", at: 1 }] }, /a: `at` 1 is not a relative path/],
		[
			"bothin",
			{ args: [{ name: "a", type: "dir", role: "in", at: "x" }, { name: "b", type: "dir", role: "in", at: "x" }] },
			/a and b are both at x, where only an in and an out of the same type may be/,
		],
		[
			"bothtypes",
			{ args: [{ name: "a", type: "dir", role: "in", at: "x" }, { name: "b", type: "file", role: "out", at: "x" }] },
			/a and b are both at x, where only an in and an out/,
		],
		[
			"byname",
			{ args: [{ name: "a", type: "file", role: "out" }, { name: "b", type: "file", role: "out", at: "a" }] },
			/a and b are both at a, where/,
		],
		[
			"inside",
			{ args: [{ name: "a", type: "dir", role: "out", at: "x/y" }, { name: "b", type: "dir", role: "in", at: "x" }] },
			/a is at x\/y, inside b's place x/,
		],
		["argdescription", { args: [{ name: "a", type: "text", description: 1 }] }, /a: `description` must be a string/],
		["argkey", { args: [{ name: "a", type: "file", role: "in", readonly: true }] }, /a: unknown key "readonly"/],
		["envname", { env: ["A-B"] }, /`env`: "A-B" is not a variable name/],
		["envtwice", { env: ["A", "A"] }, /`env` lists A twice/],
	];
	for (const [name, json, reason] of refused) {
		const files = { "PROMPT.md": "hi", "tau.json": typeof json === "string" ? json : JSON.stringify(json) };
		assert.throws(() => loadTau(write(`refused/${name}`, files)), reason, name);
		assert.throws(() => loadTau(path.join(tmp, "refused", name)), /refused\/\w+\/tau\.json: /, name);
	}
});

test("the prompt may name only declared arguments, and the tau's own directory", () => {
	const refused: [string, RegExp][] = [
		["Look at ${missing}.", /PROMPT\.md: line 1: \$\{missing\} is neither \$\{self\} nor an argument tau\.json declares/],
		["Hi\n${1:-you}", /line 2: \$\{1:-you\} is neither/],
		["Hi ${@:2}", /\$\{@:2\} is neither/],
		["Hi ${src", /line 1: \$\{src is not closed/],
	];
	for (const [index, [prompt, reason]] of refused.entries()) {
		const dir = write(`prompts/${index}`, { "PROMPT.md": prompt, "tau.json": { args: [{ name: "src", type: "text" }] } });
		assert.throws(() => loadTau(dir), reason);
	}
	const tau = loadTau(
		write("prompts/ok", { "PROMPT.md": "${a}${a} $${a} $$${a}", "tau.json": { args: [{ name: "a", type: "text" }] } }),
	);
	assert.equal(tau.bind(["x"], caller, "/work").prompt, "xx ${a} $${a}");
});

test("${self} is where the agent sees the tau's own directory: where it is, unless the runtime puts it elsewhere", () => {
	const dir = write("self", {
		"PROMPT.md": "Run ${self}/agents/counter on ${text}; $${self} stays.",
		"tau.json": { args: [{ name: "text", type: "file", role: "in" }] },
	});
	const tau = loadTau(dir);
	assert.equal(tau.bind(["a.txt"], caller, "/work").prompt, `Run ${dir}/agents/counter on /work/text; \${self} stays.`);
	const placed = tau.bind(["a.txt"], caller, "/work", "/agent");
	assert.equal(placed.prompt, "Run /agent/agents/counter on /work/text; ${self} stays.");
	// The name is the tau's own, so no argument takes it.
	const refused = write("self-arg", { "PROMPT.md": "${self}", "tau.json": { args: [{ name: "self", type: "text" }] } });
	assert.throws(() => loadTau(refused), /args\[0\]: `self` names the tau's own directory, so no argument has that name/);
});

test("a symlink in what a runtime reads is relative, and stays in the tau", () => {
	const dir = write("links", {
		"PROMPT.md": "Hi.",
		"api/shared/types.d.ts": "",
		"lib/skill/SKILL.md": "",
		"lib/deep/SKILL.md": "",
		"src/notes/index.ts": "",
		"api/node_modules/.pnpm/yaml@2/node_modules/yaml/index.d.ts": "",
	});
	const at = (target: string, file: string) => {
		mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		symlinkSync(target, path.join(dir, file));
	};
	// Fine: relative, and inside.
	at("../lib/skill", "skills/ok");
	at("shared/types.d.ts", "api/types.d.ts");
	at(".pnpm/yaml@2/node_modules/yaml", "api/node_modules/yaml");
	// What no runtime reads is the author's.
	at("/usr", "src/notes/node_modules");
	// Refused.
	at("/usr", "skills/absolute");
	at("../../outside.d.ts", "api/outside.d.ts");
	at("nowhere", "api/dangling");
	at("loop-b", "api/loop-a");
	at("loop-a", "api/loop-b");
	at("../lib/chain", "skills/chain");
	at("/usr", "lib/chain");
	at("../lib/deep", "skills/deep");
	at("/usr", "lib/deep/absolute");
	assert.throws(() => loadTau(dir), (error: Error) => {
		assert.deepEqual(error.message.split("\n").slice(1).map((line) => line.trim()).sort(), [
			"api/dangling: leads to api/nowhere, which does not exist",
			"api/loop-a: is a loop of symlinks",
			"api/loop-b: is a loop of symlinks",
			"api/outside.d.ts: leads outside the tau, to " + path.join(tmp, "outside.d.ts"),
			"lib/deep/absolute: leads to the absolute path /usr; a symlink in a tau is relative",
			"skills/absolute: leads to the absolute path /usr; a symlink in a tau is relative",
			"skills/chain: leads through lib/chain to the absolute path /usr; a symlink in a tau is relative",
		]);
		return true;
	});
});

test("argv must fit the arguments, whose paths may overlap", () => {
	const tau = replace();
	assert.throws(() => tau.bind(["site"], caller, "/work"), /expected 6 argument\(s\) \(src, edited, old, new, rules, report\), got 1/);
	assert.throws(() => tau.bind(["site", "site", "a", "b", "", "r.md"], caller, "/work"), /rules: a path cannot be empty/);
	const run = tau.bind(["site", "done", "a", "b", "site/rules.md", "site"], caller, "/work");
	assert.deepEqual(
		run.paths.map(({ name, host }) => [name, host]),
		[["src", "/home/u/site"], ["edited", "/home/u/done"], ["rules", "/home/u/site/rules.md"], ["report", "/home/u/site"]],
	);
});

test("the shapes of inputs and outputs are checked, listing every problem", () => {
	const home = write("home", { "site/index.md": "foo", "style.md": "rules", "out/.keep": "" });
	const work = write("work", { "site/index.md": "bar" });
	const tau = replace();
	const bind = (...argv: string[]) => tau.bind(argv, { cwd: home, env: {} }, work);

	const run = bind("site", "site", "foo", "bar", "style.md", "out/report.md");
	checkInputs(run);
	// What the agent left at each out's place, which is then put at the caller's path.
	assert.throws(
		() => checkOutputs(run),
		(error: Error) => error.message === `the run did not leave what the tau declares:\n  report: ${work}/report does not exist`,
	);
	writeFileSync(path.join(work, "report"), "index.md: 1");
	checkOutputs(run);
	// An output may already be there, when it is of its kind: the run replaces it.
	writeFileSync(path.join(home, "out/report.md"), "index.md: 1");
	checkInputs(run);

	assert.throws(
		() => checkInputs(bind("style.md", "style.md", "foo", "bar", "site", "nowhere/report.md")),
		(error: Error) =>
			error.message ===
			[
				"the arguments do not fit the tau:",
				`  src: ${home}/style.md is not a directory`,
				`  edited: ${home}/style.md is not a directory`,
				`  rules: ${home}/site is not a file`,
				`  report: cannot go in ${home}/nowhere, which does not exist`,
			].join("\n"),
	);
	assert.throws(() => checkInputs(bind("missing", "site", "foo", "bar", "style.md", "site/../out")), (error: Error) => {
		assert.match(error.message, /src: \S+\/missing does not exist/);
		assert.match(error.message, /report: \S+\/out is not a file/);
		return true;
	});
	rmSync(path.join(work, "site"), { recursive: true });
	writeFileSync(path.join(work, "site"), "");
	assert.throws(() => checkOutputs(run), /edited: \S+\/work\/site is not a directory/);
});

test("paths may overlap, through symlinks too", () => {
	const home = write("home3", { "site/index.md": "foo", "style.md": "rules" });
	symlinkSync("site", path.join(home, "link"));
	symlinkSync("style.md", path.join(home, "rules.md"));
	const tau = replace();
	const bind = (...argv: string[]) => tau.bind(argv, { cwd: home, env: {} }, "/work");
	// A report written into the files the agent edits, and a file read and written.
	checkInputs(bind("site", "site", "a", "b", "style.md", "link/report.md"));
	checkInputs(bind("site", "link", "a", "b", "rules.md", "style.md"));
	// An `out` that is a symlink is followed, as every path is.
	checkInputs(bind("site", "site", "a", "b", "style.md", "rules.md"));
	assert.throws(() => checkInputs(bind("site", "site", "a", "b", "style.md", "link")), /report: \S+\/link is not a file/);
});

test("a runtime whose agent works elsewhere checks its outputs where it has them, with `locate`", () => {
	const stage = write("stage", { "work/report": "done", "work/site/index.md": "bar" });
	const home = write("home2", { "site/index.md": "foo", "style.md": "rules", "out/.keep": "" });
	const run = replace().bind(["site", "site", "foo", "bar", "style.md", "out/report.md"], { cwd: home, env: {} }, "/work");
	checkInputs(run);
	const locate = ({ view }: { view: string }) => path.join(stage, view);
	checkOutputs(run, locate);
	// By default, outputs are looked for at their views.
	assert.throws(() => checkOutputs(run), /edited: \/work\/site does not exist\n {2}report: \/work\/report does not exist/);
	rmSync(path.join(stage, "work/report"));
	mkdirSync(path.join(stage, "work/report"));
	assert.throws(() => checkOutputs(run, locate), /report: \S+\/stage\/work\/report is not a file/);
});
