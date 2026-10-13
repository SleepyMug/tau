import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { createClient } from "../client/client.js";
import { packResult } from "../wire-tar/archive.js";
import { createFleetAdaptor, type FleetHandler, type FleetTransport, fleetLoopback, readFleetRunRequest } from "./fleet.js";
import { FakeFleet } from "./fleet-fake.test.util.js";
import { defaultFleetSocket, FleetUnreachable, fleetSocket, listenFleet } from "./fleet-socket.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tau-fleet-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function write(dir: string, files: Record<string, string>): string {
	const root = path.join(tmp, dir);
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		writeFileSync(path.join(root, file), text);
	}
	return root;
}

const TAU = write("greet", {
	"PROMPT.md": "Greet ${name} in ${card}, as ${style} says.\n",
	"tau.json": JSON.stringify({
		files: {
			style: { kind: "file", mode: "in", description: "How." },
			card: { kind: "file", mode: "out", description: "The card." },
		},
		args: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
	}),
});

/** A caller's folder, with its style. */
function home(dir: string): string {
	return write(dir, { "style.md": "warmly\n" });
}

const CALL = { files: { style: "style.md", card: "card.txt" }, args: { name: "Ana" } };

/** An agent that writes the card from the style, and says how many times it was asked to. */
function writer(): FakeFleet {
	let written = 0;
	return new FakeFleet(async (placed) => {
		const style = readFileSync(placed.places.style as string, "utf8").trim();
		writeFileSync(placed.places.card as string, `Hello, ${style}. (${++written})\n`);
		return { ok: true, text: `Wrote ${written}.` };
	});
}

/** A socket of the test's, served by `handle`, closed after the tests. */
async function serving(handle: FleetHandler): Promise<string> {
	const socket = path.join(tmp, `${Math.random().toString(36).slice(2)}.sock`);
	after(await listenFleet(socket, handle));
	return socket;
}

for (const [name, transport] of [
	["in this process", (fleet: FakeFleet) => Promise.resolve(fleetLoopback(fleet.handle))],
	["on the fleet service's socket", async (fleet: FakeFleet) => fleetSocket(await serving(fleet.handle))],
] as const)
	test(`a run goes to the fleet service ${name}, and its outputs come back to the caller's paths`, async () => {
		const caller = home(`home-${name.replaceAll(" ", "-")}`);
		const fleet = writer();
		const client = createClient({ adaptors: { fleet: createFleetAdaptor({ transport: await transport(fleet), project: caller }) } });
		const run = await client.start(TAU, CALL, { cwd: caller });
		assert.match(run, /^fleet:session-[0-9a-f-]+$/u);
		// The service is told what to call the run, and where its session is; never the caller's paths.
		assert.deepEqual(fleet.submitted, [{ op: "submit", title: "greet", project: caller }]);
		assert.deepEqual(await client.finish(run), { ok: true, text: "Wrote 1." });
		assert.equal(readFileSync(path.join(caller, "card.txt"), "utf8"), "Hello, warmly. (1)\n");
		await client.release(run);
		assert.deepEqual(fleet.released, [run.slice("fleet:".length)]);
		await assert.rejects(client.finish(run), /^Error: no run fleet:/u);
	});

test("finishing again gives the latest result, which puts its outputs again", async () => {
	const caller = home("home-again");
	const fleet = new FakeFleet(async (placed) => {
		writeFileSync(placed.places.card as string, "first\n");
		return { ok: true, text: "Done." };
	});
	const client = createClient({ adaptors: { fleet: createFleetAdaptor({ transport: fleetSocket(await serving(fleet.handle)) }) } });
	const run = await client.start(TAU, CALL, { cwd: caller });
	assert.deepEqual(await client.finish(run), { ok: true, text: "Done." });
	assert.equal(readFileSync(path.join(caller, "card.txt"), "utf8"), "first\n");
	// As if the run's session were asked to do better: what its agent left since is collected again.
	writeFileSync(fleet.places(run.slice("fleet:".length)).card as string, "second\n");
	assert.deepEqual(await client.finish(run), { ok: true, text: "Done." });
	assert.equal(readFileSync(path.join(caller, "card.txt"), "utf8"), "second\n");
	assert.deepEqual(fleet.submitted, [{ op: "submit", title: "greet" }]);
	await client.wait(run);
});

test("a run the service refuses does not start, and the service's error reaches the caller", async () => {
	const caller = home("home-refused");
	const refusing: FleetHandler = async (request) => {
		throw new Error(`fleet: no box for ${String(request.title)}`);
	};
	const client = createClient({ adaptors: { fleet: createFleetAdaptor({ transport: fleetSocket(await serving(refusing)) }) } });
	await assert.rejects(client.start(TAU, CALL, { cwd: caller }), /^Error: fleet: no box for greet$/u);
});

test("what the service gives back that does not fit the run fails it, and puts nothing", async () => {
	const caller = home("home-unfit");
	const lying: FleetHandler = async (request) => {
		if (request.op === "submit") return { value: { id: "session-1" } };
		const stray = path.join(tmp, "stray.txt");
		writeFileSync(stray, "stray\n");
		if (request.op === "finish") return { value: null, body: Readable.from(packResult({ ok: true, text: "", outputs: { style: { kind: "file" } } }, { style: stray })) };
		return { value: null };
	};
	const client = createClient({ adaptors: { fleet: createFleetAdaptor({ transport: fleetSocket(await serving(lying)) }) } });
	const outcome = await client.run(TAU, CALL, { cwd: caller });
	assert.equal(outcome.ok, false);
	assert.match(outcome.failure ?? "", /style/u);
	assert.equal(readFileSync(path.join(caller, "style.md"), "utf8"), "warmly\n");

	const silent: FleetTransport = { exchange: async (request) => ({ value: request.op === "submit" ? { id: "session-1" } : null }) };
	const unanswered = await createClient({ adaptors: { fleet: createFleetAdaptor({ transport: silent }) } }).run(TAU, CALL, { cwd: caller });
	assert.deepEqual(unanswered, { ok: false, text: "", failure: "the fleet service broke the protocol: finish sent no result" });
	const nameless: FleetTransport = { exchange: async () => ({ value: { id: 7 } }) };
	await assert.rejects(createClient({ adaptors: { fleet: createFleetAdaptor({ transport: nameless }) } }).start(TAU, CALL, { cwd: caller }), /submit answered \{"id":7\}, not \{ id \}/u);
});

test("aborting a finish stops the waiting, on the socket as in the service, and not the run", async () => {
	const caller = home("home-abort");
	const fleet = writer();
	let open = (): void => {};
	fleet.gate = new Promise((resolve) => (open = resolve));
	const client = createClient({ adaptors: { fleet: createFleetAdaptor({ transport: fleetSocket(await serving(fleet.handle)) }) } });
	const run = await client.start(TAU, CALL, { cwd: caller });
	const waiting = new AbortController();
	const finishing = client.finish(run, { signal: waiting.signal });
	await new Promise((resolve) => setTimeout(resolve, 50));
	waiting.abort(new Error("enough"));
	await assert.rejects(finishing, /^Error: enough$/u);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(fleet.signals.get("finish")?.aborted, true);
	open();
	assert.deepEqual(await client.wait(run), { ok: true, text: "Wrote 1." });
});

test("aborting a run once it started releases it", async () => {
	const caller = home("home-stopped");
	const fleet = writer();
	fleet.gate = new Promise(() => {});
	const client = createClient({ adaptors: { fleet: createFleetAdaptor({ transport: fleetLoopback(fleet.handle) }) } });
	const stopping = new AbortController();
	const running = client.run(TAU, CALL, { cwd: caller, signal: stopping.signal });
	await new Promise((resolve) => setTimeout(resolve, 50));
	stopping.abort();
	assert.deepEqual(await running, { ok: false, text: "", failure: "the run was stopped" });
	assert.equal(fleet.released.length, 1);
});

test("the socket carries the service's own ops, and refuses a request of another version or with no op", async () => {
	const socket = await serving(async (request, body) => {
		let sent = "";
		for await (const chunk of body) sent += Buffer.from(chunk).toString("utf8");
		if (request.op === "list") return { value: [{ sent }] };
		if (request.op === "history") return { value: { events: 2 }, body: Readable.from([Buffer.from("a\n"), Buffer.from("b\n")]) };
		throw new Error(`no op ${request.op}`);
	});
	const transport = fleetSocket(socket);
	assert.deepEqual(await transport.exchange({ op: "list" }), { value: [{ sent: "" }] });
	assert.deepEqual((await transport.exchange({ op: "list" }, Readable.from([Buffer.from("up")]))).value, [{ sent: "up" }]);
	const history = await transport.exchange({ op: "history", id: "session-1" });
	let read = "";
	for await (const chunk of history.body ?? []) read += Buffer.from(chunk).toString("utf8");
	assert.deepEqual([history.value, read], [{ events: 2 }, "a\nb\n"]);
	await assert.rejects(transport.exchange({ op: "frobnicate" }), /^Error: no op frobnicate$/u);

	const raw = async (line: string): Promise<string> => {
		const { createConnection } = await import("node:net");
		const connection = createConnection(socket);
		connection.write(`${line}\n`);
		let answer = "";
		for await (const chunk of connection) answer += Buffer.from(chunk).toString("utf8");
		return answer;
	};
	assert.equal(await raw('{"protocol": 2, "op": "list"}'), '{"ok":false,"error":"the client speaks the fleet wire 2, and the service 1"}\n');
	assert.equal(await raw('{"protocol": 1}'), '{"ok":false,"error":"the request has no op"}\n');
	assert.equal(await raw("list"), '{"ok":false,"error":"the request is not JSON"}\n');

	await assert.rejects(listenFleet(socket, async () => ({ value: null })), /^Error: another fleet service serves /u);
	await assert.rejects(fleetSocket(path.join(tmp, "nobody.sock")).exchange({ op: "list" }), (error) => error instanceof FleetUnreachable && /no fleet service at \S+nobody\.sock/u.test(error.message));
});

test("a run's requests are checked as the service takes them, and others are left to it", () => {
	assert.deepEqual(readFleetRunRequest({ op: "submit", title: "greet" }), { op: "submit", title: "greet" });
	assert.deepEqual(readFleetRunRequest({ op: "release", id: "session-1" }), { op: "release", id: "session-1" });
	assert.equal(readFleetRunRequest({ op: "list" }), undefined);
	assert.throws(() => readFleetRunRequest({ op: "submit", title: " " }), /^TypeError: submit takes a title, a string$/u);
	assert.throws(() => readFleetRunRequest({ op: "submit", title: "greet", project: "here" }), /takes project, an absolute path/u);
	assert.throws(() => readFleetRunRequest({ op: "submit", title: "greet", targets: {} }), /^TypeError: submit takes no targets$/u);
	assert.throws(() => readFleetRunRequest({ op: "finish" }), /^TypeError: finish takes the run's id, a string$/u);
});

test("the fleet service's socket is $TAU_FLEET_SOCKET, or in the dsh home", () => {
	const home = os.homedir();
	assert.equal(defaultFleetSocket({}), path.join(home, ".dsh", "fleet", "tau.sock"));
	assert.equal(defaultFleetSocket({ DSH_HOME: " " }), path.join(home, ".dsh", "fleet", "tau.sock"));
	assert.equal(defaultFleetSocket({ DSH_HOME: "~/dsh" }), path.join(home, "dsh", "fleet", "tau.sock"));
	assert.equal(defaultFleetSocket({ DSH_HOME: "/srv/dsh" }), "/srv/dsh/fleet/tau.sock");
	assert.equal(defaultFleetSocket({ DSH_HOME: "/srv/dsh", TAU_FLEET_SOCKET: "/run/fleet.sock" }), "/run/fleet.sock");
});
