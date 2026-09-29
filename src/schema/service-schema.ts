// Copied from fyona packages/fbox-host/src/service-schema.ts at commit 008a6f5; keep in step until fyona uses this package.
/**
 * The canonical form of a service (decision 0008): plain JSON Schema in a small subset, the one
 * form the host validates calls against (validate.ts) and prints the box's declarations from
 * (declarations.ts). Whatever built a service (TypeBox builders, a derivation from TypeScript), it
 * ends up here, and anything outside the subset is refused rather than approximated.
 *
 * The subset, per schema node:
 * - `{}`: any JSON value;
 * - `{ $ref: "#/$defs/<Name>" }`: a named type of the service;
 * - `{ anyOf: [...] }`: a union of two or more members;
 * - `{ type, const?, enum? }` with `type` one of string, number, integer, boolean, null, object,
 *   array, or `const`/`enum` alone (primitive values only);
 * - the constraints of each type:
 *   - string: minLength, maxLength, pattern;
 *   - number and integer: minimum, maximum, exclusiveMinimum, exclusiveMaximum;
 *   - array: items, or a closed tuple (prefixItems), plus minItems, maxItems;
 *   - object: properties, required, additionalProperties;
 * - `description` anywhere.
 *
 * Rewritten on the way in: the draft-07 forms TypeBox and ts-json-schema-generator emit for
 * tuples (`items: [...]`) and records (`patternProperties: { "^.*$": T }`), `type` lists, and
 * nested or single-member `anyOf`. Refused: a named type that refers to itself without an object
 * or array in between (`type X = X | string`), which TypeScript cannot declare.
 */

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** One schema node, as plain JSON: what a service is written in. */
export type JsonSchema = { readonly [keyword: string]: JsonValue };

export interface ParamSchema {
	readonly name: string;
	readonly description?: string;
	/** Only trailing parameters may be optional. */
	readonly optional?: boolean;
	readonly schema: JsonSchema;
}

export interface FunctionSchema {
	readonly description?: string;
	readonly params: readonly ParamSchema[];
	/** What the function resolves to; omitted means it returns nothing (`void`). */
	readonly result?: JsonSchema;
}

export interface ServiceSchema {
	/** The box imports the service as `@svc/<name>`. */
	readonly name: string;
	readonly description?: string;
	/** Named types, referenced from any schema as `{ "$ref": "#/$defs/<Name>" }`. */
	readonly $defs?: Readonly<Record<string, JsonSchema>>;
	readonly functions: Readonly<Record<string, FunctionSchema>>;
}

/** A node of the canonical form, typed for reading. */
export interface SchemaNode {
	readonly $ref?: string;
	readonly anyOf?: readonly SchemaNode[];
	readonly type?: "string" | "number" | "integer" | "boolean" | "null" | "object" | "array";
	readonly const?: Primitive;
	readonly enum?: readonly Primitive[];
	readonly description?: string;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly pattern?: string;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly exclusiveMinimum?: number;
	readonly exclusiveMaximum?: number;
	readonly items?: SchemaNode | false;
	readonly prefixItems?: readonly SchemaNode[];
	readonly minItems?: number;
	readonly maxItems?: number;
	readonly properties?: Readonly<Record<string, SchemaNode>>;
	readonly required?: readonly string[];
	readonly additionalProperties?: boolean | SchemaNode;
}

export type Primitive = string | number | boolean | null;

export interface CanonicalParam {
	readonly name: string;
	readonly description?: string;
	readonly optional: boolean;
	readonly schema: SchemaNode;
}

export interface CanonicalFunction {
	readonly description?: string;
	readonly params: readonly CanonicalParam[];
	readonly result?: SchemaNode;
}

/** A checked service. Maps, not objects, so no name (`__proto__`) can reach a prototype. */
export interface CanonicalService {
	readonly name: string;
	readonly description?: string;
	readonly defs: ReadonlyMap<string, SchemaNode>;
	readonly functions: ReadonlyMap<string, CanonicalFunction>;
}

export const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
/** The package-name rule ts-executor applies to the `@svc/<name>` specifier. */
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
export const REF_PREFIX = "#/$defs/";
/**
 * Strict-mode and module reserved words: invalid as function, parameter or type names. ts-executor
 * refuses the same function names in the box; checking here reports them at definition time.
 */
const RESERVED_WORDS = new Set(
	(
		"arguments await break case catch class const continue debugger default delete do else enum eval export " +
		"extends false finally for function if implements import in instanceof interface let new null package " +
		"private protected public return static super switch this throw true try typeof var void while with yield"
	).split(" "),
);
/** Names TypeScript refuses for an interface or type alias, and `Promise`, which the declarations use. */
const RESERVED_TYPE_NAMES = new Set(
	"any unknown never string number boolean symbol bigint object undefined keyof infer unique readonly intrinsic as Promise".split(
		" ",
	),
);
const TYPE_KEYWORDS: Readonly<Record<NonNullable<SchemaNode["type"]>, readonly string[]>> = {
	string: ["minLength", "maxLength", "pattern"],
	number: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"],
	integer: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"],
	boolean: [],
	null: [],
	array: ["items", "prefixItems", "additionalItems", "minItems", "maxItems"],
	object: ["properties", "required", "additionalProperties", "patternProperties"],
};
/** `patternProperties` keys meaning "every key", so the record is `additionalProperties`. */
const ANY_KEY_PATTERNS = new Set(["^.*$", "^[\\s\\S]*$", ".*", "^(.*)$"]);

type JsonObject = { readonly [key: string]: JsonValue };
type SchemaType = NonNullable<SchemaNode["type"]>;

const KEYWORDS = [
	"$ref",
	"anyOf",
	"type",
	"const",
	"enum",
	"description",
	"minLength",
	"maxLength",
	"pattern",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"items",
	"prefixItems",
	"additionalItems",
	"minItems",
	"maxItems",
	"properties",
	"required",
	"additionalProperties",
	"patternProperties",
] as const;
/** A raw schema node read through the keywords the subset knows. */
type RawSchema = { readonly [K in (typeof KEYWORDS)[number]]?: JsonValue };
type RawService = { readonly [K in "name" | "description" | "$defs" | "functions"]?: JsonValue };
type RawFunction = { readonly [K in "description" | "params" | "result"]?: JsonValue };
type RawParam = { readonly [K in "name" | "description" | "optional" | "schema"]?: JsonValue };
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function fail(path: string, detail: string): never {
	throw new TypeError(`${path} ${detail}`);
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isType(value: unknown): value is SchemaType {
	return typeof value === "string" && Object.hasOwn(TYPE_KEYWORDS, value);
}

/** A copy of `value` as plain JSON; refuses functions, class instances, non-finite numbers and cycles. */
export function plainJson(value: unknown, path: string, ancestors = new Set<object>()): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : fail(path, "must be a finite number");
	if (typeof value !== "object") return fail(path, `must be JSON, not ${typeof value}`);
	if (ancestors.has(value)) fail(path, "must not contain a cycle");
	const prototype = Object.getPrototypeOf(value);
	if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
		fail(path, "must be a plain object or array");
	}
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return value.map((item, index) => plainJson(item, `${path}[${index}]`, ancestors));
		// Own enumerable string keys only: TypeBox's markers are non-enumerable and not JSON Schema.
		return Object.fromEntries(
			Object.keys(value).map((key) => [key, plainJson((value as JsonObject)[key], `${path}.${key}`, ancestors)]),
		);
	} finally {
		ancestors.delete(value);
	}
}

function assertName(name: unknown, what: string, reserved: readonly ReadonlySet<string>[]): asserts name is string {
	if (typeof name !== "string" || !IDENTIFIER.test(name) || reserved.some((set) => set.has(name))) {
		throw new TypeError(`${what} ${JSON.stringify(name)} must be a non-reserved identifier`);
	}
}

function optionalText(value: JsonValue | undefined, path: string): string | undefined {
	if (value !== undefined && typeof value !== "string") fail(path, "must be a string");
	return value;
}

function assertKeys(value: JsonObject, allowed: readonly string[], path: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) fail(path, `has an unsupported property ${JSON.stringify(key)}`);
	}
}

function nonNegativeInteger(value: JsonValue | undefined, path: string): number | undefined {
	if (value !== undefined && !(typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
		fail(path, "must be a non-negative integer");
	}
	return value;
}

export function matchesType(value: JsonValue, type: SchemaType): boolean {
	switch (type) {
		case "null":
			return value === null;
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "array":
			return Array.isArray(value);
		case "object":
			return isObject(value);
		default:
			return typeof value === type;
	}
}

function primitive(value: JsonValue, type: SchemaType | undefined, path: string): Primitive {
	if (typeof value === "object" && value !== null) return fail(path, "must be a string, number, boolean or null");
	if (type !== undefined && !matchesType(value, type)) fail(path, `must be a value of type ${type}`);
	return value;
}

/** Checks one node against the subset and returns its canonical copy. */
function canonicalNode(value: JsonValue, path: string, defs: ReadonlySet<string>): SchemaNode {
	if (!isObject(value)) return fail(path, "must be a schema object");
	const node = value as RawSchema;
	const description = optionalText(node.description, `${path}.description`);
	const described = description === undefined ? {} : { description };

	if (node.$ref !== undefined) {
		assertKeys(value, ["$ref", "description"], path);
		const ref = node.$ref;
		if (typeof ref !== "string" || !ref.startsWith(REF_PREFIX) || !defs.has(ref.slice(REF_PREFIX.length))) {
			fail(`${path}.$ref`, `must name one of the service's $defs, not ${JSON.stringify(ref)}`);
		}
		return { $ref: ref, ...described };
	}
	if (node.anyOf !== undefined) {
		assertKeys(value, ["anyOf", "description"], path);
		if (!Array.isArray(node.anyOf) || node.anyOf.length === 0) fail(`${path}.anyOf`, "must be a non-empty array");
		return union(
			node.anyOf.map((member, index) => canonicalNode(member, `${path}.anyOf[${index}]`, defs)),
			description,
		);
	}

	const type = node.type;
	if (Array.isArray(type)) return typeList(value, type, description, path, defs);
	if (type !== undefined && !isType(type))
		fail(`${path}.type`, `must be one of ${Object.keys(TYPE_KEYWORDS).join(", ")}`);
	const typeKeywords = type === undefined ? [] : TYPE_KEYWORDS[type];
	for (const key of Object.keys(value)) {
		if (key === "type" || key === "description" || key === "const" || key === "enum" || typeKeywords.includes(key)) {
			continue;
		}
		const needsType = Object.values(TYPE_KEYWORDS).some((keywords) => keywords.includes(key));
		fail(
			path,
			`has an unsupported keyword ${JSON.stringify(key)}${needsType && type === undefined ? " (without a type)" : ""}`,
		);
	}
	const out: Mutable<SchemaNode> = { ...described };
	if (type !== undefined) out.type = type;
	if (node.const !== undefined) out.const = primitive(node.const, type, `${path}.const`);
	if (node.enum !== undefined) {
		if (!Array.isArray(node.enum) || node.enum.length === 0) fail(`${path}.enum`, "must be a non-empty array");
		out.enum = node.enum.map((item, index) => primitive(item, type, `${path}.enum[${index}]`));
	}
	if (out.const !== undefined && out.enum !== undefined) {
		// Both apply: the value is the constant, which must be one of the enum's.
		if (!out.enum.includes(out.const)) fail(`${path}.const`, "is not among the enum's values, so nothing matches");
		delete out.enum;
	}
	switch (type) {
		case "string":
			canonicalString(node, out, path);
			break;
		case "number":
		case "integer":
			for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
				const bound = node[key];
				if (bound !== undefined && typeof bound !== "number") fail(`${path}.${key}`, "must be a number");
				if (bound !== undefined) out[key] = bound;
			}
			break;
		case "array":
			canonicalArray(node, out, path, defs);
			break;
		case "object":
			canonicalObject(node, out, path, defs);
			break;
	}
	return out;
}

/**
 * A union of canonical members: nested description-less unions are flattened, a union of literals
 * becomes one `enum` (checked by a set lookup rather than member by member), and one member is
 * itself.
 */
function union(members: readonly SchemaNode[], description: string | undefined): SchemaNode {
	const described = description === undefined ? {} : { description };
	const flat = members.flatMap((member) =>
		member.anyOf !== undefined && member.description === undefined ? member.anyOf : [member],
	);
	const literals = flat.map(literalValues);
	if (flat.length > 1 && literals.every((values) => values !== undefined)) {
		return { enum: [...new Set(literals.flat())], ...described };
	}
	if (flat.length === 1) return { ...(flat[0] as SchemaNode), ...described };
	return { anyOf: flat, ...described };
}

/** The values a node allows if it is nothing but literals (`const`/`enum`, their type, no description). */
function literalValues(node: SchemaNode): readonly Primitive[] | undefined {
	const keys = Object.keys(node);
	if (!keys.every((key) => key === "type" || key === "const" || key === "enum")) return undefined;
	return node.const !== undefined ? [node.const] : node.enum;
}

/** `type: ["string", "null"]` is a union; each branch keeps the keywords, and values, of its type. */
function typeList(
	value: JsonObject,
	types: readonly JsonValue[],
	description: string | undefined,
	path: string,
	defs: ReadonlySet<string>,
): SchemaNode {
	if (types.length === 0 || !types.every(isType)) fail(`${path}.type`, "must list types of the subset");
	const listed = types as readonly SchemaType[];
	const known = new Set(["type", "description", "const", "enum", ...listed.flatMap((type) => TYPE_KEYWORDS[type])]);
	for (const key of Object.keys(value))
		if (!known.has(key)) fail(path, `has an unsupported keyword ${JSON.stringify(key)}`);
	const node = value as RawSchema;
	if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) {
		fail(`${path}.enum`, "must be a non-empty array");
	}
	if (node.const !== undefined && Array.isArray(node.enum) && !node.enum.includes(node.const)) {
		fail(`${path}.const`, "is not among the enum's values, so nothing matches");
	}
	const values = node.const !== undefined ? [node.const] : Array.isArray(node.enum) ? node.enum : undefined;
	for (const item of values ?? []) {
		if (!listed.some((type) => matchesType(item, type)))
			fail(path, `lists ${JSON.stringify(item)}, which has none of its types`);
	}
	const branches = listed.flatMap((type): JsonObject[] => {
		const keywords = TYPE_KEYWORDS[type];
		const own = values?.filter((item) => matchesType(item, type));
		if (own !== undefined && own.length === 0) return [];
		return [
			Object.fromEntries([
				["type", type],
				...Object.entries(value).filter(([key]) => keywords.includes(key)),
				...(own === undefined ? [] : [["enum", own]]),
			]),
		];
	});
	return union(
		branches.map((branch, index) => canonicalNode(branch, `${path}.type[${index}]`, defs)),
		description,
	);
}

function canonicalString(node: RawSchema, out: Mutable<SchemaNode>, path: string): void {
	const minLength = nonNegativeInteger(node.minLength, `${path}.minLength`);
	const maxLength = nonNegativeInteger(node.maxLength, `${path}.maxLength`);
	if (minLength !== undefined) out.minLength = minLength;
	if (maxLength !== undefined) out.maxLength = maxLength;
	if (node.pattern !== undefined) {
		if (typeof node.pattern !== "string") fail(`${path}.pattern`, "must be a string");
		try {
			new RegExp(node.pattern, "u");
		} catch (error) {
			fail(`${path}.pattern`, `is not a valid regular expression: ${(error as Error).message}`);
		}
		out.pattern = node.pattern;
	}
}

function canonicalArray(node: RawSchema, out: Mutable<SchemaNode>, path: string, defs: ReadonlySet<string>): void {
	const minItems = nonNegativeInteger(node.minItems, `${path}.minItems`);
	const maxItems = nonNegativeInteger(node.maxItems, `${path}.maxItems`);
	// A tuple: 2020-12 `prefixItems`, or draft-07 `items: [...]`.
	const prefix = node.prefixItems ?? (Array.isArray(node.items) ? node.items : undefined);
	if (prefix === undefined) {
		if (node.additionalItems !== undefined) fail(path, "has additionalItems without a tuple");
		out.items = canonicalNode(node.items ?? {}, `${path}.items`, defs);
		if (minItems !== undefined) out.minItems = minItems;
		if (maxItems !== undefined) out.maxItems = maxItems;
		return;
	}
	if (!Array.isArray(prefix)) fail(`${path}.prefixItems`, "must be an array");
	const rest = node.prefixItems === undefined ? node.additionalItems : node.items;
	if (!(rest === false || (rest === undefined && maxItems === prefix.length))) {
		fail(path, "must be a closed tuple (rest elements are not supported)");
	}
	if (maxItems !== undefined && maxItems !== prefix.length) fail(`${path}.maxItems`, "must equal the tuple's length");
	if (minItems !== undefined && minItems > prefix.length)
		fail(`${path}.minItems`, "must not exceed the tuple's length");
	out.prefixItems = prefix.map((item, index) => canonicalNode(item, `${path}.prefixItems[${index}]`, defs));
	out.items = false;
	out.minItems = minItems ?? prefix.length;
	out.maxItems = prefix.length;
}

function canonicalObject(node: RawSchema, out: Mutable<SchemaNode>, path: string, defs: ReadonlySet<string>): void {
	const properties = node.properties ?? {};
	if (!isObject(properties)) fail(`${path}.properties`, "must be an object");
	// Box values with such a key are refused, so the property could never be passed or returned.
	if (Object.hasOwn(properties, "__proto__")) fail(`${path}.properties`, "must not declare __proto__");
	out.properties = Object.fromEntries(
		Object.entries(properties).map(([name, schema]) => [
			name,
			canonicalNode(schema, `${path}.properties.${name}`, defs),
		]),
	);
	if (node.required !== undefined) {
		const required = node.required;
		if (
			!Array.isArray(required) ||
			!required.every((name): name is string => typeof name === "string" && Object.hasOwn(properties, name)) ||
			new Set(required).size !== required.length
		) {
			fail(`${path}.required`, "must list distinct names of declared properties");
		}
		out.required = required;
	}
	let additional = node.additionalProperties;
	if (node.patternProperties !== undefined) {
		const patterns = isObject(node.patternProperties) ? Object.entries(node.patternProperties) : [];
		const [pattern, schema] = patterns[0] ?? [];
		if (patterns.length !== 1 || !ANY_KEY_PATTERNS.has(pattern as string) || additional !== undefined) {
			fail(`${path}.patternProperties`, "is supported only as a single pattern matching every key (a record)");
		}
		additional = schema;
	}
	if (additional !== undefined) {
		out.additionalProperties =
			typeof additional === "boolean" ? additional : canonicalNode(additional, `${path}.additionalProperties`, defs);
	}
}

/** Refuse named types that reach themselves through `$ref` and `anyOf` alone (`type X = X | string`). */
function assertNoBareCycles(service: string, defs: ReadonlyMap<string, SchemaNode>): void {
	const done = new Set<string>();
	const visit = (name: string, trail: readonly string[]): void => {
		if (trail.includes(name))
			fail(
				`${service}.$defs.${name}`,
				`refers to itself with no object or array in between (${[...trail, name].join(" → ")})`,
			);
		if (done.has(name)) return;
		const through = (node: SchemaNode): void => {
			if (node.$ref !== undefined) visit(node.$ref.slice(REF_PREFIX.length), [...trail, name]);
			for (const member of node.anyOf ?? []) through(member);
		};
		through(defs.get(name) as SchemaNode);
		done.add(name);
	};
	for (const name of defs.keys()) visit(name, []);
}

function deepFreeze<T>(value: T): T {
	if (value instanceof Map) {
		for (const child of value.values()) deepFreeze(child);
	} else if (typeof value === "object" && value !== null) {
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return typeof value === "object" && value !== null ? Object.freeze(value) : value;
}

/** Check `schema` against the canonical subset and return its frozen canonical form. Throws TypeError. */
export function canonicalService(schema: ServiceSchema): CanonicalService {
	const raw = plainJson(schema, "service");
	if (!isObject(raw)) return fail("service", "must be an object");
	assertKeys(raw, ["name", "description", "$defs", "functions"], "service");
	const json = raw as RawService;
	const name = json.name;
	if (typeof name !== "string" || !SERVICE_NAME.test(name)) {
		throw new TypeError(`service name ${JSON.stringify(name)} must match ${SERVICE_NAME.source}`);
	}
	const description = optionalText(json.description, `${name}.description`);
	const rawDefs = json.$defs ?? {};
	if (!isObject(rawDefs)) return fail(`${name}.$defs`, "must be an object");
	for (const defName of Object.keys(rawDefs))
		assertName(defName, `${name}: type name`, [RESERVED_WORDS, RESERVED_TYPE_NAMES]);
	const defNames = new Set(Object.keys(rawDefs));
	const defs = new Map(
		Object.entries(rawDefs).map(([defName, def]) => [
			defName,
			canonicalNode(def, `${name}.$defs.${defName}`, defNames),
		]),
	);
	assertNoBareCycles(name, defs);

	const rawFunctions = json.functions;
	if (!isObject(rawFunctions) || Object.keys(rawFunctions).length === 0) {
		return fail(`${name}.functions`, "must be an object with at least one function");
	}
	const functions = new Map<string, CanonicalFunction>();
	for (const [fnName, rawFnObject] of Object.entries(rawFunctions)) {
		const where = `${name}.${fnName}`;
		assertName(fnName, `${name}: function name`, [RESERVED_WORDS]);
		// An exported `then` makes a dynamic import of the module treat it as a thenable.
		if (fnName === "then") throw new TypeError(`${name}: function name "then" is reserved`);
		if (!isObject(rawFnObject)) return fail(where, "must be an object");
		assertKeys(rawFnObject, ["description", "params", "result"], where);
		const rawFn = rawFnObject as RawFunction;
		const fnDescription = optionalText(rawFn.description, `${where}.description`);
		if (!Array.isArray(rawFn.params)) return fail(`${where}.params`, "must be an array");
		const seen = new Set<string>();
		let optionalSeen = false;
		const params = rawFn.params.map((rawParamObject, index): CanonicalParam => {
			const at = `${where}.params[${index}]`;
			if (!isObject(rawParamObject)) return fail(at, "must be an object");
			assertKeys(rawParamObject, ["name", "description", "optional", "schema"], at);
			const rawParam = rawParamObject as RawParam;
			assertName(rawParam.name, `${where}: parameter name`, [RESERVED_WORDS]);
			if (seen.has(rawParam.name)) fail(at, `repeats the parameter name ${rawParam.name}`);
			seen.add(rawParam.name);
			const paramDescription = optionalText(rawParam.description, `${at}.description`);
			if (rawParam.optional !== undefined && typeof rawParam.optional !== "boolean") {
				fail(`${at}.optional`, "must be a boolean");
			}
			const optional = rawParam.optional === true;
			if (optionalSeen && !optional) fail(at, "is required but follows an optional parameter");
			optionalSeen ||= optional;
			return {
				name: rawParam.name,
				...(paramDescription === undefined ? {} : { description: paramDescription }),
				optional,
				schema: canonicalNode(rawParam.schema ?? null, `${at}.schema`, defNames),
			};
		});
		functions.set(fnName, {
			...(fnDescription === undefined ? {} : { description: fnDescription }),
			params,
			...(rawFn.result === undefined ? {} : { result: canonicalNode(rawFn.result, `${where}.result`, defNames) }),
		});
	}
	return deepFreeze({ name, ...(description === undefined ? {} : { description }), defs, functions });
}
