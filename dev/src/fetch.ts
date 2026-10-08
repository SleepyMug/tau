import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pacote from "pacote";

/** A package fetched: its directory, and what removes what fetching it made. */
export interface Fetched {
	readonly dir: string;
	/** `run(dir)`, its errors naming the package as `spec` does, not by where it was unpacked. */
	named<T>(run: (dir: string) => T): T;
	dispose(): void;
}

/**
 * The package `spec` names, as npm names packages: a directory, as it is; or a name, with a version
 * or a range, or a tarball, which npm's fetcher, pacote, fetches from the registry and unpacks into
 * a temporary directory.
 */
export async function fetchPackage(spec: string, cwd: string = process.cwd()): Promise<Fetched> {
	const local = path.resolve(cwd, spec);
	if (existsSync(local) && statSync(local).isDirectory()) return { dir: local, named: (run) => run(local), dispose: () => {} };
	const dir = mkdtempSync(path.join(os.tmpdir(), "tau-package-"));
	const dispose = (): void => rmSync(dir, { recursive: true, force: true });
	try {
		await pacote.extract(spec, dir, { where: cwd });
	} catch (error) {
		dispose();
		throw new Error(`${spec}: cannot be fetched: ${error instanceof Error ? error.message : String(error)}`);
	}
	const named = <T>(run: (dir: string) => T): T => {
		try {
			return run(dir);
		} catch (error) {
			if (error instanceof Error) error.message = error.message.replaceAll(dir, spec);
			throw error;
		}
	};
	return { dir, named, dispose };
}
