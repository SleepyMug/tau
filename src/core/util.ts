export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Refuses the first key of `rest`, what is left of an object once its known keys are taken. */
export function refuseKeys(rest: Record<string, unknown>, where: string): void {
	const [key] = Object.keys(rest);
	if (key !== undefined) throw new TypeError(`${where}: unknown key ${JSON.stringify(key)}`);
}
