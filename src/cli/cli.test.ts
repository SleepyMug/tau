import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createDummyAdaptor } from "../adaptors/dummy.js";
import { type CliContext, main } from "./cli.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tau-cli-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function write(dir: string, files: Record<string, string>): string {
	const root = path.join(tmp, dir);
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		writeFileSync(path.join(root, file), text);
	}
	return root;
}

const home = write("home", {
	"greet/PROMPT.md": "Greet ${name} in ${card}.\n",
	"greet/tau.json": JSON.stringify({
		description: "Write a greeting card.",
		files: { card: { kind: "file", mode: "out", description: "The card." } },
		args: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
	}),
	"call.json": JSON.stringify({ files: { card: "card.txt" }, args: { name: "Ana" } }),
});

/** Runs `argv` in the caller's folder, with the dummy backend, its state under the test directory; gives its exit code and output. */
async function tau(argv: readonly string[], stdin = ""): Promise<{ code: number; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const context: CliContext = {
		cwd: home,
		env: { TAU_STATE_DIR: path.join(tmp, "state") },
		stdin: (async function* () { yield stdin; })(),
		stdout: (text) => void (stdout += text),
		stderr: (text) => void (stderr += text),
	};
	return { code: await main(argv, context), stdout, stderr };
}

test("tau check and tau describe read a tau, and check a call of it, without running it", async () => {
	assert.deepEqual(await tau(["check", "greet"]), { code: 0, stdout: `${home}/greet: a tau\n`, stderr: "" });
	assert.deepEqual(await tau(["check", "greet", "--call", "call.json"]), { code: 0, stdout: `${home}/greet: the call fits the tau\n`, stderr: "" });
	const unfit = await tau(["check", "greet", "--call-json", '{"files": {"card": "card.txt"}}']);
	assert.equal(unfit.code, 1);
	assert.match(unfit.stderr, /^tau: the call does not fit the tau:\n {2}args: must have required property 'name'\n$/u);
	const described = await tau(["describe", "greet"]);
	assert.deepEqual(JSON.parse(described.stdout), {
		dir: `${home}/greet`,
		description: "Write a greeting card.",
		files: { card: { kind: "file", mode: "out", description: "The card." } },
		args: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
		apis: [],
		exposes: [],
		skills: [],
	});
});

test("tau run runs a tau through the dummy adaptor, whose backend echoes the prompt it rendered and leaves what the call asks", async () => {
	const { code, stdout, stderr } = await tau(["run", "greet", "--call", "-"], readFileSync(path.join(home, "call.json"), "utf8"));
	assert.equal(stderr, "");
	assert.equal(code, 0);
	assert.match(stdout, /^Greet Ana in \S+\/card\/card\.txt\.\n$/u);
	assert.equal(readFileSync(path.join(home, "card.txt"), "utf8"), "");
	const json = await tau(["run", "greet", "--call", "call.json", "--json"]);
	assert.equal(JSON.parse(json.stdout).ok, true);
});

test("tau start gives a run's id, which later commands finish, as often as asked, and release; tau wait does both", async () => {
	const started = await tau(["start", "greet", "--call", "call.json"]);
	assert.equal(started.code, 0);
	const run = started.stdout.trim();
	assert.match(run, /^dummy:[0-9a-f-]+$/u);
	assert.equal((await tau(["finish", run])).code, 0);
	assert.equal(JSON.parse((await tau(["finish", run, "--json"])).stdout).ok, true);
	assert.deepEqual(await tau(["release", run]), { code: 0, stdout: "", stderr: "" });
	assert.deepEqual(await tau(["finish", run]), { code: 1, stdout: "", stderr: `tau: no run ${run}\n` });
	const again = (await tau(["start", "greet", "--call", "call.json"])).stdout.trim();
	assert.equal((await tau(["wait", again])).code, 0);
	assert.deepEqual(await tau(["release", again]), { code: 1, stdout: "", stderr: `tau: no run ${again}\n` });
});

test("a wire adaptor is chosen by name, among those the command is given", async () => {
	const unknown = await tau(["run", "greet", "--call", "call.json", "--adaptor", "elsewhere"]);
	assert.equal(unknown.code, 1);
	assert.equal(unknown.stderr, 'tau: no wire adaptor "elsewhere"; there are dummy\n');
	let stdout = "";
	const context: CliContext = {
		cwd: home,
		env: { TAU_STATE_DIR: path.join(tmp, "state"), TAU_ADAPTOR: "quiet" },
		stdin: (async function* () {})(),
		stdout: (text) => void (stdout += text),
		stderr: () => {},
		adaptors: { quiet: createDummyAdaptor({ spool: path.join(tmp, "quiet"), agent: async ({ placed }) => (writeFileSync(placed.places.card as string, "Hi.\n"), { ok: true, text: "" }) }) },
	};
	assert.equal(await main(["run", "greet", "--call", "call.json"], context), 0);
	assert.equal(stdout, "");
	assert.equal(readFileSync(path.join(home, "card.txt"), "utf8"), "Hi.\n");
});

test("a command line that is not one gives the usage", async () => {
	for (const argv of [[], ["run"], ["frobnicate", "x"], ["run", "a", "b"], ["run", "greet", "--nope"]]) {
		const { code, stderr } = await tau(argv);
		assert.equal(code, 2, argv.join(" "));
		assert.match(stderr, /usage: tau check/u);
	}
	assert.match((await tau(["--help"])).stdout, /^usage: tau check/u);
});
