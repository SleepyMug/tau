import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { PACKAGE_NAME, rangeVersion } from "./apis.js";
import { type FileDeclaration, type Json, KINDS, type Kind, MODES, type Mode, NAME, SELF } from "./model.js";
import { isObject, messageOf, refuseKeys } from "./util.js";

/** `tau.json`, read and checked (docs/spec/metadata.md). */
export interface Metadata {
	readonly description: string | undefined;
	readonly files: { readonly [name: string]: FileDeclaration };
	readonly args: { readonly [keyword: string]: Json } | undefined;
	/** What checks args against `args`; undefined when the tau takes none. */
	readonly validate: ValidateFunction | undefined;
	/** The APIs, from each contract's name to a range: `^` and a version. */
	readonly apis: { readonly [name: string]: string } | undefined;
	readonly exposes: readonly string[] | undefined;
	readonly init: string | undefined;
}

/** What `exposes` lists: a package's name, scoped or not, as programs import it. */
const PACKAGE = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/u;

/** The tau.json at `file`. Throws, naming the file and the reason, when it breaks the spec. */
export function readMetadata(file: string): Metadata {
	try {
		let json: unknown;
		try {
			json = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			throw new TypeError(`is not JSON: ${messageOf(error)}`);
		}
		if (!isObject(json)) throw new TypeError("must be an object");
		const { description, files = {}, args, apis, exposes, init, ...rest } = json;
		refuseKeys(rest, "tau.json");
		if (description !== undefined && typeof description !== "string")
			throw new TypeError("`description` must be a string");
		if (!isObject(files)) throw new TypeError("`files` must be an object, from each file's name to what it is");
		if (apis !== undefined && !isObject(apis)) throw new TypeError("`apis` must be an object, from each contract's name to a range");
		for (const [name, range] of Object.entries(apis ?? {})) {
			if (!PACKAGE_NAME.test(name) || name.length > 214) throw new TypeError(`\`apis\`: ${JSON.stringify(name)} is not a contract's name, an npm package's`);
			if (typeof range !== "string" || rangeVersion(range) === undefined)
				throw new TypeError(`\`apis\`: ${name}: ${JSON.stringify(range)} is not a range, ^ and a SemVer version, as ^1.2.0`);
		}
		if (exposes !== undefined && !Array.isArray(exposes)) throw new TypeError("`exposes` must be an array");
		if (init !== undefined && (typeof init !== "string" || init.trim() === ""))
			throw new TypeError("`init` must be a command, a string that is not blank");

		const declared: { [name: string]: FileDeclaration } = {};
		for (const [name, value] of Object.entries(files)) {
			checkName(name, "`files`", "a file");
			declared[name] = readDeclaration(value, `\`files\`: ${name}`);
		}
		const validate = args === undefined ? undefined : readSchema(args, declared);

		const exposed = new Set<string>();
		for (const specifier of exposes ?? []) {
			if (typeof specifier !== "string" || !PACKAGE.test(specifier))
				throw new TypeError(`\`exposes\`: ${JSON.stringify(specifier)} is not a package's name`);
			if (exposed.has(specifier)) throw new TypeError(`\`exposes\` lists ${specifier} twice`);
			exposed.add(specifier);
		}

		return {
			description,
			files: declared,
			args: args as { [keyword: string]: Json } | undefined,
			validate,
			apis: apis as { readonly [name: string]: string } | undefined,
			exposes: exposes === undefined ? undefined : [...exposed],
			init,
		};
	} catch (error) {
		throw new Error(`${file}: ${messageOf(error)}`);
	}
}

/** Refuses a name that a file, or an arg the schema declares, cannot have. */
function checkName(name: string, where: string, what: string): void {
	if (!NAME.test(name)) throw new TypeError(`${where}: ${JSON.stringify(name)} is not ${what}'s name, which matches ${NAME.source}`);
	if (name === SELF) throw new TypeError(`${where}: \`${SELF}\` names the tau's own directory, so ${what} cannot have that name`);
}

/** A file as tau.json declares it at `at`. */
function readDeclaration(value: unknown, at: string): FileDeclaration {
	if (!isObject(value)) throw new TypeError(`${at} must be an object, with its \`mode\` and \`description\``);
	const { mode, kind, description, ...rest } = value;
	refuseKeys(rest, at);
	if (mode === undefined) throw new TypeError(`${at}: needs a \`mode\`, one of ${MODES.join(", ")}`);
	if (typeof mode !== "string" || !(MODES as readonly string[]).includes(mode))
		throw new TypeError(`${at}: \`mode\` ${JSON.stringify(mode)} is not one of ${MODES.join(", ")}`);
	if (kind !== undefined && (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)))
		throw new TypeError(`${at}: \`kind\` ${JSON.stringify(kind)} is not one of ${KINDS.join(", ")}`);
	if (typeof description !== "string" || description.trim() === "")
		throw new TypeError(`${at}: needs a \`description\`, saying what it is`);
	return { mode: mode as Mode, ...(kind === undefined ? {} : { kind: kind as Kind }), description };
}

/**
 * `args` as tau.json declares it: a JSON Schema, draft 2020-12, of an object, that JSON Schema's
 * meta-schema takes, with no keyword the draft does not define, and every `$ref` resolved in it;
 * its top-level properties named as files are, and none a file's. Gives what checks args against it.
 */
function readSchema(args: unknown, files: { readonly [name: string]: FileDeclaration }): ValidateFunction {
	if (!isObject(args) || args.type !== "object")
		throw new TypeError('`args` must be a JSON Schema of an object, whose `type` is "object"');
	if (args.properties !== undefined && isObject(args.properties))
		for (const name of Object.keys(args.properties)) {
			checkName(name, "`args`", "an arg");
			if (Object.hasOwn(files, name)) throw new TypeError(`\`args\`: ${name} is a file's name, which no arg has`);
		}
	// Formats say what a string is, and are not checked, as draft 2020-12 has it by default.
	const ajv = new Ajv2020({ allErrors: true, strictSchema: true, strictTypes: false, strictTuples: false, strictRequired: false, validateFormats: false });
	try {
		return ajv.compile(args);
	} catch (error) {
		throw new TypeError(`\`args\` is not a JSON Schema the spec takes: ${messageOf(error)}`);
	}
}
