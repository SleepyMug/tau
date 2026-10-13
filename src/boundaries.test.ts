import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Which modules each module may import (docs/spec/protocol.md#modules): the core none; the client,
 * the backend SDK and the transfer helpers the core alone, none of them another, so that neither
 * the client nor the backend SDK knows how files move; the tar codec the transfer helpers too; a
 * wire adaptor any of those; and the command, which puts the client and its adaptors together.
 */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
	core: [],
	client: ["core"],
	backend: ["core"],
	transfer: ["core"],
	"wire-tar": ["core", "transfer"],
	adaptors: ["core", "client", "backend", "transfer", "wire-tar"],
	cli: ["core", "client", "adaptors"],
};

test("each module imports only what it may", () => {
	// The sources, from the tests built into dist/.
	const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
	const problems: string[] = [];
	for (const [module, allowed] of Object.entries(ALLOWED))
		for (const file of readdirSync(path.join(src, module)).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
			const text = readFileSync(path.join(src, module, file), "utf8");
			for (const [, specifier] of text.matchAll(/^(?:import|export)[^;]*? from "(\.\.?\/[^"]+)";$/gmu)) {
				const [top] = path.relative(src, path.resolve(src, module, specifier as string)).split(path.sep);
				if (top !== module && !allowed.includes(top as string)) problems.push(`${module}/${file} imports ${specifier}`);
			}
		}
	assert.deepEqual(problems, []);
});
