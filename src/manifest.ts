import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { printDeclarations } from "./schema/declarations.js";
import {
	type CanonicalFunction,
	type CanonicalService,
	canonicalService,
	type JsonValue,
	type SchemaNode,
	type ServiceSchema,
} from "./schema/service-schema.js";
import { Decoder } from "./schema/validate.js";
import { readManifest } from "./read-manifest.js";
import { verifyTranslation } from "./verify.js";

/** Names the socket a provider serves a tau's services on (SPEC.md). */
export const TAU_SOCKET = "TAU_SOCKET";

/** A service a tau declares in `api/<name>.d.ts`, checked against the spec. */
export interface Service {
	readonly name: string;
	readonly description: string | undefined;
	/** The manifest as written: the declarations of `@svc/<name>`, e.g. for its `index.d.ts`. */
	readonly declarations: string;
	/** Function names, in manifest order. */
	readonly functions: readonly string[];
	/**
	 * A call's arguments, validated against the manifest and reduced to what it declares: what a
	 * runtime sends the provider. Throws TypeError naming the function and the parameter.
	 */
	checkArguments(fn: string, args: readonly JsonValue[]): JsonValue[];
	/**
	 * A provider's result, validated and reduced the same way; null for a function without a
	 * result. Throws TypeError.
	 */
	checkResult(fn: string, result: JsonValue): JsonValue;
}

interface CompiledFunction {
	readonly params: readonly string[];
	/** Parameters that must be passed; the rest are optional and trailing. */
	readonly required: number;
	readonly args: Decoder;
	/** Undefined for a function that returns nothing. */
	readonly result: Decoder | undefined;
}

/** Every `api/*.d.ts` of the tau at `dir`, by name; none when there is no api/. */
export function loadServices(dir: string): Service[] {
	return serviceNames(dir).map((name) => loadService(path.join(dir, "api", `${name}.d.ts`)));
}

/** The names of the services the tau at `dir` declares, sorted, without reading the manifests. */
export function serviceNames(dir: string): string[] {
	const api = path.join(dir, "api");
	if (!existsSync(api)) return [];
	return readdirSync(api)
		.filter((file) => file.endsWith(".d.ts"))
		.map((file) => file.slice(0, -".d.ts".length))
		.sort();
}

/**
 * One manifest, `<name>.d.ts`: its exported functions are the service's, and its TSDoc package
 * documentation the service's description. It is translated to JSON Schema, and refused, with the
 * reason, unless `tsc` finds the translation means exactly what the manifest says.
 */
export function loadService(file: string): Service {
	const absolute = path.resolve(file);
	const name = path.basename(absolute, ".d.ts");
	try {
		const text = readFileSync(absolute, "utf8");
		const read = readManifest(absolute, text);
		const canonical = canonicalService({
			name,
			...(read.description === undefined ? {} : { description: read.description }),
			...(Object.keys(read.$defs).length === 0 ? {} : { $defs: read.$defs }),
			functions: read.functions,
		} satisfies ServiceSchema);
		// The printed declarations only prove the translation; programs see the manifest itself.
		verifyTranslation(absolute, read, printDeclarations(canonical));
		return compile(canonical, text);
	} catch (error) {
		throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function compile(canonical: CanonicalService, declarations: string): Service {
	const { name } = canonical;
	const compiled = new Map<string, CompiledFunction>();
	for (const [fnName, fn] of canonical.functions) {
		compiled.set(fnName, {
			params: fn.params.map((param) => param.name),
			required: fn.params.filter((param) => !param.optional).length,
			args: new Decoder(argumentsSchema(fn), canonical.defs),
			result: fn.result === undefined ? undefined : new Decoder(fn.result, canonical.defs),
		});
	}
	const lookup = (fnName: string): CompiledFunction => {
		const fn = compiled.get(fnName);
		if (fn === undefined) throw new TypeError(`${name}: no function ${JSON.stringify(fnName)}`);
		return fn;
	};
	return {
		name,
		description: canonical.description,
		declarations,
		functions: [...compiled.keys()],
		checkArguments(fnName, args) {
			const { params, required, args: decoder } = lookup(fnName);
			if (args.length < required || args.length > params.length) {
				const expected = required === params.length ? `${required}` : `${required} to ${params.length}`;
				throw new TypeError(`${name}.${fnName}: expected ${expected} arguments, got ${args.length}`);
			}
			const decoded = decoder.decode(args);
			if (decoded.ok) return decoded.value as JsonValue[];
			// `/1/owner` becomes `repo/owner`.
			const at = decoded.path.replace(/^\/(\d+)/u, (whole, index: string) => params[Number(index)] ?? whole);
			throw new TypeError(`${name}.${fnName}: ${at || "arguments"}: ${decoded.message}`);
		},
		checkResult(fnName, result) {
			const decoder = lookup(fnName).result;
			if (decoder === undefined) return null;
			const decoded = decoder.decode(result);
			if (decoded.ok) return decoded.value;
			throw new TypeError(
				`${name}.${fnName}: the result does not match the manifest: ${decoded.path || "result"}: ${decoded.message}`,
			);
		},
	};
}

/** All arguments of a call as one closed tuple, so one decoder checks order and types. */
function argumentsSchema(fn: CanonicalFunction): SchemaNode {
	return {
		type: "array",
		prefixItems: fn.params.map((param) => param.schema),
		items: false,
		minItems: fn.params.filter((param) => !param.optional).length,
		maxItems: fn.params.length,
	};
}
