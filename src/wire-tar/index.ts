/**
 * `@sleepymug/tau/wire-tar`: calls and results as tar archives (docs/spec/serialization.md), a
 * format a wire adaptor and its backend may share; nothing in the protocol asks for it.
 */
export {
	type Archive,
	ArchiveError,
	decodeCall,
	decodeResult,
	encodeCall,
	encodeResult,
	packCall,
	packResult,
	unpackCall,
	unpackResult,
} from "./archive.js";
export { packContract, unpackContract } from "./contract.js";
