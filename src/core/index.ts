/**
 * `@sleepymug/tau/core`: the tau format and the semantics of a run, which the client and the
 * backend SDK share: JSON and paths, and nothing of how a run's files travel (docs/spec/protocol.md).
 */
export { API_SCOPE, type Api, type Contract, type Exposed, parseVersion, readContract, serves } from "./apis.js";
export { checkReport, inputKinds, outputKinds, readEnvelope, readReport } from "./forms.js";
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
	type Output,
	type Report,
	type ResolvedCall,
	TAU_FALLBACK,
	TAU_RUN,
	TAU_SKIP,
} from "./model.js";
export { checkInputs, checkOutputs, checkPlaced, kindAt } from "./paths.js";
export { type Expanded, loadTau, type Skill, type Tau } from "./tau.js";
