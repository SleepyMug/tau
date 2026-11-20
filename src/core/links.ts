import { type Dirent, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/** What a runtime reads of a tau (docs/spec/directory.md). */
const READ = ["PROMPT.md", "tau.json", "skills"];
/** More links in a row than this is a loop; Linux gives up at 40 too. */
const MAX_HOPS = 40;

/**
 * The symlinks of what a runtime reads of the tau at `dir` that break the spec: each is relative,
 * and leads, through any further symlinks, all relative, to something that exists in the tau and
 * goes with a call, which `excluded`, given a path relative to `dir`, says it does not. A symlink to
 * a directory is followed, and what it leads to is checked the same way. One problem per symlink.
 */
export function linkProblems(dir: string, excluded: (file: string) => boolean = () => false): string[] {
	const root = realpathSync(dir);
	const parts = READ.map((part) => path.join(root, part));
	const relative = (file: string): string => path.relative(root, file).split(path.sep).join("/");
	return rootedLinkProblems(root, parts, { inside: "a tau", outside: "the tau" }, (file) => path.relative(root, file) || ".", (end) => excluded(relative(end)));
}

/**
 * What a runtime reads of the tau at `dir` that `excluded`, given a path relative to `dir`, says
 * does not go with a call: one problem for each, a directory's naming it alone.
 */
export function excludedProblems(dir: string, excluded: (file: string) => boolean): string[] {
	const problems: string[] = [];
	const visit = (file: string): void => {
		const at = path.join(dir, ...file.split("/"));
		let stats;
		try {
			stats = lstatSync(at);
		} catch {
			// A part the tau does not have.
			return;
		}
		if (excluded(file)) problems.push(`${file}: a runtime reads it, so \`exclude\` cannot leave it out`);
		else if (stats.isDirectory()) for (const name of readdirSync(at).sort()) visit(`${file}/${name}`);
	};
	for (const part of READ) visit(part);
	return problems;
}

/**
 * The symlinks in the directory `dir`, the value of an `in` or an `out` (docs/spec/paths.md), that
 * break the spec: each is relative, and leads, through any further symlinks, all relative, to
 * something that exists in `dir`. One problem per symlink, naming it under `dir` as given.
 */
export function valueLinkProblems(dir: string): string[] {
	const root = realpathSync(dir);
	return rootedLinkProblems(root, [root], { inside: dir, outside: dir }, (file) => path.join(dir, path.relative(root, file)));
}

/**
 * The symlinks under `starts` that do not lead, relative and through any further symlinks, all
 * relative, to something that exists in `root`, which is real. A symlink to a directory is
 * followed, and what it leads to is checked the same way. `scope` names `root` in the problems, as
 * what a symlink is in and what it leads outside of, and `label` names each file.
 */
function rootedLinkProblems(
	root: string,
	starts: readonly string[],
	scope: { readonly inside: string; readonly outside: string },
	label: (file: string) => string,
	left: (end: string) => boolean = () => false,
): string[] {
	const problems: string[] = [];
	const walked = new Set<string>();

	/** Where `link` finally leads, or undefined once its problem is recorded. */
	const follow = (link: string): string | undefined => {
		const fail = (problem: string): undefined => {
			problems.push(`${label(link)}: ${problem}`);
			return undefined;
		};
		let at = link;
		for (let hops = 0; hops < MAX_HOPS; hops++) {
			const target = readlinkSync(at);
			const via = at === link ? "" : ` through ${label(at)}`;
			if (path.isAbsolute(target))
				return fail(`leads${via} to the absolute path ${target}; a symlink in ${scope.inside} is relative`);
			let base: string;
			try {
				base = realpathSync(path.dirname(at));
			} catch {
				return fail(`leads${via} to ${label(at)}, which does not exist`);
			}
			at = path.resolve(base, target);
			if (!inside(at, root)) return fail(`leads${via} outside ${scope.outside}, to ${at}`);
			let isLink: boolean;
			try {
				isLink = lstatSync(at).isSymbolicLink();
			} catch {
				return fail(`leads${via} to ${label(at)}, which does not exist`);
			}
			if (isLink) continue;
			const end = realpathSync(at);
			if (!inside(end, root)) return fail(`leads${via} outside ${scope.outside}, to ${end}`);
			return left(end) ? fail(`leads${via} to ${label(end)}, which \`exclude\` leaves out`) : end;
		}
		return fail("is a loop of symlinks");
	};

	const visit = (file: string, entry?: Dirent): void => {
		let isLink: boolean;
		let isDir: boolean;
		if (entry === undefined) {
			try {
				const stats = lstatSync(file);
				[isLink, isDir] = [stats.isSymbolicLink(), stats.isDirectory()];
			} catch {
				// A part the tau does not have.
				return;
			}
		} else [isLink, isDir] = [entry.isSymbolicLink(), entry.isDirectory()];
		if (isLink) {
			const end = follow(file);
			if (end !== undefined && statSync(end).isDirectory()) walk(end);
		} else if (isDir) walk(file);
	};
	const walk = (directory: string): void => {
		if (walked.has(directory)) return;
		walked.add(directory);
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch (error) {
			problems.push(`${label(directory)}: cannot be read: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		// In order of name, so that the problems are listed the same way on every file system.
		entries.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
		for (const entry of entries) visit(path.join(directory, entry.name), entry);
	};

	for (const start of starts) visit(start);
	return problems;
}

/** Whether `file` is `directory` or lies inside it; both absolute and normalized. */
export function inside(file: string, directory: string): boolean {
	return file === directory || file.startsWith(directory.endsWith(path.sep) ? directory : directory + path.sep);
}
