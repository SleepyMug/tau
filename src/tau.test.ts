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
		{ name: "src", type: "dir", role: "share", description: "The files to edit." },
		{ name: "old", type: "text" },
		{ name: "new", type: "text" },
		{ name: "rules", type: "file", role: "in" },
		{ name: "report", type: "file", role: "out" },
	],
	env: ["LANG", "TZ"],
};

const caller = { cwd: "/home/u", env: { LANG: "C.UTF-8", HOME: "/home/u", PATH: "/usr/bin" } };
const ARGV = ["site", "foo", "", "style.md", "out/report.md"];

const replace = () => loadTau(write("replace", { "PROMPT.md": PROMPT, "tau.json": REPLACE }));

test("by default, the agent sees each path where the caller's is", () => {
	const tau = replace();
	assert.equal(tau.description, REPLACE.description);
	assert.deepEqual(tau.args.slice(0, 2), [
		{ name: "src", type: "dir", role: "share", description: "The files to edit." },
		{ name: "old", type: "text", description: undefined },
	]);
	const run = tau.bind(ARGV, caller);
	assert.equal(
		run.prompt,
		`In every file under /home/u/site, replace "foo" with "", following the rules in /home/u/style.md.
Then write each changed file, and how many replacements it got, to /home/u/out/report.md.
`,
	);
	// Only what tau.json lists, and only what the caller has set.
	assert.deepEqual(run.env, { LANG: "C.UTF-8" });
	assert.deepEqual(run.paths, [
		{ name: "src", type: "dir", role: "share", host: "/home/u/site", view: "/home/u/site" },
		{ name: "rules", type: "file", role: "in", host: "/home/u/style.md", view: "/home/u/style.md" },
		{ name: "report", type: "file", role: "out", host: "/home/u/out/report.md", view: "/home/u/out/report.md" },
	]);
});

test("a runtime may place each path elsewhere, and the prompt names it there", () => {
	const run = replace().bind(ARGV, caller, ({ name, role }) => `/${role}/${name}`);
	assert.match(run.prompt, /^In every file under \/share\/src, /);
	assert.match(run.prompt, /the rules in \/in\/rules\.\n.* to \/out\/report\.\n$/);
	assert.deepEqual(
		run.paths.map(({ host, view }) => [host, view]),
		[
			["/home/u/site", "/share/src"],
			["/home/u/style.md", "/in/rules"],
			["/home/u/out/report.md", "/out/report"],
		],
	);
});

test("a tau without tau.json takes no arguments and sees no variables", () => {
	const tau = loadTau(write("plain", { "PROMPT.md": "Say hi. Costs $1, and $${x} stays as it is." }));
	assert.deepEqual([tau.description, tau.args, tau.env], [undefined, [], []]);
	assert.deepEqual(tau.bind([], caller), { prompt: "Say hi. Costs $1, and ${x} stays as it is.", env: {}, paths: [] });
	assert.throws(() => tau.bind(["x"], caller), /expected 0 argument\(s\), got 1/);
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
		["roleless", { args: [{ name: "a", type: "file" }] }, /a: a file needs a `role`, one of in, out, share/],
		["role", { args: [{ name: "a", type: "dir", role: "read" }] }, /a: `role` "read" is not one of in, out, share/],
		["textrole", { args: [{ name: "a", type: "text", role: "in" }] }, /a: a text argument has no `role`/],
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

test("the prompt may name only declared arguments", () => {
	const refused: [string, RegExp][] = [
		["Look at ${missing}.", /PROMPT\.md: line 1: \$\{missing\} is not an argument tau\.json declares/],
		["Hi\n${1:-you}", /line 2: \$\{1:-you\} is not an argument/],
		["Hi ${@:2}", /\$\{@:2\} is not an argument/],
		["Hi ${src", /line 1: \$\{src is not closed/],
	];
	for (const [index, [prompt, reason]] of refused.entries()) {
		const dir = write(`prompts/${index}`, { "PROMPT.md": prompt, "tau.json": { args: [{ name: "src", type: "text" }] } });
		assert.throws(() => loadTau(dir), reason);
	}
	const tau = loadTau(
		write("prompts/ok", { "PROMPT.md": "${a}${a} $${a} $$${a}", "tau.json": { args: [{ name: "a", type: "text" }] } }),
	);
	assert.equal(tau.bind(["x"], caller).prompt, "xx ${a} $${a}");
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

test("argv must fit the arguments, and no path may be or lie inside another", () => {
	const tau = replace();
	assert.throws(() => tau.bind(["site"], caller), /expected 5 argument\(s\) \(src, old, new, rules, report\), got 1/);
	assert.throws(() => tau.bind(["site", "a", "b", "", "r.md"], caller), /rules: a path cannot be empty/);
	assert.throws(
		() => tau.bind(["site", "a", "b", "site/rules.md", "r.md"], caller),
		/rules \(\/home\/u\/site\/rules\.md\) and src \(\/home\/u\/site\) overlap: no path may be, or lie inside, another/,
	);
	assert.throws(() => tau.bind(["/work/x", "a", "b", "s.md", "/work/x"], caller), /report \(\/work\/x\) and src/);
	// Siblings do not overlap, even when one name starts with the other.
	tau.bind(["site", "a", "b", "site.md", "site-report.md"], caller);
});

test("the shapes of inputs and outputs are checked, listing every problem", () => {
	const home = write("home", { "site/index.md": "foo", "style.md": "rules", "out/.keep": "" });
	const tau = replace();
	const bind = (...argv: string[]) => tau.bind(argv, { cwd: home, env: {} });

	const run = bind("site", "foo", "bar", "style.md", "out/report.md");
	checkInputs(run);
	assert.throws(
		() => checkOutputs(run),
		(error: Error) => error.message === `the run did not leave what the tau declares:\n  report: ${home}/out/report.md does not exist`,
	);
	writeFileSync(path.join(home, "out/report.md"), "index.md: 1");
	checkOutputs(run);
	// An output may already be there, when it is of its kind: the run replaces it.
	checkInputs(run);

	assert.throws(
		() => checkInputs(bind("style.md", "foo", "bar", "site", "nowhere/report.md")),
		(error: Error) =>
			error.message ===
			[
				"the arguments do not fit the tau:",
				`  src: ${home}/style.md is not a directory`,
				`  rules: ${home}/site is not a file`,
				`  report: cannot go in ${home}/nowhere, which does not exist`,
			].join("\n"),
	);
	assert.throws(() => checkInputs(bind("missing", "foo", "bar", "style.md", "site/../out")), (error: Error) => {
		assert.match(error.message, /src: \S+\/missing does not exist/);
		assert.match(error.message, /report: \S+\/out is not a file/);
		return true;
	});
	rmSync(path.join(home, "site"), { recursive: true });
	assert.throws(() => checkOutputs(run), /src: \S+\/site does not exist/);
});

test("no path may be, or lie inside, another once symlinks are followed", () => {
	const home = write("home3", { "site/index.md": "foo", "style.md": "rules" });
	symlinkSync("site", path.join(home, "link"));
	symlinkSync("style.md", path.join(home, "rules.md"));
	const tau = replace();
	const bind = (...argv: string[]) => tau.bind(argv, { cwd: home, env: {} });
	// Lexically apart, so `bind` takes them; `checkInputs` follows the symlinks.
	assert.throws(
		() => checkInputs(bind("site", "a", "b", "style.md", "link/report.md")),
		(error: Error) =>
			error.message ===
			`the arguments do not fit the tau:\n  report (${home}/link/report.md) and src (${home}/site) overlap once symlinks are followed: ${home}/site/report.md lies inside ${home}/site`,
	);
	assert.throws(() => checkInputs(bind("site", "a", "b", "rules.md", "style.md")), /report .* and rules .*: both are \S+\/style\.md$/);
	// An `out` that is a symlink is replaced, not followed.
	checkInputs(bind("site", "a", "b", "style.md", "rules.md"));
});

test("a runtime that works elsewhere checks its outputs there with `locate`", () => {
	const stage = write("stage", { "out/report": "done" });
	const home = write("home2", { "site/index.md": "foo", "style.md": "rules", "out/.keep": "" });
	const run = replace().bind(["site", "foo", "bar", "style.md", "out/report.md"], { cwd: home, env: {} }, (p) => `/${p.role}/${p.name}`);
	checkInputs(run);
	const locate = ({ view }: { view: string }) => path.join(stage, view);
	checkOutputs(run, locate);
	// By default, outputs are looked for where the caller has them.
	assert.throws(() => checkOutputs(run), /report: \S+\/home2\/out\/report\.md does not exist/);
	rmSync(path.join(stage, "out/report"));
	mkdirSync(path.join(stage, "out/report"));
	assert.throws(() => checkOutputs(run, locate), /report: \S+\/stage\/out\/report is not a file/);
	// A share path is the caller's own, wherever the agent saw it.
	rmSync(path.join(home, "site"), { recursive: true });
	assert.throws(() => checkOutputs(run, locate), /src: \S+\/home2\/site does not exist/);
});
