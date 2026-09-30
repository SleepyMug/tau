import { type Dirent, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

/** What a runtime reads of every tau; `copy` adds the rest. */
const READ = ["PROMPT.md", "tau.json", "skills", "api"];
/** Where a runtime puts its services for modules, in place of what the tau has there. */
const SERVICES = path.join("modules", "node_modules", "@svc");
/** More links in a row than this is a loop; Linux gives up at 40 too. */
const MAX_HOPS = 40;

/**
 * The symlinks of what a runtime reads of the tau at `dir`, `copy` included, that break the spec:
 * each is relative, and leads, through any further symlinks, all relative, to something that
 * exists in the tau. One in what the tau copies leads into what it copies, except under
 * modules/node_modules/@svc/, which the runtime replaces. A symlink to a directory is followed,
 * and what it leads to is checked the same way. One problem per symlink.
 */
export function linkProblems(dir: string, copy: readonly string[]): string[] {
	const root = realpathSync(dir);
	const copied = copy.map((entry) => path.join(root, entry));
	const services = path.join(root, SERVICES);
	const relative = (file: string): string => path.relative(root, file) || ".";
	const problems: string[] = [];
	const walked = new Set<string>();

	/** Where `link` finally leads, or undefined once its problem is recorded. */
	const follow = (link: string): string | undefined => {
		const fail = (problem: string): undefined => {
			problems.push(`${relative(link)}: ${problem}`);
			return undefined;
		};
		let at = link;
		for (let hops = 0; hops < MAX_HOPS; hops++) {
			const target = readlinkSync(at);
			const via = at === link ? "" : ` through ${relative(at)}`;
			if (path.isAbsolute(target)) return fail(`leads${via} to the absolute path ${target}; a symlink in a tau is relative`);
			let base: string;
			try {
				base = realpathSync(path.dirname(at));
			} catch {
				return fail(`leads${via} to ${relative(at)}, which does not exist`);
			}
			at = path.resolve(base, target);
			if (!inside(at, root)) return fail(`leads${via} outside the tau, to ${at}`);
			let isLink: boolean;
			try {
				isLink = lstatSync(at).isSymbolicLink();
			} catch {
				return fail(`leads${via} to ${relative(at)}, which does not exist`);
			}
			if (isLink) continue;
			const end = realpathSync(at);
			return inside(end, root) ? end : fail(`leads${via} outside the tau, to ${end}`);
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
				// A part the tau does not have; the listed paths are checked for existence elsewhere.
				return;
			}
		} else [isLink, isDir] = [entry.isSymbolicLink(), entry.isDirectory()];
		if (isLink) {
			const end = follow(file);
			if (end === undefined) return;
			if (isCopied(file) && !inside(file, services) && !isCopied(end))
				problems.push(`${relative(file)}: leads to ${relative(end)}, which the tau does not copy`);
			else if (statSync(end).isDirectory()) walk(end);
		} else if (isDir) walk(file);
	};
	const walk = (directory: string): void => {
		if (walked.has(directory)) return;
		walked.add(directory);
		for (const entry of readdirSync(directory, { withFileTypes: true })) visit(path.join(directory, entry.name), entry);
	};
	const isCopied = (file: string): boolean => copied.some((listed) => inside(file, listed));

	for (const part of [...READ, ...copy]) visit(path.join(root, part));
	return problems;
}

/** Whether `file` is `directory` or lies inside it; both absolute and normalized. */
export function inside(file: string, directory: string): boolean {
	return file === directory || file.startsWith(directory.endsWith(path.sep) ? directory : directory + path.sep);
}
