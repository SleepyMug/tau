import path from "node:path";

/** What no client carries of a tau, whatever its `exclude` says (docs/spec/directory.md). */
export const AUTHOR_DIR = ".tau";

/**
 * Whether a path in a tau, relative to its directory and `/`-separated, is left out of what goes
 * with a call, as `exclude`'s patterns say (docs/spec/metadata.md): it, or a directory it is in,
 * matches one, or is `.tau/`.
 */
export function excluder(patterns: readonly string[]): (file: string) => boolean {
	const all = [AUTHOR_DIR, ...patterns];
	return (file) => {
		const parts = file.split("/");
		for (let end = 1; end <= parts.length; end++) {
			const at = parts.slice(0, end).join("/");
			if (all.some((pattern) => path.posix.matchesGlob(at, pattern))) return true;
		}
		return false;
	};
}
