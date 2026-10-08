#!/usr/bin/env node
import { addContract, updateContracts } from "./add.js";
import { checkTau } from "./check.js";
import { checkContract, diffContracts } from "./contract.js";

const USAGE = [
	"usage: tau check [dir]                  check a tau",
	"       tau add <alias> <package>         copy a contract into the tau here, as api/<alias>/",
	"       tau update [alias...]             copy in the newest version that serves each API",
	"       tau contract check [dir]          check a contract",
	"       tau contract diff <old> <new>     check that a contract's version may follow another's",
].join("\n");

/** What a command line runs, or undefined when it is not one. */
function command(args: readonly string[]): (() => Promise<string | undefined>) | undefined {
	const [first, second, ...rest] = args;
	switch (first) {
		case "check":
			if (rest.length > 0) return undefined;
			return async () => void checkTau(second);
		case "add":
			if (second === undefined || rest.length !== 1) return undefined;
			return async () => {
				const { name, version } = await addContract(second, rest[0] as string);
				return `api/${second}: ${name}@${version}`;
			};
		case "update":
			return async () =>
				(await updateContracts(args.slice(1))).map(({ alias, was, is }) => `api/${alias}: ${was === is ? is : `${was} -> ${is}`}`).join("\n");
		case "contract":
			if (second === "check" && rest.length <= 1) return async () => void checkContract(rest[0] ?? process.cwd());
			if (second === "diff" && rest.length === 2) return async () => diffContracts(rest[0] as string, rest[1] as string).then(() => undefined);
			return undefined;
		default:
			return undefined;
	}
}

const args = process.argv.slice(2);
const run = command(args);
if (args[0] === "-h" || args[0] === "--help") console.log(USAGE);
else if (run === undefined) {
	console.error(USAGE);
	process.exitCode = 2;
} else {
	try {
		const output = await run();
		if (output !== undefined && output !== "") console.log(output);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
