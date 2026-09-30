// Adapted from fyona packages/fbox-derive/src/read-declarations.ts at commit 008a6f5.
import path from "node:path";
import {
	type CompletedConfig,
	createFormatter,
	createParser,
	DEFAULT_CONFIG,
	SchemaGenerator,
} from "ts-json-schema-generator";
import ts from "typescript";
import type { FunctionSchema, JsonSchema, JsonValue, ParamSchema } from "./schema/service-schema.js";

/**
 * Reads a service manifest, `api/<name>.d.ts`: its exported functions become the service's
 * functions, and each parameter and result type is turned into JSON Schema, collecting every named
 * type they reach as `$defs`. Translating types is ts-json-schema-generator's job; it is silently
 * lossy (`Date` becomes a string), so nothing read here is trusted until verify.ts has compared
 * the printed declarations with the manifest.
 */

export const COMPILER_OPTIONS: ts.CompilerOptions = {
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.NodeNext,
	moduleResolution: ts.ModuleResolutionKind.NodeNext,
	strict: true,
	noEmit: true,
	skipLibCheck: true,
	// A manifest is self-contained: no ambient @types, and no DOM.
	types: [],
	lib: ["lib.es2022.d.ts"],
};

const GENERATOR: CompletedConfig = {
	...DEFAULT_CONFIG,
	// Exported types become named definitions, and so does a type used directly as a parameter or
	// result (`topRef`), exported or not; other unexported types are inlined.
	expose: "export",
	topRef: true,
	// Doc comment text becomes `description`.
	jsDoc: "extended",
	// TypeScript object types are open; so are the schemas.
	additionalProperties: true,
	functions: "fail",
	skipTypeCheck: true,
	encodeRefs: false,
	sortProps: false,
};

/**
 * Annotations the generator may emit that carry no type information; they are dropped. So is
 * `format` (`Date` becomes `{type: "string", format: "date-time"}`): without it, the identity check
 * reports such a type as the `string` it would arrive as.
 */
const DROPPED = new Set(["$schema", "$comment", "title", "examples", "default", "deprecated", "format"]);
/**
 * Keywords of the canonical subset whose value is a schema, a list of schemas, or a map of names to
 * schemas: the ones followed. Any other keyword is copied, and the canonical check refuses it.
 */
const SCHEMAS = new Set(["items", "additionalProperties"]);
const SCHEMA_LISTS = new Set(["items", "prefixItems", "anyOf"]);
const SCHEMA_MAPS = new Set(["properties", "patternProperties"]);

export interface ReadManifest {
	/** The program the manifest was read from, reused when verifying. */
	readonly program: ts.Program;
	readonly description: string | undefined;
	readonly $defs: Record<string, JsonSchema>;
	readonly functions: Record<string, FunctionSchema>;
	/** Each function's declaration as written, for error messages. */
	readonly signatures: ReadonlyMap<string, string>;
}

function reject(where: string, detail: string): never {
	throw new TypeError(where === "" ? detail : `${where} ${detail}`);
}

function firstLine(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
}

/**
 * The manifest's TSDoc package documentation: its first doc comment, when that comment has the
 * `@packageDocumentation` tag. Returns the description (the text before any other tag) and the
 * manifest with that comment blanked out, since TypeScript would otherwise take it as the first
 * declaration's documentation when the declaration has none of its own.
 */
function packageDocumentation(text: string): { description: string | undefined; masked: string } {
	for (const range of ts.getLeadingCommentRanges(text, 0) ?? []) {
		const comment = text.slice(range.pos, range.end);
		if (!comment.startsWith("/**")) continue;
		if (!/@packageDocumentation\b/u.test(comment)) break;
		const lines = comment
			.slice(3, -2)
			.replace(/@packageDocumentation\b/u, "")
			.split("\n")
			.map((line) => line.replace(/^\s*\*? ?/u, "").trimEnd());
		const end = lines.findIndex((line) => line.startsWith("@"));
		const description = (end === -1 ? lines : lines.slice(0, end)).join("\n").trim();
		const masked = text.slice(0, range.pos) + comment.replace(/[^\n]/gu, " ") + text.slice(range.end);
		return { description: description === "" ? undefined : description, masked };
	}
	return { description: undefined, masked: text };
}

/** A compiler host that serves `files` from memory and everything else from disk. */
export function memoryHost(files: ReadonlyMap<string, string>): ts.CompilerHost {
	const host = ts.createCompilerHost(COMPILER_OPTIONS);
	const base = { getSourceFile: host.getSourceFile, fileExists: host.fileExists, readFile: host.readFile };
	host.getSourceFile = (name, version, onError) => {
		const text = files.get(name);
		return text === undefined
			? base.getSourceFile(name, version, onError)
			: ts.createSourceFile(name, text, version, true);
	};
	host.fileExists = (name) => files.has(name) || base.fileExists(name);
	host.readFile = (name) => files.get(name) ?? base.readFile(name);
	return host;
}

/** `file` is the manifest's absolute path; `text` its contents. */
export function readManifest(file: string, text: string): ReadManifest {
	const { description, masked } = packageDocumentation(text);
	const host = memoryHost(new Map([[file, masked]]));
	const program = ts.createProgram([file], COMPILER_OPTIONS, host);
	const source = program.getSourceFile(file) as ts.SourceFile;
	const syntax = program.getSyntacticDiagnostics(source)[0];
	if (syntax !== undefined) reject("", `is not valid TypeScript: ${ts.flattenDiagnosticMessageText(syntax.messageText, " ")}`);

	// Interfaces, type aliases and exported functions; the rest has no place in a manifest.
	const names: string[] = [];
	for (const statement of source.statements) {
		if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
			if (statement.name.text === "Promise")
				reject("Promise:", "is the global Promise, and a manifest may not declare its own");
			continue;
		}
		if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
			const modifiers = ts.getModifiers(statement) ?? [];
			const name = statement.name.text;
			if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
				reject(`${name}:`, "must be exported: every function of a manifest is a function of the service");
			if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword))
				reject(`${name}:`, "must be a named export, not a default one");
			if (!names.includes(name)) names.push(name);
			continue;
		}
		const { line } = source.getLineAndCharacterOfPosition(statement.getStart());
		reject(
			`line ${line + 1}:`,
			"declares something other than an interface, a type alias or an exported function (a manifest is self-contained)",
		);
	}
	if (names.length === 0) reject("", "declares no exported function");

	const checker = program.getTypeChecker();
	const moduleSymbol = checker.getSymbolAtLocation(source) as ts.Symbol;
	const exports = new Map(checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.name, symbol]));
	const generator = new SchemaGenerator(
		program,
		createParser(program, GENERATOR),
		createFormatter(GENERATOR),
		GENERATOR,
	);

	/** Definitions as the generator names them, from every type read so far. */
	const collected = new Map<string, JsonValue>();
	const typeSchema = (node: ts.TypeNode, where: string): JsonValue => {
		let schema: Record<string, JsonValue>;
		try {
			schema = JSON.parse(JSON.stringify(generator.createSchemaFromNodes([node]))) as Record<string, JsonValue>;
		} catch (error) {
			return reject(where, `has a type that cannot be translated to JSON Schema: ${firstLine(error)}`);
		}
		const { definitions = {}, ...root } = schema;
		for (const [name, definition] of Object.entries(definitions as Record<string, JsonValue>)) {
			const existing = collected.get(name);
			if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(definition)) {
				reject(where, `reaches a second, different type named ${name}`);
			}
			collected.set(name, definition);
		}
		return root;
	};

	const raw: Record<
		string,
		{
			description?: string;
			params: { name: string; description?: string; optional: boolean; schema: JsonValue }[];
			result?: JsonValue;
		}
	> = {};
	const signatures = new Map<string, string>();
	for (const name of names) {
		const symbol = exports.get(name) as ts.Symbol;
		const declarations = symbol.declarations ?? [];
		const fn = declarations[0];
		if (declarations.length !== 1 || fn === undefined || !ts.isFunctionDeclaration(fn)) {
			return reject(`${name}:`, "must be declared exactly once (overloads are not supported)");
		}
		if (fn.typeParameters !== undefined) reject(`${name}:`, "is generic, which is not supported");
		signatures.set(
			name,
			fn
				.getText()
				.replace(/^export\s+(declare\s+)?/u, "")
				.replace(/\s+/gu, " ")
				.replace(/;$/u, "")
				.trim(),
		);
		const params = fn.parameters.map((param) => {
			if (!ts.isIdentifier(param.name))
				return reject(`${name}:`, "has a destructured parameter, which is not supported");
			const paramName = param.name.text;
			if (param.dotDotDotToken !== undefined)
				reject(`${name}(${paramName}):`, "is a rest parameter, which is not supported");
			if (param.type === undefined) return reject(`${name}(${paramName}):`, "needs a type annotation");
			// An initializer is for implementations (TS2371); `skipLibCheck` would let it through.
			if (param.initializer !== undefined)
				reject(`${name}(${paramName}):`, "has a default value, which only an implementation can have; write it optional with ?");
			// TSDoc writes `@param name - text`; the hyphen is not part of the description.
			const paramDescription = ts
				.getJSDocParameterTags(param)
				.map((tag) => ts.getTextOfJSDocComment(tag.comment) ?? "")
				.join(" ")
				.replace(/^\s*-\s*/u, "")
				.trim();
			return {
				name: paramName,
				...(paramDescription === "" ? {} : { description: paramDescription }),
				optional: param.questionToken !== undefined,
				schema: typeSchema(param.type, `${name}(${paramName}):`),
			};
		});
		if (fn.type === undefined) return reject(`${name}:`, "needs a return type annotation");
		// Written `Promise<T>`, nothing else: verify.ts then holds the whole return type identical to
		// the printed one, so `T` cannot be a Promise itself, and `Promise` must be the global one.
		if (
			!ts.isTypeReferenceNode(fn.type) ||
			!ts.isIdentifier(fn.type.typeName) ||
			fn.type.typeName.text !== "Promise" ||
			fn.type.typeArguments?.length !== 1
		) {
			return reject(`${name}:`, "must return Promise<T>, or Promise<void> for no result");
		}
		const result = fn.type.typeArguments[0] as ts.TypeNode;
		const fnDescription = ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim();
		raw[name] = {
			...(fnDescription === "" ? {} : { description: fnDescription }),
			params,
			...(result.kind === ts.SyntaxKind.VoidKeyword ? {} : { result: typeSchema(result, `${name}:`) }),
		};
	}

	const rewrite = new DefinitionRewriter(collected);
	const functions: Record<string, FunctionSchema> = {};
	for (const [name, fn] of Object.entries(raw)) {
		functions[name] = {
			...(fn.description === undefined ? {} : { description: fn.description }),
			params: fn.params.map(
				(param): ParamSchema => ({
					name: param.name,
					...(param.description === undefined ? {} : { description: param.description }),
					...(param.optional ? { optional: true } : {}),
					schema: rewrite.schema(param.schema, `${name}(${param.name}):`) as JsonSchema,
				}),
			),
			...(fn.result === undefined ? {} : { result: rewrite.schema(fn.result, `${name}:`) as JsonSchema }),
		};
	}
	return { program, description, $defs: Object.fromEntries(rewrite.defs), functions, signatures };
}

/**
 * From the generator's naming to the canonical one: `#/definitions/X` becomes `#/$defs/X`, names
 * become identifiers (`Page<string>` → `Page_string`), anonymous types the generator had to name
 * (`def-…`) are inlined, and documentation-only annotations are dropped.
 */
class DefinitionRewriter {
	readonly #source: ReadonlyMap<string, JsonValue>;
	readonly #names = new Map<string, string>();
	/** The rewritten named types, by their new names. */
	readonly defs = new Map<string, JsonSchema>();
	readonly #inlining: string[] = [];

	constructor(source: ReadonlyMap<string, JsonValue>) {
		this.#source = source;
		const taken = new Map<string, string>();
		for (const name of source.keys()) {
			if (isAnonymous(name)) continue;
			const identifier = name
				.replace(/[^A-Za-z0-9_$]+/gu, "_")
				.replace(/_+$/u, "")
				.replace(/^(?=\d)/u, "_");
			const clash = taken.get(identifier);
			if (clash !== undefined) reject("types:", `${clash} and ${name} would both be named ${identifier}`);
			taken.set(identifier, name);
			this.#names.set(name, identifier);
		}
	}

	/** Rewrites one schema node for the function or parameter `where`; schema-holding keywords are followed. */
	schema(value: JsonValue, where: string): JsonValue {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
		const node = value as Record<string, JsonValue>;
		const ref = node["$ref"];
		if (typeof ref === "string" && ref.startsWith("#/definitions/")) {
			const name = ref.slice("#/definitions/".length);
			const target = this.#source.get(name);
			if (target === undefined) return reject(where, `refers to ${name}, which was not collected`);
			if (isAnonymous(name)) {
				if (this.#inlining.includes(name)) return reject(where, "has an unnamed recursive type; give it a name");
				this.#inlining.push(name);
				try {
					return this.schema(target, where);
				} finally {
					this.#inlining.pop();
				}
			}
			const identifier = this.#names.get(name) as string;
			if (!this.defs.has(identifier)) {
				this.defs.set(identifier, {}); // placeholder while its own references are rewritten
				this.defs.set(identifier, this.schema(target, where) as JsonSchema);
			}
			return { $ref: `#/$defs/${identifier}` };
		}
		const not = node["not"];
		if (typeof not === "object" && not !== null && Object.keys(not).length === 0) {
			return reject(where, "has a type including `undefined` (or `never`), which JSON cannot carry");
		}
		const out: Record<string, JsonValue> = {};
		for (const [key, child] of Object.entries(node)) {
			if (DROPPED.has(key)) continue;
			if (SCHEMA_MAPS.has(key) && typeof child === "object" && child !== null && !Array.isArray(child)) {
				out[key] = Object.fromEntries(
					Object.entries(child).map(([name, schema]) => [name, this.schema(schema, where)]),
				);
			} else if (SCHEMA_LISTS.has(key) && Array.isArray(child)) {
				out[key] = child.map((schema) => this.schema(schema, where));
			} else {
				out[key] = SCHEMAS.has(key) ? this.schema(child, where) : child;
			}
		}
		return out;
	}
}

function isAnonymous(name: string): boolean {
	return name.startsWith("def-");
}

/** How a sibling module imports the manifest: `notes.d.ts` as `./notes.js`. */
export function importName(file: string): string {
	return `./${path.basename(file).replace(/\.d\.ts$/u, ".js")}`;
}
