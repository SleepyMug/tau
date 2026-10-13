import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Delivery } from "../core/model.js";

/**
 * What the client keeps of each run it started, until it is released, so that whoever finishes it,
 * in this process or another, can have its outputs put at the caller's paths.
 */
export interface RunRecord extends Delivery {
	/** The name of the wire adaptor that carries it. */
	readonly adaptor: string;
	/** The run's id, as the adaptor knows it. */
	readonly id: string;
}

/** Where the client keeps its runs, by the id it gives each. */
export interface RunStore {
	put(run: string, record: RunRecord): Promise<void>;
	get(run: string): Promise<RunRecord | undefined>;
	delete(run: string): Promise<void>;
}

/** Runs kept in memory, for those finished in the process that starts them. */
export function memoryRunStore(): RunStore {
	const runs = new Map<string, RunRecord>();
	return {
		put: async (run, record) => void runs.set(run, record),
		get: async (run) => runs.get(run),
		delete: async (run) => void runs.delete(run),
	};
}

/** Runs kept as files in `dir`, one each, for any process to finish. */
export function fileRunStore(dir: string): RunStore {
	const file = (run: string): string => path.join(dir, `${encodeURIComponent(run)}.json`);
	return {
		async put(run, record) {
			await mkdir(dir, { recursive: true });
			await writeFile(file(run), `${JSON.stringify(record, undefined, 2)}\n`, { mode: 0o600 });
		},
		async get(run) {
			try {
				return JSON.parse(await readFile(file(run), "utf8")) as RunRecord;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw error;
			}
		},
		async delete(run) {
			await rm(file(run), { force: true });
		},
	};
}
