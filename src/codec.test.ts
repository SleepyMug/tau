import assert from "node:assert/strict";
import { test } from "node:test";
import { serviceCodec } from "./codec.js";
import type { JsonSchema, ServiceSchema } from "./schema/service-schema.js";

/** A service of one function `f` taking one argument of `schema`. */
function taking(schema: JsonSchema, $defs?: Record<string, JsonSchema>): ServiceSchema {
	return { name: "svc", ...($defs === undefined ? {} : { $defs }), functions: { f: { params: [{ name: "a", schema }] } } };
}

const BYTES = { type: "string", contentEncoding: "base64" };

test("bytes are a string with contentEncoding base64 and nothing else", () => {
	assert.deepEqual(serviceCodec(taking(BYTES)).decodeArguments("f", ["AAE="]), [new Uint8Array([0, 1])]);
	assert.throws(() => serviceCodec(taking({ type: "string", contentEncoding: "utf-8" })), /svc\.f\.params\[0\]\.schema\.contentEncoding must be "base64"/);
	assert.throws(() => serviceCodec(taking({ ...BYTES, maxLength: 8 })), /has maxLength, which bytes do not take/);
	assert.throws(() => serviceCodec(taking({ ...BYTES, const: "AA==" })), /has const, which bytes do not take/);
	assert.throws(() => serviceCodec(taking({ type: "number", contentEncoding: "base64" })), /unsupported keyword "contentEncoding"/);
	assert.throws(() => serviceCodec(taking({ $ref: "#/$defs/Uint8Array" }, { Uint8Array: BYTES })), /type name "Uint8Array" must be a non-reserved identifier/);
});

test("base64 is the standard alphabet, padded", () => {
	const codec = serviceCodec(taking(BYTES));
	for (const text of ["", "AA==", "AAA=", "AAAA", "+/+/"]) assert.doesNotThrow(() => codec.checkArguments("f", [text]), text);
	for (const text of ["A", "AA=", "AA", "A===", "-_-_", "AA==AA==", "AA A"]) {
		assert.throws(() => codec.checkArguments("f", [text]), /svc\.f: a: must be bytes, as a base64 string/, text);
	}
});

test("a union one string could cross as bytes or text is refused, wherever it is", () => {
	const refused: [string, JsonSchema, Record<string, JsonSchema>?][] = [
		["text or bytes", { anyOf: [{ type: "string" }, BYTES] }],
		["a literal or bytes", { anyOf: [{ const: "AA==" }, BYTES] }],
		["anything or bytes", { anyOf: [{}, { type: "array", items: BYTES }] }],
		["through a named type", { anyOf: [{ $ref: "#/$defs/B" }, { type: "string", pattern: "^x" }] }, { B: BYTES }],
		[
			"same property",
			{
				anyOf: [
					{ type: "object", properties: { v: BYTES } },
					{ type: "object", properties: { v: { type: "string" } }, required: ["v"] },
				],
			},
		],
		["tuple positions", { anyOf: [{ type: "array", prefixItems: [BYTES], items: false }, { type: "array", items: { type: "string" } }] }],
		["records", { anyOf: [{ type: "object", additionalProperties: BYTES }, { type: "object", additionalProperties: { type: "string" } }] }],
	];
	for (const [what, schema, defs] of refused) {
		assert.throws(() => serviceCodec(taking(schema, defs)), /svc\.f\(a\) is a union that one string could match as bytes/, what);
	}
	const told: [string, JsonSchema][] = [
		["bytes or not a string", { anyOf: [BYTES, { type: "null" }, { type: "integer" }, { type: "array", items: { type: "string" } }] }],
		[
			"a required literal",
			{
				anyOf: [
					{ type: "object", properties: { kind: { const: "b" }, v: BYTES }, required: ["kind", "v"] },
					{ type: "object", properties: { kind: { const: "t" }, v: { type: "string" } }, required: ["kind", "v"] },
				],
			},
		],
		[
			"a required property the other refuses",
			{
				anyOf: [
					{ type: "object", properties: { v: BYTES }, required: ["v"], additionalProperties: false },
					{ type: "object", properties: { w: { type: "string" } }, required: ["w"], additionalProperties: false },
				],
			},
		],
		["bytes in both", { anyOf: [BYTES, { type: "object", properties: { v: BYTES } }] }],
	];
	for (const [what, schema] of told) assert.doesNotThrow(() => serviceCodec(taking(schema)), what);
});

test("a recursive type holding bytes is checked, and converted at every depth", () => {
	const tree = { type: "object", properties: { data: BYTES, children: { type: "array", items: { $ref: "#/$defs/Tree" } } }, required: ["data"] };
	const codec = serviceCodec(taking({ $ref: "#/$defs/Tree" }, { Tree: tree }));
	const wire = { data: "AA==", children: [{ data: "AQ==", children: [{ data: "" }] }] };
	const held = { data: new Uint8Array([0]), children: [{ data: new Uint8Array([1]), children: [{ data: new Uint8Array() }] }] };
	assert.deepEqual(codec.decodeArguments("f", [wire]), [held]);
	assert.deepEqual(codec.encodeArguments("f", [held]), [wire]);
});
