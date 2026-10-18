import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { Envelope } from "../core/model.js";
import { catalogOf, createBackendSdk, initDecision, placesUnder } from "./backend.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "tau-server-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function write(dir: string, files: Record<string, string>): string {
	const root = path.join(tmp, dir);
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		writeFileSync(path.join(root, file), text);
	}
	return root;
}

const TAU = write("tau", {
	"PROMPT.md": "Sum ${numbers} into ${total}, in ${style}.\n",
	"tau.json": JSON.stringify({
		files: {
			numbers: { kind: "file", mode: "in", description: "The numbers." },
			total: { kind: "file", mode: "out", description: "Their sum." },
		},
		args: { type: "object", properties: { style: { type: "string" } } },
		apis: { "@acme/notes": "^1.2.0" },
		init: "node ${self}/init.mjs ${numbers}",
	}),
});

const ENVELOPE: Envelope = {
	files: { numbers: { mode: "in", kind: "file", base: "numbers.txt" }, total: { mode: "out", base: "total.txt" } },
	args: { style: "words" },
};

const implementations = catalogOf([
	{ contract: "@acme/notes", version: "1.1.0", module: "/impl/notes-1.1.js" },
	{ contract: "@acme/notes", version: "1.4.0", module: "/impl/notes-1.4.js", declarations: "/impl/notes-1.4" },
	{ contract: "@acme/notes", version: "1.3.0", module: "/impl/notes-1.3.js" },
	{ contract: "@acme/notes", version: "2.0.0", module: "/impl/notes-2.0.js" },
]);
let runs = 0;
/** A fresh work directory, holding the tau, as a backend would have placed it. */
const workspace = () => {
	const work = path.join(tmp, `work-${runs++}`);
	cpSync(TAU, path.join(work, "tau"), { recursive: true });
	return { work, tau: path.join(work, "tau") };
};
/** Places the numbers under `work`, as a backend would, and gives each file's place. */
const placeFiles = (work: string, envelope: Envelope) => {
	const places = placesUnder(path.join(work, "files"), envelope);
	for (const place of Object.values(places)) mkdirSync(path.dirname(place), { recursive: true });
	writeFileSync(places.numbers as string, "1 2 3\n");
	return places;
};

test("a catalog finds the newest implementation within a range, or of all without one", () => {
	assert.equal(implementations.find("@acme/notes", "^1.2.0")?.module, "/impl/notes-1.4.js");
	assert.equal(implementations.find("@acme/notes", "^1.4.0")?.declarations, "/impl/notes-1.4");
	assert.equal(implementations.find("@acme/notes", "^1.5.0"), undefined);
	assert.equal(implementations.find("@acme/notes")?.version, "2.0.0");
	assert.equal(implementations.find("@acme/other"), undefined);
});

test("a call is admitted against its tau, its APIs linked; then placed, rendered, and collected, as often as the run goes on", () => {
	const at = workspace();
	const admitted = createBackendSdk({ implementations }).admit(ENVELOPE, at.tau);
	assert.equal(admitted.tau.dir, at.tau);
	assert.deepEqual(admitted.envelope, { files: { numbers: { mode: "in", kind: "file", base: "numbers.txt" }, total: { mode: "out", kind: "file", base: "total.txt" } }, args: { style: "words" } });
	assert.deepEqual(admitted.links.map(({ api, implementation }) => [api.name, implementation.module]), [["@acme/notes", "/impl/notes-1.4.js"]]);

	const places = placeFiles(at.work, admitted.envelope);
	const numbers = path.join(at.work, "files", "numbers", "numbers.txt");
	const total = path.join(at.work, "files", "total", "total.txt");
	assert.deepEqual(places, { numbers, total });
	const placed = admitted.place(places);
	const rendered = placed.render();
	assert.equal(rendered.prompt, `Sum ${numbers} into ${total}, in words.\n`);
	assert.equal(rendered.init, `node ${at.tau}/init.mjs ${numbers}`);
	assert.equal(rendered.self, at.tau);
	assert.deepEqual(rendered.context, { files: { numbers, total }, args: { style: "words" } });
	assert.equal(placed.render("/agent/tau").init, `node /agent/tau/init.mjs ${numbers}`);

	const failed = placed.collect({ ok: true, text: "Six." });
	assert.equal(failed.report.ok, false);
	assert.match(failed.report.failure ?? "", /^the run did not leave what the call asks:\n {2}total: \S+ does not exist$/u);
	assert.deepEqual([failed.report.outputs, failed.sources], [{}, {}]);

	writeFileSync(total, "6\n");
	assert.deepEqual(placed.collect({ ok: true, text: "Six." }), { report: { ok: true, text: "Six.", outputs: { total: { kind: "file" } } }, sources: { total } });
	// A run that failed gives back nothing, whatever the agent left.
	assert.deepEqual(placed.collect({ ok: false, text: "", failure: "stopped" }).report, { ok: false, text: "", failure: "stopped", outputs: {} });
});

test("a call that cannot run as declared is refused before any file is taken", () => {
	const sdk = createBackendSdk({ implementations });
	const refused = (envelope: unknown, pattern: RegExp, by = sdk) => assert.throws(() => by.admit(envelope, workspace().tau), pattern);
	refused({ ...ENVELOPE, tau: true }, /^TypeError: the call breaks the protocol: it: unknown key "tau"$/u);
	refused({ ...ENVELOPE, args: { style: 3 } }, /^TypeError: the call does not fit the tau:\n {2}args\.style: must be string$/u);
	refused({ files: { ...ENVELOPE.files, total: { mode: "inout", kind: "file", base: "total.txt" } }, args: {} }, /total: is an `inout` in the call, and an `out` in the tau/u);
	refused(ENVELOPE, /^Error: no implementation serves:\n {2}@acme\/notes@\^1\.2\.0$/u, createBackendSdk({ implementations: catalogOf([{ contract: "@acme/notes", version: "2.0.0", module: "/x" }]) }));
});

test("files are placed as the call asks: each where its base name is kept, an input as it was, an output in a directory that exists", () => {
	const at = workspace();
	const admitted = createBackendSdk({ implementations }).admit(ENVELOPE, at.tau);
	assert.throws(
		() => admitted.place({ numbers: path.join(at.work, "numbers"), total: "total.txt" }),
		(error: Error) => {
			assert.deepEqual(error.message.split("\n"), [
				"the files are not placed as the call asks:",
				`  numbers: its place, ${at.work}/numbers, is not absolute, or does not end in its base name, numbers.txt`,
				"  total: its place, total.txt, is not absolute, or does not end in its base name, total.txt",
			]);
			return true;
		},
	);
	assert.throws(() => admitted.place({ numbers: path.join(at.work, "a", "numbers.txt"), total: path.join(at.work, "b", "total.txt") }), /numbers: \S+ does not exist\n {2}total: cannot go in \S+\/b, which does not exist$/u);
});

test("init's ending says whether the agent runs", () => {
	assert.equal(initDecision(0), "skip");
	assert.equal(initDecision(100), "run");
	assert.equal(initDecision(101), "fallback");
	assert.equal(initDecision(1), "fallback");
	assert.equal(initDecision(undefined), "fallback");
});
