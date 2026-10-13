/** `@sleepymug/tau/adaptors`: the wire adaptors built into tau. */
export { anyImplementation, createDummyAdaptor, type DummyAgent, type DummyOptions, type DummyRun, echoAgent } from "./dummy.js";
export {
	createFleetAdaptor,
	FLEET_PROTOCOL,
	type FleetAnswer,
	type FleetHandler,
	type FleetOptions,
	type FleetRequest,
	type FleetRunRequest,
	type FleetTransport,
	fleetLoopback,
	readFleetRunRequest,
} from "./fleet.js";
export { defaultFleetSocket, FleetUnreachable, fleetSocket, listenFleet } from "./fleet-socket.js";
