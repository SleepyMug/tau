import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createDummyAdaptor } from "../adaptors/dummy.js";
import type { WireAdaptor } from "../client/adaptor.js";
import { createClient } from "../client/client.js";
import { fileRunStore, type RunStore } from "../client/store.js";
import type { Outcome } from "../core/model.js";
import { loadTau } from "../core/tau.js";
import { messageOf } from "../core/util.js";

/** The `tau` command (docs/spec/client.md#the-tau-command). */

const USAGE = [
	"usage: tau check <dir> [call]             check a tau, and a call of it, without running it",
	"       tau describe <dir>                 what a tau takes, as JSON",
	"       tau run <dir> [call] [--adaptor <name>] [--json]",
	"                                          run a tau, wait for it, and print its final text",
	"       tau start <dir> [call] [--adaptor <name>]",
	"                                          start a run, and print its id",
	"       tau finish <run> [--json]          wait for a run's result, put its outputs, and print its",
	"                                          final text; the run is kept, and may finish again",
	"       tau release <run>                  drop a run, stopping it if it has not ended",
	"       tau wait <run> [--json]            finish a run, then release it",
	"",
	"A call is JSON, {\"files\": {...}, \"args\": {...}}: --call <file>, - for stdin, or --call-json '<json>'.",
	"Its paths are relative to the working directory. Without one, the call is {}.",
	"--json prints how the run ended, {ok, text, failure}, as JSON.",
].join("\n");

/** What the command reads and writes, and what it runs on. */
export interface CliContext {
	readonly cwd: string;
	readonly env: { readonly [name: string]: string | undefined };
	readonly stdin: AsyncIterable<Uint8Array | string>;
	readonly stdout: (text: string) => void;
	readonly stderr: (text: string) => void;
	/** The wire adaptors, by name; by default {@link defaultAdaptors}. */
	readonly adaptors?: { readonly [name: string]: WireAdaptor };
	/** Where runs are kept between commands; by default files in the state directory. */
	readonly runs?: RunStore;
}

/** Where the command keeps its state: `$TAU_STATE_DIR`, or `tau` in `$XDG_STATE_HOME`, or in `~/.local/state`. */
export function stateDir(env: CliContext["env"]): string {
	if (env.TAU_STATE_DIR) return env.TAU_STATE_DIR;
	return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "tau");
}

/** The wire adaptors built into tau, each made here, none loaded by name. */
export function defaultAdaptors(state: string): { readonly [name: string]: WireAdaptor } {
	return { dummy: createDummyAdaptor({ spool: path.join(state, "dummy") }) };
}

/** Run the command line `argv`, without the program; gives its exit code. */
export async function main(argv: readonly string[], context: CliContext): Promise<number> {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(argv);
	} catch (error) {
		context.stderr(`tau: ${messageOf(error)}\n${USAGE}\n`);
		return 2;
	}
	const { values, positionals } = parsed;
	const [command, target, ...rest] = positionals;
	if (values.help === true) {
		context.stdout(`${USAGE}\n`);
		return 0;
	}
	const arity: Readonly<Record<string, number>> = { check: 1, describe: 1, run: 1, start: 1, finish: 1, release: 1, wait: 1 };
	if (command === undefined || arity[command] === undefined || target === undefined || rest.length > 0) {
		context.stderr(`${USAGE}\n`);
		return 2;
	}
	const state = stateDir(context.env);
	try {
		const client = createClient({
			adaptors: context.adaptors ?? defaultAdaptors(state),
			adaptor: values.adaptor ?? context.env.TAU_ADAPTOR ?? "dummy",
			runs: context.runs ?? fileRunStore(path.join(state, "runs")),
		});
		const dir = path.resolve(context.cwd, target);
		const call = async (): Promise<unknown> => readCall(values, context);
		const ended = (outcome: Outcome): number => {
			if (values.json === true) context.stdout(`${JSON.stringify(outcome)}\n`);
			else {
				if (outcome.text !== "") context.stdout(outcome.text.endsWith("\n") ? outcome.text : `${outcome.text}\n`);
				if (!outcome.ok) context.stderr(`tau: the run failed: ${outcome.failure ?? "for no reason given"}\n`);
			}
			return outcome.ok ? 0 : 1;
		};
		switch (command) {
			case "check": {
				const given = values.call !== undefined || values["call-json"] !== undefined;
				if (given) client.check(dir, await call(), context.cwd);
				else loadTau(dir);
				context.stdout(`${dir}: ${given ? "the call fits the tau" : "a tau"}\n`);
				return 0;
			}
			case "describe":
				context.stdout(`${JSON.stringify(describe(dir), undefined, 2)}\n`);
				return 0;
			case "run":
				return ended(await client.run(dir, await call(), { cwd: context.cwd }));
			case "start":
				context.stdout(`${await client.start(dir, await call(), { cwd: context.cwd })}\n`);
				return 0;
			case "finish":
				return ended(await client.finish(target));
			case "wait":
				return ended(await client.wait(target));
			default:
				await client.release(target);
				return 0;
		}
	} catch (error) {
		context.stderr(`tau: ${messageOf(error)}\n`);
		return 1;
	}
}

function parse(argv: readonly string[]) {
	return parseArgs({
		args: [...argv],
		allowPositionals: true,
		strict: true,
		options: {
			call: { type: "string" },
			"call-json": { type: "string" },
			adaptor: { type: "string" },
			json: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
}

async function readCall(values: ReturnType<typeof parse>["values"], context: CliContext): Promise<unknown> {
	if (values.call !== undefined && values["call-json"] !== undefined) throw new Error("give a call once: --call or --call-json");
	let text: string;
	if (values["call-json"] !== undefined) text = values["call-json"];
	else if (values.call === "-") {
		text = "";
		for await (const chunk of context.stdin) text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
	} else if (values.call !== undefined) text = await readFile(path.resolve(context.cwd, values.call), "utf8");
	else return {};
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`the call is not JSON: ${messageOf(error)}`);
	}
}

/** What a tau takes, and what it needs, for whoever runs it. */
function describe(dir: string): object {
	const tau = loadTau(dir);
	return {
		dir: tau.dir,
		...(tau.description === undefined ? {} : { description: tau.description }),
		files: tau.files,
		...(tau.args === undefined ? {} : { args: tau.args }),
		apis: tau.apis.map(({ alias, contract, version, description }) => ({ alias, contract, version, description })),
		exposes: tau.exposed.map(({ specifier }) => specifier),
		skills: tau.skills.map(({ name }) => name),
		...(tau.init === undefined ? {} : { init: tau.init }),
	};
}
