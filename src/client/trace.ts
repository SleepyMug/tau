import type { Trace } from "../core/model.js";

/**
 * A trace as the `tau` command writes it (docs/spec/client.md#the-tau-command): a line of JSON,
 * `{"format": …}`, then each event, a line of JSON each.
 */
export function traceLines(trace: Trace): string {
	return [{ format: trace.format }, ...trace.events].map((line) => `${JSON.stringify(line)}\n`).join("");
}
