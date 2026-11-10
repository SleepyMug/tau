/**
 * `@sleepymug/tau/backend`: the backend SDK, for backends that run taus (docs/spec/backend.md). It
 * knows nothing of how a call reaches the backend, how its files move, or how the agent runs.
 */
export {
	type Admitted,
	type BackendSdk,
	type Collected,
	type Context,
	createBackendSdk,
	initDecision,
	type Placed,
	placesUnder,
	type Rendered,
} from "./backend.js";
