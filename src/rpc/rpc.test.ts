import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http2";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Code, ConnectError, createRouterTransport, type Transport } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { createClient } from "../client/client.js";
import type { Status, Trace } from "../core/model.js";
import { packResult } from "../wire-tar/archive.js";
import { FAKE_TRACE, FakeBackend } from "./fake-backend.test.util.js";
import { createRpcAdaptor, defaultRpcPlace, type RunBackend, rpcTransport, runsRoutes } from "./index.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tau-rpc-"));
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

/** `backend`'s routes in this process. */
function loopback(backend: RunBackend): Transport {
	return createRouterTransport(runsRoutes(() => backend));
}

/** `backend`'s routes served on a socket of the test's, below `/services/tau`, closed after the tests. */
async function serving(backend: RunBackend): Promise<Transport> {
	const socket = path.join(tmp, `${Math.random().toString(36).slice(2)}.sock`);
	const server = createServer(connectNodeAdapter({ routes: runsRoutes(() => backend), requestPathPrefix: "/services/tau" }));
	await new Promise<void>((resolve) => server.listen(socket, resolve));
	after(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return rpcTransport({ socket, path: "/services/tau" });
}

const adaptor = (transport: Transport, project?: string) => ({ adaptors: { rpc: createRpcAdaptor({ transport, ...(project === undefined ? {} : { project }) }) } });

for (const [name, transport] of [
	["in this process", (backend: FakeBackend) => Promise.resolve(loopback(backend))],
	["on a socket", serving],
] as const)
	test(`a run goes to the backend ${name}, and its outputs come back to the caller's paths`, async () => {
		const caller = home(`home-${name.replaceAll(" ", "-")}`);
		const backend = writer();
		const client = createClient(adaptor(await transport(backend), caller));
		const run = await client.start(TAU, CALL, { cwd: caller });
		assert.match(run, /^rpc:session-[0-9a-f-]+$/u);
		// The backend is told what to call the run, and where its caller is; never the caller's paths.
		assert.deepEqual(backend.submitted, [{ title: "greet", project: caller }]);
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
		assert.deepEqual(backend.released, [run.slice("rpc:".length)]);
		await assert.rejects(client.finish(run), /^Error: no run rpc:/u);
	});

test("finishing again gives the latest result, which puts its outputs again", async () => {
	const caller = home("home-again");
	const backend = new FakeBackend(async (placed) => {
		writeFileSync(placed.places.card as string, "first\n");
		return { ok: true, text: "Done." };
	});
	const client = createClient(adaptor(await serving(backend)));
	const run = await client.start(TAU, CALL, { cwd: caller });
	assert.deepEqual(await client.finish(run), { ok: true, text: "Done." });
	assert.equal(readFileSync(path.join(caller, "card.txt"), "utf8"), "first\n");
	// As if the run's session were asked to do better: what its agent left since is collected again.
	writeFileSync(backend.places(run.slice("rpc:".length)).card as string, "second\n");
	assert.deepEqual(await client.finish(run), { ok: true, text: "Done." });
	assert.equal(readFileSync(path.join(caller, "card.txt"), "utf8"), "second\n");
	assert.deepEqual(backend.submitted, [{ title: "greet" }]);
	await client.wait(run);
});

/** A backend that answers each call as `answers` says, and refuses what it does not. */
function answering(answers: Partial<RunBackend>): RunBackend {
	const no = async (): Promise<never> => {
		throw new ConnectError("not here", Code.Unimplemented);
	};
	return { submit: no, status: no, result: no, trace: no, release: no, ...answers };
}

test("a run the backend refuses does not start, and the backend's error reaches the caller", async () => {
	const caller = home("home-refused");
	const refusing = answering({
		submit: async (_call, { title }) => {
			throw new ConnectError(`backend: no box for ${title}`, Code.Unavailable);
		},
	});
	const client = createClient(adaptor(await serving(refusing)));
	await assert.rejects(client.start(TAU, CALL, { cwd: caller }), /^Error: backend: no box for greet$/u);
});

test("what the backend gives back that does not fit the run fails it, and puts nothing", async () => {
	const caller = home("home-unfit");
	const stray = path.join(tmp, "stray.txt");
	writeFileSync(stray, "stray\n");
	const ended: Status = { state: "ended", result: 1, ok: true };
	const lying = answering({
		submit: async (call) => {
			for await (const _ of call);
			return "session-1";
		},
		status: async () => ended,
		result: async () => ({ result: 1, archive: packResult({ ok: true, text: "", outputs: { style: { kind: "file" } } }, { style: stray }) }),
		release: async () => {},
	});
	const outcome = await createClient(adaptor(loopback(lying))).run(TAU, CALL, { cwd: caller });
	assert.equal(outcome.ok, false);
	assert.match(outcome.failure ?? "", /style/u);
	assert.equal(readFileSync(path.join(caller, "style.md"), "utf8"), "warmly\n");

	const empty = answering({ ...lying, result: async () => ({ result: 1, archive: (async function* () {})() }) });
	const unanswered = await createClient(adaptor(loopback(empty))).run(TAU, CALL, { cwd: caller });
	assert.equal(unanswered.ok, false);
	const nameless = answering({ ...lying, submit: async () => "" });
	await assert.rejects(createClient(adaptor(loopback(nameless))).start(TAU, CALL, { cwd: caller }), /the backend broke the protocol: submit gave no id/u);
});

test("a run's status and trace are checked as from a backend the adaptor does not trust", async () => {
	const caller = home("home-checked");
	const started = async (answers: Partial<RunBackend>) => {
		const backend = answering({
			submit: async (call) => {
				for await (const _ of call);
				return "session-1";
			},
			...answers,
		});
		const client = createClient(adaptor(loopback(backend)));
		return { client, run: await client.start(TAU, CALL, { cwd: caller }) };
	};
	for (const [status, problem] of [
		[{ state: "ended", result: 0, ok: true }, "`result` is a whole number, from 1"],
		[{ state: "ended", result: 1, ok: true, failure: "no" }, "`failure` is a string, only when the result failed"],
	] as const) {
		const { client, run } = await started({ status: async () => status as Status });
		await assert.rejects(client.status(run), (error: Error) => error.message.startsWith("the backend broke the protocol: status gave no status: ") && error.message.includes(problem));
	}
	const { client, run } = await started({ trace: async () => ({ format: "", events: [] }) as Trace });
	await assert.rejects(client.trace(run), /trace gave what is no trace: `format` is a string, not empty/u);
});

test("a run is running until it ended, with no result, and its trace is what its agent did so far", async () => {
	const caller = home("home-running");
	const backend = writer();
	let open = (): void => {};
	backend.gate = new Promise((resolve) => (open = resolve));
	const client = createClient(adaptor(await serving(backend)));
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
	const client = createClient(adaptor(await serving(backend)));
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
	const client = createClient(adaptor(loopback(backend)));
	const stopping = new AbortController();
	const running = client.run(TAU, CALL, { cwd: caller, signal: stopping.signal });
	await new Promise((resolve) => setTimeout(resolve, 50));
	stopping.abort();
	assert.deepEqual(await running, { ok: false, text: "", failure: "the run was stopped" });
	assert.equal(backend.released.length, 1);
});

test("the backend serving a call is the one its context gives, as by who calls", async () => {
	const caller = home("home-who");
	const backends = new Map<string, FakeBackend>([
		["ana", writer()],
		["bo", writer()],
	]);
	const transport = createRouterTransport(runsRoutes((context) => backends.get(context.requestHeader.get("x-who") ?? "") as FakeBackend), {
		transport: { interceptors: [(next) => (request) => { request.header.set("x-who", "bo"); return next(request); }] },
	});
	const client = createClient(adaptor(transport));
	await client.wait(await client.start(TAU, CALL, { cwd: caller }));
	assert.equal(backends.get("ana")?.submitted.length, 0);
	assert.equal(backends.get("bo")?.submitted.length, 1);
});

test("the backend's place is $TAU_RPC_SOCKET, and the path its calls go below $TAU_RPC_PATH", () => {
	assert.equal(defaultRpcPlace({}), undefined);
	assert.deepEqual(defaultRpcPlace({ TAU_RPC_SOCKET: "/run/fleet/services.sock" }), { socket: "/run/fleet/services.sock" });
	assert.deepEqual(defaultRpcPlace({ TAU_RPC_SOCKET: "/s.sock", TAU_RPC_PATH: "/services/tau" }), { socket: "/s.sock", path: "/services/tau" });
});
