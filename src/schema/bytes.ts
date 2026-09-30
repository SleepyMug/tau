/**
 * Bytes on the wire (SPEC.md, Calls): base64 as RFC 4648 §4 has it, the standard alphabet with
 * padding. Programs and providers hold them as a `Uint8Array`.
 */

/** Whether `value` is bytes: a `Uint8Array`, from any realm, a Node `Buffer` included. */
export function isBytes(value: unknown): value is Uint8Array {
	return ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === "[object Uint8Array]";
}

/** Whether `text` is base64: whole groups of four from the standard alphabet, padded with `=`. */
export function isBase64(text: string): boolean {
	if (text.length % 4 !== 0) return false;
	const end = text.endsWith("==") ? text.length - 2 : text.endsWith("=") ? text.length - 1 : text.length;
	for (let index = 0; index < end; index++) {
		const code = text.charCodeAt(index);
		const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
		const digit = code >= 48 && code <= 57;
		if (!letter && !digit && code !== 43 && code !== 47) return false;
	}
	return true;
}

/** The base64 of `bytes`. */
export function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** The bytes of `text`, checked with {@link isBase64}, in a `Uint8Array` of their own. */
export function fromBase64(text: string): Uint8Array {
	// A copy: a small Buffer is a view of a pool that holds other data.
	return new Uint8Array(Buffer.from(text, "base64"));
}
