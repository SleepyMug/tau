import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createDummyAdaptor } from "../adaptors/dummy.js";
import { createFleetAdaptor } from "../adaptors/fleet.js";
import { defaultFleetSocket, fleetSocket } from "../adaptors/fleet-socket.js";
import type { WireAdaptor } from "../client/adaptor.js";
import { createClient } from "../client/client.js";
import { traceLines } from "../client/trace.js";
import { fileRunStore, type RunStore } from "../client/store.js";
import type { Outcome, Status, Trace } from "../core/model.js";
import { loadTau } from "../core/tau.js";
import { messageOf } from "../core/util.js";
import { addApi, removeApi, syncApis } from "./api.js";
import { type CliConfig, configFile, loadConfig } from "./config.js";

/** The `tau` command (docs/spec/client.md#the-tau-command). */

const USAGE = [
	"usage: tau check <dir> [call]             check a tau, and a call of it, without running it",
	"       tau describe <dir>                 what a tau takes, as JSON",
	"       tau run <dir> [call] [--adaptor <name>] [--json] [--trace <file>]",
	"                                          run a tau, wait for it, and print its final text",
	"       tau start <dir> [call] [--adaptor <name>]",
	"                                          start a run, and print its id",
	"       tau status <run> [--json]          whether a run is running or ended, and how its latest result ended",
	"       tau result <run> [--json]          put the outputs of a run's latest result, and print its final",
	"                                          text, at once; the run is kept",
	"       tau trace <run>                    print what a run's agent did so far: a line of JSON naming its",
	"                                          format, then each event, a line each",
	"       tau finish <run> [--json]          wait for a run's result, put its outputs, and print its",
	"                                          final text; the run is kept, and may finish again",
	"       tau release <run>                  drop a run, stopping it if it has not ended",
	"       tau wait <run> [--json] [--trace <file>]",
	"                                          finish a run, then release it",
	"       tau api add <name>[@<range>] [--from <source>] [dir]",
	"                                          pull an API's contract into the tau's .tau/, and name it",
	"                                          in its apis: from npm, the default, an adaptor, or a path",
	"       tau api remove <name> [dir]        take an API out of the tau, and its contract out of .tau/",
	"       tau api sync [dir]                 pull each API's contract .tau/ lacks, from where it came",
	"",
	"A call is JSON, {\"files\": {...}, \"args\": {...}}: --call <file>, - for stdin, or --call-json '<json>'.",
	"Its paths are relative to the working directory. Without one, the call is {}.",
	"--json prints how the run ended, {ok, text, failure}, as JSON, with result's number for result, and the",
	"status itself for status.",
	"--trace writes the run's trace to the file, as tau trace prints it, once it finished, before it is released.",
	"",
	"A run goes through --adaptor, or $TAU_ADAPTOR, or the config's adaptor, or dummy: dummy, a dry run in",
	"this process, or fleet, the fleet service, at $TAU_FLEET_SOCKET, or the config's, or fleet/tau.sock in",
	"the dsh home. Interrupting run releases the run; interrupting finish or wait stops the waiting.",
	"",
	"The config is YAML, at $TAU_CONFIG, or tau/config.yaml in $XDG_CONFIG_HOME, or in ~/.config:",
	"  adaptor: fleet",
	"  adaptors:",
	"    fleet: { socket: ~/.dsh/fleet/tau.sock }",
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
	/** What reaches the npm registry, for `tau api`; by default the global `fetch`. */
	readonly fetch?: typeof fetch;
	/** Aborted when the command is interrupted: a run started by `run` is released, and `finish` and `wait` stop waiting. */
	readonly signal?: AbortSignal;
}

/** Where the command keeps its state: `$TAU_STATE_DIR`, or `tau` in `$XDG_STATE_HOME`, or in `~/.local/state`. */
export function stateDir(env: CliContext["env"]): string {
	if (env.TAU_STATE_DIR) return env.TAU_STATE_DIR;
	return path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "tau");
}

/**
 * The wire adaptors built into tau, each made here, none loaded by name: `dummy`, and `fleet`, at
 * the fleet service's socket, `$TAU_FLEET_SOCKET`, or the config's, or the dsh home's, its runs'
 * sessions in the dsh workspace of `cwd`.
 */
export function defaultAdaptors(state: string, env: CliContext["env"], cwd: string, config: CliConfig = { adaptors: {} }): { readonly [name: string]: WireAdaptor } {
	const configured = config.adaptors.fleet?.socket;
	const socket = (env.TAU_FLEET_SOCKET ?? "").trim() === "" && configured !== undefined ? configured : defaultFleetSocket(env);
	return {
		dummy: createDummyAdaptor({ spool: path.join(state, "dummy") }),
		fleet: createFleetAdaptor({ transport: fleetSocket(socket), project: path.resolve(cwd) }),
	};
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
	if (command === "api") return api(target, rest, values.from, context);
	if (values.from !== undefined) {
		context.stderr(`tau: --from is tau api add's\n${USAGE}\n`);
		return 2;
	}
	const arity: Readonly<Record<string, number>> = { check: 1, describe: 1, run: 1, start: 1, status: 1, result: 1, trace: 1, finish: 1, release: 1, wait: 1 };
	if (command === undefined || arity[command] === undefined || target === undefined || rest.length > 0 || (values.trace !== undefined && command !== "run" && command !== "wait")) {
		context.stderr(`${USAGE}\n`);
		return 2;
	}
	const state = stateDir(context.env);
	try {
		const config = await loadConfig(configFile(context.env));
		const client = createClient({
			adaptors: context.adaptors ?? defaultAdaptors(state, context.env, context.cwd, config),
			adaptor: values.adaptor ?? context.env.TAU_ADAPTOR ?? config.adaptor ?? "dummy",
			runs: context.runs ?? fileRunStore(path.join(state, "runs")),
		});
		const dir = path.resolve(context.cwd, target);
		const call = async (): Promise<unknown> => readCall(values, context);
		const signal = context.signal === undefined ? {} : { signal: context.signal };
		const ended = (outcome: Outcome): number => {
			if (values.json === true) context.stdout(`${JSON.stringify(outcome)}\n`);
			else {
				if (outcome.text !== "") context.stdout(outcome.text.endsWith("\n") ? outcome.text : `${outcome.text}\n`);
				if (!outcome.ok) context.stderr(`tau: the run failed: ${outcome.failure ?? "for no reason given"}\n`);
			}
			return outcome.ok ? 0 : 1;
		};
		const tracing =
			values.trace === undefined
				? {}
				: {
						trace: async (trace: Trace) => {
							const file = path.resolve(context.cwd, values.trace as string);
							await mkdir(path.dirname(file), { recursive: true });
							await writeFile(file, traceLines(trace));
						},
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
				return ended(await client.run(dir, await call(), { cwd: context.cwd, ...signal, ...tracing }));
			case "start":
				context.stdout(`${await client.start(dir, await call(), { cwd: context.cwd })}\n`);
				return 0;
			case "status": {
				const status = await client.status(target, signal);
				context.stdout(`${values.json === true ? JSON.stringify(status) : said(status)}\n`);
				return 0;
			}
			case "result": {
				const { result, ...outcome } = await client.result(target, signal);
				if (values.json === true) {
					context.stdout(`${JSON.stringify({ result, ...outcome })}\n`);
					return outcome.ok ? 0 : 1;
				}
				return ended(outcome);
			}
			case "trace":
				context.stdout(traceLines(await client.trace(target, signal)));
				return 0;
			case "finish":
				return ended(await client.finish(target, signal));
			case "wait":
				return ended(await client.wait(target, { ...signal, ...tracing }));
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
			from: { type: "string" },
			json: { type: "boolean" },
			trace: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
}

/** A status as `tau status` prints it. */
function said(status: Status): string {
	if (status.state === "running") return "running";
	const how = status.ok ? "succeeded" : `failed: ${status.failure ?? "for no reason given"}`;
	return `ended: result ${status.result} ${how}`;
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

/** `tau api <command> …`, in the working directory's tau unless one is named. */
async function api(command: string | undefined, args: readonly string[], from: string | undefined, context: CliContext): Promise<number> {
	const takes: Readonly<Record<string, [number, number]>> = { add: [1, 2], remove: [1, 2], sync: [0, 1] };
	const [least, most] = takes[command ?? ""] ?? [-1, -1];
	if (args.length < least || args.length > most || (from !== undefined && command !== "add")) {
		context.stderr(`${USAGE}\n`);
		return 2;
	}
	const named = command === "sync" ? args[0] : args[1];
	const dir = path.resolve(context.cwd, named ?? ".");
	try {
		const config = await loadConfig(configFile(context.env));
		const apiContext = {
			adaptors: context.adaptors ?? defaultAdaptors(stateDir(context.env), context.env, context.cwd, config),
			env: context.env,
			...(context.fetch === undefined ? {} : { fetch: context.fetch }),
			...(context.signal === undefined ? {} : { signal: context.signal }),
		};
		const said =
			command === "add"
				? await addApi(dir, args[0] as string, from, context.cwd, apiContext)
				: command === "remove"
					? await removeApi(dir, args[0] as string)
					: await syncApis(dir, apiContext);
		context.stdout(`${said}\n`);
		return 0;
	} catch (error) {
		context.stderr(`tau: ${messageOf(error)}\n`);
		return 1;
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
		apis: Object.fromEntries(tau.apis.map(({ name, range }) => [name, range])),
		exposes: tau.exposed.map(({ specifier }) => specifier),
		skills: tau.skills.map(({ name }) => name),
		...(tau.init === undefined ? {} : { init: tau.init }),
	};
}
