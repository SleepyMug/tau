import { chmod, cp, lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkReport, outputKinds, readReport } from "../core/forms.js";
import type { Delivery, Report } from "../core/model.js";
import { messageOf } from "../core/util.js";
import { type Content, checkContents, extractContent } from "./content.js";

/** Putting a run's outputs at the caller's paths, as docs/spec/results.md has it, for a wire adaptor to use. */

/** What a backend gave back that breaks the protocol, or does not fit the run. */
class Unfit extends Error {}

/**
 * Put what a backend gave back at the caller's paths: `json`, its report, as it came, and
 * `contents`, the content of each output, as they come. The report is checked, as a report and
 * against `delivery.files`, and each content whole, before anything is put; then each output is
 * merged at its target (see {@link mergeOutputs}).
 * @returns the report; or, when what came breaks the protocol or does not fit the run, a run that
 * failed, with why, which puts nothing.
 */
export async function deliver(json: unknown, contents: AsyncIterable<Content>, delivery: Delivery): Promise<Report> {
	let report: Report;
	try {
		report = readReport(json);
	} catch (error) {
		return { ok: false, text: "", failure: `the report breaks the protocol: ${messageOf(error)}`, outputs: {} };
	}
	try {
		checkReport(report, delivery.files);
	} catch (error) {
		return { ok: false, text: report.text, failure: messageOf(error), outputs: {} };
	}
	const scratch = await mkdtemp(path.join(os.tmpdir(), "tau-result-"));
	try {
		const refuse = (problem: string): never => {
			throw new Unfit(`the result breaks the protocol: ${problem}`);
		};
		const staged: Record<string, string> = {};
		try {
			for await (const content of checkContents(contents, outputKinds(report), refuse)) {
				const file = content.file as string;
				staged[file] = path.join(scratch, file);
				await extractContent(content, staged[file]);
			}
		} catch (error) {
			if (!(error instanceof Unfit)) throw error;
			return { ok: false, text: report.text, failure: error.message, outputs: {} };
		}
		await mergeOutputs(staged, delivery.targets);
	} finally {
		await removeAll(scratch);
	}
	return report;
}

/**
 * Put each output, `staged` at a path of its own, by its file's name, at its target: a directory
 * merges into a directory there, each of its entries put the same way, and anything else replaces
 * what is there, as a copy that keeps modes and symlinks; a target's symlinks are followed, and
 * targets that lie in one another are put outer first. What is staged is not checked here; see
 * `checkOutputs`, of the core, for that.
 * @throws for an output with no target, before anything is put.
 */
export async function mergeOutputs(staged: { readonly [name: string]: string }, targets: { readonly [name: string]: string }): Promise<void> {
	const given = Object.keys(staged).map((name) => {
		const to = targets[name];
		if (to === undefined) throw new Error(`${name}: has no target`);
		return { from: staged[name] as string, to };
	});
	given.sort((a, b) => depth(a.to) - depth(b.to));
	for (const { from, to } of given) await put(from, await realpath(to).catch(() => to));
}

function depth(file: string): number {
	return path.resolve(file).split(path.sep).length;
}

async function put(from: string, to: string): Promise<void> {
	if ((await lstat(from)).isDirectory() && (await lstat(to).catch(() => undefined))?.isDirectory() === true) {
		for (const name of await readdir(from)) await put(path.join(from, name), path.join(to, name));
		return;
	}
	await rm(to, { recursive: true, force: true });
	await cp(from, to, { recursive: true, verbatimSymlinks: true });
}

/** Remove a directory and all it holds, directories that are not writable included. */
export async function removeAll(dir: string): Promise<void> {
	const open = async (file: string): Promise<void> => {
		const stats = await lstat(file).catch(() => undefined);
		if (stats?.isDirectory() !== true) return;
		await chmod(file, 0o700);
		for (const name of await readdir(file)) await open(path.join(file, name));
	};
	await open(dir);
	await rm(dir, { recursive: true, force: true });
}
