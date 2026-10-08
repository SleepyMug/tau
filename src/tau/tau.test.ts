import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { checkInputs, checkOutputs, loadTau, type ResolvedCall } from "../index.js";

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

const cwd = "/home/u";
/** Where a runtime that does not copy has the agent see each file: at its path. */
const atPaths = (call: ResolvedCall) => call.paths as { readonly [name: string]: string };
const CALL = {
	files: { site: "site", rules: "style.md", report: "out/report.md", guides: "/guides/house" },
	args: { edits: [{ old: "colour", new: "color" }], opts: { tone: "dry", style: "the house style, in ${guides}/style.md" } },
};

/** A tau of `tau.json` and `prompt`, written under `dir`. */
const tauOf = (dir: string, json: object, prompt = "Go.") => loadTau(write(dir, { "PROMPT.md": prompt, "tau.json": json }));
const replace = () => tauOf("replace", REPLACE, PROMPT);

test("a call is resolved against the caller's folder, and expanded with where the agent sees each file", () => {
	const tau = replace();
	assert.equal(tau.description, REPLACE.description);
	assert.deepEqual(tau.files, REPLACE.files);
	assert.deepEqual(tau.args, REPLACE.args);
	const resolved = tau.resolve(CALL, cwd);
	assert.deepEqual(resolved, {
		files: {
			site: { mode: "inout", kind: "dir", base: "site" },
			rules: { mode: "in", kind: "file", base: "style.md" },
			report: { mode: "out", kind: "file", base: "report.md" },
			guides: { mode: "in", base: "house" },
		},
		paths: { site: "/home/u/site", rules: "/home/u/style.md", report: "/home/u/out/report.md", guides: "/guides/house" },
		args: CALL.args,
	});
	assert.deepEqual(Object.keys(tau.resolve({ ...CALL, files: { guides: "g", report: "r", rules: "s", site: "t" } }, cwd).files), ["site", "rules", "report", "guides"]);

	// A runtime that does not copy has the agent see each file at its path.
	const run = tau.expand(resolved, atPaths(resolved));
	assert.equal(
		run.prompt,
		`Make the replacements in /home/u/site, following /home/u/style.md and the house style, in /guides/house/style.md, in a dry tone: [{"old":"colour","new":"color"}].
Then write each changed file, and how many replacements it got, to /home/u/out/report.md.
`,
	);
	assert.deepEqual(run.args, { edits: [{ old: "colour", new: "color" }], opts: { tone: "dry", style: "the house style, in /guides/house/style.md" } });
	assert.equal(run.init, undefined);

	// A runtime that copies places each file where it likes.
	const placed = tau.expand(resolved, { site: "/work/1/site", rules: "/work/2/style.md", report: "/work/3/report.md", guides: "/work/4/house" });
	assert.match(placed.prompt, /^Make the replacements in \/work\/1\/site, following \/work\/2\/style\.md and the house style, in \/work\/4\/house\/style\.md,/u);
	assert.equal((placed.args.opts as { style: string }).style, "the house style, in /work/4/house/style.md");
	assert.throws(() => tau.expand(resolved, { site: "/work/site" }), /^TypeError: rules: has no place$/u);
});

test("a call must fit the tau, listing every problem", () => {
	const tau = replace();
	assert.throws(() => tau.resolve({ files: { site: "site", extra: "x", rules: "" }, args: { site: "x", opts: { tone: 1 } }, more: 1 }, cwd), (error: Error) => {
		assert.deepEqual(error.message.split("\n"), [
			"the call does not fit the tau:",
			'  the call has no "more", only "files" and "args"',
			"  args.site: is a file's name, which no arg has",
			"  no path for report, guides",
			"  rules: a path cannot be empty",
			'  extra: is no file the tau declares, so the call gives its mode, as {"mode": "in", "path": "x"}',
			"  args: must have required property 'edits'",
			"  args.opts.tone: must be string",
		]);
		return true;
	});
	const files = { ...CALL.files, site: ["a", "b"], rules: { path: "x" }, report: 7 };
	const args = { edits: [{ old: "a" }, { old: "a", new: "b", why: "c" }, "x"], opts: { tone: "dry" } };
	assert.throws(() => tau.resolve({ files, args }, cwd), (error: Error) => {
		assert.deepEqual(error.message.split("\n"), [
			"the call does not fit the tau:",
			"  site: is given a list of paths, which only an `in` that may be a directory takes",
			'  rules: {"path":"x"} is neither a path, a list of paths, nor a file with its mode, {mode, path, kind}',
			"  report: 7 is not a path",
			"  args.edits.0: must have required property 'new'",
			"  args.edits.1: must NOT have additional properties: why",
			"  args.edits.2: must be object",
		]);
		return true;
	});
	assert.throws(() => tau.resolve([], cwd), /the call must be an object, \{"files": \{\.\.\.\}, "args": \{\.\.\.\}\}/);
	assert.throws(() => tau.resolve({ files: [], args: "x" }, cwd), (error: Error) => {
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
	const resolved = tau.resolve(call, cwd);
	assert.deepEqual(resolved.files, {
		pages: { mode: "in", kind: "dir", base: "pages" },
		book: { mode: "in", kind: "dir", base: "book" },
		cover: { mode: "in", kind: "file", base: "cover.png" },
	});
	assert.deepEqual(resolved.paths, { pages: ["/home/u/a.md", "/b/b.md"], book: [], cover: "/home/u/cover.png" });
	assert.equal(tau.expand(resolved, { pages: "/work/pages", book: "/work/book", cover: "/work/cover.png" }).prompt, "Read /work/pages and /work/book.");
	assert.throws(() => tau.resolve({ files: { ...call.files, pages: ["a/x.md", "b/x.md", "x.md", "c"], cover: ["c.png"] } }, cwd), (error: Error) => {
		assert.deepEqual(error.message.split("\n"), [
			"the call does not fit the tau:",
			"  pages: is given several paths named x.md, which one directory cannot hold",
			"  cover: is given a list of paths, which only an `in` that may be a directory takes",
		]);
		return true;
	});
	assert.throws(() => tau.resolve({ files: { ...call.files, pages: ["a", ""] } }, cwd), /pages: "" is not a path/);
});

test("an arg's placeholders name files, the tau's own directory and args, at any depth, each expanding to its value's expansion, and `$`s before a `{` lose one", () => {
	const tau = tauOf("argsplaceholders", {
		files: { site: { kind: "dir", mode: "inout", description: "The site." } },
		args: { type: "object", properties: { later: { type: "string" } } },
	});
	const args = {
		start: "${site}/index.html",
		nested: [{ deep: "from ${self}/guide.md, after ${start}, not $${site}, $${other}, $$${site}, $${ alone, $1 or $PATH" }, 3, true, null],
		page: { name: "about", path: "${site}/${page.name}.html", copy: "${page.path}" },
		whole: "${page}|${start.x}|${later}",
		"${site}": "keys stay",
	};
	const page = { name: "about", path: "/work/s/about.html", copy: "/work/s/about.html" };
	assert.deepEqual(tau.expand(tau.resolve({ files: { site: "s" }, args }, cwd), { site: "/work/s" }, "/tau").args, {
		start: "/work/s/index.html",
		nested: [{ deep: "from /tau/guide.md, after /work/s/index.html, not ${site}, ${other}, $${site}, ${ alone, $1 or $PATH" }, 3, true, null],
		page,
		whole: `${JSON.stringify(page)}||`,
		"${site}": "keys stay",
	});
	assert.throws(() => tau.resolve({ files: { site: "s" }, args: { self: "x" } }, cwd), /args\.self: names the tau's own directory, which no arg does/);

	const refused = {
		unknown: "${other}",
		open: "${site",
		field: "${site.x}",
		selfx: "${self.x}",
		dots: "${start..x}",
		loop: "${loop}",
		a: { b: "${c}" },
		c: ["${a.b}"],
		o: { x: "${o}" },
	};
	assert.throws(() => tau.resolve({ files: { site: "s" }, args: refused }, cwd), (error: Error) => {
		assert.deepEqual(error.message.split("\n"), [
			"the call does not fit the tau:",
			"  args.unknown: ${other} names neither ${self}, a file, nor an arg; write $${ for a literal ${",
			"  args.open: ${site is not closed; write $${ for a literal ${",
			"  args.field: ${site.x} names what lies in the file site, which is a path",
			"  args.selfx: ${self.x} names what lies in the tau's own directory, which is a path",
			"  args.dots: ${start..x} names nothing between its dots; write $${ for a literal ${",
			"  args.loop: names itself",
			"  args.a.b: names itself, through args.c.0",
			"  args.o.x: names itself",
		]);
		return true;
	});
	const site = { mode: "inout", kind: "dir", base: "s" } as const;
	assert.throws(() => tau.check({ files: { site }, args: { loop: "${loop}" } }), /args\.loop: names itself/);
	assert.throws(() => tau.expand({ files: { site }, args: { loop: "${loop}" } }, { site: "/work/s" }), /^TypeError: the args do not expand:\n {2}args\.loop: names itself$/u);
});

test("a call may give extra files, each with its mode, which the args name, and a declared file with its mode too", () => {
	const tau = tauOf(
		"extras",
		{
			files: { site: { kind: "dir", mode: "inout", description: "The site." } },
			args: { type: "object", properties: { call: { type: "object" } } },
		},
		"Edit ${site}, then make ${call}.",
	);
	const call = {
		files: {
			notes: { mode: "in", path: "notes.md" },
			site: { mode: "inout", path: "s", kind: "dir" },
			drafts: { mode: "in", path: ["a.md", "b.md"] },
			best: { mode: "out", kind: "file", path: "out/best.md" },
		},
		args: { call: { files: { notes: "${notes}", best: "${best}" }, args: { start: "$${notes}", deeper: "$$${notes}" } } },
	};
	const resolved = tau.resolve(call, cwd);
	// Declared files first, in tau.json's order, then extra files, in the call's.
	assert.deepEqual(resolved.files, {
		site: { mode: "inout", kind: "dir", base: "s" },
		notes: { mode: "in", base: "notes.md" },
		drafts: { mode: "in", kind: "dir", base: "drafts" },
		best: { mode: "out", kind: "file", base: "best.md" },
	});
	assert.deepEqual(Object.keys(resolved.files), ["site", "notes", "drafts", "best"]);
	assert.deepEqual(resolved.paths, { site: "/home/u/s", notes: "/home/u/notes.md", drafts: ["/home/u/a.md", "/home/u/b.md"], best: "/home/u/out/best.md" });
	const run = tau.expand(resolved, { site: "/work/s", notes: "/work/notes.md", drafts: "/work/drafts", best: "/work/best.md" });
	const passed = { files: { notes: "/work/notes.md", best: "/work/best.md" }, args: { start: "${notes}", deeper: "$${notes}" } };
	assert.deepEqual(run.args, { call: passed });
	assert.equal(run.prompt, `Edit /work/s, then make ${JSON.stringify(passed)}.`);

	const files = {
		site: { mode: "in", path: "s" },
		x: "x.md",
		y: { path: "y.md" },
		z: { mode: "out", path: ["a", "b"] },
		call: { mode: "in", path: "c" },
		self: { mode: "in", path: "s" },
		"no-name": { mode: "in", path: "n" },
		taken: { mode: "in", path: "t" },
	};
	assert.throws(() => tau.resolve({ files, args: { taken: 1 } }, cwd), (error: Error) => {
		assert.deepEqual(error.message.split("\n"), [
			"the call does not fit the tau:",
			"  call: is an arg's name, which no file has",
			"  self: names the tau's own directory, which no file does",
			"  no-name: is not a file's name, which matches ^[A-Za-z_][A-Za-z0-9_]*$",
			"  taken: is an arg's name, which no file has",
			"  site: is an `in` in the call, and an `inout` in the tau",
			'  x: is no file the tau declares, so the call gives its mode, as {"mode": "in", "path": "x.md"}',
			'  y: {"path":"y.md"} is neither a path, a list of paths, nor a file with its mode, {mode, path, kind}',
			"  z: is given a list of paths, which only an `in` that may be a directory takes",
		]);
		return true;
	});
	assert.throws(() => tau.resolve({ files: { site: { mode: "inout", kind: "file", path: "s" } } }, cwd), /site: holds a file, where a directory goes/);
});

test("a tau without tau.json takes no files and no args", () => {
	const tau = loadTau(write("plain", { "PROMPT.md": "Say hi. Costs $1, and $${x} stays as it is." }));
	assert.deepEqual([tau.description, tau.files, tau.args, tau.apis, tau.exposed, tau.init], [undefined, {}, undefined, [], [], undefined]);
	const empty = { files: {}, paths: {}, args: {} };
	assert.deepEqual(tau.resolve({}, cwd), empty);
	assert.deepEqual(tau.resolve({ files: {}, args: {} }, cwd), empty);
	assert.deepEqual(tau.expand(empty, {}), { prompt: "Say hi. Costs $1, and ${x} stays as it is.", args: {}, init: undefined });
	assert.throws(() => tau.resolve({ args: { x: "1" } }, cwd), /the tau takes no args, but is given x/);
	assert.throws(() => tau.resolve({ files: { x: "1" } }, cwd), /x: is no file the tau declares, so the call gives its mode/);
	assert.throws(() => loadTau(tmp), /not a tau \(no PROMPT\.md\)/);
});

test("a tau's init is the command tau.json gives, its placeholders the tau's own directory and the files, each one word for sh", () => {
	const tau = tauOf("init", {
		files: { notes: { kind: "file", mode: "in", description: "Notes." } },
		init: "node ${self}/init.mts ${notes} $${HOME}",
	});
	assert.equal(tau.init, "node ${self}/init.mts ${notes} $${HOME}");
	const call = tau.resolve({ files: { notes: "my notes.md" } }, cwd);
	assert.equal(tau.expand(call, atPaths(call)).init, `node ${tau.dir}/init.mts '/home/u/my notes.md' \${HOME}`);
	assert.equal(tau.expand(call, { notes: "/tau/in/n.md" }, "/tau/self").init, "node /tau/self/init.mts /tau/in/n.md ${HOME}");
	assert.equal(tau.expand(call, { notes: "/n.md" }, "/my taus/it's").init, `node '/my taus/it'\\''s'/init.mts /n.md \${HOME}`);
	assert.equal(tauOf("noinit", {}).expand({ files: {}, args: {} }, {}).init, undefined);
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
	assert.deepEqual(defs.resolve({ args: { start: "soon" } }, cwd).args, { start: "soon" });
	assert.throws(() => defs.resolve({ args: { start: 1 } }, cwd), /args\.start: must be string/);
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
	// An arg is expanded once: what it expands to, an escaped placeholder included, is not expanded again.
	const prompt = (call: object) => {
		const resolved = tau.resolve(call, cwd);
		return tau.expand(resolved, atPaths(resolved)).prompt;
	};
	const call = { files: { f: "f.md" }, args: { a: "$${a}:${f}", n: 1.5, o: { x: { y: "${n} deep" } }, l: ["a, b", 'say "hi"'], b: false, z: null } };
	assert.equal(prompt(call), '${a}:/home/u/f.md${a}:/home/u/f.md ${a} $${a}|1.5|{"x":{"y":"1.5 deep"}}|1.5 deep||["a, b","say \\"hi\\""]|false|null|');
	// What the args lack is nothing, as an arg the call leaves out.
	assert.equal(prompt({ files: { f: "f.md" } }), " ${a} $${a}||||||||");
});

test("${self} is where the agent sees the tau's own directory: where it is, unless the runtime puts it elsewhere", () => {
	const dir = write("self", {
		"PROMPT.md": "Run ${self}/agents/counter on ${text}; $${self} stays.",
		"tau.json": { files: { text: { kind: "file", mode: "in", description: "The text." } } },
	});
	const tau = loadTau(dir);
	const call = tau.resolve({ files: { text: "a.txt" } }, cwd);
	assert.equal(tau.expand(call, atPaths(call)).prompt, `Run ${dir}/agents/counter on /home/u/a.txt; \${self} stays.`);
	assert.equal(tau.expand(call, { text: "/work/a.txt" }, "/agent").prompt, "Run /agent/agents/counter on /work/a.txt; ${self} stays.");
});

test("a call an archive carries is checked against the tau, as one from a caller not trusted", () => {
	const tau = replace();
	const files = {
		notes: { mode: "in", base: "notes.md", kind: "file" },
		report: { mode: "out", base: "report.md" },
		guides: { mode: "in", base: "house", kind: "dir" },
		site: { mode: "inout", base: "site", kind: "dir" },
		rules: { mode: "in", base: "style.md", kind: "file" },
	} as const;
	const checked = tau.check({ files, args: CALL.args });
	// Declared files first, in tau.json's order, each with the kind it declares, then extra files.
	assert.deepEqual(checked, {
		files: {
			site: { mode: "inout", kind: "dir", base: "site" },
			rules: { mode: "in", kind: "file", base: "style.md" },
			report: { mode: "out", kind: "file", base: "report.md" },
			guides: { mode: "in", kind: "dir", base: "house" },
			notes: { mode: "in", kind: "file", base: "notes.md" },
		},
		args: CALL.args,
	});
	assert.deepEqual(Object.keys(checked.files), ["site", "rules", "report", "guides", "notes"]);
	const wrong = {
		site: { mode: "in", base: "site", kind: "dir" },
		rules: { mode: "in", base: "style.md", kind: "dir" },
		report: { mode: "out", base: "r", kind: "dir" },
		edits: { mode: "in", base: "e", kind: "file" },
	} as const;
	assert.throws(() => tau.check({ files: wrong, args: { edits: 1, opts: { tone: "dry" } } }), (error: Error) => {
		assert.deepEqual(error.message.split("\n"), [
			"the call does not fit the tau:",
			"  edits: is an arg's name, which no file has",
			"  no path for guides",
			"  site: is an `in` in the call, and an `inout` in the tau",
			"  rules: holds a directory, where a file goes",
			"  report: holds a directory, where a file goes",
			"  args.edits: must be array",
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
	const resolve = (...argv: Parameters<typeof callAt>) => tau.resolve(callAt(...argv), home);

	const run = resolve("site", "style.md", "out/report.md");
	checkInputs(run);
	assert.throws(
		() => checkOutputs(run, atPaths(run)),
		(error: Error) => error.message === `the run did not leave what the call asks:\n  report: ${home}/out/report.md does not exist`,
	);
	writeFileSync(path.join(home, "out/report.md"), "index.md: 1");
	checkOutputs(run, atPaths(run));
	// An `out` may be there already, when it is of its kind.
	checkInputs(run);
	// Each path of a list is a file or a directory.
	checkInputs(resolve("site", "style.md", "out/report.md", ["guide/a.md", "site"]));

	assert.throws(
		() => checkInputs(resolve("style.md", "site", "nowhere/report.md", "missing")),
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
	assert.throws(() => checkInputs(resolve("site", "style.md", "out/r.md", ["guide", "gone"])), /guides: \S+\/home\/gone does not exist/);
	assert.throws(() => checkInputs(resolve("site", "style.md", "site/../out")), /report: \S+\/out is not a file/);
	rmSync(path.join(home, "site"), { recursive: true });
	writeFileSync(path.join(home, "site"), "");
	assert.throws(() => checkOutputs(run, atPaths(run)), /site: \S+\/home\/site is not a directory/);
});

test("the caller's paths may overlap, through its symlinks too, but a file's path is never one itself", () => {
	const home = write("home3", { "site/index.md": "foo", "style.md": "rules", "guide/a.md": "a" });
	symlinkSync("site", path.join(home, "link"));
	symlinkSync("style.md", path.join(home, "rules.md"));
	const tau = replace();
	const resolve = (...argv: Parameters<typeof callAt>) => tau.resolve(callAt(...argv), home);
	checkInputs(resolve("site", "site/index.md", "link/report.md", "site"));
	// Where an `out` goes, a symlink is followed, as it is in any path.
	checkInputs(resolve("site", "style.md", "rules.md"));
	assert.throws(() => checkInputs(resolve("site", "style.md", "link")), /report: \S+\/link is not a file/);
	assert.throws(
		() => checkInputs(resolve("link", "rules.md", "r.md", ["guide", "link"])),
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
	const run = () => replace().resolve(callAt("site", "style.md", "r.md"), home);
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

test("a runtime whose agent works on copies checks what it left where it has each place", () => {
	const stage = write("stage", { "work/report": "done", "work/site/index.md": "bar" });
	const home = write("home2", { "site/index.md": "foo", "style.md": "rules", "guide/a.md": "a", "out/.keep": "" });
	const run = replace().resolve(callAt("site", "style.md", "out/report.md"), home);
	checkInputs(run);
	const places = { site: `${stage}/work/site`, rules: `${stage}/work/rules`, report: `${stage}/work/report`, guides: `${stage}/work/guide` };
	checkOutputs(run, places);
	assert.throws(() => checkOutputs(run, { site: `${stage}/work/site` }), /^Error: the run did not leave what the call asks:\n {2}report: has no place$/u);
	rmSync(path.join(stage, "work/report"));
	mkdirSync(path.join(stage, "work/report"));
	symlinkSync("index.md", path.join(stage, "work/site/kept"));
	symlinkSync("../../work", path.join(stage, "work/site/up"));
	assert.throws(() => checkOutputs(run, places), (error: Error) => {
		assert.deepEqual(error.message.split("\n"), [
			"the run did not leave what the call asks:",
			`  site: ${stage}/work/site/up: leads outside ${stage}/work/site, to ${stage}/work`,
			`  report: ${stage}/work/report is not a file`,
		]);
		return true;
	});
	rmSync(path.join(stage, "work/report"), { recursive: true });
	symlinkSync("site/index.md", path.join(stage, "work/report"));
	assert.throws(() => checkOutputs(run, places), /report: \S+\/stage\/work\/report is a symlink, which a file's path cannot be/);
});
