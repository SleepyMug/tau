import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, test } from "node:test";
import { createClient } from "../client/client.js";
import { packResult } from "../wire-tar/archive.js";
import { createSocketAdaptor, loopbackTransport, readRunRequest, type RequestHandler, type SocketTransport } from "./socket.js";
import { FAKE_TRACE, FakeBackend } from "./socket-fake.test.util.js";
import { defaultSocket, listenSocket, serveConnection, SocketUnreachable, socketTransport } from "./socket-transport.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tau-socket-"));
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
function writer(): FakeBackend {
	let written = 0;
	return new FakeBackend(async (placed) => {
		const style = readFileSync(placed.places.style as string, "utf8").trim();
		writeFileSync(placed.places.card as string, `Hello, ${style}. (${++written})\n`);
		return { ok: true, text: `Wrote ${written}.` };
	});
}

/** A socket of the test's, served by `handle`, closed after the tests. */
async function serving(handle: RequestHandler): Promise<string> {
	const socket = path.join(tmp, `${Math.random().toString(36).slice(2)}.sock`);
	after(await listenSocket(socket, handle));
	return socket;
}

for (const [name, transport] of [
	["in this process", (backend: FakeBackend) => Promise.resolve(loopbackTransport(backend.handle))],
	["on the backend's socket", async (backend: FakeBackend) => socketTransport(await serving(backend.handle))],
] as const)
	test(`a run goes to the backend ${name}, and its outputs come back to the caller's paths`, async () => {
		const caller = home(`home-${name.replaceAll(" ", "-")}`);
		const backend = writer();
		const client = createClient({ adaptors: { socket: createSocketAdaptor({ transport: await transport(backend), project: caller }) } });
		const run = await client.start(TAU, CALL, { cwd: caller });
		assert.match(run, /^socket:session-[0-9a-f-]+$/u);
		// The backend is told what to call the run, and where its caller is; never the caller's paths.
		assert.deepEqual(backend.submitted, [{ op: "submit", title: "greet", project: caller }]);
		assert.deepEqual(await client.finish(run), { ok: true, text: "Wrote 1." });
		assert.equal(readFileSync(path.join(caller, "card.txt"), "utf8"), "Hello, warmly. (1)\n");
		assert.deepEqual(await client.status(run), { state: "ended", result: 1, ok: true });
		assert.deepEqual(await client.trace(run), {
			format: FAKE_TRACE,
			events: [
				{ type: "placed", files: ["style", "card"] },
				{ type: "ended", ok: true, text: "Wrote 1." },
			],
		});
		await client.release(run);
		assert.deepEqual(backend.released, [run.slice("socket:".length)]);
		await assert.rejects(client.finish(run), /^Error: no run socket:/u);
	});

test("finishing again gives the latest result, which puts its outputs again", async () => {
	const caller = home("home-again");
	const backend = new FakeBackend(async (placed) => {
		writeFileSync(placed.places.card as string, "first\n");
		return { ok: true, text: "Done." };
	});
	const client = createClient({ adaptors: { socket: createSocketAdaptor({ transport: socketTransport(await serving(backend.handle)) }) } });
	const run = await client.start(TAU, CALL, { cwd: caller });
	assert.deepEqual(await client.finish(run), { ok: true, text: "Done." });
	assert.equal(readFileSync(path.join(caller, "card.txt"), "utf8"), "first\n");
	// As if the run's session were asked to do better: what its agent left since is collected again.
	writeFileSync(backend.places(run.slice("socket:".length)).card as string, "second\n");
	assert.deepEqual(await client.finish(run), { ok: true, text: "Done." });
	assert.equal(readFileSync(path.join(caller, "card.txt"), "utf8"), "second\n");
	assert.deepEqual(backend.submitted, [{ op: "submit", title: "greet" }]);
	await client.wait(run);
});

test("a run the backend refuses does not start, and the backend's error reaches the caller", async () => {
	const caller = home("home-refused");
	const refusing: RequestHandler = async (request) => {
		throw new Error(`backend: no box for ${String(request.title)}`);
	};
	const client = createClient({ adaptors: { socket: createSocketAdaptor({ transport: socketTransport(await serving(refusing)) }) } });
	await assert.rejects(client.start(TAU, CALL, { cwd: caller }), /^Error: backend: no box for greet$/u);
});

test("what the backend gives back that does not fit the run fails it, and puts nothing", async () => {
	const caller = home("home-unfit");
	const lying: RequestHandler = async (request) => {
		if (request.op === "submit") return { value: { id: "session-1" } };
		const stray = path.join(tmp, "stray.txt");
		writeFileSync(stray, "stray\n");
		if (request.op === "status") return { value: { state: "ended", result: 1, ok: true } };
		if (request.op === "result") return { value: { result: 1 }, body: Readable.from(packResult({ ok: true, text: "", outputs: { style: { kind: "file" } } }, { style: stray })) };
		return { value: null };
	};
	const client = createClient({ adaptors: { socket: createSocketAdaptor({ transport: socketTransport(await serving(lying)) }) } });
	const outcome = await client.run(TAU, CALL, { cwd: caller });
	assert.equal(outcome.ok, false);
	assert.match(outcome.failure ?? "", /style/u);
	assert.equal(readFileSync(path.join(caller, "style.md"), "utf8"), "warmly\n");

	const answers: Record<string, unknown> = { submit: { id: "session-1" }, status: { state: "ended", result: 1, ok: true }, result: { result: 1 } };
	const silent: SocketTransport = { exchange: async (request) => ({ value: answers[request.op] ?? null }) };
	const unanswered = await createClient({ adaptors: { socket: createSocketAdaptor({ transport: silent }) } }).run(TAU, CALL, { cwd: caller });
	assert.deepEqual(unanswered, { ok: false, text: "", failure: "the backend broke the protocol: result sent no result" });
	const nameless: SocketTransport = { exchange: async () => ({ value: { id: 7 } }) };
	await assert.rejects(createClient({ adaptors: { socket: createSocketAdaptor({ transport: nameless }) } }).start(TAU, CALL, { cwd: caller }), /submit answered \{"id":7\}, not \{ id \}/u);
});

test("a run's status, result and trace are checked as from a backend the adaptor does not trust", async () => {
	const caller = home("home-checked");
	const answering = (answers: Record<string, unknown>): SocketTransport => ({ exchange: async (request) => ({ value: answers[request.op] ?? null }) });
	const started = async (answers: Record<string, unknown>) => {
		const client = createClient({ adaptors: { socket: createSocketAdaptor({ transport: answering({ submit: { id: "session-1" }, ...answers }) }) } });
		return { client, run: await client.start(TAU, CALL, { cwd: caller }) };
	};
	for (const [status, problem] of [
		[{ state: "done" }, '`state` is "running" or "ended"'],
		[{ state: "running", ok: true }, "a running run has no `result`, `ok` or `failure`"],
		[{ state: "ended", result: 0, ok: true }, "`result` is a whole number, from 1"],
		[{ state: "ended", result: 1, ok: true, failure: "no" }, "`failure` is a string, only when the result failed"],
		[{ state: "ended", result: 1, ok: true, since: "now" }, `it: unknown key "since"`],
	] as const) {
		const { client, run } = await started({ status });
		await assert.rejects(client.status(run), (error: Error) => error.message.startsWith(`the backend broke the protocol: status answered ${JSON.stringify(status)}: `) && error.message.includes(problem));
	}
	const { client, run } = await started({ result: { result: "1" }, trace: { format: "", events: [] } });
	await assert.rejects(client.result(run), /result answered \{"result":"1"\}, not \{ result \}, its number/u);
	await assert.rejects(client.trace(run), /trace answered what is no trace: `format` is a string, not empty/u);
	const { client: other, run: again } = await started({ trace: { format: "x", events: {} } });
	await assert.rejects(other.trace(again), /`events` is an array/u);
});

test("a run is running until it ended, with no result, and its trace is what its agent did so far", async () => {
	const caller = home("home-running");
	const backend = writer();
	let open = (): void => {};
	backend.gate = new Promise((resolve) => (open = resolve));
	const client = createClient({ adaptors: { socket: createSocketAdaptor({ transport: socketTransport(await serving(backend.handle)) }) } });
	const run = await client.start(TAU, CALL, { cwd: caller });
	assert.deepEqual(await client.status(run), { state: "running" });
	await assert.rejects(client.result(run), /has no result yet/u);
	assert.deepEqual(await client.trace(run), { format: FAKE_TRACE, events: [{ type: "placed", files: ["style", "card"] }] });
	open();
	assert.deepEqual(await client.finish(run), { ok: true, text: "Wrote 1." });
	assert.deepEqual(await client.result(run), { result: 1, ok: true, text: "Wrote 1." });
	await client.release(run);
});

test("aborting a finish stops the waiting, and not the run", async () => {
	const caller = home("home-abort");
	const backend = writer();
	let open = (): void => {};
	backend.gate = new Promise((resolve) => (open = resolve));
	const client = createClient({ adaptors: { socket: createSocketAdaptor({ transport: socketTransport(await serving(backend.handle)) }) } });
	const run = await client.start(TAU, CALL, { cwd: caller });
	const waiting = new AbortController();
	const finishing = client.finish(run, { signal: waiting.signal });
	await new Promise((resolve) => setTimeout(resolve, 50));
	waiting.abort(new Error("enough"));
	await assert.rejects(finishing, /^Error: enough$/u);
	assert.deepEqual(backend.released, []);
	open();
	assert.deepEqual(await client.wait(run), { ok: true, text: "Wrote 1." });
});

test("aborting a run once it started releases it", async () => {
	const caller = home("home-stopped");
	const backend = writer();
	backend.gate = new Promise(() => {});
	const client = createClient({ adaptors: { socket: createSocketAdaptor({ transport: loopbackTransport(backend.handle) }) } });
	const stopping = new AbortController();
	const running = client.run(TAU, CALL, { cwd: caller, signal: stopping.signal });
	await new Promise((resolve) => setTimeout(resolve, 50));
	stopping.abort();
	assert.deepEqual(await running, { ok: false, text: "", failure: "the run was stopped" });
	assert.equal(backend.released.length, 1);
});

test("the socket carries the backend's own ops, and refuses a request of another version or with no op", async () => {
	const socket = await serving(async (request, body) => {
		let sent = "";
		for await (const chunk of body) sent += Buffer.from(chunk).toString("utf8");
		if (request.op === "list") return { value: [{ sent }] };
		if (request.op === "export") return { value: { lines: 2 }, body: Readable.from([Buffer.from("a\n"), Buffer.from("b\n")]) };
		throw new Error(`no op ${request.op}`);
	});
	const transport = socketTransport(socket);
	assert.deepEqual(await transport.exchange({ op: "list" }), { value: [{ sent: "" }] });
	assert.deepEqual((await transport.exchange({ op: "list" }, Readable.from([Buffer.from("up")]))).value, [{ sent: "up" }]);
	const exported = await transport.exchange({ op: "export", id: "session-1" });
	let read = "";
	for await (const chunk of exported.body ?? []) read += Buffer.from(chunk).toString("utf8");
	assert.deepEqual([exported.value, read], [{ lines: 2 }, "a\nb\n"]);
	await assert.rejects(transport.exchange({ op: "frobnicate" }), /^Error: no op frobnicate$/u);

	const raw = async (line: string): Promise<string> => {
		const { createConnection } = await import("node:net");
		const connection = createConnection(socket);
		connection.write(`${line}\n`);
		let answer = "";
		for await (const chunk of connection) answer += Buffer.from(chunk).toString("utf8");
		return answer;
	};
	assert.equal(await raw('{"protocol": 2, "op": "list"}'), '{"ok":false,"error":"the client speaks the socket wire 2, and the backend 1"}\n');
	assert.equal(await raw('{"protocol": 1}'), '{"ok":false,"error":"the request has no op"}\n');
	assert.equal(await raw("list"), '{"ok":false,"error":"the request is not JSON"}\n');

	await assert.rejects(listenSocket(socket, async () => ({ value: null })), /^Error: another backend serves /u);
	await assert.rejects(socketTransport(path.join(tmp, "nobody.sock")).exchange({ op: "list" }), (error) => error instanceof SocketUnreachable && /no backend at \S+nobody\.sock/u.test(error.message));
});

test("a run's requests are checked as the backend takes them, and others are left to it", () => {
	assert.deepEqual(readRunRequest({ op: "submit", title: "greet" }), { op: "submit", title: "greet" });
	for (const op of ["status", "result", "trace", "release"]) assert.deepEqual(readRunRequest({ op, id: "session-1" }), { op, id: "session-1" });
	assert.equal(readRunRequest({ op: "finish", id: "session-1" }), undefined);
	assert.equal(readRunRequest({ op: "list" }), undefined);
	assert.throws(() => readRunRequest({ op: "submit", title: " " }), /^TypeError: submit takes a title, a string$/u);
	assert.throws(() => readRunRequest({ op: "submit", title: "greet", project: "here" }), /takes project, an absolute path/u);
	assert.throws(() => readRunRequest({ op: "submit", title: "greet", targets: {} }), /^TypeError: submit takes no targets$/u);
	assert.throws(() => readRunRequest({ op: "result" }), /^TypeError: result takes the run's id, a string$/u);
	assert.throws(() => readRunRequest({ op: "trace", id: "session-1", since: 3 }), /^TypeError: trace takes no since$/u);
});

test("the backend's socket is $TAU_SOCKET, if it names one", () => {
	assert.equal(defaultSocket({}), undefined);
	assert.equal(defaultSocket({ TAU_SOCKET: " " }), undefined);
	assert.equal(defaultSocket({ TAU_SOCKET: "/run/tau.sock" }), "/run/tau.sock");
});

test("a connection that reaches the backend otherwise is served as the socket serves each, once its relay read what it needed of it", async () => {
	const caller = home("home-relayed");
	const backend = writer();
	const endpoint = path.join(tmp, "endpoint.sock");
	const relay = path.join(tmp, "relay.sock");
	const boxes: unknown[] = [];
	// The backend's end, which reads the relay's line first, as fleet's says which box a connection comes from.
	const served = createServer({ allowHalfOpen: true }, (connection) => {
		let received = Buffer.alloc(0);
		const read = (chunk: Buffer): void => {
			received = Buffer.concat([received, chunk]);
			const end = received.indexOf(0x0a);
			if (end === -1) return;
			connection.off("data", read);
			connection.pause();
			boxes.push(JSON.parse(received.subarray(0, end).toString("utf8")));
			connection.unshift(received.subarray(end + 1));
			serveConnection(connection, backend.handle);
		};
		connection.on("data", read);
	});
	// The relay, which opens a connection to the backend's end for each of its own, and passes the bytes both ways.
	const relaying = createServer({ allowHalfOpen: true }, (inbound) => {
		const outbound = createConnection(endpoint);
		outbound.write(`${JSON.stringify({ box: "box-1" })}\n`);
		inbound.pipe(outbound);
		outbound.pipe(inbound);
		inbound.on("error", () => outbound.destroy());
		outbound.on("error", () => inbound.destroy());
	});
	await new Promise<void>((resolve) => served.listen(endpoint, resolve));
	await new Promise<void>((resolve) => relaying.listen(relay, resolve));
	after(() => new Promise<void>((resolve) => served.close(() => resolve())));
	after(() => new Promise<void>((resolve) => relaying.close(() => resolve())));
	const client = createClient({ adaptors: { socket: createSocketAdaptor({ transport: socketTransport(relay) }) } });
	assert.deepEqual(await client.run(TAU, CALL, { cwd: caller }), { ok: true, text: "Wrote 1." });
	assert.equal(readFileSync(path.join(caller, "card.txt"), "utf8"), "Hello, warmly. (1)\n");
	assert.ok(boxes.length >= 4 && boxes.every((box) => JSON.stringify(box) === '{"box":"box-1"}'));
});
