import { readFileSync } from "node:fs";
import path from "node:path";

/** A package of the tau's own that it exposes to the agent's programs (docs/spec/packages.md). */
export interface Exposed {
	/** The package's name, which programs import. */
	readonly specifier: string;
	/** Its package.json's `description`, if it has one. */
	readonly description: string | undefined;
	/** `node_modules/<name>` in the tau, absolute: where Node.js finds it. */
	readonly dir: string;
}

/**
 * What the tau whose real directory is `root` exposes, as `exposes` lists it, in its order; none
 * without the list. Each name it lists is a package in its node_modules/, with a package.json.
 * Each problem is pushed to `problems`.
 */
export function readExposed(root: string, exposes: readonly string[] | undefined, problems: string[]): Exposed[] {
	const exposed: Exposed[] = [];
	for (const specifier of exposes ?? []) {
		const dir = path.join(root, "node_modules", ...specifier.split("/"));
		let manifest: { description?: unknown };
		try {
			manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { description?: unknown };
		} catch {
			problems.push(`exposes ${specifier}, which is no package in node_modules/`);
			continue;
		}
		const { description } = manifest;
		exposed.push({ specifier, description: typeof description === "string" && description.trim() !== "" ? description : undefined, dir });
	}
	return exposed;
}
