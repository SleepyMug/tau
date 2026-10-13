/**
 * `@sleepymug/tau/transfer`: helpers for moving a run's files, which a wire adaptor and a backend
 * may use, or not (docs/spec/protocol.md#transfer): contents as streams of entries, checked as they
 * come, and outputs put at the caller's paths.
 */
export {
	type Content,
	type ContentEntry,
	type ContentSource,
	ContentTree,
	checkContents,
	type EntryType,
	extractContent,
	jobContents,
	kindAt,
	readContents,
} from "./content.js";
export { deliver, mergeOutputs, removeAll } from "./deliver.js";
