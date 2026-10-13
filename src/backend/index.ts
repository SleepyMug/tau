/**
 * `@sleepymug/tau/backend`: the backend SDK, for backends that run taus (docs/spec/backend.md). It
 * knows nothing of how a call reaches the backend, how its files move, or how the agent runs.
 */
export {
	type Admitted,
	type BackendOptions,
	type BackendSdk,
	type Collected,
	catalogOf,
	createBackendSdk,
	type Implementation,
	type ImplementationCatalog,
	initDecision,
	type Link,
	type Placed,
	placesUnder,
	type Rendered,
} from "./backend.js";
