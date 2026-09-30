import {
	type CanonicalFunction,
	type CanonicalService,
	canonicalService,
	type JsonSchema,
	type JsonValue,
	type SchemaNode,
	type ServiceSchema,
	type Value,
} from "./schema/service-schema.js";
import { Decoder, type Form } from "./schema/validate.js";

/**
 * A service's calls, as runtimes and providers handle them (SPEC.md, Calls): checked against the
 * manifest, reduced to what it declares, and carried between the wire, where bytes are base64,
 * and the values programs and providers hold, where bytes are a Uint8Array. Every method throws
 * TypeError naming the function, and the parameter or the result, when the call does not fit.
 *
 * It needs only the service's canonical schema, so a process that does not load TypeScript, such
 * as a runtime's side of the socket in a container, can have one: `serviceCodec(service.schema)`,
 * from `@sleepymug/tau/codec`.
 */
export interface Codec {
	readonly name: string;
	readonly description: string | undefined;
	/** Function names, in manifest order. */
	readonly functions: readonly string[];
	/** The service's canonical JSON Schema, as plain JSON: what `serviceCodec` takes. */
	readonly schema: ServiceSchema;
	/** Arguments from the wire, for the wire: what a relay passes on. */
	checkArguments(fn: string, args: readonly JsonValue[]): JsonValue[];
	/** A result from the wire, for the wire; null for a function without a result. */
	checkResult(fn: string, result: JsonValue): JsonValue;
	/** A program's arguments, for the wire. */
	encodeArguments(fn: string, args: readonly Value[]): JsonValue[];
	/** Arguments from the wire, as the provider takes them. */
	decodeArguments(fn: string, args: readonly JsonValue[]): Value[];
	/** A provider's result, for the wire; null for a function without a result. */
	encodeResult(fn: string, result: Value): JsonValue;
	/** A result from the wire, as the program takes it; null for a function without a result. */
	decodeResult(fn: string, result: JsonValue): Value;
}

interface CompiledFunction {
	readonly params: readonly string[];
	/** Parameters that must be passed; the rest are optional and trailing. */
	readonly required: number;
	readonly args: Decoder;
	/** Undefined for a function that returns nothing. */
	readonly result: Decoder | undefined;
}

/** The codec of a service's canonical schema, which is checked first; throws TypeError. */
export function serviceCodec(schema: ServiceSchema): Codec {
	return codecOf(canonicalService(schema));
}

/** The codec of a checked service. */
export function codecOf(canonical: CanonicalService): Codec {
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
	const callArguments = (fnName: string, args: readonly unknown[], from: Form, to: Form): Value[] => {
		const { params, required, args: decoder } = lookup(fnName);
		if (args.length < required || args.length > params.length) {
			const expected = required === params.length ? `${required}` : `${required} to ${params.length}`;
			throw new TypeError(`${name}.${fnName}: expected ${expected} arguments, got ${args.length}`);
		}
		const decoded = decoder.decode(args, from, to);
		if (decoded.ok) return decoded.value as Value[];
		// `/1/owner` becomes `repo/owner`.
		const at = decoded.path.replace(/^\/(\d+)/u, (whole, index: string) => params[Number(index)] ?? whole);
		throw new TypeError(`${name}.${fnName}: ${at || "arguments"}: ${decoded.message}`);
	};
	const callResult = (fnName: string, result: unknown, from: Form, to: Form): Value => {
		const decoder = lookup(fnName).result;
		if (decoder === undefined) return null;
		const decoded = decoder.decode(result, from, to);
		if (decoded.ok) return decoded.value;
		throw new TypeError(
			`${name}.${fnName}: the result does not match the manifest: ${decoded.path || "result"}: ${decoded.message}`,
		);
	};
	return {
		name,
		description: canonical.description,
		functions: [...compiled.keys()],
		schema: schemaOf(canonical),
		checkArguments: (fnName, args) => callArguments(fnName, args, "wire", "wire") as JsonValue[],
		checkResult: (fnName, result) => callResult(fnName, result, "wire", "wire") as JsonValue,
		encodeArguments: (fnName, args) => callArguments(fnName, args, "value", "wire") as JsonValue[],
		decodeArguments: (fnName, args) => callArguments(fnName, args, "wire", "value"),
		encodeResult: (fnName, result) => callResult(fnName, result, "value", "wire") as JsonValue,
		decodeResult: (fnName, result) => callResult(fnName, result, "wire", "value"),
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

/** A checked service as plain JSON, which `canonicalService` takes back unchanged. */
function schemaOf(canonical: CanonicalService): ServiceSchema {
	// Canonical nodes are plain, frozen JSON objects.
	const json = (node: SchemaNode): JsonSchema => node as unknown as JsonSchema;
	return {
		name: canonical.name,
		...(canonical.description === undefined ? {} : { description: canonical.description }),
		...(canonical.defs.size === 0
			? {}
			: { $defs: Object.fromEntries([...canonical.defs].map(([defName, node]) => [defName, json(node)])) }),
		functions: Object.fromEntries(
			[...canonical.functions].map(([fnName, fn]) => [
				fnName,
				{
					...(fn.description === undefined ? {} : { description: fn.description }),
					params: fn.params.map((param) => ({
						name: param.name,
						...(param.description === undefined ? {} : { description: param.description }),
						...(param.optional ? { optional: true } : {}),
						schema: json(param.schema),
					})),
					...(fn.result === undefined ? {} : { result: json(fn.result) }),
				},
			]),
		),
	};
}
