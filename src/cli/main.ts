#!/usr/bin/env node
import { main } from "./cli.js";

process.exitCode = await main(process.argv.slice(2), {
	cwd: process.cwd(),
	env: process.env,
	stdin: process.stdin,
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
});
