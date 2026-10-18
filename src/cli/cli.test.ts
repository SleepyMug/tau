import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import { createDummyAdaptor } from "../adaptors/dummy.js";
import { createFleetAdaptor, fleetLoopback } from "../adaptors/fleet.js";
import { FakeFleet } from "../adaptors/fleet-fake.test.util.js";
import { listenFleet } from "../adaptors/fleet-socket.js";
import { writeTar } from "../wire-tar/tar.js";
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
		apis: {},
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
	assert.equal(unknown.stderr, 'tau: no wire adaptor "elsewhere"; there are dummy, fleet\n');
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

test("tau run --adaptor fleet runs on the fleet service at $TAU_FLEET_SOCKET, its session in the working directory's workspace", async () => {
	const fleet = new FakeFleet(async (placed) => (writeFileSync(placed.places.card as string, "From the fleet.\n"), { ok: true, text: "Sent." }));
	const socket = path.join(tmp, "fleet.sock");
	after(await listenFleet(socket, fleet.handle));
	let stdout = "";
	const context: CliContext = {
		cwd: home,
		env: { TAU_STATE_DIR: path.join(tmp, "state"), TAU_CONFIG: path.join(tmp, "no-config.yaml"), TAU_FLEET_SOCKET: socket },
		stdin: (async function* () {})(),
		stdout: (text) => void (stdout += text),
		stderr: () => {},
	};
	assert.equal(await main(["run", "greet", "--call", "call.json", "--adaptor", "fleet"], context), 0);
	assert.equal(stdout, "Sent.\n");
	assert.equal(readFileSync(path.join(home, "card.txt"), "utf8"), "From the fleet.\n");
	assert.deepEqual(fleet.submitted, [{ op: "submit", title: "greet", project: home }]);
	assert.equal(fleet.released.length, 1);
});

test("the config file chooses the adaptor, and the fleet service's socket, a path relative to its folder; the command line and the environment come first", async () => {
	const fleet = new FakeFleet(async (placed) => (writeFileSync(placed.places.card as string, "Configured.\n"), { ok: true, text: "Sent." }));
	const configDir = write("config", { "config.yaml": "# Runs go to the fleet.\nadaptor: fleet\nadaptors:\n  fleet:\n    socket: sockets/fleet.sock\n" });
	mkdirSync(path.join(configDir, "sockets"));
	after(await listenFleet(path.join(configDir, "sockets", "fleet.sock"), fleet.handle));
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
	assert.equal(fleet.submitted.length, 1);
	// --adaptor, and $TAU_ADAPTOR, before the config's adaptor.
	assert.equal(await run({}, ["--adaptor", "dummy"]), 0);
	assert.equal(await run({ TAU_ADAPTOR: "dummy" }), 0);
	assert.equal(fleet.submitted.length, 1);
	// $TAU_FLEET_SOCKET before the config's socket.
	assert.equal(await run({ TAU_FLEET_SOCKET: path.join(tmp, "nothing.sock") }), 1);
	assert.equal(fleet.submitted.length, 1);
});

test("a config file that is not one fails the command, saying where and why", async () => {
	const cases: [string, RegExp][] = [
		["adaptor: fleet\nsocket: x\n", /config\.yaml: it has no "socket"; it has adaptor, adaptors\n$/u],
		["adaptors:\n  dummy: {}\n", /config\.yaml: adaptors has no "dummy"; it has fleet\n$/u],
		["adaptors:\n  fleet: { socket: 3 }\n", /config\.yaml: adaptors\.fleet\.socket is not a path\n$/u],
		["adaptor: [fleet]\n", /config\.yaml: adaptor is not a name\n$/u],
		["- fleet\n", /config\.yaml: it is not a mapping\n$/u],
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
	assert.equal(stderr, 'tau: no wire adaptor "elsewhere"; there are dummy, fleet\n');
});

test("a command line that is not one gives the usage", async () => {
	for (const argv of [[], ["run"], ["frobnicate", "x"], ["run", "a", "b"], ["run", "greet", "--nope"]]) {
		const { code, stderr } = await tau(argv);
		assert.equal(code, 2, argv.join(" "));
		assert.match(stderr, /usage: tau check/u);
	}
	assert.match((await tau(["--help"])).stdout, /^usage: tau check/u);
});

/** A contract's package.json. */
const manifest = (name: string, version: string) =>
	JSON.stringify({ name, version, description: `${name}, at ${version}.`, tau: { contract: true }, type: "module", types: "./index.d.ts" });

/** Runs `argv` in `cwd`, with `adaptors` and `fetch`; gives its exit code and output. */
async function tauIn(cwd: string, argv: readonly string[], extra: Partial<CliContext> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const context: CliContext = {
		cwd,
		env: { TAU_STATE_DIR: path.join(tmp, "state"), TAU_CONFIG: path.join(tmp, "no-config.yaml"), npm_config_registry: "https://registry.test/" },
		stdin: (async function* () {})(),
		stdout: (text) => void (stdout += text),
		stderr: (text) => void (stderr += text),
		...extra,
	};
	return { code: await main(argv, context), stdout, stderr };
}

/** A registry of the test's, holding @acme/travel at 1.2.0 and 1.3.0, its tarballs as npm packs them. */
function registry(): { fetch: typeof fetch; asked: string[] } {
	const asked: string[] = [];
	const tarball = async (version: string): Promise<Buffer<ArrayBuffer>> => {
		const files: Record<string, string> = {
			"package/package.json": manifest("@acme/travel", version),
			"package/index.d.ts": "export declare function book(city: string): Promise<string>;\n",
			"package/lib/trip.d.ts": "export {};\n",
			"package/index.js": "",
		};
		const chunks: Uint8Array[] = [];
		const entries = Object.entries(files).map(([name, text]) => ({ name, type: "file" as const, mode: 0o644, size: Buffer.byteLength(text), body: async function* () { yield Buffer.from(text); } }));
		for await (const chunk of writeTar(entries)) chunks.push(chunk);
		return gzipSync(Buffer.concat(chunks));
	};
	const fake = async (input: string | URL | Request): Promise<Response> => {
		const url = String(input);
		asked.push(url);
		if (url === "https://registry.test/@acme%2ftravel")
			return Response.json({
				"dist-tags": { latest: "1.3.0" },
				versions: Object.fromEntries(["1.2.0", "1.3.0"].map((version) => [version, { dist: { tarball: `https://registry.test/travel-${version}.tgz` } }])),
			});
		const match = /travel-(.+)\.tgz$/u.exec(url);
		if (match !== null) return new Response(new Blob([await tarball(match[1] as string)]));
		return new Response("not found", { status: 404 });
	};
	return { fetch: fake as typeof fetch, asked };
}

test("tau api add pulls a contract from npm, at the version its range gives, into .tau/, and names it in apis", async () => {
	const dir = write("trip", { "PROMPT.md": "Plan a trip.\n", "tau.json": JSON.stringify({ description: "A trip." }) });
	const npm = registry();
	assert.deepEqual(await tauIn(dir, ["api", "add", "@acme/travel@^1.2.0"], { fetch: npm.fetch }), {
		code: 0,
		stdout: "@acme/travel@^1.2.0: its contract at 1.2.0, from npm\n",
		stderr: "",
	});
	assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "tau.json"), "utf8")), { description: "A trip.", apis: { "@acme/travel": "^1.2.0" } });
	assert.deepEqual(readdirSync(path.join(dir, ".tau"), { recursive: true }).sort(), [
		".gitignore",
		"contracts",
		"contracts/@acme",
		"contracts/@acme/travel",
		"contracts/@acme/travel/index.d.ts",
		"contracts/@acme/travel/lib",
		"contracts/@acme/travel/lib/trip.d.ts",
		"contracts/@acme/travel/package.json",
		"lock.json",
		"tsconfig.json",
	]);
	assert.deepEqual(JSON.parse(readFileSync(path.join(dir, ".tau/lock.json"), "utf8")), { contracts: { "@acme/travel": { version: "1.2.0", from: "npm" } } });
	assert.deepEqual(JSON.parse(readFileSync(path.join(dir, ".tau/tsconfig.json"), "utf8")), {
		compilerOptions: { paths: { "@acme/travel": ["./contracts/@acme/travel/index.d.ts"] } },
	});
	assert.equal(readFileSync(path.join(dir, ".tau/.gitignore"), "utf8"), "*\n!lock.json\n");
	assert.deepEqual(JSON.parse((await tauIn(dir, ["describe", "."])).stdout).apis, { "@acme/travel": "^1.2.0" });

	// Without a range, the latest, at ^ and its version; a version npm lacks is refused, naming those it has.
	assert.equal((await tauIn(dir, ["api", "add", "@acme/travel"], { fetch: npm.fetch })).stdout, "@acme/travel@^1.3.0: its contract at 1.3.0, from npm\n");
	const missing = await tauIn(dir, ["api", "add", "@acme/travel@^1.4.0"], { fetch: npm.fetch });
	assert.equal(missing.code, 1);
	assert.equal(missing.stderr, "tau: npm has @acme/travel at 1.2.0, 1.3.0, not 1.4.0, which is what the tau is written against\n");
	assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "tau.json"), "utf8")).apis, { "@acme/travel": "^1.3.0" });
});

test("tau api add pulls from a path, or an adaptor's backend; sync pulls again what .tau/ lacks, from where it came; remove takes an API out", async () => {
	const contracts = write("published", {
		"notes/package.json": manifest("@acme/notes", "0.2.0"),
		"notes/index.d.ts": "export {};\n",
		"notes/src/notes.ts": "",
		"clock/package.json": manifest("clock", "1.0.0"),
		"clock/index.d.ts": "export {};\n",
	});
	const dir = write("keeper", { "PROMPT.md": "Keep notes.\n", "tau.json": JSON.stringify({ exposes: ["@acme/notes", "clock"] }) });
	const fleet = new FakeFleet(async () => ({ ok: true, text: "" }), [
		{ contract: "clock", version: "1.0.0", module: "/x", declarations: path.join(contracts, "clock") },
	]);
	const adaptors = { fleet: createFleetAdaptor({ transport: fleetLoopback(fleet.handle) }), dummy: createDummyAdaptor({ spool: path.join(tmp, "api-dummy") }) };
	assert.equal((await tauIn(home, ["api", "add", "@acme/notes@^0.2.0", "--from", path.relative(home, path.join(contracts, "notes")), dir])).stdout,
		"@acme/notes@^0.2.0: its contract at 0.2.0, from ../published/notes\n");
	assert.equal((await tauIn(dir, ["api", "add", "clock", "--from", "fleet"], { adaptors })).stdout, "clock@^1.0.0: its contract at 1.0.0, from fleet\n");
	assert.deepEqual(await tauIn(dir, ["api", "add", "clock", "--from", "dummy"], { adaptors }), { code: 1, stdout: "", stderr: "tau: the dummy adaptor gives no contracts\n" });
	assert.deepEqual(JSON.parse(readFileSync(path.join(dir, ".tau/lock.json"), "utf8")), {
		contracts: { "@acme/notes": { version: "0.2.0", from: "../published/notes" }, clock: { version: "1.0.0", from: "fleet" } },
	});
	assert.equal(existsSync(path.join(dir, ".tau/contracts/@acme/notes/src")), false);

	// As a clone has it: lock.json alone.
	for (const entry of readdirSync(path.join(dir, ".tau"))) if (entry !== "lock.json") rmSync(path.join(dir, ".tau", entry), { recursive: true });
	mkdirSync(path.join(dir, ".tau/contracts/stale"), { recursive: true });
	assert.equal((await tauIn(dir, ["api", "sync"], { adaptors })).stdout, "pulled @acme/notes@0.2.0, from ../published/notes; clock@1.0.0, from fleet\n");
	assert.deepEqual(readdirSync(path.join(dir, ".tau/contracts")).sort(), ["@acme", "clock"]);
	assert.equal((await tauIn(dir, ["api", "sync"], { adaptors })).stdout, "every contract is in .tau/ already\n");

	assert.equal((await tauIn(dir, ["api", "remove", "clock"])).stdout, "clock: removed\n");
	assert.deepEqual(JSON.parse(readFileSync(path.join(dir, "tau.json"), "utf8")), { exposes: ["@acme/notes"], apis: { "@acme/notes": "^0.2.0" } });
	assert.equal(existsSync(path.join(dir, ".tau/contracts/clock")), false);
	assert.deepEqual(JSON.parse(readFileSync(path.join(dir, ".tau/tsconfig.json"), "utf8")).compilerOptions.paths, { "@acme/notes": ["./contracts/@acme/notes/index.d.ts"] });

	// A run carries no .tau/.
	let carried: string[] = [];
	const looking = createDummyAdaptor({ spool: path.join(tmp, "api-looking"), agent: async ({ placed }) => ((carried = readdirSync(placed.tau.dir).sort()), { ok: true, text: "" }) });
	assert.equal((await tauIn(dir, ["run", "."], { adaptors: { dummy: looking } })).code, 0);
	assert.deepEqual(carried, ["PROMPT.md", "tau.json"]);
});

test("tau api refuses what it cannot do, and a command line that is not one", async () => {
	const dir = write("refusing", { "PROMPT.md": "Hi.\n" });
	assert.equal((await tauIn(dir, ["api", "add", "Clock"])).stderr, 'tau: "Clock" is not a contract\'s name, an npm package\'s\n');
	assert.equal((await tauIn(dir, ["api", "add", "clock@1.0.0"])).stderr, 'tau: "1.0.0" is not a range, ^ and a version, as ^1.2.0\n');
	assert.equal((await tauIn(dir, ["api", "add", "clock", "--from", "elsewhere"], { adaptors: {} })).stderr, 'tau: no source "elsewhere": npm, a path\n');
	assert.equal((await tauIn(dir, ["api", "remove", "clock"])).stderr, `tau: ${dir}/tau.json: \`apis\` names no clock\n`);
	assert.equal((await tauIn(tmp, ["api", "sync"])).stderr, `tau: ${tmp}: not a tau (no PROMPT.md)\n`);
	assert.equal((await tauIn(dir, ["api", "list"])).code, 2);
	assert.equal((await tauIn(dir, ["api", "sync", "--from", "npm"])).code, 2);
	assert.equal((await tauIn(dir, ["check", ".", "--from", "npm"])).code, 2);
});
