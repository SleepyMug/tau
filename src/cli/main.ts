#!/usr/bin/env node
import { main } from "./cli.js";

// The first interrupt aborts what the command waits for; another ends it at once.
const interrupted = new AbortController();
for (const name of ["SIGINT", "SIGTERM"] as const)
	process.on(name, () => {
		if (interrupted.signal.aborted) process.exit(130);
		interrupted.abort(new Error(`interrupted by ${name}`));
	});

process.exitCode = await main(process.argv.slice(2), {
	cwd: process.cwd(),
	env: process.env,
	stdin: process.stdin,
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
	signal: interrupted.signal,
});
