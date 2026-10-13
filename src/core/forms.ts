import { type CallFile, type Envelope, type Json, KINDS, type Kind, MODES, NAME, type Report } from "./model.js";
import { isObject, refuseKeys } from "./util.js";

/**
 * The forms of what the client and the backend send each other (docs/spec/protocol.md), checked
 * as one side must check what comes from the other, before anything else is checked.
 */

/**
 * `json` as an envelope that is sent: `files`, each by a file's name, with its `mode`, its `base`,
 * and its `kind`, which an `in` and an `inout` have, the kind of their content; and `args`, an
 * object. Throws TypeError for the first problem.
 */
export function readEnvelope(json: unknown): Envelope {
	const { files, args, ...rest } = record(json, "it");
	refuseKeys(rest, "it");
	for (const [name, file] of Object.entries(record(files, "`files`"))) {
		if (!NAME.test(name)) throw new TypeError(`\`files\`: ${JSON.stringify(name)} is not a file's name, which matches ${NAME.source}`);
		const at = `\`files\`.${name}`;
		const { mode, base, kind, ...others } = record(file, at);
		refuseKeys(others, at);
		if (typeof mode !== "string" || !(MODES as readonly string[]).includes(mode)) throw new TypeError(`${at}: \`mode\` is "in", "out" or "inout"`);
		checkBase(base, at);
		// An `out` has no content, so its kind is what the agent must leave, if the call says.
		if (mode !== "out" || kind !== undefined) checkKind(kind, at);
	}
	record(args, "`args`");
	return json as { files: Envelope["files"]; args: { [name: string]: Json } };
}

/**
 * `json` as a report: `ok`, `text`, `failure`, only when the run failed, and `outputs`, each by a
 * file's name, with its `kind`. Throws TypeError for the first problem.
 */
export function readReport(json: unknown): Report {
	const { ok, text, failure, outputs, ...rest } = record(json, "it");
	refuseKeys(rest, "it");
	if (typeof ok !== "boolean") throw new TypeError("`ok` is true or false");
	if (typeof text !== "string") throw new TypeError("`text` is a string");
	if (failure !== undefined && (ok || typeof failure !== "string")) throw new TypeError("`failure` is a string, only when the run failed");
	for (const [name, output] of Object.entries(record(outputs, "`outputs`"))) {
		if (!NAME.test(name)) throw new TypeError(`\`outputs\`: ${JSON.stringify(name)} is not a file's name, which matches ${NAME.source}`);
		const at = `\`outputs\`.${name}`;
		const { kind, ...others } = record(output, at);
		refuseKeys(others, at);
		checkKind(kind, at);
	}
	return json as unknown as Report;
}

/**
 * Whether a report fits the run of `files`: each output an `out` or `inout` file's, of the kind it
 * is, if it has one; and if the run succeeded, every such file has one. Throws, listing every
 * problem.
 */
export function checkReport(report: Report, files: { readonly [name: string]: CallFile }): void {
	const problems: string[] = [];
	const given = new Map(Object.entries(files).filter(([, { mode }]) => mode !== "in"));
	for (const [name, { kind }] of Object.entries(report.outputs)) {
		const file = given.get(name);
		if (file === undefined) {
			problems.push(`${name}: is no \`out\` or \`inout\` file of the run`);
			continue;
		}
		if (file.kind !== undefined && kind !== file.kind)
			problems.push(`${name}: is ${file.kind === "dir" ? "a directory" : "a file"}, given back as ${kind === "dir" ? "a directory" : "a file"}`);
	}
	if (report.ok) for (const name of given.keys()) if (!Object.hasOwn(report.outputs, name)) problems.push(`${name}: the run succeeded, but gave nothing back for it`);
	if (problems.length > 0) throw new Error(`the report does not fit the run:\n  ${problems.join("\n  ")}`);
}

/** The kind of what each `in` and `inout` file of an envelope holds, by its name. */
export function inputKinds(envelope: Envelope): Map<string, Kind> {
	const kinds = new Map<string, Kind>();
	for (const [name, { mode, kind }] of Object.entries(envelope.files)) if (mode !== "out") kinds.set(name, kind as Kind);
	return kinds;
}

/** The kind of each output of a report, by its file's name. */
export function outputKinds(report: Report): Map<string, Kind> {
	return new Map(Object.entries(report.outputs).map(([name, { kind }]) => [name, kind]));
}

function checkKind(kind: unknown, at: string): void {
	if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) throw new TypeError(`${at}: \`kind\` is "file" or "dir"`);
}

/** A base name: not empty, not `.` or `..`, with no `/` and no NUL. */
function checkBase(base: unknown, at: string): void {
	if (typeof base !== "string" || base === "" || base === "." || base === ".." || /[/\0]/u.test(base))
		throw new TypeError(`${at}: \`base\` is a base name, not empty, \`.\` or \`..\`, with no / and no NUL`);
}

function record(value: unknown, at: string): Record<string, unknown> {
	if (!isObject(value)) throw new TypeError(`${at}: is an object`);
	return value;
}
