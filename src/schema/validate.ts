// Copied from fyona packages/fbox-host/src/validate.ts at commit 008a6f5; keep in step until fyona uses this package.
import { type JsonValue, matchesType, type Primitive, REF_PREFIX, type SchemaNode } from "./service-schema.js";

/**
 * Validates JSON against a canonical schema node and returns a copy holding only what the schema
 * declares, so the other side sees the declared data and nothing else:
 * - an object type keeps its declared properties and drops the rest, unless it declares a record
 *   type for them (or declares no properties at all, which prints as a record of `unknown`);
 * - a union keeps the shape of the matching member that declares most of the value's keys
 *   (the first such member).
 *
 * Written for the canonical subset rather than delegated to a general validator, because the value
 * comes from a box and the cost must not depend on how the value was built: a general validator
 * retries every union member on every level, which is exponential in the nesting depth
 * (docs/experiment_journal/typebox-1-json-schema.md). Here each (schema node, value) pair is
 * checked once, so the work is linear in the value's size times the schema's. Only own properties
 * count, and a `__proto__` key is refused anywhere, since a handler copying the value with
 * `Object.assign` would set a prototype with it.
 *
 * Callers pass plain JSON (parsed, or a JSON snapshot) no deeper than the contract's depth limit.
 */

export type Decoded =
	| { readonly ok: true; readonly value: JsonValue }
	| { readonly ok: false; readonly path: string; readonly message: string };

type JsonObject = { readonly [key: string]: JsonValue };

/** What a Run needs from its Decoder, prepared once per schema. */
interface Prepared {
	readonly defs: ReadonlyMap<string, SchemaNode>;
	readonly patterns: ReadonlyMap<string, RegExp>;
	readonly enums: ReadonlyMap<SchemaNode, ReadonlySet<Primitive>>;
}

export class Decoder {
	readonly #root: SchemaNode;
	readonly #prepared: Prepared;

	constructor(root: SchemaNode, defs: ReadonlyMap<string, SchemaNode>) {
		this.#root = root;
		const patterns = new Map<string, RegExp>();
		const enums = new Map<SchemaNode, ReadonlySet<Primitive>>();
		const seen = new Set<SchemaNode>();
		const collect = (node: SchemaNode): void => {
			if (seen.has(node)) return;
			seen.add(node);
			// Compiled once; every pattern was checked to compile when the service was made.
			if (node.pattern !== undefined && !patterns.has(node.pattern))
				patterns.set(node.pattern, new RegExp(node.pattern, "u"));
			if (node.enum !== undefined) enums.set(node, new Set(node.enum));
			for (const child of children(node)) collect(child);
		};
		collect(root);
		for (const def of defs.values()) collect(def);
		this.#prepared = { defs, patterns, enums };
	}

	decode(value: JsonValue): Decoded {
		const protoPath = protoKeyPath(value);
		if (protoPath !== undefined) return { ok: false, path: protoPath, message: "must not have a __proto__ property" };
		const run = new Run(this.#prepared);
		return run.matches(this.#root, value)
			? { ok: true, value: run.copy(this.#root, value) }
			: { ok: false, ...run.explain(this.#root, value, "") };
	}
}

/** One decode, with its memo of checked (node, value) pairs. */
class Run {
	readonly #prepared: Prepared;
	readonly #memo = new WeakMap<object, Map<SchemaNode, boolean>>();

	constructor(prepared: Prepared) {
		this.#prepared = prepared;
	}

	/** The node a reference chain ends at (`type A = B` is a reference to a reference); cycles were refused. */
	#resolve(node: SchemaNode): SchemaNode {
		let resolved = node;
		while (resolved.$ref !== undefined)
			resolved = this.#prepared.defs.get(resolved.$ref.slice(REF_PREFIX.length)) as SchemaNode;
		return resolved;
	}

	matches(schema: SchemaNode, value: JsonValue): boolean {
		const node = this.#resolve(schema);
		if (typeof value !== "object" || value === null) return this.#check(node, value);
		let seen = this.#memo.get(value);
		if (seen === undefined) {
			seen = new Map();
			this.#memo.set(value, seen);
		}
		const known = seen.get(node);
		if (known !== undefined) return known;
		const result = this.#check(node, value);
		seen.set(node, result);
		return result;
	}

	#check(node: SchemaNode, value: JsonValue): boolean {
		if (node.anyOf !== undefined) return node.anyOf.some((member) => this.matches(member, value));
		if (node.const !== undefined && value !== node.const) return false;
		if (
			node.enum !== undefined &&
			!(this.#prepared.enums.get(node) as ReadonlySet<Primitive>).has(value as Primitive)
		) {
			return false;
		}
		if (node.type === undefined) return true;
		if (!matchesType(value, node.type)) return false;
		switch (node.type) {
			case "string":
				return this.#string(node, value as string) === undefined;
			case "number":
			case "integer":
				return bounds(node, value as number) === undefined;
			case "array":
				return this.#array(node, value as readonly JsonValue[]) === undefined;
			case "object":
				return this.#object(node, value as JsonObject) === undefined;
			default:
				return true;
		}
	}

	/** Why a string fails its constraints, or undefined. */
	#string(node: SchemaNode, value: string): string | undefined {
		if (node.minLength !== undefined || node.maxLength !== undefined) {
			// JSON Schema counts code points, not UTF-16 units.
			const length = [...value].length;
			if (node.minLength !== undefined && length < node.minLength)
				return `must have at least ${node.minLength} characters`;
			if (node.maxLength !== undefined && length > node.maxLength)
				return `must have at most ${node.maxLength} characters`;
		}
		if (node.pattern !== undefined && !(this.#prepared.patterns.get(node.pattern) as RegExp).test(value)) {
			return `must match ${node.pattern}`;
		}
		return undefined;
	}

	/** Why an array fails, as the index of the failing item or a message, or undefined. */
	#array(node: SchemaNode, value: readonly JsonValue[]): number | string | undefined {
		if (node.minItems !== undefined && value.length < node.minItems) return `must have at least ${node.minItems} items`;
		if (node.maxItems !== undefined && value.length > node.maxItems) return `must have at most ${node.maxItems} items`;
		for (let index = 0; index < value.length; index++) {
			const item = itemSchema(node, index);
			if (item === undefined) return `must have at most ${index} items`;
			if (!this.matches(item, value[index] as JsonValue)) return index;
		}
		return undefined;
	}

	/** Why an object fails, as the key of the failing property or a message, or undefined. */
	#object(node: SchemaNode, value: JsonObject): { key: string } | string | undefined {
		const required = node.required ?? [];
		const keys = Object.keys(value);
		for (const name of required) if (!Object.hasOwn(value, name)) return `must have property ${name}`;
		for (const key of keys) {
			const schema = propertySchema(node, key);
			if (schema === false) return `must not have property ${key}`;
			if (!this.matches(schema, value[key] as JsonValue)) return { key };
		}
		return undefined;
	}

	/** The value as the schema declares it; call only after `matches` returned true. */
	copy(schema: SchemaNode, value: JsonValue): JsonValue {
		const node = this.#resolve(schema);
		if (node.anyOf !== undefined) return this.copy(this.#chosenMember(node.anyOf, value), value);
		if (node.type === "array") {
			return (value as readonly JsonValue[]).map((item, index) =>
				this.copy(itemSchema(node, index) as SchemaNode, item),
			);
		}
		if (node.type === "object") {
			const out: Record<string, JsonValue> = {};
			for (const [key, item] of Object.entries(value as JsonObject)) {
				const schemaFor = propertySchema(node, key);
				// A key the type does not declare is not part of it: dropped.
				if (schemaFor !== false && schemaFor !== DROPPED) out[key] = this.copy(schemaFor, item);
			}
			return out;
		}
		return value;
	}

	/**
	 * The member a union's copy follows: of the members the value matches, the one declaring most
	 * of its keys (the first on a tie), so an overlapping union loses as little as it can.
	 */
	#chosenMember(members: readonly SchemaNode[], value: JsonValue): SchemaNode {
		let best: SchemaNode | undefined;
		let bestScore = -1;
		for (const member of members) {
			if (!this.matches(member, value)) continue;
			const node = this.#resolve(member);
			const score =
				node.type === "object" && typeof value === "object" && value !== null && !Array.isArray(value)
					? Object.keys(value).filter((key) => {
							const kept = propertySchema(node, key);
							return kept !== false && kept !== DROPPED;
						}).length
					: 0;
			if (score > bestScore) {
				best = member;
				bestScore = score;
			}
		}
		return best as SchemaNode;
	}

	/** Where and why `value` fails `schema`, following one failing path; call only after `matches` returned false. */
	explain(schema: SchemaNode, value: JsonValue, path: string): { path: string; message: string } {
		const node = this.#resolve(schema);
		if (node.anyOf !== undefined) {
			const literals = node.anyOf.map((member) => this.#resolve(member).const);
			const allowed = literals.every((literal) => literal !== undefined)
				? literals.map((literal) => JSON.stringify(literal)).join(", ")
				: undefined;
			return {
				path,
				message: allowed === undefined ? `must match one of ${node.anyOf.length} types` : `must be one of ${allowed}`,
			};
		}
		if (node.const !== undefined && value !== node.const)
			return { path, message: `must be ${JSON.stringify(node.const)}` };
		if (
			node.enum !== undefined &&
			!(this.#prepared.enums.get(node) as ReadonlySet<Primitive>).has(value as Primitive)
		) {
			const shown = node.enum.slice(0, 10).map((item) => JSON.stringify(item));
			return { path, message: `must be one of ${shown.join(", ")}${node.enum.length > 10 ? ", …" : ""}` };
		}
		if (node.type !== undefined && !matchesType(value, node.type)) return { path, message: `must be ${node.type}` };
		switch (node.type) {
			case "string":
				return { path, message: this.#string(node, value as string) ?? "is invalid" };
			case "number":
			case "integer":
				return { path, message: bounds(node, value as number) ?? "is invalid" };
			case "array": {
				const failure = this.#array(node, value as readonly JsonValue[]);
				if (typeof failure !== "number") return { path, message: failure ?? "is invalid" };
				const item = itemSchema(node, failure) as SchemaNode;
				return this.explain(item, (value as readonly JsonValue[])[failure] as JsonValue, `${path}/${failure}`);
			}
			case "object": {
				const failure = this.#object(node, value as JsonObject);
				if (typeof failure !== "object") return { path, message: failure ?? "is invalid" };
				const item = propertySchema(node, failure.key) as SchemaNode;
				return this.explain(item, (value as JsonObject)[failure.key] as JsonValue, `${path}/${failure.key}`);
			}
			default:
				return { path, message: "is invalid" };
		}
	}
}

/** Any value, not kept: an undeclared property of an open object that declares properties. */
const DROPPED: SchemaNode = Object.freeze({});
/** Any value, kept: a property of an object that declares none (it prints as a record of `unknown`). */
const ANY: SchemaNode = Object.freeze({});

/** The schema of an array item, or undefined when the array may not have that item. */
function itemSchema(node: SchemaNode, index: number): SchemaNode | undefined {
	const item = node.prefixItems === undefined ? node.items : node.prefixItems[index];
	return item === false ? undefined : (item ?? ANY);
}

/** The schema of an object's property: declared, the record type, refused (`false`), or dropped. */
function propertySchema(node: SchemaNode, key: string): SchemaNode | false {
	const properties = node.properties ?? {};
	if (Object.hasOwn(properties, key)) return properties[key] as SchemaNode;
	const additional = node.additionalProperties;
	if (additional === false) return false;
	if (typeof additional === "object") return additional;
	return Object.keys(properties).length === 0 ? ANY : DROPPED;
}

function bounds(node: SchemaNode, value: number): string | undefined {
	if (node.minimum !== undefined && value < node.minimum) return `must be >= ${node.minimum}`;
	if (node.maximum !== undefined && value > node.maximum) return `must be <= ${node.maximum}`;
	if (node.exclusiveMinimum !== undefined && value <= node.exclusiveMinimum)
		return `must be > ${node.exclusiveMinimum}`;
	if (node.exclusiveMaximum !== undefined && value >= node.exclusiveMaximum)
		return `must be < ${node.exclusiveMaximum}`;
	return undefined;
}

function children(node: SchemaNode): SchemaNode[] {
	return [
		...(node.anyOf ?? []),
		...(node.prefixItems ?? []),
		...(typeof node.items === "object" ? [node.items] : []),
		...Object.values(node.properties ?? {}),
		...(typeof node.additionalProperties === "object" ? [node.additionalProperties] : []),
	];
}

/** The path of the first `__proto__` own property in `root`, if any. Iterative. */
function protoKeyPath(root: JsonValue): string | undefined {
	const pending: [JsonValue, string][] = [[root, ""]];
	while (pending.length > 0) {
		const [value, path] = pending.pop() as [JsonValue, string];
		if (typeof value !== "object" || value === null) continue;
		if (Array.isArray(value)) {
			for (const [index, item] of value.entries()) pending.push([item, `${path}/${index}`]);
			continue;
		}
		if (Object.hasOwn(value, "__proto__")) return path;
		for (const [key, item] of Object.entries(value)) pending.push([item, `${path}/${key}`]);
	}
	return undefined;
}
