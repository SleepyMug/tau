/**
 * `@sleepymug/tau`: the client SDK (docs/spec/client.md). It checks a tau and a call where the
 * caller is, and hands the run to a wire adaptor, which carries it to a backend and puts what comes
 * back at the caller's paths.
 */
export * from "./client/index.js";
export { createDummyAdaptor, type DummyAgent, type DummyOptions, type DummyRun } from "./adaptors/index.js";
export {
	type CallFile,
	type Delivery,
	type Envelope,
	type FileDeclaration,
	type Job,
	type Json,
	type Kind,
	type Mode,
	type Outcome,
	type Report,
	type ResolvedCall,
	type Tau,
	loadTau,
} from "./core/index.js";
