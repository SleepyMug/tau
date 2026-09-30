import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type Codec, codecOf } from "./codec.js";
import { printDeclarations } from "./schema/declarations.js";
import { canonicalService, type ServiceSchema } from "./schema/service-schema.js";
import { readManifest } from "./read-manifest.js";
import { verifyTranslation } from "./verify.js";

/** Names the socket a provider serves a tau's services on (SPEC.md). */
export const TAU_SOCKET = "TAU_SOCKET";

/**
 * A service a tau declares in `api/<name>.d.ts`, checked against the spec: its calls, as runtimes
 * and providers handle them (see {@link Codec}), and the manifest as written.
 */
export interface Service extends Codec {
	/** The manifest as written: the declarations of `@svc/<name>`, e.g. for its `index.d.ts`. */
	readonly declarations: string;
}

/** Every `api/*.d.ts` of the tau at `dir`, by name; none when there is no api/. */
export function loadServices(dir: string): Service[] {
	return serviceNames(dir).map((name) => loadService(path.join(dir, "api", `${name}.d.ts`)));
}

/** The names of the services the tau at `dir` declares, sorted, without reading the manifests. */
export function serviceNames(dir: string): string[] {
	const api = path.join(dir, "api");
	if (!existsSync(api)) return [];
	return readdirSync(api)
		.filter((file) => file.endsWith(".d.ts"))
		.map((file) => file.slice(0, -".d.ts".length))
		.sort();
}

/**
 * One manifest, `<name>.d.ts`: its exported functions are the service's, and its TSDoc package
 * documentation the service's description. It is translated to JSON Schema, and refused, with the
 * reason, unless `tsc` finds the translation means exactly what the manifest says.
 */
export function loadService(file: string): Service {
	const absolute = path.resolve(file);
	const name = path.basename(absolute, ".d.ts");
	try {
		const text = readFileSync(absolute, "utf8");
		const read = readManifest(absolute, text);
		const canonical = canonicalService({
			name,
			...(read.description === undefined ? {} : { description: read.description }),
			...(Object.keys(read.$defs).length === 0 ? {} : { $defs: read.$defs }),
			functions: read.functions,
		} satisfies ServiceSchema);
		// The printed declarations only prove the translation; programs see the manifest itself.
		verifyTranslation(absolute, read, printDeclarations(canonical));
		return { ...codecOf(canonical), declarations: text };
	} catch (error) {
		throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
	}
}
