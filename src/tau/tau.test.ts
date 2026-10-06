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

const PROMPT = `Make the replacements in \${site}, following \${rules} and \${opts.style}, in a \${opts.tone} tone.
Then write each changed file, and how many replacements it got, to \${report}.
`;

const REPLACE = {
	description: "Replace text in every file of a directory, and report what changed.",
	params: {
		site: { type: "dir", mode: "inout", description: "The files to edit." },
		edits: {
			type: "list",
			description: "The replacements, made in order.",
			of: { type: "record", fields: { old: { type: "text", description: "The text to replace." }, new: { type: "text" } } },
		},
		rules: { type: "file", mode: "in", description: "How to edit." },
		report: { type: "file", mode: "out", description: "What changed." },
		opts: {
			type: "record",
			description: "How to go about it.",
			fields: { tone: { type: "text" }, style: { type: "path", mode: "in" } },
		},
	},
};

const caller = { cwd: "/home/u" };
const VALUES = {
	site: { $inout: "site" },
	edits: [{ old: "colour", new: "color" }],
	rules: { $in: "style.md" },
	report: { $out: "out/report.md" },
	opts: { tone: "dry", style: { $in: "/guides/house" } },
};

/** A tau of `tau.json` and `prompt`, written under `dir`. */
const tauOf = (dir: string, json: object, prompt = "Go.") => loadTau(write(dir, { "PROMPT.md": prompt, "tau.json": json }));
const replace = () => tauOf("replace", REPLACE, PROMPT);

test("a run's values bind by parameter, each handle at its own path unless the runtime places it", () => {
	const tau = replace();
	assert.equal(tau.description, REPLACE.description);
	assert.deepEqual(tau.params, REPLACE.params);
	const run = tau.bind(VALUES, caller);
	assert.equal(
		run.prompt,
		`Make the replacements in /home/u/site, following /home/u/style.md and /guides/house, in a dry tone.
Then write each changed file, and how many replacements it got, to /home/u/out/report.md.
`,
	);
	assert.deepEqual(run.handles, [
		{ at: "site", pointer: "/site", mode: "inout", kind: "dir", name: "site", host: "/home/u/site", view: "/home/u/site" },
		{ at: "rules", pointer: "/rules", mode: "in", kind: "file", name: "style.md", host: "/home/u/style.md", view: "/home/u/style.md" },
		{ at: "report", pointer: "/report", mode: "out", kind: "file", name: "report.md", host: "/home/u/out/report.md", view: "/home/u/out/report.md" },
		{ at: "opts.style", pointer: "/opts/style", mode: "in", kind: "path", name: "house", host: "/guides/house", view: "/guides/house" },
	]);
	assert.deepEqual(run.values, {
		site: { $inout: "/home/u/site" },
		edits: [{ old: "colour", new: "color" }],
		rules: { $in: "/home/u/style.md" },
		report: { $out: "/home/u/out/report.md" },
		opts: { tone: "dry", style: { $in: "/guides/house" } },
	});

	// A runtime that copies places each handle where it likes, asked in the order of the values.
	const asked: string[] = [];
	const placed = tau.bind(VALUES, caller, ({ at, name }) => {
		asked.push(at);
		return path.join("/work", String(asked.length), name);
	});
	assert.deepEqual(asked, ["site", "rules", "report", "opts.style"]);
	assert.match(placed.prompt, /^Make the replacements in \/work\/1\/site, following \/work\/2\/style\.md and \/work\/4\/house,/u);
	assert.deepEqual(placed.values.report, { $out: "/work/3/report.md" });
	assert.deepEqual(placed.handles[2], {
		at: "report",
		pointer: "/report",
		mode: "out",
		kind: "file",
		name: "report.md",
		host: "/home/u/out/report.md",
		view: "/work/3/report.md",
	});
});

test("the values must fit the types, listing every problem", () => {
	const tau = replace();
	assert.throws(() => tau.bind({ site: "site", extra: "x", more: { $in: "y" } }, caller), (error: Error) => {
		assert.deepEqual(error.message.split("\n"), [
			"the values do not fit the tau:",
			"  no value for edits, rules, report, opts",
			"  no parameter is named extra, more",
			"  site: is a text, where an $inout handle goes",
		]);
		return true;
	});
	const values = {
		site: { $in: "site" },
		edits: [{ old: "a" }, { old: "a", new: "b", why: "c" }, "x"],
		rules: { $in: "" },
		report: { $out: "r.md", $in: "r.md" },
		opts: [],
	};
	assert.throws(() => tau.bind(values, caller), (error: Error) => {
		assert.deepEqual(error.message.split("\n"), [
			"the values do not fit the tau:",
			"  site: is an $in handle, where an $inout one goes",
			"  edits[0]: no value for new",
			"  edits[1]: no field is named why",
			"  edits[2]: is a text, where a record goes",
			"  rules: a handle's path cannot be empty",
			'  report: {"$out":"r.md","$in":"r.md"} is not a handle, which is {"$in" | "$out" | "$inout": <path>}',
			"  opts: is a list, where a record goes",
		]);
		return true;
	});
	assert.throws(() => tau.bind([], caller), /the values must be a record, from each parameter's name to its value/);
	assert.throws(() => tau.bind({ ...VALUES, edits: [{ old: 1, new: null }] }, caller), (error: Error) => {
		assert.match(error.message, /edits\[0\]\.old: 1 is not a value: a text, a handle, a list or a record/);
		assert.match(error.message, /edits\[0\]\.new: null is not a value/);
		return true;
	});
});

test("an open record takes any values, each handle with the mode it carries", () => {
	const tau = tauOf("bestof", {
		params: {
			agent: { type: "dir", mode: "in", description: "The tau to run." },
			args: { type: "record", description: "Its values." },
		},
	});
	const args = { brief: { $in: "notes.md" }, deck: { $out: "q3.pptx" }, pages: [{ $in: "a" }, "b"], opts: { site: { $inout: "s" } } };
	const run = tau.bind({ agent: { $in: "deck" }, args }, caller);
	assert.deepEqual(
		run.handles.map(({ at, mode, kind }) => [at, mode, kind]),
		[["agent", "in", "dir"], ["args.brief", "in", "path"], ["args.deck", "out", "path"], ["args.pages[0]", "in", "path"], ["args.opts.site", "inout", "path"]],
	);
	assert.deepEqual(run.values.args, {
		brief: { $in: "/home/u/notes.md" },
		deck: { $out: "/home/u/q3.pptx" },
		pages: [{ $in: "/home/u/a" }, "b"],
		opts: { site: { $inout: "/home/u/s" } },
	});
	assert.throws(() => tau.bind({ agent: { $in: "deck" }, args: { "2nd": "x", a: { $share: "y" }, b: { "my-key": "z" } } }, caller), (error: Error) => {
		assert.deepEqual(error.message.split("\n"), [
			"the values do not fit the tau:",
			'  args: "2nd" is not a name, which matches ^[A-Za-z_][A-Za-z0-9_]*$',
			'  args.a: {"$share":"y"} is not a handle, which is {"$in" | "$out" | "$inout": <path>}',
			'  args.b: "my-key" is not a name, which matches ^[A-Za-z_][A-Za-z0-9_]*$',
		]);
		return true;
	});
});

test("a tau without tau.json takes no parameters", () => {
	const tau = loadTau(write("plain", { "PROMPT.md": "Say hi. Costs $1, and $${x} stays as it is." }));
	assert.deepEqual([tau.description, tau.params, tau.exposes, tau.init], [undefined, {}, undefined, undefined]);
	assert.deepEqual(tau.bind({}, caller), { prompt: "Say hi. Costs $1, and ${x} stays as it is.", values: {}, handles: [], init: undefined });
	assert.throws(() => tau.bind({ x: "1" }, caller), /no parameter is named x/);
	assert.throws(() => loadTau(tmp), /not a tau \(no PROMPT\.md\)/);
});

test("a tau's init is the command tau.json gives, which a run expands with ${self}, as one word for sh", () => {
	const tau = tauOf("init", { init: "node ${self}/init.mts $${HOME}" });
	assert.equal(tau.init, "node ${self}/init.mts $${HOME}");
	assert.equal(tau.bind({}, caller).init, `node ${tau.dir}/init.mts \${HOME}`);
	assert.equal(tau.bind({}, caller, undefined, "/tau/self").init, "node /tau/self/init.mts ${HOME}");
	assert.equal(tau.bind({}, caller, undefined, "/my taus/it's").init, `node '/my taus/it'\\''s'/init.mts \${HOME}`);
	assert.equal(tauOf("noinit", {}).bind({}, caller).init, undefined);
	// It names nothing else: a program reads the values through the tau API.
	const refused = (init: string) => () => tauOf("initnames", { params: { term: { type: "text", description: "A term." } }, init });
	assert.throws(refused("node ${self}/init.mts ${term}"), /tau\.json: `init`: \$\{term\} is not \$\{self\}, the one name init holds/);
	assert.throws(refused("node ${self"), /tau\.json: `init`: \$\{self is not closed/);
});

test("tau.json outside the spec is refused, naming the file and the reason", () => {
	const text = { type: "text", description: "Some text." };
	const fileIn = { type: "file", mode: "in", description: "A file." };
	const refused: [string, unknown, RegExp][] = [
		["syntax", "{", /tau\.json: is not JSON/],
		["array", [], /tau\.json: must be an object/],
		["unknown", { params: {}, shell: "bash" }, /tau\.json: unknown key "shell"/],
		["vars", { vars: {} }, /tau\.json: unknown key "vars"/],
		["description", { description: ["hi"] }, /tau\.json: `description` must be a string/],
		["paramslist", { params: [] }, /`params` must be an object, from each parameter's name to its type/],
		["badname", { params: { "2nd": text } }, /`params`: "2nd" is not a parameter's name/],
		["self", { params: { self: text } }, /`params`: `self` names the tau's own directory, so no parameter has that name/],
		["value", { params: { a: "text" } }, /a must be an object, with its `type`/],
		["undescribed", { params: { a: { type: "text" } } }, /a: needs a `description`, saying what it is/],
		["blank", { params: { a: { type: "text", description: " " } } }, /a: needs a `description`/],
		["untyped", { params: { a: { description: "A." } } }, /a: needs a `type`, one of text, file, dir, path, list, record/],
		["type", { params: { a: { type: "number", description: "A." } } }, /a: `type` "number" is not one of text/],
		["modeless", { params: { a: { type: "file", description: "A." } } }, /a: a file needs a `mode`, one of in, out, inout/],
		["mode", { params: { a: { ...fileIn, mode: "share" } } }, /a: `mode` "share" is not one of in, out, inout/],
		["textmode", { params: { a: { ...text, mode: "in" } } }, /a: a text has no `mode`/],
		["key", { params: { a: { ...fileIn, at: "a" } } }, /a: unknown key "at"/],
		["listof", { params: { a: { type: "list", description: "A." } } }, /a: a list needs `of`, the type of its values/],
		["listitem", { params: { a: { type: "list", description: "A.", of: { type: "dir" } } } }, /a\[\]: a dir needs a `mode`/],
		["listfields", { params: { a: { type: "list", description: "A.", of: text, fields: {} } } }, /a: a list has no `fields`/],
		["fields", { params: { a: { type: "record", description: "A.", fields: [] } } }, /a: `fields` must be an object/],
		["fieldname", { params: { a: { type: "record", description: "A.", fields: { "b-c": text } } } }, /a: "b-c" is not a field's name/],
		["field", { params: { a: { type: "record", description: "A.", fields: { b: { type: "dir", mode: "up" } } } } }, /a\.b: `mode` "up" is not one of/],
		["fielddescription", { params: { a: { type: "record", description: "A.", fields: { b: { type: "text", description: 1 } } } } }, /a\.b: `description` must be a string/],
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
});

test("the prompt names only texts and handles, through closed records, and the tau's own directory", () => {
	const json = {
		params: {
			...REPLACE.params,
			args: { type: "record", description: "Anything." },
		},
	};
	const refused: [string, RegExp][] = [
		["Look at ${missing}.", /PROMPT\.md: line 1: \$\{missing\} is neither \$\{self\} nor a parameter tau\.json declares/],
		["Hi\n${1:-you}", /line 2: \$\{1:-you\} is neither/],
		["Hi ${site", /line 1: \$\{site is not closed/],
		["${edits}", /\$\{edits\} names a list of records, which the prompt cannot hold: name a list of texts or handles, or read it in a program/],
		["${opts}", /\$\{opts\} names a record, which the prompt cannot hold/],
		["${edits.old}", /\$\{edits\.old\} names what lies in edits, a list, which the prompt cannot hold: the agent's programs read it, through the tau API/],
		["${args.x}", /\$\{args\.x\} names what lies in args, a record that is open, which the prompt cannot hold/],
		["${opts.size}", /\$\{opts\.size\} names no field of opts/],
		["${site.x}", /\$\{site\.x\} names what lies in site, an \$inout handle/],
		["${self.x}", /\$\{self\.x\} is neither/],
	];
	for (const [index, [prompt, reason]] of refused.entries()) {
		assert.throws(() => tauOf(`prompts/${index}`, json, prompt), reason, prompt);
	}
	const tau = tauOf("prompts/ok", { params: { a: { type: "text", description: "Some text." } } }, "${a}${a} $${a} $$${a}");
	// A value is not expanded again.
	assert.equal(tau.bind({ a: "x" }, caller).prompt, "xx ${a} $${a}");
	assert.equal(tau.bind({ a: "${self}" }, caller).prompt, "${self}${self} ${a} $${a}");
	// A list of texts or handles is a JSON array, of each one as it would be.
	const lists = tauOf(
		"prompts/lists",
		{
			params: {
				tags: { type: "list", of: { type: "text" }, description: "Tags." },
				pages: { type: "list", of: { type: "file", mode: "in" }, description: "Pages." },
			},
		},
		"Tag ${tags}; read ${pages}.",
	);
	const bound = lists.bind({ tags: ["a, b", 'say "hi"'], pages: [{ $in: "a.md" }, { $in: "/b.md" }] }, caller);
	assert.equal(bound.prompt, 'Tag ["a, b","say \\"hi\\""]; read ["/home/u/a.md","/b.md"].');
});

test("${self} is where the agent sees the tau's own directory: where it is, unless the runtime puts it elsewhere", () => {
	const dir = write("self", {
		"PROMPT.md": "Run ${self}/agents/counter on ${text}; $${self} stays.",
		"tau.json": { params: { text: { type: "file", mode: "in", description: "The text." } } },
	});
	const tau = loadTau(dir);
	assert.equal(tau.bind({ text: { $in: "a.txt" } }, caller).prompt, `Run ${dir}/agents/counter on /home/u/a.txt; \${self} stays.`);
	const placed = tau.bind({ text: { $in: "a.txt" } }, caller, () => "/work/a.txt", "/agent");
	assert.equal(placed.prompt, "Run /agent/agents/counter on /work/a.txt; ${self} stays.");
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

/** The values of REPLACE, with `opts.style` at `style`, for a caller in `home`. */
const valuesAt = (site: string, rules: string, report: string, style = "guide") => ({
	site: { $inout: site },
	edits: [],
	rules: { $in: rules },
	report: { $out: report },
	opts: { tone: "dry", style: { $in: style } },
});

test("the handles' paths are checked when the run starts, and ends, listing every problem", () => {
	const home = write("home", { "site/index.md": "foo", "style.md": "rules", "guide/a.md": "a", "out/.keep": "" });
	const tau = replace();
	const bind = (...argv: Parameters<typeof valuesAt>) => tau.bind(valuesAt(...argv), { cwd: home });

	const run = bind("site", "style.md", "out/report.md");
	checkInputs(run);
	assert.throws(
		() => checkOutputs(run),
		(error: Error) => error.message === `the run did not leave what the tau declares:\n  report: ${home}/out/report.md does not exist`,
	);
	writeFileSync(path.join(home, "out/report.md"), "index.md: 1");
	checkOutputs(run);
	// An $out may be there already, when it is of its kind.
	checkInputs(run);

	assert.throws(
		() => checkInputs(bind("style.md", "site", "nowhere/report.md", "missing")),
		(error: Error) =>
			error.message ===
			[
				"the handles do not fit the tau:",
				`  site: ${home}/style.md is not a directory`,
				`  rules: ${home}/site is not a file`,
				`  report: cannot go in ${home}/nowhere, which does not exist`,
				`  opts.style: ${home}/missing does not exist`,
			].join("\n"),
	);
	assert.throws(() => checkInputs(bind("site", "style.md", "site/../out")), /report: \S+\/out is not a file/);
	rmSync(path.join(home, "site"), { recursive: true });
	writeFileSync(path.join(home, "site"), "");
	assert.throws(() => checkOutputs(run), /site: \S+\/home\/site is not a directory/);
});

test("the caller's paths may overlap, through its symlinks too, but a handle's path is never one itself", () => {
	const home = write("home3", { "site/index.md": "foo", "style.md": "rules", "guide/a.md": "a" });
	symlinkSync("site", path.join(home, "link"));
	symlinkSync("style.md", path.join(home, "rules.md"));
	const tau = replace();
	const bind = (...argv: Parameters<typeof valuesAt>) => tau.bind(valuesAt(...argv), { cwd: home });
	checkInputs(bind("site", "site/index.md", "link/report.md", "site"));
	// Where an $out goes, a symlink is followed, as it is in any path.
	checkInputs(bind("site", "style.md", "rules.md"));
	assert.throws(() => checkInputs(bind("site", "style.md", "link")), /report: \S+\/link is not a file/);
	assert.throws(
		() => checkInputs(bind("link", "rules.md", "r.md")),
		(error: Error) =>
			error.message ===
			[
				"the handles do not fit the tau:",
				`  site: ${home}/link is a symlink, which a handle's path cannot be`,
				`  rules: ${home}/rules.md is a symlink, which a handle's path cannot be`,
			].join("\n"),
	);
});

test("a symlink in a handle's directory is relative, and stays in it", () => {
	const home = write("home4", { "site/index.md": "foo", "site/docs/a.md": "a", "style.md": "rules", "guide/a.md": "a", secret: "s" });
	const site = path.join(home, "site");
	symlinkSync("docs/a.md", path.join(site, "inner"));
	symlinkSync("../docs", path.join(site, "docs/self"));
	symlinkSync("inner", path.join(site, "chain"));
	const run = () => replace().bind(valuesAt("site", "style.md", "r.md"), { cwd: home });
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
				"the handles do not fit the tau:",
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
	const places: Record<string, string> = { site: "/work/site", rules: "/work/rules", report: "/work/report", "opts.style": "/work/guide" };
	const run = replace().bind(valuesAt("site", "style.md", "out/report.md"), { cwd: home }, ({ at }) => places[at] as string);
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
	assert.throws(() => checkOutputs(run, locate), /report: \S+\/stage\/work\/report is a symlink, which a handle's path cannot be/);
});
