// Copied from fyona packages/fbox-host/src/declarations.ts at commit 008a6f5; keep in step until fyona uses this package.
import {
	type CanonicalFunction,
	type CanonicalService,
	IDENTIFIER,
	REF_PREFIX,
	type SchemaNode,
} from "./service-schema.js";

/**
 * Prints a canonical service as the TypeScript declarations programs in the box are checked
 * against: named types become `export interface`/`export type`, functions return Promises, and
 * descriptions become JSDoc. Every value the host's validation accepts has the printed type;
 * constraints TypeScript cannot express (integers, bounds, lengths, patterns) are validated and
 * appear as JSDoc tags: on properties and named types, and in `@param`/`@returns`.
 */
export function printDeclarations(service: CanonicalService): string {
	const blocks: string[] = [];
	for (const [name, schema] of service.defs) {
		const doc = docComment(docLines(schema), "");
		blocks.push(
			isPlainObject(schema)
				? `${doc}export interface ${name} ${objectType(schema, "")}\n`
				: `${doc}export type ${name} = ${typeOf(schema, "")};\n`,
		);
	}
	for (const [name, fn] of service.functions) blocks.push(functionDeclaration(name, fn));
	return blocks.join("\n");
}

function functionDeclaration(name: string, fn: CanonicalFunction): string {
	const lines = fn.description === undefined ? [] : fn.description.split(/\r\n|\r|\n/u);
	for (const param of fn.params) {
		const doc = [param.description, ...docLines(param.schema)].filter((line) => line !== undefined);
		if (doc.length > 0) lines.push(`@param ${param.name} ${oneLine(doc)}`);
	}
	const returns = fn.result === undefined ? [] : docLines(fn.result);
	if (returns.length > 0) lines.push(`@returns ${oneLine(returns)}`);
	const params = fn.params.map((param) => `${param.name}${param.optional ? "?" : ""}: ${typeOf(param.schema, "")}`);
	const result = fn.result === undefined ? "void" : typeOf(fn.result, "");
	return `${docComment(lines, "")}export declare function ${name}(${params.join(", ")}): Promise<${result}>;\n`;
}

const CONSTRAINTS = [
	"minLength",
	"maxLength",
	"pattern",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"minItems",
	"maxItems",
] as const;

function isPlainObject(schema: SchemaNode): boolean {
	return schema.type === "object" && schema.const === undefined && schema.enum === undefined;
}

/** Whether the printed type is a top-level union, which needs parentheses before `[]` or `?`. */
function isUnion(schema: SchemaNode): boolean {
	// Canonical unions have two or more members (service-schema.ts collapses single ones).
	return schema.anyOf !== undefined || (schema.enum?.length ?? 0) > 1;
}

function grouped(schema: SchemaNode, indent: string): string {
	const text = typeOf(schema, indent);
	return isUnion(schema) ? `(${text})` : text;
}

function typeOf(schema: SchemaNode, indent: string): string {
	if (schema.$ref !== undefined) return schema.$ref.slice(REF_PREFIX.length);
	if (schema.anyOf !== undefined) return schema.anyOf.map((member) => typeOf(member, indent)).join(" | ");
	if (schema.const !== undefined) return JSON.stringify(schema.const);
	if (schema.enum !== undefined) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
	switch (schema.type) {
		case "string":
		case "boolean":
		case "null":
			return schema.type;
		case "number":
		case "integer":
			return "number";
		case "array": {
			if (schema.prefixItems !== undefined) {
				const required = schema.minItems ?? schema.prefixItems.length;
				const items = schema.prefixItems.map((item, index) =>
					index < required ? typeOf(item, indent) : `${grouped(item, indent)}?`,
				);
				return `[${items.join(", ")}]`;
			}
			return `${grouped(schema.items === undefined || schema.items === false ? {} : schema.items, indent)}[]`;
		}
		case "object":
			return objectType(schema, indent);
		default:
			return "unknown";
	}
}

function objectType(schema: SchemaNode, indent: string): string {
	const inner = `${indent}\t`;
	const required = new Set(schema.required ?? []);
	const properties = Object.entries(schema.properties ?? {});
	const members = properties.map(([name, property]) => {
		const key = IDENTIFIER.test(name) ? name : JSON.stringify(name);
		const optional = required.has(name) ? "" : "?";
		return `${docComment(docLines(property), inner)}${inner}${key}${optional}: ${typeOf(property, inner)};\n`;
	});
	const additional = schema.additionalProperties;
	if (typeof additional === "object") {
		// An index signature must admit the declared properties too.
		const value = properties.length === 0 ? typeOf(additional, inner) : "unknown";
		members.push(`${inner}[key: string]: ${value};\n`);
	} else if (additional !== false && properties.length === 0) {
		members.push(`${inner}[key: string]: unknown;\n`);
	}
	return members.length === 0 ? "{}" : `{\n${members.join("")}${indent}}`;
}

/** The description of a node and the constraints its printed type cannot show. */
function docLines(schema: SchemaNode): string[] {
	const lines = schema.description === undefined ? [] : schema.description.split(/\r\n|\r|\n/u);
	if (schema.type === "integer") lines.push("@integer");
	for (const keyword of CONSTRAINTS) {
		const value = schema[keyword];
		// minItems/maxItems of a tuple are its printed length and optional elements.
		if (value === undefined || (schema.prefixItems !== undefined && keyword.endsWith("Items"))) continue;
		lines.push(`@${keyword} ${typeof value === "string" ? value : JSON.stringify(value)}`);
	}
	return lines;
}

/** Lines for a tag that takes one line (`@param`, `@returns`). */
function oneLine(lines: readonly string[]): string {
	return lines.join(" ").replace(/\s*\n\s*/gu, " ");
}

function docComment(lines: readonly string[], indent: string): string {
	if (lines.length === 0) return "";
	const safe = lines.map((line) => line.replaceAll("*/", "*\\/"));
	if (safe.length === 1) return `${indent}/** ${safe[0]} */\n`;
	return `${indent}/**\n${safe.map((line) => `${indent} * ${line}`.trimEnd()).join("\n")}\n${indent} */\n`;
}
