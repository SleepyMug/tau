import path from "node:path";
import { create, fromJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { Code, type ConnectRouter, ConnectError, type HandlerContext } from "@connectrpc/connect";
import type { Status, Trace } from "../core/model.js";
import { ResultResponseSchema, Runs, type SubmitRequest } from "../gen/tau/v1/runs_pb.js";

/**
 * A backend of the rpc adaptor (docs/spec/rpc.md), as its routes serve it: a run's life, each call
 * checked as from a client the backend does not trust before it gets here. Who calls is the
 * transport's to say, as the context of each call carries it, never the request's.
 *
 * A failure is a `ConnectError`: a call refused as `invalid_argument`, a run not known as
 * `not_found`, a result asked of a run without one as `failed_precondition`; any other error is
 * the backend's own, `internal`.
 */
export interface RunBackend {
	/** Start a run of `call`, a tar archive that carries its tau, named `title`; gives its id. */
	submit(call: AsyncIterable<Uint8Array>, start: { readonly title: string; readonly project?: string }, signal: AbortSignal): Promise<string>;
	/** Where the run `id` is, at once. */
	status(id: string, signal: AbortSignal): Promise<Status>;
	/** The run `id`'s latest result: its number, and the result, as a tar archive. */
	result(id: string, signal: AbortSignal): Promise<{ readonly result: number; readonly archive: AsyncIterable<Uint8Array> }>;
	/** What the run `id`'s agent did so far. */
	trace(id: string, signal: AbortSignal): Promise<Trace>;
	/** Drop the run `id`, stopping it if it has not ended. */
	release(id: string): Promise<void>;
}

/** `tau.v1.Runs`, served from the backend `backendOf` gives for each call's context, as by who calls. */
export function runsRoutes(backendOf: (context: HandlerContext) => RunBackend | Promise<RunBackend>): (router: ConnectRouter) => void {
	return (router) => {
		router.service(Runs, {
			async submit(requests, context) {
				const iterator = requests[Symbol.asyncIterator]();
				const first = await iterator.next();
				if (first.done === true || first.value.request.case !== "start") throw invalid("a submit starts with what names the run");
				const { title, project } = first.value.request.value;
				if (title.trim() === "") throw invalid("a submit takes a title");
				if (project !== undefined && !path.isAbsolute(project)) throw invalid("a submit's project is an absolute path, if anything");
				const backend = await backendOf(context);
				return { id: await backend.submit(call(iterator), project === undefined ? { title } : { title, project }, context.signal) };
			},
			async status({ id }, context) {
				const status = await (await backendOf(context)).status(known(id), context.signal);
				return status.state === "running"
					? { state: { case: "running", value: {} } }
					: { state: { case: "ended", value: { result: status.result, ok: status.ok, ...(status.failure === undefined ? {} : { failure: status.failure }) } } };
			},
			async *result({ id }, context) {
				const { result, archive } = await (await backendOf(context)).result(known(id), context.signal);
				yield create(ResultResponseSchema, { response: { case: "result", value: result } });
				for await (const chunk of archive) yield create(ResultResponseSchema, { response: { case: "chunk", value: chunk } });
			},
			async trace({ id }, context) {
				const { format, events } = await (await backendOf(context)).trace(known(id), context.signal);
				return { format, events: events.map((event) => fromJson(ValueSchema, event as never)) };
			},
			async release({ id }, context) {
				await (await backendOf(context)).release(known(id));
				return {};
			},
		});
	};
}

/** The call a submit carries after its first request. */
async function* call(iterator: AsyncIterator<SubmitRequest>): AsyncGenerator<Uint8Array> {
	for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
		if (next.value.request.case !== "chunk") throw invalid("a submit names its run once");
		yield next.value.request.value;
	}
}

function known(id: string): string {
	if (id === "") throw invalid("the run's id is missing");
	return id;
}

function invalid(message: string): ConnectError {
	return new ConnectError(message, Code.InvalidArgument);
}
