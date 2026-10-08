/** What this package uses of pacote, npm's fetcher, which has no types of its own. */
declare module "pacote" {
	/** Fetch the package `spec` names, as npm names packages, and unpack it into `dest`. */
	export function extract(spec: string, dest: string, options?: { readonly where?: string }): Promise<{ readonly resolved: string }>;
	const pacote: { extract: typeof extract };
	export default pacote;
}
