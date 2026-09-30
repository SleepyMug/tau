// Copied from fyona packages/fbox-host/src/validate.ts at commit 008a6f5; keep in step until fyona uses this package.
// tau adds the two forms and bytes, which fyona does not have.
import { fromBase64, isBase64, isBytes, toBase64 } from "./bytes.js";
import {
	isBytesNode,
	type JsonValue,
	matchesType,
	type Primitive,
	REF_PREFIX,
	type SchemaNode,
	type Value,
} from "./service-schema.js";

/**
 * Validates a value against a canonical schema node and returns a copy holding only what the
 * schema declares, so the other side sees the declared data and nothing else:
 * - an object type keeps its declared properties and drops the rest, unless it declares a record
 *   type for them (or declares no properties at all, which prints as a record of `unknown`);
 * - a union keeps the shape of the matching member that declares most of the value's keys
 *   (the first such member).
 *
 * A value has one of two forms (SPEC.md, Calls): on the wire, JSON with bytes in base64; or held
 * by a program or a provider, JSON with bytes as a `Uint8Array`. A decode reads one form and
 * writes one, converting bytes where the schema declares them and nowhere else. A value from the
 * wire was parsed from JSON; one held by a program or a provider may be anything, so it is also
 * checked to be what JSON carries: plain objects and arrays, finite numbers, and bytes only where
 * the schema has them.
 *
 * Written for the canonical subset rather than delegated to a general validator, because the value
 * comes from a box and the cost must not depend on how the value was built: a general validator
 * retries every union member on every level, which is exponential in the nesting depth
 * (docs/experiment_journal/typebox-1-json-schema.md). Here each (schema node, value) pair is
 * checked once, so the work is linear in the value's size times the schema's. Only own properties
 * count, and a `__proto__` key is refused anywhere, since a handler copying the value with
 * `Object.assign` would set a prototype with it.
 *
 * Callers pass values no deeper than the contract's depth limit.
 */

/** Where a value is: on the `wire`, bytes in base64; or a `value` a program or a provider holds, bytes as a Uint8Array. */
export type Form = "wire" | "value";

export type Decoded =
	| { readonly ok: true; readonly value: Value }
	| { readonly ok: false; readonly path: string; readonly message: string };

type JsonObject = { readonly [key: string]: JsonValue };
type Problem = { readonly path: string; readonly message: string };

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

	/** Check `value`, in the form `from`, and copy it in the form `to`. */
	decode(value: unknown, from: Form = "wire", to: Form = "wire"): Decoded {
		const problem = structureProblem(value);
		if (problem !== undefined) return { ok: false, ...problem };
		const run = new Run(this.#prepared, from, to);
		return run.matches(this.#root, value)
			? { ok: true, value: run.copy(this.#root, value) }
			: { ok: false, ...run.explain(this.#root, value, "") };
	}
}

/** One decode, with its memo of checked (node, value) pairs. */
class Run {
	readonly #prepared: Prepared;
	readonly #from: Form;
	readonly #to: Form;
	readonly #memo = new WeakMap<object, Map<SchemaNode, boolean>>();

	constructor(prepared: Prepared, from: Form, to: Form) {
		this.#prepared = prepared;
		this.#from = from;
		this.#to = to;
	}

	/** The node a reference chain ends at (`type A = B` is a reference to a reference); cycles were refused. */
	#resolve(node: SchemaNode): SchemaNode {
		let resolved = node;
		while (resolved.$ref !== undefined)
			resolved = this.#prepared.defs.get(resolved.$ref.slice(REF_PREFIX.length)) as SchemaNode;
		return resolved;
	}

	matches(schema: SchemaNode, value: unknown): boolean {
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

	#check(node: SchemaNode, value: unknown): boolean {
		if (node.anyOf !== undefined) return node.anyOf.some((member) => this.matches(member, value));
		if (isBytesNode(node)) return this.#bytes(value) === undefined;
		if (node.const !== undefined && value !== node.const) return false;
		if (
			node.enum !== undefined &&
			!(this.#prepared.enums.get(node) as ReadonlySet<Primitive>).has(value as Primitive)
		) {
			return false;
		}
		if (node.type === undefined) return this.#any(value, "") === undefined;
		if (!this.#is(value, node.type)) return false;
		switch (node.type) {
			case "string":
				return this.#string(node, value as string) === undefined;
			case "number":
			case "integer":
				return bounds(node, value as number) === undefined;
			case "array":
				return this.#array(node, value as readonly unknown[]) === undefined;
			case "object":
				return this.#object(node, value as JsonObject) === undefined;
			default:
				return true;
		}
	}

	/** Whether `value` is of `type`; a value held by a program or a provider must also be what JSON carries. */
	#is(value: unknown, type: NonNullable<SchemaNode["type"]>): boolean {
		if (this.#from === "value") {
			if (type === "object") return isPlainObject(value);
			if (typeof value === "number" && !Number.isFinite(value)) return false;
		}
		return matchesType(value as JsonValue, type);
	}

	/** Why `value` is not bytes in this run's form, or undefined. */
	#bytes(value: unknown): string | undefined {
		if (this.#from === "value") return isBytes(value) ? undefined : "must be bytes, a Uint8Array";
		if (typeof value === "string" && isBase64(value)) return undefined;
		return "must be bytes, as a base64 string (RFC 4648, padded)";
	}

	/**
	 * Why a value where the schema allows anything cannot be carried, or undefined. From the wire
	 * it is JSON already; held by a program or a provider it must be JSON, without bytes, since the
	 * schema declares none there.
	 */
	#any(value: unknown, path: string): Problem | undefined {
		if (this.#from === "wire") return undefined;
		const pending: [unknown, string][] = [[value, path]];
		while (pending.length > 0) {
			const [item, at] = pending.pop() as [unknown, string];
			if (item === null || typeof item === "string" || typeof item === "boolean") continue;
			if (typeof item === "number") {
				if (!Number.isFinite(item)) return { path: at, message: "must be a finite number" };
			} else if (isBytes(item)) {
				return { path: at, message: "must not be bytes: the manifest declares no Uint8Array here" };
			} else if (Array.isArray(item)) {
				for (const [index, child] of item.entries()) pending.push([child, `${at}/${index}`]);
			} else if (isPlainObject(item)) {
				for (const [key, child] of Object.entries(item)) pending.push([child, `${at}/${key}`]);
			} else {
				return { path: at, message: "must be JSON: null, a boolean, a number, a string, an array or a plain object" };
			}
		}
		return undefined;
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
	#array(node: SchemaNode, value: readonly unknown[]): number | string | undefined {
		if (node.minItems !== undefined && value.length < node.minItems) return `must have at least ${node.minItems} items`;
		if (node.maxItems !== undefined && value.length > node.maxItems) return `must have at most ${node.maxItems} items`;
		for (let index = 0; index < value.length; index++) {
			const item = itemSchema(node, index);
			if (item === undefined) return `must have at most ${index} items`;
			if (!this.matches(item, value[index])) return index;
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
			if (!this.matches(schema, value[key])) return { key };
		}
		return undefined;
	}

	/** The value as the schema declares it, in this run's form; call only after `matches` returned true. */
	copy(schema: SchemaNode, value: unknown): Value {
		const node = this.#resolve(schema);
		if (node.anyOf !== undefined) return this.copy(this.#chosenMember(node.anyOf, value), value);
		if (isBytesNode(node)) {
			if (this.#from === this.#to) return value as Value;
			return this.#to === "wire" ? toBase64(value as Uint8Array) : fromBase64(value as string);
		}
		if (node.type === "array") {
			return (value as readonly unknown[]).map((item, index) => this.copy(itemSchema(node, index) as SchemaNode, item));
		}
		if (node.type === "object") {
			const out: Record<string, Value> = {};
			for (const [key, item] of Object.entries(value as JsonObject)) {
				const schemaFor = propertySchema(node, key);
				// A key the type does not declare is not part of it: dropped.
				if (schemaFor !== false && schemaFor !== DROPPED) out[key] = this.copy(schemaFor, item);
			}
			return out;
		}
		return value as Value;
	}

	/**
	 * The member a union's copy follows: of the members the value matches, the one declaring most
	 * of its keys (the first on a tie), so an overlapping union loses as little as it can.
	 */
	#chosenMember(members: readonly SchemaNode[], value: unknown): SchemaNode {
		let best: SchemaNode | undefined;
		let bestScore = -1;
		for (const member of members) {
			if (!this.matches(member, value)) continue;
			const node = this.#resolve(member);
			const score =
				node.type === "object" && isPlainObject(value)
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
	explain(schema: SchemaNode, value: unknown, path: string): Problem {
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
		if (isBytesNode(node)) return { path, message: this.#bytes(value) ?? "is invalid" };
		if (node.const !== undefined && value !== node.const)
			return { path, message: `must be ${JSON.stringify(node.const)}` };
		if (
			node.enum !== undefined &&
			!(this.#prepared.enums.get(node) as ReadonlySet<Primitive>).has(value as Primitive)
		) {
			const shown = node.enum.slice(0, 10).map((item) => JSON.stringify(item));
			return { path, message: `must be one of ${shown.join(", ")}${node.enum.length > 10 ? ", …" : ""}` };
		}
		if (node.type === undefined) return this.#any(value, path) ?? { path, message: "is invalid" };
		if (!this.#is(value, node.type)) {
			if (typeof value === "number" && !Number.isFinite(value)) return { path, message: "must be a finite number" };
			return { path, message: isBytes(value) ? `must be ${node.type}, not bytes` : `must be ${node.type}` };
		}
		switch (node.type) {
			case "string":
				return { path, message: this.#string(node, value as string) ?? "is invalid" };
			case "number":
			case "integer":
				return { path, message: bounds(node, value as number) ?? "is invalid" };
			case "array": {
				const failure = this.#array(node, value as readonly unknown[]);
				if (typeof failure !== "number") return { path, message: failure ?? "is invalid" };
				const item = itemSchema(node, failure) as SchemaNode;
				return this.explain(item, (value as readonly unknown[])[failure], `${path}/${failure}`);
			}
			case "object": {
				const failure = this.#object(node, value as JsonObject);
				if (typeof failure !== "object") return { path, message: failure ?? "is invalid" };
				const item = propertySchema(node, failure.key) as SchemaNode;
				return this.explain(item, (value as JsonObject)[failure.key], `${path}/${failure.key}`);
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

/** A plain object: what JSON parses to, or an object literal. */
function isPlainObject(value: unknown): value is JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * The first `__proto__` own property in `root`, or object that contains itself, which only a value
 * held in memory can do. Bytes and other array buffer views are not looked into. Iterative.
 */
function structureProblem(root: unknown): Problem | undefined {
	interface Frame {
		readonly value: object;
		readonly path: string;
		readonly entries: [string, unknown][];
		next: number;
	}
	const onPath = new Set<object>();
	const stack: Frame[] = [];
	const enter = (value: unknown, path: string): Problem | undefined => {
		if (typeof value !== "object" || value === null || ArrayBuffer.isView(value)) return undefined;
		if (onPath.has(value)) return { path, message: "must not contain itself" };
		if (!Array.isArray(value) && Object.hasOwn(value, "__proto__"))
			return { path, message: "must not have a __proto__ property" };
		onPath.add(value);
		const entries = Array.isArray(value)
			? value.map((item, index): [string, unknown] => [String(index), item])
			: Object.entries(value);
		stack.push({ value, path, entries, next: 0 });
		return undefined;
	};
	let problem = enter(root, "");
	while (problem === undefined && stack.length > 0) {
		const frame = stack[stack.length - 1] as Frame;
		const entry = frame.entries[frame.next++];
		if (entry === undefined) {
			onPath.delete(frame.value);
			stack.pop();
			continue;
		}
		problem = enter(entry[1], `${frame.path}/${entry[0]}`);
	}
	return problem;
}
