import { type FileDeclaration, type Json, NAME, SELF } from "./model.js";
import { isObject, messageOf } from "./util.js";

/**
 * Placeholders (docs/spec/placeholders.md): `${...}` in the prompt, the args and init, the scope
 * they name in, and what each becomes.
 */

/** What a placeholder's first name names: the tau's own directory, a file, or an arg. */
export type Named = "self" | "file" | "arg";

/** The names a run's placeholders start with, and what each names. */
export type Scope = ReadonlyMap<string, Named>;

/** A prompt, an init, or a string of the args, as text around placeholders: `text` has one more entry than `names`, each a path of names. */
export interface Template {
	readonly text: readonly string[];
	readonly names: readonly (readonly string[])[];
}

/** `$`s before a `{`: one opens a placeholder; more are text, with one `$` less. */
const OPENING = /(\$+)\{/gu;
/** What follows a placeholder's `${`: its names, and the `}` that closes it on its line. */
const INSIDE = /([^}\n]*)(\}?)/uy;
/** What a placeholder in the args names when the scope does not have its name. */
const ARG_UNKNOWN = `neither \${${SELF}}, a file, nor an arg`;

/**
 * The scope of a run: `self`, the files tau.json declares, the args, those the schema declares
 * and those `args` gives, and the other files the call gives, `given`, its extra files, one name
 * naming one thing. A given arg that `self` or a declared file names, and an extra file named as no
 * file can be, or as an arg is, are problems, and out of the scope.
 */
export function scopeOf(
	files: { readonly [name: string]: FileDeclaration },
	declaredArgs: ReadonlySet<string>,
	args: object,
	given: readonly string[],
	problems: string[],
): Scope {
	const scope = new Map<string, Named>([[SELF, "self"]]);
	for (const name of Object.keys(files)) scope.set(name, "file");
	for (const name of [...declaredArgs, ...Object.keys(args)]) {
		const named = scope.get(name) ?? "arg";
		if (named === "arg") scope.set(name, named);
		else problems.push(named === "self" ? `args.${SELF}: names the tau's own directory, which no arg does` : `args.${name}: is a file's name, which no arg has`);
	}
	for (const name of given.filter((name) => !Object.hasOwn(files, name))) {
		if (!NAME.test(name)) problems.push(`${name}: is not a file's name, which matches ${NAME.source}`);
		else if (scope.get(name) === "self") problems.push(`${name}: names the tau's own directory, which no file does`);
		else if (scope.get(name) === "arg") problems.push(`${name}: is an arg's name, which no file has`);
		else scope.set(name, "file");
	}
	return scope;
}

/** Where a value lies in the args: a property's name, or an item's index. */
type Step = string | number;

/**
 * A run's placeholders expanded, each naming what `scope` says: `self` and a file become `placeOf`
 * it, and an arg, or `${name.field}` what lies in one, the expansion of its value, a string as it
 * is and anything else as JSON, and nothing for what the args lack. `args` are the args expanded,
 * each string, and `text` expands a template, the prompt; each placeholder in the args that names
 * what `scope` does not, and each value that names itself, through as many others as it does, is
 * one of `problems`, and expands to nothing.
 */
export function expansion(
	args: { readonly [name: string]: Json },
	scope: Scope,
	placeOf: (name: string) => string,
): { args: { readonly [name: string]: Json }; text: (template: Template) => string; problems: string[] } {
	const problems: string[] = [];
	const done = new Map<string, string>();
	const expanding: { key: string; at: string }[] = [];
	const where = (at: readonly Step[]): string => ["args", ...at].join(".");
	const valueOf = (names: readonly string[]): string => {
		const [first = ""] = names;
		if (scope.get(first) !== "arg") return placeOf(first);
		const found = lookup(args, names);
		return found === undefined ? "" : textOf(value(found, names));
	};
	const value = (item: Json, at: readonly Step[]): Json => {
		if (typeof item === "string") return string(item, at);
		if (Array.isArray(item)) return item.map((entry, index) => value(entry, [...at, index]));
		if (isObject(item)) return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, value(entry as Json, [...at, key])]));
		return item;
	};
	const string = (text: string, at: readonly Step[]): string => {
		const key = JSON.stringify(at);
		const known = done.get(key);
		if (known !== undefined) return known;
		const cycle = expanding.findIndex((entry) => entry.key === key);
		if (cycle !== -1) {
			const through = expanding.slice(cycle + 1).map((entry) => entry.at);
			problems.push(`${where(at)}: names itself${through.length === 0 ? "" : `, through ${through.join(", ")}`}`);
			return "";
		}
		expanding.push({ key, at: where(at) });
		let expanded = "";
		try {
			expanded = expand(parseTemplate(text, (inside) => placeholderProblem(inside, scope, ARG_UNKNOWN), () => where(at)), valueOf);
		} catch (error) {
			problems.push(messageOf(error));
		}
		expanding.pop();
		done.set(key, expanded);
		return expanded;
	};
	const expanded = value(args, []) as { readonly [name: string]: Json };
	return { args: expanded, text: (template) => expand(template, valueOf), problems };
}

/** What `names` finds in the args: through as many objects as it lies in; undefined for what they lack. */
function lookup(args: { readonly [name: string]: Json }, names: readonly string[]): Json | undefined {
	let value: Json | undefined = args;
	for (const name of names) value = isObject(value) && Object.hasOwn(value, name) ? (value[name] as Json) : undefined;
	return value;
}

/** A value as a placeholder becomes it: a string as it is, anything else as JSON. */
function textOf(value: Json): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * `source` as a template, each placeholder checked by `problemOf`, and named in what it throws as
 * `where` says from its line.
 */
export function parseTemplate(
	source: string,
	problemOf: (inside: string) => string | undefined,
	where: (line: number) => string,
): Template {
	const text: string[] = [];
	const names: string[][] = [];
	let chunk = "";
	let last = 0;
	const opening = new RegExp(OPENING);
	for (let match = opening.exec(source); match !== null; match = opening.exec(source)) {
		const dollars = match[1] as string;
		chunk += source.slice(last, match.index);
		last = opening.lastIndex;
		if (dollars.length > 1) {
			chunk += `${dollars.slice(1)}{`;
			continue;
		}
		INSIDE.lastIndex = last;
		const [rest, inside = "", closed] = INSIDE.exec(source) as RegExpExecArray;
		const placeholder = `\${${rest}`;
		const at = where(source.slice(0, match.index).split("\n").length);
		if (closed === "") throw new TypeError(`${at}: ${placeholder} is not closed; write $\${ for a literal \${`);
		const problem = problemOf(inside);
		if (problem !== undefined) throw new TypeError(`${at}: ${placeholder} ${problem}`);
		last += rest.length;
		opening.lastIndex = last;
		text.push(chunk);
		names.push(inside.split("."));
		chunk = "";
	}
	text.push(chunk + source.slice(last));
	return { text, names };
}

/**
 * Why `${inside}` cannot be a placeholder in `scope`, if it cannot: its first name is not in it,
 * which `unknown` says, or it names what lies in `self` or a file.
 */
export function placeholderProblem(inside: string, scope: Scope, unknown: string): string | undefined {
	const [first = "", ...rest] = inside.split(".");
	if ([first, ...rest].some((name) => name === "")) return "names nothing between its dots; write $\${ for a literal \${";
	const named = scope.get(first);
	if (named === undefined) return `names ${unknown}; write $\${ for a literal \${`;
	if (named !== "arg" && rest.length > 0) return `names what lies in ${named === "self" ? "the tau's own directory" : `the file ${first}`}, which is a path`;
	return undefined;
}

/** A path as one word for `sh`: as it is when nothing in it is special, else in single quotes. */
export function shellWord(text: string): string {
	return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

export function expand(template: Template, valueOf: (names: readonly string[]) => string): string {
	return template.names.reduce((text, names, index) => text + valueOf(names) + template.text[index + 1], template.text[0] as string);
}
