import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { isObject, messageOf } from "../core/util.js";

/**
 * The `tau` command's config file (docs/spec/client.md#the-config-file): YAML, which wire adaptor
 * a run goes through, and the options of the adaptors built into tau.
 */

/** What a config file says; what it leaves out, the command decides as without it. */
export interface CliConfig {
	/** The wire adaptor a run goes through, unless `--adaptor` or `$TAU_ADAPTOR` names one. */
	readonly adaptor?: string;
	/** The options of the adaptors built into tau, by name. */
	readonly adaptors: {
		readonly fleet?: {
			/** The fleet service's socket, absolute, unless `$TAU_FLEET_SOCKET` names one. */
			readonly socket?: string;
		};
	};
}

/** Where the config file is: `$TAU_CONFIG`, or `tau/config.yaml` in `$XDG_CONFIG_HOME`, or in `~/.config`. */
export function configFile(env: { readonly [name: string]: string | undefined }): string {
	if (env.TAU_CONFIG) return path.resolve(env.TAU_CONFIG);
	return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "tau", "config.yaml");
}

/**
 * Read the config file at `file`: none there, or an empty one, says nothing. A path in it is
 * relative to its folder, and a leading `~` is the user's home.
 */
export async function loadConfig(file: string): Promise<CliConfig> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { adaptors: {} };
		throw new Error(`the config ${file}: ${messageOf(error)}`);
	}
	try {
		return configOf(parse(text) ?? {}, path.dirname(file));
	} catch (error) {
		throw new Error(`the config ${file}: ${messageOf(error)}`);
	}
}

function configOf(value: unknown, dir: string): CliConfig {
	const top = fields(value, "it", ["adaptor", "adaptors"]);
	const adaptors = fields(top.adaptors ?? {}, "adaptors", ["fleet"]);
	const fleet = adaptors.fleet === undefined ? undefined : fields(adaptors.fleet, "adaptors.fleet", ["socket"]);
	const socket = fleet?.socket === undefined ? undefined : pathOf(fleet.socket, "adaptors.fleet.socket", dir);
	return {
		...(top.adaptor === undefined ? {} : { adaptor: text(top.adaptor, "adaptor") }),
		adaptors: fleet === undefined ? {} : { fleet: socket === undefined ? {} : { socket } },
	};
}

/** The fields of a mapping, which has only those `known` names. */
function fields(value: unknown, at: string, known: readonly string[]): { readonly [name: string]: unknown } {
	if (!isObject(value)) throw new Error(`${at} is not a mapping`);
	for (const name of Object.keys(value)) {
		if (!known.includes(name)) throw new Error(`${at} has no ${JSON.stringify(name)}; it has ${known.join(", ")}`);
	}
	return value;
}

function text(value: unknown, at: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${at} is not a name`);
	return value;
}

function pathOf(value: unknown, at: string, dir: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${at} is not a path`);
	const expanded = value === "~" || value.startsWith("~/") ? os.homedir() + value.slice(1) : value;
	return path.resolve(dir, expanded);
}
