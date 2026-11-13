/**
 * `@sleepymug/tau/rpc`: the rpc wire adaptor (docs/spec/rpc.md), runs on a backend that serves
 * `tau.v1.Runs` over Connect: the adaptor for a client, over a transport, and the routes for a
 * backend; and the schema, generated, with its comments, for a backend that registers it.
 */
export { createRpcAdaptor, type RpcOptions } from "./adaptor.js";
export { type RunBackend, runsRoutes } from "./routes.js";
export { defaultRpcPlace, type RpcPlace, rpcTransport } from "./transport.js";
export { Runs } from "../gen/tau/v1/runs_pb.js";
export { descriptors } from "../gen/descriptors.js";
