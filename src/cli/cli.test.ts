import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createDummyAdaptor } from "../adaptors/dummy.js";
import { createServer } from "node:http2";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { FakeBackend } from "../rpc/fake-backend.test.util.js";
import { runsRoutes } from "../rpc/index.js";
import { type CliContext, main } from "./cli.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tau-cli-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** `backend` served on the socket `socket`, below `prefix`, closed after the tests. */
async function serve(backend: FakeBackend, socket: string, prefix = ""): Promise<void> {
	const server = createServer(connectNodeAdapter({ routes: runsRoutes(() => backend), ...(prefix === "" ? {} : { requestPathPrefix: prefix }) }));
	await new Promise<void>((resolve) => server.listen(socket, resolve));
	after(() => new Promise<void>((resolve) => server.close(() => resolve())));
}

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
		env: { TAU_STATE_DIR: path.join(tmp, "state"), TAU_CONFIG: path.join(tmp, "no-config.yaml") },
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

test("tau status, result and trace look into a run without waiting for it; --trace writes its trace as run and wait finish it", async () => {
	const run = (await tau(["start", "greet", "--call", "call.json"])).stdout.trim();
	assert.deepEqual(await tau(["status", run]), { code: 0, stdout: "ended: result 1 succeeded\n", stderr: "" });
	assert.deepEqual(JSON.parse((await tau(["status", run, "--json"])).stdout), { state: "ended", result: 1, ok: true });
	const result = await tau(["result", run, "--json"]);
	assert.equal(result.code, 0);
	assert.deepEqual({ ...JSON.parse(result.stdout), text: "" }, { result: 1, ok: true, text: "" });
	const traced = await tau(["trace", run]);
	assert.equal(traced.code, 0);
	const lines = traced.stdout.trimEnd().split("\n").map((line) => JSON.parse(line) as { type?: string });
	assert.deepEqual(lines[0], { format: "tau-dummy" });
	assert.deepEqual(
		lines.slice(1).map((event) => event.type),
		["admitted", "rendered", "ended"],
	);
	assert.equal((await tau(["wait", run, "--trace", "traces/wait.jsonl"])).code, 0);
	assert.equal(readFileSync(path.join(home, "traces", "wait.jsonl"), "utf8"), traced.stdout);
	assert.deepEqual(await tau(["status", run]), { code: 1, stdout: "", stderr: `tau: no run ${run}\n` });
	assert.equal((await tau(["run", "greet", "--call", "call.json", "--trace", "traces/run.jsonl"])).code, 0);
	assert.match(readFileSync(path.join(home, "traces", "run.jsonl"), "utf8"), /^\{"format":"tau-dummy"\}\n\{"type":"admitted",/u);
});

test("a wire adaptor is chosen by name, among those the command is given", async () => {
	const unknown = await tau(["run", "greet", "--call", "call.json", "--adaptor", "elsewhere"]);
	assert.equal(unknown.code, 1);
	assert.equal(unknown.stderr, 'tau: no wire adaptor "elsewhere"; there are dummy, rpc\n');
	let stdout = "";
	const context: CliContext = {
		cwd: home,
		env: { TAU_STATE_DIR: path.join(tmp, "state"), TAU_CONFIG: path.join(tmp, "no-config.yaml"), TAU_ADAPTOR: "quiet" },
		stdin: (async function* () {})(),
		stdout: (text) => void (stdout += text),
		stderr: () => {},
		adaptors: { quiet: createDummyAdaptor({ spool: path.join(tmp, "quiet"), agent: async ({ placed }) => (writeFileSync(placed.places.card as string, "Hi.\n"), { ok: true, text: "" }) }) },
	};
	assert.equal(await main(["run", "greet", "--call", "call.json"], context), 0);
	assert.equal(stdout, "");
	assert.equal(readFileSync(path.join(home, "card.txt"), "utf8"), "Hi.\n");
});

test("tau run --adaptor rpc runs on the backend at $TAU_RPC_SOCKET, below $TAU_RPC_PATH, telling it the working directory", async () => {
	const backend = new FakeBackend(async (placed) => (writeFileSync(placed.places.card as string, "From the backend.\n"), { ok: true, text: "Sent." }));
	const socket = path.join(tmp, "backend.sock");
	await serve(backend, socket, "/services/tau");
	let stdout = "";
	const context: CliContext = {
		cwd: home,
		env: { TAU_STATE_DIR: path.join(tmp, "state"), TAU_CONFIG: path.join(tmp, "no-config.yaml"), TAU_RPC_SOCKET: socket, TAU_RPC_PATH: "/services/tau" },
		stdin: (async function* () {})(),
		stdout: (text) => void (stdout += text),
		stderr: () => {},
	};
	assert.equal(await main(["run", "greet", "--call", "call.json", "--adaptor", "rpc"], context), 0);
	assert.equal(stdout, "Sent.\n");
	assert.equal(readFileSync(path.join(home, "card.txt"), "utf8"), "From the backend.\n");
	assert.deepEqual(backend.submitted, [{ title: "greet", project: home }]);
	assert.equal(backend.released.length, 1);
	let stderr = "";
	assert.equal(await main(["run", "greet", "--call", "call.json", "--adaptor", "rpc"], { ...context, env: { ...context.env, TAU_RPC_SOCKET: undefined }, stderr: (text) => void (stderr += text) }), 1);
	assert.equal(stderr, "tau: the rpc adaptor has no backend: set $TAU_RPC_SOCKET, or adaptors.rpc.socket in the config\n");
});

test("the config file chooses the adaptor, and the backend's socket, a path relative to its folder, and its calls' path; the command line and the environment come first", async () => {
	const backend = new FakeBackend(async (placed) => (writeFileSync(placed.places.card as string, "Configured.\n"), { ok: true, text: "Sent." }));
	const configDir = write("config", { "config.yaml": "# Runs go to the backend.\nadaptor: rpc\nadaptors:\n  rpc:\n    socket: sockets/tau.sock\n    path: /services/tau\n" });
	mkdirSync(path.join(configDir, "sockets"));
	await serve(backend, path.join(configDir, "sockets", "tau.sock"), "/services/tau");
	const run = async (env: CliContext["env"], argv: readonly string[] = []): Promise<number> =>
		main(["run", "greet", "--call", "call.json", ...argv], {
			cwd: home,
			env: { TAU_STATE_DIR: path.join(tmp, "state"), TAU_CONFIG: path.join(configDir, "config.yaml"), ...env },
			stdin: (async function* () {})(),
			stdout: () => {},
			stderr: () => {},
		});
	assert.equal(await run({}), 0);
	assert.equal(readFileSync(path.join(home, "card.txt"), "utf8"), "Configured.\n");
	assert.equal(backend.submitted.length, 1);
	// --adaptor, and $TAU_ADAPTOR, before the config's adaptor.
	assert.equal(await run({}, ["--adaptor", "dummy"]), 0);
	assert.equal(await run({ TAU_ADAPTOR: "dummy" }), 0);
	assert.equal(backend.submitted.length, 1);
	// $TAU_RPC_SOCKET before the config's socket.
	assert.equal(await run({ TAU_RPC_SOCKET: path.join(tmp, "nothing.sock") }), 1);
	assert.equal(backend.submitted.length, 1);
});

test("a config file that is not one fails the command, saying where and why", async () => {
	const cases: [string, RegExp][] = [
		["adaptor: rpc\npath: x\n", /config\.yaml: it has no "path"; it has adaptor, adaptors\n$/u],
		["adaptors:\n  dummy: {}\n", /config\.yaml: adaptors has no "dummy"; it has rpc\n$/u],
		["adaptors:\n  rpc: { socket: 3 }\n", /config\.yaml: adaptors\.rpc\.socket is not a path\n$/u],
		["adaptors:\n  rpc: { socket: s.sock, path: services/tau }\n", /config\.yaml: adaptors\.rpc\.path is not a path from the root, such as \/services\/tau\n$/u],
		["adaptor: [rpc]\n", /config\.yaml: adaptor is not a name\n$/u],
		["- rpc\n", /config\.yaml: it is not a mapping\n$/u],
		["adaptor: : :\n", /config\.yaml: /u],
	];
	for (const [text, expected] of cases) {
		const dir = write("broken", { "config.yaml": text });
		let stderr = "";
		const code = await main(["check", "greet"], {
			cwd: home,
			env: { TAU_STATE_DIR: path.join(tmp, "state"), TAU_CONFIG: path.join(dir, "config.yaml") },
			stdin: (async function* () {})(),
			stdout: () => {},
			stderr: (text) => void (stderr += text),
		});
		assert.equal(code, 1, text);
		assert.match(stderr, expected, text);
		assert.ok(stderr.startsWith(`tau: the config ${dir}/config.yaml: `), stderr);
	}
});

test("a config file is found in $XDG_CONFIG_HOME, and an empty one says nothing", async () => {
	const xdg = write("xdg", { "tau/config.yaml": "" });
	let stdout = "";
	const code = await main(["run", "greet", "--call", "call.json"], {
		cwd: home,
		env: { TAU_STATE_DIR: path.join(tmp, "state"), XDG_CONFIG_HOME: xdg },
		stdin: (async function* () {})(),
		stdout: (text) => void (stdout += text),
		stderr: () => {},
	});
	assert.equal(code, 0);
	assert.match(stdout, /^Greet Ana in /u);
	writeFileSync(path.join(xdg, "tau", "config.yaml"), "adaptor: elsewhere\n");
	let stderr = "";
	assert.equal(await main(["run", "greet", "--call", "call.json"], {
		cwd: home,
		env: { TAU_STATE_DIR: path.join(tmp, "state"), XDG_CONFIG_HOME: xdg },
		stdin: (async function* () {})(),
		stdout: () => {},
		stderr: (text) => void (stderr += text),
	}), 1);
	assert.equal(stderr, 'tau: no wire adaptor "elsewhere"; there are dummy, rpc\n');
});

test("a command line that is not one gives the usage", async () => {
	for (const argv of [[], ["run"], ["frobnicate", "x"], ["run", "a", "b"], ["run", "greet", "--nope"], ["status", "dummy:1", "--trace", "t.jsonl"]]) {
		const { code, stderr } = await tau(argv);
		assert.equal(code, 2, argv.join(" "));
		assert.match(stderr, /usage: tau check/u);
	}
	assert.match((await tau(["--help"])).stdout, /^usage: tau check/u);
});
