import path from "node:path";
import { create, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { ConnectError, createClient, type Transport } from "@connectrpc/connect";
import type { WireAdaptor } from "../client/adaptor.js";
import { readStatus, readTrace } from "../core/forms.js";
import { messageOf } from "../core/util.js";
import { packCall, unpackResult } from "../wire-tar/archive.js";
import { Runs, SubmitRequestSchema } from "../gen/tau/v1/runs_pb.js";

/**
 * The rpc wire adaptor (docs/spec/rpc.md): a run on a backend that serves `tau.v1.Runs`, over a
 * Connect transport, such as {@link rpcTransport}'s to a socket, a gateway's that carries the
 * calls to the backend, or a backend's own routes in the caller's process.
 */

export interface RpcOptions {
	readonly transport: Transport;
	/** The caller's folder, absolute, such as its working directory, which the backend may use, as for where it lists the run. */
	readonly project?: string;
}

/** The rpc wire adaptor, over `transport`. A run's title is the name of its tau's directory. */
export function createRpcAdaptor({ transport, project }: RpcOptions): WireAdaptor {
	const runs = createClient(Runs, transport);
	return {
		async submit(job, signal) {
			async function* requests() {
				yield create(SubmitRequestSchema, { request: { case: "start", value: { title: path.basename(job.tau), ...(project === undefined ? {} : { project }) } } });
				for await (const chunk of packCall(job)) yield create(SubmitRequestSchema, { request: { case: "chunk", value: chunk } });
			}
			const { id } = await backend(runs.submit(requests(), options(signal)));
			if (id === "") throw broke("submit gave no id");
			return id;
		},
		async status(id, signal) {
			const { state } = await backend(runs.status({ id }, options(signal)));
			const json =
				state.case === "running"
					? { state: "running" }
					: state.case === "ended"
						? { state: "ended", result: state.value.result, ok: state.value.ok, ...(state.value.failure === undefined ? {} : { failure: state.value.failure }) }
						: undefined;
			try {
				return readStatus(json);
			} catch (error) {
				throw broke(`status gave no status: ${messageOf(error)}`);
			}
		},
		async result(id, delivery, signal) {
			const responses = runs.result({ id }, options(signal))[Symbol.asyncIterator]();
			const first = await backend(responses.next());
			const result = first.done === true ? undefined : first.value.response;
			if (result?.case !== "result" || result.value < 1) throw broke("result did not first give the result's number");
			async function* archive() {
				try {
					for (let next = await responses.next(); next.done !== true; next = await responses.next()) {
						if (next.value.response.case !== "chunk") throw broke("result gave its number twice");
						yield next.value.response.value;
					}
				} catch (error) {
					throw fromBackend(error);
				}
			}
			return { result: result.value, report: await unpackResult(archive(), delivery) };
		},
		async trace(id, signal) {
			const { format, events } = await backend(runs.trace({ id }, options(signal)));
			try {
				return readTrace({ format, events: events.map((event) => toJson(ValueSchema, event)) });
			} catch (error) {
				throw broke(`trace gave what is no trace: ${messageOf(error)}`);
			}
		},
		async release(id) {
			await backend(runs.release({ id }));
		},
	};
}

function options(signal: AbortSignal | undefined): { signal?: AbortSignal } {
	return signal === undefined ? {} : { signal };
}

/** What the backend answers, its failure as an error whose message is the backend's own. */
async function backend<T>(call: Promise<T>): Promise<T> {
	try {
		return await call;
	} catch (error) {
		throw fromBackend(error);
	}
}

function fromBackend(error: unknown): unknown {
	return error instanceof ConnectError ? new Error(error.rawMessage, { cause: error }) : error;
}

function broke(problem: string): Error {
	return new Error(`the backend broke the protocol: ${problem}`);
}
