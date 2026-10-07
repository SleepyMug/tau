import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { checkInputs, checkOutputs, loadTau } from "../index.js";

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

const PROMPT = `Make the replacements in \${site}, following \${rules} and \${opts.style}, in a \${opts.tone} tone: \${edits}.
Then write each changed file, and how many replacements it got, to \${report}.
`;

const REPLACE = {
	description: "Replace text in every file of a directory, and report what changed.",
	files: {
		site: { kind: "dir", mode: "inout", description: "The files to edit." },
		rules: { kind: "file", mode: "in", description: "How to edit." },
		report: { kind: "file", mode: "out", description: "What changed." },
		guides: { mode: "in", description: "Guides to follow." },
	},
	args: {
		type: "object",
		properties: {
			edits: {
				type: "array",
				description: "The replacements, made in order.",
				items: {
					type: "object",
					properties: { old: { type: "string", description: "The text to replace." }, new: { type: "string" } },
					required: ["old", "new"],
					additionalProperties: false,
				},
			},
			opts: {
				type: "object",
				description: "How to go about it.",
				properties: { tone: { type: "string" }, style: { type: "string" } },
				required: ["tone"],
			},
		},
		required: ["edits", "opts"],
	},
};

const caller = { cwd: "/home/u" };
const CALL = {
	files: { site: "site", rules: "style.md", report: "out/report.md", guides: "/guides/house" },
	args: { edits: [{ old: "colour", new: "color" }], opts: { tone: "dry", style: "the house style, in ${guides}/style.md" } },
};

/** A tau of `tau.json` and `prompt`, written under `dir`. */
const tauOf = (dir: string, json: object, prompt = "Go.") => loadTau(write(dir, { "PROMPT.md": prompt, "tau.json": json }));
const replace = () => tauOf("replace", REPLACE, PROMPT);

test("a call binds each file at its own path, unless the runtime places it, and the args, expanded", () => {
	const tau = replace();
	assert.equal(tau.description, REPLACE.description);
	assert.deepEqual(tau.files, REPLACE.files);
	assert.deepEqual(tau.args, REPLACE.args);
	const run = tau.bind(CALL, caller);
	assert.equal(
		run.prompt,
		`Make the replacements in /home/u/site, following /home/u/style.md and the house style, in /guides/house/style.md, in a dry tone: [{"old":"colour","new":"color"}].
Then write each changed file, and how many replacements it got, to /home/u/out/report.md.
`,
	);
	assert.deepEqual(run.files, [
		{ name: "site", mode: "inout", kind: "dir", base: "site", host: "/home/u/site", view: "/home/u/site" },
		{ name: "rules", mode: "in", kind: "file", base: "style.md", host: "/home/u/style.md", view: "/home/u/style.md" },
		{ name: "report", mode: "out", kind: "file", base: "report.md", host: "/home/u/out/report.md", view: "/home/u/out/report.md" },
		{ name: "guides", mode: "in", base: "house", host: "/guides/house", view: "/guides/house" },
	]);
	assert.deepEqual(run.args, { edits: [{ old: "colour", new: "color" }], opts: { tone: "dry", style: "the house style, in /guides/house/style.md" } });

	// A runtime that copies places each file where it likes, asked in the order tau.json declares them.
	const asked: string[] = [];
	const placed = tau.bind(CALL, caller, ({ name, base }) => {
		asked.push(name);
		return path.join("/work", String(asked.length), base);
	});
	assert.deepEqual(asked, ["site", "rules", "report", "guides"]);
	assert.match(placed.prompt, /^Make the replacements in \/work\/1\/site, following \/work\/2\/style\.md and the house style, in \/work\/4\/house\/style\.md,/u);
	assert.equal((placed.args.opts as { style: string }).style, "the house style, in /work/4/house/style.md");
	assert.deepEqual(placed.files[2], {
		name: "report",
		mode: "out",
		kind: "file",
		base: "report.md",
		host: "/home/u/out/report.md",
		view: "/work/3/report.md",
	});
});

test("a call must fit the tau, listing every problem", () => {
	const tau = replace();
	assert.throws(() => tau.bind({ files: { site: "site", extra: "x", rules: "" }, args: { site: "x", opts: { tone: 1 } }, more: 1 }, caller), (error: Error) => {
		assert.deepEqual(error.message.split("\n"), [
			"the call does not fit the tau:",
			'  the call has no "more", only "files" and "args"',
			"  no path for report, guides",
			"  the tau has no file named extra",
			"  rules: a path cannot be empty",
			"  args.site: is a file's name, which no arg has",
			"  args: must have required property 'edits'",
			"  args.opts.tone: must be string",
		]);
		return true;
	});
	const files = { ...CALL.files, site: ["a", "b"], rules: { path: "x" }, report: 7 };
	const args = { edits: [{ old: "a" }, { old: "a", new: "b", why: "c" }, "x"], opts: { tone: "dry" } };
	assert.throws(() => tau.bind({ files, args }, caller), (error: Error) => {
		assert.deepEqual(error.message.split("\n"), [
			"the call does not fit the tau:",
			"  site: is given a list of paths, which only an `in` that may be a directory takes",
			'  rules: {"path":"x"} is neither a path, a list of paths, nor an archive\'s file, {mode, base, kind}',
			"  report: 7 is not a path",
			"  args.edits.0: must have required property 'new'",
			"  args.edits.1: must NOT have additional properties: why",
			"  args.edits.2: must be object",
		]);
		return true;
	});
	assert.throws(() => tau.bind([], caller), /the call must be an object, \{"files": \{\.\.\.\}, "args": \{\.\.\.\}\}/);
	assert.throws(() => tau.bind({ files: [], args: "x" }, caller), (error: Error) => {
		assert.match(error.message, /`files` must be an object, from each file's name to its path/);
		assert.match(error.message, /`args` must be an object/);
		return true;
	});
});

test("an `in` given a list of paths is a directory holding each under its base name, which the runtime places", () => {
	const tau = tauOf(
		"list",
		{
			files: {
				pages: { mode: "in", description: "The pages." },
				book: { kind: "dir", mode: "in", description: "The book." },
				cover: { kind: "file", mode: "in", description: "The cover." },
			},
		},
		"Read ${pages} and ${book}.",
	);
	const call = { files: { pages: ["a.md", "/b/b.md"], book: [], cover: "cover.png" } };
	const run = tau.bind(call, caller, ({ base }) => `/work/${base}`);
	assert.equal(run.prompt, "Read /work/pages and /work/book.");
	assert.deepEqual(run.files.slice(0, 2), [
		{ name: "pages", mode: "in", kind: "dir", base: "pages", host: ["/home/u/a.md", "/b/b.md"], view: "/work/pages" },
		{ name: "book", mode: "in", kind: "dir", base: "book", host: [], view: "/work/book" },
	]);
	// Without a runtime that places it, nothing would hold the paths together.
	assert.throws(() => tau.bind(call, caller), /pages: is given several paths, so the runtime places it, as a directory holding each/);
	assert.throws(() => tau.bind({ files: { ...call.files, pages: ["a/x.md", "b/x.md", "x.md", "c"], cover: ["c.png"] } }, caller), (error: Error) => {
		assert.deepEqual(error.message.split("\n"), [
			"the call does not fit the tau:",
			"  pages: is given several paths named x.md, which one directory cannot hold",
			"  cover: is given a list of paths, which only an `in` that may be a directory takes",
		]);
		return true;
	});
	assert.throws(() => tau.bind({ files: { ...call.files, pages: ["a", ""] } }, caller), /pages: "" is not a path/);
});

test("an arg's placeholders name only files and the tau's own directory, at any depth, and the rest stays", () => {
	const tau = tauOf("argsplaceholders", {
		files: { site: { kind: "dir", mode: "inout", description: "The site." } },
		args: { type: "object" },
	});
	const args = {
		start: "${site}/index.html",
		nested: [{ deep: "from ${self}/guide.md, not $${site}, ${other}, $${other}, $1 or ${site" }, 3, true, null],
		"${site}": "keys stay",
	};
	const run = tau.bind({ files: { site: "s" }, args }, caller, () => "/work/s", "/tau");
	assert.deepEqual(run.args, {
		start: "/work/s/index.html",
		nested: [{ deep: "from /tau/guide.md, not ${site}, ${other}, $${other}, $1 or ${site" }, 3, true, null],
		"${site}": "keys stay",
	});
	assert.throws(() => tau.bind({ files: { site: "s" }, args: { self: "x" } }, caller), /args\.self: names the tau's own directory, which no arg does/);
});

test("a tau without tau.json takes no files and no args", () => {
	const tau = loadTau(write("plain", { "PROMPT.md": "Say hi. Costs $1, and $${x} stays as it is." }));
	assert.deepEqual([tau.description, tau.files, tau.args, tau.exposes, tau.init], [undefined, {}, undefined, undefined, undefined]);
	const expected = { prompt: "Say hi. Costs $1, and ${x} stays as it is.", files: [], args: {}, init: undefined };
	assert.deepEqual(tau.bind({}, caller), expected);
	assert.deepEqual(tau.bind({ files: {}, args: {} }, caller), expected);
	assert.throws(() => tau.bind({ args: { x: "1" } }, caller), /the tau takes no args, but is given x/);
	assert.throws(() => tau.bind({ files: { x: "1" } }, caller), /the tau has no file named x/);
	assert.throws(() => loadTau(tmp), /not a tau \(no PROMPT\.md\)/);
});

test("a tau's init is the command tau.json gives, its placeholders the tau's own directory and the files, each one word for sh", () => {
	const tau = tauOf("init", {
		files: { notes: { kind: "file", mode: "in", description: "Notes." } },
		init: "node ${self}/init.mts ${notes} $${HOME}",
	});
	assert.equal(tau.init, "node ${self}/init.mts ${notes} $${HOME}");
	const call = { files: { notes: "my notes.md" } };
	assert.equal(tau.bind(call, caller).init, `node ${tau.dir}/init.mts '/home/u/my notes.md' \${HOME}`);
	assert.equal(tau.bind(call, caller, () => "/tau/in/n.md", "/tau/self").init, "node /tau/self/init.mts /tau/in/n.md ${HOME}");
	assert.equal(tau.bind(call, caller, () => "/n.md", "/my taus/it's").init, `node '/my taus/it'\\''s'/init.mts /n.md \${HOME}`);
	assert.equal(tauOf("noinit", {}).bind({}, caller).init, undefined);
	// It names no arg: a program reads the args through the tau API.
	const refused = (init: string) => () =>
		tauOf("initnames", { args: { type: "object", properties: { term: { type: "string", description: "A term." } } }, init });
	assert.throws(refused("node ${self}/init.mts ${term}"), /tau\.json: `init`: \$\{term\} names neither \$\{self\} nor a file: init reads the args through the tau API/);
	assert.throws(refused("node ${self"), /tau\.json: `init`: \$\{self is not closed/);
});

test("tau.json outside the spec is refused, naming the file and the reason", () => {
	const file = { kind: "file", mode: "in", description: "A file." };
	const object = { type: "object" };
	const refused: [string, unknown, RegExp][] = [
		["syntax", "{", /tau\.json: is not JSON/],
		["array", [], /tau\.json: must be an object/],
		["unknown", { files: {}, shell: "bash" }, /tau\.json: unknown key "shell"/],
		["params", { params: {} }, /tau\.json: unknown key "params"/],
		["description", { description: ["hi"] }, /tau\.json: `description` must be a string/],
		["fileslist", { files: [] }, /`files` must be an object, from each file's name to what it is/],
		["badname", { files: { "2nd": file } }, /`files`: "2nd" is not a file's name, which matches/],
		["self", { files: { self: file } }, /`files`: `self` names the tau's own directory, so a file cannot have that name/],
		["value", { files: { a: "in" } }, /`files`: a must be an object, with its `mode` and `description`/],
		["undescribed", { files: { a: { mode: "in" } } }, /a: needs a `description`, saying what it is/],
		["blank", { files: { a: { ...file, description: " " } } }, /a: needs a `description`/],
		["modeless", { files: { a: { description: "A." } } }, /a: needs a `mode`, one of in, out, inout/],
		["mode", { files: { a: { ...file, mode: "share" } } }, /a: `mode` "share" is not one of in, out, inout/],
		["kind", { files: { a: { ...file, kind: "path" } } }, /a: `kind` "path" is not one of file, dir/],
		["key", { files: { a: { ...file, at: "a" } } }, /a: unknown key "at"/],
		["argstype", { args: { properties: {} } }, /`args` must be a JSON Schema of an object, whose `type` is "object"/],
		["argsarray", { args: { type: "array" } }, /`args` must be a JSON Schema of an object/],
		["argname", { args: { ...object, properties: { "b-c": {} } } }, /`args`: "b-c" is not an arg's name, which matches/],
		["argself", { args: { ...object, properties: { self: {} } } }, /`args`: `self` names the tau's own directory, so an arg cannot have that name/],
		["argfile", { files: { a: file }, args: { ...object, properties: { a: {} } } }, /`args`: a is a file's name, which no arg has/],
		["keyword", { args: { ...object, properties: { a: { type: "string", widget: "box" } } } }, /`args` is not a JSON Schema the spec takes: strict mode: unknown keyword: "widget"/],
		["meta", { args: { ...object, required: "a" } }, /`args` is not a JSON Schema the spec takes: schema is invalid: data\/required must be array/],
		["ref", { args: { ...object, properties: { a: { $ref: "https://example.com/a.json" } } } }, /`args` is not a JSON Schema the spec takes: can't resolve reference https:\/\/example\.com\/a\.json/],
		["exposes", { exposes: "notes-kit" }, /`exposes` must be an array/],
		["exposesname", { exposes: ["notes-kit/sub"] }, /`exposes`: "notes-kit\/sub" is not a package's name/],
		["exposestwice", { exposes: ["@api/notes", "@api/notes"] }, /`exposes` lists @api\/notes twice/],
		["init", { init: ["node", "init.ts"] }, /`init` must be a command, a string that is not blank/],
		["initblank", { init: " " }, /`init` must be a command/],
	];
	for (const [name, json, reason] of refused) {
		const files = { "PROMPT.md": "hi", "tau.json": typeof json === "string" ? json : JSON.stringify(json) };
		assert.throws(() => loadTau(write(`refused/${name}`, files)), reason, name);
		assert.throws(() => loadTau(path.join(tmp, "refused", name)), /refused\/\w+\/tau\.json: /, name);
	}
	// A schema may refer to what it defines, and say what a string is, which is not checked.
	const defs = tauOf("defs", {
		args: { type: "object", $defs: { day: { type: "string", format: "date" } }, properties: { start: { $ref: "#/$defs/day" } } },
	});
	assert.deepEqual(defs.bind({ args: { start: "soon" } }, caller).args, { start: "soon" });
	assert.throws(() => defs.bind({ args: { start: 1 } }, caller), /args\.start: must be string/);
});

test("the prompt names files, args the schema declares, what lies in them, and the tau's own directory", () => {
	const refused: [string, RegExp][] = [
		["Look at ${missing}.", /PROMPT\.md: line 1: \$\{missing\} names neither \$\{self\}, a file, nor an arg the schema declares in its properties/],
		["Hi\n${1:-you}", /line 2: \$\{1:-you\} names neither/],
		["Hi ${site", /line 1: \$\{site is not closed/],
		["${site.x}", /\$\{site\.x\} names what lies in the file site, which is a path/],
		["${self.x}", /\$\{self\.x\} names what lies in the tau's own directory, which is a path/],
		["${opts..tone}", /\$\{opts\.\.tone\} names nothing between its dots/],
		["${opts.}", /\$\{opts\.\} names nothing between its dots/],
	];
	for (const [index, [prompt, reason]] of refused.entries()) {
		assert.throws(() => tauOf(`prompts/${index}`, REPLACE, prompt), reason, prompt);
	}
	const json = {
		files: { f: { mode: "in", description: "A file." } },
		args: {
			type: "object",
			properties: { a: { type: "string" }, n: { type: "number" }, o: { type: "object" }, l: { type: "array" }, b: { type: "boolean" }, z: {} },
		},
	};
	const tau = tauOf("prompts/ok", json, "${a}${a} $${a} $$${a}|${n}|${o}|${o.x.y}|${o.missing}|${l}|${b}|${z}|${o.x.y.z}");
	// An arg is not expanded again: only its own placeholders, for files and `self`, were.
	const call = { files: { f: "f.md" }, args: { a: "${a}:${f}", n: 1.5, o: { x: { y: "deep" } }, l: ["a, b", 'say "hi"'], b: false, z: null } };
	assert.equal(tau.bind(call, caller).prompt, '${a}:/home/u/f.md${a}:/home/u/f.md ${a} $${a}|1.5|{"x":{"y":"deep"}}|deep||["a, b","say \\"hi\\""]|false|null|');
	// What the args lack is nothing, as an arg the call leaves out.
	assert.equal(tau.bind({ files: { f: "f.md" } }, caller).prompt, " ${a} $${a}||||||||");
});

test("${self} is where the agent sees the tau's own directory: where it is, unless the runtime puts it elsewhere", () => {
	const dir = write("self", {
		"PROMPT.md": "Run ${self}/agents/counter on ${text}; $${self} stays.",
		"tau.json": { files: { text: { kind: "file", mode: "in", description: "The text." } } },
	});
	const tau = loadTau(dir);
	assert.equal(tau.bind({ files: { text: "a.txt" } }, caller).prompt, `Run ${dir}/agents/counter on /home/u/a.txt; \${self} stays.`);
	const placed = tau.bind({ files: { text: "a.txt" } }, caller, () => "/work/a.txt", "/agent");
	assert.equal(placed.prompt, "Run /agent/agents/counter on /work/a.txt; ${self} stays.");
});

test("an archive's call names each file's content, whose mode and kind fit the tau, and which the runtime places", () => {
	const tau = replace();
	const files = {
		site: { mode: "inout", base: "site", kind: "dir" },
		rules: { mode: "in", base: "style.md", kind: "file" },
		report: { mode: "out", base: "report.md" },
		guides: { mode: "in", base: "house", kind: "dir" },
	};
	const run = tau.bind({ files, args: CALL.args }, { cwd: "/" }, ({ base }) => `/work/${base}`);
	assert.deepEqual(run.files, [
		{ name: "site", mode: "inout", kind: "dir", base: "site", view: "/work/site" },
		{ name: "rules", mode: "in", kind: "file", base: "style.md", view: "/work/style.md" },
		{ name: "report", mode: "out", kind: "file", base: "report.md", view: "/work/report.md" },
		{ name: "guides", mode: "in", kind: "dir", base: "house", view: "/work/house" },
	]);
	assert.throws(() => tau.bind({ files, args: CALL.args }, { cwd: "/" }), /site: an archive's call names no path of the caller's, so the runtime places it/);
	const wrong = { ...files, site: { mode: "in", base: "site", kind: "dir" }, rules: { mode: "in", base: "style.md", kind: "dir" }, report: { mode: "out", base: "r", kind: "file" } };
	assert.throws(() => tau.bind({ files: wrong, args: CALL.args }, { cwd: "/" }, () => "/x"), (error: Error) => {
		assert.deepEqual(error.message.split("\n"), [
			"the call does not fit the tau:",
			"  site: is an `in` in the call, and an `inout` in the tau",
			"  rules: holds a directory, where a file goes",
			'  report: {"mode":"out","base":"r","kind":"file"} is neither a path, a list of paths, nor an archive\'s file, {mode, base, kind}',
		]);
		return true;
	});
});

test("a symlink in what a runtime reads is relative, and stays in the tau", () => {
	const dir = write("links", {
		"PROMPT.md": "Hi.",
		"api/notes/types.d.ts": "",
		"lib/clock/index.d.ts": "",
		"lib/skill/SKILL.md": "",
		"lib/deep/SKILL.md": "",
		"src/notes/index.ts": "",
	});
	const at = (target: string, file: string) => {
		mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		symlinkSync(target, path.join(dir, file));
	};
	// Fine: relative, and inside.
	at("../lib/skill", "skills/ok");
	at("types.d.ts", "api/notes/alias.d.ts");
	at("../lib/clock", "api/clock");
	// What no runtime reads is the author's.
	at("/usr", "src/notes/node_modules");
	// Refused.
	at("/usr", "skills/absolute");
	at("../../../outside.d.ts", "api/notes/outside.d.ts");
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
			"api/notes/outside.d.ts: leads outside the tau, to " + path.join(tmp, "outside.d.ts"),
			"lib/deep/absolute: leads to the absolute path /usr; a symlink in a tau is relative",
			"skills/absolute: leads to the absolute path /usr; a symlink in a tau is relative",
			"skills/chain: leads through lib/chain to the absolute path /usr; a symlink in a tau is relative",
		]);
		return true;
	});
});

/** A call of REPLACE, for a caller in `home`. */
const callAt = (site: string, rules: string, report: string, guides: string | string[] = "guide") => ({
	files: { site, rules, report, guides },
	args: { edits: [], opts: { tone: "dry" } },
});

test("the files' paths are checked when the run starts, and ends, listing every problem", () => {
	const home = write("home", { "site/index.md": "foo", "style.md": "rules", "guide/a.md": "a", "out/.keep": "" });
	const tau = replace();
	const bind = (...argv: Parameters<typeof callAt>) => tau.bind(callAt(...argv), { cwd: home }, ({ host, base }) => (typeof host === "string" ? host : `/work/${base}`));

	const run = bind("site", "style.md", "out/report.md");
	checkInputs(run);
	assert.throws(
		() => checkOutputs(run),
		(error: Error) => error.message === `the run did not leave what the tau declares:\n  report: ${home}/out/report.md does not exist`,
	);
	writeFileSync(path.join(home, "out/report.md"), "index.md: 1");
	checkOutputs(run);
	// An `out` may be there already, when it is of its kind.
	checkInputs(run);
	// Each path of a list is a file or a directory.
	checkInputs(bind("site", "style.md", "out/report.md", ["guide/a.md", "site"]));

	assert.throws(
		() => checkInputs(bind("style.md", "site", "nowhere/report.md", "missing")),
		(error: Error) =>
			error.message ===
			[
				"the files do not fit the tau:",
				`  site: ${home}/style.md is not a directory`,
				`  rules: ${home}/site is not a file`,
				`  report: cannot go in ${home}/nowhere, which does not exist`,
				`  guides: ${home}/missing does not exist`,
			].join("\n"),
	);
	assert.throws(() => checkInputs(bind("site", "style.md", "out/r.md", ["guide", "gone"])), /guides: \S+\/home\/gone does not exist/);
	assert.throws(() => checkInputs(bind("site", "style.md", "site/../out")), /report: \S+\/out is not a file/);
	rmSync(path.join(home, "site"), { recursive: true });
	writeFileSync(path.join(home, "site"), "");
	assert.throws(() => checkOutputs(run), /site: \S+\/home\/site is not a directory/);
});

test("the caller's paths may overlap, through its symlinks too, but a file's path is never one itself", () => {
	const home = write("home3", { "site/index.md": "foo", "style.md": "rules", "guide/a.md": "a" });
	symlinkSync("site", path.join(home, "link"));
	symlinkSync("style.md", path.join(home, "rules.md"));
	const tau = replace();
	const bind = (...argv: Parameters<typeof callAt>) => tau.bind(callAt(...argv), { cwd: home }, ({ host, base }) => (typeof host === "string" ? host : `/work/${base}`));
	checkInputs(bind("site", "site/index.md", "link/report.md", "site"));
	// Where an `out` goes, a symlink is followed, as it is in any path.
	checkInputs(bind("site", "style.md", "rules.md"));
	assert.throws(() => checkInputs(bind("site", "style.md", "link")), /report: \S+\/link is not a file/);
	assert.throws(
		() => checkInputs(bind("link", "rules.md", "r.md", ["guide", "link"])),
		(error: Error) =>
			error.message ===
			[
				"the files do not fit the tau:",
				`  site: ${home}/link is a symlink, which a file's path cannot be`,
				`  rules: ${home}/rules.md is a symlink, which a file's path cannot be`,
				`  guides: ${home}/link is a symlink, which a file's path cannot be`,
			].join("\n"),
	);
});

test("a symlink in a file's directory is relative, and stays in it", () => {
	const home = write("home4", { "site/index.md": "foo", "site/docs/a.md": "a", "style.md": "rules", "guide/a.md": "a", secret: "s" });
	const site = path.join(home, "site");
	symlinkSync("docs/a.md", path.join(site, "inner"));
	symlinkSync("../docs", path.join(site, "docs/self"));
	symlinkSync("inner", path.join(site, "chain"));
	const run = () => replace().bind(callAt("site", "style.md", "r.md"), { cwd: home });
	checkInputs(run());

	symlinkSync("../secret", path.join(site, "out"));
	symlinkSync(path.join(site, "index.md"), path.join(site, "docs/absolute"));
	symlinkSync("gone", path.join(site, "dangling"));
	symlinkSync("loop", path.join(site, "loop"));
	assert.throws(
		() => checkInputs(run()),
		(error: Error) =>
			error.message ===
			[
				"the files do not fit the tau:",
				`  site: ${site}/dangling: leads to ${site}/gone, which does not exist`,
				`  site: ${site}/docs/absolute: leads to the absolute path ${site}/index.md; a symlink in ${site} is relative`,
				`  site: ${site}/loop: is a loop of symlinks`,
				`  site: ${site}/out: leads outside ${site}, to ${home}/secret`,
			].join("\n"),
	);
});

test("a runtime whose agent works on copies checks what it left where it has them, with `locate`", () => {
	const stage = write("stage", { "work/report": "done", "work/site/index.md": "bar" });
	const home = write("home2", { "site/index.md": "foo", "style.md": "rules", "guide/a.md": "a", "out/.keep": "" });
	const places: Record<string, string> = { site: "/work/site", rules: "/work/rules", report: "/work/report", guides: "/work/guide" };
	const run = replace().bind(callAt("site", "style.md", "out/report.md"), { cwd: home }, ({ name }) => places[name] as string);
	checkInputs(run);
	const locate = ({ view }: { view: string }) => path.join(stage, view);
	checkOutputs(run, locate);
	// By default, they are looked for at their views.
	assert.throws(() => checkOutputs(run), /site: \/work\/site does not exist\n {2}report: \/work\/report does not exist/);
	rmSync(path.join(stage, "work/report"));
	mkdirSync(path.join(stage, "work/report"));
	symlinkSync("index.md", path.join(stage, "work/site/kept"));
	symlinkSync("../../work", path.join(stage, "work/site/up"));
	assert.throws(() => checkOutputs(run, locate), (error: Error) => {
		assert.deepEqual(error.message.split("\n"), [
			"the run did not leave what the tau declares:",
			`  site: ${stage}/work/site/up: leads outside ${stage}/work/site, to ${stage}/work`,
			`  report: ${stage}/work/report is not a file`,
		]);
		return true;
	});
	rmSync(path.join(stage, "work/report"), { recursive: true });
	symlinkSync("site/index.md", path.join(stage, "work/report"));
	assert.throws(() => checkOutputs(run, locate), /report: \S+\/stage\/work\/report is a symlink, which a file's path cannot be/);
});
